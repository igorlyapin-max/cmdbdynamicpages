#!/bin/sh
set -eu

# A deployment-mounted CA must be consumed by Node. Otherwise preserve the
# trust configuration inherited from a prepared customer base image.
if [ -n "${CMDP_TLS_CA_FILE:-}" ]; then
  export NODE_EXTRA_CA_CERTS="$CMDP_TLS_CA_FILE"
fi

exec "$@"
