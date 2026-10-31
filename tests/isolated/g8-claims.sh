#!/bin/sh
# RG-A8 / G8: one consistent token-savings claim. Fails on unsupported or range-style claims.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
F="README.md STATE.md docs/index.html docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md skills/tp-browser/SKILL.md"
[ -d skills/tp-browser/references ] && F="$F $(ls skills/tp-browser/references/*.md 2>/dev/null)"
bad=$(grep -nE '95%\+|90%\+|97\.5%|97\.9%|88\.6% ?[~～-]|9[0-9]%\+ ' $F 2>/dev/null)
main=$(grep -l '88\.6%' $F | wc -l)
if [ -n "$bad" ]; then echo "FAIL G8 unsupported claims:"; echo "$bad"; exit 1; fi
[ "$main" -ge 4 ] && echo "PASS G8 main claim 88.6% present in $main files, no unsupported claims" || { echo "FAIL G8 main claim only in $main files"; exit 1; }
