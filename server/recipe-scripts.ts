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

export function startScript(r: RecipeConfig): string {
  const log = logPath(r.id);
  // The exit marker lets the dashboard tell a finished launcher from a failed one.
  // A subshell, so an `exit` inside the command cannot skip the marker.
  const body = `cd ${shDir(r.dir)} && ( ${r.start}
 ); echo "=== spark-lens: exit $?" >> "${log}"`;
  return [
    "set -e",
    `mkdir -p "${LOG_DIR}"`,
    `echo "=== spark-lens: start $(date '+%F %T')" > "${log}"`,
    `nohup setsid bash -c ${shq(body)} >> "${log}" 2>&1 < /dev/null &`,
    // Kept on the host, so a restarted dashboard can find a launcher still preparing.
    `echo $! > "${pidPath(r.id)}"`,
    "echo $!",
  ].join("\n");
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
