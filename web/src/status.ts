import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../server/types.ts";
import { subscriptionStatus } from "./pace.ts";
import type { Page } from "./route.ts";
import type { Tone } from "./tone.ts";

export interface Status {
  tone: Tone;
  text: string;
}

// CPUs (AMD's Tctl in particular) are designed to run hotter than GPUs.
const LIMITS = { gpu: { warn: 80, critical: 90 }, cpu: { warn: 90, critical: 98 } };

export function hostStatus(h: HostSnapshot): Status {
  if (!h.online) return { tone: "critical", text: "オフライン" };
  const gpu = h.gpu?.tempC ?? 0;
  const cpu = h.cpuTempC ?? 0;
  if (gpu >= LIMITS.gpu.critical || cpu >= LIMITS.cpu.critical) return { tone: "critical", text: "高温" };
  if (gpu >= LIMITS.gpu.warn || cpu >= LIMITS.cpu.warn) return { tone: "warn", text: "温度高め" };
  return { tone: "good", text: "オンライン" };
}

/** Process state and load, in the words used everywhere: 停止中 / 起動中 / 稼働中 / アイドル, 稼働中 / 推論中. */
export function llmStatus(l: LlmSnapshot): Status {
  if (l.state === "down") return { tone: "quiet", text: "停止中" };
  if (l.state === "starting") return { tone: "warn", text: "起動中" };
  return (l.requestsRunning ?? 0) > 0 ? { tone: "busy", text: "稼働中 / 推論中" } : { tone: "good", text: "稼働中 / アイドル" };
}

export interface Alert {
  text: string;
  tone: Tone;
  page: Page;
}

/** Only the things worth acting on; an empty list means everything is fine. */
export function alerts(s: Snapshot, now: number): Alert[] {
  const out: Alert[] = [];
  for (const h of s.hosts) {
    const st = hostStatus(h);
    if (st.tone === "critical" || st.tone === "warn") out.push({ text: `${h.label}：${st.text}`, tone: st.tone, page: "lab" });
  }
  for (const r of s.recipes) if (r.status === "failed") out.push({ text: `${r.label}：起動に失敗しました`, tone: "critical", page: "lab" });
  for (const sub of s.subscriptions) {
    const st = subscriptionStatus(sub, now);
    if (st.tone === "warn" || st.tone === "critical") out.push({ text: `${sub.label}：${st.text}${st.reset ? `（${st.reset}）` : ""}`, tone: st.tone, page: "usage" });
  }
  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  if (waiting > 0) out.push({ text: `エージェント ${waiting} 件が入力を待っています`, tone: "warn", page: "agents" });
  return out;
}

export interface Badge {
  tone: Tone;
  /** Short text inside the badge (a count), or empty for a plain dot. */
  text: string;
  label: string;
}

const RANK: Record<Tone, number> = { critical: 4, warn: 3, busy: 2, good: 1, quiet: 0 };

/**
 * What each tab shows next to its name, so the navigation itself answers
 * "is anything wrong here, is anything busy here" without an overview page.
 */
export function badges(s: Snapshot, now: number): Record<Page, Badge | null> {
  const list = alerts(s, now);
  const worst = (page: Page): Alert | null =>
    list.filter((a) => a.page === page).sort((a, b) => RANK[b.tone] - RANK[a.tone])[0] ?? null;

  const labAlert = worst("lab");
  // Tabs only speak up when something needs the owner; busy is normal and stays quiet.
  const lab: Badge | null = labAlert ? { tone: labAlert.tone, text: "", label: labAlert.text } : null;

  const usageAlert = worst("usage");
  const usage: Badge | null = usageAlert ? { tone: usageAlert.tone, text: "", label: usageAlert.text } : null;

  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  const agents: Badge | null = waiting > 0 ? { tone: "warn", text: "", label: `入力待ち ${waiting}` } : null;

  return { lab, usage, agents };
}
