import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResetTicket, UsageWindow } from "../../types.ts";
import { clampPct, failed, getJson, httpFailure, option, parseTime, unconfigured, type Provider, type UsageReport } from "./provider.ts";

// Same read-only rule as Claude Code: the Codex CLI owns token refresh.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// Read-only list of granted limit resets. (Redeeming one is a separate POST this code never makes.)
const RESETS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

function windowLabel(seconds: number | null, fallback: string): string {
  if (seconds === null) return fallback;
  if (seconds <= 6 * 3600) return `${Math.round(seconds / 3600)}時間`;
  if (seconds === 86400) return "24時間";
  if (seconds === 7 * 86400) return "週間";
  return `${Math.round(seconds / 86400)}日間`;
}

function parseWindow(raw: unknown, id: string, fallback: string): UsageWindow | null {
  if (raw === null || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const seconds = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : null;
  return {
    id,
    label: windowLabel(seconds, fallback),
    usedPct: clampPct(w.used_percent),
    resetsAt: parseTime(w.reset_at),
    windowSec: seconds,
  };
}

export function parseCodexUsage(body: unknown): { plan: string | null; windows: UsageWindow[]; notes: string[] } {
  if (body === null || typeof body !== "object") return { plan: null, windows: [], notes: [] };
  const o = body as Record<string, unknown>;
  const planRaw = typeof o.plan_type === "string" ? o.plan_type : null;
  const plan = planRaw ? `ChatGPT ${PLAN_NAMES[planRaw] ?? planRaw}` : null;
  const limit = (o.rate_limit ?? {}) as Record<string, unknown>;
  const windows = [
    parseWindow(limit.primary_window, "primary", "短期"),
    parseWindow(limit.secondary_window, "secondary", "長期"),
  ].filter((w): w is UsageWindow => w !== null);

  const notes: string[] = [];
  if (limit.limit_reached === true) notes.push("上限に達しています");
  const credits = o.credits as Record<string, unknown> | undefined;
  if (credits?.has_credits === true && typeof credits.balance === "string") notes.push(`クレジット残高 ${credits.balance}`);
  return { plan, windows, notes };
}

const TICKET_LABELS: Record<string, string> = { "Full reset (Weekly + 5 hr)": "週間＋5時間の全リセット" };

export function parseCodexResets(body: unknown): ResetTicket[] {
  const credits = (body as Record<string, unknown> | null)?.credits;
  if (!Array.isArray(credits)) return [];
  const tickets: ResetTicket[] = [];
  for (const raw of credits) {
    if (raw === null || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (c.status !== "available" || c.is_supported_by_plan === false) continue;
    const title = typeof c.title === "string" ? c.title : "リセット";
    tickets.push({ label: TICKET_LABELS[title] ?? title, expiresAt: parseTime(c.expires_at) });
  }
  // Soonest to expire first: that is the one to use.
  return tickets.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

export const codex: Provider = {
  type: "codex",
  defaultLabel: "Codex",
  async fetch(config): Promise<UsageReport> {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const path = option(config, "authPath") ?? join(codexHome, "auth.json");
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return unconfigured("Codex のログイン情報が見つかりません。この開発機で codex にログインしてください。");
    }
    const tokens = (auth.tokens ?? {}) as Record<string, unknown>;
    if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string") {
      return unconfigured("Codex が ChatGPT アカウントでログインされていません（API キー利用では使用枠を取得できません）。");
    }
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      "chatgpt-account-id": tokens.account_id,
      Accept: "application/json",
      "User-Agent": "spark-lens",
    };
    const [res, resets] = await Promise.all([getJson(USAGE_URL, headers), getJson(RESETS_URL, headers)]);
    if (res.status === 401 || res.status === 403) {
      return failed("stale", "ログインの有効期限が切れています。Codex を一度起動すると更新されます。");
    }
    if (res.status !== 200) return httpFailure(res.status, "ChatGPT");
    const { plan, windows, notes } = parseCodexUsage(res.body);
    if (windows.length === 0) return failed("error", "使用状況の形式を読み取れませんでした。", plan);
    return { plan, status: "ok", message: null, windows, notes, tickets: resets.status === 200 ? parseCodexResets(resets.body) : [] };
  },
};
