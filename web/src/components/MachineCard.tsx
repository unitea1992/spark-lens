import type { HostSnapshot, NetInfo } from "../../../server/types.ts";
import { ago, bytes, dockerStatus, duration, pct, rate, ratioPct, usedOfTotal } from "../format.ts";
import { LensDial } from "./LensDial.tsx";
import { levelFor, Meter } from "./Meter.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { hostStatus } from "./Overview.tsx";
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
  const centerGpu = isSpark && gpu?.tempC !== null && gpu?.tempC !== undefined;
  const centerTemp = centerGpu ? gpu!.tempC : (host.cpuTempC ?? gpu?.tempC ?? null);
  const st = hostStatus(host);
  const running = host.containers.filter((c) => c.state === "running");
  const links = host.net.filter((n) => n.up).sort(byLinkSpeed);

  return (
    <article className={`card machine${host.online ? "" : " machine--offline"}`}>
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

      <div className="machine__body">
        <LensDial
          dimmed={!host.online}
          rings={[
            { key: "gpu", label: "GPU", value: gpu?.utilPct ?? null },
            { key: "mem", label: "メモリ", value: memPct },
            { key: "cpu", label: "CPU", value: host.cpuPct },
          ]}
          center={centerTemp === null ? "–" : centerTemp.toFixed(0)}
          unit="°C"
          caption={centerGpu ? "GPU 温度" : "CPU 温度"}
        />
        <dl className="legend">
          <div className="legend__row">
            <dt>
              <span className="swatch series-bg-1" />
              GPU
            </dt>
            <dd>
              <strong>{pct(gpu?.utilPct)}</strong>
              <span>{temp(gpu?.tempC)}</span>
            </dd>
          </div>
          <div className="legend__row">
            <dt>
              <span className="swatch series-bg-2" />
              メモリ
            </dt>
            <dd>
              <strong>{pct(memPct)}</strong>
              <span>
                {usedOfTotal(host.memUsedBytes, host.memTotalBytes)}
                {isSpark && host.gpuProcesses.length > 0 ? "・モデルが確保" : ""}
              </span>
            </dd>
          </div>
          <div className="legend__row">
            <dt>
              <span className="swatch series-bg-3" />
              CPU
            </dt>
            <dd>
              <strong>{pct(host.cpuPct)}</strong>
              <span>{temp(host.cpuTempC)}</span>
            </dd>
          </div>
        </dl>
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

      <details className="more">
        <summary>詳細</summary>
        <dl className="facts">
          <div>
            <dt>稼働時間</dt>
            <dd>{duration(host.uptimeSec)}</dd>
          </div>
          <div>
            <dt>GPU 電力</dt>
            <dd>{gpu?.powerW !== null && gpu?.powerW !== undefined ? `${gpu.powerW.toFixed(1)} W` : "–"}</dd>
          </div>
          <div>
            <dt>GPU クロック（上限）</dt>
            <dd>{clock(gpu?.clockMhz, gpu?.clockMaxMhz)}</dd>
          </div>
          <div>
            <dt>CPU クロック（上限）</dt>
            <dd>{clock(host.clockMhz, host.clockMaxMhz)}</dd>
          </div>
          <div>
            <dt>ロードアベレージ（1 分）</dt>
            <dd>
              {host.load ? host.load[0].toFixed(1) : "–"}
              {host.ncpu ? `（${host.ncpu} コア）` : ""}
            </dd>
          </div>
          {isSpark && (
            <div>
              <dt>メモリ</dt>
              <dd>CPU と GPU で共用</dd>
            </div>
          )}
          <div>
            <dt>スワップ</dt>
            <dd>{host.swapTotalBytes ? `${bytes(host.swapUsedBytes)} / ${bytes(host.swapTotalBytes)}` : "なし"}</dd>
          </div>
          <div>
            <dt>応答時間</dt>
            <dd>{host.latencyMs === null ? "–" : `${host.latencyMs} ms`}</dd>
          </div>
          <div>
            <dt>OS</dt>
            <dd>{host.os ?? "–"}</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>{host.cpuModel ?? "–"}</dd>
          </div>
        </dl>
        {links.length > 0 && (
          <>
            <h4 className="more__title">ネットワーク</h4>
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
            </ul>
          </>
        )}
        {host.gpuProcesses.length > 0 && (
          <>
            <h4 className="more__title">GPU を使っているプロセス</h4>
            <ul className="rows">
              {host.gpuProcesses.map((p) => (
                <li key={p.pid}>
                  <span className="rows__name">{p.name || `PID ${p.pid}`}</span>
                  <span className="rows__value">{p.memBytes === null ? `PID ${p.pid}` : bytes(p.memBytes)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h4 className="more__title">コンテナ</h4>
        {host.containers.length === 0 ? (
          <p className="muted">コンテナはありません。</p>
        ) : (
          <ul className="rows">
            {[...running, ...host.containers.filter((c) => c.state !== "running")].map((c) => (
              <li key={c.name} className={c.state === "running" ? "" : "rows--quiet"}>
                <span className="rows__name">{c.name}</span>
                <span className="rows__value">{dockerStatus(c.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}
