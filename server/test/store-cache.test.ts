import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../store.ts";

test("cache counters accumulate with prompt totals and survive a state restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-cache-store-"));
  try {
    const now = new Date("2026-10-29T10:00:00Z");
    const s = new Store(dir);
    s.addTokens("llm", 800, 40, now); // legacy, unknown cache hits
    s.addTokens("llm", 1000, 60, now, 900);
    s.addTokens("llm", 300, 20, now, 350); // clamp to prompt size
    s.addTokens("llm", 200, 0, now, null); // metrics temporarily absent
    s.flush();
    const actual = new Store(dir).tokensOn("llm", now);
    assert.deepEqual(actual, { prompt: 2300, generation: 120, cached: 1200, cacheMeasuredPrompt: 1300 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
