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

/** Up to three significant digits with a K/M/B suffix: 9.26K, 850K, 90.2M. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) {
      const v = value / size;
      const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
      return `${Number(v.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** Docker's "Up 5 minutes" / "Exited (0) 2 days ago" in Japanese. */
export function dockerStatus(status: string): string {
  const unit: Record<string, string> = { second: "秒", minute: "分", hour: "時間", day: "日", week: "週間", month: "か月", year: "年" };
  const span = (s: string) =>
    s
      .replace(/^(About an?|an?) (second|minute|hour|day|week|month|year)s?$/i, (_m, _a, u: string) => `1 ${unit[u.toLowerCase()]}`)
      .replace(/^Less than a second$/i, "1 秒未満")
      .replace(/^(\d+) (second|minute|hour|day|week|month|year)s?$/i, (_m, n: string, u: string) => `${n} ${unit[u.toLowerCase()]}`);
  const up = /^Up (.+?)( \((healthy|unhealthy|health: starting)\))?$/i.exec(status);
  if (up) return `稼働 ${span(up[1]!)}${up[3] === "unhealthy" ? "（異常）" : ""}`;
  const exited = /^Exited \((\d+)\) (.+) ago$/i.exec(status);
  if (exited) return `${span(exited[2]!)}前に停止`;
  return status;
}

/** How long a running container has been up, from Docker's own status ("4 時間"), or null. */
export function containerUptime(status: string): string | null {
  const text = dockerStatus(status);
  return text.startsWith("稼働 ") ? text.slice(3).replace(/（異常）$/, "") : null;
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

/** When the upstream was last checked: "3分前に確認", or "たった今確認". */
export function checkedAgo(at: number | null, now: number): string {
  if (at === null) return "未確認";
  const when = ago(at, now);
  return when === "たった今" ? "たった今確認" : `${when}に確認`;
}

const TIME = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const HM = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
const MD = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });

export function clock(at: number): string {
  return TIME.format(at);
}

/** Just the time when it is today, otherwise with the date. */
export function when(at: number, now: number): string {
  return new Date(at).toDateString() === new Date(now).toDateString() ? HM.format(at) : `${MD.format(at)} ${HM.format(at)}`;
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
