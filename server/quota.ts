import { pace } from "../web/src/pace.ts";
import { type QuotaSeries, type WindowTrend, windowTrend } from "./quota-history.ts";
import type { LlmSnapshot, Snapshot, SubscriptionSnapshot, UsageWindow } from "./types.ts";

/**
 * A routing-oriented view of the subscriptions and local LLMs, for agents
 * deciding where to send work. Pure: the same snapshot gives the same report.
 */

/** Heavy work (implementation, E2E) needs this much headroom; light work (research, drafts) needs the second. */
export const HEAVY_MAX_USED_PCT = 70;
export const LIGHT_MAX_USED_PCT = 90;
/** Subscriptions refresh every 5 minutes; older than this means the fetch has been failing. */
export const STALE_AFTER_SEC = 15 * 60;
/** Pace only means something over a window this long; a 5-hour window swings too much. */
const PACE_MIN_WINDOW_SEC = 24 * 3600;
/** A reset ticket expiring within this is worth spending; it restores the limits, so headroom matters less. */
export const TICKET_SOON_SEC = 72 * 3600;

export type QuotaState = "usable" | "limited" | "loading" | "down" | "unknown";
export type Recommendation = "use" | "avoid_heavy" | "avoid" | "unknown";

export interface QuotaWindow {
  id: string;
  label: string;
  used_pct: number | null;
  resets_at: number | null;
  resets_at_jst: string | null;
  /** Usage share at the end of the window if use continues like this; null when too early to say. */
  projected_end_pct: number | null;
  /** How the window moved; only with `?days=N`, and null when nothing has been recorded for it yet. */
  trend?: WindowTrend | null;
}

/** Asked for with `?days=N`: the readings kept for each window. */
export interface QuotaTrendSource {
  days: number;
  series: (subscription: string, window: string) => QuotaSeries | null;
}

export interface QuotaTicket {
  label: string;
  /** Epoch ms; null when the ticket does not expire. */
  expires_at: number | null;
  expires_at_jst: string | null;
}

export interface QuotaModel {
  id: string;
  label: string;
  kind: "subscription" | "local_llm";
  plan: string | null;
  state: QuotaState;
  recommendation: Recommendation;
  reason: string;
  /** Highest use among the windows, and which window it is. */
  used_pct: number | null;
  binding_window: string | null;
  windows: QuotaWindow[];
  /** When a limited service is usable again (all full windows have reset). */
  recovers_at: number | null;
  recovers_at_jst: string | null;
  reset_tickets: number;
  /** Usable reset tickets, soonest expiry first. */
  tickets: QuotaTicket[];
  /** When these numbers were read; null for local LLMs (they are live). */
  fetched_at: number | null;
  age_sec: number | null;
  stale: boolean;
  /** Local LLMs only: the model name the running server answers to (what a client must ask for), and its load. */
  served_model?: string | null;
  requests_running?: number | null;
  requests_waiting?: number | null;
  /** Local LLMs on TensorFold only: the shared cache pool all conversations draw from, and how much of it is free. */
  pool_tokens?: number | null;
  pool_free_tokens?: number | null;
}

export interface QuotaReport {
  generated_at: number;
  generated_at_jst: string;
  thresholds: { heavy_max_used_pct: number; light_max_used_pct: number; stale_after_sec: number };
  /** The days of history asked for with `?days=N`. */
  trend_days?: number;
  models: QuotaModel[];
}

export function jst(ms: number | null): string | null {
  return ms === null ? null : `${new Date(ms + 9 * 3600_000).toISOString().slice(0, 19)}+09:00`;
}

/** "10/5(月) 08:46" in JST, for reasons read by people. */
function jstShort(ms: number): string {
  const d = new Date(ms + 9 * 3600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]}) ${hm}`;
}

function quotaWindow(w: UsageWindow, now: number, trend?: { sub: string; source: QuotaTrendSource }): QuotaWindow {
  const p = pace(w, now);
  const series = trend ? trend.source.series(trend.sub, w.id) : null;
  return {
    id: w.id,
    label: w.label,
    used_pct: w.usedPct,
    resets_at: w.resetsAt,
    resets_at_jst: jst(w.resetsAt),
    projected_end_pct: p?.projected === null || p === null ? null : Math.round(p.projected),
    ...(trend ? { trend: series ? windowTrend(series, now, trend.source.days) : null } : {}),
  };
}

function subscriptionModel(sub: SubscriptionSnapshot, now: number, trend?: QuotaTrendSource): QuotaModel {
  const base = {
    id: sub.id,
    label: sub.label,
    kind: "subscription" as const,
    plan: sub.plan,
    reset_tickets: sub.tickets.length,
    tickets: sub.tickets.map((t) => ({ label: t.label, expires_at: t.expiresAt, expires_at_jst: jst(t.expiresAt) })),
    fetched_at: sub.fetchedAt,
    age_sec: sub.fetchedAt === null ? null : Math.max(0, Math.round((now - sub.fetchedAt) / 1000)),
  };
  // A reading from the future (clock skew) cannot be called fresh; one whose window already reset describes a window that no longer exists.
  const fromFuture = sub.fetchedAt !== null && sub.fetchedAt > now + 60_000;
  const lapsed = (w: UsageWindow) => w.resetsAt !== null && w.resetsAt <= now;
  const known = sub.windows.filter((w) => w.usedPct !== null && !lapsed(w));
  const hasLapsed = sub.windows.some(lapsed);
  const stale = base.age_sec === null || base.age_sec > STALE_AFTER_SEC || fromFuture || hasLapsed;
  const empty = { used_pct: null, binding_window: null, windows: [], recovers_at: null, recovers_at_jst: null };

  if (sub.status === "unconfigured" || (known.length === 0 && sub.status !== "ok")) {
    const reason = sub.status === "unconfigured" ? "未接続" : sub.status === "stale" ? "ログインが切れている" : "取得できていない";
    return { ...base, ...empty, state: "unknown", recommendation: "unknown", reason, stale: true };
  }
  if (known.length === 0) {
    return { ...base, ...empty, state: "unknown", recommendation: "unknown", reason: "使用率が不明", stale };
  }

  const windows = known.map((w) => quotaWindow(w, now, trend ? { sub: sub.id, source: trend } : undefined));
  const worst = known.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
  const used = worst.usedPct!;
  const full = known.filter((w) => w.usedPct! >= 100);
  const fast = known.find((w) => w.windowSec && w.windowSec >= PACE_MIN_WINDOW_SEC && pace(w, now)?.untilFullSec != null);

  let state: QuotaState = "usable";
  let recommendation: Recommendation;
  let reason: string;
  let recoversAt: number | null = null;
  if (full.length > 0) {
    state = "limited";
    recommendation = "avoid";
    const resets = full.map((w) => w.resetsAt);
    recoversAt = resets.some((r) => r === null) ? null : Math.max(...(resets as number[]));
    reason = `${full.map((w) => w.label).join("・")}が上限`;
  } else if (used > LIGHT_MAX_USED_PCT) {
    recommendation = "avoid";
    reason = `${worst.label}が${Math.round(used)}%`;
  } else if (used > HEAVY_MAX_USED_PCT) {
    recommendation = "avoid_heavy";
    reason = `${worst.label}が${Math.round(used)}%。軽い作業向き`;
  } else if (fast) {
    recommendation = "avoid_heavy";
    reason = `${fast.label}の消費ペースが速く、終了前に上限へ届く見込み`;
  } else {
    recommendation = "use";
    reason = `最大でも${worst.label}の${Math.round(used)}%`;
  }
  const soon = sub.tickets.find((t) => t.expiresAt !== null && t.expiresAt > now && t.expiresAt - now <= TICKET_SOON_SEC * 1000);
  if (soon) {
    const until = jstShort(soon.expiresAt!);
    // A reset restores the limits, so spending it lifts the pace/headroom concern. A limit already hit still needs the ticket used first.
    if (state === "usable" && !stale && recommendation !== "use") {
      recommendation = recommendation === "avoid" ? "avoid_heavy" : "use";
      reason += `。期限が近いリセット券あり（${until}まで）。使えば回復できるので割り振りを増やしてよい`;
    } else {
      reason += `。期限が近いリセット券あり（${until}まで）`;
    }
  }
  if (stale) reason += "（取得が古い）";
  return {
    ...base,
    state,
    recommendation,
    reason,
    used_pct: used,
    binding_window: worst.label,
    windows,
    recovers_at: recoversAt,
    recovers_at_jst: jst(recoversAt),
    stale,
  };
}

function llmModel(llm: LlmSnapshot): QuotaModel {
  const state: QuotaState = llm.state === "up" ? "usable" : llm.state === "starting" ? "loading" : "down";
  const reason =
    llm.state === "up"
      ? `稼働中${llm.requestsWaiting ? `（待ち ${llm.requestsWaiting} 件）` : ""}`
      : llm.state === "starting"
        ? "モデル読み込み中。完了まで指示を送らない"
        : "停止中";
  return {
    id: llm.id,
    label: llm.label,
    kind: "local_llm",
    plan: null,
    state,
    recommendation: llm.state === "up" ? "use" : "avoid",
    reason,
    used_pct: null,
    binding_window: null,
    windows: [],
    recovers_at: null,
    recovers_at_jst: null,
    reset_tickets: 0,
    tickets: [],
    fetched_at: null,
    age_sec: null,
    stale: false,
    served_model: llm.state === "up" ? (llm.models[0] ?? null) : null,
    requests_running: llm.state === "up" ? llm.requestsRunning : null,
    requests_waiting: llm.state === "up" ? llm.requestsWaiting : null,
    pool_tokens: llm.state === "up" ? llm.poolTokens : null,
    pool_free_tokens: llm.state === "up" ? llm.poolFreeTokens : null,
  };
}

export function quotaReport(snapshot: Pick<Snapshot, "subscriptions" | "llms">, now: number, trend?: QuotaTrendSource): QuotaReport {
  return {
    generated_at: now,
    generated_at_jst: jst(now)!,
    thresholds: {
      heavy_max_used_pct: HEAVY_MAX_USED_PCT,
      light_max_used_pct: LIGHT_MAX_USED_PCT,
      stale_after_sec: STALE_AFTER_SEC,
    },
    ...(trend ? { trend_days: trend.days } : {}),
    models: [...snapshot.subscriptions.map((s) => subscriptionModel(s, now, trend)), ...snapshot.llms.map(llmModel)],
  };
}
