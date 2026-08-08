#!/bin/sh
set -eu

CONTROL_PORT="${OE_EGRESS_CONTROL_PORT:-8080}"
MITM="${OE_EGRESS_MITM:-0}"
SQUID_CONF="/etc/squid/squid.conf"

echo "[oe-egress] starting (MITM=$MITM) ..."

node --experimental-strip-types /opt/oe-egress/control/server.ts &
CONTROL_PID=$!

i=0
while [ $i -lt 50 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${CONTROL_PORT}/healthz" 2>/dev/null; then break; fi
  i=$((i + 1)); sleep 0.2
done

cp /opt/oe-egress/squid.conf "$SQUID_CONF"

if [ "$MITM" = "1" ]; then
  echo "[oe-egress] Tier B (MITM) enabled — generating CA + initialising cert DB."
  sh /opt/oe-egress/gen-ca.sh
  sed -i \
    "s#^http_port 3128\$#http_port 3128 ssl-bump generate-host-certificates=on dynamic_cert_mem_cache_size=4MB tls-cert=${OE_EGRESS_CA_DIR:-/opt/oe-egress/ca}/oe-egress-ca.crt tls-key=${OE_EGRESS_CA_DIR:-/opt/oe-egress/ca}/oe-egress-ca.key#" \
    "$SQUID_CONF"
  cat /opt/oe-egress/tier-b.conf >> "$SQUID_CONF"
  rm -rf /var/lib/squid/ssl_db
  /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB || true
  chown -R squid:squid /var/lib/squid 2>/dev/null || true
else
  echo "[oe-egress] Tier A (SNI/CONNECT host allow-deny, no decryption)."
fi

chown -R squid:squid /var/lib/squid 2>/dev/null || true
chown squid:squid /dev/stdout /dev/stderr 2>/dev/null || true

mkdir -p /var/log/oe-egress
chown -R squid:squid /var/log/oe-egress 2>/dev/null || true

squid -N -f "$SQUID_CONF" -z 2>/dev/null || true

echo "[oe-egress] launching squid."
exec squid -N -f "$SQUID_CONF" -d 1
