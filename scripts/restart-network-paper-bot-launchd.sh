#!/bin/zsh

set -euo pipefail

LABEL="jp.koyama.network-paper-bot"
UID_VALUE=$(id -u)

launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

echo "[RESTART] Restarted $LABEL"
