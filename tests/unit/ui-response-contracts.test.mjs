import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';
import { staticSnapshotParamPairs } from '../../scripts/template-parameters.mjs';

const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const functions = ['responseResult', 'parseResponse', 'validateUiResponse', 'createRequestError', 'requestDraftPreview',
  'runtimeSettingsScope', 'runtimeSettingsScopeIsCurrent', 'captureTemplateEditorSnapshot', 'saveTemplateSnapshot',
  'templateWriteKey', 'templateWritePending', 'templatePublicationNotice', 'exactReportLaunchQuery',
  'isSnapshotHash', 'isSnapshotResult', 'isPersistedSnapshotCache', 'validateSnapshotMutationResponse', 'snapshotMutationOutcomeUnknown',
  'draftPreviewRequestTimeoutMs', 'saveTemplate', 'extractByTemplate', 'extractionIsRunning', 'extractionMatchesDraft', 'extractionCaptureDetails', 'runDraftAction',
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
  const state = { root: 'A', session: {}, templates: [], uiDiagnosticRevision: owner.revision,
    pendingTemplateWrites: new Map(), templatePublicationNotices: new Map(),
    get savingTemplate() { return sandbox.templateWritePending(sandbox.readTemplateCode()); },
    selectedTemplate: edited, designerSection: 'assistant', lastDraftPreviewOk: true };
  const sandbox = vm.createContext({
    state, boot: {}, apiPrefix: '/api', window: { history: {} },
    document: { getElementById: () => null, querySelector: () => null },
    cloneJsonValue: (value) => structuredClone(value),
    uiRequestDiagnostics: createUiRequestDiagnostics(),
    staticSnapshotParamPairs,
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
    assistantFlowApplyPending: () => false, selectedExtractionSource: () => 'items',
    stableClientJsonStringify: JSON.stringify,
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
  // Some consumers do not return their request promise.
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

test('snapshot mutations only treat known API gateway failures as definitive after dispatch', async () => {
  const { sandbox } = await harness('{}');
  const sent = { requestSent: true, responseFormat: 'none' };
  for (const [action, timeout] of [['publish', 'draft_preview_timeout'], ['refresh-snapshot', 'snapshot_refresh_timeout']]) {
    const unknown = (result, diagnostic = sent) => sandbox.snapshotMutationOutcomeUnknown(result, diagnostic, action);
    const bad = (status, json) => ({ status, json, ok: false });
    assert.equal(unknown(undefined), true);
    assert.equal(unknown(undefined, { ...sent, requestSent: false }), false);
    assert.equal(unknown({ status: 200, ok: true }), true);
    for (const status of [502, 503, 504]) {
      assert.equal(unknown(bad(status, null)), true);
      assert.equal(unknown(bad(status, { success: false, code: 'proxy_error' })), true);
    }
    assert.equal(unknown(bad(504, { success: false, action, reason: timeout })), false);
    assert.equal(unknown(bad(504, { success: false, action: 'run', reason: timeout })), true);
    assert.equal(unknown(bad(503, { success: false, action, reason: 'snapshot_commit_outcome_unknown' })), true);
    assert.equal(unknown(bad(503, { success: false, action, reason: 'snapshot_storage_unavailable' })), false);
    assert.equal(unknown(bad(502, { success: false, action, reason: 'snapshot_refresh_data_unavailable' })), false);
    assert.equal(unknown(bad(503, null), { ...sent, requestSent: false }), false);
    assert.equal(unknown(bad(403, null)), false);
  }
});

test('snapshot mutation success requires matching action, template and persisted metadata', async () => {
  const { sandbox } = await harness('{}');
  const code = 'sample';
  const cache = { enabled: true, scope: 'staticSnapshot', status: 'snapshot-published', sharedAcrossUsers: true,
    backend: 'memory', key: 'a'.repeat(16), publishedAt: '2026-01-01T00:00:00.000Z',
    specHash: 'b'.repeat(64), paramsHash: 'c'.repeat(64), snapshotRevision: 'd'.repeat(64) };
  const params = { site: 42, enabled: false };
  const target = { code, specHash: cache.specHash, paramsMode: 'exact', query: sandbox.exactReportLaunchQuery(params) };
  const published = { success: true, action: 'publish', template: { code, active: true }, result: { tables: [] }, params, cache };
  const validate = (json, action, expected) => sandbox.validateSnapshotMutationResponse({ status: 200, ok: true, json }, action, expected);
  const reject = (json, action, expected) => assert.throws(() => validate(json, action, expected), { code: 'invalid_response' });
  validate(published, 'publish', target);
  for (const invalid of [{ success: true }, { ...published, action: 'run' }, { ...published, template: { code: 'other', active: true } },
    { ...published, result: {} }, { ...published, cache: null }, { ...published, cache: { ...cache, status: 'snapshot-hit' } },
    { ...published, cache: { ...cache, specHash: 'e'.repeat(64) } }, { ...published, params: { ...params, site: '42' } }]) {
    reject(invalid, 'publish', target);
  }
  const shared = { ...published, action: 'refresh-snapshot', mode: 'shared', snapshotFound: true };
  const refresh = { code, mode: 'shared', snapshotRevision: 'e'.repeat(64), cache };
  validate(shared, 'refresh-snapshot', refresh);
  reject(shared, 'refresh-snapshot', { ...refresh, snapshotRevision: cache.snapshotRevision });
  reject({ ...shared, cache: { ...cache, key: 'f'.repeat(16) } }, 'refresh-snapshot', refresh);
  reject({ ...shared, mode: 'personal', cache: null }, 'refresh-snapshot', refresh);
  validate({ ...shared, mode: 'personal', cache: null }, 'refresh-snapshot', { ...refresh, mode: 'personal' });
});

test('publication diagnostics follow a card across editors but not card, root or session changes', async () => {
  const { sandbox, state, edited } = await harness('{}');
  const notice = { cardId: '1', sessionInstance: 0, diagnostic: { serverRequestId: 'publication-id' } };
  state.templatePublicationNotices.set(sandbox.templateWriteKey(edited.code, state.root), notice);
  assert.equal(sandbox.templatePublicationNotice(), notice);
  state.selectedTemplate = { id: 2, code: 'other' };
  assert.equal(sandbox.templatePublicationNotice(), undefined);
  state.selectedTemplate = { ...edited, id: 2 };
  assert.equal(sandbox.templatePublicationNotice(), undefined);
  state.selectedTemplate = { ...edited };
  state.templateEditorInstance = 7;
  assert.equal(sandbox.templatePublicationNotice(), notice);
  state.root = 'B';
  assert.equal(sandbox.templatePublicationNotice(), undefined);
  state.root = 'A';
  state.sessionInstance = 1;
  assert.equal(sandbox.templatePublicationNotice(), undefined);
});

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

function assertInvalid(h, consumer) {
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
  if (consumer === 'extractByTemplate') {
    assert.equal(h.state.message, null);
    assert.equal(h.state.extractionPreview.diagnostic.code, 'invalid_response');
    assert.equal(h.state.extractionPreview.ok, false);
    assert.equal(h.state.extractionOperation, null);
  } else assert.equal(h.state.message.type, 'error');
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
      assertInvalid(h, consumer);
    });
  }
  for (const result of [{ tables: [] }, { tables: [], diagrams: [] }]) {
    test('actual ' + consumer + ' accepts ' + JSON.stringify(result), async () => {
      const h = await harness(JSON.stringify({ success: true, result }));
      await invoke(h, consumer, ...(consumer === 'runDraftAction' ? ['preview'] : []));
      assert.equal(h.errors.length, 0);
      if (consumer === 'extractByTemplate') {
        assert.equal(h.state.message, null);
        assert.equal(h.state.extractionPreview.ok, true);
        assert.equal(h.state.extractionOperation, null);
      } else assert.equal(h.state.message.type, 'ok');
      assert.equal(h.state.lastDraftPreviewOk, true);
      assert.equal(h.state.selectedTemplate, h.edited);
      assert.deepEqual(h.calls[0].options.owner, h.owner);
    });
  }
}

test('actual saveTemplate accepts canonical ACK without reloading over the editor', async () => {
  const template = { id: 1, code: 'sample', spec: { saved: true } };
  const h = await harness(JSON.stringify({ success: true, template, executionValidation: { executable: true } }));
  await invoke(h, 'saveTemplate');
  assert.equal(h.errors.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.selectedTemplate)), template);
  assert.equal(h.loads, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.templates)), [template]);
  assert.equal(h.state.templateDirty, false);
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
    assert.equal(h.loads, 0);
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

test('actual saveTemplate does not overwrite newer message after delayed ACK', async () => {
  let current = true;
  const h = await harness('{"success":true,"template":{"spec":{}}}', { current: () => current });
  let resolve;
  h.sandbox.request = () => new Promise((done) => { resolve = done; });
  const operation = invoke(h, 'saveTemplate');
  assert.equal(typeof resolve, 'function');
  current = false;
  const newer = { marker: 'newer operation' };
  h.state.message = newer;
  resolve(h.response);
  await operation;
  assert.equal(h.state.message, newer);
  assert.equal(h.loads, 0);
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
  test('actual saveTemplate after input revision changes ' + (newerMessage ? 'preserves newer message' : 'reports unsaved newer edits'), async () => {
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
    if (newerMessage) assert.equal(h.state.message, newer);
    else assert.deepEqual({ ...h.state.message }, { type: 'warning', text: 'savedPreviousRevision' });
    assert.equal(h.state.templateDirty, true);
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

for (const revision of ['local spec', 'saved base']) {
  test('actual extraction drops a response for the same source after changing ' + revision, async () => {
    const h = await harness('{"success":true,"result":{"tables":[{"name":"items","rows":[{}]}]}}');
    let resolve;
    h.sandbox.request = () => new Promise((done) => { resolve = done; });
    const pending = h.sandbox.extractByTemplate();
    assert.equal(h.sandbox.extractionIsRunning(), true);
    if (revision === 'local spec') h.state.selectedTemplate.spec.edited = false;
    else h.state.selectedTemplate.specHash = 'new-saved-hash';
    assert.equal(h.sandbox.extractionIsRunning(), false);
    resolve(h.response);
    await pending;
    assert.equal(h.state.extractionPreview, null);
    assert.equal(h.state.extractionOperation, null);
  });
}

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
