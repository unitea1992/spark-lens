// How far a recipe's checkout is from its upstream, read with plain git on
// the host it lives on. Recipes are kept as unmodified clones, so following
// upstream is a fetch, a fast-forward pull and a restart.

import type { UpstreamChanges, UpstreamCommit, UpstreamStatus } from "./types.ts";
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
# What an update brings, or what the last pull brought once it is in: the
# release headings from the changelog and the setting names that are new.
from=""; to=""; scope=""
if [ -n "$up" ] && [ "$(git rev-list --count HEAD..@{u})" -gt 0 ]; then
  from=HEAD; to=@{u}; scope=pending
elif git rev-parse -q --verify ORIG_HEAD >/dev/null && [ "$(git rev-parse ORIG_HEAD)" != "$(git rev-parse HEAD)" ] && git merge-base --is-ancestor ORIG_HEAD HEAD; then
  from=ORIG_HEAD; to=HEAD; scope=applied
fi
if [ -n "$scope" ]; then
  echo "@@changes $scope $(git rev-parse --short "$from")"
  echo "@@releases"
  for f in CHANGELOG.md CHANGELOG CHANGES.md; do
    git cat-file -e "$to:$f" 2>/dev/null || continue
    git diff "$from" "$to" -- "$f" | grep -E '^[+]## ' | sed -E 's/^[+]## //' | head -n 20
    break
  done
  echo "@@settings"
  names() {
    for f in scripts/config.sh scripts/nodes.sh config.sh start.sh .env.example .env.sample; do git show "$1:$f" 2>/dev/null; done |
      grep -oE '[$][{][A-Z][A-Z0-9_]*:[-=]' | sed -E 's/^..//; s/:.$//'
    git show "$1:README.md" 2>/dev/null | grep -oE '^[|] \`[A-Z][A-Z0-9_]*\`' | sed -E 's/^[|] .//; s/.$//'
  }
  names "$from" | sort -u > "\${TMPDIR:-/tmp}/sl-up-c.$$"
  names "$to" | sort -u > "\${TMPDIR:-/tmp}/sl-up-d.$$"
  comm -13 "\${TMPDIR:-/tmp}/sl-up-c.$$" "\${TMPDIR:-/tmp}/sl-up-d.$$"
  rm -f "\${TMPDIR:-/tmp}/sl-up-c.$$" "\${TMPDIR:-/tmp}/sl-up-d.$$"
fi
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
    changes: null,
    checkedAt: now,
    message: null,
    repo: null,
    repoUrl: null,
  };
  if (!text.includes("@@end") && !text.includes("@@error")) return { ...base, state: "error", message: "確認できませんでした" };
  let section = "";
  const commits: UpstreamCommit[] = [];
  const keys: string[] = [];
  let changes: UpstreamChanges | null = null;
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
      if (tag === "changes") changes = { scope: rest[0] === "applied" ? "applied" : "pending", since: rest[1] ?? "", releases: [], settings: [] };
      continue;
    }
    if (line.trim() === "") continue;
    if (section === "log") {
      const [sha, date, ...subject] = line.split("|");
      if (sha) commits.push({ sha, date: Date.parse(date ?? "") || null, subject: subject.join("|") });
    } else if (section === "envkeys") {
      keys.push(line.trim());
    } else if (section === "releases") {
      changes?.releases.push(line.trim());
    } else if (section === "settings") {
      changes?.settings.push(line.trim());
    }
  }
  const state: UpstreamStatus["state"] =
    base.branch === null ? "untracked" : base.dirtyFiles > 0 ? "modified" : base.behind > 0 ? "behind" : "current";
  return {
    ...base,
    state,
    commits,
    newEnvKeys: keys,
    changes,
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
