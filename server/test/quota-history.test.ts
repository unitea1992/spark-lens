import assert from "node:assert/strict";
import { test } from "node:test";
import { daysParam } from "../http.ts";
import { QUOTA_KEEP_DAYS, QuotaHistory, windowTrend } from "../quota-history.ts";
import { quotaReport } from "../quota.ts";
import type { SubscriptionSnapshot, UsageWindow } from "../types.ts";

const NOW = Date.parse("2026-10-08T00:00:00Z");
const H = 3600_000;
const D = 24 * H;

function sub(fetchedAt: number, windows: UsageWindow[], over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return { id: "s", type: "t", label: "S", plan: null, status: "ok", message: null, windows, notes: [], tickets: [], fetchedAt, ...over };
}
const weekly = (usedPct: number, resetsAt: number): UsageWindow => ({ id: "weekly_scoped:Fable", label: "週間", usedPct, resetsAt, windowSec: 7 * 86400 });

test("a fetch that did not happen adds nothing, and an unchanged reading is kept only every half hour", () => {
  const h = new QuotaHistory();
  const reset = NOW + 3 * D;
  h.record([sub(NOW, [weekly(10, reset)])], NOW);
  h.record([sub(NOW, [weekly(10, reset)])], NOW + 60_000); // same fetch, read again
  h.record([sub(NOW + 5 * 60_000, [weekly(10, reset)])], NOW + 5 * 60_000); // unchanged
  h.record([sub(NOW + 10 * 60_000, [weekly(11, reset)])], NOW + 10 * 60_000); // moved
  h.record([sub(NOW + 45 * 60_000, [weekly(11, reset)])], NOW + 45 * 60_000); // unchanged, but 35 minutes on
  assert.deepEqual(
    h.series("s", "weekly_scoped:Fable")!.points.map((p) => p[1]),
    [10, 11, 11],
  );
});

test("failed or unconfigured services are not recorded", () => {
  const h = new QuotaHistory();
  h.record([sub(NOW, [weekly(10, NOW + D)], { status: "error" }), sub(NOW, [weekly(10, NOW + D)], { id: "u", fetchedAt: null })], NOW);
  assert.deepEqual(h.dump(), {});
});

test("readings older than the kept days are dropped, and `since` follows", () => {
  const old = NOW - (QUOTA_KEEP_DAYS + 1) * D;
  const h = new QuotaHistory({ s: { w: { since: old, points: [[old, 5, null], [NOW - D, 7, null]] } } });
  h.record([], NOW);
  const s = h.series("s", "w")!;
  assert.deepEqual(s.points, [[NOW - D, 7, null]]);
  assert.equal(s.since, NOW - D);
});

test("the trend gives the 24-hour rate of the current window and the previous window's peak", () => {
  const prevReset = NOW - 2 * D;
  const reset = NOW + 5 * D;
  const series = {
    since: NOW - 9 * D,
    points: [
      [NOW - 9 * D, 20, prevReset],
      [NOW - 4 * D, 96, prevReset],
      [NOW - 2 * D + H, 0, reset], // the window reset
      [NOW - D, 10, reset],
      [NOW - 12 * H, 16, reset],
      [NOW, 22, reset],
    ] as [number, number, number | null][],
  };
  const t = windowTrend(series, NOW, 7);
  assert.equal(t.rate_pct_per_hour_24h, 0.5); // 10 -> 22 over 24 hours
  assert.equal(t.previous_window_peak_pct, 96);
  assert.equal(t.previous_window_reset_at, prevReset);
  assert.equal(t.points.length, 5); // the first reading is older than 7 days
  assert.equal(t.since, NOW - 9 * D);
});

test("a single reading has no rate and no previous window", () => {
  const t = windowTrend({ since: NOW, points: [[NOW, 3, NOW + D]] }, NOW, 7);
  assert.equal(t.rate_pct_per_hour_24h, null);
  assert.equal(t.previous_window_peak_pct, null);
});

test("/api/quota adds trends only when days are asked for", () => {
  const s = sub(NOW - 60_000, [weekly(22, NOW + 5 * D)]);
  const plain = quotaReport({ subscriptions: [s], llms: [] }, NOW);
  assert.equal("trend" in plain.models[0]!.windows[0]!, false);
  assert.equal(plain.trend_days, undefined);
  const withTrend = quotaReport({ subscriptions: [s], llms: [] }, NOW, {
    days: 7,
    series: (subId, win) => (subId === "s" && win === "weekly_scoped:Fable" ? { since: NOW - D, points: [[NOW - D, 10, NOW + 5 * D], [NOW - 60_000, 22, NOW + 5 * D]] } : null),
  });
  assert.equal(withTrend.trend_days, 7);
  assert.equal(withTrend.models[0]!.windows[0]!.trend?.points.length, 2);
});

test("days must be a whole number, and is capped", () => {
  assert.equal(daysParam("/api/quota", 35), null);
  assert.equal(daysParam("/api/quota?days=7", 35), 7);
  assert.equal(daysParam("/api/quota?days=90", 35), 35);
  assert.equal(daysParam("/api/quota?days=0", 35), null);
  assert.equal(daysParam("/api/quota?days=-3", 35), null);
  assert.equal(daysParam("/api/quota?days=2.5", 35), null);
});
