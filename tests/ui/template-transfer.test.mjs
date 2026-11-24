import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { buildLargeTableIndex, queryLargeTablePage } from '../../scripts/report-table-pages.mjs';
import { bindViewLargeExecutionHelpers } from '../fixtures/view-large-execution-helpers.mjs';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const names = [
  'templateTransferOwner', 'templateTransferOwnerIsCurrent', 'templateTransferDraft', 'renderTemplateTransfer',
  'refreshTemplateTransfer', 'templateTransferError', 'readTemplateTransferFile', 'prepareTemplateTransfer',
  'stageTemplateTransfer', 'exportTemplateTransfer', 'handleTemplateTransferChange', 'captureTemplateEditorSnapshot',
  'saveTemplate', 'saveTemplateSnapshot', 'readEditorPayload', 'runtimeSettingsScope', 'runtimeSettingsScopeIsCurrent',
  'readTemplateCode', 'readTemplateDescription', 'readTemplateActive', 'renderTemplateEditor', 'renderTemplateCopySelector',
  'stagedTemplateTransfer', 'templateVersionOwner', 'templateVersionOwnerIsCurrent', 'fetchVersions', 'loadVersion', 'renderVersions',
  'clearDraftExecutionState', 'selectedExtractionSource', 'renderActionButton', 'publishModelForSpec',
  'templateWriteKey', 'templateWritePending', 'templateTransferActionState', 'templateSaveBlockTitle', 'templatePublishBlockTitle',
  'syncImportedDiagramSaveGate', 'renderTemplateTransferIssues', 'renderTemplateTransferSaveIssues',
  'applyPublicationToSpec', 'publicationRefreshConsentMissing', 'handlePublicationRefreshChange',
  'renderPublicationEditor', 'applyPublicationEditor', 'publishSnapshot', 'validateUiResponse',
  'isSnapshotHash', 'isSnapshotResult', 'isPersistedSnapshotCache', 'validateSnapshotMutationResponse',
  'inferStoredViewLargeTable', 'inferViewComposerModel', 'normalizeViewComposerColumn', 'renderViewComposerMultiModeOptions',
  'viewLargeColumnOptions', 'viewLargeAttributeIsMultiple', 'viewLargeClassFieldOptions', 'viewLargeResultOptions',
  'viewLargeDeclaredColumns', 'viewLargeSourceFields', 'viewLargeSourceFieldOptions', 'viewLargeSimpleFieldOptions',
  'diagramImportUniqueStageCardSources',
  'viewLargeSimpleSelector', 'viewLargeSelectorMode', 'renderViewLargeChoiceOptions', 'renderFieldHelp',
  'renderViewLargeField', 'renderViewLargeSelect', 'renderViewLargePicker', 'renderViewLargeSelectorFields',
  'renderViewLargeFilter', 'renderViewLargeReductionFields', 'renderViewLargeReductions',
  'renderViewLargeTableDetails', 'renderViewLargeGroupPicker', 'renderViewLargeTable', 'renderViewComposerColumnRow', 'renderViewComposerEditor',
  'renderColumnSelectOptions', 'normalizeColumnOption', 'columnOptionLabel', 'uniqueList', 'renderCatalogFieldPicker',
  'catalogFieldPickerSelectedLabel', 'renderCatalogFieldPickerPrompt', 'renderCompactMultiSelect', 'compactMultiSelectSummary',
  'catalogFieldPickerOptions', 'catalogFieldPickerMatches', 'renderCatalogFieldPickerRows', 'selectCatalogFieldPickerField',
  'syncCompactMultiSelectOption', 'handleViewLargeTableChange', 'markViewLargeTableEdited', 'readViewLargeTableDraft',
  'readViewLargeSelectorDraft', 'captureViewLargeSelectorDrafts', 'rebindViewLargeTableSource',
  'captureViewComposerDraftFromDom', 'validateViewComposerDraft', 'buildViewComposerSpec', 'runDraftAction', 'readSpecWithEditorBlocks'
];
const functions = names.map((name) => {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}).join('\n');
const viewLargeExecutionHelpers = bindViewLargeExecutionHelpers(source)();
const translations = [...source.matchAll(/^      ((?:transfer|publication|viewComposer|viewLarge|multiSelect|fieldPicker|fieldRequired|fieldHelpAria)\w*): ('[^\n]*'),$/gm)].map((match) => [match[1], Function('return ' + match[2])()]);
const split = translations.findIndex(([key], index) => index > 0 && key === translations[0][0]);
const en = Object.fromEntries(translations.slice(0, split));
const ru = Object.fromEntries(translations.slice(split));
const styles = source.split('\n').find((line) => line.includes('#cmdp-template-transfer{'));
const publicationStyles = source.split('\n').find((line) => line.includes('#cmdp-publish-refresh-settings:not([hidden])'));
const largeTableStyles = source.split('\n').find((line) => line.includes('#cmdp-view-large-table{'));
const helpStyles = source.split('\n').filter((line) => line.includes('.field-help-button{') ||
  line.includes('.field-help[data-positioned-field-help]') || line.includes('#cmdp-view-large-table .field-label-row')).join('\n');
const actionLines = source.split('\n').filter((line) => line.includes("if (action === 'template-transfer-") ||
  ['save-template', 'load-version', 'apply-publication', 'publish-snapshot'].some((action) => line.includes("if (action === '" + action + "')")));
const viewSourceChange = source.match(/^    if \(target\.id === 'cmdp-view-source'\) \{\n[\s\S]*?^    }/m)?.[0];
assert.ok(viewSourceChange, 'Designer view-source change handler');
const helpStart = source.lastIndexOf("  document.addEventListener('focusin'", source.indexOf('  function positionFieldHelp('));
const helpEnd = source.indexOf("  document.addEventListener('pointerdown'", helpStart);
assert.ok(helpStart >= 0 && helpEnd > helpStart, 'Designer field help handlers');
const helpEvents = source.slice(helpStart, helpEnd);
const helpEscape = source.match(/^    if \(target .*matches\('\.field-help-button'\).*event.key === 'Escape'\) \{\n[\s\S]*?^    }/m)?.[0];
assert.ok(helpEscape, 'Designer field help Escape handler');

const harness = `
var apiPrefix = '/api';
var boot = { templateTransferMaxBytes: 131072, snapshotRefreshTimeoutMs: 70000 };
var CMDB_BUILD_VIEW_KIND = 'cmdb-build-view';
var state = { root: 'Root_A', session: 'session-A', sessionInstance: 1, templateEditorInstance: 1, templates: [], selectedTemplate: null, designerSection: 'template', templateVersions: [], uiDiagnosticRevision: 0,
  pendingTemplateWrites: new Map(), templatePublicationNotices: new Map(), get savingTemplate() { return templateWritePending(readTemplateCode()); } };
window.evidence = { requests: [], downloads: [], captures: [], errors: [] };
window.lang = 'en';
var translations = ${JSON.stringify({ en, ru })};
function t(key, params) { return (translations[window.lang][key] || key).replace(/\\{(\\w+)\\}/g, function(match, name) { return params && params[name] !== undefined ? params[name] : match; }); }
function designerSectionUrl(section) { return '/' + section; }
function extractionResultOptions(_spec, tables) { return tables.map(table => ({name:table.name})); }
function escapeHtml(value) { return String(value == null ? '' : value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function pretty(value) { return JSON.stringify(value, null, 2); }
function cloneJsonValue(value) { return JSON.parse(JSON.stringify(value)); }
function defaultSpec() { return {version:1}; }
function templateKindForSpec() { return 'dsl'; }
function readValue(id) { return document.getElementById(id)?.value || ''; }
function hasField(id) { return Boolean(document.getElementById(id)); }
function readChecked(id) { return document.getElementById(id).checked; }
function normalizeTemplateProtection(value) { return value; }
function applyTemplateKindFromEditor(value) { return value; }
function readCurrentParamsSchema() { return JSON.parse(readValue('cmdp-params-schema')); }
function readCurrentResultSchema() { return JSON.parse(readValue('cmdp-result-schema')); }
function readSpecWithParamEditor() { return { spec: state.selectedTemplate.spec, examples: {} }; }
function readExtractionStepFields() { return null; }
function readDataSelectionStepFields() { return null; }
function applyVisualizationToSpec(spec) { return spec; }
function applyCacheToSpec(spec) { return spec; }
function applyCmdbBuildViewToSpec(spec) { return spec; }
function applyAssistantDraftFromDomToSpec(spec) { return spec; }
function readCurrentSpec() { return state.selectedTemplate.spec; }
function firstResultTable(spec) { return spec.result?.tables?.[0] || {}; }
function finalResultTableForSpec(spec) { return firstResultTable(spec); }
function finalBaseResultAlias(spec) { return getStoredVisualModel(spec, 'viewComposer')?.source?.alias || firstResultTable(spec).name || ''; }
function resultTablesForSpec(spec) { return spec.result?.tables || []; }
function renderExtractionResultOptions(value, spec, tables) {
  return renderColumnSelectOptions([...new Set([value, ...(tables || []).map(table => table.name)])], value);
}
function renderVisualizationModeOptions() { return '<option value="table">Table</option>'; }
function tableColumnsForAlias(spec, alias) { return resultTablesForSpec(spec).find(table => table.name === alias)?.columns || []; }
function getStoredVisualModel(spec, kind) { return spec.visualModels?.find(item => item.mode === kind); }
function upsertStoredVisualModel(spec, data) { spec.visualModels = [data]; }
function cloneSpecForEdit(spec) { return structuredClone(spec); }
function diagramInitialColumnOptionRowsForSource(_spec, _source, selected) { return selected ? [{value:selected,label:selected}] : []; }
function diagramColumnOptionRowsForSource(spec, alias) {
  const step = spec.steps?.find(item => item.as === alias);
  const paths = alias === 'services' ? ['Owner.Description'] : [];
  return (step?.columns || ['_id', 'Description', 'HiddenParentId']).filter(value => typeof value === 'string')
    .concat(paths).map(value => ({value, label:value}));
}
function sourceClassForAlias(spec, alias) { return spec.steps?.find(step => step.as === alias)?.className || ''; }
function catalogAttributeOptions(className) {
  return [{name:'Code',description:'Code'},{name:'_id',description:'Identifier'},{name:'Description',description:'Description'}].concat({
    Item: [{name:'HiddenParentId',type:'integer'},{name:'ScopeIds',type:'lookupArray'}],
    Service: [{name:'ScopeIds',type:'lookupArray'}],
    RightCard: [{name:'TagSet',type:'lookupArray'},{name:'Region',type:'string'},{name:'Segment',type:'string'}]
  }[className] || []);
}
function catalogClassByName(name) { return { description: name }; }
function catalogClassOptionRows() { return [{name:'Parent',label:'Parent'}]; }
function closeCatalogFieldPickers() { document.querySelectorAll('[data-catalog-field-picker-menu]').forEach(menu => { menu.hidden = true; }); }
function getParamRows(spec) { return Object.keys(spec.params || {}).map(name => ({name})); }
function userFacingResultLabel(name) { return name; }
function assistantObjectFlowOutputManifest() { return {assistantManaged:false}; }
function authoringPreviewPath() { return '/api/draft/preview'; }
function routeUiRequestDiagnostic() {}
function renderRunParamsEditor() { return ''; }
function d2WorkflowStatusForEditor() { return {}; }
function readRunParams() { return {}; }
function exactReportLaunchQuery() { return {}; }
function refreshTemplateLaunchUrl() {}
function captureVisibleDesignerState() {
  evidence.captures.push('visible');
  state.selectedTemplate = Object.assign({}, state.selectedTemplate || {}, {code:readValue('cmdp-code'),description:readValue('cmdp-description')});
  state.selectedTemplate.spec = applyPublicationToSpec(JSON.parse(readValue('cmdp-spec')), false);
  return true;
}
function activeDiagramImportEditorModel() { return {version:3}; }
function captureDiagramImportProposalFromDom() { return {version:3, label:readValue('diagram-edit')}; }
function diagramImportSpecWithSavedEditor(spec, diagram) { evidence.captures.push('diagram'); return Object.assign({},spec,{result:{diagrams:[diagram]}}); }
function markImportedDiagramChanged() {}
function captureAssistantPromptsFromDom() { evidence.captures.push('prompts'); state.prompt=readValue('assistant-prompt'); }
function assistantSpecWithPrompts(spec) { return Object.assign({}, spec, {authoring:{assistant:{diagramIntentPrompt:state.prompt}}}); }
function updateSelectedFromEditor(spec) { state.selectedTemplate.spec=spec; }
function hydrateDesignerStateFromTemplate() { state.templateEditorInstance++; state.viewComposerDraft=null; state.prompt=state.selectedTemplate.spec.authoring?.assistant?.diagramIntentPrompt || ''; }
function uiRequestOwner() { return { revision:0 }; }
function uiDiagnosticIsCurrent() { return true; }
function runUiOperation(_action, callback) { return callback(); }
function runUiMutation(callback) { return callback(); }
function diagramImportExecutionValidationHasMappingBlocker() { return false; }
function createRequestError(result) { return new Error(result.json?.message || 'request failed'); }
function setUiError(error) { evidence.errors.push(error.message); }
function assistantTemplateRefClient() { return {root:state.root,templateCode:state.selectedTemplate.code,baseSpecHash:state.selectedTemplate.specHash}; }
function request(path, options = {}) {
  evidence.requests.push({path,method:options.method,body:options.body,timeoutMs:options.timeoutMs});
  return fetch(path,{method:options.method,body:JSON.stringify(options.body),headers:{'Content-Type':'application/json'}}).then(async response => ({ok:response.ok,json:await response.json()}));
}
function renderDesigner() {
  var selected=state.selectedTemplate || {code:'',description:'',spec:{},paramsSchema:{},resultSchema:{}};
  document.getElementById('app').innerHTML = renderTemplateEditor(selected) +
   '<textarea id="cmdp-spec">'+escapeHtml(pretty(selected.spec))+'</textarea>' +
   '<textarea id="cmdp-params-schema">'+escapeHtml(pretty(selected.paramsSchema || {}))+'</textarea>' +
   '<textarea id="cmdp-result-schema">'+escapeHtml(pretty(selected.resultSchema || {}))+'</textarea>' +
   '<input id="diagram-edit" value="'+escapeHtml(selected.spec.result?.diagrams?.[0]?.label || '')+'">' +
   '<textarea id="assistant-prompt">'+escapeHtml(state.prompt || '')+'</textarea>' +
   '<input id="cmdp-active" type="checkbox"'+(selected.active ? ' checked' : '')+'>' +
   '<button data-action="save-template">Save</button>' + renderVersions() +
   (state.designerSection === 'view' ? renderViewComposerEditor(selected) + '<button data-action="draft-preview">Preview</button>' : '') +
   (state.designerSection === 'publication' ? renderPublicationEditor(selected) + '<button data-action="apply-publication">Apply</button><button data-action="publish-snapshot">Publish</button>' : '');
  if (state.designerSection === 'publication') syncImportedDiagramSaveGate();
}
URL.createObjectURL = function(blob) { blob.text().then(text=>evidence.downloads.push(JSON.parse(text))); return 'blob:https://transfer.test/download'; };
URL.revokeObjectURL = function() {};
HTMLAnchorElement.prototype.click = function() {};
${functions}
${viewLargeExecutionHelpers}
document.addEventListener('input',handleTemplateTransferChange);
document.addEventListener('change',handleTemplateTransferChange);
document.addEventListener('change',handlePublicationRefreshChange);
document.addEventListener('change', function(event) {
 var target = event.target;
 ${viewSourceChange}
 if (target.matches('[data-compact-multi-select-option]')) syncCompactMultiSelectOption(target);
 else if (target.closest('#cmdp-view-large-table')) handleViewLargeTableChange(target);
});
${helpEvents}
document.addEventListener('keydown', function (event) {
 var target = event.target;
 ${helpEscape}
});
document.addEventListener('input', function(event) {
 if (!event.target.matches('[data-catalog-field-picker-search]')) return;
 var picker = event.target.closest('[data-catalog-field-picker]');
 var results = picker.querySelector('[data-catalog-field-picker-results]');
 results.innerHTML = event.target.value.trim() ? renderCatalogFieldPickerRows(catalogFieldPickerOptions(picker, event.target.value), '', event.target.value) : renderCatalogFieldPickerPrompt();
});
document.addEventListener('click', function(event) {
 var target=event.target.closest('[data-action]'); if (!target) return;
 var action=target.getAttribute('data-action');
 if (action === 'compact-multi-select-toggle') {
   var menu = target.parentNode.querySelector('[data-compact-multi-select-menu]');
   menu.hidden = !menu.hidden;
 }
 if (action === 'catalog-field-picker-toggle') {
   var menu = target.parentNode.querySelector('[data-catalog-field-picker-menu]');
   menu.hidden = !menu.hidden;
 }
 if (action === 'catalog-field-picker-select') selectCatalogFieldPickerField(target);
 if (action === 'draft-preview') runDraftAction('preview');
 ${actionLines.join('\n')}
});
renderDesigner();
`;

const template = { code: 'imported', description: 'Imported definition', active: true, id: 999, owner: 'foreign', specHash: 'foreign-hash', spec: { version: 1, authoring: { assistant: { diagramIntentPrompt: 'Imported prompt' } } }, paramsSchema: { type: 'object' }, resultSchema: { type: 'object' } };
const ready = { success: true, template, checks: { status: 'ready', issues: [], environmentReferences: [], summary: { fields: 2 }, executionReady: true }, changes: { mode: 'new' } };
const original = { id: 7, code: 'existing', description: 'Old', active: true, specHash: 'base-hash', owner: 'local', updatedAt: 'old-time', version: 4, spec: { version: 1 }, paramsSchema: {}, resultSchema: {} };
const targetRevision = 'sha256:' + 'a'.repeat(64);
const replacementReady = { ...ready,
  template: { ...original, description: template.description, spec: template.spec, paramsSchema: template.paramsSchema, resultSchema: template.resultSchema },
  changes: { mode: 'replace', targetId: original.id, targetRevision } };
const file = { name: 'fixture.cmdp-template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ formatVersion: 1, template: { ...template, id: undefined } })) };
const button = (page, action) => page.locator('[data-action="template-transfer-' + action + '"]');

async function withPage(run, viewport = { width: 1280, height: 1000 }, contextOptions = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome' });
  try {
    const page = await browser.newPage({ viewport, ...contextOptions });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('https://transfer.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;margin:12px}input,textarea,select{width:100%;box-sizing:border-box}input[type=checkbox]{width:auto}label{display:grid}.checkbox{display:flex;align-items:center}.checkbox input{width:auto}.row{display:flex;gap:8px}.settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}button{min-height:32px}.section{padding:12px;border-bottom:1px solid #ccc}pre{overflow-wrap:anywhere;white-space:pre-wrap}.view-column-table-wrap{max-width:100%;overflow:auto}' + styles + publicationStyles + largeTableStyles + helpStyles + '</style></head><body><main id="app"></main></body></html>'});
      if (url.pathname.endsWith('/export')) return route.fulfill({ json: { success: true, package: { template: route.request().postDataJSON().template }, fileName: 'current.cmdp-template.json' } });
      if (url.pathname.endsWith('/prepare')) return route.fulfill({json:ready});
      if (url.pathname.endsWith('/versions')) return route.fulfill({json:{success:true,data:[]}});
      if (url.pathname.endsWith('/publish')) {
        const { savedSpecHash, params } = route.request().postDataJSON();
        return route.fulfill({ json: { success: true, action: 'publish', template: { code: 'existing', active: true },
          params, result: { tables: [] }, cache: { enabled: true, scope: 'staticSnapshot', status: 'snapshot-published',
            sharedAcrossUsers: true, backend: 'memory', key: 'a'.repeat(16), specHash: savedSpecHash, paramsHash: 'b'.repeat(64),
            publishedAt: '2026-01-01T00:00:00Z' } } });
      }
      if (url.pathname === '/api/draft/preview') return route.fulfill({json:{success:true,result:{tables:[]}}});
      if (url.pathname.startsWith('/api/templates')) return route.fulfill({json:{success:true,template:{...route.request().postDataJSON(),id:7,specHash:'a'.repeat(64)},executionValidation:{executable:true}}});
      throw new Error('Unexpected request: ' + url);
    });
    await page.goto('https://transfer.test/');
    await page.addScriptTag({ content: harness });
    await run(page);
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); }
}

async function importFile(page) {
  await page.locator('#cmdp-transfer-file').setInputFiles(file);
  await page.waitForFunction(() => Boolean(state.templateTransfer.package));
}
async function prepare(page) {
  await button(page, 'prepare').click();
  await page.waitForFunction(() => Boolean(state.templateTransfer.prepared));
}
async function selectOriginal(page) {
  await page.evaluate((item) => { state.selectedTemplate=structuredClone(item);state.templates=[structuredClone(item)];state.templateVersions=[{id:4}];state.templateEditorInstance++;renderDesigner(); }, original);
}

async function openSimpleLargeTable(page) {
  await selectOriginal(page);
  await page.evaluate(() => {
    window.lang = 'ru';
    state.selectedTemplate.spec = {
      version: 1,
      steps: [
        { type: 'selectCards', as: 'items', className: 'Item', columns: ['Code', 'Region'] },
        { type: 'selectCards', as: 'services', className: 'Service', columns: ['Code', 'Environment'] }
      ],
      result: { tables: [{ name: 'items', columns: ['Code'] }, { name: 'services', columns: ['Code'] }] }
    };
    state.designerSection = 'view';
    renderDesigner();
  });
  await page.locator('#cmdp-view-large-mode').selectOption('key');
  return {
    mode: page.locator('#cmdp-view-large-selector-mode'),
    field: page.locator('#cmdp-view-large-simple-field'),
    advanced: (name) => page.locator(`[data-view-large-field="${name}"]`)
  };
}

test('Designer defaults to simple selection and restores hidden fields declared only by the source table', async () => {
  await withPage(async (page) => {
    const { mode, field, advanced } = await openSimpleLargeTable(page);
    await page.evaluate(() => {
      state.selectedTemplate.spec.result.tables[0].columns.push('DeclaredOnly', 'AlsoDeclared');
      state.viewComposerDraft.columns = [{ field: 'Code', title: 'Code' }];
      renderDesigner();
    });
    assert.equal(await mode.inputValue({ timeout: 5000 }), 'simple');
    assert.equal(await field.isVisible(), true);
    assert.equal(await advanced('kind').isVisible(), false);
    await field.selectOption('DeclaredOnly');

    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 1 && !state.savingTemplate);
    const { method, body: { spec } } = await page.evaluate(() => evidence.requests[0]);
    assert.equal(method, 'PUT');
    const table = spec.result.tables[0];
    assert.equal(table.presentation.largeTable.mode, 'key');
    assert.deepEqual(table.presentation.largeTable.selector, {
      kind: 'result', source: 'items', idField: 'DeclaredOnly', labelField: 'DeclaredOnly', matchField: 'DeclaredOnly'
    });
    assert.deepEqual(table.columns, ['Code']);
    assert.ok(spec.steps.some((step) => step.purpose === 'viewComposer' && step.from === 'items' &&
      step.columns.some((column) => column.as === 'DeclaredOnly' && column.path === 'DeclaredOnly')));
    assert.ok(!spec.steps[0].columns.includes('DeclaredOnly'));

    await page.evaluate(() => { hydrateDesignerStateFromTemplate(); renderDesigner(); });
    assert.equal(await page.locator('#cmdp-view-large-mode').inputValue(), 'key');
    assert.equal(await mode.inputValue(), 'simple');
    assert.equal(await field.inputValue(), 'DeclaredOnly');
    assert.equal(await field.locator('option[value="AlsoDeclared"]').count(), 1);
    assert.equal(await advanced('kind').isVisible(), false);
    await button(page, 'export').click();
    await page.waitForFunction(() => evidence.downloads.length === 1);
    assert.deepEqual(await page.evaluate(() => evidence.downloads[0].template.spec.result.tables[0].presentation.largeTable.selector),
      table.presentation.largeTable.selector);
  });
});

test('Designer offers actual projected fields for match and join, excluding arrays from simple selection', async () => {
  await withPage(async (page) => {
    await openSimpleLargeTable(page);
    await page.evaluate(() => {
      state.viewComposerDraft = null;
      state.selectedTemplate.spec = {
        version: 1,
        steps: [
          { type: 'selectCards', as: 'cards', className: 'Item' },
          { type: 'selectCards', as: 'rightCards', className: 'RightCard' },
          { type: 'composeRows', as: 'left', from: 'cards', columns: [
            { name: 'LeftKey', field: 'Code' }, { name: 'Region', field: 'Code' },
            { name: 'M_Region', value: ['a', 'b'] }
          ] },
          { type: 'composeRows', as: 'right', from: 'rightCards', fields: [
            { name: 'RightKey', field: 'Code' }, 'Region', 'Segment', { as: 'ProjectedTags', column: 'TagSet' }
          ] },
          { type: 'matchRows', as: 'matched', from: 'left', with: 'right', rightPrefix: 'M_' },
          { type: 'joinRows', as: 'joined', from: 'left', with: 'right', rightPrefix: 'J_', on: [{ left: 'LeftKey', right: 'RightKey' }] }
        ],
        result: { tables: [{ name: 'matched', columns: ['LeftKey'] }, { name: 'joined', columns: ['LeftKey'] }] }
      };
      renderDesigner();
    });
    await page.locator('#cmdp-view-large-mode').selectOption('key');
    const mode = page.locator('#cmdp-view-large-selector-mode');
    const field = page.locator('#cmdp-view-large-simple-field');
    async function values() { return field.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean)); }
    assert.deepEqual(await values(), ['LeftKey', 'Region', 'M_RightKey', 'M_Region_2', 'M_Segment']);
    await field.selectOption('M_Region_2');
    await mode.selectOption('advanced');
    for (const name of ['idField', 'matchField']) {
      const picker = page.locator(`[data-view-large-field="${name}"]`).locator('..');
      await picker.locator('[data-action="catalog-field-picker-toggle"]').click();
      await picker.getByRole('searchbox').fill('M_Region');
      assert.equal(await picker.locator('[data-catalog-field-picker-value="M_Region_2"]').count(), 1);
      await picker.getByRole('searchbox').fill('ProjectedTags');
      assert.equal(await picker.locator('[data-catalog-field-picker-value="M_ProjectedTags"]').count(), 1);
      await picker.locator('[data-action="catalog-field-picker-toggle"]').click();
    }
    await mode.selectOption('simple');
    await page.locator('#cmdp-view-source').selectOption('joined');
    assert.equal(await field.inputValue(), '');
    assert.deepEqual(await values(), ['LeftKey', 'Region', 'J_Region', 'Segment']);
    await field.selectOption('J_Region');
    const saved = await page.evaluate(() => readEditorPayload().spec.result.tables[0]);
    assert.equal(saved.presentation.largeTable.selector.matchField, 'J_Region');
    assert.equal(saved.columns.includes('J_Region'), false);
  });
});

test('Designer clears the old simple field on source change and prefills advanced settings from the new source', async () => {
  await withPage(async (page) => {
    const { mode, field, advanced } = await openSimpleLargeTable(page);
    assert.equal(await field.locator('option[value="Environment"]').count(), 0);
    await field.selectOption('Region', { timeout: 5000 });
    await page.locator('#cmdp-view-source').selectOption('services');
    assert.equal(await mode.inputValue(), 'simple');
    assert.equal(await field.inputValue(), '');
    assert.equal(await field.locator('option[value="Region"]').count(), 0);
    await field.selectOption('Environment');
    await mode.selectOption('advanced');
    assert.equal(await field.isVisible(), false);
    for (const [name, value] of Object.entries({
      kind: 'result', source: 'services', idField: 'Environment', labelField: 'Environment', matchField: 'Environment', parameter: ''
    })) {
      assert.equal(await advanced(name).inputValue(), value, name);
    }
  });
});

test('Designer restores each selector draft and keeps fields still valid when the source changes', async () => {
  await withPage(async (page) => {
    const { mode, field, advanced } = await openSimpleLargeTable(page);
    await field.selectOption('Code');
    await mode.selectOption('advanced');
    await advanced('source').selectOption('services');
    assert.equal(await advanced('idField').inputValue(), 'Code');
    assert.equal(await advanced('labelField').inputValue(), 'Code');
    const picker = advanced('matchField').locator('..');
    await picker.locator('[data-action="catalog-field-picker-toggle"]').click();
    await picker.getByRole('searchbox').fill('Region');
    await picker.locator('[role="option"][data-catalog-field-picker-value="Region"]').click({ timeout: 5000 });
    await mode.selectOption('simple');
    assert.equal(await field.inputValue(), 'Code');
    await mode.selectOption('advanced');
    assert.equal(await advanced('source').inputValue(), 'services');
    assert.equal(await advanced('matchField').inputValue(), 'Region');
    await page.locator('#cmdp-view-source').selectOption('services');
    assert.equal(await mode.inputValue(), 'advanced');
    assert.equal(await advanced('source').inputValue(), 'services');
    assert.equal(await advanced('idField').inputValue(), 'Code');
    assert.equal(await advanced('matchField').inputValue(), '');
    await mode.selectOption('simple');
    assert.equal(await field.inputValue(), 'Code');
    assert.deepEqual(await page.evaluate(() => readEditorPayload().spec.result.tables[0].presentation.largeTable.selector), {
      kind: 'result', source: 'services', idField: 'Code', labelField: 'Code', matchField: 'Code'
    });
  });
});

test('Designer keeps advanced array matching and dotted paths selectable after source changes and reopen', async () => {
  await withPage(async (page) => {
    const { mode, field, advanced } = await openSimpleLargeTable(page);
    assert.equal(await field.locator('option[value="ScopeIds"]').count(), 0);
    await field.selectOption('Code');
    await mode.selectOption('advanced');
    await advanced('source').selectOption('services');
    async function pick(name, value) {
      const picker = advanced(name).locator('..');
      await picker.locator('[data-action="catalog-field-picker-toggle"]').click();
      await picker.getByRole('searchbox').fill(value);
      await picker.locator(`[role="option"][data-catalog-field-picker-value="${value}"]`).click({ timeout: 5000 });
    }
    await pick('matchField', 'ScopeIds');
    await pick('labelField', 'ScopeIds');
    assert.equal(await page.evaluate(() => readEditorPayload().spec.result.tables[0].presentation.largeTable.selector.labelField), 'ScopeIds');
    await pick('labelField', 'Owner.Description');
    await page.locator('#cmdp-view-source').selectOption('services');
    assert.equal(await advanced('matchField').inputValue(), 'ScopeIds');
    assert.equal(await advanced('labelField').inputValue(), 'Owner.Description');
    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 1 && !state.savingTemplate);
    const table = await page.evaluate(() => evidence.requests[0].body.spec.result.tables[0]);
    const selector = { kind: 'result', source: 'services', idField: 'Code', labelField: 'Owner.Description', matchField: 'ScopeIds' };
    assert.deepEqual(table.presentation.largeTable.selector, selector);
    await page.evaluate(() => { hydrateDesignerStateFromTemplate(); renderDesigner(); });
    assert.equal(await mode.inputValue(), 'advanced');
    assert.equal(await advanced('matchField').inputValue(), 'ScopeIds');
    assert.equal(await advanced('labelField').inputValue(), 'Owner.Description');
    const index = buildLargeTableIndex({ ...table, rows: [{ Code: 'matched' }, { Code: 'other' }] },
      [{ Code: 'B', 'Owner.Description': 'Owner B' }], { matchValues: [['A', 'B'], ['C']] });
    const [option] = queryLargeTablePage(index, { op: 'options' }).items;
    assert.equal(option.label, 'Owner B');
    assert.deepEqual(queryLargeTablePage(index, { op: 'rows', key: option.key }).table.rows, [{ Code: 'matched' }]);
  });
});

test('Designer preserves an existing field not offered by the simple filter', async () => {
  await withPage(async (page) => {
    const { mode, field, advanced } = await openSimpleLargeTable(page);
    const selector = { kind: 'result', source: 'items', idField: 'OtherKey', labelField: 'OtherKey', matchField: 'OtherKey' };
    await page.evaluate((binding) => {
      state.selectedTemplate.spec.result.tables[0].presentation = { largeTable: { mode: 'key', selector: binding, groupKeys: [], reductions: [] } };
      hydrateDesignerStateFromTemplate();
      renderDesigner();
    }, selector);
    assert.equal(await mode.inputValue(), 'advanced');
    assert.equal(await field.count(), 0);
    assert.equal(await advanced('matchField').inputValue(), 'OtherKey');
    assert.deepEqual(await page.evaluate(() => readEditorPayload().spec.result.tables[0].presentation.largeTable.selector), selector);
  });
});

test('Designer simple large-table selection produces distinct non-empty options and filters matching rows', async () => {
  await withPage(async (page) => {
    const { field } = await openSimpleLargeTable(page);
    await field.selectOption('Region', { timeout: 5000 });
    const spec = await page.evaluate(() => readEditorPayload().spec);
    const table = spec.result.tables[0];
    const sources = {
      items: [
        { Code: 'A', Region: 'North' }, { Code: 'B', Region: 'South' }, { Code: 'C', Region: 'North' },
        { Code: 'D', Region: '' }, { Code: 'E', Region: null }
      ]
    };
    const { selector } = table.presentation.largeTable;
    const tableSource = spec.steps.find((step) => step.as === table.name).from;
    const sourceRows = sources[tableSource];
    const index = buildLargeTableIndex({ ...table, rows: sourceRows.map(({ Code }) => ({ Code })) }, sources[selector.source], {
      matchValues: sourceRows.map((row) => row[selector.matchField])
    });
    const options = queryLargeTablePage(index, { op: 'options' });
    assert.equal(options.total, 2);
    assert.deepEqual(options.items.map(({ label }) => label), ['North', 'South']);
    const north = queryLargeTablePage(index, { op: 'rows', key: options.items[0].key });
    assert.deepEqual(north.table.rows, [{ Code: 'A' }, { Code: 'C' }]);
  });
});

async function simpleFieldHelp(page) {
  const { mode, field } = await openSimpleLargeTable(page);
  const help = page.locator('.field-help-button').and(page.getByRole('button', {
    name: ru.fieldHelpAria.replace('{label}', ru.viewLargeSimpleField),
    exact: true
  }));
  assert.equal(await help.isVisible(), true);
  const tooltipId = await help.getAttribute('aria-describedby');
  assert.ok(tooltipId);
  const tooltip = page.locator(`[id="${tooltipId}"][role="tooltip"]`);
  assert.equal((await tooltip.textContent()).trim(), ru.viewLargeSimpleFieldHelp);
  await help.evaluate((button) => button.scrollIntoView({ block: 'center' }));
  return { mode, field, help, tooltip };
}

async function assertHelpInViewport(page, help, tooltip) {
  await tooltip.waitFor({ state: 'visible', timeout: 5000 });
  const [anchor, box] = await Promise.all([help.boundingBox(), tooltip.boundingBox()]);
  const viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0 &&
    box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
    JSON.stringify({ box, viewport }));
  assert.ok(anchor && box.x < anchor.x + anchor.width && box.x + box.width > anchor.x &&
    (Math.abs(box.y - anchor.y - anchor.height) <= 8 || Math.abs(box.y + box.height - anchor.y) <= 8),
    JSON.stringify({ box, anchor }));
}

async function assertHelpHidesOffscreen(page, help, tooltip) {
  await help.evaluate((button) => {
    button.closest('section').style.marginTop = '120vh';
    window.scrollTo(0, 0);
  });
  await page.waitForFunction((id) => document.getElementById(id).previousElementSibling.getBoundingClientRect().top >= innerHeight,
    await tooltip.getAttribute('id'));
  await tooltip.waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await help.evaluate((button) => document.activeElement === button), true);
}

test('Designer field help supports desktop hover and Escape without moving controls or losing focus', async () => {
  await withPage(async (page) => {
    const { field, help, tooltip } = await simpleFieldHelp(page);
    const before = await field.boundingBox();
    assert.ok(before && before.width > 0 && before.height > 0);
    assert.equal(await tooltip.isVisible(), false);
    await help.hover();
    await assertHelpInViewport(page, help, tooltip);
    assert.deepEqual(await field.boundingBox(), before);
    await page.mouse.move(0, 0);
    await tooltip.waitFor({ state: 'hidden', timeout: 5000 });
    await help.focus();
    await assertHelpInViewport(page, help, tooltip);
    await help.press('Escape');
    await tooltip.waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await help.evaluate((button) => document.activeElement === button), true);
    assert.deepEqual(await field.boundingBox(), before);
    await help.click();
    await assertHelpInViewport(page, help, tooltip);
    await assertHelpHidesOffscreen(page, help, tooltip);
  });
});

test('Designer field help is tappable on mobile without overflow or a layout shift', async () => {
  await withPage(async (page) => {
    const { mode, field, help, tooltip } = await simpleFieldHelp(page);
    assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true);
    assert.equal(await tooltip.isVisible(), false);
    const [modeBox, fieldBox, helpBox] = await Promise.all([mode.boundingBox(), field.boundingBox(), help.boundingBox()]);
    for (const box of [modeBox, fieldBox, helpBox]) {
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44, JSON.stringify(box));
    }
    assert.ok(helpBox.width >= 44);
    assert.ok(modeBox.y + modeBox.height <= fieldBox.y);
    await help.tap();
    await assertHelpInViewport(page, help, tooltip);
    assert.deepEqual(await field.boundingBox(), fieldBox);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await help.tap();
    await tooltip.waitFor({ state: 'hidden', timeout: 5000 });
    await help.tap();
    await assertHelpInViewport(page, help, tooltip);
    await assertHelpHidesOffscreen(page, help, tooltip);
  }, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
});

test('Designer saves, previews and transfers large-table settings on the result table only', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    await page.evaluate(() => {
      window.lang = 'ru';
      state.selectedTemplate.spec = {
        version: 1, params: { parentId: { type: 'integer' } },
        steps: [{ type: 'selectCards', as: 'items', className: 'Item' }, { type: 'selectCards', as: 'parents', className: 'Parent' }],
        result: { tables: [{ name: 'items', columns: ['Source', 'Parent', 'Protocol', 'Port', 'Owner', 'Count'] }] }
      };
      state.designerSection = 'view';
      renderDesigner();
    });
    const large = page.locator('#cmdp-view-large-table');
    const mode = large.getByRole('combobox', { name: 'Просмотр строк' });
    const field = (name) => large.locator(`[data-view-large-field="${name}"]`);
    const reduction = (column) => large.locator(`[data-view-large-reduction="${column}"]`);
    const pickerToggle = (name) => field(name).locator('..').locator('[data-action="catalog-field-picker-toggle"]');
    async function pick(name, value) {
      const picker = field(name).locator('..');
      await pickerToggle(name).click();
      assert.equal(await picker.getByRole('option').count(), 0);
      await picker.getByRole('searchbox').fill(value);
      await picker.locator(`[role="option"][data-catalog-field-picker-value="${value}"]`).click();
      assert.equal(await field(name).inputValue(), value);
    }
    assert.equal(await mode.inputValue(), '');
    assert.equal(await large.locator('[data-view-large-details]').isVisible(), false);
    await mode.selectOption('all');
    assert.equal(await field('kind').count(), 0);
    await large.getByRole('button', { name: /Колонки ключа группировки/ }).click();
    await large.getByRole('checkbox', { name: 'Source' }).check();
    await large.getByRole('checkbox', { name: 'Parent' }).check();
    await large.getByRole('button', { name: /Колонки ключа группировки/ }).click();
    await reduction('Count').locator('[data-view-large-reduction-kind]').selectOption('count');
    await reduction('Owner').locator('[data-view-large-reduction-kind]').selectOption('unique');
    await reduction('Owner').locator('[data-view-large-separator]').fill(' | ');
    await reduction('Protocol').locator('[data-view-large-reduction-kind]').selectOption('tuples');
    assert.equal(await reduction('Source').count(), 0);
    const tuple = reduction('Protocol').locator('[data-view-large-tuple-field]');
    await tuple.nth(0).selectOption('Protocol');
    const all = await page.evaluate(() => readEditorPayload().spec.result.tables[0].presentation.largeTable);
    assert.equal(all.mode, 'all');
    assert.equal(all.selector, undefined);
    assert.deepEqual(all.reductions.find((rule) => rule.kind === 'tuples').fields, ['Protocol']);
    await tuple.nth(1).selectOption('Port');
    await reduction('Protocol').locator('[data-view-large-separator]').fill('; ');

    await mode.selectOption('key');
    const selectorMode = large.locator('#cmdp-view-large-selector-mode');
    await selectorMode.selectOption('advanced', { timeout: 5000 });
    await field('kind').selectOption('class');
    assert.equal(await field('kind').inputValue(), 'class');
    assert.equal(await pickerToggle('idField').isDisabled(), true);
    await assert.rejects(page.evaluate(() => readEditorPayload()), /Источник вариантов/);
    await pick('source', 'Parent');
    await pick('idField', '_id');
    await field('kind').selectOption('result');
    assert.equal(await field('idField').inputValue(), '');
    await field('source').selectOption('parents');
    await pick('matchField', 'HiddenParentId');
    await field('parameter').selectOption('parentId');
    await pick('idField', '_id');
    await pick('labelField', 'Description');
    assert.ok((await mode.boundingBox()).height >= 44);
    const matchBox = await pickerToggle('matchField').boundingBox();
    assert.ok(matchBox && matchBox.x + matchBox.width <= 390);
    const expected = { mode: 'key', selector: { kind: 'result', source: 'parents', idField: '_id', labelField: 'Description', matchField: 'HiddenParentId', parameter: 'parentId' },
      groupKeys: ['Source', 'Parent'], reductions: [{ column: 'Protocol', kind: 'tuples', fields: ['Protocol', 'Port'], separator: '; ' },
        { column: 'Owner', kind: 'unique', separator: ' | ' }, { column: 'Count', kind: 'count' }] };
    await page.locator('[data-action="draft-preview"]').click();
    await page.waitForFunction(() => state.designerSection === 'run');
    await button(page, 'export').click();
    await page.waitForFunction(() => evidence.downloads.length === 1);
    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 3 && !state.savingTemplate);
    for (const spec of await page.evaluate(() => [evidence.requests[0].body.template.spec, evidence.downloads[0].template.spec, evidence.requests[2].body.spec])) {
      assert.deepEqual(spec.result.tables[0].presentation.largeTable, expected);
      assert.equal(spec.result.presentation?.tables?.[0]?.largeTable, undefined);
      assert.equal(spec.visualModels[0].output.largeTable, undefined);
      assert.ok(spec.steps.at(-1).columns.some((column) => column.path === 'HiddenParentId'));
      assert.equal(spec.result.tables[0].columns.includes('HiddenParentId'), false);
    }
    await page.evaluate(() => { hydrateDesignerStateFromTemplate(); state.designerSection = 'view'; renderDesigner(); });
    assert.equal(await mode.inputValue(), 'key');
    assert.equal(await selectorMode.inputValue(), 'advanced');
    assert.equal(await tuple.nth(1).inputValue(), 'Port');
    for (const [name, value] of Object.entries(expected.selector)) {
      assert.equal(await field(name).inputValue(), value, name);
    }
    await large.locator('.view-large-advanced > summary').click();
    assert.equal(await pickerToggle('matchField').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => readEditorPayload().spec.result.tables[0].presentation.largeTable), expected);
    await mode.selectOption('');
    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 4 && !state.savingTemplate);
    assert.equal(await page.evaluate(() => evidence.requests[3].body.spec.result.tables[0].presentation?.largeTable), undefined);
  }, { width: 390, height: 844 });
});

test('Designer publication defaults to personal and publishes without extra consent', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    await page.evaluate(() => {
      state.selectedTemplate.spec.publish = { mode: 'staticSnapshot', warningAccepted: true };
      state.designerSection = 'publication';
      renderDesigner();
    });
    const mode = page.getByRole('combobox', { name: 'Refresh from the report' });
    assert.equal(await mode.inputValue(), 'personal');
    assert.equal(await page.locator('#cmdp-publish-shared-refresh-warning').isVisible(), false);
    await page.locator('[data-action="publish-snapshot"]').click();
    await page.waitForFunction(() => evidence.requests.length === 2 && !state.savingTemplate);
    const [save, publish] = await page.evaluate(() => evidence.requests);
    assert.equal(save.body.spec.publish.refreshMode, 'personal');
    assert.equal(Object.hasOwn(save.body.spec.publish, 'sharedRefreshAccepted'), false);
    assert.equal(publish.path, '/api/templates/existing/publish?root=Root_A');
    assert.equal(publish.timeoutMs, 70000);
    assert.deepEqual(publish.body, { params: {}, savedSpecHash: 'a'.repeat(64) });
  });
});

test('Designer publication gates shared refresh and clears consent when switched away', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    await page.evaluate(() => {
      window.lang = 'ru';
      state.designerSection = 'publication';
      renderDesigner();
    });
    const runtimeMode = page.locator('#cmdp-publish-mode');
    const refreshMode = page.getByRole('combobox', { name: 'Обновление из отчёта' });
    const warning = page.locator('#cmdp-publish-shared-refresh-warning');
    const consent = page.getByRole('checkbox', { name: 'Разрешаю читателям отчёта заменять общий снимок' });
    const save = page.locator('[data-action="save-template"]');
    const apply = page.locator('[data-action="apply-publication"]');
    const publish = page.locator('[data-action="publish-snapshot"]');

    assert.equal(await refreshMode.isVisible(), false);
    await runtimeMode.selectOption('staticSnapshot');
    await page.locator('#cmdp-publish-warning-accepted').check();
    await refreshMode.selectOption({ label: 'Общий снимок' });
    assert.match(await warning.textContent(), /CMDBuild.*анонимных читателей/);
    for (const target of [refreshMode, warning, consent.locator('..')]) {
      const box = await target.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height > 0);
    }
    assert.ok((await refreshMode.boundingBox()).height >= 44);
    assert.ok((await consent.locator('..').boundingBox()).height >= 44);
    assert.equal(await consent.getAttribute('aria-describedby'), 'cmdp-publish-shared-refresh-warning');
    assert.equal(await consent.isChecked(), false);
    for (const action of [apply, save, publish]) assert.equal(await action.isDisabled(), true);
    await page.evaluate(() => saveTemplate());
    assert.equal(await page.evaluate(() => evidence.requests.length), 0);
    assert.match(await page.evaluate(() => evidence.errors.at(-1)), /Подтвердите обновление общего снимка/);

    await consent.focus();
    await consent.press('Space');
    for (const action of [apply, save, publish]) assert.equal(await action.isEnabled(), true);
    await apply.click();
    assert.equal(await consent.isChecked(), true);
    assert.equal(await page.evaluate(() => evidence.requests.length), 0);
    await save.click();
    await page.waitForFunction(() => evidence.requests.length === 1 && !state.savingTemplate);
    assert.deepEqual(await page.evaluate(() => evidence.requests[0].body.spec.publish), {
      mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true, publicD2Source: false,
      refreshMode: 'shared', sharedRefreshAccepted: true
    });
    await page.evaluate(() => renderDesigner());
    assert.equal(await consent.isChecked(), true);

    await refreshMode.selectOption('personal');
    assert.equal(await warning.isVisible(), false);
    assert.equal(await page.locator('#cmdp-publish-shared-refresh-accepted').isChecked(), false);
    await refreshMode.selectOption('shared');
    assert.equal(await consent.isChecked(), false);
    assert.equal(await save.isDisabled(), true);
    await consent.check();
    await runtimeMode.selectOption('dynamicUser');
    assert.equal(await refreshMode.isVisible(), false);
    await runtimeMode.selectOption('staticSnapshot');
    assert.equal(await refreshMode.inputValue(), 'personal');
    assert.equal(await publish.isEnabled(), true);
    await save.click();
    await page.waitForFunction(() => evidence.requests.length === 2 && !state.savingTemplate);
    const config = await page.evaluate(() => evidence.requests[1].body.spec.publish);
    assert.equal(config.refreshMode, 'personal');
    assert.equal(Object.hasOwn(config, 'sharedRefreshAccepted'), false);
  }, { width: 390, height: 844 });
});

test('export captures unsaved definition, schemas, diagram and assistant prompts through Save snapshot without DB writes', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    await page.evaluate(() => { state.designerSection='diagram'; });
    await page.locator('#cmdp-description').fill('Unsaved description');
    await page.locator('#cmdp-spec').fill('{"version":1,"unsaved":"current"}');
    await page.locator('#cmdp-params-schema').fill('{"params":"unsaved"}');
    await page.locator('#cmdp-result-schema').fill('{"result":"unsaved"}');
    await page.locator('#diagram-edit').fill('Unsaved diagram');
    await page.locator('#assistant-prompt').fill('Unsaved prompt');
    await button(page, 'export').click();
    await page.waitForFunction(() => evidence.downloads.length === 1);
    const evidence = await page.evaluate(() => window.evidence);
    assert.equal(evidence.requests.length, 1);
    const request = evidence.requests[0];
    assert.equal(request.path, '/api/template-transfer/export?root=Root_A');
    assert.equal(request.method, 'POST');
    assert.equal(request.body.template.description, 'Unsaved description');
    assert.equal(request.body.template.spec.unsaved, 'current');
    assert.equal(request.body.template.spec.result.diagrams[0].label, 'Unsaved diagram');
    assert.equal(request.body.template.spec.authoring.assistant.diagramIntentPrompt, 'Unsaved prompt');
    assert.deepEqual(request.body.template.paramsSchema, {params:'unsaved'});
    assert.deepEqual(request.body.template.resultSchema, {result:'unsaved'});
    assert.equal(request.body.templateRef.baseSpecHash, 'base-hash');
    assert.deepEqual(evidence.downloads[0].template, request.body.template);
    assert.equal(await page.locator('#cmdp-description').inputValue(), 'Unsaved description');
  });
});

test('new import is visible with no selected template, stages inactive only on confirmation, writes only on Save', async () => {
  for (const viewport of [{width:1280,height:1000},{width:390,height:844}]) {
    await withPage(async (page) => {
      assert.ok(await page.locator('#cmdp-template-transfer').isVisible());
      const box = await button(page, 'export').boundingBox();
      assert.ok(box && box.width > 60 && box.height >= 32 && box.x >= 0 && box.x + box.width <= viewport.width);
      await importFile(page);
      await page.locator('#cmdp-transfer-code').fill('custom-code');
      await page.locator('#cmdp-transfer-description').fill('Custom description');
      await prepare(page);
      assert.equal(await page.evaluate(() => state.selectedTemplate), null);
      assert.equal(await page.evaluate(() => evidence.requests.length), 1);
      const body = await page.evaluate(() => evidence.requests[0].body);
      assert.equal(body.mode, 'new');assert.equal(body.targetCode,'custom-code');assert.equal(body.description,'Custom description');
      page.once('dialog', (dialog) => dialog.dismiss());
      await button(page, 'stage').click();
      assert.equal(await page.evaluate(() => state.selectedTemplate), null);
      page.once('dialog', (dialog) => dialog.accept());
      await button(page, 'stage').click();
      const staged = await page.evaluate(() => state.selectedTemplate);
      assert.equal(staged.active, false);assert.equal(staged.id, undefined);assert.equal(staged.owner, undefined);assert.equal(staged.specHash, undefined);
      assert.deepEqual(staged.spec, template.spec);
      assert.match(await page.locator('#cmdp-template-transfer').innerText(), /Imported, not saved/);
      assert.equal(await page.evaluate(() => evidence.requests.length), 1);
      await page.locator('[data-action="save-template"]').click();
      await page.waitForFunction(() => evidence.requests.length === 2);
      const saved = await page.evaluate(() => evidence.requests[1]);
      assert.equal(saved.method,'POST');assert.equal(saved.path,'/api/templates?root=Root_A');assert.equal(saved.body.active,false);
      await page.screenshot({path:'/tmp/cmdp-template-transfer-' + viewport.width + '.png',fullPage:true});
    }, viewport);
  }
});

test('replace retains target identity, history, activity and baseline; cancel leaves unsaved editor untouched', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    await page.route('**/template-transfer/prepare?**', (route) => route.fulfill({json:replacementReady}));
    await page.locator('#cmdp-description').fill('Unsaved existing description');
    await importFile(page);
    await page.locator('#cmdp-transfer-mode').selectOption('replace');
    await prepare(page);
    assert.equal(await page.locator('#cmdp-description').inputValue(),'Unsaved existing description');
    await button(page, 'cancel').click();
    assert.equal(await page.locator('#cmdp-description').inputValue(),'Unsaved existing description');
    assert.equal(await page.evaluate(() => state.templateTransfer.prepared),null);
    await importFile(page);
    await page.locator('#cmdp-transfer-mode').selectOption('replace');
    await prepare(page);
    const body=await page.evaluate(() => evidence.requests.at(-1).body);
    assert.equal(body.baseSpecHash,'base-hash');assert.equal(body.targetCode,'existing');
    page.once('dialog', dialog => dialog.accept());
    await button(page, 'stage').click();
    const staged=await page.evaluate(() => state.selectedTemplate);
    for (const key of ['id','code','active','specHash','owner','updatedAt','version']) assert.deepEqual(staged[key],original[key],key);
    assert.deepEqual(await page.evaluate(() => state.templateVersions),[]);
    assert.equal(staged.description,template.description);
    assert.equal(await page.evaluate(() => evidence.requests.length),2);
    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 3);
    const save=await page.evaluate(() => evidence.requests.at(-1));
    assert.equal(save.method,'PUT');
    assert.deepEqual(save.body.transferReplace,{targetId:original.id,revision:targetRevision});
    assert.equal(Object.hasOwn(save.body,'expectedSpecHash'),false);
    assert.equal(Object.hasOwn(save.body,'active'),false);
  });
});

test('needsAttention shows issues, requires explicit reference acknowledgement, allows incomplete staging and explicit JSON overrides', async () => {
  await withPage(async (page) => {
    const attention={...ready,checks:{status:'needsAttention',executionReady:false,issues:[{path:'$.spec.steps[0]',code:'catalog_missing',message:'Missing class',blocking:false,severity:'error'}],environmentReferences:[{path:'$.spec.params.card.default',value:42,kind:'typedId',requiresConfirmation:true,parameterName:'card',effective:true},{path:'$.spec.url',value:'https://example.test/a',kind:'url',requiresConfirmation:true},{path:'$.spec.params.card.defaultValue',value:12,kind:'typedId',requiresConfirmation:false,parameterName:'card',effective:false,shadowedBy:'$.spec.params.card.default'}]}};
    await page.route('**/template-transfer/prepare?**', route=>route.fulfill({json:attention}));
    await importFile(page);await prepare(page);
    assert.match(await page.locator('#cmdp-template-transfer').innerText(),/Missing class/);
    assert.match(await page.locator('#cmdp-template-transfer').innerText(),/Execution is not ready/);
    assert.match(await page.locator('[data-transfer-reference="0"]').innerText(),/Parameter: card[\s\S]*Effective value/);
    assert.match(await page.locator('[data-transfer-reference="2"]').innerText(),/Shadowed by \$\.spec\.params\.card\.default/);
    assert.equal(await page.locator('[data-transfer-ack]').count(),2,'only required references need acknowledgement');
    await button(page,'stage').click();
    assert.equal(await page.evaluate(()=>state.selectedTemplate),null);
    await page.locator('[data-transfer-review-value="0"]').fill('84');
    assert.equal(await button(page,'stage').isDisabled(),true);
    await prepare(page);
    assert.deepEqual(await page.evaluate(()=>evidence.requests.at(-1).body.overrides),[{path:'$.spec.params.card.default',value:84}]);
    await page.locator('[data-transfer-ack="0"]').check();await page.locator('[data-transfer-ack="1"]').check();
    page.once('dialog',dialog=>dialog.accept());
    await button(page,'stage').click();
    assert.equal(await page.evaluate(()=>state.selectedTemplate.active),false);
    assert.equal(await page.evaluate(()=>evidence.requests.length),2);
    await page.locator('#cmdp-active').check();
    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 3);
    const save = await page.evaluate(() => evidence.requests.at(-1));
    assert.equal(save.method, 'POST');
    assert.equal(save.body.active, false, 'first Save of a staged import ignores the general Active checkbox');
  });
});

test('incomplete replacement can be staged; final 422 and 409 keep the edited draft and never fall back to ordinary Save', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    await page.route('**/template-transfer/prepare?**', (route) => route.fulfill({ json: {
      ...replacementReady, checks: { ...ready.checks, executionReady: false,
        issues: [{ path: '$.spec', message: 'Incomplete on prepare', blocking: false }] }
    } }));
    await importFile(page);
    await page.locator('#cmdp-transfer-mode').selectOption('replace');
    await prepare(page);
    assert.equal(await button(page, 'stage').isEnabled(), true);
    assert.match(await page.locator('#cmdp-template-transfer').innerText(), /Stage the draft to fix/);
    await page.evaluate(() => { state.result = { old: true }; state.extractionOperation = { old: true }; state.extractionSource = 'old'; });
    page.once('dialog', (dialog) => dialog.accept());
    await button(page, 'stage').click();
    assert.deepEqual(await page.evaluate(() => [state.result, state.extractionOperation, state.extractionSource]), [null, null, '']);
    assert.match(await page.locator('#cmdp-template-transfer').innerText(), /Incomplete on prepare/);
    const save = page.locator('[data-action="save-template"]');
    await page.locator('#cmdp-description').fill('Still my unsaved edit');
    await page.locator('#cmdp-spec').fill('{"version":1,"edited":true}');
    let status = 422;
    await page.route('**/templates/existing?**', (route) => route.fulfill({ status, json: {
      success: false, code: status === 422 ? 'template_transfer_incomplete' : 'template_transfer_revision_conflict',
      issues: status === 422 ? [{ path: '$.spec.steps[0].filters[0].values[1]', message: 'Missing target card' }] : []
    } }));
    await save.click();
    const panel = page.locator('#cmdp-template-transfer');
    await panel.getByText('Missing target card', { exact: false }).waitFor({ state: 'visible' });
    assert.ok((await panel.getByText('Missing target card', { exact: false }).boundingBox()).height > 0);
    status = 409;
    await save.click();
    await panel.getByText(/The target changed/).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#cmdp-description').inputValue(), 'Still my unsaved edit');
    assert.equal(JSON.parse(await page.locator('#cmdp-spec').inputValue()).edited, true);
    assert.equal(await button(page, 'prepare').isEnabled(), true);
    const writes = await page.evaluate(() => evidence.requests.filter((entry) => entry.method === 'PUT'));
    assert.equal(writes.length, 2);
    assert.ok(writes.every((entry) => entry.body.transferReplace.revision === 'sha256:' + 'a'.repeat(64)));
  });
});

test('history ignores late responses and stale Load buttons across roots, card IDs and generations', async () => {
  await withPage(async (page) => {
    await selectOriginal(page);
    const pending = [];
    await page.route('**/versions?**', (route) => { pending.push(route); });
    const versions = () => page.evaluate(() => {
      (window.versionRequests ||= []).push(fetchVersions(state.selectedTemplate.code).then(renderDesigner));
    });
    const history = page.locator('[data-action="load-version"]');
    const respond = (route, value) => route.fulfill({ json: { data: [{ id: 4, templateCode: 'existing', spec: { version: 1, loaded: value } }] } });
    await versions();
    await page.waitForFunction(() => evidence.requests[0]?.path.endsWith('root=Root_A'));
    await page.evaluate(() => { state.root = 'Root_B'; state.selectedTemplate.id = 88; state.templateEditorInstance++; renderDesigner(); });
    await versions();
    const waitForRequest = async (n) => {
      await page.waitForFunction((count) => evidence.requests.length === count, n);
      while (pending.length < n) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await waitForRequest(2);
    assert.match(pending[1].request().url(), /root=Root_B$/);
    await respond(pending[1], 'current');
    await history.waitFor({ state: 'visible' });
    assert.ok((await history.boundingBox()).height > 0);
    const staleGeneration = await history.getAttribute('data-version-generation');
    await respond(pending[0], 'old-root');
    await page.evaluate(() => window.versionRequests[0]);
    assert.equal(await page.evaluate(() => state.templateVersions[0].spec.loaded), 'current');
    await page.evaluate(() => { state.selectedTemplate.id = 89; renderDesigner(); });
    assert.equal(await history.count(), 0, 'the same Code on another card cannot load the last card history');
    await versions();
    await waitForRequest(3);
    await respond(pending[2], 'latest');
    await page.evaluate(() => window.versionRequests[2]);
    await page.evaluate((generation) => loadVersion(4, generation), staleGeneration);
    assert.equal(await page.evaluate(() => state.selectedTemplate.spec.loaded), undefined);
    await history.click();
    assert.deepEqual(await page.evaluate(() => [state.root, state.selectedTemplate.id, state.selectedTemplate.spec.loaded]), ['Root_B', 89, 'latest']);
  });
});

test('late prepare responses cannot reach another root, session, template or editor instance', async () => {
  await withPage(async (page) => {
    for (const change of ['root','session','template','editor','cancel']) {
      await page.evaluate(()=>{state.root='Root_A';state.session='session-A';state.sessionInstance++;state.selectedTemplate=null;state.templateEditorInstance++;renderDesigner();});
      let pending;
      await page.route('**/template-transfer/prepare?**',async route=>{pending=route;});
      await importFile(page);await button(page,'prepare').click();
      while (!pending) await new Promise(resolve=>setTimeout(resolve,10));
      await page.evaluate(change=>{
        if(change==='root'){state.rootSelectionGeneration=(state.rootSelectionGeneration||0)+2;}
        if(change==='session'){state.sessionInstance++;}
        if(change==='template'){state.selectedTemplate={id:8,code:'other',spec:{}};}
        if(change==='editor'){state.templateEditorInstance++;}
        if(change==='cancel'){state.templateTransfer=null;}
        refreshTemplateTransfer();
      },change);
      await pending.fulfill({json:ready});
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(()=>state.templateTransfer.prepared),null,change);
      assert.equal(await button(page,'stage').isDisabled(),true,change);
      await page.unroute('**/template-transfer/prepare?**');
    }
  });
});

test('RU controls, invalid files, prepare HTTP errors and reference text are safe and visible', async () => {
  await withPage(async page=>{
    await page.evaluate(()=>{window.lang='ru';renderDesigner();});
    assert.match(await page.locator('#cmdp-template-transfer').innerText(),/Экспорт \/ импорт шаблона/);
    await page.locator('#cmdp-transfer-file').setInputFiles({...file,name:'bad.json'});
    assert.match(await page.locator('#cmdp-template-transfer').innerText(),/Выберите файл/);
    await page.route('**/template-transfer/prepare?**',route=>route.fulfill({status:409,json:{success:false,message:'Revision conflict'}}));
    await importFile(page);await button(page,'prepare').click();
    await page.waitForFunction(()=>state.templateTransfer.message==='Revision conflict');
    assert.equal(await page.evaluate(()=>state.selectedTemplate),null);
    assert.equal(await button(page,'stage').isDisabled(),true);
  },{width:390,height:844});
});

test('late export and file-read completions are discarded after ownership changes', async () => {
  await withPage(async page => {
    await selectOriginal(page);
    let pending;
    await page.route('**/template-transfer/export?**', async route => { pending = route; });
    await button(page,'export').click();
    while (!pending) await new Promise(resolve => setTimeout(resolve,10));
    await page.evaluate(() => { state.sessionInstance++;refreshTemplateTransfer(); });
    await pending.fulfill({json:{success:true,package:{template},fileName:'stale.cmdp-template.json'}});
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => evidence.downloads.length),0);
    await page.evaluate(() => {
      window.pendingFile = readTemplateTransferFile({name:'delayed.cmdp-template.json',text:() => new Promise(resolve => { window.finishFile=resolve; })});
      state.templateEditorInstance++;
      refreshTemplateTransfer();
      window.finishFile('{"template":{}}');
    });
    await page.evaluate(() => window.pendingFile);
    assert.equal(await page.evaluate(() => state.templateTransfer.package),null);
  });
});

test('oversized transfer files are rejected before reading their body or sending a request', async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      window.fileWasRead = false;
      await readTemplateTransferFile({ name: 'huge.cmdp-template.json', size: boot.templateTransferMaxBytes + 1,
        text: () => { window.fileWasRead = true; throw new Error('Must not read oversized file'); } });
    });
    assert.equal(await page.evaluate(() => window.fileWasRead), false);
    assert.match(await page.locator('#cmdp-template-transfer').innerText(), /exceeds the configured limit/);
    assert.equal(await page.evaluate(() => evidence.requests.length), 0);
    assert.equal(await button(page, 'stage').isDisabled(), true);
  });
});
