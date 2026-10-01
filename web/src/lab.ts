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
 */
export function layout(s: Snapshot): { observers: HostSnapshot[]; clusters: Cluster[] } {
  const clusters: Cluster[] = [];
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
    clusters.push(cluster);
  }
  const order = { up: 0, starting: 1, down: 2 } as const;
  for (const c of clusters) c.llms.sort((a, b) => order[a.state] - order[b.state]);
  const observers = s.hosts.filter((h) => !owner.has(h.id) && h.kind === "workstation");
  const rest = s.hosts.filter((h) => !owner.has(h.id) && h.kind !== "workstation");
  if (rest.length > 0) clusters.push({ key: "rest", hosts: rest, llms: [] });
  return { observers, clusters };
}

