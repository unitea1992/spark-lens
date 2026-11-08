import { jst } from "./jst.ts";
import { STALE_AFTER_SEC } from "./quota.ts";
import type { Snapshot, UsageWindow } from "./types.ts";

/** Only observed quota facts and conservative admission. No forecasts or remaining percentages. */
export function observedQuota(snapshot: Pick<Snapshot, "subscriptions" | "llms">, now: number) {
  return {
    schema_version: 2,
    generated_at_jst: jst(now),
    semantics: {
      consumed_percent: "Percentage of provider limit already consumed; 0 = unused, 100 = exhausted",
      prediction_included: false,
      null_means: "Unknown, never zero",
      can_assign: "Conservative advisory gate, not a guarantee of available capacity",
    },
    subscriptions: snapshot.subscriptions.map((sub) => {
      const age = sub.fetchedAt === null ? null : Math.max(0, Math.round((now - sub.fetchedAt) / 1000));
      const fresh = sub.status === "ok" && age !== null && sub.fetchedAt! <= now + 60_000 && age <= STALE_AFTER_SEC;
      const windowsValid = sub.windows.length > 0 && sub.windows.every((w: UsageWindow) =>
        w.usedPct !== null && w.usedPct >= 0 && w.usedPct < (w.windowSec === null || w.windowSec === undefined || w.windowSec < 86400 ? 80 : 85)
        && (w.resetsAt === null ? w.idle === true : w.resetsAt > now),
      );
      const canAssign = fresh && windowsValid;
      return {
        id: sub.id, label: sub.label, kind: "subscription" as const,
        source: "provider_reading" as const,
        status: sub.status,
        fetched_at_jst: jst(sub.fetchedAt), age_sec: age, fresh,
        can_assign: canAssign,
        blocked_reason: !fresh ? "not_fresh_or_unavailable" : !windowsValid ? "window_unknown_or_insufficient_headroom" : null,
        windows: sub.windows.map((w) => ({
          id: w.id, label: w.label, consumed_percent: w.usedPct,
          reset_at_jst: jst(w.resetsAt), idle_until_next_use: w.idle === true,
        })),
      };
    }),
    local_models: snapshot.llms.map((llm) => {
      const up = llm.state === "up";
      const wait = (llm.requestsWaiting ?? 0) > 0;
      const full = llm.maxConcurrent !== null && llm.maxConcurrent !== undefined && llm.requestsRunning !== null && llm.requestsRunning !== undefined && llm.requestsRunning >= llm.maxConcurrent;
      return {
        id: llm.id, label: llm.label, kind: "local_llm" as const,
        state: llm.state,
        can_assign: up && !wait && !full,
        blocked_reason: !up ? "not_running" : wait ? "queued_requests" : full ? "concurrency_limit" : null,
        served_model: up ? (llm.models[0] ?? null) : null,
        requests_running: up ? llm.requestsRunning : null,
        requests_waiting: up ? llm.requestsWaiting : null,
        max_concurrent: up ? llm.maxConcurrent : null,
        pool_tokens: up ? llm.poolTokens : null,
        pool_free_tokens: up ? llm.poolFreeTokens : null,
      };
    }),
  };
}
