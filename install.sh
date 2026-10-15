#!/bin/sh
# ego-linux install: copies the app into ~/.local/share/ego-linux/app and
# links binaries into ~/.local/bin. Does NOT launch Chrome or the daemon —
# see README for systemd units / manual start commands.
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/.local/share/ego-linux/app"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$APP_DIR" "$BIN_DIR" "$HOME/.local/share/ego-linux/profile-agent"

# copy fresh
rm -rf "$APP_DIR/bin" "$APP_DIR/daemon" "$APP_DIR/lib"
mkdir -p "$APP_DIR/bin" "$APP_DIR/daemon" "$APP_DIR/lib"
cp "$SRC/bin/ego-browser.js" "$APP_DIR/bin/"
cp "$SRC/daemon/"*.js "$APP_DIR/daemon/"
cp "$SRC/lib/"*.js "$APP_DIR/lib/"
[ -f "$SRC/package.json" ] && cp "$SRC/package.json" "$APP_DIR/"

chmod +x "$APP_DIR/bin/ego-browser.js" "$APP_DIR/daemon/ego-browserd.js"

ln -sf "$APP_DIR/bin/ego-browser.js" "$BIN_DIR/ego-browser"
ln -sf "$APP_DIR/daemon/ego-browserd.js" "$BIN_DIR/ego-browserd"

echo "installed:"
echo "  $BIN_DIR/ego-browser"
echo "  $BIN_DIR/ego-browserd"
echo
echo "next steps:"
echo "  1. start headless chromium (systemd unit in scripts/, or):"
echo "     chromium --headless=new --no-first-run --no-default-browser-check \\"
echo "       --remote-debugging-port=9773 \\"
echo "       --user-data-dir=\$HOME/.local/share/ego-linux/profile-agent \\"
echo "       --window-size=1440,900 about:blank &"
echo "  2. start the daemon:  ego-browserd   (or: systemctl --user start ego-browserd)"
echo "  3. check:             ego-browser doctor"
