import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../exec.ts";
import type {
  ContainerInfo,
  DiskInfo,
  GpuInfo,
  HostConfig,
  HostProcess,
  HostSnapshot,
  NetInfo,
  TempReading,
} from "../types.ts";

const PROBE = readFileSync(new URL("../probe.sh", import.meta.url), "utf8");
const HISTORY_POINTS = 120;

/** Raw, rate-free view of one probe run. */
export interface ProbeSample {
  host: Record<string, string>;
  cpu: number[];
  /** maxKhz is the allowed maximum (a cap when one is set); hwMaxKhz the hardware one. */
  freq: { curKhz: number; maxKhz: number; cores: number; hwMaxKhz: number } | null;
  mem: Record<string, number>;
  disks: DiskInfo[];
  temps: TempReading[];
  gpu: GpuInfo | null;
  gpuProcesses: { pid: number; name: string; memBytes: number | null }[];
  net: { iface: string; rx: number; tx: number; up: boolean; speedMbps: number | null }[];
  containers: ContainerInfo[];
  procs: HostProcess[];
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v === "" || v.startsWith("[")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function splitSections(text: string): Map<string, string[]> | null {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  let ended = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const name = line.slice(2).trim();
      if (name === "end") {
        ended = true;
        break;
      }
      current = [];
      sections.set(name, current);
    } else if (current && line !== "") {
      current.push(line);
    }
  }
  // A probe cut off mid-run would otherwise read as a machine with no GPU,
  // no disks and no containers.
  return ended ? sections : null;
}

function parseGpu(rows: string[]): GpuInfo | null {
  let nvidia: GpuInfo | null = null;
  let amd: GpuInfo | null = null;
  for (const row of rows) {
    const f = row.split("|");
    if (f[0] === "nvidia" && !nvidia) {
      const used = num(f[5]);
      const total = num(f[6]);
      nvidia = {
        vendor: "nvidia",
        name: f[1]?.trim() ?? "GPU",
        utilPct: num(f[2]),
        tempC: num(f[3]),
        powerW: num(f[4]),
        memUsedBytes: used === null ? null : used * 1024 * 1024,
        memTotalBytes: total === null ? null : total * 1024 * 1024,
        clockMhz: num(f[7]),
        clockMaxMhz: num(f[8]),
      };
    } else if (f[0] === "amd" && !amd) {
      const temp = num(f[3]);
      const power = num(f[4]);
      amd = {
        vendor: "amd",
        name: "Radeon",
        utilPct: num(f[2]),
        tempC: temp === null ? null : temp / 1000,
        powerW: power === null ? null : power / 1e6,
        memUsedBytes: num(f[5]),
        memTotalBytes: num(f[6]),
        clockMhz: null,
        clockMaxMhz: null,
      };
    }
  }
  return nvidia ?? amd;
}

export function parseProbe(text: string): ProbeSample | null {
  const s = splitSections(text);
  if (!s) return null;
  const host: Record<string, string> = {};
  for (const line of s.get("host") ?? []) {
    const i = line.indexOf("=");
    if (i > 0) host[line.slice(0, i)] = line.slice(i + 1);
  }
  const cpuRow = (s.get("cpu") ?? [])[0] ?? "";
  const cpu = cpuRow.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);

  const freqRow = ((s.get("freq") ?? [])[0] ?? "").split(/\s+/).map(Number);
  const freq =
    freqRow.length >= 3 && freqRow[2]! > 0
      ? { curKhz: freqRow[0]!, maxKhz: freqRow[1]!, cores: freqRow[2]!, hwMaxKhz: freqRow[3] ?? freqRow[1]! }
      : null;

  const mem: Record<string, number> = {};
  for (const line of s.get("mem") ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) mem[m[1]!] = Number(m[2]) * 1024;
  }

  const disks: DiskInfo[] = [];
  for (const line of s.get("disk") ?? []) {
    const f = line.split(/\s+/);
    const total = Number(f[1]);
    const used = Number(f[2]);
    if (f.length >= 6 && Number.isFinite(total) && Number.isFinite(used)) {
      disks.push({ mount: f.slice(5).join(" "), totalBytes: total, usedBytes: used });
    }
  }

  const temps: TempReading[] = [];
  for (const line of s.get("temp") ?? []) {
    const [chip, label, raw] = line.split("|");
    const v = num(raw);
    // Disconnected sensors report 0 or absurd values.
    if (chip && v !== null && v > 1000 && v < 150_000) temps.push({ chip, label: label ?? "", tempC: v / 1000 });
  }

  const gpuProcesses = (s.get("gpuproc") ?? []).flatMap((line) => {
    const [pid, name, memMib] = line.split("|");
    const p = num(pid);
    if (p === null) return [];
    const m = num(memMib);
    return [{ pid: p, name: (name ?? "").trim(), memBytes: m === null ? null : m * 1024 * 1024 }];
  });

  const net = (s.get("net") ?? []).flatMap((line) => {
    const f = line.split(/\s+/);
    const rx = Number(f[1]);
    const tx = Number(f[2]);
    if (!f[0] || !Number.isFinite(rx) || !Number.isFinite(tx)) return [];
    const speed = Number(f[4]);
    return [{ iface: f[0], rx, tx, up: f[3] === "up", speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null }];
  });

  const containers = (s.get("docker") ?? []).flatMap((line) => {
    const [name, image, state, ...status] = line.split("|");
    return name ? [{ name, image: image ?? "", state: state ?? "", status: status.join("|") }] : [];
  });

  const procs = (s.get("procs") ?? []).flatMap((line) => {
    const f = line.split("|");
    const pid = num(f[0]);
    if (pid === null || f.length < 6) return [];
    return [
      {
        pid,
        elapsedSec: num(f[1]) ?? 0,
        cpuPct: num(f[2]) ?? 0,
        rssBytes: (num(f[3]) ?? 0) * 1024,
        cwd: f[4] ?? "",
        args: f.slice(5).join("|"),
      },
    ];
  });

  const gpu = parseGpu(s.get("gpu") ?? []);
  const cap = num((s.get("gpucap") ?? [])[0]);
  if (gpu && cap !== null && cap > 0 && (gpu.clockMaxMhz === null || cap < gpu.clockMaxMhz)) gpu.clockMaxMhz = cap;

  return { host, cpu, freq, mem, disks, temps, gpu, gpuProcesses, net, containers, procs };
}

/** Busy share of CPU time between two /proc/stat readings, 0..100. */
export function cpuPercent(prev: number[], next: number[]): number | null {
  if (prev.length < 5 || next.length < 5) return null;
  const total = (a: number[]) => a.slice(0, 8).reduce((x, y) => x + y, 0);
  const idle = (a: number[]) => a[3]! + a[4]!;
  const dTotal = total(next) - total(prev);
  if (dTotal <= 0) return null;
  const busy = 1 - (idle(next) - idle(prev)) / dTotal;
  return Math.min(100, Math.max(0, busy * 100));
}

const CPU_CHIPS = new Set(["k10temp", "coretemp", "zenpower", "cpu_thermal", "acpitz"]);

function cpuTemp(temps: TempReading[]): number | null {
  const cpu = temps.filter((t) => CPU_CHIPS.has(t.chip));
  // Prefer a real CPU sensor over the generic ACPI zone when both exist.
  const specific = cpu.filter((t) => t.chip !== "acpitz");
  const pool = specific.length > 0 ? specific : cpu;
  return pool.length > 0 ? Math.max(...pool.map((t) => t.tempC)) : null;
}

function push<T>(arr: T[], value: T): void {
  arr.push(value);
  if (arr.length > HISTORY_POINTS) arr.splice(0, arr.length - HISTORY_POINTS);
}

interface HostState {
  config: HostConfig;
  snapshot: HostSnapshot;
  prev: { at: number; sample: ProbeSample } | null;
  procs: HostProcess[];
  busy: boolean;
  failures: number;
}

/** Consecutive failed probes before a machine that was answering is shown as down. */
const OFFLINE_AFTER = 2;

function emptySnapshot(config: HostConfig, stepSec: number): HostSnapshot {
  return {
    id: config.id,
    label: config.label,
    kind: config.kind,
    online: false,
    error: null,
    lastSeen: null,
    latencyMs: null,
    hostname: null,
    os: null,
    kernel: null,
    cpuModel: null,
    ncpu: null,
    uptimeSec: null,
    load: null,
    cpuPct: null,
    clockPct: null,
    clockMhz: null,
    clockMaxMhz: null,
    memTotalBytes: null,
    memUsedBytes: null,
    swapTotalBytes: null,
    swapUsedBytes: null,
    disks: [],
    gpu: null,
    maxTemp: null,
    cpuTempC: null,
    temps: [],
    net: [],
    containers: [],
    gpuProcesses: [],
    history: { stepSec, cpu: [], gpu: [], mem: [], temp: [], power: [] },
  };
}

function describeFailure(stderr: string, timedOut: boolean, code: number | null): string {
  if (timedOut) return "timed out";
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ? line.slice(0, 160) : `probe exited with code ${code}`;
}

export class HostCollector {
  private readonly states: HostState[];
  private readonly controlDir: string;
  private readonly procRegex: string;
  private readonly timeoutMs: number;

  constructor(hosts: HostConfig[], opts: { procRegex: string; pollSeconds: number; runtimeDir: string }) {
    this.states = hosts.map((config) => ({
      config,
      snapshot: emptySnapshot(config, opts.pollSeconds),
      prev: null,
      procs: [],
      busy: false,
      failures: 0,
    }));
    this.procRegex = opts.procRegex;
    this.controlDir = opts.runtimeDir;
    this.timeoutMs = Math.max(4000, opts.pollSeconds * 1000 * 2);
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
  }

  snapshots(): HostSnapshot[] {
    return this.states.map((s) => s.snapshot);
  }

  processes(): { host: HostConfig; procs: HostProcess[]; online: boolean }[] {
    return this.states.map((s) => ({ host: s.config, procs: s.procs, online: s.snapshot.online }));
  }

  async poll(): Promise<void> {
    await Promise.all(this.states.map((s) => this.pollOne(s)));
  }

  private script(config: HostConfig): string {
    const mounts = (config.mounts ?? ["/"]).join(" ");
    return `export SL_PROC_RE='${this.procRegex}'\nexport SL_MOUNTS='${mounts}'\n${PROBE}`;
  }

  private async pollOne(state: HostState): Promise<void> {
    // A slow host must not pile up probes behind itself.
    if (state.busy) return;
    state.busy = true;
    try {
      const { config } = state;
      const input = this.script(config);
      const result = config.local
        ? await run("bash", ["-s"], { input, timeoutMs: this.timeoutMs })
        : await run(
            "ssh",
            [
              "-T",
              "-o", "BatchMode=yes",
              "-o", "ConnectTimeout=5",
              "-o", "ServerAliveInterval=5",
              "-o", "ServerAliveCountMax=2",
              "-o", "ControlMaster=auto",
              "-o", `ControlPath=${join(this.controlDir, "ssh-%C")}`,
              "-o", "ControlPersist=120",
              "--",
              config.ssh!,
              "bash -s",
            ],
            { input, timeoutMs: this.timeoutMs },
          );
      // Judge the run by its output, not the exit status: Tailscale SSH now and
      // then ends a session that ran to completion with status 255.
      const sample = result.timedOut ? null : parseProbe(result.stdout);
      if (!sample) {
        state.failures += 1;
        const reason = result.code === 0 ? "probe output was incomplete" : describeFailure(result.stderr, result.timedOut, result.code);
        // One dropped probe (a busy machine, a Wi-Fi blip) is not an outage:
        // keep the last reading on screen until a second one fails too.
        if (state.snapshot.online && state.failures < OFFLINE_AFTER) return;
        if (state.snapshot.online || state.snapshot.error !== reason) {
          console.log(`[spark-lens] ${config.id}: not responding (${reason})`);
        }
        state.snapshot = {
          ...state.snapshot,
          online: false,
          error: reason,
          latencyMs: null,
        };
        state.procs = [];
        // Rates after the outage must not be averaged across it.
        state.prev = null;
        this.recordHistory(state.snapshot, true);
        return;
      }
      this.apply(state, sample, result.durationMs);
    } finally {
      state.busy = false;
    }
  }

  private apply(state: HostState, sample: ProbeSample, latencyMs: number): void {
    const now = Date.now();
    if (!state.snapshot.online && state.snapshot.lastSeen !== null) console.log(`[spark-lens] ${state.config.id}: responding again`);
    state.failures = 0;
    const prev = state.prev;
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const h = sample.host;

    const memTotal = sample.mem.MemTotal ?? null;
    const memAvail = sample.mem.MemAvailable ?? null;
    const swapTotal = sample.mem.SwapTotal ?? null;
    const swapFree = sample.mem.SwapFree ?? null;

    const net: NetInfo[] = sample.net.map((n) => {
      const before = prev?.sample.net.find((p) => p.iface === n.iface);
      const rate = (a: number, b: number | undefined) =>
        b === undefined || dt <= 0 || a < b ? null : (a - b) / dt;
      return {
        iface: n.iface,
        up: n.up,
        speedMbps: n.speedMbps,
        rxBps: rate(n.rx, before?.rx),
        txBps: rate(n.tx, before?.tx),
      };
    });

    const load = (h.load ?? "").split(" ").map(Number);
    const maxTemp = sample.temps.reduce<TempReading | null>((a, t) => (!a || t.tempC > a.tempC ? t : a), null);
    const gpuTemp = sample.gpu?.tempC ?? null;
    const hottest: TempReading | null =
      gpuTemp !== null && (!maxTemp || gpuTemp > maxTemp.tempC) ? { chip: "gpu", label: "GPU", tempC: gpuTemp } : maxTemp;

    state.snapshot = {
      ...state.snapshot,
      online: true,
      error: null,
      lastSeen: now,
      latencyMs: Math.round(latencyMs),
      hostname: h.hostname ?? null,
      os: h.os || null,
      kernel: h.kernel ?? null,
      cpuModel: h.cpu_model || null,
      ncpu: num(h.ncpu),
      uptimeSec: num(h.uptime),
      load: load.length === 3 && load.every(Number.isFinite) ? [load[0]!, load[1]!, load[2]!] : null,
      cpuPct: prev ? cpuPercent(prev.sample.cpu, sample.cpu) : null,
      clockPct: sample.freq && sample.freq.maxKhz > 0 ? (sample.freq.curKhz / sample.freq.maxKhz) * 100 : null,
      clockMhz: sample.freq ? sample.freq.curKhz / sample.freq.cores / 1000 : null,
      clockMaxMhz: sample.freq ? sample.freq.maxKhz / sample.freq.cores / 1000 : null,
      memTotalBytes: memTotal,
      memUsedBytes: memTotal !== null && memAvail !== null ? memTotal - memAvail : null,
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
      disks: sample.disks,
      gpu: sample.gpu,
      maxTemp: hottest,
      cpuTempC: cpuTemp(sample.temps),
      temps: sample.temps,
      net,
      containers: sample.containers,
      gpuProcesses: sample.gpuProcesses,
    };
    state.procs = sample.procs;
    state.prev = { at: now, sample };
    this.recordHistory(state.snapshot, false);
  }

  private recordHistory(snap: HostSnapshot, gap: boolean): void {
    const hist = snap.history;
    const memPct =
      snap.memTotalBytes && snap.memUsedBytes !== null ? (snap.memUsedBytes / snap.memTotalBytes) * 100 : null;
    push(hist.cpu, gap ? null : snap.cpuPct);
    push(hist.gpu, gap ? null : (snap.gpu?.utilPct ?? null));
    push(hist.mem, gap ? null : memPct);
    push(hist.temp, gap ? null : (snap.maxTemp?.tempC ?? null));
    push(hist.power, gap ? null : (snap.gpu?.powerW ?? null));
  }
}
