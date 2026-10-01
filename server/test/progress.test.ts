import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMemoryPlan, parseProgress, startedAt } from "../progress.ts";

test("start progress follows vLLM's milestones", () => {
  assert.deepEqual(parseProgress(""), { pct: 3, stage: "準備しています" });
  const loading = [
    "(APIServer pid=1) INFO non-default args: {...}",
    "(Worker) INFO Loading model from scratch...",
    "Loading safetensors checkpoint shards:   9% Completed | 1/11",
    "Loading safetensors checkpoint shards:  27% Completed | 3/11",
  ].join("\n");
  assert.deepEqual(parseProgress(loading), { pct: 29, stage: "重みを読み込んでいます" });
  assert.equal(parseProgress("Loading safetensors using InstantTensor loader:  53% Completed | 86.9G/164G").pct, 44);
  const graphs = loading + "\nGPU KV cache size: 1,233,779 tokens\nCapturing CUDA graphs (PIECEWISE):  57%|█████▋ | 4/7";
  assert.deepEqual(parseProgress(graphs), { pct: 84, stage: "CUDA グラフを作成しています" });
  assert.equal(parseProgress(graphs + "\nboot-shape-warmup: 24/24 requests ok").stage, "最終確認をしています");
  // A launcher announcing that it will wait for "weight load + warmup" is not the end.
  assert.equal(parseProgress("waiting for /health (weight load + warmup on a 320B MoE is slow)").pct, 3);
});

test("the start time comes from the launcher log's own marker", () => {
  assert.equal(startedAt("=== spark-lens: start 2026-10-01 13:52:31\nfoo"), Date.parse("2026-10-01T13:52:31"));
  assert.equal(startedAt("no marker"), null);
});

test("memory plan comes from vLLM's start-up lines", () => {
  assert.deepEqual(parseMemoryPlan("Model loading took 64.52 GiB memory\nAvailable KV cache memory: 30.78 GiB"), { weightsGiB: 64.52, kvGiB: 30.78 });
  const glm = parseMemoryPlan("--kv-cache-memory-bytes 11811160064\nModel loading took 81.89 GiB and 80.7 seconds");
  assert.equal(glm.weightsGiB, 81.89);
  assert.ok(Math.abs((glm.kvGiB ?? 0) - 11) < 0.01);
  assert.deepEqual(parseMemoryPlan(""), { weightsGiB: null, kvGiB: null });
});
