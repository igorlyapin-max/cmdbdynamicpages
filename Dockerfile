ARG APP_VERSION=unknown
ARG VCS_REF=unknown
ARG SOURCE_DIRTY=unknown
ARG BUILD_PROVENANCE=unverified-local
ARG RUNTIME_MANIFEST_SHA256=unknown
ARG SOURCE_URL=https://github.com/igorlyapin-max/cmdbdynamicpages
ARG GKM_NODE_BASE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
ARG GKM_GO_BASE_IMAGE=golang:1.25.11-alpine@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS d2

ARG D2_VERSION=0.7.1
ARG TARGETARCH

USER root

RUN set -eux; \
  apk add --no-cache ca-certificates curl tar; \
  case "${TARGETARCH:-amd64}" in \
    amd64) d2_arch="linux-amd64"; d2_sha256="eb172adf59f38d1e5a70ab177591356754ffaf9bebb84e0ca8b767dfb421dad7" ;; \
    arm64) d2_arch="linux-arm64"; d2_sha256="ce3a0b985a8f91335a826c254b3a88736fd81afcdd08b58f6c749d2add6864b0" ;; \
    *) echo "Unsupported D2 TARGETARCH=${TARGETARCH:-}"; exit 1 ;; \
  esac; \
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 -o /tmp/d2.tar.gz "https://github.com/terrastruct/d2/releases/download/v${D2_VERSION}/d2-v${D2_VERSION}-${d2_arch}.tar.gz"; \
  echo "${d2_sha256}  /tmp/d2.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/d2.tar.gz -C /tmp; \
  install -m 0755 "/tmp/d2-v${D2_VERSION}/bin/d2" /usr/local/bin/d2; \
  /usr/local/bin/d2 --version

FROM golang:1.25.11-alpine@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2 AS d2-import-builder

WORKDIR /src

COPY go.mod go.sum ./
RUN set -eu; \
  for attempt in 1 2 3; do \
    if go mod download; then exit 0; fi; \
    if [ "$attempt" -lt 3 ]; then sleep "$((attempt * 3))"; fi; \
  done; \
  exit 1

COPY cmd/cmdp-d2-import ./cmd/cmdp-d2-import
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/cmdp-d2-import ./cmd/cmdp-d2-import

FROM d2-import-builder AS d2-import-test

RUN go test ./cmd/cmdp-d2-import

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime-source

WORKDIR /source

COPY src ./src
COPY scripts ./scripts
COPY cmd/cmdp-d2-import ./cmd/cmdp-d2-import
COPY go.mod go.sum package.json VERSION ./

FROM runtime-source AS runtime-source-manifest-manual

RUN node scripts/build-identity.mjs manifest \
  --root /source \
  --output /out/RUNTIME_SOURCE_MANIFEST.json

FROM runtime-source AS runtime-source-manifest-canonical

ARG RUNTIME_MANIFEST_SHA256

RUN node scripts/build-identity.mjs manifest \
  --root /source \
  --output /out/RUNTIME_SOURCE_MANIFEST.json \
  --expect-sha256 "$RUNTIME_MANIFEST_SHA256"

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime-base

ARG SOURCE_URL

ENV NODE_ENV=production \
    PROXY_HOST=127.0.0.1 \
    PROXY_PORT=8093 \
    CMDP_LOG_TARGET=stdout,syslog \
    CMDP_D2_RENDER_ENABLED=true \
    CMDP_D2_BINARY=/usr/local/bin/d2 \
    CMDP_D2_IMPORT_BINARY=/usr/local/bin/cmdp-d2-import

WORKDIR /app

# Runtime CA bundles are mounted read-only by the deployment compose profile.
RUN mkdir -p /run/certs \
  && chown node:node /run/certs

LABEL org.opencontainers.image.title="cmdbdynamicpages" \
      org.opencontainers.image.source="${SOURCE_URL}"

COPY --from=d2 --chown=node:node /usr/local/bin/d2 /usr/local/bin/d2
COPY --from=d2-import-builder --chown=node:node /out/cmdp-d2-import /usr/local/bin/cmdp-d2-import
COPY --from=runtime-source --chown=node:node /source/package.json /source/VERSION ./
COPY --from=runtime-source --chown=node:node /source/src ./src
COPY --from=runtime-source --chown=node:node /source/scripts ./scripts
RUN set -eu; \
  file_version="$(tr -d '\r\n' < ./VERSION)"; \
  printf '%s\n' "$file_version" | grep -Ex '[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}' >/dev/null; \
  test "$file_version" != '00.00.00.00'; \
  printf '%s\n' "$file_version" > ./VERSION

EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const port=process.env.PROXY_PORT||8093;const req=http.get({host:'127.0.0.1',port,path:'/health/live',timeout:2000},res=>{res.resume();process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));"

ENTRYPOINT ["sh", "scripts/container-entrypoint.sh"]
CMD ["node", "scripts/dev-proxy-server.mjs"]

FROM runtime-base AS runtime-canonical

ARG APP_VERSION
ARG VCS_REF
ARG SOURCE_DIRTY
ARG BUILD_PROVENANCE
ARG RUNTIME_MANIFEST_SHA256

LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      io.gkm.cmdbdynamicpages.provenance="${BUILD_PROVENANCE}" \
      io.gkm.cmdbdynamicpages.source-dirty="${SOURCE_DIRTY}" \
      io.gkm.cmdbdynamicpages.runtime-source-manifest-sha256="${RUNTIME_MANIFEST_SHA256}"

COPY --from=runtime-source-manifest-canonical --chown=node:node /out/RUNTIME_SOURCE_MANIFEST.json ./RUNTIME_SOURCE_MANIFEST.json
RUN set -eu; \
  file_version="$(tr -d '\r\n' < ./VERSION)"; \
  if [ "$APP_VERSION" != "$file_version" ]; then \
    echo "APP_VERSION $APP_VERSION does not match VERSION $file_version" >&2; \
    exit 1; \
  fi; \
  if [ "$VCS_REF" != 'unknown' ]; then \
    printf '%s\n' "$VCS_REF" | grep -Ex '[0-9a-f]{40}' >/dev/null; \
  fi; \
  case "$SOURCE_DIRTY" in true|false|unknown) ;; *) echo 'SOURCE_DIRTY must be true, false, or unknown' >&2; exit 1 ;; esac; \
  case "$BUILD_PROVENANCE" in verified|unverified-local) ;; *) echo 'BUILD_PROVENANCE must be verified or unverified-local' >&2; exit 1 ;; esac; \
  printf '%s\n' "$RUNTIME_MANIFEST_SHA256" | grep -Ex '[0-9a-f]{64}' >/dev/null; \
  actual_manifest_sha256="$(sha256sum ./RUNTIME_SOURCE_MANIFEST.json | cut -d ' ' -f 1)"; \
  test "$actual_manifest_sha256" = "$RUNTIME_MANIFEST_SHA256"; \
  if [ "$BUILD_PROVENANCE" = 'verified' ]; then \
    test "$APP_VERSION" = "$file_version"; \
    test "$VCS_REF" != 'unknown'; \
    test "$SOURCE_DIRTY" = 'false'; \
  fi; \
  if [ "$SOURCE_DIRTY" = 'unknown' ]; then dirty_json='null'; else dirty_json="$SOURCE_DIRTY"; fi; \
  printf '{"version":"%s","revision":"%s","dirty":%s,"provenance":"%s","runtimeManifestSha256":"%s"}\n' \
    "$file_version" "$VCS_REF" "$dirty_json" "$BUILD_PROVENANCE" "$RUNTIME_MANIFEST_SHA256" > ./BUILD_INFO.json; \
  node scripts/build-identity.mjs verify-runtime --root /app --expect-provenance "$BUILD_PROVENANCE"

USER node

# Prepared customer base profile: selected base images own CA trust and package
# repository configuration. Product stages still install their own utilities.
FROM ${GKM_NODE_BASE_IMAGE} AS gkm-d2

ARG D2_VERSION=0.7.1
ARG TARGETARCH

USER root

RUN set -eux; \
  apk add --no-cache curl tar; \
  case "${TARGETARCH:-amd64}" in \
    amd64) d2_arch="linux-amd64"; d2_sha256="eb172adf59f38d1e5a70ab177591356754ffaf9bebb84e0ca8b767dfb421dad7" ;; \
    arm64) d2_arch="linux-arm64"; d2_sha256="ce3a0b985a8f91335a826c254b3a88736fd81afcdd08b58f6c749d2add6864b0" ;; \
    *) echo "Unsupported D2 TARGETARCH=${TARGETARCH:-}"; exit 1 ;; \
  esac; \
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 -o /tmp/d2.tar.gz "https://github.com/terrastruct/d2/releases/download/v${D2_VERSION}/d2-v${D2_VERSION}-${d2_arch}.tar.gz"; \
  echo "${d2_sha256}  /tmp/d2.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/d2.tar.gz -C /tmp; \
  install -m 0755 "/tmp/d2-v${D2_VERSION}/bin/d2" /usr/local/bin/d2; \
  /usr/local/bin/d2 --version

FROM ${GKM_GO_BASE_IMAGE} AS gkm-d2-import-builder

USER root

WORKDIR /src

COPY go.mod go.sum ./
RUN set -eu; \
  for attempt in 1 2 3; do \
    if go mod download; then exit 0; fi; \
    if [ "$attempt" -lt 3 ]; then sleep "$((attempt * 3))"; fi; \
  done; \
  exit 1

COPY cmd/cmdp-d2-import ./cmd/cmdp-d2-import
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/cmdp-d2-import ./cmd/cmdp-d2-import

FROM ${GKM_NODE_BASE_IMAGE} AS gkm-runtime-source

USER root

WORKDIR /source

COPY src ./src
COPY scripts ./scripts
COPY cmd/cmdp-d2-import ./cmd/cmdp-d2-import
COPY go.mod go.sum package.json VERSION ./

FROM gkm-runtime-source AS gkm-runtime-source-manifest-manual

RUN node scripts/build-identity.mjs manifest \
  --root /source \
  --output /out/RUNTIME_SOURCE_MANIFEST.json

FROM gkm-runtime-source AS gkm-runtime-source-manifest-canonical

ARG RUNTIME_MANIFEST_SHA256

RUN node scripts/build-identity.mjs manifest \
  --root /source \
  --output /out/RUNTIME_SOURCE_MANIFEST.json \
  --expect-sha256 "$RUNTIME_MANIFEST_SHA256"

FROM ${GKM_NODE_BASE_IMAGE} AS gkm-runtime-base

ARG SOURCE_URL

USER root

ENV NODE_ENV=production \
    PROXY_HOST=127.0.0.1 \
    PROXY_PORT=8093 \
    CMDP_LOG_TARGET=stdout,syslog \
    CMDP_D2_RENDER_ENABLED=true \
    CMDP_D2_BINARY=/usr/local/bin/d2 \
    CMDP_D2_IMPORT_BINARY=/usr/local/bin/cmdp-d2-import

WORKDIR /app

RUN mkdir -p /run/certs \
  && chown node:node /run/certs

LABEL org.opencontainers.image.title="cmdbdynamicpages" \
      org.opencontainers.image.source="${SOURCE_URL}"

COPY --from=gkm-d2 --chown=node:node /usr/local/bin/d2 /usr/local/bin/d2
COPY --from=gkm-d2-import-builder --chown=node:node /out/cmdp-d2-import /usr/local/bin/cmdp-d2-import
COPY --from=gkm-runtime-source --chown=node:node /source/package.json /source/VERSION ./
COPY --from=gkm-runtime-source --chown=node:node /source/src ./src
COPY --from=gkm-runtime-source --chown=node:node /source/scripts ./scripts
RUN set -eu; \
  file_version="$(tr -d '\r\n' < ./VERSION)"; \
  printf '%s\n' "$file_version" | grep -Ex '[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}' >/dev/null; \
  test "$file_version" != '00.00.00.00'; \
  printf '%s\n' "$file_version" > ./VERSION

EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const port=process.env.PROXY_PORT||8093;const req=http.get({host:'127.0.0.1',port,path:'/health/live',timeout:2000},res=>{res.resume();process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));"

ENTRYPOINT ["sh", "scripts/container-entrypoint.sh"]
CMD ["node", "scripts/dev-proxy-server.mjs"]

FROM gkm-runtime-base AS gkm-runtime-canonical

ARG APP_VERSION
ARG VCS_REF
ARG SOURCE_DIRTY
ARG BUILD_PROVENANCE
ARG RUNTIME_MANIFEST_SHA256

LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      io.gkm.cmdbdynamicpages.provenance="${BUILD_PROVENANCE}" \
      io.gkm.cmdbdynamicpages.source-dirty="${SOURCE_DIRTY}" \
      io.gkm.cmdbdynamicpages.runtime-source-manifest-sha256="${RUNTIME_MANIFEST_SHA256}"

COPY --from=gkm-runtime-source-manifest-canonical --chown=node:node /out/RUNTIME_SOURCE_MANIFEST.json ./RUNTIME_SOURCE_MANIFEST.json
RUN set -eu; \
  file_version="$(tr -d '\r\n' < ./VERSION)"; \
  if [ "$APP_VERSION" != "$file_version" ]; then \
    echo "APP_VERSION $APP_VERSION does not match VERSION $file_version" >&2; \
    exit 1; \
  fi; \
  if [ "$VCS_REF" != 'unknown' ]; then \
    printf '%s\n' "$VCS_REF" | grep -Ex '[0-9a-f]{40}' >/dev/null; \
  fi; \
  case "$SOURCE_DIRTY" in true|false|unknown) ;; *) echo 'SOURCE_DIRTY must be true, false, or unknown' >&2; exit 1 ;; esac; \
  case "$BUILD_PROVENANCE" in verified|unverified-local) ;; *) echo 'BUILD_PROVENANCE must be verified or unverified-local' >&2; exit 1 ;; esac; \
  printf '%s\n' "$RUNTIME_MANIFEST_SHA256" | grep -Ex '[0-9a-f]{64}' >/dev/null; \
  actual_manifest_sha256="$(sha256sum ./RUNTIME_SOURCE_MANIFEST.json | cut -d ' ' -f 1)"; \
  test "$actual_manifest_sha256" = "$RUNTIME_MANIFEST_SHA256"; \
  if [ "$BUILD_PROVENANCE" = 'verified' ]; then \
    test "$APP_VERSION" = "$file_version"; \
    test "$VCS_REF" != 'unknown'; \
    test "$SOURCE_DIRTY" = 'false'; \
  fi; \
  if [ "$SOURCE_DIRTY" = 'unknown' ]; then dirty_json='null'; else dirty_json="$SOURCE_DIRTY"; fi; \
  printf '{"version":"%s","revision":"%s","dirty":%s,"provenance":"%s","runtimeManifestSha256":"%s"}\n' \
    "$file_version" "$VCS_REF" "$dirty_json" "$BUILD_PROVENANCE" "$RUNTIME_MANIFEST_SHA256" > ./BUILD_INFO.json; \
  node scripts/build-identity.mjs verify-runtime --root /app --expect-provenance "$BUILD_PROVENANCE"

USER node

FROM gkm-runtime-base AS gkm-runtime

LABEL io.gkm.cmdbdynamicpages.provenance="unverified-local"

COPY --from=gkm-runtime-source-manifest-manual --chown=node:node /out/RUNTIME_SOURCE_MANIFEST.json ./RUNTIME_SOURCE_MANIFEST.json
RUN set -eu; \
  file_version="$(tr -d '\r\n' < ./VERSION)"; \
  runtime_manifest_sha256="$(sha256sum ./RUNTIME_SOURCE_MANIFEST.json | cut -d ' ' -f 1)"; \
  printf '{"version":"%s","revision":"unknown","dirty":null,"provenance":"unverified-local","runtimeManifestSha256":"%s"}\n' \
    "$file_version" "$runtime_manifest_sha256" > ./BUILD_INFO.json; \
  node scripts/build-identity.mjs verify-runtime --root /app --expect-provenance unverified-local

USER node

FROM runtime-base AS runtime-manual

LABEL io.gkm.cmdbdynamicpages.provenance="unverified-local"

COPY --from=runtime-source-manifest-manual --chown=node:node /out/RUNTIME_SOURCE_MANIFEST.json ./RUNTIME_SOURCE_MANIFEST.json
RUN set -eu; \
  file_version="$(tr -d '\r\n' < ./VERSION)"; \
  runtime_manifest_sha256="$(sha256sum ./RUNTIME_SOURCE_MANIFEST.json | cut -d ' ' -f 1)"; \
  printf '{"version":"%s","revision":"unknown","dirty":null,"provenance":"unverified-local","runtimeManifestSha256":"%s"}\n' \
    "$file_version" "$runtime_manifest_sha256" > ./BUILD_INFO.json; \
  node scripts/build-identity.mjs verify-runtime --root /app --expect-provenance unverified-local

USER node
