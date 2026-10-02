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
  assert.deepEqual(parseProgress(loading), { pct: 29, stage: "モデルを読み込んでいます" });
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

test("memory plan also reads SGLang's start-up lines", () => {
  const plan = parseMemoryPlan(
    "[TP0] Load weight end. type=Qwen, dtype=bf16, avail mem=40.1 GB, mem usage=61.90 GB.\n[TP0] KV Cache is allocated. #tokens: 500000, K size: 5.25 GB, V size: 5.25 GB",
  );
  assert.deepEqual(plan, { weightsGiB: 61.9, kvGiB: 10.5 });
});

test("a start made elsewhere: a launcher log older than the containers is not trusted", async () => {
  const { externalProgress, parseDockerTime } = await import("../progress.ts");
  const log = "=== spark-lens: start 2026-10-01 13:31:05\nCapturing CUDA graphs 50%\n";
  const containers = parseDockerTime("2026-10-01T13:20:00.123456789Z\n");
  assert.equal(containers, Date.parse("2026-10-01T13:20:00.123Z"));
  // Log last written at 04:00Z, containers started at 13:20Z: the log is from an earlier start.
  const stale = externalProgress(log, Date.parse("2026-10-01T04:00:00Z"), containers);
  assert.deepEqual(stale, { pct: null, stage: "モデルを読み込んでいます", startedAt: containers });
  // Written after the containers started: the log is this start's.
  const fresh = externalProgress(log, Date.parse("2026-10-01T13:25:00Z"), containers);
  assert.equal(fresh.pct, 83);
  assert.equal(fresh.startedAt, Date.parse("2026-10-01T13:31:05"));
  assert.equal(parseDockerTime("0001-01-01T00:00:00Z"), null);
  // stat's whole second against Docker's milliseconds: the same second is not "older".
  assert.equal(externalProgress(log, Date.parse("2026-10-01T13:20:00Z"), containers).pct, 83);
});

test("start progress follows the TensorFold launchers' steps and loading", () => {
  const head = [
    "[1/5] Setup: image and checkpoint on both Sparks",
    "[3/5] Launch: container glm53-flash-tf, rank 1 on worker, then rank 0 here",
    "[4/5] Loading: ~80 GiB of weights on each Spark",
    "  │ [tensorfold] loading GLM-5.3-Flash-EXL3: GLM-5.3-Flash (glm5_next) on CUDA, rank 0 of 2",
    "  ⋯ 46s elapsed, 44.0 of ~88.0 GiB on the GPU here, 39.0 on the worker",
  ].join("\n");
  assert.deepEqual(parseProgress(head), { pct: 47, stage: "モデルを読み込んでいます" });
  // More than the estimate ends loading, not past it.
  assert.equal(parseProgress(`${head}\n  ⋯ 92s elapsed, 94.4 of ~88.09 GiB on the GPU here`).pct, 80);
  assert.deepEqual(parseProgress(`${head}\n  │ [tensorfold] serving GLM-5.3-Flash-EXL3 at http://0.0.0.0:8888/v1`), { pct: 93, stage: "最終確認をしています" });
});
