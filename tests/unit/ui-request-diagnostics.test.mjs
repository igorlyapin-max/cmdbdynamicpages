import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';

const api = createUiRequestDiagnostics();
const context = {
  path: 'https://user:password@example.invalid/api/template?token=hidden#secret',
  method: 'post', requestId: 'client-123', startedAt: Date.now() - 10,
  timeoutMs: 12000, attempt: 2, action: 'mapping', phase: 'roles', blockName: 'Network',
  owner: { templateCode: 'sample', section: 'diagram', generation: 3, revision: 7 }
};
const result = (json, extra = {}) => ({ status: 502, ok: false, json, body: '', contentType: 'application/json', requestId: 'server-456', ...extra });

test('diagnostic ownership rejects stale template, section, revision, generation and runtime', () => {
  const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
  const state = { selectedTemplate: { code: 'sample' }, designerSection: 'assistant', uiDiagnosticGeneration: 2, uiDiagnosticRevision: 4 };
  const boot = { mode: 'designer' };
  const sandbox = vm.createContext({ state, boot });
  for (const name of ['uiRequestOwner', 'uiDiagnosticIsCurrent']) {
    const start = source.indexOf('  function ' + name + '(');
    const end = source.indexOf('\n  }', start) + 4;
    vm.runInContext(source.slice(start, end), sandbox);
  }
  const diagnostic = { owner: { templateCode: 'sample', section: 'assistant', generation: 2, revision: 4 } };
  assert.equal(sandbox.uiDiagnosticIsCurrent(diagnostic), true);
  for (const [key, value] of [['templateCode', 'other'], ['section', 'run'], ['generation', 3], ['revision', 5]]) {
    assert.equal(sandbox.uiDiagnosticIsCurrent({ owner: { ...diagnostic.owner, [key]: value } }), false, key);
  }
  state.designerSection = 'run';
  assert.equal(sandbox.uiDiagnosticIsCurrent({ owner: { ...diagnostic.owner, displaySection: 'run' } }), true);
  boot.mode = 'runtime';
  assert.equal(sandbox.uiDiagnosticIsCurrent(diagnostic), false);
});

test('a client fallback request ID is not presented as a server confirmation', () => {
  const diagnostic = api.response(result({}, { requestId: 'client-123', serverRequestId: '' }), context);
  assert.equal(diagnostic.serverRequestId, '');
  assert.equal(diagnostic.clientRequestId, 'client-123');
});

test('JSON 502 preserves approved error and limit metadata, not arbitrary payload', () => {
  const diagnostic = api.response(result({
    code: 'litellm_error', message: 'Gateway unavailable',
    errors: [{ kind: 'semanticPlanContextIncomplete', reason: 'timeout', blockName: 'Network', prompt: 'hidden', stack: 'hidden' }],
    diagnostics: { limits: [{ limitName: 'maxClasses', effectiveLimit: 42, limitHit: true, token: 'hidden' }], spec: 'hidden' },
    prompt: 'hidden', body: 'hidden', Spec: 'hidden'
  }), context);
  assert.equal(diagnostic.status, 502);
  assert.equal(diagnostic.contentType, 'application/json');
  assert.equal(diagnostic.code, 'litellm_error');
  assert.equal(diagnostic.message, 'Gateway unavailable');
  assert.equal(diagnostic.path, '/api/template');
  assert.equal(diagnostic.method, 'POST');
  assert.equal(diagnostic.clientRequestId, 'client-123');
  assert.equal(diagnostic.serverRequestId, 'server-456');
  assert.equal(diagnostic.clientTimeoutMs, 12000);
  assert.equal(diagnostic.attempt, 2);
  assert.ok(diagnostic.durationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(diagnostic.time)));
  assert.equal(diagnostic.retryable, true);
  assert.deepEqual(diagnostic.owner, context.owner);
  assert.deepEqual(diagnostic.diagnostics.limits, [{ limitName: 'maxClasses', effectiveLimit: 42, limitHit: true }]);
  assert.doesNotMatch(api.serialize(diagnostic), /hidden|password|example\.invalid|token|prompt|stack|Spec/);
});

test('HTML is inert plain text, strips attribute and script secrets, never infers source', () => {
  const diagnostic = api.response(result(undefined, {
    body: '<html><body><h1>502 Bad Gateway</h1><input value="secret"><script>secret</script></body></html>',
    contentType: 'text/html'
  }), context);
  assert.equal(diagnostic.responseFormat, 'html');
  assert.equal(diagnostic.contentType, 'text/html');
  assert.match(diagnostic.responseExcerpt, /<h1>502 Bad Gateway<\/h1>/);
  assert.doesNotMatch(diagnostic.responseExcerpt, /secret|value=|<script>/);
  assert.equal(diagnostic.code, 'http_error');
  assert.equal(diagnostic.message, 'Request failed');
});

test('validation detail identifiers, schema paths, operators and limits survive the safe projection', () => {
  const detail = {
    kind: 'semanticPlanRelationPredicateUnconfirmed', blockId: 'networks', comparisonBlockId: 'acls',
    sourceClass: 'Network', comparisonClass: 'ACL', targetClass: 'IpAddress',
    path: '$.blocks[0].relationPredicates[1]', sourcePath: ['Provider', 'Email'],
    comparisonPath: [{ sourceClass: 'Network', targetClass: 'ACL', domain: 'NetworkAcl', direction: 'source', Spec: { secret: 'hidden' } }],
    paths: ['$.operations[0].operator'], predicateIndex: 1, operator: 'unsupported',
    supportedOperators: ['equals', 'contains', { prompt: 'hidden' }],
    sourceFields: ['Code'], comparisonFields: ['Name'], availableDependencyIds: ['acls'],
    sourceAlias: 'internal_result_1', aliases: ['internal_result_1'],
    limit: { limitName: 'maxItems', effectiveLimit: 16, actualCount: 20, body: 'hidden' },
    maxItems: 16, actualItems: 20, rejectedFlow: { prompt: 'hidden' }, arbitrary: { code: 'hidden' },
    value: 'hidden', Spec: { prompt: 'hidden' }
  };
  const diagnostic = api.response(result({ errors: [detail] }), context);
  const safeDetail = diagnostic.errors[0];
  for (const key of ['comparisonBlockId', 'blockId', 'sourceClass', 'comparisonClass', 'path', 'sourcePath', 'paths', 'predicateIndex', 'operator', 'sourceFields', 'comparisonFields', 'availableDependencyIds', 'sourceAlias', 'aliases', 'maxItems', 'actualItems']) {
    assert.deepEqual(safeDetail[key], detail[key], key);
  }
  assert.deepEqual(safeDetail.supportedOperators, ['equals', 'contains']);
  assert.deepEqual(safeDetail.comparisonPath, [{ sourceClass: 'Network', targetClass: 'ACL', domain: 'NetworkAcl', direction: 'source' }]);
  assert.deepEqual(safeDetail.limit, { limitName: 'maxItems', effectiveLimit: 16, actualCount: 20 });
  assert.doesNotMatch(api.serialize(diagnostic), /hidden|rejectedFlow|arbitrary|Spec/);
  assert.deepEqual(api.sanitize(diagnostic), diagnostic);
  assert.deepEqual(JSON.parse(api.serialize(diagnostic)).errors, diagnostic.errors);
});

test('invalid JSON, empty, text, JSON body without parsed result and primitives remain distinct', () => {
  assert.equal(api.response(result(undefined, { body: '{bad' }), context).responseFormat, 'invalid_json');
  assert.equal(api.response(result(undefined, { body: '  ' }), context).responseFormat, 'empty');
  assert.equal(api.response(result(undefined, { body: 'Bad gateway', contentType: 'text/plain' }), context).responseFormat, 'text');
  assert.equal(api.response(result(undefined, { body: '{"code":"backend_error"}' }), context).code, 'backend_error');
  for (const body of ['null', '42', '"secret payload"', '["secret payload"]']) {
    const diagnostic = api.response(result(undefined, { body }), context);
    assert.equal(diagnostic.responseFormat, 'json');
    assert.doesNotMatch(diagnostic.responseExcerpt, /secret payload/);
  }
});

test('known secret and URL/query patterns are masked in messages and excerpts', () => {
  const samples = [
    'Authorization: Bearer topsecret', 'Cookie: session=topsecret', 'Set-Cookie: session=topsecret',
    'X-CSRF-Token=topsecret', 'api_key: topsecret', 'password=topsecret',
    'prompt: topsecret', 'Spec: topsecret', 'request body: topsecret', 'stack: topsecret',
    'prompt:\n  topsecret\n  more private text', 'request body: {\n  "value": "topsecret"\n}',
    'Bearer topsecret', 'Basic dG9wc2VjcmV0',
    'https://user:topsecret@example.invalid/api?password=topsecret#topsecret',
    '/api?value=topsecret', '//example.invalid?value=topsecret',
    'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJ0b3BzZWNyZXQifQ.signature',
    'sk-12345678901234567890', ['-----BEGIN', 'PRIVATE KEY-----\ntopsecret\n-----END', 'PRIVATE KEY-----'].join(' ')
  ];
  for (const sample of samples) {
    const diagnostic = api.response(result(undefined, { body: sample, contentType: 'text/plain' }), { ...context, blockName: sample });
    assert.doesNotMatch(api.serialize(diagnostic), /topsecret|dG9wc2VjcmV0|12345678901234567890|eyJhbGci|user:/, sample);
    assert.doesNotMatch(api.response(result({ message: sample }), context).message, /topsecret/, sample);
  }
});

test('paths discard credentials, fragments and queries, including concealed delimiters', () => {
  for (const path of ['//user:pass@host.invalid/api?q=secret#secret', '/api?q=secret', 'api#secret']) {
    assert.equal(api.response(result({}), { ...context, path }).path, '/api');
  }
  for (const path of ['/api%3fsecret', '/user%40secret', '/api%2fsecret', 'https://[invalid']) {
    assert.equal(api.response(result({}), { ...context, path }).path, '/');
  }
});

test('UTF-8 excerpt cap is byte based and does not split Unicode code points', () => {
  const diagnostic = api.response(result(undefined, { body: '\u{1f680}'.repeat(3000), contentType: 'text/plain' }), context);
  assert.equal(Buffer.byteLength(diagnostic.responseExcerpt), 4096);
  assert.equal(diagnostic.truncated, true);
  assert.doesNotMatch(diagnostic.responseExcerpt, /\ufffd/);
});

test('serialization stays valid JSON under 16 KiB and explicitly marks omitted detail', () => {
  const diagnostic = api.response(result({
    message: '\u{1f680}'.repeat(1000),
    errors: Array.from({ length: 16 }, () => ({ code: 'limit', message: '\u{1f680}'.repeat(1000), blockName: '\u{1f680}'.repeat(1000) })),
    diagnostics: { limits: Array.from({ length: 16 }, () => ({ message: 'x'.repeat(1000), limitName: 'maxBytes', effectiveLimit: 4096 })) }
  }), context);
  const copied = api.serialize(diagnostic);
  assert.ok(Buffer.byteLength(copied) <= 16384);
  const parsed = JSON.parse(copied);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.clientRequestId, context.requestId);
  assert.equal(parsed.serverRequestId, 'server-456');
  assert.deepEqual(parsed.owner, context.owner);
});

test('only backend resume evidence confirms checkpoint; no inference from retry, limits or context', () => {
  for (const payload of [
    {}, { retryable: true }, { diagnostics: { timeout: true, checkpointRetained: true } },
    { checkpoint: { confirmed: true, stage: 'roles' } },
    { resume: { stage: 'roles' } }, { resume: { resumeId: 'private-resume', stage: 'roles', expiresAt: 'invalid' } }
  ]) {
    assert.deepEqual(api.response(result(payload), { ...context, checkpoint: { confirmed: true } }).checkpoint, { confirmed: false, stage: '', expiresAt: null });
  }
  const diagnostic = api.response(result({ retryable: true, resume: { resumeId: 'private-resume', stage: 'roles', expiresAt: '2026-11-03T12:00:00Z' } }), context);
  assert.deepEqual(diagnostic.checkpoint, { confirmed: true, stage: 'roles', expiresAt: '2026-11-03T12:00:00.000Z' });
  assert.doesNotMatch(api.serialize(diagnostic), /private-resume|resumeId/);
});

test('exceptions classify client timeout, explicit cancel and network without upstream guesses', () => {
  for (const [error, code, retryable] of [
    [{ name: 'TimeoutError' }, 'request_timeout', true],
    [{ code: 'request_timeout' }, 'request_timeout', true],
    [{ name: 'AbortError' }, 'request_cancelled', false],
    [new TypeError('Failed to fetch https://user:secret@example.invalid'), 'network_error', true]
  ]) {
    const diagnostic = api.exception(error, context);
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.retryable, retryable);
    assert.equal(diagnostic.status, null);
    assert.equal(diagnostic.responseFormat, 'none');
    assert.equal(diagnostic.checkpoint.confirmed, false);
    assert.doesNotMatch(api.serialize(diagnostic), /secret|nginx|litellm|upstream/i);
  }
  assert.equal(api.exception({ name: 'TimeoutError' }, { ...context, checkpoint: { confirmed: true, stage: 'roles' } }).checkpoint.confirmed, false);
});

test('existing diagnostics and clipboard serialization preserve request/owner identity without mutation', () => {
  const diagnostic = api.response(result({ code: 'backend_error', message: 'Unavailable' }), context);
  const original = structuredClone(diagnostic);
  const preserved = api.exception({ diagnostic }, { ...context, requestId: 'wrong-request', owner: { generation: 99 } });
  assert.deepEqual(preserved, diagnostic);
  assert.notEqual(preserved, diagnostic);
  assert.deepEqual(JSON.parse(api.serialize(preserved)), diagnostic);
  assert.deepEqual(api.sanitize(api.sanitize(diagnostic)), diagnostic);
  assert.deepEqual(diagnostic, original);
  assert.equal(api.sanitize({ ...diagnostic, Authorization: 'secret', owner: { ...context.owner, token: 'secret' } }).Authorization, undefined);
});

test('factory source runs in an isolated browser-like realm without module dependencies', () => {
  const embedded = vm.runInNewContext(`(${createUiRequestDiagnostics.toString()})()`, { TextEncoder, URL });
  const diagnostic = embedded.response(result({ code: 'backend_error' }), context);
  assert.equal(diagnostic.code, 'backend_error');
  assert.equal(diagnostic.path, '/api/template');
  assert.equal(JSON.parse(embedded.serialize(diagnostic)).clientRequestId, context.requestId);
});
