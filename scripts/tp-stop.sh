#!/bin/sh
# tp-stop.sh — Stop TooPower Browser daemon and agent Chrome profile (macOS & Linux)
set -eu
DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"
# POST /flush-and-close with the daemon token; the token goes to curl via stdin (-K -), never argv.
tp_flush() {
  [ -r "$DATA_DIR/token" ] || return 0
  TP_TOKEN="$(cat "$DATA_DIR/token" 2>/dev/null || true)"
  [ -n "$TP_TOKEN" ] || return 0
  printf 'header = "x-tp-token: %s"\n' "$TP_TOKEN" | curl -fsS --max-time 3 -X POST -K - "http://127.0.0.1:$1/flush-and-close" >/dev/null 2>&1 || true
}
tp_flush 9772
tp_flush 9774
sleep 1.0
pkill -f "ego-browserd.js" 2>/dev/null || true
pkill -f "tp-browserd.js" 2>/dev/null || true
pkill -f "$PROFILE_DIR" 2>/dev/null || true
echo "TP_STOPPED"
