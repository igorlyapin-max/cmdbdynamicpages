import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn, spawnSync } from 'node:child_process';

import {
  cmdbuildRequestCanRetry,
  cmdbuildRetryDelayMs,
  diagnosticModeAllows,
  executionThrottleScopeKey,
  expectedSpecHashFromBody,
  incMetric,
  isCmdbuildProxyPathAllowed,
  isJsonContentType,
  loggingStatus,
  normalizeDiagnosticMode,
  normalizeLogFormat,
  normalizeLogLevel,
  normalizeLogTargets,
  parsePublicOriginConfiguration,
  parseNameSet,
  redactByName,
  redisRequiredError,
  renderPrometheusMetrics,
  sanitizeTemplateCard,
  sanitizeHeaders,
  sanitizeRequestPath,
  sanitizeUrlForLog,
  setMetricGauge,
  securityHeaders,
  sameOriginMutationDecision,
  shouldRetryCmdbuildResult,
  validateRuntimeConfig,
  validateRegexPattern
} from '../../scripts/dev-proxy-server.mjs';

test('logging option normalizers keep only supported values', () => {
  assert.equal(normalizeLogLevel('debug'), 'debug');
  assert.equal(normalizeLogLevel('unknown'), 'info');
  assert.equal(normalizeLogFormat('text'), 'text');
  assert.equal(normalizeLogFormat('xml'), 'json');
  assert.deepEqual(normalizeLogTargets('stdout,syslog,stdout,bad'), ['stdout', 'syslog']);
  assert.deepEqual(normalizeLogTargets('syslog'), ['stdout', 'syslog']);
  assert.deepEqual(normalizeLogTargets('bad'), ['stdout']);
});

test('diagnostic mode normalizers expose Basic and Verbose levels', () => {
  assert.equal(normalizeDiagnosticMode('basic'), 'Basic');
  assert.equal(normalizeDiagnosticMode('Verbose'), 'Verbose');
  assert.equal(normalizeDiagnosticMode('unexpected'), 'off');
  assert.equal(diagnosticModeAllows('Basic', 'Basic'), true);
  assert.equal(diagnosticModeAllows('Verbose', 'Basic'), false);
  assert.equal(diagnosticModeAllows('Verbose', 'Verbose'), true);
  assert.equal(diagnosticModeAllows('Basic', 'off'), false);
});

test('public origin configuration accepts only a bare HTTP(S) origin', () => {
  assert.deepEqual(parsePublicOriginConfiguration('https://custom.example/'), {
    configured: true,
    valid: true,
    origin: 'https://custom.example',
    reason: ''
  });
  assert.equal(parsePublicOriginConfiguration('https://custom.example/cmdbuild').valid, false);
  assert.equal(parsePublicOriginConfiguration('https://user:password@custom.example').valid, false);
  assert.equal(parsePublicOriginConfiguration('ftp://custom.example').valid, false);
  assert.deepEqual(parsePublicOriginConfiguration(''), {
    configured: false,
    valid: true,
    origin: '',
    reason: ''
  });
});

test('same-origin mutation checks use the configured public origin, not the upstream host', () => {
  const request = { headers: { host: 'vr2.internal.example', origin: 'https://custom.example' } };
  const accepted = sameOriginMutationDecision(request, 'https://custom.example');

  assert.deepEqual(accepted, {
    allowed: true,
    expectedOrigin: 'https://custom.example',
    source: 'origin',
    reason: 'matched'
  });

  const rejected = sameOriginMutationDecision({ headers: { host: 'custom.example', origin: 'https://vr2.internal.example' } }, 'https://custom.example');
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.source, 'origin');
  assert.equal(rejected.reason, 'origin_mismatch');

  const schemeMismatch = sameOriginMutationDecision({ headers: { host: 'custom.example', origin: 'http://custom.example' } }, 'https://custom.example');
  assert.equal(schemeMismatch.allowed, false);
  assert.equal(schemeMismatch.reason, 'origin_mismatch');

  const originTakesPrecedence = sameOriginMutationDecision({
    headers: {
      origin: 'https://vr2.internal.example',
      referer: 'https://custom.example/cmdbuild/dynamicpages/ui/designer'
    }
  }, 'https://custom.example');
  assert.equal(originTakesPrecedence.allowed, false);
  assert.equal(originTakesPrecedence.source, 'origin');

  const refererFallback = sameOriginMutationDecision({ headers: { referer: 'https://custom.example/cmdbuild/dynamicpages/ui/designer' } }, 'https://custom.example');
  assert.equal(refererFallback.allowed, true);
  assert.equal(refererFallback.source, 'referer');

  const missing = sameOriginMutationDecision({ headers: {} }, 'https://custom.example');
  assert.equal(missing.reason, 'headers_missing');
});

test('redaction helpers mask configured header and query names', () => {
  const redactSet = parseNameSet('cookie,authorization,token');

  assert.equal(redactByName('Authorization', 'secret', redactSet), '[REDACTED]');
  assert.equal(redactByName('city', 'city49', redactSet), 'city49');
});

test('request path sanitizer redacts configured query secrets', () => {
  const path = sanitizeRequestPath(new URL('http://127.0.0.1:8093/cmdbuild/custom-api/templates?token=secret&city=city49&password=pwd'));

  assert.match(path, /^\/cmdbuild\/custom-api\/templates\?/);
  assert.match(path, /city=city49/);
  assert.match(path, /token=%5BREDACTED%5D/);
  assert.match(path, /password=%5BREDACTED%5D/);
  assert.doesNotMatch(path, /secret/);
  assert.doesNotMatch(path, /pwd/);
});

test('header sanitizer masks credentials and referer query secrets', () => {
  const headers = sanitizeHeaders({
    Authorization: 'secret-token',
    Referer: 'http://127.0.0.1:8093/cmdbuild/ui/?token=secret&city=city49',
    'User-Agent': 'unit-test'
  });

  assert.equal(headers.Authorization, '[REDACTED]');
  assert.match(headers.Referer, /city=city49/);
  assert.match(headers.Referer, /token=%5BREDACTED%5D/);
  assert.doesNotMatch(headers.Referer, /secret/);
  assert.equal(headers['User-Agent'], 'unit-test');
});

test('logging status is diagnostic and does not expose secret values', () => {
  const status = loggingStatus();

  assert.equal(typeof status.level, 'string');
  assert.equal(typeof status.format, 'string');
  assert.ok(Array.isArray(status.targets));
  assert.ok(Array.isArray(status.redactHeaders));
  assert.ok(Array.isArray(status.redactQuery));
  assert.equal(typeof status.diagnostic.mode, 'string');
  assert.deepEqual(status.diagnostic.levels, ['Basic', 'Verbose']);
  assert.equal(typeof status.publicOrigin.configured, 'boolean');
  assert.equal(typeof status.publicOrigin.mode, 'string');
  assert.equal(status.assistant.enabled, false);
  assert.equal(status.assistant.provider, 'litellm');
  assert.equal(status.assistant.apiKeyConfigured, false);
  assert.ok(status.syslog === null || typeof status.syslog === 'object');
  assert.equal(status.elk.directOutput, false);
  assert.match(status.elk.recommendedPipeline, /stdout\/syslog/);
});

test('runtime config validation fails closed for production CSRF secret', () => {
  const invalid = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: '',
    logTargets: ['stdout'],
    publicOrigin: 'https://custom.example',
    diagnosticMode: 'off'
  });

  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors.map((item) => item.code), ['csrf_secret_required', 'syslog_log_target_required']);

  const placeholder = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'replace-me',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 514,
    publicOrigin: 'https://custom.example',
    diagnosticMode: 'off'
  });

  assert.equal(placeholder.ok, false);
  assert.deepEqual(placeholder.errors.map((item) => item.code), ['csrf_secret_placeholder']);

  const missingSyslog = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'syslog.example.local',
    syslogPort: 514,
    publicOrigin: 'https://custom.example',
    diagnosticMode: 'off'
  });

  assert.equal(missingSyslog.ok, false);
  assert.deepEqual(missingSyslog.errors.map((item) => item.code), ['syslog_configuration_required']);

  const invalidSyslogPort = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 0,
    publicOrigin: 'https://custom.example',
    diagnosticMode: 'off'
  });

  assert.equal(invalidSyslogPort.ok, false);
  assert.deepEqual(invalidSyslogPort.errors.map((item) => item.code), ['syslog_configuration_required']);

  const valid = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 514,
    publicOrigin: 'https://custom.example',
    diagnosticMode: 'Verbose'
  });

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.warnings.map((item) => item.code), ['verbose_diagnostic_in_production']);
  assert.equal(valid.assistant.enabled, false);
  assert.equal(valid.assistant.apiKeyConfigured, false);

  const missingPublicOrigin = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 514,
    publicOrigin: '',
    diagnosticMode: 'off'
  });
  assert.deepEqual(missingPublicOrigin.errors.map((item) => item.code), ['public_origin_required']);

  const invalidPublicOrigin = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 514,
    publicOrigin: 'https://custom.example/cmdbuild',
    diagnosticMode: 'off'
  });
  assert.deepEqual(invalidPublicOrigin.errors.map((item) => item.code), ['public_origin_invalid']);
});

test('production startup delivers structured app.started to the configured UDP syslog collector', async (t) => {
  const collector = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      collector.once('error', reject);
      collector.bind(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    collector.close();
    if (error && error.code === 'EPERM') {
      t.skip('UDP sockets are not permitted by this execution sandbox.');
      return;
    }
    throw error;
  }
  const address = collector.address();
  let backend = null;
  t.after(async () => {
    collector.close();
    if (!backend || backend.exitCode !== null) return;
    backend.kill('SIGTERM');
    await new Promise((resolve) => backend.once('exit', resolve));
  });

  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the syslog startup event.')), 5000);
    collector.once('message', (packet) => {
      clearTimeout(timer);
      resolve(packet.toString('utf8'));
    });
  });
  // Start after registering the collector listener so the first structured
  // startup event is part of the delivery contract, not a timing accident.
  backend = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: '0',
      CMDBUILD_ORIGIN: 'http://127.0.0.1:8090',
      CMDBDYNAMICPAGES_CSRF_SECRET: 'production-test-secret',
      CMDP_PUBLIC_ORIGIN: 'https://custom.example',
      CMDP_LOG_TARGET: 'stdout,syslog',
      CMDP_LOG_LEVEL: 'info',
      CMDP_SYSLOG_HOST: '127.0.0.1',
      CMDP_SYSLOG_PORT: String(address.port),
      CMDP_SYSLOG_PROTOCOL: 'udp',
      CMDP_D2_RENDER_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const packet = await message;
  assert.match(packet, /app\.started/);
  assert.match(packet, /"service":"cmdbdynamicpages"/);
});

test('URL log sanitizer redacts sensitive query parameters', () => {
  const redacted = sanitizeUrlForLog('http://example.local/ui?token=secret&plain=value#fragment');

  assert.match(redacted, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.match(redacted, /plain=value/);
  assert.doesNotMatch(redacted, /secret/);
  assert.doesNotMatch(redacted, /fragment/);
});

test('missing optional LiteLLM secret file does not fail module import', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./scripts/dev-proxy-server.mjs').then(() => process.exit(0)).catch((error) => { console.error(error && error.stack || error); process.exit(1); });"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LITELLM_API_KEY: '',
      CMDP_LITELLM_API_KEY: '',
      LITELLM_API_KEY_FILE: '/tmp/cmdbdynamicpages-missing-litellm-key',
      CMDP_LITELLM_API_KEY_FILE: '',
      CMDBDYNAMIC_REDIS_PASSWORD_FILE: '',
      REDIS_PASSWORD_FILE: '',
      CMDP_LOG_LEVEL: 'silent'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
});

test('security headers are iframe-safe by default', () => {
  const headers = securityHeaders();

  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'same-origin');
  assert.match(headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['strict-transport-security'], undefined);
});

test('JSON content type helper accepts only JSON media types', () => {
  assert.equal(isJsonContentType('application/json'), true);
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType('application/vnd.api+json'), true);
  assert.equal(isJsonContentType('text/plain'), false);
  assert.equal(isJsonContentType(''), false);
});

test('CMDBuild proxy allowlist keeps UI and REST paths narrow', () => {
  assert.equal(isCmdbuildProxyPathAllowed('/cmdbuild', true), true);
  assert.equal(isCmdbuildProxyPathAllowed('/cmdbuild/ui/', true), true);
  assert.equal(isCmdbuildProxyPathAllowed('/cmdbuild/services/rest/v3/classes', true), true);
  assert.equal(isCmdbuildProxyPathAllowed('/cmdbuild/services', true), false);
  assert.equal(isCmdbuildProxyPathAllowed('/cmdbuild/manager/html', true), false);
  assert.equal(isCmdbuildProxyPathAllowed('/', true), false);
  assert.equal(isCmdbuildProxyPathAllowed('/cmdbuild/manager/html', false), true);
});

test('CMDBuild retry helpers only retry safe transient requests by default', () => {
  assert.equal(cmdbuildRequestCanRetry('GET'), true);
  assert.equal(cmdbuildRequestCanRetry('POST'), false);
  assert.equal(cmdbuildRequestCanRetry('POST', true), true);
  assert.equal(shouldRetryCmdbuildResult({ statusCode: 503 }), true);
  assert.equal(shouldRetryCmdbuildResult({ statusCode: 403 }), false);
  assert.equal(cmdbuildRetryDelayMs(2, 100, 1000, 0), 200);
});

test('execution throttle scope hashes authorization material', () => {
  const key = executionThrottleScopeKey({
    authToken: 'secret-token',
    action: 'run',
    templateCode: 'NetView'
  });

  assert.match(key, /^run\|NetView\|[a-f0-9]{16}$/);
  assert.doesNotMatch(key, /secret-token/);
});

test('Prometheus renderer escapes labels and emits metric metadata', () => {
  incMetric('cmdp_http_requests_total', { route: 'unit"route', method: 'GET', status: '2xx' });
  setMetricGauge('cmdp_health_ready', {}, 1);
  const body = renderPrometheusMetrics();

  assert.match(body, /# TYPE cmdp_http_requests_total counter/);
  assert.match(body, /cmdp_http_requests_total\{method="GET",route="unit\\"route",status="2xx"\} 1/);
  assert.match(body, /cmdp_health_ready 1/);
});

test('Redis required errors are explicit service-unavailable failures', () => {
  const error = redisRequiredError(new Error('connect ECONNREFUSED'), 'read', 'runtime');

  assert.equal(error.statusCode, 503);
  assert.equal(error.redisRequired, true);
  assert.match(error.message, /Redis is required for runtime cache read/);
});

test('regex guard rejects oversized and nested-quantifier patterns', () => {
  assert.deepEqual(validateRegexPattern('^router-[0-9]+$', '', '$.regex'), []);
  assert.match(validateRegexPattern('(a+)+$', '', '$.regex')[0].message, /nested quantifiers/);
  assert.match(validateRegexPattern('x'.repeat(600), '', '$.regex')[0].message, /exceeds/);
});

test('template cards expose stable specHash and expected hash is opt-in', () => {
  const card = sanitizeTemplateCard({
    _id: 42,
    Code: 'NetView',
    Description: 'Net view',
    Active: true,
    SpecJson: { version: 1, steps: [{ type: 'listDomains', as: 'domains' }] }
  });

  assert.match(card.specHash, /^[a-f0-9]{64}$/);
  assert.equal(expectedSpecHashFromBody({ expectedSpecHash: card.specHash }), card.specHash);
  assert.equal(expectedSpecHashFromBody({}), '');
});
