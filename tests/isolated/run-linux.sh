#!/bin/sh
# Isolated end-to-end run: throwaway HOME + fresh Chromium profile on private ports.
# Never touches the user's main TP instance (9772/9773) or any other running browser.
# Usage: sh tests/isolated/run-linux.sh [daemonPort] [chromePort]   (defaults 9796 9797)
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DP="${1:-9796}"; CP="${2:-9797}"
T="$(mktemp -d /tmp/tp-iso-XXXXXX)"
CHROME="${TP_CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
cleanup() {
  for p in ${SRV:-} ${DMN:-} ${CHR:-}; do kill "$p" 2>/dev/null || true; done
  sleep 1; for p in ${CHR:-}; do kill -9 "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT INT TERM
for port in "$DP" "$CP" 8899; do
  if (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null || ss -ltn 2>/dev/null | grep -q ":$port "; then echo "PORT_BUSY $port"; exit 3; fi
done
node "$REPO/tests/serve.mjs" > "$T/serve.log" 2>&1 & SRV=$!
"$CHROME" --headless=new --no-first-run --no-default-browser-check --disable-gpu \
  $( [ "$(id -u)" = 0 ] && echo --no-sandbox ) \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CP" --user-data-dir="$T/profile" about:blank > "$T/chrome.log" 2>&1 & CHR=$!
i=0; until curl -fsS -m 1 "http://127.0.0.1:$CP/json/version" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 40 ] && { echo CHROME_TIMEOUT; exit 4; }; sleep 0.25; done
HOME="$T" EGO_BROWSERD_PORT="$DP" EGO_CHROME_PORT="$CP" node --experimental-websocket "$REPO/daemon/ego-browserd.js" > "$T/daemon.log" 2>&1 & DMN=$!
i=0; until curl -fsS -m 1 "http://127.0.0.1:$DP/health" 2>/dev/null | grep -q '"chrome":true'; do i=$((i+1)); [ $i -gt 60 ] && { echo DAEMON_TIMEOUT; cat "$T/daemon.log"; exit 5; }; sleep 0.25; done
echo "ISO_READY home=$T daemon=$DP chrome=$CP"
export HOME="$T" EGO_BROWSERD_PORT="$DP" EGO_CHROME_PORT="$CP" TP_ISO_DAEMON_PORT="$DP"
RC=0
for s in "$REPO"/tests/smoke.ego.js "$REPO"/tests/isolated/*.ego.js; do
  [ -f "$s" ] || continue
  echo "=== $(basename "$s")"
  node "$REPO/bin/ego-browser.js" nodejs < "$s" || RC=1
done
exit $RC
