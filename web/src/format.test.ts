import assert from "node:assert/strict";
import { test } from "node:test";
import { count, dockerStatus } from "./format.ts";

test("count keeps three significant digits and drops trailing zeros", () => {
  assert.equal(count(850000), "850K");
  assert.equal(count(9257), "9.26K");
  assert.equal(count(90150000), "90.2M");
  assert.equal(count(1000), "1K");
  assert.equal(count(512), "512");
  assert.equal(count(null), "–");
});

test("dockerStatus translates the common shapes", () => {
  assert.equal(dockerStatus("Up 5 minutes"), "稼働 5 分");
  assert.equal(dockerStatus("Up About a minute"), "稼働 1 分");
  assert.equal(dockerStatus("Up 2 hours (healthy)"), "稼働 2 時間");
  assert.equal(dockerStatus("Exited (143) 2 days ago"), "停止（2 日前・終了コード 143）");
  assert.equal(dockerStatus("Created"), "Created");
});
