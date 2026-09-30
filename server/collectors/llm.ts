import type { Store } from "../store.ts";
import type { HostSnapshot, LlmConfig, LlmSnapshot } from "../types.ts";

const HISTORY_POINTS = 120;
const REQUEST_TIMEOUT_MS = 3000;

/** Sum of every series of one metric, ignoring labels. null when the metric is absent. */
export function promSum(text: string, name: string): number | null {
  let total: number | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith(name)) continue;
    const next = line.charAt(name.length);
    if (next !== "{" && next !== " ") continue;
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

function firstOf(text: string, names: string[]): number | null {
  for (const name of names) {
    const v = promSum(text, name);
    if (v !== null) return v;
  }
  return null;
}

export interface MetricsSample {
  running: number | null;
  waiting: number | null;
  kvUsage: number | null;
  promptTokens: number | null;
  generationTokens: number | null;
  ttftSum: number | null;
  ttftCount: number | null;
  prefixHits: number | null;
  prefixQueries: number | null;
  requests: number | null;
  draftTokens: number | null;
  acceptedTokens: number | null;
}

export function parseMetrics(text: string): MetricsSample {
  return {
    running: promSum(text, "vllm:num_requests_running"),
    waiting: promSum(text, "vllm:num_requests_waiting"),
    kvUsage: firstOf(text, ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"]),
    promptTokens: firstOf(text, ["vllm:prompt_tokens_total", "vllm:prompt_tokens"]),
    generationTokens: firstOf(text, ["vllm:generation_tokens_total", "vllm:generation_tokens"]),
    ttftSum: promSum(text, "vllm:time_to_first_token_seconds_sum"),
    ttftCount: promSum(text, "vllm:time_to_first_token_seconds_count"),
    prefixHits: firstOf(text, ["vllm:prefix_cache_hits_total", "vllm:prefix_cache_hits"]),
    prefixQueries: firstOf(text, ["vllm:prefix_cache_queries_total", "vllm:prefix_cache_queries"]),
    requests: firstOf(text, ["vllm:request_success_total", "vllm:request_success"]),
    draftTokens: promSum(text, "vllm:spec_decode_num_draft_tokens_total"),
    acceptedTokens: promSum(text, "vllm:spec_decode_num_accepted_tokens_total"),
  };
}

/**
 * Growth of a monotonic counter between two samples. A counter that went
 * backwards means the server restarted, so everything it shows is new.
 */
export function counterDelta(prev: number | null, next: number | null): number {
  if (next === null) return 0;
  if (prev === null) return 0;
  return next >= prev ? next - prev : next;
}

interface LlmState {
  config: LlmConfig;
  snapshot: LlmSnapshot;
  prev: { at: number; metrics: MetricsSample } | null;
  busy: boolean;
}

function push<T>(arr: T[], value: T): void {
  arr.push(value);
  if (arr.length > HISTORY_POINTS) arr.splice(0, arr.length - HISTORY_POINTS);
}

export class LlmCollector {
  private readonly states: LlmState[];
  private readonly store: Store;

  constructor(configs: LlmConfig[], store: Store, pollSeconds: number) {
    this.store = store;
    this.states = configs.map((config) => ({
      config,
      prev: null,
      busy: false,
      snapshot: {
        id: config.id,
        label: config.label,
        state: "down",
        detail: null,
        baseUrl: config.baseUrl,
        nodes: config.nodes ?? [],
        models: [],
        contextLength: null,
        upSince: null,
        latencyMs: null,
        requestsRunning: null,
        requestsWaiting: null,
        kvCacheUsage: null,
        genTokensPerSec: null,
        promptTokensPerSec: null,
        ttftSec: null,
        prefixCacheHitRate: null,
        draftAcceptRate: null,
        tokensToday: store.tokensOn(config.id),
        tokensTotal: null,
        requestsTotal: null,
        containers: [],
        history: { stepSec: pollSeconds, genTps: [], running: [] },
      },
    }));
  }

  snapshots(): LlmSnapshot[] {
    return this.states.map((s) => s.snapshot);
  }

  async poll(hosts: HostSnapshot[]): Promise<void> {
    await Promise.all(this.states.map((s) => this.pollOne(s, hosts)));
  }

  private async get(state: LlmState, path: string, auth: boolean): Promise<Response | null> {
    const headers: Record<string, string> = {};
    const key = auth && state.config.apiKeyEnv ? process.env[state.config.apiKeyEnv] : undefined;
    if (key) headers.Authorization = `Bearer ${key}`;
    try {
      return await fetch(`${state.config.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      return null;
    }
  }

  private async pollOne(state: LlmState, hosts: HostSnapshot[]): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    try {
      const { config } = state;
      const wanted = new Set(config.containers ?? []);
      const nodeIds = new Set(config.nodes ?? []);
      const containers = hosts
        // An unreachable host's container list is its last reading, not the present.
        .filter((h) => h.online && (nodeIds.size === 0 || nodeIds.has(h.id)))
        .flatMap((h) =>
          h.containers.filter((c) => wanted.has(c.name)).map((c) => ({ host: h.id, name: c.name, state: c.state, status: c.status })),
        );

      const started = performance.now();
      const health = await this.get(state, "/health", false);
      const latencyMs = Math.round(performance.now() - started);

      if (!health || health.status !== 200) {
        const running = containers.filter((c) => c.state === "running").length;
        const starting = running > 0;
        state.snapshot = {
          ...state.snapshot,
          state: starting ? "starting" : "down",
          detail: starting
            ? `コンテナ ${running}/${wanted.size} 起動済み・モデル読み込み中`
            : health
              ? `応答異常（HTTP ${health.status}）`
              : "停止中",
          upSince: null,
          latencyMs: null,
          requestsRunning: null,
          requestsWaiting: null,
          kvCacheUsage: null,
          genTokensPerSec: null,
          promptTokensPerSec: null,
          ttftSec: null,
          containers,
          tokensToday: this.store.tokensOn(config.id),
        };
        state.prev = null;
        push(state.snapshot.history.genTps, null);
        push(state.snapshot.history.running, null);
        return;
      }

      const [modelsRes, metricsRes] = await Promise.all([this.get(state, "/v1/models", true), this.get(state, "/metrics", false)]);
      let models = state.snapshot.models;
      let contextLength = state.snapshot.contextLength;
      if (modelsRes?.status === 200) {
        try {
          const data = ((await modelsRes.json()) as { data?: { id?: string; max_model_len?: number }[] }).data ?? [];
          models = data.map((m) => m.id).filter((id): id is string => typeof id === "string");
          contextLength = data.find((m) => typeof m.max_model_len === "number")?.max_model_len ?? null;
        } catch {
          // Keep the previous list.
        }
      }

      const now = Date.now();
      const metrics = metricsRes?.status === 200 ? parseMetrics(await metricsRes.text()) : null;
      const prev = state.prev;
      let genTps: number | null = null;
      let promptTps: number | null = null;
      let ttft = state.snapshot.ttftSec;
      if (metrics && prev) {
        const dt = (now - prev.at) / 1000;
        const dGen = counterDelta(prev.metrics.generationTokens, metrics.generationTokens);
        const dPrompt = counterDelta(prev.metrics.promptTokens, metrics.promptTokens);
        if (dt > 0) {
          genTps = metrics.generationTokens === null ? null : dGen / dt;
          promptTps = metrics.promptTokens === null ? null : dPrompt / dt;
        }
        this.store.addTokens(config.id, dPrompt, dGen);
        const dCount = counterDelta(prev.metrics.ttftCount, metrics.ttftCount);
        if (dCount > 0) ttft = counterDelta(prev.metrics.ttftSum, metrics.ttftSum) / dCount;
      }
      if (metrics) state.prev = { at: now, metrics };

      state.snapshot = {
        ...state.snapshot,
        state: "up",
        detail: null,
        models,
        contextLength,
        upSince: state.snapshot.upSince ?? now,
        latencyMs,
        requestsRunning: metrics?.running ?? null,
        requestsWaiting: metrics?.waiting ?? null,
        kvCacheUsage: metrics?.kvUsage ?? null,
        genTokensPerSec: genTps,
        promptTokensPerSec: promptTps,
        ttftSec: ttft,
        prefixCacheHitRate:
          metrics && metrics.prefixQueries !== null && metrics.prefixQueries > 0 && metrics.prefixHits !== null
            ? metrics.prefixHits / metrics.prefixQueries
            : null,
        draftAcceptRate:
          metrics && metrics.draftTokens !== null && metrics.draftTokens > 0 && metrics.acceptedTokens !== null
            ? metrics.acceptedTokens / metrics.draftTokens
            : null,
        tokensToday: this.store.tokensOn(config.id),
        tokensTotal:
          metrics && metrics.promptTokens !== null && metrics.generationTokens !== null
            ? { prompt: metrics.promptTokens, generation: metrics.generationTokens }
            : null,
        requestsTotal: metrics?.requests ?? null,
        containers,
      };
      push(state.snapshot.history.genTps, genTps);
      push(state.snapshot.history.running, metrics?.running ?? null);
    } finally {
      state.busy = false;
    }
  }
}
