import type { Store } from "../store.ts";
import type { HostSnapshot, LlmConfig, LlmSnapshot, SpecStats } from "../types.ts";
import { ENGINE_LABELS, engineFromMetrics, engineFromOwner, metricsFromTensorfoldHealth, parseMetrics, withLiveTensorfoldTokens, type Engine, type MetricsSample } from "./engines.ts";

export { parseMetrics } from "./engines.ts";

const HISTORY_POINTS = 120;
const REQUEST_TIMEOUT_MS = 3000;

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
  /** Configured engine, or the one detected while the server was up. */
  engine: Engine | null;
}

/**
 * Speculative-decoding figures for the last interval. null when the server
 * is not drafting at all.
 */
export function specStats(prev: MetricsSample | null, next: MetricsSample, dt: number): SpecStats | null {
  const drafted = next.draftTokens;
  const hasCounters = drafted !== null && drafted > 0;
  const hasGauges = next.acceptRateGauge !== null || next.acceptLengthGauge !== null;
  if (!hasCounters && !hasGauges) return null;
  const rate = (a: number | null, b: number | null) =>
    prev && dt > 0 && a !== null && b !== null ? counterDelta(b, a) / dt : null;
  let acceptRate = next.acceptRateGauge;
  let meanLength = next.acceptLengthGauge;
  if (hasCounters && next.acceptedTokens !== null) {
    acceptRate = next.acceptedTokens / drafted!;
    // Each verify round also yields one token of the target's own.
    if (next.drafts !== null && next.drafts > 0) meanLength = next.acceptedTokens / next.drafts + 1;
  }
  return {
    acceptRate,
    meanLength,
    draftTokensPerSec: rate(next.draftTokens, prev?.draftTokens ?? null),
    acceptedTokensPerSec: rate(next.acceptedTokens, prev?.acceptedTokens ?? null),
  };
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
      engine: config.engine && config.engine !== "auto" ? config.engine : null,
      snapshot: {
        id: config.id,
        label: config.label,
        engine: config.engine && config.engine !== "auto" ? ENGINE_LABELS[config.engine] : null,
        state: "down",
        detail: null,
        baseUrl: config.baseUrl,
        nodes: config.nodes ?? [],
        models: [],
        contextLength: null,
        upSince: null,
        lastActiveAt: null,
        latencyMs: null,
        requestsRunning: null,
        requestsWaiting: null,
        kvCacheUsage: null,
        genTokensPerSec: null,
        promptTokensPerSec: null,
        ttftSec: null,
        prefixCacheHitRate: null,
        spec: null,
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
          h.containers
            .filter((c) => wanted.has(c.name))
            .map((c) => ({ host: h.id, name: c.name, state: c.state, status: c.status, servedName: c.servedName ?? null })),
        );

      // vLLM and TensorFold have a cheap /health. SGLang's /health runs a
      // one-token generation, so an unknown or SGLang server is asked for its
      // model list instead.
      const started = performance.now();
      const cheapHealth = state.engine === "vllm" || state.engine === "tensorfold";
      const health = await this.get(state, cheapHealth ? "/health" : "/v1/models", !cheapHealth);
      const latencyMs = Math.round(performance.now() - started);

      // Not answering, or answering as some other model that shares the port.
      const markDown = (other: string | null, otherDetail: string | null = null) => {
        // The same container name may run on every node, so count machines.
        const live = containers.filter((c) => c.state === "running");
        const nodes = new Set(live.map((c) => c.host));
        const running = nodes.size;
        // Two recipes can share containers. Another model answering means they serve it; before anything
        // answers, the name in the containers' command says which recipe started them.
        const servedElse = config.model !== undefined && live.some((c) => c.servedName) && !live.some((c) => c.servedName === config.model);
        const starting = other === null && running > 0 && !servedElse;
        state.snapshot = {
          ...state.snapshot,
          state: starting ? "starting" : "down",
          detail: starting
            ? `${running}/${Math.max(nodeIds.size, running)} 台でコンテナが起動済み`
            : servedElse && other === null
              ? `コンテナは ${live.find((c) => c.servedName)!.servedName} を読み込んでいます`
              : otherDetail
              ? otherDetail
              : other
                ? `このポートでは ${other} が動いています`
                : health && health.status !== 200
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
        if (!config.engine || config.engine === "auto") state.engine = null;
        push(state.snapshot.history.genTps, null);
        push(state.snapshot.history.running, null);
      };

      if (!health || health.status !== 200) {
        markDown(null);
        return;
      }

      const [modelsRes, metricsRes, healthJson] = await Promise.all([
        cheapHealth ? this.get(state, "/v1/models", true) : Promise.resolve(health),
        this.get(state, "/metrics", false),
        // TensorFold reports its context window only in its /health body.
        state.engine === "tensorfold" && cheapHealth ? Promise.resolve(health) : Promise.resolve(null),
      ]);
      let models = state.snapshot.models;
      let contextLength = state.snapshot.contextLength;
      let owner: unknown = null;
      if (modelsRes?.status === 200) {
        try {
          const data = ((await modelsRes.json()) as { data?: { id?: string; max_model_len?: number; owned_by?: string }[] }).data ?? [];
          models = data.map((m) => m.id).filter((id): id is string => typeof id === "string");
          owner = data[0]?.owned_by;
          contextLength = data.find((m) => typeof m.max_model_len === "number")?.max_model_len ?? contextLength;
        } catch {
          // Keep the previous list.
        }
      }
      let healthBody: unknown = null;
      if (healthJson) {
        try {
          healthBody = await healthJson.json();
          const h = healthBody as { context_length?: unknown };
          if (typeof h.context_length === "number") contextLength = h.context_length;
        } catch {
          // A plain-text /health.
        }
      }
      if (config.model && modelsRes?.status === 200 && !models.includes(config.model)) {
        markDown(models[0] ?? "別のモデル");
        return;
      }
      // Two recipes can serve the same model name on one port; their containers tell them apart.
      // Absence counts only when every machine the containers could be on returned its list:
      // a failed `docker ps`, or a machine not reached, proves nothing.
      const targets = nodeIds.size > 0 ? [...nodeIds].map((id) => hosts.find((h) => h.id === id)) : hosts;
      const allSeen = targets.length > 0 && targets.every((h) => h?.online && h.containersKnown);
      if (wanted.size > 0 && allSeen && !containers.some((c) => c.state === "running")) {
        markDown(null, "このポートでは同じモデル名の別のレシピが動いています");
        return;
      }
      const metricsText = metricsRes?.status === 200 ? await metricsRes.text() : null;
      if (!state.engine) state.engine = engineFromOwner(owner) ?? (metricsText ? engineFromMetrics(metricsText) : null);
      const engine: Engine = state.engine ?? "vllm";

      const now = Date.now();
      const metrics = metricsText
        ? engine === "tensorfold"
          ? withLiveTensorfoldTokens(parseMetrics(metricsText, engine), healthBody)
          : parseMetrics(metricsText, engine)
        : engine === "tensorfold"
          ? metricsFromTensorfoldHealth(healthBody)
          : null;
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
      const spec = metrics ? specStats(prev?.metrics ?? null, metrics, prev ? (now - prev.at) / 1000 : 0) : null;
      if (metrics) state.prev = { at: now, metrics };

      state.snapshot = {
        ...state.snapshot,
        state: "up",
        detail: metrics
          ? null
          : engine === "sglang"
            ? "メトリクスを取得できません（SGLang は --enable-metrics が必要です）"
            : "メトリクスを取得できません",
        engine: state.engine ? ENGINE_LABELS[state.engine] : null,
        models,
        contextLength,
        upSince: state.snapshot.upSince ?? now,
        lastActiveAt: (metrics?.running ?? 0) > 0 || (genTps ?? 0) > 0.5 ? now : state.snapshot.lastActiveAt,
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
        spec,
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
