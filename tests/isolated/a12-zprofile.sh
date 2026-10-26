#!/bin/sh
# RG-A12g3: rerunnable test of the uninstall.sh ~/.zprofile rewrite (runs only that block, in a temp HOME).
REPO="$(CDPATH= cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"; RC=0
ok() { echo "PASS A12Z $1"; }; bad() { echo "FAIL A12Z $1"; RC=1; }
sed -n '/^ZPROF="\$HOME\/.zprofile"/,/^fi$/p' "$REPO/uninstall.sh" > "$T/blk.sh"
[ -s "$T/blk.sh" ] && ok "block extracted" || bad "block extracted"
run() { ( HOME="$T/h"; PLAN="$(mktemp "$T/plan.XXXXXX")"; echo "$PLAN" > "$T/planname"; cleanup() { rm -f "$PLAN"; }; trap cleanup EXIT; . "$T/blk.sh" ) ; }
mkdir -p "$T/h"
printf 'a\nexport PATH=x:"$PATH" # tp-browser PATH\nb\n' > "$T/h/.zprofile"; chmod 444 "$T/h/.zprofile"
run >/dev/null 2>&1
[ "$(cat "$T/h/.zprofile")" = "$(printf 'a\nb')" ] && ok "read-only zprofile rewritten" || bad "read-only zprofile rewritten"
[ "$(stat -c %a "$T/h/.zprofile" 2>/dev/null || stat -f %Lp "$T/h/.zprofile")" = "444" ] && ok "read-only mode 0444 kept" || bad "read-only mode 0444 kept"
[ ! -e "$(cat "$T/planname")" ] && ok "PLAN cleanup trap preserved" || bad "PLAN cleanup trap preserved"
[ -z "$(ls -A "$T/h" | grep '\.tp\.')" ] && ok "no temp left" || bad "no temp left"
printf 'export PATH=x:"$PATH" # tp-browser PATH\n' > "$T/h/real"; rm -f "$T/h/.zprofile"; ln -s real "$T/h/.zprofile"
run >/dev/null 2>&1
grep -q 'tp-browser PATH' "$T/h/real" && [ -L "$T/h/.zprofile" ] && ok "symlink left untouched" || bad "symlink left untouched"
rm -f "$T/h/.zprofile"; printf 'export PATH=x:"$PATH" # tp-browser PATH\n' > "$T/h/.zprofile"; chmod 640 "$T/h/.zprofile"
run >/dev/null 2>&1
[ ! -s "$T/h/.zprofile" ] && ok "single-line file emptied" || bad "single-line file emptied"
[ "$(stat -c %a "$T/h/.zprofile" 2>/dev/null || stat -f %Lp "$T/h/.zprofile")" = "640" ] && ok "mode 0640 kept" || bad "mode 0640 kept"
grep -q '\[ -x /usr/local/bin/tp-start \] && \[ "$(readlink /usr/local/bin/tp-start' "$REPO/install.sh" && ok "install requires executable link target" || bad "install requires executable link target"
rm -rf "$T"
echo "A12Z_RC=$RC"; exit $RC
