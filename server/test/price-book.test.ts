import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PriceBook, PRICE_CHECK_MS } from "../pricing.ts";

const catalog = { zai: { models: { "glm-5.3-flash": { cost: { input: 0.15, output: 0.5, cache_read: 0.03 } } } } };

test("price updates every six hours with conditional ETags and persisted revalidation age", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-price-book-"));
  try {
    const requests: { url: string; tag?: string }[] = [];
    const book = new PriceBook(dir, { fetchPrice: async (url, tag) => {
      requests.push({ url, tag });
      return tag ? { kind: "not_modified", etag: tag } : url.includes("models.dev")
        ? { kind: "data", body: catalog, etag: '"md-1"' }
        : { kind: "data", body: {}, etag: '"lite-1"' };
    } });
    const start = 2_000_000_000_000;
    await book.refreshIfStale(start);
    assert.equal(requests.length, 2);
    assert.equal(book.current()?.fetchedAt, start);
    assert.equal(book.current()?.modelsDev["zai/glm-5.3-flash"]?.cacheRead, 0.03);
    await book.refreshIfStale(start + PRICE_CHECK_MS - 1);
    assert.equal(requests.length, 2, "no unnecessary fetch within six hours");
    await book.refreshIfStale(start + PRICE_CHECK_MS);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.slice(2).map((x) => x.tag), ['"md-1"', '"lite-1"']);
    assert.equal(book.current()?.fetchedAt, start, "304 does not change source fetch time");
    assert.equal(book.current()?.checkedAt, start + PRICE_CHECK_MS);
    const persisted = JSON.parse(readFileSync(join(dir, "prices.json"), "utf8"));
    assert.equal(persisted.checkedAt, start + PRICE_CHECK_MS);
    const restored = new PriceBook(dir, { fetchPrice: async () => { throw new Error("should not refetch"); } });
    await restored.refreshIfStale(start + PRICE_CHECK_MS + 1000);
    assert.equal(restored.current()?.checkedAt, start + PRICE_CHECK_MS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed price revalidation keeps previously saved prices and backs off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-price-failure-"));
  try {
    const start = 2_000_000_000_000;
    let fail = false;
    let calls = 0;
    const book = new PriceBook(dir, { fetchPrice: async (url) => {
      calls++;
      if (fail && url.includes("models.dev")) throw new Error("HTTP 500");
      return { kind: "data", body: url.includes("models.dev") ? catalog : {} };
    } });
    await book.refreshIfStale(start);
    fail = true;
    await book.refreshIfStale(start + PRICE_CHECK_MS);
    assert.equal(book.current()?.checkedAt, start);
    assert.equal(book.current()?.modelsDev["zai/glm-5.3-flash"]?.input, 0.15);
    const attempted = calls;
    await book.refreshIfStale(start + PRICE_CHECK_MS + 15_000);
    assert.equal(calls, attempted, "failed attempt is throttled");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
