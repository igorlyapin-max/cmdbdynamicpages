import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantD2BindingModel,
  assistantDiagramStageDraftFromResponse,
  buildResultDiagrams,
  runtimeJsonResponsePayload,
  stripSensitiveDiagramArtifacts,
  validateDiagramImportV3Catalog,
  validateTemplateSpec
} from '../../scripts/dev-proxy-server.mjs';
import { assertInputCollections } from '../../scripts/input-collection-limits.mjs';

function fixture(count = 100, options = {}) {
  const rows = Array.from({ length: count }, (_, index) => ({
    _id: String(index + 1), Class: 'Connection', Source: 'a', Target: 'b',
    Category: index % 2 ? 'B' : 'A', Value: index + 1, PrivatePayload: 'not-selected'
  }));
  const mapping = {
    id: 'connection-map', from: 'links', type: 'computed', direction: '->',
    fields: { source: 'Source', target: 'Target' }, labelTemplate: '${Value}',
    dataProfile: { fields: ['Category', 'Value'], includeSourceRef: false },
    aggregation: { enabled: true, groupBy: ['Category'], ...options },
    importRole: { edgeClassKey: 'connection', label: 'Connections' }
  };
  const spec = { version: 1, steps: [], result: { diagrams: [{
    name: 'generic-connections', maxEdges: 4000,
    nodeMappings: [{ from: 'objects', fields: { id: '_id', label: 'Description' } }],
    edgeMappings: [mapping]
  }] } };
  const context = {
    objects: { rows: [{ _id: 'a', Description: 'Object A' }, { _id: 'b', Description: 'Object B' }] },
    links: { columns: ['Class', '_id', 'Source', 'Target', 'Category', 'Value'], rows }
  };
  return { spec, context, mapping, build: () => buildResultDiagrams(spec, context, {}, { maxRows: 2000 })[0] };
}

test('100 confirmed connections become one D2 edge with all original records retained', () => {
  const { build } = fixture();
  const diagram = build();
  assert.equal(diagram.edges.length, 1);
  const aggregate = diagram.edges[0];
  assert.equal(aggregate.data.aggregation.memberCount, 100);
  assert.equal(aggregate.data.aggregation.members.length, 100);
  assert.match(aggregate.label, /A \[/);
  assert.match(aggregate.label, /B \[/);
  assert.equal(diagram.data.counts.edges, 1);
  assert.equal(diagram.execution.aggregation[0].inputEdges, 100);
  assert.equal(diagram.execution.aggregation[0].outputEdges, 1);
  assert.doesNotMatch(JSON.stringify(aggregate.data), /PrivatePayload|not-selected|runtimeRow/);
  assert.equal(aggregate.runtimeRow, undefined);
  assert.equal(diagram.truncated, false);
});

test('turning aggregation off restores every original connection', () => {
  const { mapping, build } = fixture();
  mapping.aggregation.enabled = false;
  assert.equal(build().edges.length, 100);
});

test('raw edge limit remains visible after aggregation reduces the displayed count', () => {
  const { spec, build } = fixture(100);
  spec.result.diagrams[0].maxEdges = 20;
  const diagram = build();
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].data.aggregation.memberCount, 20);
  assert.equal(diagram.truncated, true);
  assert.match(diagram.warnings.join(' '), /truncated by execution limits/);
});

test('reordering source rows does not change aggregate identity, label or D2 source', () => {
  const { context, build } = fixture();
  const first = build();
  context.links.rows.reverse();
  const second = build();
  assert.equal(first.edges[0].id, second.edges[0].id);
  assert.equal(first.edges[0].label, second.edges[0].label);
  assert.equal(first.d2.source, second.d2.source);
});

test('normal runtime JSON keeps aggregate counts but not members or source rows', () => {
  const diagram = fixture().build();
  const output = runtimeJsonResponsePayload({ success: true, result: { diagrams: [diagram] } });
  assert.equal(output.diagrams[0].edges[0].aggregation.memberCount, 100);
  assert.doesNotMatch(JSON.stringify(output), /PrivatePayload|not-selected|"members"|"sourceRef"|runtimeRow/);
});

test('only explicit authenticated preview projection retains aggregation details', () => {
  const diagram = fixture(3).build();
  const ordinary = stripSensitiveDiagramArtifacts({ diagrams: [diagram] });
  assert.equal(ordinary.diagrams[0].edges[0].data, undefined);
  const preview = stripSensitiveDiagramArtifacts({ diagrams: [diagram] }, { includeAggregationDetails: true });
  assert.equal(preview.diagrams[0].edges[0].data.aggregation.memberCount, 3);
  assert.deepEqual(Object.keys(preview.diagrams[0].edges[0].data), ['aggregation']);
  assert.doesNotMatch(JSON.stringify(preview), /PrivatePayload|not-selected|runtimeRow/);
  assert.equal(diagram.edges[0].data.aggregation.memberCount, 3);
});

test('group labels use readable lookup descriptions while distinct typed identities remain separate', () => {
  const { context, build } = fixture(2);
  context.links.rows[0].Category = 10;
  context.links.rows[0]._Category_description = 'Readable category';
  context.links.rows[1].Category = 20;
  context.links.rows[1]._Category_description = 'Readable category';
  const edge = build().edges[0];
  assert.equal(edge.data.aggregation.groups.length, 2);
  assert.match(edge.label, /Readable category \[1\]/);
  assert.match(edge.label, /Readable category \[2\]/);
  assert.doesNotMatch(edge.label, /10 \[|20 \[/);
});

test('compiled edge configuration rejects invalid aggregation without hiding the field path', () => {
  const { spec } = fixture(2, { format: 'unknown' });
  spec.steps = [
    { type: 'selectCards', className: 'Object', as: 'objects' },
    { type: 'selectCards', className: 'Connection', as: 'links' }
  ];
  const errors = validateTemplateSpec(spec);
  assert.ok(errors.some((error) => error.path.endsWith('.edgeMappings[0].aggregation.format')));
});

test('partial preview retains confirmed edges and an explicit warning when aggregation field is unavailable', () => {
  const { spec, context } = fixture(3, { groupBy: ['MissingField'] });
  assert.throws(() => buildResultDiagrams(spec, context, {}, { maxRows: 100 }), (error) => {
    assert.equal(error.code, 'diagram_edge_aggregation_invalid');
    assert.equal(error.statusCode, 422);
    return true;
  });
  const partial = buildResultDiagrams(spec, context, {}, { maxRows: 100 }, { allowPartialAggregation: true })[0];
  assert.equal(partial.edges.length, 3);
  assert.match(partial.warnings.join(' '), /Агрегация.*не выполнена/);
  assert.equal(partial.execution.aggregation[0].status, 'invalid');
  assert.equal(partial.execution.aggregation[0].inputEdges, 3);
  assert.equal(partial.execution.aggregation[0].outputEdges, 3);
  assert.equal(spec.result.diagrams[0].edgeMappings[0].aggregation.groupBy[0], 'MissingField');
});

test('aggregation levels participate in raw structural collection and aggregate input limits', () => {
  const wrap = (length) => ({ relationRules: [{ aggregation: { enabled: true, groupBy: Array(length).fill('Category') } }] });
  assert.doesNotThrow(() => assertInputCollections(wrap(32)));
  assert.throws(() => assertInputCollections(wrap(33)), (error) => {
    assert.equal(error.code, 'input_collection_limit');
    assert.equal(error.details.path, '$.relationRules[0].aggregation.groupBy');
    assert.equal(error.details.actualCount, 33);
    return true;
  });
});

function assistantFixture(aggregation) {
  const stage = { id: 'select:links', alias: 'links', kind: 'selection', className: 'Connection',
    columns: ['_id', 'Class', 'Source', 'Target', 'Description', 'Category', 'Value'] };
  const input = {
    kind: 'mapping', mappingPhase: 'topology', roles: [{ id: 'object', visualKind: 'node' }], stages: [stage],
    acceptedItems: [{ roleId: 'object', source: { stageId: stage.id, alias: stage.alias, className: stage.className }, mapping: { id: 'object-map' } }],
    topology: [{ d2ElementKey: 'connection-edge', d2ClassKey: 'connection', directionPolicy: 'dataFields',
      ...(aggregation !== undefined ? { aggregation } : {}),
      deterministicEndpointStages: [{ candidateId: 'candidate', sourceStageId: stage.id, fields: stage.columns }] }]
  };
  const rule = { d2ClassKey: 'connection', candidateId: 'candidate', sourceStageId: stage.id,
    mode: 'deterministicEndpoints', sourceField: 'Source', targetField: 'Target', labelTemplate: '${Value}' };
  return { input, rule };
}

test('Assistant preserves manually configured aggregation even if its response omits it', () => {
  const config = { enabled: true, groupBy: ['Category'], format: 'tree', duplicates: 'preserve', maxLabelChars: 400 };
  const { input, rule } = assistantFixture(config);
  const draft = assistantDiagramStageDraftFromResponse(input, { relationRules: [rule] });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.deepEqual(draft.relationRules[0].aggregation, config);
  assert.deepEqual(assistantD2BindingModel([], draft.relationRules).connections[0].aggregation, config);
});

test('Assistant proposals cannot invent an aggregation field outside the supplied result', () => {
  const { input, rule } = assistantFixture();
  const draft = assistantDiagramStageDraftFromResponse(input, { relationRules: [{ ...rule,
    aggregation: { enabled: true, groupBy: ['NotOffered'] } }] });
  assert.equal(draft.success, false);
  assert.ok(draft.errors.some((error) => error.path.includes('.aggregation')));
});

test('catalog validation confirms generic reference grouping paths not explicitly projected by Object Flow', () => {
  const config = { enabled: true, groupBy: ['owner.Description'] };
  const proposal = { roles: [], structureTree: { version: 5, items: [] }, endpointProfiles: [], relationRules: [{
    id: 'connection', mode: 'deterministicEndpoints', sourceStageId: 'selection:links',
    sourceField: '_id', targetField: '_id', aggregation: config
  }] };
  const spec = { version: 1, visualModels: [{ mode: 'objectGroup', selections: [{
    id: 'selection:links', alias: 'links', className: 'Connection', columns: ['_id'],
    rules: [{ action: 'include', path: 'Code', op: 'exists' }]
  }] }] };
  const catalog = { classes: [
    { name: 'Connection', attributes: [{ name: 'owner', type: 'reference', targetClass: 'Owner' }] },
    { name: 'Owner', attributes: [{ name: 'Description', type: 'string' }] }
  ], domains: [] };
  const errors = validateDiagramImportV3Catalog(proposal, catalog, spec);
  assert.equal(errors.filter((error) => error.path.includes('.aggregation')).length, 0, JSON.stringify(errors));
  proposal.relationRules[0].aggregation.groupBy = ['owner.SecretMissing'];
  assert.ok(validateDiagramImportV3Catalog(proposal, catalog, spec).some((error) => error.path.includes('.aggregation.groupBy')));
});
