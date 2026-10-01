// Shell quoting shared by the recipe and upstream scripts.

/** Single-quote a string for bash. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A directory for `cd`, with a leading ~ expanded by the remote shell. */
export function shDir(dir: string): string {
  if (dir === "~") return '"$HOME"';
  if (dir.startsWith("~/")) return `"$HOME"/${shq(dir.slice(2))}`;
  return shq(dir);
}
