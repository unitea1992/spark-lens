import assert from "node:assert/strict";
import { test } from "node:test";
import type { QuotaSeries } from "../quota-history.ts";
import { quotaReport, type QuotaTrendSource } from "../quota.ts";
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
  const llm = (state: LlmSnapshot["state"]) =>
    ({ id: "g", label: "GLM", state, models: ["GLM-5.3-Flash"], requestsRunning: 3, requestsWaiting: 0, poolTokens: 1918976, poolFreeTokens: 129024 }) as LlmSnapshot;
  const states = (["up", "starting", "down"] as const).map((s) => quotaReport({ subscriptions: [], llms: [llm(s)] }, NOW).models[0]!);
  assert.deepEqual(states.map((m) => m.state), ["usable", "loading", "down"]);
  assert.deepEqual(states.map((m) => m.recommendation), ["use", "avoid", "avoid"]);
  // Only the running server says which model it answers to and how busy it is.
  assert.deepEqual(states.map((m) => [m.served_model, m.requests_running, m.requests_waiting, m.pool_tokens, m.pool_free_tokens]), [
    ["GLM-5.3-Flash", 3, 0, 1918976, 129024],
    [null, null, null, null, null],
    [null, null, null, null, null],
  ]);
});

test("reset tickets are listed with their expiry in JST", () => {
  const exp = Date.parse("2026-10-05T08:46:00+09:00");
  const m = report(sub([win("w", 20, NOW + 86400_000, 7 * 86400)], { tickets: [{ label: "全リセット", expiresAt: exp }, { label: "無期限", expiresAt: null }] }));
  assert.equal(m.reset_tickets, 2);
  // The weekly window ends before the ticket does, so the plan spends it at that reset rather than at expiry.
  assert.deepEqual(m.tickets[0], {
    label: "全リセット",
    expires_at: exp,
    expires_at_jst: "2026-10-05T08:46:00+09:00",
    use_by: NOW + 86400_000,
    use_by_jst: "2026-10-04T09:00:00+09:00",
  });
  assert.equal(m.tickets[1]?.expires_at, null);
  assert.equal(m.tickets[1]?.use_by, null);
});

test("a ticket expiring soon lifts a pace-driven avoid_heavy to use, and says until when", () => {
  // Weekly pace says avoid_heavy; the ticket (expires in ~2 days) can wipe it.
  const week = [win("week", 60, NOW + 4 * 86400_000, 7 * 86400)];
  const exp = Date.parse("2026-10-05T08:46:00+09:00");
  assert.ok(exp - NOW < 72 * H);
  const m = report(sub(week, { tickets: [{ label: "全リセット", expiresAt: exp }] }));
  assert.equal(m.recommendation, "use");
  assert.match(m.reason, /期限が近いリセット券あり（10\/5\(月\) 08:46まで）/);
});

test("a distant or absent ticket changes nothing, and a limit already hit stays avoid", () => {
  const week = [win("week", 60, NOW + 4 * 86400_000, 7 * 86400)];
  const far = report(sub(week, { tickets: [{ label: "t", expiresAt: NOW + 10 * 86400_000 }] }));
  assert.equal(far.recommendation, "avoid_heavy");
  const expired = report(sub(week, { tickets: [{ label: "t", expiresAt: NOW - H }] }));
  assert.equal(expired.recommendation, "avoid_heavy");
  const limited = report(sub([win("week", 100, NOW + 30 * H, 7 * 86400)], { tickets: [{ label: "t", expiresAt: NOW + 20 * H }] }));
  assert.equal(limited.recommendation, "avoid");
  assert.match(limited.reason, /期限が近いリセット券あり/);
});

test("a ticket does not lift a stale reading", () => {
  const week = [win("week", 60, NOW + 4 * 86400_000, 7 * 86400)];
  const m = report(sub(week, { fetchedAt: NOW - 30 * 60_000, tickets: [{ label: "t", expiresAt: NOW + 20 * H }] }));
  assert.equal(m.recommendation, "avoid_heavy");
});

test("a window whose reset time has passed is not trusted, and the reading is marked stale", () => {
  const m = report(sub([win("5h", 72, NOW - 2 * H, 5 * 3600), win("week", 43, NOW + 3 * 86400_000, 7 * 86400)]));
  assert.equal(m.windows.length, 1);
  assert.equal(m.stale, true);
});

test("a reading stamped in the future is stale, not fresh", () => {
  const m = report(sub([win("week", 10, NOW + 3 * 86400_000, 7 * 86400)], { fetchedAt: NOW + 90 * 60_000 }));
  assert.equal(m.stale, true);
});

test("a long window carries a spend plan, and a lag in the second half is called out", () => {
  // 4 of 7 days gone, 20% used: under the calendar, with 80 points left across 3 days.
  const m = report(sub([win("week", 20, NOW + 3 * 86400_000, 7 * 86400), win("5h", 40, NOW + 2 * H, 5 * 3600)]));
  assert.equal(m.recommendation, "use");
  assert.equal(m.windows[1]?.plan, null);
  const plan = m.windows[0]?.plan;
  assert.ok(plan);
  assert.equal(plan.remaining_pct, 80);
  assert.equal(plan.days_until_reset, 3);
  assert.equal(plan.daily_allowance_pct, 26.7);
  assert.equal(plan.elapsed_pct, 57.1);
  assert.equal(plan.pace, "under");
  assert.match(m.reason, /weekは余りそう。割り振りを増やしてよい/);
});

test("pace is on when use tracks the calendar, and over when it runs ahead", () => {
  const halfway = report(sub([win("week", 50, NOW + 3.5 * 86400_000, 7 * 86400)]));
  assert.equal(halfway.windows[0]?.plan?.pace, "on");
  assert.equal(halfway.windows[0]?.plan?.elapsed_pct, 50);
  assert.doesNotMatch(halfway.reason, /余りそう/);
  // 3 days in, 60% used: ahead, but not yet the second half, so no surplus note.
  const ahead = report(sub([win("week", 60, NOW + 4 * 86400_000, 7 * 86400)]));
  assert.equal(ahead.windows[0]?.plan?.pace, "over");
  assert.equal(ahead.recommendation, "avoid_heavy");
  assert.doesNotMatch(ahead.reason, /余りそう/);
});

test("a stale lag is not described as spare room", () => {
  const m = report(sub([win("week", 20, NOW + 3 * 86400_000, 7 * 86400)], { fetchedAt: NOW - 30 * 60_000 }));
  assert.equal(m.windows[0]?.plan?.pace, "under");
  assert.doesNotMatch(m.reason, /余りそう/);
  assert.match(m.reason, /取得が古い/);
});

test("each reset ticket gets a deadline, and extras that outrun the resets are due at expiry", () => {
  const reset = NOW + 2 * 86400_000;
  const soon = NOW + 3 * 86400_000;
  const later = NOW + 20 * 86400_000;
  const m = report(
    sub([win("week", 30, reset, 7 * 86400)], {
      tickets: [
        { label: "後", expiresAt: later },
        { label: "先", expiresAt: soon },
        { label: "同じ", expiresAt: soon },
      ],
    }),
  );
  const byLabel = Object.fromEntries(m.tickets.map((t) => [t.label, t.use_by]));
  // Soonest expiry takes the only window end before it. The twin has no slot left, so it is due at expiry.
  assert.equal(byLabel["先"], reset);
  assert.equal(byLabel["同じ"], soon);
  // The later ticket takes the latest window end that still precedes its expiry (reset + 14d).
  assert.equal(byLabel["後"], reset + 14 * 86400_000);
  assert.match(m.reason, /リセット券は10\/5\(月\) 09:00までに使う計画/);
  assert.equal(m.recommendation, "use");
});

test("an unannounced refill projects from later readings, not from the wiped usage", () => {
  const reset = NOW + 2 * 86400_000;
  const series: QuotaSeries = {
    since: NOW - 5 * 86400_000,
    points: [
      [NOW - 5 * 86400_000, 90, reset],
      [NOW - 6 * H, 5, reset],
      [NOW, 20, reset],
    ],
  };
  const source: QuotaTrendSource = { series: (id, win) => (id === "s" && win === "week" ? series : null) };
  const m = quotaReport({ subscriptions: [sub([win("week", 20, reset, 7 * 86400)])], llms: [] }, NOW, source).models[0]!;
  // 5% -> 20% over 6 hours, 48 hours left: 20 + 2.5*48 = 140. The window average would say ~28.
  assert.equal(m.windows[0]?.projected_end_pct, 140);
  assert.equal(m.windows[0]?.allowance_reset_at, NOW - 6 * H);
  assert.equal(m.windows[0]?.allowance_reset_at_jst, "2026-10-03T03:00:00+09:00");
  assert.equal(m.recommendation, "avoid_heavy");
  assert.equal("trend" in m.windows[0]!, false);
});

test("a refill from an earlier window does not rewrite the one open now", () => {
  const reset = NOW + 3 * H;
  const series: QuotaSeries = {
    since: NOW - 2 * 86400_000,
    points: [
      [NOW - 2 * 86400_000, 80, NOW - 86400_000],
      [NOW - 2 * 86400_000 + H, 0, NOW - 86400_000 + 5 * H],
      [NOW - 2 * H, 1, reset],
      [NOW, 4, reset],
    ],
  };
  const w = quotaReport(
    { subscriptions: [sub([win("5h", 4, reset, 5 * 3600)])], llms: [] },
    NOW,
    { series: () => series },
  ).models[0]!.windows[0]!;
  assert.equal(w.allowance_reset_at, null);
  // 4% used with 2 of 5 hours gone. The old refill would have flattened this toward 4.
  assert.equal(w.projected_end_pct, 10);
});

test("a drop at the scheduled reset, or a small dip, is not an unannounced refill", () => {
  const reset = NOW + 2 * 86400_000;
  const natural: QuotaSeries = {
    since: NOW - 6 * 86400_000,
    points: [
      [NOW - 6 * 86400_000, 80, NOW - 30 * 60_000],
      [NOW - 20 * 60_000, 4, reset],
      [NOW, 6, reset],
    ],
  };
  const dip: QuotaSeries = {
    since: NOW - 2 * 86400_000,
    points: [
      [NOW - 2 * 86400_000, 40, reset],
      [NOW - 10 * H, 37, reset],
      [NOW, 42, reset],
    ],
  };
  const at = (series: QuotaSeries) =>
    quotaReport(
      { subscriptions: [sub([win("week", 42, reset, 7 * 86400)])], llms: [] },
      NOW,
      { series: () => series },
    ).models[0]!.windows[0]!;
  assert.equal(at(natural).allowance_reset_at, null);
  assert.equal(at(dip).allowance_reset_at, null);
  // No refill: 42% used with 5 of 7 days gone projects near 59.
  assert.equal(at(dip).projected_end_pct, 59);
});
