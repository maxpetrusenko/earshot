#!/bin/sh
# Install the earshot plugin into Hermes and enable it. Idempotent. Backs up a changed copy.
# Usage: integrations/hermes/install.sh [--restart]   (restart = `hermes gateway restart`, graceful)
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)/earshot"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
DEST="$HOME_DIR/plugins/earshot"
mkdir -p "$HOME_DIR/plugins"
if [ -d "$DEST" ] && ! diff -rq "$SRC" "$DEST" >/dev/null 2>&1; then
  mv "$DEST" "$DEST.earshot-bak-$(date +%Y%m%d%H%M%S)"
fi
[ -d "$DEST" ] || cp -R "$SRC" "$DEST"
find "$DEST" -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
hermes plugins enable earshot
if [ "${1:-}" = "--restart" ]; then hermes gateway restart; fi
echo "earshot plugin installed at $DEST"
