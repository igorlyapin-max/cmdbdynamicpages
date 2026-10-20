import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantBindingHandles } from '../../scripts/assistant-binding-handles.mjs';

const placements = [
  { structureItemId: 'structure_city_parent_aaaaaaaa', visualKind: 'container', displayName: 'City' },
  { structureItemId: 'structure_building_bbbbbbbb', parentStructureItemId: 'structure_city_parent_aaaaaaaa', visualKind: 'node', displayName: 'Building' },
  { structureItemId: 'structure_building_copy_cccccccc', parentStructureItemId: 'structure_city_parent_aaaaaaaa', visualKind: 'node', displayName: 'Building copy' },
  { structureItemId: 'structure_other_parent_dddddddd', visualKind: 'container', displayName: 'Other City' }
];
const parentId = placements[0].structureItemId;
const childId = placements[1].structureItemId;
const copyId = placements[2].structureItemId;

test('typed handles are deterministic in input order with independent kind counters', () => {
  const handles = createAssistantBindingHandles(placements);
  const input = { placements };
  const output = handles.encode(input);
  assert.deepEqual(output.placements.map((placement) => placement.structureItemId), ['container_1', 'node_1', 'node_2', 'container_2']);
  assert.equal(output.placements[1].parentStructureItemId, 'container_1');
  assert.equal(output.placements[2].parentStructureItemId, 'container_1');
  assert.deepEqual(output, createAssistantBindingHandles(structuredClone(placements)).encode(input));
  assert.deepEqual(Object.keys(handles).sort(), ['decode', 'encode']);
  assert.deepEqual(handles.decode(output), input);
});

test('sibling and copy references decode independently and preserve the chosen parent', () => {
  const handles = createAssistantBindingHandles(placements);
  const response = { placements: [
    { structureItemId: 'node_1', parentStructureItemId: 'container_1' },
    { structureItemId: 'node_2', parentStructureItemId: 'container_2' }
  ] };
  assert.deepEqual(handles.decode(response), { placements: [
    { structureItemId: childId, parentStructureItemId: parentId },
    { structureItemId: copyId, parentStructureItemId: placements[3].structureItemId }
  ] });
});

test('reference keys are transformed recursively and targetId is placement-only', () => {
  const handles = createAssistantBindingHandles(placements);
  const payload = { nested: [[{ structureItemId: childId, parentStructureItemId: parentId }]], unresolved: [
    { targetType: 'placement', targetId: copyId },
    { targetType: 'connection', targetId: childId },
    { targetId: parentId }
  ] };
  const encoded = handles.encode(payload);
  assert.equal(encoded.nested[0][0].structureItemId, 'node_1');
  assert.equal(encoded.unresolved[0].targetId, 'node_2');
  assert.equal(encoded.unresolved[1].targetId, childId);
  assert.equal(encoded.unresolved[2].targetId, parentId);
  assert.deepEqual(handles.decode(encoded), payload);
  assert.equal(handles.decode({ targetType: 'connection', targetId: 'node_1' }).targetId, 'node_1');
  assert.equal(handles.decode({ targetId: 'container_1' }).targetId, 'container_1');
});

test('encoding replaces only exact known references, never arbitrary text or identifiers', () => {
  const handles = createAssistantBindingHandles(placements);
  const unchanged = {
    value: childId, labelTemplate: '${' + childId + '}', field: childId, path: childId,
    cardSourceId: childId, classId: childId, className: childId, businessBlockId: childId,
    id: childId, roleId: childId, text: `Use ${childId}`, explanation: `Use ${childId}`,
    structureItemId: `prefix:${childId}`, parentStructureItemId: `${parentId}.field`
  };
  assert.deepEqual(handles.encode(unchanged), unchanged);
  assert.deepEqual(handles.encode({ structureItemId: 1, parentStructureItemId: null }), { structureItemId: 1, parentStructureItemId: null });
});

test('decode preserves literal handle strings, field paths, card sources and templates byte for byte', () => {
  const handles = createAssistantBindingHandles(placements);
  const payload = {
    value: 'node_1', labelTemplate: '${node_1} container_1', field: 'node_1', path: 'container_1.field',
    cardSourceId: 'node_1', classId: 'node_1', className: 'container_1', businessBlockId: 'node_2',
    id: 'node_1', roleId: 'container_1', text: 'node_1 and container_1',
    nested: { value: { message: 'node_1', structureItemId: 'node_1' }, labelTemplate: { reason: 'container_1' } }
  };
  assert.deepEqual(handles.decode(payload), payload);
  const raw = { value: { structureItemId: childId, parentStructureItemId: parentId, warnings: ['node_1'] } };
  assert.deepEqual(handles.encode(raw), raw);
});

test('unknown handles and unknown parents remain intact for the existing validator to reject', () => {
  const handles = createAssistantBindingHandles(placements);
  const response = { structureItemId: 'node_1', parentStructureItemId: 'container_99', unresolved: [{ targetType: 'placement', targetId: 'node_99' }] };
  const decoded = handles.decode(response);
  assert.equal(decoded.structureItemId, childId);
  assert.equal(decoded.parentStructureItemId, 'container_99');
  assert.equal(decoded.unresolved[0].targetId, 'node_99');
  const known = new Set(placements.map((placement) => placement.structureItemId));
  assert.equal(known.has(decoded.parentStructureItemId), false);
  assert.equal(known.has(decoded.unresolved[0].targetId), false);
  assert.deepEqual(handles.encode({ structureItemId: 'unknown-structure', parentStructureItemId: '' }), { structureItemId: 'unknown-structure', parentStructureItemId: '' });
});

test('known response free text projects standalone handles to display names, including warnings arrays', () => {
  const handles = createAssistantBindingHandles(placements);
  const response = {
    explanation: 'node_1 belongs to container_1.',
    message: 'Compare node_1, node_2; unknown node_99.',
    reason: '[container_2]: node_2',
    warnings: ['node_1', ['container_1'], { message: 'node_2', code: 'node_1', value: 'container_1' }],
    details: { message: 'container_1: check node_1' }
  };
  assert.deepEqual(handles.decode(response), {
    explanation: 'Building belongs to City.',
    message: 'Compare Building, Building copy; unknown node_99.',
    reason: '[Other City]: Building copy',
    warnings: ['Building', ['City'], { message: 'Building copy', code: 'node_1', value: 'container_1' }],
    details: { message: 'City: check Building' }
  });
  assert.deepEqual(handles.encode(response), response, 'request free text is never rewritten');
});

test('free text does not project handle substrings, longer handles or field-path tokens', () => {
  const handles = createAssistantBindingHandles(placements);
  const text = 'prefix_node_1 node_10 node_1suffix node_1.Description x.node_1 path/node_1 node_1-other';
  assert.equal(handles.decode({ message: text }).message, text);
  assert.equal(handles.decode({ message: '(node_1) node_1.' }).message, '(Building) Building.');
});

test('missing display names use user-facing fallback text, not internal ids', () => {
  const handles = createAssistantBindingHandles([
    { structureItemId: 'opaque-a', visualKind: 'node' },
    { structureItemId: 'opaque-b', visualKind: 'container', displayName: '  ' },
    { structureItemId: 'opaque-c', visualKind: 'node', displayName: 'opaque-c' }
  ]);
  const result = handles.decode({ warnings: ['node_1', 'container_1', 'node_2'] });
  assert.ok(result.warnings.every((warning) => warning === '\u044d\u043b\u0435\u043c\u0435\u043d\u0442 \u0434\u0438\u0430\u0433\u0440\u0430\u043c\u043c\u044b'));
  assert.doesNotMatch(JSON.stringify(result), /opaque-|node_\d|container_\d/);
});

test('unknown and missing visual kinds use independent safe placement handles', () => {
  const input = [
    { structureItemId: 'a', visualKind: 'unknown' },
    { structureItemId: 'b', visualKind: 'node' },
    { structureItemId: 'c' },
    { structureItemId: 'd', visualKind: 'container' }
  ];
  const handles = createAssistantBindingHandles(input);
  assert.deepEqual(handles.encode(input).map((placement) => placement.structureItemId), ['placement_1', 'node_1', 'placement_2', 'container_1']);
  assert.deepEqual(handles.decode(handles.encode(input)), input);
});

test('invalid and duplicate placement ids fail closed with explicit error codes', () => {
  for (const value of [undefined, null, {}, [null], [{}], [{ structureItemId: '' }], [{ structureItemId: 1 }], [{ structureItemId: ' ' }]]) {
    assert.throws(() => createAssistantBindingHandles(value), { code: 'assistant_binding_handles_invalid_placements' });
  }
  assert.throws(() => createAssistantBindingHandles([placements[0], { ...placements[0], visualKind: 'node' }]), { code: 'assistant_binding_handles_duplicate_id' });
});

test('generated handles cannot collide with any original id, including later placements', () => {
  for (const input of [
    [{ structureItemId: 'node_1', visualKind: 'node' }],
    [{ structureItemId: 'a', visualKind: 'node' }, { structureItemId: 'node_1', visualKind: 'container' }],
    [{ structureItemId: 'a' }, { structureItemId: 'placement_1', visualKind: 'container' }]
  ]) assert.throws(() => createAssistantBindingHandles(input), { code: 'assistant_binding_handles_collision' });
});

test('empty mappings and JSON primitives round trip without modifying data', () => {
  const handles = createAssistantBindingHandles([]);
  for (const value of [null, false, 0, '', 'node_1', [], {}, { nested: [1, 'node_1', { structureItemId: 'x' }] }]) {
    assert.deepEqual(handles.decode(handles.encode(value)), value);
  }
});

test('encode and decode are pure on frozen nested inputs and retain a request-local snapshot', () => {
  const frozen = Object.freeze(placements.map((placement) => Object.freeze({ ...placement })));
  const handles = createAssistantBindingHandles(frozen);
  const payload = Object.freeze({ nested: Object.freeze([Object.freeze({ structureItemId: childId, parentStructureItemId: parentId })]) });
  const before = JSON.stringify({ frozen, payload });
  assert.deepEqual(handles.decode(handles.encode(payload)), payload);
  assert.equal(JSON.stringify({ frozen, payload }), before);
  const mutable = structuredClone(placements);
  const snapshot = createAssistantBindingHandles(mutable);
  mutable[0].structureItemId = 'changed';
  mutable[0].displayName = 'Changed';
  assert.deepEqual(snapshot.decode({ structureItemId: 'container_1', message: 'container_1' }), { structureItemId: parentId, message: 'City' });
});
