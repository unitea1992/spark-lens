import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelUsage } from "./types.ts";

// API-price equivalent of the tokens each model used. Prices come from
// models.dev (per provider, USD per million tokens) with LiteLLM as a
// fallback, are cached on disk and refreshed at most once a day. A model that
// cannot be matched exactly is left unpriced: no guessing.

const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_AGE_MS = 24 * 3600_000;
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
  /** "provider/model-id" -> rates. */
  modelsDev: Record<string, Rates>;
  /** Plain model id -> rates (LiteLLM keys with a region or cloud prefix are dropped). */
  litellm: Record<string, Rates>;
}

/** Local models are priced as the same open model through its maker's API. Key: label lowercased, spaces as hyphens. */
export const LOCAL_PRICE_AS: Record<string, string> = {
  "glm-5.3-flash": "zai/glm-5.3-flash",
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

/** The "provider/id" a local model is priced as, or null when unmapped. */
export function localPriceKey(label: string): string | null {
  return LOCAL_PRICE_AS[label.trim().toLowerCase().replace(/\s+/g, "-")] ?? null;
}

export function findRates(table: PriceTable, row: Pick<ModelUsage, "model" | "source" | "local">): Rates | null {
  if (row.local) {
    const key = localPriceKey(row.model);
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
export function priceRow(table: PriceTable | null, row: ModelUsage): { usd: number | null; usdEstimate?: boolean } {
  const rates = table ? findRates(table, row) : null;
  if (!rates) return { usd: null };
  if (row.input === null || row.output === null) {
    // Only a total is known: price all of it at the input rate, an upper bound.
    return { usd: (row.total * rates.input) / 1e6, usdEstimate: true };
  }
  const cached = row.cached ?? 0;
  const usd = (row.input * rates.input + row.output * rates.output + cached * (rates.cacheRead ?? rates.input)) / 1e6;
  return { usd };
}

export function applyPrices(list: ModelUsage[], table: PriceTable | null): void {
  for (const r of list) {
    const p = priceRow(table, r);
    r.usd = p.usd;
    if (p.usdEstimate) r.usdEstimate = true;
    else delete r.usdEstimate;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), credentials: "omit", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export class PriceBook {
  private table: PriceTable | null = null;
  private loading: Promise<void> | null = null;
  private refreshing = false;
  private lastAttempt = 0;
  private readonly file: string;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly log: (msg: string) => void;

  constructor(stateDir: string, opts: { fetchJson?: (url: string) => Promise<unknown>; log?: (msg: string) => void } = {}) {
    this.file = join(stateDir, "prices.json");
    this.fetchJson = opts.fetchJson ?? fetchJson;
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

  /** Load the cache and, when it is over a day old, fetch fresh prices. Never throws. */
  async refreshIfStale(now = Date.now()): Promise<void> {
    await this.loadCache();
    if (this.refreshing) return;
    if (this.table && now - this.table.fetchedAt < MAX_AGE_MS) return;
    if (now - this.lastAttempt < RETRY_MS) return;
    this.refreshing = true;
    this.lastAttempt = now;
    try {
      const [md, ll] = await Promise.allSettled([this.fetchJson(MODELS_DEV_URL), this.fetchJson(LITELLM_URL)]);
      if (md.status !== "fulfilled") throw md.reason;
      const modelsDev = parseModelsDev(md.value);
      if (Object.keys(modelsDev).length === 0) throw new Error("models.dev returned no prices");
      const litellm = ll.status === "fulfilled" ? parseLitellm(ll.value) : (this.table?.litellm ?? {});
      const next: PriceTable = { fetchedAt: now, modelsDev, litellm };
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
