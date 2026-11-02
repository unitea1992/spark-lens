---
name: readme-screenshots
description: README の画像（docs/images の lab・lab-dark・usage・agents）を、実際の画面から匿名化したデータで撮り直す。画面を変えたとき、または画像が古くなったときに使う。
---

README の画像は、実データではなく匿名のサンプルで撮る（マシン名・作業内容・他プロジェクトのコンテナ名を置き換える）。サービスが動いている開発機で行う。

## 前提

- 置換表 `~/.config/spark-lens/screenshot-map.json`（リポジトリに入れない）：`replace`（実名 → 公開してよい名前の組）、`leak_pattern`（残ってはいけない語の正規表現）、`drop_llms`（画像に出さないモデルの id）。
- ブラウザ：Playwright が取得済みの Chromium（`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`）。`playwright-core` の入ったディレクトリ（例：`$(npm root -g)/@playwright/cli/node_modules`）。ライブラリの版と合わない Chromium は `CHROME` で直接指定する。
- 撮りたい状態にしておく：モデルが1つ稼働中（`up`）、直近のベンチがある、上流が最新（画面に更新の帯が出ない）。

## 手順

1. 最新のコードで `pnpm build`（`dist/` を作る）。
2. 実データの取得と匿名化：
   ```sh
   curl -s http://127.0.0.1:8686/api/state > /tmp/state.real.json
   python3 -I .agents/skills/readme-screenshots/scripts/sanitize.py /tmp/state.real.json /tmp/state.demo.json
   ```
   `leaks: []` を確認する（空でなければ置換表を足して再実行）。エージェントは固定のサンプル4件に入れ替わり、他のコンテナは除かれ、上流の更新帯は消える。
3. モックを立てる（`dist/` とサンプルのスナップショットを配る。ポートは空いているもの。5199 は別アプリが使うことがある）：
   `node .agents/skills/readme-screenshots/scripts/mock.mjs dist /tmp/state.demo.json 5671 &`
4. 撮る：
   `CHROME=<chrome> node .agents/skills/readme-screenshots/scripts/shoot.mjs <playwright-core のあるディレクトリ> http://127.0.0.1:5671 /tmp/shots`
   幅 1280。`lab`・`lab-dark` は「マシン」の見出しの手前まで、`usage` は全体、`agents` は高さ 620。
5. 目で確認する（実名・パス・他プロジェクトのコンテナ名・IP が写っていないか、レイアウトが崩れていないか）。問題なければ `docs/images/` へ置き、PR にする。モックは止める。

## 注意

- 利用枠・トークン数・プラン名は実データのまま出る（以前の画像と同じ）。出したくなければ `sanitize.py` に項目を足す。
- ライブ時刻（右上）と「○分前」は撮った時点の値になる。
