import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanLog, RecipeManager, shDir, shq } from "../recipes.ts";
import type { LlmSnapshot } from "../types.ts";

test("shell quoting survives quotes and expands only a leading ~", async () => {
  const { run } = await import("../exec.ts");
  const tricky = `it's "here" $HOME; rm -rf /`;
  const out = await run("bash", ["-c", `printf %s ${shq(tricky)}`], { timeoutMs: 5000 });
  assert.equal(out.stdout, tricky);
  assert.equal(shDir("~/a b/c'd"), `"$HOME"/'a b/c'\\''d'`);
  assert.equal(shDir("/opt/x"), "'/opt/x'");
});

test("cleanLog drops colour codes and keeps the last redraw of a progress line", () => {
  assert.equal(cleanLog("\x1b[1;36m[x]\x1b[0m ok\n10%\r50%\r100%\n"), "[x] ok\n100%\n");
  const bars = "Loading: 10% | 1G\nLoading: 55% | 9G\nLoading: 90% | 15G\nother 5% line\ndone\n";
  assert.equal(cleanLog(bars), "Loading: 90% | 15G\nother 5% line\ndone\n");
});

function llm(state: LlmSnapshot["state"]): LlmSnapshot {
  return { id: "m", state } as LlmSnapshot;
}

test("a recipe starts detached, finishes, stops, blocks its group and shows logs", async () => {
  const home = mkdtempSync(join(tmpdir(), "sl-recipe-"));
  const work = join(home, "work");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(work);
  writeFileSync(join(work, "start.sh"), "echo starting; echo done\n");
  writeFileSync(join(work, "stop.sh"), "echo stopped; exit 0\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const m = new RecipeManager(
      [
        { id: "a", label: "A", host: "local", dir: work, start: "bash start.sh", stop: "bash stop.sh", logs: "echo server-log", llm: "m", group: "g" },
        { id: "b", label: "B", host: "local", dir: work, start: "true", stop: "true", group: "g" },
      ],
      [{ id: "local", label: "Local", kind: "server", local: true }],
      join(home, "ctl"),
    );
    await m.update([llm("down")]);
    assert.equal(m.snapshots()[0]?.canStart, true);

    const started = await m.start("a");
    assert.equal(started.ok, true);
    // While A is starting, B shares its machines and must wait.
    const b = m.snapshots()[1]!;
    assert.equal(b.canStart, false);
    assert.equal(b.blockedBy, "A");
    assert.equal((await m.start("b")).ok, false);

    // Let the launcher finish, then notice it.
    for (let i = 0; i < 40 && m.snapshots()[0]?.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await m.update([llm("down")]);
    }
    assert.equal(m.snapshots()[0]?.lastAction?.ok, true);

    const launcher = await m.logs("a", "launcher");
    assert.match(launcher.text, /starting\ndone/);
    assert.match(launcher.text, /=== spark-lens: exit 0/);
    assert.equal((await m.logs("a", "server")).text.trim(), "server-log");
    assert.equal((await m.logs("b", "server")).ok, false);

    await m.update([llm("up")]);
    assert.equal(m.snapshots()[0]?.status, "running");
    assert.equal(m.snapshots()[0]?.canStart, false);
    const stopped = await m.stop("a");
    assert.equal(stopped.ok, true);
    assert.match((await m.logs("a", "launcher")).text, /stopped/);
    assert.equal((await m.start("nope")).ok, false);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("a failing launcher is reported as failed", async () => {
  const home = mkdtempSync(join(tmpdir(), "sl-recipe-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const m = new RecipeManager(
      [{ id: "x", label: "X", host: "local", dir: home, start: "echo boom; exit 3", stop: "true", llm: "m" }],
      [{ id: "local", label: "Local", kind: "server", local: true }],
      join(home, "ctl"),
    );
    await m.start("x");
    for (let i = 0; i < 40 && m.snapshots()[0]?.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await m.update([llm("down")]);
    }
    const s = m.snapshots()[0]!;
    assert.equal(s.status, "failed");
    assert.match(s.lastAction?.message ?? "", /終了コード 3/);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("switching stops the recipe holding the machines, then starts the requested one", async () => {
  const home = mkdtempSync(join(tmpdir(), "sl-recipe-"));
  const marks = join(home, "marks");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const m = new RecipeManager(
      [
        { id: "a", label: "A", host: "local", dir: home, start: `echo start-a >> ${marks}`, stop: `echo stop-a >> ${marks}`, llm: "ma", group: "g" },
        { id: "b", label: "B", host: "local", dir: home, start: `echo start-b >> ${marks}`, stop: `echo stop-b >> ${marks}`, llm: "mb", group: "g" },
      ],
      [{ id: "local", label: "Local", kind: "server", local: true }],
      join(home, "ctl"),
    );
    await m.update([{ id: "ma", state: "up" } as LlmSnapshot, { id: "mb", state: "down" } as LlmSnapshot]);
    assert.equal(m.snapshots()[1]?.blockedBy, "A");
    const res = await m.switchTo("b");
    assert.equal(res.ok, true);
    for (let i = 0; i < 40; i++) {
      const { readFileSync, existsSync } = await import("node:fs");
      if (existsSync(marks) && readFileSync(marks, "utf8").includes("start-b")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const { readFileSync } = await import("node:fs");
    assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["stop-a", "start-b"]);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("a restarted dashboard adopts a launcher that is still preparing and keeps its machines held", async () => {
  const home = mkdtempSync(join(tmpdir(), "sl-recover-"));
  const work = join(home, "work");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(work);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const recipes = [
    { id: "a", label: "A", host: "local", dir: work, start: "sleep 3", stop: "true", llm: "m", group: "g" },
    { id: "b", label: "B", host: "local", dir: work, start: "true", stop: "true", group: "g" },
  ];
  const hosts = [{ id: "local", label: "Local", kind: "server" as const, local: true }];
  try {
    const first = new RecipeManager(recipes, hosts, join(home, "ctl"));
    await first.update([llm("down")]);
    assert.equal((await first.start("a")).ok, true);

    // No container or API yet: only the launcher is alive.
    const second = new RecipeManager(recipes, hosts, join(home, "ctl"));
    await second.update([llm("down")]);
    const [a, b] = second.snapshots();
    assert.equal(a?.status, "starting");
    assert.equal(a?.canStart, false);
    assert.equal(b?.blockedBy, "A");
    assert.equal((await second.start("b")).ok, false);
    assert.equal((await second.start("a")).ok, false);

    // Once the launcher exits, the adopted start finishes like any other.
    for (let i = 0; i < 60 && second.snapshots()[0]?.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await second.update([llm("down")]);
    }
    assert.notEqual(second.snapshots()[0]?.status, "starting");
    assert.equal(second.snapshots()[1]?.canStart, true);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("a failed SSH check keeps a starting launcher holding its machines", async () => {
  const home = mkdtempSync(join(tmpdir(), "sl-ssh-"));
  const work = join(home, "work");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(work);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const m = new RecipeManager(
      [
        { id: "a", label: "A", host: "local", dir: work, start: "sleep 2", stop: "true", llm: "m", group: "g" },
        { id: "b", label: "B", host: "local", dir: work, start: "true", stop: "true", group: "g" },
      ],
      [{ id: "local", label: "Local", kind: "server", local: true }],
      join(home, "ctl"),
    );
    await m.update([llm("down")]);
    assert.equal((await m.start("a")).ok, true);
    // Simulate Tailscale SSH dropping the connection: exit 255, no output.
    const target = m as unknown as { exec: (...args: unknown[]) => Promise<unknown> };
    const real = target.exec.bind(m);
    target.exec = async () => ({ code: 255, stdout: "", stderr: "", timedOut: false });
    for (let i = 0; i < 3; i++) await m.update([llm("down")]);
    assert.equal(m.snapshots()[0]?.status, "starting");
    assert.equal(m.snapshots()[1]?.canStart, false);
    // Back online, the launcher's real end is noticed.
    target.exec = real;
    for (let i = 0; i < 50 && m.snapshots()[0]?.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await m.update([llm("down")]);
    }
    assert.equal(m.snapshots()[1]?.canStart, true);
  } finally {
    process.env.HOME = oldHome;
  }
});
