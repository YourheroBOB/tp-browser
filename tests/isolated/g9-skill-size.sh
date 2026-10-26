#!/bin/sh
# RG-A9 / G9: skill entry <= 2000 bytes and every relative link resolves.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; S="$ROOT/skills/tp-browser"; rc=0
n=$(wc -c < "$S/SKILL.md"); [ "$n" -le 2000 ] && echo "PASS G9 SKILL.md $n B" || { echo "FAIL G9 SKILL.md $n B > 2000"; rc=1; }
for f in "$S/SKILL.md" "$S"/references/*.md; do
  d=$(dirname "$f")
  for l in $(grep -oE '\]\([^)#:]+\.md' "$f" | sed 's/^](//'); do
    [ -f "$d/$l" ] || { echo "FAIL broken link in $(basename "$f"): $l"; rc=1; }
  done
done
[ $rc -eq 0 ] && echo "PASS G9 links"; exit $rc
