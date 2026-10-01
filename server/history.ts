// Minute averages of the live figures for the last 24 hours, so a trend can
// be read back without streaming every five-second sample to every viewer.

const MINUTES = 24 * 60;

interface Bucket {
  /** Epoch minute (ms / 60000). */
  m: number;
  sum: number;
  n: number;
}

export interface HistoryPoint {
  /** Epoch ms of the minute's start. */
  t: number;
  v: number;
}

export type HistoryDump = Record<string, Bucket[]>;

export class History {
  private readonly series = new Map<string, Bucket[]>();

  constructor(saved: HistoryDump = {}) {
    for (const [key, buckets] of Object.entries(saved)) {
      if (Array.isArray(buckets)) this.series.set(key, buckets.filter((b) => b && Number.isFinite(b.m) && b.n > 0));
    }
  }

  record(key: string, value: number | null | undefined, at = Date.now()): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const m = Math.floor(at / 60_000);
    const list = this.series.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && last.m === m) {
      last.sum += value;
      last.n += 1;
    } else {
      list.push({ m, sum: value, n: 1 });
      const oldest = m - MINUTES;
      while (list.length > 0 && list[0]!.m <= oldest) list.shift();
    }
    this.series.set(key, list);
  }

  /** Minute averages for the last 24 hours; minutes without samples are absent. */
  points(key: string, now = Date.now()): HistoryPoint[] {
    const oldest = Math.floor(now / 60_000) - MINUTES;
    return (this.series.get(key) ?? []).filter((b) => b.m > oldest).map((b) => ({ t: b.m * 60_000, v: b.sum / b.n }));
  }

  keys(): string[] {
    return [...this.series.keys()];
  }

  dump(): HistoryDump {
    return Object.fromEntries(this.series);
  }
}
