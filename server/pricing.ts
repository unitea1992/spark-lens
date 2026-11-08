import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelUsage } from "./types.ts";

// API-price equivalent of the tokens each model used. Prices come from
// models.dev (per provider, USD per million tokens) with LiteLLM as a
// fallback, are cached on disk. Refresh checks run at most every 6 hours, use
// ETags when offered, and never block serving the last known good prices.

const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const PRICE_CHECK_MS = 6 * 3600_000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_MS = 3600_000;
const FETCH_TIMEOUT_MS = 20_000;

/** USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  /** Absent when the source lists no cache price. */
  cacheRead?: number;
}

export interface PriceTable {
  fetchedAt: number;
  /** Last successful conditional revalidation, including HTTP 304. */
  checkedAt?: number;
  /** Opaque response validators; never include in the UI. */
  etags?: { modelsDev?: string; litellm?: string };
  /** "provider/model-id" -> rates. */
  modelsDev: Record<string, Rates>;
  /** Plain model id -> rates (LiteLLM keys with a region or cloud prefix are dropped). */
  litellm: Record<string, Rates>;
}

/** Reviewed comparisons only. Never fuzzy-match an unrelated paid model.
 * A non-standard/abliterated checkpoint is an approximation to its base API. */
export const LOCAL_PRICE_AS: Record<string, { key: string; comparison: "same_model" | "proxy" }> = {
  "glm-5.3-flash": { key: "zai/glm-5.3-flash", comparison: "same_model" },
  "glm-5.3-flash（tensorfold）": { key: "zai/glm-5.3-flash", comparison: "same_model" },
  "glm-5.3-flash-未検閲版（tensorfold）": { key: "zai/glm-5.3-flash", comparison: "proxy" },
  "qwen3.8-flash-next（tensorfold）": { key: "vultr/qwen3.8-flash-next", comparison: "same_model" },
  "qwen3.8-flash-next（tensorfold・2-台）": { key: "vultr/qwen3.8-flash-next", comparison: "same_model" },
  "deepseek-v4.1-flash-1017（tensorfold・2-台）": { key: "deepinfra/deepseek-ai/deepseek-v4.1-flash-1017", comparison: "same_model" },
  "deepseek-v4.1-flash-1017-未検閲版（tensorfold・2-台）": { key: "deepinfra/deepseek-ai/deepseek-v4.1-flash-1017", comparison: "proxy" },
};

/** OpenCode model ids do not name their maker; the few we can tell from the id. */
const OPENCODE_MAKERS: [prefix: string, provider: string][] = [
  ["muse-", "meta"],
  ["deepseek-", "deepseek"],
  ["glm-", "zai"],
  ["kimi-", "moonshotai"],
];

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function parseModelsDev(json: unknown): Record<string, Rates> {
  const out: Record<string, Rates> = {};
  if (!json || typeof json !== "object") return out;
  for (const [provider, p] of Object.entries(json as Record<string, unknown>)) {
    const models = (p as { models?: Record<string, { cost?: Record<string, unknown> }> } | null)?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, m] of Object.entries(models)) {
      const c = m?.cost;
      if (!c || !num(c.input) || !num(c.output)) continue;
      out[`${provider}/${id.toLowerCase()}`] = { input: c.input, output: c.output, ...(num(c.cache_read) ? { cacheRead: c.cache_read } : {}) };
    }
  }
  return out;
}

const REGION_PREFIX = /^(us|eu|apac|global|au|jp|ca|us-gov|sa|me|af|cn)\./;

export function parseLitellm(json: unknown): Record<string, Rates> {
  const out: Record<string, Rates> = {};
  if (!json || typeof json !== "object") return out;
  for (const [key, v] of Object.entries(json as Record<string, Record<string, unknown>>)) {
    if (key.includes("/") || REGION_PREFIX.test(key) || !v || typeof v !== "object") continue;
    if (!num(v.input_cost_per_token) || !num(v.output_cost_per_token)) continue;
    const cr = v.cache_read_input_token_cost;
    out[key.toLowerCase()] = {
      input: v.input_cost_per_token * 1e6,
      output: v.output_cost_per_token * 1e6,
      ...(num(cr) ? { cacheRead: cr * 1e6 } : {}),
    };
  }
  return out;
}

/** The id as given, then without a trailing -YYYYMMDD or -YYYY-MM-DD. */
export function idCandidates(model: string): string[] {
  const id = model.trim().toLowerCase();
  const stripped = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return stripped !== id && stripped ? [id, stripped] : [id];
}

/** Which models.dev providers to look in, in order. */
function providersFor(row: Pick<ModelUsage, "model" | "source">): string[] {
  switch (row.source) {
    case "Claude Code":
      return ["anthropic"];
    case "Codex":
      return ["openai"];
    case "OpenCode": {
      const id = row.model.toLowerCase();
      const maker = id.endsWith("-free") ? undefined : OPENCODE_MAKERS.find(([p]) => id.startsWith(p))?.[1];
      return [...(maker ? [maker] : []), "opencode", "opencode-go"];
    }
    default:
      return [];
  }
}

/** Explicit reference and whether the checkpoint has a directly comparable public API. */
export function localPriceMatch(label: string): { key: string; comparison: "same_model" | "proxy" } | null {
  return LOCAL_PRICE_AS[label.trim().toLowerCase().replace(/\s+/g, "-")] ?? null;
}

/** The "provider/id" a local model is priced as, or null when unmapped. */
export function localPriceKey(label: string): string | null {
  return localPriceMatch(label)?.key ?? null;
}

export function findRates(table: PriceTable, row: Pick<ModelUsage, "model" | "source" | "local" | "priceReference">): Rates | null {
  if (row.local) {
    const key = row.priceReference ?? localPriceKey(row.model);
    return key ? (table.modelsDev[key] ?? null) : null;
  }
  const providers = providersFor(row);
  if (providers.length === 0) return null;
  for (const id of idCandidates(row.model)) {
    for (const p of providers) {
      const hit = table.modelsDev[`${p}/${id}`];
      if (hit) return hit;
    }
    // LiteLLM only prices the maker's own API, so it is no help for OpenCode's free ids.
    if (row.source !== "OpenCode") {
      const hit = table.litellm[id];
      if (hit) return hit;
    }
  }
  return null;
}

/** Dollar value of a row's tokens, or null when its model has no reliable price. */
export function priceRow(table: PriceTable | null, row: ModelUsage): {
  usd: number | null;
  usdEstimate?: boolean;
  priceReference?: string;
  priceComparison?: "same_model" | "proxy";
} {
  const rates = table ? findRates(table, row) : null;
  if (!rates) return { usd: null };
  const localMatch = row.local
    ? row.priceReference
      ? { key: row.priceReference, comparison: row.priceComparison ?? "proxy" }
      : localPriceMatch(row.model)
    : null;
  const reference = localMatch ? { priceReference: localMatch.key, priceComparison: localMatch.comparison } : {};
  if (row.input === null || row.output === null) {
    // Only a total is known: price all of it at the input rate, an upper bound.
    return { usd: (row.total * rates.input) / 1e6, usdEstimate: true, ...reference };
  }
  const cached = row.cached ?? 0;
  const usd = (row.input * rates.input + row.output * rates.output + cached * (rates.cacheRead ?? rates.input)) / 1e6;
  // Even a same-model price estimates *avoided API purchases*, not net savings.
  return { usd, ...(row.local ? { usdEstimate: true } : {}), ...reference };
}

export function applyPrices(list: ModelUsage[], table: PriceTable | null): void {
  for (const r of list) {
    const p = priceRow(table, r);
    // An absent comparison is unknown, never $0. Actual local API billing is
    // zero, but `usd` means the *hypothetical* API-price equivalent.
    r.usd = p.usd;
    if (p.usdEstimate) r.usdEstimate = true;
    else delete r.usdEstimate;
    if (p.priceReference) r.priceReference = p.priceReference;
    else delete r.priceReference;
    if (p.priceComparison) r.priceComparison = p.priceComparison;
    else delete r.priceComparison;
  }
}

type PriceFetch = { kind: "data"; body: unknown; etag?: string } | { kind: "not_modified"; etag?: string };

async function fetchPrice(url: string, etag?: string): Promise<PriceFetch> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (etag) headers["if-none-match"] = etag;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), credentials: "omit", headers });
  const tag = res.headers.get("etag") ?? undefined;
  if (res.status === 304) return { kind: "not_modified", etag: tag ?? etag };
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return { kind: "data", body: await res.json(), etag: tag };
}

export class PriceBook {
  private table: PriceTable | null = null;
  private loading: Promise<void> | null = null;
  private refreshing = false;
  private lastAttempt = 0;
  private readonly file: string;
  private readonly fetchPrice: (url: string, etag?: string) => Promise<PriceFetch>;
  private readonly log: (msg: string) => void;

  constructor(stateDir: string, opts: { fetchPrice?: (url: string, etag?: string) => Promise<PriceFetch>; log?: (msg: string) => void } = {}) {
    this.file = join(stateDir, "prices.json");
    this.fetchPrice = opts.fetchPrice ?? fetchPrice;
    this.log = opts.log ?? (() => {});
  }

  current(): PriceTable | null {
    return this.table;
  }

  loadCache(): Promise<void> {
    this.loading ??= this.readCache();
    return this.loading;
  }

  private async readCache(): Promise<void> {
    try {
      const t = JSON.parse(await readFile(this.file, "utf8")) as PriceTable;
      if (typeof t.fetchedAt === "number" && t.modelsDev && t.litellm) this.table = t;
    } catch {
      // No cache yet.
    }
  }

  /** Rate-limit checks, not page reads; a failed request leaves the last prices intact. */
  async refreshIfStale(now = Date.now()): Promise<void> {
    await this.loadCache();
    if (this.refreshing) return;
    if (this.table && now - (this.table.checkedAt ?? this.table.fetchedAt) < PRICE_CHECK_MS) return;
    if (now - this.lastAttempt < RETRY_MS) return;
    this.refreshing = true;
    this.lastAttempt = now;
    try {
      const previous = this.table;
      const [md, ll] = await Promise.allSettled([
        this.fetchPrice(MODELS_DEV_URL, previous?.etags?.modelsDev),
        this.fetchPrice(LITELLM_URL, previous?.etags?.litellm),
      ]);
      if (md.status !== "fulfilled") throw md.reason;
      if (md.value.kind === "not_modified" && !previous) throw new Error("models.dev 304 without cached prices");
      const modelsDev = md.value.kind === "not_modified" ? previous!.modelsDev : parseModelsDev(md.value.body);
      if (Object.keys(modelsDev).length === 0) throw new Error("models.dev returned no prices");
      const litellm = ll.status === "fulfilled" && ll.value.kind === "data"
        ? parseLitellm(ll.value.body)
        : previous?.litellm ?? {};
      const next: PriceTable = {
        fetchedAt: md.value.kind === "not_modified" ? previous!.fetchedAt : now,
        checkedAt: now,
        modelsDev,
        litellm,
        etags: {
          ...((md.value.kind === "not_modified" ? md.value.etag ?? previous?.etags?.modelsDev : md.value.etag)
            ? { modelsDev: md.value.kind === "not_modified" ? md.value.etag ?? previous?.etags?.modelsDev : md.value.etag } : {}),
          ...((ll.status === "fulfilled"
            ? (ll.value.kind === "not_modified" ? ll.value.etag ?? previous?.etags?.litellm : ll.value.etag)
            : previous?.etags?.litellm)
            ? { litellm: ll.status === "fulfilled" ? ll.value.etag ?? (ll.value.kind === "not_modified" ? previous?.etags?.litellm : undefined) : previous?.etags?.litellm }
            : {}),
        },
      };
      // Publish valid prices immediately even if persistence fails.
      this.table = next;
      try {
        await mkdir(join(this.file, ".."), { recursive: true });
        await writeFile(`${this.file}.tmp`, JSON.stringify(next));
        await rename(`${this.file}.tmp`, this.file);
      } catch (err) {
        this.log(`price cache not saved: ${(err as Error).message}`);
      }
    } catch (err) {
      this.log(`price refresh failed: ${(err as Error).message}`);
    } finally {
      this.refreshing = false;
    }
  }
}
