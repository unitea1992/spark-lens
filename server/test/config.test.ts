import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "../config.ts";
import { hostAllowed } from "../http.ts";

test("an empty config monitors this machine with the default subscriptions", () => {
  const c = parseConfig({});
  assert.equal(c.hosts.length, 1);
  assert.equal(c.hosts[0]?.local, true);
  assert.deepEqual(c.subscriptions.map((s) => s.type), ["claude-code", "codex", "opencode-go"]);
  assert.deepEqual(c.server, { host: "127.0.0.1", port: 8686, allowedHosts: [] });
  assert.equal(c.pollSeconds, 5);
});

test("the shipped example config is valid", () => {
  const c = parseConfig(JSON.parse(readFileSync(new URL("../../config/config.example.json", import.meta.url), "utf8")));
  assert.equal(c.hosts.length, 3);
  assert.equal(c.llms[0]?.baseUrl, "http://spark-1:8888");
});

test("normalises an LLM base URL given with /v1", () => {
  const c = parseConfig({ hosts: [{ id: "a", local: true }], llms: [{ id: "m", baseUrl: "http://a:8888/v1/" }] });
  assert.equal(c.llms[0]?.baseUrl, "http://a:8888");
});

test("rejects values that would be unsafe on a command line", () => {
  const bad: unknown[] = [
    { hosts: [{ id: "a", ssh: "-oProxyCommand=evil" }] },
    { hosts: [{ id: "a", ssh: "host; rm -rf /" }] },
    { hosts: [{ id: "a", local: true, mounts: ["/ $(id)"] }] },
    { hosts: [{ id: "a", local: true, mounts: ["/x'"] }] },
    { agents: { processes: [{ tool: "t", match: "a'; id; '" }] } },
    { agents: { processes: [{ tool: "t", match: "(" }] } },
  ];
  for (const raw of bad) assert.throws(() => parseConfig(raw), JSON.stringify(raw));
});

test("rejects structural mistakes with a message naming the field", () => {
  assert.throws(() => parseConfig({ hosts: [{ id: "a" }] }), /hosts\[0\]/);
  assert.throws(() => parseConfig({ hosts: [{ id: "a", local: true }, { id: "a", local: true }] }), /duplicate/);
  assert.throws(() => parseConfig({ hosts: [{ id: "a", local: true }], llms: [{ id: "m", baseUrl: "http://a", nodes: ["b"] }] }), /unknown host/);
  assert.throws(() => parseConfig({ llms: [{ id: "m", baseUrl: "ftp://a" }] }), /http/);
  assert.throws(() => parseConfig({ pollSeconds: 0 }), /pollSeconds/);
  assert.throws(() => parseConfig({ server: { port: "80" } }), /server\.port/);
  assert.throws(() => parseConfig([]), /object/);
});

test("Host header: local names, IPs and tailnet names pass; others do not", () => {
  for (const ok of ["localhost:8686", "127.0.0.1:8686", "[::1]:8686", "100.64.0.1", "box.tail1234.ts.net", "box.tail1234.ts.net:8686", "LOCALHOST"]) {
    assert.ok(hostAllowed(ok, []), ok);
  }
  for (const no of [undefined, "", "evil.example.com", "ts.net.evil.com", "localhost.evil.com:80"]) {
    assert.ok(!hostAllowed(no, []), String(no));
  }
  assert.ok(hostAllowed("lens.example.com", ["lens.example.com"]));
});

test("recipes must point at known hosts and llms", () => {
  const base = { hosts: [{ id: "a", local: true }], llms: [{ id: "m", baseUrl: "http://a:1" }] };
  const ok = parseConfig({ ...base, recipes: [{ id: "r", host: "a", llm: "m", dir: "~/x", start: "./s", stop: "./s stop" }] });
  assert.equal(ok.recipes[0]?.label, "r");
  assert.throws(() => parseConfig({ ...base, recipes: [{ id: "r", host: "zz", dir: "x", start: "s", stop: "s" }] }), /unknown host/);
  assert.throws(() => parseConfig({ ...base, recipes: [{ id: "r", host: "a", llm: "q", dir: "x", start: "s", stop: "s" }] }), /unknown llm/);
  assert.throws(() => parseConfig({ ...base, recipes: [{ id: "r", host: "a", dir: "x", start: "s" }] }), /stop/);
});
