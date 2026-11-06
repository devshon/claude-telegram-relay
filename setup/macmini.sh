#!/bin/bash
# One-step setup for the relay on Shon's Mac Mini.
# Run with:
#   bash <(curl -fsSL https://raw.githubusercontent.com/devshon/claude-telegram-relay/local-memory-keychain/setup/macmini.sh)
# Safe to run again; it skips what is already done.

set -euo pipefail

REPO_URL="https://github.com/devshon/claude-telegram-relay.git"
REPO_DIR="$HOME/claude-telegram-relay"
DATA_DIR="/Volumes/AgentData/relay"
WORK_DIR="$DATA_DIR/workspace"

say()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mOK\033[0m  %s\n" "$1"; }
stop() { printf "\n  \033[31mSTOP\033[0m  %s\n\n" "$1"; exit 1; }

say "1/8  Checking the AgentData drive"
[ -d "/Volumes/AgentData" ] || stop "AgentData is not mounted. Plug in the SSD, unlock it, then run this again."
mkdir -p "$WORK_DIR/.claude"
ok "AgentData is mounted"

say "2/8  Checking developer tools (git)"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  stop "A window opened to install developer tools. Click Install, wait for it to finish, then run this same command again."
fi
ok "Developer tools installed"

say "3/8  Installing Bun and Claude Code (skipped if already installed)"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || stop "Bun did not install. Paste this output to Claude."
command -v claude >/dev/null 2>&1 || stop "Claude Code did not install. Paste this output to Claude."
touch "$HOME/.zshrc"
grep -q 'HOME/.local/bin:$HOME/.bun/bin' "$HOME/.zshrc" || \
  echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME/.zshrc"
ok "Bun $(bun --version)"
ok "Claude Code $(claude --version 2>/dev/null | head -1)"

say "4/8  Anthropic API key (stored in your Keychain, not in a file)"
if security find-generic-password -a "$USER" -s anthropic-api-key -w 2>/dev/null | grep -q '^sk-ant-'; then
  ok "Key already in Keychain"
else
  while true; do
    read -r -s -p "  Paste your Anthropic API key (starts with sk-ant-), then press Enter: " KEY; echo
    case "$KEY" in sk-ant-*) break ;; *) echo "  That does not start with sk-ant-. Try again." ;; esac
  done
  security add-generic-password -U -a "$USER" -s anthropic-api-key -w "$KEY"
  unset KEY
  ok "Key saved to Keychain"
fi
grep -q 'anthropic-api-key' "$HOME/.zshrc" || \
  echo 'export ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s anthropic-api-key -w 2>/dev/null)"' >> "$HOME/.zshrc"

say "5/8  Getting the relay code"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --ff-only || true
else
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
if ! grep -q "LocalMemory" src/memory.ts; then
  git fetch origin local-memory-keychain
  git checkout -B local-memory-keychain FETCH_HEAD
fi
bun install >/dev/null
ok "Relay code ready in $REPO_DIR"

say "6/8  Telegram details"
if [ -f .env ] && grep -q '^TELEGRAM_USER_ID=[0-9]' .env && grep -q '^TELEGRAM_BOT_TOKEN=[0-9]' .env; then
  ok ".env already filled in (delete $REPO_DIR/.env and rerun to change it)"
else
  while true; do
    read -r -s -p "  Paste your Telegram bot token from BotFather, then press Enter: " BOT; echo
    case "$BOT" in [0-9]*:*) break ;; *) echo "  Bot tokens look like 123456789:ABC... Try again." ;; esac
  done
  while true; do
    read -r -p "  Type your Telegram user ID (numbers only, from @userinfobot), then press Enter: " TGID
    case "$TGID" in ''|*[!0-9]*) echo "  Numbers only. Try again." ;; *) break ;; esac
  done
  umask 077
  cat > .env <<EOF
TELEGRAM_BOT_TOKEN=$BOT
TELEGRAM_USER_ID=$TGID
USER_NAME=Shon
USER_TIMEZONE=America/New_York
RELAY_DIR=$DATA_DIR
PROJECT_DIR=$WORK_DIR
CLAUDE_PATH=$(command -v claude)
EOF
  chmod 600 .env
  unset BOT
  ok ".env written (readable only by you)"
fi

say "7/8  Blocking Claude from your personal data"
cat > "$WORK_DIR/.claude/settings.json" <<'EOF'
{
  "permissions": {
    "deny": [
      "Read(~/Library/Messages/**)",
      "Read(~/Library/Mail/**)",
      "Read(~/Library/Keychains/**)",
      "Read(~/Library/Mobile Documents/**)",
      "Read(~/Pictures/**)",
      "Read(~/.ssh/**)",
      "Read(~/.zshrc)",
      "Read(~/claude-telegram-relay/.env)",
      "Bash(security:*)",
      "Bash(sudo:*)"
    ]
  }
}
EOF
ok "Deny rules written to $WORK_DIR/.claude/settings.json"

say "8/8  Health check"
bun run setup:verify || true

echo
read -r -p "  Start the bot in the background now, and on every login? (y/n): " GO
if [ "$GO" = "y" ] || [ "$GO" = "Y" ]; then
  bun run setup:launchd -- --service relay
  say "Done. Message your bot on Telegram now. It should answer within a few seconds."
else
  say "Done. To test in the foreground: cd ~/claude-telegram-relay && bun run start"
fi
echo "  Kill switch: cd ~/claude-telegram-relay && bun run setup/configure-launchd.ts --unload"
echo
