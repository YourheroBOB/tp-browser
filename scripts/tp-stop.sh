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

all_stopped() {
  for pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      return 1
    fi
  done
  return 0
}

# Check immediately, then at one-second intervals for up to $1 extra seconds.
wait_until_stopped() {
  waited=0
  while :; do
    if all_stopped; then
      return 0
    fi
    if [ "$waited" -ge "$1" ]; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Graceful shutdown: up to five seconds before resorting to SIGKILL.
if wait_until_stopped 5; then
  echo "TP_STOPPED"
  exit 0
fi

# Graceful shutdown timed out; force only processes that are still present.
for pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -9 -f "$pattern" 2>/dev/null || true
  fi
done

# SIGKILL only queues the signal: pgrep keeps matching the target until the
# kernel reaps it (and a zombie child of another shell stays visible even
# longer). Checking once right after the kill therefore reported
# TP_STOP_FAILED for a stop that was already in progress. Give the killed
# processes a short, bounded window to disappear before giving up.
if wait_until_stopped 3; then
  echo "TP_STOPPED"
  exit 0
fi

echo "TP_STOP_FAILED"
exit 1
