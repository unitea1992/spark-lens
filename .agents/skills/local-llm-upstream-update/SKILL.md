---
name: local-llm-upstream-update
description: Spark のローカル LLM レシピの上流更新が、個別調整なしで取り込めているか・新しい設定を見落としていないかを確かめる。上流を pull した後、または更新を確かめる依頼のときに使う。
---

`~/tools/local-llm/<レシピ>/upstream` は pgx-head にあり、素の `git pull` で追う（tracked ファイルは編集しない）。

## 見る順番

1. 各レシピで `git fetch` し、前回の基準点（`local-llm-recipes` の記憶に書いたコミット）から `git log --oneline <前>..HEAD` と `git diff --stat`。`dirty` は `.env` の控えだけであるべき。
2. 設定の差分：`git diff <前>..HEAD -- scripts/config.sh scripts/port.sh start.sh`。新設定は既定値が何か、現在の `.env` で上書きしているかを突き合わせる。**`.env` に残すのはパス・WORKER・WORKER_WEIGHTS・HF_TOKEN などの環境依存だけ**にし、性能や挙動の設定は上流の既定に合わせる（方針 2026-11-02）。消えた設定や廃止された設定（例：Qwen 単機の `DRAFT_LANGUAGE`、GLM の `ENGINE`）は `.env` から外す。
3. README・CHANGELOG の注意書き：既定の重みの変更（再ダウンロード）、文脈の上限、クライアントから見える挙動変更。
4. `DRY_RUN=1 ./start.sh`（何も止めず起動もしない）で、イメージ・重みの準備が要るか、設定が通るかを見る。
5. 起動して検証：`local-llm-bench` のスキルのベンチと API 確認。1つずつ（同時に動くのは1モデル）。

## 決まり

- Sparks 上の削除は、そのつど明示の OK が要る。`.env` の控えも依頼者の許可を得て消す。
- 上流のイメージ識別子が変わると、DeepSeek の spill のフォルダ（`dsv41-tensorfold-spill/native-spill-<id>`）が古い版のまま残る。spill を使っている間は更新のたびに掃除する。今は spill 無効。
- `HF_TOKEN` は出力に出さない（`sed` で伏せる）。
- 外部リポジトリへの Issue は、先に既存 Issue とテンプレートを確かめ、英語の下書きを依頼者に見せて了承を得てから送る。
- GLM の現行は `~/tools/local-llm/glm-5.3-flash-1104/`（新リポジトリ。旧 `glm-5.3-flash-tensorfold/` は停止した予備で、上流の更新も追わなくてよい）。上流で `patches/engine/` が増えるとイメージのハッシュが変わり、次の起動でビルドと worker への転送（約 6 分）が走る。
- head の空きメモリが 100 GiB 未満だと GLM 新の `start.sh` は起動を断る（`MIN_AVAIL_GIB`）。`hf download` は既定の XET だと RAM を約 27 GB 使うので、head では `HF_HUB_DISABLE_XET=1` を付ける。
- 新しいモデルや構成を入れるときは、`local-llm-bench` の `battery.sh`（モデルどうしを比べる節）で、速さと品質を既存のモデルと並べてから既定にするか決める。

