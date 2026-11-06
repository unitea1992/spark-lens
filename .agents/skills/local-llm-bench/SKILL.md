---
name: local-llm-bench
description: Spark のローカル LLM（GLM・Qwen・DeepSeek）を同じ手順で測り、前回と比べて記録する。上流の更新後、設定変更後、モデルの選び直しの前に使う。Responses API と Chat Completions の同等性確認もここにある。
---

ローカル LLM の定期計測。pgx-head:8888 は同時に1モデルしか動かせないので、1本ずつ止めて起動し、測り、最後に元のモデルへ戻す。

## 何のために測るか

起動後に動くかどうかの確認（疎通）は、各レシピの `start.sh` が最後に1回のチャット要求で行う（`[5/5] Smoke test`）。DeepSeek の上流には、応答の検査（`tools/validate.py`、`smoke.py`）と速度の測定（`tools/bench.py`）もあり、Qwen 単機の上流にも `tools/bench.py` がある。
ここで流す Spark Lens のベンチは疎通確認ではなく、上流の更新や設定の変更のあとに、速度が前と同じ水準かを同じ手順で比べるためのもの。起動しただけで動作を確かめたいときは、ベンチは要らない。

## 事前確認

- 他の作業が使っていないこと：`curl -s http://127.0.0.1:8686/api/quota?view=brief`（ホストとポートは `~/.config/spark-lens/config.json` の `server`）で稼働状態を見る。使用中なら、止める前に持ち主へ相談する。
- 計測前に今動いているモデルを控える。最後にそれへ戻す。

## 流す

1. 止める：`ssh pgx-head 'cd ~/tools/local-llm/<動いているレシピ>/upstream && ./stop.sh'`
2. 起動：起動コマンドは `config.json` の `recipes[]` の `start`（DeepSeek は `PATH="$HOME/.local/bin:$PATH"` が要る）。ssh の1行で流し、ログは `start-<日付>.log` に出す。初回や上流更新後はイメージのビルド・取得で長い（GLM 約15分、Qwen 約5分）ので、バックグラウンドで流す。
3. 測る：起動直後は Spark Lens がまだ `up` と見ておらず「モデルが稼働していません」で終わるので、`/api/state` の該当 `llms[].state` が `up` になるまで待つ。そのうえで `pnpm bench <llm-id>`（`config.json` の `llms[].id`）。**サービスが動いているチェックアウト**で流す（`systemctl --user cat spark-lens` の `WorkingDirectory`）。リポジトリの main に無い設定が `config.json` にあると、別のチェックアウトでは設定の読み込みで落ちる。`pnpm` に `-s` は使えない。標準出力が結果の JSON、標準エラーが進捗。
4. 全モデルで繰り返し、最後に元のモデルを起動し直す。Ablit 版は同じ重み・エンジンなので、通常版を測れば足りる。

## 記録と比較

- 結果は、サービスが動いているチェックアウトの `bench-data/spark-lens-bench/runs.jsonl` に自動で追記される（別の worktree から動いているときは、そちらに溜まる。`compare.py` が読むこのチェックアウトの分へ、足りない行を追記して統合する。`SPARK_LENS_BENCH_DIR` で場所を揃える手もある）。加えて `bench-data/runs/<日付>-<名前>/results/` に JSON と起動ログを置き、`NOTES.md` に上流のコミットと `.env` の違いを書く（置き方は `bench-data/README.md`）。
- 前回との比較：`python3 -I .agents/skills/local-llm-bench/scripts/compare.py`（モデルごとに TTFT・prose・code・プレフィルの最新と1つ前、増減％）。
- 目安（既定設定、TTFT ms / prose / code / プレフィル tok/s）：DeepSeek 149 / 58 / 102 / 1,952（2026-11-06）、GLM 約 190 / 34 / 62 / 1,565（2026-11-05 に切り替えた新レシピ 1104、DENSE=q8。旧 EXL3・q4 は 143 / 46 / 73 / 1,569）、Qwen 二機 95 / 36 / 83 / 3,122、Qwen 単機 266 / 30 / 76 / 2,102（この 2 つは 2026-11-02）。大きく下回るときは `.env` の違いと同時稼働を疑う。

## API の同等性確認（Responses と Chat）

起動後に1モデルずつ：

```sh
python3 -I .agents/skills/local-llm-bench/scripts/resp_check.py http://pgx-head:8888/v1 <提供名> low
python3 -I .agents/skills/local-llm-bench/scripts/loop_cache.py http://pgx-head:8888/v1 <提供名> low

キャッシュの確認に使う文は、ランダムな語で作る。同じ文の繰り返しだと Qwen 二機は保存せず、`cached_tokens` が常に 0 になる（2026-11-02 に確認。実際の会話では当たる）。
```

基本・ストリーム・ツール往復・画像・`previous_response_id`・長い前置きのキャッシュを、Responses と Chat で並べて出す。`cached_tokens` が両方0なら API ではなくエンジンの問題（2026-11-02 時点で Qwen 二機がそう）。Pi と DSH-TUI は Responses で `include: ["reasoning.encrypted_content"]` を固定で送り、DeepSeek がこれを拒否するため Completions 運用（上流 issue #99）。

## モデルどうしを比べる（直接対決）

`pnpm bench` は単ストリームの速さだけを見る。モデルを選ぶ・切り替えるときは、次の測定器で速さと品質を同じ条件で並べる。**1 回の点数は ±4 問/59 ほど揺れる**ので、点数だけで優劣を決めず、所要時間・トークン数と合わせ、必要なら複数回測る。

| スクリプト | 測るもの |
|---|---|
| `conc.py` | 並列 1・2・4 本の合計デコード速度 |
| `long.py` | 4 万・17 万トークン級のプリフィルとデコード（窓より大きいとエラー） |
| `qset.py` | 答えが決まった計算問題 59 問を思考ありで解く点数・所要・出力トークン（`EFFORT`・`SEED`・`TEMP` などで条件を固定） |
| `code_eval.py <BASE> <提供名> <並列> basic\|hard` | 標準 20 問・難問 19 問のコードを、参照実装と同じ入力で動かして採点（問題は `problems_*.py`） |
| `ja_eval.py` | 日本語 8 問の回答を保存（人が読む） |
| `ja_repeat.py` | 論理パズルと形式指定（敬体・5 項目・30 字以内）を n 回ずつ自動採点 |
| `battery.sh <出力フォルダ> <提供名> <llm id>` | 上のすべてと `pnpm bench`・`resp_check.py` を順に流す。済んだ段階は飛ばして再開できる。思考の長いモデルは 1 時間を超える |

- 手順は 1 モデルずつ。他を止めて起動し、Spark Lens で `up` になってから `battery.sh` を流す。結果は `bench-data/runs/<日付>-<名前>/results/` に置く。
- 2026-11-06 の 4 モデル比較（DeepSeek・GLM 新 q8・Nemotron 3.5 Super VL・GLM FP4-Local）の結果と読み方は `bench-data/runs/2026-11-05-glm1104/NOTES.md`。要点は、DeepSeek が速度・計算問題・日本語の指示追従で最良、Nemotron は品質が並ぶが思考が非常に長い、GLM 新は標準コードで満点だが日本語の敬体指示が弱い。
- 注意：effort の段の意味はレシピ間で同じでも、同じ effort・seed で出力の長さが 1.3〜2 倍違うことがある（GLM の旧 EXL3 と新 1104）。所要時間の差は、デコード速度の差と出力トークン数の差に分けて読む（`qset.py` は両方を出す）。
- 思考オフ（`enable_thinking: false`）の回答には、思考が本文に漏れる回がある。形式指定の採点は、この漏れで落ちることがある。

