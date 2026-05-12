#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO_ROOT"

if [[ ! -f ".env" ]]; then
  echo "[RUN] Missing .env at $REPO_ROOT/.env" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/logs" "$REPO_ROOT/output"

exec node src/network-paper-bot.js
