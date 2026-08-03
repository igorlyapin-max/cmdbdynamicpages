import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const REQUIRED_TEST_NAMES = [
  'Designer opens on the template list with fixed menu and action bar',
  'Designer asks for a normal Save when a recovered D2 mapping is ready but not persisted',
  'Extraction remains usable with recovered Object Flow labels when Assistant is unavailable',
  'About screen displays the embedded application version'
];
const TEST_NAME_PATTERN = `^(${REQUIRED_TEST_NAMES.join('|')})$`;
const backendLogs = [];

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(Number(address.port));
    });
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(Number(address.port)));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForHealth(origin, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = http.get(`${origin}/health/live`, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
      request.setTimeout(1_000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Required UI smoke backend did not become healthy.\n${backendLogs.join('')}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function createMockCmdbuild() {
  const classes = [
    { _id: 1, name: 'Cst_QueryTool', description: 'Cst_QueryTool', active: true },
    { _id: 2, name: 'Cst_QueryToolConfig', description: 'Cst_QueryToolConfig', active: true },
    { _id: 3, name: 'Cst_QueryTemplate', description: 'Cst_QueryTemplate', active: true },
    { _id: 4, name: 'Cst_QueryTemplateVersion', description: 'Cst_QueryTemplateVersion', active: true }
  ];
  const templateCards = [{
    _id: 'required-ui-template',
    Code: 'RequiredUiFixture',
    Description: 'Required UI fixture',
    Active: true,
    SpecJson: JSON.stringify({ version: 1, params: {}, steps: [], result: { tables: [] } }),
    ParamsSchemaJson: '{}',
    ResultSchemaJson: '{}',
    Owner: 'ui-fixture',
    UpdatedAt: '2026-01-01T00:00:00.000Z'
  }];
  const templateVersionCards = [];
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/cmdbuild/services/rest/v3/sessions' && request.method === 'POST') {
      sendJson(response, 200, { data: { _id: 'required-ui-fixture-session' } }, {
        'set-cookie': 'CMDBuild-Authorization=required-ui-fixture-session; HttpOnly; Path=/'
      });
      return;
    }
    if (url.pathname === '/cmdbuild/services/rest/v3/sessions/current') {
      sendJson(response, 200, {
        data: { username: 'ui-fixture', role: 'Admin', rolePrivileges: { admin_classes_modify: true } }
      });
      return;
    }
    if (url.pathname === '/cmdbuild/services/rest/v3/classes') {
      sendJson(response, 200, { data: classes });
      return;
    }
    const classMatch = url.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)$/);
    if (classMatch) {
      const name = decodeURIComponent(classMatch[1]);
      const found = classes.find((item) => item.name === name);
      sendJson(response, found ? 200 : 404, found ? {
        data: { ...found, _can_read: true, _can_create: true, _can_update: true }
      } : { message: `Unknown class ${name}` });
      return;
    }
    if (/^\/cmdbuild\/services\/rest\/v3\/classes\/[^/]+\/attributes$/.test(url.pathname)) {
      sendJson(response, 200, { data: [] });
      return;
    }
    if (url.pathname === '/cmdbuild/services/rest/v3/domains' || url.pathname === '/cmdbuild/services/rest/v3/lookup_types') {
      sendJson(response, 200, { data: [] });
      return;
    }
    if (url.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate/cards' && request.method === 'GET') {
      sendJson(response, 200, { data: templateCards });
      return;
    }
    const templateCardMatch = url.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/Cst_QueryTemplate\/cards\/([^/]+)$/);
    if (templateCardMatch && request.method === 'PUT') {
      const cardId = decodeURIComponent(templateCardMatch[1]);
      const cardIndex = templateCards.findIndex((card) => String(card._id) === cardId);
      if (cardIndex < 0) {
        sendJson(response, 404, { message: `Unknown template card ${cardId}` });
        return;
      }
      templateCards[cardIndex] = { ...templateCards[cardIndex], ...await readJson(request) };
      sendJson(response, 200, { data: templateCards[cardIndex] });
      return;
    }
    if (url.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplateVersion/cards' && request.method === 'GET') {
      const timer = setTimeout(() => {
        if (!response.destroyed) sendJson(response, 200, { data: templateVersionCards });
      }, 1_000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplateVersion/cards' && request.method === 'POST') {
      const card = { _id: `required-ui-version-${templateVersionCards.length + 1}`, ...await readJson(request) };
      templateVersionCards.push(card);
      sendJson(response, 200, { data: card });
      return;
    }
    if (/^\/cmdbuild\/services\/rest\/v3\/classes\/[^/]+\/cards$/.test(url.pathname)) {
      sendJson(response, 200, { data: [] });
      return;
    }
    sendJson(response, 404, { message: `Unhandled required UI fixture route: ${url.pathname}` });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        const text = String(chunk);
        output += text;
        process.stdout.write(text);
      });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
}

const mock = createMockCmdbuild();
let backend;
try {
  const cmdbuildPort = await listen(mock);
  const proxyPort = await reservePort();
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
  backend = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: String(proxyPort),
      CMDP_PUBLIC_ORIGIN: proxyOrigin,
      CMDBUILD_ORIGIN: `http://127.0.0.1:${cmdbuildPort}`,
      CMDBDYNAMIC_REDIS_REQUIRED: 'false',
      CMDBDYNAMIC_HEALTH_REDIS_REQUIRED: 'false',
      CMDP_D2_RENDER_ENABLED: 'false',
      CMDP_D2_IMPORT_BINARY: `${process.cwd()}/tests/fixtures/d2-import-stub.mjs`,
      CMDP_LOG_TARGET: 'stdout',
      CMDP_DIAGNOSTIC_MODE: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [backend.stdout, backend.stderr]) {
    stream.on('data', (chunk) => {
      backendLogs.push(String(chunk));
      if (backendLogs.length > 40) backendLogs.shift();
    });
  }
  await waitForHealth(proxyOrigin);
  const result = await run(process.execPath, [
    '--test',
    `--test-name-pattern=${TEST_NAME_PATTERN}`,
    'tests/ui/playwright-smoke.test.mjs'
  ], {
    env: {
      ...process.env,
      CMDBDYNAMIC_PROXY: proxyOrigin,
      CMDBUILD_ORIGIN: `http://127.0.0.1:${cmdbuildPort}`,
      CMDBUILD_LOGIN_ORIGIN: `http://127.0.0.1:${cmdbuildPort}`,
      CMDBUILD_USERNAME: 'ui-fixture',
      CMDBUILD_PASSWORD: 'ui-fixture',
      CMDBDYNAMIC_E2E_REQUIRED: '1'
    }
  });
  if (result.code !== 0 || result.signal) {
    throw new Error(`Required browser UI smoke failed with ${result.signal || `exit code ${result.code}`}.`);
  }
  const passPattern = new RegExp(`pass\\s+${REQUIRED_TEST_NAMES.length}\\b`, 'i');
  if (!passPattern.test(result.output) || /skipped\s+[1-9]\d*/i.test(result.output)) {
    throw new Error(`Required browser UI smoke did not execute all ${REQUIRED_TEST_NAMES.length} scenarios.\n${result.output}`);
  }
} finally {
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await Promise.race([once(backend, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (backend.exitCode === null) backend.kill('SIGKILL');
  }
  await closeServer(mock);
}
