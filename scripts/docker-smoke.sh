#!/usr/bin/env bash
set -euo pipefail

DOCKER="${DOCKER:-docker}"
PORT="${OE_SMOKE_PORT:-38472}"
IMAGE="${OE_SMOKE_IMAGE:-open-everywhere:docker-smoke}"
PROXY_IMAGE="${OE_SMOKE_PROXY_IMAGE:-open-everywhere-egress:docker-smoke}"
NAME="oe-docker-smoke-$$"
PROXY="$NAME-proxy"
APP="$NAME-app"
EGRESS_IMAGE="$IMAGE-egress"
NET_INT="$NAME-int"
NET_WAN="$NAME-wan"
BOOT_TIMEOUT=180

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APP_DIR="$(cd "${OE_SMOKE_APP_DIR:-$ROOT}" && pwd)"
if [ ! -f "$APP_DIR/Dockerfile" ] || [ ! -f "$APP_DIR/deploy/egress-proxy/Dockerfile" ]; then
  echo "docker-smoke: $APP_DIR has no Dockerfile or no deploy/egress-proxy/Dockerfile" >&2
  exit 2
fi

pass=0
fail=0
note() { printf '  %s\n' "$*"; }
check() {
  if [ "$2" -eq 0 ]; then printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1));
  else printf '  \033[31m✗ %s\033[0m\n' "$1"; fail=$((fail+1)); fi
}

cleanup() {
  set +e
  "$DOCKER" rm -f "$NAME" "$PROXY" "$APP" >/dev/null 2>&1
  "$DOCKER" network rm "$NET_INT" "$NET_WAN" >/dev/null 2>&1
  if [ "${KEEP_IMAGE:-0}" != "1" ]; then "$DOCKER" rmi -f "$EGRESS_IMAGE" "$IMAGE" "$PROXY_IMAGE" >/dev/null 2>&1; fi
  [ -n "${PATCH_CTX:-}" ] && rm -rf "$PATCH_CTX"
}
trap cleanup EXIT

wait_for_log() {
  local deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$DOCKER" logs "$1" 2>&1 | grep -q "$2"; then return 0; fi
    if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != "true" ]; then return 1; fi
    sleep 2 2>/dev/null || :
  done
  return 1
}

echo "== OPE-25 / OPE-2406 / OPE-2407 Vercel-less Docker smoke =="
echo "-- app: $APP_DIR --"
echo "-- building $IMAGE (off-Vercel: eve build emits the Nitro node-server bundle) --"
if [ "${OE_SMOKE_SKIP_BUILD:-0}" = "1" ]; then
  echo "-- OE_SMOKE_SKIP_BUILD=1: reusing $IMAGE and $PROXY_IMAGE as tagged --"
else
  "$DOCKER" build -t "$IMAGE" "$APP_DIR"
  echo "-- building $PROXY_IMAGE (deploy/egress-proxy) --"
  "$DOCKER" build -t "$PROXY_IMAGE" "$APP_DIR/deploy/egress-proxy"
fi

echo "-- LEG 1: booting $NAME on the backend the app declares, no proxy --"
"$DOCKER" run -d --name "$NAME" \
  -p "${PORT}:3000" \
  -e OE_OPERATIONAL_PROVIDER=sqlite \
  -e DO_NOT_TRACK=1 \
  -e PORT=3000 \
  "$IMAGE" >/dev/null
wait_for_log "$NAME" "server listening" || true

logs=$("$DOCKER" logs "$NAME" 2>&1 || true)
running=$("$DOCKER" inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)

echo "-- leg 1 assertions --"
set +e

[ "$running" = "true" ] && printf '%s' "$logs" | grep -q "server listening"
check "clean boot — container up and eve server listening" $?

http_ok=1
if [ "$running" = "true" ]; then
  code=$("$DOCKER" exec "$NAME" wget -q -S -O /dev/null http://127.0.0.1:3000/ 2>&1 | awk '/HTTP\// {print $2; exit}')
  [ "$code" = "200" ] && http_ok=0
  note "in-container GET / → HTTP ${code:-<none>}"
fi
check "HTTP health — GET / returns 200" "$http_ok"

printf '%s' "$logs" | grep -q "off-Vercel sandbox backend = justbash"
check "image sandbox backend = justbash (boot log)" $?

printf '%s' "$logs" | grep -q "\[open-everywhere:egress\] ⚠"
check "egress warning present at boot (conscious-choice posture)" $?
printf '%s' "$logs" | grep -q "will ABORT at session.started (fail-closed)"
check "egress warning is the fail-closed 'sessions will ABORT' form" $?

echo "---- leg 1 boot log (tail) ----"
printf '%s\n' "$logs" | grep -E '\[open-everywhere:(sandbox|egress)\]|server listening' | head -20
echo "-------------------------------"
"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true

echo
echo "-- LEG 2: the compose topology — app on an internal-only network, the proxy its only way out --"
TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
"$DOCKER" network create --internal "$NET_INT" >/dev/null
"$DOCKER" network create "$NET_WAN" >/dev/null
"$DOCKER" run -d --name "$PROXY" --network "$NET_INT" -e OE_EGRESS_PROXY_TOKEN="$TOKEN" "$PROXY_IMAGE" >/dev/null
"$DOCKER" network connect "$NET_WAN" "$PROXY"
wait_for_log "$PROXY" "Accepting HTTP Socket connections" || true

PATCH_CTX="$(mktemp -d)"
cp "$ROOT/scripts/docker-smoke-settings-patch.mjs" "$PATCH_CTX/"
printf 'FROM %s\nCOPY docker-smoke-settings-patch.mjs /tmp/\nRUN node /tmp/docker-smoke-settings-patch.mjs agent/settings/settings.ts "http://%s:8080" && npm run build\n' \
  "$IMAGE" "$PROXY" > "$PATCH_CTX/Dockerfile"
echo "-- building $EGRESS_IMAGE ($IMAGE with egress.proxyUrl = http://$PROXY:8080) --"
"$DOCKER" build -t "$EGRESS_IMAGE" "$PATCH_CTX"

APP_ENV=(
  -e OE_OPERATIONAL_PROVIDER=sqlite -e DO_NOT_TRACK=1 -e PORT=3000
  -e NODE_USE_ENV_PROXY=1
  -e HTTP_PROXY="http://$PROXY:3128" -e HTTPS_PROXY="http://$PROXY:3128"
  -e NO_PROXY="$PROXY,localhost,127.0.0.1"
  -e OE_EGRESS_PROXY_TOKEN="$TOKEN" -e OE_SMOKE_PROXY_URL="http://$PROXY:8080"
)
[ -n "${AI_GATEWAY_API_KEY:-}" ] && APP_ENV+=(-e AI_GATEWAY_API_KEY)
for k in OE_SMOKE_MODEL OE_SMOKE_SESSION_HOST OE_SMOKE_UNDECLARED_HOST OE_SMOKE_CREDENTIAL_UNDECLARED_HOST; do
  [ -n "${!k:-}" ] && APP_ENV+=(-e "$k")
done

"$DOCKER" run -d --name "$APP" --network "$NET_INT" "${APP_ENV[@]}" "$EGRESS_IMAGE" >/dev/null
wait_for_log "$APP" "server listening" || true
app_logs=$("$DOCKER" logs "$APP" 2>&1 || true)

probe=""
if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" = "true" ]; then
  "$DOCKER" cp "$ROOT/scripts/docker-smoke-egress-probe.mjs" "$APP:/app/scripts/docker-smoke-egress-probe.mjs"
  probe=$("$DOCKER" exec -w /app "$APP" node /app/scripts/docker-smoke-egress-probe.mjs 2>&1 | grep -E '^(PROBE|NOTE) ' || true)
fi

proxy_logs=$("$DOCKER" logs "$PROXY" 2>&1 || true)
denied=$("$DOCKER" exec "$PROXY" cat /var/log/oe-egress/denied.log 2>/dev/null || true)
GW_HOST="ai-gateway.vercel.sh"
UNDECLARED="${OE_SMOKE_UNDECLARED_HOST:-example.org}"
CRED_UNDECLARED="${OE_SMOKE_CREDENTIAL_UNDECLARED_HOST:-example.net}"

echo "-- leg 2 assertions --"
printf '%s' "$app_logs" | grep -q "server listening"
check "app boots behind the proxy (internal-only network)" $?
printf '%s' "$app_logs" | grep -q "self-host egress ENFORCED via proxy sidecar"
check "boot log: self-host egress ENFORCED via the proxy" $?

probe_check() {
  printf '%s\n' "$probe" | grep -q "^PROBE $1 ok"
  check "$2" $?
  printf '%s\n' "$probe" | grep "^PROBE $1 " | sed 's/^/      /' | head -1
}
probe_check session-policy-pushed "session policy pushed for the app's source IP (one declared host)"
probe_check host-plane-wired "host plane wired for the gateway"
probe_check model-call "🔴 MODEL CALL succeeds through the enforcing proxy (host plane)"
probe_check session-gateway-refused "🔴 the SESSION cannot reach the model gateway (no widening)"
probe_check session-undeclared-refused "🔴 the SESSION cannot reach an undeclared host"
probe_check session-declared-allowed "the SESSION reaches its declared host (positive control)"
probe_check host-plane-undeclared-refused "the credential reaches no undeclared host at the proxy"
probe_check host-plane-guard "the host-plane fetch refuses an undeclared host in-process"

printf '%s' "$proxy_logs" | grep -q "TCP_TUNNEL/200 [0-9]* CONNECT $GW_HOST:443"
check "proxy access log: TCP_TUNNEL/200 to $GW_HOST (the model call went through the proxy)" $?
printf '%s' "$denied" | grep -q "TCP_DENIED/403 $GW_HOST\$"
check "proxy denial log: $GW_HOST refused (the session's attempt reached the proxy)" $?
printf '%s' "$denied" | grep -q "TCP_DENIED/403 $UNDECLARED\$"
check "proxy denial log: $UNDECLARED refused (the session's attempt reached the proxy)" $?
printf '%s' "$denied" | grep -q "TCP_DENIED/403 $CRED_UNDECLARED\$"
check "proxy denial log: $CRED_UNDECLARED refused (the credentialed attempt reached the proxy)" $?
printf '%s\n%s\n%s\n%s\n' "$proxy_logs" "$denied" "$app_logs" "$probe" | grep -q "$TOKEN"
[ $? -ne 0 ]
check "no log carries the control token (proxy, denial log, app, probe)" $?

printf '%s\n' "$probe" | grep '^NOTE ' | sed 's/^/  /'

echo
echo "---- leg 2 app boot log (tail) ----"
printf '%s\n' "$app_logs" | grep -E '\[open-everywhere:(sandbox|egress)\]|server listening' | head -10
echo "---- leg 2 proxy decisions ----"
printf '%s\n' "$proxy_logs" | grep -E 'TCP_(TUNNEL|DENIED)' | awk '{print $4, $6, $7}' | head -20
echo "-------------------------------"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && { echo "SMOKE: PASS"; exit 0; } || { echo "SMOKE: FAIL"; exit 1; }
