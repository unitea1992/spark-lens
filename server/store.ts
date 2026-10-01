import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubscriptionSnapshot } from "./types.ts";

interface DayTotals {
  prompt: number;
  generation: number;
}

interface StateFile {
  version: 1;
  /** llm id -> local date (YYYY-MM-DD) -> tokens counted that day */
  tokens: Record<string, Record<string, DayTotals>>;
  /** Last subscription readings, so a restart does not hit the usage APIs at once. */
  subscriptions?: Record<string, SubscriptionSnapshot>;
  /** Minute averages of live figures for the last day (see history.ts). */
  history?: Record<string, { m: number; sum: number; n: number }[]>;
  /** Benchmark runs, newest first. */
  benchRuns?: import("./types.ts").BenchRun[];
  /** Seconds the last successful start of each recipe took. */
  startSeconds?: Record<string, number>;
}

const KEEP_DAYS = 60;

export function localDate(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** Small JSON file for the few numbers that must survive a restart. */
export class Store {
  private readonly path: string;
  private state: StateFile = { version: 1, tokens: {} };
  private dirty = false;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "state.json");
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as StateFile;
      if (raw && raw.version === 1 && raw.tokens && typeof raw.tokens === "object") this.state = raw;
    } catch {
      // First run, or an unreadable file: start empty.
    }
  }

  addTokens(llm: string, prompt: number, generation: number, at = new Date()): void {
    if (prompt <= 0 && generation <= 0) return;
    const days = (this.state.tokens[llm] ??= {});
    const day = (days[localDate(at)] ??= { prompt: 0, generation: 0 });
    day.prompt += Math.max(0, prompt);
    day.generation += Math.max(0, generation);
    this.dirty = true;
  }

  tokensOn(llm: string, at = new Date()): DayTotals {
    return this.state.tokens[llm]?.[localDate(at)] ?? { prompt: 0, generation: 0 };
  }

  subscriptions(): Record<string, SubscriptionSnapshot> {
    return this.state.subscriptions ?? {};
  }

  setSubscriptions(snapshots: Record<string, SubscriptionSnapshot>): void {
    this.state.subscriptions = snapshots;
    this.dirty = true;
  }

  history(): Record<string, { m: number; sum: number; n: number }[]> {
    return this.state.history ?? {};
  }

  setHistory(dump: Record<string, { m: number; sum: number; n: number }[]>): void {
    this.state.history = dump;
    this.dirty = true;
  }

  benchRuns(): import("./types.ts").BenchRun[] {
    return this.state.benchRuns ?? [];
  }

  addBenchRun(run: import("./types.ts").BenchRun): void {
    this.state.benchRuns = [run, ...(this.state.benchRuns ?? [])].slice(0, 100);
    this.dirty = true;
  }

  startSeconds(id: string): number | null {
    return this.state.startSeconds?.[id] ?? null;
  }

  setStartSeconds(id: string, seconds: number): void {
    (this.state.startSeconds ??= {})[id] = Math.round(seconds);
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    for (const days of Object.values(this.state.tokens)) {
      const keys = Object.keys(days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
