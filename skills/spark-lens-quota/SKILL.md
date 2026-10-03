---
name: spark-lens-quota
description: 複数モデル（Claude・Codex・OpenCode Go・Grok・ローカルLLM）へ作業を振り分ける前に、各モデルの利用枠と稼働状態を Spark Lens から確認する。実装・E2E・調査・下書きなどの作業を別モデルやサブエージェントに割り当てるときに使う。
---

作業を振る前に1回だけ確認する。

```sh
curl -s http://127.0.0.1:8686/api/quota
```

`127.0.0.1:8686` は Spark Lens の既定の待ち受けで、一例。自分の環境のホストとポート（`config/config.json` の `server`）に読み替える。

## 読み方

`models[]` の各要素は次のとおり。

- `recommendation`: `use` / `avoid_heavy` / `avoid` / `unknown`。基本はこれに従う。
- `state`: `usable` / `limited`（上限に到達）/ `loading`（ローカルLLMの読み込み中）/ `down` / `unknown`。
- `recovers_at_jst`: `limited` のとき、使えるようになる時刻。
- `stale`: `true` なら取得が古い。値を信用せず、`avoid_heavy` 以下として扱う。
- `reason`: 判断の理由。

## 使い分け

- 重い作業（実装・E2E）は `use` のモデルだけに振る。
- 軽い作業（調査・下書き）は `use` か `avoid_heavy` のモデルに振る。
- `avoid`・`unknown`・`loading` には振らない。`loading` は読み込みが終わってから送る。
- 全部が `use` でないときは、自分の枠を使い切らない側へ寄せ、`recovers_at_jst` が近いものを待つ手もある。

判定の基準値は応答の `thresholds` にある。入力欄をふさぐ案内など、画面上の対話待ちは検知できない。
