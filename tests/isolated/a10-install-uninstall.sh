#!/bin/sh
# RG-A10: install.sh then uninstall.sh in a throwaway HOME.
# Does not start a browser. Does not read or write the real HOME.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ORIG_HOME="${HOME:-}"
HOME="$(mktemp -d /tmp/tp-a10-XXXXXX)"
export HOME
RC=0
pass() { printf 'PASS A10 %s\n' "$*"; }
fail() { printf 'FAIL A10 %s\n' "$*"; RC=1; }

case "$HOME" in
  /tmp/tp-a10-*) ;;
  *) printf 'FAIL A10 bad throwaway HOME\n'; exit 9 ;;
esac
if [ -n "$ORIG_HOME" ] && [ "$HOME" = "$ORIG_HOME" ]; then
  printf 'FAIL A10 throwaway HOME collided with the real HOME\n'
  exit 9
fi

cleanup() {
  case "${HOME:-}" in
    /tmp/tp-a10-*) rm -rf "$HOME" ;;
  esac
}
trap cleanup EXIT INT TERM

PORT=45910
while [ "$PORT" -lt 45940 ]; do
  if ! ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    break
  fi
  PORT=$((PORT + 1))
done
export EGO_BROWSERD_PORT="$PORT"
unset TP_DRY_RUN || true

SYSBIN_BEFORE="$(ls -la /usr/local/bin 2>/dev/null | cksum || true)"

if sh "$REPO/uninstall.sh" --help >/dev/null; then
  pass "uninstall --help exits 0"
else
  fail "uninstall --help failed"
fi
if sh "$REPO/uninstall.sh" --no-such-option >/dev/null 2>&1; then
  fail "unknown option was accepted"
else
  pass "unknown option rejected"
fi

for f in \
  bin/tp-browser.js bin/ego-browser.js \
  daemon/ego-browserd.js daemon/tp-browserd.js \
  lib/sdk.js scripts/tp-start.sh scripts/tp-stop.sh \
  skills/tp-browser/SKILL.md package.json LICENSE NOTICE
do
  if [ -f "$REPO/$f" ]; then
    pass "source exists $f"
  else
    fail "missing source $f"
  fi
done
if [ -f "$REPO/scripts/tp-daemon.sh" ]; then
  fail "scripts/tp-daemon.sh exists in the source tree (install should generate it)"
else
  pass "scripts/tp-daemon.sh is not a source file"
fi

if grep -E -n 'pkill|killall|taskkill' "$REPO/uninstall.sh" "$REPO/uninstall.ps1" "$REPO/uninstall.cmd"; then
  fail "uninstall script contains a forbidden process kill"
else
  pass "uninstall scripts do not name-kill processes"
fi

mkdir -p "$HOME"
printf '%s\n' "=== install.sh ==="
if sh "$REPO/install.sh" >"$HOME/install.out" 2>"$HOME/install.err"; then
  pass "install.sh exit 0"
else
  fail "install.sh failed"
  cat "$HOME/install.err" >&2 || true
fi
cat "$HOME/install.out"
if grep -q 'Downloading TooPower' "$HOME/install.out" "$HOME/install.err"; then
  fail "install.sh tried to clone from the network"
else
  pass "install.sh stayed offline"
fi
if grep -q 'TP_READY' "$HOME/install.out" "$HOME/install.err"; then
  fail "install.sh started the browser"
else
  pass "install.sh did not print TP_READY"
fi

DATA="$HOME/.local/share/ego-linux"
APP="$DATA/app"
BIN="$HOME/.local/bin"

check_file() {
  if [ -f "$1" ]; then
    pass "installed $2"
  else
    fail "missing $2 ($1)"
  fi
}
check_file "$APP/bin/tp-browser.js" "app/bin/tp-browser.js"
check_file "$APP/bin/ego-browser.js" "app/bin/ego-browser.js"
check_file "$APP/daemon/ego-browserd.js" "app/daemon/ego-browserd.js"
check_file "$APP/daemon/tp-browserd.js" "app/daemon/tp-browserd.js"
check_file "$APP/lib/sdk.js" "app/lib/sdk.js"
check_file "$APP/scripts/tp-start.sh" "app/scripts/tp-start.sh"
check_file "$APP/scripts/tp-stop.sh" "app/scripts/tp-stop.sh"
check_file "$APP/scripts/tp-cli.sh" "app/scripts/tp-cli.sh"
check_file "$APP/scripts/tp-daemon.sh" "app/scripts/tp-daemon.sh"
check_file "$APP/scripts/tp-headed.sh" "app/scripts/tp-headed.sh"
check_file "$APP/tools/profile-init.js" "app/tools/profile-init.js"
check_file "$APP/tests/serve.mjs" "app/tests/serve.mjs"
check_file "$APP/skills/tp-browser/SKILL.md" "app/skills/tp-browser/SKILL.md"
check_file "$APP/skills/tp-browser/references/api.md" "app/skills/tp-browser/references/api.md"
check_file "$HOME/.claude/skills/tp-browser/references/api.md" "claude skill references/api.md (RG-A9b)"
check_file "$APP/docs/index.html" "app/docs/index.html"
check_file "$APP/package.json" "app/package.json"
check_file "$APP/LICENSE" "app/LICENSE"
check_file "$APP/NOTICE" "app/NOTICE"
if [ -d "$DATA/profile-agent" ] && [ -d "$DATA/logs" ]; then
  pass "data directories created"
else
  fail "profile-agent or logs missing after install"
fi

if grep -q 'daemon/tp-browserd.js' "$APP/scripts/tp-daemon.sh" && [ -f "$APP/daemon/tp-browserd.js" ]; then
  pass "generated tp-daemon.sh points at an existing daemon file"
else
  fail "tp-daemon.sh wrapper target is wrong"
fi

for cmd in tp-browser tp-browserd tp-start tp-headed tp-stop ego-browser ego-browserd ego-start ego-headed ego-stop; do
  link="$BIN/$cmd"
  if [ -L "$link" ]; then
    target="$(readlink "$link")"
    case "$target" in
      "$APP"/*) pass "symlink $cmd" ;;
      *) fail "symlink $cmd points outside the app ($target)" ;;
    esac
  else
    fail "symlink missing $cmd"
  fi
done

for root in \
  "$HOME/.claude/skills" \
  "$HOME/.agents/skills" \
  "$HOME/.codex/skills" \
  "$HOME/.gemini/config/skills"
do
  for name in tp-browser ego-browser; do
    if [ -f "$root/$name/SKILL.md" ]; then
      pass "skill $root/$name"
    else
      fail "skill missing $root/$name"
    fi
  done
done

# User data and decoys. Uninstall must not treat these as install files.
printf 'a10-keep\n' > "$DATA/token"
printf 'a10-log\n' > "$DATA/logs/a10.log"
printf 'a10-profile\n' > "$DATA/profile-agent/marker.txt"
printf 'keep-me\n' > "$BIN/unrelated-tool"
ln -sf /bin/true "$BIN/ego-headed"
mkdir -p "$HOME/.claude/skills/other" "$HOME/.agents/skills/tp-browser"
printf 'other-skill\n' > "$HOME/.claude/skills/other/SKILL.md"
printf 'extra\n' > "$HOME/.agents/skills/tp-browser/extra.txt"

printf '%s\n' "=== uninstall.sh --dry-run ==="
DRY_OUT="$(sh "$REPO/uninstall.sh" --dry-run 2>&1)" || fail "dry-run exit"
printf '%s\n' "$DRY_OUT"
printf '%s\n' "$DRY_OUT" | grep -q 'TP_DRY_RUN' && pass "dry-run called tp-stop in dry-run mode" || fail "dry-run did not call tp-stop"
printf '%s\n' "$DRY_OUT" | grep -q "would remove: $APP/bin" && pass "dry-run lists app/bin" || fail "dry-run missed app/bin"
printf '%s\n' "$DRY_OUT" | grep -q "would remove: $APP/scripts" && pass "dry-run lists app/scripts" || fail "dry-run missed app/scripts"
printf '%s\n' "$DRY_OUT" | grep -q "would remove: $BIN/tp-browser" && pass "dry-run lists tp-browser symlink" || fail "dry-run missed symlink"
if printf '%s\n' "$DRY_OUT" | grep -q "would remove: $BIN/ego-headed"; then
  fail "dry-run would remove a symlink that is not ours"
else
  pass "dry-run keeps a foreign ego-headed symlink"
fi
if printf '%s\n' "$DRY_OUT" | grep -q "would remove: $DATA/token"; then
  fail "dry-run without --purge lists token"
else
  pass "dry-run without --purge keeps token off the list"
fi
if [ -f "$APP/bin/tp-browser.js" ] && [ -f "$DATA/token" ] && [ -L "$BIN/tp-browser" ]; then
  pass "dry-run deleted nothing"
else
  fail "dry-run deleted a file"
fi

printf '%s\n' "=== uninstall.sh --purge --dry-run ==="
PURGE_DRY="$(sh "$REPO/uninstall.sh" --purge --dry-run 2>&1)" || fail "purge dry-run exit"
printf '%s\n' "$PURGE_DRY" | grep -q "would remove: $DATA/token" && pass "purge dry-run lists token" || fail "purge dry-run missed token"
printf '%s\n' "$PURGE_DRY" | grep -q "would remove: $DATA/profile-agent" && pass "purge dry-run lists profile-agent" || fail "purge dry-run missed profile-agent"
printf '%s\n' "$PURGE_DRY" | grep -q "would remove: $DATA/logs" && pass "purge dry-run lists logs" || fail "purge dry-run missed logs"
if [ -f "$DATA/token" ] && [ -f "$DATA/profile-agent/marker.txt" ] && [ -f "$DATA/logs/a10.log" ]; then
  pass "purge dry-run kept user data"
else
  fail "purge dry-run removed user data"
fi

printf '%s\n' "=== uninstall.sh ==="
UN_OUT="$(sh "$REPO/uninstall.sh" 2>&1)" || fail "uninstall exit"
printf '%s\n' "$UN_OUT"
printf '%s\n' "$UN_OUT" | grep -q 'TP_STOPPED' && pass "uninstall called tp-stop" || fail "uninstall did not report TP_STOPPED"

gone() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    fail "still present: $2"
  else
    pass "removed $2"
  fi
}
gone "$APP" "app directory"
gone "$BIN/tp-browser" "tp-browser symlink"
gone "$BIN/tp-browserd" "tp-browserd symlink"
gone "$BIN/tp-start" "tp-start symlink"
gone "$BIN/tp-stop" "tp-stop symlink"
gone "$BIN/ego-browser" "ego-browser symlink"
gone "$BIN/ego-browserd" "ego-browserd symlink"
gone "$BIN/ego-start" "ego-start symlink"
gone "$BIN/ego-stop" "ego-stop symlink"
gone "$BIN/tp-headed" "tp-headed symlink"
gone "$HOME/.claude/skills/tp-browser" "claude tp-browser skill"
gone "$HOME/.claude/skills/ego-browser" "claude ego-browser skill"
gone "$HOME/.codex" "codex skill tree"
gone "$HOME/.gemini" "gemini skill tree"
gone "$HOME/.agents/skills/ego-browser" "agents ego-browser skill"
if [ -L "$BIN/ego-headed" ] && [ "$(readlink "$BIN/ego-headed")" = "/bin/true" ]; then
  pass "foreign ego-headed symlink kept"
else
  fail "foreign ego-headed symlink was removed or retargeted"
fi
if [ -f "$BIN/unrelated-tool" ]; then
  pass "unrelated bin file kept"
else
  fail "unrelated bin file removed"
fi
if [ -f "$HOME/.claude/skills/other/SKILL.md" ]; then
  pass "unrelated skill kept"
else
  fail "unrelated skill removed"
fi
if [ -f "$HOME/.agents/skills/tp-browser/extra.txt" ] && [ ! -f "$HOME/.agents/skills/tp-browser/SKILL.md" ] && [ ! -f "$HOME/.agents/skills/tp-browser/references/api.md" ]; then
  pass "skill dir with extra files lost only SKILL.md"
else
  fail "skill dir with extra files was not trimmed correctly"
fi
if [ -f "$DATA/token" ] && [ -f "$DATA/logs/a10.log" ] && [ -f "$DATA/profile-agent/marker.txt" ] && [ -d "$DATA" ]; then
  pass "user data kept before --purge"
else
  fail "user data missing before --purge"
fi

printf '%s\n' "=== uninstall.sh --purge ==="
PURGE_OUT="$(sh "$REPO/uninstall.sh" --purge 2>&1)" || fail "purge exit"
printf '%s\n' "$PURGE_OUT"
if [ ! -e "$DATA" ]; then
  pass "purge removed the data directory"
else
  fail "data directory still present after purge"
fi
if [ -f "$BIN/unrelated-tool" ] && [ -f "$HOME/.claude/skills/other/SKILL.md" ]; then
  pass "purge left unrelated files"
else
  fail "purge removed unrelated files"
fi

if sh "$REPO/uninstall.sh" --purge >/dev/null 2>&1; then
  pass "second purge is a no-op success"
else
  fail "second purge failed"
fi

SYSBIN_AFTER="$(ls -la /usr/local/bin 2>/dev/null | cksum || true)"
if [ "$SYSBIN_BEFORE" = "$SYSBIN_AFTER" ]; then
  pass "/usr/local/bin unchanged"
else
  fail "/usr/local/bin changed"
fi

leaks=""
for cmdf in /proc/[0-9]*/cmdline; do
  [ -r "$cmdf" ] || continue
  line="$(tr '\0' ' ' < "$cmdf" 2>/dev/null || true)"
  case "$line" in
    *"$HOME/.local/share/ego-linux"*|*"$DATA/profile-agent"*) leaks="$leaks $line" ;;
  esac
done
if [ -z "$leaks" ]; then
  pass "no browser or daemon process left for this HOME"
else
  fail "leftover process: $leaks"
fi

printf 'A10_RC=%s\n' "$RC"
exit "$RC"
