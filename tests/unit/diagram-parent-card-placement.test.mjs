import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResultDiagrams } from '../../scripts/dev-proxy-server.mjs';

function placementFixture({ materialization = 'parentCard', repeated = false, sourceConflict = false } = {}) {
  const items = [
    { id: 'root', parentId: '', kind: 'container', materialization: 'structural' },
    ...(repeated ? [{ id: 'district', parentId: 'root', kind: 'container', materialization: 'stage', from: 'districts', className: 'Building' }] : []),
    { id: 'city', parentId: repeated ? 'district' : 'root', kind: 'container', materialization: 'stage', from: 'cities', className: 'City' },
    ...(repeated ? [
      { id: 'frame', parentId: 'city', kind: 'container', materialization: 'structural' },
      { id: 'inner-frame', parentId: 'frame', kind: 'container', materialization: 'structural' }
    ] : []),
    { id: 'card', parentId: repeated ? 'inner-frame' : 'city', kind: 'node', materialization, from: 'cards', className: 'City' },
    ...(repeated ? [{ id: 'card-copy', roleId: 'card', parentId: 'inner-frame', kind: 'node', materialization, from: 'cards', className: 'City' }] : [])
  ];
  const roles = items.filter((item) => !item.roleId).map((item) => ({
    roleId: item.id, roleKey: item.id, label: item.id, visualKind: item.kind,
    elementKeys: [item.id], nodeElementKeys: item.kind === 'node' ? [item.id] : [],
    groupElementKeys: item.kind === 'container' ? [item.id] : []
  }));
  const mappingFor = (item) => ({
    id: `${item.id}-mapping`, from: item.from,
    fields: { id: '_id', label: 'Description' },
    dataProfile: { className: item.className },
    disableImplicitGroup: true,
    importRole: {
      roleId: item.roleId || item.id, key: item.roleId || item.id,
      elementKey: item.roleId || item.id, structureItemId: item.id,
      parentStructureItemId: item.parentId, visualKind: item.kind,
      semantic: item.kind === 'container' ? 'group' : 'object',
      materialization: item.materialization, primaryCardSourceClassName: item.className,
      ...(repeated && item.id === 'city' ? {
        parentCorrelations: [{ parentStructureItemId: 'district', childColumn: 'Shared', parentColumn: 'Shared', operator: 'equals' }]
      } : {})
    }
  });
  const diagramSpec = {
    name: 'parent-card-placement',
    templateGrammar: {
      version: 3, fingerprint: 'parent-card-placement', roles, contexts: [], edges: [],
      elements: items.filter((item) => !item.roleId).map((item) => ({
        key: item.id, kind: item.kind === 'container' ? 'group' : 'node',
        roleKey: item.id, parentKey: item.parentId, parentRoleKey: item.parentId
      }))
    },
    structureTree: {
      version: 5,
      items: items.map((item) => ({
        id: item.id, roleId: item.roleId || item.id, parentId: item.parentId,
        templateElementKey: item.roleId || item.id,
        mapping: { materialization: { kind: item.materialization, stageId: item.from || '' } }
      }))
    },
    groupMappings: items.filter((item) => item.kind === 'container' && item.from).map(mappingFor),
    nodeMappings: items.filter((item) => item.kind === 'node').map(mappingFor)
  };
  const cities = ['101', '102'].map((_id, index) => ({
    _id, Class: 'City', Code: `city-${index}`, Description: `City ${index}`, Shared: 'both',
    SourceId: sourceConflict ? ['102', '101'][index] : 'unrelated-source',
    Source_Class: 'Building', TargetId: ['102', '101'][index], Target_Class: 'Building',
    Witness_id: ['102', '101'][index], Witness_Class: 'City'
  }));
  const context = {
    cities: { rows: cities }, cards: { rows: structuredClone(cities) },
    districts: { rows: ['101', '102'].map((_id) => ({ _id, Class: 'Building', Description: `Building ${_id}`, Shared: 'both' })) }
  };
  const execute = () => buildResultDiagrams({ result: { diagrams: [diagramSpec] } }, context, {}, { maxRows: 100 })[0];
  return { diagramSpec, context, execute };
}

test('parentCard matches its own Class and Id independently of retained relation sides and witnesses', () => {
  for (const sourceConflict of [false, true]) {
    const { execute } = placementFixture({ sourceConflict });
    const diagram = execute();
    assert.deepEqual(diagram.unplaced, []);
    assert.equal(diagram.nodes.length, 2);
    const groups = new Map(diagram.groups.map((group) => [group.id, group]));
    for (const node of diagram.nodes) {
      const parent = groups.get(node.group);
      assert.equal(parent.importRole.structureItemId, 'city');
      assert.equal(parent.businessId, node.businessId);
      assert.ok(node.d2Path.startsWith(`${parent.d2Path}.`));
    }
  }

  const differentClass = placementFixture({ sourceConflict: true });
  differentClass.diagramSpec.nodeMappings[0].importRole.primaryCardSourceClassName = 'Building';
  differentClass.diagramSpec.nodeMappings[0].dataProfile.className = 'Building';
  const rejected = differentClass.execute();
  assert.equal(rejected.nodes.length, 0, 'equal IDs from a different selected class are not the parent card');
  assert.equal(rejected.unplaced.length, 2);
});

test('parentCard crosses structural frames and preserves every parent occurrence and distinct placement', () => {
  const { execute } = placementFixture({ repeated: true, sourceConflict: true });
  const diagram = execute();
  assert.deepEqual(diagram.unplaced, []);
  assert.equal(diagram.nodes.length, 8);
  assert.equal(new Set(diagram.nodes.map((node) => node.id)).size, 8);
  assert.equal(new Set(diagram.nodes.map((node) => node.d2Path)).size, 8);
  const groups = new Map(diagram.groups.map((group) => [group.id, group]));
  for (const node of diagram.nodes) {
    const innerFrame = groups.get(node.group);
    const frame = groups.get(innerFrame.parent);
    const city = groups.get(frame.parent);
    assert.equal(innerFrame.importRole.structureItemId, 'inner-frame');
    assert.equal(frame.importRole.structureItemId, 'frame');
    assert.equal(city.importRole.structureItemId, 'city');
    assert.equal(city.businessId, node.businessId);
    assert.ok(node.d2Path.startsWith(`${innerFrame.d2Path}.`));
  }
  for (const placement of ['card', 'card-copy']) {
    for (const businessId of ['101', '102']) {
      const copies = diagram.nodes.filter((node) => node.importRole.structureItemId === placement && node.businessId === businessId);
      assert.equal(copies.length, 2);
      assert.equal(new Set(copies.map((node) => node.group)).size, 2);
    }
  }
});

test('independent stage does not guess same-card identity and explicit correlations retain precedence', () => {
  const independent = placementFixture({ materialization: 'stage' });
  const unresolved = independent.execute();
  assert.equal(unresolved.nodes.length, 0);
  assert.equal(unresolved.unplaced.length, 2);

  for (const materialization of ['stage', 'parentCard']) {
    const fixture = placementFixture({ materialization, sourceConflict: true });
    fixture.diagramSpec.nodeMappings[0].importRole.parentCorrelations = [{
      parentStructureItemId: 'city', childColumn: 'ParentCode', parentColumn: 'Code', operator: 'equals'
    }];
    fixture.context.cards.rows[0].ParentCode = 'city-1';
    fixture.context.cards.rows[1].ParentCode = 'not-present';
    const diagram = fixture.execute();
    assert.equal(diagram.nodes.length, 1);
    assert.equal(diagram.nodes[0].businessId, '101');
    assert.equal(diagram.groups.find((group) => group.id === diagram.nodes[0].group).businessId, '102');
    assert.equal(diagram.unplaced.length, 1, 'an unmatched explicit rule must not fall back to card identity or SourceId');
    assert.equal(diagram.unplaced[0].businessId, '102');
  }
});
