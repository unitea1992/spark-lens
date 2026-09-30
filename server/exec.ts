import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** Run a command without a shell, feed it optional stdin, and never throw. */
export function run(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv } = { timeoutMs: 10_000 },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: performance.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    child.on("error", (err) => {
      stderr += String(err.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}
