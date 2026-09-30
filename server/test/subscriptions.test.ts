import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeUsage } from "../collectors/subscriptions/claudeCode.ts";
import { parseCodexUsage } from "../collectors/subscriptions/codex.ts";
import { parseCommandReport } from "../collectors/subscriptions/command.ts";
import { SubscriptionCollector } from "../collectors/subscriptions/index.ts";
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
  assert.deepEqual(notes, ["リセット券 3 枚"]);
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
    [fake([OK, { plan: null, status: "error", message: "down", windows: [], notes: [] }])],
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

test("collector reports an unknown type and survives a throwing provider", async () => {
  const boom: Provider = {
    type: "boom",
    defaultLabel: "Boom",
    fetch: async () => {
      throw new Error("Authorization: Bearer secret-token");
    },
  };
  const collector = new SubscriptionCollector([{ type: "nope" }, { type: "boom" }, { type: "boom" }], [boom]);
  await collector.poll();
  const [unknown, b1, b2] = collector.snapshots();
  assert.equal(unknown?.status, "error");
  assert.match(unknown?.message ?? "", /nope/);
  assert.equal(b1?.status, "error");
  // The thrown text must not reach the client.
  assert.doesNotMatch(JSON.stringify(collector.snapshots()), /secret-token/);
  assert.deepEqual([b1?.id, b2?.id], ["boom", "boom-2"]);
});
