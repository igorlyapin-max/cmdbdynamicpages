import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

test('draft preview executes exact router anchor before selecting ARM cards by Location', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=preview-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const spec = {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'routerG',
        filters: [{ path: 'Description', op: 'equals', value: 'Маршрутизатор для Test City 300' }],
        columns: ['Code', 'Description', 'Location'],
        limit: 1
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'ARM',
        filters: [{ path: 'Location', op: 'equals', valueColumn: 'Location' }],
        columns: ['Code', 'Description', 'Location', 'model', 'model2'],
        limit: 100
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Code', 'Description', 'Location', 'model', 'model2'] }]
    }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: {
      code: 'RouterArmPreview',
      spec
    },
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json.success, true);
  assert.deepEqual(preview.json.result.trace.map((item) => [item.as, item.rows]), [
    ['routerAnchor', 1],
    ['arms', 2]
  ]);
  const table = preview.json.result.tables.find((item) => item.name === 'arms');
  assert.ok(table, 'arms table is present');
  assert.deepEqual(table.rows.map((row) => row.Code).sort(), ['ARM-001', 'ARM-002']);
  assert.deepEqual(
    table.rows.map((row) => [row.Code, row.model, row.model2]).sort((left, right) => left[0].localeCompare(right[0])),
    [
      ['ARM-001', 'model-a', 'model2-a'],
      ['ARM-002', 'model-b', 'model2-b']
    ]
  );
  assert.equal(table.rows.some((row) => row.Code === 'ARM-003'), false);
  assert.equal(table.rows.some((row) => row.Class === 'routerG'), false);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), true);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), true);
  const armCardsRequest = mock.requests.find((item) => item.pathname.endsWith('/classes/ARM/cards'));
  const requestedAttributes = new URLSearchParams(armCardsRequest.search).get('attributes') || '';
  assert.ok(requestedAttributes.split(',').includes('model'));
  assert.ok(requestedAttributes.split(',').includes('model2'));
  assert.equal(mock.requests.some((item) => item.pathname.includes('/relations')), false);
  assert.equal(backend.exitCode, null);
});

test('model metadata endpoints read inherited attributes with service scope', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=metadata-test-token';

  const attributes = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/classes/routerG/attributes`,
    undefined,
    { cookie }
  );

  assert.equal(attributes.statusCode, 200, attributes.body);
  assert.deepEqual(attributes.json.data.map((item) => [item.name, item.inherited]), [
    ['Location', false],
    ['model', true],
    ['model2', false]
  ]);
  assert.equal(attributes.json.data.some((item) => item.name === 'hiddenModel'), false);

  const catalog = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/catalog?maxClasses=5&maxDomains=5&includeAttributes=true`,
    undefined,
    { cookie }
  );

  assert.equal(catalog.statusCode, 200, catalog.body);
  const routerClass = catalog.json.catalog.classes.find((item) => item.name === 'routerG');
  assert.ok(routerClass, 'routerG catalog class is present');
  assert.deepEqual(routerClass.attributes.map((item) => item.name), ['Location', 'model', 'model2']);
  assert.equal(mock.requests.some((item) =>
    item.pathname.endsWith('/classes/routerG/attributes') &&
    item.search === '?scope=service&limit=1000'
  ), true);
  assert.equal(backend.exitCode, null);
});

async function startMockCmdbuild(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({
      method: req.method || '',
      pathname: requestUrl.pathname,
      search: requestUrl.search
    });

    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/sessions/current') {
      sendJson(res, 200, { data: { username: 'preview-user', role: 'Admin' } });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes') {
      sendJson(res, 200, {
        data: [
          { _id: 1, name: 'routerG', description: 'Маршрутизатор', active: true },
          { _id: 2, name: 'ARM', description: 'АРМ', active: true },
          { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true }
        ]
      });
      return;
    }
    if (requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/[^/]+\/attributes$/)) {
      if (requestUrl.searchParams.get('scope') !== 'service' || requestUrl.searchParams.get('limit') !== '1000') {
        sendJson(res, 404, { message: `missing service-scope attributes query: ${requestUrl.pathname}${requestUrl.search}` });
        return;
      }
      const className = decodeURIComponent(requestUrl.pathname.split('/').at(-2));
      const fixtures = {
        routerG: [
          { name: 'Location', type: 'reference', targetClass: 'Location', inherited: false, active: true, _can_read: true },
          { name: 'model', type: 'string', inherited: true, active: true, _can_read: true },
          { name: 'model2', type: 'string', inherited: false, active: true, _can_read: true },
          { name: 'hiddenModel', type: 'string', inherited: true, active: true, _can_read: false },
          { name: 'inactiveModel', type: 'string', inherited: true, active: false, _can_read: true }
        ],
        ARM: [
          { name: 'Location', type: 'reference', targetClass: 'Location', inherited: false, active: true, _can_read: true },
          { name: 'model', type: 'string', inherited: true, active: true, _can_read: true },
          { name: 'model2', type: 'string', inherited: false, active: true, _can_read: true }
        ],
        Cst_QueryToolConfig: []
      };
      sendJson(res, 200, { data: fixtures[className] || [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/domains') {
      sendJson(res, 200, { data: [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/lookup_types') {
      sendJson(res, 200, { data: [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryToolConfig/cards') {
      sendJson(res, 200, { data: [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/routerG/cards') {
      sendJson(res, 200, {
        data: paginate(requestUrl, [
          {
            _id: 302,
            Code: 'router-other',
            Description: 'Маршрутизатор для Test City 300 backup',
            Location: 400,
            _Location_description: 'Test City 400'
          },
          {
            _id: 301,
            Code: 'router-target',
            Description: 'Маршрутизатор для Test City 300',
            Location: 300,
            _Location_description: 'Test City 300'
          }
        ])
      });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/ARM/cards') {
      sendJson(res, 200, {
        data: paginate(requestUrl, [
          {
            _id: 503,
            Code: 'ARM-003',
            Description: 'АРМ 003',
            Location: 400,
            _Location_description: 'Test City 400'
          },
          {
            _id: 501,
            Code: 'ARM-001',
            Description: 'АРМ 001',
            Location: 901,
            _Location_description: 'Test City 300',
            model: 'model-a',
            model2: 'model2-a'
          },
          {
            _id: 502,
            Code: 'ARM-002',
            Description: 'АРМ 002',
            Location: 902,
            _Location_description: 'Test City 300',
            model: 'model-b',
            model2: 'model2-b'
          }
        ])
      });
      return;
    }

    sendJson(res, 404, { message: `Unhandled mock CMDBuild route: ${requestUrl.pathname}` });
  });
  await listen(server, 0);
  t.after(() => closeServer(server));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests
  };
}

function paginate(requestUrl, rows) {
  const limit = Number(requestUrl.searchParams.get('limit') || rows.length);
  const start = Number(requestUrl.searchParams.get('start') || 0);
  return rows.slice(start, start + limit);
}

async function startBackend(t, port, cmdbuildOrigin) {
  const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: String(port),
      CMDBUILD_ORIGIN: cmdbuildOrigin,
      CMDBDYNAMIC_REDIS_ENABLED: 'false',
      CMDBDYNAMIC_HEALTH_REDIS_REQUIRED: 'false',
      CMDBDYNAMICPAGES_CSRF_SECRET: 'preview-test-csrf-secret',
      CMDP_LOG_LEVEL: 'silent',
      CMDP_LOG_TARGET: 'stdout',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  t.after(() => stopChild(child));
  await waitFor(async () => {
    const result = await requestJson('GET', `http://127.0.0.1:${port}/health/live`, undefined, {}, 500);
    return result.statusCode === 200;
  }, 5000, () => output);
  return child;
}

async function requestJson(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const result = await request(method, url, body, extraHeaders, timeoutMs);
  let json = null;
  try {
    json = result.body ? JSON.parse(result.body) : null;
  } catch {
    json = null;
  }
  return {
    ...result,
    json
  };
}

function request(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      accept: 'application/json,*/*',
      ...extraHeaders
    };
    if (payload !== null) {
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function hasHeader(headers, name) {
  const normalized = String(name || '').toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(check, timeoutMs, details) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const suffix = typeof details === 'function' ? details() : '';
  throw new Error(`Timed out waiting for backend startup.${lastError ? ` Last error: ${lastError.message}` : ''}${suffix ? `\n${suffix}` : ''}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
