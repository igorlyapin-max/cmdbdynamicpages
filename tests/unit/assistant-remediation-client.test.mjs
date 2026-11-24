import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
function load(context, names) {
  for (const name of names) {
    const start = source.indexOf('  function ' + name + '(');
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), context);
  }
}
const settle = () => new Promise(setImmediate);

function harness() {
  const fields = new Map();
  const state = {
    root: 'A', session: {}, selectedTemplate: { code: 'sample', spec: { text: 'initial' } },
    templates: [], designerSection: 'template', uiDiagnosticRevision: 0, uiDiagnosticGeneration: 0,
    pendingTemplateWrites: new Map(), templatePublicationNotices: new Map(),
    get savingTemplate() { return context.templateWritePending(context.readTemplateCode()); }
  };
  const calls = [];
  const context = vm.createContext({ state, boot: { mode: 'designer' }, apiPrefix: '/api',
    document: { getElementById: (id) => fields.get(id), querySelector: () => null, querySelectorAll: () => [...fields.values()] },
    window: {}, t: (key) => key, runtimeSettingsReadDraft: null,
    renderDesigner: () => {}, syncImportedDiagramSaveGate: () => {}, captureVisibleDesignerState: () => true,
    captureAssistantPromptsFromDom: () => {}, updateSelectedFromEditor: () => {}, assistantSpecWithPrompts: (value) => value,
    defaultSpec: () => ({}), activeDiagramImportEditorModel: () => null,
    cloneJsonValue: (value) => structuredClone(value),
    validateUiResponse: (result) => { if (result.ok && !result.json.template) throw new Error('invalid response'); },
    createRequestError: () => new Error('failed'), setUiError: (error) => { state.message = error.message; },
    diagramImportExecutionValidationHasMappingBlocker: () => false,
    readEditorPayload: () => ({ ...state.selectedTemplate, expectedSpecHash: state.selectedTemplate.specHash }),
    request: (path, options) => new Promise((resolve, reject) => { calls.push({ path, options, resolve, reject }); })
  });
  const start = source.indexOf('  var designerRoot = state.root;');
  vm.runInContext(source.slice(start, source.indexOf('  function runtimeSettingsScope()', start)), context);
  load(context, ['runtimeSettingsScope', 'runtimeSettingsScopeIsCurrent', 'runtimeSettingsDraft', 'captureRuntimeSettingsInput',
    'captureRuntimeSettingsFields', 'restoreRuntimeSettingsFields', 'readValue', 'readChecked', 'hasField', 'readPositiveIntField',
    'uiRequestOwner', 'uiDiagnosticIsCurrent', 'captureTemplateEditorSnapshot', 'saveTemplateSnapshot', 'saveTemplate', 'runtimeConfigWarnings', 'persistRuntimeConfig',
    'readTemplateCode', 'templateWriteKey', 'templateWritePending']);
  return { fields, state, calls, context };
}

test('successful initial POST ACK advances identity/hash while preserving newer edits and dirty flags', async () => {
  const { context, state, calls } = harness();
  context.saveTemplate();
  assert.equal(calls[0].options.method, 'POST');
  state.selectedTemplate.spec = { text: 'new unsaved edit' };
  state.uiDiagnosticRevision++;
  state.assistantAuthoringDirty = true;
  calls[0].resolve({ ok: true, json: { template: { id: 42, code: 'sample', specHash: 'hash-1', version: 1, spec: { text: 'initial' } } } });
  await settle();
  assert.equal(state.selectedTemplate.id, 42);
  assert.equal(state.selectedTemplate.specHash, 'hash-1');
  assert.equal(state.selectedTemplate.spec.text, 'new unsaved edit');
  assert.equal(state.assistantAuthoringDirty, true);
  assert.equal(state.savingTemplate, false);
  context.saveTemplate();
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.body.expectedSpecHash, 'hash-1');
  calls[1].resolve({ ok: true, json: { template: { ...state.selectedTemplate, specHash: 'hash-2' }, executionValidation: { executable: true } } });
  await settle();
  assert.equal(state.selectedTemplate.specHash, 'hash-2');
});

test('another editor instance cannot receive late ACK or finally state', async () => {
  const { context, state, calls } = harness();
  context.saveTemplate();
  state.templateEditorInstance = 1;
  state.selectedTemplate = { code: 'other', spec: {} };
  context.saveTemplate();
  calls[0].resolve({ ok: true, json: { template: { id: 42, code: 'sample', specHash: 'old', spec: {} } } });
  await settle();
  assert.equal(state.selectedTemplate.code, 'other');
  assert.equal(state.savingTemplate, true);
  assert.equal(state.templates[0].code, 'sample');
  calls[1].resolve({ ok: true, json: { template: { id: 43, code: 'other', spec: {} } } });
  await settle();
  assert.equal(state.savingTemplate, false);
});

test('successful ACK and failed Save do not overwrite newer operation diagnostics', async () => {
  for (const ok of [true, false]) {
    const { context, state, calls } = harness();
    context.saveTemplate();
    state.uiDiagnosticGeneration++;
    const diagnostic = { text: 'newer failure' };
    state.message = diagnostic;
    calls[0].resolve({ ok, json: { template: { id: 42, code: 'sample', specHash: 'new', spec: {} } } });
    await settle();
    assert.equal(state.message, diagnostic);
    if (ok) assert.equal(state.selectedTemplate.specHash, 'new');
  }
});

test('root A-B-A and session replacement invalidate pending ownership', async () => {
  for (const change of [(state) => { state.root = 'B'; state.root = 'A'; }, (state) => { state.session = {}; }]) {
    const { context, state, calls } = harness();
    context.saveTemplate();
    const owner = calls[0].options.owner;
    change(state);
    assert.equal(context.uiDiagnosticIsCurrent({ owner }), false);
    calls[0].resolve({ ok: true, json: { template: { id: 42, code: 'sample', specHash: 'old', spec: {} } } });
    await settle();
    assert.equal(state.selectedTemplate.id, undefined);
  }
});

test('raw runtime fields retain invalid strings, booleans and prompts through rerender; scope changes discard them', () => {
  const { context, fields, state } = harness();
  for (const [id, value, checked] of [['number', 'invalid-01', false], ['prompt', 'raw prompt\n\n', false], ['enabled', '', true]]) {
    const field = { id, value, checked, type: 'text', closest: () => true };
    fields.set(id, field);
    context.captureRuntimeSettingsInput({ target: field });
    field.value = ''; field.checked = false;
  }
  context.restoreRuntimeSettingsFields();
  assert.equal(fields.get('number').value, 'invalid-01');
  assert.equal(fields.get('prompt').value, 'raw prompt\n\n');
  assert.equal(fields.get('enabled').checked, true);
  context.runtimeSettingsReadDraft = context.runtimeSettingsDraft();
  assert.throws(() => context.readPositiveIntField('number', 'number', 10), /invalidParamValue/);
  context.runtimeSettingsReadDraft = null;
  state.root = 'B'; state.root = 'A';
  context.captureRuntimeSettingsFields();
  assert.equal(Object.keys(context.runtimeSettingsDraft().fields).length, 0);
});

test('config ACK preserves newer raw revision and clamp warnings, clears only acknowledged revision', async () => {
  const { context, state, calls } = harness();
  const draft = context.runtimeSettingsDraft();
  draft.fields.number = { value: '9999999' };
  draft.revision = 1;
  const pending = context.persistRuntimeConfig('A', {});
  draft.revision = 2;
  draft.fields.number.value = 'not yet valid';
  calls[0].resolve({ ok: true, json: { success: true, config: {}, diagnostics: { limits: [{ settingPath: 'assistant.llm.maxTokens', requested: 9999999, effectiveLimit: 8192, absoluteCap: 8192, clamped: true }] } } });
  await pending;
  assert.equal(context.runtimeSettingsDraft().fields.number.value, 'not yet valid');
  assert.equal(state.message.type, 'warning');
  assert.match(state.message.text, /requested=9999999, effective=8192, cap=8192/);
  const saved = context.persistRuntimeConfig('A', {});
  calls[1].resolve({ ok: true, json: { success: true, config: {} } });
  await saved;
  assert.equal(state.runtimeSettingsDraft, null);
});
