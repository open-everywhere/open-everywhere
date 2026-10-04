#!/usr/bin/env bash
set -u

if [ "$#" -ne 1 ]; then
  echo "usage: bash scripts/proof-gates-parallel.sh <fresh log dir>" >&2
  exit 2
fi
LOGS="$1"
if [ -e "$LOGS" ] && [ -n "$(ls -A "$LOGS" 2>/dev/null)" ]; then
  echo "proof-gates: $LOGS is not empty. Give a fresh directory, so no log from an earlier run is read as this one." >&2
  exit 2
fi
mkdir -p "$LOGS"

if ! npm run oe:build > "$LOGS/oe-build.log" 2>&1; then
  echo "proof-gates: oe:build failed, so no gate started. See $LOGS/oe-build.log." >&2
  exit 1
fi

gate() {
  local suite="$1" log="$LOGS/$2.log" started rc
  started=$(date +%s)
  npm run "$suite" > "$log" 2>&1
  rc=$?
  echo "EXIT=$rc" >> "$log"
  echo "proof-gates: $suite wall=$(( $(date +%s) - started ))s log=$log"
  echo "OE_PROOF sha=$(git rev-parse HEAD) suite=$suite exit=$rc"
  return "$rc"
}

gate typecheck:all typecheck-all & P1=$!
gate test test & P2=$!
gate build build & P3=$!
RED=0
for pid in "$P1" "$P2" "$P3"; do wait "$pid" || RED=1; done
exit "$RED"
