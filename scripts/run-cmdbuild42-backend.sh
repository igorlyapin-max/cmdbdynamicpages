#!/bin/sh
set -eu

: "${CMDBUILD42_HOST_PORT:=8094}"
: "${CMDP_CMDBUILD42_PROXY_PORT:=8095}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export NODE_ENV=development
export PROXY_HOST=127.0.0.1
export PROXY_PORT="$CMDP_CMDBUILD42_PROXY_PORT"
export CMDP_PUBLIC_ORIGIN="http://127.0.0.1:${CMDP_CMDBUILD42_PROXY_PORT}"
export CMDBUILD_ORIGIN="http://127.0.0.1:${CMDBUILD42_HOST_PORT}"
export CMDBDYNAMIC_REDIS_REQUIRED=false
export CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=false
export CMDP_DIAGNOSTIC_MODE=basic
export CMDP_LOG_TARGET=stdout
# This harness validates CMDBuild schema behavior, not diagram rendering.
export CMDP_D2_RENDER_ENABLED=false
export CMDP_D2_IMPORT_BINARY="$script_dir/../tests/fixtures/d2-import-stub.mjs"

exec node scripts/dev-proxy-server.mjs
