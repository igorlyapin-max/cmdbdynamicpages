FROM node:20-alpine AS d2

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

FROM node:20-alpine

ENV NODE_ENV=production \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=8093 \
    CMDP_D2_RENDER_ENABLED=true \
    CMDP_D2_BINARY=/usr/local/bin/d2

WORKDIR /app

COPY --from=d2 --chown=node:node /usr/local/bin/d2 /usr/local/bin/d2
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node

EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const port=process.env.PROXY_PORT||8093;const req=http.get({host:'127.0.0.1',port,path:'/health/live',timeout:2000},res=>{res.resume();process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));"

CMD ["node", "scripts/dev-proxy-server.mjs"]
