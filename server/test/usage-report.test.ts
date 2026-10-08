import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { HttpServer } from "../http.ts";
import { usageReport, type UsageReport } from "../usage-report.ts";
import type { ModelUsage, Snapshot, UsageSnapshot } from "../types.ts";

const NOW = Date.parse("2026-10-08T01:00:00Z");

const row = (model: string, over: Partial<ModelUsage> = {}): ModelUsage => ({
  model,
  source: "Claude Code",
  local: false,
  input: 100,
  output: 20,
  cached: 1000,
  total: 1120,
  usd: 0.5,
  ...over,
});

const usage = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  generatedAt: NOW - 30_000,
  pricesFetchedAt: NOW - 3600_000,
  pricesSource: "models.dev",
  today: [row("claude-haiku-5-5"), row("claude-opus-5-5", { total: 5000, usd: 2.25 })],
  week: [row("claude-haiku-5-5", { total: 9000, usd: 1 })],
  month: [],
  ...over,
});

test("each period lists its models with totals, and says when it was collected", () => {
  const r = usageReport(usage(), NOW);
  assert.equal(r.generated_at_jst, "2026-10-08T10:00:00+09:00");
  assert.equal(r.age_sec, 30);
  assert.equal(r.usage_at_jst, "2026-10-08T09:59:30+09:00");
  assert.equal(r.today.models.length, 2);
  assert.equal(r.today.total_tokens, 1120 + 5000);
  assert.equal(r.today.total_usd, 2.75);
  assert.equal(r.today.usd_partial, false);
  assert.deepEqual(r.today.models[0], {
    model: "claude-haiku-5-5",
    source: "Claude Code",
    local: false,
    input_tokens: 100,
    output_tokens: 20,
    cached_tokens: 1000,
    total_tokens: 1120,
    usd: 0.5,
    usd_estimate: false,
  });
  assert.deepEqual(r.month, { models: [], total_tokens: 0, total_usd: null, usd_partial: false });
});

test("the model filter is a case-insensitive substring match across all periods", () => {
  const r = usageReport(usage(), NOW, "  HAIKU ");
  assert.equal(r.model_filter, "haiku");
  assert.deepEqual(r.today.models.map((m) => m.model), ["claude-haiku-5-5"]);
  assert.equal(r.week.total_tokens, 9000);
  assert.equal(usageReport(usage(), NOW, "").model_filter, null);
  assert.equal(usageReport(usage(), NOW, "nothing-like-this").today.models.length, 0);
});

test("unpriced and total-only models are marked, not guessed", () => {
  const r = usageReport(
    usage({
      today: [row("a"), row("b", { usd: null }), row("c", { input: null, output: null, cached: null, total: 700, usdEstimate: true })],
    }),
    NOW,
  );
  assert.equal(r.today.usd_partial, true);
  assert.equal(r.today.total_usd, 1);
  assert.equal(r.today.models[1]!.usd, null);
  assert.equal(r.today.models[2]!.input_tokens, null);
  assert.equal(r.today.models[2]!.usd_estimate, true);
  assert.equal(r.today.total_tokens, 1120 + 1120 + 700);
});

test("before the first collection the age is unknown", () => {
  const r = usageReport(usage({ generatedAt: 0, today: [], week: [] }), NOW);
  assert.equal(r.usage_at, null);
  assert.equal(r.age_sec, null);
});

test("the report carries nothing beyond the dashboard's usage table", () => {
  const text = JSON.stringify(usageReport(usage(), NOW));
  assert.doesNotMatch(text, /models\.dev|pricesSource|prices_fetched/);
  const keys = Object.keys(usageReport(usage(), NOW)).sort();
  assert.deepEqual(keys, ["age_sec", "generated_at", "generated_at_jst", "model_filter", "month", "today", "usage_at", "usage_at_jst", "week"]);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

test("GET /api/usage serves the report and reads ?model=", async () => {
  const port = await freePort();
  const snapshot = { usage: usage() } as unknown as Snapshot;
  const server = new HttpServer({ host: "127.0.0.1", port, staticDir: "/nonexistent", allowedHosts: [], snapshot: () => snapshot });
  await server.listen();
  try {
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body: (await res.json()) as UsageReport };
    };
    const all = await get("/api/usage");
    assert.equal(all.status, 200);
    assert.match(all.type ?? "", /application\/json/);
    assert.equal(all.cache, "no-store");
    assert.equal(all.body.today.models.length, 2);
    const filtered = await get("/api/usage?model=Opus");
    assert.deepEqual(filtered.body.today.models.map((m) => m.model), ["claude-opus-5-5"]);
    assert.equal(filtered.body.model_filter, "opus");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/usage`, { method: "POST" })).status, 405);
  } finally {
    server.close();
  }
});
