import { jst, jstShort } from "./jst.ts";
import { planCadence, presentTickets } from "./quota-tickets.ts";
import { quotaWindow } from "./quota-window.ts";
import type { QuotaSeries, WindowTrend } from "./quota-history.ts";
import type { LlmSnapshot, Snapshot, SubscriptionSnapshot, UsageWindow } from "./types.ts";

/**
 * A routing-oriented view of the subscriptions and local LLMs, for agents
 * deciding where to send work. Pure: the same snapshot gives the same report.
 * The window projections are in quota-window.ts, the reset-ticket plan in quota-tickets.ts.
 */

/** Heavy work (implementation, E2E) needs this much headroom; light work (research, drafts) needs the second. */
export const HEAVY_MAX_USED_PCT = 70;
export const LIGHT_MAX_USED_PCT = 90;
/** Subscriptions refresh every 5 minutes; older than this means the fetch has been failing. */
export const STALE_AFTER_SEC = 15 * 60;
/** A reset ticket expiring within this is worth spending; it restores the limits, so headroom matters less. */
export const TICKET_SOON_SEC = 72 * 3600;
/** Surplus is called only in the second half, and only when use lags the calendar by this many points, or the recent pace ends short of full. */
const SURPLUS_ELAPSED_PCT = 50;
const SURPLUS_GAP_PCT = 15;
/** A long window this full is not given heavy work whatever its pace says; one more task could end it. */
const NEARLY_FULL_PCT = 95;
/** A window projected to end this many points short of full has room to spare. */
const SURPLUS_LEFT_PCT = 10;

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
  /** Remaining share divided by the days left until the reset, or until a plan change that arrives first. */
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
   * Usage share at the end of the window if use continues at the speed of the last 24 hours. Without enough readings,
   * the window average from its first hour on, unless a refill or plan change makes it misleading; null when too early to say.
   * That speed counts use on both sides of a reset or refill (they zero the counter, not the limit), not before a plan change.
   */
  projected_end_pct: number | null;
  /** When an unannounced refill was seen. Null when usage only fell at a scheduled reset. */
  allowance_reset_at: number | null;
  allowance_reset_at_jst: string | null;
  /** When the plan name changed inside this window. Percentages before this use a different denominator. */
  plan_changed_at: number | null;
  plan_changed_at_jst: string | null;
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
   * Best time to spend this ticket: when the window is full, or earlier when it would otherwise expire unused.
   * Null when it does not expire, or already has.
   */
  use_at: number | null;
  use_at_jst: string | null;
  /**
   * Extra percentage points per day, above the ordinary fill-by-reset budget, so the window is full at `use_at`.
   * Null when the ordinary budget already gets there.
   */
  extra_daily_pct: number | null;
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
  /** Next known plan change. The daily budget stops there, because the percentage's denominator changes. */
  renews_at: number | null;
  renews_at_jst: string | null;
  next_plan: string | null;
  /** When these numbers were read; null for local LLMs (they are live). */
  fetched_at: number | null;
  age_sec: number | null;
  stale: boolean;
  /** Local LLMs only: the model name the running server answers to (what a client must ask for), and its load. */
  served_model?: string | null;
  requests_running?: number | null;
  requests_waiting?: number | null;
  /** Local LLMs only: how many requests the server handles at once; null when its start-up command does not say. */
  max_concurrent?: number | null;
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

function subscriptionModel(sub: SubscriptionSnapshot, now: number, trend?: QuotaTrendSource): QuotaModel {
  // A date already past is not the next change. Leaving it in place would also drop every later ticket slot.
  const renewsAt = sub.renewsAt != null && sub.renewsAt > now ? sub.renewsAt : null;
  const cadence = planCadence(sub.windows, now);
  const base = {
    id: sub.id,
    label: sub.label,
    kind: "subscription" as const,
    plan: sub.plan,
    reset_tickets: sub.tickets.length,
    tickets: presentTickets(sub.tickets, now, cadence, null, null, renewsAt),
    renews_at: renewsAt,
    renews_at_jst: jst(renewsAt),
    next_plan: renewsAt !== null ? (sub.nextPlan ?? null) : null,
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

  const windows = known.map((w) => quotaWindow(w, now, renewsAt, trend ? { sub: sub.id, source: trend } : undefined));
  const worst = known.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
  const used = worst.usedPct!;
  const full = known.filter((w) => w.usedPct! >= 100);
  // A long window is judged by where it ends at its recent speed; a short one (or one whose end is unknown) by how full it is.
  const verdictOf = (w: QuotaWindow, src: UsageWindow): { rec: Recommendation; reason: string } | null => {
    const u = src.usedPct!;
    const longKnown = w.plan !== null && w.projected_end_pct !== null;
    if (!longKnown) {
      if (u > LIGHT_MAX_USED_PCT) return { rec: "avoid", reason: `${w.label}が${Math.round(u)}%` };
      if (u > HEAVY_MAX_USED_PCT) return { rec: "avoid_heavy", reason: `${w.label}が${Math.round(u)}%。軽い作業向き` };
      return null;
    }
    const end = w.projected_end_pct!;
    if (end > 100) {
      if (u > LIGHT_MAX_USED_PCT) return { rec: "avoid", reason: `${w.label}が${Math.round(u)}%で、最近のペースだと上限を超える見込み` };
      return { rec: "avoid_heavy", reason: `${w.label}の最近の消費ペースが速く、リセット前に上限へ届く見込み（約${end}%）` };
    }
    if (u >= NEARLY_FULL_PCT) return { rec: "avoid", reason: `${w.label}が${Math.round(u)}%` };
    return null;
  };
  const rank: Record<Recommendation, number> = { use: 0, avoid_heavy: 1, avoid: 2, unknown: 3 };
  let verdict: { rec: Recommendation; reason: string } | null = null;
  windows.forEach((w, i) => {
    const v = verdictOf(w, known[i]!);
    if (v && (verdict === null || rank[v.rec] > rank[verdict.rec])) verdict = v;
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
  } else if (verdict !== null) {
    const v = verdict as { rec: Recommendation; reason: string };
    recommendation = v.rec;
    reason = v.reason;
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
  const cadenceWindow = cadence ? windows.find((w) => w.id === cadence.id) : undefined;
  const tickets = presentTickets(sub.tickets, now, cadence, cadenceWindow?.used_pct ?? null, cadenceWindow?.projected_end_pct ?? null, renewsAt);
  const planned = tickets.filter((t) => t.use_at !== null && t.use_at - now <= TICKET_SOON_SEC * 1000);
  if (planned.length > 0) {
    const when = [...new Set(planned.map((t) => jstShort(t.use_at!)))].join("、");
    reason += `。リセット券は${when}に使うのがよい`;
    const extra = planned.find((t) => t.extra_daily_pct !== null);
    if (extra?.extra_daily_pct != null) reason += `。その週は1日あたり${extra.extra_daily_pct}%多く使う`;
  }
  if (!stale && state !== "limited") {
    const behind = windows.filter(
      (w) =>
        w.plan !== null &&
        w.plan.elapsed_pct >= SURPLUS_ELAPSED_PCT &&
        (w.plan.elapsed_pct - (w.used_pct ?? 0) >= SURPLUS_GAP_PCT || (w.projected_end_pct !== null && w.projected_end_pct <= 100 - SURPLUS_LEFT_PCT)),
    );
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
    tickets,
    recovers_at: recoversAt,
    recovers_at_jst: jst(recoversAt),
    stale,
  };
}

function llmModel(llm: LlmSnapshot): QuotaModel {
  const state: QuotaState = llm.state === "up" ? "usable" : llm.state === "starting" ? "loading" : "down";
  const up = llm.state === "up";
  const max = up ? llm.maxConcurrent : null;
  // At the limit, one more request waits in line or pushes another conversation's cache out; a queue without a known limit is the same signal.
  const full = max !== null && (llm.requestsRunning ?? 0) >= max;
  const queued = up && (llm.requestsWaiting ?? 0) > 0;
  let reason = up
    ? `稼働中${llm.requestsWaiting ? `（待ち ${llm.requestsWaiting} 件）` : ""}`
    : llm.state === "starting"
      ? "モデル読み込み中。完了まで指示を送らない"
      : "停止中";
  let recommendation: Recommendation = up ? "use" : "avoid";
  if (full) {
    recommendation = "avoid";
    reason = `同時 ${max} 本の上限に達している。追加で振らない${queued ? `（待ち ${llm.requestsWaiting} 件）` : ""}`;
  } else if (queued) {
    recommendation = "avoid_heavy";
    reason += "。待ちがあるので追加で振らない";
  }
  return {
    id: llm.id,
    label: llm.label,
    kind: "local_llm",
    plan: null,
    state,
    recommendation,
    reason,
    used_pct: null,
    binding_window: null,
    windows: [],
    recovers_at: null,
    recovers_at_jst: null,
    reset_tickets: 0,
    tickets: [],
    renews_at: null,
    renews_at_jst: null,
    next_plan: null,
    fetched_at: null,
    age_sec: null,
    stale: false,
    served_model: llm.state === "up" ? (llm.models[0] ?? null) : null,
    requests_running: llm.state === "up" ? llm.requestsRunning : null,
    requests_waiting: llm.state === "up" ? llm.requestsWaiting : null,
    max_concurrent: max,
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

/** Compact routing view, retaining every reported window even when its reading is unknown. */
export function quotaBrief(snapshot: Pick<Snapshot, "subscriptions" | "llms">, now: number, trend?: QuotaTrendSource) {
  return {
    generated_at_jst: jst(now)!,
    models: [
      ...snapshot.subscriptions.map((sub) => {
        const model = subscriptionModel(sub, now, trend);
        const next = model.tickets.map((ticket) => ticket.use_at).filter((time): time is number => time !== null);
        return {
          id: model.id, label: model.label, kind: model.kind, state: model.state,
          windows: sub.windows.map((w) => ({ id: w.id, label: w.label, used_pct: w.usedPct, resets_at_jst: jst(w.resetsAt) })),
          ...(model.reset_tickets > 0 ? { tickets: { remaining: model.reset_tickets, next_at_jst: jst(next.length ? Math.min(...next) : null) } } : {}),
        };
      }),
      ...snapshot.llms.map((llm) => {
        const m = llmModel(llm);
        return { id: m.id, label: m.label, kind: m.kind, state: m.state, windows: [], served_model: m.served_model,
          requests_running: m.requests_running, requests_waiting: m.requests_waiting, max_concurrent: m.max_concurrent,
          pool_tokens: m.pool_tokens, pool_free_tokens: m.pool_free_tokens };
      }),
    ],
  };
}
