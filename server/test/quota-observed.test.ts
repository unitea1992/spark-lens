import assert from "node:assert/strict";
import { test } from "node:test";
import { observedQuota } from "../quota-observed.ts";
import type { Snapshot, SubscriptionSnapshot } from "../types.ts";

const NOW = Date.parse("2026-10-29T09:00:00Z");
const base = {
  id: "claude-code", label: "Claude", type: "claude-code", plan: "Max", status: "ok", message: null,
  notes: [], tickets: [], fetchedAt: NOW - 60_000,
  windows: [
    { id: "5h", label: "5時間", usedPct: 79, resetsAt: NOW + 60_000, windowSec: 5 * 3600 },
    { id: "week", label: "週間", usedPct: 84, resetsAt: NOW + 86400_000, windowSec: 7 * 86400 },
  ],
} satisfies SubscriptionSnapshot;
const make = (sub: SubscriptionSnapshot) => observedQuota({ subscriptions: [sub], llms: [] } as Pick<Snapshot, "subscriptions" | "llms">, NOW);

test("observed API has explicit direction and no projection/remaining percentage", () => {
  const doc = make(base);
  assert.equal(doc.schema_version, 2);
  assert.equal(doc.subscriptions[0]?.can_assign, true);
  assert.equal(doc.subscriptions[0]?.windows[0]?.consumed_percent, 79);
  assert.equal(JSON.stringify(doc).includes("projected_end_pct"), false);
  assert.equal(JSON.stringify(doc).includes("remaining_pct"), false);
  assert.equal(JSON.stringify(doc).includes("used_pct"), false);
  assert.equal(doc.semantics.prediction_included, false);
});

test("observed API fails closed for unknown, stale and consumed windows", () => {
  const variants: SubscriptionSnapshot[] = [
    { ...base, fetchedAt: NOW - 20 * 60_000 },
    { ...base, status: "dormant" },
    { ...base, windows: [{ ...base.windows[0]!, usedPct: null }] },
    { ...base, windows: [{ ...base.windows[0]!, usedPct: 80 }] },
    { ...base, windows: [{ ...base.windows[1]!, usedPct: 85 }] },
    { ...base, windows: [{ ...base.windows[0]!, resetsAt: NOW - 1000 }] },
    { ...base, windows: [] },
  ];
  for (const sub of variants) assert.equal(make(sub).subscriptions[0]?.can_assign, false);
});

test("unknown local concurrency does not masquerade as reported quota", () => {
  const snapshot = { subscriptions: [], llms: [{ id: "local", label: "Local", state: "up", models: ["m"], requestsRunning: 0, requestsWaiting: 1, maxConcurrent: 4, poolTokens: null, poolFreeTokens: null }] } as unknown as Pick<Snapshot, "subscriptions" | "llms">;
  assert.equal(observedQuota(snapshot, NOW).local_models[0]?.can_assign, false);
  assert.equal(observedQuota(snapshot, NOW).local_models[0]?.blocked_reason, "queued_requests");
});
