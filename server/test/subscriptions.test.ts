import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeUsage } from "../collectors/subscriptions/claudeCode.ts";
import { parseCodexResets, parseCodexUsage } from "../collectors/subscriptions/codex.ts";
import { parseCommandReport } from "../collectors/subscriptions/command.ts";
import { SubscriptionCollector } from "../collectors/subscriptions/index.ts";
import { parseGrokBilling, pickGrokCredential } from "../collectors/subscriptions/grok.ts";
import { parseOpencodeGoUsage } from "../collectors/subscriptions/opencodeGo.ts";
import type { Provider, UsageReport } from "../collectors/subscriptions/provider.ts";

test("Claude Code: reads the limits list and names scoped limits", () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 4, resets_at: "2026-09-30T17:50:00+00:00" },
    limits: [
      { kind: "session", group: "session", percent: 4, resets_at: "2026-09-30T17:50:00+00:00", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 3, resets_at: "2026-10-02T09:00:00+00:00", scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        resets_at: "2026-10-02T09:00:00+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  });
  assert.deepEqual(windows.map((w) => w.label), ["5時間", "週間（全モデル）", "週間（Fable）"]);
  assert.deepEqual(windows.map((w) => w.usedPct), [4, 3, 0]);
  assert.equal(windows[0]?.resetsAt, Date.parse("2026-09-30T17:50:00Z"));
  assert.equal(windows[0]?.windowSec, 5 * 3600);
  assert.equal(new Set(windows.map((w) => w.id)).size, 3);
});

test("Claude Code: falls back to named buckets on older responses", () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 12.5, resets_at: "2026-09-30T17:50:00+00:00" },
    seven_day: { utilization: 140, resets_at: null },
    seven_day_opus: null,
  });
  assert.deepEqual(windows.map((w) => w.id), ["five_hour", "seven_day"]);
  // Out-of-range values are clamped rather than drawn off the end of the bar.
  assert.equal(windows[1]?.usedPct, 100);
  assert.equal(windows[1]?.resetsAt, null);
});

test("Codex: reads both windows, the plan and extras", () => {
  const { plan, windows, notes } = parseCodexUsage({
    plan_type: "plus",
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1790803468 },
      secondary_window: { used_percent: 21, limit_window_seconds: 604800, reset_at: 1791093697 },
    },
    rate_limit_reset_credits: { available_count: 3 },
    credits: { has_credits: false, balance: "0" },
  });
  assert.equal(plan, "ChatGPT Plus");
  assert.deepEqual(windows.map((w) => [w.label, w.usedPct]), [["5時間", 0], ["週間", 21]]);
  // Seconds since the epoch become milliseconds.
  assert.equal(windows[0]?.resetsAt, 1790803468000);
  assert.deepEqual(notes, []);
});

test("Codex: tolerates a plan without a secondary window", () => {
  const { windows } = parseCodexUsage({ plan_type: "free", rate_limit: { primary_window: { used_percent: 50 } } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.label, "短期");
});

test("OpenCode Go: reads rolling, weekly and monthly windows", () => {
  const windows = parseOpencodeGoUsage({
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-30T19:52:39.361Z" },
      weekly: { status: "ok", percent: 1, resetsAt: "2026-10-05T00:00:00.000Z" },
      monthly: { status: "limited", percent: 100, resetsAt: "2026-10-05T12:47:21.000Z" },
    },
  });
  assert.deepEqual(windows.map((w) => w.label), ["5時間", "週間", "月間"]);
  assert.equal(windows[2]?.usedPct, 100);
  assert.equal(windows[2]?.detail, "limited");
  assert.equal(windows[0]?.detail, null);
});

test("unexpected bodies yield no windows instead of throwing", () => {
  for (const body of [null, "nope", 42, {}, { usage: null }, { limits: "x" }]) {
    assert.deepEqual(parseClaudeUsage(body), []);
    assert.deepEqual(parseOpencodeGoUsage(body), []);
    assert.deepEqual(parseCodexUsage(body).windows, []);
  }
});

test("command provider: accepts a report and rejects anything else", () => {
  const report = parseCommandReport(
    JSON.stringify({ plan: "Pro", windows: [{ id: "w", label: "週間", usedPct: 40, resetsAt: "2026-10-05T00:00:00Z" }], notes: ["a", 1] }),
  );
  assert.equal(report?.plan, "Pro");
  assert.equal(report?.windows[0]?.usedPct, 40);
  assert.deepEqual(report?.notes, ["a"]);
  assert.equal(parseCommandReport("not json"), null);
  assert.equal(parseCommandReport('{"plan":"x"}'), null);
});

function fake(reports: UsageReport[]): Provider {
  let i = 0;
  return { type: "fake", defaultLabel: "Fake", fetch: async () => reports[Math.min(i++, reports.length - 1)]! };
}

const OK: UsageReport = {
  plan: "Pro",
  status: "ok",
  message: null,
  windows: [{ id: "w", label: "週間", usedPct: 10, resetsAt: null }],
  notes: [],
};

test("collector keeps the last good numbers through a failed poll", async () => {
  const collector = new SubscriptionCollector(
    [{ type: "fake" }],
    { providers: [fake([OK, { plan: null, status: "error", message: "down", windows: [], notes: [] }])], intervalSec: 0 },
  );
  await collector.poll();
  const first = collector.snapshots()[0]!;
  assert.equal(first.status, "ok");
  assert.ok(first.fetchedAt);
  await collector.poll();
  const second = collector.snapshots()[0]!;
  assert.equal(second.status, "error");
  assert.equal(second.message, "down");
  assert.equal(second.windows[0]?.usedPct, 10);
  assert.equal(second.plan, "Pro");
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test("a lapsed login keeps the last numbers as dormant; with none it asks for a login", async () => {
  const lapsed: UsageReport = { plan: null, status: "dormant", message: "expired", windows: [], notes: [] };
  const withHistory = new SubscriptionCollector([{ type: "fake" }], { providers: [fake([OK, lapsed])], intervalSec: 0 });
  await withHistory.poll();
  await withHistory.poll();
  const kept = withHistory.snapshots()[0]!;
  assert.equal(kept.status, "dormant");
  assert.equal(kept.windows[0]?.usedPct, 10);
  const fresh = new SubscriptionCollector([{ type: "fake" }], { providers: [fake([lapsed])], intervalSec: 0 });
  await fresh.poll();
  assert.equal(fresh.snapshots()[0]?.status, "stale");
});

test("collector reports an unknown type and survives a throwing provider", async () => {
  const boom: Provider = {
    type: "boom",
    defaultLabel: "Boom",
    fetch: async () => {
      throw new Error("Authorization: Bearer secret-token");
    },
  };
  const collector = new SubscriptionCollector([{ type: "nope" }, { type: "boom" }, { type: "boom" }], { providers: [boom] });
  await collector.poll();
  const [unknown, b1, b2] = collector.snapshots();
  assert.equal(unknown?.status, "error");
  assert.match(unknown?.message ?? "", /nope/);
  assert.equal(b1?.status, "error");
  // The thrown text must not reach the client.
  assert.doesNotMatch(JSON.stringify(collector.snapshots()), /secret-token/);
  assert.deepEqual([b1?.id, b2?.id], ["boom", "boom-2"]);
});

test("Codex: lists usable reset tickets, soonest expiry first", () => {
  const tickets = parseCodexResets({
    credits: [
      { status: "available", is_supported_by_plan: true, title: "Full reset (Weekly + 5 hr)", expires_at: "2026-10-22T20:15:30Z" },
      { status: "redeemed", title: "Full reset (Weekly + 5 hr)", expires_at: "2026-10-01T00:00:00Z" },
      { status: "available", is_supported_by_plan: true, title: "Full reset (Weekly + 5 hr)", expires_at: "2026-10-04T23:46:14Z" },
      { status: "available", is_supported_by_plan: false, title: "Other", expires_at: null },
    ],
  });
  assert.deepEqual(tickets.map((t) => t.expiresAt), [Date.parse("2026-10-04T23:46:14Z"), Date.parse("2026-10-22T20:15:30Z")]);
  assert.equal(tickets[0]?.label, "週間＋5時間の全リセット");
  assert.deepEqual(parseCodexResets({}), []);
});

test("Claude Code: a 5-hour window that has not started is marked idle", () => {
  const [w] = parseClaudeUsage({ limits: [{ kind: "session", group: "session", percent: 0, resets_at: null }] });
  assert.equal(w?.idle, true);
  assert.equal(w?.resetsAt, null);
});

test("collector waits its interval, backs off on throttling and restores from cache", async () => {
  let calls = 0;
  const throttled: UsageReport = { plan: null, status: "error", message: "busy", windows: [], notes: [], backoff: true };
  const provider: Provider = {
    type: "fake",
    defaultLabel: "Fake",
    fetch: async () => (calls++ === 0 ? OK : throttled),
  };
  let saved: Record<string, import("../types.ts").SubscriptionSnapshot> = {};
  const cache = { load: () => saved, save: (s: typeof saved) => (saved = s) };
  const c = new SubscriptionCollector([{ type: "fake" }], { providers: [provider], intervalSec: 300, cache });
  const t0 = Date.now();
  await c.poll(t0);
  assert.equal(calls, 1);
  await c.poll(t0 + 60_000); // not due yet
  assert.equal(calls, 1);
  await c.poll(t0 + 301_000);
  assert.equal(calls, 2);
  assert.match(c.snapshots()[0]?.message ?? "", /busy/);
  await c.poll(t0 + 602_000); // backing off for at least ten minutes
  assert.equal(calls, 2);
  // A restart picks up the last good reading and does not fetch straight away.
  const again = new SubscriptionCollector([{ type: "fake" }], { providers: [provider], intervalSec: 300, cache });
  assert.equal(again.snapshots()[0]?.windows[0]?.usedPct, 10);
  await again.poll();
  assert.equal(calls, 2);
});

test("Grok: reads the weekly credit window", () => {
  const windows = parseGrokBilling({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-27T03:34:37.807064+00:00", end: "2026-10-04T03:34:37.807064+00:00" },
      creditUsagePercent: 64.0,
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      productUsage: [
        { product: "GrokImagine", usagePercent: 64.0 },
        { product: "GrokBuild", usagePercent: 0 },
      ],
      billingPeriodStart: "2026-09-27T03:34:37.807064+00:00",
      billingPeriodEnd: "2026-10-04T03:34:37.807064+00:00",
    },
  });
  assert.deepEqual(windows.map((w) => [w.label, w.usedPct, w.windowSec]), [["週間", 64, 7 * 86400]]);
  assert.equal(windows[0]?.resetsAt, Date.parse("2026-10-04T03:34:37.807Z"));
});

test("Grok: a period without a percentage is unknown, not zero", () => {
  const windows = parseGrokBilling({
    config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-27T00:00:00Z", end: "2026-10-04T00:00:00Z" } },
  });
  assert.deepEqual(windows, []);
});

test("Grok: picks the SuperGrok login from the auth file", () => {
  assert.deepEqual(
    pickGrokCredential({
      "https://accounts.x.ai/sign-in": { key: "old" },
      "https://auth.x.ai::client": { key: "new", expires_at: "2026-10-01T17:59:23Z" },
    }),
    { token: "new", expiresAt: Date.parse("2026-10-01T17:59:23Z") },
  );
  assert.equal(pickGrokCredential({ "https://auth.x.ai::client": { key: "" } }), null);
});

test("a cached reading stamped in the future (clock skew) is refetched at once", async () => {
  let calls = 0;
  const provider: Provider = { type: "fake", defaultLabel: "Fake", fetch: async () => (calls++, OK) };
  const future = Date.now() + 90 * 60_000;
  const cache = {
    load: () => ({
      fake: { id: "fake", type: "fake", label: "Fake", plan: null, status: "ok" as const, message: null, windows: OK.windows, notes: [], tickets: [], fetchedAt: future },
    }),
    save: () => {},
  };
  const c = new SubscriptionCollector([{ type: "fake" }], { providers: [provider], intervalSec: 300, cache });
  await c.poll();
  assert.equal(calls, 1);
  assert.ok((c.snapshots()[0]?.fetchedAt ?? Infinity) <= Date.now());
});
