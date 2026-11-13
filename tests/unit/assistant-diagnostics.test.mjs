import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  DEFAULT_ASSISTANT_DIAGNOSTICS, normalizeAssistantDiagnosticsPolicy,
  redactAssistantDiagnosticValue, isAssistantCredentialKey, createAssistantDiagnosticsStore
} from '../../scripts/assistant-diagnostics.mjs';

const run = promisify(execFile);

test('policy validation, caps and cross-limit clamps', () => {
  assert.deepEqual(normalizeAssistantDiagnosticsPolicy(null, null), DEFAULT_ASSISTANT_DIAGNOSTICS);
  const policy = normalizeAssistantDiagnosticsPolicy({ captureDurationSec: 99999, retentionSec: 9999999, maxBodyBytes: -1 });
  assert.equal(policy.captureDurationSec, 3600);
  assert.equal(policy.retentionSec, 604800);
  assert.equal(policy.maxBodyBytes, 8388608);
  assert.equal(normalizeAssistantDiagnosticsPolicy({ maxBodyBytes: 200 }, { maxBodyBytes: 100 }).maxBodyBytes, 100);
  const small = normalizeAssistantDiagnosticsPolicy({ maxStoredBytes: 12 });
  assert.equal(small.maxBodyBytes, 12);
  assert.equal(small.maxTraceBytes, 12);
});

test('shared credential predicate masks numeric and descriptor credentials; usage requires whitelisted context', () => {
  const input = { prompt: 'retain HTML', max_tokens: 4096, usage: { total_tokens: 32, token: 7 },
    token: 123, total_tokens: 567, nested: { token: 789 }, sessionId: 123456, resumeId: 234567, CSRF: 345678,
    headers: { Authorization: 'opaque', Cookie: 'sid=x', 'X-API-Key': 'keyvalue' },
    pairs: [['Authorization', 456789]], descriptors: [{ name: 'X-Session-Id', value: 567890 }],
    private_key: 'material', nestedCredential: { clientSecret: 'secretvalue' } };
  const result = redactAssistantDiagnosticValue(input);
  assert.equal(result.value.max_tokens, 4096);
  assert.equal(result.value.usage.total_tokens, 32);
  assert.equal(result.value.usage.token, 7);
  assert.equal(result.value.prompt, 'retain HTML');
  for (const key of ['token', 'total_tokens', 'sessionId', 'resumeId', 'CSRF']) assert.equal(result.value[key], '[REDACTED]');
  assert.equal(result.value.nested.token, '[REDACTED]');
  assert.equal(result.value.pairs[0][1], '[REDACTED]');
  assert.equal(result.value.descriptors[0].value, '[REDACTED]');
  for (const key of ['X-API-Key', 'session_id', 'resumeId', 'x-csrf-token', 'Authorization']) assert.equal(isAssistantCredentialKey(key), true);
  assert.equal(result.redacted, true);
});

test('malformed fields: escaped keys/values, unclosed strings, headers and numeric secrets redact before clipping', () => {
  const fixtures = [
    '{"sessionId":"credential-one", broken',
    '{"session\\u0049d":"credential-two", broken',
    '{"password":"credential-three\\\"tail", broken',
    '{"resumeId":"credential-four',
    "'CSRF-Key'=345678 broken",
    'Authorization: opaque-header\nCookie: opaque-cookie',
    '{"access_token":987654, "notes":"keep", broken',
    '{"private_key":{"nested":"credential-five',
    'session_id=credential-six&keep=yes',
    '{"headers":[{"name":"Authorization","value":"credential-seven"}, broken',
    '{"headers":[{"name":"Authoriz\\u0061tion","value":"credential-nine\\\"tail"}, broken',
    '{"headers":[{"value":"credential-ten","name":"Cookie"}, broken',
    '{"headers":[{"name":"Authorization","value":"credential-eleven',
    '[["Cookie","credential-eight"], broken'
  ];
  const secrets = ['credential-one', 'credential-two', 'credential-three', 'credential-four', '345678',
    'opaque-header', 'opaque-cookie', '987654', 'credential-five', 'credential-six', 'credential-seven', 'credential-eight',
    'credential-nine', 'credential-ten', 'credential-eleven'];
  for (const fixture of fixtures) {
    const result = redactAssistantDiagnosticValue(fixture);
    assert.equal(result.redacted, true, fixture);
    for (const secret of secrets) assert.ok(!result.value.includes(secret), fixture);
    for (const maxBytes of [1, 2, 3, 10, 50]) {
      const clipped = redactAssistantDiagnosticValue(fixture, { maxBytes });
      assert.ok(clipped.storedBytes <= maxBytes);
      for (const secret of secrets) assert.ok(!String(clipped.value).includes(secret));
    }
  }
  const valid = JSON.parse(redactAssistantDiagnosticValue('{"password":"secret","notes":"unchanged"}').value);
  assert.equal(valid.password, '[REDACTED]');
  assert.equal(valid.notes, 'unchanged');
  const text = '<html>provider error: {invalid json} keep whitespace\n</html>';
  assert.equal(redactAssistantDiagnosticValue(text).value, text);
  const known = redactAssistantDiagnosticValue('keep known-secret Bearer opaque https://user:pass@example.test', { secretValues: ['known-secret'] });
  for (const value of ['known-secret', 'opaque', 'user:pass']) assert.ok(!known.value.includes(value));
});

test('Unicode bounds, circular input and depth remain safe', () => {
  for (const maxBytes of [1, 2, 3, 10, 50]) for (const value of ['😀'.repeat(200), { notes: 'x'.repeat(200) }]) {
    const result = redactAssistantDiagnosticValue(value, { maxBytes });
    assert.ok(result.storedBytes <= maxBytes);
    assert.equal(result.storedBytes, Buffer.byteLength(JSON.stringify(result.value)));
    assert.ok(result.actualBytes > result.storedBytes);
    assert.equal(result.truncated, true);
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => redactAssistantDiagnosticValue(cyclic));
});

test('Redis failure propagates without memory fallback; malformed metadata fails closed', async () => {
  const store = createAssistantDiagnosticsStore({ redisCommand: async () => { throw new Error('offline'); } });
  for (const call of [() => store.status('r'), () => store.activate('r', { mode: 'Verbose' }), () => store.stop('r'),
    () => store.clear('r'), () => store.activeCaptures(), () => store.list('r'), () => store.get('r', randomUUID())]) {
    await assert.rejects(call, /offline/);
  }
  for (const call of ['begin', 'save']) assert.equal((await store[call]('r', {})).reason, 'invalid_metadata');
});

test('real Redis opt-in: atomic lifecycle, safe ingress, isolation, TTL, FIFO and quota accounting', {
  skip: !process.env.CMDP_DIAGNOSTICS_REDIS_TEST_CONTAINER
}, async (t) => {
  const commands = [];
  const adapter = async (args) => {
    commands.push(args);
    const { stdout } = await run('docker', ['exec', process.env.CMDP_DIAGNOSTICS_REDIS_TEST_CONTAINER,
      'redis-cli', '--json', ...args.map(String)], { maxBuffer: 4 * 1024 * 1024 });
    const reply = JSON.parse(stdout);
    if (typeof reply === 'string' && /^(?:ERR|WRONGTYPE|NOAUTH)/.test(reply)) throw new Error(reply);
    return reply;
  };
  let clock = Date.now();
  const prefix = 'test-assistant-diagnostics-' + randomUUID();
  const events = [];
  const store = createAssistantDiagnosticsStore({ redisCommand: adapter, keyPrefix: prefix, now: () => clock, onEvent: (e) => events.push(e) });
  const roots = ['one', 'two', 'quota', 'ttl'];
  t.after(async () => {
    // Delete only keys from this unique test namespace, including its durable epoch.
    for (const root of roots) { await store.clear(root); await store.stop(root); }
    const keys = new Set(commands.filter((parts) => parts[0] === 'EVAL').flatMap((parts) => parts.slice(3, 9)));
    if (keys.size) await adapter(['DEL', ...keys]);
  });
  const make = (status, extra = {}, retentionSec = 86400) => ({
    id: randomUUID(), captureGeneration: status.captureGeneration, storageEpoch: status.storageEpoch,
    startedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + retentionSec * 1000).toISOString(),
    requestId: 'request-1', templateCode: 'T', mode: 'Verbose', status: 'in_progress',
    spans: [{ request: { prompt: 'retain prompt', password: 'never-in-redis',
      malformed: ['{"headers":[{"name":"Authorization","value":"never-in-descriptor"}, broken',
        '{"password":"never-in-escaped\\\"tail", broken', '{"sessionId":"never-in-unclosed'] },
      response: '{"sessionId":"never-in-json", broken', metadata: { max_tokens: 12, usage: { total_tokens: 34 } } }], ...extra
  });
  const empty = await store.status('one');
  assert.deepEqual(empty, { mode: 'Off', activeUntil: null, policy: DEFAULT_ASSISTANT_DIAGNOSTICS,
    recordCount: 0, storedBytes: 0, evictedCount: 0, captureGeneration: null, storageEpoch: 0 });
  let active = await store.activate('one', { mode: 'Verbose', policy: { secretValues: ['activation-secret'] } });
  assert.equal((await store.activeCaptures())[0].root, 'one');
  assert.ok(!JSON.stringify(await store.activeCaptures()).includes('spans'));
  assert.equal((await store.status('two')).mode, 'Off');
  const first = make(active);
  assert.equal((await store.save('one', first)).reason, 'missing');
  assert.equal((await store.begin('one', first)).stored, true);
  const recordKey = commands.findLast((parts) => parts[0] === 'EVAL' && parts[9] === 'begin')[8];
  const initialTtl = await adapter(['PTTL', recordKey]);
  assert.equal((await store.begin('one', first)).reason, 'already_registered');
  const fetched = await store.get('one', first.id);
  assert.equal(fetched.spans[0].request.value.password, '[REDACTED]');
  assert.ok(!fetched.spans[0].response.value.includes('never-in-json'));
  assert.equal(fetched.spans[0].metadata.max_tokens, 12);
  assert.equal(fetched.spans[0].metadata.usage.total_tokens, 34);
  for (const secret of ['never-in-descriptor', 'never-in-escaped', 'never-in-unclosed']) {
    assert.ok(!JSON.stringify(fetched).includes(secret));
  }
  assert.equal(await store.get('two', first.id), null);
  assert.equal(await store.get('one', '../key'), null);
  assert.equal((await store.list('one', { requestId: 'request-1', templateCode: 'T' })).length, 1);
  assert.deepEqual(await store.list('one', { requestId: 'missing' }), []);
  assert.equal((await store.stop('one')).mode, 'Off');
  assert.equal((await store.begin('one', make(active))).reason, 'capture_inactive');
  const updated = await store.save('one', { ...first, status: 'ok' });
  assert.equal(updated.updated, true);
  assert.ok(await adapter(['PTTL', recordKey]) <= initialTtl);
  assert.equal((await store.save('one', { ...first, expiresAt: new Date(clock + 90000000).toISOString() })).stored, false);
  assert.equal((await store.save('one', { ...first, captureGeneration: randomUUID() })).reason, 'registration_mismatch');
  active = await store.activate('one', { mode: 'Basic' });
  assert.equal((await store.begin('one', make({ ...active, captureGeneration: first.captureGeneration }))).stored, false);
  const pending = make(active);
  const clear = await store.clear('one');
  assert.equal(clear.clearedCount, 1);
  assert.equal(clear.storageEpoch, 1);
  assert.equal((await store.begin('one', pending)).reason, 'storage_epoch');
  assert.equal((await store.save('one', first)).reason, 'storage_epoch');
  assert.deepEqual(await store.list('one'), []);
  assert.equal((await store.status('one')).storageEpoch, 1);
  assert.equal((await store.status('two')).storageEpoch, 0);
  const afterClear = make(await store.status('one'));
  assert.equal((await store.begin('one', afterClear)).stored, true);
  const orphan = make(await store.status('one'));
  assert.equal((await store.begin('one', orphan)).stored, true);
  const orphanKey = commands.findLast((parts) => parts[0] === 'EVAL' && parts[9] === 'begin')[8];
  await adapter(['DEL', orphanKey]);
  assert.equal((await store.save('one', orphan)).reason, 'missing');
  assert.equal(await store.get('one', orphan.id), null);
  assert.equal((await store.status('one')).recordCount, 1);

  const quotaStatus = await store.activate('quota', { mode: 'Verbose' });
  const a = make(quotaStatus);
  const firstSize = (await store.begin('quota', a)).storedBytes;
  await store.clear('quota');
  const quotaActive = await store.status('quota');
  const policy = { maxStoredBytes: firstSize * 2 + 100, maxTraceBytes: firstSize + 100, maxBodyBytes: firstSize };
  const traces = Array.from({ length: 6 }, () => make(quotaActive));
  const results = await Promise.all(traces.map((value) => store.begin('quota', value, policy)));
  assert.ok(results.every((value) => value.stored));
  assert.equal(results.reduce((sum, value) => sum + value.evictedCount, 0), 4);
  const survivors = await store.list('quota');
  assert.equal(survivors.length, 2);
  const evictedTrace = traces.find((value) => !survivors.some((entry) => entry.id === value.id));
  assert.equal((await store.save('quota', evictedTrace, policy)).reason, 'missing');
  const stats = await store.status('quota');
  assert.equal(stats.recordCount, 2);
  assert.equal(stats.evictedCount, 4);
  assert.ok(stats.storedBytes <= policy.maxStoredBytes);
  const latest = traces.find((value) => value.id === survivors[0].id);
  const replacements = await Promise.all(Array.from({ length: 3 }, () => store.save('quota', latest, policy)));
  assert.ok(replacements.every((value) => value.updated && value.evictedCount === 0));
  await store.begin('quota', make(quotaActive), policy);
  assert.equal(await store.get('quota', survivors[1].id), null);
  assert.ok(await store.get('quota', latest.id));
  const grown = await store.save('quota', { ...latest, notes: 'g'.repeat(300) }, { maxStoredBytes: firstSize + 600 });
  assert.equal(grown.stored, true);
  assert.equal(grown.evictedCount, 1);
  assert.equal(grown.totalStoredBytes, grown.storedBytes);

  const other = await store.activate('two', { mode: 'Verbose' });
  const omitted = await store.begin('two', make(other, { notes: 'x'.repeat(20000) }), { maxTraceBytes: 850 });
  assert.equal(omitted.stored, true);
  assert.equal(omitted.omitted, true);
  assert.equal((await store.get('two', omitted.id)).diagnostics.reason, 'maxTraceBytes');
  assert.equal((await store.begin('two', make(other), { maxTraceBytes: 1 })).reason, 'quota');

  const ttlStatus = await store.activate('ttl', { mode: 'Basic', durationSec: 1 });
  const ttlTrace = make(ttlStatus, {}, 1);
  assert.equal((await store.begin('ttl', ttlTrace, { retentionSec: 1 })).stored, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  clock += 1101;
  assert.equal((await store.status('ttl')).mode, 'Off');
  assert.equal((await store.begin('ttl', make(ttlStatus))).reason, 'capture_inactive');
  assert.ok(!(await store.activeCaptures()).some((capture) => capture.root === 'ttl'));
  assert.equal((await store.save('ttl', ttlTrace, { retentionSec: 1 })).stored, false);
  assert.equal(await store.get('ttl', ttlTrace.id), null);
  assert.equal((await store.status('ttl')).recordCount, 0);
  assert.equal((await store.status('one')).storageEpoch, 1);
  assert.ok(!JSON.stringify(events).includes('never-in'));
  const writes = JSON.stringify(commands.filter((parts) => parts[0] === 'EVAL'));
  for (const secret of ['never-in-redis', 'never-in-json', 'activation-secret',
    'never-in-descriptor', 'never-in-escaped', 'never-in-unclosed']) assert.ok(!writes.includes(secret));
});
