---
name: spark-lens-quota
description: 複数モデル（Spark Lens に登録したクラウドのサブスクリプションとローカルLLM）へ作業を振り分ける前に、各モデルの利用枠と稼働状態を Spark Lens から確認する。実装・E2E・調査・下書きなどの作業を別モデルやサブエージェントに割り当てるときに使う。
---

作業を振る前に1回だけ確認する。

```sh
curl -s "http://127.0.0.1:8686/api/quota?view=brief"
```

`127.0.0.1:8686` は既定の待ち受けの一例。環境のホストとポート（`config/config.json` の `server`）に読み替える。候補は `models[]` にあるものだけ。

- `state` と、すべての窓の `used_pct`・`resets_at_jst` を見る。`limited`・`loading`・`down`・`unknown` には振らない。
- 今の使用率が長い窓（1日以上）で85%、短い窓で80%に達したら、そのモデルへの追加を控える。使用率が不明な窓も判断できないものとして扱う。
- `tickets` は残り枚数と次に使う時刻。券を使うのはオーナーの操作。
- ローカル LLM は `served_model`、`requests_running`・`requests_waiting`、`max_concurrent` と、あれば `pool_tokens`・`pool_free_tokens` も見る。待ちがあるか同時処理数の上限に達しているときは追加で振らない。共有領域の空きが少ない場合も長い作業を控える。

見込みや推奨は既定では見ない。詳しく見るときだけ `curl -s "http://127.0.0.1:8686/api/quota"` を使う。画面上の入力待ちは検知できない。
