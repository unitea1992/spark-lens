---
name: spark-lens-quota
description: 別モデル・エージェントへの作業配分前に、Spark Lens のクラウド利用枠とローカルLLMの稼働状況を確認する。
---

作業の割り振り前に1回、観測値専用APIを読む。

```sh
curl -fsS "http://127.0.0.1:8686/api/ai/quota"
```

`consumed_percent` は **利用済み割合**。0=未使用、100=上限到達。残量、経過率、見込み値ではない。`semantics` を優先する。
このAPIは見込み値・消費予測・予算計画を一切返さない。

- `subscriptions[]` と `local_models[]` を別々に見る。 `can_assign: false` の候補には作業を割り振らない。`blocked_reason` を確認する。
- `fresh: false`、`consumed_percent: null`、ウィンドウの期限切れは利用可能と推測しない。サブスクリプションはすべての窓が基準を満たす場合だけ割り振れる。
- ローカルLLMでは `served_model`、待ち行列、同時実行上限、共有キャッシュの空きを確認する。`can_assign` は空きキャッシュまで保証しない。
- リセット券は利用可能な枠には数えない。画面上の入力待ちやタスクの進行はこのAPIでは検知できない。
- `/api/ai` に用途別APIの一覧がある。マシン/LLMの動作は `/api/ai/monitor`、エージェント検出は `/api/ai/agents` を読む。
- `/api/quota` は旧来の詳細分析APIで予測を含むため、作業配分の判断には使用しない。
