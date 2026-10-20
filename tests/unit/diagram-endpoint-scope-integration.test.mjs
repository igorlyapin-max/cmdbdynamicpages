import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResultDiagrams,
  diagramImportBindRelationRulesToStructureItems,
  validateDiagramImportV3Catalog
} from '../../scripts/dev-proxy-server.mjs';

function scopeFixture({ repeated = false, sourceOutside = false } = {}) {
  const items = [
    { id: 'region', parentId: '', kind: 'container', materialization: 'structural' },
    { id: 'target', parentId: 'region', kind: 'container', materialization: 'stage', from: 'regions', className: 'Region' },
    { id: 'outside', parentId: '', kind: 'container', materialization: 'structural' },
    { id: 'city', parentId: sourceOutside ? 'outside' : 'target', kind: 'node', materialization: 'stage', from: 'cities', className: 'City' },
    { id: 'building', parentId: 'target', kind: 'node', materialization: 'stage', from: 'buildings', className: 'Building' },
    { id: 'outside-building', roleId: 'building', parentId: 'outside', kind: 'node', materialization: 'stage', from: 'outsideBuildings', className: 'Building' }
  ];
  const elementKey = (item) => item.id === 'target' ? 'region.city' : item.roleId || item.id;
  const roles = items.filter((item) => !item.roleId).map((item) => ({ id: item.id, key: item.id, visualKind: item.kind }));
  const mappingFor = (item) => ({
    id: `${item.id}-mapping`, from: item.from,
    fields: { id: '_id', label: 'Description' },
    dataProfile: { className: item.className },
    disableImplicitGroup: true,
    ...(item.kind === 'node' ? { endpointProfiles: [{
      id: `${item.id}-name`, structureItemId: item.id, field: 'Description', operators: ['equals']
    }] } : {}),
    importRole: {
      roleId: item.roleId || item.id, key: item.roleId || item.id,
      elementKey: elementKey(item), structureItemId: item.id,
      parentStructureItemId: item.parentId, visualKind: item.kind,
      materialization: item.materialization, primaryCardSourceClassName: item.className,
      ...(item.parentId === 'target' ? { parentCorrelations: [{
        parentStructureItemId: 'target', operator: 'equals',
        childColumn: item.id === 'city' ? 'RegionId' : 'Shared',
        parentColumn: item.id === 'city' ? '_id' : 'Shared'
      }] } : {})
    }
  });
  const structureTree = { version: 5, items: items.map((item) => ({
    id: item.id, roleId: item.roleId || item.id, parentId: item.parentId,
    templateElementKey: elementKey(item),
    mapping: { materialization: { kind: item.materialization, stageId: item.from || '' } }
  })) };
  const diagramSpec = {
    name: 'city-building-endpoint-scope',
    templateGrammar: {
      version: 3, fingerprint: 'city-building-endpoint-scope', contexts: [],
      roles: roles.map((role) => ({
        roleId: role.id, roleKey: role.key, visualKind: role.visualKind,
        elementKeys: [elementKey(role)],
        nodeElementKeys: role.visualKind === 'node' ? [elementKey(role)] : [],
        groupElementKeys: role.visualKind === 'container' ? [elementKey(role)] : []
      })),
      elements: items.filter((item) => !item.roleId).map((item) => ({
        key: elementKey(item), kind: item.kind === 'container' ? 'group' : 'node',
        roleKey: item.id, parentKey: item.parentId === 'target' ? 'region.city' : item.parentId, parentRoleKey: item.parentId
      })),
      edges: [{ key: 'city_to_building', sourceRoleKey: 'city', targetRoleKey: 'building' }]
    },
    structureTree,
    groupMappings: items.filter((item) => item.kind === 'container' && item.from).map(mappingFor),
    nodeMappings: items.filter((item) => item.kind === 'node').map(mappingFor),
    edgeMappings: [{
      id: 'city-building-link', type: 'attributeEndpoints', direction: '->',
      staticRows: [{ _id: 'link-1', Source: 'North City', Target: 'Depot', Description: 'Serves' }],
      fields: { source: 'Source', target: 'Target', label: 'Description' },
      endpointResolution: { strategy: 'comparisonRules', sourceOperator: 'equals', targetOperator: 'equals', directionPolicy: 'dataFields' },
      importRole: { key: 'city_building', edgeClassKey: 'city_building', elementKey: 'city_to_building', directionPolicy: 'dataFields' }
    }]
  };
  const context = {
    regions: { rows: ['region-1', ...(repeated ? ['region-2'] : [])].map((_id) => ({ _id, Class: 'Region', Description: _id, Shared: 'all' })) },
    cities: { rows: [{ _id: 'city-1', Class: 'City', Description: 'North City', RegionId: 'region-1' }] },
    buildings: { rows: [{ _id: 'building-1', Class: 'Building', Description: 'Depot', Shared: 'all' }] },
    outsideBuildings: { rows: [{ _id: 'building-2', Class: 'Building', Description: 'Depot' }] }
  };
  const execute = (scopeStructureItemId) => {
    const definition = structuredClone(diagramSpec);
    if (scopeStructureItemId !== undefined) definition.edgeMappings[0].endpointResolution.scopeStructureItemId = scopeStructureItemId;
    return buildResultDiagrams({ result: { diagrams: [definition] } }, context, {}, { maxRows: 100 })[0];
  };
  return { execute, structureTree, roles };
}

test('runtime equality matching emits two compatible edges without scope and only the target-subtree edge with scope', () => {
  const { execute } = scopeFixture();
  const unrestricted = execute();
  const scoped = execute('target');
  assert.deepEqual(unrestricted.unplaced, []);
  assert.deepEqual(scoped.unplaced, []);
  assert.equal(unrestricted.edges.length, 2);
  assert.equal(scoped.edges.length, 1);
  assert.deepEqual(scoped.nodes.map((node) => node.id).sort(), unrestricted.nodes.map((node) => node.id).sort(), 'scope restricts connections, not materialization');
  const nodes = new Map(scoped.nodes.map((node) => [node.id, node]));
  const edge = scoped.edges[0];
  assert.equal(nodes.get(edge.source).data.sourceRef.className, 'City');
  assert.equal(nodes.get(edge.source).data.sourceRef.id, 'city-1');
  assert.equal(nodes.get(edge.target).data.sourceRef.className, 'Building');
  assert.equal(nodes.get(edge.target).data.sourceRef.id, 'building-1');
  assert.equal(edge.direction, '->');
  assert.equal(edge.label, 'Serves');
  assert.ok(unrestricted.edges.some((item) => unrestricted.nodes.find((node) => node.id === item.target).businessId === 'building-2'), 'outside matching point must participate when scope is absent');
  assert.equal(scoped.execution.connections[0].candidatePairs, 1);
  assert.equal(scoped.execution.connections[0].emittedPairs, 1);
  assert.deepEqual(execute('').edges.map((item) => item.id), unrestricted.edges.map((item) => item.id), 'explicit empty scope preserves all-compatible behavior');
});

test('runtime scope checks the source as well as the target, even if the target matches inside', () => {
  const { execute } = scopeFixture({ sourceOutside: true });
  assert.equal(execute().edges.length, 2);
  const scoped = execute('target');
  assert.deepEqual(scoped.unplaced, []);
  assert.equal(scoped.edges.length, 0);
  assert.equal(scoped.nodes.filter((node) => node.businessId === 'building-1').length, 1);
  assert.equal(scoped.execution.connections[0].skipped.sourceUnresolved, 1);
});

test('runtime retains both Building copies inside the exact scope placement without forcing a shared runtime occurrence', () => {
  const { execute } = scopeFixture({ repeated: true });
  assert.equal(execute().edges.length, 3);
  const scoped = execute('target');
  assert.deepEqual(scoped.unplaced, []);
  const copies = scoped.nodes.filter((node) => node.businessId === 'building-1');
  assert.equal(copies.length, 2);
  assert.equal(new Set(copies.map((node) => node.id)).size, 2);
  assert.equal(new Set(copies.map((node) => node.group)).size, 2);
  assert.equal(new Set(copies.map((node) => node.d2Path)).size, 2);
  assert.equal(scoped.edges.length, 2);
  assert.deepEqual(scoped.edges.map((edge) => edge.target).sort(), copies.map((node) => node.id).sort());
  const city = scoped.nodes.find((node) => node.businessId === 'city-1');
  assert.ok(copies.some((node) => node.group !== city.group), 'scope is one exact placement across all copies, not a same-occurrence pair constraint');
  assert.ok(scoped.edges.every((edge) => edge.source === city.id));
});

test('runtime fails closed for a nonempty scope absent from the materialized tree', () => {
  const { execute } = scopeFixture();
  assert.equal(execute().edges.length, 2);
  const scoped = execute('missing-scope');
  assert.equal(scoped.edges.length, 0);
  assert.equal(scoped.nodes.length, 3);
});

function connectionRule(overrides = {}) {
  return {
    id: 'city-building-link', kind: 'connection', mode: 'attributeEndpoints',
    d2ClassKey: 'city_building', d2ElementKey: 'city_to_building',
    sourceStageId: 'selection:links', sourceField: 'Source', targetField: 'Target',
    sourceOperator: 'equals', targetOperator: 'equals', directionPolicy: 'dataFields',
    d2Notes: 'endpoint-scope: target', ...overrides
  };
}

test('binder resolves exact Notes scope by id or template element key using provided roles', () => {
  const { structureTree, roles } = scopeFixture();
  for (const name of ['target', 'region.city']) {
    const rule = connectionRule({ d2Notes: `endpoint-scope: ${name}` });
    const before = JSON.stringify(rule);
    const [bound] = diagramImportBindRelationRulesToStructureItems([rule], structureTree, [], roles);
    assert.equal(bound.endpointScopeStructureItemId, 'target');
    assert.equal(bound.endpointScopeError, undefined);
    assert.equal(JSON.stringify(rule), before);
  }
});

test('manual empty scope overrides Notes, removes stale scope errors and remains empty on rebind', () => {
  const { structureTree, roles } = scopeFixture();
  const [cleared] = diagramImportBindRelationRulesToStructureItems([
    connectionRule({ endpointScopeStructureItemId: '', endpointScopeError: { code: 'stale', message: 'Stale error' } })
  ], structureTree, [], roles);
  assert.equal(cleared.endpointScopeStructureItemId, '');
  assert.equal(cleared.endpointScopeError, undefined);
  const [rebound] = diagramImportBindRelationRulesToStructureItems([cleared], structureTree, [], roles);
  assert.equal(rebound.endpointScopeStructureItemId, '');
  assert.equal(rebound.endpointScopeError, undefined);
  const [withoutScope] = diagramImportBindRelationRulesToStructureItems([connectionRule({ d2Notes: '' })], structureTree);
  assert.equal(withoutScope.endpointScopeError, undefined, 'old no-scope callers do not require roles');
});

test('binder and catalog report invalid node or missing scopes explicitly rather than silently widening matching', () => {
  const { structureTree, roles } = scopeFixture();
  for (const [scope, code] of [['city', 'diagram_endpoint_scope_not_container'], ['missing', 'diagram_endpoint_scope_not_found']]) {
    const [bound] = diagramImportBindRelationRulesToStructureItems([connectionRule({ d2Notes: `endpoint-scope: ${scope}` })], structureTree, [], roles);
    assert.equal(bound.endpointScopeStructureItemId, scope);
    assert.equal(bound.endpointScopeError.code, code);
    const errors = validateDiagramImportV3Catalog({ structureTree, roles, endpointProfiles: [], relationRules: [bound] }, { classes: [], domains: [] });
    assert.ok(errors.some((error) => error.path === '$.relationRules[0].endpointScopeStructureItemId' && error.code === code), JSON.stringify(errors));
  }
});
