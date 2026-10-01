import { useEffect, useRef, useState } from "react";
import type { RecipeSnapshot } from "../../../server/types.ts";
import { duration } from "../format.ts";

/**
 * A model coming up: stage, share done and time, drawn as one bar. Without a
 * reading (a start made outside the dashboard) the bar runs indeterminate.
 */
export function StartProgress({ progress, now }: { progress: RecipeSnapshot["progress"]; now: number }) {
  const reading = progress?.pct ?? null;
  // Between log readings the bar keeps easing forward, never past the next
  // milestone it could plausibly reach, so it reads as alive without lying.
  const since = useRef<{ pct: number | null; at: number }>({ pct: reading, at: now });
  if (since.current.pct !== reading) since.current = { pct: reading, at: now };
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 400);
    return () => clearInterval(t);
  }, []);
  const ceiling = reading === null ? null : Math.min(98, reading + (reading < 70 ? 12 : 6));
  const pct =
    reading === null || ceiling === null
      ? null
      : Math.round(reading + (ceiling - reading) * (1 - Math.exp(-(Date.now() - since.current.at) / 45_000)));
  const elapsed = progress ? (now - progress.startedAt) / 1000 : null;
  const expected = progress?.expectedSec ?? null;
  const left = expected !== null && elapsed !== null ? Math.max(0, expected - elapsed) : null;
  return (
    <div className="startbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="起動の進み具合">
      <div className="startbar__line">
        <span className="startbar__stage">{progress?.stage ?? "モデルを読み込んでいます"}</span>
        {pct !== null && <strong className="startbar__pct">{pct}%</strong>}
      </div>
      <div className={`startbar__track${pct === null ? " startbar__track--unknown" : ""}`}>
        <div className="startbar__fill" style={pct === null ? undefined : { width: `${Math.max(3, pct)}%` }} />
      </div>
      {elapsed !== null && (
        <p className="startbar__time">
          経過 {duration(elapsed)}
          {left !== null ? (left > 30 ? `・残り 約${duration(left)}（前回の起動時間から）` : "・まもなく完了") : ""}
        </p>
      )}
    </div>
  );
}
