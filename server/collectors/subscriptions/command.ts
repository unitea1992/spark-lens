import { run } from "../../exec.ts";
import type { UsageWindow } from "../../types.ts";
import { clampPct, failed, parseTime, unconfigured, type Provider, type UsageReport } from "./provider.ts";

/**
 * Escape hatch for services without a built-in provider: run a local command
 * and read a usage report from its stdout.
 *
 *   { "type": "command", "label": "My plan",
 *     "options": { "command": ["/path/to/script", "--json"] } }
 *
 * The command prints:
 *   { "plan": "Pro", "windows": [ { "id": "weekly", "label": "週間",
 *     "usedPct": 40, "resetsAt": "2026-10-05T00:00:00Z" } ], "notes": [] }
 */
export function parseCommandReport(stdout: string): UsageReport | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.windows)) return null;
  const windows: UsageWindow[] = [];
  o.windows.forEach((raw, i) => {
    if (raw === null || typeof raw !== "object") return;
    const w = raw as Record<string, unknown>;
    windows.push({
      id: typeof w.id === "string" ? w.id : `window-${i}`,
      label: typeof w.label === "string" ? w.label : `#${i + 1}`,
      usedPct: clampPct(w.usedPct),
      resetsAt: parseTime(w.resetsAt),
      detail: typeof w.detail === "string" ? w.detail : null,
    });
  });
  return {
    plan: typeof o.plan === "string" ? o.plan : null,
    status: "ok",
    message: null,
    windows,
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string") : [],
  };
}

export const command: Provider = {
  type: "command",
  defaultLabel: "Custom",
  async fetch(config): Promise<UsageReport> {
    const argv = config.options?.command;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
      return unconfigured('options.command に実行するコマンドを配列で指定してください（例: ["/path/to/script"]）。');
    }
    const [cmd, ...args] = argv as string[];
    const res = await run(cmd!, args, { timeoutMs: 30_000 });
    if (res.code !== 0) return failed("error", res.timedOut ? "コマンドがタイムアウトしました。" : "コマンドが失敗しました。");
    return parseCommandReport(res.stdout) ?? failed("error", "コマンドの出力を使用状況として読み取れませんでした。");
  },
};
