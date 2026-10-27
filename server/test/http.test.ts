import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";
import { ACTION_HEADER, HttpServer, type HttpOptions } from "../http.ts";
import type { Snapshot } from "../types.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  type: string | undefined;
  cache: string | undefined;
  allow: string | undefined;
  body: string;
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers["content-type"],
          cache: res.headers["cache-control"],
          allow: res.headers.allow,
          body,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const snapshot = {
  generatedAt: 1,
  subscriptions: [],
  llms: [],
  usage: { generatedAt: 0, pricesFetchedAt: null, pricesSource: null, today: [], week: [], month: [] },
} as unknown as Snapshot;

async function withServer(extra: Partial<HttpOptions>, body: (port: number) => Promise<void>): Promise<void> {
  const port = await freePort();
  const server = new HttpServer({ host: "127.0.0.1", port, staticDir: "/nonexistent", allowedHosts: [], snapshot: () => snapshot, ...extra });
  await server.listen();
  try {
    await body(port);
  } finally {
    server.close();
  }
}

const JSON_TYPE = "application/json; charset=utf-8";

test("the read-only API answers JSON that is never cached, and HEAD without a body", async () => {
  await withServer({ history: () => [{ t: 1, v: 2 }], historyKeys: () => ["host:a:cpu"] }, async (port) => {
    for (const path of ["/api/state", "/api/quota", "/api/quota?view=brief", "/api/usage", "/api/history", "/api/history?key=host:a:cpu"]) {
      const get = await send(port, "GET", path);
      assert.equal(get.status, 200, path);
      assert.equal(get.type, JSON_TYPE, path);
      assert.equal(get.cache, "no-store", path);
      JSON.parse(get.body);
      const head = await send(port, "HEAD", path);
      assert.equal(head.status, 200, path);
      assert.equal(head.type, JSON_TYPE, path);
      assert.equal(head.body, "", path);
    }
    assert.deepEqual(JSON.parse((await send(port, "GET", "/api/state")).body), snapshot);
    const normal = JSON.parse((await send(port, "GET", "/api/quota")).body);
    const brief = JSON.parse((await send(port, "GET", "/api/quota?view=brief&days=7")).body);
    assert.deepEqual(Object.keys(normal), ["generated_at", "generated_at_jst", "thresholds", "models"]);
    assert.deepEqual(Object.keys(brief), ["generated_at_jst", "models"]);
    assert.deepEqual(Object.keys(JSON.parse((await send(port, "GET", "/api/quota?view=other")).body)), Object.keys(normal));
    assert.deepEqual(JSON.parse((await send(port, "GET", "/api/history")).body), { keys: ["host:a:cpu"] });
    assert.deepEqual(JSON.parse((await send(port, "GET", "/api/history?key=host:a:cpu")).body), [{ t: 1, v: 2 }]);
    assert.deepEqual(JSON.parse((await send(port, "GET", "/api/history?key=bad%20key")).body), []);
  });
});

test("unknown API paths, wrong methods and bad paths", async () => {
  await withServer({}, async (port) => {
    const missing = await send(port, "GET", "/api/nothing");
    assert.deepEqual([missing.status, missing.type, missing.cache, missing.body], [404, JSON_TYPE, undefined, '{"error":"not found"}']);
    const post = await send(port, "POST", "/api/state");
    assert.deepEqual([post.status, post.allow, post.body], [405, "GET, HEAD", ""]);
    assert.equal((await send(port, "GET", "/%E0%A4%A")).status, 400);
    const health = await send(port, "GET", "/healthz");
    assert.deepEqual([health.status, health.type, health.cache, health.body], [200, "text/plain; charset=utf-8", "no-store", "ok\n"]);
    const page = await send(port, "GET", "/");
    assert.equal(page.status, 404);
    assert.match(page.body, /pnpm build/);
  });
});

test("recipe and benchmark actions need POST and the dashboard's header", async () => {
  const done = { ok: true, message: "done" };
  const recipes = {
    start: async () => done,
    stop: async () => ({ ok: false, message: "busy" }),
    logs: async () => ({ ok: true, text: "log" }),
    check: async () => done,
    update: async () => done,
    switchTo: async () => done,
  };
  await withServer(
    { recipes, bench: async () => ({ ok: true, message: "started" }), benchStop: () => ({ ok: false, message: "idle" }) },
    async (port) => {
      const act = { [ACTION_HEADER]: "1" };
      const start = await send(port, "POST", "/api/recipes/r1/start", act);
      assert.deepEqual([start.status, start.type, start.cache, JSON.parse(start.body)], [202, JSON_TYPE, "no-store", done]);
      const stop = await send(port, "POST", "/api/recipes/r1/stop", act);
      assert.deepEqual([stop.status, JSON.parse(stop.body)], [409, { ok: false, message: "busy" }]);
      const forged = await send(port, "POST", "/api/recipes/r1/start");
      assert.equal(forged.status, 403);
      assert.equal(JSON.parse(forged.body).ok, false);
      const wrong = await send(port, "GET", "/api/recipes/r1/start");
      assert.deepEqual([wrong.status, wrong.allow], [405, "POST"]);
      const logs = await send(port, "GET", "/api/recipes/r1/logs");
      assert.deepEqual([logs.status, JSON.parse(logs.body)], [200, { ok: true, text: "log" }]);
      assert.deepEqual([(await send(port, "POST", "/api/recipes/r1/logs", act)).allow], ["GET"]);

      const bench = await send(port, "POST", "/api/llms/m1/bench", act);
      assert.deepEqual([bench.status, bench.type, bench.cache, JSON.parse(bench.body)], [202, JSON_TYPE, "no-store", { ok: true, message: "started" }]);
      const benchStop = await send(port, "POST", "/api/llms/m1/bench/stop", act);
      assert.deepEqual([benchStop.status, JSON.parse(benchStop.body)], [409, { ok: false, message: "idle" }]);
      assert.equal((await send(port, "POST", "/api/llms/m1/bench")).status, 403);
      const benchGet = await send(port, "GET", "/api/llms/m1/bench");
      assert.deepEqual([benchGet.status, benchGet.allow], [405, "POST"]);
    },
  );
});

test("without recipes or benchmarks configured, their routes say so", async () => {
  await withServer({}, async (port) => {
    const act = { [ACTION_HEADER]: "1" };
    const recipe = await send(port, "POST", "/api/recipes/r1/start", act);
    assert.deepEqual([recipe.status, recipe.type, recipe.cache, JSON.parse(recipe.body).ok], [404, JSON_TYPE, "no-store", false]);
    const bench = await send(port, "POST", "/api/llms/m1/bench", act);
    assert.deepEqual([bench.status, JSON.parse(bench.body).ok], [404, false]);
  });
});
