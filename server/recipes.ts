import { join } from "node:path";
import { run } from "./exec.ts";
import { shDir, shq } from "./recipes-shell.ts";
import { checkScript, parseCheck, pullScript } from "./upstream.ts";
import { parseMemoryPlan, parseProgress, startedAt, type MemoryPlan, type StartProgress } from "./progress.ts";
import type { HostConfig, LlmSnapshot, RecipeConfig, RecipeSnapshot, UpstreamStatus } from "./types.ts";

// Starting, stopping and reading the logs of model "recipes" — upstream
// launchers such as start.sh, run unchanged on the machine they belong to.
//
// A start runs detached on the target host (nohup + setsid) with its output
// in ~/.local/state/spark-lens/recipe-<id>.log there, so it survives this
// dashboard restarting and can be followed from the log viewer.

const LOG_DIR = "$HOME/.local/state/spark-lens";
const LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;

export { shDir, shq } from "./recipes-shell.ts";

function logPath(id: string): string {
  return `${LOG_DIR}/recipe-${id}.log`;
}

function pidPath(id: string): string {
  return `${LOG_DIR}/recipe-${id}.pid`;
}

export function startScript(r: RecipeConfig): string {
  const log = logPath(r.id);
  // The exit marker lets the dashboard tell a finished launcher from a failed one.
  // A subshell, so an `exit` inside the command cannot skip the marker.
  const body = `cd ${shDir(r.dir)} && ( ${r.start}
 ); echo "=== spark-lens: exit $?" >> "${log}"`;
  return [
    "set -e",
    `mkdir -p "${LOG_DIR}"`,
    `echo "=== spark-lens: start $(date '+%F %T')" > "${log}"`,
    `nohup setsid bash -c ${shq(body)} >> "${log}" 2>&1 < /dev/null &`,
    // Kept on the host, so a restarted dashboard can find a launcher still preparing.
    `echo $! > "${pidPath(r.id)}"`,
    "echo $!",
  ].join("\n");
}

export function stopScript(r: RecipeConfig, launcherPid: number | null = null): string {
  const log = logPath(r.id);
  return [
    // A launcher still running holds its own lock and would refuse the stop.
    launcherPid ? `kill -TERM -- -${launcherPid} 2>/dev/null && sleep 2` : ":",
    `mkdir -p "${LOG_DIR}"`,
    `echo "=== spark-lens: stop $(date '+%F %T')" >> "${log}"`,
    `cd ${shDir(r.dir)} && ( ${r.stop}
 ) 2>&1 | tee -a "${log}"`,
    "exit ${PIPESTATUS[0]}",
  ].join("\n");
}

/** Terminal output to plain lines: colour codes dropped, progress-bar redraws collapsed. */
export function cleanLog(text: string): string {
  const lines = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((p) => p.trim() !== "");
      return parts[parts.length - 1] ?? "";
    });
  // Progress bars piped through a log arrive one update per line; keep only
  // the latest of a run that shares the text before its percentage.
  const out: string[] = [];
  const key = (line: string) => /^(.*?)\d+(?:\.\d+)?%/.exec(line)?.[1] ?? null;
  for (const line of lines) {
    const k = key(line);
    if (k !== null && k.trim() !== "" && out.length > 0 && key(out[out.length - 1]!) === k) out[out.length - 1] = line;
    else out.push(line);
  }
  return out.join("\n");
}

interface Action {
  kind: "start" | "stop" | "update";
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  message: string | null;
  pid: number | null;
}

export class RecipeManager {
  private readonly recipes: RecipeConfig[];
  private readonly hosts: Map<string, HostConfig>;
  private readonly controlDir: string;
  private readonly actions = new Map<string, Action>();
  /** Machine groups with an operation in progress (start, stop, switch, update). */
  private readonly locks = new Set<string>();
  private readonly upstream = new Map<string, UpstreamStatus>();
  private readonly memory = new Map<string, MemoryPlan & { readAt: number }>();
  private readonly progress = new Map<string, StartProgress & { startedAt: number | null }>();
  private readonly durations: { get(id: string): number | null; set(id: string, sec: number): void } | null;
  private llms: LlmSnapshot[] = [];
  /** Recipes whose host has been asked, since this dashboard started, for a launcher still running. */
  private readonly recovered = new Set<string>();

  constructor(
    recipes: RecipeConfig[],
    hosts: HostConfig[],
    controlDir: string,
    durations: { get(id: string): number | null; set(id: string, sec: number): void } | null = null,
  ) {
    this.durations = durations;
    this.recipes = recipes;
    this.hosts = new Map(hosts.map((h) => [h.id, h]));
    this.controlDir = controlDir;
  }

  private exec(host: HostConfig, script: string, timeoutMs: number) {
    if (host.local) return run("bash", ["-s"], { input: script, timeoutMs });
    return run(
      "ssh",
      [
        "-T",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        "-o", "ControlMaster=auto",
        "-o", `ControlPath=${join(this.controlDir, "ssh-%C")}`,
        "-o", "ControlPersist=120",
        "--",
        host.ssh!,
        "bash -s",
      ],
      { input: script, timeoutMs },
    );
  }

  private llmState(r: RecipeConfig): LlmSnapshot["state"] | null {
    return r.llm ? (this.llms.find((l) => l.id === r.llm)?.state ?? null) : null;
  }

  private group(r: RecipeConfig): string {
    return r.group ?? r.host;
  }

  /**
   * Run one operation per machine group at a time. The lock is taken before
   * the first await, so two clicks cannot both pass the checks and then both
   * stop, pull or start.
   */
  private async locked(r: RecipeConfig, run: () => Promise<{ ok: boolean; message: string }>): Promise<{ ok: boolean; message: string }> {
    const group = this.group(r);
    if (this.locks.has(group)) return { ok: false, message: "ほかの操作が進行中です。終わってからもう一度試してください" };
    this.locks.add(group);
    try {
      await this.recover();
      return await run();
    } finally {
      this.locks.delete(group);
    }
  }

  private busy(r: RecipeConfig): boolean {
    const a = this.actions.get(r.id);
    if (a && a.finishedAt === null) return true;
    const s = this.llmState(r);
    return s === "up" || s === "starting";
  }

  /** Not yet confirmed, since this dashboard started, to have no launcher running. */
  private unconfirmed(r: RecipeConfig): boolean {
    return !this.recovered.has(r.id);
  }

  /**
   * Another recipe that holds the same machines. One whose host could not be
   * asked yet counts as holding them: an unreachable host proves nothing.
   */
  private blocker(r: RecipeConfig): RecipeConfig | null {
    const group = this.group(r);
    return this.recipes.find((o) => o.id !== r.id && this.group(o) === group && (this.busy(o) || this.unconfirmed(o))) ?? null;
  }

  snapshots(): RecipeSnapshot[] {
    return this.recipes.map((r) => {
      const a = this.actions.get(r.id) ?? null;
      const llm = this.llmState(r);
      const inFlight = a !== null && a.finishedAt === null;
      let status: RecipeSnapshot["status"];
      if (inFlight) status = a!.kind === "start" ? "starting" : a!.kind === "update" ? "updating" : "stopping";
      else if (llm === "up") status = "running";
      else if (llm === "starting") status = "starting";
      else if (a?.kind === "start" && a.ok === false) status = "failed";
      else status = "stopped";
      const blocker = this.blocker(r);
      return {
        id: r.id,
        label: r.label,
        host: r.host,
        hostLabel: this.hosts.get(r.host)?.label ?? r.host,
        hostLabels: [...new Set([r.host, ...((r.llm && this.llms.find((l) => l.id === r.llm)?.nodes) || [])])].map(
          (h) => this.hosts.get(h)?.label ?? h,
        ),
        llm: r.llm ?? null,
        status,
        canStart: !inFlight && status !== "running" && status !== "starting" && blocker === null && !this.unconfirmed(r),
        canStop: !inFlight && status !== "stopped",
        hasServerLog: Boolean(r.logs),
        blockedBy: blocker?.label ?? null,
        upstream: this.upstream.get(r.id) ?? null,
        memory: status === "running" ? (this.memory.get(r.id) ?? null) : null,
        progress: (() => {
          if (status !== "starting") return null;
          const p = this.progress.get(r.id);
          const own = a?.kind === "start" && a.finishedAt === null ? a.startedAt : null;
          const since = own ?? p?.startedAt ?? null;
          if (since === null) return null;
          return {
            pct: p?.pct ?? 3,
            stage: p?.stage ?? "準備しています",
            startedAt: since,
            expectedSec: this.durations?.get(r.id) ?? null,
          };
        })(),
        canUpdate: !inFlight && this.upstream.get(r.id)?.state === "behind" && this.upstream.get(r.id)?.ahead === 0,
        lastAction: a ? { kind: a.kind, startedAt: a.startedAt, finishedAt: a.finishedAt, ok: a.ok, message: a.message } : null,
      };
    });
  }

  /** Read what the running model reserved, once per start (retried a minute later if missing). */
  private async readMemory(r: RecipeConfig): Promise<void> {
    if (this.llmState(r) !== "up") {
      this.memory.delete(r.id);
      return;
    }
    const known = this.memory.get(r.id);
    if (known && (known.weightsGiB !== null || Date.now() - known.readAt < 60_000)) return;
    const res = await this.exec(
      this.hosts.get(r.host)!,
      `grep -aoE "Model loading took [0-9.]+ ?GiB|Available KV cache memory: [0-9.]+ ?GiB|kv-cache-memory-bytes[ =][0-9]+|Load weight end\\.[^\\r]*mem usage=[0-9.]+ ?GB|KV Cache is allocated\\.[^\\r]*V size: [0-9.]+ ?GB" "${logPath(r.id)}" 2>/dev/null | tail -n 5`,
      10_000,
    );
    if (res.code === null || res.timedOut) return;
    this.memory.set(r.id, { ...parseMemoryPlan(res.stdout), readAt: Date.now() });
  }

  /**
   * After a dashboard restart, adopt launchers that are still running (for
   * example still downloading, with no container or API yet), so their
   * machines stay held and a second start is refused. Runs once.
   */
  private async recover(): Promise<void> {
    await Promise.all(
      this.recipes.map(async (r) => {
        if (this.recovered.has(r.id)) return;
        if (this.actions.has(r.id)) {
          this.recovered.add(r.id);
          return;
        }
        const pidFile = pidPath(r.id);
        const res = await this.exec(
          this.hosts.get(r.host)!,
          // The command line check guards against a recycled pid.
          `p=$(cat "${pidFile}" 2>/dev/null) && kill -0 "$p" 2>/dev/null && ps -o args= -p "$p" | grep -q "spark-lens: exit" && echo "$p"; head -n 1 "${logPath(r.id)}" 2>/dev/null; echo "@@checked"`,
          10_000,
        );
        // An unreachable host proves nothing; ask again on the next tick.
        if (res.timedOut || !res.stdout.includes("@@checked")) return;
        this.recovered.add(r.id);
        const pid = Number(res.stdout.split("\n")[0]);
        if (!Number.isInteger(pid) || pid <= 0 || this.actions.has(r.id)) return;
        this.actions.set(r.id, {
          kind: "start",
          startedAt: startedAt(cleanLog(res.stdout)) ?? Date.now(),
          finishedAt: null,
          ok: null,
          message: "起動しています",
          pid,
        });
      }),
    );
  }

  /** Called every tick with fresh LLM states; also notices launchers that finished. */
  async update(llms: LlmSnapshot[]): Promise<void> {
    this.llms = llms;
    await this.recover();
    await Promise.all(this.recipes.map((r) => this.readMemory(r)));
    await Promise.all(
      this.recipes.map(async (r) => {
        const a = this.actions.get(r.id);
        if (!a || a.finishedAt !== null || a.kind !== "start") {
          // Started elsewhere, or before this dashboard restarted: follow the log anyway.
          if (this.llmState(r) === "starting") {
            const res = await this.exec(this.hosts.get(r.host)!, `tail -n 400 "${logPath(r.id)}" 2>/dev/null; head -n 1 "${logPath(r.id)}" 2>/dev/null`, 10_000);
            if (res.code === 0) {
              const text = cleanLog(res.stdout);
              this.progress.set(r.id, { ...parseProgress(text), startedAt: startedAt(text) });
            }
          } else {
            this.progress.delete(r.id);
          }
          return;
        }
        // The model answering is success, even while the launcher still warms up.
        if (this.llmState(r) === "up") {
          Object.assign(a, { finishedAt: Date.now(), ok: true, message: "起動しました" });
          this.durations?.set(r.id, (Date.now() - a.startedAt) / 1000);
          this.progress.delete(r.id);
          return;
        }
        const host = this.hosts.get(r.host)!;
        // Without a pid (the start reply was lost), ask the pid file the launcher left.
        const pidExpr = a.pid ?? `$(cat "${pidPath(r.id)}" 2>/dev/null || echo 0)`;
        const res = await this.exec(host, `tail -n 400 "${logPath(r.id)}" 2>/dev/null; p=${pidExpr}; kill -0 "$p" 2>/dev/null && echo "ALIVE $p"; echo "@@checked"`, 10_000);
        // Only a completed check may conclude the launcher is gone; a failed SSH keeps the machines held.
        if (res.timedOut || !res.stdout.includes("@@checked")) return;
        const text = cleanLog(res.stdout);
        this.progress.set(r.id, { ...parseProgress(text), startedAt: null });
        const alive = /^ALIVE (\d+)$/m.exec(res.stdout);
        if (alive) {
          // Learn the pid when the start reply was lost, so a stop can end the launcher too.
          a.pid ??= Number(alive[1]);
          return;
        }
        const exit = /=== spark-lens: exit (\d+)/.exec(res.stdout);
        const code = exit ? Number(exit[1]) : null;
        // A launcher that exits 0 before the API answers is still loading the model;
        // the LLM state takes over from here.
        Object.assign(a, {
          finishedAt: Date.now(),
          ok: code === 0,
          message: code === 0 ? "起動処理が完了しました" : `起動に失敗しました（終了コード ${code ?? "不明"}）。起動ログを確認してください`,
        });
      }),
    );
  }

  async start(id: string): Promise<{ ok: boolean; message: string }> {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, message: "レシピが見つかりません" };
    return this.locked(r, () => this.doStart(r));
  }

  /**
   * `afterOwnStop`: the caller has just stopped this recipe itself, so a
   * monitoring reading taken before that stop must not refuse the restart.
   */
  private async doStart(r: RecipeConfig, afterOwnStop = false): Promise<{ ok: boolean; message: string }> {
    const id = r.id;
    const snap = this.snapshots().find((s) => s.id === id)!;
    if (this.unconfirmed(r)) return { ok: false, message: "前回の起動状態を確認できていません。マシンへの接続を確認してください" };
    if (afterOwnStop ? snap.blockedBy !== null : !snap.canStart) {
      return { ok: false, message: snap.blockedBy ? `${snap.blockedBy} が動いているため起動できません` : "すでに動いているか、操作中です" };
    }
    const action: Action = { kind: "start", startedAt: Date.now(), finishedAt: null, ok: null, message: "起動しています", pid: null };
    this.actions.set(id, action);
    const res = await this.exec(this.hosts.get(r.host)!, startScript(r), 30_000);
    const pid = Number(res.stdout.trim().split("\n").pop());
    // SSH dropped (255) or timed out: the launcher may well be running. Keep
    // the start in flight; the next ticks find it through the pid file.
    if ((!Number.isInteger(pid) || pid <= 0) && (res.timedOut || res.code === 255 || res.code === null)) {
      action.message = "起動を依頼しましたが、応答を受け取れませんでした。状態を確認しています";
      return { ok: true, message: action.message };
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      Object.assign(action, { finishedAt: Date.now(), ok: false, message: "起動コマンドを実行できませんでした" });
      return { ok: false, message: action.message! };
    }
    action.pid = pid;
    return { ok: true, message: "起動を開始しました" };
  }

  async stop(id: string): Promise<{ ok: boolean; message: string }> {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, message: "レシピが見つかりません" };
    return this.locked(r, () => this.doStop(r));
  }

  private async doStop(r: RecipeConfig): Promise<{ ok: boolean; message: string }> {
    const id = r.id;
    const current = this.actions.get(id);
    if (current && current.finishedAt === null && current.kind === "stop") return { ok: false, message: "停止処理中です" };
    // Stopping also abandons an in-flight start: the launcher's own stop handles both.
    const launcher = current && current.finishedAt === null && current.kind === "start" ? current.pid : null;
    const action: Action = { kind: "stop", startedAt: Date.now(), finishedAt: null, ok: null, message: "停止しています", pid: null };
    this.actions.set(id, action);
    const res = await this.exec(this.hosts.get(r.host)!, stopScript(r, launcher), 300_000);
    const ok = res.code === 0 && !res.timedOut;
    if (!ok && current && current.finishedAt === null && current.kind === "start") {
      // The launcher may still be running; keep following it rather than freeing its machines.
      this.actions.set(id, current);
      return { ok: false, message: res.timedOut ? "停止処理がタイムアウトしました" : `停止に失敗しました（終了コード ${res.code}）` };
    }
    Object.assign(action, {
      finishedAt: Date.now(),
      ok,
      message: ok ? "停止しました" : res.timedOut ? "停止処理がタイムアウトしました" : `停止に失敗しました（終了コード ${res.code}）`,
    });
    return { ok, message: action.message! };
  }

  /**
   * Make this recipe the one running on its machines: stop whichever recipe
   * of the same group is running, then start this one.
   */
  async switchTo(id: string): Promise<{ ok: boolean; message: string }> {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, message: "レシピが見つかりません" };
    return this.locked(r, () => this.doSwitch(r));
  }

  private async doSwitch(r: RecipeConfig): Promise<{ ok: boolean; message: string }> {
    const current = this.actions.get(r.id);
    if (current && current.finishedAt === null) return { ok: false, message: "ほかの操作が進行中です" };
    const other = this.blocker(r);
    if (other) {
      const stopped = await this.doStop(other);
      if (!stopped.ok) return { ok: false, message: `${other.label} を停止できませんでした` };
      // Seen as stopped from here on, without waiting for the next poll.
      if (other.llm) this.llms = this.llms.map((l) => (l.id === other.llm ? { ...l, state: "down" } : l));
    }
    const started = await this.doStart(r);
    return started.ok ? { ok: true, message: other ? `${other.label} を停止し、起動しています` : started.message } : started;
  }

  /** Fetch and compare one recipe's checkout with its upstream. */
  async checkUpstream(id: string): Promise<UpstreamStatus | null> {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return null;
    const res = await this.exec(this.hosts.get(r.host)!, checkScript(r.dir), 90_000);
    const fresh = res.timedOut
      ? null
      : parseCheck(res.stdout);
    const previous = this.upstream.get(id);
    // Offline: keep what was known, flagged, rather than claiming "up to date".
    const status: UpstreamStatus =
      fresh === null
        ? { ...(previous ?? parseCheck("")), state: previous?.state ?? "error", message: "確認がタイムアウトしました", checkedAt: Date.now() }
        : fresh.message && previous && fresh.state !== "error"
          ? { ...fresh, commits: fresh.commits.length > 0 ? fresh.commits : previous.commits }
          : fresh;
    this.upstream.set(id, status);
    return status;
  }

  async checkAllUpstreams(): Promise<void> {
    for (const r of this.recipes) await this.checkUpstream(r.id);
  }

  /**
   * Follow upstream: stop if running, fast-forward the checkout, and start
   * again if it was running. Refuses when tracked files were edited, since
   * those would be custom patches the owner wants to avoid.
   */
  async updateRecipe(id: string): Promise<{ ok: boolean; message: string }> {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, message: "レシピが見つかりません" };
    return this.locked(r, () => this.doUpdate(r));
  }

  private async doUpdate(r: RecipeConfig): Promise<{ ok: boolean; message: string }> {
    const id = r.id;
    const current = this.actions.get(id);
    if (current && current.finishedAt === null) return { ok: false, message: "ほかの操作が進行中です" };
    const up = await this.checkUpstream(id);
    if (!up || up.state === "error") return { ok: false, message: up?.message ?? "upstream を確認できませんでした" };
    if (up.state === "modified") return { ok: false, message: "追跡ファイルに手元の変更があるため更新しません" };
    if (up.state !== "behind") return { ok: true, message: "すでに最新です" };
    // Diverged history cannot fast-forward; refuse before stopping anything.
    if (up.ahead > 0) return { ok: false, message: "手元に upstream にないコミットがあるため更新しません" };
    const host = this.hosts.get(r.host)!;
    const wasRunning = this.busy(r);
    const action: Action = { kind: "update", startedAt: Date.now(), finishedAt: null, ok: null, message: "更新しています", pid: null };
    this.actions.set(id, action);
    const fail = (message: string) => {
      Object.assign(action, { finishedAt: Date.now(), ok: false, message });
      return { ok: false, message };
    };
    if (wasRunning) {
      action.message = "更新のため停止しています";
      const stopped = await this.exec(host, stopScript(r), 300_000);
      if (stopped.code !== 0 || stopped.timedOut) return fail("停止できなかったため更新を中止しました");
      // The stop just succeeded; do not wait for the next poll to notice it,
      // or the restart below would be refused as "still running".
      if (r.llm) this.llms = this.llms.map((l) => (l.id === r.llm ? { ...l, state: "down" } : l));
    }
    action.message = "upstream を取り込んでいます";
    const pulled = await this.exec(host, pullScript(r.dir, logPath(r.id)), 180_000);
    if (pulled.code !== 0 || pulled.timedOut) {
      fail("git pull に失敗しました。起動ログを確認してください");
      if (!wasRunning) return { ok: false, message: action.message! };
      // `--ff-only` leaves the checkout as it was, so bring the previous version back up.
      const restarted = await this.doStart(r, true);
      const message = restarted.ok
        ? "git pull に失敗したため、元の版で起動し直しています"
        : `git pull に失敗し、元の版でも起動し直せませんでした（${restarted.message}）`;
      if (this.actions.get(id) === action) action.message = message;
      return { ok: false, message };
    }
    await this.checkUpstream(id);
    Object.assign(action, { finishedAt: Date.now(), ok: true, message: `${up.behind} 件の更新を取り込みました` });
    if (wasRunning) {
      // The update's own stop decides here; the latest poll may still show the old run.
      const started = await this.doStart(r, true);
      if (!started.ok) {
        // A refused restart leaves the update as the last action; say the model stayed stopped.
        const message = `更新は取り込みましたが、起動し直せませんでした（${started.message}）`;
        if (this.actions.get(id) === action) Object.assign(action, { ok: false, message });
        return { ok: false, message };
      }
      return { ok: true, message: `${up.behind} 件の更新を取り込み、起動し直しています` };
    }
    return { ok: true, message: action.message! };
  }

  async logs(id: string, source: "launcher" | "server"): Promise<{ ok: boolean; text: string }> {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, text: "レシピが見つかりません" };
    if (source === "server" && !r.logs) return { ok: false, text: "このレシピにはサーバーログのコマンドが設定されていません" };
    const script =
      source === "launcher"
        ? `tail -n ${LOG_LINES} "${logPath(r.id)}" 2>/dev/null || echo "まだ起動ログはありません"`
        : `cd ${shDir(r.dir)} && ( ${r.logs}
 ) 2>&1 | tail -n ${LOG_LINES}`;
    const res = await this.exec(this.hosts.get(r.host)!, script, 20_000);
    if (res.timedOut) return { ok: false, text: "ログの取得がタイムアウトしました" };
    const text = cleanLog(res.stdout.slice(-MAX_LOG_BYTES));
    return { ok: res.code === 0, text: text || (res.code === 0 ? "（出力なし）" : `取得に失敗しました（終了コード ${res.code}）`) };
  }
}
