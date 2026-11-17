import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const names = [
  'templateTransferOwner', 'templateTransferOwnerIsCurrent', 'templateTransferDraft', 'renderTemplateTransfer',
  'refreshTemplateTransfer', 'templateTransferError', 'readTemplateTransferFile', 'prepareTemplateTransfer',
  'stageTemplateTransfer', 'exportTemplateTransfer', 'handleTemplateTransferChange', 'captureTemplateEditorSnapshot',
  'saveTemplate', 'saveTemplateSnapshot', 'readEditorPayload', 'runtimeSettingsScope', 'runtimeSettingsScopeIsCurrent',
  'readTemplateCode', 'readTemplateDescription', 'readTemplateActive', 'renderTemplateEditor', 'renderTemplateCopySelector'
];
const functions = names.map((name) => {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}).join('\n');
const translations = [...source.matchAll(/^      (transfer\w+): ('[^\n]*'),$/gm)].map((match) => [match[1], Function('return ' + match[2])()]);
const split = translations.findIndex(([key], index) => index > 0 && key === translations[0][0]);
const en = Object.fromEntries(translations.slice(0, split));
const ru = Object.fromEntries(translations.slice(split));
const styles = source.split('\n').find((line) => line.includes('#cmdp-template-transfer{'));
const actionLines = source.split('\n').filter((line) => line.includes("if (action === 'template-transfer-") || line.includes("if (action === 'save-template')"));

const harness = `
var apiPrefix = '/api';
var boot = { templateTransferMaxBytes: 131072 };
var CMDB_BUILD_VIEW_KIND = 'cmdb-build-view';
var state = { root: 'Root_A', session: 'session-A', sessionInstance: 1, templateEditorInstance: 1, templates: [], selectedTemplate: null, designerSection: 'template', templateVersions: [], uiDiagnosticRevision: 0 };
window.evidence = { requests: [], downloads: [], captures: [], errors: [] };
window.lang = 'en';
var translations = ${JSON.stringify({ en, ru })};
function t(key, params) { return (translations[window.lang][key] || key).replace(/\\{(\\w+)\\}/g, function(match, name) { return params && params[name] !== undefined ? params[name] : match; }); }
function escapeHtml(value) { return String(value == null ? '' : value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function pretty(value) { return JSON.stringify(value, null, 2); }
function cloneJsonValue(value) { return JSON.parse(JSON.stringify(value)); }
function defaultSpec() { return {version:1}; }
function templateKindForSpec() { return 'dsl'; }
function readValue(id) { return document.getElementById(id).value; }
function hasField(id) { return Boolean(document.getElementById(id)); }
function readChecked(id) { return document.getElementById(id).checked; }
function normalizeTemplateProtection(value) { return value; }
function applyTemplateKindFromEditor(value) { return value; }
function readCurrentParamsSchema() { return JSON.parse(readValue('cmdp-params-schema')); }
function readCurrentResultSchema() { return JSON.parse(readValue('cmdp-result-schema')); }
function readSpecWithEditorBlocks() { return { spec: state.selectedTemplate.spec }; }
function captureVisibleDesignerState() {
  evidence.captures.push('visible');
  state.selectedTemplate = Object.assign({}, state.selectedTemplate || {}, {code:readValue('cmdp-code'),description:readValue('cmdp-description')});
  state.selectedTemplate.spec = JSON.parse(readValue('cmdp-spec'));
  return true;
}
function activeDiagramImportEditorModel() { return {version:3}; }
function captureDiagramImportProposalFromDom() { return {version:3, label:readValue('diagram-edit')}; }
function diagramImportSpecWithSavedEditor(spec, diagram) { evidence.captures.push('diagram'); return Object.assign({},spec,{result:{diagrams:[diagram]}}); }
function markImportedDiagramChanged() {}
function captureAssistantPromptsFromDom() { evidence.captures.push('prompts'); state.prompt=readValue('assistant-prompt'); }
function assistantSpecWithPrompts(spec) { return Object.assign({}, spec, {authoring:{assistant:{diagramIntentPrompt:state.prompt}}}); }
function updateSelectedFromEditor(spec) { state.selectedTemplate.spec=spec; }
function hydrateDesignerStateFromTemplate() { state.templateEditorInstance++; state.prompt=state.selectedTemplate.spec.authoring?.assistant?.diagramIntentPrompt || ''; }
function uiRequestOwner() { return { revision:0 }; }
function uiDiagnosticIsCurrent() { return true; }
function runUiOperation(_action, callback) { return callback(); }
function runUiMutation(callback) { return callback(); }
function syncImportedDiagramSaveGate() {}
function diagramImportExecutionValidationHasMappingBlocker() { return false; }
function validateUiResponse(result) { if (!result.json.template) throw new Error('invalid'); }
function createRequestError(result) { return new Error(result.json?.message || 'request failed'); }
function setUiError(error) { evidence.errors.push(error.message); }
function assistantTemplateRefClient() { return {root:state.root,templateCode:state.selectedTemplate.code,baseSpecHash:state.selectedTemplate.specHash}; }
function request(path, options) {
  evidence.requests.push({path,method:options.method,body:options.body});
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
   '<button data-action="save-template">Save</button>';
}
URL.createObjectURL = function(blob) { blob.text().then(text=>evidence.downloads.push(JSON.parse(text))); return 'blob:https://transfer.test/download'; };
URL.revokeObjectURL = function() {};
HTMLAnchorElement.prototype.click = function() {};
${functions}
document.addEventListener('input',handleTemplateTransferChange);
document.addEventListener('change',handleTemplateTransferChange);
document.addEventListener('click', function(event) {
 var target=event.target.closest('[data-action]'); if (!target) return;
 var action=target.getAttribute('data-action');
 ${actionLines.join('\n')}
});
renderDesigner();
`;

const template = { code: 'imported', description: 'Imported definition', active: true, id: 999, owner: 'foreign', specHash: 'foreign-hash', spec: { version: 1, authoring: { assistant: { diagramIntentPrompt: 'Imported prompt' } } }, paramsSchema: { type: 'object' }, resultSchema: { type: 'object' } };
const ready = { success: true, template, checks: { status: 'ready', issues: [], environmentReferences: [], summary: { fields: 2 }, executionReady: true }, changes: { mode: 'new' } };
const original = { id: 7, code: 'existing', description: 'Old', active: true, specHash: 'base-hash', owner: 'local', updatedAt: 'old-time', version: 4, spec: { version: 1 }, paramsSchema: {}, resultSchema: {} };
const file = { name: 'fixture.cmdp-template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ formatVersion: 1, template: { ...template, id: undefined } })) };
const button = (page, action) => page.locator('[data-action="template-transfer-' + action + '"]');

async function withPage(run, viewport = { width: 1280, height: 1000 }) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome' });
  try {
    const page = await browser.newPage({ viewport });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('https://transfer.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;margin:12px}input,textarea,select{width:100%;box-sizing:border-box}label{display:grid}.row{display:flex;gap:8px}.settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}button{min-height:32px}.section{padding:12px;border-bottom:1px solid #ccc}pre{overflow-wrap:anywhere;white-space:pre-wrap}' + styles + '</style></head><body><main id="app"></main></body></html>'});
      if (url.pathname.endsWith('/export')) return route.fulfill({ json: { success: true, package: { template: route.request().postDataJSON().template }, fileName: 'current.cmdp-template.json' } });
      if (url.pathname.endsWith('/prepare')) return route.fulfill({json:ready});
      if (url.pathname.startsWith('/api/templates')) return route.fulfill({json:{success:true,template:{...route.request().postDataJSON(),id:7,specHash:'saved-hash'},executionValidation:{executable:true}}});
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
    await page.route('**/template-transfer/prepare?**', (route) => route.fulfill({json:{...ready,template:{...template,code:'existing'},changes:{mode:'replace'}}}));
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
    assert.deepEqual(await page.evaluate(() => state.templateVersions),[{id:4}]);
    assert.equal(staged.description,template.description);
    assert.equal(await page.evaluate(() => evidence.requests.length),2);
    await page.locator('[data-action="save-template"]').click();
    await page.waitForFunction(() => evidence.requests.length === 3);
    const save=await page.evaluate(() => evidence.requests.at(-1));
    assert.equal(save.method,'PUT');assert.equal(save.body.expectedSpecHash,'base-hash');
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
