import type { HostSnapshot, NetInfo } from "../../../server/types.ts";
import { ago, bytes, dockerStatus, duration, pct, rate, ratioPct, usedOfTotal } from "../format.ts";
import { hostStatus } from "../status.ts";
import { Sparkline } from "./Sparkline.tsx";
import { StatusPill } from "./StatusPill.tsx";

const KIND_LABEL: Record<HostSnapshot["kind"], string> = {
  spark: "DGX Spark",
  workstation: "開発機",
  server: "サーバー",
};

function temp(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : `${value.toFixed(0)}℃`;
}

function clock(cur: number | null | undefined, max: number | null | undefined): string {
  if (cur === null || cur === undefined) return "–";
  return max ? `${Math.round(cur)} / ${Math.round(max)} MHz` : `${Math.round(cur)} MHz`;
}

/** Slowest link first, so the management port leads and fast fabric ports group together. */
function byLinkSpeed(a: NetInfo, b: NetInfo): number {
  return (a.speedMbps ?? Infinity) - (b.speedMbps ?? Infinity) || a.iface.localeCompare(b.iface);
}

function Bar({ label, value, side, series }: { label: string; value: number | null; side: string; series: 1 | 2 | 3 | 0 }) {
  return (
    <div className="bar-row">
      <span className="bar-row__label">
        {series > 0 && <i className={`swatch series-bg-${series}`} />}
        {label}
      </span>
      <strong className="bar-row__value">{pct(value)}</strong>
      <span className="bar-row__side">{side}</span>
      <div className={`bar-row__track series-track-${series}`}>
        <div className="bar-row__fill" style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <li>
      <span>{label}</span>
      <span>{value}</span>
    </li>
  );
}

export function MachineCard({ host, now }: { host: HostSnapshot; now: number }) {
  const memPct = ratioPct(host.memUsedBytes, host.memTotalBytes);
  const gpu = host.gpu;
  const isSpark = host.kind === "spark";
  const st = hostStatus(host);
  const containers = [...host.containers].sort((a, b) => Number(b.state === "running") - Number(a.state === "running"));
  // Ports carrying nothing are counted, not listed: a Spark has several idle fabric ports.
  const moving = (rx: number | null, tx: number | null) => (rx ?? 0) + (tx ?? 0) >= 1000;
  const allLinks = host.net.filter((n) => n.up).sort(byLinkSpeed);
  const links = allLinks.filter((n, i) => moving(n.rxBps, n.txBps) || i === 0);
  const rdma = host.fabric.filter((f) => moving(f.rxBps, f.txBps));
  const quietPorts = allLinks.length - links.length + host.fabric.length - rdma.length;

  return (
    <article id={`machine-${host.id}`} className={`card machine${host.online ? "" : " machine--offline"}`}>
      <header className="card__head">
        <div>
          <h3 className="card__title">{host.label}</h3>
          <p className="card__sub">
            {KIND_LABEL[host.kind]}
            {host.hostname && host.hostname !== host.label ? `・${host.hostname}` : ""}
          </p>
        </div>
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
      </header>

      {!host.online && (
        <p className="notice notice--critical">
          {host.lastSeen ? `${ago(host.lastSeen, now)}から応答がありません。` : "まだ一度も応答がありません。"}
          {host.error ? <span className="notice__detail">{host.error}</span> : null}
        </p>
      )}

      <div className="gauges">
        {[
          { key: "gpu", label: "GPU", value: gpu?.utilPct ?? null, side: temp(gpu?.tempC), series: 1 },
          {
            key: "mem",
            label: "メモリ",
            value: memPct,
            side: usedOfTotal(host.memUsedBytes, host.memTotalBytes),
            series: 2,
          },
          { key: "cpu", label: "CPU", value: host.cpuPct, side: temp(host.cpuTempC), series: 3 },
        ].map((g) => (
          <div key={g.key} className={`gauge gauge--${g.series}`}>
            <span className="gauge__label">{g.label}</span>
            <span className="gauge__value">
              {g.value === null ? "–" : Math.round(g.value)}
              <small>%</small>
            </span>
            <span className="gauge__track">
              <span className="gauge__fill" style={{ width: `${Math.min(100, Math.max(0, g.value ?? 0))}%` }} />
            </span>
            <span className="gauge__side">{g.side || "\u00a0"}</span>
          </div>
        ))}
      </div>

      <Sparkline
        values={isSpark ? host.history.gpu : host.history.cpu}
        stepSec={host.history.stepSec}
        max={100}
        series={isSpark ? 1 : 3}
        label={isSpark ? "GPU 使用率" : "CPU 使用率"}
        format={(v) => `${v.toFixed(0)}%`}
        historyKey={`host:${host.id}:${isSpark ? "gpu" : "cpu"}`}
      />

      {host.disks.map((d) => (
        <Bar
          key={d.mount}
          label={host.disks.length > 1 ? `ストレージ ${d.mount}` : "ストレージ"}
          value={ratioPct(d.usedBytes, d.totalBytes)}
          side={usedOfTotal(d.usedBytes, d.totalBytes)}
          series={0}
        />
      ))}

      <ul className="spec">
        <Spec label="稼働時間" value={duration(host.uptimeSec)} />
        {gpu && <Spec label="GPU 電力" value={gpu.powerW !== null ? `${gpu.powerW.toFixed(1)} W` : "–"} />}
        {gpu && gpu.clockMhz !== null && <Spec label="GPU クロック / 上限" value={clock(gpu.clockMhz, gpu.clockMaxMhz)} />}
        <Spec label="CPU クロック / 上限" value={clock(host.clockMhz, host.clockMaxMhz)} />
        <Spec label="スワップ" value={host.swapTotalBytes ? `${bytes(host.swapUsedBytes)} / ${bytes(host.swapTotalBytes)}` : "なし"} />
      </ul>

      {(links.length > 0 || rdma.length > 0) && (
        <div className="minilist">
          <h4>ネットワーク</h4>
          <ul className="spec spec--flow">
            {links.map((n) => (
              <li key={n.iface}>
                <span>
                  {n.iface}
                  <em>{n.speedMbps ? (n.speedMbps >= 1000 ? `${n.speedMbps / 1000} GbE` : `${n.speedMbps} Mb`) : ""}</em>
                </span>
                <span>
                  ↓ {rate(n.rxBps)}　↑ {rate(n.txBps)}
                </span>
              </li>
            ))}
            {rdma.map((f) => (
              <li key={f.device}>
                <span>
                  {f.device}
                  <em>RDMA</em>
                </span>
                <span>
                  ↓ {rate(f.rxBps)}　↑ {rate(f.txBps)}
                </span>
              </li>
            ))}
          </ul>
          {quietPorts > 0 && <p className="minilist__more">ほか {quietPorts} ポートは通信なし</p>}
        </div>
      )}

      {host.gpuProcesses.length > 0 && (
        <div className="minilist">
          <h4>GPU を使っているプロセス</h4>
          <ul className="spec">
            {host.gpuProcesses.map((p) => (
              <Spec key={p.pid} label={p.name || `PID ${p.pid}`} value={p.memBytes === null ? `PID ${p.pid}` : bytes(p.memBytes)} />
            ))}
          </ul>
        </div>
      )}

      {containers.length > 0 && (
        <div className="minilist">
          <h4>コンテナ</h4>
          <ul className="spec">
            {containers.map((c) => (
              <li key={c.name} className={c.state === "running" ? "" : "spec--quiet"}>
                <span>{c.name}</span>
                <span>{dockerStatus(c.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="machine__foot">
        {[host.os, host.cpuModel, host.latencyMs !== null ? `応答 ${host.latencyMs} ms` : null].filter(Boolean).join("・")}
      </p>
    </article>
  );
}
