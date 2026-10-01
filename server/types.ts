// Shapes shared by the server and the web client. The client imports this
// file type-only, so nothing here may have a runtime dependency.

export type HostKind = "spark" | "workstation" | "server";

export interface HostConfig {
  id: string;
  label: string;
  kind: HostKind;
  /** Probe this machine directly instead of over SSH. */
  local?: boolean;
  /** SSH destination (an ssh_config alias or user@host). */
  ssh?: string;
  /** Mount points reported under storage. Defaults to ["/"]. */
  mounts?: string[];
}

export interface LlmConfig {
  id: string;
  label: string;
  /** OpenAI-compatible server root, without /v1. */
  baseUrl: string;
  /** Host ids this model runs on. */
  nodes?: string[];
  /** Container names that belong to this deployment, used to tell "starting" from "stopped". */
  containers?: string[];
  /** Name of an environment variable holding the bearer token, if the server needs one. */
  apiKeyEnv?: string;
  /** Inference engine; "auto" (default) detects it from the server's responses. */
  engine?: "auto" | "vllm" | "sglang" | "tensorfold";
}

export interface SubscriptionConfig {
  type: string;
  label?: string;
  /** Provider-specific options (paths, commands). */
  options?: Record<string, unknown>;
}

export interface AgentProcessRule {
  tool: string;
  label: string;
  /** Extended regex matched against the full command line. */
  match: string;
}

export interface Config {
  server: { host: string; port: number; allowedHosts: string[] };
  pollSeconds: number;
  subscriptionPollSeconds: number;
  agentPollSeconds: number;
  hosts: HostConfig[];
  llms: LlmConfig[];
  subscriptions: SubscriptionConfig[];
  agents: { processes: AgentProcessRule[] };
}

// ---------------------------------------------------------------- snapshot

export interface GpuInfo {
  vendor: "nvidia" | "amd";
  name: string;
  utilPct: number | null;
  tempC: number | null;
  powerW: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  clockMhz: number | null;
  clockMaxMhz: number | null;
}

export interface DiskInfo {
  mount: string;
  totalBytes: number;
  usedBytes: number;
}

export interface NetInfo {
  iface: string;
  up: boolean;
  speedMbps: number | null;
  rxBps: number | null;
  txBps: number | null;
}

export interface ContainerInfo {
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface TempReading {
  chip: string;
  label: string;
  tempC: number;
}

export interface HostProcess {
  pid: number;
  elapsedSec: number;
  cpuPct: number;
  rssBytes: number;
  cwd: string;
  args: string;
}

export interface HostHistory {
  /** Seconds between samples. */
  stepSec: number;
  cpu: (number | null)[];
  gpu: (number | null)[];
  mem: (number | null)[];
  temp: (number | null)[];
  power: (number | null)[];
}

export interface HostSnapshot {
  id: string;
  label: string;
  kind: HostKind;
  online: boolean;
  error: string | null;
  /** Epoch ms of the last successful probe. */
  lastSeen: number | null;
  latencyMs: number | null;
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  cpuModel: string | null;
  ncpu: number | null;
  uptimeSec: number | null;
  load: [number, number, number] | null;
  cpuPct: number | null;
  /** Average core clock as a share of the maximum. */
  clockPct: number | null;
  clockMhz: number | null;
  clockMaxMhz: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  disks: DiskInfo[];
  gpu: GpuInfo | null;
  /** Hottest sensor on the machine. */
  maxTemp: TempReading | null;
  cpuTempC: number | null;
  temps: TempReading[];
  net: NetInfo[];
  containers: ContainerInfo[];
  gpuProcesses: { pid: number; name: string; memBytes: number | null }[];
  history: HostHistory;
}

export type LlmState = "up" | "starting" | "down";

export interface SpecStats {
  /** Share of drafted tokens the model kept, 0..1. */
  acceptRate: number | null;
  /** Tokens produced per verify round, including the model's own one. */
  meanLength: number | null;
  draftTokensPerSec: number | null;
  acceptedTokensPerSec: number | null;
}

export interface LlmSnapshot {
  id: string;
  label: string;
  /** Engine name for display, once known. */
  engine: string | null;
  state: LlmState;
  detail: string | null;
  baseUrl: string;
  nodes: string[];
  models: string[];
  contextLength: number | null;
  /** Epoch ms since the endpoint has been continuously healthy. */
  upSince: number | null;
  latencyMs: number | null;
  requestsRunning: number | null;
  requestsWaiting: number | null;
  /** 0..1 */
  kvCacheUsage: number | null;
  /** Tokens per second over the last poll interval. */
  genTokensPerSec: number | null;
  promptTokensPerSec: number | null;
  /** Mean time to first token (s) over recent requests. */
  ttftSec: number | null;
  /** 0..1 over the server's lifetime. */
  prefixCacheHitRate: number | null;
  /** Speculative decoding, when the server drafts. Ratios are over the server's lifetime. */
  spec: SpecStats | null;
  tokensToday: { prompt: number; generation: number };
  tokensTotal: { prompt: number; generation: number } | null;
  requestsTotal: number | null;
  containers: { host: string; name: string; state: string; status: string }[];
  history: { stepSec: number; genTps: (number | null)[]; running: (number | null)[] };
}

export type SubscriptionStatus = "ok" | "stale" | "error" | "unconfigured";

export interface UsageWindow {
  id: string;
  label: string;
  usedPct: number | null;
  /** Epoch ms. */
  resetsAt: number | null;
  /** Length of the window, when the provider reports one. */
  windowSec?: number | null;
  /**
   * The window has not started: it opens on first use (Claude's 5-hour
   * session), so there is no reset time yet.
   */
  idle?: boolean;
  detail?: string | null;
}

/** A one-off limit reset the account holds (Codex grants these). */
export interface ResetTicket {
  label: string;
  /** Epoch ms, or null when it does not expire. */
  expiresAt: number | null;
}

export interface SubscriptionSnapshot {
  id: string;
  type: string;
  label: string;
  plan: string | null;
  status: SubscriptionStatus;
  message: string | null;
  windows: UsageWindow[];
  notes: string[];
  tickets: ResetTicket[];
  fetchedAt: number | null;
}

export type AgentStatus = "working" | "idle" | "waiting" | "unknown";

export interface AgentSnapshot {
  id: string;
  tool: string;
  toolLabel: string;
  host: string;
  hostLabel: string;
  title: string | null;
  cwd: string | null;
  status: AgentStatus;
  pid: number | null;
  startedAt: number | null;
  lastActivity: number | null;
  cpuPct: number | null;
  detail: string | null;
}

export interface ModelUsage {
  model: string;
  /** Where it was used: "Claude Code", "Codex", "OpenCode" or "ローカル". */
  source: string;
  local: boolean;
  /** null when the tool reports only a total. */
  input: number | null;
  output: number | null;
  cached: number | null;
  total: number;
}

export interface UsageSnapshot {
  generatedAt: number;
  today: ModelUsage[];
  week: ModelUsage[];
}

export interface Snapshot {
  generatedAt: number;
  pollSeconds: number;
  version: string;
  hosts: HostSnapshot[];
  llms: LlmSnapshot[];
  subscriptions: SubscriptionSnapshot[];
  agents: AgentSnapshot[];
  usage: UsageSnapshot;
}
