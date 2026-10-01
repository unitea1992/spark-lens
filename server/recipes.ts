import { join } from "node:path";
import { run } from "./exec.ts";
import type { HostConfig, LlmSnapshot, RecipeConfig, RecipeSnapshot } from "./types.ts";

// Starting, stopping and reading the logs of model "recipes" — upstream
// launchers such as start.sh, run unchanged on the machine they belong to.
//
// A start runs detached on the target host (nohup + setsid) with its output
// in ~/.local/state/spark-lens/recipe-<id>.log there, so it survives this
// dashboard restarting and can be followed from the log viewer.

const LOG_DIR = "$HOME/.local/state/spark-lens";
const LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;

/** Single-quote a string for bash. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A directory for `cd`, with a leading ~ expanded by the remote shell. */
export function shDir(dir: string): string {
  if (dir === "~") return '"$HOME"';
  if (dir.startsWith("~/")) return `"$HOME"/${shq(dir.slice(2))}`;
  return shq(dir);
}

function logPath(id: string): string {
  return `${LOG_DIR}/recipe-${id}.log`;
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
  kind: "start" | "stop";
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
  private llms: LlmSnapshot[] = [];

  constructor(recipes: RecipeConfig[], hosts: HostConfig[], controlDir: string) {
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

  private busy(r: RecipeConfig): boolean {
    const a = this.actions.get(r.id);
    if (a && a.finishedAt === null) return true;
    const s = this.llmState(r);
    return s === "up" || s === "starting";
  }

  /** Another recipe that holds the same machines. */
  private blocker(r: RecipeConfig): RecipeConfig | null {
    const group = r.group ?? r.host;
    return this.recipes.find((o) => o.id !== r.id && (o.group ?? o.host) === group && this.busy(o)) ?? null;
  }

  snapshots(): RecipeSnapshot[] {
    return this.recipes.map((r) => {
      const a = this.actions.get(r.id) ?? null;
      const llm = this.llmState(r);
      const inFlight = a !== null && a.finishedAt === null;
      let status: RecipeSnapshot["status"];
      if (inFlight) status = a!.kind === "start" ? "starting" : "stopping";
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
        llm: r.llm ?? null,
        status,
        canStart: !inFlight && status !== "running" && status !== "starting" && blocker === null,
        canStop: !inFlight && status !== "stopped",
        hasServerLog: Boolean(r.logs),
        blockedBy: blocker?.label ?? null,
        lastAction: a ? { kind: a.kind, startedAt: a.startedAt, finishedAt: a.finishedAt, ok: a.ok, message: a.message } : null,
      };
    });
  }

  /** Called every tick with fresh LLM states; also notices launchers that finished. */
  async update(llms: LlmSnapshot[]): Promise<void> {
    this.llms = llms;
    await Promise.all(
      this.recipes.map(async (r) => {
        const a = this.actions.get(r.id);
        if (!a || a.finishedAt !== null || a.kind !== "start") return;
        // The model answering is success, even while the launcher still warms up.
        if (this.llmState(r) === "up") {
          Object.assign(a, { finishedAt: Date.now(), ok: true, message: "起動しました" });
          return;
        }
        const host = this.hosts.get(r.host)!;
        const res = await this.exec(host, `tail -n 3 "${logPath(r.id)}" 2>/dev/null; kill -0 ${a.pid ?? 0} 2>/dev/null && echo ALIVE`, 10_000);
        if (res.code === null || res.timedOut) return;
        if (res.stdout.includes("ALIVE")) return;
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
    const snap = this.snapshots().find((s) => s.id === id)!;
    if (!snap.canStart) {
      return { ok: false, message: snap.blockedBy ? `${snap.blockedBy} が動いているため起動できません` : "すでに動いているか、操作中です" };
    }
    const action: Action = { kind: "start", startedAt: Date.now(), finishedAt: null, ok: null, message: "起動しています", pid: null };
    this.actions.set(id, action);
    const res = await this.exec(this.hosts.get(r.host)!, startScript(r), 30_000);
    const pid = Number(res.stdout.trim().split("\n").pop());
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
    const current = this.actions.get(id);
    if (current && current.finishedAt === null && current.kind === "stop") return { ok: false, message: "停止処理中です" };
    // Stopping also abandons an in-flight start: the launcher's own stop handles both.
    const launcher = current && current.finishedAt === null && current.kind === "start" ? current.pid : null;
    const action: Action = { kind: "stop", startedAt: Date.now(), finishedAt: null, ok: null, message: "停止しています", pid: null };
    this.actions.set(id, action);
    const res = await this.exec(this.hosts.get(r.host)!, stopScript(r, launcher), 300_000);
    const ok = res.code === 0 && !res.timedOut;
    Object.assign(action, {
      finishedAt: Date.now(),
      ok,
      message: ok ? "停止しました" : res.timedOut ? "停止処理がタイムアウトしました" : `停止に失敗しました（終了コード ${res.code}）`,
    });
    return { ok, message: action.message! };
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
