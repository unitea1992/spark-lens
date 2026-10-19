// Runs the dashboard's benchmark for one local model from the command line and prints the result:
//   pnpm bench <llm-id>
// It asks the running Spark Lens (the address in its config) to start, as the dashboard's button does, and waits.

import { loadConfig } from "../server/config.ts";
import { ACTION_HEADER } from "../server/http.ts";
import type { BenchRun, BenchState } from "../server/types.ts";

const llmId = process.argv[2];
const { config } = loadConfig();
if (!llmId) {
  console.error(`usage: pnpm bench <llm-id>\n  ${config.llms.map((l) => l.id).join("\n  ")}`);
  process.exit(2);
}
const host = config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
const base = `http://${host.includes(":") ? `[${host}]` : host}:${config.server.port}`;

const started = await fetch(`${base}/api/llms/${llmId}/bench`, { method: "POST", headers: { [ACTION_HEADER]: "1" } });
const answer = (await started.json()) as { ok: boolean; message: string };
if (!answer.ok) {
  console.error(answer.message);
  process.exit(1);
}
const since = Date.now();
let last = "";
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const state = (await (await fetch(`${base}/api/state`)).json()) as { bench?: Record<string, BenchState> };
  const b = state.bench?.[llmId];
  if (!b) continue;
  if (b.running) {
    const line = `${b.done}/${b.total} ${b.stage ?? ""}`;
    if (line !== last) console.error(line);
    last = line;
    continue;
  }
  const run: BenchRun | undefined = b.runs.find((r) => r.at >= since - 5000);
  if (!run) {
    console.error("the benchmark ended without a result (stopped?)");
    process.exit(1);
  }
  console.log(JSON.stringify(run, null, 2));
  // Not process.exit(): a piped stdout would be cut short.
  process.exitCode = run.error ? 1 : 0;
  break;
}
