# Mac mini Deployment Guide

このBotは `MacBook Pro で開発 -> Git で push -> Mac mini で pull -> launchd で常駐` の流れで運用する想定です。

## 1. MacBook Pro 側

この端末では Codex にコードを書かせてから Git に反映します。

```bash
git status
git add src/network-paper-bot.js scripts launchd DEPLOY_MACMINI.md package.json .env.example .gitignore README.md
git commit -m "Add network paper bot deployment files"
git push origin main
```

補足:
- 本番用の `.env` は Git に入れません。
- 投稿済み状態ファイル `output/network-paper-bot-state.json` も Git に入れません。

## 2. Mac mini 初回セットアップ

### 2-1. リポジトリ取得

```bash
git clone <YOUR_PRIVATE_REPO_URL> ~/network-paper-bot
cd ~/network-paper-bot
```

### 2-2. Node 依存インストール

```bash
npm ci
```

### 2-3. Ollama セットアップ

M1 / 16GB ならまずは `qwen2.5:7b` を推奨します。より軽くしたいなら `gemma3:4b` でも構いません。

```bash
ollama pull qwen2.5:7b
ollama list
```

### 2-4. 環境変数設定

```bash
cp .env.example .env
```

最低限この値を埋めてください。

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0123456789

PAPER_SEARCH_QUERY=cat:cs.NI
PAPER_CRON_SCHEDULE=0 9 * * *
PAPER_RUN_ON_START=false
PAPER_POST_EMPTY_UPDATE=true

ARXIV_USER_AGENT=network-paper-bot/1.0 (mailto:your_email@example.com)
ARXIV_MAX_RETRIES=3
ARXIV_RETRY_DELAY_MS=20000
ARXIV_TIMEOUT_MS=60000
OLLAMA_MODEL=qwen2.5:7b
```

### 2-5. 単発動作確認

```bash
npm run paper:network:dry-run
```

問題なければ実投稿も確認します。

```bash
npm run paper:network:once
```

## 3. launchd で常駐

このリポジトリには user-level LaunchAgent を入れるスクリプトを用意しています。

```bash
chmod +x scripts/*.sh
./scripts/install-network-paper-bot-launchd.sh
```

確認コマンド:

```bash
launchctl print "gui/$(id -u)/jp.koyama.network-paper-bot"
tail -f logs/network-paper-bot.log
tail -f logs/network-paper-bot.error.log
```

補足:
- この方式は `~/Library/LaunchAgents` を使います。
- Mac mini を無人運用するなら、自動ログインを有効にしておく方が単純です。
- ログイン前から必ず起動したい場合は、別途 `LaunchDaemon` 化が必要です。

## 4. 更新フロー

MacBook Pro で修正して `git push` したあと、Mac mini ではこれだけで更新できます。

```bash
cd ~/network-paper-bot
./scripts/update-network-paper-bot.sh
```

このスクリプトは次を実行します。
- `git pull --ff-only`
- `npm ci`
- `launchd` の再起動

## 5. よく使う運用コマンド

```bash
# Bot 再起動
./scripts/restart-network-paper-bot-launchd.sh

# 停止
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/jp.koyama.network-paper-bot.plist"

# 再インストール
./scripts/install-network-paper-bot-launchd.sh
```

## 6. トラブルシュート

### Ollama モデルが見つからない

```bash
ollama list
ollama pull qwen2.5:7b
```

### Slack 投稿に失敗する

確認点:
- `SLACK_BOT_TOKEN` が正しいか
- Bot が対象チャンネルに招待されているか
- Slack App に `chat:write` が付いているか

### arXiv 取得はできるか

```bash
npm run paper:network:dry-run
```

`429` が出た場合:
- まず 5分から10分待ってから再実行する
- セットアップ中に `paper:network:once` を短時間で連打しない
- 必要なら `.env` で `ARXIV_MAX_RETRIES=5`、`ARXIV_RETRY_DELAY_MS=30000` のように待機を長くする

`TimeoutError` が出た場合:
- `.env` で `ARXIV_TIMEOUT_MS=120000` に上げて再実行する
- それでも止まるなら回線または arXiv 側の一時不調を疑い、少し待ってから再試行する

### launchd の状態確認

```bash
launchctl print "gui/$(id -u)/jp.koyama.network-paper-bot"
```
