import type { CSSProperties } from "react";
import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../../server/types.ts";
import { ago, pct, rate, ratioPct } from "../format.ts";
import { hostStatus, llmStatus } from "../status.ts";
import { layout } from "../lab.ts";
import { LensDial } from "./LensDial.tsx";

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

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : String(Math.round(v));
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
  const working = (host.gpu?.utilPct ?? 0) >= 40;
  return (
    <button
      type="button"
      className={`node node--${st.tone}${host.online ? "" : " node--offline"}${working ? " node--working" : ""}`}
      onClick={() => scrollToMachine(host.id)}
      aria-label={`${host.label}の詳細へ移動`}
    >
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
      <span className="node__figures" aria-hidden="true">
        <span className="node__fig node__fig--1">
          <small>GPU</small>
          {num(host.gpu?.utilPct)}
        </span>
        <span className="node__fig node__fig--2">
          <small>メモリ</small>
          {num(mem)}
        </span>
        <span className="node__fig node__fig--3">
          <small>CPU</small>
          {num(host.cpuPct)}
        </span>
      </span>
      {st.tone !== "good" && <span className={`node__flag node__flag--${st.tone}`}>{st.text}</span>}
    </button>
  );
}

/** A cable between two machines. Light travels along it while data does. */
function Fabric({ a, b }: { a: HostSnapshot; b: HostSnapshot }) {
  const fa = fabricBps(a);
  const fb = fabricBps(b);
  const bps = fa.bps === null && fb.bps === null ? null : Math.max(fa.bps ?? 0, fb.bps ?? 0);
  const speed = fa.speedGb ?? fb.speedGb;
  const active = (bps ?? 0) > 1_000_000; // more than ~8 Mb/s is real traffic, not keep-alives
  // Faster traffic, faster pulses.
  const seconds = active ? Math.max(0.35, Math.min(3, 2.2 - Math.log10(bps! / 1e6) * 0.6)) : 0;
  return (
    <div className={`fabric${active ? " fabric--active" : ""}`} style={active ? ({ "--flow": `${seconds}s` } as CSSProperties) : undefined}>
      <span className="fabric__line" aria-hidden="true" />
      <span className="fabric__label">
        <span>{speed ? `${speed} GbE` : "直結"}</span>
        <strong>{bps === null ? "–" : rate(bps)}</strong>
      </span>
    </div>
  );
}

function Band({ llm, now }: { llm: LlmSnapshot; now: number }) {
  const st = llmStatus(llm);
  const running = (llm.requestsRunning ?? 0) > 0;
  const kind = llm.state === "down" ? "down" : llm.state === "starting" ? "starting" : running ? "busy" : "idle";
  return (
    <div className={`band band--${kind}`}>
      <span className="band__name">{llm.label}</span>
      <span className="band__state">{st.text}</span>
      <span className="band__figures">
        {kind === "busy" && (
          <span className="band__hero">
            <strong>{llm.genTokensPerSec === null ? "–" : llm.genTokensPerSec.toFixed(1)}</strong> トークン/秒
          </span>
        )}
        {kind === "idle" && llm.lastActiveAt !== null && <span>最後の推論 {ago(llm.lastActiveAt, now)}</span>}
        {(kind === "busy" || kind === "idle") && (
          <>
            <span>
              実行 <strong>{llm.requestsRunning ?? "–"}</strong>・待ち <strong>{llm.requestsWaiting ?? "–"}</strong>
            </span>
            <span>
              KV <strong>{llm.kvCacheUsage === null ? "–" : pct(llm.kvCacheUsage * 100)}</strong>
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * The lab drawn the way it is built: the machine this dashboard runs on,
 * then each group of machines with the models they serve and the cables
 * between them. Always on a dark stage, like an instrument.
 */
export function LabMap({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const { observers, clusters } = layout(snapshot);
  return (
    <section className="stage" aria-label="ラボの構成">
      <div className={`stage__map${observers.length > 0 ? " stage__map--with-side" : ""}`}>
        {observers.length > 0 && (
          <div className="stage__side">
            {observers.map((h) => (
              <Node key={h.id} host={h} />
            ))}
          </div>
        )}
        {observers.length > 0 && clusters.length > 0 && (
          <div className="stage__tether" aria-hidden="true">
            <span>Tailscale</span>
          </div>
        )}
        <div className="stage__clusters">
          {clusters.map((c) => (
            <div key={c.key} className="cluster">
              <div className="cluster__nodes">
                {c.hosts.map((h, j) => (
                  <div key={h.id} className="cluster__cell">
                    {j > 0 && c.llms.length > 0 && <Fabric a={c.hosts[j - 1]!} b={h} />}
                    <Node host={h} />
                  </div>
                ))}
              </div>
              {c.llms.length > 0 && (
                <div className="cluster__bands">
                  {c.llms.map((l) => (
                    <Band key={l.id} llm={l} now={now} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="stage__legend" aria-hidden="true">
        <span className="legend-key legend-key--1">GPU</span>
        <span className="legend-key legend-key--2">メモリ</span>
        <span className="legend-key legend-key--3">CPU</span>
        <span className="legend-key legend-key--center">リングの中央は温度・数値は使用率 %</span>
      </div>
    </section>
  );
}
