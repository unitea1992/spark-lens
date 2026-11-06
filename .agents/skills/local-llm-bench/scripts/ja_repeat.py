"""日本語の論理パズル（正解は B）と形式指定（敬体・ちょうど 5 項目・30 字以内・前置きなし）を n 回ずつ自動採点する。

使い方: python3 -I ja_repeat.py <BASE（…/v1）> <提供名> <回数>
環境変数: OUT（回答を保存する JSON のパス）
"""
import json, os, re, sys, urllib.request, concurrent.futures as cf
base, model, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
PUZ = "A、B、Cの3人のうち、1人だけが本当のことを言い、2人は嘘をついています。Aは「Bが嘘つきだ」、Bは「Cが嘘つきだ」、Cは「AもBも嘘つきだ」と言いました。本当のことを言っているのは誰ですか。理由を簡潔に説明してください。"
CON = "日本語の敬体（です・ます調）で、ソフトウェアのコードレビューで気をつける点を、ちょうど5つの箇条書きで答えてください。各項目は30文字以内にしてください。前置きや締めの文は不要です。"
def ask(q):
    b = {"model": model, "max_tokens": 6000, "temperature": 0.7, "messages": [{"role": "user", "content": q}]}
    r = urllib.request.Request(base + "/chat/completions", json.dumps(b).encode(), {"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(r, timeout=900)); return d["choices"][0]["message"].get("content") or "", d["usage"]["completion_tokens"]
def puz_verdict(t):
    t = re.sub(r"[#*\s]", "", t)
    m = re.search(r"(本当のことを言っている|本当のことを言う|本当のことを言って|正直者|答え|解答|結論)", t)
    if not m: return None
    m2 = re.search(r"[ABC]", t[m.end(): m.end() + 40]); return m2.group(0) if m2 else None
def puz_ok(t): return puz_verdict(t) == "B"
def con_ok(t):
    lines = [l.strip() for l in t.strip().splitlines() if l.strip()]
    bul = [l for l in lines if re.match(r"^([-・*•]|\d+[.)．])\s*", l)]
    if len(bul) != 5 or len(lines) != 5: return False
    txt = [re.sub(r"^([-・*•]|\d+[.)．])\s*", "", l) for l in bul]
    return all(len(x) <= 30 for x in txt) and all(re.search(r"(ます|です|ください|しましょう)[。]?$", x) for x in txt)
with cf.ThreadPoolExecutor(4) as ex:
    P = list(ex.map(lambda _: ask(PUZ), range(n))); C = list(ex.map(lambda _: ask(CON), range(n)))
json.dump({"puzzle": [(puz_verdict(t), t[:200]) for t, _ in P], "constraint": [(con_ok(t), t[:300]) for t, _ in C]}, open(os.environ["OUT"], "w") if os.environ.get("OUT") else open(os.devnull, "w"), ensure_ascii=False, indent=1)
print(json.dumps({"puzzle_correct": sum(puz_ok(t) for t, _ in P), "puzzle_n": n, "constraint_ok": sum(con_ok(t) for t, _ in C), "constraint_n": n,
                  "puzzle_tokens": sum(k for _, k in P), "constraint_tokens": sum(k for _, k in C)}))
