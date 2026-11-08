import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPrices, findRates, idCandidates, localPriceKey, parseLitellm, parseModelsDev, priceRow, type PriceTable } from "../pricing.ts";
import type { ModelUsage } from "../types.ts";

const modelsDev = parseModelsDev({
  anthropic: { models: { "claude-opus-4-7": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } } },
  openai: { models: { "gpt-5.5": { cost: { input: 2, output: 10, cache_read: 0.2 } } } },
  zai: { models: { "glm-5.3-flash": { cost: { input: 0.15, output: 0.5, cache_read: 0.03 } } } },
  vultr: { models: { "qwen3.8-flash-next": { cost: { input: 0.1, output: 0.2 } } } },
  deepinfra: { models: { "deepseek-ai/deepseek-v4.1-flash-1017": { cost: { input: 0.2, output: 0.6 } } } },
  meta: { models: { "muse-spark-1.3-contributor": { cost: { input: 0.1, output: 0.2, cache_read: 0.002 } } } },
  deepseek: { models: { "deepseek-v4-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  opencode: {
    models: {
      "space-bunny-free": { cost: { input: 0, output: 0, cache_read: 0 } },
      "deepseek-v4-flash": { cost: { input: 0.14, output: 0.28 } },
    },
  },
  other: { models: { "qwen3.8-flash-next": { cost: { input: 9, output: 9 } }, "no-cost": {} } },
});

const litellm = parseLitellm({
  "claude-sonnet-4-5": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 3e-7 },
  "us.claude-sonnet-4-5": { input_cost_per_token: 1, output_cost_per_token: 1 },
  "bedrock/claude-sonnet-4-5": { input_cost_per_token: 1, output_cost_per_token: 1 },
  "text-only": { litellm_provider: "x" },
});

const table: PriceTable = { fetchedAt: 1, modelsDev, litellm };

const row = (over: Partial<ModelUsage>): ModelUsage => ({
  model: "x",
  source: "Claude Code",
  local: false,
  input: 0,
  output: 0,
  cached: 0,
  total: 0,
  usd: null,
  ...over,
});

test("models.dev entries without a cost are skipped; LiteLLM is per million and drops prefixed keys", () => {
  assert.equal(modelsDev["other/no-cost"], undefined);
  assert.deepEqual(Object.keys(litellm), ["claude-sonnet-4-5"]);
  assert.ok(Math.abs(litellm["claude-sonnet-4-5"]!.input - 3) < 1e-9);
  assert.ok(Math.abs(litellm["claude-sonnet-4-5"]!.cacheRead! - 0.3) < 1e-9);
});

test("ids: exact, then without a date suffix, nothing fuzzier", () => {
  assert.deepEqual(idCandidates("Claude-Opus-4-7-20260416"), ["claude-opus-4-7-20260416", "claude-opus-4-7"]);
  assert.deepEqual(idCandidates("gpt-5.5-2026-01-02"), ["gpt-5.5-2026-01-02", "gpt-5.5"]);
  assert.deepEqual(idCandidates("gpt-5.5"), ["gpt-5.5"]);
  assert.equal(findRates(table, row({ model: "claude-opus-4-7-20260416" }))?.input, 5);
  assert.equal(findRates(table, row({ model: "claude-opus-4" })), null);
  assert.equal(findRates(table, row({ model: "claude-opus-4-7-1m" })), null);
});

test("provider follows the source; LiteLLM is the fallback", () => {
  assert.equal(findRates(table, row({ source: "Claude Code", model: "gpt-5.5" })), null);
  assert.equal(findRates(table, row({ source: "Codex", model: "gpt-5.5" }))?.input, 2);
  assert.equal(findRates(table, row({ source: "Codex", model: "claude-opus-4-7" })), null);
  assert.equal(findRates(table, row({ source: "Claude Code", model: "claude-sonnet-4-5-20250929" }))?.input, 3);
});

test("OpenCode: maker first, then opencode; free ids cost nothing", () => {
  assert.equal(findRates(table, row({ source: "OpenCode", model: "muse-spark-1.3-contributor" }))?.output, 0.2);
  assert.equal(findRates(table, row({ source: "OpenCode", model: "deepseek-v4-flash" }))?.output, 0.6);
  const free = priceRow(table, row({ source: "OpenCode", model: "space-bunny-free", input: 100, output: 5, cached: 50, total: 155 }));
  assert.equal(free.usd, 0);
  assert.equal(priceRow(table, row({ source: "OpenCode", model: "jev-1.13-free", input: 1, output: 1, total: 2 })).usd, null);
});

test("Claude Code arithmetic: input, output and cache reads at their own rates", () => {
  const p = priceRow(table, row({ model: "claude-opus-4-7", input: 1_000_000, output: 100_000, cached: 2_000_000, total: 3_100_000 }));
  assert.ok(Math.abs(p.usd! - (5 + 2.5 + 1)) < 1e-9);
  assert.equal(p.usdEstimate, undefined);
});

test("Codex reports only a total: priced at the input rate and flagged as an estimate", () => {
  const p = priceRow(table, row({ source: "Codex", model: "gpt-5.5", input: null, output: null, cached: null, total: 3_000_000 }));
  assert.ok(Math.abs(p.usd! - 6) < 1e-9);
  assert.equal(p.usdEstimate, true);
});

test("local models: only the mapped label is priced, as its maker's API", () => {
  assert.equal(localPriceKey("GLM-5.3 Flash"), "zai/glm-5.3-flash");
  const glm = priceRow(table, row({ source: "ローカル", local: true, model: "GLM-5.3 Flash", input: 2_000_000, output: 1_000_000, cached: 0, total: 3_000_000 }));
  assert.ok(Math.abs(glm.usd! - (0.3 + 0.5)) < 1e-9);
  assert.equal(glm.usdEstimate, true);
  assert.equal(glm.priceReference, "zai/glm-5.3-flash");
  assert.equal(glm.priceComparison, "same_model");
  // Another model's price must not be borrowed.
  const qwen = priceRow(table, row({ source: "ローカル", local: true, model: "Qwen3.8 Flash Next", input: 1, output: 1, total: 2 }));
  assert.equal(qwen.usd, null);
});

test("no price table: everything is unknown, and applyPrices clears stale flags", () => {
  const r = row({ model: "claude-opus-4-7", input: 10, output: 10, total: 20, usd: 5, usdEstimate: true });
  applyPrices([r], null);
  assert.equal(r.usd, null);
  assert.equal(r.usdEstimate, undefined);
});

test("an unpriced local model stays unknown rather than falsely reporting $0", () => {
  const list = [
    row({ source: "ローカル", local: true, model: "Qwen3.8 Flash Next", input: 10, output: 10, cached: 0, total: 20 }),
    row({ source: "Codex", model: "no-such-model", input: 10, output: 10, cached: 0, total: 20 }),
  ];
  applyPrices(list, table);
  assert.equal(list[0]!.usd, null);
  assert.equal(list[1]!.usd, null);
});


test("reviewed local TensorFold labels map to explicit comparable public rates", () => {
  const models = [
    ["GLM-5.3 Flash（TensorFold）", "zai/glm-5.3-flash", "same_model", 0.2],
    ["GLM-5.3 Flash 未検閲版（TensorFold）", "zai/glm-5.3-flash", "proxy", 0.2],
    ["Qwen3.8 Flash Next（TensorFold）", "vultr/qwen3.8-flash-next", "same_model", 0.12],
    ["Qwen3.8 Flash Next（TensorFold・2 台）", "vultr/qwen3.8-flash-next", "same_model", 0.12],
    ["DeepSeek-V4.1 Flash 1017（TensorFold・2 台）", "deepinfra/deepseek-ai/deepseek-v4.1-flash-1017", "same_model", 0.26],
    ["DeepSeek-V4.1 Flash 1017 未検閲版（TensorFold・2 台）", "deepinfra/deepseek-ai/deepseek-v4.1-flash-1017", "proxy", 0.26],
  ] as const;
  for (const [model, reference, comparison, expected] of models) {
    const p = priceRow(table, row({ source: "ローカル", local: true, model, input: 1_000_000, output: 100_000, cached: 0, total: 1_100_000 }));
    assert.equal(p.priceReference, reference, model);
    assert.equal(p.priceComparison, comparison, model);
    assert.equal(p.usdEstimate, true);
    assert.ok(Math.abs(p.usd! - expected) < 1e-9);
  }
  assert.equal(priceRow(table, row({ source: "ローカル", local: true, model: "d1-2B（ローカル判断モデル）", input: 1, output: 1, total: 2 })).usd, null);
});

test("applyPrices clears local price references when the reference data becomes unavailable", () => {
  const r = row({ source: "ローカル", local: true, model: "GLM-5.3 Flash（TensorFold）", input: 1e6, output: 0, cached: 0, total: 1e6 });
  applyPrices([r], table);
  assert.equal(r.priceReference, "zai/glm-5.3-flash");
  applyPrices([r], null);
  assert.equal(r.usd, null);
  assert.equal(r.priceReference, undefined);
  assert.equal(r.priceComparison, undefined);
});

test("custom model comparison uses a reviewed exact provider key instead of fuzzy model matching", () => {
  const mapped = row({
    model: "Custom Label", source: "ローカル", local: true,
    input: 1e6, output: 1e5, cached: 0, total: 1.1e6,
    priceReference: "deepinfra/deepseek-ai/deepseek-v4.1-flash-1017", priceComparison: "proxy",
  });
  const p = priceRow(table, mapped);
  assert.ok(Math.abs(p.usd! - 0.26) < 1e-9);
  assert.equal(p.priceComparison, "proxy");
  assert.equal(priceRow(table, { ...mapped, priceReference: "unknown/not-listed" }).usd, null);
});


test("a local cache hit is priced at the published cache read rate", () => {
  const priced = priceRow(table, row({ source: "ローカル", local: true,
    model: "GLM-5.3 Flash（TensorFold）", input: 100_000, cached: 900_000,
    output: 10_000, total: 1_010_000 }));
  assert.ok(Math.abs(priced.usd! - (0.015 + 0.027 + 0.005)) < 1e-9);
  assert.equal(priced.usdEstimate, true);
  // DeepInfra's DeepSeek comparison has its own cache read price omitted
  // in some regions: never fabricate the discounted rate.
  const noCacheRate = priceRow(table, row({ source: "ローカル", local: true,
    model: "DeepSeek-V4.1 Flash 1017（TensorFold・2 台）", input: 100_000, cached: 900_000,
    output: 10_000, total: 1_010_000 }));
  assert.ok(Math.abs(noCacheRate.usd! - (0.2 + 0.006)) < 1e-9);
});
