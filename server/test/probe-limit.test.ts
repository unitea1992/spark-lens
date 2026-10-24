import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseProbe } from "../collectors/hosts.ts";
import { containersMaxConcurrent } from "../collectors/llm.ts";

test("probe.sh reads the request limit from a container's command", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-probe-"));
  try {
    writeFileSync(
      join(dir, "docker"),
      [
        "#!/bin/sh",
        "cat <<'EOT'",
        'tf|img|running|Up 2h|"/srv/engine --name Model-A --parallel 4 --port 1"',
        'vl|img|running|Up|"vllm serve m --max-num-seqs=16 --served-model-name m"',
        'py|img|running|Up|"python -m engine --port 1"',
        "sh|img|running|Up|\"sh -c 'run --parallel \\\"8\\\"'\"",
        'gap|img|running|Up|"x --parallel --foo 5"',
        'next|img|running|Up|"x --parallel --port=8000"',
        'neg|img|running|Up|"x --parallel -1"',
        'zero|img|running|Up|"x --max-num-seqs 0"',
        'tail|img|running|Up|"x --max-running-requests 12"',
        "EOT",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const out = execFileSync("bash", [fileURLToPath(new URL("../probe.sh", import.meta.url))], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 30_000,
    });
    const s = parseProbe(out);
    const limits = Object.fromEntries((s?.containers ?? []).map((c) => [c.name, c.maxConcurrent]));
    assert.deepEqual(limits, { tf: 4, vl: 16, py: null, sh: 8, gap: null, next: null, neg: null, zero: null, tail: 12 });
    assert.equal(s?.containers[0]?.servedName, "Model-A");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line from an older probe without the limit field reads as unknown", () => {
  const s = parseProbe("@@host\nhostname=dev\n@@docker\nfoo|img|running|Up|M\n@ok\n@@end\n");
  assert.equal(s?.containers[0]?.maxConcurrent, null);
});

test("the LLM's limit is the first running container that sets one", () => {
  assert.equal(containersMaxConcurrent([{ state: "exited", maxConcurrent: 2 }, { state: "running", maxConcurrent: null }, { state: "running", maxConcurrent: 4 }]), 4);
  assert.equal(containersMaxConcurrent([{ state: "running" }]), null);
  assert.equal(containersMaxConcurrent([]), null);
});
