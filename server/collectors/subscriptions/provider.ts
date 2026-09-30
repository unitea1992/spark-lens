import type { SubscriptionConfig, SubscriptionStatus, UsageWindow } from "../../types.ts";

/** What a provider returns from one poll. */
export interface UsageReport {
  plan: string | null;
  status: SubscriptionStatus;
  /** Shown to the user when status is not "ok". Must never contain a credential. */
  message: string | null;
  windows: UsageWindow[];
  notes: string[];
}

export interface Provider {
  /** Matches SubscriptionConfig.type. */
  type: string;
  defaultLabel: string;
  fetch(config: SubscriptionConfig): Promise<UsageReport>;
}

export function unconfigured(message: string): UsageReport {
  return { plan: null, status: "unconfigured", message, windows: [], notes: [] };
}

export function failed(status: "stale" | "error", message: string, plan: string | null = null): UsageReport {
  return { plan, status, message, windows: [], notes: [] };
}

export function option(config: SubscriptionConfig, key: string): string | undefined {
  const v = config.options?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

/** GET a JSON document. Network failures surface as status 0. */
export async function getJson(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<JsonResponse> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export function clampPct(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

export function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
