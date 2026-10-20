import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INPUT_COLLECTION_ABSOLUTE_LIMITS,
  INPUT_COLLECTION_DEFAULT_LIMITS,
  assertInputCollections,
  normalizeInputCollectionLimits
} from '../../scripts/input-collection-limits.mjs';

function items(count) {
  return Array(count).fill(null);
}

function expectLimit(input, path, actualCount, limit, options = {}, rootKind = 'request') {
  assert.throws(() => assertInputCollections(input, options, { rootKind }), (error) => {
    assert.equal(error.statusCode, 413);
    assert.equal(error.code, 'input_collection_limit');
    assert.deepEqual(error.details, { path, actualCount, limit });
    assert.equal(error.message, 'Authoring input exceeds a structural collection limit.');
    return true;
  });
}

test('limit defaults and immutable absolute caps are explicit', () => {
  const { effective, meta } = normalizeInputCollectionLimits();
  assert.deepEqual(effective, { maxCollectionItems: 5_000, maxTotalItems: 50_000, d2MaxElements: 5_000 });
  assert.deepEqual(INPUT_COLLECTION_ABSOLUTE_LIMITS, { maxCollectionItems: 50_000, maxTotalItems: 500_000, d2MaxElements: 50_000 });
  assert.ok(Object.isFrozen(INPUT_COLLECTION_DEFAULT_LIMITS));
  assert.ok(Object.isFrozen(INPUT_COLLECTION_ABSOLUTE_LIMITS));
  assert.deepEqual(meta.maxCollectionItems, { requested: 5_000, effective: 5_000, absolute: 50_000, clampedBy: null });
});

test('numeric env options expose requested, effective, absolute and clamping metadata', () => {
  const input = Object.freeze({ maxCollectionItems: '60000', maxTotalItems: '900000', d2MaxElements: '7000' });
  const { effective, meta } = normalizeInputCollectionLimits(input);
  assert.deepEqual(effective, { maxCollectionItems: 50_000, maxTotalItems: 500_000, d2MaxElements: 7_000 });
  assert.deepEqual(meta.maxCollectionItems, { requested: 60_000, effective: 50_000, absolute: 50_000, clampedBy: 'absolute' });
  assert.deepEqual(meta.maxTotalItems, { requested: 900_000, effective: 500_000, absolute: 500_000, clampedBy: 'absolute' });
  assert.deepEqual(meta.d2MaxElements, { requested: 7_000, effective: 7_000, absolute: 50_000, clampedBy: null });
  assert.deepEqual(normalizeInputCollectionLimits({ d2MaxElements: 80_000 }).meta.d2MaxElements,
    { requested: 80_000, effective: 50_000, absolute: 50_000, clampedBy: 'absolute' });
});

test('invalid configuration cannot disable limits or leak arbitrary raw config into metadata', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, null, true, {}, [], 'not-a-limit', ' ']) {
    const normalized = normalizeInputCollectionLimits({ maxCollectionItems: value });
    assert.equal(normalized.effective.maxCollectionItems, 5_000);
    assert.equal(normalized.meta.maxCollectionItems.clampedBy, 'default');
    assert.equal(typeof normalized.meta.maxCollectionItems.requested === 'number' || normalized.meta.maxCollectionItems.requested === null, true);
  }
  for (const value of [undefined, '', null, false]) {
    assert.deepEqual(normalizeInputCollectionLimits(value).effective, INPUT_COLLECTION_DEFAULT_LIMITS);
  }
});

test('intent permits 32 blocks and rejects raw block 33', () => {
  assert.deepEqual(assertInputCollections({ intent: { blocks: items(32) } }), { collectionCount: 1, totalCount: 32 });
  expectLimit({ intent: { blocks: items(33) } }, '$.intent.blocks', 33, 32);
  expectLimit({ blocks: items(33) }, '$.blocks', 33, 32, {}, 'intent');
});

test('intent permits 31 uses and rejects 32 duplicates before deduplication', () => {
  const uses = Array(31).fill('same-block');
  assert.deepEqual(assertInputCollections({ intent: { blocks: [{ uses }] } }), { collectionCount: 2, totalCount: 32 });
  uses.push('same-block');
  expectLimit({ intent: { blocks: [{ uses }] } }, '$.intent.blocks[0].uses', 32, 31);
  expectLimit({ intent: { blocks: [{ uses }] } }, '$.intent.blocks[0].uses', 32, 31, { maxCollectionItems: 50_000 });
  assert.equal(uses.length, 32);
});

test('business limits stay fixed independently of the configurable generic limit', () => {
  assert.deepEqual(assertInputCollections({ intent: { blocks: [{ uses: items(31) }] } }, { maxCollectionItems: 1 }),
    { collectionCount: 2, totalCount: 32 });
  expectLimit({ intent: { blocks: items(33) } }, '$.intent.blocks', 33, 32, { maxCollectionItems: 50_000 });
});

test('generic structural collections permit 5000 and reject 5001 without truncation', () => {
  const steps = items(5_000);
  assert.deepEqual(assertInputCollections({ spec: { steps } }), { collectionCount: 1, totalCount: 5_000 });
  steps.push(null);
  expectLimit({ spec: { steps } }, '$.spec.steps', 5_001, 5_000);
  assert.equal(steps.length, 5_001);
});

test('generic options can raise or lower per-collection limits', () => {
  const body = { spec: { steps: items(5_001) } };
  assert.equal(assertInputCollections(body, { maxCollectionItems: '5001' }).totalCount, 5_001);
  expectLimit({ flow: { selections: items(3) } }, '$.flow.selections', 3, 2, { maxCollectionItems: 2 });
  expectLimit({ spec: { steps: items(50_001) } }, '$.spec.steps', 50_001, 50_000,
    { maxCollectionItems: 500_000, maxTotalItems: 500_000 });
});

const keyAndPairCollections = [
  [(values) => ({ spec: { steps: [{ type: 'unionRows', column: values }] } }), '$.spec.steps[0].column', 1],
  [(values) => ({ flow: { operations: [{ type: 'unionRows', column: values }] } }), '$.flow.operations[0].column', 1],
  [(values) => ({ semanticPlan: { blocks: [{ resultContract: { pair: { rules: values } } }] } }), '$.semanticPlan.blocks[0].resultContract.pair.rules', 1]
];

for (const [wrap, path, parentCount] of keyAndPairCollections) {
  test(`raw collection at ${path} respects default and configured boundaries before deduplication`, () => {
    for (const limit of [5_000, 3, 5_001]) {
      const limits = limit === 5_000 ? {} : { maxCollectionItems: limit };
      const values = Array(limit).fill('same');
      const body = wrap(values);
      assert.deepEqual(assertInputCollections(body, limits), { collectionCount: 2, totalCount: parentCount + limit });
      values.push('same');
      expectLimit(body, path, limit + 1, limit, limits);
      assert.equal(values.length, limit + 1);
    }
  });
}

test('row key and pair rule arrays count every raw occurrence toward the aggregate', () => {
  const column = Object.freeze(['Code', 'Code']);
  const rule = Object.freeze({ leftColumn: 'Code', rightColumn: 'Code', operator: 'equals' });
  const rules = Object.freeze([rule, rule]);
  const body = {
    spec: { steps: [{ column }, { column }] },
    semanticPlan: { blocks: [{ resultContract: { pair: { rules } } }] }
  };
  const before = JSON.stringify(body);
  assert.deepEqual(assertInputCollections(body, { maxTotalItems: 9 }), { collectionCount: 5, totalCount: 9 });
  expectLimit(body, '$.semanticPlan.blocks[0].resultContract.pair.rules', 9, 8, { maxTotalItems: 8 });
  assert.equal(JSON.stringify(body), before);
});

test('default aggregate includes newly guarded row key and semantic pair arrays', () => {
  const body = {
    spec: { steps: Array.from({ length: 9 }, () => ({ column: items(4_999) })) },
    semanticPlan: { blocks: [{ resultContract: { pair: { rules: items(4_999) } } }] }
  };
  assert.deepEqual(assertInputCollections(body), { collectionCount: 12, totalCount: 50_000 });
  body.semanticPlan.blocks[0].resultContract.pair.rules.push(null);
  expectLimit(body, '$.semanticPlan.blocks[0].resultContract.pair.rules', 50_001, 50_000);
});

const genericCases = [
  [{ spec: { visualModels: items(3) } }, '$.spec.visualModels'],
  [{ spec: { result: { tables: items(3) } } }, '$.spec.result.tables'],
  [{ spec: { result: { tables: [{ columns: items(3) }] } } }, '$.spec.result.tables[0].columns'],
  [{ spec: { steps: [{ filters: items(3) }] } }, '$.spec.steps[0].filters'],
  [{ spec: { steps: [{ where: items(3) }] } }, '$.spec.steps[0].where'],
  [{ flow: { selections: [{ columns: items(3) }] } }, '$.flow.selections[0].columns'],
  [{ flow: { operations: [{ rules: items(3) }] } }, '$.flow.operations[0].rules'],
  [{ flow: { blocks: items(3) } }, '$.flow.blocks'],
  [{ flow: { setOperations: [{ on: items(3) }] } }, '$.flow.setOperations[0].on'],
  [{ flow: { operations: [{ on: items(3) }] } }, '$.flow.operations[0].on'],
  [{ spec: { visualModel: { selections: items(3) } } }, '$.spec.visualModel.selections'],
  [{ spec: { visualModels: [{ operations: items(3) }] } }, '$.spec.visualModels[0].operations'],
  [{ roles: [{ elementKeys: items(3) }] }, '$.roles[0].elementKeys'],
  [{ relationRules: [{ path: items(3) }] }, '$.relationRules[0].path'],
  [{ stages: [{ columns: items(3) }] }, '$.stages[0].columns'],
  [{ assistantOutputBindings: items(3) }, '$.assistantOutputBindings'],
  [{ checkpoint: { interpretation: { decisions: items(3) } } }, '$.checkpoint.interpretation.decisions'],
  [{ checkpoint: { mapping: { result: { placements: items(3) } } } }, '$.checkpoint.mapping.result.placements']
];

for (const [body, path] of genericCases) {
  test(`generic policy applies at ${path}`, () => {
    expectLimit(body, path, 3, 2, { maxCollectionItems: 2, d2MaxElements: 10 });
  });
}

test('checkpoint diagnostic arrays are output data, not editable structural collections', () => {
  const diagnostics = { unresolved: items(100), missingMappings: items(100), missingConnectionMappings: items(100) };
  assert.equal(assertInputCollections({ checkpoint: { mapping: { result: diagnostics } } },
    { maxCollectionItems: 1, maxTotalItems: 1 }).totalCount, 0);
});

for (const field of ['roles', 'relationRules', 'endpointProfiles', 'structureTree']) {
  const body = (count) => ({ [field]: field === 'structureTree' ? { items: items(count) } : items(count) });
  const path = field === 'structureTree' ? '$.structureTree.items' : `$.${field}`;
  test(`D2 ${field} uses its own configured limit, not the generic default`, () => {
    assert.equal(assertInputCollections(body(5_001), { d2MaxElements: 6_000 }).totalCount, 5_001);
    expectLimit(body(5_001), path, 5_001, 5_000);
    expectLimit(body(3), path, 3, 2, { d2MaxElements: 2, maxCollectionItems: 50_000 });
    expectLimit(body(50_001), path, 50_001, 50_000, { d2MaxElements: 100_000, maxTotalItems: 500_000 });
  });
}

test('D2 nested mapping arrays retain generic bounds and include deep raw entries', () => {
  const tree = { items: [{ templateElementKeys: ['a', 'a'], mapping: {
    primary: { structuredFields: ['Code', 'Code'] },
    related: [{ structuredFields: ['Description'], conditions: { rules: [{ right: { value: items(100) } }] } }],
    hierarchyConditions: { rules: [{}, {}] }
  } }] };
  assert.deepEqual(assertInputCollections(tree, {}, { rootKind: 'structureTree' }), { collectionCount: 7, totalCount: 10 });
  tree.items[0].mapping.related[0].conditions.rules.push({}, {});
  expectLimit({ structureTree: tree }, '$.structureTree.items[0].mapping.related[0].conditions.rules', 3, 2,
    { maxCollectionItems: 2, d2MaxElements: 10 });
});

test('nested mapping primary, related, structuredFields and templateElementKeys are bounded', () => {
  for (const [mapping, suffix] of [
    [{ primary: { structuredFields: items(3) } }, 'mapping.primary.structuredFields'],
    [{ related: items(3) }, 'mapping.related'],
    [{ conditions: { rules: items(3) } }, 'mapping.conditions.rules'],
    [{ hierarchyConditions: { rules: items(3) } }, 'mapping.hierarchyConditions.rules'],
    [{ related: [{ conditions: { rules: items(3) } }] }, 'mapping.related[0].conditions.rules']
  ]) {
    expectLimit({ structureTree: { items: [{ mapping }] } }, `$.structureTree.items[0].${suffix}`, 3, 2,
      { maxCollectionItems: 2, d2MaxElements: 10 });
  }
  expectLimit({ structureTree: { items: [{ templateElementKeys: items(3) }] } },
    '$.structureTree.items[0].templateElementKeys', 3, 2, { maxCollectionItems: 2 });
});

test('default aggregate limit permits 50000 raw items and rejects the next nested entry', () => {
  const spec = { steps: Array.from({ length: 10 }, () => ({ columns: items(4_999) })) };
  assert.deepEqual(assertInputCollections({ spec }), { collectionCount: 11, totalCount: 50_000 });
  spec.steps[9].columns.push(null);
  expectLimit({ spec }, '$.spec.steps[9].columns', 50_001, 50_000);
});

test('aggregate includes nested arrays, all wrappers and duplicate/shared array occurrences', () => {
  const columns = ['Code', 'Code'];
  const step = { columns };
  const input = { spec: { steps: [step, step] }, flow: { selections: [{ columns }] } };
  assert.deepEqual(assertInputCollections(input), { collectionCount: 5, totalCount: 9 });
  expectLimit(input, '$.flow.selections[0].columns', 9, 8, { maxTotalItems: 8 });
  assert.equal(input.spec.steps[0], input.spec.steps[1]);
  assert.equal(input.flow.selections[0].columns, columns);
});

test('tuple arrays in operation on count toward the raw aggregate', () => {
  const flow = { operations: [{ on: [['Code', 'Code'], ['_id', '_id']] }] };
  assert.deepEqual(assertInputCollections(flow, {}, { rootKind: 'flow' }), { collectionCount: 4, totalCount: 7 });
  expectLimit(flow, '$.operations[0].on[1]', 7, 6, { maxTotalItems: 6 }, 'flow');
});

test('aggregate config override is normalized and cannot exceed the absolute cap', () => {
  const input = { spec: { steps: items(5) } };
  expectLimit(input, '$.spec.steps', 5, 4, { maxTotalItems: '4' });
  assert.equal(assertInputCollections(input, normalizeInputCollectionLimits({ maxTotalItems: 5 })).totalCount, 5);
  const spec = { steps: Array.from({ length: 10 }, () => ({ columns: items(49_999) })) };
  const limits = { maxCollectionItems: 50_000, maxTotalItems: 5_000_000 };
  assert.equal(assertInputCollections(spec, limits, { rootKind: 'spec' }).totalCount, 500_000);
  spec.steps[9].columns.push(null);
  expectLimit(spec, '$.steps[9].columns', 500_001, 500_000, limits, 'spec');
});

test('supported request spec wrappers inspect objects and JSON strings without changing them', () => {
  for (const [wrap, path] of [
    [(spec) => ({ spec }), '$.spec.steps'],
    [(spec) => ({ SpecJson: spec }), '$.SpecJson.steps'],
    [(spec) => ({ template: { spec } }), '$.template.spec.steps'],
    [(spec) => ({ template: { SpecJson: spec } }), '$.template.SpecJson.steps']
  ]) {
    for (const raw of [{ steps: items(3) }, JSON.stringify({ steps: items(3) })]) {
      const body = wrap(raw);
      const before = JSON.stringify(body);
      expectLimit(body, path, 3, 2, { maxCollectionItems: 2 });
      assert.equal(JSON.stringify(body), before);
    }
  }
});

test('currentSpec and editorDelta.spec inspect object shapes but do not parse unsupported strings', () => {
  expectLimit({ currentSpec: { steps: items(3) } }, '$.currentSpec.steps', 3, 2, { maxCollectionItems: 2 });
  expectLimit({ editorDelta: { spec: { steps: items(3) } } }, '$.editorDelta.spec.steps', 3, 2, { maxCollectionItems: 2 });
  const unsupported = { editorDelta: { spec: JSON.stringify({ steps: items(3) }) } };
  assert.deepEqual(assertInputCollections(unsupported, { maxCollectionItems: 2 }), { collectionCount: 0, totalCount: 0 });
});

test('direct specs are recognized explicitly or by root steps/version, never inside params', () => {
  expectLimit({ result: { tables: items(3) } }, '$.result.tables', 3, 2, { maxCollectionItems: 2 }, 'spec');
  expectLimit({ steps: items(3) }, '$.steps', 3, 2, { maxCollectionItems: 2 });
  expectLimit({ version: 1, result: { tables: items(3) } }, '$.result.tables', 3, 2, { maxCollectionItems: 2 });
  assert.equal(assertInputCollections({ params: { version: 1, steps: items(3), roles: items(3) } },
    { maxCollectionItems: 2, d2MaxElements: 2 }).totalCount, 0);
});

test('all persisted authoring, proposal and checkpoint wrappers preserve their schema context', () => {
  const wrappers = [
    [(value) => ({ proposal: value }), '$.proposal'],
    [(value) => ({ checkpoint: value }), '$.checkpoint'],
    [(value) => ({ analysisCheckpoint: value }), '$.analysisCheckpoint'],
    [(value) => ({ assistantCheckpoint: value }), '$.assistantCheckpoint'],
    [(value) => ({ spec: { authoring: { d2: { analysisCheckpoint: value } } } }), '$.spec.authoring.d2.analysisCheckpoint'],
    [(value) => ({ spec: { authoring: { d2: { assistantCheckpoint: value } } } }), '$.spec.authoring.d2.assistantCheckpoint'],
    [(value) => ({ spec: { result: { diagrams: [{ authoring: { d2Import: value } }] } } }), '$.spec.result.diagrams[0].authoring.d2Import'],
    [(value) => ({ checkpoint: { mapping: { result: value } } }), '$.checkpoint.mapping.result']
  ];
  for (const [wrap, path] of wrappers) {
    expectLimit(wrap({ roles: items(4) }), `${path}.roles`, 4, 3, { d2MaxElements: 3 });
    expectLimit(wrap({ structureTree: { items: items(4) } }), `${path}.structureTree.items`, 4, 3, { d2MaxElements: 3 });
  }
  expectLimit({ spec: { authoring: { assistant: { objectFlowIntent: { blocks: items(33) } } } } },
    '$.spec.authoring.assistant.objectFlowIntent.blocks', 33, 32);
  expectLimit({ assistantObjectFlowIntent: { blocks: [{ uses: items(32) }] } },
    '$.assistantObjectFlowIntent.blocks[0].uses', 32, 31);
});

test('explicit array roots apply D2 policy and inspect nested structural arrays', () => {
  for (const rootKind of ['roles', 'relationRules', 'endpointProfiles']) {
    expectLimit(items(4), '$', 4, 3, { d2MaxElements: 3, maxCollectionItems: 1 }, rootKind);
    assert.equal(assertInputCollections(items(3), { d2MaxElements: 3, maxCollectionItems: 1 }, { rootKind }).totalCount, 3);
  }
  expectLimit([{ mapping: { related: items(3) } }], '$[0].mapping.related', 3, 2,
    { maxCollectionItems: 2, d2MaxElements: 3 }, 'roles');
});

test('semantic authoring roots count raw collections before semantic normalization', () => {
  const cases = [
    [{ blocks: items(3) }, '$.semanticPlan.blocks'],
    [{ blocks: [{ dependencies: items(3) }] }, '$.semanticPlan.blocks[0].dependencies'],
    [{ blocks: [{ resolvedEntities: items(3) }] }, '$.semanticPlan.blocks[0].resolvedEntities'],
    [{ blocks: [{ relationPaths: items(3) }] }, '$.semanticPlan.blocks[0].relationPaths']
  ];
  for (const field of ['predicates', 'dependencyPaths', 'relationPredicates', 'attributePredicates', 'referencePathPredicates']) {
    cases.push([{ blocks: [{ resultContract: { [field]: items(3) } }] }, `$.semanticPlan.blocks[0].resultContract.${field}`]);
  }
  cases.push([{ blocks: [{ resultContract: { referencePathPredicates: [{ hops: items(3) }] } }] },
    '$.semanticPlan.blocks[0].resultContract.referencePathPredicates[0].hops']);
  cases.push([{ blocks: [{ resultContract: { attributePredicates: [{ sourceFields: items(3) }] } }] },
    '$.semanticPlan.blocks[0].resultContract.attributePredicates[0].sourceFields']);
  for (const [semanticPlan, path] of cases) expectLimit({ semanticPlan }, path, 3, 2, { maxCollectionItems: 2 });
});

test('arbitrary root arrays are not row scans, while explicitly declared array roots are checked', () => {
  const rows = [{ roles: items(100) }, { steps: items(100) }, { spec: { steps: items(100) } }];
  assert.deepEqual(assertInputCollections(rows, { maxCollectionItems: 2, d2MaxElements: 2 }),
    { collectionCount: 0, totalCount: 0 });
  expectLimit(items(3), '$', 3, 2, { maxCollectionItems: 2, d2MaxElements: 100 }, 'assistantOutputBindings');
});

test('effective config passed directly is bounded just like the full normalized result', () => {
  const normalized = normalizeInputCollectionLimits({ maxCollectionItems: 2 });
  const body = { flow: { selections: items(3) } };
  expectLimit(body, '$.flow.selections', 3, 2, normalized);
  expectLimit(body, '$.flow.selections', 3, 2, normalized.effective);
  expectLimit({ steps: items(50_001) }, '$.steps', 50_001, 50_000,
    { effective: { maxCollectionItems: 500_000 } }, 'spec');
});

test('arbitrary CMDB rows, literal values, catalog metadata/Help, prompts and model responses are excluded', () => {
  const arbitrary = { roles: items(100), rules: items(100), steps: items(100) };
  const literal = [arbitrary, arbitrary, arbitrary];
  const spec = {
    params: { roles: items(100), value: literal, definition: { default: arbitrary } },
    defaults: arbitrary, paramDefaults: arbitrary, metadata: arbitrary, catalog: arbitrary, Help: arbitrary,
    steps: [{ sourceValue: literal, values: literal, filters: [{ value: literal, right: { value: arbitrary } }] }],
    result: { rows: literal, data: literal, tables: [{ rows: literal, data: literal }],
      diagrams: [{ metadata: arbitrary, nodeMappings: [{ staticRows: literal }] }] }
  };
  const input = {
    spec, params: arbitrary, rows: literal, data: literal, catalog: arbitrary, metadata: arbitrary,
    Help: arbitrary, prompt: arbitrary, response: { spec: arbitrary }, modelResponse: arbitrary,
    result: { flow: { selections: items(100) } }, mcpContext: arbitrary
  };
  assert.deepEqual(assertInputCollections(input, { maxCollectionItems: 2, d2MaxElements: 2, maxTotalItems: 6 }),
    { collectionCount: 5, totalCount: 5 });
  Object.defineProperty(input, 'catalog', { get() { throw new Error('Catalog must not be read'); } });
  Object.defineProperty(spec.params, 'roles', { get() { throw new Error('Params must not be read'); } });
  assert.equal(assertInputCollections(input).totalCount, 5);
});

test('frozen inputs and options are unchanged on success and failure, with no hidden dedup or slicing', () => {
  const uses = Object.freeze(['same', 'same']);
  const block = Object.freeze({ uses });
  const intent = Object.freeze({ blocks: Object.freeze([block, block]) });
  const input = Object.freeze({ intent });
  const options = Object.freeze({ maxTotalItems: 6 });
  const before = JSON.stringify(input);
  assert.deepEqual(assertInputCollections(input, options), { collectionCount: 3, totalCount: 6 });
  expectLimit(input, '$.intent.blocks[1].uses', 6, 5, { maxTotalItems: 5 });
  assert.equal(JSON.stringify(input), before);
  assert.equal(input.intent.blocks[0], block);
  assert.equal(block.uses, uses);
});

test('iterative traversal handles deeply nested structural mappings without call-stack recursion', () => {
  let mapping = { structuredFields: ['Code'] };
  for (let index = 0; index < 12_000; index += 1) mapping = { primary: mapping };
  assert.deepEqual(assertInputCollections({ structureTree: { items: [{ mapping }] } }), { collectionCount: 2, totalCount: 2 });
});

test('in-memory object and array cycles terminate while independent shared occurrences still count', () => {
  const mapping = { related: [] };
  mapping.related.push(mapping);
  const tree = { items: [{ mapping }, { mapping }] };
  assert.deepEqual(assertInputCollections(tree, {}, { rootKind: 'structureTree' }), { collectionCount: 3, totalCount: 4 });
  const on = [];
  on.push(on, ['Code', 'Code']);
  assert.deepEqual(assertInputCollections({ flow: { operations: [{ on }] } }), { collectionCount: 3, totalCount: 5 });
});

test('errors reveal only fixed schema paths and counts, never ids, user keys or array payload', () => {
  const secret = 'DO_NOT_REFLECT_THIS_PAYLOAD';
  const body = { spec: { steps: [{ as: secret, columns: [secret, secret, secret] }] }, [secret]: items(100) };
  assert.throws(() => assertInputCollections(body, { maxCollectionItems: 2 }), (error) => {
    assert.equal(`${error.message}${JSON.stringify(error)}`.includes(secret), false);
    assert.deepEqual(Object.keys(error.details).sort(), ['actualCount', 'limit', 'path']);
    assert.equal(error.details.path, '$.spec.steps[0].columns');
    return true;
  });
});

test('malformed JSON and unknown schema shapes are left to ordinary validation', () => {
  for (const input of [undefined, null, 1, false, 'invalid', { SpecJson: '{' }, { SpecJson: 'null' },
    { spec: { unknownAuthoringTree: { steps: items(100) } } }]) {
    assert.deepEqual(assertInputCollections(input, null), { collectionCount: 0, totalCount: 0 });
  }
  assert.throws(() => assertInputCollections({}, {}, { rootKind: 'not-a-schema' }), TypeError);
});
