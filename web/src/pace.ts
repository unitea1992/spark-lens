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
  if (p.untilFullSec !== null) return `約${duration(p.untilFullSec)}で上限`;
  return `終了時予測 ${Math.round(p.projected ?? 0)}%`;
}

function untilReset(w: UsageWindow, now: number): string | undefined {
  return w.resetsAt !== null && w.resetsAt > now ? `リセットまで約${duration((w.resetsAt - now) / 1000)}` : undefined;
}

/**
 * One status per service: the worst of its windows, counting pace as well as
 * use. `reset` says when the window behind a warning resets; the card already
 * shows it under each bar, so only the alert strip adds it.
 */
export function subscriptionStatus(
  sub: SubscriptionSnapshot,
  now: number,
): { tone: Tone; text: string; reset?: string; short?: string } {
  if (sub.status === "unconfigured") return { tone: "quiet", text: "未接続" };
  if (sub.status === "stale") return { tone: "warn", text: "要ログイン" };
  if (sub.status === "dormant") return { tone: "quiet", text: "最終取得値" };
  if (sub.status === "error" && sub.windows.length === 0) return { tone: "warn", text: "取得失敗" };
  const known = sub.windows.filter((w) => w.usedPct !== null);
  if (known.length === 0) return { tone: "quiet", text: "使用率不明" };
  const full = known.find((w) => w.usedPct! >= 100);
  if (full) return { tone: "critical", text: "上限に到達", reset: untilReset(full, now) };
  const fast = known
    .map((w) => ({ w, p: pace(w, now) }))
    .filter((x): x is { w: UsageWindow; p: Pace } => x.p !== null && x.p.untilFullSec !== null)
    .sort((a, b) => a.p.untilFullSec! - b.p.untilFullSec!)[0];
  if (fast)
    return {
      tone: "warn",
      text: `約${duration(fast.p.untilFullSec!)}で上限に達する見込み`,
      reset: untilReset(fast.w, now),
      // On the card the window itself says when; the header only flags it.
      short: "ペース速め",
    };
  if (known.some((w) => w.usedPct! >= 80)) return { tone: "warn", text: "残りわずか" };
  return { tone: "good", text: "余裕あり" };
}
