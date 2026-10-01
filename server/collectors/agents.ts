import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { run } from "../exec.ts";
import type { AgentProcessRule, AgentSnapshot, AgentStatus, HostConfig, HostProcess } from "../types.ts";

const TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  omp: "Pi",
  gemini: "Gemini CLI",
  grok: "Grok",
};

/** Agent CLIs looked for on remote hosts, where only the process table is visible. */
export const REMOTE_RULES: AgentProcessRule[] = [
  { tool: "claude", label: "Claude Code", match: "(^|/)claude( |$)" },
  { tool: "codex", label: "Codex", match: "(^|/)codex( (exec|resume|--)|$)" },
  { tool: "opencode", label: "OpenCode", match: "(^|/)opencode( (run|mini|-)|$)" },
];

const RECENT_MS = 12 * 3600 * 1000;
/** Finished sessions kept per tool, so a burst of one-shot runs cannot bury the live ones. */
const IDLE_PER_TOOL = 3;
const TITLE_MAX = 90;

/** One POSIX extended regex (evaluated by awk on each host) covering every rule. */
export function procRegex(rules: AgentProcessRule[]): string {
  return [...REMOTE_RULES, ...rules].map((r) => `(${r.match})`).join("|");
}

function clip(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** Start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat), or null. */
async function procStartTicks(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces; fields after it are fixed.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizePath(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

type Partial = Omit<AgentSnapshot, "host" | "hostLabel" | "toolLabel">;

// ------------------------------------------------------------ Claude Code

const CLAUDE_KINDS: Record<string, string> = { bg: "バックグラウンド", background: "バックグラウンド", headless: "非対話" };

const CLAUDE_STATUS: Record<string, AgentStatus> = { busy: "working", idle: "idle", waiting: "waiting" };

export async function claudeSessions(dir = join(homedir(), ".claude", "sessions")): Promise<Partial[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Partial[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const s = JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown>;
      const pid = typeof s.pid === "number" ? s.pid : null;
      // Session files outlive a crashed CLI; only a live pid is a session.
      if (pid === null || !pidAlive(pid)) continue;
      // A reused pid belongs to some other program now.
      if (typeof s.procStart === "string" && process.platform === "linux") {
        const started = await procStartTicks(pid);
        if (started !== null && started !== s.procStart) continue;
      }
      out.push({
        id: `claude:${s.sessionId ?? pid}`,
        tool: "claude",
        title: clip(typeof s.name === "string" ? s.name : null),
        cwd: normalizePath(typeof s.cwd === "string" ? s.cwd : null),
        status: CLAUDE_STATUS[String(s.status)] ?? "unknown",
        pid,
        startedAt: typeof s.startedAt === "number" ? s.startedAt : null,
        lastActivity: typeof s.statusUpdatedAt === "number" ? s.statusUpdatedAt : typeof s.updatedAt === "number" ? s.updatedAt : null,
        cpuPct: null,
        detail: s.kind === "interactive" || s.kind === undefined ? null : (CLAUDE_KINDS[String(s.kind)] ?? clip(String(s.kind))),
      });
    } catch {
      // Half-written or foreign file: skip it.
    }
  }
  return out;
}

// ------------------------------------------------------------------ Codex

const CODEX_TAIL_BYTES = 512 * 1024;
/** A rollout written this recently is treated as busy even if its turn marker scrolled out of the tail. */
const CODEX_FRESH_MS = 30 * 1000;
const CODEX_LIVE_MS = 120 * 1000;

/** Last turn marker in the tail of a Codex rollout file. */
export function codexTurnState(tail: string): "started" | "finished" | null {
  let state: "started" | "finished" | null = null;
  for (const line of tail.split("\n")) {
    if (!line.includes('"event_msg"')) continue;
    const m = /"type"\s*:\s*"(task_started|task_complete|turn_aborted)"/.exec(line);
    if (m) state = m[1] === "task_started" ? "started" : "finished";
  }
  return state;
}

async function readTail(path: string, bytes: number): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    const handle = await open(path, "r");
    try {
      const length = Math.min(bytes, info.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      return { text: buffer.toString("utf8"), mtimeMs: info.mtimeMs };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function codexThreads(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<Partial[]> {
  let dbPath: string | null = null;
  try {
    const version = (n: string) => Number(/^state_(\d+)\.sqlite$/.exec(n)?.[1] ?? -1);
    const candidates = (await readdir(codexHome)).filter((n) => version(n) >= 0).sort((a, b) => version(a) - version(b));
    if (candidates.length > 0) dbPath = join(codexHome, candidates[candidates.length - 1]!);
  } catch {
    return [];
  }
  if (!dbPath) return [];
  let rows: Record<string, unknown>[];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db
        .prepare(
          "select id, cwd, title, updated_at_ms, model, rollout_path from threads " +
            "where archived = 0 and thread_source = 'user' and updated_at_ms > ? order by updated_at_ms desc limit 12",
        )
        .all(Date.now() - RECENT_MS) as Record<string, unknown>[];
    } finally {
      db.close();
    }
  } catch {
    // Schema changed or the database is mid-migration.
    return [];
  }
  const out: Partial[] = [];
  for (const row of rows) {
    const updated = Number(row.updated_at_ms);
    const tail = typeof row.rollout_path === "string" ? await readTail(row.rollout_path, CODEX_TAIL_BYTES) : null;
    const lastWrite = Math.max(updated, tail?.mtimeMs ?? 0);
    // A turn that started but whose log went quiet is a crashed or killed run.
    const turn = tail === null ? null : codexTurnState(tail.text);
    const age = Date.now() - lastWrite;
    const working = (turn === "started" && age < CODEX_LIVE_MS) || (turn === null && tail !== null && age < CODEX_FRESH_MS);
    out.push({
      id: `codex:${row.id}`,
      tool: "codex",
      title: clip(typeof row.title === "string" ? row.title : null),
      cwd: normalizePath(typeof row.cwd === "string" ? row.cwd : null),
      status: working ? "working" : "idle",
      pid: null,
      startedAt: null,
      lastActivity: lastWrite,
      cpuPct: null,
      detail: typeof row.model === "string" ? row.model : null,
    });
  }
  return out;
}

// --------------------------------------------------------------- OpenCode

async function opencodeGet(bin: string, path: string): Promise<unknown> {
  const res = await run(bin, ["api", "GET", path], { timeoutMs: 8000 });
  if (res.code !== 0) return null;
  try {
    return (JSON.parse(res.stdout) as Record<string, unknown>).data ?? null;
  } catch {
    return null;
  }
}

export function parseOpencodeSessions(list: unknown, active: unknown, now = Date.now()): Partial[] {
  if (!Array.isArray(list)) return [];
  const activeIds = new Set(
    Array.isArray(active)
      ? active.map((a) => (typeof a === "string" ? a : String((a as Record<string, unknown>)?.id ?? "")))
      : active && typeof active === "object"
        ? Object.keys(active)
        : [],
  );
  const out: Partial[] = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const id = String(s.id ?? "");
    const time = (s.time ?? {}) as Record<string, unknown>;
    const updated = typeof time.updated === "number" ? time.updated : null;
    const isActive = activeIds.has(id);
    if (time.archived || (!isActive && (updated === null || now - updated > RECENT_MS))) continue;
    const model = (s.model ?? {}) as Record<string, unknown>;
    const location = (s.location ?? {}) as Record<string, unknown>;
    out.push({
      id: `opencode:${id}`,
      tool: "opencode",
      title: clip(typeof s.title === "string" ? s.title : null),
      cwd: normalizePath(typeof location.directory === "string" ? location.directory : null),
      status: isActive ? "working" : "idle",
      pid: null,
      startedAt: typeof time.created === "number" ? time.created : null,
      lastActivity: updated,
      cpuPct: null,
      detail: typeof model.id === "string" ? model.id : null,
    });
  }
  return out;
}

async function opencodeSessions(bin: string): Promise<Partial[]> {
  const active = await opencodeGet(bin, "/api/session/active");
  if (active === null) return [];
  const list = await opencodeGet(bin, "/api/session?limit=12&order=desc&parentID=null");
  return parseOpencodeSessions(list, active);
}

// ------------------------------------------------------------------- Orca

const ORCA_STATE: Record<string, AgentStatus> = {
  working: "working",
  running: "working",
  done: "idle",
  idle: "idle",
  waiting: "waiting",
  blocked: "waiting",
  permission: "waiting",
  "needs-input": "waiting",
};

export function parseOrca(body: unknown): Partial[] {
  const result = (body as Record<string, unknown> | null)?.result as Record<string, unknown> | undefined;
  if (!result || !Array.isArray(result.worktrees)) return [];
  const out: Partial[] = [];
  for (const raw of result.worktrees) {
    const w = raw as Record<string, unknown>;
    if (!Array.isArray(w.agents)) continue;
    for (const rawAgent of w.agents) {
      const a = rawAgent as Record<string, unknown>;
      const tool = typeof a.agentType === "string" && a.agentType ? a.agentType : "agent";
      const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : null);
      out.push({
        id: `orca:${a.paneKey ?? `${w.path}:${tool}`}`,
        tool,
        title: clip(str("taskTitle") ?? str("displayName") ?? str("prompt")),
        cwd: normalizePath(typeof w.path === "string" ? w.path : null),
        status: a.interrupted === true ? "idle" : (ORCA_STATE[String(a.state)] ?? "unknown"),
        pid: null,
        startedAt: null,
        lastActivity: typeof a.updatedAt === "number" ? a.updatedAt : null,
        cpuPct: null,
        detail: a.state === "working" ? str("toolName") : null,
      });
    }
  }
  return out;
}

async function orcaAgents(bin: string): Promise<Partial[]> {
  const res = await run(bin, ["worktree", "ps", "--json"], { timeoutMs: 8000 });
  if (res.code !== 0) return [];
  try {
    return parseOrca(JSON.parse(res.stdout));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------- process rules

export function processAgents(procs: HostProcess[], rules: AgentProcessRule[], now = Date.now()): Partial[] {
  const out: Partial[] = [];
  const compiled = rules.map((r) => ({ rule: r, re: new RegExp(r.match) }));
  for (const p of procs) {
    const hit = compiled.find((c) => c.re.test(p.args));
    if (!hit) continue;
    out.push({
      id: `proc:${hit.rule.tool}:${p.pid}`,
      tool: hit.rule.tool,
      title: null,
      cwd: normalizePath(p.cwd) ?? null,
      // Without a session log, sustained CPU is the only sign of work.
      status: p.cpuPct >= 5 ? "working" : "idle",
      pid: p.pid,
      startedAt: now - p.elapsedSec * 1000,
      lastActivity: null,
      cpuPct: p.cpuPct,
      detail: null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ merge

/**
 * Orca watches the panes its agents run in, so the same Claude Code session
 * can arrive both from its own session file and from Orca. Keep the tool's own
 * record (it has the pid and the authoritative status) and borrow Orca's
 * title when the tool has none.
 */
export function mergeAgents(own: Partial[], orca: Partial[]): Partial[] {
  const merged = [...own];
  for (const o of orca) {
    const twin = merged.find((m) => m.tool === o.tool && m.cwd !== null && m.cwd === o.cwd && !m.id.startsWith("orca:"));
    if (twin) {
      twin.title = twin.title ?? o.title;
      twin.detail = twin.detail ?? o.detail;
      if (twin.status === "unknown") twin.status = o.status;
      continue;
    }
    merged.push(o);
  }
  return merged;
}

export function trimIdle(agents: Partial[], now = Date.now()): Partial[] {
  const kept: Partial[] = [];
  const idleCount = new Map<string, number>();
  const byRecency = [...agents].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  for (const a of byRecency) {
    const live = a.status === "working" || a.status === "waiting" || a.pid !== null;
    if (!live) {
      if ((a.lastActivity ?? 0) < now - RECENT_MS) continue;
      const n = idleCount.get(a.tool) ?? 0;
      if (n >= IDLE_PER_TOOL) continue;
      idleCount.set(a.tool, n + 1);
    }
    kept.push(a);
  }
  return kept;
}

const STATUS_ORDER: Record<AgentStatus, number> = { waiting: 0, working: 1, idle: 2, unknown: 3 };

export class AgentCollector {
  private current: AgentSnapshot[] = [];
  private busy = false;
  private readonly rules: AgentProcessRule[];
  private readonly home = homedir();
  private readonly opencodeBin: string | null;
  private readonly orcaBin: string | null;

  constructor(rules: AgentProcessRule[]) {
    this.rules = rules;
    this.opencodeBin = findBin("opencode", [join(this.home, ".opencode", "bin", "opencode")]);
    this.orcaBin = findBin("orca", [join(this.home, ".local", "bin", "orca")]);
  }

  snapshots(): AgentSnapshot[] {
    return this.current;
  }

  async poll(hosts: { host: HostConfig; procs: HostProcess[]; online: boolean }[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const local = hosts.find((h) => h.host.local)?.host ?? null;
      const out: AgentSnapshot[] = [];
      const attach = (host: HostConfig, items: Partial[]) => {
        for (const item of items) {
          const custom = this.rules.find((r) => r.tool === item.tool);
          out.push({
            ...item,
            // Process ids repeat across machines.
            id: host.local ? item.id : `${host.id}:${item.id}`,
            cwd: item.cwd && host.local ? this.tilde(item.cwd) : item.cwd,
            host: host.id,
            hostLabel: host.label,
            toolLabel: custom?.label ?? TOOL_LABELS[item.tool] ?? item.tool,
          });
        }
      };

      if (local) {
        const [claude, codex, opencode, orca] = await Promise.all([
          claudeSessions(),
          codexThreads(),
          this.opencodeBin ? opencodeSessions(this.opencodeBin) : Promise.resolve([]),
          this.orcaBin ? orcaAgents(this.orcaBin) : Promise.resolve([]),
        ]);
        const merged = mergeAgents([...claude, ...codex, ...opencode], orca);
        attach(local, trimIdle(merged));
      }
      for (const h of hosts) {
        if (!h.online) continue;
        // Locally the tools' own records already cover the built-in CLIs.
        attach(h.host, processAgents(h.procs, h.host.local ? this.rules : [...this.rules, ...REMOTE_RULES]));
      }
      out.sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivity ?? b.startedAt ?? 0) - (a.lastActivity ?? a.startedAt ?? 0),
      );
      this.current = out;
    } finally {
      this.busy = false;
    }
  }

  private tilde(path: string): string {
    return path === this.home ? "~" : path.startsWith(`${this.home}/`) ? `~${path.slice(this.home.length)}` : path;
  }
}

function findBin(name: string, extra: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const candidate of [...dirs.map((d) => join(d, name)), ...extra]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
