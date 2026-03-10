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

## 補足

- Discordメッセージ長制限に合わせて自動分割投稿します。
- RSSフィードによっては公開日時が無い記事が含まれる場合があります。
- 会話機能のトリガー:
  - Discord: `@Bot こんにちは` / `news 今日はどんな日？`
  - Slack: `@Bot こんにちは` / `news 今日はどんな日？`
- カメラ機能のトリガー:
  - Slack: `camera` / `カメラ` / `news camera`
