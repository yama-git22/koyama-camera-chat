# Discord / Slack 日次ニュースまとめ Bot

毎日1回、RSSから直近24時間のニュースを集めて、Discord/Slackチャンネルに要約を投稿するBotです。
また、Botに話しかけると博多弁で会話できます。

## 機能

- 複数RSSフィードからニュース取得
- 重複除去
- 直近24時間の記事のみ抽出
- OpenAI APIで日本語要約（未設定なら簡易要約にフォールバック）
- `node-cron` による日次投稿
- Discord: `@Botメンション` または `news` プレフィックスで会話（博多弁）
- Slack: `@Botメンション` または `news` プレフィックスで会話（博多弁）
- Slack: `camera` / `カメラ` でRaspberry Piカメラの画像を同じチャンネルに投稿

## 事前準備

1. Discord Developer Portal で Bot を作成
2. Bot Token を取得
3. 投稿先チャンネルIDを取得（開発者モードをONにしてコピー）
4. Bot をサーバーに招待し、投稿権限を付与
5. 会話機能を使う場合は、Developer Portal の `Bot` で `MESSAGE CONTENT INTENT` を有効化
6. Slackを使う場合は Slack App を作成し、Socket Mode を有効化
7. Slack Bot Token (`SLACK_BOT_TOKEN`), App Token (`SLACK_APP_TOKEN`), Signing Secret (`SLACK_SIGNING_SECRET`) を取得
8. Slack投稿先チャンネルID (`SLACK_CHANNEL_ID`) を設定
9. Slackでカメラ投稿を使う場合は `files:write` スコープを追加してアプリを再インストール

## セットアップ

```bash
npm install
cp .env.example .env
```

`.env` を編集してください。

## 起動

```bash
npm start
```

## Raspberry PiカメラをSlackに投稿

Slackで `camera` または `カメラ` と送ると、Raspberry Pi Cameraで静止画を撮影して同じチャンネルに投稿します。

前提:
- Raspberry Piカメラが接続済み
- `rpicam-still`（Bookworm）または `libcamera-still`（Bullseye）が使える
- Slack Appに `files:write` 権限がある

```bash
sudo apt update
sudo apt install -y rpicam-apps
# 古いOSの場合:
sudo apt install -y libcamera-apps
```

`.env` 例:

```env
SLACK_CAMERA_ENABLED=true
SLACK_CAMERA_CHANNEL_ID=
CAMERA_CAPTURE_TIME_MS=1200
CAMERA_OUTPUT_DIR=output/camera
```

任意で `SLACK_CAMERA_CHANNEL_ID` を設定すると、そのチャンネルだけカメラコマンドを受け付けます。

## Zoom動画の文字起こし・要約

Zoom録画ファイル（mp4等）またはZoom共有URLから文字起こしと要約を作成します。

```bash
npm run zoom:summary -- /path/to/zoom-recording.mp4
npm run zoom:summary -- "https://us06web.zoom.us/rec/share/...."
```

出力先:
- `output/*.transcript.txt`
- `output/*.summary.md`

前提:
- `OPENAI_API_KEY` が設定されていること
- `ffmpeg` がインストールされていること
- URL入力を使う場合は `yt-dlp` があると成功率が上がること（未導入時は直接ダウンロードを試行）

macOS で `ffmpeg` がない場合:

```bash
brew install ffmpeg
brew install yt-dlp
```

## note記事の自動生成 + X(Twitter)自動投稿

note記事の下書きを自動生成し、任意でnoteへ公開した後にXへ投稿します。

```bash
# 常駐（cron実行）
npm run note:x:auto

# 1回だけ実行（動作確認）
npm run note:x:once
```

動作概要:
- OpenAIでMarkdown記事を生成
- `output/note-drafts/*.md` に下書きを保存
- `NOTE_PUBLISH_COMMAND` があれば実行し、出力からnote記事URLを検出
- X API v2へ投稿（OAuth 1.0a）

注意:
- noteには公開APIが限定的なため、このリポジトリでは `NOTE_PUBLISH_COMMAND` で公開処理を外部化しています。
- `NOTE_PUBLISH_COMMAND` は `{file}` `{title}` `{slug}` を使えます。
- コマンドの標準出力または標準エラーにURLを含めると、そのURLがX投稿文に添付されます。

`.env` 例:

```env
NOTE_X_CRON_SCHEDULE=0 9 * * *
NOTE_X_RUN_ON_START=true
NOTE_TOPICS=AIの最新活用,個人開発の学び,自動化で時短した実例
NOTE_REFERENCE_FEEDS=https://www3.nhk.or.jp/rss/news/cat0.xml
NOTE_MIN_INTERVAL_HOURS=20
NOTE_MODEL=gpt-4.1-mini
NOTE_OUTPUT_DIR=output

# 例: 任意の公開スクリプトを呼ぶ（URLをstdoutへ出力）
NOTE_PUBLISH_COMMAND=./scripts/publish-note.sh {file}
NOTE_FALLBACK_URL=https://note.com/your_account

X_ENABLED=true
X_USERNAME=your_account
X_CONSUMER_KEY=
X_CONSUMER_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

## ネットワーク論文Slack Bot

Mac mini (M1 / 16GB) で動かす前提なら、既定の `qwen2.5:7b` か軽めの `gemma3:4b` が現実的です。Botは `arXiv API -> Ollama -> Slack Web API` の順で処理します。

Slack側の前提:
- `chat:write` スコープを持つSlack Appを作る
- Botを投稿先チャンネルに招待する
- `SLACK_BOT_TOKEN` と `SLACK_CHANNEL_ID` を `.env` に入れる

Ollama側の前提:

```bash
# OllamaをmacOSにインストール後
ollama pull qwen2.5:7b
# もっと軽くしたい場合
# ollama pull gemma3:4b
```

`.env` 例:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0123456789

PAPER_SEARCH_QUERY=cat:cs.NI
PAPER_CRON_SCHEDULE=0 9 * * *
PAPER_RUN_ON_START=false
PAPER_FETCH_LIMIT=25
PAPER_MAX_POSTS=5
PAPER_LOOKBACK_HOURS=48

OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
```

実行コマンド:

```bash
# Slack投稿せず内容だけ確認
npm run paper:network:dry-run

# 1回だけ実行してSlackへ投稿
npm run paper:network:once

# 常駐して毎日定時に実行
npm run paper:network
```

補足:
- `PAPER_SEARCH_QUERY` は arXiv の検索式です。まずは `cat:cs.NI` を既定にしています。
- 同じ論文を再投稿しないように、投稿済みIDは `output/network-paper-bot-state.json` に保存します。
- 要約に失敗した場合は、アブストラクトからの簡易要約へフォールバックします。
- Mac mini へ別端末デプロイする場合の手順は `DEPLOY_MACMINI.md` を参照してください。

## 主な環境変数

- `DISCORD_TOKEN` (必須): Botトークン
- `DISCORD_CHANNEL_ID` (必須): 投稿先チャンネルID
- `DISCORD_ENABLED`: Discord連携のON/OFF（既定: `true`）
- `SLACK_ENABLED`: Slack連携のON/OFF（既定: `false`）
- `SLACK_BOT_TOKEN`: Slack Bot User OAuth Token
- `SLACK_APP_TOKEN`: Slack App Level Token（Socket Mode用）
- `SLACK_SIGNING_SECRET`: Slack Signing Secret
- `SLACK_CHANNEL_ID`: Slack投稿先チャンネルID
- `NEWS_FEEDS` (必須): RSS URLを`,`区切りで指定
- `CRON_SCHEDULE`: cron式（既定: `0 8 * * *`）
- `TZ`: タイムゾーン（既定: `Asia/Tokyo`）
- `MAX_NEWS_ITEMS`: 要約対象の最大記事数（既定: `12`）
- `RUN_ON_START`: 起動時に1回実行するか（`true/false`）
- `OPENAI_API_KEY`: 設定時のみAI要約を利用
- `OPENAI_MODEL`: 既定 `gpt-4.1-mini`
- `NOTE_X_CRON_SCHEDULE`: note/X自動化のcron式（既定: `0 9 * * *`）
- `NOTE_X_RUN_ON_START`: 起動時に1回実行するか（既定: `true`）
- `NOTE_TOPICS`: 記事テーマ候補（`,`区切り）
- `NOTE_REFERENCE_FEEDS`: 記事生成時の参考RSS（`,`区切り）
- `NOTE_REFERENCE_MAX_ITEMS`: 参照する記事数（既定: `6`）
- `NOTE_MIN_INTERVAL_HOURS`: 最小実行間隔（既定: `20`）
- `NOTE_MODEL`: 記事生成モデル（既定: `gpt-4.1-mini`）
- `NOTE_OUTPUT_DIR`: 生成物保存先（既定: `output`）
- `NOTE_PUBLISH_COMMAND`: note公開コマンド（任意）
- `NOTE_FALLBACK_URL`: note URLが取得できない場合の予備URL（任意）
- `X_ENABLED`: X投稿のON/OFF（既定: `true`）
- `X_USERNAME`: 投稿URL組み立て用ユーザー名（任意）
- `X_CONSUMER_KEY`: X API Consumer Key
- `X_CONSUMER_SECRET`: X API Consumer Secret
- `X_ACCESS_TOKEN`: X Access Token
- `X_ACCESS_TOKEN_SECRET`: X Access Token Secret
- `CHAT_ENABLED`: 会話機能のON/OFF（既定: `true`）
- `CHAT_PREFIX`: プレフィックス（既定: `news`）
- `CHAT_CHANNEL_ID`: 設定した場合、このチャンネルだけ会話に応答
- `SLACK_CHAT_ENABLED`: Slack会話機能のON/OFF（既定: `true`）
- `SLACK_CHAT_PREFIX`: Slack会話プレフィックス（既定: `news`）
- `SLACK_CHAT_CHANNEL_ID`: 設定した場合、このSlackチャンネルだけ会話に応答
- `SLACK_CAMERA_ENABLED`: Slackカメラ機能のON/OFF（既定: `true`）
- `SLACK_CAMERA_CHANNEL_ID`: 設定した場合、このSlackチャンネルだけカメラ撮影を許可
- `CAMERA_CAPTURE_TIME_MS`: 撮影待機時間ミリ秒（既定: `1200`）
- `CAMERA_OUTPUT_DIR`: 撮影画像の保存先（既定: `output/camera`）
- `PAPER_SEARCH_QUERY`: arXiv検索式（既定: `cat:cs.NI`）
- `PAPER_CRON_SCHEDULE`: ネットワーク論文Botのcron式（既定: `0 9 * * *`）
- `PAPER_RUN_ON_START`: 起動時にネットワーク論文Botを1回流すか
- `PAPER_FETCH_LIMIT`: arXivから取得する最大件数（既定: `25`）
- `PAPER_MAX_POSTS`: 1回でSlackへ投稿する最大論文数（既定: `5`）
- `PAPER_LOOKBACK_HOURS`: 新着とみなす時間幅（既定: `48`）
- `PAPER_POST_EMPTY_UPDATE`: 新着0件でもSlackに投稿するか
- `PAPER_STATE_FILE`: 既読論文IDの保存先（既定: `output/network-paper-bot-state.json`）
- `ARXIV_API_URL`: arXiv APIエンドポイント
- `ARXIV_USER_AGENT`: arXivアクセス時のUser-Agent
- `OLLAMA_BASE_URL`: Ollama APIのURL（既定: `http://127.0.0.1:11434`）
- `OLLAMA_MODEL`: ローカル要約モデル（既定: `qwen2.5:7b`）
- `OLLAMA_KEEP_ALIVE`: モデル常駐時間（既定: `10m`）
- `OLLAMA_TIMEOUT_MS`: Ollamaタイムアウトミリ秒（既定: `120000`）

## 補足

- Discordメッセージ長制限に合わせて自動分割投稿します。
- RSSフィードによっては公開日時が無い記事が含まれる場合があります。
- 会話機能のトリガー:
  - Discord: `@Bot こんにちは` / `news 今日はどんな日？`
  - Slack: `@Bot こんにちは` / `news 今日はどんな日？`
- カメラ機能のトリガー:
  - Slack: `camera` / `カメラ` / `news camera`
