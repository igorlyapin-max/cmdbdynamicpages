import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return server.address().port;
}

function resp(value) {
  if (value === null) return '$-1\r\n';
  if (Array.isArray(value)) return `*${value.length}\r\n` + value.map(resp).join('');
  if (typeof value === 'number') return `:${value}\r\n`;
  return `$${Buffer.byteLength(String(value))}\r\n${value}\r\n`;
}

async function fixture(t, options = {}) {
  const strings = new Map();
  const indexes = new Map();
  const sorted = new Map();
  const writes = [];
  let unavailable = false;
  let hanging = false;
  const heldSockets = new Set();
  const redis = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const first = buffer.indexOf('\r\n');
        if (first < 0) return;
        const count = Number(buffer.subarray(1, first));
        let offset = first + 2;
        const parts = [];
        for (let i = 0; i < count; i++) {
          const end = buffer.indexOf('\r\n', offset);
          if (end < 0) return;
          const length = Number(buffer.subarray(offset + 1, end));
          if (buffer.length < end + 2 + length + 2) return;
          parts.push(buffer.subarray(end + 2, end + 2 + length).toString());
          offset = end + 2 + length + 2;
        }
        buffer = buffer.subarray(offset);
        if (hanging && parts.some((part) => part.includes(':assistant-diagnostics:'))) { heldSockets.add(socket); continue; }
        if (unavailable && parts.some((part) => part.includes(':assistant-diagnostics:'))) { socket.write('-ERR unavailable\r\n'); continue; }
        const [op, ...args] = parts;
        let result = null;
        const read = (key) => { const entry = strings.get(key); return entry && entry.until > Date.now() ? entry.value : null; };
        if (op === 'PING') result = 'PONG';
        else if (op === 'GET') result = read(args[0]);
        else if (op === 'SET') { writes.push(parts); strings.set(args[0], { value: args[1], until: Date.now() + Number(args[3]) * 1000 }); result = 'OK'; }
        else if (op === 'DEL') result = Number(strings.delete(args[0]));
        else if (op === 'ZRANGE') result = [...(sorted.get(args[0]) || new Map()).keys()];
        else if (op === 'ZREMRANGEBYSCORE') {
          result = 0;
          for (const [key, deadline] of sorted.get(args[0]) || []) if (deadline <= Number(args[2])) { sorted.get(args[0]).delete(key); result++; }
        }
        else if (op === 'EVAL') {
          const n = Number(args[1]);
          const keys = args.slice(2, 2 + n);
          const argv = args.slice(2 + n);
          const index = (indexes.get(keys[0]) || []).filter((key) => read(key) !== null);
          indexes.set(keys[0], index);
          const total = () => index.reduce((sum, key) => sum + Buffer.byteLength(read(key) || ''), 0);
          const status = () => [index.length, total(), '0', read(keys[2]), read(keys[3]) || '0'];
          if (argv[0] === 'activate') {
            const capture = JSON.parse(argv[3]);
            strings.set(keys[2], { value: argv[3], until: capture.activeUntilMs });
            if (!sorted.has(keys[4])) sorted.set(keys[4], new Map());
            sorted.get(keys[4]).set(argv[2], capture.activeUntilMs);
            result = status();
          } else if (argv[0] === 'stop') {
            strings.delete(keys[2]); sorted.get(keys[4])?.delete(argv[2]); result = status();
          } else if (argv[0] === 'status') result = status();
          else if (argv[0] === 'save' || argv[0] === 'begin') {
            writes.push(parts);
            const doc = JSON.parse(argv[3]);
            const old = read(keys[5]);
            const control = JSON.parse(read(keys[2]) || 'null');
            let reason;
            if (String(doc.trace.storageEpoch) !== String(read(keys[3]) || '0')) reason = 'storage_epoch';
            else if (Number(argv[8]) <= Date.now()) reason = 'deadline';
            else if (argv[0] === 'begin' && (!control || control.captureGeneration !== doc.trace.captureGeneration)) reason = 'capture_inactive';
            else if (argv[0] === 'save' && !old) reason = 'missing';
            if (reason) result = [0, 0, total(), 0, reason];
            else {
              strings.set(keys[5], { value: argv[3], until: strings.get(keys[5])?.until || Number(argv[8]) });
              if (!index.includes(keys[5])) index.push(keys[5]);
              result = [1, 0, total(), old ? 1 : 0, 'stored'];
            }
          } else if (argv[0] === 'list') result = [...index].reverse().map((key) => JSON.parse(read(key)).summary)
            .filter((item) => (!argv[2] || item.requestId === argv[2]) && (!argv[3] || item.templateCode === argv[3]))
            .slice(0, Number(argv[4])).map(JSON.stringify);
          else if (argv[0] === 'clear') {
            for (const key of index) strings.delete(key);
            indexes.delete(keys[0]);
            const epoch = String(Number(read(keys[3]) || 0) + 1);
            strings.set(keys[3], { value: epoch, until: Infinity }); result = [index.length, epoch];
          }
        } else throw new Error(`Unexpected mock Redis operation ${op}`);
        socket.write(resp(result));
      }
    });
  });
  const redisPort = await listen(t, redis);
  const outgoing = [];
  const llm = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    outgoing.push(JSON.parse(body));
    if (options.llmDelay) await options.llmDelay();
    res.writeHead(options.llmStatus || 200, { 'content-type': 'application/json' });
    if (options.rawResponse !== undefined) return res.end(options.rawResponse);
    const completion = typeof options.completion === 'function' ? options.completion(outgoing.length) : options.completion;
    res.end(JSON.stringify(completion || { id: 'provider-test-id', choices: [{ message: { content: options.content ?? '{invalid provider JSON diagnostic-test-key admin-test-session' }, finish_reason: options.finishReason || 'stop' }], usage: { total_tokens: 42 } }));
  });
  const llmPort = await listen(t, llm);
  const runtime = { assistant: { llm: { enabled: true, model: 'test-model', baseUrl: `http://127.0.0.1:${llmPort}`, maxTokens: 4567 }, mcp: { enabled: true } } };
  const configWrites = [];
  const upstream = http.createServer(async (req, res) => {
    const auth = req.headers['cmdbuild-authorization'];
    let data;
    let status = 200;
    const path = new URL(req.url, 'http://mock').pathname;
    if (path.endsWith('/sessions/current')) {
      status = auth === 'expired-test-session' ? 401 : 200;
      data = { username: 'test', rolePrivileges: { admin_classes_modify: auth !== 'reader-test-session' } };
    } else if (req.method === 'PUT' && path.endsWith('/Cst_QueryToolConfig/cards/1')) {
      let text = ''; for await (const chunk of req) text += chunk;
      data = { _id: 1, ...JSON.parse(text) }; configWrites.push(data);
      Object.assign(runtime, typeof data.RuntimeConfigJson === 'string' ? JSON.parse(data.RuntimeConfigJson) : data.RuntimeConfigJson);
    } else if (/\/(Cst|Trace)_QueryToolConfig$/.test(path)) data = { _can_read: auth !== 'denied-test-session' };
    else if (/\/(Cst|Trace)_QueryToolConfig\/cards$/.test(path)) {
      const root = path.split('/').at(-2).replace(/Config$/, '');
      data = [{ _id: 1, Code: root, RootCode: root, RuntimeConfigJson: JSON.stringify(runtime) }];
    } else if (/\/(Cst|Trace)_QueryTemplate$/.test(path)) data = { _can_create: true, _can_read: true };
    else if (/\/(Cst|Trace)_QueryTemplate\/cards$/.test(path)) data = options.templates || [];
    else if (path.endsWith('/classes')) data = [{ name: 'Asset', description: 'Asset', _can_read: true, active: true }];
    else if (path.endsWith('/classes/Asset')) data = { name: 'Asset', description: 'Asset', _can_read: true, active: true };
    else if (path.endsWith('/classes/Asset/cards')) data = options.assetCards || [];
    else if (path.includes('/classes/Asset/cards/')) data = options.assetCards?.find((card) => path.endsWith(`/cards/${card._id}`));
    else if (options.failingClass && path.endsWith(`/classes/${options.failingClass}/cards`)) { status = 400; data = { detail: options.upstreamFailure }; }
    else data = [];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: status === 200, data, meta: { total: Array.isArray(data) ? data.length : 1 } }));
  });
  const upstreamPort = await listen(t, upstream);
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], { env: {
    ...process.env, NODE_ENV: 'test', PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port),
    CMDBUILD_ORIGIN: `http://127.0.0.1:${upstreamPort}`, CMDBDYNAMIC_REDIS_ENABLED: 'true',
    CMDBDYNAMIC_REDIS_URL: `redis://127.0.0.1:${redisPort}`, CMDBDYNAMIC_REDIS_KEY_PREFIX: `diag-test-${port}`,
    CMDP_INPUT_MAX_COLLECTION_ITEMS: '5000', CMDP_INPUT_MAX_TOTAL_ITEMS: '50000',
    CMDBDYNAMICPAGES_CSRF_SECRET: 'diagnostic-test-csrf-secret', CMDP_LOG_TARGET: 'stdout', CMDP_LOG_LEVEL: 'warn',
    LITELLM_API_KEY: 'diagnostic-test-key', LITELLM_BASE_URL: `http://127.0.0.1:${llmPort}`,
    CMDP_LITELLM_ALLOWED_BASE_URLS: `http://127.0.0.1:${llmPort}`
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (value) => { logs += value; });
  child.stderr.on('data', (value) => { logs += value; });
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } });
  const deadline = Date.now() + 10000;
  while (true) {
    try { if ((await fetch(origin + '/health/live')).ok) break; } catch { /* Isolated process startup. */ }
    assert.ok(Date.now() < deadline && child.exitCode === null, logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  async function request(path, { method = 'GET', body, rawBody, session = 'admin-test-session', csrf = true } = {}) {
    const headers = { cookie: `CMDBuild-Authorization=${session}`, origin, 'content-type': 'application/json' };
    if (method !== 'GET' && csrf) {
      const response = await fetch(origin + '/cmdbuild/custom-api/csrf', { headers });
      headers['x-cmdbdynamicpages-csrf'] = (await response.json()).token;
    }
    const response = await fetch(origin + '/cmdbuild/custom-api' + path, { method, headers,
      ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, headers: response.headers, json: await response.json() };
  }
  return { request, outgoing, writes, runtime, configWrites, logs: () => logs, unavailable: () => { unavailable = true; },
    hangDiagnostics: () => { hanging = true; }, releaseDiagnostics: () => { hanging = false; for (const socket of heldSockets) socket.destroy(); heldSockets.clear(); } };
}

test('diagnostic access validates current session, admin, config readability and CSRF', async (t) => {
  const f = await fixture(t);
  for (const [session, status] of [['expired-test-session', 401], ['reader-test-session', 403], ['denied-test-session', 403]]) {
    assert.equal((await f.request('/assistant/diagnostics/status', { session })).status, status);
  }
  assert.equal((await f.request('/assistant/diagnostics/capture', { method: 'POST', csrf: false, body: { mode: 'Verbose', confirmed: true } })).status, 403);
  assert.equal((await f.request('/assistant/diagnostics/capture', { method: 'POST', body: { mode: 'Verbose' } })).status, 400);
  const response = await f.request('/assistant/diagnostics/status');
  assert.equal(response.status, 200);
  assert.equal(response.json.status.mode, 'Off');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/assistant/diagnostics/traces?limit=1000')).status, 400);
  assert.equal((await f.request('/assistant/diagnostics/status?root=../../bad')).status, 400);
  assert.equal((await f.request('/assistant/diagnostics/traces/not-a-uuid')).status, 400);
});

test('capture stores safe ingress, metadata excludes bodies, full spans/export retain redacted content', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/assistant/diagnostics/capture', { method: 'POST', body: { mode: 'Verbose', confirmed: true, durationSec: 120 } })).status, 200);
  const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: {
    templateRef: { root: 'Cst_QueryTool', templateCode: '', baseSpecHash: '' },
    intent: { context: 'keep business prompt diagnostic-test-key admin-test-session', blocks: [{ id: 'block-1', name: 'Assets', description: 'Select all cards of class Asset. Expected result: all Asset cards.', expectedResult: 'Assets', uses: [] }] },
    editorDelta: { version: 1, spec: { version: 1, steps: [], result: { tables: [] } } }
  } });
  assert.ok(response.json.diagnostics?.assistantTrace?.traceId, JSON.stringify(response.json));
  const id = response.json.diagnostics.assistantTrace.traceId;
  const deadline = Date.now() + 3000;
  while (true) {
    const detail = await f.request(`/assistant/diagnostics/traces/${id}`);
    if (detail.status === 200 && detail.json.trace?.status !== 'in_progress') break;
    assert.ok(Date.now() < deadline, 'Final diagnostic snapshot was not persisted.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const listed = await f.request('/assistant/diagnostics/traces');
  assert.equal(listed.json.traces.length, 1);
  const detail = await f.request(`/assistant/diagnostics/traces/${id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.json.trace.spans.length > 0);
  assert.ok(detail.json.trace.spans.every((span) => span.id && !('request' in span) && !('response' in span)));
  const ingress = detail.json.trace.spans.find((span) => span.kind === 'bff');
  const span = await f.request(`/assistant/diagnostics/traces/${id}/spans/${ingress.id}`);
  assert.ok(JSON.stringify(span.json).includes('keep business prompt'));
  const exported = await f.request(`/assistant/diagnostics/traces/${id}/export`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  for (const secret of ['diagnostic-test-key', 'admin-test-session']) {
    assert.ok(!JSON.stringify(exported.json).includes(secret));
    assert.ok(!JSON.stringify(f.writes).includes(secret));
  }
  assert.ok(!f.logs().includes('keep business prompt'));
  assert.equal(response.status, 502, JSON.stringify(response.json));
  assert.equal(response.json.code, 'assistant_invalid_json', JSON.stringify(response.json));
  assert.equal(f.outgoing.length, 1, JSON.stringify(response.json));
  {
    assert.equal(f.outgoing[0].max_tokens, 4567);
    const llm = exported.json.trace.spans.find((item) => item.kind === 'litellm');
    assert.equal(llm.metadata.finish_reason, 'stop');
    assert.equal(llm.metadata.usage.total_tokens, 42);
    assert.equal(llm.metadata.limits.maxTokens.requested, 4567);
    assert.equal(llm.metadata.limits.maxTokens.effectiveLimit, 4567);
    assert.equal(llm.metadata.responseFormat, 'json_object');
    assert.ok(llm.metadata.parseError);
    assert.equal(llm.metadata.parseError.reason, 'SyntaxError');
    assert.ok(llm.metadata.parseError.message);
    const ingressResponse = exported.json.trace.spans.find((item) => item.kind === 'bff').response;
    assert.equal(ingressResponse.value.code, 'assistant_invalid_json');
  }
  await f.request('/assistant/diagnostics/capture', { method: 'DELETE' });
  assert.equal((await f.request('/assistant/diagnostics/status')).json.status.mode, 'Off');
  assert.deepEqual((await f.request('/assistant/diagnostics/traces', { method: 'DELETE' })).json, { success: true });
  assert.deepEqual((await f.request('/assistant/diagnostics/traces')).json.traces, []);
});

test('Redis unavailable is 503 for operators but only an additive warning for Assistant', async (t) => {
  const f = await fixture(t);
  f.unavailable();
  assert.equal((await f.request('/assistant/diagnostics/status')).status, 503);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: {
    templateRef: { root: 'Cst_QueryTool', templateCode: '', baseSpecHash: '' },
    intent: { blocks: [{ id: 'block-1', name: 'Assets', description: 'Select all cards of class Asset. Expected result: all Asset cards.', uses: [] }] },
    editorDelta: { version: 1, spec: { version: 1, steps: [], result: { tables: [] } } }
  } });
  assert.equal(response.status, 502, JSON.stringify(response.json));
  assert.equal(response.json.code, 'assistant_invalid_json');
  assert.equal(f.outgoing.length, 1, 'A diagnostic outage must not trip the runtime Redis circuit breaker.');
  assert.equal(response.json.diagnostics.assistantTrace.status, 'unavailable');
  assert.ok(response.json.diagnostics.assistantTrace.warning);
});

test('Basic capture applies to another user, excludes bodies and stops without deleting records', async (t) => {
  const f = await fixture(t);
  const body = {
    templateRef: { root: 'Cst_QueryTool', templateCode: '', baseSpecHash: '' },
    intent: { blocks: [{ id: 'block-1', name: 'Assets', description: 'Select all cards of class Asset.', uses: [] }] },
    editorDelta: { version: 1, spec: { version: 1, steps: [], result: { tables: [] } } }
  };
  const stopped = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body });
  assert.equal(stopped.json.diagnostics?.assistantTrace, undefined);
  const activation = await f.request('/assistant/diagnostics/capture', { method: 'POST', body: { mode: 'Basic', confirmed: true, durationSec: 60 } });
  const deadline = activation.json.status.activeUntil;
  assert.equal((await f.request('/assistant/diagnostics/status')).json.status.activeUntil, deadline);
  const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body, session: 'reader-test-session' });
  assert.equal(response.json.code, 'assistant_invalid_json');
  const id = response.json.diagnostics.assistantTrace.traceId;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const trace = (await f.request(`/assistant/diagnostics/traces/${id}/export`)).json.trace;
  assert.equal(trace.mode, 'Basic');
  assert.ok(trace.spans.some((span) => span.kind === 'litellm'));
  for (const span of trace.spans) { assert.equal(span.request, undefined); assert.equal(span.response, undefined); }
  assert.equal(trace.spans.find((span) => span.kind === 'litellm').metadata.limits.maxTokens.requested, 4567);
  await f.request('/assistant/diagnostics/capture', { method: 'DELETE' });
  assert.equal((await f.request('/assistant/diagnostics/status')).json.status.mode, 'Off');
  assert.equal((await f.request('/assistant/diagnostics/traces')).json.traces.length, 1);
});

const semanticProbe = () => ({
  templateRef: { root: 'Cst_QueryTool', templateCode: '', baseSpecHash: '' },
  intent: { blocks: [{ id: 'block-1', name: 'Assets', description: 'Select all cards of class Asset.', uses: [] }] },
  editorDelta: { version: 1, spec: { version: 1, steps: [], result: { tables: [] } } }
});

test('JSON response format is explicit; instruction-only mode is saved and never selected implicitly', async (t) => {
  const f = await fixture(t);
  await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
  assert.deepEqual(f.outgoing[0].response_format, { type: 'json_object' });
  assert.equal(f.outgoing.length, 1);
  assert.equal((await f.request('/config', { method: 'PUT', body: { runtimeConfig: { assistant: { ...f.runtime.assistant,
    llm: { ...f.runtime.assistant.llm, responseFormat: 'prompt' } } } } })).status, 200);
  assert.equal((await f.request('/config')).json.config.runtimeConfig.assistant.llm.responseFormat, 'prompt');
  await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
  assert.equal(f.outgoing.length, 2);
  assert.equal(f.outgoing[1].response_format, undefined);
  const before = f.configWrites.length;
  assert.equal((await f.request('/config', { method: 'PUT', body: { runtimeConfig: { assistant: { llm: { responseFormat: 'auto' } } } } })).status, 422);
  assert.equal(f.configWrites.length, before);
});

test('unsupported JSON format has a distinct error and exactly one provider request', async (t) => {
  const f = await fixture(t, { llmStatus: 400, completion: { error: { param: 'response_format', message: 'response_format json_object is not supported' } } });
  const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
  assert.equal(response.status, 502);
  assert.equal(response.json.code, 'assistant_response_format_unsupported');
  assert.equal(response.json.retryable, false);
  assert.equal(response.json.diagnostics.llm.upstreamStatus, 400);
  assert.equal(f.outgoing.length, 1);
});

test('text, empty content and token-limited output remain distinct failures without automatic retries', async (t) => {
  for (const [options, code] of [
    [{ content: '# Catalog summary' }, 'assistant_invalid_json'],
    [{ rawResponse: '{invalid response envelope' }, 'assistant_invalid_json'],
    [{ content: '' }, 'assistant_empty_response'],
    [{ content: '{"version":1}', finishReason: 'length' }, 'assistant_output_truncated']
  ]) {
    await t.test(code, async (t) => {
      const f = await fixture(t, options);
      const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
      assert.equal(response.status, 502);
      assert.equal(response.json.code, code);
      assert.equal(response.json.diagnostics.llm.upstreamStatus, 200);
      assert.equal(response.json.semanticPlan, undefined);
      assert.equal(f.outgoing.length, 1);
    });
  }
});

test('manual invalid-JSON retry reuses the confirmed MCP checkpoint and completes a valid plan', async (t) => {
  const valid = { version: 1, blocks: [{ id: 'block-1', name: 'Assets', summary: 'Select Asset cards', resolvedEntities: ['Asset'],
    relationPaths: [], dependencies: [], expectedResult: 'Select all cards of class Asset.', resultContract: { outputKind: 'sourceCards', outputClass: 'Asset',
      dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: [] }], warnings: [], explanation: 'Asset cards' };
  const f = await fixture(t, { completion: (attempt) => ({ choices: [{ finish_reason: 'stop', message: { content: attempt === 1 ? '# Not a plan' : JSON.stringify(valid) } }] }) });
  const body = semanticProbe();
  const context = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: { ...body, stage: 'context' } });
  assert.equal(context.status, 202, JSON.stringify(context.json));
  const resumeId = context.json.checkpoint.resumeId;
  assert.ok(resumeId);
  const failed = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: { ...body, stage: 'plan', resumeId } });
  assert.equal(failed.json.code, 'assistant_invalid_json');
  assert.equal(failed.json.retryable, true);
  assert.equal(failed.json.resume.resumeId, resumeId);
  assert.equal(f.outgoing.length, 1);
  const retried = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: { ...body, stage: 'plan', resumeId } });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.equal(retried.json.semanticPlan.blocks[0].resultContract.outputClass, 'Asset');
  assert.equal(retried.json.diagnostics.resume.mcpContextReused, true);
  assert.equal(f.outgoing.length, 2);
});

async function waitUntil(check, message) {
  const deadline = Date.now() + 3000;
  while (!await check()) { assert.ok(Date.now() < deadline, message); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

async function exportFinishedTrace(f, response, mode, root = 'Trace_QueryTool') {
  const ref = response.json.diagnostics?.assistantTrace;
  assert.equal(ref?.mode, mode, JSON.stringify(response.json));
  assert.ok(ref.traceId);
  const status = response.status >= 400 ? 'error' : 'completed';
  assert.equal(ref.status, status);
  let trace;
  await waitUntil(async () => {
    trace = (await f.request(`/assistant/diagnostics/traces/${ref.traceId}/export?root=${root}`)).json.trace;
    return trace?.status === status;
  }, 'Final diagnostic snapshot was not persisted in the expected root.');
  assert.equal(trace.requestId, ref.requestId);
  assert.equal(trace.statusCode, response.status);
  return trace;
}

test('draft Apply uses root and template scope and stores only allowlisted metadata', async (t) => {
  const spec = { result: { tables: [] }, steps: [], version: 1 };
  const secret = 'fixture-apply-password';
  const contact = 'apply-private-contact@example.invalid';
  const instruction = 'private free-form instruction for Apply';
  const body = {
    root: 'Trace_QueryTool', templateCode: 'TraceApply',
    baseSpecHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
    currentSpec: { ...spec, diagnosticFixture: { password: secret, value: contact, description: instruction } },
    flow: { version: 1, selections: [{ id: 'selection:assets', name: 'Assets', alias: 'assets', className: 'Asset',
      rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }] }], operations: [] }
  };
  const apply = '/draft/object-flow/apply?root=Cst_QueryTool';
  const capture = '/assistant/diagnostics/capture?root=Trace_QueryTool';
  const cards = [{ _id: 1, Code: 'A-001', Description: 'First card' }, { _id: 2, Code: 'A-002', Description: 'Second card' }];
  const f = await fixture(t, { assetCards: cards, templates: [{ _id: 1, Code: body.templateCode, SpecJson: JSON.stringify(spec) }] });

  for (const mode of ['Basic', 'Verbose']) {
    assert.equal((await f.request(capture, { method: 'POST', body: { mode, confirmed: true } })).status, 200);
    const response = await f.request(apply, { method: 'POST', body, session: 'reader-test-session' });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.spec.steps[0].as, 'assets');
    const trace = await exportFinishedTrace(f, response, mode);
    assert.equal(trace.action, '/draft/object-flow/apply');
    assert.equal(trace.templateCode, 'TraceApply');
    assert.equal(trace.spans.length, 1);
    const [span] = trace.spans;
    assert.equal(span.request, undefined);
    assert.equal(span.response, undefined);
    assert.equal(span.statusCode, 200);
    assert.ok(span.durationMs >= 0);
    assert.deepEqual(span.metadata, { stage: 'apply', code: 'applied',
      ...(mode === 'Verbose' ? { selections: 1, matches: 0, setOperations: 0 } : {}) });
    for (const value of [secret, contact, instruction]) assert.equal(JSON.stringify(trace).includes(value), false);
    assert.equal((await f.request(`/assistant/diagnostics/traces/${trace.id}/export?root=Trace_QueryTool`, { session: 'reader-test-session' })).status, 403);
    const preview = await f.request('/draft/preview?root=Trace_QueryTool&includeDiagrams=false&extractionSource=assets', {
      method: 'POST', body: { template: { code: body.templateCode, spec: response.json.spec }, params: {} }, session: 'reader-test-session'
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.deepEqual(preview.json.result.tables.find((table) => table.name === 'assets').rows.map((row) => row.Description),
      cards.map((card) => card.Description));
  }
  const malformed = await f.request('/draft/object-flow/apply?root=Trace_QueryTool', { method: 'POST', rawBody: `{"currentSpec":"${secret}"` });
  assert.equal(malformed.status, 400);
  const errorTrace = await exportFinishedTrace(f, malformed, 'Verbose');
  assert.equal(errorTrace.spans[0].request, undefined);
  assert.equal(errorTrace.spans[0].response, undefined);
  assert.deepEqual(errorTrace.spans[0].metadata, { stage: 'apply', code: 'invalid_json_body' });
  const conflict = await f.request(apply, { method: 'POST', body: { ...body, baseSpecHash: '0'.repeat(64) },
    session: 'reader-test-session' });
  assert.equal(conflict.status, 409);
  const conflictTrace = await exportFinishedTrace(f, conflict, 'Verbose');
  assert.equal(conflictTrace.spans.length, 1);
  assert.equal(conflictTrace.spans[0].request, undefined);
  assert.equal(conflictTrace.spans[0].response, undefined);
  assert.deepEqual(conflictTrace.spans[0].metadata, { stage: 'apply', code: 'template_version_conflict' });
  for (const value of [secret, contact, instruction]) assert.equal(JSON.stringify(f.writes).includes(value), false);
  assert.equal(f.outgoing.length, 0);
});

test('only Extraction preview is traced, with structural evidence and no card, parameter or error values', async (t) => {
  const cardCode = 'PrivateReturnedCardCode';
  const cardDescription = 'PrivateReturnedCardDescription';
  const unmatched = 'PrivateUnmatchedFilterValue';
  const filterLiteral = 'PrivateConfiguredFilterValue';
  const templateDescription = 'PrivateTemplateDescription';
  const failingClass = 'PrivateRuntimeClassValue';
  const upstreamFailure = 'PrivateCmdbErrorPayload';
  const f = await fixture(t, { assetCards: [{ _id: 73603562, Code: cardCode, Description: cardDescription }], failingClass, upstreamFailure });
  const body = {
    root: 'Cst_QueryTool', templateCode: 'NotThePreviewTemplate',
    template: { code: 'TraceExtraction', description: templateDescription, spec: {
      version: 1,
      params: { criterion: { type: 'string', required: true } },
      steps: [{ type: 'selectCards', as: 'assets', className: 'Asset', columns: ['Code'], limit: 1,
        filters: [{ path: 'Code', op: 'equals', valueParam: 'criterion', value: filterLiteral }] }],
      result: { tables: [{ name: 'assets', columns: ['Code'] }] }
    } },
    params: { criterion: unmatched }
  };
  const preview = '/draft/preview?root=Trace_QueryTool&maxRows=1';
  const extraction = `${preview}&includeDiagrams=false&extractionSource=assets`;
  const post = (path, payload, options = {}) => f.request(path, { method: 'POST', body: payload, ...options });
  assert.equal((await post(extraction, body)).json.diagnostics?.assistantTrace, undefined);
  const capture = '/assistant/diagnostics/capture?root=Trace_QueryTool';
  assert.equal((await post(capture, { mode: 'Basic', confirmed: true })).status, 200);
  const basic = await exportFinishedTrace(f, await post(extraction, body), 'Basic');
  assert.ok(basic.spans.every((span) => !span.request && !span.response));
  assert.equal((await post(capture, { mode: 'Verbose', confirmed: true })).status, 200);

  for (const query of ['', '&includeDiagrams=false', '&includeDiagrams=false&extractionSource=%20', '&extractionSource=assets',
    '&executionScope=diagrams&includeDiagrams=false&extractionSource=assets']) {
    assert.equal((await post(preview + query, body)).json.diagnostics?.assistantTrace, undefined, query);
  }
  const denied = await post(extraction, body, { csrf: false });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.diagnostics?.assistantTrace, undefined);

  const exported = [];
  for (const [criterion, rowCount] of [[unmatched, 0], [cardCode, 1]]) {
    const response = await post(extraction, { ...body, params: { criterion } }, { session: 'reader-test-session' });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.result.tables[0].rows.length, rowCount);
    if (rowCount) assert.equal(response.json.result.tables[0].rows[0].Code, cardCode);
    const trace = await exportFinishedTrace(f, response, 'Verbose');
    exported.push(trace);
    assert.equal(trace.action, '/draft/preview');
    assert.equal(trace.templateCode, 'TraceExtraction');
    assert.equal(trace.spans.length, 1);
    const [span] = trace.spans;
    assert.deepEqual(span.request.value, { executionScope: 'tables', extractionSource: 'assets', tableCount: 1,
      steps: [{ index: 0, type: 'selectCards', as: 'assets', className: 'Asset', filterCount: 1, limit: 1 }] });
    const result = span.response.value.result;
    assert.deepEqual(result.selectedTable, { name: 'assets', rows: rowCount });
    assert.equal(result.trace[0].rows, rowCount);
    assert.equal(result.trace[0].status, 'ok');
    assert.equal(result.limits.maxRows, 1);
    if (rowCount) assert.deepEqual(result.trace[0].limitDiagnostics, [{ limitName: 'maxRows', configuredLimit: 1, returned: 1 }]);
  }

  const failedBody = structuredClone(body);
  failedBody.template.spec.params.runtimeClass = { type: 'string', required: true };
  delete failedBody.template.spec.steps[0].className;
  failedBody.template.spec.steps[0].classNameParam = 'runtimeClass';
  failedBody.params.runtimeClass = failingClass;
  const failed = await post(extraction, failedBody);
  assert.equal(failed.status, 400, JSON.stringify(failed.json));
  assert.match(failed.json.result.trace[0].message, new RegExp(failingClass));
  const failureTrace = await exportFinishedTrace(f, failed, 'Verbose');
  exported.push(failureTrace);
  const failureResult = failureTrace.spans[0].response.value.result;
  assert.equal(failureResult.trace[0].status, 'error');
  assert.equal(failureResult.trace[0].message, undefined);
  assert.equal(failureResult.limits.maxRows, 1);

  const invalid = await post(extraction, { ...body, template: { ...body.template, spec: {} } });
  assert.equal(invalid.status, 400);
  const invalidTrace = await exportFinishedTrace(f, invalid, 'Verbose');
  assert.equal(invalidTrace.templateCode, 'TraceExtraction');
  assert.deepEqual(invalidTrace.spans[0].response.value, { success: false });
  exported.push(invalidTrace);

  const excessive = structuredClone(body);
  const filters = excessive.template.spec.steps[0].filters;
  excessive.template.spec.steps[0].filters = Array(5001).fill(filters[0]);
  const rejected = await post(extraction, excessive);
  assert.equal(rejected.status, 413);
  assert.equal(rejected.json.code, 'input_collection_limit');
  const rejectedTrace = await exportFinishedTrace(f, rejected, 'Verbose');
  assert.equal(rejectedTrace.templateCode, 'TraceExtraction');
  assert.equal(rejectedTrace.spans[0].request, undefined);
  assert.deepEqual(rejectedTrace.spans[0].response.value, { success: false });
  exported.push(rejectedTrace);

  const listed = await f.request('/assistant/diagnostics/traces?root=Trace_QueryTool&templateCode=TraceExtraction');
  assert.equal(listed.json.traces.length, 6);
  assert.equal((await f.request('/assistant/diagnostics/traces')).json.traces.length, 0);
  for (const marker of [cardCode, cardDescription, '73603562', unmatched, filterLiteral, templateDescription, failingClass, upstreamFailure]) {
    assert.equal(JSON.stringify(exported).includes(marker), false, marker);
    assert.equal(JSON.stringify(f.writes).includes(marker), false, marker);
  }
});

test('malformed provider credentials are masked in actual trace writes and export', async (t) => {
  const secrets = ['synthetic-cookie-secret', 'synthetic-session-secret'];
  const f = await fixture(t, { content: `{"cookie":"${secrets[0]}","sessionId":"${secrets[1]}"` });
  await f.request('/assistant/diagnostics/capture', { method: 'POST', body: { mode: 'Verbose', confirmed: true } });
  const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
  assert.equal(response.json.code, 'assistant_invalid_json');
  const id = response.json.diagnostics.assistantTrace.traceId;
  let trace;
  await waitUntil(async () => { trace = (await f.request(`/assistant/diagnostics/traces/${id}/export`)).json.trace; return trace?.status === 'error'; }, 'Missing completed trace');
  for (const secret of secrets) {
    assert.equal(JSON.stringify(trace).includes(secret), false);
    assert.equal(JSON.stringify(f.writes).includes(secret), false);
    assert.equal(f.logs().includes(secret), false);
  }
});

test('config keeps requested values, returns clamps and rejects invalid numbers before writes', async (t) => {
  const f = await fixture(t);
  const changed = structuredClone(f.runtime);
  changed.assistant.llm.maxTokens = 999999;
  changed.assistant.diagnostics = { maxStoredBytes: 10000, maxTraceBytes: 20000, maxBodyBytes: 30000 };
  const saved = await f.request('/config', { method: 'PUT', body: { runtimeConfig: changed } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.config.runtimeConfig.assistant.llm.maxTokens, 999999);
  assert.ok(saved.json.diagnostics.limits.some((item) => item.requested === 999999 && item.effectiveLimit === 131072));
  assert.equal(saved.json.effectiveAssistantDiagnostics.maxBodyBytes, 10000);
  const loaded = await f.request('/config');
  assert.ok(loaded.json.diagnostics.limits.some((item) => item.requested === 999999));
  const writeCount = f.configWrites.length;
  for (const invalid of [0, -1, 1.5, null, '123']) {
    const response = await f.request('/config', { method: 'PUT', body: { runtimeConfig: { assistant: { llm: { maxTokens: invalid } } } } });
    assert.equal(response.status, 422);
    assert.equal(response.json.code, 'runtime_config_invalid');
  }
  assert.equal(f.configWrites.length, writeCount);
  const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
  assert.equal(response.json.code, 'assistant_invalid_json');
  assert.equal(f.outgoing.at(-1).max_tokens, 131072);
});

for (const mode of ['Off', 'Verbose']) test(`silent diagnostics Redis cannot block Assistant in ${mode}`, async (t) => {
  const f = await fixture(t);
  if (mode !== 'Off') await f.request('/assistant/diagnostics/capture', { method: 'POST', body: { mode, confirmed: true } });
  else await f.request('/assistant/diagnostics/status');
  f.hangDiagnostics();
  try {
    const started = Date.now();
    const response = await f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
    assert.equal(response.json.code, 'assistant_invalid_json');
    assert.ok(Date.now() - started < 1000, 'Diagnostic Redis must not be awaited before LiteLLM or response completion.');
    assert.equal(f.outgoing.length, 1);
  } finally { f.releaseDiagnostics(); }
});

test('stop and clear during LiteLLM prohibit delayed final snapshots from restoring the trace', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { llmDelay: () => gate });
  t.after(() => release());
  await f.request('/assistant/diagnostics/capture', { method: 'POST', body: { mode: 'Verbose', confirmed: true } });
  const pending = f.request('/assistant/object-flow/semantic-plan', { method: 'POST', body: semanticProbe() });
  await waitUntil(async () => f.outgoing.length && (await f.request('/assistant/diagnostics/traces')).json.traces.length, 'Trace was not registered');
  await f.request('/assistant/diagnostics/capture', { method: 'DELETE' });
  await f.request('/assistant/diagnostics/traces', { method: 'DELETE' });
  release();
  assert.equal((await pending).json.code, 'assistant_invalid_json');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual((await f.request('/assistant/diagnostics/traces')).json.traces, []);
  assert.equal((await f.request('/assistant/diagnostics/status')).json.status.mode, 'Off');
});
