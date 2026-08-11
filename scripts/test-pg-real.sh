#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="ope385-ci"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.test-pg.yml)
WS_PORT="${OE_TEST_PG_WS_PORT:-55433}"

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    echo "-- tearing down the $PROJECT sidecar --"
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== OPE-385 real-Postgres store/migration test lane =="
echo "-- bringing up postgres + neon-wsproxy ($PROJECT) --"
"${COMPOSE[@]}" up -d --wait

echo "-- waiting for neon-wsproxy to accept connections on 127.0.0.1:${WS_PORT} --"
deadline=$(( $(date +%s) + 60 ))
until (exec 3<>"/dev/tcp/127.0.0.1/${WS_PORT}") 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "neon-wsproxy did not come up on 127.0.0.1:${WS_PORT} within 60s" >&2
    "${COMPOSE[@]}" logs
    exit 1
  fi
  sleep 1
done
exec 3<&- 3>&- || true
echo "-- neon-wsproxy is up --"

export OE_TEST_PG_URL="postgres://openeverywhere:${OE_TEST_PG_PASSWORD:-test-pg-local-only}@postgres:5432/openeverywhere"
export OE_TEST_PG_WS="127.0.0.1:${WS_PORT}"

echo "-- running the store/migration suites through the real driver --"
npm run oe:build
fail=0
for script in test:operational test:postgres test:migrate-operational; do
  echo "---- $script ----"
  if ! npm run "$script" --workspace @open-everywhere/core; then
    fail=1
  fi
done

[ "$fail" -eq 0 ] && { echo "PG-REAL: PASS"; exit 0; } || { echo "PG-REAL: FAIL"; exit 1; }
