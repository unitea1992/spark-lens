import { run } from "../../exec.ts";
import type { UsageWindow } from "../../types.ts";
import { clampPct, failed, getJson, option, parseTime, unconfigured, type Provider, type UsageReport } from "./provider.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const KEY_ENV = "OPENCODE_GO_API_KEY";

const WINDOWS: [string, string, number | null][] = [
  ["rolling", "5時間", 5 * 3600],
  ["weekly", "週間", 7 * 86400],
  ["monthly", "月間", null],
];

export function parseOpencodeGoUsage(body: unknown): UsageWindow[] {
  const usage = (body as Record<string, unknown> | null)?.usage;
  if (usage === null || typeof usage !== "object") return [];
  const u = usage as Record<string, Record<string, unknown> | undefined>;
  const windows: UsageWindow[] = [];
  for (const [key, label, windowSec] of WINDOWS) {
    const w = u[key];
    if (!w || typeof w !== "object") continue;
    windows.push({
      id: key,
      label,
      usedPct: clampPct(w.percent),
      resetsAt: parseTime(w.resetsAt),
      windowSec,
      detail: typeof w.status === "string" && w.status !== "ok" ? w.status : null,
    });
  }
  return windows;
}

/**
 * The key stays in OpenCode's own credential store; ask the CLI for it each
 * time rather than keeping a second copy. OPENCODE_GO_API_KEY overrides this
 * for machines without the CLI.
 */
async function resolveKey(bin: string): Promise<string | null> {
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv) return fromEnv;
  const res = await run(bin, ["auth", "export"], { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(entries)) return null;
    const match = entries.find(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).integrationID === "opencode-go" && (e as Record<string, unknown>).active !== false,
    ) as Record<string, unknown> | undefined;
    const value = match?.value as Record<string, unknown> | undefined;
    return typeof value?.key === "string" && value.key !== "" ? value.key : null;
  } catch {
    return null;
  }
}

export const opencodeGo: Provider = {
  type: "opencode-go",
  defaultLabel: "OpenCode Go",
  async fetch(config): Promise<UsageReport> {
    const key = await resolveKey(option(config, "opencodeBin") ?? "opencode");
    if (!key) {
      return unconfigured(`OpenCode Go の API キーが見つかりません。opencode auth login で接続するか、環境変数 ${KEY_ENV} を設定してください。`);
    }
    const res = await getJson(USAGE_URL, { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "spark-lens" });
    if (res.status === 401 || res.status === 403) return failed("stale", "API キーが無効です。opencode auth login で接続し直してください。", "Go");
    if (res.status !== 200) {
      return failed("error", res.status === 0 ? "opencode.ai に接続できません。" : `使用状況を取得できません（HTTP ${res.status}）。`, "Go");
    }
    const windows = parseOpencodeGoUsage(res.body);
    if (windows.length === 0) return failed("error", "使用状況の形式を読み取れませんでした。", "Go");
    return { plan: "Go", status: "ok", message: null, windows, notes: [] };
  },
};
