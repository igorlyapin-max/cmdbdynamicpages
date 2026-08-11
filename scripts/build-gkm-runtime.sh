#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/build-gkm-runtime.sh \
    --node-base-image <image> --go-base-image <image> --tag <image> [--no-cache]

Builds the local unverified GKM runtime image through Docker target gkm-runtime.
The script invokes Docker only; it does not require npm, Node, or Go on the host.
EOF
}

node_base_image=''
go_base_image=''
tag=''
no_cache=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --node-base-image) node_base_image=${2:?--node-base-image requires a value}; shift 2 ;;
    --go-base-image) go_base_image=${2:?--go-base-image requires a value}; shift 2 ;;
    --tag) tag=${2:?--tag requires a value}; shift 2 ;;
    --no-cache) no_cache=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$node_base_image" ] || { echo '--node-base-image is required.' >&2; exit 2; }
[ -n "$go_base_image" ] || { echo '--go-base-image is required.' >&2; exit 2; }
[ -n "$tag" ] || { echo '--tag is required.' >&2; exit 2; }

if [ "$no_cache" = true ]; then
  exec docker build --no-cache --target gkm-runtime \
    --build-arg "GKM_NODE_BASE_IMAGE=$node_base_image" \
    --build-arg "GKM_GO_BASE_IMAGE=$go_base_image" \
    -t "$tag" .
fi

exec docker build --target gkm-runtime \
  --build-arg "GKM_NODE_BASE_IMAGE=$node_base_image" \
  --build-arg "GKM_GO_BASE_IMAGE=$go_base_image" \
  -t "$tag" .
