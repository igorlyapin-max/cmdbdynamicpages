import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('scripts/dev-proxy-server.mjs', 'utf8');
const helperNames = ['parseResponse', 'requestRetryDelayMs', 'requestTimeoutError',
  'remainingRequestDeadlineMs', 'fetchWithinDeadline', 'getCsrfToken', 'request'];
const helpers = helperNames.map((name) => {
  const start = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start, 'Missing helper boundary: ' + name);
  return source.slice(start, end);
}).join('\n');

const owner = { templateCode: 'sample', section: 'diagrams', generation: 7 };

function response(status = 200, body = '{}', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: typeof body === 'function' ? body : async () => body
  };
}

function harness(fetchMock, { csrfToken = '', abortController = AbortController } = {}) {
  let now = 10000;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const diagnostics = [];
  class Clock extends Date {
    static now() { return now; }
  }
  const snapshot = (kind, value, context) => {
    const diagnostic = { kind, context: structuredClone(context) };
    diagnostics.push({ kind, value, diagnostic });
    return diagnostic;
  };
  const context = vm.createContext({
    Date: Clock,
    window: {
      AbortController: abortController,
      setTimeout(callback, delay) {
        const id = ++nextTimer;
        timers.set(id, { at: now + delay, callback });
        return id;
      },
      clearTimeout(id) { timers.delete(id); }
    },
    fetch(path, options) {
      calls.push({ path, options });
      return fetchMock(path, options, calls.length);
    },
    apiPrefix: '/api',
    csrfToken,
    clientRequestId: () => 'client-generated',
    uiRequestOwner: () => ({ ...owner }),
    uiRequestDiagnostics: {
      response: (result, ctx) => snapshot('response', result, ctx),
      exception: (error, ctx) => snapshot('exception', error, ctx)
    },
    createRequestError: (result) => Object.assign(new Error('HTTP ' + result.status), { diagnostic: result.diagnostic })
  });
  vm.runInContext(helpers, context);
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  return {
    context, calls, diagnostics, timers,
    request: (path, options) => context.request(path, options),
    flush,
    async advance(ms) {
      await flush();
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

test('actual parseResponse keeps its old shape and adds HTTP metadata', async () => {
  const h = harness(() => response());
  const result = await h.context.parseResponse(response(503, '{"message":"busy"}', {
    'Content-Type': 'application/json', 'X-Request-ID': 'server-id', 'Retry-After': '1'
  }), { requestId: 'client-id' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.json.message, 'busy');
  assert.equal(result.body, '{"message":"busy"}');
  assert.equal(result.retryAfter, '1');
  assert.equal(result.requestId, 'server-id');
  assert.equal(result.serverRequestId, 'server-id');
  assert.equal(result.contentType, 'application/json');
  assert.equal(h.diagnostics.length, 0);
  const html = await h.context.parseResponse(response(502, '<html>gateway</html>'), { requestId: 'client-id' });
  assert.equal(html.json, null);
  assert.equal(html.requestId, 'client-id');
  assert.equal(html.serverRequestId, '');
});

test('request retains server/client IDs separately and passes owner and action metadata', async () => {
  const h = harness(() => response(200, '{"ok":true}', { 'X-Request-ID': 'server-id', 'Content-Type': 'application/json' }));
  const result = await h.request('/api/items', {
    requestId: 'client-id', action: 'preview', phase: 'load', blockName: 'topology'
  });
  assert.equal(h.calls[0].options.headers['X-Request-ID'], 'client-id');
  assert.equal(result.requestId, 'server-id');
  assert.equal(result.serverRequestId, 'server-id');
  assert.equal(result.contentType, 'application/json');
  assert.deepEqual(result.diagnostic.context, {
    path: '/api/items', method: 'GET', requestId: 'client-id', startedAt: 10000,
    timeoutMs: 15000, attempt: 1, owner, action: 'preview', phase: 'load', blockName: 'topology'
  });
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.timers.size, 0);
});

test('GET retries only supported HTTP statuses and collects only final diagnostics', async () => {
  for (const status of [429, 502, 503, 504]) {
    const h = harness((path, options, attempt) => response(attempt < 3 ? status : 200, '{}', { 'Retry-After': '0.1' }));
    const pending = h.request('/api/items');
    await h.flush();
    assert.equal(h.diagnostics.length, 0);
    await h.advance(200);
    const result = await pending;
    assert.equal(h.calls.length, 3);
    assert.equal(result.status, 200);
    assert.equal(result.diagnostic.context.attempt, 3);
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('exhausted retries retain final HTTP response; non-retry HTTP errors stay results', async () => {
  const h = harness(() => response(503, '{"message":"busy"}'));
  const pending = h.request('/api/items', { maxRetries: 1 });
  await h.advance(250);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.diagnostic.context.attempt, 2);
  assert.equal(h.diagnostics.length, 1);
  const denied = harness(() => response(403));
  assert.equal((await denied.request('/api/items')).status, 403);
  assert.equal(denied.calls.length, 1);
});

test('network and body-read failures preserve Error identity with final diagnostics', async () => {
  for (const bodyFailure of [false, true]) {
    const error = new TypeError('Failed to fetch');
    const h = harness(() => bodyFailure ? response(200, () => Promise.reject(error)) : Promise.reject(error));
    await assert.rejects(h.request('/api/items', { action: 'inspect', phase: 'read', blockName: 'inventory' }), (caught) => {
      assert.equal(caught, error);
      assert.equal(caught.diagnostic.kind, 'exception');
      assert.deepEqual(caught.diagnostic.context.owner, owner);
      assert.equal(caught.diagnostic.context.path, '/api/items');
      assert.equal(caught.diagnostic.context.action, 'inspect');
      assert.equal(caught.diagnostic.context.phase, 'read');
      assert.equal(caught.diagnostic.context.blockName, 'inventory');
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('network failure after an HTTP retry keeps final attempt and original owner snapshot', async () => {
  const error = new TypeError('Failed to fetch');
  const h = harness((path, options, attempt) => attempt === 1 ? response(503) : Promise.reject(error));
  const pending = assert.rejects(h.request('/api/items'), (caught) => {
    assert.equal(caught, error);
    assert.equal(caught.diagnostic.context.attempt, 2);
    assert.deepEqual(caught.diagnostic.context.owner, owner);
    return true;
  });
  await h.flush();
  h.context.uiRequestOwner = () => ({ templateCode: 'other', section: 'another', generation: 8 });
  assert.equal(h.diagnostics.length, 0);
  await h.advance(250);
  await pending;
  assert.equal(h.calls.length, 2);
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.timers.size, 0);
});

test('deadline stays active through a hanging body and aborts its read', async () => {
  let bodyStarted = false;
  let readAborted = false;
  const h = harness((path, options) => response(200, () => {
    bodyStarted = true;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      readAborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }));
  }));
  const pending = assert.rejects(h.request('/api/slow', { timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, 'request_timeout');
    assert.equal(error.path, '/api/slow');
    assert.equal(error.timeoutMs, 1000);
    assert.equal(error.diagnostic.context.path, '/api/slow');
    assert.deepEqual(error.diagnostic.context.owner, owner);
    return true;
  });
  await h.advance(999);
  assert.equal(bodyStarted, true);
  assert.equal(readAborted, false);
  assert.equal(h.diagnostics.length, 0);
  await h.advance(1);
  await pending;
  assert.equal(readAborted, true);
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.timers.size, 0);
});

test('hanging fetch and noncooperative body are bounded even without AbortController', async () => {
  for (const headersReceived of [false, true]) {
    const h = harness(() => headersReceived ? response(200, () => new Promise(() => {})) : new Promise(() => {}), { abortController: null });
    const pending = assert.rejects(h.request('/api/slow', { timeoutMs: 1000 }), { code: 'request_timeout' });
    await h.advance(1000);
    await pending;
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('caller cancellation during fetch, body or retry wait never becomes timeout', async () => {
  for (const stage of ['fetch', 'body', 'retry', 'before']) {
    const controller = new AbortController();
    const h = harness(() => stage === 'retry' ? response(503) : stage === 'body'
      ? response(200, () => new Promise(() => {})) : new Promise(() => {}));
    if (stage === 'before') controller.abort();
    const pending = assert.rejects(h.request('/api/items', { signal: controller.signal }), (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'request_cancelled');
      assert.equal(error.diagnostic.context.path, '/api/items');
      return true;
    });
    await h.flush();
    controller.abort();
    await pending;
    assert.equal(h.calls.length, stage === 'before' ? 0 : 1);
    if (stage === 'fetch' || stage === 'body') assert.equal(h.calls[0].options.signal.aborted, true);
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('unsolicited AbortError is not relabeled as request_timeout', async () => {
  const error = Object.assign(new Error('upstream aborted'), { name: 'AbortError' });
  const h = harness(() => Promise.reject(error));
  await assert.rejects(h.request('/api/items'), (caught) => caught === error && caught.code !== 'request_timeout');
  assert.equal(h.diagnostics.length, 1);
});

test('POST fetches and caches CSRF without collecting successful CSRF diagnostics or retrying POST', async () => {
  const h = harness((path) => path === '/api/csrf' ? response(200, '{"token":"test-csrf"}') : response(503));
  const result = await h.request('/api/save', { method: 'post', body: { value: 1 }, action: 'save' });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[1].options.method, 'POST');
  assert.equal(h.calls[1].options.headers['X-CMDBDynamicPages-CSRF'], 'test-csrf');
  assert.equal(h.calls[1].options.body, '{"value":1}');
  assert.equal(result.diagnostic.context.path, '/api/save');
  assert.equal(result.diagnostic.context.method, 'POST');
  assert.equal(h.diagnostics.length, 1);
  await h.request('/api/save', { method: 'POST' });
  assert.equal(h.calls.length, 3);
});

test('CSRF HTTP and network errors identify the actual GET, not target POST', async () => {
  for (const network of [false, true]) {
    const h = harness(() => network ? Promise.reject(new TypeError('Failed to fetch')) : response(403));
    await assert.rejects(h.request('/api/save', { method: 'POST', phase: 'persist', blockName: 'form' }), (error) => {
      assert.equal(error.diagnostic.context.path, '/api/csrf');
      assert.equal(error.diagnostic.context.method, 'GET');
      assert.equal(error.diagnostic.context.attempt, 1);
      assert.equal(error.diagnostic.context.phase, 'persist');
      assert.equal(error.diagnostic.context.blockName, 'form');
      assert.deepEqual(error.diagnostic.context.owner, owner);
      assert.equal(error.diagnostic.kind, network ? 'exception' : 'response');
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.diagnostics.length, 1);
  }
});

test('CSRF body timeout and cancellation preserve GET context and prevent POST', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const h = harness(() => response(200, () => new Promise(() => {})));
    const pending = assert.rejects(h.request('/api/save', { method: 'POST', timeoutMs: 1000, signal: controller.signal }), (error) => {
      assert.equal(error.code, cancelled ? 'request_cancelled' : 'request_timeout');
      assert.equal(error.diagnostic.context.path, '/api/csrf');
      assert.equal(error.diagnostic.context.method, 'GET');
      return true;
    });
    await h.flush();
    if (cancelled) controller.abort();
    else await h.advance(1000);
    await pending;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.signal.aborted, true);
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test('deadline is shared across CSRF and POST body, not reset per fetch', async () => {
  let finishCsrf;
  const h = harness((path) => path === '/api/csrf'
    ? response(200, () => new Promise((resolve) => { finishCsrf = resolve; }))
    : response(200, () => new Promise(() => {})));
  const pending = assert.rejects(h.request('/api/save', { method: 'POST', timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, 'request_timeout');
    assert.equal(error.diagnostic.context.path, '/api/save');
    assert.equal(error.diagnostic.context.method, 'POST');
    return true;
  });
  await h.advance(800);
  finishCsrf('{"token":"test-csrf"}');
  await h.advance(200);
  await pending;
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.signal.aborted, true);
  assert.equal(h.diagnostics.length, 1);
});

test('retry backoff cannot exceed the original deadline or create intermediate diagnostics', async () => {
  const h = harness(() => response(503, '{}', { 'Retry-After': '5' }));
  const pending = assert.rejects(h.request('/api/items', { timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, 'request_timeout');
    assert.equal(error.diagnostic.context.attempt, 2);
    return true;
  });
  await h.advance(1000);
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.timers.size, 0);
});

test('body serialization errors reject with diagnostics before any network request', async () => {
  const h = harness(() => response());
  const circular = {};
  circular.self = circular;
  await assert.rejects(h.request('/api/save', { method: 'POST', body: circular }), (error) => {
    assert.equal(error.name, 'TypeError');
    assert.equal(error.diagnostic.context.path, '/api/save');
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.diagnostics.length, 1);
});
