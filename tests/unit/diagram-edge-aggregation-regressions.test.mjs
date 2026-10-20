import test from 'node:test';
import assert from 'node:assert/strict';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';
import { buildResultDiagrams, dependencyMapWithHash, executeSelectCards, executeMatchRows, executeEnrichRows,
  executeFilterRows, executeSemiJoinRows, executeJoinRows, executeUnionRows, executeDifferenceRows,
  assistantObjectFlowDiagramStages, validateDiagramImportV3Catalog, diagramImportCompileRelationRule,
  diagramImportRuntimeRelationMappings } from '../../scripts/dev-proxy-server.mjs';
import { runtimeRowIdentity, runtimeRowValue } from '../../scripts/runtime-row-semantics.mjs';

const limits = { maxRows: 100, maxSelectionScanRows: 100, maxSelectionScanRowsMax: 100,
  maxClasses: 100, maxClassesMax: 100, maxRelationsPerCard: 100, maxRelationsPerCardMax: 100 };

function diagramSpec(alias, fields = ['Source', 'Target'], groupBy = ['Category']) {
  return { version: 1, steps: [], result: { diagrams: [{ name: 'connections',
    nodeMappings: [{ from: 'objects', fields: { id: '_id', label: 'Description' },
      endpointProfiles: [{ id: 'addresses', field: 'Address', operators: ['equals'] }] }],
    edgeMappings: [{ id: 'connections', from: alias, type: 'attributeEndpoints', direction: '->',
      fields: { source: fields[0], target: fields[1] }, labelTemplate: '${Value}',
      endpointResolution: { sourceOperator: 'equals', targetOperator: 'equals', directionPolicy: 'dataFields' },
      importRole: { edgeClassKey: 'connection', directionPolicy: 'dataFields' },
      aggregation: { enabled: true, groupBy, duplicates: 'preserve' } }]
  }] } };
}

const objects = { rows: [{ _id: 'a', Address: 'source', Description: 'A' }, { _id: 'b', Address: ['target-1', 'target-2'], Description: 'B' }] };

test('real selected lookup IDs remain distinct when their display descriptions are equal', async () => {
  const spec = diagramSpec('links');
  const step = { type: 'selectCards', as: 'links', className: 'Connection' };
  spec.steps = [step];
  const cards = [10, 20].map((Category, index) => ({ _id: index + 1, Code: `link-${index}`, Category,
    _Category_description: 'Same category', Source: 'source', Target: 'target-1', Value: index + 1 }));
  const request = async () => ({ ok: true, statusCode: 200, json: { data: cards, meta: { total: 2 } } });
  const links = await executeSelectCards(request, step, {}, {}, limits, dependencyMapWithHash(spec));
  assert.deepEqual(links.rows.map(row => row.Category), ['Same category', 'Same category']);
  assert.deepEqual(links.rows.map(row => runtimeRowValue(row, 'Category')), [10, 20]);
  const edge = buildResultDiagrams(spec, { objects, links }, {}, limits)[0].edges[0];
  assert.equal(edge.data.aggregation.groups.length, 2);
  assert.deepEqual(edge.data.aggregation.groups.map(group => group.label), ['Same category', 'Same category']);
  assert.equal(edge.data.aggregation.memberCount, 2);
  assert.doesNotMatch(JSON.stringify(links), /rawFields|rowSemantics|recordIdentity/);
});

test('pair-grain source records and labels survive aggregation, source reordering and row-preserving operations', () => {
  const context = { objects,
    left: { columns: ['Class', '_id', 'Source', 'Value'], rows: [{ Class: 'Origin', _id: 1, Source: 'source', Value: 'left' }] },
    right: { columns: ['Class', '_id', 'Address', 'Category', 'Value'], rows: [
      { Class: 'Destination', _id: 10, Address: 'target-1', Category: 'X', Value: 'first' },
      { Class: 'Destination', _id: 20, Address: 'target-2', Category: 'Y', Value: 'second' }
    ] }
  };
  const step = { from: 'left', with: 'right', rightPrefix: 'right_', rules: [] };
  context.matched = executeMatchRows(step, {}, context, limits);
  assert.notEqual(runtimeRowIdentity(context.matched.rows[0]), runtimeRowIdentity(context.matched.rows[1]));
  const spec = diagramSpec('matched', ['Source', 'right_Address'], ['right_Category']);
  spec.result.diagrams[0].edgeMappings[0].labelTemplate = '${right_Value}';
  const expected = buildResultDiagrams(spec, context, {}, limits)[0].edges[0];
  assert.equal(expected.label, 'X [first]\nY [second]');
  assert.equal(expected.data.aggregation.memberCount, 2);
  context.right.rows.reverse();
  context.matched = executeMatchRows(step, {}, context, limits);
  const reordered = buildResultDiagrams(spec, context, {}, limits)[0].edges[0];
  assert.equal(reordered.label, expected.label);
  assert.equal(reordered.id, expected.id);
  for (const operation of [
    () => executeFilterRows({ from: 'matched', filters: [] }, {}, context, limits),
    () => executeSemiJoinRows({ from: 'matched', with: 'right', rules: [] }, {}, context, limits),
    () => executeUnionRows({ from: 'matched', with: 'empty', column: '_id', distinct: false }, context, limits),
    () => executeDifferenceRows({ from: 'matched', with: 'empty', column: '_id', distinct: false }, context, limits)
  ]) {
    context.empty = { rows: [], columns: [] };
    const result = operation();
    assert.deepEqual(result.rows.map(runtimeRowIdentity), context.matched.rows.map(runtimeRowIdentity));
    assert.equal(buildResultDiagrams(spec, { ...context, matched: result }, {}, limits)[0].edges[0].label, expected.label);
  }
  const joined = executeJoinRows({ from: 'left', with: 'right', on: '_id', mode: 'full' }, context, limits);
  assert.equal(new Set(joined.rows.map(runtimeRowIdentity)).size, 3);
});

for (const sourceKind of ['current', 'right', 'retained-only']) {
test(`catalog-confirmed deep fields on ${sourceKind} match cards are materialized before aggregation`, async () => {
  const flow = { version: 1, selections: [
    { id: 'selection:links', alias: 'links', className: 'Connection', columns: ['_id', 'Code', 'Value'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] },
    { id: 'selection:right', alias: 'right', className: 'Other', columns: ['_id', 'Code'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }
  ], operations: [{ id: 'match:links', type: 'match', from: 'links', with: 'right', as: 'matched',
    rules: [{ action: 'include', leftColumn: 'Code', rightColumn: 'Code', operator: 'equals' }] }] };
  const spec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  const stage = assistantObjectFlowDiagramStages(spec).find(stage => stage.alias === 'matched');
  if (sourceKind === 'retained-only') stage.cardSources = stage.cardSources.filter(source => source.className === 'Other');
  const groupField = sourceKind === 'current' ? 'owner.Description' : 'right_owner.Description';
  const rule = { id: 'connection', d2ClassKey: 'connection', kind: 'connection', mode: 'deterministicEndpoints', directionPolicy: 'dataFields',
    sourceStageId: stage.id, sourceField: '_id', targetField: 'right__id', labelTemplate: '${Value}',
    aggregation: { enabled: true, groupBy: [groupField] } };
  const catalog = { classes: [
    { name: 'Connection', attributes: sourceKind === 'current' ? [{ name: 'owner', type: 'reference', targetClass: 'Owner' }] : [] },
    { name: 'Owner', attributes: [{ name: 'Description', type: 'string' }] },
    { name: 'Other', attributes: sourceKind !== 'current' ? [{ name: 'owner', type: 'reference', targetClass: 'Owner' }] : [] }
  ], domains: [] };
  assert.deepEqual(validateDiagramImportV3Catalog({ roles: [], structureTree: { version: 5, items: [] }, endpointProfiles: [], relationRules: [rule] }, catalog, spec), []);
  const compiled = diagramImportCompileRelationRule(rule, new Map(), new Map(), new Map([[stage.id, stage]]));
  assert.ok(compiled[0].steps.length, 'confirmed nonprojected fields require deterministic enrichment');
  spec.steps.push(...compiled.flatMap(item => item.steps));
  const mappings = diagramImportRuntimeRelationMappings(compiled, new Map(), null);
  spec.result.diagrams = [{ name: 'deep', nodeMappings: [{ from: 'objects', fields: { id: '_id', label: 'Description' } }], edgeMappings: mappings.edgeMappings }];
  const calls = [];
  const connection = { _id: 1, Code: 'same', ...(sourceKind === 'current' ? { owner: 10 } : {}), Value: 'leaf' };
  const other = { _id: 2, Code: 'same', ...(sourceKind !== 'current' ? { owner: 10 } : {}) };
  const request = async path => {
    calls.push(path);
    if (/\/classes\/Connection\/attributes/.test(path)) return { ok: true, statusCode: 200, json: { data: catalog.classes[0].attributes } };
    if (/\/classes\/Connection\/cards\/1/.test(path)) return { ok: true, statusCode: 200, json: { data: connection } };
    if (/\/classes\/Other\/cards\/2/.test(path)) return { ok: true, statusCode: 200, json: { data: other } };
    if (/\/classes\/Other\/attributes/.test(path)) return { ok: true, statusCode: 200, json: { data: catalog.classes[2].attributes } };
    if (/\/classes\/Owner\/cards\/10/.test(path)) return { ok: true, statusCode: 200, json: { data: { _id: 10, Description: 'Team' } } };
    const data = path.includes('/classes/Connection/cards') ? [connection] : path.includes('/classes/Other/cards') ? [other] : null;
    assert.ok(data, `Unexpected mock read: ${path}`);
    return { ok: true, statusCode: 200, json: { data, meta: { total: data.length } } };
  };
  const context = { objects: { rows: [{ _id: 1, Description: 'A' }, { _id: 2, Description: 'B' }] } };
  const dependencies = dependencyMapWithHash(spec);
  for (const step of spec.steps) {
    if (step.type === 'selectCards') context[step.as] = await executeSelectCards(request, step, {}, context, limits, dependencies);
    else if (step.type === 'matchRows') context[step.as] = executeMatchRows(step, {}, context, limits);
    else if (step.type === 'enrichRows') context[step.as] = await executeEnrichRows(request, step, {}, context, limits);
    else assert.fail(`Unexpected step: ${step.type}`);
  }
  const output = buildResultDiagrams(spec, context, {}, limits)[0];
  assert.equal(output.edges[0].label, 'Team [leaf]');
  assert.equal(output.edges[0].data.aggregation.memberCount, 1);
  assert.ok(calls.some(path => path.includes('/classes/Owner/cards/10')));
  assert.equal(context.matched.rows.length, 1);
  assert.equal(context.matched.rows[0][groupField], undefined, 'original source result is unchanged');
});
}
