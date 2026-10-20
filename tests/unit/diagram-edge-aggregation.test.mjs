import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDiagramEdges, normalizeEdgeAggregation, validateEdgeAggregation } from '../../scripts/diagram-edge-aggregation.mjs';

const missingLabel = '\u041d\u0435 \u0437\u0430\u0434\u0430\u043d\u043e';

function edge(id, row = {}, options = {}) {
  const { aggregation = { enabled: true, groupBy: ['Protocol'] }, mapping = {}, ...properties } = options;
  return {
    id: `edge-${id}`, d2Id: `edge-${id}`, source: 'visual-a', target: 'visual-b',
    sourceD2Id: 'root.a', targetD2Id: 'root.b', label: String(row.Port ?? id),
    direction: '->', blueprintKey: 'edge-blueprint', styleHints: { stroke: 'black' },
    importRole: { key: 'connection', edgeClassKey: 'connection-class' },
    data: { kind: 'edge', id: `edge-${id}`, fields: { Port: { value: row.Port } }, sourceRef: { id } },
    runtimeMapping: { id: 'mapping-1', type: 'computed', aggregation, ...mapping },
    runtimeRow: { _id: id, ...row }, ...properties
  };
}

function aggregate(input, callbacks) {
  const result = aggregateDiagramEdges(input, callbacks);
  assert.equal(result.edges.length, 1);
  return result.edges[0];
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('normalization defaults are canonical, independent and preserve disabled settings', () => {
  assert.equal(normalizeEdgeAggregation(undefined), undefined);
  const defaults = normalizeEdgeAggregation({});
  assert.deepEqual(defaults, { enabled: false, groupBy: [], format: 'compact', duplicates: 'distinct', maxLabelChars: 2000 });
  const input = { enabled: false, groupBy: ['Owner.Team'], format: 'tree', duplicates: 'preserve', maxLabelChars: 64 };
  assert.deepEqual(normalizeEdgeAggregation(input), input);
  assert.notEqual(normalizeEdgeAggregation(input).groupBy, input.groupBy);
  defaults.groupBy.push('Changed');
  assert.deepEqual(normalizeEdgeAggregation({}).groupBy, []);
});

test('validation rejects unknown keys and invalid types without coercion or normalization loss', () => {
  for (const value of [null, false, 1, 'compact', [], new Date()]) assert.ok(validateEdgeAggregation(value).length);
  for (const value of [
    { enabled: 'true' }, { enabled: 0 }, { enabled: undefined }, { groupBy: 'Protocol' },
    { groupBy: [1] }, { groupBy: [' '] }, { groupBy: [null] }, { format: 'other' },
    { duplicates: 'other' }, { maxLabelChars: '2000' }, { maxLabelChars: 64.5 }, { extra: true }
  ]) {
    assert.ok(validateEdgeAggregation(value).length);
    assert.throws(() => normalizeEdgeAggregation(value), { name: 'DiagramEdgeAggregationError', statusCode: 422, code: 'diagram_edge_aggregation_invalid' });
  }
  assert.deepEqual(validateEdgeAggregation(undefined), []);
});

test('validation enforces field and label boundaries with precise caller paths', () => {
  for (const maxLabelChars of [64, 20000]) assert.deepEqual(validateEdgeAggregation({ maxLabelChars }), []);
  for (const maxLabelChars of [0, 63, 20001, NaN, Infinity]) assert.ok(validateEdgeAggregation({ maxLabelChars }).length);
  assert.deepEqual(validateEdgeAggregation({ groupBy: Array(32).fill('Protocol') }), []);
  assert.ok(validateEdgeAggregation({ groupBy: Array(33).fill('Protocol') }).length);
  for (const availableFields of [new Set(['Protocol']), ['Protocol']]) {
    assert.deepEqual(validateEdgeAggregation({ groupBy: ['Protocol'] }, { availableFields }), []);
    assert.deepEqual(validateEdgeAggregation({ groupBy: ['Unknown'] }, { path: '$.mapping.aggregation', availableFields }), [
      { path: '$.mapping.aggregation.groupBy[0]', message: 'Group field is not available in the source.' }
    ]);
  }
});

test('one hundred source records become one connection with complete provenance and diagnostics', () => {
  const input = Array.from({ length: 100 }, (_, index) => edge(index + 1, { Protocol: 'TCP', Port: index + 1 }));
  const result = aggregateDiagramEdges(input);
  assert.equal(result.edges.length, 1);
  const output = result.edges[0];
  assert.equal(output.data.aggregation.memberCount, 100);
  assert.equal(output.data.aggregation.connectionCount, 100);
  assert.equal(output.data.aggregation.members.length, 100);
  assert.match(output.label, /^TCP \[1, 2, 3,/);
  assert.deepEqual(result.diagnostics, [{ label: 'Connection', inputEdges: 100, outputEdges: 1, uniqueRecords: 100, truncatedLabels: 0 }]);
  assert.deepEqual(result.warnings, []);
});

test('compact labels group protocol examples and sort terminal labels naturally', () => {
  const output = aggregate([edge(1, { Protocol: 'UDP', Port: 53 }), edge(2, { Protocol: 'TCP', Port: 443 }), edge(3, { Protocol: 'TCP', Port: 80 })]);
  assert.equal(output.label, 'TCP [80, 443]\nUDP [53]');
});

test('arbitrary non-network ordered fields support compact multi-level hierarchies', () => {
  const options = { aggregation: { enabled: true, groupBy: ['Owner.Team', 'Category'] } };
  const output = aggregate([
    edge(1, { Owner: { Team: 'Operations' }, Category: 'Policy' }, { ...options, label: 'Review' }),
    edge(2, { Owner: { Team: 'Operations' }, Category: 'Asset' }, { ...options, label: 'Laptop' }),
    edge(3, { Owner: { Team: 'Finance' }, Category: 'Asset' }, { ...options, label: 'Invoice' })
  ]);
  assert.equal(output.label, 'Finance [Asset [Invoice]]\nOperations [Asset [Laptop], Policy [Review]]');
  assert.equal(output.data.aggregation.groups[1].field, 'Owner.Team');
  assert.equal(output.data.aggregation.groups[1].groups[0].field, 'Category');
});

test('tree formatting respects field order and fixed indentation at two levels', () => {
  const options = { aggregation: { enabled: true, groupBy: ['Team', 'Priority'], format: 'tree' } };
  const output = aggregate([edge(1, { Team: 'Ops', Priority: 10 }, { ...options, label: 'Review' }), edge(2, { Team: 'Ops', Priority: 2 }, { ...options, label: 'Approve' })]);
  assert.equal(output.label, 'Ops\n  2\n    Approve\n  10\n    Review');
});

test('distinct deduplicates only leaf labels, while preserve retains record occurrences', () => {
  const input = [edge(1, { Protocol: 'TCP', Port: 80 }), edge(2, { Protocol: 'TCP', Port: 80 }), edge(3, { Protocol: 'UDP', Port: 80 })];
  assert.equal(aggregate(input).label, 'TCP [80]\nUDP [80]');
  const preserved = input.map((item) => ({ ...item, runtimeMapping: { ...item.runtimeMapping, aggregation: { enabled: true, groupBy: ['Protocol'], duplicates: 'preserve' } } }));
  assert.equal(aggregate(preserved).label, 'TCP [80, 80]\nUDP [80]');
  assert.equal(aggregate(input).data.aggregation.connectionCount, 3);
});

test('profile endpoint matches retain all edge IDs without inflating source record counts', () => {
  const first = edge(1, { Protocol: 'TCP', Port: 80 });
  const secondProfile = { ...first, id: 'profile-edge-2', data: { profile: 'second', endpointResolution: { score: 2 } } };
  const thirdProfile = { ...first, id: 'profile-edge-3' };
  for (const duplicates of ['distinct', 'preserve']) {
    const input = [first, secondProfile, thirdProfile].map((item) => ({ ...item, runtimeMapping: { ...item.runtimeMapping, aggregation: { enabled: true, groupBy: ['Protocol'], duplicates } } }));
    const result = aggregateDiagramEdges(input);
    assert.equal(result.edges[0].label, 'TCP [80]');
    assert.equal(result.edges[0].data.aggregation.connectionCount, 1);
    assert.equal(result.edges[0].data.aggregation.memberCount, 1);
    assert.deepEqual(result.edges[0].data.aggregation.members.map((item) => item.id).sort(), ['edge-1', 'profile-edge-2', 'profile-edge-3']);
    assert.equal(result.diagnostics[0].uniqueRecords, 1);
  }
});

test('null, absent and blank fields share a missing bucket distinct from the literal missing label', () => {
  const input = [undefined, null, '', '  ', missingLabel].map((Protocol, index) => edge(index, { Protocol }, { label: `leaf-${index}` }));
  const output = aggregate(input);
  assert.equal(output.data.aggregation.groups.length, 2);
  assert.equal(output.data.aggregation.groups[0].missing, true);
  assert.equal(output.data.aggregation.groups[0].values.length, 4);
  assert.equal(output.data.aggregation.groups[1].missing, false);
  assert.equal(output.data.aggregation.groups[1].label, missingLabel);
});

test('raw typed groups cannot collapse when display text is identical', () => {
  const output = aggregate([edge(1, { Protocol: 1 }), edge(2, { Protocol: '1' }), edge(3, { Protocol: true })], { displayValue: () => 'same' });
  assert.equal(output.data.aggregation.groups.length, 3);
  assert.deepEqual(output.data.aggregation.groups.map((item) => item.type), ['boolean', 'number', 'string']);
});

test('lookup grouping uses typed identity rather than descriptions or object property order', () => {
  for (const field of ['_id', 'id', 'code', 'value']) {
    const output = aggregate([
      edge(1, { Protocol: { [field]: 1, description: 'Same' } }),
      edge(2, { Protocol: { description: 'Renamed', [field]: 1 } }),
      edge(3, { Protocol: { [field]: '1', description: 'Same' } }),
      edge(4, { Protocol: { [field]: 2, description: 'Same' } })
    ], { displayValue: (value) => value.description });
    assert.equal(output.data.aggregation.groups.length, 3);
    assert.equal(output.data.aggregation.groups[0].values.length, 2);
  }
});

test('arrays are atomic group values with no scalar expansion or Cartesian multiplication', () => {
  const options = { aggregation: { enabled: true, groupBy: ['Tags', 'Owners'] } };
  const output = aggregate([
    edge(1, { Tags: ['A', 'B'], Owners: ['X', 'Y'] }, { ...options, label: 'One' }),
    edge(2, { Tags: ['A', 'B'], Owners: ['X', 'Y'] }, { ...options, label: 'Two' }),
    edge(3, { Tags: ['B', 'A'], Owners: ['X', 'Y'] }, { ...options, label: 'Three' })
  ]);
  assert.equal(output.data.aggregation.groups.length, 2);
  assert.equal(output.data.aggregation.groups[0].groups.length, 1);
  assert.equal(output.data.aggregation.connectionCount, 3);
});

test('actual numeric groups sort numerically without conflating numeric strings', () => {
  const output = aggregate([10, 2, -1, '2'].map((Protocol, index) => edge(index, { Protocol })));
  assert.deepEqual(output.data.aggregation.groups.map((item) => item.label), ['-1', '2', '10', '2']);
  const leaves = aggregate([10, 2, -1].map((label, index) => edge(index, { Protocol: 'Numbers' }, { label })));
  assert.equal(leaves.label, 'Numbers [-1, 2, 10]');
});

test('direction keeps directed reverse pairs separate and canonicalizes undirected endpoints and D2 paths', () => {
  const forward = edge(1, { Protocol: 'TCP' });
  const reverse = edge(2, { Protocol: 'TCP' }, { source: 'visual-b', target: 'visual-a', sourceD2Id: 'root.b', targetD2Id: 'root.a' });
  assert.equal(aggregateDiagramEdges([forward, reverse]).edges.length, 2);
  const undirected = [reverse, forward].map((item) => ({ ...item, direction: '--' }));
  const output = aggregate(undirected);
  assert.equal(output.source, 'visual-a');
  assert.equal(output.target, 'visual-b');
  assert.equal(output.sourceD2Id, 'root.a');
  assert.equal(output.targetD2Id, 'root.b');
  assert.equal(output.d2Id, output.id);
  assert.notEqual(output.id, forward.id);
  assert.deepEqual(aggregateDiagramEdges(undirected), aggregateDiagramEdges([...undirected].reverse()));
  assert.equal(aggregateDiagramEdges([forward, { ...reverse, direction: '<->' }]).edges.length, 2);
  const policy = [reverse, forward].map((item) => ({ ...item, runtimeMapping: { ...item.runtimeMapping, importRole: { directionPolicy: 'undirected' } } }));
  assert.equal(aggregateDiagramEdges(policy).edges.length, 1);
});

test('copied visual placements do not merge and do not inflate rule uniqueRecords', () => {
  const first = edge(1, { Protocol: 'TCP' });
  const copy = { ...first, id: 'copied-edge', source: 'visual-a-copy', sourceD2Id: 'copy.a' };
  const result = aggregateDiagramEdges([first, copy]);
  assert.equal(result.edges.length, 2);
  assert.equal(result.diagnostics[0].uniqueRecords, 1);
});

test('mapping, type, class, blueprint, direction and style form aggregation boundaries', () => {
  const first = edge(1, { Protocol: 'TCP' });
  const changes = [
    { runtimeMapping: { ...first.runtimeMapping, id: 'other-rule' } },
    { runtimeMapping: { ...first.runtimeMapping, type: 'relation' } }, { kind: 'other' },
    { className: 'Other' }, { importRole: { ...first.importRole, edgeClassKey: 'other-class' } },
    { blueprintKey: 'other-blueprint' }, { direction: '<-' }, { styleHints: { stroke: 'red' } }
  ];
  for (const properties of changes) assert.equal(aggregateDiagramEdges([first, { ...first, id: 'other-edge', ...properties }]).edges.length, 2);
  const styled = { ...first, styleHints: { stroke: 'red', width: 2 } };
  assert.equal(aggregateDiagramEdges([styled, { ...styled, id: 'other-edge', styleHints: { width: 2, stroke: 'red' } }]).edges.length, 1);
});

test('input and object-key permutations preserve IDs, labels, details and diagnostics', () => {
  const input = Array.from({ length: 20 }, (_, index) => edge(index, { Protocol: index % 2 ? 'TCP' : 'UDP', Port: index + 1 }));
  const expected = aggregateDiagramEdges(input);
  for (let offset = 1; offset < input.length; offset += 1) {
    const permuted = [...input.slice(offset), ...input.slice(0, offset)].reverse();
    assert.deepEqual(aggregateDiagramEdges(permuted), expected);
    assert.equal(JSON.stringify(aggregateDiagramEdges(permuted)), JSON.stringify(expected));
  }
  const anonymous = input.map((item) => ({ ...item, runtimeRow: { Protocol: item.runtimeRow.Protocol, Port: item.runtimeRow.Port } }));
  const permutedKeys = anonymous.map((item) => ({ ...item, runtimeRow: { Port: item.runtimeRow.Port, Protocol: item.runtimeRow.Protocol } })).reverse();
  assert.deepEqual(aggregateDiagramEdges(anonymous), aggregateDiagramEdges(permutedKeys));
});

test('custom field reader, display and hash callbacks receive the generic contract', () => {
  const fields = [];
  const hashes = [];
  const output = aggregate([edge(1, { nested: { owner: 'Ops' } }, { aggregation: { enabled: true, groupBy: ['owner'] } })], {
    readField: (row, field) => { fields.push(field); return row.nested[field]; },
    displayValue: (value) => value.toUpperCase(),
    hash: (text) => { hashes.push(text); return 'provided-digest'; }
  });
  assert.equal(output.id, 'edge_aggregation_provided-digest');
  assert.equal(output.label, 'OPS [1]');
  assert.deepEqual(fields, ['owner']);
  assert.equal(hashes.length, 1);
});

test('quotes, backslashes and control characters remain plain safely bounded label text', () => {
  const output = aggregate([edge(1, { Protocol: 'A"\\B\nC' }, { label: 'value"\\\t\r\n\u0000' })]);
  assert.equal(output.label, 'A"\\B\\nC [value"\\\\t\\r\\n\\u0000]');
  assert.equal(JSON.parse(JSON.stringify(output.label)), output.label);
});

test('truncation fits the hard cap and reports exactly hidden leaf values with full detail hierarchy', () => {
  for (const format of ['compact', 'tree']) {
    const input = Array.from({ length: 40 }, (_, index) => edge(index, { Protocol: index < 20 ? 'TCP' : 'UDP' }, { label: `connection-${index.toString().padStart(3, '0')}`, aggregation: { enabled: true, groupBy: ['Protocol'], format, maxLabelChars: 64 } }));
    const result = aggregateDiagramEdges(input);
    const output = result.edges[0];
    const details = output.data.aggregation;
    assert.ok(output.label.length <= 64);
    assert.equal(details.labelTruncated, true);
    assert.match(output.label, new RegExp(`\\(\\+${details.hiddenValues} hidden values\\)$`));
    assert.equal(details.groups.flatMap((group) => group.values).length, 40);
    assert.equal(output.label.match(/connection-\d+/g).length + details.hiddenValues, 40);
    assert.equal(details.members.length, 40);
    assert.equal(result.diagnostics[0].truncatedLabels, 1);
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.warnings[0].includes('edge-'));
  }
});

test('a single oversized group or terminal label still shows the hidden count marker', () => {
  for (const properties of [{ Protocol: 'x'.repeat(500) }, { Protocol: 'Short', Port: 'x'.repeat(500) }]) {
    const output = aggregate([edge(1, properties, { aggregation: { enabled: true, groupBy: ['Protocol'], maxLabelChars: 64 } })]);
    assert.equal(output.label, '... (+1 hidden values)');
    assert.equal(output.data.aggregation.hiddenValues, 1);
    assert.ok(output.data.aggregation.groups[0].values[0].label);
  }
  const longLabel = 'x'.repeat(20001);
  const output = aggregate([edge(1, {}, { aggregation: { enabled: true, maxLabelChars: 20000 }, label: longLabel })]);
  assert.equal(output.label, '... (+1 hidden values)');
  assert.equal(output.data.aggregation.groups[0].values[0].label, longLabel);
});

test('aggregate metadata exposes only safe member data and no arbitrary first-row fields or raw rows', () => {
  const input = [edge(1, { Protocol: 'TCP', SecretNotSelected: 'private-raw-marker' }), edge(2, { Protocol: 'TCP', SecretNotSelected: 'another-raw-marker' })];
  input[0].sourceRef = { id: 'not-an-aggregate-source' };
  input[0].fields = { raw: 'not-an-aggregate-field' };
  input[0].runtimeSourceBusinessId = 'private-business-id';
  const output = aggregate(input);
  for (const key of ['runtimeRow', 'runtimeMapping', 'runtimeSourceBusinessId', 'sourceRef', 'fields']) assert.equal(Object.hasOwn(output, key), false);
  assert.equal(Object.hasOwn(output.data, 'sourceRef'), false);
  assert.equal(Object.hasOwn(output.data, 'fields'), false);
  assert.ok(!JSON.stringify(output).includes('private-raw-marker'));
  assert.ok(!JSON.stringify(output).includes('another-raw-marker'));
  for (const member of output.data.aggregation.members) {
    const original = input.find((item) => item.id === member.id);
    assert.deepEqual(member.data, original.data);
    assert.notEqual(member.data, original.data);
  }
});

test('frozen incoming arrays, mappings, rows and data are never mutated', () => {
  const input = deepFreeze([edge(1, { Protocol: 'TCP', Port: 80 }), edge(2, { Protocol: 'UDP', Port: 53 })]);
  const before = JSON.stringify(input);
  const output = aggregate(input);
  output.data.aggregation.members[0].data.fields.Port.value = 'changed-output';
  assert.equal(JSON.stringify(input), before);
});

test('disabled, absent, hierarchy and static aggregations leave arrays and items unchanged', () => {
  const input = [
    edge(1, {}, { aggregation: undefined, mapping: { aggregation: undefined } }),
    edge(2, {}, { aggregation: { enabled: false, groupBy: ['Protocol'], duplicates: 'preserve' } }),
    edge(3, {}, { mapping: { type: 'hierarchy' } }),
    edge(4, {}, { importRole: { key: 'static:declared-arrow' } }),
    edge(5, {}, { importRole: { templateStatic: true } }),
    edge(6, {}, { blueprintKey: 'static:blueprint' })
  ];
  assert.equal(aggregateDiagramEdges(input).edges, input);
  assert.deepEqual(aggregateDiagramEdges(input).diagnostics, []);
  assert.deepEqual(aggregateDiagramEdges(input).warnings, []);
  const empty = [];
  assert.equal(aggregateDiagramEdges(empty).edges, empty);
});

test('empty groupBy aggregates only terminal labels and keeps full terminal details', () => {
  const output = aggregate([edge(1, {}, { aggregation: { enabled: true }, label: 'Second' }), edge(2, {}, { aggregation: { enabled: true }, label: 'First' })]);
  assert.equal(output.label, 'First\nSecond');
  assert.deepEqual(output.data.aggregation.groups[0].values.map((item) => item.label), ['First', 'Second']);
});

test('business staticRows are usable unless the mapping is explicitly a static blueprint', () => {
  const options = { aggregation: { enabled: true, groupBy: ['Category'] }, mapping: { staticRows: [{ Category: 'A' }, { Category: 'B' }] } };
  const input = [edge(1, { Category: 'B' }, options), edge(2, { Category: 'A' }, options)];
  const result = aggregateDiagramEdges(input);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].label, 'A [2]\nB [1]');
  assert.equal(result.edges[0].data.aggregation.memberCount, 2);
  assert.equal(JSON.stringify(aggregateDiagramEdges([...input].reverse())), JSON.stringify(result));
});

test('invalid runtime configurations throw a typed 422 error, including disabled invalid settings', () => {
  const input = [edge(1, {}, { aggregation: { enabled: false, format: 'invalid' } })];
  assert.throws(() => aggregateDiagramEdges(input), (error) => {
    assert.equal(error.name, 'DiagramEdgeAggregationError');
    assert.equal(error.code, 'diagram_edge_aggregation_invalid');
    assert.equal(error.statusCode, 422);
    assert.deepEqual(error.details, [{ path: '$.edges[0].runtimeMapping.aggregation.format', message: 'format must be compact or tree.' }]);
    return true;
  });
});
