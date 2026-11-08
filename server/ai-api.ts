import type { Snapshot } from "./types.ts";
import { observedQuota } from "./quota-observed.ts";

/** Small, stable JSON contracts for agents. The dashboard continues using /api/state. */
export const AI_ROUTES = [
  { path: "/api/ai/monitor", purpose: "Current machine and local LLM telemetry; no quota forecasts" },
  { path: "/api/ai/quota", purpose: "Observed subscription consumption and conservative model availability" },
  { path: "/api/ai/agents", purpose: "Detected coding agent sessions and source coverage; state may be unknown" },
  { path: "/api/usage", purpose: "Historical model token counts and estimated API-price equivalents" },
  { path: "/api/history", purpose: "Time-series samples for host and LLM metrics" },
] as const;

export function aiCatalog() {
  return { schema_version: 1, format: "json", routes: AI_ROUTES, dashboard_internal: "/api/state", notes: "Read-only. Null means not observed. Fields named estimated/forecast are never actual measurements." };
}

export function aiMonitor(snapshot: Pick<Snapshot, "hosts" | "llms">, now: number) {
  return {
    schema_version: 1,
    observed_at: new Date(now).toISOString(),
    units: { cpu_used_pct: "percent", memory_used_bytes: "bytes", memory_total_bytes: "bytes", gpu_used_pct: "percent", gen_tokens_per_sec: "tokens/second" },
    hosts: snapshot.hosts.map((host) => ({
      id: host.id, name: host.label, kind: host.kind, role: host.role ?? "standalone", head_id: host.headId ?? null, online: host.online,
      disk_io: host.online ? host.disks.map((d) => ({ mount: d.mount, read_bytes_per_sec: d.readBps ?? null, write_bytes_per_sec: d.writeBps ?? null })) : [],
      network_issue_recent: host.networkIssueUntil != null && host.networkIssueUntil > now,
      gpu_telemetry_missing: host.gpuReadFailed === true,
      memory_pressure_some_avg10_pct: host.online ? host.memoryPressure?.someAvg10 ?? null : null,
      memory_pressure_full_avg10_pct: host.online ? host.memoryPressure?.fullAvg10 ?? null : null,
      oom_kill_recent: host.online ? host.memoryPressure?.oomKillRecent ?? null : null,
      last_seen_at: host.lastSeen === null ? null : new Date(host.lastSeen).toISOString(),
      cpu_used_pct: host.online ? host.cpuPct : null,
      memory_used_bytes: host.online ? host.memUsedBytes : null,
      memory_total_bytes: host.online ? host.memTotalBytes : null,
      gpu_used_pct: host.online ? (host.gpu?.utilPct ?? null) : null,
      error: host.online ? null : host.error,
    })),
    local_models: snapshot.llms.map((llm) => ({
      id: llm.id, name: llm.label, purpose: llm.purpose ?? "generation", state: llm.state,
      served_model: llm.state === "up" ? llm.models[0] ?? null : null,
      nodes: llm.nodes,
      requests_running: llm.state === "up" ? llm.requestsRunning : null,
      requests_waiting: llm.state === "up" ? llm.requestsWaiting : null,
      max_concurrent: llm.state === "up" ? llm.maxConcurrent : null,
      gen_tokens_per_sec: llm.state === "up" ? llm.genTokensPerSec : null,
    })),
  };
}

export function aiAgents(snapshot: Pick<Snapshot, "agents" | "agentSources">, now: number) {
  return {
    schema_version: 1,
    observed_at: new Date(now).toISOString(),
    caveat: "Sources may omit sessions. source=process proves only a running process, not task activity; it may duplicate an Orca pane. An idle or unknown state is not proof of completion or a user-input prompt.",
    sources: snapshot.agentSources ?? [],
    agents: snapshot.agents.map((a) => ({
      id: a.id, harness: a.tool, host: a.host, project_path: a.cwd,
      status: a.status, state_confidence: a.confidence ?? "unknown", source: a.source ?? "unknown",
      title: a.title, last_activity_at: a.lastActivity === null ? null : new Date(a.lastActivity).toISOString(),
    })),
  };
}

export { observedQuota as aiQuota };
