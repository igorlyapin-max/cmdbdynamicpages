import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cmdbuildRequestCanRetry,
  cmdbuildRetryDelayMs,
  executionThrottleScopeKey,
  expectedSpecHashFromBody,
  incMetric,
  isCmdbuildProxyPathAllowed,
  isJsonContentType,
  loggingStatus,
  normalizeLogFormat,
  normalizeLogLevel,
  normalizeLogTargets,
  parseNameSet,
  redactByName,
  redisRequiredError,
  renderPrometheusMetrics,
  sanitizeTemplateCard,
  sanitizeRequestPath,
  setMetricGauge,
  securityHeaders,
  shouldRetryCmdbuildResult,
  validateRegexPattern
} from '../../scripts/dev-proxy-server.mjs';

test('logging option normalizers keep only supported values', () => {
  assert.equal(normalizeLogLevel('debug'), 'debug');
  assert.equal(normalizeLogLevel('unknown'), 'info');
  assert.equal(normalizeLogFormat('text'), 'text');
  assert.equal(normalizeLogFormat('xml'), 'json');
  assert.deepEqual(normalizeLogTargets('stdout,syslog,stdout,bad'), ['stdout', 'syslog']);
  assert.deepEqual(normalizeLogTargets('bad'), ['stdout']);
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

test('logging status is diagnostic and does not expose secret values', () => {
  const status = loggingStatus();

  assert.equal(typeof status.level, 'string');
  assert.equal(typeof status.format, 'string');
  assert.ok(Array.isArray(status.targets));
  assert.ok(Array.isArray(status.redactHeaders));
  assert.ok(Array.isArray(status.redactQuery));
  assert.equal(status.elk.directOutput, false);
  assert.match(status.elk.recommendedPipeline, /stdout\/syslog/);
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
