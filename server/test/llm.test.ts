import assert from "node:assert/strict";
import { test } from "node:test";
import { engineFromMetrics, engineFromOwner, metricsFromTensorfoldHealth, parseProm, withLiveTensorfoldTokens } from "../collectors/engines.ts";
import { counterDelta, parseMetrics, specStats } from "../collectors/llm.ts";

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
  const m = parseMetrics(METRICS, "vllm");
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
  const m = parseMetrics("vllm:num_requests_running 0\n", "vllm");
  assert.equal(m.running, 0);
  assert.equal(m.generationTokens, null);
});

test("falls back to the older KV cache gauge name", () => {
  assert.equal(parseMetrics('vllm:gpu_cache_usage_perc{model_name="m"} 0.5\n', "vllm").kvUsage, 0.5);
});

test("parseProm keeps metrics that share a prefix apart and reads labels", () => {
  const p = parseProm('# HELP x\nvllm:prompt_tokens_total 5\nvllm:prompt_tokens_total_extra 100\nm{a="1",b="x,y"} 2\nbad line\n');
  assert.equal(p.get("vllm:prompt_tokens_total")?.[0]?.value, 5);
  assert.equal(p.get("vllm:prompt_tokens_total_extra")?.[0]?.value, 100);
  assert.deepEqual(p.get("m")?.[0]?.labels, { a: "1", b: "x,y" });
});

const SGLANG = `# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{model_name="m",tp_rank="0"} 3.0
sglang:num_running_reqs{model_name="m",tp_rank="1"} 3.0
sglang:num_queue_reqs{model_name="m",tp_rank="0"} 1.0
sglang:token_usage{model_name="m",tp_rank="0"} 0.25
sglang:token_usage{model_name="m",tp_rank="1"} 0.30
sglang:prompt_tokens_total{model_name="m",is_streaming="true"} 600.0
sglang:prompt_tokens_total{model_name="m",is_streaming="false"} 400.0
sglang:generation_tokens_total{model_name="m",is_streaming="true"} 900.0
sglang:cached_tokens_total{model_name="m",cache_source="device"} 300.0
sglang:cached_tokens_total{model_name="m",cache_source="host"} 100.0
sglang:time_to_first_token_seconds_sum{model_name="m",is_streaming="true"} 2.0
sglang:time_to_first_token_seconds_count{model_name="m",is_streaming="true"} 4.0
sglang:num_requests_total{model_name="m",is_streaming="true"} 12.0
sglang:spec_accept_rate{model_name="m",tp_rank="0"} 0.6
sglang:spec_accept_length{model_name="m",tp_rank="0"} 3.2
sglang:spec_verify_calls_total{model_name="m"} 50.0
`;

test("SGLang: gauges repeated per rank are not double counted", () => {
  const m = parseMetrics(SGLANG, "sglang");
  assert.equal(m.running, 3);
  assert.equal(m.waiting, 1);
  assert.equal(m.kvUsage, 0.3);
  assert.equal(m.promptTokens, 1000);
  assert.equal(m.generationTokens, 900);
  assert.equal(m.prefixHits, 400);
  assert.equal(m.prefixQueries, 1000);
  assert.equal(m.requests, 12);
  assert.equal(m.ttftSum, 2);
  const spec = specStats(null, m, 0);
  assert.deepEqual(spec, { acceptRate: 0.6, meanLength: 3.2, draftTokensPerSec: null, acceptedTokensPerSec: null });
});

const TENSORFOLD = `tensorfold:requests_running 1
tensorfold:requests_waiting 0
tensorfold:kv_cache_usage_ratio{pool="0"} 0.1
tensorfold:kv_cache_usage_ratio{pool="1"} 0.4
tensorfold:prompt_tokens_total 50
tensorfold:generation_tokens_total 70
tensorfold:time_to_first_token_seconds_sum 1.5
tensorfold:time_to_first_token_seconds_count 3
tensorfold:request_latency_seconds_count 3
tensorfold:mtp_drafted_total 200
tensorfold:mtp_accepted_total 150
`;

test("TensorFold: reads its own names, and kept-prompt hits when /health's figures are exported", () => {
  const m = parseMetrics(TENSORFOLD, "tensorfold");
  assert.equal(m.running, 1);
  assert.equal(m.kvUsage, 0.4);
  assert.equal(m.generationTokens, 70);
  assert.equal(m.requests, 3);
  assert.equal(m.prefixHits, null);
  assert.equal(m.prefixQueries, null);
  assert.equal(specStats(null, m, 0)?.acceptRate, 0.75);
  const withHealth = parseMetrics(`${TENSORFOLD}tensorfold_health:cached_tokens_total 20\n`, "tensorfold");
  assert.equal(withHealth.prefixHits, 20);
  assert.equal(m.poolFreeTokens, null);
  const withPool = parseMetrics(`${TENSORFOLD}tensorfold_health:pool_tokens 1918976\ntensorfold_health:pool_free_tokens 129024\n`, "tensorfold");
  assert.deepEqual([withPool.poolTokens, withPool.poolFreeTokens], [1918976, 129024]);
  assert.equal(withHealth.prefixQueries, 50);
});

test("speculative decoding: rates over the interval and mean accepted length", () => {
  const base = parseMetrics(METRICS, "vllm");
  const before = { ...base, draftTokens: 1000, acceptedTokens: 400, drafts: 100 };
  const after = { ...base, draftTokens: 1700, acceptedTokens: 750, drafts: 200 };
  const s = specStats(before, after, 5);
  assert.equal(s?.draftTokensPerSec, 140);
  assert.equal(s?.acceptedTokensPerSec, 70);
  assert.ok(Math.abs((s?.acceptRate ?? 0) - 750 / 1700) < 1e-9);
  assert.equal(s?.meanLength, 750 / 200 + 1);
  // A server that never drafted reports nothing.
  assert.equal(specStats(null, { ...base, draftTokens: null, acceptedTokens: null }, 5), null);
});

test("engine detection from owned_by and from metric prefixes", () => {
  assert.equal(engineFromOwner("vllm"), "vllm");
  assert.equal(engineFromOwner("SGLang"), "sglang");
  assert.equal(engineFromOwner("tensorfold"), "tensorfold");
  assert.equal(engineFromOwner("openai"), null);
  assert.equal(engineFromMetrics(SGLANG), "sglang");
  assert.equal(engineFromMetrics(TENSORFOLD), "tensorfold");
  assert.equal(engineFromMetrics(METRICS), "vllm");
  assert.equal(engineFromMetrics("process_cpu_seconds_total 1\n"), null);
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

test("a model sharing its port with another reads as down while the other is served", async () => {
  const { createServer } = await import("node:http");
  const { LlmCollector } = await import("../collectors/llm.ts");
  const { Store } = await import("../store.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("");
    if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "glm", owned_by: "vllm" }] }));
    res.end("vllm:num_requests_running 0\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const store = new Store(mkdtempSync(join(tmpdir(), "sl-store-")));
    const llm = new LlmCollector(
      [
        { id: "glm", label: "GLM", baseUrl: `http://127.0.0.1:${port}`, model: "glm", engine: "vllm" },
        { id: "qwen", label: "Qwen", baseUrl: `http://127.0.0.1:${port}`, model: "qwen", engine: "vllm" },
      ],
      store,
      5,
    );
    await llm.poll([]);
    const [glm, qwen] = llm.snapshots();
    assert.equal(glm?.state, "up");
    assert.equal(qwen?.state, "down");
    assert.match(qwen?.detail ?? "", /glm/);
    // Two recipes of one checkout share containers: the other model's running containers are not this one starting.
    const shared = new LlmCollector(
      [{ id: "ablit", label: "GLM Ablit", baseUrl: `http://127.0.0.1:${port}`, model: "glm-ablit", engine: "vllm", nodes: ["a"], containers: ["glm-tf"] }],
      store,
      5,
    );
    await shared.poll([{ id: "a", online: true, containersKnown: true, containers: [{ name: "glm-tf", image: "", state: "running", status: "Up" }] } as never]);
    assert.equal(shared.snapshots()[0]?.state, "down");
    assert.match(shared.snapshots()[0]?.detail ?? "", /glm/);
    // While nothing answers yet, the name in the shared containers' command decides which recipe is loading.
    server.close();
    const loading = (servedName: string | null) =>
      [{ id: "a", online: true, containersKnown: true, containers: [{ name: "glm-tf", image: "", state: "running", status: "Up", servedName }] }] as never;
    const pair = new LlmCollector(
      [
        { id: "glm", label: "GLM", baseUrl: `http://127.0.0.1:${port}`, model: "glm", engine: "vllm", nodes: ["a"], containers: ["glm-tf"] },
        { id: "ablit", label: "GLM Ablit", baseUrl: `http://127.0.0.1:${port}`, model: "glm-ablit", engine: "vllm", nodes: ["a"], containers: ["glm-tf"] },
      ],
      store,
      5,
    );
    await pair.poll(loading("glm"));
    assert.deepEqual(pair.snapshots().map((x) => x.state), ["starting", "down"]);
    assert.match(pair.snapshots()[1]?.detail ?? "", /glm を読み込んでいます/);
    // A container without a name in its command proves nothing: both may be starting, as before.
    await pair.poll(loading(null));
    assert.deepEqual(pair.snapshots().map((x) => x.state), ["starting", "starting"]);
  } finally {
    server.close();
  }
});

test("two recipes serving the same model name are told apart by their containers", async () => {
  const { createServer } = await import("node:http");
  const { LlmCollector } = await import("../collectors/llm.ts");
  const { Store } = await import("../store.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.end("");
    if (req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "glm", owned_by: "vllm" }] }));
    res.end("vllm:num_requests_running 0\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const store = new Store(mkdtempSync(join(tmpdir(), "sl-store-")));
    const baseUrl = `http://127.0.0.1:${port}`;
    const llm = new LlmCollector(
      [
        { id: "vllm", label: "GLM vLLM", baseUrl, model: "glm", engine: "vllm", nodes: ["a"], containers: ["glm-vllm"] },
        { id: "tf", label: "GLM TensorFold", baseUrl, model: "glm", engine: "vllm", nodes: ["a"], containers: ["glm-tf"] },
      ],
      store,
      5,
    );
    const host = (containersKnown: boolean) =>
      ({ id: "a", online: true, containersKnown, containers: containersKnown ? [{ name: "glm-vllm", image: "", state: "running", status: "Up" }] : [] }) as never;
    await llm.poll([host(true)]);
    const [vllm, tf] = llm.snapshots();
    assert.equal(vllm?.state, "up");
    assert.equal(tf?.state, "down");
    assert.match(tf?.detail ?? "", /別のレシピ/);
    // Docker did not answer: the API's word stands for both.
    await llm.poll([host(false)]);
    assert.deepEqual(llm.snapshots().map((l) => l.state), ["up", "up"]);
    // Two nodes, one not answering: an empty list from the other proves nothing.
    const two = new LlmCollector(
      [{ id: "tf", label: "GLM TensorFold", baseUrl, model: "glm", engine: "vllm", nodes: ["a", "b"], containers: ["glm-tf"] }],
      store,
      5,
    );
    const b = (containersKnown: boolean) => ({ id: "b", online: true, containersKnown, containers: [] }) as never;
    await two.poll([host(true), b(false)]);
    assert.equal(two.snapshots()[0]?.state, "up");
    await two.poll([host(true), b(true)]);
    assert.equal(two.snapshots()[0]?.state, "down");
  } finally {
    server.close();
  }
});

test("TensorFold without /metrics: counters come from /health", () => {
  const m = metricsFromTensorfoldHealth({
    ok: true,
    backend: "tensorfold",
    busy: true,
    requests_running: 1,
    prompt_tokens_total: 18962,
    completion_tokens_total: 3594,
    prefill_seconds_total: 11.58,
    context_length: 262144,
  });
  assert.equal(m?.running, 1);
  assert.equal(m?.promptTokens, 18962);
  assert.equal(m?.generationTokens, 3594);
  assert.equal(m?.kvUsage, null);
  // An older /health with no counters is not a reading.
  assert.equal(metricsFromTensorfoldHealth({ ok: true, context_length: 262144 }), null);
});

test("TensorFold with /metrics: generated tokens follow /health while a request is decoding", () => {
  const fromMetrics = parseMetrics(TENSORFOLD, "tensorfold");
  const live = withLiveTensorfoldTokens(fromMetrics, { completion_tokens_total: 95 });
  assert.equal(live.generationTokens, 95);
  assert.equal(live.promptTokens, fromMetrics.promptTokens);
  assert.equal(live.running, fromMetrics.running);
  // A /health without the counter leaves /metrics as it was.
  assert.equal(withLiveTensorfoldTokens(fromMetrics, { ok: true }).generationTokens, 70);
  assert.equal(withLiveTensorfoldTokens(fromMetrics, null).generationTokens, 70);
});
