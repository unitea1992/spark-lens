import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProcessRule, Config, HostConfig, LlmConfig, SubscriptionConfig } from "./types.ts";

const DEFAULT_SUBSCRIPTIONS: SubscriptionConfig[] = [
  { type: "claude-code" },
  { type: "codex" },
  { type: "opencode-go" },
];

export function configPath(): string {
  if (process.env.SPARK_LENS_CONFIG) return process.env.SPARK_LENS_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "spark-lens", "config.json");
}

export function stateDir(): string {
  if (process.env.SPARK_LENS_STATE_DIR) return process.env.SPARK_LENS_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "spark-lens");
}

class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a non-empty string`);
  return value;
}

function optString(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : asString(value, where);
}

function asNumber(value: unknown, where: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${where} must be a number between ${min} and ${max}`);
  }
  return value;
}

function stringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  return asArray(value, where).map((v, i) => asString(v, `${where}[${i}]`));
}

// SSH destinations and mount points end up on a command line; keep them to
// the characters real ones use so a config typo cannot become an option or a
// shell fragment.
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/;
const MOUNT = /^\/[A-Za-z0-9_./-]*$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

function parseHost(raw: unknown, i: number): HostConfig {
  const where = `hosts[${i}]`;
  const o = asObject(raw, where);
  const id = asString(o.id, `${where}.id`);
  if (!ID.test(id)) fail(`${where}.id must be lowercase letters, digits and dashes`);
  const kind = o.kind === undefined ? "server" : asString(o.kind, `${where}.kind`);
  if (kind !== "spark" && kind !== "workstation" && kind !== "server") {
    fail(`${where}.kind must be spark, workstation or server`);
  }
  const local = o.local === true;
  const ssh = optString(o.ssh, `${where}.ssh`);
  if (!local && !ssh) fail(`${where} needs either "local": true or an "ssh" destination`);
  if (ssh && !SSH_TARGET.test(ssh)) fail(`${where}.ssh contains unsupported characters`);
  const mounts = stringList(o.mounts, `${where}.mounts`);
  for (const m of mounts ?? []) if (!MOUNT.test(m)) fail(`${where}.mounts: "${m}" is not a plain absolute path`);
  return { id, label: optString(o.label, `${where}.label`) ?? id, kind, local, ssh, mounts };
}

function parseEngine(value: unknown, where: string): LlmConfig["engine"] {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "vllm" || value === "sglang" || value === "tensorfold") return value;
  fail(`${where} must be auto, vllm, sglang or tensorfold`);
}

function parseLlm(raw: unknown, i: number, hostIds: Set<string>): LlmConfig {
  const where = `llms[${i}]`;
  const o = asObject(raw, where);
  const id = asString(o.id, `${where}.id`);
  if (!ID.test(id)) fail(`${where}.id must be lowercase letters, digits and dashes`);
  const baseUrl = asString(o.baseUrl, `${where}.baseUrl`).replace(/\/+$/, "").replace(/\/v1$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    fail(`${where}.baseUrl is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${where}.baseUrl must be http or https`);
  const nodes = stringList(o.nodes, `${where}.nodes`) ?? [];
  for (const n of nodes) if (!hostIds.has(n)) fail(`${where}.nodes: unknown host id "${n}"`);
  return {
    id,
    label: optString(o.label, `${where}.label`) ?? id,
    baseUrl,
    nodes,
    containers: stringList(o.containers, `${where}.containers`) ?? [],
    apiKeyEnv: optString(o.apiKeyEnv, `${where}.apiKeyEnv`),
    engine: parseEngine(o.engine, `${where}.engine`),
  };
}

function parseSubscription(raw: unknown, i: number): SubscriptionConfig {
  const where = `subscriptions[${i}]`;
  const o = asObject(raw, where);
  return {
    type: asString(o.type, `${where}.type`),
    label: optString(o.label, `${where}.label`),
    options: o.options === undefined ? undefined : asObject(o.options, `${where}.options`),
  };
}

function parseRule(raw: unknown, i: number): AgentProcessRule {
  const where = `agents.processes[${i}]`;
  const o = asObject(raw, where);
  const match = asString(o.match, `${where}.match`);
  try {
    new RegExp(match);
  } catch {
    fail(`${where}.match is not a valid regular expression`);
  }
  // The pattern is handed to grep -E inside a single-quoted shell word.
  if (match.includes("'") || match.includes("\n")) fail(`${where}.match must not contain quotes or newlines`);
  const tool = asString(o.tool, `${where}.tool`);
  return { tool, label: optString(o.label, `${where}.label`) ?? tool, match };
}

export function parseConfig(raw: unknown): Config {
  const o = asObject(raw, "config");
  const server = o.server === undefined ? {} : asObject(o.server, "server");
  const hostsRaw = asArray(o.hosts, "hosts");
  const hosts: HostConfig[] =
    hostsRaw.length > 0 ? hostsRaw.map(parseHost) : [{ id: "local", label: "This machine", kind: "workstation", local: true }];
  const hostIds = new Set<string>();
  for (const h of hosts) {
    if (hostIds.has(h.id)) fail(`hosts: duplicate id "${h.id}"`);
    hostIds.add(h.id);
  }
  const llms = asArray(o.llms, "llms").map((l, i) => parseLlm(l, i, hostIds));
  const subscriptions =
    o.subscriptions === undefined ? DEFAULT_SUBSCRIPTIONS : asArray(o.subscriptions, "subscriptions").map(parseSubscription);
  const agents = o.agents === undefined ? {} : asObject(o.agents, "agents");
  return {
    server: {
      host: optString(server.host, "server.host") ?? "127.0.0.1",
      port: asNumber(server.port, "server.port", 1, 65535, 8686),
      allowedHosts: stringList(server.allowedHosts, "server.allowedHosts") ?? [],
    },
    pollSeconds: asNumber(o.pollSeconds, "pollSeconds", 2, 300, 5),
    subscriptionPollSeconds: asNumber(o.subscriptionPollSeconds, "subscriptionPollSeconds", 60, 86400, 300),
    agentPollSeconds: asNumber(o.agentPollSeconds, "agentPollSeconds", 2, 600, 15),
    hosts,
    llms,
    subscriptions,
    agents: { processes: asArray(agents.processes, "agents.processes").map(parseRule) },
  };
}

export function loadConfig(): { config: Config; path: string; found: boolean } {
  const path = configPath();
  if (!existsSync(path)) return { config: parseConfig({}), path, found: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${(err as Error).message})`);
  }
  try {
    return { config: parseConfig(raw), path, found: true };
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`${path}: ${err.message}`);
    throw err;
  }
}
