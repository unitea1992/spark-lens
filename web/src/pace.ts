import type { SubscriptionSnapshot, UsageWindow } from "../../server/types.ts";
import type { Tone } from "./tone.ts";
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
  /** Usage share expected at the end of the window if use continues like this. */
  projected: number | null;
  /** Time until the limit at this pace, when that comes before the reset. */
  untilFullSec: number | null;
}

/**
 * Where this window ends up if use continues at the rate seen so far.
 * Too early in a window the projection is noise, so it stays quiet.
 */
export function pace(w: UsageWindow, now: number): Pace | null {
  if (w.usedPct === null) return null;
  if (w.usedPct >= 100) return { tone: "critical", projected: 100, untilFullSec: 0 };
  const elapsed = elapsedPct(w, now);
  if (elapsed === null || elapsed < 5 || !w.windowSec) return null;
  const projected = (w.usedPct / elapsed) * 100;
  if (projected <= 75) return { tone: "good", projected, untilFullSec: null };
  if (projected <= 100) return { tone: "ok", projected, untilFullSec: null };
  const ratePerSec = w.usedPct / ((elapsed / 100) * w.windowSec);
  return { tone: "warn", projected, untilFullSec: (100 - w.usedPct) / ratePerSec };
}

export function paceLabel(p: Pace): string {
  if (p.tone === "critical") return "上限に到達";
  if (p.untilFullSec !== null) return `このままだと あと約${duration(p.untilFullSec)}で上限`;
  return `終了時予測 ${Math.round(p.projected ?? 0)}%`;
}

/** One status per service: the worst of its windows, counting pace as well as use. */
export function subscriptionStatus(sub: SubscriptionSnapshot, now: number): { tone: Tone; text: string } {
  if (sub.status === "unconfigured") return { tone: "quiet", text: "未接続" };
  if (sub.status === "stale") return { tone: "warn", text: "要ログイン" };
  if (sub.status === "error" && sub.windows.length === 0) return { tone: "warn", text: "取得失敗" };
  const known = sub.windows.filter((w) => w.usedPct !== null);
  if (known.length === 0) return { tone: "quiet", text: "使用率不明" };
  if (known.some((w) => w.usedPct! >= 100)) return { tone: "critical", text: "上限に到達" };
  const fast = known
    .map((w) => pace(w, now))
    .filter((p): p is Pace => p !== null && p.untilFullSec !== null)
    .sort((a, b) => a.untilFullSec! - b.untilFullSec!)[0];
  if (fast) return { tone: "warn", text: `ペース速め・あと約${duration(fast.untilFullSec!)}` };
  if (known.some((w) => w.usedPct! >= 80)) return { tone: "warn", text: "残りわずか" };
  return { tone: "good", text: "余裕あり" };
}
