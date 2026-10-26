#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/scripts/lib-wsl-win-dir.sh"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/tp-wsl-XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
mkdir -p "$DIR/Aaa/.local/share/ego-linux/scripts" "$DIR/Zed/.local/share/ego-linux/scripts"
mkdir -p "$DIR/嚴柏顯/.local/share/ego-linux/scripts"
echo 'marker-aaa' > "$DIR/Aaa/.local/share/ego-linux/scripts/ego-start.ps1"
echo 'marker-zed' > "$DIR/Zed/.local/share/ego-linux/scripts/ego-start.ps1"
echo 'marker-zh' > "$DIR/嚴柏顯/.local/share/ego-linux/scripts/ego-start.ps1"
got="$(pick_win_ego_linux_dir "$DIR" Zed)"
test "$got" = "$DIR/Zed/.local/share/ego-linux"
if pick_win_ego_linux_dir "$DIR" Aaa | grep -q Zed; then
  echo 'FAIL: picked Zed while asking for Aaa'
  exit 1
fi
if pick_win_ego_linux_dir "$DIR" Missing; then
  echo 'FAIL: missing user should fail'
  exit 1
fi
zh="$(pick_win_ego_linux_dir "$DIR" 嚴柏顯)"
test "$zh" = "$DIR/嚴柏顯/.local/share/ego-linux"
if pick_win_ego_linux_dir "$DIR" '../Aaa'; then
  echo 'FAIL: slash/dot-dot user should fail'
  exit 1
fi
if grep -q 'will not fall back to another account' "$ROOT/scripts/tp-start.sh"; then
  echo 'FAIL: tp-start.sh must fall back to native headed start when Windows dir is missing'
  exit 1
fi
echo 'PASS wsl-win-user-pick'
