import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createTemplateTransferPackage,
  readTemplateTransferPackage,
  templateTransferDependencies,
  templateTransferEnvironmentReferences,
  applyTemplateTransferOverrides,
  templateTransferTargetRevision,
} from '../../scripts/template-transfer.mjs';

const options = { producerVersion: '00.00.00.18' };
const invalid = { code: 'template_transfer_invalid' };

function fixture() {
  const checkpoint = {
    version: 1, proposalId: 'source-proposal', deterministicSpecHash: 'source-spec-hash',
    source: { hash: 'source-hash', mappingContractHash: 'source-mapping' },
    resumeId: 'source-resume', signature: 'source-signature',
    roles: [{ id: 'role:1', visualKind: 'node', labelTemplate: '${id} ${token}' }],
    relationRules: [{ id: 'rule:1', roleId: 'role:1', domain: 'AssetRoom' }],
    structureTree: { version: 1, items: [{ id: 'item:1', parentId: '', roleId: 'role:1' }] },
    interpretation: { explanation: 'Keep token and id words verbatim.', decisions: [{ roleId: 'role:1' }] },
    mapping: { result: { partial: true, mapping: { id: 'business-id', token: 'business-token',
      source: 'business-source', resumeId: 'business-resume', signature: 'business-signature' } } },
  };
  return {
    id: 19, active: true, owner: 'source-owner', updatedAt: 'yesterday', specHash: 'source-hash',
    history: [{ version: 2 }], runtimeConfig: { apiKey: 'fixture-only-external' },
    code: 'asset-map', description: 'Current authoring', paramsSchema: { type: 'object' }, resultSchema: {},
    spec: {
      version: 1,
      params: {
        asset: { type: 'reference', targetClass: 'Asset', default: 41 },
        status: { type: 'lookup', lookupType: 'Status', default: '7' },
        count: { type: 'integer', default: 12 },
        missingTarget: { type: 'reference', default: 55 },
        literal: { default: { id: 66, token: 'literal-token', active: true, owner: 'literal-owner' } },
      },
      steps: [
        { type: 'selectCards', className: 'Asset', as: 'assets', columns: ['Code', 'Location'],
          filters: [{ attribute: 'Code', value: 'literal token id' }] },
        { type: 'expandRelations', from: 'assets', targetClass: 'Room', domain: 'AssetRoom', as: 'rooms', columns: ['Code'] },
      ],
      objectFlow: { version: 1, selections: [{ id: 'selection:1', alias: 'assets', name: 'Asset business name', className: 'Asset', rules: [] }],
        operations: [{ id: 'operation:1', type: 'relation', from: 'assets', as: 'rooms', targetClass: 'Room', domain: 'AssetRoom' }] },
      result: { tables: [{ source: 'rooms' }], link: { url: 'https://source.example.test/item' } },
      authoring: { version: 1,
        assistant: { promptContractVersion: 4, diagramIntentPrompt: 'https://prompt.example.test/keep-verbatim',
          systemPromptOverrides: { system: 'Keep all id/token literals.' },
          objectFlowIntent: { context: 'Business context', blocks: [{ id: 'block:1', name: 'Business name', description: 'Prompt ${param.id}', uses: [] }] } },
        d2: { source: 'a: { class: node }\na -> b: "id token"\n', sourceHash: 'source-d2-hash',
          analysisCheckpoint: structuredClone(checkpoint), assistantCheckpoint: structuredClone(checkpoint) },
      },
    },
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function resign(pkg) {
  const { checksum, ...payload } = pkg;
  pkg.checksum = `sha256:${createHash('sha256').update(stable(payload)).digest('hex')}`;
  return pkg;
}

test('single-file roundtrip preserves current authoring and reviewed payload without source attestation', () => {
  const input = fixture();
  const before = structuredClone(input);
  const pkg = createTemplateTransferPackage(input, options);
  assert.equal(pkg.format, 'cmdbdynamicpages.template');
  assert.equal(pkg.formatVersion, 1);
  assert.equal(pkg.producerVersion, options.producerVersion);
  assert.match(pkg.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(pkg.template).sort(), ['code', 'description', 'paramsSchema', 'resultSchema', 'spec']);
  const imported = readTemplateTransferPackage(JSON.stringify(pkg));
  assert.deepEqual(imported, pkg.template);
  assert.deepEqual(imported.spec.objectFlow, before.spec.objectFlow);
  assert.deepEqual(imported.spec.authoring.assistant, before.spec.authoring.assistant);
  assert.equal(imported.spec.authoring.d2.source, before.spec.authoring.d2.source);
  assert.equal(Object.hasOwn(imported.spec.authoring.d2, 'sourceHash'), false);
  for (const name of ['analysisCheckpoint', 'assistantCheckpoint']) {
    const checkpoint = imported.spec.authoring.d2[name];
    for (const key of ['roles', 'relationRules', 'structureTree', 'mapping', 'interpretation']) {
      assert.deepEqual(checkpoint[key], before.spec.authoring.d2[name][key]);
    }
    for (const key of ['proposalId', 'deterministicSpecHash', 'source', 'resumeId', 'signature']) assert.equal(Object.hasOwn(checkpoint, key), false);
  }
  assert.deepEqual(imported.spec.params.literal, before.spec.params.literal);
  assert.deepEqual(input, before);
  assert.deepEqual(createTemplateTransferPackage(imported, options), pkg);
});

test('canonical checksum ignores object insertion order but covers entire payload', () => {
  const input = fixture();
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  reversed.spec = Object.fromEntries(Object.entries(input.spec).reverse());
  assert.equal(createTemplateTransferPackage(input, options).checksum, createTemplateTransferPackage(reversed, options).checksum);
  const pkg = createTemplateTransferPackage(input, options);
  const reordered = Object.fromEntries(Object.entries(pkg).reverse());
  assert.deepEqual(readTemplateTransferPackage(reordered), pkg.template);
  for (const mutate of [
    (p) => { p.template.description += '!'; },
    (p) => { p.template.spec.authoring.d2.source += '\n'; },
    (p) => { p.producerVersion = 'different'; },
    (p) => { p.dependencies.classes.pop(); },
  ]) {
    const altered = structuredClone(pkg);
    mutate(altered);
    assert.throws(() => readTemplateTransferPackage(altered), invalid);
  }
});

test('unknown version, wrong format, missing or extra envelope and template fields fail closed', () => {
  const pkg = createTemplateTransferPackage(fixture(), options);
  for (const mutate of [
    (p) => { p.formatVersion = 2; }, (p) => { p.formatVersion = '1'; },
    (p) => { p.format = 'other'; }, (p) => { delete p.dependencies; },
    (p) => { p.extra = {}; }, (p) => { p.template.id = 99; },
    (p) => { delete p.template.paramsSchema; },
  ]) {
    const altered = structuredClone(pkg);
    mutate(altered);
    assert.throws(() => readTemplateTransferPackage(resign(altered)), invalid);
  }
  assert.throws(() => readTemplateTransferPackage({ ...pkg, checksum: '0000' }), invalid);
  assert.throws(() => readTemplateTransferPackage('{'), invalid);
  assert.throws(() => readTemplateTransferPackage(null), invalid);
});

test('recomputed checksums do not authorize injected config or false manifests', () => {
  for (const mutate of [
    (p) => { p.runtimeConfig = { apiKey: 'fixture-only' }; },
    (p) => { p.template.runtimeConfig = { apiKey: 'fixture-only' }; },
    (p) => { p.template.spec.runtimeConfig = { apiKey: 'fixture-only' }; },
    (p) => { p.template.spec.steps[0].credentials = { token: 'fixture-only' }; },
    (p) => { p.template.spec.authoring.assistant.llm = { apiKey: 'fixture-only' }; },
    (p) => { p.template.spec.authoring.d2.assistantCheckpoint.resumeId = 'source-resume'; },
    (p) => { p.dependencies.environmentReferences = []; },
    (p) => { p.dependencies.unknown = true; },
  ]) {
    const pkg = createTemplateTransferPackage(fixture(), options);
    mutate(pkg);
    assert.throws(() => readTemplateTransferPackage(resign(pkg)), invalid);
  }
});

test('manifests retain exact paths, classify only typed IDs, and flag unresolved provenance', () => {
  const spec = fixture().spec;
  const dependencies = templateTransferDependencies(spec);
  assert.ok(dependencies.classes.some((ref) => ref.name === 'Asset' && ref.path === '$.spec.steps[0].className'));
  assert.ok(dependencies.domains.some((ref) => ref.name === 'AssetRoom'));
  assert.ok(dependencies.directFields.some((ref) => ref.className === 'Asset' && ref.field === 'Location'));
  assert.deepEqual(dependencies.environmentReferences, [
    { kind: 'card', className: 'Asset', value: 41, path: '$.spec.params.asset.default' },
    { kind: 'lookup', lookupType: 'Status', value: '7', path: '$.spec.params.status.default' },
    { kind: 'url', value: 'https://source.example.test/item', path: '$.spec.result.link.url' },
  ]);
  assert.deepEqual(templateTransferEnvironmentReferences(spec), dependencies.environmentReferences);
  assert.ok(dependencies.inspection.some((ref) => ref.path === '$.spec.params.count.default'));
  assert.ok(dependencies.inspection.some((ref) => ref.path === '$.spec.params.missingTarget.default'));
  assert.equal(dependencies.environmentReferences.some((ref) => /role|operation|selection|block|literal|Prompt/.test(ref.path)), false);
});

test('direct card and lookup fields use explicit target type and internal IDs never become card IDs', () => {
  const spec = { version: 1, steps: [{ type: 'selectCards', className: 'Asset', cardId: 11,
    lookupType: 'Status', lookupId: 3, id: 444, roleId: 555, parentId: 666, stageId: 777 }] };
  assert.deepEqual(templateTransferEnvironmentReferences(spec), [
    { kind: 'card', className: 'Asset', value: 11, path: '$.spec.steps[0].cardId' },
    { kind: 'lookup', lookupType: 'Status', value: 3, path: '$.spec.steps[0].lookupId' },
  ]);
});

test('typed reference lists expose physical indices and can be overridden without replacing the arrays', () => {
  const input = { code: 'Indexed', spec: { version: 1, params: {
    cards: { type: 'array', referenceType: 'card', targetClass: 'Asset', default: [41, '42'] },
    lookups: { type: 'array', referenceType: 'lookup', lookupType: 'Status', defaultValue: ['7', 8] },
    counts: { type: 'array', default: [3, 4] }
  } } };
  const pkg = createTemplateTransferPackage(input, options);
  const refs = pkg.dependencies.environmentReferences;
  assert.deepEqual(refs.map(({ path, value }) => [path, value]), [
    ['$.spec.params.cards.default[0]', 41], ['$.spec.params.cards.default[1]', '42'],
    ['$.spec.params.lookups.defaultValue[0]', '7'], ['$.spec.params.lookups.defaultValue[1]', 8]
  ]);
  const imported = readTemplateTransferPackage(pkg);
  const updated = applyTemplateTransferOverrides(imported, refs.map(({ path, value }, index) => ({ path, value: index === 1 ? 43 : value })));
  assert.deepEqual(updated.spec.params.cards.default, [41, 43]);
  assert.deepEqual(imported.spec.params.cards.default, [41, '42']);
  assert.throws(() => applyTemplateTransferOverrides(imported, refs.map(({ path, value }, index) => ({
    path: index === 1 ? '$.spec.params.cards.default[2]' : path, value
  }))), invalid);
});

test('target revisions cover identity, root, editable metadata and stored definition, not permission flags', () => {
  const card = { _id: 42, Code: 'Target', Description: 'Old', Owner: 'user', Active: false, UpdatedAt: 'now',
    SpecJson: '{}', ParamsSchemaJson: '{}', ResultSchemaJson: '{}' };
  const before = templateTransferTargetRevision('Root_A', card);
  assert.match(before, /^sha256:[a-f0-9]{64}$/);
  for (const key of Object.keys(card)) {
    assert.notEqual(templateTransferTargetRevision('Root_A', { ...card, [key]: null }), before, key);
  }
  assert.notEqual(templateTransferTargetRevision('Root_B', card), before);
  assert.equal(templateTransferTargetRevision('Root_A', { ...card, _can_update: false }), before);
});

test('override maps are complete, explicit, nonmutating and preserve graph IDs and prompts', () => {
  const input = readTemplateTransferPackage(createTemplateTransferPackage(fixture(), options));
  const before = structuredClone(input);
  const references = templateTransferEnvironmentReferences(input.spec).map((ref) => ({ path: ref.path, value: ref.kind === 'url' ? 'https://target.example.test/item' : 91 }));
  const output = applyTemplateTransferOverrides(input, references);
  assert.deepEqual(input, before);
  assert.equal(output.spec.params.asset.default, 91);
  assert.equal(output.spec.params.status.default, 91);
  assert.equal(output.spec.result.link.url, 'https://target.example.test/item');
  assert.deepEqual(output.spec.objectFlow, input.spec.objectFlow);
  assert.deepEqual(output.spec.authoring, input.spec.authoring);
  assert.deepEqual(applyTemplateTransferOverrides(input), input);
  assert.deepEqual(applyTemplateTransferOverrides(input, []), input);
  assert.equal(applyTemplateTransferOverrides(input, { code: 'target-code' }).code, 'target-code');
});

test('incomplete, unknown, duplicate, malformed or mistyped overrides fail closed', () => {
  const input = fixture();
  const refs = templateTransferEnvironmentReferences(input.spec).map((ref) => ({ path: ref.path, value: ref.value }));
  for (const overrides of [
    refs.slice(1), [...refs, refs[0]], [...refs, { path: '$.spec.objectFlow.selections[0].id', value: 9 }],
    refs.map((ref, index) => index ? ref : { ...ref, path: '$.spec.__proto__.polluted' }),
    refs.map((ref, index) => index ? ref : { ...ref, value: {} }),
    refs.map((ref) => ref.path.includes('.url') ? { ...ref, value: 'javascript:alert(1)' } : ref),
    { references: {} }, { id: 1 }, { code: 2 },
  ]) assert.throws(() => applyTemplateTransferOverrides(input, overrides), invalid);
});

test('unsaved empty-code exports remain empty and never rename graph elements', () => {
  const input = fixture();
  input.code = '';
  const output = readTemplateTransferPackage(createTemplateTransferPackage(input, options));
  assert.equal(output.code, '');
  assert.deepEqual(output.spec.objectFlow, input.spec.objectFlow);
});

test('prototype pollution, cyclic graphs, accessors and non-JSON data are rejected safely', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const input = fixture();
    input.spec.params.literal.default = JSON.parse(`{"${key}":{"polluted":true}}`);
    assert.throws(() => createTemplateTransferPackage(input, options), invalid);
  }
  assert.equal({}.polluted, undefined);
  for (const item of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(), Object.create({ inherited: true }), Symbol('x')]) {
    const input = fixture();
    input.spec.params.literal.default = item;
    assert.throws(() => createTemplateTransferPackage(input, options), invalid);
  }
  const cyclic = fixture();
  cyclic.spec.params.literal.default = cyclic;
  assert.throws(() => createTemplateTransferPackage(cyclic, options), invalid);
  const accessor = fixture();
  let invoked = false;
  Object.defineProperty(accessor, 'code', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  assert.throws(() => createTemplateTransferPackage(accessor, options), invalid);
  assert.equal(invoked, false);
  for (const array of [new Array(3), Object.assign([], { extra: 1 })]) {
    const input = fixture();
    input.spec.steps = array;
    assert.throws(() => createTemplateTransferPackage(input, options), invalid);
  }
});

test('caller-owned capacities: deep JSON and collections have no hidden local caps', () => {
  const input = fixture();
  let nested = {};
  for (let index = 0; index < 90; index++) nested = { next: nested };
  input.spec.params.literal.default = nested;
  assert.ok(createTemplateTransferPackage(input, options).checksum);
  input.spec.params.literal.default = Array(200_001).fill(null);
  assert.ok(createTemplateTransferPackage(input, options).checksum);
});

test('null schemas and business config literals preserve semantics', () => {
  const input = fixture();
  input.paramsSchema = null;
  input.resultSchema = null;
  input.spec.steps[0].config = { id: 3, token: 'business-token' };
  const output = readTemplateTransferPackage(createTemplateTransferPackage(input, options));
  assert.equal(output.paramsSchema, null);
  assert.equal(output.resultSchema, null);
  assert.deepEqual(output.spec.steps[0].config, input.spec.steps[0].config);
});

test('match right-side and derived technical columns are not guessed as direct class attributes', () => {
  const spec = { version: 1, steps: [
    { type: 'selectCards', className: 'Asset', as: 'assets', columns: ['Code', 'SourceDescription', 'RelatedClass', '_id'] },
    { type: 'selectCards', className: 'Room', as: 'rooms', columns: ['Code'] },
    { type: 'matchRows', from: 'assets', with: 'rooms', as: 'joined',
      rules: [{ left: { column: 'Code' }, right: { column: 'Location' } }, { leftColumn: 'Code', rightColumn: 'Other' }] },
  ] };
  const manifest = templateTransferDependencies(spec);
  assert.equal(manifest.directFields.some((ref) => ['SourceDescription', 'RelatedClass', '_id', 'Other', 'Location'].includes(ref.field)), false);
  assert.ok(manifest.inspection.some((ref) => ref.path === '$.spec.steps[2].rules[0].right.column'));
  assert.ok(manifest.inspection.some((ref) => ref.path === '$.spec.steps[0].columns[1]'));
});

test('sourceClass dependencies have explicit JSON paths', () => {
  const manifest = templateTransferDependencies({ version: 1, steps: [{ type: 'expandRelations', sourceClass: 'Asset', targetClass: 'Room', domain: 'AssetRoom' }] });
  assert.ok(manifest.classes.some((ref) => ref.name === 'Asset' && ref.path === '$.spec.steps[0].sourceClass'));
});

test('invalid structural roots reject rather than coerce', () => {
  for (const mutate of [
    (t) => { t.spec = []; }, (t) => { t.spec.version = 2; }, (t) => { t.spec.steps = {}; },
    (t) => { t.spec.authoring = []; }, (t) => { t.paramsSchema = []; },
    (t) => { t.spec.authoring.d2.analysisCheckpoint = []; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => createTemplateTransferPackage(input, options), invalid);
  }
  for (const producerVersion of [null, 1, '', ' '.repeat(2), 'x'.repeat(129)]) {
    assert.throws(() => createTemplateTransferPackage(fixture(), { producerVersion }), invalid);
  }
});
