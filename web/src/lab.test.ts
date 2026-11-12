import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSnapshot, LlmSnapshot, Snapshot } from "../../server/types.ts";
import { layout, liveModels } from "./lab.ts";

const host = (id: string, kind: HostSnapshot["kind"]) => ({ id, label: id, kind }) as HostSnapshot;
const llm = (id: string, nodes: string[], state: LlmSnapshot["state"]) => ({ id, label: id, nodes, state }) as LlmSnapshot;
const snap = (hosts: HostSnapshot[], llms: LlmSnapshot[]) => ({ hosts, llms }) as Snapshot;

test("models on the same machines share one cluster, running model first", () => {
  const s = snap(
    [host("dev", "workstation"), host("a", "spark"), host("b", "spark")],
    [llm("glm", ["a", "b"], "down"), llm("qwen", ["a", "b"], "up")],
  );
  const { devs, clusters } = layout(s);
  assert.deepEqual(devs.map((c) => c.hosts.map((h) => h.id)), [["dev"]]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0]!.hosts.map((h) => h.id), ["a", "b"]);
  assert.deepEqual(clusters[0]!.llms.map((l) => l.id), ["qwen", "glm"]);
});

test("a model on one of the machines joins that cluster; separate machines get their own", () => {
  const s = snap(
    [host("a", "spark"), host("b", "spark"), host("c", "spark"), host("d", "server")],
    [llm("big", ["a", "b"], "up"), llm("small", ["b"], "down"), llm("other", ["c"], "up")],
  );
  const { devs, clusters } = layout(s);
  assert.deepEqual(devs, []);
  assert.deepEqual(
    clusters.map((c) => [c.hosts.map((h) => h.id), c.llms.map((l) => l.id)]),
    [
      [["a", "b"], ["big", "small"]],
      [["c"], ["other"]],
      [["d"], []],
    ],
  );
});

test("dev machines form the dev side in their configured order, with or without a model of their own", () => {
  const s = snap(
    [host("dev1", "workstation"), host("a", "spark"), host("dev2", "workstation"), host("b", "spark")],
    [llm("big", ["a", "b"], "up"), llm("router", ["dev2"], "down")],
  );
  const { devs, clusters } = layout(s);
  assert.deepEqual(
    devs.map((c) => [c.hosts.map((h) => h.id), c.llms.map((l) => l.id)]),
    [
      [["dev1"], []],
      [["dev2"], ["router"]],
    ],
  );
  assert.deepEqual(clusters.map((c) => c.hosts.map((h) => h.id)), [["a", "b"]]);
});

test("a dev machine that serves a model together with an inference machine stays with it", () => {
  const s = snap([host("dev", "workstation"), host("a", "spark")], [llm("split", ["a", "dev"], "up")]);
  const { devs, clusters } = layout(s);
  assert.deepEqual(devs, []);
  assert.deepEqual(clusters.map((c) => c.hosts.map((h) => h.id)), [["a", "dev"]]);
});

test("only models that answer or load are drawn under their machines", () => {
  const llms = [llm("stopped", ["a"], "down"), llm("loading", ["a"], "starting"), llm("serving", ["a"], "up")];
  assert.deepEqual(liveModels(llms).map((l) => l.id), ["loading", "serving"]);
  assert.deepEqual(liveModels([llm("stopped", ["a"], "down")]), []);
});
