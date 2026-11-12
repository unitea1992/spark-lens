import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../server/types.ts";

export interface Cluster {
  key: string;
  hosts: HostSnapshot[];
  llms: LlmSnapshot[];
}

/**
 * Hosts grouped the way they are wired. Models that run on the same set of
 * machines (two recipes for one pair of Sparks, say) share one cluster and
 * stack their bands under it; the running one comes first.
 *
 * The groups come in two sides: the dev machines, each on its own unless a
 * model spans several, and everything else (the inference machines).
 */
export function layout(s: Snapshot): { devs: Cluster[]; clusters: Cluster[] } {
  const all: Cluster[] = [];
  const owner = new Map<string, Cluster>();
  for (const llm of s.llms) {
    const hosts = llm.nodes.map((id) => s.hosts.find((h) => h.id === id)).filter((h): h is HostSnapshot => !!h);
    if (hosts.length === 0) continue;
    const existing = hosts.map((h) => owner.get(h.id)).find((c) => c !== undefined);
    if (existing) {
      existing.llms.push(llm);
      for (const h of hosts) {
        if (!owner.has(h.id)) {
          existing.hosts.push(h);
          owner.set(h.id, existing);
        }
      }
      continue;
    }
    const cluster: Cluster = { key: llm.id, hosts, llms: [llm] };
    hosts.forEach((h) => owner.set(h.id, cluster));
    all.push(cluster);
  }
  const order = { up: 0, starting: 1, down: 2 } as const;
  for (const c of all) c.llms.sort((a, b) => order[a.state] - order[b.state]);
  // A dev machine with no model of its own still has its place on the dev side.
  for (const h of s.hosts) {
    if (!owner.has(h.id) && h.kind === "workstation") all.push({ key: `host:${h.id}`, hosts: [h], llms: [] });
  }
  const isDev = (c: Cluster) => c.hosts.every((h) => h.kind === "workstation");
  const position = (c: Cluster) => Math.min(...c.hosts.map((h) => s.hosts.indexOf(h)));
  const devs = all.filter(isDev).sort((a, b) => position(a) - position(b));
  const clusters = all.filter((c) => !isDev(c));
  const rest = s.hosts.filter((h) => !owner.has(h.id) && h.kind !== "workstation");
  if (rest.length > 0) clusters.push({ key: "rest", hosts: rest, llms: [] });
  return { devs, clusters };
}

/** The models to draw under their machines: the ones answering or loading right now. */
export function liveModels(llms: LlmSnapshot[]): LlmSnapshot[] {
  return llms.filter((l) => l.state !== "down");
}
