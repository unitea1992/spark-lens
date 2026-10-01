// How far a model start has got, read from the launcher's log. vLLM prints
// the same milestones whatever the recipe, so one table serves them all.

export interface StartProgress {
  /** 0..100 */
  pct: number;
  stage: string;
}

interface Milestone {
  re: RegExp;
  /** Fixed share, or [from, to] scaled by the percentage the line reports. */
  at: number | [number, number];
  stage: string;
}

const MILESTONES: Milestone[] = [
  { re: /non-default args|Initializing a V1 LLM engine/, at: 10, stage: "エンジンを初期化しています" },
  { re: /Loading model from scratch|Starting to load model/, at: 14, stage: "重みを読み込んでいます" },
  { re: /Loading safetensors[^\n]*?(\d+)%/, at: [14, 70], stage: "重みを読み込んでいます" },
  { re: /GPU KV cache size|Available KV cache memory/, at: 74, stage: "KV キャッシュを確保しています" },
  { re: /Capturing CUDA graphs[^\n]*?(\d+)%/, at: [76, 90], stage: "CUDA グラフを作成しています" },
  // Only lines the server prints at the end; launchers mention "warmup" early on.
  { re: /boot-shape-warmup:|Application startup complete|Uvicorn running on/, at: 93, stage: "最終確認をしています" },
];

/** When the launcher log says the current start began (host local time), if it says. */
export function startedAt(log: string): number | null {
  const m = /=== spark-lens: start (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(log);
  if (!m) return null;
  const t = Date.parse(m[1]!.replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
}

export function parseProgress(log: string): StartProgress {
  let best: StartProgress = { pct: 3, stage: "準備しています" };
  for (const line of log.split("\n")) {
    for (const m of MILESTONES) {
      const hit = m.re.exec(line);
      if (!hit) continue;
      const pct = typeof m.at === "number" ? m.at : m.at[0] + ((m.at[1] - m.at[0]) * Math.min(100, Number(hit[1]))) / 100;
      if (pct >= best.pct) best = { pct, stage: m.stage };
    }
  }
  return { pct: Math.round(best.pct), stage: best.stage };
}

/** What vLLM reported reserving at start, in GiB. */
export interface MemoryPlan {
  weightsGiB: number | null;
  kvGiB: number | null;
}

export function parseMemoryPlan(log: string): MemoryPlan {
  // vLLM
  const weights = /Model loading took ([0-9.]+) ?GiB/.exec(log);
  const kv = /Available KV cache memory: ([0-9.]+) ?GiB/.exec(log);
  const kvBytes = /kv-cache-memory-bytes[ =]([0-9]+)/.exec(log);
  // SGLang: "Load weight end. ... mem usage=61.90 GB" and "KV Cache is allocated. ... K size: 5.25 GB, V size: 5.25 GB"
  const sgWeights = /Load weight end\.[^\n]*?mem usage=([0-9.]+) ?GB/.exec(log);
  const sgKv = /KV Cache is allocated\.[^\n]*?K size: ([0-9.]+) ?GB, V size: ([0-9.]+) ?GB/.exec(log);
  return {
    weightsGiB: weights ? Number(weights[1]) : sgWeights ? Number(sgWeights[1]) : null,
    kvGiB: kv
      ? Number(kv[1])
      : kvBytes
        ? Number(kvBytes[1]) / 1024 ** 3
        : sgKv
          ? Number(sgKv[1]) + Number(sgKv[2])
          : null,
  };
}
