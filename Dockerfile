FROM node:20-alpine

ENV NODE_ENV=production \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=8093

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node

EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const port=process.env.PROXY_PORT||8093;const req=http.get({host:'127.0.0.1',port,path:'/health/live',timeout:2000},res=>{res.resume();process.exit(res.statusCode>=200&&res.statusCode<300?0:1)});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));"

CMD ["node", "scripts/dev-proxy-server.mjs"]
