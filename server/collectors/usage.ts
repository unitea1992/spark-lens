import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir } from "../config.ts";
import { run } from "../exec.ts";
import { applyPrices, PriceBook } from "../pricing.ts";
import { localDate, type Store } from "../store.ts";
import type { LlmConfig, ModelUsage, UsageSnapshot } from "../types.ts";

// Token use per model, today and over the last 7 and 30 days, gathered from the
// records each tool already keeps on this machine. Nothing here calls a
// cloud API, so it costs no quota.

const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
/** Files and rows are read for one day more than the longest range, so the local-time boundary is never cut. */
const SCAN_DAYS = MONTH_DAYS + 1;

interface Tally {
  input: number;
  output: number;
  cached: number;
  /** Tools that only report a total (Codex) leave input/output unknown. */
  totalOnly: number;
}

type DayModel = Map<string, Map<string, Tally>>; // day -> "source\0model" -> tally

function add(target: DayModel, day: string, source: string, model: string, t: Partial<Tally>): void {
  const key = `${source}\0${model}`;
  const byModel = target.get(day) ?? new Map<string, Tally>();
  const cur = byModel.get(key) ?? { input: 0, output: 0, cached: 0, totalOnly: 0 };
  cur.input += t.input ?? 0;
  cur.output += t.output ?? 0;
  cur.cached += t.cached ?? 0;
  cur.totalOnly += t.totalOnly ?? 0;
  byModel.set(key, cur);
  target.set(day, byModel);
}

/** Local dates of the last `count` days, today first. */
export function recentDays(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => localDate(new Date(now.getTime() - i * 86400_000)));
}

// ------------------------------------------------------------ Claude Code

interface ClaudeEntry {
  key: string;
  day: string;
  model: string;
  input: number;
  output: number;
  cached: number;
}

export function parseClaudeLog(text: string): ClaudeEntry[] {
  const out: ClaudeEntry[] = [];
  for (const line of text.split("\n")) {
    // Cheap pre-filter: most lines are tool output, not model replies.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "assistant") continue;
    const m = o.message as Record<string, unknown> | undefined;
    const u = m?.usage as Record<string, number> | undefined;
    const model = typeof m?.model === "string" ? m.model : null;
    if (!u || !model || model === "<synthetic>" || typeof o.timestamp !== "string") continue;
    const at = Date.parse(o.timestamp);
    if (!Number.isFinite(at)) continue;
    out.push({
      // A reply streamed in several chunks is logged once per chunk with the same ids.
      key: `${m?.id ?? ""}:${o.requestId ?? ""}`,
      day: localDate(new Date(at)),
      model,
      input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
      cached: u.cache_read_input_tokens ?? 0,
    });
  }
  return out;
}

async function walk(dir: string, since: number, found: string[] = []): Promise<string[]> {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of names) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, since, found);
    else if (e.name.endsWith(".jsonl")) {
      try {
        if ((await stat(p)).mtimeMs >= since) found.push(p);
      } catch {
        // Vanished between listing and stat.
      }
    }
  }
  return found;
}

class ClaudeSource {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; entries: ClaudeEntry[] }>();
  private readonly root = join(homedir(), ".claude", "projects");

  async collect(target: DayModel): Promise<void> {
    const since = Date.now() - SCAN_DAYS * 86400_000;
    const files = await walk(this.root, since);
    const live = new Set(files);
    for (const f of this.cache.keys()) if (!live.has(f)) this.cache.delete(f);
    for (const f of files) {
      try {
        const info = await stat(f);
        const cached = this.cache.get(f);
        if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) continue;
        this.cache.set(f, { size: info.size, mtimeMs: info.mtimeMs, entries: parseClaudeLog(await readFile(f, "utf8")) });
      } catch {
        // Unreadable file: skip this round.
      }
    }
    const seen = new Set<string>();
    for (const { entries } of this.cache.values()) {
      for (const e of entries) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
        add(target, e.day, "Claude Code", e.model, e);
      }
    }
  }
}

// ------------------------------------------------------------------ Codex

function codexThreads(target: DayModel): void {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    return;
  }
  const version = (n: string) => Number(/^state_(\d+)\.sqlite$/.exec(n)?.[1] ?? -1);
  const db = names.filter((n) => version(n) >= 0).sort((a, b) => version(a) - version(b)).pop();
  if (!db) return;
  try {
    const conn = new DatabaseSync(join(home, db), { readOnly: true });
    try {
      const rows = conn
        .prepare("select tokens_used, model, model_provider, updated_at_ms from threads where updated_at_ms > ? and tokens_used > 0")
        .all(Date.now() - SCAN_DAYS * 86400_000) as Record<string, unknown>[];
      for (const r of rows) {
        const model = typeof r.model === "string" && r.model ? r.model : "モデル不明";
        add(target, localDate(new Date(Number(r.updated_at_ms))), "Codex", model, { totalOnly: Number(r.tokens_used) || 0 });
      }
    } finally {
      conn.close();
    }
  } catch {
    // Schema change: Codex simply drops out of the table.
  }
}

// --------------------------------------------------------------- OpenCode

export function parseOpencodeStats(stdout: string): { model: string; input: number; output: number; cached: number }[] {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(o.models)) return [];
  return o.models.flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const m = r.model as Record<string, unknown> | undefined;
    const t = r.tokens as Record<string, unknown> | undefined;
    if (!m || typeof m.id !== "string" || !t) return [];
    const cache = (t.cache ?? {}) as Record<string, number>;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return [
      {
        model: m.id,
        input: n(t.input) + n(cache.write),
        output: n(t.output) + n(t.reasoning),
        cached: n(cache.read),
      },
    ];
  });
}

// ------------------------------------------------------------- collector

function rows(tallies: Map<string, Tally>[], localSources: Set<string>): ModelUsage[] {
  const merged = new Map<string, Tally>();
  for (const byModel of tallies) {
    for (const [key, t] of byModel) {
      const cur = merged.get(key) ?? { input: 0, output: 0, cached: 0, totalOnly: 0 };
      cur.input += t.input;
      cur.output += t.output;
      cur.cached += t.cached;
      cur.totalOnly += t.totalOnly;
      merged.set(key, cur);
    }
  }
  return [...merged.entries()]
    .map(([key, t]) => {
      const [source, model] = key.split("\0") as [string, string];
      const split = t.input + t.output + t.cached > 0;
      return {
        model,
        source,
        local: localSources.has(source),
        input: split ? t.input : null,
        output: split ? t.output : null,
        cached: split ? t.cached : null,
        total: t.input + t.output + t.cached + t.totalOnly,
        usd: null,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
}

export class UsageCollector {
  private current: UsageSnapshot = { generatedAt: 0, pricesFetchedAt: null, pricesSource: null, today: [], week: [], month: [] };
  private busy = false;
  private readonly claude = new ClaudeSource();
  private readonly prices = new PriceBook(stateDir(), { log: (m) => console.error(`[usage] ${m}`) });
  private readonly opencodeBin: string | null;

  private readonly llms: LlmConfig[];
  private readonly store: Store;

  constructor(llms: LlmConfig[], store: Store) {
    this.llms = llms;
    this.store = store;
    const candidates = [...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "opencode")), join(homedir(), ".opencode", "bin", "opencode")];
    this.opencodeBin = candidates.find((c) => existsSync(c)) ?? null;
  }

  snapshot(): UsageSnapshot {
    return this.current;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // Prices refresh in the background; this poll uses whatever is cached.
      await this.prices.loadCache();
      void this.prices.refreshIfStale();
      const byDay: DayModel = new Map();
      await this.claude.collect(byDay);
      codexThreads(byDay);
      for (const llm of this.llms) {
        for (const day of recentDays(MONTH_DAYS)) {
          const t = this.store.tokensOn(llm.id, new Date(`${day}T12:00:00`));
          add(byDay, day, "ローカル", llm.label, { input: t.prompt, output: t.generation });
        }
      }
      const days = recentDays(MONTH_DAYS);
      const today = rows([byDay.get(days[0]!) ?? new Map()], new Set(["ローカル"]));
      const range = (n: number) => rows(days.slice(0, n).map((d) => byDay.get(d) ?? new Map()), new Set(["ローカル"]));
      const week = range(WEEK_DAYS);
      const month = range(MONTH_DAYS);

      // OpenCode keeps its own day boundaries; ask it for each range.
      if (this.opencodeBin) {
        const [d0, d7, d30] = await Promise.all(
          ["0", String(WEEK_DAYS), String(MONTH_DAYS)].map((d) => run(this.opencodeBin!, ["stats", "--days", d, "--json", "--models"], { timeoutMs: 15_000 })),
        );
        const localIds = new Set(this.llms.map((l) => l.model?.toLowerCase()).filter((id): id is string => Boolean(id)));
        const add2 = (list: ModelUsage[], stdout: string) => {
          // OpenCode lists a model once per reasoning variant; show it once.
          const byModel = new Map<string, ModelUsage>();
          for (const m of parseOpencodeStats(stdout)) {
            // A local model used through OpenCode is already counted by the model's own row.
            if (localIds.has(m.model.toLowerCase())) continue;
            const total = m.input + m.output + m.cached;
            if (total <= 0) continue;
            const cur = byModel.get(m.model);
            if (cur) {
              cur.input = (cur.input ?? 0) + m.input;
              cur.output = (cur.output ?? 0) + m.output;
              cur.cached = (cur.cached ?? 0) + m.cached;
              cur.total += total;
            } else byModel.set(m.model, { model: m.model, source: "OpenCode", local: false, input: m.input, output: m.output, cached: m.cached, total, usd: null });
          }
          list.push(...byModel.values());
          list.sort((a, b) => b.total - a.total);
        };
        if (d0?.code === 0) add2(today, d0.stdout);
        if (d7?.code === 0) add2(week, d7.stdout);
        if (d30?.code === 0) add2(month, d30.stdout);
      }
      const table = this.prices.current();
      for (const list of [today, week, month]) applyPrices(list, table);
      this.current = {
        generatedAt: Date.now(),
        pricesFetchedAt: table?.fetchedAt ?? null,
        pricesSource: table ? "models.dev" : null,
        today,
        week,
        month,
      };
    } finally {
      this.busy = false;
    }
  }
}
