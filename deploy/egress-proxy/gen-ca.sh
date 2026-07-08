#!/bin/sh
set -eu

CA_DIR="${OE_EGRESS_CA_DIR:-/opt/oe-egress/ca}"
CA_KEY="$CA_DIR/oe-egress-ca.key"
CA_CRT="$CA_DIR/oe-egress-ca.crt"
CA_CN="${OE_EGRESS_CA_CN:-Open Everywhere Egress Proxy CA}"
DAYS="${OE_EGRESS_CA_DAYS:-3650}"

mkdir -p "$CA_DIR"

if [ -f "$CA_KEY" ] && [ -f "$CA_CRT" ]; then
  echo "[gen-ca] CA already present at $CA_DIR — leaving it untouched (delete to rotate)."
  exit 0
fi

echo "[gen-ca] generating a new local CA in $CA_DIR ..."
openssl genrsa -out "$CA_KEY" 4096
openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days "$DAYS" \
  -subj "/CN=$CA_CN" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$CA_CRT"
chmod 600 "$CA_KEY"
chmod 644 "$CA_CRT"
echo "[gen-ca] done. CA cert: $CA_CRT"
echo "[gen-ca] install it into the app/sandbox with install-ca.sh (see README)."
