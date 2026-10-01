import type { CSSProperties } from "react";
import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../../server/types.ts";
import { pct, rate, ratioPct } from "../format.ts";
import { hostStatus, llmStatus } from "../status.ts";
import { LensDial } from "./LensDial.tsx";
import { StatusPill } from "./StatusPill.tsx";

/**
 * Throughput on a host's fast ports, both directions. RDMA counters come
 * first: inter-node traffic such as NCCL never touches the IP counters.
 */
function fabricBps(h: HostSnapshot): { bps: number | null; speedGb: number | null } {
  const fast = (h.fabric ?? []).filter((p) => (p.rateGbps ?? 0) >= 100);
  const ports = h.net.filter((n) => n.up && (n.speedMbps ?? 0) >= 100_000);
  if (fast.length === 0 && ports.length === 0) return { bps: null, speedGb: null };
  const rdma = fast.reduce((a, p) => a + (p.rxBps ?? 0) + (p.txBps ?? 0), 0);
  const ip = ports.reduce((a, n) => a + (n.rxBps ?? 0) + (n.txBps ?? 0), 0);
  const speed = Math.max(...fast.map((p) => p.rateGbps ?? 0), ...ports.map((n) => (n.speedMbps ?? 0) / 1000));
  return { bps: rdma + ip, speedGb: speed };
}

function scrollToMachine(id: string) {
  document.getElementById(`machine-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function Node({ host }: { host: HostSnapshot }) {
  const st = hostStatus(host);
  const spark = host.kind === "spark";
  const mem = ratioPct(host.memUsedBytes, host.memTotalBytes);
  const centerGpu = spark && host.gpu?.tempC != null;
  const temp = centerGpu ? host.gpu!.tempC : (host.cpuTempC ?? null);
  return (
    <button type="button" className={`node node--${st.tone}${host.online ? "" : " node--offline"}`} onClick={() => scrollToMachine(host.id)}>
      <LensDial
        dimmed={!host.online}
        rings={[
          { key: "gpu", label: "GPU", value: host.gpu?.utilPct ?? null },
          { key: "mem", label: "メモリ", value: mem },
          { key: "cpu", label: "CPU", value: host.cpuPct },
        ]}
        center={temp === null || temp === undefined ? "–" : temp.toFixed(0)}
        unit="°C"
        caption={centerGpu ? "GPU" : "CPU"}
      />
      <span className="node__name">{host.label}</span>
      <span className="node__figures">
        <span>
          <i className="swatch series-bg-1" />
          {pct(host.gpu?.utilPct)}
        </span>
        <span>
          <i className="swatch series-bg-2" />
          {pct(mem)}
        </span>
        <span>
          <i className="swatch series-bg-3" />
          {pct(host.cpuPct)}
        </span>
      </span>
      {st.tone !== "good" && <StatusPill tone={st.tone}>{st.text}</StatusPill>}
    </button>
  );
}

/** A cable between two Sparks. Dashes travel along it while data does. */
function Fabric({ a, b }: { a: HostSnapshot; b: HostSnapshot }) {
  const fa = fabricBps(a);
  const fb = fabricBps(b);
  const bps = fa.bps === null && fb.bps === null ? null : Math.max(fa.bps ?? 0, fb.bps ?? 0);
  const speed = fa.speedGb ?? fb.speedGb;
  const active = (bps ?? 0) > 1_000_000; // more than ~8 Mb/s is real traffic, not keep-alives
  // Faster traffic, faster dashes: one second at 1 GB/s, slower below.
  const seconds = active ? Math.max(0.35, Math.min(3, 2.2 - Math.log10(bps! / 1e6) * 0.6)) : 0;
  return (
    <div className={`fabric${active ? " fabric--active" : ""}`} style={active ? ({ "--flow": `${seconds}s` } as CSSProperties) : undefined}>
      <span className="fabric__line" aria-hidden="true" />
      <span className="fabric__label">
        {speed ? `${speed} GbE` : "直結"}
        <strong>{bps === null ? "" : rate(bps)}</strong>
      </span>
    </div>
  );
}

function Band({ llm }: { llm: LlmSnapshot }) {
  const st = llmStatus(llm);
  const up = llm.state === "up";
  const running = (llm.requestsRunning ?? 0) > 0;
  const kind = llm.state === "down" ? "down" : llm.state === "starting" ? "starting" : running ? "busy" : "idle";
  return (
    <div className={`band band--${kind}`}>
      <span className="band__name">{llm.label}</span>
      <span className="band__state">{st.text}</span>
      {up && (
        <span className="band__figures">
          {running && llm.genTokensPerSec !== null && (
            <span>
              <strong>{llm.genTokensPerSec.toFixed(1)}</strong> トークン/秒
            </span>
          )}
          <span>
            実行 <strong>{llm.requestsRunning ?? "–"}</strong>・待ち <strong>{llm.requestsWaiting ?? "–"}</strong>
          </span>
          <span>
            KV <strong>{llm.kvCacheUsage === null ? "–" : pct(llm.kvCacheUsage * 100)}</strong>
          </span>
        </span>
      )}
    </div>
  );
}

interface Cluster {
  llm: LlmSnapshot | null;
  hosts: HostSnapshot[];
}

/** Hosts grouped the way they are wired: each model with the machines it spans. */
function layout(s: Snapshot): { observers: HostSnapshot[]; clusters: Cluster[] } {
  const used = new Set<string>();
  const clusters: Cluster[] = [];
  for (const llm of s.llms) {
    const hosts = llm.nodes.map((id) => s.hosts.find((h) => h.id === id)).filter((h): h is HostSnapshot => !!h && !used.has(h.id));
    if (hosts.length === 0) continue;
    hosts.forEach((h) => used.add(h.id));
    clusters.push({ llm, hosts });
  }
  const observers = s.hosts.filter((h) => !used.has(h.id) && h.kind === "workstation");
  const rest = s.hosts.filter((h) => !used.has(h.id) && h.kind !== "workstation");
  if (rest.length > 0) clusters.push({ llm: null, hosts: rest });
  return { observers, clusters };
}

/**
 * The lab drawn the way it is built: the machine this dashboard runs on,
 * then each model with the machines it spans and the cable between them.
 */
export function LabMap({ snapshot }: { snapshot: Snapshot }) {
  const { observers, clusters } = layout(snapshot);
  return (
    <section className="lab" aria-label="ラボの構成">
      {observers.length > 0 && (
        <div className="lab__side">
          {observers.map((h) => (
            <Node key={h.id} host={h} />
          ))}
        </div>
      )}
      {observers.length > 0 && clusters.length > 0 && (
        <div className="lab__tether" aria-hidden="true">
          <span>Tailscale</span>
        </div>
      )}
      <div className="lab__clusters">
        {clusters.map((c, i) => (
          <div key={c.llm?.id ?? `rest-${i}`} className="cluster">
            <div className="cluster__nodes">
              {c.hosts.map((h, j) => (
                <div key={h.id} className="cluster__cell">
                  {j > 0 && c.llm && <Fabric a={c.hosts[j - 1]!} b={h} />}
                  <Node host={h} />
                </div>
              ))}
            </div>
            {c.llm && <Band llm={c.llm} />}
          </div>
        ))}
      </div>
    </section>
  );
}
