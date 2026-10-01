import type { SubscriptionSnapshot, UsageWindow } from "../../../server/types.ts";
import { ago, duration, pct, resetAt, shortDate } from "../format.ts";
import { elapsedPct, pace } from "../pace.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { StatusPill } from "./StatusPill.tsx";

function Window({ w, now }: { w: UsageWindow; now: number }) {
  const elapsed = elapsedPct(w, now);
  const remaining = w.resetsAt === null ? null : (w.resetsAt - now) / 1000;
  const p = pace(w, now);
  return (
    <div className="stat">
      <div className="stat__line">
        <span>{w.label}</span>
        <span>
          <strong>{pct(w.usedPct)}</strong>
        </span>
      </div>
      <Meter
        value={w.usedPct}
        level={levelFor(w.usedPct, 80, 95)}
        marker={elapsed}
        markerLabel="期間の経過位置（均等に使った場合の目安）"
        label={`${w.label}の使用率`}
      />
      <p className="stat__foot">
        {w.idle
          ? "未使用（次に使い始めた時点から数え始めます）"
          : remaining !== null && remaining <= 0
            ? "リセット予定時刻を経過（次回の取得で更新）"
            : `${resetAt(w.resetsAt, now)}${remaining !== null ? `・あと ${duration(remaining)}` : ""}`}
      </p>
      {p && (
        <p className={`pace pace--${p.tone}`}>
          <span className="pace__dot" aria-hidden="true" />
          {p.text}
        </p>
      )}
    </div>
  );
}

const SOON_MS = 3 * 86400_000;

export function SubscriptionCard({ sub, now }: { sub: SubscriptionSnapshot; now: number }) {
  const known = sub.windows.filter((w) => w.usedPct !== null);
  const worst = Math.max(0, ...known.map((w) => w.usedPct!));
  return (
    <article className="card sub">
      <header className="card__head">
        <div>
          <h3 className="card__title">{sub.label}</h3>
          <p className="card__sub">{sub.plan ?? "プラン不明"}</p>
        </div>
        {sub.status === "ok" ? (
          known.length === 0 ? (
            <StatusPill tone="quiet">使用率不明</StatusPill>
          ) : worst >= 100 ? (
            <StatusPill tone="critical">上限に到達</StatusPill>
          ) : worst >= 95 ? (
            <StatusPill tone="critical">上限間近</StatusPill>
          ) : worst >= 80 ? (
            <StatusPill tone="warn">残りわずか</StatusPill>
          ) : (
            <StatusPill tone="good">余裕あり</StatusPill>
          )
        ) : sub.status === "unconfigured" ? (
          <StatusPill tone="quiet">未接続</StatusPill>
        ) : (
          <StatusPill tone="warn">{sub.status === "stale" ? "要ログイン" : "取得失敗"}</StatusPill>
        )}
      </header>

      {sub.message && <p className={`notice ${sub.status === "unconfigured" ? "" : "notice--warn"}`}>{sub.message}</p>}

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
