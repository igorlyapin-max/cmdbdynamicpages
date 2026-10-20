import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const functionNames = [
  'diagramImportLabelAutocompleteQuery', 'diagramImportLabelAutocompleteHost', 'closeDiagramImportLabelAutocomplete',
  'diagramImportAggregationLabelCandidatesClient', 'ensureDiagramImportAggregationLabelAttributesClient',
  'renderDiagramImportAggregationLabelAutocompleteClient', 'selectDiagramImportLabelAutocompleteCandidate',
  'catalogAttributeLoadKey', 'ensureCatalogAttributesForClass', 'mergeCatalogClassAttributes',
  'invalidateCatalogDerivedCaches', 'diagramImportStageFieldOptions'
];
const functions = functionNames.map((name) => {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
}).join('\n');
const eventsStart = source.indexOf("  document.addEventListener('click', function (event) {\n    if (event.target && event.target.matches && event.target.matches('[data-diagram-import-aggregation-label-template]'))");
const eventsEnd = source.indexOf("  document.addEventListener('change'", eventsStart);
const changeStart = source.indexOf("  document.addEventListener('change', function (event) {\n    var target = event.target;");
const changeEnd = source.indexOf("\n  window.addEventListener('popstate'", changeStart);
assert.ok(eventsStart >= 0 && eventsEnd > eventsStart && changeStart >= 0 && changeEnd > changeStart);

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:20px;font:14px system-ui}main{max-width:480px}input,select{box-sizing:border-box;width:100%;min-height:44px}
.diagram-import-label-template{position:relative}.diagram-import-label-autocomplete{position:absolute;z-index:45;top:calc(100% + 3px);left:0;right:0;max-height:260px;overflow:auto;background:#fff;border:1px solid #ddd}
.diagram-import-label-autocomplete button{display:grid;width:100%;min-height:44px;text-align:left}.diagram-import-label-autocomplete[hidden]{display:none}
</style></head><body><main data-diagram-import-rule-row="0" data-diagram-import-rule-id="rule">
<label>Source<select data-diagram-import-rule-field="sourceStageId"><option value="stage">Selected source</option></select></label>
<div class="diagram-import-label-template" data-diagram-import-label-template-field>
<label>Connection label<input data-diagram-import-rule-field="labelTemplate" data-diagram-import-aggregation-label-template autocomplete="off" aria-autocomplete="list" aria-expanded="false"></label>
<div class="diagram-import-label-autocomplete" role="listbox" data-diagram-import-label-autocomplete hidden></div></div>
<button id="capture">Capture</button></main></body></html>`;

const harness = `
var apiPrefix = '/cmdbuild/custom-api';
var state = { selectedTemplate: { spec: {} }, catalog: { classes: [{ name: 'SelectedClass', attributes: [] }] }, catalogAttributeLoads: {}, catalogAttributeLoaded: {}, catalogAttributeFailedAt: {} };
window.autocompleteEvidence = { requests: [], captures: [], stores: 0, renders: 0 };
function t(key) { return key; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); }
function defaultSpec() { return {}; }
function uniqueList(values) { return Array.from(new Set(values)); }
function request(url) { window.autocompleteEvidence.requests.push(url); return fetch(url).then(async function(response) { return { ok: response.ok, json: await response.json() }; }); }
function catalogClassByName(name) { return state.catalog.classes.find(function(item) { return item.name === name; }); }
function catalogAttributeOptions(name) { return catalogClassByName(name).attributes; }
function catalogScopePathOptions(_name, query) { if (!query.trim()) throw new Error('Empty metadata traversal'); return []; }
function normalizeDiagramImportConditionCardSourceClient(source) { return source || null; }
function diagramImportStageById() { return { className: 'SelectedClass' }; }
function diagramImportPrimaryCardSourceClient(stage) { return { source: { className: stage.className } }; }
function diagramImportStageCardSourcesClient() { throw new Error('Unrelated card sources must not be traversed'); }
function diagramImportStageFieldDisplayLabel(_stage, name) { return name; }
function diagramTemplateParameterTokenRows() { return [{ value: 'param.Protocol', label: 'Protocol' }]; }
function ensureDiagramImportRelatedLabelField() {}
function errorText() { return 'Unavailable'; }
function clientLog() {}
function captureDiagramImportProposalFromDom() { var value = document.querySelector('[data-diagram-import-aggregation-label-template]').value; window.autocompleteEvidence.captures.push(value); return { labelTemplate: value }; }
function storeDiagramImportEditorMutation() { window.autocompleteEvidence.stores += 1; }
function renderDesigner() { window.autocompleteEvidence.renders += 1; var input = document.querySelector('[data-diagram-import-aggregation-label-template]'); input.outerHTML = input.outerHTML; }
${functions}
document.addEventListener('input', function(event) { if (event.target.matches('[data-diagram-import-aggregation-label-template]')) renderDiagramImportAggregationLabelAutocompleteClient(event.target); });
document.getElementById('capture').addEventListener('click', captureDiagramImportProposalFromDom);
${source.slice(eventsStart, eventsEnd)}
${source.slice(changeStart, changeEnd)}
`;

test('Diagram label cold search, full-token replacement, and Enter then suffix retain focus on desktop and mobile', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome' });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('https://diagram.test/**', async (route) => {
          if (route.request().url().endsWith('/model/classes/SelectedClass/attributes')) {
            return route.fulfill({ json: { data: [{ name: 'dport' }, { name: 'sport' }] } });
          }
          assert.ok(route.request().url().endsWith('/ui/designer'));
          return route.fulfill({ contentType: 'text/html', body: html });
        });
        await page.goto('https://diagram.test/cmdbuild/dynamicpages/ui/designer');
        await page.addScriptTag({ content: harness });
        const input = page.locator('[data-diagram-import-aggregation-label-template]');
        await input.fill('${');
        assert.equal(await page.locator('[data-diagram-import-aggregation-candidate]').count(), 1);
        assert.deepEqual(await page.evaluate(() => window.autocompleteEvidence.requests), []);
        await input.fill('${dp');
        const candidate = page.locator('[data-diagram-import-aggregation-candidate]').filter({ hasText: '${dport}' });
        await candidate.waitFor({ state: 'visible' });
        const box = await candidate.boundingBox();
        assert.ok(box && box.width > 40 && box.height >= 44);
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
        assert.equal(await page.evaluate(() => window.autocompleteEvidence.requests.length), 1);
        await input.press('Enter');
        await page.waitForTimeout(100);
        await page.keyboard.type(' suffix');
        assert.equal(await input.inputValue(), '${dport} suffix');
        assert.equal(await input.evaluate((node) => document.activeElement === node), true);
        assert.equal(await page.evaluate(() => window.autocompleteEvidence.renders), 0);
        await input.fill('prefix ${dport} suffix');
        await input.evaluate((node) => node.setSelectionRange(node.value.indexOf('dport') + 2, node.value.indexOf('dport') + 2));
        await input.press('ArrowLeft');
        await input.press('ArrowRight');
        await candidate.click();
        assert.equal(await input.inputValue(), 'prefix ${dport} suffix');
        assert.equal(await input.evaluate((node) => document.activeElement === node), true);
        await page.locator('#capture').click();
        assert.equal(await page.evaluate(() => window.autocompleteEvidence.captures.at(-1)), 'prefix ${dport} suffix');
        assert.ok(await page.evaluate(() => window.autocompleteEvidence.stores) >= 2);
        assert.equal(await page.evaluate(() => window.autocompleteEvidence.renders), 0);
        assert.equal(await page.evaluate(() => window.autocompleteEvidence.requests.length), 1);
        await input.fill('${param.');
        await page.locator('[data-diagram-import-aggregation-candidate]').filter({ hasText: '${param.Protocol}' }).waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => window.autocompleteEvidence.requests.length), 1);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});
