import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';

const ROOT = 'Cst_QueryTool';
const STATIC = { mode: 'staticSnapshot', paramsMode: 'ignore', warningAccepted: true };
const SELECT = { type: 'selectCards', as: 'items', className: 'Asset' };
const TABLE = { name: 'items', columns: ['Code'] };
const PAGED = { ...TABLE, presentation: { largeTable: { mode: 'all' } } };

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function specHash(spec) {
  return createHash('sha256').update(stableJson(spec)).digest('hex');
}

function deferredSignal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function upstream(t, templates, read, userForToken = (token) => token) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const path = url.pathname;
    const token = req.headers['cmdbuild-authorization'];
    let data = [];
    let status = 200;
    let total;
    const override = await read(url, token);
    if (override) ({ data = [], status = 200, total } = override);
    else if (path.endsWith('/sessions/current')) data = { username: userForToken(token), role: 'Reader' };
    else if (path.endsWith('/Cst_QueryTemplate/cards')) {
      data = Object.entries(templates).map(([code, spec]) => ({
        _id: code, Code: code, Description: code, SpecJson: JSON.stringify(spec),
        Active: true, _can_read: true, _can_update: true
      }));
    } else if (path.endsWith('/Cst_QueryToolConfig/cards')) {
      data = [{ _id: 1, Code: ROOT, RootCode: ROOT, Active: true,
        RuntimeConfigJson: JSON.stringify({ runtimeCache: { refreshCooldownSec: 1 } }) }];
    } else if (path.endsWith('/classes')) {
      data = ['Asset', 'Hidden', 'Target'].map((name) => ({ name, description: name, active: true }));
    } else if (path.endsWith('/attributes')) {
      data = ['Code', 'Description'].map((name) => ({ name, type: 'string', active: true }));
    }
    const meta = total === null ? {} : { total: total ?? (Array.isArray(data) ? data.length : 1) };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: status === 200, data, meta }));
  });
  await listen(server);
  t.after(() => close(server));
  return 'http://127.0.0.1:' + server.address().port;
}

async function backend(t, upstreamOrigin, redisOrigin) {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], { env: {
    ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port), NODE_ENV: 'test',
    CMDBUILD_ORIGIN: upstreamOrigin, CMDBDYNAMIC_REDIS_ENABLED: String(Boolean(redisOrigin)),
    CMDBDYNAMIC_REDIS_REQUIRED: String(Boolean(redisOrigin)), CMDBDYNAMIC_HEALTH_REDIS_REQUIRED: 'false',
    ...(redisOrigin ? { CMDBDYNAMIC_REDIS_URL: redisOrigin, CMDBDYNAMIC_REDIS_KEY_PREFIX: 'publication-test' } : {}),
    CMDBDYNAMICPAGES_CSRF_SECRET: 'fixture-only-csrf', CMDP_LOG_TARGET: 'stdout', CMDP_LOG_LEVEL: 'silent'
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      if ((await fetch(origin + '/health/live', { signal: AbortSignal.timeout(250) })).ok) break;
    } catch { /* Wait for the isolated listener. */ }
    assert.ok(Date.now() < deadline && child.exitCode === null, stderr);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  async function request(path, { token, method = 'GET', body } = {}) {
    const headers = token ? { cookie: 'CMDBuild-Authorization=' + token } : {};
    if (method !== 'GET') {
      const csrf = await request('/csrf', { token });
      assert.equal(csrf.status, 200, JSON.stringify(csrf.json));
      Object.assign(headers, { origin, 'content-type': 'application/json', 'x-cmdbdynamicpages-csrf': csrf.json.token });
    }
    const url = origin + (path.startsWith('/cmdbuild/') ? '' : '/cmdbuild/custom-api') + path;
    const response = await fetch(url, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: response.status, ...(response.headers.get('content-type')?.includes('application/json')
      ? { json: await response.json() } : { html: await response.text() }) };
  }
  return request;
}

function reply(value) {
  if (value == null) return '$-1\r\n';
  if (typeof value === 'number') return ':' + value + '\r\n';
  if (Array.isArray(value)) return '*' + value.length + '\r\n' + value.map(reply).join('');
  return '$' + Buffer.byteLength(value) + '\r\n' + value + '\r\n';
}

function redisArguments(input) {
  const end = input.indexOf('\r\n');
  if (end < 0) return null;
  const parts = [];
  let offset = end + 2;
  const count = Number(input.subarray(1, end));
  while (parts.length < count) {
    const header = input.indexOf('\r\n', offset);
    if (header < 0) return null;
    const length = Number(input.subarray(offset + 1, header));
    if (header + 4 + length > input.length) return null;
    parts.push(input.subarray(header + 2, header + 2 + length).toString());
    offset = header + 4 + length;
  }
  return parts;
}

async function redisFixture(t) {
  const values = new Map();
  const events = [];
  const faults = { runtimeRead: false };
  const sets = new Map();
  const add = (key, value) => {
    if (!sets.has(key)) sets.set(key, new Set());
    sets.get(key).add(value);
  };
  const remove = (keys) => keys.reduce((total, key) => total + Number(values.delete(key) || sets.delete(key)), 0);
  const command = ([op, key, ...args]) => {
    switch (op) {
      case 'PING': return 'PONG';
      case 'GET': return values.get(key);
      case 'MGET': return [key, ...args].map((item) => values.get(item));
      case 'SET':
        if (args.includes('NX') && values.has(key)) return null;
        values.set(key, args[0]);
        return 'OK';
      case 'SADD': add(key, args[0]); return 1;
      case 'SMEMBERS': return [...(sets.get(key) || [])];
      case 'EXPIRE': return 1;
      case 'ZREMRANGEBYSCORE': return 0;
      case 'ZRANGE': return [];
      case 'DEL': return remove([key, ...args]);
      case 'EVAL': {
        const count = Number(args[0]);
        const [state, value, index] = args.slice(1, count + 1);
        const argv = args.slice(count + 1);
        if (state.includes(':runtime-relation-generation:')) {
          if (key.includes('local generation')) {
            assert.match(key, /SET.*PX.*DEL/);
            const generation = values.get(state) || argv[0];
            values.set(state, generation);
            values.delete(value);
            events.push('begin');
            return generation;
          }
          if (count === 2 && /^return redis.call\('DEL'/.test(key)) {
            events.push('revoke');
            return remove([state, value]);
          }
          assert.match(key, /GET.*~= ARGV\[1\].*return 0.*SADD.*SET.*PX/);
          if (values.get(state) !== argv[0]) { events.push('write-rejected'); return 0; }
          add(index, argv[3]);
          values.set(value, argv[1]);
          events.push('write');
          return 1;
        }
        if (values.get(state) !== argv[0]) return 0;
        if (count === 3 && key.includes('SADD')) {
          if (argv[3] && values.get(value) !== argv[3]) return 0;
          add(index, argv[2]);
          values.set(value, argv[1]);
          return 1;
        }
        throw new Error('Unexpected EVAL operation');
      }
      default: throw new Error('Unexpected Redis operation: ' + op);
    }
  };
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      const parts = redisArguments(input);
      if (faults.runtimeRead && parts?.[0] === 'GET' && parts[1].includes(':runtime:')) {
        return socket.end('-ERR fixture backend unavailable\r\n');
      }
      if (parts) socket.end(reply(command(parts)));
    });
  });
  await listen(server);
  t.after(() => close(server));
  return { origin: 'redis://127.0.0.1:' + server.address().port, values, events, faults };
}

const rows = (...codes) => codes.map((Code, i) => ({ _id: i + 1, Code, Description: Code }));
const publish = (request, name, spec, token = 'editor', params = {}) =>
  request('/templates/' + name + '/publish', { token, method: 'POST', body: { savedSpecHash: specHash(spec), params } });

test('anonymous run, viewer shell and public paging expose only the canonical table, even with an old index', async (t) => {
  const redis = await redisFixture(t);
  const hidden = { name: 'hidden', columns: ['Code'], presentation: { largeTable: { mode: 'key',
    selector: { kind: 'class', source: 'Hidden', idField: 'Code', labelField: 'Description', matchField: 'Code' },
    groupKeys: ['Code'] } } };
  const spec = { version: 1, steps: [SELECT, { ...SELECT, className: 'Hidden', as: 'hidden' }],
    result: { tables: [{ ...PAGED, published: true }, hidden] }, publish: STATIC };
  let hiddenReads = 0;
  const mock = await upstream(t, { Limited: spec }, (url) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) return { data: rows('visible') };
    if (url.pathname.endsWith('/classes/Hidden/cards')) {
      hiddenReads += 1;
      return { data: rows('should-not-be-read') };
    }
  });
  const request = await backend(t, mock, redis.origin);
  assert.equal((await publish(request, 'Limited', spec)).status, 200);
  const [snapshotKey] = [...redis.values.keys()].filter((key) => key.includes(':snapshot:'));
  const snapshot = JSON.parse(redis.values.get(snapshotKey));
  assert.deepEqual(Object.keys(snapshot.tableIndexes), ['items']);
  assert.deepEqual(snapshot.result.tables.map(({ name }) => name), ['items']);
  assert.equal(hiddenReads, 0);
  snapshot.result.tables.push({ ...hidden, rows: rows('hidden') });
  snapshot.tableIndexes.hidden = snapshot.tableIndexes.items;
  redis.values.set(snapshotKey, JSON.stringify(snapshot));

  const path = '/public-snapshots/Limited';
  for (const output of ['', '?cmdpTableShell=1', '?json=true']) {
    const response = await request(path + '/run' + output);
    assert.equal(response.status, 200);
    assert.deepEqual((response.json.tables || response.json.result.tables).map(({ name }) => name), ['items']);
  }
  const direct = await request('/cmdbuild/dynamicpages/ui/run/Limited?json=true');
  assert.deepEqual(direct.json.tables.map(({ name }) => name), ['items']);
  const directHtml = await request('/cmdbuild/dynamicpages/ui/run/Limited');
  assert.equal(directHtml.status, 200);
  assert.match(directHtml.html, /"publicRuntime":true/);
  const snapshotRevision = (await request(path + '/run?cmdpTableShell=1')).json.tableView.snapshotRevision;
  const page = (table, op) => request(path + '/table-page?cmdpTable=' + encodeURIComponent(JSON.stringify({
    table, op, snapshotRevision
  })));
  for (const op of ['rows', 'options', 'details']) {
    const hiddenPage = await page('hidden', op);
    assert.equal(hiddenPage.status, 404);
    assert.equal(hiddenPage.json.reason, 'table_not_available');
  }
  assert.equal((await page('items', 'rows')).json.table.rows[0].Code, 'visible');
});

test('personal refresh conflicts with republish of an ignore snapshot across two backends', async (t) => {
  const redis = await redisFixture(t);
  const spec = { version: 1, params: { marker: { type: 'string', required: true } },
    steps: [SELECT], result: { tables: [PAGED] }, publish: STATIC };
  const entered = deferredSignal();
  const release = deferredSignal();
  const mock = await upstream(t, { Refresh: spec }, async (url, token) => {
    if (!url.pathname.endsWith('/classes/Asset/cards')) return;
    if (token === 'slow') { entered.resolve(); await release.promise; }
    return { data: rows(token) };
  });
  const a = await backend(t, mock, redis.origin);
  const b = await backend(t, mock, redis.origin);
  assert.equal((await publish(b, 'Refresh', spec, 'first', { marker: 'old' })).status, 200);
  const publicRun = '/public-snapshots/Refresh/run?json=true';
  const before = await b(publicRun);
  const pending = a('/templates/Refresh/refresh-snapshot?cmdpTableShell=1', { method: 'POST', token: 'slow',
    body: { expectedMode: 'personal', expectedSnapshotRevision: before.json.cache.snapshotRevision } });
  try {
    await Promise.race([entered.promise, pending.then((response) => assert.fail(JSON.stringify(response)))]);
    assert.equal((await publish(b, 'Refresh', spec, 'second', { marker: 'new' })).status, 200);
  } finally { release.resolve(); }
  const stale = await pending;
  assert.equal(stale.status, 409);
  assert.equal(stale.json.reason, 'snapshot_refresh_conflict');
  assert.equal(stale.json.tableView, undefined);
  const current = await b(publicRun);
  assert.notEqual(current.json.cache.snapshotRevision, before.json.cache.snapshotRevision);
  assert.equal(current.json.params.marker, 'new');
  assert.equal(current.json.tables[0].rows[0].Code, 'second');
  const personal = await a('/templates/Refresh/refresh-snapshot?cmdpTableShell=1', { method: 'POST', token: 'reader',
    body: { expectedMode: 'personal', expectedSnapshotRevision: current.json.cache.snapshotRevision } });
  assert.equal(personal.status, 200);
  assert.equal(personal.json.tableView.kind, 'personal');
  const page = '/templates/Refresh/table-page?cmdpTable=' + encodeURIComponent(JSON.stringify({
    table: 'items', op: 'rows', viewId: personal.json.tableView.viewId
  }));
  assert.equal((await a(page, { token: 'reader' })).json.table.rows[0].Code, 'reader');
  assert.equal((await a(page, { token: 'different-reader' })).status, 409);
  assert.deepEqual((await b(publicRun)).json, current.json);
});

test('visibilityHash shares only a complete visibility proof and isolates an identical partial first page', async (t) => {
  const full = { version: 1, cache: { scopeMode: 'visibilityHash' },
    steps: [SELECT], result: { tables: [TABLE] } };
  const partial = { ...full, steps: [{ ...SELECT, scanLimit: 1001,
    filters: [{ path: 'Code', op: 'matches', regex: '^match' }] }] };
  let deny = '';
  const mock = await upstream(t, { Full: full, Partial: partial }, (url, token) => {
    if (token === 'partial-a' && ((deny === 'fields' && url.pathname.endsWith('/classes/Asset/attributes')) ||
      (deny === 'classes' && url.pathname.endsWith('/classes')))) return { status: 403 };
    if (!url.pathname.endsWith('/classes/Asset/cards')) return;
    if (!token.startsWith('partial-')) return { data: rows('same') };
    const start = Number(url.searchParams.get('start') || 0);
    const limit = Number(url.searchParams.get('limit') || 500);
    const data = Array.from({ length: 1000 }, (_, i) => ({ _id: i + 1, Code: 'same-' + i }))
      .concat([{ _id: 1001, Code: 'match-' + token }]);
    return { data: data.slice(start, start + limit), total: data.length };
  });
  const request = await backend(t, mock);
  const run = (name, token) => request('/templates/' + name + '/run?json=true', { token });
  const [one, two] = [await run('Full', 'one'), await run('Full', 'two')];
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.equal(one.json.cache.scopeMode, 'visibilityHash');
  assert.equal(one.json.cache.key, two.json.cache.key);
  assert.equal(two.json.cache.status, 'hit');

  const first = await run('Partial', 'partial-a');
  const second = await run('Partial', 'partial-b');
  for (const [result, token] of [[first, 'partial-a'], [second, 'partial-b']]) {
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.cache.scopeMode, 'privateUser');
    assert.equal(result.json.cache.accessProbe.reason, 'visibility_unconfirmed');
    assert.deepEqual(result.json.cache.accessProbe.checkedClasses, []);
    assert.deepEqual(result.json.tables[0].rows, [{ Code: 'match-' + token }]);
  }
  assert.notEqual(first.json.cache.key, second.json.cache.key);
  assert.equal((await run('Partial', 'partial-a')).json.cache.status, 'hit');
  for (const deniedSurface of ['fields', 'classes']) {
    deny = deniedSurface;
    const forbidden = await run('Partial', 'partial-a');
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.json));
    assert.equal(forbidden.json.reason, 'data_access_denied');
    assert.deepEqual(forbidden.json.tables || forbidden.json.result?.tables || [], []);
  }
});

test('a denied relation read fences a late successful computation across Redis-backed processes', async (t) => {
  const redis = await redisFixture(t);
  const spec = { version: 1, steps: [SELECT, { type: 'expandRelations', as: 'related',
    from: 'items', domain: 'AssetTarget', targetClass: 'Target', targetColumns: ['Code'] }],
    result: { tables: [{ name: 'related', columns: ['Code'] }] } };
  const entered = deferredSignal();
  const release = deferredSignal();
  let allowed = false;
  const mock = await upstream(t, { Related: spec }, async (url, token) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) return { data: rows('asset') };
    if (url.pathname.endsWith('/domains/AssetTarget')) return { data: { name: 'AssetTarget', source: 'Asset', destination: 'Target' } };
    if (url.pathname.endsWith('/classes/Target/cards/1')) return { data: rows('related')[0] };
    if (!url.pathname.endsWith('/relations')) return;
    if (token === 'slow') { entered.resolve(); await release.promise; }
    else if (!allowed) return { status: 403 };
    return { data: [{ domain: 'AssetTarget', _sourceType: 'Asset', _sourceId: 1,
      _destinationType: 'Target', _destinationId: 1, _destinationCode: 'related' }] };
  }, () => 'same-user');
  const a = await backend(t, mock, redis.origin);
  const b = await backend(t, mock, redis.origin);
  const run = (request, token) => request('/templates/Related/run?json=true', { token });
  const pending = run(a, 'slow');
  try {
    await Promise.race([entered.promise, pending.then((response) => assert.fail(JSON.stringify(response)))]);
    const denied = await run(b, 'denied');
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
  } finally { release.resolve(); }
  const stale = await pending;
  assert.equal(stale.status, 403, JSON.stringify(stale.json));
  assert.equal(stale.json.reason, 'data_access_denied');
  assert.deepEqual(redis.events, ['begin', 'begin', 'revoke', 'write-rejected']);
  assert.ok(![...redis.values.keys()].some((key) => key.includes(':runtime:')));
  assert.equal((await run(b, 'denied')).status, 403);
  allowed = true;
  const recovered = await run(b, 'allowed');
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  assert.equal(recovered.json.cache.status, 'miss');
  assert.deepEqual(recovered.json.tables[0].rows, [{ Code: 'related' }]);
  assert.equal((await run(a, 'allowed')).json.cache.status, 'hit');
  redis.faults.runtimeRead = true;
  const unavailable = await run(a, 'allowed');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.reason, 'runtime_cache_unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable.json), /fixture backend unavailable/);
});
