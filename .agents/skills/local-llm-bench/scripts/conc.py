"""並列ストリームの合計デコード速度を測る。

使い方: python3 -I conc.py <BASE（…/v1）> <提供名> <並列数のカンマ区切り 例 1,2,4>
"""
import json, sys, time, random, threading, urllib.request
base, model = sys.argv[1], sys.argv[2]
levels = [int(x) for x in sys.argv[3].split(",")]
words = "alpha river stone cloud maple quartz ember lotus harbor violet".split()
def one(i, out):
    seed = " ".join(random.choice(words) for _ in range(20))
    body = {"model": model, "stream": True, "max_tokens": 400, "temperature": 0.7, "stream_options": {"include_usage": True},
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": f"({seed}) Write a long essay about the history of tea trade."}]}
    req = urllib.request.Request(base + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time(); first = None; n = 0
    with urllib.request.urlopen(req, timeout=600) as r:
        for line in r:
            line = line.decode().strip()
            if not line.startswith("data: ") or line.endswith("[DONE]"): continue
            d = json.loads(line[6:])
            if d.get("choices") and d["choices"][0]["delta"].get("content"):
                if first is None: first = time.time()
            if d.get("usage"): n = d["usage"]["completion_tokens"]
    out[i] = (first - t0 if first else None, n, time.time() - (first or t0))
for N in levels:
    res = {}; ths = [threading.Thread(target=one, args=(i, res)) for i in range(N)]
    t0 = time.time(); [t.start() for t in ths]; [t.join() for t in ths]
    wall = time.time() - t0
    tot = sum(v[1] for v in res.values()); per = [round(v[1] / v[2], 1) for v in res.values()]
    print(json.dumps({"streams": N, "total_tokens": tot, "total_tps_decode": round(sum(per), 1), "per_stream_tps": per,
                      "ttft_s": [round(v[0], 2) for v in res.values()], "wall_s": round(wall, 1)}))
