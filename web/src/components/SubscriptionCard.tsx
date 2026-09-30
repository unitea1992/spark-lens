import type { SubscriptionSnapshot, UsageWindow } from "../../../server/types.ts";
import { ago, duration, pct, resetAt } from "../format.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { StatusPill } from "./StatusPill.tsx";

/** Share of the window that has already passed, 0..100. */
function elapsedPct(w: UsageWindow, now: number): number | null {
  if (!w.windowSec || w.resetsAt === null) return null;
  const remaining = (w.resetsAt - now) / 1000;
  if (remaining < 0 || remaining > w.windowSec) return null;
  return (1 - remaining / w.windowSec) * 100;
}

function paceNote(w: UsageWindow, elapsed: number | null): string | null {
  if (elapsed === null || w.usedPct === null || w.usedPct < 5) return null;
  // More than a fifth ahead of an even spend is worth saying out loud.
  return w.usedPct > elapsed + 20 ? "ペース速め" : null;
}

function Window({ w, now }: { w: UsageWindow; now: number }) {
  const elapsed = elapsedPct(w, now);
  const level = levelFor(w.usedPct, 80, 95);
  const remaining = w.resetsAt === null ? null : (w.resetsAt - now) / 1000;
  const pace = paceNote(w, elapsed);
  return (
    <div className="stat">
      <div className="stat__line">
        <span>{w.label}</span>
        <span>
          {pace && <em className="stat__flag">{pace}</em>}
          <strong>{pct(w.usedPct)}</strong>
        </span>
      </div>
      <Meter
        value={w.usedPct}
        level={level}
        marker={elapsed}
        markerLabel="期間の経過位置（均等に使った場合の目安）"
        label={`${w.label}の使用率`}
      />
      <p className="stat__foot">
        {remaining !== null && remaining <= 0 ? "リセット済み（次回利用時に更新）" : resetAt(w.resetsAt, now)}
        {remaining !== null && remaining > 0 ? `・あと ${duration(remaining)}` : ""}
      </p>
    </div>
  );
}

export function SubscriptionCard({ sub, now }: { sub: SubscriptionSnapshot; now: number }) {
  const worst = Math.max(0, ...sub.windows.map((w) => w.usedPct ?? 0));
  return (
    <article className="card sub">
      <header className="card__head">
        <div>
          <h3 className="card__title">{sub.label}</h3>
          <p className="card__sub">{sub.plan ?? "プラン不明"}</p>
        </div>
        {sub.status === "ok" ? (
          worst >= 95 ? (
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
