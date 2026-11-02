"""Turn a live /api/state into an anonymous snapshot for the README screenshots.

usage: python3 -I sanitize.py <state.real.json> <state.demo.json>
The names to replace come from ~/.config/spark-lens/screenshot-map.json (kept out of the repository):
{"replace": [["real host", "Spark 1"], ...], "leak_pattern": "regex of things that must not remain"}
"""
import json, os, re, sys
src, dst = sys.argv[1], sys.argv[2]
cfg = json.load(open(os.path.expanduser("~/.config/spark-lens/screenshot-map.json")))
s = json.load(open(src))
s["llms"] = [l for l in s["llms"] if l["id"] not in cfg.get("drop_llms", [])]
now = s["generatedAt"]
tmpl = {"pid": None, "startedAt": None, "cpuPct": None, "host": "dev", "hostLabel": "Workstation", "confidence": "inferred"}
def agent(i, tool, label, name, status, task, detail, source, ago):
    return {**tmpl, "id": f"{tool}:demo-{i}", "tool": tool, "toolLabel": label, "title": task, "cwd": f"~/projects/{name}",
            "status": status, "lastActivity": now - ago * 1000, "detail": detail, "source": source}
s["agents"] = [
    agent(1, "claude", "Claude Code", "demo-app", "working", "ダッシュボードの README を更新", "Edit", "claude-session", 26),
    agent(2, "codex", "Codex", "demo-api", "working", "API クライアントのリトライ処理を見直す", "gpt-6.1-sol", "codex-log", 26),
    agent(3, "opencode", "OpenCode", "demo-app", "idle", "テストの失敗原因を調べる", "", "opencode-api", 26),
    agent(4, "claude", "Claude Code", "demo-cli", "waiting", "依存関係の更新を確認", "", "claude-session", 26),
]
for h in s["hosts"]:
    h["containers"] = [c for c in h["containers"] if re.search(r"dsv41|glm53|qwen38", c["name"])]
for r in s["recipes"]:
    u = r.get("upstream")
    if u and u.get("state") != "current":
        u.update({"state": "current", "behind": 0, "latest": u.get("head"), "latestDate": u.get("headDate"), "commits": []})
s["agentSources"] = [x for x in s["agentSources"] if x["source"] != "orca"]
counts = {"claude-session": 2, "codex-log": 1, "opencode-api": 1}
for x in s["agentSources"]: x["count"] = counts.get(x["source"], x["count"])
text = json.dumps(s, ensure_ascii=False)
for a, b in cfg["replace"]:
    text = text.replace(a, b)
open(dst, "w").write(text)
bad = re.findall(cfg["leak_pattern"] + r"|\b(?:172\.16|192\.168|100\.\d+)\.\d+\.\d+", text, re.I)
print("leaks:", sorted(set(bad)))
