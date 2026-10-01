import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProgress, startedAt } from "../progress.ts";

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
