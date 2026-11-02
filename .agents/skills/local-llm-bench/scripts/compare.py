#!/usr/bin/env python3
"""Print the newest Spark Lens bench run of each local LLM next to the one before it.

usage: python3 -I compare.py [runs.jsonl]   (default: bench-data/spark-lens-bench/runs.jsonl under the repo)
"""
import json
import sys
from pathlib import Path

path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[4] / "bench-data/spark-lens-bench/runs.jsonl"
runs = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
runs = [r for r in runs if not r.get("error")]
KEYS = [("ttft", "ttftMs", "TTFT ms"), ("prose", "decodeTps", "prose tok/s"), ("code", "decodeTps", "code tok/s"), ("prefill", "prefillTps", "prefill tok/s")]


def val(run, case, field):
    for c in run.get("cases", []):
        if c.get("key") == case and c.get(field) is not None:
            return c[field]
    return None


def fmt(v):
    return "-" if v is None else f"{v:.0f}"


for llm in dict.fromkeys(r["llmId"] for r in runs):
    mine = [r for r in runs if r["llmId"] == llm]
    new, old = mine[-1], (mine[-2] if len(mine) > 1 else None)
    print(f"{llm}  {new.get('model','')}  {new.get('commit','')}" + (f"  (before: {old.get('commit','')})" if old else ""))
    for case, field, label in KEYS:
        n, o = val(new, case, field), (val(old, case, field) if old else None)
        delta = "" if n is None or o is None else f"  {100 * (n - o) / o:+.0f}%"
        print(f"  {label:14} {fmt(n):>7}  before {fmt(o):>7}{delta}")
