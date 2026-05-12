#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO_ROOT"

git pull --ff-only
npm ci
"$REPO_ROOT/scripts/restart-network-paper-bot-launchd.sh"

echo "[UPDATE] Repository updated and bot restarted."
