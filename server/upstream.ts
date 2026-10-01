// How far a recipe's checkout is from its upstream, read with plain git on
// the host it lives on. Recipes are kept as unmodified clones, so following
// upstream is a fetch, a fast-forward pull and a restart.

import type { UpstreamCommit, UpstreamStatus } from "./types.ts";
import { shDir } from "./recipes-shell.ts";

/**
 * Prints one report in sections. Settings that the upstream example file now
 * has but the local .env lacks are listed, so a pull that adds a knob is
 * visible before it matters.
 */
export function checkScript(dir: string): string {
  return `cd ${shDir(dir)} 2>/dev/null || { echo "@@error ディレクトリが見つかりません"; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "@@error git の作業ツリーではありません"; exit 0; }
if ! err="$(timeout 60 git fetch --quiet 2>&1)"; then echo "@@fetch-error $(printf '%s' "$err" | tail -n 1)"; fi
echo "@@remote $(git remote get-url origin 2>/dev/null)"
echo "@@head $(git rev-parse --short HEAD) $(git log -1 --format=%cI HEAD)"
up="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"
if [ -n "$up" ]; then
  echo "@@upstream $(git rev-parse --short @{u}) $(git log -1 --format=%cI @{u}) $up"
  echo "@@behind $(git rev-list --count HEAD..@{u})"
  echo "@@ahead $(git rev-list --count @{u}..HEAD)"
fi
echo "@@dirty $(git status --porcelain --untracked-files=no | wc -l)"
echo "@@log"
[ -n "$up" ] && git log --format='%h|%cI|%s' HEAD..@{u} | head -n 30
echo "@@envkeys"
for example in .env.example .env.sample; do
  [ -n "$up" ] && git cat-file -e "@{u}:$example" 2>/dev/null || continue
  [ -f .env ] || break
  git show "@{u}:$example" | grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | tr -d = | sort -u > "\${TMPDIR:-/tmp}/sl-up-a.$$"
  grep -oE '^#?[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' .env | sed -E 's/^#?[[:space:]]*//; s/=$//' | sort -u > "\${TMPDIR:-/tmp}/sl-up-b.$$"
  comm -23 "\${TMPDIR:-/tmp}/sl-up-a.$$" "\${TMPDIR:-/tmp}/sl-up-b.$$"
  rm -f "\${TMPDIR:-/tmp}/sl-up-a.$$" "\${TMPDIR:-/tmp}/sl-up-b.$$"
  break
done
echo "@@end"
`;
}

/** "owner/repo" and a browsable https link from a GitHub remote; anything else stays unnamed. */
export function repoFromRemote(url: string): { repo: string | null; repoUrl: string | null } {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return { repo: null, repoUrl: null };
  return { repo: `${m[1]}/${m[2]}`, repoUrl: `https://github.com/${m[1]}/${m[2]}` };
}

export function parseCheck(text: string, now = Date.now()): UpstreamStatus {
  const base: UpstreamStatus = {
    state: "unknown",
    head: null,
    headDate: null,
    latest: null,
    latestDate: null,
    branch: null,
    behind: 0,
    ahead: 0,
    dirtyFiles: 0,
    commits: [],
    newEnvKeys: [],
    checkedAt: now,
    message: null,
    repo: null,
    repoUrl: null,
  };
  if (!text.includes("@@end") && !text.includes("@@error")) return { ...base, state: "error", message: "確認できませんでした" };
  let section = "";
  const commits: UpstreamCommit[] = [];
  const keys: string[] = [];
  let fetchError: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const [tag, ...rest] = line.slice(2).split(" ");
      section = tag!;
      const v = rest.join(" ");
      if (tag === "error") return { ...base, state: "error", message: v || "確認できませんでした" };
      if (tag === "fetch-error") fetchError = v;
      if (tag === "remote") Object.assign(base, repoFromRemote(v));
      if (tag === "head") [base.head, base.headDate] = [rest[0] ?? null, Date.parse(rest[1] ?? "") || null];
      if (tag === "upstream") [base.latest, base.latestDate, base.branch] = [rest[0] ?? null, Date.parse(rest[1] ?? "") || null, rest[2] ?? null];
      if (tag === "behind") base.behind = Number(rest[0]) || 0;
      if (tag === "ahead") base.ahead = Number(rest[0]) || 0;
      if (tag === "dirty") base.dirtyFiles = Number(rest[0]) || 0;
      continue;
    }
    if (line.trim() === "") continue;
    if (section === "log") {
      const [sha, date, ...subject] = line.split("|");
      if (sha) commits.push({ sha, date: Date.parse(date ?? "") || null, subject: subject.join("|") });
    } else if (section === "envkeys") {
      keys.push(line.trim());
    }
  }
  const state: UpstreamStatus["state"] =
    base.branch === null ? "untracked" : base.dirtyFiles > 0 ? "modified" : base.behind > 0 ? "behind" : "current";
  return {
    ...base,
    state,
    commits,
    newEnvKeys: keys,
    message: fetchError ? `upstream に接続できませんでした（${fetchError}）。前回取得した情報で表示しています` : null,
  };
}

export function pullScript(dir: string, log: string): string {
  return `cd ${shDir(dir)} || exit 3
echo "=== spark-lens: update $(date '+%F %T')" >> "${log}"
git pull --ff-only 2>&1 | tee -a "${log}"
exit \${PIPESTATUS[0]}
`;
}
