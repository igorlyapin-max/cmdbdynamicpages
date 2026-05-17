#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="cmdbdynamicpages-nginx"

if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
  docker rm -f "${NAME}" >/dev/null
fi

docker run -d \
  --name "${NAME}" \
  --restart unless-stopped \
  --network host \
  -v "${ROOT_DIR}/nginx/cmdbdynamicpages-dev.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine
