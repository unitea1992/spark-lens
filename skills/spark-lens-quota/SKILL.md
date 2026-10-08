---
name: spark-lens-quota
description: 複数モデル（Spark Lens に登録したクラウドのサブスクリプションとローカルLLM）へ作業を振り分ける前に、各モデルの利用枠と稼働状態を Spark Lens から確認する。実装・E2E・調査・下書きなどの作業を別モデルやサブエージェントに割り当てるときに使う。
---

作業を振る前に1回だけ確認する。

```sh
curl -s http://127.0.0.1:8686/api/quota
```

`127.0.0.1:8686` は Spark Lens の既定の待ち受けで、一例。自分の環境のホストとポート（`config/config.json` の `server`）に読み替える。

## 読み方

振り分け先の候補は `models[]` に並ぶものだけ。ここにないサービスには振らない。各要素は次のとおり。

- `recommendation`: `use` / `avoid_heavy` / `avoid` / `unknown`。基本はこれに従う。
- `state`: `usable` / `limited`（上限に到達）/ `loading`（ローカルLLMの読み込み中）/ `down` / `unknown`。
- `recovers_at_jst`: `limited` のとき、使えるようになる時刻。
- `tickets[]`: リセット券ごとの期限（`expires_at_jst`）。期限が近い券があると、`recommendation` が上がり `reason` に期限が出る。券を使うのはオーナーの操作で、エージェントは使わない。
- `stale`: `true` なら取得が古い。値を信用せず、`avoid_heavy` 以下として扱う。
- `reason`: 判断の理由。
- ローカルLLM（`kind: local_llm`）だけ、稼働中のとき次も付く。同じ口を複数のモデルで共有していることがあるので、振る前にどれが動いているかをここで確かめる。
  - `served_model`: いま答えているモデルの名前。クライアント側では、これに対応するモデル名を指定する（サーバーによっては、別の名前を指定しても黙ってこのモデルが答える）。作業の記録には、実際に答えたこのモデル名を残す。
  - `requests_running` / `requests_waiting`: 処理中と待ちの件数。待ちがあるときは、追加の作業を振らずに空くのを待つか、別のモデルへ回す。

## 使い分け

- 重い作業（実装・E2E）は `use` のモデルだけに振る。
- 軽い作業（調査・下書き）は `use` か `avoid_heavy` のモデルに振る。
- `avoid`・`unknown`・`loading` には振らない。`loading` は読み込みが終わってから送る。
- 全部が `use` でないときは、自分の枠を使い切らない側へ寄せ、`recovers_at_jst` が近いものを待つ手もある。

## 推移も見るとき

大きな作業をまとめて振る前や、配分を見直すときは、推移も読む。

```sh
curl -s 'http://127.0.0.1:8686/api/quota?days=7'   # 各ウィンドウに trend が付く
curl -s 'http://127.0.0.1:8686/api/usage?days=7'   # daily[] に 1 日ごとのトークン数と換算額
```

- `trend.rate_pct_per_hour_24h`: 直近 24 時間の消費の速さ（1 時間あたりのポイント）。速いサービスへの追加は控えめにする。
- `trend.previous_window_peak_pct`: 前回のウィンドウの最大値。100 に近いなら、前回と同じ配り方では今回も上限に届きやすい。
- `trend` が `null`、または `since` が最近なら、まだ記録が足りない。いまの値だけで判断する。

判定の基準値は応答の `thresholds` にある。入力欄をふさぐ案内など、画面上の対話待ちは検知できない。
