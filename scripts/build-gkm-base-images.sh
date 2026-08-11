#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/build-gkm-base-images.sh \
    --node-tag <image> --go-tag <image> \
    [--node-base-image <image>] [--go-base-image <image>] \
    [--ca-dir <directory>] [--apk-repositories <file>] [--no-cache]

Builds the prepared Alpine Node and Go images used by Docker target gkm-runtime.
The script invokes Docker only; it does not require npm, Node, or Go on the host.
EOF
}

node_base_image='node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293'
go_base_image='golang:1.25.11-alpine@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2'
node_tag=''
go_tag=''
ca_dir=''
apk_repositories=''
no_cache=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --node-base-image) node_base_image=${2:?--node-base-image requires a value}; shift 2 ;;
    --go-base-image) go_base_image=${2:?--go-base-image requires a value}; shift 2 ;;
    --node-tag) node_tag=${2:?--node-tag requires a value}; shift 2 ;;
    --go-tag) go_tag=${2:?--go-tag requires a value}; shift 2 ;;
    --ca-dir) ca_dir=${2:?--ca-dir requires a value}; shift 2 ;;
    --apk-repositories) apk_repositories=${2:?--apk-repositories requires a value}; shift 2 ;;
    --no-cache) no_cache=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$node_tag" ] || { echo '--node-tag is required.' >&2; exit 2; }
[ -n "$go_tag" ] || { echo '--go-tag is required.' >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
template_dir=$(CDPATH= cd -- "$script_dir/../deploy/gkm-base-images" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
context_dir=$(mktemp -d "$project_root/.tmp-gkm-base.XXXXXX")
trap 'rm -rf "$context_dir"' EXIT HUP INT TERM
mkdir -p "$context_dir/customer-ca"
: > "$context_dir/apk-repositories"

custom_ca_required=false
if [ -n "$ca_dir" ]; then
  [ -d "$ca_dir" ] || { echo "CA directory does not exist: $ca_dir" >&2; exit 2; }
  certificate_count=0
  for certificate in "$ca_dir"/*.crt "$ca_dir"/*.pem; do
    [ -f "$certificate" ] || continue
    cp "$certificate" "$context_dir/customer-ca/"
    certificate_count=$((certificate_count + 1))
  done
  [ "$certificate_count" -gt 0 ] || { echo "CA directory must contain at least one .crt or .pem file: $ca_dir" >&2; exit 2; }
  custom_ca_required=true
fi

apk_repositories_required=false
if [ -n "$apk_repositories" ]; then
  [ -f "$apk_repositories" ] && [ -s "$apk_repositories" ] || { echo "Alpine repositories file must be a non-empty regular file: $apk_repositories" >&2; exit 2; }
  cp "$apk_repositories" "$context_dir/apk-repositories"
  apk_repositories_required=true
fi

build_base() {
  dockerfile=$1
  base_image=$2
  image_tag=$3
  set -- docker build
  if [ "$no_cache" = true ]; then set -- "$@" --no-cache; fi
  set -- "$@" \
    -f "$template_dir/$dockerfile" \
    --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "CUSTOM_CA_REQUIRED=$custom_ca_required" \
    --build-arg "APK_REPOSITORIES_REQUIRED=$apk_repositories_required" \
    -t "$image_tag" \
    "$context_dir"
  "$@"
}

build_base Dockerfile.node "$node_base_image" "$node_tag"
build_base Dockerfile.go "$go_base_image" "$go_tag"

printf '%s\n' "Prepared Node base: $node_tag"
printf '%s\n' "Prepared Go base: $go_tag"
