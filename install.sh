#!/bin/sh
# TooPower Browser (tp-browser / ego-browser) installer for macOS & Linux
# Supports both local checkout (`./install.sh`) and 1-line remote pipe:
#   curl -fsSL https://raw.githubusercontent.com/YourheroBOB/tp-browser/main/install.sh | bash
# Automatically installs CLI, Daemon, Service scripts, AND universal AI Agent SKILL.md!
set -eu

DATA_DIR="$HOME/.local/share/ego-linux"
APP_DIR="$DATA_DIR/app"
BIN_DIR="$HOME/.local/bin"

TMP_CLONE=""
cleanup() {
  if [ -n "$TMP_CLONE" ] && [ -d "$TMP_CLONE" ]; then
    rm -rf "$TMP_CLONE"
  fi
}
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "$0" 2>/dev/null || echo .)" && pwd)"
if [ -f "$SCRIPT_DIR/bin/tp-browser.js" ] && [ -f "$SCRIPT_DIR/daemon/ego-browserd.js" ]; then
  SRC="$SCRIPT_DIR"
else
  echo "=== Downloading TooPower Browser (tp-browser) from GitHub ==="
  TMP_CLONE="$(mktemp -d /tmp/tp-browser-install-XXXXXX)"
  git clone --depth 1 https://github.com/YourheroBOB/tp-browser.git "$TMP_CLONE"
  SRC="$TMP_CLONE"
fi

mkdir -p "$DATA_DIR" "$APP_DIR" "$BIN_DIR" "$DATA_DIR/profile-agent" "$DATA_DIR/logs"
chmod 700 "$DATA_DIR" 2>/dev/null || true

# Copy fresh runtime
rm -rf "$APP_DIR/bin" "$APP_DIR/daemon" "$APP_DIR/lib" "$APP_DIR/scripts" "$APP_DIR/tools" "$APP_DIR/tests" "$APP_DIR/skills" "$APP_DIR/docs"
mkdir -p "$APP_DIR/bin" "$APP_DIR/daemon" "$APP_DIR/lib" "$APP_DIR/scripts" "$APP_DIR/tools" "$APP_DIR/tests" "$APP_DIR/skills/tp-browser" "$APP_DIR/docs"
cp "$SRC/bin/"*.js "$APP_DIR/bin/"
cp "$SRC/daemon/"*.js "$APP_DIR/daemon/"
cp "$SRC/lib/"*.js "$APP_DIR/lib/"
cp "$SRC/scripts/"* "$APP_DIR/scripts/" 2>/dev/null || true
cp "$SRC/tools/"*.js "$APP_DIR/tools/" 2>/dev/null || true
cp "$SRC/tests/"*.mjs "$APP_DIR/tests/" 2>/dev/null || true
cp "$SRC/docs/"* "$APP_DIR/docs/" 2>/dev/null || true
[ -f "$SRC/skills/tp-browser/SKILL.md" ] && cp "$SRC/skills/tp-browser/SKILL.md" "$APP_DIR/skills/tp-browser/SKILL.md"
[ -f "$SRC/package.json" ] && cp "$SRC/package.json" "$APP_DIR/"
[ -f "$SRC/LICENSE" ] && cp "$SRC/LICENSE" "$APP_DIR/"
[ -f "$SRC/NOTICE" ] && cp "$SRC/NOTICE" "$APP_DIR/"

chmod +x "$APP_DIR/bin/ego-browser.js" "$APP_DIR/bin/tp-browser.js" \
         "$APP_DIR/daemon/ego-browserd.js" "$APP_DIR/daemon/tp-browserd.js" \
         "$APP_DIR/scripts/tp-start.sh" "$APP_DIR/scripts/tp-stop.sh"

# Create tp-headed wrapper script
cat > "$APP_DIR/scripts/tp-headed.sh" << 'EOF'
#!/bin/sh
exec "$HOME/.local/share/ego-linux/app/scripts/tp-start.sh" --headed "$@"
EOF
chmod +x "$APP_DIR/scripts/tp-headed.sh"

cat > "$APP_DIR/scripts/tp-cli.sh" << 'EOF'
#!/bin/sh
exec node --experimental-websocket "$HOME/.local/share/ego-linux/app/bin/tp-browser.js" "$@"
EOF
cat > "$APP_DIR/scripts/tp-daemon.sh" << 'EOF'
#!/bin/sh
exec node --experimental-websocket "$HOME/.local/share/ego-linux/app/daemon/tp-browserd.js" "$@"
EOF
chmod +x "$APP_DIR/scripts/tp-cli.sh" "$APP_DIR/scripts/tp-daemon.sh"

ln -sf "$APP_DIR/scripts/tp-cli.sh" "$BIN_DIR/tp-browser"
ln -sf "$APP_DIR/scripts/tp-daemon.sh" "$BIN_DIR/tp-browserd"
ln -sf "$APP_DIR/scripts/tp-start.sh" "$BIN_DIR/tp-start"
ln -sf "$APP_DIR/scripts/tp-headed.sh" "$BIN_DIR/tp-headed"
ln -sf "$APP_DIR/scripts/tp-stop.sh" "$BIN_DIR/tp-stop"

ln -sf "$APP_DIR/scripts/tp-cli.sh" "$BIN_DIR/ego-browser"
ln -sf "$APP_DIR/scripts/tp-daemon.sh" "$BIN_DIR/ego-browserd"
ln -sf "$APP_DIR/scripts/tp-start.sh" "$BIN_DIR/ego-start"
ln -sf "$APP_DIR/scripts/tp-headed.sh" "$BIN_DIR/ego-headed"
ln -sf "$APP_DIR/scripts/tp-stop.sh" "$BIN_DIR/ego-stop"

if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  for cmd in tp-browser tp-browserd tp-start tp-headed tp-stop ego-browser ego-browserd ego-start ego-headed ego-stop; do
    ln -sf "$BIN_DIR/$cmd" "/usr/local/bin/$cmd" 2>/dev/null || true
  done
fi

# Auto-install universal AI Agent Skill (Claude Code, Antigravity, Cursor, Codex, OpenClaw)
if [ -f "$APP_DIR/skills/tp-browser/SKILL.md" ]; then
  for skill_root in "$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.gemini/config/skills"; do
    for skill_name in tp-browser ego-browser; do
      mkdir -p "$skill_root/$skill_name" 2>/dev/null || true
      cp -f "$APP_DIR/skills/tp-browser/SKILL.md" "$skill_root/$skill_name/SKILL.md" 2>/dev/null || true
    done
  done
fi

echo "=== TooPower Browser (tp-browser) Installed ($(uname -s)) ==="
echo "  CLI:         $BIN_DIR/tp-browser  (alias: ego-browser)"
echo "  Daemon:      $BIN_DIR/tp-browserd (alias: ego-browserd)"
echo "  Service:     tp-start | tp-headed | tp-stop (aliases: ego-start | ego-headed | ego-stop)"
echo "  Agent Skill: ~/.claude/skills/tp-browser/SKILL.md (+ ego-browser)"
echo "               ~/.agents/skills/tp-browser/SKILL.md"
echo "               ~/.codex/skills/tp-browser/SKILL.md"
echo
echo "Quick Start:"
echo "  1. Start headless background browser:  tp-start"
echo "  2. Or start GUI browser for login:     tp-headed"
echo "  3. Print Agent Skill instructions:     tp-browser skill"
echo "  4. Check status:                       tp-browser doctor"
