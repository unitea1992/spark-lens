import assert from "node:assert/strict";
import { test } from "node:test";
import { counterRate, cpuPercent, gpuAwakePercent, gpuPowerWatts, parseProbe } from "../collectors/hosts.ts";
import { pushRecent, RECENT_POINTS } from "../collectors/recent.ts";

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
@@pressure
some avg10=0.04 avg60=0.20 avg300=0.13 total=932040
full avg10=0.00 avg60=0.00 avg300=0.00 total=100
oom_kill 8
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
@@ib
rocep1s0f0 1000 2000 200
@@docker
glm53-exl3-head|ghcr.io/example/image:tag|running|Up 2 hours|GLM-5.3-Flash-EXL3
old|img|exited|Exited (0) 4 days ago
@ok
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
  assert.deepEqual(s.pressure, { someAvg10: 0.04, fullAvg10: 0, oomKills: 8 });
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
  assert.equal(s.containers[0]?.status, "Up 2 hours");
  assert.equal(s.containers[0]?.servedName, "GLM-5.3-Flash-EXL3");
  assert.equal(s.containers[1]?.servedName, null);
  // The "@ok" line marks a list Docker returned; it is not a container.
  assert.equal(s.containers.length, 2);
  assert.equal(s.containersKnown, true);
  // Without it (docker ps failed or timed out) the empty list is not trusted.
  assert.equal(parseProbe(SPARK.replace("@ok\n", ""))?.containersKnown, false);
  // RDMA counters count 4-byte words.
  assert.deepEqual(s.ib, [{ device: "rocep1s0f0", rx: 4000, tx: 8000, rateGbps: 200, up: true, errors: null }]);
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

test("counterRate gives no rate without an earlier reading, over no time, or when the counter went back", () => {
  assert.equal(counterRate(3000, 1000, 2), 1000);
  assert.equal(counterRate(3000, undefined, 2), null);
  assert.equal(counterRate(3000, 1000, 0), null);
  assert.equal(counterRate(500, 1000, 2), null);
});

test("pushRecent keeps only the newest samples", () => {
  const arr: number[] = [];
  for (let i = 0; i < RECENT_POINTS + 5; i++) pushRecent(arr, i);
  assert.equal(arr.length, RECENT_POINTS);
  assert.equal(arr[0], 5);
});

test("probes reach a remote host through one shared ssh connection, with short timeouts", async () => {
  const { sshBashArgs } = await import("../exec.ts");
  const { PROBE_SSH_OPTIONS } = await import("../collectors/hosts.ts");
  assert.deepEqual(sshBashArgs("/run/sl", "spark-1", PROBE_SSH_OPTIONS), [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/run/sl/ssh-%C",
    "-o", "ControlPersist=120",
    "--",
    "spark-1",
    "bash -s",
  ]);
});

test("recipe commands use the same shared connection, with only a connect timeout", async () => {
  const { sshBashArgs } = await import("../exec.ts");
  const { RECIPE_SSH_OPTIONS } = await import("../recipes.ts");
  assert.deepEqual(sshBashArgs("/run/sl", "spark-1", RECIPE_SSH_OPTIONS), [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/run/sl/ssh-%C",
    "-o", "ControlPersist=120",
    "--",
    "spark-1",
    "bash -s",
  ]);
});

test("disk I/O readings preserve physical device identity for multiple mounts", () => {
  const sample = parseProbe(`@@disk
/dev/nvme0n1p2 10000 4000 6000 40% /
/dev/nvme0n1p3 5000 1000 4000 20% /data
@@diskio
/|nvme0n1|1000|500
/data|nvme0n1|1000|500
@@end
`);
  assert.deepEqual(sample?.diskIo, [
    { mount: "/", device: "nvme0n1", readSectors: 1000, writeSectors: 500 },
    { mount: "/data", device: "nvme0n1", readSectors: 1000, writeSectors: 500 },
  ]);
  assert.equal(counterRate(1500 * 512, 1000 * 512, 5), 51200);
  assert.equal(counterRate(200 * 512, 1000 * 512, 5), null);
});


test("pressure telemetry is optional on older kernels and rejects unusable samples", () => {
  const s = parseProbe("@@host\nhostname=dev\n@@pressure\nsome avg10=150.00 avg60=0.0 total=0\nfull avg10=4.75 avg60=0 total=0\n@@end\n");
  assert.deepEqual(s?.pressure, { someAvg10: null, fullAvg10: 4.75, oomKills: null });
  assert.deepEqual(parseProbe("@@host\nhostname=dev\n@@end\n")?.pressure, { someAvg10: null, fullAvg10: null, oomKills: null });
});

test("an Intel GPU reports idle time per GT, not a busy percentage", () => {
  const probe = (row: string) => parseProbe(`@@host\nhostname=dev\n@@gpu\n${row}\n@@end\n`);
  const s = probe("intel|Panther Lake [Arc B390]|1700000005000|tile0.gt0=4000 tile0.gt1=4900");
  assert.equal(s?.gpu?.vendor, "intel");
  assert.equal(s?.gpu?.name, "Intel Arc B390");
  // A rate needs two readings: the GPU is there, its usage not yet known.
  assert.equal(s?.gpu?.utilPct, null);
  assert.equal(s?.gpu?.clockMhz, null);
  assert.equal(s?.gpu?.powerW, null);
  // The energy counter is root's until the machine opens it: no power then, the rest as usual.
  assert.deepEqual(s?.gpuCounters, { atMs: 1700000005000, idleMs: { "tile0.gt0": 4000, "tile0.gt1": 4900 }, energyUj: null, energyRangeUj: null });
  const open = probe("intel|Panther Lake [Arc B390]|1700000005000|tile0.gt0=4000|432386954|262143328850");
  assert.equal(open?.gpuCounters?.energyUj, 432386954);
  assert.equal(open?.gpuCounters?.energyRangeUj, 262143328850);

  // Without lspci on the machine the row carries no name.
  assert.equal(probe("intel||1700000005000|tile0.gt0=4000")?.gpu?.name, "Intel GPU");
  assert.equal(probe("intel|Device b082|1700000005000|tile0.gt0=4000")?.gpu?.name, "Intel GPU");
  assert.equal(probe("intel|Intel UHD Graphics|1700000005000|tile0.gt0=4000")?.gpu?.name, "Intel UHD Graphics");
});

test("a discrete GPU is shown rather than the Intel one beside it", () => {
  const s = parseProbe(
    "@@host\nhostname=dev\n@@gpu\nnvidia|RTX|7|50|30.0|100|8000|900|2100\nintel|Arc|1700000005000|tile0.gt0=4000\n@@end\n",
  );
  assert.equal(s?.gpu?.vendor, "nvidia");
  assert.equal(s?.gpuCounters, null);
});

test("Intel GPU usage is the awake share of its busiest GT", () => {
  const at = (atMs: number, gt0: number, gt1: number) => ({ atMs, idleMs: { "tile0.gt0": gt0, "tile0.gt1": gt1 }, energyUj: null, energyRangeUj: null });
  // 5 s apart: the render GT slept 4 s of them, the media GT all 5.
  assert.equal(gpuAwakePercent(at(0, 1000, 1000), at(5000, 5000, 6000)), 20);
  // The media GT counts when it is the one working.
  assert.equal(gpuAwakePercent(at(0, 1000, 1000), at(5000, 6000, 2000)), 80);
  // The counter and the clock are read a moment apart: never below 0 or above 100.
  assert.equal(gpuAwakePercent(at(0, 1000, 1000), at(5000, 6010, 6010)), 0);
  // No earlier reading, a clock that did not move, or a counter that restarted: no figure.
  assert.equal(gpuAwakePercent(null, at(5000, 5000, 6000)), null);
  assert.equal(gpuAwakePercent(at(5000, 1000, 1000), at(5000, 5000, 6000)), null);
  assert.equal(gpuAwakePercent(at(0, 9000, 9000), at(5000, 10, 10)), null);
  assert.equal(gpuAwakePercent(at(0, 9000, 1000), at(5000, 10, 6000)), 0);
});

test("Intel GPU power is the energy counter's growth over the time between readings", () => {
  const at = (atMs: number, energyUj: number | null, energyRangeUj: number | null = 1_000_000_000) => ({ atMs, idleMs: {}, energyUj, energyRangeUj });
  // 76.8 J in 5 s.
  assert.equal(gpuPowerWatts(at(0, 1_000_000), at(5000, 77_800_000)), 15.36);
  assert.equal(gpuPowerWatts(at(0, 1_000_000), at(5000, 1_000_000)), 0);
  // The counter wrapped past its range.
  assert.equal(gpuPowerWatts(at(0, 999_000_000), at(5000, 4_000_000)), 1);
  // A counter that went backwards with no known range, or further than the range allows, was reset.
  assert.equal(gpuPowerWatts(at(0, 999_000_000), at(5000, 4_000_000, null)), null);
  assert.equal(gpuPowerWatts(at(0, 2_000_000_000), at(5000, 4_000_000)), null);
  // Unreadable on either side, no earlier reading, or no time passed: no figure.
  assert.equal(gpuPowerWatts(at(0, null), at(5000, 4_000_000)), null);
  assert.equal(gpuPowerWatts(at(0, 1_000_000), at(5000, null)), null);
  assert.equal(gpuPowerWatts(null, at(5000, 4_000_000)), null);
  assert.equal(gpuPowerWatts(at(5000, 1_000_000), at(5000, 4_000_000)), null);
});
