#!/bin/sh
# RG-A7: tp-start/tp-stop on an isolated HOME + private ports must stop only their own processes.
# A decoy process whose command line contains "ego-browserd.js" and the profile path must survive,
# and any TP instance on other ports (e.g. the user's 9772) must be untouched.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DP="${1:-9798}"; CP="${2:-9799}"
T="$(mktemp -d /tmp/tp-a7-XXXXXX)"; RC=0
pass() { echo "PASS A7 $*"; }; fail() { echo "FAIL A7 $*"; RC=1; }
node -e "setTimeout(()=>{},120000)" "$T/.local/share/ego-linux/profile-agent" ego-browserd.js tp-browserd.js & DECOY=$!
MAIN_BEFORE="$(curl -fsS -m 1 http://127.0.0.1:9772/health 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
MAIN_UP=0; curl -fsS -m 1 http://127.0.0.1:9772/health 2>/dev/null | grep -q '"chrome":true' && MAIN_UP=1
cleanup() { kill "$DECOY" 2>/dev/null; HOME="$T" EGO_BROWSERD_PORT="$DP" EGO_CHROME_PORT="$CP" sh "$REPO/scripts/tp-stop.sh" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT INT TERM
out="$(HOME="$T" EGO_BROWSERD_PORT="$DP" EGO_CHROME_PORT="$CP" sh "$REPO/scripts/tp-start.sh" 2>&1)"
case "$out" in *TP_READY*"port=$DP"*) pass "tp-start ready on $DP" ;; *) fail "tp-start: $out" ;; esac
[ -f "$T/.local/share/ego-linux/tp-pids-$DP" ] && pass "pid file written" || fail "no pid file"
dry="$(HOME="$T" EGO_BROWSERD_PORT="$DP" EGO_CHROME_PORT="$CP" TP_DRY_RUN=1 sh "$REPO/scripts/tp-stop.sh" 2>&1 | grep TP_DRY_RUN)"
echo "  $dry"
case " $dry " in *" $DECOY "*) fail "decoy listed in dry run" ;; *) pass "decoy not targeted" ;; esac
CH="$(sed -n 's/^chrome=//p' "$T/.local/share/ego-linux/tp-pids-$DP" 2>/dev/null)"
case " $dry " in *" $CH "*) pass "own chrome ($CH) targeted" ;; *) fail "own chrome not targeted" ;; esac
if [ -n "$MAIN_BEFORE" ]; then case " $dry " in *" $MAIN_BEFORE "*) fail "main TP daemon targeted" ;; *) pass "main TP daemon (9772) not targeted" ;; esac; fi
HOME="$T" EGO_BROWSERD_PORT="$DP" EGO_CHROME_PORT="$CP" sh "$REPO/scripts/tp-stop.sh" >/dev/null 2>&1
sleep 1
curl -fsS -m 1 "http://127.0.0.1:$DP/health" >/dev/null 2>&1 && fail "daemon still up" || pass "isolated daemon stopped"
curl -fsS -m 1 "http://127.0.0.1:$CP/json/version" >/dev/null 2>&1 && fail "chrome still up" || pass "isolated chrome stopped"
kill -0 "$DECOY" 2>/dev/null && pass "decoy survived" || fail "decoy was killed"
if [ -n "$MAIN_BEFORE" ]; then
  MAIN_AFTER="$(curl -fsS -m 1 http://127.0.0.1:9772/health 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
  [ "$MAIN_AFTER" = "$MAIN_BEFORE" ] && pass "main TP untouched (pid $MAIN_BEFORE)" || fail "main TP changed ($MAIN_BEFORE -> $MAIN_AFTER)"
fi
if [ "$MAIN_UP" = 1 ]; then curl -fsS -m 1 http://127.0.0.1:9772/health 2>/dev/null | grep -q '"chrome":true' && pass "main TP on 9772 still healthy" || fail "main TP on 9772 went down"; fi
echo "A7_RC=$RC"; exit $RC
