import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeLog, parseOpencodeStats, recentDays } from "../collectors/usage.ts";
import { localDate } from "../store.ts";

const line = (o: object) => JSON.stringify(o);
const assistant = (id: string, req: string, model: string, timestamp: string, usage: object) =>
  line({ type: "assistant", requestId: req, timestamp, message: { id, model, usage } });

test("Claude log: chunks of one reply share a key, synthetic and non-assistant lines are skipped", () => {
  const ts = "2026-09-20T03:00:00.000Z";
  const text = [
    assistant("m1", "r1", "claude-opus", ts, { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100 }),
    assistant("m1", "r1", "claude-opus", ts, { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 100 }),
    assistant("m2", "r2", "<synthetic>", ts, { input_tokens: 1, output_tokens: 1 }),
    line({ type: "user", message: { usage: {} } }),
    'not json but has "usage" and "assistant"',
    "",
  ].join("\n");
  const entries = parseClaudeLog(text);
  // Parsing keeps both chunks; the collector dedupes on `key`.
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((e) => e.key)).size, 1);
  assert.equal(entries[0]!.key, "m1:r1");
  assert.equal(entries[0]!.model, "claude-opus");
  assert.equal(entries[0]!.input, 15);
  assert.equal(entries[0]!.cached, 100);
  assert.equal(entries[1]!.output, 40);
});

test("Claude log: the day is the local date of the timestamp", () => {
  const ts = "2026-09-20T23:30:00.000Z";
  const [e] = parseClaudeLog(assistant("m", "r", "claude-sonnet", ts, { input_tokens: 1, output_tokens: 1 }));
  assert.equal(e!.day, localDate(new Date(ts)));
  assert.deepEqual(parseClaudeLog(assistant("m", "r", "claude-sonnet", "garbage", { input_tokens: 1 })), []);
});

test("OpenCode stats: input includes cache writes, output includes reasoning", () => {
  const out = JSON.stringify({
    models: [
      { model: { id: "glm-5" }, tokens: { input: 10, output: 4, reasoning: 6, cache: { read: 50, write: 3 } } },
      { model: { id: "bare" }, tokens: { input: 1 } },
      { tokens: { input: 9 } },
    ],
  });
  assert.deepEqual(parseOpencodeStats(out), [
    { model: "glm-5", input: 13, output: 10, cached: 50 },
    { model: "bare", input: 1, output: 0, cached: 0 },
  ]);
  assert.deepEqual(parseOpencodeStats("nope"), []);
  assert.deepEqual(parseOpencodeStats("{}"), []);
});

test("recentDays: today first, one distinct local date per day", () => {
  const now = new Date("2026-10-01T12:00:00");
  const days = recentDays(30, now);
  assert.equal(days.length, 30);
  assert.equal(days[0], localDate(now));
  assert.equal(new Set(days).size, 30);
  assert.deepEqual(recentDays(7, now), days.slice(0, 7));
});

test("Codex rollout: per-response usage with the model from the turn context, cached split out of input", async () => {
  const { parseCodexRollout } = await import("../collectors/usage.ts");
  const lines = [
    { timestamp: "2026-10-01T03:00:00Z", type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { timestamp: "2026-10-01T03:00:05Z", type: "token_usage_record", payload: { response_id: "resp_1", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } },
    { timestamp: "2026-10-01T03:00:06Z", type: "event_msg", payload: { type: "agent_message" } },
    { timestamp: "2026-10-01T03:00:09Z", type: "token_usage_record", payload: { response_id: "resp_2", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 70 } } },
  ].map((l) => JSON.stringify(l));
  const state = { model: null as string | null };
  const out = parseCodexRollout(lines.join("\n"), state);
  assert.deepEqual(
    out.map((e) => [e.key, e.model, e.input, e.cached, e.output]),
    [
      ["r:resp_1", "gpt-6.1-sol", 200, 800, 50],
      ["r:resp_2", "gpt-6.1-sol", 200, 1000, 70],
    ],
  );
  // The model carries over to the next chunk read from the same file.
  const more = parseCodexRollout(JSON.stringify({ timestamp: "2026-10-01T03:01:00Z", type: "token_usage_record", payload: { response_id: "resp_3", usage: { input_tokens: 5, output_tokens: 1 } } }), state);
  assert.equal(more[0]?.model, "gpt-6.1-sol");
});

test("Codex rollout: token counts are only a fallback for rollouts without usage records", async () => {
  const { parseCodexRollout } = await import("../collectors/usage.ts");
  const both = [
    { timestamp: "2026-10-01T03:00:00Z", type: "turn_context", payload: { model: "m" } },
    { timestamp: "2026-10-01T03:00:05Z", type: "token_usage_record", payload: { response_id: "resp_1", usage: { input_tokens: 10, output_tokens: 1 } } },
    { timestamp: "2026-10-01T03:00:05Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 11 }, last_token_usage: { input_tokens: 10, output_tokens: 1 } } } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const keys = parseCodexRollout(both, { model: null }).map((e) => e.key[0]);
  assert.deepEqual(keys, ["r", "c"], "both are parsed; the collector keeps the records");
});
