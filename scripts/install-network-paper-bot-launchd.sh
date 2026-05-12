#!/bin/zsh

set -euo pipefail

LABEL="jp.koyama.network-paper-bot"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
TEMPLATE_PATH="$REPO_ROOT/launchd/network-paper-bot.plist.template"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PATH="$TARGET_DIR/$LABEL.plist"
RUN_SCRIPT="$REPO_ROOT/scripts/run-network-paper-bot.sh"
LOG_DIR="$REPO_ROOT/logs"
STDOUT_LOG="$LOG_DIR/network-paper-bot.log"
STDERR_LOG="$LOG_DIR/network-paper-bot.error.log"
UID_VALUE=$(id -u)

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "[INSTALL] Missing template: $TEMPLATE_PATH" >&2
  exit 1
fi

if [[ ! -x "$RUN_SCRIPT" ]]; then
  echo "[INSTALL] Run script is not executable: $RUN_SCRIPT" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$LOG_DIR"

sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__RUN_SCRIPT__|$RUN_SCRIPT|g" \
  -e "s|__WORKING_DIR__|$REPO_ROOT|g" \
  -e "s|__STDOUT_LOG__|$STDOUT_LOG|g" \
  -e "s|__STDERR_LOG__|$STDERR_LOG|g" \
  "$TEMPLATE_PATH" > "$TARGET_PATH"

launchctl bootout "gui/$UID_VALUE" "$TARGET_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$TARGET_PATH"
launchctl enable "gui/$UID_VALUE/$LABEL"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

echo "[INSTALL] Installed LaunchAgent: $TARGET_PATH"
echo "[INSTALL] Label: $LABEL"
echo "[INSTALL] Stdout log: $STDOUT_LOG"
echo "[INSTALL] Stderr log: $STDERR_LOG"
