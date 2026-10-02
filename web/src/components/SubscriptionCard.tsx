import type { SubscriptionSnapshot, UsageWindow } from "../../../server/types.ts";
import { ago, duration, pct, shortDate, when } from "../format.ts";
import { elapsedPct, pace, paceLabel, subscriptionStatus } from "../pace.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { StatusPill } from "./StatusPill.tsx";

function Window({ w, now }: { w: UsageWindow; now: number }) {
  const remaining = w.resetsAt === null ? null : (w.resetsAt - now) / 1000;
  const p = pace(w, now);
  const left = w.idle
    ? "未使用（使い始めた時点から数えます）"
    : remaining === null
      ? "リセット時刻不明"
      : remaining <= 0
        ? "リセット予定時刻を経過"
        : `あと ${duration(remaining)} / ${when(w.resetsAt!, now)}`;
  return (
    <div className="stat">
      <div className="stat__line">
        <span>{w.label}</span>
        <strong>{pct(w.usedPct)}</strong>
      </div>
      <Meter
        value={w.usedPct}
        level={levelFor(w.usedPct, 80, 95)}
        marker={elapsedPct(w, now)}
        markerLabel="期間の経過位置（均等に使った場合の目安）"
        projection={p?.projected ?? null}
        label={`${w.label}の使用率`}
      />
      <p className="stat__foot stat__foot--split">
        <span>{left}</span>
        {p && <span className={`pace pace--${p.tone}`}>{paceLabel(p)}</span>}
      </p>
    </div>
  );
}

const SOON_MS = 3 * 86400_000;

export function SubscriptionCard({ sub, now }: { sub: SubscriptionSnapshot; now: number }) {
  const st = subscriptionStatus(sub, now);
  return (
    <article className="card sub">
      <header className="card__head">
        <div>
          <h3 className="card__title">{sub.label}</h3>
          <p className="card__sub">{sub.plan ?? "プラン不明"}</p>
        </div>
        <StatusPill tone={st.tone}>{st.short ?? st.text}</StatusPill>
      </header>

      {sub.message && <p className={`notice ${sub.status === "unconfigured" || sub.status === "dormant" ? "" : "notice--warn"}`}>{sub.message}</p>}

      {sub.windows.map((w) => (
        <Window key={w.id} w={w} now={now} />
      ))}

      {sub.tickets.length > 0 && (
        <div className="tickets">
          <p className="tickets__title">リセット券 {sub.tickets.length} 枚</p>
          <ul>
            {sub.tickets.map((t, i) => (
              <li key={i} className={t.expiresAt !== null && t.expiresAt - now < SOON_MS ? "tickets--soon" : ""}>
                <span>{t.label}</span>
                <span>{t.expiresAt === null ? "期限不明" : `${shortDate(t.expiresAt)} まで`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sub.notes.length > 0 && (
        <ul className="notes">
          {sub.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {sub.fetchedAt !== null && <p className="card__foot">{ago(sub.fetchedAt, now)}に取得</p>}
    </article>
  );
}
