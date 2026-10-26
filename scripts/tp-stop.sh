#!/bin/sh
# tp-stop.sh — Stop TooPower Browser daemon and agent Chrome profile (macOS & Linux)
set -eu
DATA_DIR="$HOME/.local/share/ego-linux"
PROFILE_DIR="$DATA_DIR/profile-agent"
# RG-A7: stop only THIS instance: PIDs recorded at launch + the pid the daemon on this port reports
# + Chrome processes started with exactly this --user-data-dir. Never pkill by bare name/substring.
tp_cmdline() { if [ -r "/proc/$1/cmdline" ]; then tr '\0' ' ' < "/proc/$1/cmdline"; else ps -ww -p "$1" -o command= 2>/dev/null || true; fi; }
tp_kill_scoped() {
  _port="$1"; _pids=""
  [ -f "$PID_FILE" ] && _pids="$(sed -n 's/^[a-z]*=\([0-9][0-9]*\)$/\1/p' "$PID_FILE" | tr '\n' ' ')"
  _h="$(curl -fsS --max-time 1 "http://127.0.0.1:$_port/health" 2>/dev/null || true)"
  _hp=""
  # only trust the port's pid if that daemon serves OUR data dir (another user/instance may own the port)
  case "$_h" in *"\"dataDir\":\"$DATA_DIR\""*) _hp="$(printf '%s' "$_h" | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p')" ;; esac
  _cp="$(pgrep -f -- "--user-data-dir=$PROFILE_DIR( |$)" 2>/dev/null | tr '\n' ' ')"
  _victims=""
  for _p in $_pids $_hp $_cp; do
    [ "$_p" = "$$" ] && continue
    _c="$(tp_cmdline "$_p")"
    case "$_c" in
      *ego-browserd.js*|*tp-browserd.js*|*"--user-data-dir=$PROFILE_DIR"*) case " $_victims " in *" $_p "*) ;; *) _victims="$_victims $_p" ;; esac ;;
    esac
  done
  [ -n "${TP_DRY_RUN:-}" ] && { echo "TP_DRY_RUN would stop:$_victims"; return 0; }
  for _p in $_victims; do kill "$_p" 2>/dev/null || true; done
  sleep 0.8
  for _p in $_victims; do kill -0 "$_p" 2>/dev/null && kill -9 "$_p" 2>/dev/null || true; done
  rm -f "$PID_FILE"
}
tp_flush_close() {  # RG-A6: authenticated flush; token is piped via stdin, never on argv
  [ -r "$DATA_DIR/token" ] || return 0
  printf 'x-tp-token: %s\n' "$(cat "$DATA_DIR/token")" | curl -fsS --max-time 3 -H @- "http://127.0.0.1:$1/flush-and-close" >/dev/null 2>&1 || true
}
PORTS="${EGO_BROWSERD_PORT:-9772 9774}"
[ -z "${TP_DRY_RUN:-}" ] && { for DP in $PORTS; do tp_flush_close "$DP"; done; sleep 1.0; }
for DP in $PORTS; do PID_FILE="$DATA_DIR/tp-pids-$DP"; tp_kill_scoped "$DP"; done
[ -z "${TP_DRY_RUN:-}" ] && echo "TP_STOPPED"
