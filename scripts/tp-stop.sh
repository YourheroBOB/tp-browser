#!/bin/sh
# tp-stop.sh — Stop TooPower Browser daemon and agent Chrome profile (macOS & Linux)
set -eu
DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"
PROC_DIR="${TP_PROC_DIR:-/proc}"

# ---------------------------------------------------------------------------
# Capability probe (regression fix)
#
# Old behaviour: on a box without pgrep/pkill this script killed nothing and
# still printed TP_STOPPED — pgrep exits 127 when the binary is missing, and
# all_stopped() read that as "no matching process". Probe up front and fall
# back to ps, then /proc, for both discovery and signalling. When none of the
# three is available we cannot verify that the daemon is gone, so refuse to
# claim success instead of reporting a stop that never happened.
# ---------------------------------------------------------------------------
HAVE_PGREP=0
HAVE_PKILL=0
HAVE_PS=0
HAVE_PROC=0
if command -v pgrep >/dev/null 2>&1; then HAVE_PGREP=1; fi
if command -v pkill >/dev/null 2>&1; then HAVE_PKILL=1; fi
if command -v ps >/dev/null 2>&1; then HAVE_PS=1; fi
if [ -d "$PROC_DIR" ] && [ -r "$PROC_DIR" ]; then HAVE_PROC=1; fi

if [ "$HAVE_PGREP" -eq 0 ] && [ "$HAVE_PS" -eq 0 ] && [ "$HAVE_PROC" -eq 0 ]; then
  echo "tp-stop: cannot inspect processes: no pgrep, no ps, no readable $PROC_DIR" >&2
  echo "TP_STOP_FAILED"
  exit 1
fi

# ---------------------------------------------------------------------------
# flush-and-close: the two well-known ports *and* the port configured in
# daemon.json (parity with scripts/ego-stop.ps1). A daemon started with
# {"port":9780} used to never be flushed at all.
# ---------------------------------------------------------------------------
flush_port() {
  _fp_port="$1"
  case "$_fp_port" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$_fp_port" -lt 1 ] || [ "$_fp_port" -gt 65535 ]; then
    return 0
  fi
  curl -fsS --max-time 3 "http://127.0.0.1:$_fp_port/flush-and-close" >/dev/null 2>&1 || true
}

# Pure-builtin extraction of every "port":<number> value of a small JSON file.
# Deliberately avoids grep/sed/awk/tr: this script must keep working when PATH
# holds nothing but sh, sleep and curl (see tests/fmb_w6_s09_*).
json_port_values() {
  _jp_body=""
  _jp_line=""
  while IFS= read -r _jp_line || [ -n "$_jp_line" ]; do
    _jp_body="$_jp_body$_jp_line"
  done < "$1"
  # Drop spaces (newlines are already gone) so `"port": 9780` and
  # `"port":9780` behave identically.
  while :; do
    case "$_jp_body" in
      *' '*) _jp_body="${_jp_body% *}${_jp_body##* }" ;;
      *) break ;;
    esac
  done
  while :; do
    case "$_jp_body" in
      *'"port":'*) _jp_body="${_jp_body#*'"port":'}" ;;
      *) break ;;
    esac
    _jp_digits="${_jp_body%%[!0-9]*}"
    if [ -n "$_jp_digits" ]; then
      printf '%s\n' "$_jp_digits"
    fi
  done
}

flush_port 9772
flush_port 9774

DAEMON_JSON="$DATA_DIR/daemon.json"
if [ -f "$DAEMON_JSON" ] && [ -r "$DAEMON_JSON" ]; then
  for _fp_p in $(json_port_values "$DAEMON_JSON"); do
    flush_port "$_fp_p"
  done
fi

sleep 1

# ---------------------------------------------------------------------------
# Process discovery / signalling that degrades gracefully:
# pgrep+pkill -> pkill only -> ps -> /proc -> kill builtin.
# ---------------------------------------------------------------------------
matching_pids() {
  _mp_pattern="$1"
  if [ "$HAVE_PGREP" -eq 1 ]; then
    pgrep -f "$_mp_pattern" 2>/dev/null || true
    return 0
  fi
  if [ "$HAVE_PS" -eq 1 ]; then
    ps -eo pid=,args= 2>/dev/null | while read -r _mp_pid _mp_args; do
      case "$_mp_args" in
        *"$_mp_pattern"*) printf '%s\n' "$_mp_pid" ;;
      esac
    done
    return 0
  fi
  for _mp_entry in "$PROC_DIR"/[0-9]*; do
    [ -r "$_mp_entry/cmdline" ] || continue
    _mp_pid="${_mp_entry##*/}"
    case "$_mp_pid" in
      *[!0-9]*) continue ;;
    esac
    _mp_cmd=""
    if IFS= read -r _mp_cmd < "$_mp_entry/cmdline" 2>/dev/null; then
      :
    fi
    case "$_mp_cmd" in
      *"$_mp_pattern"*) printf '%s\n' "$_mp_pid" ;;
    esac
  done
  return 0
}

signal_pattern() {
  _sp_sig="$1"
  _sp_pattern="$2"
  if [ "$HAVE_PKILL" -eq 1 ]; then
    pkill -"$_sp_sig" -f "$_sp_pattern" 2>/dev/null || true
    return 0
  fi
  for _sp_pid in $(matching_pids "$_sp_pattern"); do
    case "$_sp_pid" in
      ''|*[!0-9]*) continue ;;
    esac
    kill -"$_sp_sig" "$_sp_pid" 2>/dev/null || true
  done
  return 0
}

all_stopped() {
  for _as_pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
    if [ -n "$(matching_pids "$_as_pattern")" ]; then
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
for pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
  signal_pattern TERM "$pattern"
done

if wait_until_stopped 5; then
  echo "TP_STOPPED"
  exit 0
fi

# Graceful shutdown timed out; force only processes that are still present.
for pattern in "ego-browserd.js" "tp-browserd.js" "$PROFILE_DIR"; do
  signal_pattern 9 "$pattern"
done

# SIGKILL only queues the signal: the kernel keeps the target visible until it
# is reaped (and a zombie child of another shell stays visible even longer).
# Checking once right after the kill therefore reported TP_STOP_FAILED for a
# stop that was already in progress. Give the killed processes a short,
# bounded window to disappear before giving up.
if wait_until_stopped 3; then
  echo "TP_STOPPED"
  exit 0
fi

echo "TP_STOP_FAILED"
exit 1
