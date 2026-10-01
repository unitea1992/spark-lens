import type { UsageWindow } from "../../server/types.ts";
import { duration } from "./format.ts";

/** Share of the window that has already passed, 0..100. */
export function elapsedPct(w: UsageWindow, now: number): number | null {
  if (!w.windowSec || w.resetsAt === null) return null;
  const remaining = (w.resetsAt - now) / 1000;
  if (remaining < 0 || remaining > w.windowSec) return null;
  return (1 - remaining / w.windowSec) * 100;
}

export interface Pace {
  tone: "good" | "ok" | "warn" | "critical";
  text: string;
}

/**
 * Where this window ends up if use continues at the rate seen so far.
 * Too early in a window the projection is noise, so it stays quiet.
 */
export function pace(w: UsageWindow, now: number): Pace | null {
  if (w.usedPct === null) return null;
  if (w.usedPct >= 100) return { tone: "critical", text: "上限に達しています" };
  const elapsed = elapsedPct(w, now);
  if (elapsed === null || elapsed < 5 || !w.windowSec) return null;
  const projected = (w.usedPct / elapsed) * 100;
  if (projected <= 75) return { tone: "good", text: `余裕あり・このペースでの期間終了時の使用率予測 約${Math.round(projected)}%` };
  if (projected <= 100) return { tone: "ok", text: `期間内に収まる見込み・このペースでの期間終了時の使用率予測 約${Math.round(projected)}%` };
  const ratePerSec = w.usedPct / ((elapsed / 100) * w.windowSec);
  const untilFull = (100 - w.usedPct) / ratePerSec;
  return { tone: "warn", text: `速いペース・このままだと あと約${duration(untilFull)}で上限` };
}
