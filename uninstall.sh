#!/bin/sh
# Uninstall TP Linux (macOS and Linux).
# Removes what install.sh created: app files under ~/.local/share/ego-linux/app,
# symlinks in ~/.local/bin (and /usr/local/bin when they point at this install),
# and the agent skill copies. profile-agent, token, and logs stay unless --purge.
# Stopping always goes through scripts/tp-stop.sh, which stops only this instance.
#
#   uninstall.sh [--dry-run] [--purge]
set -eu

DRY=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --purge) PURGE=1 ;;
    -h|--help)
      printf '%s\n' "Usage: uninstall.sh [--dry-run] [--purge]" \
        "Remove the TP Linux install. User data (profile-agent, token, logs) is kept unless --purge." \
        "--dry-run prints the paths that would be removed and does not delete them."
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  printf '%s\n' "Refusing to uninstall: HOME is empty or /." >&2
  exit 3
fi

DATA_DIR="$HOME/.local/share/ego-linux"
APP_DIR="$DATA_DIR/app"
BIN_DIR="$HOME/.local/bin"
case "$DATA_DIR" in
  "$HOME"/.local/share/ego-linux) ;;
  *) printf '%s\n' "Refusing to uninstall: unexpected data directory." >&2; exit 3 ;;
esac

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
PLAN="$(mktemp "${TMPDIR:-/tmp}/tp-uninstall-plan-XXXXXX")"
cleanup() { rm -f "$PLAN"; }
trap cleanup EXIT
: > "$PLAN"

add() {
  if [ -f "$PLAN" ] && grep -Fxq "$1" "$PLAN" 2>/dev/null; then
    return 0
  fi
  printf '%s\n' "$1" >> "$PLAN"
}

exists_path() {
  [ -e "$1" ] || [ -L "$1" ]
}

add_our_symlink() {
  link="$1"
  if [ ! -L "$link" ]; then
    return 0
  fi
  target="$(readlink "$link" 2>/dev/null || true)"
  case "$target" in
    "$APP_DIR"/*|"$BIN_DIR"/*) add "$link" ;;
  esac
  return 0
}

# A skill directory installed by install.sh holds SKILL.md and references/{api,platforms,troubleshooting}.md.
# Extra files in that directory are left in place; only our files are removed.
add_skill_dir() {
  dir="$1"
  if [ ! -d "$dir" ] || [ ! -f "$dir/SKILL.md" ]; then
    return 0
  fi
  extra=0
  for f in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [ ! -e "$f" ]; then
      continue
    fi
    base="$(basename "$f")"
    if [ "$base" = "references" ] && [ -d "$f" ]; then
      # RG-A9b: references/ is ours only if it holds nothing but the files install.sh copies.
      for r in "$f"/* "$f"/.[!.]* "$f"/..?*; do
        [ -e "$r" ] || continue
        case "$(basename "$r")" in api.md|platforms.md|troubleshooting.md) ;; *) extra=1 ;; esac
      done
    elif [ "$base" != "SKILL.md" ]; then
      extra=1
    fi
  done
  if [ "$extra" -eq 0 ]; then
    add "$dir"
  else
    add "$dir/SKILL.md"
    for r in api.md platforms.md troubleshooting.md; do [ -f "$dir/references/$r" ] && add "$dir/references/$r"; done
  fi
  return 0
}

has_planned_child() {
  dir="$1"
  while IFS= read -r p; do
    case "$p" in
      "$dir"/*) return 0 ;;
    esac
  done < "$PLAN"
  return 1
}

would_be_empty() {
  dir="$1"
  if [ ! -d "$dir" ]; then
    return 1
  fi
  for f in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then
      continue
    fi
    if ! grep -Fxq "$f" "$PLAN" 2>/dev/null; then
      return 1
    fi
  done
  return 0
}

add_empty_parents() {
  # Walk from the deepest directory upward. A parent is removed only when
  # this uninstall is already removing something inside it and nothing else remains.
  for dir in "$@"; do
    if has_planned_child "$dir" && would_be_empty "$dir"; then
      add "$dir"
    fi
  done
}

CMDS="tp-browser tp-browserd tp-start tp-headed tp-stop ego-browser ego-browserd ego-start ego-headed ego-stop"
for cmd in $CMDS; do
  add_our_symlink "$BIN_DIR/$cmd"
  if [ -d /usr/local/bin ]; then
    add_our_symlink "/usr/local/bin/$cmd"
  fi
  # RG-A12g: install.sh also links into Homebrew's bin on macOS.
  if [ -d /opt/homebrew/bin ]; then
    add_our_symlink "/opt/homebrew/bin/$cmd"
  fi
done

for root in \
  "$HOME/.claude/skills" \
  "$HOME/.agents/skills" \
  "$HOME/.codex/skills" \
  "$HOME/.gemini/config/skills"
do
  for name in tp-browser ego-browser; do
    add_skill_dir "$root/$name"
  done
done

add_empty_parents "$HOME/.claude/skills" "$HOME/.claude"
add_empty_parents "$HOME/.agents/skills" "$HOME/.agents"
add_empty_parents "$HOME/.codex/skills" "$HOME/.codex"
add_empty_parents "$HOME/.gemini/config/skills" "$HOME/.gemini/config" "$HOME/.gemini"

for rel in bin daemon lib scripts tools tests skills docs package.json LICENSE NOTICE; do
  if exists_path "$APP_DIR/$rel"; then
    add "$APP_DIR/$rel"
  fi
done
if has_planned_child "$APP_DIR" && would_be_empty "$APP_DIR"; then
  add "$APP_DIR"
fi

if [ "$PURGE" -eq 1 ] && [ -d "$DATA_DIR" ]; then
  for f in "$DATA_DIR"/* "$DATA_DIR"/.[!.]* "$DATA_DIR"/..?*; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      add "$f"
    fi
  done
  add "$DATA_DIR"
fi

stop="$APP_DIR/scripts/tp-stop.sh"
if [ ! -f "$stop" ]; then
  stop="$SCRIPT_DIR/scripts/tp-stop.sh"
fi
if [ -f "$stop" ]; then
  if [ "$DRY" -eq 1 ]; then
    TP_DRY_RUN=1 sh "$stop" || true
  else
    env -u TP_DRY_RUN sh "$stop" || true
  fi
else
  printf '%s\n' "scripts/tp-stop.sh not found; skipped stop" >&2
fi

if [ "$DRY" -eq 1 ]; then
  if [ -s "$PLAN" ]; then
    while IFS= read -r p; do
      printf 'would remove: %s\n' "$p"
    done < "$PLAN"
  else
    printf '%s\n' "would remove: (nothing)"
  fi
  if [ -f "$HOME/.zprofile" ] && grep -qF '# tp-browser PATH' "$HOME/.zprofile"; then printf '%s\n' "would remove: the '# tp-browser PATH' line in ~/.zprofile"; fi
  printf '%s\n' "dry-run: no files removed"
  exit 0
fi

while IFS= read -r p; do
  if [ -n "$p" ]; then
    rm -rf "$p"
  fi
done < "$PLAN"

# RG-A12g: drop only the one marked line install.sh appended to ~/.zprofile on macOS.
ZPROF="$HOME/.zprofile"
if [ -f "$ZPROF" ] && grep -qF '# tp-browser PATH' "$ZPROF"; then
  # RG-A12g2/g3: temp file next to the original (mode via cp -p plus u+w so a read-only file still works; the PLAN cleanup trap is kept), every step checked, atomic mv; a symlinked
  # ~/.zprofile is left untouched with a note. grep -v exit 1 just means no other lines remain.
  if [ -L "$ZPROF" ]; then
    printf '%s\n' "~/.zprofile is a symlink; remove the '# tp-browser PATH' line by hand"
  elif _z="$(mktemp "$ZPROF.tp.XXXXXX" 2>/dev/null)" && [ -n "$_z" ]; then
    trap 'rm -f "$_z"; cleanup' EXIT
    trap 'rm -f "$_z"; cleanup; exit 130' INT TERM
    _grc=0; _ro=0
    # RG-A12g5: read the owner write bit itself (ls -ldL column 3, following links), not -w, which is always true for root. Symlinks never reach here (handled above).
    [ "$(ls -ldL "$ZPROF" | cut -c3)" = "w" ] || _ro=1
    { cp -p "$ZPROF" "$_z" && chmod u+w "$_z" && { grep -vF '# tp-browser PATH' "$ZPROF" > "$_z" || _grc=$?; }; } || _grc=2
    # RG-A12g4: give a read-only original its read-only mode back.
    if [ "$_grc" -le 1 ] && [ "$_ro" -eq 1 ]; then chmod u-w "$_z" || _grc=2; fi
    if [ "$_grc" -le 1 ] && mv -f "$_z" "$ZPROF"; then
      printf '%s\n' "Removed the tp-browser PATH line from ~/.zprofile"
    else
      rm -f "$_z"; printf '%s\n' "Could not rewrite ~/.zprofile; it is unchanged. Remove the '# tp-browser PATH' line by hand." >&2
    fi
    trap cleanup EXIT; trap - INT TERM
  else
    printf '%s\n' "Could not create a temp file next to ~/.zprofile; it is unchanged." >&2
  fi
fi

printf '%s\n' "TP Linux uninstall finished"
if [ "$PURGE" -eq 1 ]; then
  printf '%s\n' "User data purged."
else
  printf '%s\n' "Kept user data (profile-agent, token, logs). Use --purge to delete them."
fi
exit 0
