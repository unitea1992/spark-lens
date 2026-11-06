"""コード問題をモデルに解かせ、返ったコードを参照実装と同じ入力で動かして採点する。

使い方: python3 -I code_eval.py <BASE（…/v1）> <提供名> <並列数> [basic|hard]
環境変数: EFFORT（既定 low）、THINK（1 で思考あり）
"""
import json, sys, re, subprocess, tempfile, os, time, threading, urllib.request, importlib.util
sys.dont_write_bytecode = True
base, model, workers = sys.argv[1], sys.argv[2], int(sys.argv[3])
which = sys.argv[4] if len(sys.argv) > 4 else "basic"
EFFORT = os.environ.get("EFFORT", "low"); THINK = os.environ.get("THINK", "1") == "1"
_spec = importlib.util.spec_from_file_location("problems", os.path.join(os.path.dirname(os.path.abspath(__file__)), f"problems_{which}.py"))
_mod = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_mod)
P = _mod.P
def extract(txt):
    b = re.findall(r"```(?:python|py)?\n(.*?)```", txt, re.S)
    return b[-1] if b else txt
def grade(name, code, ref, inputs):
    exp = []
    for a in inputs:
        try: exp.append(("ok", ref(*[json.loads(json.dumps(x)) for x in a])))
        except Exception as e: exp.append(("err", None))
    harness = code + "\n\nimport json,sys\n_in=json.loads(sys.stdin.read())\n_out=[]\nfor a in _in:\n    try: _out.append(['ok',"+name+"(*a)])\n    except Exception as e: _out.append(['err',None])\nprint(json.dumps(_out, default=list))\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f: f.write(harness); path = f.name
    try:
        r = subprocess.run([sys.executable, "-I", path], input=json.dumps([list(a) for a in inputs]), capture_output=True, text=True, timeout=15)
        got = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: return 0, len(inputs)
    finally: os.unlink(path)
    ok = 0
    for g, e in zip(got, exp):
        ev = json.loads(json.dumps(e[1], default=list))
        if g[0] == e[0] and (g[0] == "err" or g[1] == ev): ok += 1
    return ok, len(inputs)
res = {}
def one(i):
    name, sig, desc, ref, inputs = P[i]
    body = {"model": model, "max_tokens": 8000, "temperature": 0.7,
            "messages": [{"role": "user", "content": f"Write a Python 3 function `{sig}`. {desc}\nReply with only one ```python code block containing the function (and any imports/helpers). No explanation, no tests."}],
            "chat_template_kwargs": {"enable_thinking": THINK}}
    if EFFORT: body["reasoning_effort"] = EFFORT
    req = urllib.request.Request(base + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    try:
        d = json.load(urllib.request.urlopen(req, timeout=1800)); txt = d["choices"][0]["message"].get("content") or ""; ct = d["usage"]["completion_tokens"]
    except Exception: txt, ct = "", 0
    ok, n = grade(name, extract(txt), ref, inputs)
    res[i] = (name, ok, n, ct, time.time() - t0)
it = iter(range(len(P))); lock = threading.Lock()
def worker():
    while True:
        with lock:
            try: i = next(it)
            except StopIteration: return
        one(i)
t0 = time.time(); ths = [threading.Thread(target=worker) for _ in range(workers)]
[t.start() for t in ths]; [t.join() for t in ths]
wall = time.time() - t0
print(json.dumps({"problems": len(P), "fully_passed": sum(1 for v in res.values() if v[1] == v[2]), "cases_passed": sum(v[1] for v in res.values()), "cases_total": sum(v[2] for v in res.values()),
                  "wall_s": round(wall), "completion_tokens": sum(v[3] for v in res.values()), "failed": [v[0] for v in res.values() if v[1] != v[2]], "effort": EFFORT, "think": THINK}))
