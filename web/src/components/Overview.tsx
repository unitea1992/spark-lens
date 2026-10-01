import type { HostSnapshot, Snapshot } from "../../../server/types.ts";
import { count, pct, ratioPct } from "../format.ts";
import { pace } from "../pace.ts";
import type { Page } from "../route.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { StatusPill, type Tone } from "./StatusPill.tsx";

function More({ to, label }: { to: Page; label: string }) {
  return (
    <a className="more-link" href={`#/${to}`} aria-label={`${label}を詳しく見る`}>
      詳しく見る
    </a>
  );
}

function hostTone(h: HostSnapshot): { tone: Tone; text: string } {
  if (!h.online) return { tone: "critical", text: "応答なし" };
  const hot = Math.max(h.gpu?.tempC ?? 0, h.cpuTempC ?? 0);
  if (hot >= 90) return { tone: "critical", text: "高温" };
  if (hot >= 80) return { tone: "warn", text: "温度高め" };
  return { tone: "good", text: "稼働中" };
}

function Mini({ label, value, warnAt = 90 }: { label: string; value: number | null; warnAt?: number }) {
  return (
    <div className="mini">
      <span className="mini__label">{label}</span>
      <Meter value={value} level={levelFor(value, warnAt, Math.max(warnAt, 97))} label={`${label}の使用率`} />
      <span className="mini__value">{pct(value)}</span>
    </div>
  );
}

/** The first page: one line per thing, each linking to its own page. */
export function Overview({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const s = snapshot;
  const active = s.agents.filter((a) => a.status === "working" || a.status === "waiting");

  return (
    <div className="overview">
      <section className="card ov" aria-labelledby="ov-machines">
        <header className="ov__head">
          <h2 id="ov-machines">マシン</h2>
          <More to="machines" label="マシン" />
        </header>
        <ul className="ov__rows">
          {s.hosts.map((h) => {
            const st = hostTone(h);
            const temp = h.kind === "spark" ? (h.gpu?.tempC ?? h.cpuTempC) : (h.cpuTempC ?? h.gpu?.tempC ?? null);
            return (
              <li key={h.id} className="ov-host">
                <div className="ov-host__name">
                  <strong>{h.label}</strong>
                  <StatusPill tone={st.tone}>{st.text}</StatusPill>
                  <span className="ov-host__temp">{temp === null || temp === undefined ? "" : `${temp.toFixed(0)}℃`}</span>
                </div>
                <div className="ov-host__meters">
                  <Mini label="GPU" value={h.gpu?.utilPct ?? null} />
                  {/* A loaded model reserves most of a Spark's memory on purpose. */}
                  <Mini label="メモリ" value={ratioPct(h.memUsedBytes, h.memTotalBytes)} warnAt={h.kind === "spark" ? 97 : 90} />
                  <Mini label="CPU" value={h.cpuPct} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {s.llms.length > 0 && (
        <section className="card ov" aria-labelledby="ov-llm">
          <header className="ov__head">
            <h2 id="ov-llm">ローカル LLM</h2>
            <More to="llm" label="ローカル LLM" />
          </header>
          <ul className="ov__rows">
            {s.llms.map((l) => {
              const running = l.requestsRunning ?? 0;
              const st: { tone: Tone; text: string } =
                l.state === "down"
                  ? { tone: "quiet", text: "停止中" }
                  : l.state === "starting"
                    ? { tone: "warn", text: "起動中" }
                    : running > 0
                      ? { tone: "busy", text: "推論中" }
                      : { tone: "good", text: "待機中" };
              return (
                <li key={l.id} className="ov-llm">
                  <div className="ov-llm__name">
                    <strong>{l.label}</strong>
                    <StatusPill tone={st.tone}>{st.text}</StatusPill>
                  </div>
                  {l.state === "up" ? (
                    <dl className="ov-llm__figures">
                      <div>
                        <dt>生成速度</dt>
                        <dd>
                          {l.genTokensPerSec === null ? "–" : l.genTokensPerSec.toFixed(1)}
                          <small> トークン/秒</small>
                        </dd>
                      </div>
                      <div>
                        <dt>処理中・順番待ち</dt>
                        <dd>
                          {l.requestsRunning ?? "–"}・{l.requestsWaiting ?? "–"}
                        </dd>
                      </div>
                      <div>
                        <dt>今日の出力</dt>
                        <dd>{count(l.tokensToday.generation)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="muted">{l.detail ?? "起動していません。"}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card ov" aria-labelledby="ov-subs">
        <header className="ov__head">
          <h2 id="ov-subs">クラウド利用枠</h2>
          <More to="subscriptions" label="クラウド利用枠" />
        </header>
        <ul className="ov__rows">
          {s.subscriptions.map((sub) => {
            // The window closest to its limit is the one worth a glance.
            const w = [...sub.windows].sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1))[0];
            const p = w ? pace(w, now) : null;
            return (
              <li key={sub.id} className="ov-sub">
                <div className="ov-sub__line">
                  <strong>{sub.label}</strong>
                  <span className="muted">{w ? w.label : sub.status === "unconfigured" ? "未接続" : "取得できていません"}</span>
                  <span className="ov-sub__pct">{w ? pct(w.usedPct) : ""}</span>
                </div>
                {w && <Meter value={w.usedPct} level={levelFor(w.usedPct, 80, 95)} label={`${sub.label} ${w.label}の使用率`} />}
                {p && p.tone !== "good" && p.tone !== "ok" && <p className={`pace pace--${p.tone}`}>{p.text}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card ov" aria-labelledby="ov-agents">
        <header className="ov__head">
          <h2 id="ov-agents">エージェント</h2>
          <More to="agents" label="エージェント" />
        </header>
        {active.length === 0 ? (
          <p className="muted">いま作業中のエージェントはありません。</p>
        ) : (
          <ul className="ov__rows">
            {active.slice(0, 5).map((a) => (
              <li key={a.id} className="ov-agent">
                <StatusPill tone={a.status === "waiting" ? "warn" : "busy"}>{a.status === "waiting" ? "入力待ち" : "作業中"}</StatusPill>
                <span className="ov-agent__text">
                  <strong>{a.toolLabel}</strong> {a.title ?? a.cwd ?? ""}
                </span>
              </li>
            ))}
            {active.length > 5 && <li className="muted">ほか {active.length - 5} 件</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
