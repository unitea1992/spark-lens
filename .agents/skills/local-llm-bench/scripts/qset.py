"""答えが決まった計算問題 59 問（問題は固定の乱数から作る）を、思考ありで解かせて採点する。

使い方: python3 -I qset.py <BASE（…/v1）> <提供名> <並列数>
環境変数: EFFORT（既定 low。空で省略）、THINK（1 で思考あり）、STEP（N 問おきに間引く）、QN（先頭から N 問）、
          TEMP・TOPP・SEED（温度・top_p・seed を固定）
点数は 1 回で ±4 問ほど揺れる。構成の優劣は所要時間・トークン数と合わせ、複数回で見ること。
"""
import json, os, sys, time, random, re, threading, urllib.request
from math import gcd, comb
base, model, workers = sys.argv[1], sys.argv[2], int(sys.argv[3])
rnd = random.Random(20261105)
qs = []
def add(q, a): qs.append((q, str(a)))
for _ in range(8):
    a, b, c, m = rnd.randint(100, 999), rnd.randint(100, 999), rnd.randint(100, 999), rnd.randint(7, 97)
    add(f"Compute ({a} * {b} + {c}) mod {m}. Reply with the final integer on the last line.", (a * b + c) % m)
for _ in range(8):
    b, e, m = rnd.randint(2, 12), rnd.randint(100, 400), rnd.choice([1000, 997, 10007])
    add(f"What is {b}^{e} mod {m}? Reply with the final integer on the last line.", pow(b, e, m))
for _ in range(8):
    k = rnd.randint(50, 110)
    add(f"What is the sum of the decimal digits of 2^{k}? Reply with the final integer on the last line.", sum(map(int, str(2 ** k))))
for _ in range(8):
    n = rnd.choice([1000, 1500, 2000, 3000])
    add(f"How many prime numbers are there below {n}? Reply with the final integer on the last line.", sum(1 for x in range(2, n) if all(x % d for d in range(2, int(x ** .5) + 1))))
for _ in range(8):
    a, b = rnd.randint(10**5, 10**6), rnd.randint(10**5, 10**6)
    add(f"What is the greatest common divisor of {a * 6} and {b * 6}? Reply with the final integer on the last line.", gcd(a * 6, b * 6))
for _ in range(8):
    n = rnd.randint(500, 9999)
    s, x = 0, n
    while x != 1: x = x // 2 if x % 2 == 0 else 3 * x + 1; s += 1
    add(f"Starting from {n}, repeatedly apply the Collatz rule (if even divide by 2, else 3n+1). How many steps until reaching 1? Reply with the final integer on the last line.", s)
for _ in range(4):
    n, k = rnd.randint(14, 28), rnd.randint(4, 8)
    add(f"How many ways can {k} people be chosen from {n} people to form a committee? Reply with the final integer on the last line.", comb(n, k))
for _ in range(4):
    n = rnd.randint(50, 100)
    a, b = 0, 1
    for _ in range(n): a, b = b, a + b
    add(f"What are the last 4 digits of the {n}-th Fibonacci number (F1=1, F2=1)? Give them as an integer (drop leading zeros). Reply with the final integer on the last line.", a % 10000)
for _ in range(3):
    n = rnd.randint(300, 900)
    add(f"How many integers from 1 to {n} inclusive are divisible by 3 or 5 but not by 15? Reply with the final integer on the last line.", sum(1 for x in range(1, n + 1) if (x % 3 == 0 or x % 5 == 0) and x % 15))
qs = qs[::int(os.environ.get("STEP", "1"))][:int(os.environ.get("QN", "999"))]
EFFORT = os.environ.get("EFFORT", "low")
THINK = os.environ.get("THINK", "1") == "1"
rch = [0]; cch = [0]; errs = [0]
def one(q, a, out, i):
    body = {"model": model, "max_tokens": 8000, "temperature": 0.7, "messages": [{"role": "user", "content": q}],
            "chat_template_kwargs": {"enable_thinking": THINK}}
    if EFFORT: body["reasoning_effort"] = EFFORT
    for k, env in (("top_p", "TOPP"), ("temperature", "TEMP"), ("seed", "SEED")):
        if os.environ.get(env): body[k] = float(os.environ[env]) if k != "seed" else int(os.environ[env])
    req = urllib.request.Request(base + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    try:
        d = json.load(urllib.request.urlopen(req, timeout=1800))
        msg = d["choices"][0]["message"]; txt = msg.get("content") or ""; rch[0] += len(msg.get("reasoning_content") or msg.get("reasoning") or ""); cch[0] += len(txt)
        ct = d["usage"]["completion_tokens"]
    except Exception:
        txt, ct = "", 0; errs[0] += 1
    nums = re.findall(r"-?\d[\d,]*", txt.replace("**", ""))
    got = nums[-1].replace(",", "") if nums else ""
    out[i] = (got == a, ct, time.time() - t0)
res = {}; it = iter(enumerate(qs)); lock = threading.Lock()
def worker():
    while True:
        with lock:
            try: i, (q, a) = next(it)
            except StopIteration: return
        one(q, a, res, i)
t0 = time.time(); ths = [threading.Thread(target=worker) for _ in range(workers)]
[t.start() for t in ths]; [t.join() for t in ths]
wall = time.time() - t0
print(json.dumps({"n": len(qs), "correct": sum(v[0] for v in res.values()), "wall_s": round(wall), "completion_tokens": sum(v[1] for v in res.values()),
                  "tok_per_wall_s": round(sum(v[1] for v in res.values()) / wall, 1), "sum_request_s": round(sum(v[2] for v in res.values())), "errors": errs[0], "reasoning_chars": rch[0], "content_chars": cch[0], "effort": EFFORT, "think": THINK}))
