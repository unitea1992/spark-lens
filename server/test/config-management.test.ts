import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../config.ts";
import { manageConfig } from "../config-management.ts";

test("manage configured nodes and providers without losing unrelated config", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-manage-"));
  const path = join(dir, "config.json");
  try {
    const raw = { hosts: [{ id: "dev", label: "Dev", kind: "workstation", local: true }], subscriptions: [{ type: "claude-code" }, { type: "codex" }], pollSeconds: 9 };
    writeFileSync(path, JSON.stringify(raw));
    let current = parseConfig(raw);
    current = manageConfig(path, current, "hosts", "add", { id: "worker-3", label: "Worker", ssh: "worker-3", kind: "server" });
    assert.equal(current.hosts.length, 2);
    assert.equal(current.pollSeconds, 9);
    current = manageConfig(path, current, "subscriptions", "remove", { id: "claude-code" });
    assert.equal(current.subscriptions[0]?.id, "codex");
    current = manageConfig(path, current, "subscriptions", "add", { id: "grok", type: "grok" });
    assert.deepEqual(current.subscriptions.map((s) => s.id), ["codex", "grok"]);
    assert.deepEqual((JSON.parse(readFileSync(path, "utf8")) as { subscriptions: { id: string }[] }).subscriptions.map((x) => x.id), ["codex", "grok"]);
    assert.throws(() => manageConfig(path, current, "hosts", "remove", { id: "dev" }), /ローカル/);
    assert.throws(() => manageConfig(path, current, "hosts", "add", { id: "bad-node", label: "Bad", ssh: "-evil", kind: "server" }), /unsupported/);
    assert.throws(() => manageConfig(path, current, "subscriptions", "add", { id: "command", type: "command" }), /組み込み/);
    current = manageConfig(path, current, "hosts", "remove", { id: "worker-3" });
    assert.equal(current.hosts.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses external edits rather than overwriting them", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-drift-"));
  const path = join(dir, "config.json");
  try {
    const raw = { hosts: [{ id: "local", label: "Local", kind: "workstation", local: true }] };
    writeFileSync(path, JSON.stringify(raw));
    const current = parseConfig(raw);
    writeFileSync(path, JSON.stringify({ ...raw, pollSeconds: 10 }));
    assert.throws(() => manageConfig(path, current, "subscriptions", "add", { id: "grok", type: "grok" }), /外部で変更/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("head/worker topology saves by id and protects referenced heads", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-topology-"));
  const path = join(dir, "config.json");
  try {
    const raw = { hosts: [
      { id: "main", label: "Main", kind: "spark", ssh: "main" },
      { id: "other", label: "Other", kind: "spark", ssh: "other" },
    ] };
    writeFileSync(path, JSON.stringify(raw));
    let current = parseConfig(raw);
    assert.throws(() => manageConfig(path, current, "hosts", "update", { id: "other", role: "worker", headId: "main" }), /non-head/);
    current = manageConfig(path, current, "hosts", "update", { id: "main", role: "head" });
    current = manageConfig(path, current, "hosts", "update", { id: "other", role: "worker", headId: "main" });
    assert.equal(current.hosts.find((h) => h.id === "other")?.headId, "main");
    assert.throws(() => manageConfig(path, current, "hosts", "remove", { id: "main" }), /依存/);
    assert.throws(() => manageConfig(path, current, "hosts", "update", { id: "main", role: "standalone" }), /non-head/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
