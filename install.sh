#!/bin/sh
# TooPower Browser (tp-browser / ego-browser) installer for macOS & Linux
# Copies the runtime into ~/.local/share/ego-linux/app and links CLI & service
# commands into ~/.local/bin.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.local/share/ego-linux"
APP_DIR="$DATA_DIR/app"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$DATA_DIR" "$APP_DIR" "$BIN_DIR" "$DATA_DIR/profile-agent" "$DATA_DIR/logs"
chmod 700 "$DATA_DIR" 2>/dev/null || true

# Copy fresh runtime
rm -rf "$APP_DIR/bin" "$APP_DIR/daemon" "$APP_DIR/lib" "$APP_DIR/scripts" "$APP_DIR/tools" "$APP_DIR/tests"
mkdir -p "$APP_DIR/bin" "$APP_DIR/daemon" "$APP_DIR/lib" "$APP_DIR/scripts" "$APP_DIR/tools" "$APP_DIR/tests"
cp "$SRC/bin/"*.js "$APP_DIR/bin/"
cp "$SRC/daemon/"*.js "$APP_DIR/daemon/"
cp "$SRC/lib/"*.js "$APP_DIR/lib/"
cp "$SRC/scripts/"* "$APP_DIR/scripts/" 2>/dev/null || true
cp "$SRC/tools/"*.js "$APP_DIR/tools/" 2>/dev/null || true
cp "$SRC/tests/"*.mjs "$APP_DIR/tests/" 2>/dev/null || true
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

# Only install ego-* compatibility aliases if native macOS EGo Browser is not present (or --replace-ego is passed)
REPLACE_EGO=0
for arg in "$@"; do [ "$arg" = "--replace-ego" ] && REPLACE_EGO=1; done
EXISTING_EGO="$(readlink "$BIN_DIR/ego-browser" 2>/dev/null || true)"
if [ "$REPLACE_EGO" -eq 1 ] || [ ! -e "$BIN_DIR/ego-browser" ] || echo "$EXISTING_EGO" | grep -q "ego-linux"; then
  ln -sf "$APP_DIR/scripts/tp-cli.sh" "$BIN_DIR/ego-browser"
  ln -sf "$APP_DIR/scripts/tp-daemon.sh" "$BIN_DIR/ego-browserd"
  ln -sf "$APP_DIR/scripts/tp-start.sh" "$BIN_DIR/ego-start"
  ln -sf "$APP_DIR/scripts/tp-headed.sh" "$BIN_DIR/ego-headed"
  ln -sf "$APP_DIR/scripts/tp-stop.sh" "$BIN_DIR/ego-stop"
else
  echo "  (preserved existing native $BIN_DIR/ego-browser -> $EXISTING_EGO; use tp-browser or pass --replace-ego)"
fi

echo "=== TooPower Browser (tp-browser) Installed ($(uname -s)) ==="
echo "  CLI:      $BIN_DIR/tp-browser  (alias: ego-browser)"
echo "  Daemon:   $BIN_DIR/tp-browserd (alias: ego-browserd)"
echo "  Service:  tp-start | tp-headed | tp-stop"
echo
echo "Quick Start:"
echo "  1. Start headless background browser:  tp-start"
echo "  2. Or start GUI browser for login:     tp-headed"
echo "  3. Check status:                       tp-browser doctor"
