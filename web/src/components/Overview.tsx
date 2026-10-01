import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../../server/types.ts";
import { ago, count, pct, ratioPct } from "../format.ts";
import { pace, paceLabel, subscriptionStatus } from "../pace.ts";
import type { Page } from "../route.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { StatusPill, type Tone } from "./StatusPill.tsx";

function Title({ to, children }: { to: Page; children: string }) {
  return (
    <h2 className="ov__title">
      <a href={`#/${to}`}>
        {children}
        <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </h2>
  );
}

// CPUs (AMD's Tctl in particular) are designed to run hotter than GPUs.
const LIMITS = { gpu: { warn: 80, critical: 90 }, cpu: { warn: 90, critical: 98 } };

export function hostStatus(h: HostSnapshot): { tone: Tone; text: string } {
  if (!h.online) return { tone: "critical", text: "応答なし" };
  const gpu = h.gpu?.tempC ?? 0;
  const cpu = h.cpuTempC ?? 0;
  if (gpu >= LIMITS.gpu.critical || cpu >= LIMITS.cpu.critical) return { tone: "critical", text: "高温" };
  if (gpu >= LIMITS.gpu.warn || cpu >= LIMITS.cpu.warn) return { tone: "warn", text: "温度高め" };
  return { tone: "good", text: "稼働中" };
}

/** Process state and load, in the words used everywhere: 停止中 / 起動中 / 稼働中・アイドル / 稼働中・推論中. */
export function llmStatus(l: LlmSnapshot): { tone: Tone; text: string } {
  if (l.state === "down") return { tone: "quiet", text: "停止中" };
  if (l.state === "starting") return { tone: "warn", text: "起動中" };
  return (l.requestsRunning ?? 0) > 0 ? { tone: "busy", text: "稼働中・推論中" } : { tone: "good", text: "稼働中・アイドル" };
}

function Mini({ label, value, warnAt = 90, note }: { label: string; value: number | null; warnAt?: number; note?: string }) {
  return (
    <div className="mini">
      <span className="mini__label">{label}</span>
      <span className="mini__value">{pct(value)}</span>
      <Meter value={value} level={levelFor(value, warnAt, Math.max(warnAt, 97))} label={`${label}の使用率`} />
      {note && <span className="mini__note">{note}</span>}
    </div>
  );
}

interface Alert {
  text: string;
  tone: Tone;
  to: Page;
}

/** Only the things worth acting on; an empty list means everything is fine. */
export function alerts(s: Snapshot, now: number): Alert[] {
  const out: Alert[] = [];
  for (const h of s.hosts) {
    const st = hostStatus(h);
    if (st.tone === "critical" || st.tone === "warn") out.push({ text: `${h.label} ${st.text}`, tone: st.tone, to: "local" });
  }
  for (const r of s.recipes) if (r.status === "failed") out.push({ text: `${r.label} 起動に失敗`, tone: "critical", to: "local" });
  for (const sub of s.subscriptions) {
    const st = subscriptionStatus(sub, now);
    if (st.tone === "warn" || st.tone === "critical") out.push({ text: `${sub.label} ${st.text}`, tone: st.tone, to: "usage" });
  }
  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  if (waiting > 0) out.push({ text: `入力待ち ${waiting}`, tone: "warn", to: "agents" });
  return out;
}

/** The first page: one line per thing, each title linking to its own page. */
export function Overview({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const s = snapshot;
  const working = s.agents.filter((a) => a.status === "working");
  const waiting = s.agents.filter((a) => a.status === "waiting");
  const active = [...waiting, ...working];

  return (
    <>
      <div className="overview">
        <section className="card ov" aria-label="マシン">
          <Title to="local">マシン</Title>
          <ul className="ov__rows">
            {s.hosts.map((h) => {
              const st = hostStatus(h);
              const spark = h.kind === "spark";
              const tempLabel = spark && h.gpu?.tempC != null ? `GPU ${h.gpu.tempC.toFixed(0)}℃` : h.cpuTempC != null ? `CPU ${h.cpuTempC.toFixed(0)}℃` : "";
              const reserved = spark && h.gpuProcesses.length > 0;
              return (
                <li key={h.id} className="ov-host">
                  <div className="ov-host__name">
                    <strong>{h.label}</strong>
                    {st.tone !== "good" && <StatusPill tone={st.tone}>{st.text}</StatusPill>}
                    <span className="ov-host__temp">{tempLabel}</span>
                  </div>
                  <div className="ov-host__meters">
                    <Mini label="GPU" value={h.gpu?.utilPct ?? null} />
                    {/* A loaded model reserves most of a Spark's memory on purpose. */}
                    <Mini
                      label="メモリ"
                      value={ratioPct(h.memUsedBytes, h.memTotalBytes)}
                      warnAt={reserved ? 99 : 90}
                      note={reserved ? "モデルが確保" : undefined}
                    />
                    <Mini label="CPU" value={h.cpuPct} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {s.llms.length > 0 && (
          <section className="card ov" aria-label="ローカル LLM">
            <Title to="local">ローカル LLM</Title>
            <ul className="ov__rows">
              {s.llms.map((l) => {
                const st = llmStatus(l);
                const running = (l.requestsRunning ?? 0) > 0;
                return (
                  <li key={l.id} className="ov-llm">
                    <div className="ov-llm__name">
                      <strong>{l.label}</strong>
                      <StatusPill tone={st.tone}>{st.text}</StatusPill>
                    </div>
                    {l.state === "up" ? (
                      <>
                        <p className="ov-llm__hero">
                          {running ? (
                            <>
                              {l.genTokensPerSec === null ? "–" : l.genTokensPerSec.toFixed(1)}
                              <small> トークン/秒</small>
                            </>
                          ) : (
                            <span className="ov-llm__idle">
                              {l.lastActiveAt ? `最後の推論 ${ago(l.lastActiveAt, now)}` : "リクエストを待っています"}
                            </span>
                          )}
                        </p>
                        <dl className="ov-llm__figures">
                          <div>
                            <dt>リクエスト</dt>
                            <dd>
                              実行 {l.requestsRunning ?? "–"} / 待ち {l.requestsWaiting ?? "–"}
                            </dd>
                          </div>
                          <div>
                            <dt>今日の出力トークン</dt>
                            <dd>{count(l.tokensToday.generation)}</dd>
                          </div>
                        </dl>
                      </>
                    ) : (
                      <p className="muted">{l.detail ?? "起動していません。"}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="card ov" aria-label="クラウド利用枠">
          <Title to="usage">クラウド利用枠</Title>
          <ul className="ov__rows">
            {s.subscriptions.map((sub) => {
              // The window closest to its limit is the one worth a glance.
              const w = [...sub.windows].sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1))[0];
              const st = subscriptionStatus(sub, now);
              const fast = sub.windows.map((x) => pace(x, now)).find((p) => p?.untilFullSec != null);
              return (
                <li key={sub.id} className="ov-sub">
                  <div className="ov-sub__line">
                    <strong>{sub.label}</strong>
                    <span className="muted">{w ? w.label : ""}</span>
                    <span className="ov-sub__pct">{w ? pct(w.usedPct) : ""}</span>
                  </div>
                  {w && <Meter value={w.usedPct} level={levelFor(w.usedPct, 80, 95)} label={`${sub.label} ${w.label}の使用率`} />}
                  {st.tone !== "good" && (
                    <p className={`pace pace--${st.tone === "critical" ? "critical" : "warn"}`}>{fast ? paceLabel(fast) : st.text}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card ov ov--wide" aria-label="エージェント">
          <Title to="agents">エージェント</Title>
          <p className="ov-agents__count">
            作業中 <strong>{working.length}</strong>
            {waiting.length > 0 && (
              <>
                ・入力待ち <strong className="warn-text">{waiting.length}</strong>
              </>
            )}
          </p>
          {active.length === 0 ? (
            <p className="muted">いま作業中のエージェントはありません。</p>
          ) : (
            <ul className="ov-agents">
              {active.slice(0, 6).map((a) => (
                <li key={a.id}>
                  {a.status === "waiting" && <StatusPill tone="warn">入力待ち</StatusPill>}
                  <strong>{a.toolLabel}</strong>
                  <span className="ov-agents__title">{a.title ?? a.cwd ?? ""}</span>
                  <span className="ov-agents__time">{ago(a.lastActivity ?? a.startedAt, now)}</span>
                </li>
              ))}
              {active.length > 6 && <li className="muted">ほか {active.length - 6} 件</li>}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
