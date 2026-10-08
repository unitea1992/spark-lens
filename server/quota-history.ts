// How each subscription window's use moved over the last weeks, so an agent
// can read the trend (how fast a window fills, how high the last one peaked)
// and not only the present reading.

import type { SubscriptionSnapshot } from "./types.ts";

/** Five weekly windows: enough to compare this week with the previous ones. */
export const QUOTA_KEEP_DAYS = 35;
/** An unchanged reading is still written this often, so a flat stretch shows as flat, not missing. */
const HEARTBEAT_MS = 30 * 60_000;
const DAY_MS = 24 * 3600_000;

/** One reading: when it was fetched, the share used, and when the window resets. */
export type QuotaPoint = [at: number, usedPct: number, resetsAt: number | null];

export interface QuotaSeries {
  /** When this series started (the first reading kept); older history is not known. */
  since: number;
  points: QuotaPoint[];
}

/** subscription id -> window id -> series. Window ids can contain colons, so they are not joined into one key. */
export type QuotaHistoryDump = Record<string, Record<string, QuotaSeries>>;

export class QuotaHistory {
  private data: QuotaHistoryDump;

  constructor(saved: QuotaHistoryDump = {}) {
    this.data = {};
    for (const [sub, windows] of Object.entries(saved ?? {})) {
      for (const [win, s] of Object.entries(windows ?? {})) {
        if (!s || !Array.isArray(s.points)) continue;
        const points = s.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (points.length > 0) (this.data[sub] ??= {})[win] = { since: Number.isFinite(s.since) ? s.since : points[0]![0], points };
      }
    }
  }

  /** Keep the windows' readings from the latest fetch. A fetch that did not happen (same fetchedAt) adds nothing. */
  record(subs: SubscriptionSnapshot[], now = Date.now()): void {
    for (const sub of subs) {
      if (sub.fetchedAt === null || sub.status !== "ok") continue;
      for (const w of sub.windows) {
        if (w.usedPct === null || !Number.isFinite(w.usedPct)) continue;
        const series = ((this.data[sub.id] ??= {})[w.id] ??= { since: sub.fetchedAt, points: [] });
        const last = series.points[series.points.length - 1];
        if (last && sub.fetchedAt <= last[0]) continue;
        if (last && last[1] === w.usedPct && last[2] === w.resetsAt && sub.fetchedAt - last[0] < HEARTBEAT_MS) continue;
        series.points.push([sub.fetchedAt, w.usedPct, w.resetsAt]);
      }
    }
    this.trim(now);
  }

  private trim(now: number): void {
    const oldest = now - QUOTA_KEEP_DAYS * DAY_MS;
    for (const [sub, windows] of Object.entries(this.data)) {
      for (const [win, s] of Object.entries(windows)) {
        const drop = s.points.findIndex((p) => p[0] >= oldest);
        if (drop === -1) {
          delete windows[win];
          continue;
        }
        if (drop > 0) {
          s.points.splice(0, drop);
          s.since = Math.max(s.since, s.points[0]![0]);
        }
      }
      if (Object.keys(windows).length === 0) delete this.data[sub];
    }
  }

  series(sub: string, win: string): QuotaSeries | null {
    return this.data[sub]?.[win] ?? null;
  }

  dump(): QuotaHistoryDump {
    return this.data;
  }
}

export interface WindowTrend {
  /** When the kept history starts; earlier readings are not known. */
  since: number;
  /** Readings in the last `days` days, oldest first. */
  points: { at: number; used_pct: number; resets_at: number | null }[];
  /** Percentage points used per hour over the last 24 hours of this window; null without two readings in it. */
  rate_pct_per_hour_24h: number | null;
  /** The highest use the previous window reached before it reset; null when that window is not in the history. */
  previous_window_peak_pct: number | null;
  /** When that previous window reset. */
  previous_window_reset_at: number | null;
}

/** Two reset times this close are the same window (providers jitter the timestamp). */
const SAME_RESET_MS = 10 * 60_000;
const sameWindow = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) < SAME_RESET_MS);

/** The trend of one window from its series. Pure, for the quota report. */
export function windowTrend(series: QuotaSeries, now: number, days: number): WindowTrend {
  const from = now - days * DAY_MS;
  const points = series.points.filter((p) => p[0] >= from).map(([at, used, resets]) => ({ at, used_pct: used, resets_at: resets }));

  // The current window is the run of readings at the end that share its reset time.
  const all = series.points;
  let start = all.length - 1;
  while (start > 0 && sameWindow(all[start - 1]![2], all[all.length - 1]![2]) && all[start - 1]![1] <= all[start]![1]) start--;
  const current = all.slice(start);

  const dayAgo = now - DAY_MS;
  const recent = current.filter((p) => p[0] >= dayAgo);
  let rate: number | null = null;
  if (recent.length >= 2) {
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const hours = (last[0] - first[0]) / 3600_000;
    if (hours > 0) rate = Math.round(((last[1] - first[1]) / hours) * 100) / 100;
  }

  let peak: number | null = null;
  let resetAt: number | null = null;
  if (start > 0) {
    let end = start - 1;
    const ref = all[end]![2];
    peak = all[end]![1];
    while (end > 0 && sameWindow(all[end - 1]![2], ref) && all[end - 1]![1] <= all[end]![1]) {
      end--;
      peak = Math.max(peak, all[end]![1]);
    }
    resetAt = ref;
  }

  return { since: series.since, points, rate_pct_per_hour_24h: rate, previous_window_peak_pct: peak, previous_window_reset_at: resetAt };
}
