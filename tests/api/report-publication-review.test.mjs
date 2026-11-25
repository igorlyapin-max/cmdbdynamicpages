import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';

const ROOT = 'Cst_QueryTool';
const STATIC = { mode: 'staticSnapshot', paramsMode: 'ignore', warningAccepted: true };
const SHARED = { ...STATIC, refreshMode: 'shared', sharedRefreshAccepted: true };
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

async function backend(t, upstreamOrigin, redisOrigin, env = {}) {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], { env: {
    ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port), NODE_ENV: 'test',
    CMDBUILD_ORIGIN: upstreamOrigin, CMDBDYNAMIC_REDIS_ENABLED: String(Boolean(redisOrigin)),
    CMDBDYNAMIC_REDIS_REQUIRED: String(Boolean(redisOrigin)), CMDBDYNAMIC_HEALTH_REDIS_REQUIRED: 'false',
    ...(redisOrigin ? { CMDBDYNAMIC_REDIS_URL: redisOrigin, CMDBDYNAMIC_REDIS_KEY_PREFIX: 'publication-test' } : {}),
    CMDBDYNAMICPAGES_CSRF_SECRET: 'fixture-only-csrf', CMDP_LOG_TARGET: 'stdout', CMDP_LOG_LEVEL: 'silent', ...env
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
  return { parts, offset };
}

async function redisFixture(t) {
  const values = new Map();
  const events = [];
  const faults = { runtimeRead: false, timeReplyDelay: 0, beforeCommit: null, commitAck: 'normal' };
  const sets = new Map();
  const commits = [];
  const redisNow = () => Date.now() + 24 * 60 * 60 * 1000;
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
        if (count === 3 && key.includes('SADD')) {
          if (redisNow() >= Number(argv[3])) return -1;
          if (values.get(state) !== argv[0] || (argv[4] !== undefined && values.get(value) !== argv[4])) return 0;
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
    let sampledTime;
    socket.on('data', async (chunk) => {
      input = Buffer.concat([input, chunk]);
      const parsed = redisArguments(input);
      if (!parsed) return;
      input = input.subarray(parsed.offset);
      const { parts } = parsed;
      if (faults.runtimeRead && parts[0] === 'GET' && parts[1].includes(':runtime:')) {
        socket.end('-ERR fixture backend unavailable\r\n');
        return;
      }
      if (parts[0] === 'TIME') {
        sampledTime = redisNow();
        if (faults.timeReplyDelay) await new Promise((resolve) => setTimeout(resolve, faults.timeReplyDelay));
        socket.write(reply([String(Math.floor(sampledTime / 1000)), String(sampledTime % 1000 * 1000)]));
        return;
      }
      if (parts[0] === 'EVAL' && parts[3].includes(':snapshot-state:') && parts[1].includes('SADD')) {
        assert.ok(sampledTime, 'snapshot EVAL uses the socket that sampled Redis TIME');
        assert.match(parts[1], /GET[\s\S]*TIME[\s\S]*ARGV\[4\][\s\S]*SADD[\s\S]*SET/);
        const attempt = { sampledTime, deadline: Number(parts[9]) };
        const ack = faults.commitAck;
        commits.push(attempt);
        await faults.beforeCommit?.(attempt);
        if (ack === 'denied') {
          socket.end("-NOPERM this user has no permissions to run the 'eval' command\r\n");
          return;
        }
        attempt.outcome = command(parts);
        if (ack === 'drop') socket.end();
        else if (ack === 'script-error') socket.end('-ERR ACL failure in script fixture\r\n');
        else if (ack !== 'hold') socket.end(reply(attempt.outcome));
        return;
      }
      socket.end(reply(command(parts)));
    });
  });
  await listen(server);
  t.after(() => close(server));
  return { origin: 'redis://127.0.0.1:' + server.address().port, values, events, sets, faults, commits, redisNow };
}

const rows = (...codes) => codes.map((Code, i) => ({ _id: i + 1, Code, Description: Code }));
const publish = (request, name, spec, token = 'editor', params = {}) =>
  request('/templates/' + name + '/publish', { token, method: 'POST', body: { savedSpecHash: specHash(spec), params } });

test('invalid deployment row ceilings refuse startup and name the offending variable', { timeout: 5000 }, async (t) => {
  for (const [ordinary, paged, expected] of [
    ['0', '7', 'CMDP_EXECUTION_MAX_ROWS_ABSOLUTE'],
    ['4', '', 'CMDP_LARGE_TABLE_MAX_ROWS'],
    ['4', '4', 'CMDP_LARGE_TABLE_MAX_ROWS']
  ]) {
    const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
      env: { ...process.env, CMDP_EXECUTION_MAX_ROWS_ABSOLUTE: ordinary, CMDP_LARGE_TABLE_MAX_ROWS: paged,
        CMDP_LOG_TARGETS: 'stdout' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    const [code] = await once(child, 'close');
    const logs = Buffer.concat(output).toString();
    assert.equal(code, 1, logs);
    assert.match(logs, /app\.config_invalid/);
    assert.match(logs, new RegExp(expected));
  }
});

test('snapshot publication applies configured row ceilings and diagnoses explicit step limits', async (t) => {
  const ordinaryCap = 4;
  const pagedCap = 7;
  const stepLabel = 'Select report assets';
  const spec = (table, limit) => ({
    version: 1,
    steps: [{ ...SELECT, title: stepLabel, scanLimit: pagedCap + 1, ...(limit === undefined ? {} : { limit }) }],
    result: { tables: [table] }, publish: SHARED
  });
  const templates = {
    Ordinary: spec(TABLE),
    OrdinaryConflict: spec(TABLE, ordinaryCap + 1),
    ExplicitLower: spec(TABLE, 3),
    Paged: spec(PAGED),
    PagedConflict: spec(PAGED, pagedCap + 1)
  };
  const matching = {
    ...spec(TABLE, ordinaryCap + 1),
    result: { tables: [{ ...TABLE, name: 'view', published: true }] }
  };
  matching.steps = [...matching.steps,
    { ...SELECT, as: 'other', limit: 1, filters: [{ path: 'Code', op: 'equals', value: 'missing' }] },
    { type: 'unionRows', as: 'combined', from: 'items', with: 'other', on: 'Code', title: 'Matched assets' },
    { type: 'enrichRows', as: 'view', from: 'combined', purpose: 'viewComposer', columns: [{ path: 'Code', as: 'Code' }] }];
  templates.Matching = matching;
  templates.MatchingPaged = { ...matching, result: { tables: [
    { ...matching.result.tables[0], presentation: { largeTable: { mode: 'all' } } }
  ] } };
  const redis = await redisFixture(t);
  let total = 0;
  let sourceReads = 0;
  const mock = await upstream(t, templates, (url) => {
    if (url.pathname.endsWith('/Cst_QueryToolConfig/cards')) return { data: [{
      _id: 1, Code: ROOT, RootCode: ROOT, Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRowsDefault: 2, maxRowsMax: 6 } })
    }] };
    if (!/\/classes\/Asset\/cards(?:\/|$)/.test(url.pathname)) return;
    sourceReads += 1;
    const offset = Number(url.searchParams.get('start') || 0);
    const limit = Number(url.searchParams.get('limit') || total);
    const data = rows(...Array.from({ length: total }, (_, i) => 'asset-' + (i + 1)));
    return { data: data.slice(offset, offset + limit), total };
  });
  const request = await backend(t, mock, redis.origin, {
    CMDP_EXECUTION_MAX_ROWS_ABSOLUTE: String(ordinaryCap), CMDP_LARGE_TABLE_MAX_ROWS: String(pagedCap)
  });
  const publishTemplate = (code) => publish(request, code, templates[code]);
  const publicRun = (code, query = 'json=true') => request('/public-snapshots/' + code + '/run?' + query);
  const assertRowLimit = ({ status, json }, expected) => {
    assert.equal(status, 422, JSON.stringify(json));
    assert.equal(json.code, 'table_result_incomplete');
    assert.equal(json.result, undefined);
    assert.equal(json.tableView, undefined);
    const diagnostic = json.diagnostics?.limits?.find(({ limitName }) => limitName === 'maxRows');
    assert.ok(diagnostic, JSON.stringify(json));
    for (const [key, value] of Object.entries({
      table: 'items', phase: 'rows', stepAlias: 'items', sourceLabel: stepLabel, stepLabel, ...expected
    })) {
      assert.deepEqual(diagnostic[key], value, `${key}: ${JSON.stringify(diagnostic)}`);
    }
  };

  await t.test('ordinary steps without a limit inherit the ordinary ceiling, not maxRowsDefault', async () => {
    total = ordinaryCap;
    const published = await publishTemplate('Ordinary');
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const before = await publicRun('Ordinary');
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.tables[0].rows, Array.from({ length: ordinaryCap }, (_, i) => ({ Code: 'asset-' + (i + 1) })));
    total += 1;
    assertRowLimit(await publishTemplate('Ordinary'), {
      rowLimitMode: 'ordinary', reason: 'limit_exceeded', effectiveLimit: ordinaryCap, observed: total,
      rowLimitCauses: ['ordinaryCeiling'], canUseLargeTable: true
    });
    assert.deepEqual(await publicRun('Ordinary'), before);
  });

  await t.test('ordinary and paged configuration conflicts fail before reading source data', async () => {
    total = 1;
    const readsBefore = sourceReads;
    const commitsBefore = redis.commits.length;
    for (const [code, rowLimitMode, cap, cause, canUseLargeTable] of [
      ['OrdinaryConflict', 'ordinary', ordinaryCap, 'ordinaryCeiling', true],
      ['PagedConflict', 'paged', pagedCap, 'pagedCeiling', false]
    ]) {
      assertRowLimit(await publishTemplate(code), {
        rowLimitMode, reason: 'row_limit_configuration_conflict', requested: cap + 1, effectiveLimit: cap,
        rowLimitCauses: [cause], canUseLargeTable, observed: undefined, truncated: false
      });
      assert.equal(sourceReads, readsBefore, `${code} must not read source data`);
      assert.equal(redis.commits.length, commitsBefore, `${code} must not commit a snapshot`);
    }
  });

  await t.test('a lower explicit step limit aborts refresh and preserves the prior snapshot', async () => {
    total = 3;
    const published = await publishTemplate('ExplicitLower');
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const before = await publicRun('ExplicitLower');
    assert.equal(before.status, 200);
    const expectedSnapshotRevision = before.json.cache.snapshotRevision;
    assert.ok(expectedSnapshotRevision);
    const readsBefore = sourceReads;
    const commitsBefore = redis.commits.length;
    total += 1;
    const refresh = await request('/templates/ExplicitLower/refresh-snapshot', {
      token: 'editor', method: 'POST', body: { expectedMode: 'shared', expectedSnapshotRevision }
    });
    assertRowLimit(refresh, {
      rowLimitMode: 'ordinary', reason: 'limit_exceeded', requested: 3, effectiveLimit: 3, observed: total,
      rowLimitCauses: ['stepLimit']
    });
    assert.ok(sourceReads > readsBefore, 'a valid lower limit is enforced on the actual result');
    assert.equal(redis.commits.length, commitsBefore);
    assert.deepEqual(await publicRun('ExplicitLower'), before);
  });

  await t.test('enabling pagination removes an ordinary threshold conflict in a matching input', async () => {
    const readsBefore = sourceReads;
    const failed = await publishTemplate('Matching');
    assertRowLimit(failed, {
      table: 'view', rowLimitMode: 'ordinary', reason: 'row_limit_configuration_conflict',
      requested: ordinaryCap + 1, effectiveLimit: ordinaryCap, canUseLargeTable: true, sourceLabel: 'Matched assets'
    });
    assert.equal(sourceReads, readsBefore);
    total = ordinaryCap + 1;
    const published = await publishTemplate('MatchingPaged');
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.result.tables[0].rows.length, total);
  });

  await t.test('paged steps inherit the paged ceiling and publish every row up to that ceiling', async () => {
    total = pagedCap;
    const published = await publishTemplate('Paged');
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const shell = await publicRun('Paged', 'cmdpTableShell=1');
    assert.equal(shell.status, 200);
    const snapshotRevision = shell.json.tableView.snapshotRevision;
    const pagePath = '/public-snapshots/Paged/table-page?cmdpTable=' + encodeURIComponent(JSON.stringify({
      table: 'items', op: 'rows', offset: pagedCap - 1, limit: 1, snapshotRevision
    }));
    const lastPage = await request(pagePath);
    assert.equal(lastPage.status, 200);
    assert.equal(lastPage.json.total, pagedCap);
    assert.equal(lastPage.json.incomplete, false);
    assert.deepEqual(lastPage.json.table.rows, [{ Code: 'asset-' + pagedCap }]);
    total += 1;
    assertRowLimit(await publishTemplate('Paged'), {
      rowLimitMode: 'paged', reason: 'limit_exceeded', effectiveLimit: pagedCap, observed: total,
      rowLimitCauses: ['pagedCeiling'], canUseLargeTable: false
    });
    assert.deepEqual(await publicRun('Paged', 'cmdpTableShell=1'), shell);
    assert.deepEqual(await request(pagePath), lastPage);
  });
});

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

test('Redis fences delayed snapshot writes and distinguishes a timeout before EVAL', async (t) => {
  const redis = await redisFixture(t);
  const code = 'CommitDeadline';
  const spec = { version: 1, steps: [SELECT], result: { tables: [PAGED] }, publish: SHARED };
  const mock = await upstream(t, { [code]: spec }, (url, token) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) return { data: rows(token) };
  });
  const timeoutMs = 1000;
  const request = await backend(t, mock, redis.origin, {
    CMDP_DRAFT_PREVIEW_TIMEOUT_MS: String(timeoutMs), CMDBDYNAMIC_REDIS_TIMEOUT_MS: '2000'
  });
  assert.equal((await publish(request, code, spec, 'original')).status, 200);
  const publicPath = '/public-snapshots/' + code + '/run?json=true';
  const before = (await request(publicPath)).json;
  const revision = before.cache.snapshotRevision;
  assert.ok(revision);
  assert.equal(before.tables[0].rows[0].Code, 'original');
  const initialIndex = [...redis.sets].map(([key, items]) => [key, [...items]]);
  const refresh = () => request('/templates/' + code + '/refresh-snapshot?cmdpTableShell=1', {
    method: 'POST', token: 'replacement', body: { expectedMode: 'shared', expectedSnapshotRevision: revision }
  });
  const assertTimeout = (response, reason) => {
    assert.equal(response.status, 504, JSON.stringify(response.json));
    assert.equal(response.json.reason, reason);
    assert.equal(response.json.code, reason);
    assert.equal(response.json.result, undefined);
    assert.equal(response.json.tableView, undefined);
    const [limit] = response.json.diagnostics.limits;
    assert.deepEqual([limit.phase, limit.table, limit.limitName, limit.reason],
      ['commit', '', 'executionTimeoutMs', 'deadline_exceeded']);
    assert.equal(limit.stepAlias, undefined);
  };

  redis.faults.timeReplyDelay = 350;
  redis.faults.beforeCommit = async ({ sampledTime, deadline }) => {
    assert.ok(deadline > redis.redisNow(), 'EVAL was sent before the translated deadline');
    assert.ok(deadline - sampledTime <= timeoutMs - 300, 'TIME reply transit consumes the commit budget');
    await new Promise((resolve) => setTimeout(resolve, deadline - redis.redisNow() + 30));
  };
  assertTimeout(await publish(request, code, spec, 'replacement'), 'draft_preview_timeout');
  assertTimeout(await refresh(), 'snapshot_refresh_timeout');
  assert.deepEqual(redis.commits.map(({ outcome }) => outcome), [1, -1, -1]);
  assert.deepEqual((await request(publicPath)).json, before);

  redis.faults.timeReplyDelay = timeoutMs + 150;
  assertTimeout(await refresh(), 'snapshot_refresh_timeout');
  assert.equal(redis.commits.length, 3, 'a TIME reply arriving out of budget cannot dispatch EVAL');
  assert.deepEqual((await request(publicPath)).json, before);
  assert.deepEqual([...redis.sets].map(([key, items]) => [key, [...items]]), initialIndex);
});

test('lost Redis ACK permits same-instance readback without repeating the write', async (t) => {
  const redis = await redisFixture(t);
  const code = 'CommitAck';
  const spec = { version: 1, steps: [SELECT], result: { tables: [PAGED] }, publish: SHARED };
  const mock = await upstream(t, { [code]: spec }, (url, token) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) return { data: rows(token) };
  });
  const env = { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: '1000', CMDBDYNAMIC_REDIS_TIMEOUT_MS: '2000' };
  const writer = await backend(t, mock, redis.origin, env);
  assert.equal((await publish(writer, code, spec, 'original')).status, 200);
  const publicPath = '/public-snapshots/' + code + '/run?json=true';
  const before = await writer(publicPath);
  const assertUnknown = (response) => {
    assert.equal(response.status, 503, JSON.stringify(response.json));
    assert.equal(response.json.reason, 'snapshot_commit_outcome_unknown');
    assert.equal(response.json.code, response.json.reason);
    assert.equal(response.json.result, undefined);
    assert.equal(response.json.tableView, undefined);
    assert.equal(response.json.diagnostics, undefined);
  };

  redis.faults.commitAck = 'hold';
  assertUnknown(await writer('/templates/' + code + '/refresh-snapshot?cmdpTableShell=1', {
    method: 'POST', token: 'shared', body: {
      expectedMode: 'shared', expectedSnapshotRevision: before.json.cache.snapshotRevision
    }
  }));
  const shared = await writer(publicPath);
  assert.equal(shared.status, 200);
  assert.notEqual(shared.json.cache.snapshotRevision, before.json.cache.snapshotRevision);
  assert.equal(shared.json.tables[0].rows[0].Code, 'shared');

  redis.faults.commitAck = 'drop';
  assertUnknown(await publish(writer, code, spec, 'republished'));
  const republished = await writer(publicPath);
  assert.equal(republished.status, 200);
  assert.notEqual(republished.json.cache.snapshotRevision, shared.json.cache.snapshotRevision);
  assert.equal(republished.json.tables[0].rows[0].Code, 'republished');
  assert.deepEqual(redis.commits.map(({ outcome }) => outcome), [1, 1, 1], 'each write was dispatched exactly once');
});

test('snapshot command ACL denial and pre-write read failure are definitive; script errors are not', async (t) => {
  const redis = await redisFixture(t);
  const code = 'CommitDenial';
  const spec = { version: 1, steps: [SELECT], result: { tables: [TABLE] }, publish: SHARED };
  const mock = await upstream(t, { [code]: spec }, (url, token) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) {
      if (token === 'read-failure') return { status: 502 };
      return { data: rows(token) };
    }
  });
  const writer = await backend(t, mock, redis.origin);
  const publicPath = '/public-snapshots/' + code + '/run?json=true';
  assert.equal((await publish(writer, code, spec, 'original')).status, 200);
  const before = await writer(publicPath);

  const readFailed = await publish(writer, code, spec, 'read-failure');
  assert.equal(readFailed.status, 502, JSON.stringify(readFailed.json));
  assert.equal(readFailed.json.reason, 'snapshot_refresh_data_unavailable');
  assert.equal(redis.commits.length, 1);
  assert.deepEqual(await writer(publicPath), before);

  redis.faults.commitAck = 'denied';
  const denied = await publish(writer, code, spec, 'acl-denied');
  assert.equal(denied.status, 503, JSON.stringify(denied.json));
  assert.equal(denied.json.reason, 'snapshot_storage_unavailable');
  assert.equal(redis.commits[1].outcome, undefined);
  assert.deepEqual(await writer(publicPath), before);

  redis.faults.commitAck = 'script-error';
  const uncertain = await publish(writer, code, spec, 'script-error');
  assert.equal(uncertain.status, 503, JSON.stringify(uncertain.json));
  assert.equal(uncertain.json.reason, 'snapshot_commit_outcome_unknown');
  assert.equal((await writer(publicPath)).json.tables[0].rows[0].Code, 'script-error');
  assert.equal(redis.commits.length, 3);
});

test('shared refresh uses Redis revision CAS to reject a competing republish', async (t) => {
  const redis = await redisFixture(t);
  const code = 'CommitCas';
  const spec = { version: 1, steps: [SELECT], result: { tables: [TABLE] }, publish: SHARED };
  const mock = await upstream(t, { [code]: spec }, (url, token) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) return { data: rows(token) };
  });
  const env = { CMDBDYNAMIC_REDIS_TIMEOUT_MS: '2000' };
  const writer = await backend(t, mock, redis.origin, env);
  const competitor = await backend(t, mock, redis.origin, env);
  assert.equal((await publish(writer, code, spec, 'original')).status, 200);
  const publicPath = '/public-snapshots/' + code + '/run?json=true';
  const before = await competitor(publicPath);
  const entered = deferredSignal();
  const release = deferredSignal();
  redis.faults.beforeCommit = () => {
    entered.resolve();
    return release.promise;
  };
  const pending = writer('/templates/' + code + '/refresh-snapshot', {
    method: 'POST', token: 'stale-writer',
    body: { expectedMode: 'shared', expectedSnapshotRevision: before.json.cache.snapshotRevision }
  });
  let current;
  try {
    await Promise.race([entered.promise, pending.then((response) => assert.fail(JSON.stringify(response)))]);
    redis.faults.beforeCommit = null;
    assert.equal((await publish(competitor, code, spec, 'competitor')).status, 200);
    current = await competitor(publicPath);
  } finally {
    release.resolve();
  }
  const stale = await pending;
  assert.equal(stale.status, 409, JSON.stringify(stale.json));
  assert.equal(stale.json.reason, 'snapshot_refresh_conflict');
  assert.equal(redis.commits[1].outcome, 0);
  assert.notEqual(current.json.cache.snapshotRevision, before.json.cache.snapshotRevision);
  assert.equal(current.json.tables[0].rows[0].Code, 'competitor');
  assert.deepEqual(await competitor(publicPath), current);
});

test('personal refresh timing out at the final recheck neither returns a view nor replaces existing data', async (t) => {
  const redis = await redisFixture(t);
  const code = 'PersonalCommitDeadline';
  const spec = { version: 1, steps: [SELECT], result: { tables: [PAGED] }, publish: STATIC };
  let timeOut = false;
  let readRows = false;
  let delayed = false;
  const mock = await upstream(t, { [code]: spec }, async (url, token) => {
    if (url.pathname.endsWith('/classes/Asset/cards')) {
      if (timeOut && token === 'reader') readRows = true;
      return { data: rows(timeOut ? 'candidate' : token) };
    }
    if (readRows && url.pathname.endsWith('/classes/Cst_QueryTemplate/cards')) {
      readRows = false;
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 1150));
    }
  });
  const request = await backend(t, mock, redis.origin, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: '1000' });
  assert.equal((await publish(request, code, spec, 'original')).status, 200);
  const publicPath = '/public-snapshots/' + code + '/run?json=true';
  const before = await request(publicPath);
  const refresh = () => request('/templates/' + code + '/refresh-snapshot?cmdpTableShell=1', {
    method: 'POST', token: 'reader',
    body: { expectedMode: 'personal', expectedSnapshotRevision: before.json.cache.snapshotRevision }
  });
  const open = await refresh();
  assert.equal(open.status, 200);
  const viewId = open.json.tableView.viewId;
  assert.ok(viewId);
  timeOut = true;
  const expired = await refresh();
  assert.equal(delayed, true, 'the timeout happened at the final template recheck');
  assert.equal(expired.status, 504, JSON.stringify(expired.json));
  assert.equal(expired.json.reason, 'snapshot_refresh_timeout');
  assert.equal(expired.json.diagnostics.limits[0].phase, 'commit');
  assert.equal(expired.json.result, undefined);
  assert.equal(expired.json.tableView, undefined);
  const page = await request('/templates/' + code + '/table-page?cmdpTable=' +
    encodeURIComponent(JSON.stringify({ table: 'items', op: 'rows', viewId })), { token: 'reader' });
  assert.equal(page.status, 200);
  assert.equal(page.json.table.rows[0].Code, 'reader');
  assert.deepEqual(await request(publicPath), before);
  assert.equal(redis.commits.length, 1, 'only the initial publication wrote to Redis');
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
