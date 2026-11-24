import { shDir, shq } from "./recipes-shell.ts";
import type { RecipeConfig } from "./types.ts";

// The shell scripts RecipeManager runs on a recipe's host, and the cleanup of
// what they print. A start runs detached (nohup + setsid) with its output in
// ~/.local/state/spark-lens/recipe-<id>.log there, so it survives this
// dashboard restarting and can be followed from the log viewer.

const LOG_DIR = "$HOME/.local/state/spark-lens";

export function logPath(id: string): string {
  return `${LOG_DIR}/recipe-${id}.log`;
}

export function pidPath(id: string): string {
  return `${LOG_DIR}/recipe-${id}.pid`;
}

export function startScript(r: RecipeConfig, arbitrationLog: string[] = []): string {
  const log = logPath(r.id);
  // The exit marker lets the dashboard tell a finished launcher from a failed one.
  // A subshell, so an `exit` inside the command cannot skip the marker.
  const body = `cd ${shDir(r.dir)} && ( ${r.start}
 ); echo "=== spark-lens: exit $?" >> "${log}"`;
  return [
    "set -e",
    `mkdir -p "${LOG_DIR}"`,
    `echo "=== spark-lens: start $(date '+%F %T')" > "${log}"`,
    ...arbitrationLog.map((message) => `printf '%s\\n' ${shq(`=== ${message}`)} >> "${log}"`),
    `nohup setsid bash -c ${shq(body)} >> "${log}" 2>&1 < /dev/null &`,
    // Kept on the host, so a restarted dashboard can find a launcher still preparing.
    `echo $! > "${pidPath(r.id)}"`,
    "echo $!",
  ].join("\n");
}

/**
 * Wait for local ComfyUI queues to drain, unload models on active ports, then
 * wait (up to `settleSeconds`, 0 = not at all) until the host's MemAvailable
 * stops rising: ComfyUI frees its models asynchronously, and a recipe that
 * starts before that sees a smaller room (a GLM prompt cache of 3.2 GiB
 * instead of 12 when its worker's ComfyUI still held ~12 GiB).
 */
export function gpuArbitrationScript(ports: number[], timeoutSeconds: number, settleSeconds = 0): string {
  return `exec python3 - ${timeoutSeconds} ${settleSeconds} ${ports.join(" ")} <<'PY'
import http.client
import json
import socket
import sys
import time

start = time.monotonic()
wait_limit = float(sys.argv[1])
deadline = start + wait_limit
settle_limit = float(sys.argv[2])
ports = [int(port) for port in sys.argv[3:]]
active = set()

def bound_hosts(port):
    # ComfyUI may listen on a non-loopback address only (a worker's :8188 on its tailnet address), so ask
    # the kernel where the port is bound instead of assuming 127.0.0.1.
    found = set()
    try:
        with open("/proc/net/tcp") as table:
            next(table)
            for row in table:
                fields = row.split()
                address, _, listen_port = fields[1].partition(":")
                if fields[3] == "0A" and int(listen_port, 16) == port:
                    ip = socket.inet_ntoa(bytes.fromhex(address)[::-1])
                    found.add("127.0.0.1" if ip == "0.0.0.0" else ip)
    except (OSError, ValueError, IndexError):
        pass
    return sorted(found) or ["127.0.0.1"]

targets = [(host, port) for port in ports for host in bound_hosts(port)]

def label(target):
    host, port = target
    return f":{port}" if host == "127.0.0.1" else f"{host}:{port}"
free_body = '{"unload_models":true,"free_memory":true}'

def request(target, timeout, method, path, body=None):
    connection = http.client.HTTPConnection(target[0], target[1], timeout=timeout)
    try:
        headers = {"Content-Type": "application/json"} if body else {}
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            raise ValueError(f"HTTP {response.status}")
        if method == "GET":
            return json.load(response)
    finally:
        connection.close()

def fail(message):
    sys.exit(f"GPU仲裁: {message}")

def remaining():
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        fail(f"生成ジョブ待機が上限{wait_limit:g}秒を超過")
    return seconds

while targets:
    busy = False
    for target in targets:
        try:
            status = request(target, min(3, remaining()), "GET", "/queue")
            running, pending = status["queue_running"], status["queue_pending"]
            if not isinstance(running, list) or not isinstance(pending, list):
                raise ValueError("不正なキュー形式")
        except ConnectionRefusedError:
            if target in active:
                fail(f"ComfyUI {label(target)} への接続が切断されました")
            continue
        except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError) as error:
            fail(f"ComfyUI {label(target)} のキュー確認に失敗 ({error})")
        active.add(target)
        busy = busy or bool(running or pending)
    seconds = remaining()
    if not busy:
        break
    time.sleep(min(5, seconds))

if not active:
    print("GPU仲裁: 稼働中のComfyUIなし")
    sys.exit(0)

waited = int(time.monotonic() - start)
for target in sorted(active):
    try:
        request(target, 10, "POST", "/free", free_body)
    except (OSError, http.client.HTTPException, ValueError) as error:
        fail(f"ComfyUI {label(target)} のアンロード要求に失敗 ({error})")
unloaded = ", ".join(label(target) for target in sorted(active))

def mem_available_gib():
    with open("/proc/meminfo") as meminfo:
        for line in meminfo:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1048576
    return None

released = ""
if settle_limit > 0 and mem_available_gib() is not None:
    settle_start = time.monotonic()
    first = mem_available_gib()
    samples = [first]
    while time.monotonic() - settle_start < settle_limit:
        time.sleep(1)
        samples.append(mem_available_gib())
        # at least 4 s, then 3 s without the free memory moving by 0.25 GiB
        if time.monotonic() - settle_start >= 4 and len(samples) >= 4 and max(samples[-4:]) - min(samples[-4:]) < 0.25:
            break
    settled = time.monotonic() - settle_start < settle_limit
    released = f"、空き {first:.0f}→{samples[-1]:.0f} GiB（{int(time.monotonic() - settle_start)}秒{'' if settled else '、上限まで増加中'}）"
print(f"GPU仲裁: 待機 {waited}秒、アンロード要求 {unloaded}{released}")
PY`;
}

/**
 * Reads a launcher's log tail and whether its pid still lives. A download's
 * progress bar leaves the log without a final newline, so the marker lines
 * start after one: otherwise `ALIVE <pid>` is glued to the bar, goes unseen,
 * and a launcher that is still working reads as gone (a false failure).
 */
export function launcherCheckScript(id: string, pidExpr: string | number): string {
  return `tail -n 400 "${logPath(id)}" 2>/dev/null; echo; p=${pidExpr}; kill -0 "$p" 2>/dev/null && echo "ALIVE $p"; echo "@@checked"`;
}

/**
 * After a dashboard restart: the pid of a launcher still running (its command
 * line checked, against a recycled pid), then the log's first line.
 */
export function recoverScript(id: string): string {
  return `p=$(cat "${pidPath(id)}" 2>/dev/null) && kill -0 "$p" 2>/dev/null && ps -o args= -p "$p" | grep -q "spark-lens: exit" && echo "$p"; head -n 1 "${logPath(id)}" 2>/dev/null; echo "@@checked"`;
}

/**
 * For a start made elsewhere: the log's tail and first line, when it was last
 * written (`@@mtime`), and when the newest of `containers` started (`@@cstart`).
 */
export function externalStartScript(id: string, containers: string[]): string {
  const inspect = containers.length
    ? `docker inspect -f '{{.State.StartedAt}}' ${containers.map(shq).join(" ")} 2>/dev/null | sort | tail -n 1`
    : "true";
  return (
    `tail -n 400 "${logPath(id)}" 2>/dev/null; echo; head -n 1 "${logPath(id)}" 2>/dev/null; ` +
    `echo "@@mtime $(stat -c %Y "${logPath(id)}" 2>/dev/null)"; echo "@@cstart $(${inspect})"`
  );
}

/** The log lines where vLLM and SGLang say how much memory the weights and KV cache took (see parseMemoryPlan). */
export function memoryScript(id: string): string {
  return `grep -aoE "Model loading took [0-9.]+ ?GiB|Available KV cache memory: [0-9.]+ ?GiB|kv-cache-memory-bytes[ =][0-9]+|Load weight end\\.[^\\r]*mem usage=[0-9.]+ ?GB|KV Cache is allocated\\.[^\\r]*V size: [0-9.]+ ?GB" "${logPath(id)}" 2>/dev/null | tail -n 5`;
}

export function stopScript(r: RecipeConfig, launcherPid: number | null = null): string {
  const log = logPath(r.id);
  return [
    // A launcher still running holds its own lock and would refuse the stop.
    launcherPid ? `kill -TERM -- -${launcherPid} 2>/dev/null && sleep 2` : ":",
    `mkdir -p "${LOG_DIR}"`,
    `echo "=== spark-lens: stop $(date '+%F %T')" >> "${log}"`,
    `cd ${shDir(r.dir)} && ( ${r.stop}
 ) 2>&1 | tee -a "${log}"`,
    "exit ${PIPESTATUS[0]}",
  ].join("\n");
}

/** Terminal output to plain lines: colour codes dropped, progress-bar redraws collapsed. */
export function cleanLog(text: string): string {
  const lines = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((p) => p.trim() !== "");
      return parts[parts.length - 1] ?? "";
    });
  // Progress bars piped through a log arrive one update per line; keep only
  // the latest of a run that shares the text before its percentage.
  const out: string[] = [];
  const key = (line: string) => /^(.*?)\d+(?:\.\d+)?%/.exec(line)?.[1] ?? null;
  for (const line of lines) {
    const k = key(line);
    if (k !== null && k.trim() !== "" && out.length > 0 && key(out[out.length - 1]!) === k) out[out.length - 1] = line;
    else out.push(line);
  }
  return out.join("\n");
}
