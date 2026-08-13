import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cmdbuildRequestCanRetry,
  cmdbuildRetryDelayMs,
  diagnosticModeAllows,
  executionThrottleScopeKey,
  ensureAssistantStatusReady,
  expectedSpecHashFromBody,
  incMetric,
  isCmdbuildProxyPathAllowed,
  isJsonContentType,
  loggingStatus,
  normalizeDiagnosticMode,
  normalizeLogFormat,
  normalizeLogLevel,
  normalizeLogTargets,
  parseRedisUrl,
  parsePublicOriginConfiguration,
  parseNameSet,
  redactByName,
  readOptionalSecretValue,
  redisRequiredError,
  redisTransportSecurity,
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

test('Redis URL configuration distinguishes TLS and plaintext transports', () => {
  const parsed = parseRedisUrl('rediss://:encoded%2Dpassword@redis.example:6380/2');
  assert.equal(parsed.host, 'redis.example');
  assert.equal(parsed.port, 6380);
  assert.equal(parsed.password, 'encoded-password');
  assert.equal(parsed.db, 2);
  assert.equal(parsed.tls, true);
  assert.equal(typeof parsed.tlsCaFile, 'string');
  assert.equal(redisTransportSecurity('redis://redis.example:6379/0').transport, 'plaintext');
  assert.equal(redisTransportSecurity('rediss://redis.example:6380/0').transport, 'tls');
  assert.throws(() => parseRedisUrl('https://redis.example:6380/0'), /redis:\/\/ or rediss:\/\//);
});

test('runtime configuration requires one readable shared CA bundle for Node and Redis TLS', () => {
  const certificateDirectory = mkdtempSync(join(tmpdir(), 'cmdbdynamicpages-tls-config-'));
  const certificatePath = join(certificateDirectory, 'customer-ca.pem');
  writeFileSync(certificatePath, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');
  try {
    const valid = validateRuntimeConfig({
      nodeEnv: 'development',
      redisEnabled: false,
      tlsCaFile: certificatePath,
      nodeExtraCaCerts: certificatePath
    });
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.tls, { configured: true, readable: true });

    const mismatched = validateRuntimeConfig({
      nodeEnv: 'development',
      redisEnabled: false,
      tlsCaFile: certificatePath,
      nodeExtraCaCerts: ''
    });
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.errors.some((item) => item.code === 'tls_ca_bundle_contract_invalid'));

    const inheritedBaseTrust = validateRuntimeConfig({
      nodeEnv: 'development',
      redisEnabled: false,
      tlsCaFile: '',
      nodeExtraCaCerts: certificatePath,
      logTargets: ['stdout']
    });
    assert.equal(inheritedBaseTrust.ok, true);
    assert.deepEqual(inheritedBaseTrust.tls, { configured: true, readable: true });

    const unreadable = validateRuntimeConfig({
      nodeEnv: 'development',
      redisEnabled: false,
      tlsCaFile: join(certificateDirectory, 'missing.pem'),
      nodeExtraCaCerts: join(certificateDirectory, 'missing.pem')
    });
    assert.equal(unreadable.ok, false);
    assert.ok(unreadable.errors.some((item) => item.code === 'tls_ca_bundle_invalid'));
  } finally {
    rmSync(certificateDirectory, { recursive: true, force: true });
  }
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
  assert.equal(status.assistant.apiKeyState, 'missing');
  assert.equal(status.assistant.apiKeyErrorCode, '');
  assert.ok(status.syslog === null || typeof status.syslog === 'object');
  assert.equal(status.elk.directOutput, false);
  assert.equal(status.elk.recommendedPipeline, 'stdout -> platform collector/agent/sidecar -> configured log backend');
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
  assert.deepEqual(invalid.errors.map((item) => item.code), ['csrf_secret_required']);

  const stdoutOnly = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout'],
    publicOrigin: 'https://custom.example',
    diagnosticMode: 'off'
  });

  assert.equal(stdoutOnly.ok, true);
  assert.deepEqual(stdoutOnly.errors, []);

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
    redisUrl: 'rediss://redis.example:6380/0',
    diagnosticMode: 'Verbose'
  });

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.warnings.map((item) => item.code), ['verbose_diagnostic_in_production']);
  assert.equal(valid.assistant.enabled, false);
  assert.equal(valid.assistant.apiKeyConfigured, false);

  const plaintextRedis = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 514,
    publicOrigin: 'https://custom.example',
    redisUrl: 'redis://redis.example:6379/0',
    diagnosticMode: 'off'
  });
  assert.equal(plaintextRedis.ok, true);
  assert.equal(plaintextRedis.redis.transport, 'plaintext');
  assert.ok(plaintextRedis.warnings.some((item) => item.code === 'redis_plaintext_transport'));

  const invalidRedis = validateRuntimeConfig({
    nodeEnv: 'production',
    csrfSecret: 'externally-managed-secret',
    logTargets: ['stdout', 'syslog'],
    syslogHost: 'collector.internal.example',
    syslogPort: 514,
    publicOrigin: 'https://custom.example',
    redisUrl: 'https://redis.example:6380/0',
    diagnosticMode: 'off'
  });
  assert.equal(invalidRedis.ok, false);
  assert.ok(invalidRedis.errors.some((item) => item.code === 'redis_url_invalid'));

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

test('Redis TLS transport accepts a configured private CA', async (t) => {
  const certificateDirectory = mkdtempSync(join(tmpdir(), 'cmdbdynamicpages-redis-tls-'));
  const keyPath = join(certificateDirectory, 'redis-key.pem');
  const certificatePath = join(certificateDirectory, 'redis-cert.pem');
  let redisServer = null;
  let backend = null;
  try {
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath,
        '-out', certificatePath,
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
        '-days', '1'
      ], { stdio: 'ignore' });
    } catch {
      t.skip('OpenSSL is required to generate the temporary Redis TLS certificate.');
      return;
    }

    redisServer = tls.createServer({
      key: readFileSync(keyPath),
      cert: readFileSync(certificatePath)
    }, (socket) => {
      socket.on('data', () => socket.write('+PONG\r\n'));
    });
    try {
      await listen(redisServer);
    } catch (error) {
      if (error && error.code === 'EPERM') {
        t.skip('TCP sockets are not permitted by this execution sandbox.');
        return;
      }
      throw error;
    }
    const redisPort = redisServer.address().port;
    const proxyPort = await availablePort();
    backend = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PROXY_HOST: '127.0.0.1',
        PROXY_PORT: String(proxyPort),
        CMDP_PUBLIC_ORIGIN: `http://127.0.0.1:${proxyPort}`,
        CMDBDYNAMIC_REDIS_URL: `rediss://127.0.0.1:${redisPort}/0`,
        CMDP_TLS_CA_FILE: certificatePath,
        NODE_EXTRA_CA_CERTS: certificatePath,
        CMDBDYNAMIC_REDIS_REQUIRED: 'false',
        CMDP_D2_RENDER_ENABLED: 'false',
        CMDP_LOG_TARGET: 'stdout'
      },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const status = await waitForJson(`http://127.0.0.1:${proxyPort}/health/redis`);
    assert.equal(status.response.status, 200, JSON.stringify(status.json));
    assert.equal(status.json.redis.backend, 'redis');
    assert.equal(status.json.redis.available, true);
    assert.deepEqual(status.json.redis.transportSecurity, { transport: 'tls', caConfigured: true });
  } finally {
    if (backend && backend.exitCode === null) {
      backend.kill('SIGTERM');
      await new Promise((resolve) => backend.once('exit', resolve));
    }
    if (redisServer && redisServer.listening) await new Promise((resolve) => redisServer.close(resolve));
    rmSync(certificateDirectory, { recursive: true, force: true });
  }
});

test('CMDBuild HTTPS health probe trusts the configured shared CA bundle', async (t) => {
  const certificateDirectory = mkdtempSync(join(tmpdir(), 'cmdbdynamicpages-cmdbuild-tls-'));
  const keyPath = join(certificateDirectory, 'cmdbuild-key.pem');
  const certificatePath = join(certificateDirectory, 'cmdbuild-cert.pem');
  let cmdbuildServer = null;
  let backend = null;
  try {
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath,
        '-out', certificatePath,
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
        '-days', '1'
      ], { stdio: 'ignore' });
    } catch {
      t.skip('OpenSSL is required to generate the temporary CMDBuild TLS certificate.');
      return;
    }
    cmdbuildServer = tls.createServer({
      key: readFileSync(keyPath),
      cert: readFileSync(certificatePath)
    }, (socket) => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{"success":true}');
      });
    });
    try {
      await listen(cmdbuildServer);
    } catch (error) {
      if (error && error.code === 'EPERM') {
        t.skip('TCP sockets are not permitted by this execution sandbox.');
        return;
      }
      throw error;
    }
    const cmdbuildPort = cmdbuildServer.address().port;
    const proxyPort = await availablePort();
    backend = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PROXY_HOST: '127.0.0.1',
        PROXY_PORT: String(proxyPort),
        CMDP_PUBLIC_ORIGIN: `http://127.0.0.1:${proxyPort}`,
        CMDBUILD_ORIGIN: `https://127.0.0.1:${cmdbuildPort}`,
        CMDP_TLS_CA_FILE: certificatePath,
        NODE_EXTRA_CA_CERTS: certificatePath,
        CMDBDYNAMIC_REDIS_ENABLED: 'false',
        CMDP_D2_RENDER_ENABLED: 'false',
        CMDP_D2_IMPORT_BINARY: join(process.cwd(), 'tests/fixtures/d2-import-stub.mjs'),
        CMDP_LOG_TARGET: 'stdout'
      },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const status = await waitForJson(`http://127.0.0.1:${proxyPort}/health/ready`);
    assert.ok([200, 503].includes(status.response.status), JSON.stringify(status.json));
    const cmdbuild = status.json && status.json.checks && status.json.checks.cmdbuild;
    assert.ok(cmdbuild, JSON.stringify(status.json));
    assert.equal(cmdbuild.ok, true);
    assert.equal(cmdbuild.status, 'ok');
  } finally {
    if (backend && backend.exitCode === null) {
      backend.kill('SIGTERM');
      await new Promise((resolve) => backend.once('exit', resolve));
    }
    if (cmdbuildServer && cmdbuildServer.listening) await new Promise((resolve) => cmdbuildServer.close(resolve));
    rmSync(certificateDirectory, { recursive: true, force: true });
  }
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
    const timer = setTimeout(() => {
      collector.off('message', onMessage);
      reject(new Error('Timed out waiting for the syslog startup event.'));
    }, 5000);
    const onMessage = (packet) => {
      const value = packet.toString('utf8');
      if (!value.includes('app.started')) return;
      clearTimeout(timer);
      collector.off('message', onMessage);
      resolve(value);
    };
    collector.on('message', onMessage);
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

test('optional LiteLLM secret reader distinguishes missing, invalid, and direct values', () => {
  const secretDirectory = mkdtempSync(join(tmpdir(), 'cmdbdynamicpages-litellm-secret-dir-'));
  try {
    assert.deepEqual(readOptionalSecretValue('', '/tmp/cmdbdynamicpages-missing-litellm-key'), {
      value: '', state: 'missing', errorCode: ''
    });
    assert.deepEqual(readOptionalSecretValue('', secretDirectory), {
      value: '', state: 'invalid_file', errorCode: 'EISDIR'
    });
    assert.deepEqual(readOptionalSecretValue('test-direct-value', secretDirectory), {
      value: 'test-direct-value', state: 'configured', errorCode: ''
    });
  } finally {
    rmSync(secretDirectory, { recursive: true, force: true });
  }
});

test('invalid optional LiteLLM secret produces a controlled Assistant error', () => {
  assert.throws(
    () => ensureAssistantStatusReady({ enabled: true, baseUrlAllowed: true, apiKeyState: 'invalid_file' }),
    (error) => {
      assert.equal(error.code, 'assistant_secret_file_invalid');
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, 'LiteLLM API key secret file is invalid.');
      return true;
    }
  );
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  await listen(server);
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const json = await response.json();
      return { response, json };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}.`);
}
