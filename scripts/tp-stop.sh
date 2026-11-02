#!/bin/sh
# tp-stop.sh — Stop TooPower Browser daemon and agent Chrome profile (macOS & Linux)
set -eu
DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"

# pkill/pgrep -f take an *extended regular expression*, not a literal string.
# $PROFILE_DIR used to be interpolated verbatim, so a HOME such as /tmp/x/a+b or
# /tmp/x/a[b produced a pattern that matched nothing (the agent Chrome stayed
# alive) or made pgrep exit 2 — which all_stopped read as "nothing is running"
# and still printed TP_STOPPED. Escape the regex metacharacters first.
esc_regex() {
  printf '%s' "$1" | sed -e 's/[][\.*^$()+?{}|]/\\&/g'
}

EGO_RE="$(esc_regex 'ego-browserd.js')"
TPD_RE="$(esc_regex 'tp-browserd.js')"
PROFILE_RE="$(esc_regex "$PROFILE_DIR")"

# The daemon is not always on the two default ports: daemon.json carries
# {"port": <n>, "chromePort": <m>} and deployments move the daemon with it (the
# Windows stopper ego-stop.ps1 already honours that file). Flushing only 9772 and
# 9774 left a custom-port daemon un-flushed, so cookies/storage could be lost
# when the SIGTERM below arrives. Parsing is deliberately forgiving: a damaged or
# out-of-range daemon.json must never abort the stop path, so anything unparsable
# falls back to the two defaults.
FLUSH_PORTS="9772 9774"
if [ -r "$DATA_DIR/daemon.json" ]; then
  JSON_PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*0*\([0-9][0-9]*\).*/\1/p' "$DATA_DIR/daemon.json" 2>/dev/null | sed -n '1p')"
  if [ -n "$JSON_PORT" ] && [ "${#JSON_PORT}" -le 5 ] &&
     [ "$JSON_PORT" -ge 1 ] && [ "$JSON_PORT" -le 65535 ] &&
     [ "$JSON_PORT" != "9772" ] && [ "$JSON_PORT" != "9774" ]; then
    FLUSH_PORTS="$FLUSH_PORTS $JSON_PORT"
  fi
fi

# $FLUSH_PORTS is a deliberate space-separated list (unquoted split below).
for flush_port in $FLUSH_PORTS; do
  curl -fsS --max-time 3 "http://127.0.0.1:$flush_port/flush-and-close" >/dev/null 2>&1 || true
done
sleep 1.0

pkill -f "$EGO_RE" 2>/dev/null || true
pkill -f "$TPD_RE" 2>/dev/null || true
pkill -f "$PROFILE_RE" 2>/dev/null || true

# proc_state <ere>:
#   0 = at least one process matched
#   1 = nothing matched
#   2 = pgrep itself failed (bad pattern / usage error / binary missing)
proc_state() {
  rc=0
  pgrep -f "$1" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ge 2 ]; then
    return 2
  fi
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  return 1
}

# any_present:
#   0 = a target is still running
#   1 = no target is running
#   2 = pgrep failed — an exit status >= 2 is NOT evidence that nothing runs.
any_present() {
  for re in "$EGO_RE" "$TPD_RE" "$PROFILE_RE"; do
    st=0
    proc_state "$re" || st=$?
    if [ "$st" -ne 1 ]; then
      return "$st"
    fi
  done
  return 1
}

# Check immediately, then at one-second intervals for up to $1 extra seconds.
# Returns 0 only when every target is really gone (1 = timed out, 2 = pgrep error).
wait_until_stopped() {
  waited=0
  while :; do
    st=0
    any_present || st=$?
    if [ "$st" -eq 1 ]; then
      return 0
    fi
    if [ "$st" -eq 2 ]; then
      echo "tp-stop: pgrep failed; refusing to report success" >&2
      return 2
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
for re in "$EGO_RE" "$TPD_RE" "$PROFILE_RE"; do
  st=0
  proc_state "$re" || st=$?
  if [ "$st" -eq 0 ]; then
    pkill -9 -f "$re" 2>/dev/null || true
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
