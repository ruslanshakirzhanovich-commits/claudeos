#!/usr/bin/env bash
# Send a message to the owner's Telegram chat.
# Usage: scripts/notify.sh "some progress update"
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env in the project root.

set -euo pipefail

MESSAGE="${1:-}"
if [[ -z "$MESSAGE" ]]; then
  echo "Usage: $0 <message>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No .env at $ENV_FILE. Run \`npm run setup\` first." >&2
  exit 1
fi

get_env() {
  # Parse KEY=value from .env, stripping quotes. No pollution of current shell env.
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | head -n1 || true)
  [[ -z "$line" ]] && return 1
  line="${line#${key}=}"
  # Strip surrounding quotes
  line="${line#\"}"; line="${line%\"}"
  line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

TOKEN="$(get_env TELEGRAM_BOT_TOKEN || true)"
CHAT_ID="$(get_env ALLOWED_CHAT_ID || true)"

if [[ -z "$TOKEN" ]]; then
  echo "TELEGRAM_BOT_TOKEN missing in .env" >&2
  exit 1
fi
if [[ -z "$CHAT_ID" ]]; then
  echo "ALLOWED_CHAT_ID missing in .env" >&2
  exit 1
fi

curl -fsS \
  --data-urlencode "chat_id=$CHAT_ID" \
  --data-urlencode "text=$MESSAGE" \
  --data-urlencode "disable_web_page_preview=true" \
  "https://api.telegram.org/bot${TOKEN}/sendMessage" >/dev/null

echo "sent"
