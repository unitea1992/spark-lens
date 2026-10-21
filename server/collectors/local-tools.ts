import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the coding tools on this machine keep their binaries and records.

/** The first `name` on PATH, then the tool's own install locations; null when none exists. */
export function findBin(name: string, extra: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const candidate of [...dirs.map((d) => join(d, name)), ...extra]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The OpenCode CLI, also found where its installer puts it outside PATH. */
export function findOpencode(): string | null {
  return findBin("opencode", [join(homedir(), ".opencode", "bin", "opencode")]);
}

/** Codex's home directory (sessions, state database). */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}
