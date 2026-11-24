import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';
import { createAssistantDiagnosticsUi } from '../../scripts/assistant-diagnostics-ui.mjs';
import { resolveTemplateParameters, staticSnapshotParamPairs } from '../../scripts/template-parameters.mjs';
import { bindViewLargeExecutionHelpers } from '../fixtures/view-large-execution-helpers.mjs';

function clientVersionConstants(source) {
  return Object.fromEntries(['D2_IMPORT_SEMANTIC_MODEL_REVISION', 'D2_IMPORT_ENDPOINT_PROFILE_VERSION',
    'D2_IMPORT_STRUCTURE_TREE_VERSION', 'D2_IMPORT_ANALYSIS_CHECKPOINT_VERSION',
    'D2_IMPORT_ASSISTANT_CHECKPOINT_VERSION', 'ASSISTANT_PROMPT_CONTRACT_VERSION'].map((name) => {
    const match = source.match(new RegExp('^const ' + name + ' = ([0-9]+);', 'm'));
    assert.ok(match, name);
    return [name, Number(match[1])];
  }));
}

function clientScript() {
  const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function dynamicPagesClientScript()');
  const end = source.indexOf('\nfunction isCollectionLimitedAuthoringRequest', start);
  assert.ok(start >= 0 && end > start, 'generated client boundaries must exist');
  const constants = {
    createUiRequestDiagnostics, createAssistantDiagnosticsUi, resolveTemplateParameters, staticSnapshotParamPairs,
    renderViewLargeExecutionHelpers: bindViewLargeExecutionHelpers(source),
    DEFAULT_EMPTY_RESULT_TEXT: 'empty', DEFAULT_PERMISSION_DENIED_TEXT: 'denied', DEFAULT_TEMPLATE_CACHE_TTL_SEC: 3600,
    ...clientVersionConstants(source),
    DEFAULT_ASSISTANT_SYSTEM_PROMPT: 'system', DEFAULT_ASSISTANT_OBJECT_FLOW_PROMPT: 'flow', DEFAULT_ASSISTANT_OBJECT_FLOW_SEMANTIC_PROMPT: 'semantic',
    DEFAULT_ASSISTANT_DIAGRAM_SEMANTICS_PROMPT: 'diagram', DEFAULT_ASSISTANT_DIAGRAM_BINDING_INTENT_PROMPT: 'binding',
    DEFAULT_ASSISTANT_DIAGRAM_PLACEMENT_PROMPT: 'placement', DEFAULT_ASSISTANT_DIAGRAM_CONNECTIONS_PROMPT: 'connections', DEFAULT_ASSISTANT_DIAGRAM_CRITIQUE_PROMPT: 'critique'
  };
  const generate = new Function(...Object.keys(constants), source.slice(start, end) + '\nreturn dynamicPagesClientScript();');
  const script = generate(...Object.values(constants));
  const startup = "  updateChrome();\n  setupLanguageSelector();\n  if (boot.mode === 'runtime') loadRuntime();\n  else loadDesigner();";
  assert.ok(script.includes(startup));
  // Suppress only startup I/O; retain the real renderers, event handlers and request pipeline.
  return script.replace(startup, `window.remediation = { state, assistantDiagnosticsUi, renderDesigner,
    captureVisibleDesignerState, captureRuntimeSettings, runtimeSettingsDraft, defaultRuntimeConfig, defaultSpec,
    hydrateDesignerStateFromTemplate, getRunParamsFromSpec };
    setupLanguageSelector();`);
}

async function withClient(viewport, scenario) {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true });
  const expected = [];
  try {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(5000);
    const errors = [], unexpected = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const expectRequest = (method, pathname) => {
      let receive, reply;
      let timer;
      const received = new Promise((resolve, reject) => {
        receive = resolve;
        timer = setTimeout(() => reject(new Error(`Missing mock request: ${method} ${pathname}`)), 5000);
      });
      const response = new Promise((resolve) => { reply = resolve; });
      expected.push({ method, pathname, receive, response, timer });
      return { received, respond: (json, status = 200) => reply({ json, status }), fail: () => reply({ abort: true }) };
    };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://remediation.test' && request.isNavigationRequest() && url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>*{box-sizing:border-box}body{font:14px sans-serif;margin:12px}input,textarea,select{max-width:100%}label{display:block}section{max-width:100%}.visual-grid{display:grid;gap:8px}pre{overflow-wrap:anywhere}table{font-size:12px}</style></head><body><select id="cmdp-language"><option value="ru">RU</option><option value="en">EN</option></select><div id="app"></div></body></html>' });
      }
      const call = { method: request.method(), path: url.pathname, root: url.searchParams.get('root'), query: url.searchParams, body: request.postDataJSON() };
      if (call.method !== 'GET') writes.push(call);
      const index = expected.findIndex((item) => item.method === call.method && item.pathname === url.pathname);
      if (url.origin === 'http://remediation.test' && index >= 0) {
        const item = expected.splice(index, 1)[0];
        clearTimeout(item.timer);
        item.receive(call);
        const response = await item.response;
        return response.abort ? route.abort('failed') : route.fulfill(response);
      }
      if (url.origin === 'http://remediation.test' && call.method === 'GET') {
        if (url.pathname === '/cmdbuild/custom-api/csrf') return route.fulfill({ json: { success: true, token: 'mock-csrf' } });
        if (url.pathname === '/cmdbuild/custom-api/client-log' && url.searchParams.get('stage') === 'script-loaded') return route.fulfill({ status: 204 });
        if (url.pathname === '/cmdbuild/custom-api/assistant/diagnostics/status') return route.fulfill({ json: { success: true, status: { mode: 'Off' } } });
      }
      unexpected.push(call);
      return route.abort('blockedbyclient');
    });
    await page.goto('http://remediation.test/');
    await page.addScriptTag({ content: clientScript() });
    await page.evaluate(() => {
      const ui = window.remediation;
      ui.state.session = { rolePrivileges: { admin_classes_modify: true } };
      ui.state.config = { exists: true, runtimeConfig: ui.defaultRuntimeConfig() };
      ui.state.designerSection = 'settings';
      ui.renderDesigner();
    });
    await scenario({ page, expectRequest, writes });
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(unexpected, [], 'all network traffic must be explicitly mocked');
    assert.equal(expected.length, 0, 'all expected calls must occur');
  } finally {
    expected.forEach((item) => clearTimeout(item.timer));
    await browser.close();
  }
}

async function assertVisible(locator, viewport) {
  assert.equal(await locator.isVisible(), true);
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 0 && box.x >= 0 && box.x + box.width <= viewport.width, 'usable visible geometry');
}

async function openSemanticPlan(page, language = 'ru') {
  await page.locator('#cmdp-language').selectOption(language);
  await page.evaluate(() => {
    const ui = window.remediation;
    ui.state.selectedTemplate = { code: 'retry-test', spec: ui.defaultSpec() };
    ui.state.assistantObjectFlowIntent = { context: 'Devices', blocks: [
      { id: 'devices', name: 'Devices', description: 'Devices', resultKind: 'cards', uses: [] }
    ] };
    ui.state.designerSection = 'assistant';
    ui.renderDesigner();
  });
}

const semanticPath = '/cmdbuild/custom-api/assistant/object-flow/semantic-plan';
const flowPath = '/cmdbuild/custom-api/assistant/object-flow/plan';
const applyPath = '/cmdbuild/custom-api/draft/object-flow/apply';
const extractionPath = '/cmdbuild/custom-api/draft/preview';
const widgetRoot = 'Widget_QueryTool';
const widgetTemplate = { id: 7, code: 'widget-extraction', active: true, specHash: 'saved-widget-spec' };
const widgetBlock = { id: 'widgets', name: 'Карточки Widget', description: 'Все карточки класса Widget без фильтров', resultKind: 'sourceCards', uses: [] };
const widgetIntent = { context: 'Показать все карточки Widget', blocks: [widgetBlock] };
const widgetFlow = {
  version: 1,
  selections: [{ id: 'selection:widgets', name: widgetBlock.name, alias: 'widgets', className: 'Widget',
    from: '', limit: 100, columns: ['Code', 'Description'],
    // Production uses this match-all sentinel when no user filter was specified.
    rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', rightExpression: '.*' }] }],
  operations: [], blocks: [], setOperations: [], publishedAlias: 'widgets'
};
const widgetRows = [
  { _id: 41, Code: 'W-001', Description: 'Первый виджет' },
  { _id: 42, Code: 'W-002', Description: 'Второй виджет' }
];
const archiveBlock = { ...widgetBlock, id: 'archive', name: 'Архивные карточки Widget' };
const archiveSelection = { ...widgetFlow.selections[0], id: 'selection:archive', alias: 'archive', name: archiveBlock.name };
const archiveFlow = { ...widgetFlow, selections: [archiveSelection], publishedAlias: 'archive' };
const combinedWidgetFlow = { ...widgetFlow, selections: [archiveSelection, ...widgetFlow.selections] };

async function openWidgetTemplate(page, section, spec, proposal) {
  await page.locator('#cmdp-language').selectOption('ru');
  await page.evaluate(({ template, intent, root, section, spec, proposal }) => {
    const ui = window.remediation;
    ui.state.root = root;
    ui.state.selectedTemplate = { ...template, spec: spec || { ...ui.defaultSpec(), params: {}, steps: [], result: { tables: [] } } };
    ui.state.templates = [structuredClone(ui.state.selectedTemplate)];
    ui.hydrateDesignerStateFromTemplate({ replaceRunParams: true });
    ui.state.assistantObjectFlowIntent = intent;
    if (proposal) {
      ui.state.assistantFlowProposal = proposal;
      ui.state.assistantFlowCanApply = true;
      ui.state.assistantFlowOutputBindings = intent.blocks.map((block) => ({ blockId: block.id, alias: block.id }));
    }
    ui.state.designerSection = section;
    ui.renderDesigner();
  }, { template: widgetTemplate, intent: proposal?.selections.length === 2 ? { ...widgetIntent, blocks: [archiveBlock, widgetBlock] } : widgetIntent,
    root: widgetRoot, section, spec, proposal });
}

function draftWithArchive() {
  return compileObjectFlowToSpec({ version: 1, params: {}, steps: [], result: { tables: [] } }, archiveFlow);
}

function compileAppliedFlow(call) {
  const { currentSpec, flow, assistantOutputBindings, assistantObjectFlowIntent } = call.body;
  const blocks = assistantObjectFlowIntent.blocks.map(({ id, name }, index) => ({ id, name, order: index + 1 }));
  return compileObjectFlowToSpec(currentSpec, flow, {
    outputMetadata: assistantOutputBindings.map(({ alias, blockId }) => ({ alias,
      label: blocks.find((block) => block.id === blockId).name, assistantBlockId: blockId, assistantStageRole: 'terminal' })),
    assistantOutputManifest: { version: 1, blocks }
  });
}

function draftWithBothSources() {
  return compileAppliedFlow({ body: {
    currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, flow: combinedWidgetFlow,
    assistantObjectFlowIntent: { ...widgetIntent, blocks: [archiveBlock, widgetBlock] },
    assistantOutputBindings: [{ blockId: 'archive', alias: 'archive' }, { blockId: 'widgets', alias: 'widgets' }]
  } });
}

async function prepareWidgetFlow(page, expectRequest) {
  const semanticPlan = { version: 1, blocks: [{ ...widgetBlock, dependencies: [],
    resultContract: { outputKind: 'sourceCards', outputClass: 'Widget', dependencyPaths: [], relationPredicates: [], attributePredicates: [] }
  }] };
  const context = expectRequest('POST', semanticPath);
  await page.locator('[data-action="assistant-flow-prepare"]').click();
  const initial = await context.received;
  assert.equal(initial.root, widgetRoot);
  assert.equal(initial.body.stage, 'context');
  const plan = expectRequest('POST', semanticPath);
  context.respond({ success: true, checkpoint: { resumeId: initial.body.resumeId,
    stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString() } });
  const semantic = await plan.received;
  assert.equal(semantic.body.stage, 'plan');
  assert.equal(semantic.body.resumeId, initial.body.resumeId);
  plan.respond({ success: true, semanticPlan });
  const generate = expectRequest('POST', flowPath);
  await page.getByRole('button', { name: 'Сформировать поток данных', exact: true }).click();
  const generated = await generate.received;
  assert.equal(generated.root, widgetRoot);
  assert.equal(generated.body.resumeId, initial.body.resumeId);
  assert.deepEqual(generated.body.semanticPlan, semanticPlan);
  const outputBindings = [{ blockId: widgetBlock.id, alias: 'widgets' }];
  generate.respond({ success: true, flow: widgetFlow, canApply: true, outputBindings });
  return outputBindings;
}

function widgetExtractionResult(rows, limitDiagnostics = []) {
  return { success: true, action: 'preview', result: {
    tables: [{ name: 'widgets', columns: ['_id', 'Code', 'Description'], rows }],
    diagrams: [], trace: [{ index: 0, type: 'selectCards', as: 'widgets', status: 'ok', rows: rows.length, restCalls: 1, elapsedMs: 17 }],
    limitDiagnostics
  }, diagnostics: { assistantTrace: { traceId: 'fixture-widget-trace', mode: 'Basic' } } };
}

function assertWidgetExtractionRequest(call, compiledSpec) {
  assert.equal(call.root, widgetRoot);
  assert.equal(call.query.get('includeDiagrams'), 'false');
  assert.equal(call.query.get('extractionSource'), 'widgets');
  assert.equal(call.query.get('maxRows'), '100');
  assert.equal(call.body.template.code, widgetTemplate.code);
  assert.equal(call.body.template.expectedSpecHash, widgetTemplate.specHash);
  assert.deepEqual(call.body.template.spec.steps, compiledSpec.steps, 'extraction uses the applied local spec, not the saved spec');
  assert.equal(compiledSpec.steps[0].className, 'Widget');
  assert.deepEqual(compiledSpec.steps[0].filters, [
    { scope: 'include', path: 'Code', negate: false, op: 'matches', regexExpression: '.*' }
  ], 'no user-defined filters');
  assert.ok(call.body.template.spec.result.tables.some((table) => table.name === 'widgets'));
  assert.deepEqual(call.body.params, {});
}

const writeViewport = { width: 1280, height: 900 };
const templateApi = '/cmdbuild/custom-api/templates';
const writeAction = (page, action) => page.locator('button[data-action="' + action + '"]');
const openSection = (page, section) => page.locator('a[data-designer-section="' + section + '"]').click();

async function openWriteFixture(page, section) {
  await page.locator('#cmdp-language').selectOption('en');
  return page.evaluate((section) => {
    const ui = window.remediation;
    const first = { id: 17, code: 'write-a', description: 'Initial A', active: true, specHash: 'a'.repeat(64),
      spec: { ...ui.defaultSpec(), publish: { mode: 'staticSnapshot', warningAccepted: true, paramsMode: 'exact' } } };
    const second = { ...first, id: 18, code: 'write-b', description: 'Initial B', specHash: 'b'.repeat(64) };
    ui.state.root = 'Writes_QueryTool';
    ui.state.templates = [first, second];
    ui.state.selectedTemplate = structuredClone(first);
    ui.hydrateDesignerStateFromTemplate({ replaceRunParams: true });
    ui.state.designerSection = section;
    ui.renderDesigner();
    return first;
  }, section);
}

async function selectWriteFixture(page, expectRequest, code) {
  const versions = expectRequest('GET', templateApi + '/' + code + '/versions');
  await page.locator('[data-action="select-template"][data-code="' + code + '"]').click();
  await versions.received;
  versions.respond({ success: true, data: [{ id: 1, templateCode: code, spec: {} }] });
  await page.waitForFunction(() => window.remediation.state.templateVersions.length === 1);
}

test('pending template writes survive A-B-A reselection and ACKs update the list without replacing the new draft', async () => {
  await withClient(writeViewport, async ({ page, expectRequest, writes }) => {
    const first = await openWriteFixture(page, 'publication');
    const save = writeAction(page, 'save-template');
    const publish = writeAction(page, 'publish-snapshot');
    await page.locator('#cmdp-publish-params-mode').selectOption('ignore');
    const write = expectRequest('PUT', templateApi + '/write-a');
    await publish.click();
    const { body } = await write.received;
    assert.equal(body.expectedSpecHash, first.specHash);
    assert.equal(body.spec.publish.paramsMode, 'ignore');
    await openSection(page, 'templates');
    await selectWriteFixture(page, expectRequest, 'write-b');
    assert.equal(await save.isEnabled(), true, 'a different template is not locked');
    await selectWriteFixture(page, expectRequest, 'write-a');
    assert.equal(await save.isDisabled(), true);
    await save.dispatchEvent('click');
    await openSection(page, 'publication');
    assert.equal(await publish.isDisabled(), true);
    await page.locator('#cmdp-publish-public-d2-source').check();
    await openSection(page, 'templates');
    await page.locator('[data-action="select-template"][data-code="write-a"]').click();
    assert.equal(await save.isDisabled(), true);

    const savedHash = 'c'.repeat(64);
    write.respond({ success: true, template: { ...first, ...body, description: 'ACK list description', specHash: savedHash }, executionValidation: { executable: true } });
    const savedCell = page.getByRole('cell', { name: 'ACK list description' });
    await savedCell.waitFor();
    assert.ok((await savedCell.boundingBox()).height > 0);
    await openSection(page, 'publication');
    assert.equal(await page.locator('#cmdp-publish-params-mode').inputValue(), 'exact');
    assert.equal(await page.locator('#cmdp-publish-public-d2-source').isChecked(), true);
    assert.equal(await publish.isEnabled(), true);
    assert.equal(writes.length, 1, 'a reselected editor cannot publish the initial ACK');

    const retry = expectRequest('PUT', templateApi + '/write-a');
    await save.click();
    const second = await retry.received;
    assert.equal(second.body.expectedSpecHash, savedHash);
    assert.equal(second.body.spec.publish.publicD2Source, true);
    retry.respond({ success: true, template: { ...first, ...second.body, specHash: 'd'.repeat(64) }, executionValidation: { executable: true } });
    await page.locator('button[data-action="save-template"]:enabled').waitFor();
  });
});

test('publish failure survives section navigation and preserves a newer notice', async () => {
  await withClient(writeViewport, async ({ page, expectRequest }) => {
    const first = await openWriteFixture(page, 'publication');
    const save = expectRequest('PUT', templateApi + '/write-a');
    const publish = expectRequest('POST', templateApi + '/write-a/publish');
    await writeAction(page, 'publish-snapshot').click();
    const { body } = await save.received;
    const specHash = 'c'.repeat(64);
    save.respond({ success: true, template: { ...first, ...body, specHash }, executionValidation: { executable: true } });
    assert.equal((await publish.received).body.savedSpecHash, specHash);
    await openSection(page, 'cache');
    await writeAction(page, 'apply-cache').click();
    const notice = page.locator('#cmdp-designer-notice');
    const newer = (await notice.innerText()).trim();
    assert.ok(newer && !newer.includes('Publishing'));
    const code = 'snapshot_storage_unavailable';
    const message = 'Published report storage is temporarily unavailable.';
    publish.respond({ success: false, action: 'publish', reason: code, code, message }, 503);
    const failure = notice.getByRole('alert').filter({ hasText: message });
    await failure.waitFor();
    assert.ok((await failure.boundingBox()).height > 0);
    assert.ok((await notice.innerText()).includes(newer));
    const diagnostic = JSON.parse(await notice.locator('[data-ui-diagnostic-report]').textContent());
    assert.equal(diagnostic.phase, 'publish');
    assert.equal(diagnostic.code, code);
    assert.equal(await writeAction(page, 'save-template').isEnabled(), true);
    await openSection(page, 'publication');
    assert.equal(await failure.isVisible(), true);
  });
});

test('pending snapshot revocation keeps the Save ACK, localizes the warning and skips Publish', async () => {
  await withClient(writeViewport, async ({ page, expectRequest, writes }) => {
    const first = await openWriteFixture(page, 'publication');
    const publish = writeAction(page, 'publish-snapshot');
    const save = expectRequest('PUT', templateApi + '/write-a');
    await publish.click();
    const { body } = await save.received;
    const savedHash = 'c'.repeat(64);
    save.respond({ success: true, template: { ...first, ...body, specHash: savedHash, version: 2 },
      snapshotRevocationPending: true, executionValidation: { executable: true } });
    const warning = page.locator('#cmdp-designer-publication-notice .notice.warning');
    await warning.waitFor();
    await assertVisible(warning, writeViewport);
    assert.match(await warning.innerText(), /Template saved.*complete revocation/);
    assert.deepEqual(writes.map(({ method }) => method), ['PUT']);
    assert.deepEqual(await page.evaluate(() => {
      const { specHash, version } = window.remediation.state.selectedTemplate;
      return [specHash, version];
    }), [savedHash, 2]);
    await page.locator('#cmdp-language').selectOption('ru');
    assert.match(await warning.innerText(), /Шаблон сохранён.*завершить отзыв/);
    await openSection(page, 'cache');
    assert.equal(await warning.isVisible(), true);
    await openSection(page, 'publication');

    const retry = expectRequest('PUT', templateApi + '/write-a');
    const publication = expectRequest('POST', templateApi + '/write-a/publish');
    await publish.click();
    const next = await retry.received;
    assert.equal(next.body.expectedSpecHash, savedHash);
    const freshHash = 'd'.repeat(64);
    retry.respond({ success: true, template: { ...first, ...next.body, specHash: freshHash, version: 3 },
      snapshotRevocationPending: false, executionValidation: { executable: true } });
    const { body: published } = await publication.received;
    assert.equal(published.savedSpecHash, freshHash);
    publication.respond({ success: true, action: 'publish', template: { code: first.code, active: true },
      params: published.params, result: { tables: [] }, cache: { enabled: true, scope: 'staticSnapshot', status: 'snapshot-published',
        sharedAcrossUsers: true, backend: 'memory', key: 'a'.repeat(16), specHash: freshHash, paramsHash: 'b'.repeat(64),
        publishedAt: '2026-01-01T00:00:00Z' } });
    await page.locator('button[data-action="publish-snapshot"]:enabled').waitFor();
    assert.equal(await warning.count(), 0);
  });
});

test('pending writes for the same template code in different roots do not unlock or amend each other', async () => {
  await withClient(writeViewport, async ({ page, expectRequest }) => {
    const first = await openWriteFixture(page, 'templates');
    const button = writeAction(page, 'save-template');
    const writeA = expectRequest('PUT', templateApi + '/write-a');
    await button.click();
    const requestA = await writeA.received;
    const second = { ...first, description: 'Other root version', specHash: 'b'.repeat(64) };
    await page.evaluate((template) => {
      const ui = window.remediation;
      ui.state.root = 'Other_QueryTool';
      ui.state.templates = [template];
      ui.state.selectedTemplate = structuredClone(template);
      ui.hydrateDesignerStateFromTemplate({ replaceRunParams: true });
      ui.renderDesigner();
    }, second);
    assert.equal(await button.isEnabled(), true);
    const writeB = expectRequest('PUT', templateApi + '/write-a');
    await button.click();
    const requestB = await writeB.received;
    assert.notEqual(requestA.root, requestB.root);
    assert.equal(requestB.body.expectedSpecHash, second.specHash);

    writeA.respond({ success: true, template: { ...first, description: 'Do not copy across roots', specHash: 'c'.repeat(64) } });
    await page.waitForFunction(() => window.remediation.state.pendingTemplateWrites.size === 1);
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByRole('cell', { name: 'Do not copy across roots' }).count(), 0);
    assert.equal(await page.getByRole('cell', { name: second.description }).isVisible(), true);
    writeB.respond({ success: true, template: { ...second, description: 'Other root ACK', specHash: 'd'.repeat(64) } });
    const cell = page.getByRole('cell', { name: 'Other root ACK' });
    await cell.waitFor();
    assert.ok((await cell.boundingBox()).height > 0);
    assert.equal(await button.isEnabled(), true);
  });
});

test('Save unlocks transfer actions without replacing transfer inputs or prepared import', async () => {
  await withClient(writeViewport, async ({ page, expectRequest }) => {
    const first = await openWriteFixture(page, 'templates');
    const prepare = expectRequest('POST', '/cmdbuild/custom-api/template-transfer/prepare');
    const fileName = 'independent.cmdp-template.json';
    await page.locator('#cmdp-transfer-file').setInputFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.locator('#cmdp-transfer-code').fill('transfer-target');
    const description = page.locator('#cmdp-transfer-description');
    await description.fill('Keep this import description');
    await page.locator('#cmdp-transfer-overrides').fill('[{"path":"$.spec.example","value":"kept"}]');
    await writeAction(page, 'template-transfer-prepare').click();
    const prepared = await prepare.received;
    prepare.respond({ success: true, template: { code: prepared.body.targetCode, spec: first.spec },
      checks: { status: 'ready', issues: [], environmentReferences: [] }, changes: {} });
    const stage = writeAction(page, 'template-transfer-stage');
    await page.locator('button[data-action="template-transfer-stage"]:enabled').waitFor();
    const overrides = await page.locator('#cmdp-transfer-overrides').inputValue();
    const originalInput = await description.elementHandle();
    const save = expectRequest('PUT', templateApi + '/write-a');
    await writeAction(page, 'save-template').click();
    const { body } = await save.received;
    for (const action of ['export', 'prepare', 'stage']) assert.equal(await writeAction(page, 'template-transfer-' + action).isDisabled(), true);
    await description.focus();
    await description.evaluate((field) => field.setSelectionRange(5, 9));
    save.respond({ success: true, template: { ...first, ...body, specHash: 'c'.repeat(64) }, executionValidation: { executable: true } });
    await page.locator('button[data-action="template-transfer-stage"]:enabled').waitFor();
    for (const action of ['export', 'prepare']) assert.equal(await writeAction(page, 'template-transfer-' + action).isEnabled(), true);
    assert.equal(await stage.isVisible(), true);
    assert.ok((await stage.boundingBox()).height > 0);
    assert.equal(await originalInput.evaluate((field) => field === document.activeElement), true);
    assert.deepEqual(await description.evaluate((field) => [field.selectionStart, field.selectionEnd]), [5, 9]);
    assert.equal(await description.inputValue(), 'Keep this import description');
    assert.equal(await page.locator('#cmdp-transfer-overrides').inputValue(), overrides);
    assert.equal(await page.locator('#cmdp-transfer-code').inputValue(), 'transfer-target');
    assert.equal(await page.getByText(fileName, { exact: true }).isVisible(), true);
  });
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Assistant Apply and Extraction show draft-only Widget results at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      const saved = draftWithArchive();
      await openWidgetTemplate(page, 'extraction', saved);
      const source = page.locator('#cmdp-extraction-source');
      const extractButton = page.locator('[data-action="extract-template"]');
      assert.equal(await source.inputValue(), 'archive');
      assert.equal(await extractButton.isEnabled(), true, 'old draft would otherwise be executable');
      await page.locator('[data-designer-section="assistant"]').click();
      const applyStatus = page.locator('[data-assistant-flow-apply-status]');
      const applyButton = page.getByRole('button', { name: 'Применить цепочку', exact: true });
      const initialReason = applyStatus.filter({ hasText: 'Сначала сформируйте поток данных.' });
      await initialReason.waitFor();
      await assertVisible(initialReason, viewport);
      assert.equal(await applyButton.isDisabled(), true);
      assert.equal(await applyButton.getAttribute('aria-describedby'), await initialReason.getAttribute('id'));
      assert.deepEqual(writes, []);

      const outputBindings = await prepareWidgetFlow(page, expectRequest);
      const apply = expectRequest('POST', applyPath);
      await applyButton.click();
      const applied = await apply.received;
      assert.equal(await applyButton.isDisabled(), true);
      await assertVisible(applyStatus, viewport);
      assert.match(await applyStatus.innerText(), /Применяем цепочку/);
      assert.doesNotMatch(await applyStatus.innerText(), /Цепочка применена|Изменения готовы/);
      assert.equal(applied.body.root, widgetRoot);
      assert.equal(applied.body.templateCode, widgetTemplate.code);
      assert.equal(applied.body.baseSpecHash, widgetTemplate.specHash);
      assert.deepEqual(applied.body.assistantOutputBindings, outputBindings);
      assert.deepEqual(applied.body.assistantObjectFlowIntent, widgetIntent);
      assert.deepEqual(applied.body.currentSpec.steps, saved.steps);
      assert.deepEqual(applied.body.flow, widgetFlow);
      const compiled = compileAppliedFlow(applied);
      await page.locator('[data-designer-section="extraction"]').click();
      const editor = page.locator('#cmdp-extraction-editor');
      const status = (state) => editor.locator(`[data-extraction-status][data-extraction-state="${state}"]`);
      const table = editor.locator('table');
      await status('apply-pending').filter({ hasText: 'Применяем цепочку' }).waitFor();
      await assertVisible(status('apply-pending'), viewport);
      assert.equal(await source.inputValue(), 'archive');
      assert.equal(await extractButton.isDisabled(), true);
      await extractButton.dispatchEvent('click');
      assert.equal(writes.filter((call) => call.path === extractionPath).length, 0, 'pending Apply cannot extract the old draft');

      apply.respond({ success: true, action: 'object-flow-apply', spec: compiled, specHash: 'unsaved-widget-spec' });
      await status('not-started').filter({ hasText: 'Данные ещё не извлечены.' }).waitFor();
      await assertVisible(status('not-started'), viewport);
      assert.equal(await table.count(), 0);
      assert.equal(await source.inputValue(), 'widgets');
      assert.deepEqual(await source.locator('option').evaluateAll((options) => options.map((option) => option.value)), ['widgets']);
      assert.deepEqual(await source.locator('option:checked').allTextContents(), [widgetBlock.name]);
      assert.equal(await extractButton.isEnabled(), true);
      const unsaved = page.locator('[data-authoring-unsaved]');
      await assertVisible(unsaved, viewport);
      await page.locator('[data-designer-section="assistant"]').click();
      const appliedStatus = applyStatus.filter({ hasText: 'Цепочка применена к черновику. Данные ещё не извлечены.' });
      await assertVisible(appliedStatus, viewport);
      assert.equal(await applyButton.isDisabled(), true);
      await page.locator('[data-designer-section="extraction"]').click();

      const extract = expectRequest('POST', extractionPath);
      await extractButton.click();
      assertWidgetExtractionRequest(await extract.received, compiled);
      await status('running').filter({ hasText: `Извлекаем данные: ${widgetBlock.name}` }).waitFor();
      await assertVisible(status('running'), viewport);
      assert.equal(await extractButton.isDisabled(), true, 'in-flight extraction cannot be repeated');
      const extractBox = await extractButton.boundingBox();
      assert.ok(extractBox);
      await page.mouse.click(extractBox.x + extractBox.width / 2, extractBox.y + extractBox.height / 2);
      assert.equal(await page.getByText(/Изменения готовы/).count(), 0, 'running status replaces the old Apply notice');
      assert.equal(await table.count(), 0);
      await assertVisible(unsaved, viewport);
      extract.respond(widgetExtractionResult(widgetRows));
      await status('rows').filter({ hasText: 'получено строк: 2' }).waitFor();
      await assertVisible(status('rows'), viewport);
      assert.equal(await extractButton.isDisabled(), false);
      assert.equal(await table.locator('tbody tr').count(), 2);
      for (const [index, card] of widgetRows.entries()) {
        const row = table.locator('tbody tr').nth(index);
        await assertVisible(row, viewport);
        assert.deepEqual(await row.getByRole('cell').allTextContents(), [String(card._id), card.Code, card.Description]);
      }

      let extractionCount = 1;
      if (viewport.width === 1280) {
        const technical = editor.locator('[data-ui-error-diagnostics]');
        await technical.locator('summary').click();
        const report = technical.locator('[data-ui-diagnostic-report]');
        await assertVisible(report, viewport);
        const captured = JSON.parse(await report.innerText());
        assert.equal(captured.assistantTrace.mode, 'Basic');
        assert.equal(captured.diagnostics.className, 'Widget');
        assert.equal(captured.diagnostics.filterCount, 1, 'trace counts the compiled match-all rule');
        assert.equal(captured.diagnostics.steps[0].rows, 2);
        assert.equal(captured.diagnostics.steps[0].restCalls, 1);
        assert.equal(captured.diagnostics.steps[0].elapsedMs, 17);
        assert.doesNotMatch(await report.innerText(), /W-001|W-002|Первый виджет|Второй виджет/);

        const missing = widgetExtractionResult([]);
        missing.result.tables = [{ name: 'unselected', columns: ['Description'], rows: [{ Description: 'Wrong source' }] }];
        const limit = { source: 'template-execution', limitHit: true, limitName: 'maxRows', configuredLimit: 1,
          returned: 1, truncated: true, reason: 'selection-row-limit' };
        for (const [state, expectedText, response, httpStatus, rowCount] of [
          ['empty', 'получено строк: 0', widgetExtractionResult([]), 200, 0],
          ['missing-result', 'Ответ не содержит выбранный результат', missing, 200, 0],
          ['limited', 'Результат ограничен.', widgetExtractionResult(widgetRows.slice(0, 1), [limit]), 200, 1],
          ['error', 'Не удалось извлечь данные', { success: false, code: 'fixture_extraction_failed', message: 'Нет доступа к Widget.' }, 422, 0]
        ]) {
          const next = expectRequest('POST', extractionPath);
          await extractButton.click();
          assertWidgetExtractionRequest(await next.received, compiled);
          extractionCount++;
          await status('running').waitFor();
          assert.equal(await table.count(), 0, 'a new run clears stale rows before the response');
          next.respond(response, httpStatus);
          await status(state).filter({ hasText: expectedText }).waitFor();
          await assertVisible(status(state), viewport);
          assert.equal(await extractButton.isDisabled(), false);
          assert.equal(await table.locator('tbody tr').filter({ hasText: /W-00[12]/ }).count(), rowCount);
          assert.equal(await editor.getByText('Wrong source', { exact: true }).count(), 0, 'never show a fallback table for a missing source');
          assert.equal(await page.getByText(/Изменения готовы/).count(), 0);
          if (state === 'limited') {
            await technical.locator('summary').click();
            assert.deepEqual(JSON.parse(await report.innerText()).diagnostics.limits, [limit]);
          }
        }
      }
      assert.deepEqual(writes.map((call) => [call.method, call.path]), [
        ['POST', semanticPath], ['POST', semanticPath], ['POST', flowPath], ['POST', applyPath],
        ...Array.from({ length: extractionCount }, () => ['POST', extractionPath])
      ], 'no persistence, implicit extraction, duplicate extraction or extra Assistant calls');
    });
  });
}

test('Extraction explains why it cannot run with no executable source', async () => {
  const viewport = { width: 1280, height: 900 };
  await withClient(viewport, async ({ page, writes }) => {
    await openWidgetTemplate(page, 'extraction');
    const reason = page.locator('[data-extraction-status][data-extraction-state="no-source"]')
      .filter({ hasText: 'Нет выбранного исполняемого результата.' });
    await reason.waitFor();
    await assertVisible(reason, viewport);
    assert.equal(await page.locator('[data-action="extract-template"]').isDisabled(), true);
    assert.deepEqual(writes, []);
  });
});

test('Apply keeps a still-executable non-default Extraction source but clears old rows', async () => {
  const viewport = { width: 1280, height: 900 };
  await withClient(viewport, async ({ page, expectRequest }) => {
    await openWidgetTemplate(page, 'extraction', draftWithBothSources(), combinedWidgetFlow);
    const source = page.locator('#cmdp-extraction-source');
    assert.equal(await source.inputValue(), 'archive');
    await source.selectOption('widgets');
    const extract = expectRequest('POST', extractionPath);
    await page.locator('[data-action="extract-template"]').click();
    assert.equal((await extract.received).query.get('extractionSource'), 'widgets');
    extract.respond(widgetExtractionResult(widgetRows));
    await page.getByRole('cell', { name: 'W-001' }).waitFor();
    await page.locator('[data-designer-section="assistant"]').click();
    const apply = expectRequest('POST', applyPath);
    await page.locator('[data-action="assistant-flow-apply"]').click();
    const applied = await apply.received;
    await page.locator('[data-designer-section="extraction"]').click();
    assert.equal(await page.getByRole('cell', { name: 'W-001' }).count(), 0);
    apply.respond({ success: true, spec: compileAppliedFlow(applied) });
    const status = page.locator('[data-extraction-state="not-started"]');
    await status.waitFor();
    await assertVisible(status, viewport);
    assert.equal(await source.inputValue(), 'widgets');
    assert.equal(await page.getByRole('cell', { name: 'W-001' }).count(), 0);
  });
});

test('Apply error stays visible after navigating to Extraction and does not replace the draft', async () => {
  const viewport = { width: 1280, height: 900 };
  await withClient(viewport, async ({ page, expectRequest, writes }) => {
    const saved = draftWithArchive();
    await openWidgetTemplate(page, 'assistant', saved, widgetFlow);
    const apply = expectRequest('POST', applyPath);
    const applyButton = page.locator('[data-action="assistant-flow-apply"]');
    await applyButton.click();
    await apply.received;
    await page.locator('[data-designer-section="extraction"]').click();
    apply.respond({ success: false, code: 'object_flow_invalid', message: 'Поток данных не прошёл проверку.' }, 422);
    const error = page.locator('[data-authoring-operation-message]').filter({ hasText: 'Поток данных не прошёл проверку.' });
    await error.waitFor();
    await assertVisible(error, viewport);
    await page.locator('[data-ui-error-diagnostics] summary').click();
    assert.equal(JSON.parse(await page.locator('[data-ui-diagnostic-report]').innerText()).code, 'object_flow_invalid');
    assert.equal(await page.locator('#cmdp-extraction-source').inputValue(), 'archive');
    assert.equal(await page.locator('[data-action="extract-template"]').isEnabled(), true);
    assert.equal(await page.locator('[data-authoring-unsaved]').count(), 0);
    await page.locator('[data-designer-section="assistant"]').click();
    await assertVisible(error, viewport);
    assert.equal(await applyButton.isEnabled(), true);
    assert.deepEqual(writes.map((call) => call.path), [applyPath]);
  });
});

test('Extraction source A → B drops shown rows and ignores the late A response', async () => {
  const viewport = { width: 1280, height: 900 };
  await withClient(viewport, async ({ page, expectRequest, writes }) => {
    await openWidgetTemplate(page, 'extraction', draftWithBothSources());
    const source = page.locator('#cmdp-extraction-source');
    const extract = page.locator('[data-action="extract-template"]');
    const table = page.locator('#cmdp-extraction-editor table');
    async function start(alias) {
      const request = expectRequest('POST', extractionPath);
      await extract.click();
      assert.equal((await request.received).query.get('extractionSource'), alias);
      return request;
    }
    const first = await start('archive');
    const bothTables = widgetExtractionResult([{ Code: 'Wrong B from A' }]);
    bothTables.result.tables.unshift({ name: 'archive', columns: ['Code', 'Description'], rows: [{ Code: 'Only A', Description: 'Архивная карточка Widget' }] });
    first.respond(bothTables);
    const aRow = table.getByRole('row').filter({ hasText: 'Only A' });
    await aRow.waitFor();
    await assertVisible(aRow, viewport);

    await source.selectOption('widgets');
    await page.locator('[data-extraction-state="not-started"]').waitFor();
    assert.equal(await table.count(), 0, 'B never renders the B table piggybacked on completed A');
    await source.selectOption('archive');
    assert.equal(await table.count(), 0, 'returning to A does not restore discarded rows');
    const lateA = await start('archive');
    assert.equal(await source.isEnabled(), true);
    await source.selectOption('widgets');
    assert.equal(await extract.isEnabled(), true);
    const currentB = await start('widgets');
    const ack = page.waitForResponse((response) => new URL(response.url()).pathname === extractionPath);
    lateA.respond(bothTables);
    await (await ack).finished();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-extraction-state="running"]').count(), 1, 'stale A must not clear the B operation');
    assert.equal(await table.count(), 0);
    currentB.respond(widgetExtractionResult(widgetRows));
    const bRow = table.getByRole('row').filter({ hasText: 'W-001' });
    await bRow.waitFor();
    await assertVisible(bRow, viewport);
    assert.equal(await table.getByText('Wrong B from A').count(), 0);
    assert.deepEqual(writes.map((call) => call.query.get('extractionSource')), ['archive', 'archive', 'widgets']);
  });
});

for (const change of ['root', 'session', 'editor', 'template', 'base revision', 'input revision', 'spec', 'action', 'generation', 'proposal', 'intent', 'bindings']) {
  test(`Apply ignores stale ${change} ownership after section navigation`, async () => {
    const viewport = { width: 1280, height: 900 };
    await withClient(viewport, async ({ page, expectRequest }) => {
      const saved = draftWithArchive();
      await openWidgetTemplate(page, 'assistant', saved, widgetFlow);
      const apply = expectRequest('POST', applyPath);
      await page.locator('[data-action="assistant-flow-apply"]').click();
      const sent = await apply.received;
      await page.locator('[data-designer-section="extraction"]').click();
      await page.locator('[data-extraction-state="apply-pending"]').waitFor();
      await page.evaluate((change) => {
        const { state, renderDesigner } = window.remediation;
        if (change === 'root') { const root = state.root; state.root = 'Other_QueryTool'; state.root = root; }
        if (change === 'session') state.session = { ...state.session };
        if (change === 'editor') state.templateEditorInstance++;
        if (change === 'template') state.selectedTemplate.id++;
        if (change === 'base revision') state.selectedTemplate.specHash = 'new-saved-hash';
        if (change === 'input revision') state.uiDiagnosticRevision++;
        if (change === 'spec') state.selectedTemplate.spec.steps[0].limit = 35;
        if (change === 'action') state.uiDiagnosticAction = 'save-template';
        if (change === 'generation') state.uiDiagnosticGeneration++;
        if (change === 'proposal') state.assistantFlowProposal.publishedAlias = 'another';
        if (change === 'intent') state.assistantObjectFlowIntent.context = 'Different intent';
        if (change === 'bindings') state.assistantFlowOutputBindings[0].alias = 'another';
        state.message = { type: 'ok', text: 'Текущее состояние редактора' };
        renderDesigner();
      }, change);
      assert.equal(await page.locator('[data-action="extract-template"]').isEnabled(), true, 'stale Apply must not block current draft');
      apply.respond({ success: true, spec: compileAppliedFlow(sent) });
      await page.waitForFunction(() => window.remediation.state.assistantFlowApplyOperation === null);
      const source = page.locator('#cmdp-extraction-source');
      assert.equal(await source.inputValue(), 'archive');
      assert.equal(await page.locator('[data-authoring-unsaved]').count(), 0);
      await assertVisible(page.getByText('Текущее состояние редактора', { exact: true }), viewport);
      assert.deepEqual(await page.evaluate(() => window.remediation.state.selectedTemplate.spec.steps),
        change === 'spec' ? [{ ...saved.steps[0], limit: 35 }] : saved.steps);
    });
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const language of ['ru', 'en']) {
    test(`invalid JSON permits only manual checkpoint retry in ${language} at ${viewport.width}px`, async () => {
      await withClient(viewport, async ({ page, expectRequest, writes }) => {
        await openSemanticPlan(page, language);
        const context = expectRequest('POST', semanticPath);
        await page.locator('[data-action="assistant-flow-prepare"]').click();
        const initial = await context.received;
        const checkpoint = { resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString() };
        const plan = expectRequest('POST', semanticPath);
        context.respond({ success: true, checkpoint });
        assert.equal((await plan.received).body.stage, 'plan');
        plan.respond({ success: false, code: 'assistant_invalid_json', retryable: true, resume: checkpoint }, 502);
        const retry = page.locator('[data-action="assistant-flow-prepare-retry"]');
        await retry.waitFor();
        await assertVisible(retry, viewport);
        const rejected = page.locator('[data-assistant-flow-rejected]');
        await assertVisible(rejected, viewport);
        assert.match(await rejected.innerText(), language === 'ru' ? /Модель вернула текст вместо JSON-плана; результат не применен/ : /model returned text instead of a JSON plan; not applied/);
        assert.equal(await page.locator('[data-action="assistant-flow-apply"]').isDisabled(), true);
        await page.waitForTimeout(100);
        assert.equal(writes.filter((call) => call.path === semanticPath).length, 2, 'no automatic retry');
        const manual = expectRequest('POST', semanticPath);
        await retry.click();
        const resumed = await manual.received;
        assert.equal(resumed.body.stage, 'plan');
        assert.equal(resumed.body.resumeId, initial.body.resumeId);
        assert.equal(resumed.root, initial.root);
        manual.respond({ success: false, code: 'assistant_invalid_json', retryable: false, resume: checkpoint }, 502);
        await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
        assert.equal(await retry.count(), 0, 'server denial wins even with saved checkpoint');
        assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowResume), null);
        assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowSemanticPlan), null);
        await page.screenshot({ path: `/tmp/assistant-retry-${language}-${viewport.width}.png`, fullPage: true });
      });
    });
  }
}

for (const mode of ['missing', 'wrong-id', 'expired', 'wrong-stage', 'string-true', 'no-flag', 'auth', 'network']) {
  test(`semantic retry rejects ${mode} server contract`, async () => {
    await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest, writes }) => {
      await openSemanticPlan(page);
      const pending = expectRequest('POST', semanticPath);
      await page.locator('[data-action="assistant-flow-prepare"]').click();
      const initial = await pending.received;
      const resume = { resumeId: mode === 'wrong-id' ? 'other' : initial.body.resumeId,
        stage: mode === 'wrong-stage' ? 'completed' : 'mcpContextReady',
        expiresAt: new Date(Date.now() + (mode === 'expired' ? -60000 : 60000)).toISOString() };
      if (mode === 'network') pending.fail();
      else pending.respond({ success: false, code: mode === 'auth' ? 'permission_denied' : 'assistant_invalid_json',
        ...(mode === 'no-flag' ? {} : { retryable: mode === 'string-true' ? 'true' : mode !== 'auth' }),
        resume: mode === 'missing' ? null : resume }, mode === 'auth' ? 403 : 502);
      await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
      assert.equal(await page.locator('[data-action="assistant-flow-prepare-retry"]').count(), 0);
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowResume), null);
      assert.equal(writes.filter((call) => call.path === semanticPath).length, 1);
    });
  });
}

for (const language of ['ru', 'en']) {
  for (const [code, retryable, summary] of [
    ['assistant_empty_response', true, { ru: 'Модель вернула пустой ответ; результат не применен.', en: 'The model returned an empty response; not applied.' }],
    ['assistant_output_truncated', false, { ru: 'Ответ модели обрезан; результат не применен.', en: 'The model response was truncated; not applied.' }],
    ['assistant_response_format_unsupported', false, { ru: 'Провайдер не поддерживает выбранный формат ответа; результат не применен.', en: 'The provider does not support the selected response format; not applied.' }]
  ]) {
    test(`${code} localized in ${language}, retryable=${retryable}`, async () => {
      await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest }) => {
        await openSemanticPlan(page, language);
        const pending = expectRequest('POST', semanticPath);
        await page.locator('[data-action="assistant-flow-prepare"]').click();
        const initial = await pending.received;
        pending.respond({ success: false, code, retryable, resume: {
          resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString()
        } }, 502);
        await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
        const rejected = page.locator('[data-assistant-flow-rejected]');
        await assertVisible(rejected, { width: 1280 });
        assert.ok((await rejected.innerText()).includes(summary[language]));
        if (code === 'assistant_response_format_unsupported') assert.match(await rejected.innerText(), /assistant\.llm\.responseFormat/);
        if (code === 'assistant_output_truncated') {
          assert.match(await rejected.innerText(), /assistant\.llm\.maxTokens/);
          assert.match(await rejected.innerText(), language === 'ru' ? /автоматически не увеличиваются/ : /not increased automatically/);
        }
        assert.equal(await page.locator('[data-action="assistant-flow-prepare-retry"]').count(), Number(retryable));
        assert.match(await rejected.locator('h4').innerText(), retryable
          ? language === 'ru' ? /приостановлен/ : /paused/
          : language === 'ru' ? /отклонен/ : /rejected/);
      });
    });
  }
}

for (const ownership of ['generation', 'root', 'session']) {
  test(`semantic response cannot replace ${ownership} ownership`, async () => {
    await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest }) => {
      await openSemanticPlan(page);
      const pending = expectRequest('POST', semanticPath);
      await page.locator('[data-action="assistant-flow-prepare"]').click();
      const initial = await pending.received;
      await page.evaluate((ownership) => {
        const state = window.remediation.state;
        if (ownership === 'generation') state.assistantFlowRequestGeneration++;
        if (ownership === 'root') { const root = state.root; state.root = 'Other_QueryTool'; state.root = root; }
        if (ownership === 'session') state.sessionInstance++;
        state.assistantFlowResume = null;
        state.assistantFlowBusy = true;
        state.assistantFlowFeedback = { summary: 'Current owner feedback' };
      }, ownership);
      const ack = page.waitForResponse((response) => new URL(response.url()).pathname === semanticPath);
      pending.respond({ success: false, code: 'assistant_invalid_json', retryable: true,
        resume: { resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString() } }, 502);
      await ack;
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowFeedback.summary), 'Current owner feedback');
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowResume), null);
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowBusy), true, 'stale finally preserves current owner busy state');
    });
  });
}

test('semantic request cleanup releases its own busy state after edits or navigation without replacing newer diagnostics', async () => {
  for (const change of ['prompt', 'section']) {
    await withClient({ width: 1280, height: 900 }, async ({ page, expectRequest }) => {
      await openSemanticPlan(page, 'en');
      await page.locator('.assistant-template-system-prompts summary').click();
      await page.locator('[data-action="assistant-template-prompt-override"][data-template-assistant-prompt-key="objectFlowSemantic"]').click();
      const pending = expectRequest('POST', semanticPath);
      await page.locator('[data-action="assistant-flow-prepare"]').click();
      const initial = await pending.received;
      if (change === 'prompt') {
        await page.locator('.assistant-template-system-prompts summary').click();
        const prompt = page.locator('#cmdp-template-assistant-system-prompt-objectFlowSemantic');
        await assertVisible(prompt, { width: 1280 });
        await prompt.fill('New unsaved semantic prompt');
      } else {
        await page.locator('[data-designer-section="params"]').click();
      }
      await page.evaluate(() => { window.remediation.state.message = { type: 'warning', text: 'Newer local status' }; });
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === semanticPath);
      pending.respond({ success: false, code: 'assistant_invalid_json', retryable: true, resume: {
        resumeId: initial.body.resumeId, stage: 'mcpContextReady', expiresAt: new Date(Date.now() + 60000).toISOString()
      } }, 502);
      await response;
      await page.waitForFunction(() => !window.remediation.state.assistantFlowBusy);
      assert.equal(await page.evaluate(() => window.remediation.state.message.text), 'Newer local status');
      assert.equal(await page.evaluate(() => window.remediation.state.assistantFlowSemanticPlan), null);
      if (change === 'section') await page.locator('[data-designer-section="assistant"]').click();
      assert.equal(await page.locator('[data-action="assistant-flow-prepare"]').isDisabled(), false);
      if (change === 'prompt') {
        await page.locator('.assistant-template-system-prompts summary').click();
        assert.equal(await page.locator('#cmdp-template-assistant-system-prompt-objectFlowSemantic').inputValue(), 'New unsaved semantic prompt');
      }
    });
  }
});

test('full client transfer preserves staged Save/export artifacts, defaults and pending D2 checkpoints outside Diagram', async () => {
  const versions = clientVersionConstants(fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8'));
  for (const mode of ['new', 'replace']) {
    await withClient({ width: 1280, height: 1000 }, async ({ page, expectRequest, writes }) => {
      await page.locator('#cmdp-language').selectOption('en');
      const checkpoint = { version: versions.D2_IMPORT_ANALYSIS_CHECKPOINT_VERSION, proposalId: 'pending-proposal',
        deterministicSpecHash: 'pending-spec', source: { hash: 'pending-source', structureHash: 'structure', mappingContractHash: 'mapping' },
        roles: [{ id: 'role-container', visualKind: 'container', labelTemplate: 'Pending proposal label' }],
        relationRules: [], structureTree: { version: versions.D2_IMPORT_STRUCTURE_TREE_VERSION, items: [] } };
      const imported = {
        code: mode === 'replace' ? 'existing' : 'imported', description: 'Imported definition', active: true,
        paramsSchema: { type: 'object', properties: { card: { type: 'integer' } } }, resultSchema: { type: 'object', additionalProperties: true },
        spec: { version: 1, defaults: { card: 84 }, paramDefaults: { fallback: 22 },
          params: { card: { type: 'integer', default: 41, example: 99 }, fallback: { type: 'integer', defaultValue: 11 }, exampleOnly: { type: 'string', example: 'example fallback' } },
          steps: [{ type: 'selectCards', as: 'assets', className: 'Asset', limit: 20, filters: [] }],
          objectFlow: { version: 1, selections: [{ id: 'asset-selection', alias: 'assets', className: 'Asset', rules: [] }], operations: [] },
          cache: { enabled: true, ttlSec: 456 }, publish: { mode: 'dynamicUser', paramsMode: 'exact' },
          result: { tables: [{ name: 'assets', title: 'Preserved table' }], diagrams: [
            { id: 'topology', name: 'topology', title: 'Saved diagram', type: 'topology', authoring: { d2Import: {
              version: 3, semanticModelRevision: versions.D2_IMPORT_SEMANTIC_MODEL_REVISION,
              endpointProfileVersion: versions.D2_IMPORT_ENDPOINT_PROFILE_VERSION,
              diagramId: 'topology', source: 'group: { class: container }', sourceHash: 'applied-source', structureHash: 'structure', mappingContractHash: 'mapping',
              structure: { nodes: [], groups: [{ key: 'group', classKeys: ['container'] }], edges: [] }, classes: [{ key: 'container' }],
              roles: [{ id: 'role-container', kind: 'class', key: 'container', visualKind: 'container', visualKindOptions: ['container'], labelTemplate: 'Saved label' }],
              structureTree: { version: versions.D2_IMPORT_STRUCTURE_TREE_VERSION, items: [{ id: 'group', roleId: 'role-container', d2Key: 'group', parentId: '', mapping: { materialization: { kind: 'structural' }, primary: { labelTemplate: 'Saved label' } } }] },
              relationRules: [], endpointProfiles: [], mappingValidation: { version: 1, status: 'needsValidation' }
            } } },
            { id: 'second', name: 'second', type: 'topology', title: 'Do not replace this diagram', nodes: [] }
          ] },
          authoring: { version: 1, assistant: { promptContractVersion: versions.ASSISTANT_PROMPT_CONTRACT_VERSION,
            objectFlowIntent: { context: 'Imported context', blocks: [{ id: 'assets', name: 'Assets', description: 'Asset cards', resultKind: 'sourceCards', uses: [] }] },
            diagramIntentPrompt: 'Imported diagram prompt', systemPromptOverrides: { objectFlow: 'Imported flow policy' } },
            d2: { source: 'group: { class: container }', analysisCheckpoint: checkpoint, assistantCheckpoint: null } }
        }
      };
      await page.evaluate(() => {
        const ui = window.remediation;
        ui.state.selectedTemplate = { id: 7, code: 'existing', description: 'Existing definition', active: true, specHash: 'original-hash', owner: 'local-owner', spec: ui.defaultSpec(), paramsSchema: {}, resultSchema: {} };
        ui.state.templates = [structuredClone(ui.state.selectedTemplate)];
        ui.hydrateDesignerStateFromTemplate({ replaceRunParams: true });
        ui.state.designerSection = 'template'; ui.renderDesigner();
      });
      const prepare = expectRequest('POST', '/cmdbuild/custom-api/template-transfer/prepare');
      await page.locator('#cmdp-transfer-file').setInputFiles({ name: 'current.cmdp-template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ template: imported })) });
      if (mode === 'replace') await page.locator('#cmdp-transfer-mode').selectOption('replace');
      await page.locator('[data-action="template-transfer-prepare"]').click();
      await prepare.received;
      const replacement = { targetId: 7, revision: 'sha256:' + 'a'.repeat(64) };
      prepare.respond({ success: true,
        template: mode === 'replace' ? { ...imported, id: 7, specHash: 'original-hash' } : imported,
        changes: { mode, ...(mode === 'replace' ? { targetId: replacement.targetId, targetRevision: replacement.revision } : {}) },
        checks: { status: 'needsAttention', issues: [], environmentReferences: [], executionReady: false } });
      await page.locator('[data-action="template-transfer-stage"]:enabled').waitFor();
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('[data-action="template-transfer-stage"]').click();
      const staged = await page.evaluate(() => structuredClone(window.remediation.state.selectedTemplate));
      assert.deepEqual(staged.spec, imported.spec);
      assert.deepEqual(staged.paramsSchema, imported.paramsSchema);
      assert.deepEqual(staged.resultSchema, imported.resultSchema);
      assert.deepEqual(await page.evaluate(() => window.remediation.state.runParams), { card: 84, fallback: 22, exampleOnly: 'example fallback' });
      assert.equal(await page.evaluate(() => window.remediation.getRunParamsFromSpec(window.remediation.state.selectedTemplate.spec, { card: 105 }).card), 105);
      const expectedPayload = { code: imported.code, description: imported.description, active: mode === 'replace', spec: imported.spec,
        paramsSchema: imported.paramsSchema, resultSchema: imported.resultSchema, ...(mode === 'replace' ? { expectedSpecHash: 'original-hash' } : {}) };
      const exported = expectRequest('POST', '/cmdbuild/custom-api/template-transfer/export');
      await page.locator('[data-action="template-transfer-export"]').click();
      const exportCall = await exported.received;
      assert.deepEqual(exportCall.body.template, expectedPayload, 'entire staged artifact reaches export');
      exported.respond({ success: false, message: 'Mock download not needed' }, 400);
      await page.waitForFunction(() => window.remediation.state.templateTransfer.message === 'Mock download not needed');

      await page.locator('[data-designer-section="diagram"]').click();
      await page.locator('[data-action="diagram-structure-select"][data-diagram-structure-item-id="group"]').click();
      const label = page.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
      await assertVisible(label, { width: 1280 });
      await label.fill('Unsaved current label');
      await page.locator('[data-designer-section="templates"]').click();
      await page.evaluate(({ checkpoint, source }) => {
        window.remediation.state.diagramImportProposal = {
          ...structuredClone(checkpoint), version: 3, sourceText: source,
          template: {}, structure: { nodes: [], groups: [], edges: [] }, classes: [], endpointProfiles: []
        };
      }, { checkpoint, source: imported.spec.authoring.d2.source });
      const dirtyExport = expectRequest('POST', '/cmdbuild/custom-api/template-transfer/export');
      await page.locator('[data-action="template-transfer-export"]').click();
      const dirtyCall = await dirtyExport.received;
      const dirtySpec = dirtyCall.body.template.spec;
      assert.equal(dirtySpec.result.diagrams[0].authoring.d2Import.structureTree.items[0].mapping.primary.labelTemplate, 'Unsaved current label');
      assert.deepEqual(dirtySpec.result.diagrams[1], imported.spec.result.diagrams[1]);
      assert.deepEqual(dirtySpec.authoring.d2.analysisCheckpoint, checkpoint, 'pending checkpoint is preserved, never promoted to result.diagrams');
      for (const key of ['params', 'defaults', 'paramDefaults', 'steps', 'objectFlow', 'cache', 'publish']) assert.deepEqual(dirtySpec[key], imported.spec[key], key);
      assert.deepEqual(dirtySpec.authoring.assistant, imported.spec.authoring.assistant);
      dirtyExport.respond({ success: false, message: 'Mock download complete' }, 400);
      await page.waitForFunction(() => window.remediation.state.templateTransfer.message === 'Mock download complete');
      const savePath = '/cmdbuild/custom-api/templates' + (mode === 'replace' ? '/existing' : '');
      const save = expectRequest(mode === 'replace' ? 'PUT' : 'POST', savePath);
      await page.locator('[data-action="save-template"]').click();
      const saved = await save.received;
      if (mode === 'replace') {
        const { active, expectedSpecHash, ...portableFields } = dirtyCall.body.template;
        assert.deepEqual(saved.body, { ...portableFields, transferReplace: replacement }, 'Replace saves the same artifact without overwriting target activity');
        save.respond({ success: false, code: 'template_transfer_incomplete', issues: [
          { path: '$.spec.result.diagrams[0]', code: 'template_transfer_execution_incomplete', severity: 'error', message: 'Invalid mapping' }
        ] }, 422);
      } else {
        assert.deepEqual(saved.body, dirtyCall.body.template, 'Save and export use the same entire current artifact');
        save.respond({ success: true, template: { ...saved.body, id: 7, specHash: 'saved-hash' }, executionValidation: { executable: false } });
      }
      await page.waitForFunction(() => !window.remediation.state.savingTemplate);
      if (mode === 'replace') {
        const rejected = await page.evaluate(() => window.remediation.state);
        assert.equal(rejected.templateDirty, true);
        assert.deepEqual(rejected.stagedTemplateTransfer.replacement, replacement);
        assert.equal(rejected.selectedTemplate.specHash, 'original-hash');
        assert.equal(rejected.selectedTemplate.spec.result.diagrams[0].authoring.d2Import.structureTree.items[0].mapping.primary.labelTemplate,
          'Unsaved current label');
      }
      assert.equal(writes.filter((call) => call.path.startsWith('/cmdbuild/custom-api/templates')).length, 1, 'only explicit Save persists');
    });
  }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`embedded client raw settings and trace filters survive rerender at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      await page.locator('#cmdp-assistant-llm-max-tokens').fill('not-a-number');
      await page.locator('#cmdp-assistant-system-prompt').fill('unsaved prompt\nsecond line');
      await page.locator('#cmdp-assistant-llm-model').fill('unsaved-model');
      await page.locator('#cmdp-assistant-llm-response-format').selectOption('prompt');
      await page.locator('#cmdp-assistant-mcp-enabled').check();
      await page.locator('#cmdp-language').selectOption('en');
      await page.locator('[data-designer-section="about"]').click();
      assert.equal(await page.locator('#cmdp-assistant-llm-model').count(), 0);
      await page.locator('[data-designer-section="settings"]').click();
      assert.equal(await page.locator('#cmdp-assistant-llm-max-tokens').inputValue(), 'not-a-number');
      assert.equal(await page.locator('#cmdp-assistant-system-prompt').inputValue(), 'unsaved prompt\nsecond line');
      assert.equal(await page.locator('#cmdp-assistant-llm-model').inputValue(), 'unsaved-model');
      assert.equal(await page.locator('#cmdp-assistant-llm-response-format').inputValue(), 'prompt');
      await page.locator('#cmdp-assistant-llm-max-tokens').fill('16384');
      assert.equal(await page.evaluate(() => window.remediation.captureRuntimeSettings('Cst_QueryTool').runtimeConfig.assistant.llm.responseFormat), 'prompt');
      await page.locator('#cmdp-assistant-llm-max-tokens').fill('not-a-number');
      assert.equal(await page.locator('#cmdp-assistant-mcp-enabled').isChecked(), true);
      await assertVisible(page.locator('#cmdp-assistant-llm-model'), viewport);
      assert.equal(await page.evaluate(() => { try { window.remediation.captureRuntimeSettings('Cst_QueryTool'); return false; } catch { return true; } }), true);
      assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /unsaved-model|unsaved prompt|not-a-number/);
      const status = expectRequest('GET', '/cmdbuild/custom-api/assistant/diagnostics/status');
      await page.evaluate(() => { void window.remediation.assistantDiagnosticsUi.refresh(); });
      await status.received;
      const filter = page.locator('#cmdp-assistant-debug-request');
      await filter.fill('unsent filter');
      await page.locator('#cmdp-assistant-debug-template').fill('unsent-template');
      await filter.focus();
      await filter.evaluate((input) => input.setSelectionRange(3, 6));
      status.respond({ success: true, status: { mode: 'Basic' } });
      await page.waitForFunction(() => document.getElementById('cmdp-assistant-debug-mode').value === 'Basic');
      assert.equal(await filter.inputValue(), 'unsent filter');
      assert.equal(await page.locator('#cmdp-assistant-debug-template').inputValue(), 'unsent-template');
      assert.equal(await filter.evaluate((input) => document.activeElement === input), true);
      assert.deepEqual(await filter.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 6]);
      await assertVisible(filter, viewport);
      assert.deepEqual(writes, [], 'settings and trace filtering must not persist anything');
      await page.screenshot({ path: `/tmp/assistant-remediation-${viewport.width}.png`, fullPage: true });
    });
  });

  test(`Save POST ACK retains new edits and next PUT identity at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      await page.evaluate(() => {
        const ui = window.remediation;
        ui.state.selectedTemplate = { code: '', description: '', active: true, spec: {}, paramsSchema: {}, resultSchema: {} };
        ui.state.designerSection = 'template';
        ui.renderDesigner();
      });
      await page.locator('#cmdp-code').fill('remediation');
      await page.locator('#cmdp-description').fill('initial description');
      const post = expectRequest('POST', '/cmdbuild/custom-api/templates');
      await page.locator('[data-action="save-template"]').click();
      const created = await post.received;
      assert.equal(created.body.description, 'initial description');
      await page.locator('#cmdp-description').fill('new unsaved description');
      post.respond({ success: true, template: { ...created.body, id: 42, version: 1, specHash: 'hash-1' }, executionValidation: { executable: true } });
      await page.waitForFunction(() => window.remediation.state.selectedTemplate?.id === 42 && !window.remediation.state.savingTemplate);
      assert.equal(await page.locator('#cmdp-description').inputValue(), 'new unsaved description');
      assert.equal(await page.evaluate(() => window.remediation.state.templateDirty), true);
      assert.match(await page.locator('#app').innerText(), /Сохранена предыдущая редакция; есть несохранённые изменения|The previous revision was saved; there are unsaved changes/);
      assert.equal(await page.locator('#cmdp-code').evaluate((input) => input.readOnly), true);
      await assertVisible(page.locator('#cmdp-description'), viewport);
      const put = expectRequest('PUT', '/cmdbuild/custom-api/templates/remediation');
      await page.locator('[data-action="save-template"]').click();
      const updated = await put.received;
      assert.equal(updated.body.expectedSpecHash, 'hash-1');
      assert.equal(updated.body.description, 'new unsaved description');
      assert.equal(updated.root, created.root);
      put.respond({ success: true, template: { ...updated.body, id: 42, version: 2, specHash: 'hash-2' }, executionValidation: { executable: true } });
      await page.waitForFunction(() => window.remediation.state.selectedTemplate?.specHash === 'hash-2' && !window.remediation.state.savingTemplate);
      assert.equal(await page.evaluate(() => window.remediation.state.templateDirty), false);
      assert.deepEqual(writes.map((call) => call.method), ['POST', 'PUT']);
    });
  });

  test(`A-B-A invalidates pending capture before POST at ${viewport.width}px`, async () => {
    await withClient(viewport, async ({ page, expectRequest, writes }) => {
      const config = expectRequest('PUT', '/cmdbuild/custom-api/config');
      await page.locator('#cmdp-assistant-llm-model').fill('old-root-unsaved-model');
      await page.locator('#cmdp-assistant-debug-mode').selectOption('Basic');
      await page.locator('[data-action="assistant-debug-apply"]').click();
      const pending = await config.received;
      await page.evaluate(() => {
        const ui = window.remediation;
        const root = ui.state.root;
        ui.state.root = 'Other_QueryTool';
        ui.state.root = root;
        ui.renderDesigner();
      });
      const ack = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/cmdbuild/custom-api/config');
      config.respond({ success: true, config: { exists: true, runtimeConfig: pending.body.runtimeConfig }, effectiveAssistantDiagnostics: { captureDurationSec: 60 } });
      await ack;
      // Drain the original savePolicy -> current(token) continuation before checking negative effects.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      assert.equal(await page.locator('#cmdp-assistant-debug-mode').inputValue(), 'Off');
      assert.deepEqual(writes.map((call) => [call.method, call.path]), [['PUT', '/cmdbuild/custom-api/config']]);
      assert.notEqual(await page.locator('#cmdp-assistant-llm-model').inputValue(), 'old-root-unsaved-model');
      await assertVisible(page.locator('#cmdp-assistant-debug-request'), viewport);
    });
  });
}
