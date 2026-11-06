"""日本語の 8 問（メール・要約・説明・翻訳・論理パズル・推敲・形式指定・レビュー）の回答を JSON に保存する。人が読んで比べる用。

使い方: python3 -I ja_eval.py <BASE（…/v1）> <提供名> <出力 JSON>
環境変数: EFFORT
"""
import json, sys, time, urllib.request, os
base, model, out = sys.argv[1], sys.argv[2], sys.argv[3]
EFFORT = os.environ.get("EFFORT", "")
text = "近年、リモートワークの普及により、企業のオフィス需要は大きく変化している。都心部の大規模オフィスでは空室率が上昇する一方、郊外のサテライトオフィスやコワーキングスペースの利用は増加している。企業は固定費の削減を狙ってオフィス面積を縮小する動きを見せているが、従業員の孤立やコミュニケーション不足、新入社員の育成の難しさといった課題も指摘されている。このため、週の一部のみ出社するハイブリッド型の勤務形態を採用し、オフィスを「集まるための場所」として再定義する企業が増えている。"
P = [
 ("email", "取引先に対し、システム納品が3営業日遅れることをお詫びし、新しい納期（来週水曜日）と再発防止策を伝えるビジネスメールを書いてください。宛名は株式会社サンプル 営業部 田中様、差出人は山田です。"),
 ("summary", f"次の文章を、重要な点を落とさず3文以内で要約してください。\n\n{text}"),
 ("explain", "TCPの3ウェイハンドシェイクを、ネットワークを学び始めたばかりの新入社員に、たとえ話を使って300字程度で説明してください。"),
 ("translate", "次の英文を自然な日本語に翻訳してください。直訳調は避けてください。\n\nThe service gracefully degrades under load: instead of rejecting requests outright, it sheds the least critical work first, keeping core paths responsive while background jobs are deferred."),
 ("puzzle", "A、B、Cの3人のうち、1人だけが本当のことを言い、2人は嘘をついています。Aは「Bが嘘つきだ」、Bは「Cが嘘つきだ」、Cは「AもBも嘘つきだ」と言いました。本当のことを言っているのは誰ですか。理由を簡潔に説明してください。"),
 ("rewrite", "次の文章を、不自然な表現を直して自然で読みやすい日本語にしてください。意味は変えないでください。\n\n本システムは、ユーザーの体験を最大化することを目的として、革新的なアプローチによってシームレスな価値を提供することを実現しております。"),
 ("constraint", "日本語の敬体（です・ます調）で、ソフトウェアのコードレビューで気をつける点を、ちょうど5つの箇条書きで答えてください。各項目は30文字以内にしてください。前置きや締めの文は不要です。"),
 ("review", "次のPythonコードにレビューコメントを日本語で付けてください。問題点と改善案を具体的に。\n\n```python\ndef avg(xs):\n    total = 0\n    for i in range(len(xs)):\n        total = total + xs[i]\n    return total / len(xs)\n```"),
]
res = {}
for k, q in P:
    body = {"model": model, "max_tokens": 4000, "temperature": 0.7, "messages": [{"role": "user", "content": q}]}
    if EFFORT: body["reasoning_effort"] = EFFORT
    req = urllib.request.Request(base + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    d = json.load(urllib.request.urlopen(req, timeout=900)); m = d["choices"][0]["message"]
    res[k] = {"prompt": q, "answer": m.get("content") or "", "seconds": round(time.time() - t0, 1), "completion_tokens": d["usage"]["completion_tokens"], "reasoning_chars": len(m.get("reasoning_content") or m.get("reasoning") or "")}
json.dump(res, open(out, "w"), ensure_ascii=False, indent=1)
print(json.dumps({k: (v["seconds"], v["completion_tokens"]) for k, v in res.items()}))
