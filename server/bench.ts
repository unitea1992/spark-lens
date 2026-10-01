// A short, fixed benchmark against an OpenAI-compatible server: time to first
// token, decode speed on prose and on code, and prefill speed on a long
// prompt. Runs are kept with the recipe's upstream commit, so a version can
// be compared with the last one.

import type { BenchCase, BenchRun } from "./types.ts";

interface Case {
  key: BenchCase["key"];
  label: string;
  prompt: string;
  maxTokens: number;
}

// About 8k tokens of plain prose for the prefill case.
const FILLER = Array.from(
  { length: 160 },
  (_, i) =>
    `Section ${i + 1}. The lighthouse keeper logged the weather, trimmed the wick, and noted every passing ship in a careful hand, because the record mattered as much as the light.`,
).join(" ");

export const CASES: Case[] = [
  { key: "ttft", label: "TTFT", prompt: "Reply with the single word OK.", maxTokens: 8 },
  {
    key: "prose",
    label: "文章の生成",
    prompt: "日本の四季それぞれの特徴と楽しみ方を、具体例を交えて 600 字程度で説明してください。",
    maxTokens: 640,
  },
  {
    key: "code",
    label: "コードの生成",
    prompt: "Write a Python module implementing an LRU cache class with get/put, type hints, docstrings, and pytest tests.",
    maxTokens: 640,
  },
  {
    key: "prefill",
    label: "プリフィル",
    prompt: `${FILLER}\n\nSummarise the text above in one sentence.`,
    maxTokens: 32,
  },
];

export interface StreamTiming {
  ttftMs: number | null;
  /** Milliseconds from the first token to the last. */
  decodeMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Read an SSE chat-completion stream and time it. Exported for tests. */
export async function timeStream(body: ReadableStream<Uint8Array>, startedAt: number, now = () => performance.now()): Promise<StreamTiming> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let first: number | null = null;
  let last: number | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = (chunk.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0]?.delta;
      // Thinking models stream reasoning before content; both count as tokens.
      const text = delta && (delta.content || delta.reasoning_content || delta.reasoning);
      if (text) {
        const t = now();
        first ??= t;
        last = t;
      }
      const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        promptTokens = usage.prompt_tokens ?? promptTokens;
        completionTokens = usage.completion_tokens ?? completionTokens;
      }
    }
  }
  return {
    ttftMs: first === null ? null : first - startedAt,
    decodeMs: first !== null && last !== null ? last - first : null,
    promptTokens,
    completionTokens,
  };
}

export function summarise(c: Case, t: StreamTiming): BenchCase {
  const decodeTps =
    t.decodeMs && t.decodeMs > 0 && t.completionTokens && t.completionTokens > 1
      ? (t.completionTokens - 1) / (t.decodeMs / 1000)
      : null;
  const prefillTps = t.ttftMs && t.ttftMs > 0 && t.promptTokens ? t.promptTokens / (t.ttftMs / 1000) : null;
  return {
    key: c.key,
    label: c.label,
    ttftMs: t.ttftMs === null ? null : Math.round(t.ttftMs),
    decodeTps: c.key === "prose" || c.key === "code" ? decodeTps : null,
    prefillTps: c.key === "prefill" ? prefillTps : null,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
  };
}

export async function runBench(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  onProgress: (label: string, done: number, total: number) => void,
  stop?: AbortSignal,
): Promise<{ cases: BenchCase[]; error: string | null }> {
  const cases: BenchCase[] = [];
  for (const [i, c] of CASES.entries()) {
    if (stop?.aborted) return { cases, error: "中止しました" };
    onProgress(c.label, i, CASES.length);
    const startedAt = performance.now();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          // A fresh first line per run keeps the prefix cache from answering for the model.
          messages: [{ role: "user", content: `[run ${Date.now().toString(36)}-${i}]\n${c.prompt}` }],
          max_tokens: c.maxTokens,
          temperature: 0,
          stream: true,
          stream_options: { include_usage: true },
          // Measure the answer, not the thinking; servers ignore kwargs their template lacks.
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: stop ? AbortSignal.any([stop, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
      });
    } catch {
      return { cases, error: stop?.aborted ? "中止しました" : `${c.label}: 接続できませんでした` };
    }
    if (!res.ok || !res.body) return { cases, error: `${c.label}: HTTP ${res.status}` };
    // The connection can still drop, or the timeout fire, while the answer streams.
    try {
      cases.push(summarise(c, await timeStream(res.body, startedAt)));
    } catch {
      return { cases, error: stop?.aborted ? "中止しました" : `${c.label}: 応答の途中で接続が切れました` };
    }
  }
  onProgress("完了", CASES.length, CASES.length);
  return { cases, error: null };
}

export function newRun(llmId: string, model: string, commit: string | null, repo: string | null): BenchRun {
  return { id: `${llmId}-${Date.now()}`, llmId, model, commit, repo, at: Date.now(), cases: [], error: null };
}

/** One benchmark at a time per model; results go to the store. */
export class BenchRunner {
  private readonly state = new Map<string, { running: boolean; stage: string | null; done: number; total: number }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly store: { benchRuns(): BenchRun[]; addBenchRun(run: BenchRun): void };

  /** Replaceable for tests. */
  private readonly runImpl: typeof runBench | null;

  constructor(store: { benchRuns(): BenchRun[]; addBenchRun(run: BenchRun): void }, runImpl: typeof runBench | null = null) {
    this.store = store;
    this.runImpl = runImpl;
  }

  snapshot(llmIds: string[]): Record<string, import("./types.ts").BenchState> {
    const runs = this.store.benchRuns();
    return Object.fromEntries(
      llmIds.map((id) => {
        const s = this.state.get(id) ?? { running: false, stage: null, done: 0, total: CASES.length };
        return [id, { ...s, runs: runs.filter((r) => r.llmId === id).slice(0, 12) }];
      }),
    );
  }

  /** Starts in the background; resolves once accepted. */
  start(
    llmId: string,
    target: { baseUrl: string; model: string; apiKey?: string; commit: string | null; repo: string | null },
    changed: () => void,
  ): { ok: boolean; message: string } {
    if (this.state.get(llmId)?.running) return { ok: false, message: "ベンチマークを実行中です" };
    const run = newRun(llmId, target.model, target.commit, target.repo);
    const controller = new AbortController();
    this.controllers.set(llmId, controller);
    this.state.set(llmId, { running: true, stage: "準備しています", done: 0, total: CASES.length });
    changed();
    void (this.runImpl ?? runBench)(
      target.baseUrl,
      target.model,
      target.apiKey,
      (stage, done, total) => {
        this.state.set(llmId, { running: true, stage, done, total });
        changed();
      },
      controller.signal,
    )
      .catch((err: unknown) => ({ cases: [] as BenchCase[], error: `計測に失敗しました（${err instanceof Error ? err.message : String(err)}）` }))
      // A run the owner stopped is not a measurement; keep it out of the history.
      .then(({ cases, error }) => (controller.signal.aborted ? undefined : this.store.addBenchRun({ ...run, cases, error })))
      .catch(() => {})
      .finally(() => {
        this.controllers.delete(llmId);
        this.state.set(llmId, { running: false, stage: null, done: 0, total: CASES.length });
        changed();
      });
    return { ok: true, message: "ベンチマークを開始しました" };
  }

  /** Abandon a running benchmark; the request in flight is cancelled. */
  stop(llmId: string): { ok: boolean; message: string } {
    const controller = this.controllers.get(llmId);
    if (!controller) return { ok: false, message: "実行中のベンチマークはありません" };
    controller.abort();
    return { ok: true, message: "ベンチマークを中止しました" };
  }
}
