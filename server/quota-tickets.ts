import { jst } from "./jst.ts";
import { PACE_MIN_WINDOW_SEC, round1 } from "./quota-window.ts";
import type { QuotaTicket } from "./quota.ts";
import type { ResetTicket, UsageWindow } from "./types.ts";

// When to spend a subscription's reset tickets, so none expires unused.

/** A weekly cadence is preferred for ticket deadlines; anything longer is the fallback. */
const WEEKLY_MAX_SEC = 8 * 86400;
/** A window this full is already worth a reset ticket; waiting longer only blocks work. */
const NEAR_LIMIT_PCT = 90;

export interface Cadence {
  id: string;
  resetsAt: number;
  windowSec: number;
}

/** The next long window. A weekly one wins over a longer one, and the soonest reset wins a tie. */
export function planCadence(windows: UsageWindow[], now: number): Cadence | null {
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

export function presentTickets(
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
