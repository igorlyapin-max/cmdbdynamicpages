#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir="$script_dir/../dev/cmdbuild42/artifacts"
target="$target_dir/cmdbuild-4.2.0.war"
url='https://sourceforge.net/projects/cmdbuild/files/4.2.0/cmdbuild-4.2.0.war/download'

mkdir -p "$target_dir"
tmp="$target.tmp"
trap 'rm -f "$tmp"' EXIT

curl --http1.1 -fL --retry 3 --retry-delay 2 -A 'cmdbdynamicpages compatibility harness' -o "$tmp" "$url"

if [ "$(wc -c < "$tmp")" -lt 300000000 ]; then
  echo "Downloaded CMDBuild WAR is unexpectedly small; refusing to use it." >&2
  exit 1
fi

if command -v jar >/dev/null 2>&1; then
  archive_check='jar tf'
  if jar tf "$tmp" >/dev/null 2>&1; then
    archive_valid=true
  else
    archive_valid=false
  fi
elif command -v unzip >/dev/null 2>&1; then
  archive_check='unzip -tq'
  if unzip -tq "$tmp" >/dev/null 2>&1; then
    archive_valid=true
  else
    archive_valid=false
  fi
else
  echo "Neither jar nor unzip is available to validate the downloaded CMDBuild WAR." >&2
  exit 69
fi

if [ "$archive_valid" != true ]; then
  echo "Downloaded CMDBuild WAR is not a valid archive; refusing to use it." >&2
  exit 1
fi

printf 'Validated CMDBuild WAR with %s.\n' "$archive_check"

mv "$tmp" "$target"
sha256sum "$target"
