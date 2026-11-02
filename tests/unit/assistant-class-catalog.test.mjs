import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const functionNames = [
  'responseDataArray', 'responseTotalCount', 'assistantLimitDiagnostic', 'mcpReadModelSummary',
  'assistantClassMetadataReadable', 'assistantClassMetadataSummary', 'assistantClassExactScore',
  'assistantExactClassMatches', 'assistantClassTextScore', 'assistantCandidateClassesFromSummary',
  'assistantExactClassCandidatesFromSummary', 'normalizedAssistantLookupText', 'isCmdbuildIdentifierText',
  'assistantClassMentionsFromText', 'assistantTrimClassMentionText', 'assistantExpectedResultClassMentions',
  'assistantClassMentionAlternatives', 'assistantMcpSummaryClasses', 'assistantSemanticClassBindings',
  'assistantResolveExplicitClassMetadata', 'assistantMcpResult', 'assistantObjectFlowMcpPayload',
  'cmdbuildClassAttributesPath', 'sanitizeVisibleClassAttributes', 'sanitizeAttribute',
  'boundedMcpText', 'compactMcpValue', 'mcpResultEnvelope', 'mcpTimeoutMs',
  'prepareAssistantObjectFlowSemanticPlanContext', 'assistantSemanticPlanError'
];

// Test private functions without adding runtime exports to the shared server.
function harness(overrides = {}) {
  const globals = {
    Buffer, Date, Set, Map,
    uniqueStrings: (items) => [...new Set(items)],
    toPositiveInt: (value, fallback, max) => Math.min(max, Math.max(1, Number(value) || fallback)),
    hashJson: () => 'test-revision',
    truncateText: (value, length) => String(value).slice(0, length),
    pickBooleans: (item, keys) => Object.fromEntries(keys.filter((key) => typeof item[key] === 'boolean').map((key) => [key, item[key]])),
    ASSISTANT_MCP_MAX_CLASSES_ABSOLUTE: 10000,
    ASSISTANT_MCP_MAX_DOMAINS_ABSOLUTE: 10000,
    DEFAULT_ASSISTANT_MCP_MAX_CONTEXT_BYTES: 100000,
    ASSISTANT_SEMANTIC_PLAN_CHECKPOINT_VERSION: 1,
    normalizeAssistantObjectFlowIntent: (intent) => intent,
    normalizeAssistantRuntimeConfig: (config) => config,
    ensureAssistantReady: () => {},
    objectFlowFromSpecServer: (spec) => spec,
    assistantObjectFlowContextSpec: (spec) => spec,
    assistantObjectFlowIntentPlanningText: (intent) => JSON.stringify(intent),
    assistantSemanticPlanCheckpointInputHash: () => 'hash',
    assistantSemanticPlanCheckpointTtlMs: () => 60000,
    assistantFinalizeSemanticContext: async () => {},
    ...overrides
  };
  vm.createContext(globals);
  for (const name of functionNames) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(match, name);
    const end = source.indexOf('\n}\n', match.index);
    vm.runInContext(source.slice(match.index, end + 3), globals, { filename: name });
  }
  return globals;
}

const config = () => ({ mcp: {
  enabled: true, maxClasses: 8, maxDomains: 8, maxContextBytes: 100000, timeoutMs: 10000,
  allowedTools: ['cmdbuild_model_summary', 'cmdbuild_class_fields']
} });
const response = (data, extra = {}) => ({ ok: true, statusCode: 200, json: { data, ...extra } });
const intent = (mention) => ({ blocks: [{ id: 'b1', name: 'Items', entities: `класс "${mention}"`, algorithm: '', expectedResult: '' }] });
const context = (classes = [], catalog = { fetched: classes.length, visible: classes.length, total: classes.length, pages: 1, complete: true, reason: '' }) => ({
  enabled: true, diagnostics: { contextClassNames: classes.map((item) => item.name), limits: [] },
  results: [{ tool: 'cmdbuild_model_summary', ok: true, result: { classes, domains: [], classCatalog: catalog } }]
});

test('totals reject coercion of null, blank, boolean, negative and fractional counts', () => {
  const h = harness();
  for (const total of [null, undefined, '', ' ', false, true, -1, 1.5, {}, []]) {
    assert.equal(h.responseTotalCount({ json: { total } }), null);
  }
  assert.equal(h.responseTotalCount({ json: { total: null, meta: { total: '12' } } }), 12);
  assert.equal(h.responseTotalCount({ json: { totalCount: '0' } }), 0);
  assert.equal(h.responseTotalCount({ json: { count: 0, size: 3, meta: { total: 12 } } }), 12);
  assert.equal(h.responseTotalCount({ json: { count: 3, size: 3 } }), null);
});

test('metadata name outranks exact descriptions; complete catalogs bind original and translated descriptions', () => {
  const h = harness();
  const classes = [{ name: 'Asset', description: 'Record' }, { name: 'Other', description: 'Asset' },
    { name: 'Device', description: 'Устройство', originalDescription: 'Equipment', translatedDescription: 'Устройство' }];
  assert.equal(h.assistantExactClassCandidatesFromSummary({ classes }, ['Asset'])[0], 'Asset');
  for (const mention of ['Equipment', 'Устройство']) {
    const binding = h.assistantSemanticClassBindings(intent(mention), context(classes)).bindings[0];
    assert.equal(binding.className, 'Device');
    assert.equal(binding.matchSource, 'description');
    assert.equal(binding.evidenceSource, 'classCatalog');
  }
  assert.equal(h.assistantCandidateClassesFromSummary({ classes }, ['Asset'], 8)[0].name, 'Asset');
  assert.equal(h.assistantSemanticClassBindings(intent('Asset'), context(classes)).bindings[0].className, 'Asset');
});

test('partial score, aliases, parent, card Code and transliteration never automatically bind', () => {
  const h = harness();
  for (const item of [
    { name: 'AssetSpecial', description: 'Asset extended' },
    { name: 'Other', alias: 'Asset', parent: 'Asset', Code: 'Asset' },
    { name: 'Server', description: 'Infrastructure' }
  ]) {
    const mention = item.name === 'Server' ? 'Сервер' : 'Asset';
    const result = h.assistantSemanticClassBindings(intent(mention), context([item]));
    assert.equal(result.bindings.length, 0);
    assert.equal(result.errors[0].kind, 'semanticPlanClassUnavailable');
  }
  assert.equal(h.assistantCandidateClassesFromSummary({ classes: [{ Code: 'Asset', description: 'Asset' }] }, ['Asset'], 8).length, 0);
});

test('exact descriptions stay ambiguous and a conjunction resolves all classes', () => {
  const h = harness();
  const classes = [{ name: 'One', description: 'Record' }, { name: 'Two', description: 'Record' }];
  assert.equal(h.assistantSemanticClassBindings(intent('Record'), context(classes)).errors[0].kind, 'semanticPlanClassAmbiguous');
  assert.equal(h.assistantSemanticClassBindings(intent('One and Two'), context(classes)).bindings.length, 2);
});

test('summary paginates overlapping pages with raw offsets and hides denied metadata', async () => {
  const requests = [];
  const h = harness({ cmdbuildRequest: async (path, token, options) => {
    requests.push({ path, token, options });
    if (path.includes('/domains?')) return response([]);
    const start = Number(new URL(path, 'http://test').searchParams.get('start'));
    if (start === 0) return response([{ name: 'One' }, { name: 'Two' }], { total: null, meta: { total: 4 } });
    if (start === 2) return response([{ name: 'Two' }, { name: 'Hidden', description: 'DO_NOT_EXPOSE', permissions: { _can_read: false } }], { meta: { total: 4 } });
    return response([{ name: 'Four', description: 'Original', _description_translation: 'Translated' }], { meta: { total: 4 } });
  } });
  const summary = await h.mcpReadModelSummary('same-session', {}, config());
  assert.equal(summary.classCatalog.fetched, 5);
  assert.equal(summary.classCatalog.visible, 3);
  assert.equal(summary.classCatalog.complete, true);
  assert.equal(summary.classCatalog.denied, 1);
  assert.deepEqual(requests.filter((item) => item.path.includes('/classes?')).map((item) => new URL(item.path, 'http://test').searchParams.get('start')), ['0', '2', '4']);
  assert.ok(requests.every((item) => item.token === 'same-session' && item.options.deadlineAt > 0));
  assert.equal(JSON.stringify(summary).includes('Hidden'), false);
  assert.equal(JSON.stringify(summary).includes('DO_NOT_EXPOSE'), false);
  assert.equal(summary.classes.at(-1).originalDescription, 'Original');
  assert.equal(summary.classes.at(-1).translatedDescription, 'Translated');
});

test('unknown totals, repeated pages and invalid identifiers cannot spin or imply completeness', async () => {
  for (const rows of [[{ name: 'One' }], [{ name: '' }]]) {
    let calls = 0;
    const h = harness({ cmdbuildRequest: async (path) => {
      if (path.includes('/domains?')) return response([]);
      calls += 1;
      return response(rows);
    } });
    const result = await h.mcpReadModelSummary('s', {}, config());
    assert.equal(result.classCatalog.complete, false);
    assert.ok(calls <= 2);
    assert.equal(result.classCatalog.reason, 'incomplete');
  }
});

test('fetched budget caps scans and known exact boundary is complete, not cap-hit', async () => {
  for (const total of [8, 20]) {
    const h = harness({ cmdbuildRequest: async (path) => path.includes('/domains?') ? response([])
      : response(Array.from({ length: 8 }, (_, i) => ({ name: `Item${i}` })), { total }) });
    const summary = await h.mcpReadModelSummary('s', {}, config());
    assert.equal(summary.classCatalog.fetched, 8);
    assert.equal(summary.classCatalog.complete, total === 8);
    assert.equal(summary.limits[0].limitHit, total !== 8);
  }
});

test('empty catalog distinguishes absence, permission, request failure and deadline', async () => {
  for (const [statusCode, reason] of [[200, 'absent'], [403, 'permission'], [503, 'incomplete']]) {
    const h = harness({ cmdbuildRequest: async () => ({ ...response([], { total: 0 }), ok: statusCode === 200, statusCode }) });
    const summary = await h.mcpReadModelSummary('s', {}, config());
    const issue = h.assistantSemanticClassBindings(intent('Missing'), context(summary.classes, summary.classCatalog)).errors[0];
    assert.equal(issue.kind, 'semanticPlanClassUnavailable');
    assert.equal(issue.reason, reason === 'incomplete' ? 'incomplete' : reason);
    assert.equal(summary.limits[0].limitHit, false);
  }
  const h = harness({ cmdbuildRequest: () => { throw new Error('Must not request after deadline'); } });
  const summary = await h.mcpReadModelSummary('s', {}, config(), { deadlineAt: Date.now() - 1 });
  assert.equal(summary.classCatalog.reason, 'timeout');
  assert.equal(h.assistantSemanticClassBindings(intent('Missing'), context([], summary.classCatalog)).errors[0].reason, 'timeout');
});

test('same-session metadata lookup provides verified metadata and readable fields for finalization', async () => {
  const calls = [];
  const h = harness({ cmdbuildRequest: async (path, token, options) => {
    calls.push({ path, token, options });
    return path.includes('/attributes?')
      ? response([{ name: 'Title' }, { name: 'Secret', _can_read: false }, { name: 'NestedSecret', permissions: { _can_read: false } }, { name: 'Inactive', active: false }])
      : response({ name: 'NewAsset', description: 'Original', _description_translation: 'Translated' });
  } });
  const ctx = context([], { fetched: 8, visible: 8, total: 20, complete: false, reason: 'maxClasses' });
  const deadline = Date.now() + 5000;
  await h.assistantResolveExplicitClassMetadata(intent('NewAsset'), ctx, 'session-a', config(), deadline);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((item) => item.token === 'session-a' && item.options.deadlineAt === deadline));
  assert.ok(calls[0].path.endsWith('/classes/NewAsset'));
  assert.equal(ctx.diagnostics.classLookups[0].status, 'found');
  const metadata = ctx.results.find((item) => item.tool === 'cmdbuild_model_summary').result.classes[0];
  const fields = ctx.results.find((item) => item.tool === 'cmdbuild_class_fields').result[0];
  assert.equal(metadata.name, 'NewAsset');
  assert.equal(metadata.originalDescription, 'Original');
  assert.equal(metadata.translatedDescription, 'Translated');
  assert.deepEqual(fields.attributes.map((item) => item.name), ['Title']);
  assert.equal(h.assistantSemanticClassBindings(intent('NewAsset'), ctx).bindings[0].className, 'NewAsset');
});

test('exact English descriptions in complete catalogs and invalid identifiers never trigger direct lookup', async () => {
  const h = harness({ cmdbuildRequest: () => { throw new Error('Unexpected lookup'); } });
  for (const mention of ['Equipment', 'Some description', '../Unsafe']) {
    const ctx = context([{ name: 'Device', description: 'Equipment' }]);
    await h.assistantResolveExplicitClassMetadata(intent(mention), ctx, 's', config(), Date.now() + 1000);
    assert.equal(ctx.diagnostics.classLookups.length, 0);
    if (mention === 'Equipment') assert.equal(h.assistantSemanticClassBindings(intent(mention), ctx).bindings[0].className, 'Device');
  }
});

test('lookup distinguishes 404, permission, unreadable metadata and fields failures', async () => {
  for (const scenario of [
    { metadata: { ok: false, statusCode: 404 }, reason: 'absent' },
    { metadata: { ok: false, statusCode: 403 }, reason: 'permission' },
    { metadata: response({ name: 'Missing', _can_read: false, description: 'DO_NOT_EXPOSE' }), reason: 'permission' },
    { metadata: response({ name: 'Missing', permissions: { _can_read: false } }), reason: 'permission' },
    { metadata: response({ name: 'WrongName' }), reason: 'invalidMetadata' },
    { metadata: response({ name: 'Missing' }), fields: { ok: false, statusCode: 403 }, reason: 'permission' },
    { metadata: response({ name: 'Missing' }), fields: { ok: false, statusCode: 503 }, reason: 'fieldsUnavailable' },
    { metadata: response({ name: 'Missing' }), fields: response(null), reason: 'fieldsUnavailable' }
  ]) {
    const h = harness({ cmdbuildRequest: async (path) => path.includes('/attributes?') ? scenario.fields : scenario.metadata });
    const ctx = context();
    await h.assistantResolveExplicitClassMetadata(intent('Missing'), ctx, 's', config(), Date.now() + 5000);
    const issue = h.assistantSemanticClassBindings(intent('Missing'), ctx).errors[0];
    assert.equal(issue.reason, scenario.reason);
    assert.equal(issue.lookup.className, 'Missing');
    assert.equal(issue.catalogCompleteness.visible, 0);
    assert.equal(JSON.stringify(ctx).includes('DO_NOT_EXPOSE'), false);
    assert.equal(h.assistantMcpSummaryClasses(ctx).length, 0);
  }
});

test('partial descriptions cannot cancel a same-session technical-name lookup', async () => {
  const calls = [];
  const h = harness({ cmdbuildRequest: async (path, token) => {
    calls.push({ path, token });
    return path.includes('/attributes?') ? response([{ name: 'Title' }])
      : response({ name: 'Asset', description: 'Actual asset' });
  } });
  const ctx = context([{ name: 'Other', description: 'Asset' }], { complete: false, reason: 'maxClasses' });
  assert.equal(h.assistantSemanticClassBindings(intent('Asset'), ctx).errors[0].reason, 'descriptionUnverified');
  await h.assistantResolveExplicitClassMetadata(intent('Asset'), ctx, 'same-session', config(), Date.now() + 5000);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].path.endsWith('/classes/Asset'));
  assert.ok(calls.every((call) => call.token === 'same-session'));
  const result = h.assistantSemanticClassBindings(intent('Asset'), ctx);
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings[0].className, 'Asset');
  assert.equal(result.bindings[0].matchSource, 'name');
  assert.equal(result.bindings[0].evidenceSource, 'sameSessionLookup');
});

test('404 proves only nameNotFound; description requires a complete unique catalog', async () => {
  for (const descriptions of [[], [{ name: 'Device', description: 'Equipment' }],
    [{ name: 'Device', originalDescription: 'Equipment' }],
    [{ name: 'Device', translatedDescription: 'Equipment' }],
    [{ name: 'One', description: 'Equipment' }, { name: 'Two', description: 'Equipment' }]]) {
    const h = harness({ cmdbuildRequest: async () => ({ ok: false, statusCode: 404 }) });
    const ctx = context(descriptions, { complete: false, reason: 'maxClasses' });
    await h.assistantResolveExplicitClassMetadata(intent('Equipment'), ctx, 's', config(), Date.now() + 5000);
    assert.equal(ctx.diagnostics.classLookups.length, 1);
    assert.equal(ctx.diagnostics.classLookups[0].status, 'nameNotFound');
    assert.equal(ctx.diagnostics.classLookups[0].reason, 'nameNotFound');
    const incomplete = h.assistantSemanticClassBindings(intent('Equipment'), ctx);
    assert.equal(incomplete.bindings.length, 0);
    assert.equal(incomplete.errors[0].reason, 'descriptionUnverified');
    ctx.results[0].result.classCatalog = { complete: true, reason: '' };
    const complete = h.assistantSemanticClassBindings(intent('Equipment'), ctx);
    if (descriptions.length === 1) {
      assert.equal(complete.errors.length, 0);
      assert.equal(complete.bindings[0].className, 'Device');
      assert.equal(complete.bindings[0].matchSource, 'description');
      assert.equal(complete.bindings[0].evidenceSource, 'classCatalog');
    } else {
      assert.equal(complete.bindings.length, 0);
      assert.equal(complete.errors[0].reason, descriptions.length ? 'ambiguous' : 'absent');
    }
  }
});

test('known technical names win collisions case-insensitively even in partial catalogs', async () => {
  const h = harness({ cmdbuildRequest: () => { throw new Error('Known name must not trigger lookup'); } });
  for (const complete of [false, true]) {
    const ctx = context([{ name: 'Asset', description: 'Actual asset' }, { name: 'Other', description: 'asset' }],
      { complete, reason: complete ? '' : 'incomplete' });
    await h.assistantResolveExplicitClassMetadata(intent('aSsEt'), ctx, 's', config(), Date.now() + 5000);
    assert.equal(ctx.diagnostics.classLookups.length, 0);
    const result = h.assistantSemanticClassBindings(intent('aSsEt'), ctx);
    assert.equal(result.errors.length, 0);
    assert.equal(result.bindings[0].className, 'Asset');
    assert.equal(result.bindings[0].matchSource, 'name');
  }
});

test('missing completeness and incomplete original or translated descriptions never bind', () => {
  const h = harness();
  for (const catalog of [undefined, { complete: false, reason: 'incomplete' }, { complete: false, reason: 'maxClasses' }]) {
    for (const metadata of [{ name: 'Device', description: 'Equipment' },
      { name: 'Device', originalDescription: 'Equipment' }, { name: 'Device', translatedDescription: 'Устройство' }]) {
      const ctx = context([metadata]);
      ctx.results[0].result.classCatalog = catalog;
      const result = h.assistantSemanticClassBindings(intent(metadata.translatedDescription || 'Equipment'), ctx);
      assert.equal(result.bindings.length, 0);
      assert.equal(result.errors[0].reason, 'descriptionUnverified');
    }
  }
});

test('a complete permission-filtered catalog ignores denied description collisions', () => {
  const h = harness();
  const ctx = context([
    { name: 'Device', description: 'Equipment' },
    { name: 'Denied', description: 'Equipment', permissions: { _can_read: false } }
  ]);
  const result = h.assistantSemanticClassBindings(intent('Equipment'), ctx);
  assert.equal(result.errors.length, 0);
  assert.equal(result.bindings[0].className, 'Device');
  assert.equal(result.bindings[0].matchSource, 'description');
});

test('404 never enables partial, transliterated, alias, parent or Code bindings', async () => {
  const h = harness({ cmdbuildRequest: async () => ({ ok: false, statusCode: 404 }) });
  for (const complete of [false, true]) {
    for (const metadata of [
      { name: 'EquipmentExtended', description: 'Equipment catalog' },
      { name: 'Other', alias: 'Equipment', parent: 'Equipment', Code: 'Equipment' },
      { name: 'Oborudovanie', description: 'Infrastructure' }
    ]) {
      const ctx = context([metadata], { complete, reason: complete ? '' : 'maxClasses' });
      await h.assistantResolveExplicitClassMetadata(intent('Equipment'), ctx, 's', config(), Date.now() + 5000);
      const result = h.assistantSemanticClassBindings(intent('Equipment'), ctx);
      assert.equal(result.bindings.length, 0);
      assert.equal(result.errors[0].reason, complete ? 'absent' : 'descriptionUnverified');
    }
  }
  const result = h.assistantSemanticClassBindings(intent('Оборудование'), context([{ name: 'Oborudovanie' }]));
  assert.equal(result.bindings.length, 0);
});

test('deadline and allowed tools fail closed for explicit resolution', async () => {
  const h = harness({ cmdbuildRequest: async (path) => path.includes('/attributes?')
    ? response([{ name: 'Large', help: 'x'.repeat(10000) }]) : response({ name: 'Missing' }) });
  for (const mode of ['deadline', 'tools']) {
    const ctx = context();
    const cfg = config();
    if (mode === 'tools') cfg.mcp.allowedTools = [];
    await h.assistantResolveExplicitClassMetadata(intent('Missing'), ctx, 's', cfg, Date.now() + (mode === 'deadline' ? -1 : 5000));
    assert.equal(h.assistantSemanticClassBindings(intent('Missing'), ctx).bindings.length, 0);
    assert.equal(ctx.diagnostics.classLookups[0].reason, { deadline: 'timeout', tools: 'toolNotAllowed' }[mode]);
  }
});

test('prepare attaches class diagnostics to binding errors without touching HTTP handling', async () => {
  const ctx = context();
  const h = harness({ buildAssistantMcpContext: async () => ctx,
    cmdbuildRequest: async () => ({ ok: false, statusCode: 404 }) });
  await assert.rejects(h.prepareAssistantObjectFlowSemanticPlanContext({ intent: intent('Missing') }, { runtimeConfig: config(), authToken: 's' }), (error) => {
    assert.equal(error.details[0].kind, 'semanticPlanClassUnavailable');
    assert.equal(error.details[0].reason, 'absent');
    assert.equal(error.diagnostics.mcp.classLookups[0].statusCode, 404);
    return true;
  });
});
