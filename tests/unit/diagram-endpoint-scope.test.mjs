import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramObjectsWithinScope, resolveDiagramEndpointScope } from '../../scripts/diagram-endpoint-scope.mjs';

const roles = [
  { id: 'city-role', visualKind: 'container' },
  { id: 'building-role', visualKind: 'node' }
];
const tree = { items: [
  { id: 'city-item', templateElementKey: 'region.city', roleId: 'city-role' },
  { id: 'building-item', templateElementKey: 'region.city.building', roleId: 'building-role' }
] };

function expectError(value, inputTree, inputRoles, code) {
  const result = resolveDiagramEndpointScope(value, inputTree, inputRoles);
  assert.equal(result.structureItemId, '');
  assert.equal(result.error?.code, code);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
}

test('optional empty scope does not require a tree or roles', () => {
  for (const value of ['', undefined, null]) assert.deepEqual(resolveDiagramEndpointScope(value, null), { structureItemId: '', error: null });
});

test('scope resolves only the exact item id or exact template element key', () => {
  for (const value of ['city-item', 'region.city']) assert.deepEqual(resolveDiagramEndpointScope(value, tree, roles), { structureItemId: 'city-item', error: null });
  for (const value of ['City', 'city', 'REGION.CITY', ' region.city ', 'region']) expectError(value, tree, roles, 'diagram_endpoint_scope_not_found');
});

test('scope accepts an explicit isContainer role when visualKind is absent', () => {
  assert.deepEqual(resolveDiagramEndpointScope('city-item', tree, [{ id: 'city-role', isContainer: true }]), { structureItemId: 'city-item', error: null });
});

test('nodes, unknown roles and contradictory container roles fail closed', () => {
  expectError('building-item', tree, roles, 'diagram_endpoint_scope_not_container');
  expectError('city-item', tree, [], 'diagram_endpoint_scope_not_container');
  expectError('city-item', tree, undefined, 'diagram_endpoint_scope_not_container');
  expectError('city-item', tree, [{ id: 'city-role', visualKind: 'node', isContainer: true }], 'diagram_endpoint_scope_not_container');
  expectError('city-item', tree, [{ id: 'city-role', visualKind: 'container', isContainer: false }], 'diagram_endpoint_scope_not_container');
  expectError('city-item', tree, [{ id: 'city-role', visualKind: 'other', isContainer: true }], 'diagram_endpoint_scope_not_container');
});

test('duplicate template keys and cross-namespace matches are ambiguous', () => {
  const other = { id: 'other-item', templateElementKey: 'region.city', roleId: 'city-role' };
  expectError('region.city', { items: [...tree.items, other] }, roles, 'diagram_endpoint_scope_ambiguous');
  expectError('city-item', { items: [...tree.items, { ...other, templateElementKey: 'city-item' }] }, roles, 'diagram_endpoint_scope_ambiguous');
  assert.deepEqual(resolveDiagramEndpointScope('city-item', { items: [{ ...tree.items[0], templateElementKey: 'city-item' }] }, roles), { structureItemId: 'city-item', error: null });
});

test('duplicate item ids or role ids cannot select an arbitrary match', () => {
  expectError('region.city', { items: [...tree.items, { ...tree.items[0], templateElementKey: 'region.other' }] }, roles, 'diagram_endpoint_scope_ambiguous');
  expectError('city-item', tree, [...roles, { id: 'city-role', visualKind: 'container' }], 'diagram_endpoint_scope_ambiguous');
});

test('malformed lookup values and items fail without guessing or throwing', () => {
  for (const value of [0, false, {}, [], ' ']) expectError(value, tree, roles, 'diagram_endpoint_scope_invalid');
  for (const input of [null, {}, { items: null }, { items: [null, false] }]) expectError('city-item', input, roles, 'diagram_endpoint_scope_not_found');
  expectError('region.city', { items: [{ templateElementKey: 'region.city', roleId: 'city-role' }] }, roles, 'diagram_endpoint_scope_invalid');
  expectError('region.city', { items: [{ ...tree.items[0], roleId: null }] }, roles, 'diagram_endpoint_scope_not_container');
});

const city = { id: 'city-runtime', parent: '', importRole: { structureItemId: 'city-item' } };
const district = { id: 'district-runtime', parent: city.id, importRole: { structureItemId: 'district-item' } };
const building = { id: 'building-runtime', group: district.id, importRole: { structureItemId: 'building-item' } };
const otherCity = { id: 'other-city-runtime', parent: '', importRole: { structureItemId: 'other-city-item' } };
const otherBuilding = { id: 'other-building-runtime', group: otherCity.id, importRole: { structureItemId: 'building-item' } };

test('no scope preserves the original array and objects, including old unplaced inputs', () => {
  const input = [city, building, null, { id: 'unplaced', group: 'missing' }];
  for (const scope of ['', undefined, null]) assert.equal(diagramObjectsWithinScope(input, scope), input);
});

test('City scope includes itself, nested groups and Building nodes only within its ancestry', () => {
  const input = [otherBuilding, building, city, district, otherCity];
  assert.deepEqual(diagramObjectsWithinScope(input, 'city-item'), [building, city, district]);
  assert.deepEqual(diagramObjectsWithinScope(input, 'district-item'), [building, district]);
  assert.deepEqual(diagramObjectsWithinScope(input, 'unknown-item'), []);
  assert.deepEqual(diagramObjectsWithinScope(input, 'City'), []);
});

test('all runtime copies of one placement are accepted without mixing their ancestry', () => {
  const copiedCity = { ...city, id: 'copied-city-runtime' };
  const copiedDistrict = { ...district, id: 'copied-district-runtime', parent: copiedCity.id };
  const copiedBuilding = { ...building, id: 'copied-building-runtime', group: copiedDistrict.id };
  const input = [building, copiedBuilding, otherBuilding, district, copiedDistrict, copiedCity, city, otherCity];
  assert.deepEqual(diagramObjectsWithinScope(input, 'city-item'), [building, copiedBuilding, district, copiedDistrict, copiedCity, city]);
  assert.deepEqual(diagramObjectsWithinScope([otherCity, otherBuilding], 'city-item'), []);
});

test('unplaced objects and broken ancestry do not inherit scope from another copy', () => {
  const input = [city, { ...building, group: 'missing' }, { ...otherBuilding, group: '' }, { id: 'unplaced', group: '' }];
  assert.deepEqual(diagramObjectsWithinScope(input, 'city-item'), [city]);
  const brokenCity = { ...city, parent: 'missing-parent' };
  assert.deepEqual(diagramObjectsWithinScope([brokenCity, { ...building, group: brokenCity.id }], 'city-item'), []);
});

test('cycles fail closed even when the scope placement appears before the cycle', () => {
  const cyclicCity = { ...city, parent: district.id };
  const cyclicDistrict = { ...district, parent: cyclicCity.id };
  const child = { ...building, group: cyclicDistrict.id };
  assert.deepEqual(diagramObjectsWithinScope([cyclicCity, cyclicDistrict, child], 'city-item'), []);
  const self = { ...city, parent: city.id };
  assert.deepEqual(diagramObjectsWithinScope([self], 'city-item'), []);
});

test('duplicate runtime ids invalidate the ambiguous objects and their descendants', () => {
  const duplicate = { ...city, importRole: { structureItemId: 'other-city-item' } };
  assert.deepEqual(diagramObjectsWithinScope([city, duplicate, district, building], 'city-item'), []);
});

test('malformed scoped inputs and ancestry fields fail closed', () => {
  for (const objects of [null, undefined, {}, 'objects']) assert.deepEqual(diagramObjectsWithinScope(objects, 'city-item'), []);
  for (const scope of [false, 1, {}, [], ' ']) assert.deepEqual(diagramObjectsWithinScope([city, district, building], scope), []);
  for (const malformed of [null, [], {}, { id: 1 }, { ...building, group: null }, { ...building, group: [] }, { ...building, group: 1 }, { ...city, parent: false }, { ...city, importRole: 'city-item' }, { ...city, importRole: { structureItemId: 1 } }]) {
    assert.deepEqual(diagramObjectsWithinScope([malformed], 'city-item'), []);
  }
});

test('node group is authoritative and never falls back to node parent or card fields', () => {
  const unplaced = { ...building, group: '', parent: city.id, businessId: city.id, className: 'City' };
  const malformed = { ...building, group: null, parent: city.id };
  const noOwnRole = { id: 'building-without-role', group: city.id };
  assert.deepEqual(diagramObjectsWithinScope([city, unplaced, malformed, noOwnRole], 'city-item'), [city, noOwnRole]);
});

test('scope helpers leave frozen inputs untouched', () => {
  const input = [city, district, building, otherCity, otherBuilding].map((item) => Object.freeze({ ...item, importRole: Object.freeze({ ...item.importRole }) }));
  Object.freeze(input);
  const frozenTree = Object.freeze({ items: Object.freeze(tree.items.map((item) => Object.freeze({ ...item }))) });
  const before = JSON.stringify({ input, frozenTree, roles });
  assert.deepEqual(resolveDiagramEndpointScope('region.city', frozenTree, roles), { structureItemId: 'city-item', error: null });
  assert.deepEqual(diagramObjectsWithinScope(input, 'city-item'), input.slice(0, 3));
  assert.equal(JSON.stringify({ input, frozenTree, roles }), before);
});
