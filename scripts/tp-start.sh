#!/bin/sh
# tp-start.sh — Unified launcher for TooPower Browser (macOS & Linux)
# Supports: --headed, --restart, --alt-port
set -eu

HEADED=0
RESTART=0
ALT_PORT=0
for arg in "$@"; do
  case "$arg" in
    --headed|-Headed|headed) HEADED=1 ;;
    --restart|-Restart|restart) RESTART=1 ;;
    --alt-port|-AltPort) ALT_PORT=1 ;;
  esac
done

DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"
LOGS_DIR="$DATA_DIR/logs"
APP_DIR="$DATA_DIR/app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$APP_DIR/daemon/ego-browserd.js" ]; then
  DAEMON_JS="$APP_DIR/daemon/ego-browserd.js"
else
  DAEMON_JS="$(cd "$SCRIPT_DIR/.." && pwd)/daemon/ego-browserd.js"
fi

mkdir -p "$DATA_DIR" "$PROFILE_DIR" "$LOGS_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

if [ "$ALT_PORT" -eq 1 ]; then
  DAEMON_PORT=9774
  CHROME_PORT=9775
else
  DAEMON_PORT=9772
  CHROME_PORT=9773
fi

# Check if running inside WSL2 and --headed is requested -> delegate to Windows desktop GUI browser!
if [ "$HEADED" -eq 1 ] && [ -f /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
  WIN_PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  WIN_EGO_DIR=""
  for d in /mnt/c/Users/*/.local/share/ego-linux; do
    if [ -f "$d/scripts/ego-start.ps1" ]; then WIN_EGO_DIR="$d"; break; fi
  done
  if [ -x "$WIN_PS" ] && [ -n "$WIN_EGO_DIR" ]; then
    WIN_USER="$(basename "$(dirname "$(dirname "$(dirname "$WIN_EGO_DIR")")")")"
    WIN_SCRIPT="C:\\Users\\$WIN_USER\\.local\\share\\ego-linux\\scripts\\ego-start.ps1"
    if [ "$RESTART" -eq 1 ]; then
      "$WIN_PS" -NoProfile -ExecutionPolicy Bypass -File "$WIN_SCRIPT" -Headed -Restart
    else
      "$WIN_PS" -NoProfile -ExecutionPolicy Bypass -File "$WIN_SCRIPT" -Headed
    fi
    [ -f "$WIN_EGO_DIR/daemon.json" ] && cp -f "$WIN_EGO_DIR/daemon.json" "$DATA_DIR/daemon.json"
    [ -f "$WIN_EGO_DIR/token" ] && cp -f "$WIN_EGO_DIR/token" "$DATA_DIR/token"
    chmod 600 "$DATA_DIR/token" "$DATA_DIR/daemon.json" 2>/dev/null || true
    exit 0
  fi
fi

# Check if already healthy when not restarting
if [ "$RESTART" -eq 0 ]; then
  if curl -fsS --max-time 2 "http://127.0.0.1:$DAEMON_PORT/health" 2>/dev/null | grep -q '"chrome":true'; then
    if [ "$HEADED" -eq 0 ]; then
      echo "TP_READY (port=$DAEMON_PORT, chrome=$CHROME_PORT, os=$(uname -s))"
      exit 0
    else
      # If already running in headed mode (no --headless in process args), preserve open window & tabs!
      if ps ax -o command= 2>/dev/null | grep "$PROFILE_DIR" | grep -v grep | grep -qv -- "--headless"; then
        echo "TP_READY (port=$DAEMON_PORT, chrome=$CHROME_PORT, os=$(uname -s), mode=headed)"
        exit 0
      fi
    fi
  fi
fi

# Flush active cookies & storage and gracefully close Chrome via CDP before stopping
curl -fsS --max-time 3 "http://127.0.0.1:$DAEMON_PORT/flush-and-close" >/dev/null 2>&1 || true
sleep 1.0

# Stop existing TP Browser processes for this profile/daemon
pkill -f "ego-browserd.js" 2>/dev/null || true
pkill -f "tp-browserd.js" 2>/dev/null || true
pkill -f "$PROFILE_DIR" 2>/dev/null || true
sleep 0.6
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonSocket" 2>/dev/null || true
PROFILE_INIT_JS="$(dirname "$DAEMON_JS")/../tools/profile-init.js"
[ -f "$PROFILE_INIT_JS" ] && node "$PROFILE_INIT_JS" 2>/dev/null || true

# Discover Chromium/Chrome/Edge/Brave on macOS (Darwin) or Linux
OS="$(uname -s)"
BROWSER_BIN="${TP_BROWSER_BIN:-}"
if [ -z "$BROWSER_BIN" ] || [ ! -x "$BROWSER_BIN" ]; then
  if [ "$OS" = "Darwin" ]; then
    for c in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
      if [ -x "$c" ]; then BROWSER_BIN="$c"; break; fi
    done
  else
    for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
      if command -v "$c" >/dev/null 2>&1; then BROWSER_BIN="$(command -v "$c")"; break; fi
    done
  fi
fi

if [ -z "$BROWSER_BIN" ] || [ ! -x "$BROWSER_BIN" ]; then
  echo "ERROR: No Chrome/Chromium/Edge/Brave binary found on $OS!" >&2
  exit 1
fi

# Helper to spawn a truly detached background process (setsid via Node.js)
spawn_detached() {
  LOG_FILE="$1"
  shift
  node -e '
    import("node:child_process").then(({ spawn }) => {
      import("node:fs").then(({ openSync }) => {
        const out = openSync(process.argv[1], "a");
        const child = spawn(process.argv[2], process.argv.slice(3), {
          detached: true,
          stdio: ["ignore", out, out]
        });
        child.unref();
      });
    });
  ' "$LOG_FILE" "$@"
}

# Launch daemon FIRST so http://127.0.0.1:$DAEMON_PORT/newtab is ready when headed window opens
if [ "$ALT_PORT" -eq 1 ]; then
  spawn_detached "$LOGS_DIR/daemon.log" node --experimental-websocket "$DAEMON_JS" --alt-port
else
  spawn_detached "$LOGS_DIR/daemon.log" node --experimental-websocket "$DAEMON_JS"
fi
sleep 0.3

# Launch Chrome/Chromium bound strictly to 127.0.0.1
SANDBOX_FLAG=""
if [ "$(id -u 2>/dev/null || echo 1000)" = "0" ]; then
  SANDBOX_FLAG="--no-sandbox"
fi

if [ "$HEADED" -eq 1 ]; then
  # shellcheck disable=SC2086
  spawn_detached "$LOGS_DIR/chrome.log" "$BROWSER_BIN" $SANDBOX_FLAG \
    --no-first-run --no-default-browser-check \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$PROFILE_DIR" \
    --window-size=1440,900 \
    --disable-blink-features=AutomationControlled \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --noerrdialogs --disable-popup-blocking --disable-quic \
    "http://127.0.0.1:$DAEMON_PORT/newtab"
else
  # shellcheck disable=SC2086
  spawn_detached "$LOGS_DIR/chrome.log" "$BROWSER_BIN" --headless=new $SANDBOX_FLAG \
    --no-first-run --no-default-browser-check \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$PROFILE_DIR" \
    --window-size=1440,900 \
    --disable-blink-features=AutomationControlled \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --noerrdialogs --disable-popup-blocking --disable-extensions --disable-quic \
    about:blank
fi

# Wait up to 10s for daemon + chrome attachment
i=0
while [ $i -lt 20 ]; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$DAEMON_PORT/health" 2>/dev/null | grep -q '"chrome":true'; then
    chmod 600 "$DATA_DIR/token" "$DATA_DIR/daemon.json" 2>/dev/null || true
    MODE="headless"
    [ "$HEADED" -eq 1 ] && MODE="headed"
    echo "TP_READY (port=$DAEMON_PORT, chrome=$CHROME_PORT, os=$OS, mode=$MODE)"
    if [ "$HEADED" -eq 1 ]; then
      echo "TP_INDICATORS: [1] Tab Title Prefix: ⚡[TP] | [2] Top 4px Gold-Green Strip | [3] Bottom-Right ⚡ TooPower Capsule"
    fi
    exit 0
  fi
  sleep 0.5
  i=$((i + 1))
done

echo "TP_NOT_READY" >&2
exit 1
