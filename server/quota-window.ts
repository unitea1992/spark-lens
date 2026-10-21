import { pace } from "../web/src/pace.ts";
import { jst } from "./jst.ts";
import { type QuotaSeries, latestAllowanceReset, latestPlanChange, windowTrend } from "./quota-history.ts";
import type { PaceJudgment, QuotaTrendSource, QuotaWindow, WindowPlan } from "./quota.ts";
import type { UsageWindow } from "./types.ts";

// One usage window of a subscription: where it is projected to end, and how
// to spend what is left of it before the reset.

/** Pace only means something over a window this long; a 5-hour window swings too much. */
export const PACE_MIN_WINDOW_SEC = 24 * 3600;
/** |used − elapsed| within this many points counts as on pace. */
const PACE_ON_BAND_PCT = 10;
/** The speed needs readings covering this long; minutes of readings scaled to hours swing wildly. */
const MIN_PROJECT_HOURS = 2;
/** Speed is read over the last day of readings: a whole day evens out working and sleeping hours, and still follows a changed pace. */
const PACE_HOURS = 24;
/** The speed is stretched over at most this many times the time it was read over; one step of use must not swing a week. */
const MAX_STRETCH = 24;
/** A refill or plan change this long before the nominal window start still belongs to it (Codex slides `reset_at` while at 0%). */
const BASIS_SLACK_MS = 3_600_000;

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function windowPlan(w: UsageWindow, now: number, anchorAt: number | null, horizonAt: number | null): WindowPlan | null {
  if (w.usedPct === null || w.windowSec == null || w.windowSec < PACE_MIN_WINDOW_SEC || w.resetsAt === null || w.resetsAt <= now) return null;
  const start = w.resetsAt - w.windowSec * 1000;
  const horizon = horizonAt !== null && horizonAt > now && horizonAt < w.resetsAt ? horizonAt : w.resetsAt;
  const anchor = anchorAt !== null && anchorAt > start && anchorAt < horizon ? anchorAt : start;
  if (horizon <= anchor || now < anchor) return null;
  const elapsed = ((now - anchor) / (horizon - anchor)) * 100;
  if (elapsed < 0 || elapsed > 100) return null;
  const remaining = Math.max(0, Math.round(100 - w.usedPct));
  const daysReset = (w.resetsAt - now) / 86_400_000;
  const daysBudget = (horizon - now) / 86_400_000;
  const gap = w.usedPct - elapsed;
  const judgment: PaceJudgment = gap > PACE_ON_BAND_PCT ? "over" : gap < -PACE_ON_BAND_PCT ? "under" : "on";
  return {
    remaining_pct: remaining,
    days_until_reset: round1(daysReset),
    // Budget runs to the reset, or to a plan change that arrives first. A few minutes left must not read as thousands of percent.
    daily_allowance_pct: round1(remaining / Math.max(daysBudget, 1 / 24)),
    elapsed_pct: round1(elapsed),
    pace: judgment,
  };
}

function windowStartMs(w: UsageWindow): number | null {
  return w.resetsAt === null || w.windowSec == null ? null : w.resetsAt - w.windowSec * 1000;
}

/** A moment belongs to this window when it is not clearly inside the previous one. */
function inThisWindow(at: number, start: number | null): boolean {
  return start === null || at >= start - BASIS_SLACK_MS;
}

function basisOf(w: UsageWindow, now: number, series: QuotaSeries | null): { allowanceResetAt: number | null; planChangedAt: number | null } {
  const start = windowStartMs(w);
  const drop = series ? latestAllowanceReset(series, now) : null;
  const change = series ? latestPlanChange(series, now) : null;
  return {
    allowanceResetAt: drop && inThisWindow(drop.at, start) ? drop.at : null,
    planChangedAt: change && inThisWindow(change.at, start) ? change.at : null,
  };
}

/**
 * Points used per hour over the last day of readings. A reset or refill only
 * zeroes the counter, so use on both sides counts and a fresh window is not
 * read from its first burst alone; the stretch across the drop itself is
 * left out, since its use is not known. A plan change moves the denominator, so
 * nothing before it counts. Time spent at the limit is left out: nothing
 * could be used then. Readings too short for the time left give no speed.
 */
function recentSpeed(series: QuotaSeries | null, now: number, remainMs: number): number | null {
  if (!series) return null;
  const change = latestPlanChange(series, now);
  const from = Math.max(change?.at ?? -Infinity, now - PACE_HOURS * 3_600_000);
  let used = 0;
  let ms = 0;
  const points = series.points;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a[0] < from || b[0] > now || a[1] >= 100 || b[1] < a[1]) continue;
    ms += b[0] - a[0];
    used += b[1] - a[1];
  }
  return ms >= Math.max(MIN_PROJECT_HOURS * 3_600_000, remainMs / MAX_STRETCH) ? used / (ms / 3_600_000) : null;
}

/**
 * End-of-window share at the speed of the last day. Without enough readings
 * it falls back to the window average, except after a refill or plan change,
 * whose earlier share would mislead it.
 * A known renewal before the reset means the end of the window is not knowable.
 */
function projectEnd(
  w: UsageWindow,
  now: number,
  series: QuotaSeries | null,
  renewsAt: number | null,
): { projected: number | null; allowanceResetAt: number | null; planChangedAt: number | null; anchorAt: number | null; horizonAt: number | null } {
  const basis = basisOf(w, now, series);
  const anchors = [basis.allowanceResetAt, basis.planChangedAt].filter((t): t is number => t !== null);
  const anchorAt = anchors.length > 0 ? Math.max(...anchors) : null;
  const renewalCuts = renewsAt !== null && w.resetsAt !== null && renewsAt > now && renewsAt < w.resetsAt;
  const horizonAt = renewalCuts ? renewsAt : null;
  const blank = { ...basis, anchorAt, horizonAt, projected: null as number | null };
  if (renewalCuts) return blank;
  if (w.usedPct !== null && w.resetsAt !== null && w.resetsAt > now) {
    const speed = recentSpeed(series, now, w.resetsAt - now);
    if (speed !== null) {
      return { ...basis, anchorAt, horizonAt, projected: Math.round(w.usedPct + (speed * (w.resetsAt - now)) / 3_600_000) };
    }
    if (anchorAt !== null) return blank;
  }
  const paced = pace(w, now);
  return { ...basis, anchorAt, horizonAt, projected: paced === null || paced.projected === null ? null : Math.round(paced.projected) };
}

export function quotaWindow(w: UsageWindow, now: number, renewsAt: number | null, history?: { sub: string; source: QuotaTrendSource }): QuotaWindow {
  const series = history ? history.source.series(history.sub, w.id) : null;
  const projected = projectEnd(w, now, series, renewsAt);
  const days = history?.source.days;
  return {
    id: w.id,
    label: w.label,
    used_pct: w.usedPct,
    resets_at: w.resetsAt,
    resets_at_jst: jst(w.resetsAt),
    projected_end_pct: projected.projected,
    allowance_reset_at: projected.allowanceResetAt,
    allowance_reset_at_jst: jst(projected.allowanceResetAt),
    plan_changed_at: projected.planChangedAt,
    plan_changed_at_jst: jst(projected.planChangedAt),
    plan: windowPlan(w, now, projected.anchorAt, projected.horizonAt),
    ...(days !== undefined ? { trend: series ? windowTrend(series, now, days) : null } : {}),
  };
}
