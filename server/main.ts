import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentCollector, procRegex } from "./collectors/agents.ts";
import { HostCollector } from "./collectors/hosts.ts";
import { LlmCollector } from "./collectors/llm.ts";
import { SubscriptionCollector } from "./collectors/subscriptions/index.ts";
import { UsageCollector } from "./collectors/usage.ts";
import { loadConfig, stateDir } from "./config.ts";
import { HttpServer } from "./http.ts";
import { RecipeManager } from "./recipes.ts";
import { BenchRunner } from "./bench.ts";
import { History } from "./history.ts";
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
  const history = new History(store.history());
  const bench = new BenchRunner(store);
  const hosts = new HostCollector(config.hosts, {
    procRegex: procRegex(config.agents.processes),
    pollSeconds: config.pollSeconds,
    runtimeDir,
  });
  const llms = new LlmCollector(config.llms, store, config.pollSeconds);
  const subscriptions = new SubscriptionCollector(config.subscriptions, {
    intervalSec: config.subscriptionPollSeconds,
    cache: { load: () => store.subscriptions(), save: (s) => store.setSubscriptions(s) },
  });
  const agents = new AgentCollector(config.agents.processes);
  const usage = new UsageCollector(config.llms, store);
  const recipes = new RecipeManager(config.recipes, config.hosts, runtimeDir, {
    get: (id) => store.startSeconds(id),
    set: (id, sec) => store.setStartSeconds(id, sec),
  });

  const snapshot = (): Snapshot => ({
    generatedAt: Date.now(),
    pollSeconds: config.pollSeconds,
    version: VERSION,
    hosts: hosts.snapshots(),
    llms: llms.snapshots(),
    subscriptions: subscriptions.snapshots(),
    agents: agents.snapshots(),
    usage: usage.snapshot(),
    recipes: recipes.snapshots(),
    bench: bench.snapshot(config.llms.map((l) => l.id)),
  });

  const http = new HttpServer({
    host: config.server.host,
    port: config.server.port,
    staticDir: join(ROOT, "dist"),
    allowedHosts: config.server.allowedHosts,
    snapshot,
    recipes:
      config.recipes.length > 0
        ? {
            start: (id) => recipes.start(id),
            stop: (id) => recipes.stop(id),
            logs: (id, source) => recipes.logs(id, source),
            check: async (id) => {
              const up = await recipes.checkUpstream(id);
              return up ? { ok: up.state !== "error", message: up.state === "behind" ? `${up.behind} 件の更新があります` : up.message ?? "確認しました" } : { ok: false, message: "レシピが見つかりません" };
            },
            update: (id) => recipes.updateRecipe(id),
            switchTo: (id) => recipes.switchTo(id),
          }
        : undefined,
    changed: () => http.broadcast(),
    history: (key) => history.points(key),
    benchStop: (llmId) => bench.stop(llmId),
    bench: async (llmId) => {
      const cfg = config.llms.find((l) => l.id === llmId);
      const live = llms.snapshots().find((l) => l.id === llmId);
      if (!cfg || !live) return { ok: false, message: "モデルが見つかりません" };
      if (live.state !== "up") return { ok: false, message: "モデルが稼働していません" };
      let recipe = recipes.snapshots().find((r) => r.llm === llmId);
      // Record which upstream version is being measured, even right after a restart.
      if (recipe && !recipe.upstream) {
        await recipes.checkUpstream(recipe.id);
        recipe = recipes.snapshots().find((r) => r.llm === llmId);
      }
      return bench.start(
        llmId,
        {
          baseUrl: cfg.baseUrl,
          model: cfg.model ?? live.models[0] ?? "",
          apiKey: cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined,
          commit: recipe?.upstream?.head ?? null,
          repo: recipe?.upstream?.repo ?? null,
        },
        () => http.broadcast(),
      );
    },
  });

  // Keys are "host:<id>:<metric>" and "llm:<id>:<metric>", matching what the client asks for.
  const recordHistory = () => {
    const now = Date.now();
    for (const h of hosts.snapshots()) {
      if (!h.online) continue;
      const mem = h.memTotalBytes && h.memUsedBytes !== null ? (h.memUsedBytes / h.memTotalBytes) * 100 : null;
      history.record(`host:${h.id}:cpu`, h.cpuPct, now);
      history.record(`host:${h.id}:gpu`, h.gpu?.utilPct, now);
      history.record(`host:${h.id}:mem`, mem, now);
      history.record(`host:${h.id}:temp`, h.maxTemp?.tempC, now);
    }
    for (const l of llms.snapshots()) {
      if (l.state !== "up") continue;
      history.record(`llm:${l.id}:genTps`, l.genTokensPerSec, now);
    }
  };

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
      await recipes.update(llms.snapshots());
      recordHistory();
      http.broadcast();
    } catch (err) {
      log(`poll failed: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  };

  const pollUsage = () => {
    usage.poll().then(
      () => http.broadcast(),
      (err: Error) => log(`usage poll failed: ${err.message}`),
    );
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
  pollUsage();
  setTimeout(() => void recipes.checkAllUpstreams().then(() => http.broadcast()), 15_000);
  const timers = [
    setInterval(pollUsage, 60_000),
    // Upstreams move a few times a day; a fetch every few hours is plenty.
    setInterval(() => void recipes.checkAllUpstreams().then(() => http.broadcast()), 3 * 3600_000),
    setInterval(tick, config.pollSeconds * 1000),
    // Each service has its own schedule (and back-off); this only checks who is due.
    setInterval(pollSubscriptions, 30_000),
    setInterval(() => {
      try {
        store.setHistory(history.dump());
        store.flush();
      } catch (err) {
        log(`could not save state: ${(err as Error).message}`);
      }
    }, 30_000),
  ];

  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    try {
      store.setHistory(history.dump());
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
