import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantDiagnosticsUi } from '../../scripts/assistant-diagnostics-ui.mjs';

function fixture(privilege = true) {
  const state = { root: 'Root', language: 'ru', session: { rolePrivileges: { admin_classes_modify: privilege } } };
  const calls = [];
  const api = createAssistantDiagnosticsUi({
    getState: () => state, escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    apiPrefix: '/api', createRequestError: (result) => new Error(result.json.message),
    request: async (url) => { calls.push(url); return { ok: true, json: { success: true, span: { request: '<script>not-html</script>', response: '{invalid' } } }; }
  });
  return { state, calls, api };
}

test('non-admin cannot render trace references or issue diagnostic requests', async () => {
  const { api, calls } = fixture(false);
  assert.equal(api.render(), '');
  assert.equal(api.renderReference({ traceId: 'trace' }), '');
  await api.refresh();
  assert.deepEqual(calls, []);
});

test('reference bodies remain lazy and markup from captured responses is never executed', async () => {
  const { api, calls } = fixture();
  const markup = api.renderReference({ traceId: 'trace"<script>' });
  assert.match(markup, /data-assistant-debug-reference/);
  assert.doesNotMatch(markup, /<script>|not-html|invalid/);
  assert.deepEqual(calls, []);
  const output = { textContent: '' };
  const attrs = { 'data-debug-root': 'Root', 'data-assistant-debug-span': 'span', 'data-trace-id': 'trace' };
  const target = { open: true, isConnected: true, dataset: {}, getAttribute: (name) => attrs[name], querySelector: () => output };
  await api.handleToggle({ target });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/api/assistant/diagnostics/traces/trace/spans/span?root=Root');
  assert.match(output.textContent, /<script>not-html<\/script>/);
  assert.match(output.textContent, /invalid/);
  await api.handleToggle({ target });
  assert.equal(calls.length, 1);
});

test('root changes while a body is loading discard the response', async () => {
  let release;
  const state = { root: 'First', session: { rolePrivileges: { admin_classes_modify: true } } };
  const api = createAssistantDiagnosticsUi({ getState: () => state, escapeHtml: String, apiPrefix: '/api', request: () => new Promise((resolve) => { release = resolve; }) });
  api.renderReference({ traceId: 'trace' });
  const output = { textContent: '' };
  const target = { open: true, isConnected: true, dataset: {}, getAttribute: (name) => ({ 'data-debug-root': 'First', 'data-assistant-debug-span': 'span', 'data-trace-id': 'trace' })[name], querySelector: () => output };
  const pending = api.handleToggle({ target });
  state.root = 'Second';
  release({ ok: true, json: { success: true, span: { request: 'other-root-private-data' } } });
  await pending;
  assert.doesNotMatch(output.textContent, /other-root-private-data/);
});

function browser(t) {
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { getElementById: () => null };
  globalThis.window = { confirm: () => true };
  t.after(() => {
    for (const key of ['document', 'window']) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  });
}

test('Apply freezes root and policy before await; A-B-A cancels the capture POST', async (t) => {
  browser(t);
  const state = { root: 'A', rootSelectionGeneration: 0, session: { rolePrivileges: { admin_classes_modify: true } } };
  let release;
  const calls = [];
  const api = createAssistantDiagnosticsUi({
    getState: () => state, escapeHtml: String, apiPrefix: '/api',
    capturePolicy: (root) => { calls.push(['snapshot', root]); return { captureDurationSec: 30 }; },
    savePolicy: (root, snapshot) => { calls.push(['save', root, snapshot]); return new Promise((resolve) => { release = resolve; }); },
    request: async (url) => { calls.push(['request', url]); return { ok: true, json: { success: true, status: {} } }; }
  });
  api.handleInput({ target: { id: 'cmdp-assistant-debug-mode', value: 'Basic' } });
  api.handleAction({ getAttribute: () => 'assistant-debug-apply' });
  assert.deepEqual(calls, [['snapshot', 'A'], ['save', 'A', { captureDurationSec: 30 }]]);
  state.root = 'B'; state.rootSelectionGeneration++;
  state.root = 'A'; state.rootSelectionGeneration++;
  release({ captureDurationSec: 10 });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
});

test('Apply passes the acknowledged effective policy into the original root POST', async (t) => {
  browser(t);
  const state = { root: 'A', session: { rolePrivileges: { admin_classes_modify: true } } };
  const calls = [];
  const api = createAssistantDiagnosticsUi({ getState: () => state, escapeHtml: String, apiPrefix: '/api',
    capturePolicy: () => ({ requested: 900 }), savePolicy: async () => ({ captureDurationSec: 60 }),
    request: async (url, options) => { calls.push({ url, options }); return { ok: true, json: { success: true, status: {} } }; }
  });
  api.handleInput({ target: { id: 'cmdp-assistant-debug-mode', value: 'Basic' } });
  api.handleAction({ getAttribute: () => 'assistant-debug-apply' });
  await new Promise(setImmediate);
  assert.equal(calls[0].url, '/api/assistant/diagnostics/capture?root=A');
  assert.equal(calls[0].options.body.durationSec, 60);
});

test('trace filters are captured on input and survive status completion and language changes', async (t) => {
  browser(t);
  const { api, state } = fixture();
  api.handleInput({ target: { id: 'cmdp-assistant-debug-request', value: 'not submitted' } });
  api.handleInput({ target: { id: 'cmdp-assistant-debug-template', value: 'draft-template' } });
  await api.refresh();
  state.language = 'en';
  assert.match(api.render(), /value="not submitted"/);
  assert.match(api.render(), /value="draft-template"/);
});

test('known pending 404 retries at most five seconds and leaves manual refresh available', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { now += ms; queueMicrotask(callback); });
  const state = { root: 'Root', language: 'en', session: { rolePrivileges: { admin_classes_modify: true } } };
  let calls = 0;
  const api = createAssistantDiagnosticsUi({ getState: () => state, escapeHtml: String, apiPrefix: '/api',
    request: async () => { calls++; return { ok: false, status: 404, json: { success: false } }; },
    createRequestError: () => new Error('not found') });
  const markup = api.renderReference({ traceId: 'trace', storageStatus: 'pending' });
  assert.match(markup, /data-debug-pending="true"/);
  assert.match(markup, /data-action="assistant-debug-open"/);
  const output = {};
  const attrs = { 'data-debug-root': 'Root', 'data-debug-pending': 'true', 'data-assistant-debug-reference': 'trace' };
  const target = { open: true, isConnected: true, dataset: {}, getAttribute: (name) => attrs[name], querySelector: () => output };
  await api.handleToggle({ target });
  assert.equal(now, 5000);
  assert.equal(calls, 21);
  assert.match(output.textContent, /still being captured/);
  assert.equal(target.dataset.debugLoaded, undefined);
  assert.equal(target.dataset.debugLoading, 'false');
});
