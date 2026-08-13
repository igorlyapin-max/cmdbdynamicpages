#!/bin/sh
set -eu

: "${CMDP_TLS_CA_FILE_HOST:?set CMDP_TLS_CA_FILE_HOST to the host PEM bundle}"
: "${CMDP_TLS_SMOKE_URL:?set CMDP_TLS_SMOKE_URL to an internal https:// endpoint}"

case "$CMDP_TLS_SMOKE_URL" in
  https://*) ;;
  *) echo 'CMDP_TLS_SMOKE_URL must use https://' >&2; exit 64 ;;
esac

test -f "$CMDP_TLS_CA_FILE_HOST"
test -r "$CMDP_TLS_CA_FILE_HOST"
curl --fail --silent --show-error --cacert "$CMDP_TLS_CA_FILE_HOST" --max-time 15 "$CMDP_TLS_SMOKE_URL" >/dev/null
