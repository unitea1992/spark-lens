import type { HostSnapshot, NetInfo } from "../../../server/types.ts";
import { ago, bytes, dockerStatus, duration, pct, rate, ratioPct, usedOfTotal } from "../format.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { hostStatus } from "../status.ts";
import { StatusPill, type Tone } from "./StatusPill.tsx";

const KIND_LABEL: Record<HostSnapshot["kind"], string> = {
  spark: "DGX Spark",
  workstation: "開発機",
  server: "サーバー",
};


function temp(value: number | null | undefined): string {
  return value === null || value === undefined ? "温度不明" : `${value.toFixed(0)}℃`;
}

function clock(cur: number | null | undefined, max: number | null | undefined): string {
  if (cur === null || cur === undefined) return "–";
  return max ? `${Math.round(cur)} / ${Math.round(max)} MHz` : `${Math.round(cur)} MHz`;
}

/** Slowest link first, so the management port leads and fast fabric ports group together. */
function byLinkSpeed(a: NetInfo, b: NetInfo): number {
  return (a.speedMbps ?? Infinity) - (b.speedMbps ?? Infinity) || a.iface.localeCompare(b.iface);
}


export function MachineCard({ host, now }: { host: HostSnapshot; now: number }) {
  const memPct = ratioPct(host.memUsedBytes, host.memTotalBytes);
  const gpu = host.gpu;
  const isSpark = host.kind === "spark";
  const st = hostStatus(host);
  const running = host.containers.filter((c) => c.state === "running");
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

      <div className="machine__bars">
        {[
          { key: "gpu", label: "GPU", value: gpu?.utilPct ?? null, side: temp(gpu?.tempC), series: 1 },
          {
            key: "mem",
            label: "メモリ",
            value: memPct,
            side: `${usedOfTotal(host.memUsedBytes, host.memTotalBytes)}${isSpark && host.gpuProcesses.length > 0 ? "・モデルが確保" : ""}`,
            series: 2,
          },
          { key: "cpu", label: "CPU", value: host.cpuPct, side: temp(host.cpuTempC), series: 3 },
        ].map((r) => (
          <div key={r.key} className="bar-row">
            <span className="bar-row__label">
              <i className={`swatch series-bg-${r.series}`} />
              {r.label}
            </span>
            <strong className="bar-row__value">{pct(r.value)}</strong>
            <span className="bar-row__side">{r.side}</span>
            <div className={`bar-row__track series-track-${r.series}`}>
              <div className="bar-row__fill" style={{ width: `${Math.min(100, Math.max(0, r.value ?? 0))}%` }} />
            </div>
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
      />

      <div className="machine__disks">
        {host.disks.map((d) => {
          const used = ratioPct(d.usedBytes, d.totalBytes);
          return (
            <div className="stat" key={d.mount}>
              <div className="stat__line">
                <span>ストレージ{host.disks.length > 1 ? ` ${d.mount}` : ""}</span>
                <span>
                  <strong>{pct(used)}</strong> {usedOfTotal(d.usedBytes, d.totalBytes)}
                </span>
              </div>
              <Meter value={used} level={levelFor(used, 85, 95)} label={`ストレージ ${d.mount} の使用率`} />
            </div>
          );
        })}
      </div>

      <dl className="facts facts--compact">
        <div>
          <dt>稼働時間</dt>
          <dd>{duration(host.uptimeSec)}</dd>
        </div>
        <div>
          <dt>GPU 電力</dt>
          <dd>{gpu?.powerW !== null && gpu?.powerW !== undefined ? `${gpu.powerW.toFixed(1)} W` : "–"}</dd>
        </div>
        <div>
          <dt>GPU クロック / 上限</dt>
          <dd>{clock(gpu?.clockMhz, gpu?.clockMaxMhz)}</dd>
        </div>
        <div>
          <dt>CPU クロック / 上限</dt>
          <dd>{clock(host.clockMhz, host.clockMaxMhz)}</dd>
        </div>
        <div>
          <dt>ロードアベレージ</dt>
          <dd>
            {host.load ? host.load.map((l) => l.toFixed(1)).join(" / ") : "–"}
          </dd>
        </div>
        <div>
          <dt>スワップ</dt>
          <dd>{host.swapTotalBytes ? `${bytes(host.swapUsedBytes)} / ${bytes(host.swapTotalBytes)}` : "なし"}</dd>
        </div>
      </dl>

      {links.length > 0 && (
        <div className="minilist">
          <h4>ネットワーク</h4>
          <ul className="rows">
            {links.map((n) => (
              <li key={n.iface}>
                <span className="rows__name">{n.iface}</span>
                <span className="rows__meta">
                  {n.speedMbps ? (n.speedMbps >= 1000 ? `${n.speedMbps / 1000} GbE` : `${n.speedMbps} Mb`) : ""}
                </span>
                <span className="rows__value">
                  ↓ {rate(n.rxBps)}　↑ {rate(n.txBps)}
                </span>
              </li>
            ))}
            {rdma.map((f) => (
                <li key={f.device}>
                  <span className="rows__name">{f.device}</span>
                  <span className="rows__meta">RDMA{f.rateGbps ? ` ${f.rateGbps} Gb` : ""}</span>
                  <span className="rows__value">
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
          <ul className="rows">
            {host.gpuProcesses.map((p) => (
              <li key={p.pid}>
                <span className="rows__name">{p.name || `PID ${p.pid}`}</span>
                <span className="rows__value">{p.memBytes === null ? `PID ${p.pid}` : bytes(p.memBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {host.containers.length > 0 && (
        <div className="minilist">
          <h4>コンテナ</h4>
          <ul className="rows">
            {[...running, ...host.containers.filter((c) => c.state !== "running")].map((c) => (
              <li key={c.name} className={c.state === "running" ? "" : "rows--quiet"}>
                <span className="rows__name">{c.name}</span>
                <span className="rows__value">{dockerStatus(c.status)}</span>
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
