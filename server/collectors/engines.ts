// Inference-server adapters. Each engine exposes the same few facts under
// different Prometheus names; this file maps them onto one MetricsSample so
// the collector and the screen never need to know which engine is running.

export type Engine = "vllm" | "sglang" | "tensorfold";
export const ENGINES: Engine[] = ["vllm", "sglang", "tensorfold"];

export const ENGINE_LABELS: Record<Engine, string> = {
  vllm: "vLLM",
  sglang: "SGLang",
  tensorfold: "TensorFold",
};

interface Series {
  labels: Record<string, string>;
  value: number;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Prometheus text exposition, indexed by metric name. Comments are skipped. */
export function parseProm(text: string): Map<string, Series[]> {
  const out = new Map<string, Series[]>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(LABEL)) labels[l[1]!] = l[2]!;
    const list = out.get(m[1]!) ?? [];
    list.push({ labels, value });
    out.set(m[1]!, list);
  }
  return out;
}

type Prom = Map<string, Series[]>;

/** Counters add up across label sets (finish reasons, streaming or not, ranks). */
function sum(p: Prom, names: string[], where?: (labels: Record<string, string>) => boolean): number | null {
  for (const name of names) {
    const series = p.get(name)?.filter((s) => !where || where(s.labels));
    if (series && series.length > 0) return series.reduce((a, s) => a + s.value, 0);
  }
  return null;
}

/** Gauges repeated per tensor-parallel rank or per pool: the largest is the one that matters. */
function max(p: Prom, names: string[]): number | null {
  for (const name of names) {
    const series = p.get(name);
    if (series && series.length > 0) return Math.max(...series.map((s) => s.value));
  }
  return null;
}

export interface MetricsSample {
  running: number | null;
  waiting: number | null;
  /** 0..1 */
  kvUsage: number | null;
  promptTokens: number | null;
  generationTokens: number | null;
  ttftSum: number | null;
  ttftCount: number | null;
  /** Prompt tokens served from the prefix cache, and prompt tokens looked up. */
  prefixHits: number | null;
  prefixQueries: number | null;
  requests: number | null;
  /** Speculative decoding: tokens proposed by the draft model, tokens the target kept, and verify rounds. */
  draftTokens: number | null;
  acceptedTokens: number | null;
  drafts: number | null;
  /** Engines that only publish ready-made ratios (SGLang). */
  acceptRateGauge: number | null;
  acceptLengthGauge: number | null;
}

function vllm(p: Prom): MetricsSample {
  return {
    running: sum(p, ["vllm:num_requests_running"]),
    waiting: sum(p, ["vllm:num_requests_waiting"]),
    kvUsage: max(p, ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"]),
    promptTokens: sum(p, ["vllm:prompt_tokens_total", "vllm:prompt_tokens"]),
    generationTokens: sum(p, ["vllm:generation_tokens_total", "vllm:generation_tokens"]),
    ttftSum: sum(p, ["vllm:time_to_first_token_seconds_sum"]),
    ttftCount: sum(p, ["vllm:time_to_first_token_seconds_count"]),
    prefixHits: sum(p, ["vllm:prefix_cache_hits_total", "vllm:prefix_cache_hits"]),
    prefixQueries: sum(p, ["vllm:prefix_cache_queries_total", "vllm:prefix_cache_queries"]),
    requests: sum(p, ["vllm:request_success_total", "vllm:request_success"]),
    draftTokens: sum(p, ["vllm:spec_decode_num_draft_tokens_total"]),
    acceptedTokens: sum(p, ["vllm:spec_decode_num_accepted_tokens_total"]),
    drafts: sum(p, ["vllm:spec_decode_num_drafts_total"]),
    acceptRateGauge: null,
    acceptLengthGauge: null,
  };
}

// SGLang serves /metrics only when started with --enable-metrics.
function sglang(p: Prom): MetricsSample {
  const prompt = sum(p, ["sglang:prompt_tokens_total"]);
  return {
    running: max(p, ["sglang:num_running_reqs"]),
    waiting: max(p, ["sglang:num_queue_reqs"]),
    kvUsage: max(p, ["sglang:token_usage"]),
    promptTokens: prompt,
    generationTokens: sum(p, ["sglang:generation_tokens_total"]),
    ttftSum: sum(p, ["sglang:time_to_first_token_seconds_sum"]),
    ttftCount: sum(p, ["sglang:time_to_first_token_seconds_count"]),
    prefixHits: sum(p, ["sglang:cached_tokens_total"]),
    prefixQueries: prompt,
    requests: sum(p, ["sglang:num_requests_total"]),
    draftTokens: null,
    acceptedTokens: null,
    drafts: sum(p, ["sglang:spec_verify_calls_total"]),
    acceptRateGauge: max(p, ["sglang:spec_accept_rate"]),
    acceptLengthGauge: max(p, ["sglang:spec_accept_length"]),
  };
}

// TensorFold counts tokens when a request finishes, so its rates are bursty.
function tensorfold(p: Prom): MetricsSample {
  return {
    running: sum(p, ["tensorfold:requests_running"]),
    waiting: sum(p, ["tensorfold:requests_waiting"]),
    kvUsage: max(p, ["tensorfold:kv_cache_usage_ratio"]),
    promptTokens: sum(p, ["tensorfold:prompt_tokens_total"]),
    generationTokens: sum(p, ["tensorfold:generation_tokens_total"]),
    ttftSum: sum(p, ["tensorfold:time_to_first_token_seconds_sum"]),
    ttftCount: sum(p, ["tensorfold:time_to_first_token_seconds_count"]),
    // Recipes that also export /health's figures count prompt tokens served from kept prompts.
    prefixHits: sum(p, ["tensorfold_health:cached_tokens_total"]),
    prefixQueries: sum(p, ["tensorfold_health:cached_tokens_total"]) === null ? null : sum(p, ["tensorfold:prompt_tokens_total"]),
    requests: sum(p, ["tensorfold:request_latency_seconds_count"]),
    draftTokens: sum(p, ["tensorfold:mtp_drafted_total"]),
    acceptedTokens: sum(p, ["tensorfold:mtp_accepted_total"]),
    drafts: null,
    acceptRateGauge: null,
    acceptLengthGauge: null,
  };
}

/**
 * TensorFold builds without /metrics still keep running totals in /health.
 * Only counters and the running count are there: no queue, KV or TTFT.
 */
export function metricsFromTensorfoldHealth(body: unknown): MetricsSample | null {
  if (body === null || typeof body !== "object") return null;
  const h = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const generationTokens = num(h.completion_tokens_total);
  if (generationTokens === null) return null;
  return {
    running: num(h.requests_running),
    waiting: null,
    kvUsage: null,
    promptTokens: num(h.prompt_tokens_total),
    generationTokens,
    ttftSum: null,
    ttftCount: null,
    prefixHits: null,
    prefixQueries: null,
    requests: null,
    draftTokens: null,
    acceptedTokens: null,
    drafts: null,
    acceptRateGauge: null,
    acceptLengthGauge: null,
  };
}

/**
 * /metrics counts TensorFold's tokens only when a request finishes, so a long
 * generation would read 0 tokens/s until its last poll. /health's completion
 * count grows while decoding; take the generation counter from there.
 */
export function withLiveTensorfoldTokens(metrics: MetricsSample, healthBody: unknown): MetricsSample {
  const live = metricsFromTensorfoldHealth(healthBody)?.generationTokens ?? null;
  return live === null ? metrics : { ...metrics, generationTokens: live };
}

const ADAPTERS: Record<Engine, (p: Prom) => MetricsSample> = { vllm, sglang, tensorfold };

export function parseMetrics(text: string, engine: Engine): MetricsSample {
  return ADAPTERS[engine](parseProm(text));
}

/** Engine named by a /v1/models `owned_by`, if it names one. */
export function engineFromOwner(owner: unknown): Engine | null {
  if (typeof owner !== "string") return null;
  const o = owner.toLowerCase();
  return ENGINES.find((e) => o.includes(e)) ?? null;
}

/** Engine whose metric prefix appears in a /metrics body. */
export function engineFromMetrics(text: string): Engine | null {
  for (const e of ENGINES) if (text.includes(`\n${e}:`) || text.startsWith(`${e}:`)) return e;
  return null;
}
