import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "../../types.ts";
import { clampPct, failed, getJson, httpFailure, option, parseTime, unconfigured, type Provider, type UsageReport } from "./provider.ts";

// The endpoints the Grok Build CLI reads for its own usage display. Same
// read-only rule as Claude Code and Codex: the CLI owns token refresh.
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

const PERIOD_LABELS: Record<string, string> = {
  USAGE_PERIOD_TYPE_DAILY: "日間",
  USAGE_PERIOD_TYPE_WEEKLY: "週間",
  USAGE_PERIOD_TYPE_MONTHLY: "月間",
};

/** The SuperGrok login, else the older sign-in entry. Keys are OIDC scope URLs. */
export function pickGrokCredential(auth: unknown): { token: string; expiresAt: number | null } | null {
  if (auth === null || typeof auth !== "object") return null;
  const entries = Object.entries(auth as Record<string, unknown>);
  const entry =
    entries.find(([k]) => k.startsWith("https://auth.x.ai::"))?.[1] ?? entries.find(([k]) => k === "https://accounts.x.ai/sign-in")?.[1];
  const e = (entry ?? null) as Record<string, unknown> | null;
  if (typeof e?.key !== "string" || e.key === "") return null;
  return { token: e.key, expiresAt: parseTime(e.expires_at) };
}

export function parseGrokBilling(body: unknown): UsageWindow[] {
  const config = (body as Record<string, unknown> | null)?.config;
  if (config === null || typeof config !== "object") return [];
  const c = config as Record<string, unknown>;
  const period = (c.currentPeriod ?? {}) as Record<string, unknown>;
  const start = parseTime(period.start ?? c.billingPeriodStart);
  const end = parseTime(period.end ?? c.billingPeriodEnd);
  let usedPct = clampPct(c.creditUsagePercent);
  if (usedPct === null) {
    // Plans that publish only an on-demand cap.
    const used = (c.onDemandUsed as Record<string, unknown> | undefined)?.val;
    const cap = (c.onDemandCap as Record<string, unknown> | undefined)?.val;
    if (typeof used === "number" && typeof cap === "number" && cap > 0) usedPct = clampPct((used / cap) * 100);
  }
  // A period without a percentage is unknown usage, not zero.
  if (usedPct === null || end === null) return [];
  const windowSec = start !== null && end > start ? Math.round((end - start) / 1000) : null;
  const label = (typeof period.type === "string" && PERIOD_LABELS[period.type]) || "利用枠";
  return [{ id: "credits", label, usedPct, resetsAt: end, windowSec }];
}

export const grok: Provider = {
  type: "grok",
  defaultLabel: "Grok",
  async fetch(config): Promise<UsageReport> {
    const grokHome = process.env.GROK_HOME || join(homedir(), ".grok");
    const path = option(config, "authPath") ?? join(grokHome, "auth.json");
    let credential: ReturnType<typeof pickGrokCredential>;
    try {
      credential = pickGrokCredential(JSON.parse(await readFile(path, "utf8")));
    } catch {
      credential = null;
    }
    if (!credential) return unconfigured("Grok のログイン情報が見つかりません。この開発機で grok login を実行してください。");
    // Grok's login lasts only hours and is renewed only when the CLI runs, so
    // a lapse is routine; the card keeps the last numbers and says so.
    const expired = "ログインの有効期限が切れたため、最後に取得した値を表示しています。grok を一度起動すると更新されます。";
    if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) return failed("dormant", expired);
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "x-xai-token-auth": "xai-grok-cli",
      Accept: "application/json",
      "User-Agent": "spark-lens",
    };
    const [res, settings] = await Promise.all([getJson(BILLING_URL, headers), getJson(SETTINGS_URL, headers, 5_000)]);
    const tier = (settings.body as Record<string, unknown> | null)?.subscription_tier_display;
    const plan = settings.status === 200 && typeof tier === "string" && tier !== "" ? tier : null;
    if (res.status === 401 || res.status === 403) return failed("dormant", expired, plan);
    if (res.status !== 200) return httpFailure(res.status, "Grok", plan);
    const windows = parseGrokBilling(res.body);
    if (windows.length === 0) return failed("error", "使用率が公開されていないため表示できません。", plan);
    // The usage is fine, but a busy or limited settings endpoint still asks for a pause.
    const settingsBusy = settings.status === 0 || settings.status === 429 || settings.status >= 500;
    return { plan, status: "ok", message: null, windows, notes: [], backoff: settingsBusy };
  },
};
