import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const t = (key, vars = {}) => key + (vars.count === undefined ? '' : `:${vars.count}`);
const configNames = ['diagramImportAggregationConfigClient', 'diagramImportAggregationErrorsClient', 'captureDiagramImportAggregationClient'];

function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
}

function helpers(names, dependencies = {}) {
  return new Function(...Object.keys(dependencies), names.map(functionSource).join('\n') + `\nreturn { ${names.join(', ')} };`)(...Object.values(dependencies));
}

function relationRow(config, values = {}, id = 'rule') {
  const controls = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]));
  const aggregation = config === undefined ? {} : {
    enabled: { checked: config.enabled },
    format: { value: config.format ?? 'compact' },
    duplicates: { value: config.duplicates ?? 'distinct' },
    maxLabelChars: { value: String(config.maxLabelChars ?? 2000) }
  };
  return {
    getAttribute: () => id,
    querySelector(selector) {
      const name = selector.match(/field="([^"]+)"/)?.[1];
      return (selector.includes('aggregation-field') ? aggregation : controls)[name] || null;
    },
    querySelectorAll: () => (config?.groupBy || []).map((value) => ({ value }))
  };
}

test('aggregation defaults are opt-in and never clamp or drop invalid authored values', () => {
  const api = helpers(configNames, { t });
  assert.deepEqual(api.diagramImportAggregationConfigClient(), { enabled: false, groupBy: [], format: 'compact', duplicates: 'distinct', maxLabelChars: 2000 });
  assert.equal(api.diagramImportAggregationConfigClient({ enabled: true }).enabled, true);
  for (const maxLabelChars of [0, 63, 20001, 64.5, '']) {
    const config = api.diagramImportAggregationConfigClient({ enabled: true, groupBy: ['missing'], maxLabelChars });
    assert.equal(config.maxLabelChars, maxLabelChars);
    assert.deepEqual(api.diagramImportAggregationErrorsClient(config), ['diagramImportAggregationMaxError']);
  }
  for (const maxLabelChars of [64, 2000, 20000]) {
    assert.deepEqual(api.diagramImportAggregationErrorsClient(api.diagramImportAggregationConfigClient({ maxLabelChars })), []);
  }
});

test('capture retains absence, disabled configuration, field order, and invalid numeric input', () => {
  const { captureDiagramImportAggregationClient: capture } = helpers(configNames, { t });
  assert.equal(capture(relationRow({ enabled: false }), undefined), undefined);
  const existing = { enabled: false, groupBy: ['old'] };
  assert.equal(capture(relationRow(), existing), existing);
  const config = { enabled: false, groupBy: ['z', 'missing', 'a'], format: 'tree', duplicates: 'preserve', maxLabelChars: 20001 };
  assert.deepEqual(capture(relationRow(config), config), config);
  const row = relationRow({ enabled: true });
  const query = row.querySelector.bind(row);
  row.querySelector = (selector) => selector.includes('maxLabelChars') ? { value: '' } : query(selector);
  assert.equal(capture(row).maxLabelChars, '');
});

test('numeric validation updates the local alert without replacing controls or changing authored input', () => {
  const row = relationRow({ enabled: true, groupBy: [], maxLabelChars: 20001 });
  const original = row.querySelector.bind(row);
  const notice = {};
  const max = { value: '20001', setAttribute(name, value) { this[name] = value; } };
  row.querySelector = (selector) => selector === '[data-diagram-import-aggregation-errors]' ? notice : selector.includes('maxLabelChars') ? max : original(selector);
  const { syncDiagramImportAggregationValidationClient: sync } = helpers([...configNames, 'syncDiagramImportAggregationValidationClient'], { t });
  const target = { closest: () => row };
  sync(target);
  assert.equal(notice.textContent, 'diagramImportAggregationMaxError');
  assert.equal(notice.hidden, false);
  assert.equal(max['aria-invalid'], 'true');
  assert.equal(max.value, '20001');
  max.value = '64';
  sync(target);
  assert.equal(notice.hidden, true);
  assert.equal(max['aria-invalid'], 'false');
});

test('ordered grouping picker uses the exact stage and preserves invalid selected fields without preload', () => {
  const calls = [];
  const { renderDiagramImportAggregationClient: render } = helpers([...configNames, 'renderDiagramImportAggregationClient'], {
    t, escapeHtml, state: {}, defaultSpec: () => ({}),
    renderDiagramImportStageFields(spec, stage, selected, attribute) {
      calls.push({ spec, stage, selected });
      return `<input ${attribute} value="${escapeHtml(selected[0])}">`;
    }
  });
  const spec = {};
  const html = render({ id: 'rule', sourceStageId: 'exact-stage', aggregation: { enabled: true, groupBy: ['B', 'missing"<field>', 'A'] } }, spec);
  assert.deepEqual(calls.map((call) => call.stage), ['exact-stage', 'exact-stage', 'exact-stage']);
  assert.ok(calls.every((call) => call.spec === spec));
  assert.deepEqual(calls.flatMap((call) => call.selected), ['B', 'missing"<field>', 'A']);
  assert.match(html, /missing&quot;&lt;field&gt;/);
  assert.match(html, /min="64" max="20000" step="1"/);
  for (const action of ['add', 'remove', 'up', 'down']) assert.match(html, new RegExp(`data-diagram-import-aggregation-action="${action}"`));
  assert.doesNotMatch(functionSource('renderDiagramImportAggregationClient'), /ensureCatalog|fetch\(/);
});

test('32-field safety is visible and oversized existing lists are not silently truncated', () => {
  const { renderDiagramImportAggregationClient: render } = helpers([...configNames, 'renderDiagramImportAggregationClient'], {
    t, escapeHtml, state: {}, defaultSpec: () => ({}), renderDiagramImportStageFields: () => '<input>'
  });
  for (const size of [32, 33]) {
    const html = render({ aggregation: { enabled: true, groupBy: Array.from({ length: size }, (_, index) => `field${index}`) } }, {});
    assert.equal((html.match(/data-diagram-import-aggregation-row/g) || []).length, size);
    assert.match(html, /data-diagram-import-aggregation-action="add"[^>]* disabled/);
    assert.match(html, new RegExp(`diagramImportAggregationLimit:${size}`));
    assert.equal(html.includes('diagramImportAggregationGroupError'), size > 32);
  }
});

test('add, remove, and arrow actions mutate the captured applied rule, not the pending proposal', () => {
  const proposal = { relationRules: [{ id: 'applied-rule', aggregation: { enabled: true, groupBy: ['A', 'B', 'C'] } }] };
  let stored;
  let renders = 0;
  const { mutateDiagramImportAggregationClient: mutate } = helpers([...configNames, 'mutateDiagramImportAggregationClient'], {
    t, captureDiagramImportProposalFromDom: () => proposal,
    document: { querySelectorAll: () => [] },
    storeDiagramImportEditorMutation: (value) => { stored = value; }, renderDesigner: () => { renders += 1; }
  });
  const action = (name, index) => mutate({ closest: () => ({ getAttribute: () => 'applied-rule' }), getAttribute: (key) => key.endsWith('action') ? name : String(index) });
  action('up', 1);
  assert.deepEqual(proposal.relationRules[0].aggregation.groupBy, ['B', 'A', 'C']);
  action('down', 1);
  assert.deepEqual(proposal.relationRules[0].aggregation.groupBy, ['B', 'C', 'A']);
  action('remove', 0);
  action('add', 2);
  assert.deepEqual(proposal.relationRules[0].aggregation.groupBy, ['C', 'A', '']);
  assert.equal(stored, proposal);
  assert.equal(renders, 4);
});

test('applied capture survives source change, tab switch, and normal Save with a separate pending proposal', () => {
  const config = { enabled: true, groupBy: ['missing', 'Protocol'], format: 'tree', duplicates: 'preserve', maxLabelChars: 8192 };
  const row = relationRow(config, { sourceStageId: 'new-stage', labelTemplate: 'Service ${Protocol}', mode: 'attributeEndpoints' });
  const applied = { version: 3, editorMode: 'applied', diagramId: 'diagram', roles: [], relationRules: [{ id: 'rule', sourceStageId: 'old-stage' }] };
  const pending = { version: 3, relationRules: [{ id: 'pending-rule' }] };
  let visible = true;
  let stored;
  const state = { selectedTemplate: { spec: {} }, diagramImportProposal: pending };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const api = helpers([...configNames, 'captureDiagramImportProposalFromDom', 'diagramImportSpecWithSavedEditor'], {
    t, state, D2_IMPORT_SEMANTIC_MODEL_REVISION: 1, D2_IMPORT_STRUCTURE_TREE_VERSION: 1, D2_IMPORT_ENDPOINT_PROFILE_VERSION: 1,
    defaultSpec: () => ({}), appliedDiagramImportEditorModel: () => applied,
    activeDiagramImportEditorModel: () => { throw new Error('Must not capture pending Assistant proposal'); },
    diagramImportStructureTreeClient: () => ({ version: 1, items: [] }),
    document: {
      querySelector: (selector) => selector.includes('editor-mode="applied"') ? {} : null,
      querySelectorAll: (selector) => visible && selector === '[data-diagram-import-rule-row]' ? [row] : [],
      getElementById: () => null
    },
    refreshDiagramImportSemanticState: () => {}, storeDiagramImportEditorModel: (value) => { stored = value; },
    diagramImportEditorIsApplied: () => true, diagramImportAppliedEditorHasUnsavedChanges: () => true,
    markImportedDiagramChanged: () => {}, diagramImportAuthoringOverrides: (proposal) => ({ relationRules: clone(proposal.relationRules) }),
    cloneSpecForEdit: clone, cloneJsonValue: clone, templateAuthoringClient: () => ({ d2: {} })
  });
  const captured = api.captureDiagramImportProposalFromDom();
  assert.equal(captured, applied);
  assert.equal(stored, applied);
  assert.deepEqual(captured.relationRules[0].aggregation, config);
  assert.equal(captured.relationRules[0].sourceStageId, 'new-stage');
  assert.equal(captured.relationRules[0].labelTemplate, 'Service ${Protocol}');
  assert.equal(state.diagramImportAppliedEditorDirty, true);
  visible = false;
  api.captureDiagramImportProposalFromDom();
  const saved = api.diagramImportSpecWithSavedEditor({}, applied);
  assert.deepEqual(saved.result.diagrams[0].authoring.d2Import.relationRules[0].aggregation, config);
  assert.deepEqual(pending.relationRules, [{ id: 'pending-rule' }]);
});

test('relation label autocomplete is source-bound, expression-only, keyboard-selectable, and reuses insertion', () => {
  const state = { selectedTemplate: { spec: {} } };
  const list = { hidden: true, innerHTML: '' };
  const host = { querySelector: () => list };
  const row = { getAttribute: () => '0', querySelector: () => ({ value: 'selected-stage' }) };
  const attrs = {};
  const input = {
    value: 'TCP ${Pr', selectionStart: 8,
    closest: () => row, setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: (key) => { delete attrs[key]; },
    focus: () => {}, setSelectionRange: () => {}, dispatchEvent: () => {}
  };
  const { renderDiagramImportAggregationLabelAutocompleteClient: render, selectDiagramImportLabelAutocompleteCandidate: select } = helpers([
    'diagramImportLabelAutocompleteQuery', 'diagramImportAggregationLabelCandidatesClient', 'renderDiagramImportAggregationLabelAutocompleteClient', 'selectDiagramImportLabelAutocompleteCandidate'
  ], {
    state, t, escapeHtml, diagramImportLabelAutocompleteHost: () => host,
    closeDiagramImportLabelAutocomplete: () => { list.hidden = true; state.diagramImportLabelAutocomplete = null; },
    diagramTemplateParameterTokenRows: () => [{ value: 'param.Protocol', label: 'Protocol parameter' }],
    diagramImportStageFieldOptions: (_spec, stage, query) => { assert.equal(stage, 'selected-stage'); assert.equal(query, 'Pr'); return [{ value: 'Protocol', label: 'Protocol field' }, { value: 'Private', label: 'Private field' }]; },
    ensureDiagramImportAggregationLabelAttributesClient: () => false,
    ensureDiagramImportRelatedLabelField: () => {}, defaultSpec: () => ({})
  });
  render(input);
  assert.equal(list.hidden, false);
  assert.match(list.innerHTML, /Protocol/);
  assert.equal(state.diagramImportLabelAutocomplete.matchIndexes.length, 3);
  render(input, 1);
  assert.equal(state.diagramImportLabelAutocomplete.activeIndex, 1);
  select(input, 1);
  assert.equal(input.value, 'TCP ${Protocol}');
  input.value = 'outside expression';
  input.selectionStart = input.value.length;
  render(input);
  assert.equal(list.hidden, true);
});

function labelAutocompleteFixture() {
  const state = {
    selectedTemplate: { spec: {} }, catalog: { classes: [{ name: 'SelectedClass', attributes: [] }] },
    catalogAttributeLoads: {}, catalogAttributeLoaded: {}, catalogAttributeFailedAt: {}
  };
  const list = { hidden: true, innerHTML: '' };
  const stage = { value: 'selected-stage' };
  const row = { getAttribute: () => '0', querySelector: () => stage };
  const requests = [];
  let traversals = 0;
  let connected = true;
  const input = {
    value: '${dp', selectionStart: 4, closest: () => row,
    setAttribute() {}, removeAttribute() {}, focus() {}, dispatchEvent() {},
    setSelectionRange(start) { this.selectionStart = start; }
  };
  const api = helpers([
    'diagramImportLabelAutocompleteQuery', 'diagramImportAggregationLabelCandidatesClient',
    'ensureDiagramImportAggregationLabelAttributesClient', 'renderDiagramImportAggregationLabelAutocompleteClient',
    'selectDiagramImportLabelAutocompleteCandidate', 'catalogAttributeLoadKey', 'ensureCatalogAttributesForClass'
  ], {
    state, t, escapeHtml, defaultSpec: () => ({}), apiPrefix: '/cmdbuild/custom-api',
    document: { contains: () => connected },
    diagramImportLabelAutocompleteHost: () => ({ querySelector: () => list }),
    closeDiagramImportLabelAutocomplete: () => { list.hidden = true; state.diagramImportLabelAutocomplete = null; },
    diagramTemplateParameterTokenRows: () => [{ value: 'param.Protocol', label: 'Protocol' }],
    diagramImportStageById: (_spec, id) => ({ id }),
    diagramImportPrimaryCardSourceClient: () => ({ source: { className: 'SelectedClass' } }),
    diagramImportStageCardSourcesClient: () => { throw new Error('Must use the selected card source'); },
    diagramImportStageFieldOptions: (_spec, id, query) => {
      traversals += 1;
      assert.equal(id, 'selected-stage');
      assert.ok(query.trim());
      return state.catalog.classes[0].attributes.map((item) => ({ value: item.name, label: item.name }));
    },
    request: (url) => new Promise((resolve) => { requests.push({ url, resolve }); }),
    mergeCatalogClassAttributes: (_name, attributes) => {
      state.catalog.classes[0].attributes = attributes;
      state.catalogAttributeLoaded.selectedclass = true;
      return true;
    },
    errorText: () => 'Unavailable', clientLog() {}, ensureDiagramImportRelatedLabelField() {}
  });
  return { api, state, list, input, stage, requests, traversals: () => traversals, disconnect: () => { connected = false; } };
}

const finishAttributeLoad = async (fixture, ok = true) => {
  fixture.requests[0].resolve({ ok, json: { data: Array.from({ length: 20 }, (_, i) => ({ name: i ? `dport${i}` : 'dport' })) } });
  await new Promise((resolve) => setImmediate(resolve));
};

test('cold label search lazily loads selected attributes, deduplicates in flight, and bounds cached results', async () => {
  const fixture = labelAutocompleteFixture();
  const render = fixture.api.renderDiagramImportAggregationLabelAutocompleteClient;
  fixture.input.value = '${';
  fixture.input.selectionStart = 2;
  render(fixture.input);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.traversals(), 0);
  assert.match(fixture.list.innerHTML, /param.Protocol/);
  fixture.input.value = '${dp';
  fixture.input.selectionStart = 4;
  render(fixture.input);
  render(fixture.input);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url, '/cmdbuild/custom-api/model/classes/SelectedClass/attributes');
  assert.match(fixture.list.innerHTML, /fieldPickerLoading/);
  await finishAttributeLoad(fixture);
  assert.match(fixture.list.innerHTML, /dport/);
  assert.equal(fixture.state.diagramImportLabelAutocomplete.matchIndexes.length, 12);
  render(fixture.input);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.state.catalogAttributeLoads.selectedclass, undefined);
});

test('late metadata responses never reopen or overwrite a stale query, source, template, or detached editor', async () => {
  for (const stale of ['query', 'caret', 'source', 'template', 'spec', 'detached', 'dismissed']) {
    const fixture = labelAutocompleteFixture();
    fixture.api.renderDiagramImportAggregationLabelAutocompleteClient(fixture.input);
    const html = fixture.list.innerHTML;
    const active = fixture.state.diagramImportLabelAutocomplete;
    if (stale === 'query') fixture.input.value = '${other';
    if (stale === 'caret') fixture.input.selectionStart = 3;
    if (stale === 'source') fixture.stage.value = 'different-stage';
    if (stale === 'template') fixture.state.selectedTemplate = { spec: {} };
    if (stale === 'spec') fixture.state.selectedTemplate.spec = {};
    if (stale === 'detached') fixture.disconnect();
    if (stale === 'dismissed') fixture.state.diagramImportLabelAutocomplete = null;
    await finishAttributeLoad(fixture);
    assert.equal(fixture.list.innerHTML, html, stale);
    assert.equal(fixture.state.diagramImportLabelAutocomplete, stale === 'dismissed' ? null : active, stale);
  }
});

test('parameter hints remain usable without metadata traversal and after an attribute failure', async () => {
  const fixture = labelAutocompleteFixture();
  const render = fixture.api.renderDiagramImportAggregationLabelAutocompleteClient;
  fixture.input.value = '${param.';
  fixture.input.selectionStart = fixture.input.value.length;
  render(fixture.input);
  assert.match(fixture.list.innerHTML, /param.Protocol/);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.traversals(), 0);
  fixture.input.value = '${dp';
  fixture.input.selectionStart = 4;
  render(fixture.input);
  await finishAttributeLoad(fixture, false);
  assert.equal(fixture.requests.length, 1);
  assert.doesNotMatch(fixture.list.innerHTML, /fieldPickerLoading/);
  fixture.input.value = '${param.';
  fixture.input.selectionStart = fixture.input.value.length;
  render(fixture.input);
  fixture.api.selectDiagramImportLabelAutocompleteCandidate(fixture.input, 0);
  assert.equal(fixture.input.value, '${param.Protocol}');
});

test('shared insertion replaces the complete closed token and preserves surrounding text and focus position', () => {
  const fixture = labelAutocompleteFixture();
  fixture.input.value = 'prefix ${dport} suffix';
  fixture.input.selectionStart = fixture.input.value.indexOf('dport') + 2;
  fixture.state.diagramImportLabelAutocomplete = { input: fixture.input, candidates: [{ displayToken: 'dport' }] };
  fixture.api.selectDiagramImportLabelAutocompleteCandidate(fixture.input, 0);
  assert.equal(fixture.input.value, 'prefix ${dport} suffix');
  assert.equal(fixture.input.selectionStart, 'prefix ${dport}'.length);
  fixture.input.value = 'prefix ${dp suffix ${other}';
  fixture.input.selectionStart = 'prefix ${dp'.length;
  const query = fixture.api.diagramImportLabelAutocompleteQuery(fixture.input);
  assert.equal(query.end, fixture.input.selectionStart, 'An unfinished expression must not eat the next token');
});

test('pure label change captures and stores without scheduling a full Designer render', () => {
  const start = source.indexOf("  document.addEventListener('change', function (event) {\n    var target = event.target;");
  const end = source.indexOf("\n  window.addEventListener('popstate'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let captures = 0;
  let stores = 0;
  let renders = 0;
  let scheduled = 0;
  const proposal = {};
  new Function('document', 'window', 'captureDiagramImportProposalFromDom', 'storeDiagramImportEditorMutation', 'renderDesigner', 'syncDiagramImportAggregationValidationClient', source.slice(start, end))(
    { addEventListener: (_name, callback) => { handler = callback; } },
    { setTimeout: () => { scheduled += 1; } },
    () => { captures += 1; return proposal; },
    (value) => { assert.equal(value, proposal); stores += 1; },
    () => { renders += 1; }, () => {}
  );
  for (const attribute of ['data-diagram-import-label-template', 'data-diagram-import-aggregation-label-template']) {
    handler({ target: { matches: (selector) => selector.includes(attribute) || selector.includes('[data-diagram-import-placement-field],') } });
  }
  assert.equal(captures, 2);
  assert.equal(stores, 2);
  assert.equal(renders, 0);
  assert.equal(scheduled, 0);
});

function diagramFixture() {
  return {
    nodes: [{ id: 'INTERNAL_SOURCE', label: 'Source <A>' }, { id: 'INTERNAL_TARGET', label: 'Target B' }],
    edges: [{ id: 'INTERNAL_EDGE', source: 'INTERNAL_SOURCE', target: 'INTERNAL_TARGET', data: {
      aggregation: { memberCount: 2, connectionCount: 3, groups: [{ id: 'INTERNAL_GROUP' }], labelTruncated: true, hiddenValues: 5,
        members: [{ id: 'INTERNAL_MEMBER', label: '<script>member</script>', data: { fields: { Protocol: 'TCP', Description: '<img onerror="bad">' }, runtimeRow: { secret: 'DO_NOT_RENDER' } } }] }
    } }],
    execution: { aggregation: [{ id: 'INTERNAL_RULE', label: 'Service links', inputEdges: 3, outputEdges: 1, uniqueRecords: 2, truncatedLabels: 1 }] }
  };
}

test('aggregation details display diagnostics and safe member fields, never internal IDs or runtimeRow', () => {
  const { renderDiagramAggregationDetailsClient: render } = helpers(['renderDiagramAggregationDetailsClient'], { t, escapeHtml });
  const html = render(diagramFixture());
  assert.match(html, /Service links/);
  assert.match(html, /Source &lt;A&gt; → Target B/);
  assert.match(html, /diagramImportAggregationConnections: 3/);
  assert.match(html, /diagramImportAggregationHidden: 5/);
  assert.match(html, /diagramImportAggregationTruncatedNotice/);
  assert.match(html, /&lt;script&gt;member&lt;\/script&gt;/);
  assert.match(html, /Protocol/);
  assert.match(html, /TCP/);
  assert.doesNotMatch(html, /INTERNAL_|DO_NOT_RENDER|runtimeRow|<script>|<img /);
  assert.equal(render({}), '');
});

test('aggregation details are present with D2 SVG, fallback diagram, and empty topology', () => {
  for (const mode of ['d2', 'fallback', 'empty']) {
    const { renderResultDiagram: render } = helpers(['renderDiagramAggregationDetailsClient', 'renderResultDiagram'], {
      t, escapeHtml, DEFAULT_EMPTY_RESULT_TEXT: 'Empty', renderDiagramToolbar: () => '',
      renderD2SvgContent: () => mode === 'd2' ? '<svg></svg>' : '', renderD2UnavailableNotice: () => '',
      renderDiagramSvgContract: () => '', renderDiagramViewport: (html) => html, isSafeRuntimeLinkUrlClient: () => false
    });
    const diagram = diagramFixture();
    if (mode === 'empty') diagram.nodes = [];
    assert.match(render(diagram), /data-diagram-import-aggregation-diagnostics/);
  }
});

test('generic input and change handlers recognize aggregation controls and source changes do not preload', () => {
  const start = source.indexOf("  document.addEventListener('input', function (event)");
  const end = source.indexOf("    if (target.id === 'cmdp-diagram-import-file')", start);
  const events = source.slice(start, end);
  assert.ok(events.split('[data-diagram-import-aggregation-field]').length >= 4);
  const stageStart = events.indexOf("target.matches('[data-diagram-import-rule-field=\"sourceStageId\"]')");
  const stageEnd = events.indexOf('\n    if (target.matches', stageStart + 1);
  const stageChange = events.slice(stageStart, stageEnd);
  assert.match(stageChange, /captureDiagramImportProposalFromDom/);
  assert.doesNotMatch(stageChange, /ensureCatalog|delete .*aggregation/);
});
