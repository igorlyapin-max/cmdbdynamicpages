#!/bin/sh
set -eu

: "${CMDBUILD42_HOST_PORT:=8094}"
origin="http://127.0.0.1:${CMDBUILD42_HOST_PORT}"
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT

curl -fsS -o /dev/null -D "$headers" "${origin}/cmdbuild/"
status=$(awk 'NR == 1 { print $2 }' "$headers")

if [ "$status" != "200" ] && [ "$status" != "302" ]; then
  echo "CMDBuild 4.2 smoke failed: expected HTTP 200 or 302, got $status." >&2
  exit 1
fi

echo "CMDBuild 4.2 responds at ${origin}/cmdbuild/ (HTTP ${status})."
