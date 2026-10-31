# Pick the Windows ego-linux dir for THIS user. Never glob-and-take-first.
# Usage: pick_win_ego_linux_dir <users-root> <windows-username>
# Prints the directory on success; returns 1 if missing / unsafe name.
# Non-ASCII names (e.g. 嚴柏顯) are allowed; only path separators and
# empty / dot / dot-dot names are rejected.
pick_win_ego_linux_dir() {
  users_root="$1"
  win_user="$2"
  if [ -z "$users_root" ] || [ -z "$win_user" ]; then
    return 1
  fi
  case "$win_user" in
    '.' | '..' | */* | *'\\'*)
      return 1
      ;;
  esac
  case "$win_user" in
    *$'\n'* | *$'\r'* | *$'\t'*)
      return 1
      ;;
  esac
  candidate="$users_root/$win_user/.local/share/ego-linux"
  if [ -f "$candidate/scripts/ego-start.ps1" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}
