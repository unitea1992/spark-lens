import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuPercent, parseProbe } from "../collectors/hosts.ts";

const SPARK = `@@host
hostname=spark-1
kernel=7.0.0-1019-nvidia
arch=aarch64
ncpu=20
uptime=173886.48
load=7.72 3.91 1.66
os=Ubuntu 24.04.5 LTS
cpu_model=Cortex-X925+Cortex-A725
@@cpu
cpu  449881 10969 2283299 344656881 30207 0 12433 0 0 0
@@freq
40000000 40000000 20 56160000
@@mem
MemTotal:       127532364 kB
MemAvailable:   123000000 kB
SwapTotal:       16777212 kB
SwapFree:        16777212 kB
@@disk
/dev/nvme0n1p2 3936818806784 1288490188800 2448240345088      35% /
@@temp
acpitz||46300
nvme|Composite|40850
mlx5|asic|50000
mt7925_phy0||0
@@gpu
nvidia|NVIDIA GB10|0|43|3.60|[N/A]|[N/A]|208|3003
@@gpucap
2200
@@gpuproc
4242|VLLM::Worker_TP0|[N/A]
@@net
enP7s7 11253613566 1268300775 up 10000
wlP9s9 0 0 down -1
@@docker
glm53-exl3-head|ghcr.io/example/image:tag|running|Up 2 hours
old|img|exited|Exited (0) 4 days ago
@@procs
812|120|12.5|204800|/home/me/project|codex exec --json
@@end
`;

test("parses a DGX Spark probe", () => {
  const s = parseProbe(SPARK);
  assert.ok(s);
  assert.equal(s.host.hostname, "spark-1");
  assert.equal(s.cpu.length, 10);
  assert.deepEqual(s.freq, { curKhz: 40000000, maxKhz: 40000000, cores: 20, hwMaxKhz: 56160000 });
  // A persisted clock lock lowers the GPU's reported maximum.
  assert.equal(s.gpu?.clockMaxMhz, 2200);
  assert.equal(s.mem.MemTotal, 127532364 * 1024);
  assert.equal(s.disks[0]?.mount, "/");
  // The disconnected Wi-Fi sensor reporting 0 is dropped.
  assert.deepEqual(s.temps.map((t) => t.chip), ["acpitz", "nvme", "mlx5"]);
  assert.equal(s.gpu?.vendor, "nvidia");
  assert.equal(s.gpu?.utilPct, 0);
  assert.equal(s.gpu?.powerW, 3.6);
  // Unified memory: nvidia-smi reports no GPU memory figures.
  assert.equal(s.gpu?.memTotalBytes, null);
  assert.deepEqual(s.gpuProcesses, [{ pid: 4242, name: "VLLM::Worker_TP0", memBytes: null }]);
  assert.equal(s.net.length, 2);
  assert.equal(s.net[0]?.speedMbps, 10000);
  assert.equal(s.net[1]?.speedMbps, null);
  assert.equal(s.containers[0]?.state, "running");
  assert.deepEqual(s.procs[0], {
    pid: 812,
    elapsedSec: 120,
    cpuPct: 12.5,
    rssBytes: 204800 * 1024,
    cwd: "/home/me/project",
    args: "codex exec --json",
  });
});

test("parses an AMD integrated GPU in physical units", () => {
  const s = parseProbe("@@host\nhostname=dev\n@@gpu\namd|card0|12|39000|26039000|89903104|12884901888\n@@end\n");
  assert.equal(s?.gpu?.vendor, "amd");
  assert.equal(s?.gpu?.utilPct, 12);
  assert.equal(s?.gpu?.tempC, 39);
  assert.ok(Math.abs((s?.gpu?.powerW ?? 0) - 26.039) < 1e-9);
});

test("rejects a probe that was cut off before its end marker", () => {
  assert.equal(parseProbe(SPARK.replace("@@end\n", "")), null);
  assert.equal(parseProbe(""), null);
});

test("keeps a command line that itself contains the field separator", () => {
  const s = parseProbe("@@procs\n7|1|0.0|10|/tmp|sh -c a|b|c\n@@end\n");
  assert.equal(s?.procs[0]?.args, "sh -c a|b|c");
});

test("cpuPercent measures the busy share between two readings", () => {
  const before = [100, 0, 100, 800, 0, 0, 0, 0];
  const after = [150, 0, 150, 900, 0, 0, 0, 0];
  assert.equal(cpuPercent(before, after), 50);
  assert.equal(cpuPercent(before, before), null);
  assert.equal(cpuPercent([], after), null);
});

test("reads the old three-field frequency line", () => {
  const s = parseProbe("@@freq\n100 200 2\n@@end\n");
  assert.deepEqual(s?.freq, { curKhz: 100, maxKhz: 200, cores: 2, hwMaxKhz: 200 });
});
