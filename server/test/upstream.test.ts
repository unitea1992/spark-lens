import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RecipeManager } from "../recipes.ts";
import type { LlmSnapshot } from "../types.ts";
import { checkScript, parseCheck } from "../upstream.ts";

const IDENT = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };

/** Runs fn with git identity and a private HOME set, restoring the environment afterwards. */
async function withEnv<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const keys = [...Object.keys(IDENT), "HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, IDENT, { HOME: home });
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// CI runners have no git identity, and the fixtures commit; name one for every git these tests start.
for (const [k, v] of Object.entries({
  GIT_AUTHOR_NAME: "Spark Lens Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Spark Lens Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
})) {
  process.env[k] ??= v;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
  home: string;
  origin: string;
  dir: string;
  other: string;
}

/** A bare origin with one commit, the recipe checkout, and a second clone for pushing. */
function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "sl-up-"));
  const origin = join(home, "origin.git");
  const seed = join(home, "seed");
  const dir = join(home, "recipe");
  const other = join(home, "other");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  git(home, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-B", "main");
  writeFileSync(join(seed, "README"), "one\n");
  writeFileSync(join(seed, ".env.example"), "HEAD_IP=\nOLD_KNOB=\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "push", "-q", "origin", "main");
  git(home, "clone", "-q", "-b", "main", origin, dir);
  git(home, "clone", "-q", "-b", "main", origin, other);
  return { home, origin, dir, other };
}

function pushTwo(f: Fixture): void {
  writeFileSync(join(f.other, ".env.example"), "HEAD_IP=\nOLD_KNOB=\n# COMMENTED=1\nNEW_KNOB=1\n");
  git(f.other, "commit", "-q", "-am", "add NEW_KNOB");
  writeFileSync(join(f.other, "README"), "two\n");
  git(f.other, "commit", "-q", "-am", "second change");
  git(f.other, "push", "-q", "origin", "main");
}

function manager(f: Fixture, extra: { start?: string; stop?: string } = {}): RecipeManager {
  return new RecipeManager(
    [{ id: "r", label: "R", host: "local", dir: f.dir, start: extra.start ?? "true", stop: extra.stop ?? "true", llm: "m" }],
    [{ id: "local", label: "Local", kind: "server", local: true }],
    join(f.home, "ctl"),
  );
}

const llm = (state: LlmSnapshot["state"]): LlmSnapshot => ({ id: "m", state }) as LlmSnapshot;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a fresh clone is current", async () => {
  const f = fixture();
  await withEnv(f.home, async () => {
    const s = await manager(f).checkUpstream("r");
    assert.equal(s?.state, "current");
    assert.equal(s?.behind, 0);
    assert.equal(s?.ahead, 0);
    assert.equal(s?.head, git(f.dir, "rev-parse", "--short", "HEAD"));
    assert.equal(s?.branch, "origin/main");
    assert.deepEqual(s?.commits, []);
    assert.equal(s?.message, null);
  });
});

test("upstream commits are listed newest first with env keys missing from .env", async () => {
  const f = fixture();
  writeFileSync(join(f.dir, ".env"), "HEAD_IP=10.0.0.1\n# OLD_KNOB=\n");
  pushTwo(f);
  await withEnv(f.home, async () => {
    const s = await manager(f).checkUpstream("r");
    assert.equal(s?.state, "behind");
    assert.equal(s?.behind, 2);
    assert.deepEqual(s?.commits.map((c) => c.subject), ["second change", "add NEW_KNOB"]);
    assert.ok(s?.commits.every((c) => c.date !== null));
    // HEAD_IP is set and OLD_KNOB is commented out in .env; both count as known.
    assert.deepEqual(s?.newEnvKeys, ["NEW_KNOB"]);
    assert.equal(s?.latest, git(f.origin, "rev-parse", "--short", "main"));
  });
});

test("editing a tracked file makes the recipe modified and refuses the update", async () => {
  const f = fixture();
  pushTwo(f);
  writeFileSync(join(f.dir, "README"), "local edit\n");
  const before = git(f.dir, "rev-parse", "HEAD");
  await withEnv(f.home, async () => {
    const m = manager(f);
    const s = await m.checkUpstream("r");
    assert.equal(s?.state, "modified");
    assert.equal(s?.dirtyFiles, 1);
    const res = await m.updateRecipe("r");
    assert.equal(res.ok, false);
    assert.equal(git(f.dir, "rev-parse", "HEAD"), before);
    assert.equal(m.snapshots()[0]?.canUpdate, false);
  });
});

test("updating a stopped recipe only pulls", async () => {
  const f = fixture();
  pushTwo(f);
  const marks = join(f.home, "marks");
  await withEnv(f.home, async () => {
    const m = manager(f, { start: `echo start >> ${marks}`, stop: `echo stop >> ${marks}` });
    await m.update([llm("down")]);
    await m.checkUpstream("r");
    assert.equal(m.snapshots()[0]?.canUpdate, true);
    const res = await m.updateRecipe("r");
    assert.equal(res.ok, true, res.message);
    assert.equal(git(f.dir, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "main"));
    const snap = m.snapshots()[0]!;
    assert.equal(snap.upstream?.state, "current");
    assert.equal(snap.canUpdate, false);
    assert.equal(snap.status, "stopped");
    await sleep(300);
    assert.equal(existsSync(marks), false, "neither start nor stop may run");
    // A second call has nothing to do.
    assert.equal((await m.updateRecipe("r")).message, "すでに最新です");
  });
});

test("updating a running recipe stops, pulls, then starts, passing through updating", async () => {
  const f = fixture();
  pushTwo(f);
  const old = git(f.dir, "rev-parse", "--short", "HEAD");
  const marks = join(f.home, "marks");
  const rec = (name: string) => `echo "${name} $(git rev-parse --short HEAD)" >> ${marks}`;
  await withEnv(f.home, async () => {
    const m = manager(f, { start: rec("start"), stop: `sleep 0.5; ${rec("stop")}` });
    await m.update([llm("up")]);
    await m.checkUpstream("r");
    const seen = new Set<string>();
    const done = m.updateRecipe("r");
    // The dashboard tick notices the model going down while the stop command runs.
    const tick = sleep(250).then(() => m.update([llm("down")]));
    while (!seen.has("done")) {
      seen.add(m.snapshots()[0]!.status);
      if (seen.has("updating")) break;
      await sleep(20);
    }
    const res = await done;
    await tick;
    assert.equal(res.ok, true, res.message);
    assert.ok(seen.has("updating"));
    for (let i = 0; i < 50 && !(existsSync(marks) && readFileSync(marks, "utf8").includes("start")); i++) await sleep(100);
    const newHead = git(f.origin, "rev-parse", "--short", "main");
    assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), [`stop ${old}`, `start ${newHead}`]);
    assert.equal(git(f.dir, "rev-parse", "--short", "HEAD"), newHead);
  });
});

// Known implementation bug: start() is called right after the pull while the
// last tick still says the model is "up", so canStart is false and the restart is refused.
test("updating a running recipe restarts even if no tick has seen the model go down", async () => {
  const f = fixture();
  pushTwo(f);
  const marks = join(f.home, "marks2");
  await withEnv(f.home, async () => {
    const m = manager(f, { start: `echo start >> ${marks}`, stop: "true" });
    await m.update([llm("up")]);
    const res = await m.updateRecipe("r");
    assert.equal(res.ok, true, res.message);
  });
});

test("a non-repository is an error and a clone without upstream is untracked", async () => {
  const f = fixture();
  const plain = join(f.home, "plain");
  mkdirSync(plain);
  const lonely = join(f.home, "lonely");
  git(f.home, "clone", "-q", "-b", "main", f.origin, lonely);
  git(lonely, "checkout", "-q", "-b", "side");
  await withEnv(f.home, async () => {
    const run = async (dir: string) =>
      new RecipeManager(
        [{ id: "r", label: "R", host: "local", dir, start: "true", stop: "true" }],
        [{ id: "local", label: "Local", kind: "server", local: true }],
        join(f.home, "ctl"),
      ).checkUpstream("r");
    const bad = await run(plain);
    assert.equal(bad?.state, "error");
    assert.ok(bad?.message);
    const missing = await run(join(f.home, "nope"));
    assert.equal(missing?.state, "error");
    const un = await run(lonely);
    assert.equal(un?.state, "untracked");
    assert.equal(un?.branch, null);
  });
});

test("checkScript reports a missing directory as @@error", async () => {
  const { run } = await import("../exec.ts");
  const out = await run("bash", ["-s"], { input: checkScript("/nonexistent/sl-dir"), timeoutMs: 5000 });
  assert.match(out.stdout, /^@@error /);
});

test("parseCheck treats truncated output as an error", () => {
  const s = parseCheck("@@head abc1234 2026-01-01T00:00:00+00:00\n@@upstream abc1234 2026-01-01T00:00:00+00:00 origin/main\n@@behind 1\n");
  assert.equal(s.state, "error");
  assert.ok(s.message);
  assert.equal(parseCheck("").state, "error");
});

test("parseCheck keeps parsing after @@fetch-error but sets a message", () => {
  const text = [
    "@@fetch-error fatal: unable to access",
    "@@head abc1234 2026-01-01T00:00:00+00:00",
    "@@upstream def5678 2026-01-02T00:00:00+00:00 origin/main",
    "@@behind 1",
    "@@ahead 0",
    "@@dirty 0",
    "@@log",
    "def5678|2026-01-02T00:00:00+00:00|fix: a | b",
    "@@envkeys",
    "NEW_KNOB",
    "@@end",
    "",
  ].join("\n");
  const s = parseCheck(text, 123);
  assert.equal(s.state, "behind");
  assert.equal(s.behind, 1);
  assert.equal(s.head, "abc1234");
  assert.equal(s.branch, "origin/main");
  assert.equal(s.checkedAt, 123);
  assert.deepEqual(s.commits.map((c) => c.subject), ["fix: a | b"]);
  assert.deepEqual(s.newEnvKeys, ["NEW_KNOB"]);
  assert.match(s.message ?? "", /fatal: unable to access/);
  assert.equal(parseCheck("@@error boom\n").message, "boom");
});

test("repoFromRemote names GitHub remotes and ignores others", async () => {
  const { repoFromRemote } = await import("../upstream.ts");
  assert.deepEqual(repoFromRemote("https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks.git"), {
    repo: "MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks",
    repoUrl: "https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks",
  });
  assert.equal(repoFromRemote("git@github.com:owner/repo.git").repo, "owner/repo");
  assert.deepEqual(repoFromRemote("/srv/git/local.git"), { repo: null, repoUrl: null });
});

test("two update clicks at once run one stop and one pull; a stop during the update is refused", async () => {
  const f = fixture();
  pushTwo(f);
  const marks = join(f.home, "marks");
  await withEnv(f.home, async () => {
    const m = manager(f, { start: `echo start >> ${marks}`, stop: `sleep 0.3; echo stop >> ${marks}` });
    await m.update([llm("up")]);
    const [first, second] = await Promise.all([m.updateRecipe("r"), m.updateRecipe("r"), m.stop("r").then((s) => assert.equal(s.ok, false))]);
    assert.equal(first.ok, true, first.message);
    assert.equal(second.ok, false);
    for (let i = 0; i < 50 && !(existsSync(marks) && readFileSync(marks, "utf8").includes("start")); i++) await sleep(100);
    assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["stop", "start"]);
    // The lock is released afterwards: a stop now goes through.
    assert.equal((await m.stop("r")).ok, true);
  });
});

test("a stale 'still running' reading during the pull does not cancel the restart", async () => {
  const f = fixture();
  pushTwo(f);
  const marks = join(f.home, "marks");
  await withEnv(f.home, async () => {
    const m = manager(f, { start: `echo start >> ${marks}`, stop: `echo stop >> ${marks}` });
    await m.update([llm("up")]);
    const done = m.updateRecipe("r");
    // Polls keep arriving with the old container still listed while git pulls.
    const poll = setInterval(() => void m.update([llm("starting")]), 10);
    const res = await done;
    clearInterval(poll);
    assert.equal(res.ok, true, res.message);
    for (let i = 0; i < 50 && !(existsSync(marks) && readFileSync(marks, "utf8").includes("start")); i++) await sleep(100);
    assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["stop", "start"]);
  });
});

test("a diverged checkout is refused before the model is stopped", async () => {
  const f = fixture();
  pushTwo(f);
  writeFileSync(join(f.dir, "LOCAL"), "mine\n");
  git(f.dir, "add", "LOCAL");
  git(f.dir, "commit", "-q", "-m", "local commit");
  const marks = join(f.home, "marks");
  await withEnv(f.home, async () => {
    const m = manager(f, { start: `echo start >> ${marks}`, stop: `echo stop >> ${marks}` });
    await m.update([llm("up")]);
    const s = await m.checkUpstream("r");
    assert.equal(s?.ahead, 1);
    assert.equal(m.snapshots()[0]?.canUpdate, false);
    const res = await m.updateRecipe("r");
    assert.equal(res.ok, false);
    assert.equal(existsSync(marks), false, "nothing may be stopped");
  });
});

test("a failed pull brings the previous version back up", async () => {
  const f = fixture();
  writeFileSync(join(f.other, "NEW"), "upstream\n");
  git(f.other, "add", "NEW");
  git(f.other, "commit", "-q", "-m", "add NEW");
  git(f.other, "push", "-q", "origin", "main");
  // An untracked file in the way makes the fast-forward fail.
  writeFileSync(join(f.dir, "NEW"), "local\n");
  const old = git(f.dir, "rev-parse", "--short", "HEAD");
  const marks = join(f.home, "marks");
  const rec = (name: string) => `echo "${name} $(git rev-parse --short HEAD)" >> ${marks}`;
  await withEnv(f.home, async () => {
    const m = manager(f, { start: rec("start"), stop: rec("stop") });
    await m.update([llm("up")]);
    const res = await m.updateRecipe("r");
    assert.equal(res.ok, false);
    assert.match(res.message, /元の版で起動し直しています/);
    for (let i = 0; i < 50 && !(existsSync(marks) && readFileSync(marks, "utf8").includes("start")); i++) await sleep(100);
    assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), [`stop ${old}`, `start ${old}`]);
  });
});
