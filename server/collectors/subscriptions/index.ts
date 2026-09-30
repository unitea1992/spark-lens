import type { SubscriptionConfig, SubscriptionSnapshot } from "../../types.ts";
import { claudeCode } from "./claudeCode.ts";
import { codex } from "./codex.ts";
import { command } from "./command.ts";
import { opencodeGo } from "./opencodeGo.ts";
import type { Provider } from "./provider.ts";

// To add a service: write a Provider next to these and list it here.
const PROVIDERS: Provider[] = [claudeCode, codex, opencodeGo, command];

interface Entry {
  config: SubscriptionConfig;
  provider: Provider | null;
  snapshot: SubscriptionSnapshot;
}

export class SubscriptionCollector {
  private readonly entries: Entry[];
  private busy = false;

  constructor(configs: SubscriptionConfig[], providers: Provider[] = PROVIDERS) {
    const seen = new Map<string, number>();
    this.entries = configs.map((config) => {
      const provider = providers.find((p) => p.type === config.type) ?? null;
      const n = (seen.get(config.type) ?? 0) + 1;
      seen.set(config.type, n);
      return {
        config,
        provider,
        snapshot: {
          id: n === 1 ? config.type : `${config.type}-${n}`,
          type: config.type,
          label: config.label ?? provider?.defaultLabel ?? config.type,
          plan: null,
          status: provider ? "unconfigured" : "error",
          message: provider ? "取得中…" : `未対応の種類です: ${config.type}`,
          windows: [],
          notes: [],
          fetchedAt: null,
        },
      };
    });
  }

  snapshots(): SubscriptionSnapshot[] {
    return this.entries.map((e) => e.snapshot);
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Promise.all(
        this.entries.map(async (entry) => {
          if (!entry.provider) return;
          let report;
          try {
            report = await entry.provider.fetch(entry.config);
          } catch {
            // Deliberately drop the error text: it could echo a request header.
            report = { plan: null, status: "error" as const, message: "取得中にエラーが発生しました。", windows: [], notes: [] };
          }
          const previous = entry.snapshot;
          // Keep showing the last good numbers through a transient failure,
          // marked stale, rather than blanking the card.
          const keepOld = report.status !== "ok" && report.status !== "unconfigured" && previous.windows.length > 0;
          entry.snapshot = {
            ...previous,
            plan: report.plan ?? previous.plan,
            status: report.status,
            message: report.message,
            windows: keepOld ? previous.windows : report.windows,
            notes: keepOld ? previous.notes : report.notes,
            fetchedAt: report.status === "ok" ? Date.now() : previous.fetchedAt,
          };
        }),
      );
    } finally {
      this.busy = false;
    }
  }
}
