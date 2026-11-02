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
# Test hooks (behaviour is byte-identical when unset): TP_START_PROC_VERSION overrides
# the kernel-version source file, TP_START_WIN_PS the Windows powershell.exe path and
# TP_START_WIN_USERS the Windows Users root, so the delegation branch can be exercised
# without a real /mnt/c mount.
PROC_VERSION_SRC="${TP_START_PROC_VERSION:-/proc/version}"
WIN_PS="${TP_START_WIN_PS:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
WIN_USERS_ROOT="${TP_START_WIN_USERS:-/mnt/c/Users}"
if [ "$HEADED" -eq 1 ] && [ -f "$PROC_VERSION_SRC" ] && grep -qi microsoft "$PROC_VERSION_SRC" 2>/dev/null; then
  WIN_EGO_DIR=""
  for d in "$WIN_USERS_ROOT"/*/.local/share/ego-linux; do
    if [ -f "$d/scripts/ego-start.ps1" ]; then WIN_EGO_DIR="$d"; break; fi
  done
  if [ -x "$WIN_PS" ] && [ -n "$WIN_EGO_DIR" ]; then
    WIN_USER="$(basename "$(dirname "$(dirname "$(dirname "$WIN_EGO_DIR")")")")"
    WIN_SCRIPT="C:\\Users\\$WIN_USER\\.local\\share\\ego-linux\\scripts\\ego-start.ps1"
    # Forward every mode flag the user asked for. Dropping -AltPort here made the
    # Windows daemon come up on 9772/9773 (or its own 9773-derived group) instead of
    # the requested 9774/9775 — and that wrong daemon.json was then copied back to
    # Linux below.
    set -- -NoProfile -ExecutionPolicy Bypass -File "$WIN_SCRIPT" -Headed
    if [ "$RESTART" -eq 1 ]; then
      set -- "$@" -Restart
    fi
    if [ "$ALT_PORT" -eq 1 ]; then
      set -- "$@" -AltPort
    fi
    "$WIN_PS" "$@"
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
      # Already headed only when some process is bound to this profile and none
      # of those processes carries --headless. Preserve that window and its tabs.
      # grep -F: PROFILE_DIR contains ".local"; as a regex the "." matches any
      # character and can latch onto an unrelated process.
      # `grep -qv -- --headless` is the wrong test: Chrome gpu/zygote/utility
      # children keep --user-data-dir but drop --headless, so a headless browser
      # still has a matching line and the headless→headed switch never ran.
      _profile_procs="$(ps ax -o command= 2>/dev/null | grep -F -- "$PROFILE_DIR" | grep -v grep || true)"
      if [ -n "$_profile_procs" ] && ! printf '%s\n' "$_profile_procs" | grep -q -- "--headless"; then
        echo "TP_READY (port=$DAEMON_PORT, chrome=$CHROME_PORT, os=$(uname -s), mode=headed)"
        exit 0
      fi
    fi
  fi
fi

# Discover Chromium/Chrome/Edge/Brave before touching any existing processes.
OS="$(uname -s)"
BROWSER_BIN="${TP_BROWSER_BIN:-}"
if [ -n "$BROWSER_BIN" ]; then
  # TP_BROWSER_BIN is an explicit user override: never silently fall back to a
  # different browser. Reject a bad path *before* flushing or killing anything,
  # so the currently running daemon/profile is left exactly as it was.
  if [ ! -f "$BROWSER_BIN" ] || [ ! -x "$BROWSER_BIN" ]; then
    echo "ERROR: TP_BROWSER_BIN is set to '$BROWSER_BIN' but that path is not an executable file." >&2
    echo "       Refusing to auto-detect another browser. Fix TP_BROWSER_BIN, or unset it to let tp-start.sh probe." >&2
    echo "       Nothing was flushed, stopped or launched." >&2
    exit 1
  fi
else
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

# Only flush and stop existing instances after a browser executable is available.
#
# The sweep below (pkill -f ego-browserd.js / tp-browserd.js / $PROFILE_DIR) does
# not target "the daemon on $DAEMON_PORT" — it matches *every* TP daemon and
# agent Chrome on this machine, including the other port group (9772 vs 9774)
# and any extra port recorded in daemon.json. Flushing only $DAEMON_PORT
# therefore terminated the other group's Chrome before it could persist cookies
# and storage (silent login-state loss). ego-start.ps1 already flushes every
# port; mirror it here: flush the port we are about to start, then the fixed
# dual-port set, then the daemon.json port — skipping duplicates and any value
# that is not a usable TCP port.
FLUSH_PORTS="$DAEMON_PORT 9772 9774"
if [ -f "$DATA_DIR/daemon.json" ]; then
  CFG_FLUSH_PORT="$(tr -d '\r' < "$DATA_DIR/daemon.json" 2>/dev/null \
    | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    | head -n 1 || true)"
  if [ -n "${CFG_FLUSH_PORT:-}" ]; then
    FLUSH_PORTS="$FLUSH_PORTS $CFG_FLUSH_PORT"
  fi
fi

FLUSH_SEEN=" "
for _flush_port in $FLUSH_PORTS; do
  case "$_flush_port" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$_flush_port" -lt 1 ] || [ "$_flush_port" -gt 65535 ]; then
    continue
  fi
  case "$FLUSH_SEEN" in
    *" $_flush_port "*) continue ;;
  esac
  FLUSH_SEEN="$FLUSH_SEEN$_flush_port "
  curl -fsS --max-time 3 "http://127.0.0.1:$_flush_port/flush-and-close" >/dev/null 2>&1 || true
done
sleep 1.0

# Stop existing TP Browser processes for this profile/daemon.
# pkill only *sends* SIGTERM and returns immediately: it does not wait for the
# process to exit. Sleeping a fixed 0.6s and then deleting the profile's
# Singleton* lock files is a race — a still-shutting-down daemon/Chrome keeps the
# profile locked, so the freshly spawned Chrome bails out with "the profile
# appears to be in use", and tp-start finishes with TP_NOT_READY while leaving a
# stray daemon behind. Poll until the processes are really gone and escalate to
# SIGKILL, mirroring the hardened shutdown loop already used by tp-stop.sh.
tp_procs_alive() {
  for pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

pkill -f "ego-browserd.js" 2>/dev/null || true
pkill -f "tp-browserd.js" 2>/dev/null || true
pkill -f "$PROFILE_DIR" 2>/dev/null || true
# Grace period for SIGTERM; also the exact old behaviour when pgrep is missing.
sleep 0.6

# Wait at most 5 rounds for a graceful exit, then force only what is still there.
STOP_WAITED=0
while tp_procs_alive; do
  if [ "$STOP_WAITED" -ge 5 ]; then
    for pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
      if pgrep -f "$pattern" >/dev/null 2>&1; then
        pkill -9 -f "$pattern" 2>/dev/null || true
      fi
    done
    sleep 0.5
    break
  fi
  sleep 0.6
  STOP_WAITED=$((STOP_WAITED + 1))
done

rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonSocket" 2>/dev/null || true
PROFILE_INIT_JS="$(dirname "$DAEMON_JS")/../tools/profile-init.js"
[ -f "$PROFILE_INIT_JS" ] && node "$PROFILE_INIT_JS" 2>/dev/null || true

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
