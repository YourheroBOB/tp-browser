#!/bin/sh
# tp-stop.sh — Stop TooPower Browser daemon and agent Chrome profile (macOS & Linux)
set -eu
DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"
tp_flush_close() {  # RG-A6: authenticated flush; token is piped via stdin, never on argv
  [ -r "$DATA_DIR/token" ] || return 0
  printf 'x-tp-token: %s\n' "$(cat "$DATA_DIR/token")" | curl -fsS --max-time 3 -H @- "http://127.0.0.1:$1/flush-and-close" >/dev/null 2>&1 || true
}
tp_flush_close 9772
tp_flush_close 9774
sleep 1.0
pkill -f "ego-browserd.js" 2>/dev/null || true
pkill -f "tp-browserd.js" 2>/dev/null || true
pkill -f "$PROFILE_DIR" 2>/dev/null || true
echo "TP_STOPPED"
