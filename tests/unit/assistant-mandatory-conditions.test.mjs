import test from 'node:test';
import assert from 'node:assert/strict';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';
import { compileAssistantPlacementIntent } from '../../scripts/assistant-placement-compiler.mjs';
import {
  assistantDiagramPlacementTargets, assistantDiagramPlacementDraftFromResponse,
  assistantDiagramSemanticObligations, assistantObjectFlowDiagramStages,
  normalizeDiagramImportIr, createDiagramImportProposal, applyDiagramImportProposal,
  buildResultDiagrams, executeFilterRows
} from '../../scripts/dev-proxy-server.mjs';

function fixture() {
  const currentSpec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1,
    selections: [ ['cities', 'City'], ['buildings', 'Building'] ].map(([alias, className]) => ({
      id: `selection:${alias}`, name: alias, alias, className, limit: 100,
      columns: ['Code', 'Description', 'CityId', 'Zone', 'Enabled', 'State', 'Country'],
      rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }]
    }))
  });
  const source = 'frame: { city: { building: Building } }';
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [
        { id: 'frame', label: 'Frame', classKeys: ['frame'], pathSegments: ['frame'] },
        { id: 'frame.city', label: 'City', parentKey: 'frame', classKeys: ['city'], pathSegments: ['frame', 'city'] }
      ],
      nodes: [{ id: 'frame.city.building', label: 'Building', parentKey: 'frame.city', classKeys: ['building'], pathSegments: ['frame', 'city', 'building'] }]
    },
    classes: [{ key: 'frame', usageKeys: ['frame'] }, { key: 'city', usageKeys: ['frame.city'] }, { key: 'building', usageKeys: ['frame.city.building'] }]
  }, source), { sourceText: source });
  const stages = assistantObjectFlowDiagramStages(currentSpec).map((stage) => ({
    ...stage, stageRole: 'terminal', assistantBlockIds: [stage.alias]
  }));
  const placements = assistantDiagramPlacementTargets(proposal, stages).map((placement) => ({
    ...placement, templateStatic: false, allowedMaterialization: [placement.templateElementKey === 'frame' ? 'structural' : 'stage']
  }));
  const frame = placements.find((placement) => placement.templateElementKey === 'frame');
  const city = placements.find((placement) => placement.templateElementKey === 'frame.city');
  const building = placements.find((placement) => placement.templateElementKey === 'frame.city.building');
  const input = {
    placements, stages,
    businessBlockManifest: { blocks: stages.map((stage) => ({ id: stage.alias, terminalStageId: stage.id })) },
    bindingIntent: { placements: [
      { structureItemId: frame.structureItemId, materializationIntent: 'structural', membership: 'structural' },
      { structureItemId: city.structureItemId, materializationIntent: 'stage', businessBlockId: 'cities', cardSourceId: 'current' },
      { structureItemId: building.structureItemId, materializationIntent: 'stage', businessBlockId: 'buildings', cardSourceId: 'current',
        membership: 'compare', requiredMembership: ['CityId equals parent._id', 'Zone equals parent.Zone'], requiredConditions: [] }
    ] }
  };
  return { input, currentSpec, proposal, city, building, intent: input.bindingIntent.placements[2] };
}

function rule(column, value, overrides = {}) {
  return { id: `manual-${column}-${value}`, action: 'include', negate: false, operator: 'equals',
    left: { column }, right: { kind: 'literal', value }, ...overrides };
}

function parentRule(column = 'Country') {
  return rule(column, '', { right: { kind: 'stage', stageId: 'selection:cities', column } });
}

function draftFor(local, edit = () => {}) {
  const response = compileAssistantPlacementIntent(local.input);
  assert.ok(response);
  edit(response.mappings.find((candidate) => candidate.structureItemId === local.building.structureItemId));
  return assistantDiagramPlacementDraftFromResponse(local.input, response);
}

function mappingFor(local, draft) {
  return draft.items.find((item) => item.structureItemId === local.building.structureItemId).mapping;
}

function applyDraft(local, draft) {
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  const matrix = assistantDiagramSemanticObligations(local.input, draft);
  assert.ok(matrix.obligations.every((obligation) => obligation.status === 'satisfied'), JSON.stringify(matrix));
  const mappings = new Map(draft.items.map((item) => [item.structureItemId, item.mapping]));
  const tree = { ...local.proposal.structureTree, items: local.proposal.structureTree.items.map((item) => ({
    ...item, mapping: mappings.get(item.id)
  })) };
  return applyDiagramImportProposal(local.currentSpec, local.proposal, [], [], tree);
}

function context(buildings) {
  return {
    cities: { rows: ['c1', 'c2'].map((_id) => ({ _id, Class: 'City', Description: _id, Zone: 'shared', Country: 'same' })) },
    buildings: { rows: buildings.map((row) => ({ Class: 'Building', Description: row._id, CityId: 'c1', Zone: 'shared', Country: 'same', ...row })) }
  };
}

test('compiler carries independently cloned current condition groups into its response', () => {
  const local = fixture();
  local.building.currentMapping.conditions = { ruleJoin: 'all', rules: [rule('State', 'ready')] };
  local.building.currentMapping.hierarchyConditions = { ruleJoin: 'all', rules: [parentRule()] };
  const before = structuredClone(local.input);
  const candidate = compileAssistantPlacementIntent(local.input).mappings.find((item) => item.structureItemId === local.building.structureItemId);
  assert.deepEqual(candidate.conditions, local.building.currentMapping.conditions);
  assert.deepEqual(candidate.hierarchyConditions, local.building.currentMapping.hierarchyConditions);
  candidate.conditions.rules[0].right.value = 'changed';
  assert.deepEqual(local.input, before);
});

test('compiler -> draft -> apply -> diagram requires BOTH parent predicates with two cities in one zone', () => {
  const local = fixture();
  const before = structuredClone(local.input);
  const draft = draftFor(local);
  assert.equal(mappingFor(local, draft).hierarchyConditions.ruleJoin, 'all');
  assert.equal(mappingFor(local, draft).conditions.ruleJoin, 'any', 'empty groups are not forced to all');
  const applied = applyDraft(local, draft);
  const diagram = buildResultDiagrams(applied, context([{ _id: 'b1' }]), {}, { maxRows: 100 })[0];
  assert.equal(diagram.nodes.length, 1, 'same Zone must not place the building in both cities');
  assert.equal(diagram.groups.find((group) => group.id === diagram.nodes[0].group).businessId, 'c1');
  assert.deepEqual(diagram.unplaced, []);
  assert.deepEqual(local.input, before);
});

test('compound mandatory filters compile to intersection and retain only rows satisfying both predicates', () => {
  const local = fixture();
  local.intent.requiredConditions = ['Enabled equals true', 'State equals ready'];
  const draft = draftFor(local);
  assert.equal(mappingFor(local, draft).conditions.ruleJoin, 'all');
  const applied = applyDraft(local, draft);
  const data = context([
    { _id: 'both', Enabled: true, State: 'ready' },
    { _id: 'enabled-only', Enabled: true, State: 'blocked' },
    { _id: 'state-only', Enabled: false, State: 'ready' }
  ]);
  const filters = applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'filterRows');
  assert.equal(filters.length, 2);
  for (const step of filters) data[step.as] = executeFilterRows(step, {}, data, { maxRows: 100 });
  const intersection = applied.steps.find((step) => step.managedBy === 'd2ImportV3' && step.type === 'intersectRows');
  assert.ok(intersection, 'mandatory predicates cannot compile to a union');
  assert.equal(applied.steps.some((step) => step.managedBy === 'd2ImportV3' && step.type === 'unionRows'), false);
  const rightIds = new Set(data[intersection.with].rows.map((row) => row._id));
  data[intersection.as] = { rows: data[intersection.from].rows.filter((row) => rightIds.has(row._id)) };
  const diagram = buildResultDiagrams(applied, data, {}, { maxRows: 100 })[0];
  assert.deepEqual(diagram.nodes.map((node) => node.businessId), ['both']);
  assert.equal(diagram.groups.find((group) => group.id === diagram.nodes[0].group).businessId, 'c1');
});

for (const family of ['conditions', 'hierarchyConditions']) {
  for (const location of ['candidate', 'current']) {
    test(`${family}: ${location} multi-include OR conflicts before apply and preserves input`, () => {
      const local = fixture();
      local.intent.requiredConditions = ['Enabled equals true'];
      const manual = { ruleJoin: 'any', rules: family === 'conditions'
        ? [rule('State', 'ready'), rule('Code', 'special')]
        : [parentRule('Country'), parentRule('Zone')] };
      if (location === 'current') local.building.currentMapping[family] = manual;
      const before = structuredClone(local.input);
      const draft = draftFor(local, (candidate) => { if (location === 'candidate') candidate[family] = structuredClone(manual); });
      assert.equal(draft.success, false);
      assert.ok(draft.errors.some((error) => error.code === 'diagram_mandatory_condition_conflict' &&
        error.structureItemId === local.building.structureItemId && error.path.endsWith(`.${family}`) && /OR/.test(error.message)), JSON.stringify(draft.errors));
      const conflict = draft.errors.find((error) => error.code === 'diagram_mandatory_condition_conflict');
      assert.ok(conflict.message.includes(local.building.displayName));
      assert.ok(conflict.message.includes(family === 'conditions' ? 'фильтры элемента' : 'условия принадлежности'));
      assert.match(conflict.message, /DSL v1.*AND\/OR/);
      assert.match(conflict.message, /Ручные правки сохранены/);
      assert.equal(draft.items.some((item) => item.structureItemId === local.building.structureItemId), false);
      assert.deepEqual(local.input, before);
    });
  }

  test(`${family}: current extra AND rules survive obligations and a different response`, () => {
    const local = fixture();
    local.intent.requiredConditions = ['Enabled equals true'];
    const extra = family === 'conditions' ? rule('State', 'ready') : parentRule();
    local.building.currentMapping[family] = { ruleJoin: 'all', rules: [extra] };
    const draft = draftFor(local, (candidate) => {
      candidate[family] = { ruleJoin: 'all', rules: [family === 'conditions' ? rule('Code', 'special') : parentRule('Zone')] };
    });
    assert.equal(draft.success, true, JSON.stringify(draft.errors));
    const filters = mappingFor(local, draft)[family];
    assert.equal(filters.ruleJoin, 'all');
    assert.ok(filters.rules.some((item) => item.id === extra.id && item.origin !== 'assistant'));
    assert.ok(assistantDiagramSemanticObligations(local.input, draft).obligations.every((item) => item.status === 'satisfied'));
  });

  test(`${family}: existing origin or its absence is preserved; only new rules become assistant-owned`, () => {
    for (const origin of [undefined, 'manual', 'assistant']) {
      const local = fixture();
      local.intent.requiredConditions = ['Enabled equals true'];
      const manual = family === 'conditions' ? rule('State', 'ready') : parentRule();
      if (origin !== undefined) manual.origin = origin;
      local.building.currentMapping[family] = { ruleJoin: 'all', rules: [manual] };
      const draft = draftFor(local);
      assert.equal(draft.success, true, JSON.stringify(draft.errors));
      const filters = mappingFor(local, draft)[family];
      const preserved = filters.rules.find((item) => item.id === manual.id);
      assert.equal(preserved.origin, origin);
      assert.equal(Object.hasOwn(preserved, 'origin'), Object.hasOwn(manual, 'origin'));
      assert.ok(filters.rules.filter((item) => item.id !== manual.id).every((item) => item.origin === 'assistant'));
    }
  });

  test(`${family}: manual OR without obligations remains OR, including a resumed mapping`, () => {
    const local = fixture();
    local.intent.requiredMembership = [];
    const rules = family === 'conditions' ? [rule('State', 'ready'), rule('Code', 'special')] : [parentRule('Country'), parentRule('Zone')];
    local.building.currentMapping[family] = { ruleJoin: 'any', rules };
    const before = structuredClone(local.input);
    const draft = draftFor(local);
    assert.equal(draft.success, true, JSON.stringify(draft.errors));
    assert.equal(mappingFor(local, draft)[family].ruleJoin, 'any');
    assert.deepEqual(mappingFor(local, draft)[family].rules.map((item) => item.id), rules.map((item) => item.id));
    assert.deepEqual(local.input, before);
  });
}

for (const [name, change] of [
  ['OR join', (mapping) => { mapping.hierarchyConditions.ruleJoin = 'any'; }],
  ['negated equality', (mapping) => { mapping.hierarchyConditions.rules[0].negate = true; }],
  ['exclude', (mapping) => { mapping.hierarchyConditions.rules[0].action = 'exclude'; }],
  ['wrong parent', (mapping) => { mapping.hierarchyConditions.rules[0].right.stageId = 'selection:buildings'; }],
  ['notEquals is not equals', (mapping) => { mapping.hierarchyConditions.rules[0].operator = 'notEquals'; }],
  ['left regex changes predicate', (mapping) => { mapping.hierarchyConditions.rules[0].left.regex = '.*'; }]
]) {
  test(`semantic validation rejects ${name} in fresh AND accepted/resumed drafts`, () => {
    const local = fixture();
    const draft = draftFor(local);
    change(mappingFor(local, draft));
    for (const resumed of [false, true]) {
      const input = resumed ? { ...local.input, placements: [local.building], placementContext: local.input.placements,
        acceptedItems: draft.items.filter((item) => item.structureItemId !== local.building.structureItemId) } : local.input;
      const value = resumed ? { ...draft, items: draft.items.filter((item) => item.structureItemId === local.building.structureItemId) } : draft;
      const matrix = assistantDiagramSemanticObligations(input, value);
      assert.ok(matrix.obligations.some((item) => item.family === 'placementMembershipRule' && item.status === 'unsatisfied'), JSON.stringify(matrix));
    }
  });
}

test('semantic filter obligations reject OR, exclude, negation, and unrelated retained source', () => {
  for (const change of [
    (mapping) => { mapping.conditions.ruleJoin = 'any'; },
    (mapping) => { mapping.conditions.rules[0].action = 'exclude'; },
    (mapping) => { mapping.conditions.rules[0].negate = true; },
    (mapping) => { mapping.conditions.rules[0].left.source = { id: 'retained', className: 'City', classColumn: 'OtherClass', idColumn: 'OtherId' }; }
  ]) {
    const local = fixture();
    local.intent.requiredConditions = ['Enabled equals true', 'State equals ready'];
    const draft = draftFor(local);
    change(mappingFor(local, draft));
    assert.ok(assistantDiagramSemanticObligations(local.input, draft).obligations.some((item) =>
      item.family === 'placementCondition' && item.status === 'unsatisfied'));
  }
});

test('valid resumed parent context and accepted placement obligations are checked without rewriting them', () => {
  const local = fixture();
  local.intent.requiredConditions = ['Enabled equals true', 'State equals ready'];
  const draft = draftFor(local);
  const input = { ...local.input, placements: [local.building], placementContext: local.input.placements,
    acceptedItems: draft.items.filter((item) => item.structureItemId !== local.building.structureItemId) };
  const resumed = draftFor({ ...local, input });
  assert.equal(resumed.success, true, JSON.stringify(resumed.errors));
  assert.ok(assistantDiagramSemanticObligations(input, resumed).obligations.every((item) => item.status === 'satisfied'));
  input.acceptedItems = structuredClone(draft.items);
  mappingFor(local, { items: input.acceptedItems }).conditions.ruleJoin = 'any';
  const before = structuredClone(input);
  assert.ok(assistantDiagramSemanticObligations(input, { items: [] }).obligations.some((item) =>
    item.family === 'placementCondition' && item.status === 'unsatisfied'));
  assert.deepEqual(input, before);
});

test('normalized notEquals satisfies only a mandatory negative predicate, never positive equality', () => {
  const local = fixture();
  local.intent.requiredConditions = ['State notEquals blocked'];
  local.intent.requiredMembership = ['CityId notEquals parent._id'];
  const draft = draftFor(local);
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  const mapping = mappingFor(local, draft);
  assert.equal(mapping.conditions.rules.length, 1);
  assert.equal(mapping.conditions.rules[0].operator, 'equals');
  assert.equal(mapping.conditions.rules[0].negate, true);
  assert.equal(mapping.hierarchyConditions.rules[0].operator, 'equals');
  assert.equal(mapping.hierarchyConditions.rules[0].negate, true);
  assert.ok(assistantDiagramSemanticObligations(local.input, draft).obligations.every((item) => item.status === 'satisfied'));
  mapping.hierarchyConditions.rules[0].negate = false;
  assert.ok(assistantDiagramSemanticObligations(local.input, draft).obligations.some((item) =>
    item.family === 'placementMembershipRule' && item.status === 'unsatisfied'));
});

test('membership sources require exact selected descriptors on BOTH sides, not only matching ids', () => {
  const local = fixture();
  local.intent.membershipCardSourceId = 'current';
  local.intent.parentMembershipCardSourceId = 'current';
  const draft = draftFor(local);
  assert.ok(assistantDiagramSemanticObligations(local.input, draft).obligations.every((item) => item.status === 'satisfied'));
  for (const side of ['left', 'right']) {
    const altered = structuredClone(draft);
    mappingFor(local, altered).hierarchyConditions.rules[0][side].source.idColumn = 'WrongId';
    assert.ok(assistantDiagramSemanticObligations(local.input, altered).obligations.some((item) =>
      item.family === 'placementMembershipRule' && item.status === 'unsatisfied'));
  }
});
