import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentCollector, procRegex } from "./collectors/agents.ts";
import { HostCollector } from "./collectors/hosts.ts";
import { LlmCollector } from "./collectors/llm.ts";
import { SubscriptionCollector } from "./collectors/subscriptions/index.ts";
import { loadConfig, stateDir } from "./config.ts";
import { HttpServer } from "./http.ts";
import { Store } from "./store.ts";
import type { Snapshot } from "./types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

function log(message: string): void {
  console.log(`[spark-lens] ${message}`);
}

async function main(): Promise<void> {
  const { config, path, found } = loadConfig();
  log(found ? `config: ${path}` : `no config at ${path}; monitoring this machine only`);

  const runtimeDir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "spark-lens");
  const store = new Store(stateDir());
  const hosts = new HostCollector(config.hosts, {
    procRegex: procRegex(config.agents.processes),
    pollSeconds: config.pollSeconds,
    runtimeDir,
  });
  const llms = new LlmCollector(config.llms, store, config.pollSeconds);
  const subscriptions = new SubscriptionCollector(config.subscriptions);
  const agents = new AgentCollector(config.agents.processes);

  const snapshot = (): Snapshot => ({
    generatedAt: Date.now(),
    pollSeconds: config.pollSeconds,
    version: VERSION,
    hosts: hosts.snapshots(),
    llms: llms.snapshots(),
    subscriptions: subscriptions.snapshots(),
    agents: agents.snapshots(),
  });

  const http = new HttpServer({
    host: config.server.host,
    port: config.server.port,
    staticDir: join(ROOT, "dist"),
    allowedHosts: config.server.allowedHosts,
    snapshot,
  });

  // Agent sources are other tools' CLIs; asking them every few seconds costs
  // more than the answer is worth.
  const agentEvery = Math.max(1, Math.round(config.agentPollSeconds / config.pollSeconds));
  let tickCount = 0;
  let ticking = false;
  const tick = async () => {
    // Collectors guard themselves, but a tick that outlives the interval
    // should not start a second broadcast behind it.
    if (ticking) return;
    ticking = true;
    try {
      await hosts.poll();
      const pollAgents = tickCount++ % agentEvery === 0;
      await Promise.all([llms.poll(hosts.snapshots()), pollAgents ? agents.poll(hosts.processes()) : null]);
      http.broadcast();
    } catch (err) {
      log(`poll failed: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  };

  const pollSubscriptions = () => {
    subscriptions.poll().then(
      () => http.broadcast(),
      () => {},
    );
  };

  await http.listen();
  log(`listening on http://${config.server.host}:${config.server.port}`);

  void tick();
  pollSubscriptions();
  const timers = [
    setInterval(tick, config.pollSeconds * 1000),
    setInterval(pollSubscriptions, config.subscriptionPollSeconds * 1000),
    setInterval(() => {
      try {
        store.flush();
      } catch (err) {
        log(`could not save state: ${(err as Error).message}`);
      }
    }, 30_000),
  ];

  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    try {
      store.flush();
    } catch {
      // Losing today's token tally is better than hanging on shutdown.
    }
    http.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[spark-lens] ${(err as Error).message}`);
  process.exit(1);
});
