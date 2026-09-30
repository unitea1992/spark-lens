import assert from "node:assert/strict";
import { test } from "node:test";
import { counterDelta, parseMetrics, promSum } from "../collectors/llm.ts";

const METRICS = `# HELP vllm:num_requests_running Number of requests currently running.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="m"} 2.0
vllm:num_requests_waiting{engine="0",model_name="m"} 1.0
vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.125
vllm:prompt_tokens_total{engine="0",model_name="m"} 1200.0
vllm:generation_tokens_total{engine="0",model_name="m"} 3.4e+03
vllm:time_to_first_token_seconds_bucket{le="0.5",engine="0",model_name="m"} 3.0
vllm:time_to_first_token_seconds_sum{engine="0",model_name="m"} 4.5
vllm:time_to_first_token_seconds_count{engine="0",model_name="m"} 9.0
vllm:prefix_cache_queries_total{engine="0",model_name="m"} 1000.0
vllm:prefix_cache_hits_total{engine="0",model_name="m"} 250.0
vllm:spec_decode_num_draft_tokens_total{engine="0",model_name="m"} 1400.0
vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="m"} 490.0
vllm:request_success_total{finished_reason="stop",engine="0",model_name="m"} 7.0
vllm:request_success_total{finished_reason="length",engine="0",model_name="m"} 2.0
`;

test("reads the vLLM metrics the dashboard shows", () => {
  const m = parseMetrics(METRICS);
  assert.equal(m.running, 2);
  assert.equal(m.waiting, 1);
  assert.equal(m.kvUsage, 0.125);
  assert.equal(m.promptTokens, 1200);
  assert.equal(m.generationTokens, 3400);
  assert.equal(m.ttftSum, 4.5);
  assert.equal(m.ttftCount, 9);
  assert.equal(m.prefixHits, 250);
  assert.equal(m.prefixQueries, 1000);
  assert.equal(m.draftTokens, 1400);
  assert.equal(m.acceptedTokens, 490);
  // Series with different labels add up.
  assert.equal(m.requests, 9);
});

test("a metric that is absent reads as unknown, not zero", () => {
  const m = parseMetrics("vllm:num_requests_running 0\n");
  assert.equal(m.running, 0);
  assert.equal(m.generationTokens, null);
});

test("falls back to the older KV cache gauge name", () => {
  assert.equal(parseMetrics('vllm:gpu_cache_usage_perc{model_name="m"} 0.5\n').kvUsage, 0.5);
});

test("promSum does not match a longer metric name sharing the prefix", () => {
  const text = "vllm:prompt_tokens_total 5\nvllm:prompt_tokens_total_extra 100\nvllm:prompt_tokens_by_source_total 9\n";
  assert.equal(promSum(text, "vllm:prompt_tokens_total"), 5);
});

test("counterDelta treats a counter that went backwards as a restart", () => {
  assert.equal(counterDelta(100, 160), 60);
  assert.equal(counterDelta(100, 30), 30);
  // The first sample only sets the baseline.
  assert.equal(counterDelta(null, 500), 0);
  assert.equal(counterDelta(100, null), 0);
});

test("a stopped endpoint on an unreachable host reads as down, not starting", async () => {
  const { LlmCollector } = await import("../collectors/llm.ts");
  const { Store } = await import("../store.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = new Store(mkdtempSync(join(tmpdir(), "sl-store-")));
  const llm = new LlmCollector(
    [{ id: "m", label: "M", baseUrl: "http://127.0.0.1:9", nodes: ["a"], containers: ["serve"] }],
    store,
    5,
  );
  const host = (online: boolean) =>
    ({ id: "a", online, containers: [{ name: "serve", image: "", state: "running", status: "Up" }] }) as never;
  await llm.poll([host(false)]);
  assert.equal(llm.snapshots()[0]?.state, "down");
  await llm.poll([host(true)]);
  assert.equal(llm.snapshots()[0]?.state, "starting");
});
