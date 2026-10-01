import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES, summarise, timeStream } from "../bench.ts";

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test("stream timing reads first/last token times and usage, across split chunks", async () => {
  let clock = 1000;
  const now = () => (clock += 100);
  const body = sse([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\ndata: {"choices":[{"delta":{"con',
    'tent":"a"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":21}}\n\ndata: [DONE]\n\n',
  ]);
  const t = await timeStream(body, 1000, now);
  assert.equal(t.ttftMs, 100);
  assert.equal(t.decodeMs, 200);
  assert.equal(t.promptTokens, 12);
  assert.equal(t.completionTokens, 21);
});

test("summaries give decode speed for generation cases and prefill speed for the long input", () => {
  const prose = CASES.find((c) => c.key === "prose")!;
  const s = summarise(prose, { ttftMs: 300, decodeMs: 2000, promptTokens: 40, completionTokens: 101 });
  assert.equal(s.decodeTps, 50);
  assert.equal(s.prefillTps, null);
  const prefill = CASES.find((c) => c.key === "prefill")!;
  const p = summarise(prefill, { ttftMs: 4000, decodeMs: 100, promptTokens: 8000, completionTokens: 20 });
  assert.equal(p.prefillTps, 2000);
  assert.equal(p.decodeTps, null);
  assert.equal(summarise(prose, { ttftMs: null, decodeMs: null, promptTokens: null, completionTokens: null }).decodeTps, null);
});

test("a stream that breaks mid-answer is recorded as a failure, not an unhandled rejection", async () => {
  const { BenchRunner, runBench } = await import("../bench.ts");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          c.error(new Error("socket hang up"));
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const result = await runBench("http://x", "m", undefined, () => {});
    assert.match(result.error ?? "", /接続が切れました/);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Even an unexpected throw ends the run and keeps the dashboard alive.
  const runs: unknown[] = [];
  const runner = new BenchRunner({ benchRuns: () => [], addBenchRun: (r) => runs.push(r) }, async () => {
    throw new Error("boom");
  });
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  let calls = 0;
  runner.start("m", { baseUrl: "http://x", model: "m", commit: null, repo: null }, () => {
    if (++calls >= 2) done();
  });
  await finished;
  assert.equal(runner.snapshot(["m"]).m?.running, false);
  assert.equal(runs.length, 1);
  assert.match((runs[0] as { error: string }).error, /boom/);
});
