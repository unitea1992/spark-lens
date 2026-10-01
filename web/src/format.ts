const GB = 1024 ** 3;
const TB = 1024 ** 4;

export function pct(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? "–" : `${value.toFixed(digits)}%`;
}

export function ratioPct(used: number | null, total: number | null): number | null {
  return used === null || total === null || total <= 0 ? null : (used / total) * 100;
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value >= TB) return `${(value / TB).toFixed(2)} TB`;
  if (value >= 10 * GB) return `${(value / GB).toFixed(0)} GB`;
  if (value >= GB) return `${(value / GB).toFixed(1)} GB`;
  return `${(value / 1024 ** 2).toFixed(0)} MB`;
}

export function usedOfTotal(used: number | null, total: number | null): string {
  if (used === null || total === null) return "–";
  if (total >= TB) return `${(used / TB).toFixed(2)} / ${(total / TB).toFixed(2)} TB`;
  return `${(used / GB).toFixed(1)} / ${(total / GB).toFixed(0)} GB`;
}

export function rate(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return "–";
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
  return `${bits.toFixed(0)} b/s`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString("ja-JP");
}

/** "3日 4時間", "2時間 5分", "40秒" */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "–";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}日 ${h}時間`;
  if (h > 0) return `${h}時間 ${m}分`;
  if (m > 0) return `${m}分`;
  return `${s}秒`;
}

export function ago(at: number | null, now: number): string {
  if (at === null) return "–";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 10) return "たった今";
  if (s < 60) return `${Math.floor(s)}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

const TIME = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const HM = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
const MD = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });

export function clock(at: number): string {
  return TIME.format(at);
}

/** Reset time: just the time when it is today, otherwise with the date. */
export function resetAt(at: number | null, now: number): string {
  if (at === null) return "リセット時刻不明";
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? `${HM.format(at)} にリセット` : `${MD.format(at)} ${HM.format(at)} にリセット`;
}

/** "10/4(土) 08:46" */
export function shortDate(at: number): string {
  return `${MD.format(at)} ${HM.format(at)}`;
}

export function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
