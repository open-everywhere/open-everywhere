#!/usr/bin/env bash
set -euo pipefail

DOCKER="${DOCKER:-docker}"
PORT="${OE_SMOKE_PORT:-38472}"
IMAGE="${OE_SMOKE_IMAGE:-open-everywhere:docker-smoke}"
SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
NAME="oe-docker-smoke-$$"
BOOT_TIMEOUT=180

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass=0
fail=0
note() { printf '  %s\n' "$*"; }
check() {
  if [ "$2" -eq 0 ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1));
  else printf '  \033[31m✗ %s\033[0m\n' "$1"; fail=$((fail+1)); fi
}

cleanup() {
  set +e
  "$DOCKER" rm -f "$NAME" >/dev/null 2>&1
  tpl=$("$DOCKER" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^eve-sandbox-template:' || true)
  if [ -n "$tpl" ]; then echo "$tpl" | xargs -r "$DOCKER" rmi -f >/dev/null 2>&1; fi
  if [ "${KEEP_IMAGE:-0}" != "1" ]; then "$DOCKER" rmi -f "$IMAGE" >/dev/null 2>&1; fi
}
trap cleanup EXIT

echo "== OPE-25 Vercel-less Docker smoke =="
echo "-- building $IMAGE (off-Vercel: eve build emits the Nitro node-server bundle) --"
"$DOCKER" build -t "$IMAGE" "$ROOT"

echo "-- booting $NAME on the docker() sandbox backend (daemon socket mounted) --"
"$DOCKER" run -d --name "$NAME" \
  -p "${PORT}:3000" \
  -v "${SOCK}:/var/run/docker.sock" \
  -e OE_MEMORY_PROVIDER=sqlite \
  -e OE_OPERATIONAL_PROVIDER=sqlite \
  -e OE_TELEMETRY=off \
  -e PORT=3000 \
  "$IMAGE" >/dev/null

deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  logs=$("$DOCKER" logs "$NAME" 2>&1 || true)
  if printf '%s' "$logs" | grep -q "server listening"; then break; fi
  if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then break; fi
  sleep 2 2>/dev/null || :
done

logs=$("$DOCKER" logs "$NAME" 2>&1 || true)
running=$("$DOCKER" inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)

echo "-- assertions --"

[ "$running" = "true" ] && printf '%s' "$logs" | grep -q "server listening"
check "clean boot — container up and eve server listening" $?

http_ok=1
if [ "$running" = "true" ]; then
  code=$("$DOCKER" exec "$NAME" wget -q -S -O /dev/null http://127.0.0.1:3000/ 2>&1 | awk '/HTTP\// {print $2; exit}')
  [ "$code" = "200" ] && http_ok=0
  note "in-container GET / → HTTP ${code:-<none>}"
fi
check "HTTP health — GET / returns 200" "$http_ok"

printf '%s' "$logs" | grep -q "off-Vercel sandbox backend = docker"
check "sandbox backend resolved to docker (boot log)" $?
printf '%s' "$logs" | grep -q "initialized 1 sandbox template"
check "docker() backend functioned — eve initialized a sandbox template" $?

printf '%s' "$logs" | grep -q "\[open-everywhere:egress\] ⚠"
check "egress warning present at boot (conscious-choice posture)" $?
printf '%s' "$logs" | grep -q "EVERY session will ABORT"
check "egress warning is the fail-closed 'sessions will ABORT' form" $?

echo
echo "---- boot log (tail) ----"
printf '%s\n' "$logs" | grep -E '\[open-everywhere:(sandbox|egress)\]|sandbox template|server listening' | head -20
echo "-------------------------"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && { echo "SMOKE: PASS"; exit 0; } || { echo "SMOKE: FAIL"; exit 1; }
