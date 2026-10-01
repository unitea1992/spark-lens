import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../server/types.ts";
import { layout } from "./lab.ts";

const host = (id: string, kind: HostSnapshot["kind"]) => ({ id, label: id, kind }) as HostSnapshot;
const llm = (id: string, nodes: string[], state: LlmSnapshot["state"]) => ({ id, label: id, nodes, state }) as LlmSnapshot;
const snap = (hosts: HostSnapshot[], llms: LlmSnapshot[]) => ({ hosts, llms }) as Snapshot;

test("models on the same machines share one cluster, running model first", () => {
  const s = snap(
    [host("dev", "workstation"), host("a", "spark"), host("b", "spark")],
    [llm("glm", ["a", "b"], "down"), llm("qwen", ["a", "b"], "up")],
  );
  const { observers, clusters } = layout(s);
  assert.deepEqual(observers.map((h) => h.id), ["dev"]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0]!.hosts.map((h) => h.id), ["a", "b"]);
  assert.deepEqual(clusters[0]!.llms.map((l) => l.id), ["qwen", "glm"]);
});

test("a model on one of the machines joins that cluster; separate machines get their own", () => {
  const s = snap(
    [host("a", "spark"), host("b", "spark"), host("c", "spark"), host("d", "server")],
    [llm("big", ["a", "b"], "up"), llm("small", ["b"], "down"), llm("other", ["c"], "up")],
  );
  const { clusters } = layout(s);
  assert.deepEqual(
    clusters.map((c) => [c.hosts.map((h) => h.id), c.llms.map((l) => l.id)]),
    [
      [["a", "b"], ["big", "small"]],
      [["c"], ["other"]],
      [["d"], []],
    ],
  );
});
