import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageWindow } from "../../server/types.ts";
import { elapsedPct, pace } from "./pace.ts";

const HOUR = 3600_000;
const now = Date.UTC(2026, 9, 1, 12);
const window = (usedPct: number, hoursLeft: number): UsageWindow => ({
  id: "w",
  label: "5時間",
  usedPct,
  resetsAt: now + hoursLeft * HOUR,
  windowSec: 5 * 3600,
});

test("elapsedPct places now inside the window", () => {
  assert.ok(Math.abs((elapsedPct(window(0, 4), now) ?? 0) - 20) < 1e-9);
  assert.equal(elapsedPct(window(0, 6), now), null);
  assert.equal(elapsedPct({ ...window(0, 4), windowSec: null }, now), null);
});

test("pace projects the end-of-window share from use so far", () => {
  // 20% used with 40% of the window gone ends near 50%.
  assert.match(pace(window(20, 3), now)?.text ?? "", /余裕あり.*約50%/);
  assert.equal(pace(window(20, 3), now)?.tone, "good");
  assert.equal(pace(window(36, 3), now)?.tone, "ok");
  // 60% used at 40% elapsed runs out with 40% left at 30%/h -> about 1h20m.
  const fast = pace(window(60, 3), now);
  assert.equal(fast?.tone, "warn");
  assert.match(fast?.text ?? "", /1時間 20分/);
  assert.equal(pace(window(100, 3), now)?.tone, "critical");
});

test("pace stays quiet too early in a window or without numbers", () => {
  assert.equal(pace(window(1, 4.9), now), null);
  assert.equal(pace({ ...window(10, 3), usedPct: null }, now), null);
});
