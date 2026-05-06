#!/bin/bash
set -euo pipefail

ADDONS_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="$(dirname "$ADDONS_DIR")"
BOT_DIST="$HOME/.npm-global/lib/node_modules/@grinev/opencode-telegram-bot/dist"
BOT_PKG="$HOME/.npm-global/lib/node_modules/@grinev/opencode-telegram-bot/package.json"

echo "=== OpenCode Telegram Bot - Rolling Summary Install ==="
echo "Addons dir : $ADDONS_DIR"
echo "Bot dist   : $BOT_DIST"
echo ""

# ---- Version check ----
if [ -f "$BOT_PKG" ]; then
  BOT_VERSION=$(node -e "console.log(require('$BOT_PKG').version)" 2>/dev/null || echo "unknown")
  echo "Bot version: $BOT_VERSION"
else
  echo "ERROR: Bot package.json not found at $BOT_PKG"
  exit 1
fi

# ---- Verify dist exists ----
if [ ! -d "$BOT_DIST" ]; then
  echo "ERROR: Bot dist directory not found at $BOT_DIST"
  exit 1
fi

# ---- Copy addon modules into dist ----
echo "Copying addon modules..."
mkdir -p "$BOT_DIST/rolling-summary"
rsync -a "$ADDONS_DIR/rolling-summary/" "$BOT_DIST/rolling-summary/"
# Note: config.js is NOT copied to dist/ — it's only for addon-internal use (CJS).
# The bot has its own config.js (ESM), which must NOT be overwritten.

echo "Modules copied."

# ---- Apply patches ----
echo "Applying patches..."
node "$ADDONS_DIR/patches/apply.js"
PATCH_EXIT=$?

if [ $PATCH_EXIT -ne 0 ]; then
  echo "ERROR: Patch application failed (exit code $PATCH_EXIT)"
  exit 1
fi

echo ""
echo "=== Install complete ==="
echo ""
echo "To restart the bot:"
echo "  launchctl kickstart -k gui/$(id -u)/com.uiye2048.opencode-telegram-bot"
echo ""
echo "To verify:"
echo "  tail -f /tmp/opencode-telegram-bot.log | grep rolling-summary"
echo ""
echo "To uninstall:"
echo "  npm install -g @grinev/opencode-telegram-bot  # reinstalls clean package"
