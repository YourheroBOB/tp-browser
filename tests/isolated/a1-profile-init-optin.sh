#!/bin/sh
# RG-A1: profile-init must NOT copy logins/cookies/os_crypt/storage by default; only with --sync-auth / TP_IMPORT_AUTH=1.
# Fully isolated: fake HOME with a fake Chrome profile. No real browser data is read.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SRC="$T/home/.config/google-chrome"; mkdir -p "$SRC/Default/Network" "$SRC/Default/Local Storage/leveldb" "$SRC/Default/IndexedDB/https_example.test_0.indexeddb.leveldb"
printf '{"roots":{"bookmark_bar":{"children":[{"name":"x","url":"https://example.test"}]},"other":{"children":[]}}}' > "$SRC/Default/Bookmarks"
head -c 200000 /dev/zero > "$SRC/Default/Favicons"
echo FAKE > "$SRC/Default/Login Data"; echo FAKE > "$SRC/Default/Web Data"
head -c 40000 /dev/zero > "$SRC/Default/Network/Cookies"
printf '{"os_crypt":{"encrypted_key":"FAKEKEY"}}' > "$SRC/Local State"
echo FAKE > "$SRC/Default/Local Storage/leveldb/000003.log"
echo FAKE > "$SRC/Default/IndexedDB/https_example.test_0.indexeddb.leveldb/000003.log"
fail=0; ok(){ echo "PASS A1 $1"; }; bad(){ echo "FAIL A1 $1"; fail=1; }
chk(){ D="$1"; P="$D/profile-agent/Default"
  [ -f "$P/Bookmarks" ] && ok "$2 bookmarks copied" || bad "$2 bookmarks missing"
  for f in "Login Data" "Web Data" Cookies "Network/Cookies" "Local Storage/leveldb/000003.log" "IndexedDB/https_example.test_0.indexeddb.leveldb"; do
    if [ -e "$P/$f" ]; then [ "$3" = yes ] && ok "$2 $f copied (opt-in)" || bad "$2 $f copied WITHOUT opt-in"
    else [ "$3" = yes ] && { [ "$f" = Cookies ] || [ "$f" = "Network/Cookies" ]; } && continue; [ "$3" = yes ] && bad "$2 $f not copied with opt-in" || ok "$2 $f not copied"; fi
  done
  if grep -q os_crypt "$D/profile-agent/Local State" 2>/dev/null; then [ "$3" = yes ] && ok "$2 os_crypt copied (opt-in)" || bad "$2 os_crypt copied WITHOUT opt-in"; else [ "$3" = yes ] && bad "$2 os_crypt missing" || ok "$2 os_crypt not copied"; fi
}
HOME="$T/home" USERPROFILE="$T/home" LOCALAPPDATA="$T/home/AppData/Local" APPDATA="$T/home/AppData/Roaming" EGO_LINUX_DATA_DIR="$T/d1" node "$ROOT/tools/profile-init.js" >/dev/null; chk "$T/d1" default no
HOME="$T/home" USERPROFILE="$T/home" LOCALAPPDATA="$T/home/AppData/Local" APPDATA="$T/home/AppData/Roaming" EGO_LINUX_DATA_DIR="$T/d2" node "$ROOT/tools/profile-init.js" --sync-auth >/dev/null; chk "$T/d2" sync-auth yes
[ -e "$T/d2/profile-agent/Default/Cookies" ] || [ -e "$T/d2/profile-agent/Default/Network/Cookies" ] && ok "sync-auth cookies copied (opt-in)" || bad "sync-auth cookies not copied"
HOME="$T/home" USERPROFILE="$T/home" LOCALAPPDATA="$T/home/AppData/Local" APPDATA="$T/home/AppData/Roaming" TP_IMPORT_AUTH=1 EGO_LINUX_DATA_DIR="$T/d3" node "$ROOT/tools/profile-init.js" >/dev/null; [ -f "$T/d3/profile-agent/Default/Login Data" ] && ok "TP_IMPORT_AUTH=1 opt-in works" || bad "TP_IMPORT_AUTH=1 ignored"
echo "A1_RC=$fail"; exit $fail
