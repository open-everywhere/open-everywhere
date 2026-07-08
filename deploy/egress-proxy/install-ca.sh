#!/bin/sh
set -eu

CA_CRT="${OE_EGRESS_CA_CRT:-/opt/oe-egress/ca/oe-egress-ca.crt}"
PROXY_URL="${OE_EGRESS_PROXY_HTTP:-http://oe-egress-proxy:3128}"

if [ ! -f "$CA_CRT" ]; then
  echo "[install-ca] CA cert not found at $CA_CRT — run gen-ca.sh in the proxy first (Tier B)." >&2
  exit 1
fi

if command -v update-ca-certificates >/dev/null 2>&1; then
  cp "$CA_CRT" /usr/local/share/ca-certificates/oe-egress-ca.crt 2>/dev/null \
    || cp "$CA_CRT" /etc/ssl/certs/oe-egress-ca.pem
  update-ca-certificates >/dev/null 2>&1 || true
fi

echo "[install-ca] CA installed. Export these in the app environment (compose sets them):"
echo "  HTTP_PROXY=$PROXY_URL"
echo "  HTTPS_PROXY=$PROXY_URL"
echo "  NODE_EXTRA_CA_CERTS=$CA_CRT   # Node/npm trust the MITM CA"
echo "  GIT_SSL_CAINFO=$CA_CRT        # git trusts the MITM CA"
echo "[install-ca] (git also honors http.proxy=$PROXY_URL; npm honors https-proxy=$PROXY_URL)"
