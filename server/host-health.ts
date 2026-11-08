import type { HostSnapshot } from "./types.ts";

/** A local LLM intentionally consumes Spark unified memory. Only sustained
 * reclaim stalls or a recent OOM indicate harmful memory pressure there. */
export function memoryWarning(h: Pick<HostSnapshot, "kind" | "memTotalBytes" | "memUsedBytes" | "memoryPressure">):
  { severity: "warn" | "critical"; message: string } | null {
  if (h.kind === "spark") {
    if (h.memoryPressure?.oomKillRecent) return { severity: "critical", message: "OOMを検出" };
    if ((h.memoryPressure?.fullAvg10 ?? 0) >= 5 || (h.memoryPressure?.someAvg10 ?? 0) >= 20) {
      return { severity: "warn", message: "メモリ圧力が高い" };
    }
    return null;
  }
  const used = h.memTotalBytes && h.memUsedBytes !== null ? h.memUsedBytes / h.memTotalBytes : null;
  if (used !== null && used >= 0.98) return { severity: "critical", message: "メモリ残量が危険" };
  if (used !== null && used >= 0.92) return { severity: "warn", message: "メモリ残量が少ない" };
  return null;
}
