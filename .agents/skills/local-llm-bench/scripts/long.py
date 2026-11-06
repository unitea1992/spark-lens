"""長いプロンプト（乱数の語）のプリフィル速度とデコード速度を測る。

使い方: python3 -I long.py <BASE（…/v1）> <提供名> <目標トークン数のカンマ区切り 例 32000,128000>
実際のトークン数は目標の約 1.3 倍になる。窓より大きいとエラーで止まる。
"""
import json, sys, time, random, string, urllib.request
base, model = sys.argv[1], sys.argv[2]
def words(n):
    rnd = random.Random(); return " ".join("".join(rnd.choices(string.ascii_lowercase, k=rnd.randint(3, 8))) for _ in range(n))
for target in [int(x) for x in sys.argv[3].split(",")]:
    text = words(int(target * 0.42))  # random words are roughly 2.4 tokens each
    body = {"model": model, "stream": True, "max_tokens": 200, "temperature": 0.7, "stream_options": {"include_usage": True},
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": text + "\n\nIgnore the text above. Write a short story about a lighthouse."}]}
    req = urllib.request.Request(base + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time(); first = None; usage = None
    with urllib.request.urlopen(req, timeout=1800) as r:
        for line in r:
            line = line.decode().strip()
            if not line.startswith("data: ") or line.endswith("[DONE]"): continue
            d = json.loads(line[6:])
            if d.get("choices") and d["choices"][0]["delta"].get("content") and first is None: first = time.time()
            if d.get("usage"): usage = d["usage"]
    end = time.time(); pt = usage["prompt_tokens"]; ct = usage["completion_tokens"]
    print(json.dumps({"target": target, "prompt_tokens": pt, "ttft_s": round(first - t0, 1), "prefill_tps": round(pt / (first - t0)),
                      "decode_tps": round(ct / (end - first), 1), "cached": (usage.get("prompt_tokens_details") or {}).get("cached_tokens")}), flush=True)
