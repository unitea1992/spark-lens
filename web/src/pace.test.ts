import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubscriptionSnapshot, UsageWindow } from "../../server/types.ts";
import { elapsedPct, pace, paceLabel, subscriptionStatus } from "./pace.ts";

const HOUR = 3600_000;
const now = Date.UTC(2026, 9, 1, 12);
const window = (usedPct: number, hoursLeft: number): UsageWindow => ({
  id: "w",
  label: "5時間",
  usedPct,
  resetsAt: now + hoursLeft * HOUR,
  windowSec: 5 * 3600,
});

test("elapsedPct places now inside the window", () => {
  assert.ok(Math.abs((elapsedPct(window(0, 4), now) ?? 0) - 20) < 1e-9);
  assert.equal(elapsedPct(window(0, 6), now), null);
  assert.equal(elapsedPct({ ...window(0, 4), windowSec: null }, now), null);
});

test("pace projects the end-of-window share from use so far", () => {
  // 20% used with 40% of the window gone ends near 50%.
  const easy = pace(window(20, 3), now)!;
  assert.equal(easy.tone, "good");
  assert.equal(paceLabel(easy), "終了時予測 50%");
  assert.equal(pace(window(36, 3), now)?.tone, "ok");
  // 60% used at 40% elapsed runs out with 40% left at 30%/h -> about 1h20m.
  const fast = pace(window(60, 3), now)!;
  assert.equal(fast.tone, "warn");
  assert.match(paceLabel(fast), /1時間 20分/);
  assert.equal(pace(window(100, 3), now)?.tone, "critical");
});

test("pace stays quiet too early in a window or without numbers", () => {
  assert.equal(pace(window(1, 4.9), now), null);
  assert.equal(pace({ ...window(10, 3), usedPct: null }, now), null);
});

const sub = (windows: UsageWindow[], status: SubscriptionSnapshot["status"] = "ok"): SubscriptionSnapshot => ({
  id: "s",
  type: "t",
  label: "S",
  plan: null,
  status,
  message: null,
  windows,
  notes: [],
  tickets: [],
  fetchedAt: now,
});

test("a service's status is its worst window, pace included", () => {
  assert.equal(subscriptionStatus(sub([window(20, 3)]), now).text, "余裕あり");
  assert.deepEqual(subscriptionStatus({ ...sub([window(20, 3)]), status: "dormant" }, now), { tone: "quiet", text: "最終取得値" });
  assert.match(subscriptionStatus(sub([window(20, 3), window(60, 3)]), now).text, /で上限に達する見込み$/);
  assert.equal(subscriptionStatus(sub([window(85, 0.5)]), now).text, "残りわずか");
  assert.equal(subscriptionStatus(sub([window(100, 3)]), now).tone, "critical");
  assert.equal(subscriptionStatus(sub([], "unconfigured"), now).text, "未接続");
  assert.equal(subscriptionStatus(sub([], "error"), now).text, "取得失敗");
});

test("trendLine says how fast a window fills and how high the last one went", async () => {
  const { trendLine } = await import("./pace.ts");
  assert.equal(trendLine(undefined), null);
  assert.equal(trendLine({ ratePctPerHour24h: 0.5, rateSpanHours: 24, previousPeakPct: 96.4, since: 0 }), "直近24時間 +0.5%/時 / 前回の最大 96%");
  assert.equal(trendLine({ ratePctPerHour24h: 0.04, rateSpanHours: 5.6, previousPeakPct: null, since: 0 }), "直近5時間 +0.04%/時");
  assert.equal(trendLine({ ratePctPerHour24h: null, rateSpanHours: null, previousPeakPct: null, since: 0 }), null);
});
