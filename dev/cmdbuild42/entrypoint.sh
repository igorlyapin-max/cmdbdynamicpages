#!/bin/sh
set -eu

webapp=/usr/local/tomcat/webapps/cmdbuild
config_dir=/usr/local/tomcat/conf/cmdbuild
config_file="$config_dir/database.conf"
init_marker=/var/lib/cmdbuild42/demo-db-initialized

require_value() {
  name=$1
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "cmdbuild42: required environment variable $name is empty" >&2
    exit 64
  fi
}

set_property() {
  key=$1
  value=$2
  escaped_value=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')
  if grep -q "^${key}=" "$config_file"; then
    sed -i "s|^${key}=.*|${key}=${escaped_value}|" "$config_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$config_file"
  fi
}

require_value CMDBUILD42_DB_NAME
require_value CMDBUILD42_DB_USER
require_value CMDBUILD42_DB_PASSWORD
require_value CMDBUILD42_DB_SUPERUSER
require_value CMDBUILD42_DB_SUPERUSER_PASSWORD

mkdir -p "$config_dir"
cp "$webapp/WEB-INF/conf/database.conf_example" "$config_file"
set_property db.url "jdbc:postgresql://cmdbuild42-db:5432/${CMDBUILD42_DB_NAME}"
set_property db.username "$CMDBUILD42_DB_USER"
set_property db.password "$CMDBUILD42_DB_PASSWORD"
set_property db.admin.username "$CMDBUILD42_DB_SUPERUSER"
set_property db.admin.password "$CMDBUILD42_DB_SUPERUSER_PASSWORD"

if [ ! -f "$init_marker" ]; then
  echo "cmdbuild42: creating the isolated demo database"
  "$webapp/cmdbuild.sh" dbconfig create demo -configfile "$config_file"
  touch "$init_marker"
fi

exec "$@"
