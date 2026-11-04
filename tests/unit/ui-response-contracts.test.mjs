import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';

const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const functions = ['parseResponse', 'validateUiResponse', 'createRequestError', 'requestDraftPreview',
  'draftPreviewRequestTimeoutMs', 'saveTemplate', 'extractByTemplate', 'runDraftAction',
  'visualizeInEditor', 'queueDiagramImportRuntimePreview', 'runDiagramImportRuntimePreview'];
const helpers = functions.map((name) => {
  const start = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  }', start) + 4;
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
}).join('\n');

async function harness(body, { status = 200, current = true, mode = 'applied' } = {}) {
  const edited = { id: 1, code: 'sample', spec: { edited: true, result: {} } };
  const owner = { templateCode: 'sample', section: 'assistant', generation: 4, revision: 2 };
  const calls = [];
  const errors = [];
  let loads = 0;
  const state = { selectedTemplate: edited, designerSection: 'assistant', lastDraftPreviewOk: true };
  const sandbox = vm.createContext({
    state, boot: {}, apiPrefix: '/api', window: { history: {} },
    cloneJsonValue: (value) => structuredClone(value),
    uiRequestDiagnostics: createUiRequestDiagnostics(),
    uiRequestOwner: () => ({ ...owner }),
    // Deliberately test current/stale consumers independently of root ownership implementation.
    uiDiagnosticIsCurrent: typeof current === 'function' ? current : () => current,
    t: (key) => key,
    errorText: () => 'backend failure',
    draftPreviewErrorText: (error) => error.message,
    draftPreviewResultErrorText: () => 'preview failure',
    setUiError(error) { errors.push(error); state.message = { type: 'error', diagnostic: error.diagnostic }; },
    renderDesigner() {}, syncImportedDiagramSaveGate() {},
    captureVisibleDesignerState: () => true,
    captureAssistantPromptsFromDom() {},
    assistantSpecWithPrompts: (spec) => spec,
    updateSelectedFromEditor(spec) { state.selectedTemplate.spec = spec; },
    readEditorPayload: () => structuredClone(edited),
    readRunParams: () => ({}), readTemplateCode: () => 'sample', readValue: () => '',
    diagramImportExecutionValidationHasMappingBlocker: () => false,
    loadDesigner() { loads += 1; return Promise.resolve(); },
    preferredExtractionResultName: () => 'items',
    ensureExtractionPreviewTable: (spec) => spec,
    extractionSelectedSourceEmptyWarning: () => '',
    authoringPreviewPath: () => '/api/draft/preview', authoringPreviewMaxRows: () => 10,
    d2WorkflowStatusForEditor: () => ({ state: 'ready' }),
    routeUiRequestDiagnostic() {},
    clientRequestId: () => 'client-123',
    diagramImportRuntimePreviewRequestSnapshot: () => ({ mode, template: edited, params: {}, revision: 'r1' }),
    templateAuthoringClient: () => ({ d2: { source: 'a -> b' } }),
    currentDiagramImportRuntimePreviewRevision: () => 'r1',
    startDiagramImportRuntimePreviewTimer() {}, stopDiagramImportRuntimePreviewTimer() {},
    diagramImportRuntimePreviewDetails: () => ({ ready: true, partial: false, diagrams: [{}] })
  });
  vm.runInContext(helpers, sandbox);
  const response = await sandbox.parseResponse(new Response(body, {
    status, headers: { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json', 'X-Request-ID': 'server-456' }
  }), { requestId: 'client-123' });
  response.diagnostic = sandbox.uiRequestDiagnostics.response(response, {
    path: '/api/draft/preview', method: 'POST', requestId: 'client-123',
    timeoutMs: 65000, startedAt: Date.now() - 1, owner
  });
  sandbox.request = (path, options) => { calls.push({ path, options }); return Promise.resolve(response); };
  return { sandbox, state, edited, owner, calls, errors, response, get loads() { return loads; } };
}

async function invoke(h, name, ...args) {
  await h.sandbox[name](...args);
  // Save and extraction intentionally do not return their request promise.
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

const invalidEnvelopes = [
  ['HTML', '<html>upstream unavailable</html>'], ['empty', ''], ['whitespace', '  '],
  ['malformed JSON', '{"success":'], ['null', 'null'], ['array', '[]'],
  ['primitive', '42'], ['missing success', '{}'], ['false success', '{"success":false}'],
  ['backend code in invalid envelope', '{"success":false,"code":"unexpected"}'],
  ['nonboolean success', '{"success":"true"}'], ['missing payload', '{"success":true}']
];
const invalidSave = [
  ...invalidEnvelopes,
  ...[null, [], 'template', {}, { spec: null }, { spec: [] }, { spec: 'spec' }]
    .map((template) => ['invalid template ' + JSON.stringify(template), JSON.stringify({ success: true, template })])
];
const invalidPreview = [
  ...invalidEnvelopes,
  ...[null, [], 'result', {}, { tables: null }, { tables: {} }, { tables: [], diagrams: null }, { tables: [], diagrams: {} }]
    .map((result) => ['invalid result ' + JSON.stringify(result), JSON.stringify({ success: true, result })])
];

function assertInvalid(h) {
  assert.equal(h.errors.length, 1);
  const error = h.errors[0];
  assert.equal(error.code, 'invalid_response');
  assert.equal(error.statusCode, 200);
  assert.equal(error.diagnostic.code, 'invalid_response');
  for (const key of Object.keys(h.response.diagnostic).filter((key) => !['code', 'message'].includes(key))) {
    assert.deepEqual(error.diagnostic[key], h.response.diagnostic[key], key);
  }
  assert.equal(h.state.lastDraftPreviewOk, false);
  assert.equal(h.state.selectedTemplate, h.edited);
  assert.equal(h.state.selectedTemplate.spec.edited, true);
  assert.equal(h.state.message.type, 'error');
  assert.deepEqual(h.calls[0].options.owner, h.owner);
}

for (const [label, body] of invalidSave) {
  test('actual saveTemplate rejects ' + label + ' without replacing edited template', async () => {
    const h = await harness(body);
    await invoke(h, 'saveTemplate');
    assertInvalid(h);
    assert.equal(h.loads, 0);
    assert.equal(h.state.savingTemplate, false);
  });
}

for (const consumer of ['extractByTemplate', 'runDraftAction', 'visualizeInEditor', 'runDiagramImportRuntimePreview']) {
  for (const [label, body] of invalidPreview) {
    test('actual ' + consumer + ' rejects ' + label, async () => {
      const h = await harness(body);
      await invoke(h, consumer, ...(consumer === 'runDraftAction' ? ['preview'] : []));
      assertInvalid(h);
    });
  }
  for (const result of [{ tables: [] }, { tables: [], diagrams: [] }]) {
    test('actual ' + consumer + ' accepts ' + JSON.stringify(result), async () => {
      const h = await harness(JSON.stringify({ success: true, result }));
      await invoke(h, consumer, ...(consumer === 'runDraftAction' ? ['preview'] : []));
      assert.equal(h.errors.length, 0);
      assert.equal(h.state.message.type, 'ok');
      assert.equal(h.state.lastDraftPreviewOk, true);
      assert.equal(h.state.selectedTemplate, h.edited);
      assert.deepEqual(h.calls[0].options.owner, h.owner);
    });
  }
}

test('actual saveTemplate accepts complete envelope and reloads saved template', async () => {
  const template = { id: 1, code: 'sample', spec: { saved: true } };
  const h = await harness(JSON.stringify({ success: true, template, executionValidation: { executable: true } }));
  await invoke(h, 'saveTemplate');
  assert.equal(h.errors.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.selectedTemplate)), template);
  assert.equal(h.loads, 1);
  assert.equal(h.state.message.type, 'ok');
});

for (const capture of ['captureVisibleDesignerState', 'updateSelectedFromEditor', 'readEditorPayload']) {
  test('actual saveTemplate captures new template code owner after ' + capture, async () => {
    const saved = { id: 2, code: 'new-template', spec: { saved: true } };
    const h = await harness(JSON.stringify({ success: true, template: saved }));
    delete h.edited.id;
    h.edited.code = '';
    h.state.designerSection = 'template';
    h.sandbox.uiRequestOwner = () => ({ ...h.owner, templateCode: h.state.selectedTemplate.code });
    h.sandbox.uiDiagnosticIsCurrent = (diagnostic) => diagnostic.owner.templateCode === h.state.selectedTemplate.code;
    const originalCapture = h.sandbox[capture];
    h.sandbox[capture] = (...args) => {
      h.state.selectedTemplate.code = 'new-template';
      return originalCapture(...args);
    };
    const originalRequest = h.sandbox.request;
    h.sandbox.request = (path, options) => {
      h.response.diagnostic.owner = options.owner;
      return originalRequest(path, options);
    };
    await invoke(h, 'saveTemplate');
    assert.equal(h.calls[0].options.owner.templateCode, 'new-template');
    assert.equal(h.calls[0].options.method, 'POST');
    assert.equal(h.calls[0].options.body.code, 'new-template');
    assert.equal(h.state.selectedTemplate.id, 2);
    assert.equal(h.state.selectedTemplate.spec.saved, true);
    assert.equal(h.state.designerSection, 'templates');
    assert.equal(h.loads, 1);
    assert.equal(h.errors.length, 0);
  });
}

test('actual saveTemplate still reports synchronous payload errors normally', async () => {
  const h = await harness('{}');
  const error = new Error('invalid local payload');
  h.sandbox.readEditorPayload = () => { throw error; };
  await invoke(h, 'saveTemplate');
  assert.equal(h.errors[0], error);
  assert.equal(h.calls.length, 0);
});

test('actual saveTemplate does not overwrite newer message after delayed reload', async () => {
  let current = true;
  const h = await harness('{"success":true,"template":{"spec":{}}}', { current: () => current });
  let resolve;
  h.sandbox.loadDesigner = () => new Promise((done) => { resolve = done; });
  await invoke(h, 'saveTemplate');
  assert.equal(typeof resolve, 'function');
  current = false;
  const newer = { marker: 'newer operation' };
  h.state.message = newer;
  resolve();
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  assert.equal(h.state.message, newer);
});

test('actual intermediate diagram preview invalid response clears success gate but preserves visible SVG', async () => {
  const h = await harness('{}', { mode: 'intermediate' });
  const visible = { svg: 'previous' };
  h.state.diagramImportRuntimePreview = visible;
  await invoke(h, 'runDiagramImportRuntimePreview');
  assertInvalid(h);
  assert.equal(h.state.diagramImportRuntimePreview, visible);
});

for (const consumer of ['saveTemplate', 'extractByTemplate', 'runDraftAction', 'visualizeInEditor', 'runDiagramImportRuntimePreview']) {
  for (const body of ['{}', '{"success":true,"template":{"spec":{}},"result":{"tables":[]}}']) {
    test('actual ' + consumer + ' ignores stale ' + body, async () => {
      const h = await harness(body, { current: false, mode: 'intermediate' });
      const newer = { marker: 'newer result' };
      h.state.result = newer;
      h.state.diagramImportRuntimePreview = newer;
      await invoke(h, consumer, ...(consumer === 'runDraftAction' ? ['preview'] : []));
      assert.equal(h.errors.length, 0);
      assert.equal(h.state.selectedTemplate, h.edited);
      assert.equal(h.state.result, newer);
      assert.equal(h.state.diagramImportRuntimePreview, newer);
      assert.equal(h.state.lastDraftPreviewOk, true);
      assert.equal(h.loads, 0);
    });
  }
}

for (const stale of [false, true]) {
  test('actual diagram preview queued replay ' + (stale ? 'rejects stale owner after template switch' : 'retains original current owner'), async () => {
    let current = true;
    const h = await harness('{"success":true,"result":{"tables":[],"diagrams":[]}}', { current: () => current });
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const originalRequest = h.sandbox.request;
    h.sandbox.request = (path, options) => {
      const result = originalRequest(path, options);
      return h.calls.length === 1 ? pending : result;
    };
    const running = invoke(h, 'runDiagramImportRuntimePreview');
    await invoke(h, 'runDiagramImportRuntimePreview');
    const queued = h.state.diagramImportRuntimePreviewQueued;
    assert.deepEqual({ ...queued.owner }, h.owner);
    assert.equal(h.calls.length, 1);
    // A replay must use the queued snapshot, never recapture the owner's current value.
    h.sandbox.uiRequestOwner = () => ({ ...h.owner, templateCode: 'another-template', generation: 99 });
    if (stale) {
      current = false;
      h.state.selectedTemplate = { code: 'another-template', spec: {} };
    }
    resolve(h.response);
    await running;
    assert.equal(h.calls.length, stale ? 1 : 2);
    assert.equal(h.state.diagramImportRuntimePreviewQueued, null);
    if (!stale) assert.deepEqual({ ...h.calls[1].options.owner }, h.owner);
    else {
      assert.equal(h.state.selectedTemplate.code, 'another-template');
      assert.equal(h.state.diagramImportRuntimePreview, undefined);
    }
    assert.equal(h.errors.length, 0);
  });
}

test('actual diagram preview rejects explicit stale replay owner before state mutation', async () => {
  const h = await harness('{}', { current: false });
  const newer = { marker: 'newer preview' };
  h.state.diagramImportRuntimePreview = newer;
  await invoke(h, 'runDiagramImportRuntimePreview', { owner: h.owner });
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.diagramImportRuntimePreview, newer);
  assert.equal(h.state.lastDraftPreviewOk, true);
});

for (const newerMessage of [false, true]) {
  test('actual saveTemplate after input revision changes ' + (newerMessage ? 'preserves newer message' : 'clears only its obsolete loading message'), async () => {
    const h = await harness('{"success":true,"template":{"code":"sample","spec":{"saved":true}}}');
    h.state.uiDiagnosticRevision = h.owner.revision;
    h.sandbox.uiRequestOwner = () => ({ ...h.owner, revision: h.state.uiDiagnosticRevision });
    h.sandbox.uiDiagnosticIsCurrent = (diagnostic) => diagnostic.owner.revision === h.state.uiDiagnosticRevision;
    let resolve;
    h.sandbox.request = () => new Promise((done) => { resolve = done; });
    const operation = invoke(h, 'saveTemplate');
    assert.equal(h.state.message.text, 'savingTemplate');
    h.state.uiDiagnosticRevision += 1;
    h.state.selectedTemplate.spec.editedAfterRequest = true;
    // Use the same text to ensure cleanup relies on operation identity, not a translated label.
    const newer = { type: 'ok', text: 'savingTemplate' };
    if (newerMessage) h.state.message = newer;
    resolve(h.response);
    await operation;
    assert.equal(h.state.message, newerMessage ? newer : null);
    assert.equal(h.state.selectedTemplate, h.edited);
    assert.equal(h.state.selectedTemplate.spec.editedAfterRequest, true);
    assert.equal(h.state.savingTemplate, false);
    assert.equal(h.loads, 0);
    assert.equal(h.errors.length, 0);
  });
}

test('HTTP error keeps backend code and original diagnostic', async () => {
  const h = await harness('{"success":false,"code":"backend_error"}', { status: 502 });
  await invoke(h, 'saveTemplate');
  assert.equal(h.errors[0].code, 'backend_error');
  assert.equal(h.errors[0].diagnostic, h.response.diagnostic);
});

for (const consumer of ['saveTemplate', 'extractByTemplate', 'runDraftAction', 'visualizeInEditor', 'runDiagramImportRuntimePreview']) {
  test('actual ' + consumer + ' cannot clear newer data when invalid response arrives late', async () => {
    let current = true;
    const h = await harness('{}', { current: () => current });
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const originalRequest = h.sandbox.request;
    h.sandbox.request = (path, options) => { originalRequest(path, options); return pending; };
    const operation = invoke(h, consumer, ...(consumer === 'runDraftAction' ? ['preview'] : []));
    current = false;
    const newer = { marker: 'newer operation' };
    h.state.result = newer;
    h.state.extractionPreview = newer;
    h.state.diagramImportRuntimePreview = newer;
    h.state.lastDraftPreviewOk = true;
    h.state.message = newer;
    resolve(h.response);
    await operation;
    assert.equal(h.errors.length, 0);
    assert.equal(h.state.result, newer);
    assert.equal(h.state.extractionPreview, newer);
    assert.equal(h.state.diagramImportRuntimePreview, newer);
    assert.equal(h.state.message, newer);
    assert.equal(h.state.lastDraftPreviewOk, true);
    assert.equal(h.state.selectedTemplate, h.edited);
  });
}
