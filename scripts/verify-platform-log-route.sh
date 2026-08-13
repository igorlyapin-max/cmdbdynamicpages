#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/verify-platform-log-route.sh <health-url> -- <collector-query-command> [args...]

Sends a unique X-Request-ID to the running service and executes the explicitly
provided platform collector query. The query receives CMDP_LOG_PROBE_ID and
must exit 0 only after that identifier is visible in the external log route.
EOF
}

[ "$#" -ge 3 ] || { usage >&2; exit 64; }
probe_url=$1
shift
[ "${1:-}" = '--' ] || { usage >&2; exit 64; }
shift
[ "$#" -gt 0 ] || { usage >&2; exit 64; }

case "$probe_url" in
  http://*|https://*) ;;
  *) echo 'health-url must use http:// or https://' >&2; exit 64 ;;
esac

CMDP_LOG_PROBE_ID=${CMDP_LOG_PROBE_ID:-"cmdp-log-probe-$(date +%s)-$$"}
export CMDP_LOG_PROBE_ID

curl --fail --silent --show-error --max-time 15 \
  -H "X-Request-ID: ${CMDP_LOG_PROBE_ID}" \
  "$probe_url" >/dev/null

"$@"
