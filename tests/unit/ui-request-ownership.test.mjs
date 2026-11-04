import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';

const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
function harness() {
  const state = { selectedTemplate: { code: 'sample' }, designerSection: 'template', uiDiagnosticGeneration: 0, uiDiagnosticRevision: 0 };
  const sandbox = vm.createContext({ state, boot: { mode: 'designer' }, uiRequestDiagnostics: createUiRequestDiagnostics(), t: (key) => key });
  for (const name of ['runUiOperation', 'runUiMutation', 'invalidateUiDiagnosticRevision', 'uiRequestOwner', 'uiDiagnosticIsCurrent', 'uiErrorMessage', 'setUiError']) {
    const start = source.indexOf('  function ' + name + '(');
    assert.ok(start >= 0, name);
    const end = source.indexOf('\n  }', start) + 4;
    vm.runInContext(source.slice(start, end), sandbox);
  }
  return { state, sandbox };
}

test('one explicit operation retains ownership across its asynchronous stages', async () => {
  const { state, sandbox } = harness();
  const result = await sandbox.runUiOperation('semantic-plan', async () => {
    const owner = sandbox.uiRequestOwner();
    await Promise.resolve();
    assert.equal(sandbox.uiDiagnosticIsCurrent({ owner }), true);
    return owner;
  });
  assert.equal(state.uiDiagnosticGeneration, 1);
  assert.equal(result.action, 'semantic-plan');
  assert.equal(sandbox.uiDiagnosticIsCurrent({ owner: result }), true);
});

test('picker searches and language changes preserve ownership, selected values invalidate it', () => {
  const { sandbox } = harness();
  const owner = sandbox.runUiOperation('save-template', () => sandbox.uiRequestOwner());
  for (const selector of ['data-catalog-field-picker-search', 'data-diagram-import-condition-picker-search', 'data-compact-multi-select-search']) {
    sandbox.invalidateUiDiagnosticRevision({ target: { matches: (value) => value.includes(selector) } });
    assert.equal(sandbox.uiDiagnosticIsCurrent({ owner }), true, selector);
  }
  sandbox.invalidateUiDiagnosticRevision({ target: { id: 'cmdp-language' } });
  assert.equal(sandbox.uiDiagnosticIsCurrent({ owner }), true);
  sandbox.invalidateUiDiagnosticRevision({ target: { id: 'selected-column' } });
  assert.equal(sandbox.uiDiagnosticIsCurrent({ owner }), false);
});

test('non-DOM mutations invalidate pending diagnostics without starting a new operation', () => {
  const { state, sandbox } = harness();
  const owner = sandbox.runUiOperation('extract-template', () => sandbox.uiRequestOwner());
  let changed = false;
  sandbox.runUiMutation(() => { changed = true; });
  assert.equal(changed, true);
  assert.equal(state.uiDiagnosticGeneration, 1);
  assert.equal(sandbox.uiDiagnosticIsCurrent({ owner }), false);
});

test('replacement operation and another template cannot receive the previous error', () => {
  const { state, sandbox } = harness();
  const owner = sandbox.runUiOperation('save-template', () => sandbox.uiRequestOwner());
  sandbox.runUiOperation('preview-template', () => {});
  const error = { message: 'Old error', diagnostic: { code: 'save_failed', owner } };
  sandbox.setUiError(error);
  assert.equal(state.message, undefined);
  const current = sandbox.uiRequestOwner();
  state.selectedTemplate = { code: 'other' };
  sandbox.setUiError({ ...error, diagnostic: { ...error.diagnostic, owner: current } });
  assert.equal(state.message, undefined);
});

test('disclosure dispatch does not start a new request generation', () => {
  const start = source.indexOf('    var action = target.getAttribute(\'data-action\');');
  const stop = source.indexOf("    if (action === 'diagram-import-editor-tab')", start);
  assert.ok(start >= 0 && stop > start);
  assert.doesNotMatch(source.slice(start, stop), /uiDiagnosticGeneration\s*=|runUiOperation\(/);
  assert.match(source, /if \(action === 'save-template'\) runUiOperation\(action,/);
  assert.match(source, /if \(action === 'remove-object-selection'\) runUiMutation\(/);
});
