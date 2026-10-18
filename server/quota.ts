import { pace } from "../web/src/pace.ts";
import { type QuotaSeries, type WindowTrend, latestAllowanceReset, latestPlanChange, windowTrend } from "./quota-history.ts";
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
/** Surplus is called only in the second half, and only when use lags the calendar by this many points, or the recent pace ends short of full. */
const SURPLUS_ELAPSED_PCT = 50;
const SURPLUS_GAP_PCT = 15;
/** A weekly cadence is preferred for ticket deadlines; anything longer is the fallback. */
const WEEKLY_MAX_SEC = 8 * 86400;
/** The speed needs readings covering this long; minutes of readings scaled to hours swing wildly. */
const MIN_PROJECT_HOURS = 2;
/** Speed is read over the last day of readings: a whole day evens out working and sleeping hours, and still follows a changed pace. */
const PACE_HOURS = 24;
/** The speed is stretched over at most this many times the time it was read over; one step of use must not swing a week. */
const MAX_STRETCH = 24;
/** A long window this full is not given heavy work whatever its pace says; one more task could end it. */
const NEARLY_FULL_PCT = 95;
/** A window projected to end this many points short of full has room to spare. */
const SURPLUS_LEFT_PCT = 10;
/** A window this full is already worth a reset ticket; waiting longer only blocks work. */
const NEAR_LIMIT_PCT = 90;
/** A refill or plan change this long before the nominal window start still belongs to it (Codex slides `reset_at` while at 0%). */
const BASIS_SLACK_MS = 3_600_000;

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

function windowPlan(w: UsageWindow, now: number, anchorAt: number | null, horizonAt: number | null): WindowPlan | null {
  if (w.usedPct === null || w.windowSec == null || w.windowSec < PACE_MIN_WINDOW_SEC || w.resetsAt === null || w.resetsAt <= now) return null;
  const start = w.resetsAt - w.windowSec * 1000;
  const horizon = horizonAt !== null && horizonAt > now && horizonAt < w.resetsAt ? horizonAt : w.resetsAt;
  const anchor = anchorAt !== null && anchorAt > start && anchorAt < horizon ? anchorAt : start;
  if (horizon <= anchor || now < anchor) return null;
  const elapsed = ((now - anchor) / (horizon - anchor)) * 100;
  if (elapsed < 0 || elapsed > 100) return null;
  const remaining = Math.max(0, Math.round(100 - w.usedPct));
  const daysReset = (w.resetsAt - now) / 86_400_000;
  const daysBudget = (horizon - now) / 86_400_000;
  const gap = w.usedPct - elapsed;
  const judgment: PaceJudgment = gap > PACE_ON_BAND_PCT ? "over" : gap < -PACE_ON_BAND_PCT ? "under" : "on";
  return {
    remaining_pct: remaining,
    days_until_reset: round1(daysReset),
    // Budget runs to the reset, or to a plan change that arrives first. A few minutes left must not read as thousands of percent.
    daily_allowance_pct: round1(remaining / Math.max(daysBudget, 1 / 24)),
    elapsed_pct: round1(elapsed),
    pace: judgment,
  };
}

function windowStartMs(w: UsageWindow): number | null {
  return w.resetsAt === null || w.windowSec == null ? null : w.resetsAt - w.windowSec * 1000;
}

/** A moment belongs to this window when it is not clearly inside the previous one. */
function inThisWindow(at: number, start: number | null): boolean {
  return start === null || at >= start - BASIS_SLACK_MS;
}

function basisOf(w: UsageWindow, now: number, series: QuotaSeries | null): { allowanceResetAt: number | null; planChangedAt: number | null } {
  const start = windowStartMs(w);
  const drop = series ? latestAllowanceReset(series, now) : null;
  const change = series ? latestPlanChange(series, now) : null;
  return {
    allowanceResetAt: drop && inThisWindow(drop.at, start) ? drop.at : null,
    planChangedAt: change && inThisWindow(change.at, start) ? change.at : null,
  };
}

/**
 * Points used per hour over the last day of readings. A reset or refill only
 * zeroes the counter, so use on both sides counts and a fresh window is not
 * read from its first burst alone; the stretch across the drop itself is
 * left out, since its use is not known. A plan change moves the denominator, so
 * nothing before it counts. Time spent at the limit is left out: nothing
 * could be used then. Readings too short for the time left give no speed.
 */
function recentSpeed(series: QuotaSeries | null, now: number, remainMs: number): number | null {
  if (!series) return null;
  const change = latestPlanChange(series, now);
  const from = Math.max(change?.at ?? -Infinity, now - PACE_HOURS * 3_600_000);
  let used = 0;
  let ms = 0;
  const points = series.points;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a[0] < from || b[0] > now || a[1] >= 100 || b[1] < a[1]) continue;
    ms += b[0] - a[0];
    used += b[1] - a[1];
  }
  return ms >= Math.max(MIN_PROJECT_HOURS * 3_600_000, remainMs / MAX_STRETCH) ? used / (ms / 3_600_000) : null;
}

/**
 * End-of-window share at the speed of the last day. Without enough readings
 * it falls back to the window average, except after a refill or plan change,
 * whose earlier share would mislead it.
 * A known renewal before the reset means the end of the window is not knowable.
 */
function projectEnd(
  w: UsageWindow,
  now: number,
  series: QuotaSeries | null,
  renewsAt: number | null,
): { projected: number | null; allowanceResetAt: number | null; planChangedAt: number | null; anchorAt: number | null; horizonAt: number | null } {
  const basis = basisOf(w, now, series);
  const anchors = [basis.allowanceResetAt, basis.planChangedAt].filter((t): t is number => t !== null);
  const anchorAt = anchors.length > 0 ? Math.max(...anchors) : null;
  const renewalCuts = renewsAt !== null && w.resetsAt !== null && renewsAt > now && renewsAt < w.resetsAt;
  const horizonAt = renewalCuts ? renewsAt : null;
  const blank = { ...basis, anchorAt, horizonAt, projected: null as number | null };
  if (renewalCuts) return blank;
  if (w.usedPct !== null && w.resetsAt !== null && w.resetsAt > now) {
    const speed = recentSpeed(series, now, w.resetsAt - now);
    if (speed !== null) {
      return { ...basis, anchorAt, horizonAt, projected: Math.round(w.usedPct + (speed * (w.resetsAt - now)) / 3_600_000) };
    }
    if (anchorAt !== null) return blank;
  }
  const paced = pace(w, now);
  return { ...basis, anchorAt, horizonAt, projected: paced === null || paced.projected === null ? null : Math.round(paced.projected) };
}

interface Cadence {
  id: string;
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
  return { id: chosen.id, resetsAt: chosen.resetsAt!, windowSec: chosen.windowSec! };
}

/** When this window is full. Near the cap already, that is now; a fast pace hits before the reset. */
function fillAt(now: number, used: number | null, resetsAt: number, projected: number | null): number {
  if (used !== null && used >= NEAR_LIMIT_PCT) return now;
  if (used !== null && projected !== null && projected > Math.max(100, used)) {
    const hit = now + ((100 - used) / (projected - used)) * (resetsAt - now);
    if (hit > now && hit < resetsAt) return Math.round(hit);
  }
  return resetsAt;
}

interface PlannedUse {
  useAt: number;
  extra: number | null;
}

/**
 * Every expiring ticket is given a time to spend it. The best time is when a
 * window is full. A ticket that would expire before any such moment is brought
 * forward, and `extra` is how many points per day that week must add so the
 * window is full then. Slots after a known renewal are not offered: the
 * percentage would mean something else.
 */
function planUses(
  expiring: { index: number; exp: number }[],
  now: number,
  cadence: Cadence,
  usedPct: number | null,
  projected: number | null,
  renewsAt: number | null,
): Map<number, PlannedUse> {
  const step = cadence.windowSec * 1000;
  const day = 86_400_000;
  let end = cadence.resetsAt;
  while (end <= now) end += step;
  const first = fillAt(now, usedPct, end, projected);
  const slots: number[] = [];
  if (renewsAt === null || first <= renewsAt) slots.push(first);
  for (let e = end + step, i = 0; i < 36; i++, e += step) {
    if (renewsAt !== null && e > renewsAt) break;
    if (e !== first) slots.push(e);
  }
  const taken = new Set<number>();
  const planned = new Map<number, PlannedUse>();
  const pending = [...expiring].sort((a, b) => a.exp - b.exp || a.index - b.index);
  const surplus: { index: number; exp: number }[] = [];
  for (const ticket of pending) {
    const open = slots.filter((s) => s <= ticket.exp && !taken.has(s));
    if (open.length > 0) {
      const chosen = open[open.length - 1]!;
      taken.add(chosen);
      planned.set(ticket.index, { useAt: chosen, extra: null });
    } else {
      surplus.push(ticket);
    }
  }

  const cap = (exp: number) => (renewsAt !== null && renewsAt > now && renewsAt < exp ? renewsAt : exp);
  const groups = new Map<number, { index: number; exp: number }[]>();
  for (const ticket of surplus) {
    const deadline = cap(ticket.exp);
    const cycleEnd = deadline <= end ? end : end + Math.ceil((deadline - end) / step) * step;
    const list = groups.get(cycleEnd) ?? [];
    list.push({ index: ticket.index, exp: deadline });
    groups.set(cycleEnd, list);
  }
  for (const [cycleEnd, group] of groups) {
    const cycleStart = cycleEnd - step;
    const current = now >= cycleStart && now < cycleEnd;
    const alreadyFull = current && (usedPct ?? 0) >= NEAR_LIMIT_PCT;
    const list = [...group].sort((a, b) => a.exp - b.exp || a.index - b.index);
    let rest = list;
    if (alreadyFull && rest.length > 0) {
      const firstTicket = rest[0]!;
      planned.set(firstTicket.index, { useAt: Math.min(now, firstTicket.exp), extra: null });
      rest = rest.slice(1);
    }
    if (rest.length === 0) continue;
    const origin = current ? now : cycleStart;
    const level = current && !alreadyFull ? Math.min(usedPct ?? 0, 100) : 0;
    let rate = 0;
    let percent = 0;
    for (let k = 0; k < rest.length; k++) {
      percent += k === 0 ? 100 - level : 100;
      const days = Math.max((rest[k]!.exp - origin) / day, 1 / 24);
      rate = Math.max(rate, percent / days);
    }
    const ordinary = current && !alreadyFull
      ? Math.max(0, 100 - (usedPct ?? 0)) / Math.max((cycleEnd - now) / day, 1 / 24)
      : 100 / (cadence.windowSec / 86400);
    const extra = round1(rate - ordinary);
    const extraOut = extra > 0.05 ? extra : null;
    let consumed = 0;
    for (let k = 0; k < rest.length; k++) {
      consumed += k === 0 ? 100 - level : 100;
      const at = origin + (consumed / rate) * day;
      planned.set(rest[k]!.index, { useAt: Math.min(Math.round(at), rest[k]!.exp), extra: extraOut });
    }
  }
  return planned;
}

function presentTickets(
  tickets: ResetTicket[],
  now: number,
  cadence: Cadence | null,
  usedPct: number | null,
  projected: number | null,
  renewsAt: number | null,
): QuotaTicket[] {
  const expiring = tickets
    .map((t, index) => ({ index, exp: t.expiresAt }))
    .filter((x): x is { index: number; exp: number } => x.exp !== null && x.exp > now);
  const uses = cadence && cadence.windowSec > 0 ? planUses(expiring, now, cadence, usedPct, projected, renewsAt) : new Map<number, PlannedUse>();
  if (!cadence) {
    for (const ticket of expiring) uses.set(ticket.index, { useAt: ticket.exp, extra: null });
  }
  return tickets.map((t, index) => {
    const use = uses.get(index);
    const at = use?.useAt ?? null;
    return {
      label: t.label,
      expires_at: t.expiresAt,
      expires_at_jst: jst(t.expiresAt),
      use_at: at,
      use_at_jst: jst(at),
      extra_daily_pct: use?.extra ?? null,
    };
  });
}

function quotaWindow(w: UsageWindow, now: number, renewsAt: number | null, history?: { sub: string; source: QuotaTrendSource }): QuotaWindow {
  const series = history ? history.source.series(history.sub, w.id) : null;
  const projected = projectEnd(w, now, series, renewsAt);
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
    plan_changed_at: projected.planChangedAt,
    plan_changed_at_jst: jst(projected.planChangedAt),
    plan: windowPlan(w, now, projected.anchorAt, projected.horizonAt),
    ...(days !== undefined ? { trend: series ? windowTrend(series, now, days) : null } : {}),
  };
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
    renews_at: null,
    renews_at_jst: null,
    next_plan: null,
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
