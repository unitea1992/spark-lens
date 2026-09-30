import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "../../types.ts";
import { clampPct, failed, getJson, option, parseTime, unconfigured, type Provider, type UsageReport } from "./provider.ts";

// Claude Code keeps its subscription login here and refreshes it itself. This
// provider only ever reads the current access token: refreshing from a second
// process would rotate the refresh token out from under the CLI.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const PLAN_NAMES: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };

function planName(subscriptionType: unknown, tier: unknown): string | null {
  if (typeof subscriptionType !== "string") return null;
  const base = PLAN_NAMES[subscriptionType] ?? subscriptionType;
  const multiplier = typeof tier === "string" ? /(\d+)x/.exec(tier)?.[1] : undefined;
  return multiplier ? `${base} ${multiplier}x` : base;
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
      windows.push({
        id: scope ? `${kind}:${scope}` : kind,
        label: scope ? `${base}（${scope}）` : base,
        usedPct: clampPct(l.percent),
        resetsAt: parseTime(l.resets_at),
        windowSec: kind === "session" ? 5 * 3600 : l.group === "weekly" ? 7 * 86400 : null,
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
    windows.push({ id: key, label, usedPct: clampPct(b.utilization), resetsAt: parseTime(b.resets_at), windowSec });
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
    const plan = planName(oauth.subscriptionType, oauth.rateLimitTier);
    if (typeof token !== "string" || token === "") {
      return unconfigured("Claude Code がサブスクリプションでログインされていません。");
    }
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
      return failed("stale", "ログインの有効期限が切れています。Claude Code を一度起動すると更新されます。", plan);
    }
    const res = await getJson(USAGE_URL, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });
    if (res.status === 401 || res.status === 403) {
      return failed("stale", "ログインの有効期限が切れています。Claude Code を一度起動すると更新されます。", plan);
    }
    if (res.status !== 200) {
      return failed("error", res.status === 0 ? "Anthropic に接続できません。" : `使用状況を取得できません（HTTP ${res.status}）。`, plan);
    }
    const windows = parseClaudeUsage(res.body);
    if (windows.length === 0) return failed("error", "使用状況の形式を読み取れませんでした。", plan);
    return { plan, status: "ok", message: null, windows, notes: extraUsageNote(res.body) };
  },
};
