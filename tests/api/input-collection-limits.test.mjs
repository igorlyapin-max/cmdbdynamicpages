import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t, env = {}) {
  const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    upstreamCalls.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { username: 'test-admin', role: 'Admin' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
    env: {
      ...process.env, NODE_ENV: 'test', PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port),
      CMDBUILD_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
      CMDBDYNAMIC_REDIS_ENABLED: 'false', CMDBDYNAMIC_HEALTH_REDIS_REQUIRED: 'false',
      CMDBDYNAMICPAGES_CSRF_SECRET: 'collection-limit-test-only',
      CMDP_INPUT_MAX_COLLECTION_ITEMS: '5000', CMDP_INPUT_MAX_TOTAL_ITEMS: '50000',
      CMDP_D2_IMPORT_MAX_ELEMENTS: '5000', CMDP_LOG_TARGET: 'stdout', CMDP_LOG_LEVEL: 'warn',
      ...env
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  });
  const deadline = Date.now() + 10000;
  while (true) {
    try { if ((await fetch(origin + '/health/live')).ok) break; } catch { /* Wait for the test process. */ }
    assert.ok(Date.now() < deadline && child.exitCode === null, output);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cookie = 'CMDBuild-Authorization=collection-limit-test-session';
  const csrfResponse = await fetch(origin + '/cmdbuild/custom-api/csrf', { headers: { cookie } });
  assert.equal(csrfResponse.status, 200);
  const csrf = (await csrfResponse.json()).token;
  upstreamCalls.length = 0;
  async function request(path, body, options = {}) {
    const headers = { cookie, origin, 'content-type': 'application/json',
      ...(options.csrf === false ? {} : { 'x-cmdbdynamicpages-csrf': csrf }) };
    if (options.rawPath) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: options.rawPath,
          method: options.method || 'POST', headers, signal: AbortSignal.timeout(10000)
        }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { data += chunk; });
          res.on('error', reject);
          res.on('end', () => {
            try { resolve({ status: res.statusCode, json: JSON.parse(data), requestId: res.headers['x-request-id'] }); }
            catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    }
    const response = await fetch(origin + '/cmdbuild/custom-api' + path, {
      method: options.method || 'POST',
      headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, json: await response.json(), requestId: response.headers.get('x-request-id') };
  }
  return { request, upstreamCalls, output: () => output };
}

function spec(count) {
  return { version: 1, steps: [{ type: 'selectCards', className: 'IS', as: 'objects',
    filters: Array.from({ length: count }, () => ({ attribute: 'Name', op: 'equals', value: 'not-logged-business-value' })) }],
  result: { tables: [{ name: 'objects' }] } };
}

function rowOperationSpec(count) {
  return { version: 1, steps: [
    { type: 'extractVariables', as: 'left', sourceValue: ['A', 'B'], regex: '^(?<Code>.+)$', all: true },
    { type: 'extractVariables', as: 'right', sourceValue: ['B', 'C'], regex: '^(?<Code>.+)$', all: true },
    { type: 'unionRows', as: 'allCodes', from: 'left', with: 'right', column: Array(count).fill('Code'), distinct: true }
  ], result: { tables: [{ name: 'allCodes', columns: ['Code'] }] } };
}

function pairRules(count, rule = { leftColumn: 'Code', rightColumn: 'Code', operator: 'equals' }) {
  return { semanticPlan: { blocks: [{ resultContract: { pair: {
    mode: 'match', rules: Array(count).fill(rule)
  } } }] } };
}

test('owned authoring endpoints reject excessive collections before any upstream read or write', async (t) => {
  const f = await fixture(t);
  const excessiveSpec = spec(5001);
  const cases = [
    ['/templates', { code: 'Limited', spec: excessiveSpec }],
    ['/templates/Limited', { spec: excessiveSpec }, { method: 'PUT' }],
    ['/draft/validate', { spec: excessiveSpec }],
    ['/draft/preview', { spec: JSON.stringify(excessiveSpec) }],
    ['/draft/object-flow/apply', { flow: { selections: [{ rules: excessiveSpec.steps[0].filters }] } }],
    ['/assistant/object-flow/plan', { intent: { blocks: Array.from({ length: 33 }, () => ({})) } }],
    ['/assistant/object-flow/semantic-plan', { intent: { blocks: [{ uses: Array(32).fill('duplicate') }] } }],
    ['/draft/diagram-import/analyze', { currentSpec: excessiveSpec }],
    ['/draft/diagram-import/apply', { roles: Array.from({ length: 5001 }, () => ({})) }],
    ['/draft/diagram-import/refresh', { structureTree: { items: Array.from({ length: 5001 }, () => ({})) } }],
    ['/draft/diagram-import/restore', { analysisCheckpoint: { roles: Array.from({ length: 5001 }, () => ({})) } }],
    ['/assistant/diagram-import/map-selections', { editorDelta: { version: 1, spec: excessiveSpec } }]
  ];
  for (const [path, body, options] of cases) {
    const response = await f.request(path, body, options);
    assert.equal(response.status, 413, path + ': ' + JSON.stringify(response.json));
    assert.equal(response.json.code, 'input_collection_limit', path);
    assert.ok(response.json.requestId, path);
    assert.ok(response.json.errors[0].path.startsWith('$.'), path);
    assert.ok(response.json.errors[0].actualCount > response.json.errors[0].limit, path);
    assert.ok(!JSON.stringify(response.json).includes('not-logged-business-value'), path);
    assert.deepEqual(f.upstreamCalls, [], path);
  }
  assert.match(f.output(), /security\.input_collection_limit/);
  assert.ok(!f.output().includes('not-logged-business-value'));
});

test('boundary-sized filters remain valid and CSRF is still required', async (t) => {
  const f = await fixture(t);
  const valid = await f.request('/draft/validate', { spec: spec(5000) });
  assert.equal(valid.status, 200, JSON.stringify(valid.json));
  assert.equal(valid.json.success, true);
  assert.deepEqual(f.upstreamCalls, []);
  const denied = await f.request('/draft/validate', { spec: spec(5001) }, { csrf: false });
  assert.equal(denied.status, 403);
  assert.deepEqual(f.upstreamCalls, []);
});

test('configured collection and aggregate budgets are enforced without changing literals', async (t) => {
  const f = await fixture(t, { CMDP_INPUT_MAX_COLLECTION_ITEMS: '3', CMDP_INPUT_MAX_TOTAL_ITEMS: '5', CMDP_D2_IMPORT_MAX_ELEMENTS: '2' });
  const validSpec = spec(3);
  validSpec.steps[0].filters[0].value = Array(100).fill('literal');
  const valid = await f.request('/draft/validate', { spec: validSpec });
  assert.equal(valid.status, 200, JSON.stringify(valid.json));
  const aggregate = spec(3);
  aggregate.steps[0].columns = ['Name'];
  const total = await f.request('/draft/validate', { spec: aggregate });
  assert.equal(total.status, 413, JSON.stringify(total.json));
  assert.equal(total.json.errors[0].limit, 5);
  const d2 = await f.request('/draft/diagram-import/apply', { roles: [{}, {}, {}] });
  assert.equal(d2.status, 413);
  assert.equal(d2.json.errors[0].limit, 2);
  assert.deepEqual(f.upstreamCalls, []);
});

test('row-operation column arrays accept the default boundary and reject the next raw duplicate', async (t) => {
  const f = await fixture(t);
  const valid = await f.request('/draft/preview', { spec: rowOperationSpec(5000) });
  assert.equal(valid.status, 200, JSON.stringify(valid.json));
  assert.deepEqual(valid.json.result.tables.find((table) => table.name === 'allCodes').rows.map((row) => row.Code), ['A', 'B', 'C']);
  assert.ok(f.upstreamCalls.every((call) => call.method === 'GET'));
  f.upstreamCalls.length = 0;
  for (const [path, body] of [
    ['/draft/validate', { spec: rowOperationSpec(5001) }],
    ['/draft/preview', { spec: JSON.stringify(rowOperationSpec(5001)) }],
    ['/draft/object-flow/apply', { flow: { operations: [{ type: 'unionRows', column: Array(5001).fill('Code') }] } }]
  ]) {
    const response = await f.request(path, body);
    assert.equal(response.status, 413, JSON.stringify(response.json));
    assert.equal(response.json.code, 'input_collection_limit');
    assert.match(response.json.errors[0].path, /\.column$/);
    assert.equal(response.json.errors[0].actualCount, 5001);
    assert.equal(response.json.errors[0].limit, 5000);
  }
  assert.deepEqual(f.upstreamCalls, []);
});

test('semantic pair rules are guarded at the default collection boundary before normalization', async (t) => {
  const f = await fixture(t);
  // Stay below the independent request-byte limit to exercise the raw collection guard.
  const response = await f.request('/assistant/object-flow/semantic-plan', pairRules(5001, {}));
  assert.equal(response.status, 413, JSON.stringify(response.json));
  assert.equal(response.json.code, 'input_collection_limit');
  assert.equal(response.json.errors[0].path, '$.semanticPlan.blocks[0].resultContract.pair.rules');
  assert.equal(response.json.errors[0].actualCount, 5001);
  assert.equal(response.json.errors[0].limit, 5000);
  assert.deepEqual(f.upstreamCalls, []);
});

test('configured row key and pair rule limits count raw duplicates and aggregate occurrences', async (t) => {
  const f = await fixture(t, { CMDP_INPUT_MAX_COLLECTION_ITEMS: '3', CMDP_INPUT_MAX_TOTAL_ITEMS: '8' });
  const valid = await f.request('/draft/validate', { spec: rowOperationSpec(3) });
  assert.equal(valid.status, 200, JSON.stringify(valid.json));
  assert.equal(valid.json.success, true);
  const aggregate = rowOperationSpec(3);
  aggregate.steps[0].columns = ['Code', 'Code', 'Code'];
  const bodies = [
    ['/draft/validate', { spec: rowOperationSpec(4) }, '$.spec.steps[2].column', 4, 3],
    ['/assistant/object-flow/semantic-plan', pairRules(4), '$.semanticPlan.blocks[0].resultContract.pair.rules', 4, 3],
    ['/draft/validate', { spec: aggregate }, '$.spec.steps[2].column', 9, 8],
    ['/assistant/object-flow/semantic-plan', {
      ...pairRules(3), flow: { operations: [{ column: ['Code', 'Code'] }, { column: ['Code'] }] }
    }, '$.semanticPlan.blocks[0].resultContract.pair.rules', 9, 8]
  ];
  for (const [path, body, errorPath, actualCount, limit] of bodies) {
    const response = await f.request(path, body);
    assert.equal(response.status, 413, JSON.stringify(response.json));
    assert.equal(response.json.code, 'input_collection_limit');
    assert.deepEqual(response.json.errors[0], { path: errorPath, actualCount, limit });
  }
  assert.deepEqual(f.upstreamCalls, []);
});

test('raw dot-segment request paths cannot bypass authoring collection guards', async (t) => {
  const f = await fixture(t);
  const body = { spec: spec(5001) };
  for (const [rawPath, method = 'POST'] of [
    ['/cmdbuild/custom-api/draft/./validate'],
    ['/cmdbuild/custom-api/draft/unused/../validate'],
    ['/cmdbuild/custom-api/draft/%2e/validate'],
    ['/cmdbuild/custom-api/draft/unused/%2e%2e/validate'],
    ['/cmdbuild/custom-api/unused/../draft/validate'],
    ['/cmdbuild/unused/../custom-api/draft/validate'],
    ['/cmdbuild/custom-api/unused/../draft/preview?maxRows=1'],
    ['/cmdbuild/custom-api/unused/../templates'],
    ['/cmdbuild/custom-api/templates/unused/../Limited', 'PUT']
  ]) {
    const response = await f.request('', body, { rawPath, method });
    assert.equal(response.status, 413, rawPath + ': ' + JSON.stringify(response.json));
    assert.equal(response.json.code, 'input_collection_limit', rawPath);
    assert.equal(response.json.errors[0].path, '$.spec.steps[0].filters', rawPath);
    assert.deepEqual(f.upstreamCalls, [], rawPath);
  }
  const denied = await f.request('', body, { rawPath: '/cmdbuild/custom-api/draft/./validate', csrf: false });
  assert.equal(denied.status, 403);
  assert.deepEqual(f.upstreamCalls, []);
  assert.ok(!f.output().includes('not-logged-business-value'));
});
