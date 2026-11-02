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
- 目安（2026-11-02、既定設定、TTFT ms / prose / code / プレフィル tok/s）：DeepSeek 163 / 63 / 106 / 1,989、GLM 143 / 46 / 73 / 1,569、Qwen 二機 95 / 36 / 83 / 3,122、Qwen 単機 266 / 30 / 76 / 2,102。大きく下回るときは `.env` の違いと同時稼働を疑う。

## API の同等性確認（Responses と Chat）

起動後に1モデルずつ：

```sh
python3 -I .agents/skills/local-llm-bench/scripts/resp_check.py http://pgx-head:8888/v1 <提供名> low
python3 -I .agents/skills/local-llm-bench/scripts/loop_cache.py http://pgx-head:8888/v1 <提供名> low
```

基本・ストリーム・ツール往復・画像・`previous_response_id`・長い前置きのキャッシュを、Responses と Chat で並べて出す。`cached_tokens` が両方0なら API ではなくエンジンの問題（2026-11-02 時点で Qwen 二機がそう）。Pi と DSH-TUI は Responses で `include: ["reasoning.encrypted_content"]` を固定で送り、DeepSeek がこれを拒否するため Completions 運用（上流 issue #99）。
