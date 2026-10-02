import type { SubscriptionConfig, SubscriptionSnapshot } from "../../types.ts";
import { claudeCode } from "./claudeCode.ts";
import { codex } from "./codex.ts";
import { command } from "./command.ts";
import { grok } from "./grok.ts";
import { opencodeGo } from "./opencodeGo.ts";
import type { Provider, UsageReport } from "./provider.ts";

// To add a service: write a Provider next to these and list it here.
const PROVIDERS: Provider[] = [claudeCode, codex, opencodeGo, grok, command];

const BACKOFF_MIN_SEC = 600;
const BACKOFF_MAX_SEC = 3600;

/** Where the last good readings are kept, so a restart does not refetch at once. */
export interface SnapshotCache {
  load(): Record<string, SubscriptionSnapshot>;
  save(snapshots: Record<string, SubscriptionSnapshot>): void;
}

interface Entry {
  config: SubscriptionConfig;
  provider: Provider | null;
  snapshot: SubscriptionSnapshot;
  /** Epoch ms before which this entry is not polled. */
  dueAt: number;
  backoffSec: number;
}

export class SubscriptionCollector {
  private readonly entries: Entry[];
  private readonly intervalMs: number;
  private readonly cache: SnapshotCache | null;
  private busy = false;

  constructor(
    configs: SubscriptionConfig[],
    opts: { providers?: Provider[]; intervalSec?: number; cache?: SnapshotCache } = {},
  ) {
    const providers = opts.providers ?? PROVIDERS;
    this.intervalMs = (opts.intervalSec ?? 300) * 1000;
    this.cache = opts.cache ?? null;
    const saved = this.cache?.load() ?? {};
    const seen = new Map<string, number>();
    this.entries = configs.map((config) => {
      const provider = providers.find((p) => p.type === config.type) ?? null;
      const n = (seen.get(config.type) ?? 0) + 1;
      seen.set(config.type, n);
      const id = n === 1 ? config.type : `${config.type}-${n}`;
      const label = config.label ?? provider?.defaultLabel ?? config.type;
      const prior = saved[id];
      const snapshot: SubscriptionSnapshot =
        provider && prior && prior.type === config.type && prior.windows.length > 0
          ? { ...prior, label, tickets: prior.tickets ?? [] }
          : {
              id,
              type: config.type,
              label,
              plan: null,
              status: provider ? "unconfigured" : "error",
              message: provider ? "取得中…" : `未対応の種類です: ${config.type}`,
              windows: [],
              notes: [],
              tickets: [],
              fetchedAt: null,
            };
      return { config, provider, snapshot, dueAt: (snapshot.fetchedAt ?? 0) + this.intervalMs, backoffSec: 0 };
    });
  }

  snapshots(): SubscriptionSnapshot[] {
    return this.entries.map((e) => e.snapshot);
  }

  /** Polls every entry that is due. Safe to call often. */
  async poll(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.entries.filter((e) => e.provider && e.dueAt <= now);
      if (due.length === 0) return;
      await Promise.all(due.map((entry) => this.pollOne(entry, now)));
      this.cache?.save(Object.fromEntries(this.entries.map((e) => [e.snapshot.id, e.snapshot])));
    } finally {
      this.busy = false;
    }
  }

  private async pollOne(entry: Entry, now: number): Promise<void> {
    let report: UsageReport;
    try {
      report = await entry.provider!.fetch(entry.config);
    } catch {
      // Deliberately drop the error text: it could echo a request header.
      report = { plan: null, status: "error", message: "取得中にエラーが発生しました。", windows: [], notes: [] };
    }
    if (report.backoff) {
      entry.backoffSec = Math.min(BACKOFF_MAX_SEC, Math.max(BACKOFF_MIN_SEC, entry.backoffSec * 2));
      entry.dueAt = now + entry.backoffSec * 1000;
    } else {
      entry.backoffSec = 0;
      entry.dueAt = now + this.intervalMs;
    }
    const previous = entry.snapshot;
    // Keep showing the last good numbers through a transient failure,
    // marked with the error, rather than blanking the card.
    const keepOld = report.status !== "ok" && report.status !== "unconfigured" && previous.windows.length > 0;
    // With no earlier numbers to show, a lapsed login is a plain "log in".
    const status = report.status === "dormant" && !keepOld ? "stale" : report.status;
    entry.snapshot = {
      ...previous,
      plan: report.plan ?? previous.plan,
      status,
      message: report.message,
      windows: keepOld ? previous.windows : report.windows,
      notes: keepOld ? previous.notes : report.notes,
      tickets: keepOld ? previous.tickets : (report.tickets ?? []),
      fetchedAt: report.status === "ok" ? now : previous.fetchedAt,
    };
  }
}
