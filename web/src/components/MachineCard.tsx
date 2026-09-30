import type { HostSnapshot } from "../../../server/types.ts";
import { ago, bytes, duration, pct, rate, ratioPct, usedOfTotal } from "../format.ts";
import { LensDial } from "./LensDial.tsx";
import { levelFor, Meter } from "./Meter.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { StatusPill, type Tone } from "./StatusPill.tsx";

const TEMP_WARN = 80;
const TEMP_CRITICAL = 90;

const KIND_LABEL: Record<HostSnapshot["kind"], string> = {
  spark: "DGX Spark",
  workstation: "開発機",
  server: "サーバー",
};

// hwmon chip names, translated to the part they sit on.
const SENSOR_NAMES: [RegExp, string][] = [
  [/^gpu$|^amdgpu$|^nouveau$/, "GPU"],
  [/^(k10temp|coretemp|zenpower|cpu_thermal)$/, "CPU"],
  [/^acpitz$/, "本体"],
  [/^nvme$/, "SSD"],
  [/^mlx5$/, "高速ネットワーク"],
  [/^(r8169|igc|igb|e1000e)/, "有線 LAN"],
  [/^(iwlwifi|mt79|ath)/, "Wi-Fi"],
  [/^spd5118$/, "メモリ"],
];

function sensorName(chip: string): string {
  return SENSOR_NAMES.find(([re]) => re.test(chip))?.[1] ?? chip;
}

function status(host: HostSnapshot): { tone: Tone; text: string } {
  if (!host.online) return { tone: "critical", text: "応答なし" };
  const hottest = host.maxTemp?.tempC ?? 0;
  if (hottest >= TEMP_CRITICAL) return { tone: "critical", text: "高温" };
  if (hottest >= TEMP_WARN) return { tone: "warn", text: "温度高め" };
  return { tone: "good", text: "稼働中" };
}

export function MachineCard({ host, now }: { host: HostSnapshot; now: number }) {
  const memPct = ratioPct(host.memUsedBytes, host.memTotalBytes);
  const gpu = host.gpu;
  const isSpark = host.kind === "spark";
  const temp = isSpark ? (gpu?.tempC ?? host.cpuTempC) : (host.cpuTempC ?? gpu?.tempC ?? null);
  const tempSource = isSpark && gpu?.tempC !== null && gpu?.tempC !== undefined ? "GPU 温度" : "CPU 温度";
  const st = status(host);
  const running = host.containers.filter((c) => c.state === "running");
  const links = host.net.filter((n) => n.up);

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
          center={temp === null ? "–" : temp.toFixed(0)}
          unit="°C"
          caption={tempSource}
        />
        <dl className="legend">
          <div className="legend__row">
            <dt>
              <span className="swatch series-bg-1" />
              GPU
            </dt>
            <dd>
              <strong>{pct(gpu?.utilPct)}</strong>
              <span>
                {gpu?.powerW !== null && gpu?.powerW !== undefined ? `${gpu.powerW.toFixed(1)} W` : "–"}
                {gpu?.clockMhz ? `・${gpu.clockMhz} MHz` : ""}
              </span>
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
                {isSpark ? "（GPU と共用）" : ""}
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
              <span>
                {host.ncpu ? `${host.ncpu} コア` : "–"}
                {host.load ? `・負荷 ${host.load[0].toFixed(1)}` : ""}
              </span>
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
            <dt>連続稼働</dt>
            <dd>{duration(host.uptimeSec)}</dd>
          </div>
          <div>
            <dt>最も熱いセンサー</dt>
            <dd>
              {host.maxTemp ? `${sensorName(host.maxTemp.chip)} ${host.maxTemp.tempC.toFixed(0)}°C` : "–"}
            </dd>
          </div>
          <div>
            <dt>CPU クロック</dt>
            <dd>
              {host.clockMhz !== null && host.clockMaxMhz !== null
                ? `${Math.round(host.clockMhz)} / ${Math.round(host.clockMaxMhz)} MHz`
                : "–"}
            </dd>
          </div>
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
                <span className="rows__value">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}
