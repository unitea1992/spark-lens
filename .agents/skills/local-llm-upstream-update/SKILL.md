---
name: local-llm-upstream-update
description: Spark のローカル LLM レシピの上流更新が、個別調整なしで取り込めているか・新しい設定を見落としていないかを確かめる。上流を pull した後、または更新を確かめる依頼のときに使う。
---

`~/tools/local-llm/<レシピ>/upstream` は pgx-head にあり、素の `git pull` で追う（tracked ファイルは編集しない）。

## 見る順番

1. 各レシピで `git fetch` し、前回の基準点（`local-llm-recipes` の記憶に書いたコミット）から `git log --oneline <前>..HEAD` と `git diff --stat`。`dirty` は `.env` の控えだけであるべき。**「behind 0」は「検証済み」ではない**：Spark Lens の「更新する」などで、検証より前に取り込み済みのことがある。`git reflog --date=iso -5` で pull の日時を見て、記憶の基準点と HEAD が違えばその間を検証する。後継リポジトリ（GLM の 1104 のように別名で出る）は fetch では見えないので、`gh repo list MiaAI-Lab --json name,pushedAt` も見る。
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
- 2 台構成の起動前は、**head だけでなく worker の ComfyUI（8188・8189）も `/free` で解放する**。`free-comfyui.sh` は head だけを外す。worker の ComfyUI が約 12 GiB を載せたまま GLM を起動すると、プロンプトキャッシュが 12 → 3.2 GiB に黙って縮む（2026-11-25）。Spark Lens の起動ボタンは両方を解放する（`gpuArbitration`）。手動で起動したら、rank 0 のログの `prompt cache` の行で確かめる。
- モデルの能力のスイッチ（動画・PDF・画像枚数など）が上流で opt-in に変わっていないかを `config.sh` の差分で見る。Qwen 単機は v1.2.7 で `VIDEO`・`PDF` が既定 0 になった。「モデルの能力は全部有効に」の方針なので、`.env` に置いて実機で確かめる（性能の調整とは別扱い）。
- Nemotron（`nemotron-super-vl/`）は git ではなく、GLM のイメージ（`tensorfold-glm53-spark:*` の最新）を流用する。GLM のエンジンが上がると Nemotron も黙って新しいエンジンで動くので、GLM の更新のたびに Nemotron の起動も確かめる。
- Inkling 2 Mini（`inkling-2-mini-tensorfold/`、1 台、イメージ `tensorfold-inkling2:*`）は動画・音声に非対応。通常版と未検閲版（`RERISKED=1`、重みは `hf/Inkling-2-Mini-Derisked/`）は同じコンテナを共有する。effort は none を避け low〜medium を使う（none は逆に長く出す。記録は `bench-data/runs/2026-11-25-inkling-6061fa8/`）。`.env` は絶対パスだけ（展開されない）。ドラフトは 9e3cf20（2026-11-25）から DFlash2（別の重み約 1 GB、`DRAFTER_DIR` を `.env` で recipe 配下に置く。`./scripts/fetch.sh drafter`、head では `HF_HUB_DISABLE_XET=1`）が既定で、`DRAFTER=dspark` で戻る。ビルドの 1 回目が docker 内の名前解決で落ちることがあり、同じ `./start.sh` の再実行で通る。上流の `tools/exact.py`・`prompt_reuse.py` は `python3 -I` だと自分の `client.py` を読めないので、`-I` なしで流す。`conc.py` は思考の先頭トークンも数えて測る（思考オフでも少し考えるので、本文だけ数えると TTFT が取れず落ちる）。
- 新しいモデルや構成を入れるときは、`local-llm-bench` の `battery.sh`（モデルどうしを比べる節）で、速さと品質を既存のモデルと並べてから既定にするか決める。

