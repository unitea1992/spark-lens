import assert from "node:assert/strict";
import { test } from "node:test";
import { History } from "../history.ts";

test("samples average per minute and age out after a day", () => {
  const h = new History();
  const t0 = Date.UTC(2026, 9, 1, 12, 0, 5);
  h.record("a", 10, t0);
  h.record("a", 20, t0 + 30_000);
  h.record("a", 40, t0 + 60_000);
  h.record("a", null, t0 + 61_000);
  assert.deepEqual(h.points("a", t0 + 61_000), [
    { t: Date.UTC(2026, 9, 1, 12, 0), v: 15 },
    { t: Date.UTC(2026, 9, 1, 12, 1), v: 40 },
  ]);
  h.record("a", 5, t0 + 24 * 3600_000 + 60_000);
  assert.deepEqual(
    h.points("a", t0 + 24 * 3600_000 + 60_000).map((p) => p.v),
    [5],
  );
});

test("history survives a dump and reload", () => {
  const h = new History();
  h.record("k", 3, Date.UTC(2026, 9, 1, 12));
  const again = new History(JSON.parse(JSON.stringify(h.dump())));
  assert.deepEqual(again.points("k", Date.UTC(2026, 9, 1, 12, 5)), [{ t: Date.UTC(2026, 9, 1, 12), v: 3 }]);
  assert.deepEqual(new History({ bad: "x" } as never).keys(), []);
});
