import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeSessions,
  codexTurnState,
  mergeAgents,
  parseOpencodeSessions,
  parseOrca,
  processAgents,
  procRegex,
  REMOTE_RULES,
  trimIdle,
} from "../collectors/agents.ts";

test("Claude Code: lists sessions whose process is alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-claude-"));
  const live = { pid: process.pid, sessionId: "a", cwd: "/work/app/", name: "fix login", status: "busy", statusUpdatedAt: 5 };
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(live));
  // 2^31-1 is never a live pid.
  writeFileSync(join(dir, "2147483647.json"), JSON.stringify({ ...live, pid: 2147483647, sessionId: "dead" }));
  writeFileSync(join(dir, "123.json"), "{ half written");
  // Same live pid, but recorded for a process that started at another time.
  writeFileSync(join(dir, "1.json"), JSON.stringify({ ...live, pid: process.pid, sessionId: "reused", procStart: "1" }));
  writeFileSync(join(dir, `${process.pid}.abc.key`), "ignored");
  const sessions = await claudeSessions(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "claude:a");
  assert.equal(sessions[0]?.status, "working");
  assert.equal(sessions[0]?.cwd, "/work/app");
  assert.equal(sessions[0]?.title, "fix login");
  assert.deepEqual(await claudeSessions(join(dir, "missing")), []);
});

test("Codex: the last turn marker decides working vs finished", () => {
  const started = '{"type":"event_msg","payload":{"type":"task_started"}}';
  const done = '{"type":"event_msg","payload":{"type":"task_complete"}}';
  const other = '{"type":"response_item","payload":{"type":"message","text":"task_started"}}';
  assert.equal(codexTurnState([started, other].join("\n")), "started");
  assert.equal(codexTurnState([started, done, other].join("\n")), "finished");
  assert.equal(codexTurnState([done, started].join("\n")), "started");
  assert.equal(codexTurnState(other), null);
});

test("OpenCode: active sessions are working, stale idle ones are dropped", () => {
  const now = 1_000_000_000_000;
  const list = [
    { id: "s1", title: "Refactor", time: { created: now - 5000, updated: now - 1000 }, location: { directory: "/w/a" }, model: { id: "m1" } },
    { id: "s2", title: "Old", time: { updated: now - 48 * 3600 * 1000 }, location: { directory: "/w/b" } },
    { id: "s3", title: "Old but running", time: { updated: now - 48 * 3600 * 1000 }, location: { directory: "/w/c" } },
    { id: "s4", title: "Archived", time: { updated: now, archived: now } },
  ];
  const out = parseOpencodeSessions(list, { s3: {} }, now);
  assert.deepEqual(out.map((a) => [a.id, a.status]), [["opencode:s1", "idle"], ["opencode:s3", "working"]]);
  assert.equal(out[0]?.detail, "m1");
  assert.deepEqual(parseOpencodeSessions(null, {}, now), []);
});

test("Orca: maps pane agents and falls back through title fields", () => {
  const out = parseOrca({
    result: {
      worktrees: [
        {
          path: "/w/app/",
          agents: [
            { paneKey: "p1", agentType: "claude", state: "working", prompt: "  add   tests  ", toolName: "Bash", updatedAt: 9 },
            { paneKey: "p2", agentType: "omp", state: "done", taskTitle: "Merge", prompt: "ignored" },
            { paneKey: "p3", agentType: "codex", state: "something-new" },
            { paneKey: "p4", agentType: "claude", state: "working", interrupted: true },
          ],
        },
        { path: "/w/none" },
      ],
    },
  });
  assert.deepEqual(out.map((a) => a.status), ["working", "idle", "unknown", "idle"]);
  assert.equal(out[0]?.title, "add tests");
  assert.equal(out[0]?.detail, "Bash");
  assert.equal(out[0]?.cwd, "/w/app");
  assert.equal(out[1]?.title, "Merge");
  assert.deepEqual(parseOrca({}), []);
});

test("merge: Orca fills in a tool's own record instead of duplicating it", () => {
  const base = { pid: null, startedAt: null, lastActivity: null, cpuPct: null, detail: null };
  const own = [{ ...base, id: "claude:a", tool: "claude", title: null, cwd: "/w/app", status: "working" as const, pid: 1 }];
  const orca = [
    { ...base, id: "orca:p1", tool: "claude", title: "add tests", cwd: "/w/app", status: "idle" as const },
    { ...base, id: "orca:p2", tool: "omp", title: "merge", cwd: "/w/app", status: "idle" as const },
  ];
  const merged = mergeAgents(own, orca);
  assert.deepEqual(merged.map((a) => a.id), ["claude:a", "orca:p2"]);
  assert.equal(merged[0]?.title, "add tests");
  // The tool's own status wins over Orca's.
  assert.equal(merged[0]?.status, "working");
});

test("trimIdle keeps live work and only a few recent finished sessions per tool", () => {
  const now = 1_000_000_000_000;
  const mk = (id: string, status: "working" | "idle", ageMin: number, pid: number | null = null) => ({
    id,
    tool: "codex",
    title: null,
    cwd: null,
    status,
    pid,
    startedAt: null,
    lastActivity: now - ageMin * 60_000,
    cpuPct: null,
    detail: null,
  });
  const out = trimIdle(
    [mk("w", "working", 9999), mk("i1", "idle", 1), mk("i2", "idle", 2), mk("i3", "idle", 3), mk("i4", "idle", 4), mk("old", "idle", 9999), mk("livepid", "idle", 9999, 42)],
    now,
  );
  assert.deepEqual(out.map((a) => a.id).sort(), ["i1", "i2", "i3", "livepid", "w"]);
});

test("process rules: built-in patterns match agent CLIs but not their helpers", () => {
  const re = new RegExp(procRegex([]));
  for (const hit of ["claude", "/usr/local/bin/claude --resume", "codex exec --json -", "/home/u/.opencode/bin/opencode run hi"]) {
    assert.ok(re.test(hit), hit);
  }
  for (const miss of ["codex app-server --listen unix://", "/home/u/.opencode/bin/opencode serve --service", "vim claude.md", "claude-hook.sh"]) {
    assert.ok(!re.test(miss), miss);
  }
  const procs = [
    { pid: 5, elapsedSec: 60, cpuPct: 40, rssBytes: 1, cwd: "/w/x/", args: "codex exec --json" },
    { pid: 6, elapsedSec: 60, cpuPct: 0, rssBytes: 1, cwd: "", args: "hermes gateway" },
  ];
  const out = processAgents(procs, [...REMOTE_RULES, { tool: "hermes", label: "Hermes", match: "^hermes " }], 1_000_000);
  assert.deepEqual(out.map((a) => [a.tool, a.status, a.cwd]), [["codex", "working", "/w/x"], ["hermes", "idle", null]]);
  assert.equal(out[0]?.startedAt, 1_000_000 - 60_000);
});
