# Spark Lens

自宅・小規模のローカル AI 環境を、ブラウザ 1 画面で見渡すためのダッシュボードです。

- **マシン** — 開発機と DGX Spark の GPU・メモリ・CPU・温度・ストレージ・ネットワーク・コンテナ
- **ローカル LLM** — vLLM・SGLang・TensorFold の稼働状態、生成速度、処理中の件数、先読み（投機的デコード）の効き具合、今日のトークン数
- **クラウド利用枠** — Claude Code・Codex・OpenCode Go の使用率とリセット時刻
- **エージェント** — いま動いている coding agent と、その作業内容、モデル別のトークン利用量

画面は 3 ページです。

- **ローカル AI** — ラボの構成図（開発機 → Spark 2 台と、その間の高速回線、2 台にまたがるモデル）を先頭に、モデルの状態と起動・停止、各マシンの詳細を並べます。回線は実際の通信量（RDMA を含む）に応じて流れ、モデルは推論中だけ光ります
- **利用状況** — クラウド利用枠と、ローカル・クラウドを合わせたモデル別のトークン利用量
- **エージェント** — いま動いている coding agent

各タブには、そのページで注意が必要なこと（黄・赤の点）や作業中の件数が出ます。ほかのページで問題があるときだけ、画面上部に「要確認」の帯が出ます。スマートフォンでは下部のタブで切り替えます。

ローカル AI のページからは、登録した「レシピ」（モデルの起動スクリプト）の起動・停止とログの確認もできます。

監視される側のマシンには何もインストールしません。Spark Lens は開発機で動き、Spark へは数秒おきに SSH で短いスクリプトを流すだけなので、Spark の GPU とメモリは推論のために空いたままです。

## 必要なもの

- Node.js 24 以上と pnpm（開発機）
- 監視したいマシンへ、パスワードなしで入れる SSH（`ssh <ホスト名>` が通ること）
- 手元の PC やスマートフォンから見る場合は Tailscale

## 使い始める

```bash
git clone https://github.com/unitea1992/spark-lens.git
cd spark-lens
pnpm install

mkdir -p ~/.config/spark-lens
cp config/config.example.json ~/.config/spark-lens/config.json
# ~/.config/spark-lens/config.json のホスト名を自分の環境に合わせて書き換える

deploy/install.sh        # ビルドして systemd のユーザーサービスとして常駐させる
```

`http://127.0.0.1:8686` を開くと表示されます。設定を変えたら `systemctl --user restart spark-lens` で反映します。

設定ファイルがなければ、そのマシン自身と 3 つのクラウド利用枠だけを表示します。

### Tailscale 経由で見る

Spark Lens 自体は開発機の内側（127.0.0.1）だけで待ち受けます。Tailscale に中継させると、同じ tailnet の端末からだけ HTTPS で開けるようになります。

```bash
tailscale serve --bg --https=8686 http://127.0.0.1:8686
```

表示された `https://<マシン名>.<tailnet>.ts.net:8686/` を PC やスマートフォンで開いてください。やめるときは `tailscale serve --https=8686 off` です。

ログイン機能はありません。tailnet の外へ公開する（Tailscale Funnel やポート開放）使い方は想定していません。

## 設定

`~/.config/spark-lens/config.json`（場所は環境変数 `SPARK_LENS_CONFIG` で変更可）。全体の例は [`config/config.example.json`](config/config.example.json) にあります。

| 項目 | 既定値 | 内容 |
|---|---|---|
| `server.host` / `server.port` | `127.0.0.1` / `8686` | 待ち受けるアドレスとポート |
| `server.allowedHosts` | `[]` | 独自ドメインで開く場合に、そのホスト名を追加する |
| `pollSeconds` | `5` | マシンと LLM を確認する間隔 |
| `agentPollSeconds` | `15` | エージェントを確認する間隔 |
| `subscriptionPollSeconds` | `300` | クラウド利用枠を取得する間隔 |
| `hosts[]` | このマシンのみ | 監視するマシン |
| `llms[]` | なし | 監視するローカル LLM |
| `subscriptions[]` | 3 サービス | 表示するクラウド利用枠 |
| `agents.processes[]` | なし | 追加で検出したいエージェントのプロセス |

### マシン（`hosts`）

```json
{ "id": "spark-1", "label": "DGX Spark 1", "kind": "spark", "ssh": "spark-1" }
```

- `ssh` — SSH の接続先。`~/.ssh/config` の別名か `user@host`。このマシン自身を見るときは代わりに `"local": true`
- `kind` — `spark`（GPU を主役に表示）、`workstation`、`server`
- `mounts` — 容量を表示するマウントポイント。既定は `["/"]`

### ローカル LLM（`llms`）

```json
{
  "id": "glm-5-3-flash",
  "label": "GLM-5.3 Flash",
  "baseUrl": "http://spark-1:8888",
  "nodes": ["spark-1", "spark-2"],
  "containers": ["glm53-exl3-head", "glm53-exl3-worker"]
}
```

- `baseUrl` — OpenAI 互換サーバーのアドレス（`/v1` は付けない）。`/health`・`/v1/models`・`/metrics` を読みます
- `engine` — `vllm`・`sglang`・`tensorfold`。省略（`auto`）すると応答から自動で判別します。SGLang は起動時に `--enable-metrics` を付けないと速度などの数値が出ません
- `nodes` — そのモデルが載っているマシンの `id`
- `containers` — モデルを動かすコンテナ名。API がまだ応答しなくてもコンテナが起動していれば「起動中」と表示します
- `apiKeyEnv` — API キーが必要なサーバーの場合、キーを入れた環境変数の名前（キー自体は設定ファイルに書きません）

上の例は [GLM-5.3 Flash EXL3 on DGX Spark](https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks) を 2 台構成で動かした場合の値です。

### レシピ（`recipes`）

モデルの起動・停止をダッシュボードのボタンから行うための登録です。upstream の起動スクリプトをそのまま呼び出すので、スクリプト側に手を加える必要はありません。

```json
{
  "id": "glm-5-3-flash",
  "label": "GLM-5.3 Flash",
  "host": "spark-1",
  "group": "sparks",
  "llm": "glm-5-3-flash",
  "dir": "~/tools/local-llm/glm-5.3-flash/upstream",
  "start": "./start.sh",
  "stop": "./start.sh stop",
  "logs": "docker logs --tail 300 glm53-exl3-head"
}
```

- `host` と `dir` — どのマシンのどのディレクトリでコマンドを実行するか
- `start` / `stop` — 起動・停止のコマンド。起動はそのマシン上で切り離して実行され、出力はそのマシンの `~/.local/state/spark-lens/recipe-<id>.log` に残ります。ダッシュボードを再起動しても起動処理は止まりません
- `logs` — 「サーバーログ」に表示する内容を出力するコマンド（省略可）
- `llm` — このレシピが動かすモデル（`llms` の `id`）。稼働中かどうかの判定に使います
- `group` — 同じマシンを使うレシピの組。同じ組で同時に動かせるのは 1 つだけで、ほかが動いている間は起動ボタンが押せません。省略すると `host` が組になります

ボタン操作に認証はありません。tailnet の中から開ける人は誰でも起動・停止できる前提です。別のサイトから閲覧者のブラウザを使って操作させることはできないようにしてあります（操作には画面からだけ付く専用のヘッダーが必要です）。

### マシンのクロック上限

CPU は `scaling_max_freq`、GPU は systemd のユニットに書かれた `nvidia-smi -lgc 最小,最大` を読み、上限を絞っている場合はその値を上限として表示します。

### クラウド利用枠（`subscriptions`）

| `type` | 取得元 | 前提 |
|---|---|---|
| `claude-code` | Anthropic の使用状況 API | 開発機で `claude` にサブスクリプションでログイン済み |
| `codex` | ChatGPT の使用状況 API | 開発機で `codex` に ChatGPT アカウントでログイン済み |
| `opencode-go` | OpenCode Go の使用状況 API | 開発機で `opencode auth login` 済み（または環境変数 `OPENCODE_GO_API_KEY`） |
| `command` | 任意のコマンドの出力 | 下記 |

認証情報は各ツールが保存しているものをその都度読むだけで、Spark Lens は複製も更新もしません。ログインの期限が切れたときは、そのツールを一度起動すれば元に戻ります。

バーの上の縦線は「期間がどこまで進んだか」を示します。バーが縦線より右にあれば、均等に使うペースより速く消費しています。その下には、ここまでの使い方が続いた場合に期間終了時に何 % になるか（上限に届きそうなら、あと何時間で届くか）を表示します。

プラン名は、Claude Code はログイン情報（`subscriptionType` と `rateLimitTier`）、Codex は使用状況 API の `plan_type` から取得します。OpenCode Go は Go プラン専用の API なので常に「Go」です。Codex のリセット券は枚数と期限を表示します。Claude のリセット券は Claude Code のログインで読める API に含まれないため表示できません。

#### ほかのサービスを足す

コードを書かずに足すなら `command` を使います。使用状況を JSON で出力するスクリプトを用意して、設定に登録します。

```json
{ "type": "command", "label": "My Plan", "options": { "command": ["/path/to/usage.sh"] } }
```

```json
{
  "plan": "Pro",
  "windows": [{ "id": "weekly", "label": "週間", "usedPct": 40, "resetsAt": "2026-10-05T00:00:00Z" }],
  "notes": []
}
```

組み込みとして足すなら、[`server/collectors/subscriptions/`](server/collectors/subscriptions) に `Provider` を 1 ファイル追加し、[`index.ts`](server/collectors/subscriptions/index.ts) の一覧に加えます。既存の 3 つがそのまま見本になります。

### エージェント

開発機では次の情報源を自動で使います。入っていないツールは単に表示されません。

| ツール | 情報源 |
|---|---|
| Claude Code | `~/.claude/sessions/` のセッション記録 |
| Codex | `~/.codex/` のスレッド記録 |
| OpenCode | 常駐サーバーへの問い合わせ（`opencode api`） |
| Orca | `orca worktree ps`（Orca 上で動くエージェント全般） |

「モデル別の利用量」は、Claude Code（`~/.claude/projects/`）、Codex（`~/.codex/` のスレッド記録）、OpenCode（`opencode stats`）の記録と、ローカル LLM のトークン数を合わせて、今日と直近 7 日間で集計します。Codex は合計トークンしか記録していないため内訳は出ません。

SSH 先のマシンでは、`claude`・`codex`・`opencode` のプロセスを検出します。ほかのプロセスも拾いたいときは規則を足します。`match` は各マシンの awk で評価されるため、POSIX 拡張正規表現の範囲で書いてください（`\d` や `(?:…)` は使えません）。

```json
{ "agents": { "processes": [{ "tool": "hermes", "label": "Hermes", "match": "(^|/)hermes( |$)" }] } }
```

## 仕組み

```
ブラウザ ──HTTPS──▶ tailscale serve ──▶ Spark Lens（開発機, Node.js）
                                          ├─ ssh ──▶ 各マシンで server/probe.sh を実行
                                          ├─ HTTP ─▶ ローカル LLM の /health, /metrics
                                          ├─ HTTPS ▶ 各サービスの使用状況 API
                                          └─ 開発機内のエージェント記録を読む
```

- サーバー（[`server/`](server)）は Node.js の標準機能だけで動き、実行時の依存パッケージはありません。TypeScript をそのまま実行します
- 画面（[`web/`](web)）は React で、`pnpm build` で `dist/` に出力したものをサーバーが配信します
- 画面への反映は Server-Sent Events。履歴は直近 10 分ぶんをメモリに持つだけで、データベースは使いません
- 日ごとのトークン数だけ `~/.local/state/spark-lens/state.json` に保存します

## 開発

```bash
pnpm dev        # サーバーを変更監視つきで起動（:8686）
pnpm dev:web    # 画面をホットリロードで起動（API は :8686 に中継）
pnpm check      # 型チェック・テスト・ビルド
pnpm scan:secrets   # Betterleaks（Docker）で履歴と作業ツリーの秘密情報を走査
```

GitHub Actions でも push と pull request のたびに同じ走査を行います。

## アンインストール

```bash
deploy/install.sh --uninstall
tailscale serve --https=8686 off
```

## ライセンス

[MIT](LICENSE)
