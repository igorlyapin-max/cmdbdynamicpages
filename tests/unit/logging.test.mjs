import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loggingStatus,
  normalizeLogFormat,
  normalizeLogLevel,
  normalizeLogTargets,
  parseNameSet,
  redactByName,
  sanitizeRequestPath
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
