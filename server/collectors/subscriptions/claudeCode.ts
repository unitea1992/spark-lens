import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "../../types.ts";
import { clampPct, failed, getJson, httpFailure, option, parseTime, unconfigured, type Provider, type UsageReport } from "./provider.ts";

// Claude Code keeps its subscription login here and refreshes it itself. This
// provider only ever reads the current access token: refreshing from a second
// process would rotate the refresh token out from under the CLI.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The login file keeps the plan from login time; the profile follows upgrades.
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// Plans change rarely and the usage API is easily rate-limited: ask hourly.
const PROFILE_TTL_MS = 3600_000;
const profileCache = new Map<string, { plan: string; at: number }>();

const PLAN_NAMES: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };

function planName(subscriptionType: unknown, tier: unknown): string | null {
  if (typeof subscriptionType !== "string") return null;
  const base = PLAN_NAMES[subscriptionType] ?? subscriptionType;
  const multiplier = typeof tier === "string" ? /(\d+)x/.exec(tier)?.[1] : undefined;
  return multiplier ? `${base} ${multiplier}x` : base;
}

const ORG_TYPES: Record<string, string> = { claude_max: "max", claude_pro: "pro", claude_team: "team", claude_enterprise: "enterprise" };

/** The current plan from the OAuth profile; null when the profile does not name one. */
export function profilePlan(body: unknown): string | null {
  const org = (body as { organization?: Record<string, unknown> | null } | null)?.organization;
  if (!org || typeof org.organization_type !== "string") return null;
  return planName(ORG_TYPES[org.organization_type] ?? null, org.rate_limit_tier);
}

const LIMIT_LABELS: Record<string, string> = {
  session: "5時間",
  weekly_all: "週間（全モデル）",
  weekly_scoped: "週間",
};

/** A scoped limit names the model or surface it applies to. */
function scopeName(scope: unknown): string | null {
  if (typeof scope === "string") return scope || null;
  if (scope === null || typeof scope !== "object") return null;
  const s = scope as { model?: { display_name?: unknown } | null; surface?: unknown };
  if (typeof s.model?.display_name === "string" && s.model.display_name) return s.model.display_name;
  if (typeof s.surface === "string" && s.surface) return s.surface;
  return null;
}

interface Bucket {
  utilization?: unknown;
  resets_at?: unknown;
}

export function parseClaudeUsage(body: unknown): UsageWindow[] {
  if (body === null || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;
  const windows: UsageWindow[] = [];

  // Newer responses carry a ready-made list; older ones only named buckets.
  if (Array.isArray(o.limits) && o.limits.length > 0) {
    o.limits.forEach((raw, i) => {
      if (raw === null || typeof raw !== "object") return;
      const l = raw as Record<string, unknown>;
      const kind = typeof l.kind === "string" ? l.kind : `limit-${i}`;
      const scope = scopeName(l.scope);
      const base = LIMIT_LABELS[kind] ?? kind;
      const resetsAt = parseTime(l.resets_at);
      windows.push({
        id: scope ? `${kind}:${scope}` : kind,
        label: scope ? `${base}（${scope}）` : base,
        usedPct: clampPct(l.percent),
        resetsAt,
        windowSec: kind === "session" ? 5 * 3600 : l.group === "weekly" ? 7 * 86400 : null,
        // The 5-hour window only starts with the next message.
        idle: resetsAt === null,
      });
    });
    return windows;
  }

  const named: [string, string, number][] = [
    ["five_hour", "5時間", 5 * 3600],
    ["seven_day", "週間（全モデル）", 7 * 86400],
    ["seven_day_opus", "週間（Opus）", 7 * 86400],
    ["seven_day_sonnet", "週間（Sonnet）", 7 * 86400],
  ];
  for (const [key, label, windowSec] of named) {
    const b = o[key] as Bucket | null | undefined;
    if (!b || typeof b !== "object") continue;
    const resetsAt = parseTime(b.resets_at);
    windows.push({ id: key, label, usedPct: clampPct(b.utilization), resetsAt, windowSec, idle: resetsAt === null });
  }
  return windows;
}

function extraUsageNote(body: unknown): string[] {
  const extra = (body as Record<string, unknown> | null)?.extra_usage as Record<string, unknown> | undefined;
  if (!extra || extra.is_enabled !== true) return [];
  const pct = clampPct(extra.utilization);
  return [pct === null ? "追加利用枠: 有効" : `追加利用枠: ${Math.round(pct)}% 使用`];
}

export const claudeCode: Provider = {
  type: "claude-code",
  defaultLabel: "Claude Code",
  async fetch(config): Promise<UsageReport> {
    const path = option(config, "credentialsPath") ?? join(homedir(), ".claude", ".credentials.json");
    let oauth: Record<string, unknown>;
    try {
      oauth = JSON.parse(await readFile(path, "utf8")).claudeAiOauth ?? {};
    } catch {
      return unconfigured("Claude Code のログイン情報が見つかりません。この開発機で claude にログインしてください。");
    }
    const token = oauth.accessToken;
    let plan = planName(oauth.subscriptionType, oauth.rateLimitTier);
    if (typeof token !== "string" || token === "") {
      return unconfigured("Claude Code がサブスクリプションでログインされていません。");
    }
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
      return failed("stale", "ログインの有効期限が切れています。Claude Code を一度起動すると更新されます。", plan);
    }
    const headers = { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };
    const cached = profileCache.get(path);
    const fresh = cached !== undefined && Date.now() - cached.at < PROFILE_TTL_MS;
    const [res, profile] = await Promise.all([getJson(USAGE_URL, headers), fresh ? null : getJson(PROFILE_URL, headers)]);
    const fromProfile = profile?.status === 200 ? profilePlan(profile.body) : null;
    if (fromProfile) profileCache.set(path, { plan: fromProfile, at: Date.now() });
    plan = fromProfile ?? cached?.plan ?? plan;
    if (res.status === 401 || res.status === 403) {
      return failed("stale", "ログインの有効期限が切れています。Claude Code を一度起動すると更新されます。", plan);
    }
    if (res.status !== 200) return httpFailure(res.status, "Anthropic", plan);
    const windows = parseClaudeUsage(res.body);
    if (windows.length === 0) return failed("error", "使用状況の形式を読み取れませんでした。", plan);
    return { plan, status: "ok", message: null, windows, notes: extraUsageNote(res.body) };
  },
};
