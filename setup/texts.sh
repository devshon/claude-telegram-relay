#!/bin/bash
# Set up the read-only texts and calls helper for Hal.
#
# Builds one small program (~/hal-texts/hal-texts), the only thing that gets
# Full Disk Access. It runs every 5 minutes and copies the last 3 days of
# texts and calls to $RELAY_DIR/texts.json. Hal reads that file.
#
# Run: bash ~/claude-telegram-relay/setup/texts.sh
# Undo: bash ~/claude-telegram-relay/setup/texts.sh --remove

set -e
REPO="$HOME/claude-telegram-relay"
DEST="$HOME/hal-texts"
BIN="$DEST/hal-texts"
LABEL="com.hal.texts"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RELAY_DIR="$(grep -E '^RELAY_DIR=' "$REPO/.env" 2>/dev/null | cut -d= -f2-)"
RELAY_DIR="${RELAY_DIR:-$HOME/.claude-relay}"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ "$1" = "--remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$RELAY_DIR/texts.json"
  rm -rf "$DEST"
  echo "Removed. Also remove hal-texts from System Settings > Privacy & Security > Full Disk Access."
  exit 0
fi

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"

# Build once. Rebuilding changes the program, and macOS would ask for access again.
if [ ! -x "$BIN" ] || [ "$1" = "--rebuild" ]; then
  echo "Building hal-texts..."
  bun build --compile "$REPO/src/texts-export.ts" --outfile "$BIN" >/dev/null
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$BIN</string><string>$RELAY_DIR</string><string>3</string></array>
    <key>RunAtLoad</key><true/>
    <key>StartInterval</key><integer>300</integer>
    <key>StandardOutPath</key><string>$DEST/hal-texts.log</string>
    <key>StandardErrorPath</key><string>$DEST/hal-texts.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "One manual step: give hal-texts Full Disk Access."
echo "1. System Settings is opening to Full Disk Access."
echo "2. Click +, press Command+Shift+G, type ~/hal-texts and press Return."
echo "3. Choose hal-texts, click Open, and make sure its switch is on."
echo "Do not add Terminal or bun."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open -R "$BIN"
echo ""
read -r -p "Press Return after you have added it..."
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 3
tail -n 1 "$DEST/hal-texts.log"
echo "Done. In Telegram, send /texts or /calls."
