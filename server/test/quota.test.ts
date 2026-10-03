import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaReport } from "../quota.ts";
import type { LlmSnapshot, SubscriptionSnapshot, UsageWindow } from "../types.ts";

const NOW = Date.parse("2026-10-03T00:00:00Z");
const H = 3600_000;

function sub(windows: UsageWindow[], over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return { id: "s", type: "t", label: "S", plan: "Pro", status: "ok", message: null, windows, notes: [], tickets: [], fetchedAt: NOW - 60_000, ...over };
}
const win = (id: string, usedPct: number | null, resetsAt: number | null, windowSec: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  id, label: id, usedPct, resetsAt, windowSec, ...over,
});
const report = (s: SubscriptionSnapshot) => quotaReport({ subscriptions: [s], llms: [] }, NOW).models[0]!;

test("a window at 100% is limited, and recovery is when the last full window resets", () => {
  const m = report(sub([win("5h", 100, NOW + 2 * H, 5 * 3600), win("week", 100, NOW + 30 * H, 7 * 86400), win("m", 10, NOW + 99 * H, 30 * 86400)]));
  assert.equal(m.state, "limited");
  assert.equal(m.recommendation, "avoid");
  assert.equal(m.recovers_at, NOW + 30 * H);
  assert.equal(m.recovers_at_jst, "2026-10-04T15:00:00+09:00");
});

test("headroom thresholds split heavy and light work", () => {
  const at = (pct: number) => report(sub([win("w", pct, NOW + 3 * 86400_000, 7 * 86400)])).recommendation;
  assert.equal(at(20), "use");
  assert.equal(at(80), "avoid_heavy");
  assert.equal(at(95), "avoid");
});

test("a weekly window burning faster than its pace steers heavy work away", () => {
  // 3 days in, 60% used: ends near 140%.
  const m = report(sub([win("week", 60, NOW + 4 * 86400_000, 7 * 86400)]));
  assert.equal(m.recommendation, "avoid_heavy");
  assert.ok((m.windows[0]?.projected_end_pct ?? 0) > 100);
});

test("a short window's pace alone does not count", () => {
  const m = report(sub([win("5h", 60, NOW + 3 * H, 5 * 3600)]));
  assert.equal(m.recommendation, "use");
});

test("an old fetch is flagged stale", () => {
  const m = report(sub([win("w", 10, NOW + 86400_000, 7 * 86400)], { fetchedAt: NOW - 30 * 60_000 }));
  assert.equal(m.stale, true);
  assert.equal(m.age_sec, 1800);
  assert.match(m.reason, /取得が古い/);
});

test("no readable numbers is unknown, not usable", () => {
  assert.equal(report(sub([], { status: "stale" })).state, "unknown");
  assert.equal(report(sub([], { status: "unconfigured" })).recommendation, "unknown");
});

test("local LLMs report loading separately from up", () => {
  const llm = (state: LlmSnapshot["state"]) => ({ id: "g", label: "GLM", state, requestsWaiting: 0 }) as LlmSnapshot;
  const states = (["up", "starting", "down"] as const).map((s) => quotaReport({ subscriptions: [], llms: [llm(s)] }, NOW).models[0]!);
  assert.deepEqual(states.map((m) => m.state), ["usable", "loading", "down"]);
  assert.deepEqual(states.map((m) => m.recommendation), ["use", "avoid", "avoid"]);
});
