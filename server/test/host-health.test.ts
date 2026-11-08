import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryWarning } from "../host-health.ts";
import type { HostSnapshot } from "../types.ts";

function sample(kind: HostSnapshot["kind"], percent: number, some: number | null, full: number | null, oom = false) {
  return {
    kind, memTotalBytes: 1000, memUsedBytes: percent * 10,
    memoryPressure: { someAvg10: some, fullAvg10: full, oomKillRecent: oom },
  };
}

test("Spark inference node at 97-99.9% used is normal without reclaim stalls", () => {
  assert.equal(memoryWarning(sample("spark", 97, 0.2, 0)), null);
  assert.equal(memoryWarning(sample("spark", 99.9, null, null)), null);
});

test("Spark reports significant memory PSI and recent OOM", () => {
  assert.deepEqual(memoryWarning(sample("spark", 96, 20, 0)), { severity: "warn", message: "メモリ圧力が高い" });
  assert.deepEqual(memoryWarning(sample("spark", 96, 0, 5)), { severity: "warn", message: "メモリ圧力が高い" });
  assert.deepEqual(memoryWarning(sample("spark", 70, 0, 0, true)), { severity: "critical", message: "OOMを検出" });
});

test("ordinary workstation still warns on genuinely low available memory", () => {
  assert.equal(memoryWarning(sample("workstation", 90, null, null)), null);
  assert.equal(memoryWarning(sample("workstation", 94, null, null))?.severity, "warn");
  assert.equal(memoryWarning(sample("workstation", 99, null, null))?.severity, "critical");
});
