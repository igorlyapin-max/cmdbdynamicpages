import fs from 'node:fs';

const requiredFiles = [
  '.env.example',
  'VERSION',
  'Dockerfile',
  'docker-compose.runtime.yml',
  'docker-compose.nginx.yml',
  'scripts/build-identity.mjs',
  'scripts/container-image.mjs',
  'docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md'
];

const requiredEnv = [
  'CMDBDYNAMIC_IMAGE',
  'NODE_ENV',
  'PROXY_HOST',
  'PROXY_PORT',
  'CMDP_PUBLIC_ORIGIN',
  'CMDP_NGINX_PUBLIC_HOST',
  'CMDP_NGINX_PUBLIC_PROTO',
  'CMDBUILD_ORIGIN',
  'CMDBDYNAMIC_REDIS_URL',
  'CMDBDYNAMIC_REDIS_TLS_CA_FILE',
  'CMDBDYNAMIC_REDIS_PASSWORD_FILE',
  'CMDBDYNAMIC_REDIS_PASSWORD_FILE_HOST',
  'CMDBDYNAMIC_REDIS_REQUIRED',
  'CMDBDYNAMIC_HEALTH_REDIS_REQUIRED',
  'CMDBDYNAMICPAGES_CSRF_SECRET',
  'CMDP_NGINX_CUSTOM_API_READ_TIMEOUT',
  'CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE',
  'CMDP_D2_RENDER_ENABLED',
  'CMDP_D2_BINARY',
  'CMDP_D2_TIMEOUT_MS',
  'CMDP_D2_MAX_INPUT_BYTES',
  'CMDP_D2_MAX_OUTPUT_BYTES',
  'CMDP_D2_MAX_DIAGRAMS',
  'CMDP_D2_CONCURRENCY',
  'CMDP_D2_LAYOUT',
  'CMDP_D2_LAYOUT_ALLOWLIST',
  'CMDP_ASSISTANT_ENABLED',
  'LITELLM_BASE_URL',
  'CMDP_LITELLM_ALLOWED_BASE_URLS',
  'LITELLM_MODEL',
  'CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE',
  'CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE',
  'LITELLM_API_KEY_FILE_HOST',
  'CMDP_LOG_TARGET',
  'CMDP_SYSLOG_HOST',
  'CMDP_SYSLOG_PORT',
  'CMDP_SYSLOG_PROTOCOL',
  'CMDP_SYSLOG_FACILITY',
  'CMDP_DIAGNOSTIC_MODE'
];

const failures = [];

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    failures.push(`${file}: missing required delivery file`);
    return '';
  }
}

function requireText(file, text, label = text) {
  const body = read(file);
  if (!body.includes(text)) failures.push(`${file}: missing ${label}`);
}

function requirePattern(file, regex, label) {
  const body = read(file);
  if (!regex.test(body)) failures.push(`${file}: missing ${label}`);
}

function requireDigestPinnedReferences(file, regex, label) {
  const references = [...read(file).matchAll(regex)].map((match) => match[1]);
  if (!references.length) {
    failures.push(`${file}: missing ${label}`);
    return;
  }
  for (const reference of references) {
    if (!/@sha256:[0-9a-f]{64}$/.test(reference)) {
      failures.push(`${file}: ${reference} is not pinned by a valid SHA-256 digest`);
    }
  }
}

function rejectPattern(file, regex, label) {
  const body = read(file);
  if (regex.test(body)) failures.push(`${file}: contains forbidden ${label}`);
}

function requireEnvValue(name, expectedValue) {
  const value = envValue(name);
  if (value === undefined) return;
  if (value !== expectedValue) {
    failures.push(`.env.example: ${name} must be ${expectedValue}`);
  }
}

function envValue(name) {
  const match = envExample.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

function validateNginxPublicOrigin() {
  const originValue = envValue('CMDP_PUBLIC_ORIGIN');
  const host = envValue('CMDP_NGINX_PUBLIC_HOST');
  const proto = envValue('CMDP_NGINX_PUBLIC_PROTO');

  if (!originValue || !host || !proto) return;
  if (!['http', 'https'].includes(proto)) {
    failures.push('.env.example: CMDP_NGINX_PUBLIC_PROTO must be http or https');
    return;
  }

  let origin;
  try {
    origin = new URL(originValue);
  } catch {
    failures.push('.env.example: CMDP_PUBLIC_ORIGIN must be a valid absolute URL');
    return;
  }

  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    failures.push('.env.example: CMDP_PUBLIC_ORIGIN must contain only scheme, host, and optional port');
  }
  if (origin.protocol !== `${proto}:`) {
    failures.push('.env.example: CMDP_NGINX_PUBLIC_PROTO must match CMDP_PUBLIC_ORIGIN protocol');
  }
  if (origin.host !== host) {
    failures.push('.env.example: CMDP_NGINX_PUBLIC_HOST must match CMDP_PUBLIC_ORIGIN host and port');
  }
}

requiredFiles.forEach((file) => {
  if (!fs.existsSync(file)) failures.push(`${file}: missing required delivery file`);
});

const envExample = read('.env.example');
const version = read('VERSION');
if (!/^\d{2}\.\d{2}\.\d{2}\.\d{2}\n$/.test(version)) {
  failures.push('VERSION: must contain exactly XX.YY.ZZ.NN followed by a newline');
} else if (version === '00.00.00.00\n') {
  failures.push('VERSION: 00.00.00.00 is reserved for the pre-handoff image fallback');
}
requiredEnv.forEach((name) => {
  if (!new RegExp(`^${name}=`, 'm').test(envExample)) {
    failures.push(`.env.example: missing ${name}`);
  }
});
requireEnvValue('PROXY_HOST', '127.0.0.1');
requireEnvValue('CMDBDYNAMIC_REDIS_URL', 'rediss://redis.example.local:6380/0');
requireEnvValue('CMDP_LOG_TARGET', 'stdout,syslog');
requireEnvValue('CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE', '2097152');
requireEnvValue('CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE', '4194304');
requireEnvValue('LITELLM_API_KEY_FILE_HOST', '');
requireEnvValue('CMDBDYNAMIC_IMAGE', 'registry.example.local/gkm/cmdbdynamicpages:vXX.YY.ZZ.NN');
validateNginxPublicOrigin();

rejectPattern('docker-compose.runtime.yml', /^\s*build\s*:/m, 'build directive');
rejectPattern('docker-compose.nginx.yml', /^\s*build\s*:/m, 'build directive');
rejectPattern('docker-compose.runtime.yml', /^\s*ports\s*:/m, 'published backend ports');
rejectPattern('docker-compose.runtime.yml', /^\s*logging\s*:/m, 'Docker logging driver configuration');
requireText('docker-compose.runtime.yml', 'image: ${CMDBDYNAMIC_IMAGE}', 'prebuilt image reference');
requireText('docker-compose.runtime.yml', 'PROXY_HOST: ${PROXY_HOST:-127.0.0.1}', 'loopback proxy host default');
requireText('docker-compose.runtime.yml', '/health/live', 'container liveness healthcheck');
requireText('docker-compose.runtime.yml', 'LITELLM_API_KEY_FILE', 'LiteLLM assistant secret file wiring');
requireText('docker-compose.runtime.yml', 'source: ${LITELLM_API_KEY_FILE_HOST:-/dev/null}', 'LiteLLM empty-secret fallback');
requireText('docker-compose.runtime.yml', 'CMDP_LOG_TARGET: ${CMDP_LOG_TARGET:-stdout,syslog}', 'production stdout and syslog target default');
requireText('docker-compose.runtime.yml', 'CMDP_SYSLOG_HOST: ${CMDP_SYSLOG_HOST:?CMDP_SYSLOG_HOST must be set}', 'required syslog host wiring');
requireText('docker-compose.runtime.yml', 'CMDP_SYSLOG_PORT', 'syslog port wiring');
requireText('docker-compose.runtime.yml', 'CMDP_SYSLOG_PROTOCOL', 'syslog protocol wiring');
requireText('docker-compose.runtime.yml', 'CMDP_SYSLOG_FACILITY', 'syslog facility wiring');
requireText('docker-compose.runtime.yml', 'CMDP_PUBLIC_ORIGIN: ${CMDP_PUBLIC_ORIGIN}', 'public origin wiring');
requireText('docker-compose.runtime.yml', 'CMDP_LITELLM_ALLOWED_BASE_URLS', 'LiteLLM base URL allowlist wiring');
requireText('docker-compose.runtime.yml', 'CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE: ${CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE:-2097152}', 'LiteLLM absolute request cap wiring');
requireText('docker-compose.runtime.yml', 'CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE: ${CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE:-4194304}', 'LiteLLM absolute response cap wiring');
requireText('docker-compose.runtime.yml', 'CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE: ${CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE:-50000}', 'absolute selection scan limit wiring');
requireText('docker-compose.runtime.yml', 'CMDBDYNAMIC_REDIS_TLS_CA_FILE', 'Redis TLS CA wiring');
requireText('docker-compose.runtime.yml', 'CMDP_D2_RENDER_ENABLED', 'D2 render wiring');
requireText('docker-compose.runtime.yml', 'CMDP_D2_MAX_DIAGRAMS', 'D2 max diagrams wiring');
requireText('docker-compose.runtime.yml', 'CMDP_D2_CONCURRENCY', 'D2 render concurrency wiring');
requireText('docker-compose.nginx.yml', '/etc/nginx/templates/default.conf.template', 'nginx template mount');
requireText('docker-compose.nginx.yml', 'CMDP_NGINX_PUBLIC_HOST: "${CMDP_NGINX_PUBLIC_HOST:-localhost:8088}"', 'local public host default wiring');
requireText('docker-compose.nginx.yml', 'CMDP_NGINX_PUBLIC_PROTO: "${CMDP_NGINX_PUBLIC_PROTO:-http}"', 'local public protocol default wiring');
requireText('docker-compose.nginx.yml', 'CMDP_NGINX_CUSTOM_API_READ_TIMEOUT: "${CMDP_NGINX_CUSTOM_API_READ_TIMEOUT:-70s}"', 'custom API timeout default wiring');
requireText('docker-compose.nginx.yml', 'nginx -t && test -s /var/run/nginx.pid && kill -0 $$(cat /var/run/nginx.pid)', 'nginx config and master-process healthcheck');
rejectPattern('docker-compose.nginx.yml', /\bwget\b/, 'nginx HTTP healthcheck client');
requireText('nginx/cmdbdynamicpages.conf', 'proxy_set_header Host ${CMDP_NGINX_PUBLIC_HOST};', 'explicit public Host forwarding');
requireText('nginx/cmdbdynamicpages.conf', 'proxy_set_header X-Forwarded-Host ${CMDP_NGINX_PUBLIC_HOST};', 'explicit public X-Forwarded-Host forwarding');
requireText('nginx/cmdbdynamicpages.conf', 'proxy_set_header X-Forwarded-Proto ${CMDP_NGINX_PUBLIC_PROTO};', 'explicit public X-Forwarded-Proto forwarding');
rejectPattern('nginx/cmdbdynamicpages.conf', /proxy_set_header\s+(?:Host|X-Forwarded-Host)\s+\$http_host;/, 'request Host forwarding');
rejectPattern('nginx/cmdbdynamicpages.conf', /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/, 'request scheme forwarding');
requireText('Dockerfile', 'HEALTHCHECK', 'Docker HEALTHCHECK');
requireText('Dockerfile', 'USER node', 'non-root runtime user');
requireText('Dockerfile', 'PROXY_HOST=127.0.0.1', 'loopback proxy host default');
requireText('Dockerfile', 'CMDP_LOG_TARGET=stdout,syslog', 'production stdout and syslog targets');
requireText('Dockerfile', `path:'/health/live'`, 'Docker liveness healthcheck');
requireText('Dockerfile', 'd2-v${D2_VERSION}', 'pinned D2 binary download');
requireText('Dockerfile', 'sha256sum -c -', 'D2 checksum validation');
requireText('Dockerfile', 'ARG APP_VERSION=unknown', 'unverified local application version build argument');
requireText('Dockerfile', 'ARG APP_VERSION', 'runtime application version build argument');
requireText('Dockerfile', 'ARG VCS_REF=unknown', 'unverified local Git revision build argument');
requireText('Dockerfile', 'ARG BUILD_PROVENANCE=unverified-local', 'unverified local provenance build argument');
requireText('Dockerfile', 'ARG RUNTIME_MANIFEST_SHA256=unknown', 'runtime source manifest digest build argument');
requireText('Dockerfile', 'FROM d2-import-builder AS d2-import-test', 'D2 importer test target');
requireText('Dockerfile', 'RUN go test ./cmd/cmdp-d2-import', 'D2 importer test target command');
requireText('Dockerfile', 'for attempt in 1 2 3', 'bounded Go module download retry');
requirePattern('Dockerfile', /^FROM node:20-alpine@sha256:[0-9a-f]{64}(?:\s|$)/m, 'digest-pinned Node base image');
requirePattern('Dockerfile', /^FROM golang:1\.25\.11-alpine@sha256:[0-9a-f]{64}(?:\s|$)/m, 'digest-pinned patched Go base image');
requireDigestPinnedReferences('Dockerfile', /^FROM\s+((?:node|golang):[^\s]+)(?:\s|$)/gmi, 'Node or Go base image references');
requireText('Dockerfile', 'AS runtime-source-manifest', 'runtime source manifest build stage');
requireText('Dockerfile', 'COPY src ./src', 'runtime manifest src source copy');
requireText('Dockerfile', 'COPY scripts ./scripts', 'runtime manifest scripts source copy');
requireText('Dockerfile', 'COPY cmd/cmdp-d2-import ./cmd/cmdp-d2-import', 'runtime manifest D2 importer source copy');
requireText('Dockerfile', 'COPY go.mod go.sum package.json VERSION ./', 'runtime manifest root source copy');
requireText('Dockerfile', '--output /out/RUNTIME_SOURCE_MANIFEST.json', 'deterministic runtime source manifest generation');
requireText('Dockerfile', '--expect-sha256 "$RUNTIME_MANIFEST_SHA256"', 'runtime source manifest digest verification');
requireText('Dockerfile', '/source/VERSION ./VERSION', 'root VERSION image copy');
requireText('Dockerfile', `printf '%s\\n' "$file_version" > ./VERSION`, 'normalized LF VERSION in image');
requireText('Dockerfile', 'APP_VERSION $APP_VERSION does not match VERSION $file_version', 'build argument and VERSION consistency check');
requireText('Dockerfile', './BUILD_INFO.json', 'embedded build identity');
requireText('Dockerfile', './RUNTIME_SOURCE_MANIFEST.json', 'embedded runtime source manifest');
requireText('Dockerfile', 'org.opencontainers.image.version', 'OCI version label');
requireText('Dockerfile', 'org.opencontainers.image.revision', 'OCI revision label');
requireText('Dockerfile', 'io.gkm.cmdbdynamicpages.provenance', 'OCI provenance label');
requireText('Dockerfile', 'io.gkm.cmdbdynamicpages.runtime-source-manifest-sha256', 'OCI runtime source manifest digest label');
requireText('Dockerfile', '"runtimeManifestSha256":"%s"', 'BUILD_INFO runtime source manifest digest');
requireText('scripts/build-identity.mjs', "'src/**'", 'runtime manifest src coverage');
requireText('scripts/build-identity.mjs', "'scripts/**'", 'runtime manifest scripts coverage');
requireText('scripts/build-identity.mjs', "'cmd/cmdp-d2-import/**'", 'runtime manifest D2 importer coverage');
requireText('scripts/build-identity.mjs', "'go.mod'", 'runtime manifest go.mod coverage');
requireText('scripts/build-identity.mjs', "'go.sum'", 'runtime manifest go.sum coverage');
requireText('scripts/build-identity.mjs', "'package.json'", 'runtime manifest package.json coverage');
requireText('scripts/build-identity.mjs', "'VERSION'", 'runtime manifest VERSION coverage');
requireText('scripts/container-image.mjs', 'workspace.runtimeManifestText !== embedded.runtimeManifestText', 'whole runtime manifest comparison');
requireText('scripts/container-image.mjs', 'a clean verification requires a clean Git checkout', 'strict clean checkout verification');
requireText('scripts/container-image.mjs', 'a clean verification requires image dirty=false', 'strict image dirty verification');
requireText('scripts/container-image.mjs', '`RUNTIME_MANIFEST_SHA256=${metadata.runtimeManifestSha256}`', 'runtime manifest Docker build argument');
requireText('package.json', '"container:build": "node scripts/container-image.mjs build"', 'canonical container build command');
requireText('package.json', '"container:verify": "node scripts/container-image.mjs verify"', 'container identity verification command');
rejectPattern('Dockerfile', /^COPY\s+\.\s+\.$/m, 'broad build-context copy');
requireText('.dockerignore', '*.d2', 'local D2 template exclusion');
requireText('.dockerignore', '.tmp-*', 'local temporary artifact exclusion');

[
  'private registry',
  'CA/cert',
  'DNS',
  'firewall',
  'PAM',
  'PROXY_HOST',
  '/health/live',
  '/health/ready',
  '/metrics',
  'CMDP_LOG_TARGET=stdout,syslog',
  'CMDP_SYSLOG_HOST',
  'CMDP_SYSLOG_PORT',
  'CMDP_SYSLOG_PROTOCOL',
  'CMDP_SYSLOG_FACILITY',
  'CMDP_PUBLIC_ORIGIN',
  'CMDBDYNAMIC_REDIS_TLS_CA_FILE',
  'CMDP_NGINX_CUSTOM_API_READ_TIMEOUT',
  'CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE',
  'CMDP_LITELLM_ALLOWED_BASE_URLS',
  'CMDP_D2_RENDER_ENABLED',
  'CMDP_D2_MAX_DIAGRAMS',
  'CMDP_D2_CONCURRENCY',
  'CMDP_DIAGNOSTIC_MODE=off',
  'CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE',
  'CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE',
  'assistant.llm.maxRequestBytes',
  'assistant.llm.maxResponseBytes',
  'Runtime rows',
  'raw D2 source',
  'RUNTIME_SOURCE_MANIFEST.json',
  'runtimeManifestSha256',
  'vXX.YY.ZZ.NN',
  '--require-clean'
].forEach((text) => requireText('docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md', text));

rejectPattern('.env.example', /v0\.1\.0-static-baseline/, 'legacy image tag example');
rejectPattern('docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md', /v0\.1\.0-static-baseline/, 'legacy image tag example');

[
  'Dockerfile',
  'docker-compose.runtime.yml',
  '.env.example',
  'docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md',
  'docs/deployment-guide.md',
  'docs/deployment-guide.ru.md'
].forEach((file) => rejectPattern(file, /\bCMDP_EXTERNAL_LOG_SINK\b/, 'unsupported external log sink variable'));

rejectPattern('Dockerfile', /\bPROXY_HOST\s*=\s*0\.0\.0\.0\b/, 'public backend bind default');
rejectPattern('docker-compose.runtime.yml', /PROXY_HOST:\s*\$\{PROXY_HOST:-0\.0\.0\.0\}/, 'public backend bind default');
rejectPattern('.env.example', /^PROXY_HOST=0\.0\.0\.0$/m, 'public backend bind default');

[
  '.omk/',
  '.kimi/',
  '.recovery/'
].forEach((rule) => requireText('.gitignore', rule, `local workspace ignore ${rule}`));

[
  ['docs/deployment-guide.md', 'CMDP_LOG_TARGET=stdout,syslog'],
  ['docs/deployment-guide.md', 'CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE=2097152'],
  ['docs/deployment-guide.md', 'CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE=4194304'],
  ['docs/deployment-guide.md', 'assistant.llm.maxRequestBytes'],
  ['docs/deployment-guide.md', 'Runtime rows'],
  ['docs/deployment-guide.ru.md', 'CMDP_LOG_TARGET=stdout,syslog'],
  ['docs/deployment-guide.ru.md', 'CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE=2097152'],
  ['docs/deployment-guide.ru.md', 'CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE=4194304'],
  ['docs/deployment-guide.ru.md', 'assistant.llm.maxRequestBytes'],
  ['docs/deployment-guide.ru.md', 'Runtime rows'],
  ['docs/wikiai-integration.ru.md', 'CMDP_PUBLIC_ORIGIN'],
  ['docs/wikiai-integration.ru.md', ':8093'],
  ['docs/wikiai-integration.ru.md', 'X-User-Name'],
  ['docs/wikiai-integration.ru.md', 'X-Groups']
].forEach(([file, text]) => requireText(file, text));

[
  ['docs/integration-guide.en.md', 'CMDP_PUBLIC_ORIGIN'],
  ['docs/integration-guide.en.md', 'CMDBuild-Authorization'],
  ['docs/integration-guide.en.md', 'does not accept MediaWiki identity headers'],
  ['docs/integration-guide.ru.md', 'CMDP_PUBLIC_ORIGIN'],
  ['docs/integration-guide.ru.md', 'CMDBuild-Authorization'],
  ['docs/integration-guide.ru.md', 'не принимает identity headers MediaWiki']
].forEach(([file, text]) => requireText(file, text));

[
  'docs/integration-guide.en.md',
  'docs/integration-guide.ru.md'
].forEach((file) => {
  rejectPattern(file, /\bX-(?:User-Name|Groups)\b/, 'unsupported MediaWiki identity header');
  rejectPattern(file, /Authorization:\s*Bearer/i, 'unsupported credential pass-through');
  rejectPattern(file, /proxy_set_header\s+Cookie/i, 'unsupported cookie pass-through');
});

requireText('.github/workflows/ci.yml', 'node scripts/container-image.mjs build --tag "$image:$tag" --require-clean', 'canonical verified Docker image build gate');
requireText('.github/workflows/ci.yml', 'node scripts/container-image.mjs verify --image "$image:$tag" --require-clean', 'whole-manifest Docker image verification gate');
requireText('.github/workflows/ci.yml', 'docker push', 'Docker image push gate');
requireText('.github/workflows/ci.yml', 'needs:', 'Docker image dependency gate');
requireText('.github/workflows/ci.yml', '- test', 'Docker image npm/UI dependency');
requireText('.github/workflows/ci.yml', '- go_vulncheck', 'Docker image vulnerability dependency');
requireText('.github/workflows/ci.yml', 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', 'pinned custom page artifact upload');
requireText('.github/workflows/ci.yml', 'dist/cmdbdynamicpages-custompage.zip', 'GitHub custom page artifact path');
requireText('.github/workflows/ci.yml', 'bash scripts/nginx-test.sh', 'GitHub nginx template gate');
requireText('.github/workflows/ci.yml', 'go test ./cmd/cmdp-d2-import', 'D2 importer test gate');
requireText('.github/workflows/ci.yml', "go-version: '1.25.11'", 'patched Go toolchain gate');
requireText('.github/workflows/ci.yml', 'govulncheck@v1.6.0', 'current Go vulnerability scanner gate');
requireText('.github/workflows/ci.yml', 'npm run test:ui:required', 'required browser UI gate');
requireText('.github/workflows/ci.yml', 'git status --porcelain --untracked-files=all', 'clean checkout proof before verified build');
requireText('.github/workflows/ci.yml', 'git rev-parse HEAD', 'GitHub checkout revision proof');
requireText('.github/workflows/ci.yml', 'docker compose --env-file .env.example -f docker-compose.runtime.yml config', 'runtime compose config gate');
requireText('.gitlab-ci.yml', 'node scripts/container-image.mjs build --tag "$CI_REGISTRY_IMAGE:$IMAGE_TAG" --require-clean', 'canonical GitLab verified Docker image build gate');
requireText('.gitlab-ci.yml', 'node scripts/container-image.mjs verify --image "$CI_REGISTRY_IMAGE:$IMAGE_TAG" --require-clean', 'GitLab whole-manifest Docker image verification gate');
requireText('.gitlab-ci.yml', 'docker push', 'Docker image push gate');
requireText('.gitlab-ci.yml', 'dist/cmdbdynamicpages-custompage.zip', 'GitLab custom page artifact path');
requirePattern('.gitlab-ci.yml', /npm_test:[\s\S]*?rules:[\s\S]*?CI_COMMIT_TAG[\s\S]*?script:/, 'npm test gate for tag pipelines');
requirePattern('.gitlab-ci.yml', /ui_smoke_required:[\s\S]*?rules:[\s\S]*?CI_COMMIT_TAG[\s\S]*?script:/, 'browser gate for tag pipelines');
requirePattern('.gitlab-ci.yml', /go_vulncheck:[\s\S]*?rules:[\s\S]*?CI_COMMIT_TAG[\s\S]*?script:/, 'vulnerability gate for tag pipelines');
requireText('.gitlab-ci.yml', 'apk add --no-cache bash git nodejs', 'GitLab helper dependencies');
requireText('.gitlab-ci.yml', 'git status --porcelain --untracked-files=all', 'GitLab clean checkout proof before verified build');
requireText('.gitlab-ci.yml', 'git rev-parse HEAD', 'GitLab checkout revision proof');
requireText('.gitlab-ci.yml', 'go test ./cmd/cmdp-d2-import', 'D2 importer test gate');
requireText('.gitlab-ci.yml', 'govulncheck@v1.6.0', 'current GitLab Go vulnerability scanner gate');
requireText('.gitlab-ci.yml', 'npm run test:ui:required', 'required browser UI gate');
requirePattern('.gitlab-ci.yml', /^\s*image:\s*node:20@sha256:[0-9a-f]{64}\s*$/m, 'digest-pinned Node test image');
requirePattern('.gitlab-ci.yml', /^\s*image:\s*node:20-bookworm@sha256:[0-9a-f]{64}\s*$/m, 'digest-pinned Node browser image');
requirePattern('.gitlab-ci.yml', /^\s*image:\s*golang:1\.25\.11-alpine@sha256:[0-9a-f]{64}\s*$/m, 'digest-pinned patched Go test image');
requirePattern('.gitlab-ci.yml', /^\s*image:\s*docker:27-cli@sha256:[0-9a-f]{64}\s*$/m, 'digest-pinned Docker CLI image');
requirePattern('.gitlab-ci.yml', /^\s*- name:\s*docker:27-dind@sha256:[0-9a-f]{64}\s*$/m, 'digest-pinned Docker DinD service image');
requireDigestPinnedReferences('.gitlab-ci.yml', /^\s*(?:image:|- name:)\s*((?:node|golang|docker):\S+)\s*$/gm, 'GitLab Node, Go, or Docker image references');
requireText('.gitlab-ci.yml', 'docker compose --env-file .env.example -f docker-compose.runtime.yml config', 'runtime compose config gate');
requireText('.gitlab-ci.yml', 'bash scripts/nginx-test.sh', 'nginx template syntax gate');

if (/CMDBDYNAMICPAGES_CSRF_SECRET=(?!replace-me\b).+/m.test(envExample)) {
  failures.push('.env.example: CSRF secret must be a placeholder, not a real value');
}

if (failures.length) {
  console.error('Container delivery validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('OK container delivery baseline checked.');
