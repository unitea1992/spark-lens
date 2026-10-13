import { elapsedPct, pace } from "../web/src/pace.ts";
import { type QuotaSeries, type WindowTrend, latestAllowanceReset, windowTrend } from "./quota-history.ts";
import type { LlmSnapshot, ResetTicket, Snapshot, SubscriptionSnapshot, UsageWindow } from "./types.ts";

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
/** |used − elapsed| within this many points counts as on pace. */
const PACE_ON_BAND_PCT = 10;
/** Surplus is called only in the second half, and only when use lags the calendar by this many points. */
const SURPLUS_ELAPSED_PCT = 50;
const SURPLUS_GAP_PCT = 15;
/** A weekly cadence is preferred for ticket deadlines; anything longer is the fallback. */
const WEEKLY_MAX_SEC = 8 * 86400;
/** Readings after an unannounced refill have to cover this long before they replace the projection. */
const MIN_PROJECT_HOURS = 2;

export type QuotaState = "usable" | "limited" | "loading" | "down" | "unknown";
export type Recommendation = "use" | "avoid_heavy" | "avoid" | "unknown";
/** under: use lags the calendar. on: within 10 points of it. over: ahead of it. */
export type PaceJudgment = "under" | "on" | "over";

/** How to spend a long window so it is used up by the reset, without going over. */
export interface WindowPlan {
  /** Share of the window still unused. */
  remaining_pct: number;
  /** Days until this window resets. */
  days_until_reset: number;
  /** Remaining share divided by the days left: the per-day budget that lands on 100% at the reset. */
  daily_allowance_pct: number;
  /** Share of the window that has already passed. */
  elapsed_pct: number;
  pace: PaceJudgment;
}

export interface QuotaWindow {
  id: string;
  label: string;
  used_pct: number | null;
  resets_at: number | null;
  resets_at_jst: string | null;
  /**
   * Usage share at the end of the window if use continues like this; null when too early to say.
   * After an unannounced refill, this is computed from readings taken after that refill only.
   */
  projected_end_pct: number | null;
  /** When an unannounced refill was seen. Null when usage only fell at a scheduled reset. */
  allowance_reset_at: number | null;
  allowance_reset_at_jst: string | null;
  /** Set for windows of at least a day whose position is known. Null for a 5-hour window. */
  plan: WindowPlan | null;
  /** How the window moved; only with `?days=N`, and null when nothing has been recorded for it yet. */
  trend?: WindowTrend | null;
}

/**
 * Readings kept for each window. `days` is set only when the caller asked for
 * `?days=N`; the readings are still used to correct `projected_end_pct`.
 */
export interface QuotaTrendSource {
  days?: number;
  series: (subscription: string, window: string) => QuotaSeries | null;
}

export interface QuotaTicket {
  label: string;
  /** Epoch ms; null when the ticket does not expire. */
  expires_at: number | null;
  expires_at_jst: string | null;
  /**
   * Latest time to spend this ticket so earlier tickets keep a slot and this one does not expire unused.
   * Null when it does not expire, or already has.
   */
  use_by: number | null;
  use_by_jst: string | null;
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function windowPlan(w: UsageWindow, now: number): WindowPlan | null {
  if (w.usedPct === null || w.windowSec == null || w.windowSec < PACE_MIN_WINDOW_SEC || w.resetsAt === null) return null;
  const elapsed = elapsedPct(w, now);
  if (elapsed === null) return null;
  const remaining = Math.max(0, Math.round(100 - w.usedPct));
  const days = (w.resetsAt - now) / 86_400_000;
  const gap = w.usedPct - elapsed;
  const judgment: PaceJudgment = gap > PACE_ON_BAND_PCT ? "over" : gap < -PACE_ON_BAND_PCT ? "under" : "on";
  return {
    remaining_pct: remaining,
    days_until_reset: round1(days),
    // The last fraction of a day still has a per-day budget; dividing by a few minutes would shout thousands of percent.
    daily_allowance_pct: round1(remaining / Math.max(days, 1 / 24)),
    elapsed_pct: round1(elapsed),
    pace: judgment,
  };
}

/**
 * End-of-window share. After an unannounced refill the average since the
 * nominal window start counts usage that was wiped, so the rate is taken
 * from readings at and after the refill. Until those cover two hours the
 * old average is withheld rather than shown.
 */
function projectEnd(w: UsageWindow, now: number, series: QuotaSeries | null): { projected: number | null; allowanceResetAt: number | null } {
  // A refill from a window that already ended must not set the rate for the one open now.
  // An hour of slack covers Codex sliding `reset_at` forward while the new window is still at 0%.
  const windowStart = w.resetsAt !== null && w.windowSec != null ? w.resetsAt - w.windowSec * 1000 : null;
  const raw = series ? latestAllowanceReset(series, now) : null;
  const drop = raw && (windowStart === null || raw.at >= windowStart - 3_600_000) ? raw : null;
  if (drop && w.usedPct !== null && w.resetsAt !== null && w.resetsAt > now) {
    const after = series!.points.filter((p) => p[0] >= drop.at && p[0] <= now);
    if (after.length >= 2) {
      const first = after[0]!;
      const last = after[after.length - 1]!;
      const hours = (last[0] - first[0]) / 3_600_000;
      if (hours >= MIN_PROJECT_HOURS) {
        const rate = (last[1] - first[1]) / hours;
        const remainH = (w.resetsAt - now) / 3_600_000;
        return { projected: Math.round(Math.max(0, w.usedPct + rate * remainH)), allowanceResetAt: drop.at };
      }
    }
    return { projected: null, allowanceResetAt: drop.at };
  }
  const p = pace(w, now);
  return { projected: p === null || p.projected === null ? null : Math.round(p.projected), allowanceResetAt: null };
}

interface Cadence {
  resetsAt: number;
  windowSec: number;
}

/** The next long window. A weekly one wins over a longer one, and the soonest reset wins a tie. */
function planCadence(windows: UsageWindow[], now: number): Cadence | null {
  const long = windows.filter((w) => w.resetsAt !== null && w.resetsAt > now && w.windowSec != null && w.windowSec >= PACE_MIN_WINDOW_SEC);
  if (long.length === 0) return null;
  const weekly = long.filter((w) => w.windowSec! <= WEEKLY_MAX_SEC);
  const pool = weekly.length > 0 ? weekly : long;
  const chosen = pool.reduce((a, b) => (a.resetsAt! <= b.resetsAt! ? a : b));
  return { resetsAt: chosen.resetsAt!, windowSec: chosen.windowSec! };
}

/**
 * One ticket per window, soonest expiry first, each taking the latest window
 * end that still falls on or before its expiry. A ticket left without a slot
 * has to be spent by its own expiry or it outnumbers the resets before then.
 */
function presentTickets(tickets: ResetTicket[], now: number, cadence: Cadence | null): QuotaTicket[] {
  const expiring = tickets
    .map((t, index) => ({ t, index }))
    .filter((x) => x.t.expiresAt !== null && x.t.expiresAt > now)
    .sort((a, b) => a.t.expiresAt! - b.t.expiresAt! || a.index - b.index);
  const horizon = expiring.length > 0 ? expiring[expiring.length - 1]!.t.expiresAt! : now;
  const ends: number[] = [];
  if (cadence && cadence.windowSec > 0) {
    const step = cadence.windowSec * 1000;
    let end = cadence.resetsAt;
    while (end <= now) end += step;
    for (let i = 0; i < 36 && end <= horizon; i++) {
      ends.push(end);
      end += step;
    }
  }
  const taken = new Set<number>();
  const useBy = new Map<number, number>();
  for (const { t, index } of expiring) {
    const exp = t.expiresAt!;
    const open = ends.filter((e) => e <= exp && !taken.has(e));
    if (open.length > 0) {
      const chosen = open[open.length - 1]!;
      taken.add(chosen);
      useBy.set(index, chosen);
    } else {
      useBy.set(index, exp);
    }
  }
  return tickets.map((t, index) => {
    const by = useBy.get(index) ?? null;
    return { label: t.label, expires_at: t.expiresAt, expires_at_jst: jst(t.expiresAt), use_by: by, use_by_jst: jst(by) };
  });
}

function quotaWindow(w: UsageWindow, now: number, history?: { sub: string; source: QuotaTrendSource }): QuotaWindow {
  const series = history ? history.source.series(history.sub, w.id) : null;
  const projected = projectEnd(w, now, series);
  const days = history?.source.days;
  return {
    id: w.id,
    label: w.label,
    used_pct: w.usedPct,
    resets_at: w.resetsAt,
    resets_at_jst: jst(w.resetsAt),
    projected_end_pct: projected.projected,
    allowance_reset_at: projected.allowanceResetAt,
    allowance_reset_at_jst: jst(projected.allowanceResetAt),
    plan: windowPlan(w, now),
    ...(days !== undefined ? { trend: series ? windowTrend(series, now, days) : null } : {}),
  };
}

function subscriptionModel(sub: SubscriptionSnapshot, now: number, trend?: QuotaTrendSource): QuotaModel {
  const base = {
    id: sub.id,
    label: sub.label,
    kind: "subscription" as const,
    plan: sub.plan,
    reset_tickets: sub.tickets.length,
    tickets: presentTickets(sub.tickets, now, planCadence(sub.windows, now)),
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
  const fast = windows.find((w) => {
    const src = known.find((k) => k.id === w.id);
    return src?.windowSec != null && src.windowSec >= PACE_MIN_WINDOW_SEC && w.projected_end_pct !== null && w.projected_end_pct > 100;
  });

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
  const planned = base.tickets.filter(
    (t) => t.use_by !== null && t.expires_at !== null && t.use_by - now <= TICKET_SOON_SEC * 1000 && t.expires_at - t.use_by >= 3_600_000,
  );
  if (planned.length > 0) {
    const when = [...new Set(planned.map((t) => jstShort(t.use_by!)))].join("、");
    reason += `。リセット券は${when}までに使う計画`;
  }
  if (!stale && state !== "limited") {
    const behind = windows.filter((w) => w.plan !== null && w.plan.elapsed_pct >= SURPLUS_ELAPSED_PCT && w.plan.elapsed_pct - (w.used_pct ?? 0) >= SURPLUS_GAP_PCT);
    if (behind.length > 0) reason += `。${behind.map((w) => w.label).join("・")}は余りそう。割り振りを増やしてよい`;
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
    ...(trend?.days !== undefined ? { trend_days: trend.days } : {}),
    models: [...snapshot.subscriptions.map((s) => subscriptionModel(s, now, trend)), ...snapshot.llms.map(llmModel)],
  };
}
