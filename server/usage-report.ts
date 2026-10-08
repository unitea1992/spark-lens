import { jst } from "./quota.ts";
import type { ModelUsage, UsageSnapshot } from "./types.ts";

/**
 * Per-model token usage for today, the last 7 days and the last 30 days, for
 * callers that measure usage before and after a run. Pure: the same snapshot
 * gives the same report. Only what the dashboard's usage table already shows
 * is returned: no host names, price-list sources or configuration.
 */

export interface UsageReportModel {
  model: string;
  /** Where it was used: "Claude Code", "Codex", "OpenCode" or "ローカル". */
  source: string;
  local: boolean;
  /** null when the tool reports only a total. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Cache reads. */
  cached_tokens: number | null;
  /** Cache writes, already counted in input_tokens; null when the tool does not report them (Codex, local LLMs). */
  cache_write_tokens: number | null;
  total_tokens: number;
  /** API-price equivalent in USD, not a bill; null when the model has no reliable price. */
  usd: number | null;
  /** The dollar figure is an upper bound (the tool reports only a total). */
  usd_estimate: boolean;
}

export interface UsageReportPeriod {
  models: UsageReportModel[];
  total_tokens: number;
  /** Sum over the models that have a price; null when none do. */
  total_usd: number | null;
  /** Some models are in total_tokens but not in total_usd. */
  usd_partial: boolean;
}

export interface UsageReport {
  generated_at: number;
  generated_at_jst: string;
  /** When the usage numbers were last collected (every minute); null before the first collection. */
  usage_at: number | null;
  usage_at_jst: string | null;
  age_sec: number | null;
  /** The case-insensitive substring the models were filtered by, if any. */
  model_filter: string | null;
  today: UsageReportPeriod;
  week: UsageReportPeriod;
  month: UsageReportPeriod;
  /** With `?days=N`: each of the last N days, newest first. OpenCode reports only ranges, so it is in the periods above but not here. */
  daily?: (UsageReportPeriod & { day: string })[];
  daily_excludes?: string[];
}

/** Days of daily usage kept (the collector reads 30). */
export const MAX_USAGE_DAYS = 30;

/** Longest model filter accepted; a longer one cannot match any model name. */
export const MAX_MODEL_FILTER = 80;

function reportModel(m: ModelUsage): UsageReportModel {
  return {
    model: m.model,
    source: m.source,
    local: m.local,
    input_tokens: m.input,
    output_tokens: m.output,
    cached_tokens: m.cached,
    cache_write_tokens: m.cacheWrite ?? null,
    total_tokens: m.total,
    usd: m.usd,
    usd_estimate: m.usdEstimate === true,
  };
}

function period(list: ModelUsage[], filter: string | null): UsageReportPeriod {
  const models = list.filter((m) => filter === null || m.model.toLowerCase().includes(filter)).map(reportModel);
  const priced = models.filter((m) => m.usd !== null);
  return {
    models,
    total_tokens: models.reduce((sum, m) => sum + m.total_tokens, 0),
    total_usd: priced.length === 0 ? null : Math.round(priced.reduce((sum, m) => sum + m.usd!, 0) * 1e6) / 1e6,
    usd_partial: priced.length < models.length,
  };
}

export function usageReport(usage: UsageSnapshot, now: number, modelFilter?: string | null, days?: number | null): UsageReport {
  const filter = modelFilter?.trim().toLowerCase().slice(0, MAX_MODEL_FILTER) || null;
  const collected = usage.generatedAt > 0 ? usage.generatedAt : null;
  return {
    generated_at: now,
    generated_at_jst: jst(now)!,
    usage_at: collected,
    usage_at_jst: jst(collected),
    age_sec: collected === null ? null : Math.max(0, Math.round((now - collected) / 1000)),
    model_filter: filter,
    today: period(usage.today, filter),
    week: period(usage.week, filter),
    month: period(usage.month, filter),
    ...(days
      ? {
          daily: (usage.daily ?? []).slice(0, Math.min(days, MAX_USAGE_DAYS)).map((d) => ({ day: d.day, ...period(d.models, filter) })),
          daily_excludes: ["OpenCode"],
        }
      : {}),
  };
}
