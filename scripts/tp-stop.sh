#!/bin/sh
# tp-stop.sh — Stop TooPower Browser daemon and agent Chrome profile (macOS & Linux)
set -eu
DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"
curl -fsS --max-time 3 "http://127.0.0.1:9772/flush-and-close" >/dev/null 2>&1 || true
curl -fsS --max-time 3 "http://127.0.0.1:9774/flush-and-close" >/dev/null 2>&1 || true
sleep 1.0
pkill -f "ego-browserd.js" 2>/dev/null || true
pkill -f "tp-browserd.js" 2>/dev/null || true
pkill -f "$PROFILE_DIR" 2>/dev/null || true
echo "TP_STOPPED"
