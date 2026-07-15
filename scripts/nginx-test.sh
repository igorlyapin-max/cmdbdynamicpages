#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm \
  --network host \
  -e CMDP_NGINX_CUSTOM_API_READ_TIMEOUT=70s \
  -v "${ROOT_DIR}/nginx/cmdbdynamicpages-dev.conf:/etc/nginx/templates/default.conf.template:ro" \
  nginx:1.27-alpine nginx -t
