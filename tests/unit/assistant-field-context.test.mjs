import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssistantFieldContext, compactAssistantDataModel, assistantFieldContextWarnings } from '../../scripts/assistant-field-context.mjs';
import { assistantDataSemanticModel, assistantObjectFlowBusinessBlockManifest, assistantDiagramBindingIntentMessages } from '../../scripts/dev-proxy-server.mjs';

const catalog = { classes: [
  { name: 'Base', attributes: [] },
  { name: 'System', parent: 'Base', attributes: [{ name: 'Description', type: 'string' }] },
  { name: 'Network', attributes: [{ name: 'range', type: 'string' }, { name: 'secret', permissions: { _can_read: false } }] },
  { name: 'Application', attributes: [{ name: 'address', type: 'reference', targetClass: 'Address' }, { name: 'management', type: 'reference', targetClass: 'Address' }] },
  { name: 'Address', attributes: [{ name: 'value', description: 'IP address value', type: 'string' }] }
], domains: [{ name: 'owns', sources: ['Base'], destinations: ['Network'], cardinality: '1:N' }] };
const stage = { id: 'selection:systems', className: 'System', columns: ['_id'], cardSources: [{ id: 'current', className: 'System' }] };

const referenceCatalog = { classes: [
  { name: 'Asset', attributes: [
    { name: 'Description', type: 'string' },
    { name: 'owner', type: 'reference', targetClass: 'Person' },
    { name: 'backupOwner', type: 'foreignkey', targetType: 'Person' },
    { name: 'privateOwner', type: 'reference', targetClass: 'Person', permissions: { _can_read: false } },
    { name: 'deniedOwner', type: 'reference', targetClass: 'Denied' }
  ] },
  { name: 'Person', attributes: [
    { name: 'Description', type: 'string' }, { name: 'Code', type: 'string' }, { name: 'Name', type: 'string' },
    { name: 'secret', type: 'string', permissions: { _can_read: false } },
    { name: 'inactive', type: 'string', active: false },
    { name: 'location', type: 'reference', targetClass: 'Location' }
  ] },
  { name: 'Location', attributes: [{ name: 'Name', type: 'string' }] },
  { name: 'Denied', permissions: { _can_read: false }, attributes: [{ name: 'Description' }] },
  { name: 'Unrelated', attributes: [{ name: 'unrelatedField', type: 'string' }] }
], domains: [{ name: 'unrelated', source: 'Asset', destination: 'Unrelated', cardinality: '1:N' }] };

for (const terminal of ['Description', 'Code', 'Name']) {
  test(`explicit reference path to generic ${terminal} is available at default and configured depth 1`, () => {
    const path = `owner.${terminal}`;
    for (const options of [{}, { depth: 1 }]) {
      const result = buildAssistantFieldContext([{ id: 'assets', className: 'Asset' }], referenceCatalog, { ...options, queries: [path] });
      const field = result.stages[0].fields.find((item) => item.path === path);
      assert.ok(field, path);
      assert.equal(field.className, 'Person');
      assert.equal(field.evidence, 'readableCatalog');
      assert.equal(field.cardinality, 'one');
      assert.deepEqual(field.hops.map((hop) => hop.name), ['owner']);
      assert.equal(result.diagnostics.truncated, false);
    }
  });
}

test('explicit nested generic path respects depth and retains alternative exact reference paths', () => {
  const stages = [{ id: 'assets', className: 'Asset' }];
  const queries = ['owner.location.Name', 'backupOwner.location.Name'];
  assert.equal(buildAssistantFieldContext(stages, referenceCatalog, { queries }).stages[0].fields.some((field) => field.path.endsWith('location.Name')), false);
  const result = buildAssistantFieldContext(stages, referenceCatalog, { depth: 2, queries });
  assert.deepEqual(result.stages[0].fields.filter((field) => field.path.endsWith('location.Name')).map((field) => field.path), queries);
  assert.equal(buildAssistantFieldContext(stages, referenceCatalog, { depth: 0, queries: ['owner.Description'] }).stages[0].fields.some((field) => field.hops.length), false);
});

test('generic context without a query includes bounded reference fields, not unrelated domain metadata', () => {
  const result = buildAssistantFieldContext([{ id: 'assets', className: 'Asset' }], referenceCatalog);
  for (const path of ['Description', 'owner.Description', 'owner.Code', 'backupOwner.Name']) {
    assert.ok(result.stages[0].fields.some((field) => field.path === path), path);
  }
  assert.ok(result.stages[0].fields.every((field) => field.hops.length <= 1));
  assert.equal(result.stages[0].fields.some((field) => /secret|inactive|privateOwner|deniedOwner\.|unrelated/.test(field.path)), false);
  assert.equal(result.diagnostics.scannedStates, 3);
  assert.equal(result.diagnostics.truncated, false);
});

test('explicit reference queries cannot expose denied classes, references or attributes', () => {
  const queries = ['owner.secret', 'owner.inactive', 'privateOwner.Description', 'deniedOwner.Description'];
  const result = buildAssistantFieldContext([{ id: 'assets', className: 'Asset' }], referenceCatalog, { queries });
  assert.equal(result.stages[0].fields.some((field) => queries.includes(field.path)), false);
});

test('reference discovery preserves configured state and byte boundaries', () => {
  const stages = [{ id: 'assets', className: 'Asset' }];
  const options = { queries: ['owner.Description'], maxStates: 1 };
  const bounded = buildAssistantFieldContext(stages, referenceCatalog, options);
  assert.equal(bounded.diagnostics.scannedStates, 1);
  assert.equal(bounded.diagnostics.truncated, true);
  assert.equal(bounded.stages[0].fields.some((field) => field.path === 'owner.Description'), false);
  assert.deepEqual(bounded, buildAssistantFieldContext(stages, referenceCatalog, options));
  const full = buildAssistantFieldContext(stages, referenceCatalog, { queries: ['owner.Description'] });
  const exact = buildAssistantFieldContext(stages, referenceCatalog, { queries: ['owner.Description'], maxBytes: full.diagnostics.bytes });
  assert.deepEqual(exact.fieldCatalog, full.fieldCatalog);
  assert.equal(exact.diagnostics.truncated, false);
  const short = buildAssistantFieldContext(stages, referenceCatalog, { queries: ['owner.Description'], maxBytes: full.diagnostics.bytes - 1 });
  assert.ok(short.diagnostics.bytes <= full.diagnostics.bytes - 1);
  assert.equal(short.diagnostics.truncated, true);
});

test('related catalog field includes confirmed superclass path and cardinality without reading rows', () => {
  const result = buildAssistantFieldContext([stage], catalog, { depth: 1, queries: ['range'] });
  const field = result.stages[0].fields.find((f) => f.path === '{owns:Network}.range');
  assert.ok(field);
  assert.equal(field.cardinality, 'many');
  assert.equal(field.hops[0].direction, 'direct');
  assert.equal(field.cardSourceId, 'current');
  assert.equal(result.stages[0].fields.some((f) => f.path.endsWith('.secret')), false);
});

test('explicit reference and alternative reference remain distinct confirmed paths', () => {
  const result = buildAssistantFieldContext([{ id: 'apps', className: 'Application' }], catalog, { depth: 1, queries: ['address.IP address value'] });
  assert.deepEqual(result.stages[0].fields.filter((f) => f.path.endsWith('.value')).map((f) => f.path), ['address.value', 'management.value']);
  assert.ok(result.stages[0].fields.every((f) => f.cardinality === 'one'));
});

test('each side of a relation pair has independent fields and identity', () => {
  const result = buildAssistantFieldContext([{ id: 'pairs', cardSources: [{ id: 'current', className: 'System' }, { id: 'relation-source', className: 'Application' }] }], catalog, { queries: ['value'] });
  assert.ok(result.stages[0].fields.some((f) => f.cardSourceId === 'relation-source' && f.path === 'address.value'));
  assert.equal(result.stages[0].readableFields.includes('address.value'), false);
});

test('depth, byte and scan boundaries are visible and deterministic', () => {
  const shallow = buildAssistantFieldContext([stage], catalog, { depth: 0, queries: ['range'] });
  assert.equal(shallow.stages[0].fields.some((f) => f.hops.length), false);
  const bounded = buildAssistantFieldContext([stage], catalog, { maxStates: 1, queries: ['range'] });
  assert.equal(bounded.diagnostics.truncated, true);
  assert.equal(bounded.diagnostics.maxStates, 1);
  assert.deepEqual(bounded, buildAssistantFieldContext([stage], catalog, { maxStates: 1, queries: ['range'] }));
});

test('denied classes and attributes never become reachable through superclass domains', () => {
  const denied = structuredClone(catalog);
  denied.classes.find((c) => c.name === 'Network').permissions = { _can_read: false };
  const result = buildAssistantFieldContext([stage], denied, { queries: ['range'] });
  assert.equal(result.stages[0].fields.some((f) => f.path.includes('Network')), false);
});

test('binding and business manifest expose the same confirmed related field contract', () => {
  const stages = [{ ...stage, alias: 'systems', stageRole: 'terminal', assistantBlockIds: ['systems-block'] }];
  const model = assistantDataSemanticModel(stages, catalog, { depth: 1, queries: ['range'] });
  const manifest = assistantObjectFlowBusinessBlockManifest({ authoring: { version: 1, assistant: { objectFlowIntent: {
    blocks: [{ id: 'systems-block', name: 'Selected systems', description: 'Systems whose related network range matches an endpoint.' }]
  } } } }, stages, model);
  assert.ok(manifest.blocks[0].terminalFields.includes('{owns:Network}.range'));
  const payload = JSON.parse(assistantDiagramBindingIntentMessages({ businessBlockManifest: manifest, dataSemanticModel: model, placements: [], relationRules: [] }, {}).at(-1).content);
  assert.ok(payload.models.dataSemanticModel.fieldCatalog.some((f) => f.path === '{owns:Network}.range'));
  assert.equal(payload.models.dataSemanticModel.stages[0].typedFields, undefined);
  assert.equal(payload.models.businessBlockManifest.blocks[0].typedFields, undefined);
  assert.deepEqual(payload.models.dataSemanticModel.stages[0].readableFields, model.stages[0].readableFields);
});

test('shared field definitions are counted once across repeated stage card sources', () => {
  const stages = Array.from({ length: 10 }, (_, i) => ({ ...stage, id: `systems-${i}` }));
  const result = buildAssistantFieldContext(stages, catalog, { queries: ['range'] });
  const fieldIds = new Set(result.stages.flatMap((s) => s.fields.map((f) => f.id)));
  assert.equal(result.fieldCatalog.length, fieldIds.size);
  assert.equal(result.diagnostics.returnedFields, fieldIds.size);
  assert.equal(result.diagnostics.truncated, false);
});

test('compact context preserves manual stages; terminal-only scope must be explicit', () => {
  const model = { stages: [
    { id: 'manual', stageRole: 'helper', readableFields: ['Code'], typedFields: [{ id: 'a' }], rules: [] },
    { id: 'named', stageRole: 'terminal', readableFields: ['Name'], typedFields: [{ id: 'b' }], rules: [] }
  ] };
  const copy = structuredClone(model);
  assert.deepEqual(compactAssistantDataModel(model).stages.map((s) => s.id), ['manual', 'named']);
  assert.deepEqual(compactAssistantDataModel(model, { terminalOnly: true }).stages.map((s) => s.id), ['named']);
  assert.deepEqual(compactAssistantDataModel({ stages: [model.stages[0]] }).stages[0].readableFields, ['Code']);
  assert.deepEqual(model, copy);
});

test('bounded context produces a visible deficit warning, never a completeness claim', () => {
  assert.deepEqual(assistantFieldContextWarnings(null), []);
  assert.deepEqual(assistantFieldContextWarnings({ fieldContextDiagnostics: { truncated: false } }), []);
  const warnings = assistantFieldContextWarnings({ fieldContextDiagnostics: { truncated: true } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /не доказывает/);
});

test('small configured byte limits are never silently raised to a minimum', () => {
  const result = buildAssistantFieldContext([stage], catalog, { maxBytes: 25, queries: ['range'] });
  assert.equal(result.diagnostics.maxBytes, 25);
  assert.ok(result.diagnostics.bytes <= 25);
  assert.equal(result.diagnostics.truncated, true);
  assert.deepEqual(result.fieldCatalog, []);
  assert.equal(buildAssistantFieldContext([stage], catalog, { depth: NaN }).diagnostics.depth, 1);
  assert.equal(buildAssistantFieldContext([stage], catalog, { depth: 1.9 }).diagnostics.depth, 1);
});
