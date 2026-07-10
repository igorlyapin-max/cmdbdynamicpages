import fs from 'node:fs';

const requiredFiles = [
  '.env.example',
  'Dockerfile',
  'docker-compose.runtime.yml',
  'docker-compose.nginx.yml',
  'docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md'
];

const requiredEnv = [
  'CMDBDYNAMIC_IMAGE',
  'NODE_ENV',
  'PROXY_HOST',
  'PROXY_PORT',
  'CMDBUILD_ORIGIN',
  'CMDBDYNAMIC_REDIS_URL',
  'CMDBDYNAMIC_REDIS_PASSWORD_FILE',
  'CMDBDYNAMIC_REDIS_PASSWORD_FILE_HOST',
  'CMDBDYNAMIC_REDIS_REQUIRED',
  'CMDBDYNAMIC_HEALTH_REDIS_REQUIRED',
  'CMDBDYNAMICPAGES_CSRF_SECRET',
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
  'LITELLM_API_KEY_FILE_HOST',
  'CMDP_LOG_TARGET',
  'CMDP_EXTERNAL_LOG_SINK',
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

function rejectPattern(file, regex, label) {
  const body = read(file);
  if (regex.test(body)) failures.push(`${file}: contains forbidden ${label}`);
}

requiredFiles.forEach((file) => {
  if (!fs.existsSync(file)) failures.push(`${file}: missing required delivery file`);
});

const envExample = read('.env.example');
requiredEnv.forEach((name) => {
  if (!new RegExp(`^${name}=`, 'm').test(envExample)) {
    failures.push(`.env.example: missing ${name}`);
  }
});

rejectPattern('docker-compose.runtime.yml', /^\s*build\s*:/m, 'build directive');
rejectPattern('docker-compose.nginx.yml', /^\s*build\s*:/m, 'build directive');
requireText('docker-compose.runtime.yml', 'image: ${CMDBDYNAMIC_IMAGE}', 'prebuilt image reference');
requireText('docker-compose.runtime.yml', '/health/live', 'container healthcheck');
requireText('docker-compose.runtime.yml', 'LITELLM_API_KEY_FILE', 'LiteLLM assistant secret file wiring');
requireText('docker-compose.runtime.yml', 'CMDP_EXTERNAL_LOG_SINK', 'external log sink wiring');
requireText('docker-compose.runtime.yml', 'CMDP_LITELLM_ALLOWED_BASE_URLS', 'LiteLLM base URL allowlist wiring');
requireText('docker-compose.runtime.yml', 'CMDP_D2_RENDER_ENABLED', 'D2 render wiring');
requireText('docker-compose.runtime.yml', 'CMDP_D2_MAX_DIAGRAMS', 'D2 max diagrams wiring');
requireText('docker-compose.runtime.yml', 'CMDP_D2_CONCURRENCY', 'D2 render concurrency wiring');
requireText('Dockerfile', 'HEALTHCHECK', 'Docker HEALTHCHECK');
requireText('Dockerfile', 'USER node', 'non-root runtime user');
requireText('Dockerfile', 'd2-v${D2_VERSION}', 'pinned D2 binary download');
requireText('Dockerfile', 'sha256sum -c -', 'D2 checksum validation');

[
  'private registry',
  'CA/cert',
  'DNS',
  'firewall',
  'PAM',
  '/health/ready',
  '/metrics',
  'CMDP_EXTERNAL_LOG_SINK',
  'CMDP_LITELLM_ALLOWED_BASE_URLS',
  'CMDP_D2_RENDER_ENABLED',
  'CMDP_D2_MAX_DIAGRAMS',
  'CMDP_D2_CONCURRENCY',
  'CMDP_DIAGNOSTIC_MODE=off'
].forEach((text) => requireText('docs/CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md', text));

requireText('.github/workflows/ci.yml', 'docker build', 'Docker image build gate');
requireText('.github/workflows/ci.yml', 'docker push', 'Docker image push gate');
requireText('.github/workflows/ci.yml', 'docker compose --env-file .env.example -f docker-compose.runtime.yml config', 'runtime compose config gate');
requireText('.gitlab-ci.yml', 'docker build', 'Docker image build gate');
requireText('.gitlab-ci.yml', 'docker push', 'Docker image push gate');
requireText('.gitlab-ci.yml', 'docker compose --env-file .env.example -f docker-compose.runtime.yml config', 'runtime compose config gate');

if (/CMDBDYNAMICPAGES_CSRF_SECRET=(?!replace-me\b).+/m.test(envExample)) {
  failures.push('.env.example: CSRF secret must be a placeholder, not a real value');
}

if (/^CMDP_EXTERNAL_LOG_SINK=(docker-logging-driver-or-collector|replace-me|changeme|change-me|placeholder|example)\b/im.test(envExample)) {
  failures.push('.env.example: CMDP_EXTERNAL_LOG_SINK must be blank or a real deployment sink, not a fake working placeholder');
}

if (failures.length) {
  console.error('Container delivery validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('OK container delivery baseline checked.');
