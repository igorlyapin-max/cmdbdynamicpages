#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="cmdbdynamicpages-nginx"

cd "${ROOT_DIR}"

# The template requires all CMDP_NGINX_* values. Compose supplies their stable
# local defaults without changing the host-network port contract.
docker compose -f docker-compose.nginx.yml config --quiet

# A legacy manually-created container has no Compose labels and blocks the
# fixed container name. A Compose-managed container belongs to its project and
# must be stopped by that project's owner, never removed by this launcher.
if docker container inspect "${NAME}" >/dev/null 2>&1; then
  EXISTING_PROJECT="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "${NAME}")"
  if [[ -z "${EXISTING_PROJECT}" || "${EXISTING_PROJECT}" == '<no value>' ]]; then
    docker rm --force "${NAME}"
  else
    printf 'Container %s belongs to Compose project %s. Stop it from that project before running nginx:dev.\n' "${NAME}" "${EXISTING_PROJECT}" >&2
    exit 1
  fi
fi

docker compose -f docker-compose.nginx.yml up -d --force-recreate --no-deps nginx
