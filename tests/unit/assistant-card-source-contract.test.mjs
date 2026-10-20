import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantCardSources, assistantSelectedCardSource, assistantMergeBindingIntent
} from '../../scripts/assistant-card-source.mjs';
import {
  assistantD2BindingIntentModel, assistantDiagramBindingIntentSeed,
  assistantDiagramPlacementTargets, assistantDiagramNotesHasNaturalLanguage,
  normalizeAssistantDiagramBindingIntentResponse, assistantDiagramBindingIntentDraftFromResponse,
  assistantDiagramPlacementDraftFromResponse, assistantDiagramEndpointProfilesFromBindings,
  assistantDiagramSemanticObligations, assistantDiagramPlacementExecutionValidation,
  assistantObjectFlowDiagramStages, diagramImportPrimaryCardSource,
  diagramImportCompileRoleMapping, diagramImportStructureTree, diagramImportStructureTreeErrors,
  normalizeDiagramImportIr, createDiagramImportProposal, applyDiagramImportProposal,
  normalizeTemplateSpecForStorage
} from '../../scripts/dev-proxy-server.mjs';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';

const current = { id: 'current', className: 'Server', classColumn: 'Class', idColumn: '_id', label: 'Server' };
const retained = { id: 'relation-source', className: 'Application', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Application' };
const stage = {
  id: 'match:apps', alias: 'apps', kind: 'match', className: 'Server', stageRole: 'terminal', assistantBlockIds: ['apps'],
  cardSources: [current, retained], columns: ['Class', '_id', 'Description', 'SourceClass', 'SourceId', 'SourceDescription']
};
const placement = {
  structureItemId: 'apps-node', roleId: 'app', displayName: 'Application', visualKind: 'node', allowedMaterialization: ['stage'],
  directives: { 'binding-result': 'apps' }, currentMapping: { primary: { labelTemplate: '${Description}', structuredFields: [] } }
};
const input = {
  stages: [stage], placements: [placement], relationRules: [],
  businessBlockManifest: { blocks: [{ id: 'apps', terminalStageId: stage.id, primaryClass: stage.className, terminalCardSources: stage.cardSources }] }
};
const binding = (cardSourceId = 'relation-source') => ({ structureItemId: 'apps-node', materializationIntent: 'stage', businessBlockId: 'apps', cardSourceId });

test('card source selection uses exact ids, never class, parent or current heuristics', () => {
  assert.equal(assistantSelectedCardSource(stage).source, null);
  assert.equal(diagramImportPrimaryCardSource(stage, { className: 'Application' }, { className: 'Server' }).source, null);
  assert.equal(assistantSelectedCardSource(stage, 'Application').source, null);
  assert.equal(assistantSelectedCardSource(stage, 'relation-source').source, retained);
  assert.equal(assistantSelectedCardSource(stage, 'current').source, current);
  assert.equal(assistantSelectedCardSource(stage, 'removed', current).source, null);
  assert.equal(assistantSelectedCardSource(stage, 'current', retained).source, null);
  const sameClass = { ...stage, cardSources: [current, { ...retained, className: 'Server' }] };
  assert.equal(assistantSelectedCardSource(sameClass).source, null);
  assert.equal(assistantSelectedCardSource(sameClass, 'relation-source').source.idColumn, 'SourceId');
  assert.equal(assistantSelectedCardSource({ cardSources: [current, { ...retained, id: 'current' }] }, 'current').source, null);
});

test('one declared card is a deterministic default, not a guess among retained cards', () => {
  const descriptor = assistantSelectedCardSource({ primaryClass: 'Application' }).source;
  assert.deepEqual(descriptor, { ...current, className: 'Application', label: 'Карточка результата' });
  assert.equal(assistantSelectedCardSource({ className: 'Server', cardSources: [retained] }).source, retained);
  assert.deepEqual(assistantCardSources({ className: 'Server', cardSources: [current, retained] }), [current, retained]);
  assert.equal(assistantSelectedCardSource({ cardSources: [{ id: 'bad' }] }).source, null);
});

test('multi-card seeds stay pending; normalized intent retains exact selected source', () => {
  const seed = assistantDiagramBindingIntentSeed(input);
  assert.deepEqual(seed.pendingPlacementIds, ['apps-node']);
  assert.deepEqual(seed.placementBindings, []);
  const normalized = normalizeAssistantDiagramBindingIntentResponse(input, { placementBindings: [binding()] });
  const draft = assistantDiagramBindingIntentDraftFromResponse(input, normalized);
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.equal(draft.intent.placements[0].cardSourceId, 'relation-source');
  assert.equal(assistantD2BindingIntentModel(draft.intent).version, 2);
  assert.equal(assistantD2BindingIntentModel(draft.intent).placements[0].cardSourceId, 'relation-source');
  assert.notEqual(assistantD2BindingIntentModel(draft.intent).modelHash,
    assistantD2BindingIntentModel({ placements: [binding('current')] }).modelHash);
});

test('missing or invented multi-card choice fails closed; unresolved is retained', () => {
  for (const id of ['', 'Application', 'not-retained']) {
    const draft = assistantDiagramBindingIntentDraftFromResponse(input, { placementBindings: [binding(id)] });
    assert.equal(draft.success, false);
    assert.ok(draft.errors.some((error) => error.path.endsWith('.cardSourceId')));
  }
  const draft = assistantDiagramBindingIntentDraftFromResponse(input, {
    unresolved: [{ targetType: 'placement', targetId: 'apps-node', reason: 'ambiguousBlock', message: 'Select displayed card.' }]
  });
  assert.equal(draft.success, true);
  assert.deepEqual(draft.intent.placements, []);
  assert.equal(draft.intent.unresolved.length, 1);
});

test('explicit parent comparison fixes membership; a stage cannot claim same-parent-card', () => {
  const local = { ...input, placements: [{ ...placement, directives: { ...placement.directives,
    'required-membership': ['_id equals parent._id'] } }] };
  const raw = { placementBindings: [{ ...binding(), membership: 'same-parent-card' }] };
  assert.ok(assistantDiagramBindingIntentDraftFromResponse(local, raw).errors.some((e) => e.code === 'diagram_binding_membership_mismatch'));
  const normalized = normalizeAssistantDiagramBindingIntentResponse(local, raw);
  const draft = assistantDiagramBindingIntentDraftFromResponse(local, normalized);
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.equal(draft.intent.placements[0].membership, 'compare');
});

test('stage cards under a layout-only frame need no data parent comparison', () => {
  const frame = { structureItemId: 'frame', allowedMaterialization: ['structural'], visualKind: 'container', directives: {} };
  const local = { ...input, placements: [frame, { ...placement, parentStructureItemId: 'frame' }] };
  const response = normalizeAssistantDiagramBindingIntentResponse(local, { placementBindings: [
    { structureItemId: 'frame', materializationIntent: 'structural', membership: 'structural' },
    { ...binding(), membership: 'compare', requiredMembership: [] }
  ] });
  const intentDraft = assistantDiagramBindingIntentDraftFromResponse(local, response);
  assert.equal(intentDraft.success, true, JSON.stringify(intentDraft.errors));
  assert.equal(intentDraft.intent.placements[1].membership, 'structural');
  local.bindingIntent = intentDraft.intent;
  const draft = assistantDiagramPlacementDraftFromResponse(local, { mappings: [
    { structureItemId: 'frame', materialization: 'structural' },
    { structureItemId: placement.structureItemId, materialization: 'stage', stageId: stage.id }
  ] });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.ok(assistantDiagramSemanticObligations(local, draft).obligations.every((item) => item.status === 'satisfied'));
});

test('single-source intent and seed persist a deterministic source id', () => {
  const one = { ...input, businessBlockManifest: { blocks: [{ ...input.businessBlockManifest.blocks[0], terminalCardSources: [retained] }] } };
  assert.deepEqual(assistantDiagramBindingIntentSeed(one).placementBindings, [binding()]);
  assert.equal(assistantDiagramBindingIntentDraftFromResponse(one, { placementBindings: [binding('')] }).intent.placements[0].cardSourceId, retained.id);
});

test('exact source Notes seed a multi-card result without LLM or class-name guessing', () => {
  const directives = { ...placement.directives, 'card-source': retained.id, 'membership-card-source': current.id, 'parent-membership-card-source': 'range' };
  const local = { ...input, placements: [{ ...placement, directives, notes: 'card-source: relation-source\nmembership-card-source: current\nparent-membership-card-source: range' }] };
  const seed = assistantDiagramBindingIntentSeed(local);
  assert.deepEqual(seed.pendingPlacementIds, []);
  assert.deepEqual(seed.placementBindings, [{ ...binding(), membershipCardSourceId: current.id, parentMembershipCardSourceId: 'range' }]);
  assert.equal(assistantDiagramBindingIntentDraftFromResponse(local, seed).success, true);
  local.placements[0].directives['card-source'] = 'Application';
  assert.deepEqual(assistantDiagramBindingIntentSeed(local).pendingPlacementIds, [placement.structureItemId]);
  assert.equal(assistantDiagramBindingIntentDraftFromResponse(local, { placementBindings: [binding('Application')] }).success, false);
});

test('source Notes are authoritative in normalization and conflicting direct drafts fail closed', () => {
  const directives = { ...placement.directives, 'card-source': retained.id, 'membership-card-source': current.id, 'parent-membership-card-source': 'range' };
  const local = { ...input, placements: [{ ...placement, directives }] };
  for (const [key, value] of [['cardSourceId', 'current'], ['membershipCardSourceId', retained.id], ['parentMembershipCardSourceId', 'invented']]) {
    const response = { placementBindings: [{ ...binding(), membershipCardSourceId: current.id, parentMembershipCardSourceId: 'range', [key]: value }] };
    assert.equal(assistantDiagramBindingIntentDraftFromResponse(local, response).success, false);
    const normalized = normalizeAssistantDiagramBindingIntentResponse(local, response);
    const draft = assistantDiagramBindingIntentDraftFromResponse(local, normalized);
    assert.equal(draft.success, true, JSON.stringify(draft.errors));
    assert.equal(draft.intent.placements[0].cardSourceId, retained.id);
    assert.equal(draft.intent.placements[0].membershipCardSourceId, current.id);
    assert.equal(draft.intent.placements[0].parentMembershipCardSourceId, 'range');
  }
});

test('structural and parentCard cannot select independent card sources', () => {
  for (const kind of ['structural', 'parentCard']) {
    const local = { ...input, placements: [{ ...placement, allowedMaterialization: [kind], directives: {} }] };
    const draft = assistantDiagramBindingIntentDraftFromResponse(local, { placementBindings: [{ structureItemId: placement.structureItemId, materializationIntent: kind, cardSourceId: 'current' }] });
    assert.equal(draft.success, false);
    assert.ok(draft.errors.some((error) => error.path.endsWith('.cardSourceId')));
  }
});

test('connection intent cannot replace the confirmed row grain with a guessed card output', () => {
  const local = { ...input, placements: [], relationRules: [{ d2ClassKey: 'association' }],
    businessBlockManifest: { blocks: [{ ...input.businessBlockManifest.blocks[0], rowGrain: 'pair' }] } };
  const connection = { d2ClassKey: 'association', businessBlockId: 'apps', rowGrain: 'card' };
  const rejected = assistantDiagramBindingIntentDraftFromResponse(local, { connectionBindings: [connection] });
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((error) => error.code === 'diagram_binding_row_grain_mismatch'));
  for (const rowGrain of ['pair', '']) {
    const accepted = assistantDiagramBindingIntentDraftFromResponse(local, { connectionBindings: [{ ...connection, rowGrain }] });
    assert.equal(accepted.success, true, JSON.stringify(accepted.errors));
    assert.equal(accepted.intent.connections[0].rowGrain, 'pair');
  }
});

test('pending Notes unresolved and omissions cannot be masked by deterministic seeds', () => {
  const seed = {
    placementBindings: [binding()], connectionBindings: [{ d2ClassKey: 'link', businessBlockId: 'apps' }],
    pendingPlacementIds: ['apps-node'], pendingConnectionKeys: ['link']
  };
  const unresolved = [{ targetType: 'placement', targetId: 'apps-node', reason: 'ambiguousBlock' }, { targetType: 'connection', targetId: 'link', reason: 'ambiguousBlock' }];
  const merged = assistantMergeBindingIntent(seed, { unresolved });
  assert.deepEqual(merged.placementBindings, []);
  assert.deepEqual(merged.connectionBindings, []);
  assert.deepEqual(merged.unresolved, unresolved);
  assert.deepEqual(assistantMergeBindingIntent(seed, {}).placementBindings, []);
  assert.equal(assistantDiagramBindingIntentDraftFromResponse(input, assistantMergeBindingIntent(seed, {})).success, false);
  const contradictory = assistantMergeBindingIntent(seed, { placementBindings: [binding()], unresolved: unresolved.slice(0, 1) });
  assert.equal(assistantDiagramBindingIntentDraftFromResponse(input, contradictory).success, false);
});

function mappedFixture() {
  const intent = assistantDiagramBindingIntentDraftFromResponse(input, { placementBindings: [binding()] }).intent;
  intent.placements[0].endpointFields = ['endpoint.ip'];
  intent.placements[0].endpointOperators = ['equals'];
  const local = { ...input, bindingIntent: intent };
  const draft = assistantDiagramPlacementDraftFromResponse(local, {
    mappings: [{ structureItemId: 'apps-node', materialization: 'stage', stageId: stage.id, cardSourceId: 'current' }]
  });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  return { local, draft };
}

test('selected intent controls mapping, identity, label, endpoint and semantic obligations', () => {
  const { local, draft } = mappedFixture();
  const item = draft.items[0];
  assert.equal(item.mapping.primary.cardSource.id, retained.id);
  assert.equal(item.mapping.primary.className, 'Application');
  const compiled = diagramImportCompileRoleMapping({ id: 'app', key: 'app', visualKind: 'node' }, item.mapping, item.structureItemId,
    new Map([[stage.id, stage]]), { stageId: stage.id, alias: stage.alias, className: stage.className });
  assert.equal(compiled.runtimeMapping.fields.id, 'SourceId');
  assert.equal(compiled.runtimeMapping.fields.label, 'SourceDescription');
  assert.equal(compiled.runtimeMapping.labelTemplate, '${SourceDescription}');
  assert.equal(compiled.runtimeMapping.dataProfile.className, 'Application');
  draft.endpointProfiles = assistantDiagramEndpointProfilesFromBindings(local, draft.items);
  assert.equal(draft.endpointProfiles[0].source.id, retained.id);
  assert.equal(draft.endpointProfiles[0].field, 'endpoint.ip');
  assert.ok(assistantDiagramSemanticObligations(local, draft).obligations.every((item) => item.status === 'satisfied'));
  draft.items[0].mapping.primary.cardSource = current;
  assert.ok(assistantDiagramSemanticObligations(local, draft).obligations.some((item) => item.family === 'placementCardSource' && item.status === 'unsatisfied'));
});

test('an explicit label directive remains authoritative through selected-card compilation', () => {
  const local = { ...input, placements: [{ ...placement, directives: { ...placement.directives, 'label-template': 'Item ${Description}' } }] };
  local.bindingIntent = assistantDiagramBindingIntentDraftFromResponse(local, { placementBindings: [binding()] }).intent;
  const draft = assistantDiagramPlacementDraftFromResponse(local, { mappings: [{ structureItemId: placement.structureItemId,
    materialization: 'stage', stageId: stage.id, labelTemplate: 'technical-role-key' }] });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.equal(draft.items[0].mapping.primary.labelTemplate, 'Item ${Description}');
  const compiled = diagramImportCompileRoleMapping({ id: 'app', key: 'app', visualKind: 'node' }, draft.items[0].mapping,
    placement.structureItemId, new Map([[stage.id, stage]]), { stageId: stage.id, alias: stage.alias, className: stage.className });
  assert.equal(compiled.runtimeMapping.labelTemplate, 'Item ${SourceDescription}');
  assert.equal(assistantDiagramNotesHasNaturalLanguage('materialization: stage\nlabel-template: Item ${Description}'), false);
});

test('parentCard inherits selected displayed ancestor, even with reversed candidate order and a structural frame', () => {
  const { local } = mappedFixture();
  const parent = { ...placement, visualKind: 'container', structureItemId: 'scope' };
  const frame = { structureItemId: 'frame', parentStructureItemId: 'scope', allowedMaterialization: ['structural'], visualKind: 'container' };
  const child = { ...placement, structureItemId: 'child', parentStructureItemId: 'frame', allowedMaterialization: ['parentCard'], directives: {} };
  const changed = { ...local, placements: [parent, frame, child], bindingIntent: { placements: [{ ...binding(), structureItemId: 'scope' }] } };
  const draft = assistantDiagramPlacementDraftFromResponse(changed, { mappings: [
    { structureItemId: 'child', materialization: 'parentCard' }, { structureItemId: 'frame', materialization: 'structural' },
    { structureItemId: 'scope', materialization: 'stage', stageId: stage.id }
  ] });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.equal(draft.items.find((item) => item.structureItemId === 'child').mapping.primary.cardSource.id, retained.id);
});

test('compiler rejects an unselected or stale multi-card source instead of using current', () => {
  const compile = (primary) => diagramImportCompileRoleMapping({ id: 'app', visualKind: 'node' }, { primary }, 'app',
    new Map([[stage.id, stage]]), { stageId: stage.id, alias: stage.alias });
  assert.throws(() => compile({ className: 'Application' }), /exact retained primary card source/);
  assert.throws(() => compile({ cardSource: { ...retained, id: 'removed' } }), /exact retained primary card source/);
});

test('displayed source and exact parent membership side remain independent', () => {
  const parentStage = { id: 'selection:parent', className: 'Server', columns: ['Class', '_id', 'Description'], cardSources: [current] };
  const parent = { structureItemId: 'parent', roleId: 'scope', visualKind: 'container', allowedMaterialization: ['stage'], currentMapping: { primary: { cardSource: current } } };
  const { local } = mappedFixture();
  const contract = local.bindingIntent.placements[0];
  contract.requiredMembership = ['_id equals parent._id', 'Class equals parent.Class'];
  contract.requiredConditions = ['endpoint.ip equals value'];
  const draft = assistantDiagramPlacementDraftFromResponse({ ...local,
    stages: [stage, parentStage], placements: [parent, { ...placement, parentStructureItemId: 'parent' }],
    dataSemanticModel: { stages: [{ id: stage.id, typedFields: [{ path: 'endpoint.ip', cardSourceId: retained.id, rootClass: retained.className }] }] }
  }, { mappings: [
    { structureItemId: 'parent', materialization: 'stage', stageId: parentStage.id },
    { structureItemId: 'apps-node', materialization: 'stage', stageId: stage.id }
  ] });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  const mapping = draft.items.find((item) => item.structureItemId === 'apps-node').mapping;
  assert.equal(mapping.primary.cardSource.id, retained.id);
  assert.deepEqual(mapping.hierarchyConditions.rules.map((rule) => [rule.left.column, rule.right.column]), [['_id', '_id'], ['Class', 'Class']]);
  assert.ok(mapping.hierarchyConditions.rules.every((rule) => !rule.left.source && !rule.right.source));
  assert.equal(mapping.conditions.rules[0].left.source.id, retained.id);
});

test('explicit membership sources select independent child and parent cards, not their displayed cards', () => {
  const parentRange = { id: 'range', className: 'Range', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Range' };
  const parentStage = { id: 'relation:parent', className: 'Server', cardSources: [current, parentRange], columns: ['Class', '_id', 'Description', 'SourceClass', 'SourceId'] };
  const parent = { structureItemId: 'parent', roleId: 'scope', visualKind: 'container', allowedMaterialization: ['stage'], currentMapping: { primary: { cardSource: current } } };
  const responseBinding = { ...binding(), membershipCardSourceId: 'current', parentMembershipCardSourceId: 'range', requiredMembership: ['ipaddress.ipAddr ipv4InCidr parent.range'] };
  const intent = assistantDiagramBindingIntentDraftFromResponse(input, { placementBindings: [responseBinding] }).intent;
  assert.equal(intent.placements[0].membershipCardSourceId, 'current');
  assert.equal(assistantD2BindingIntentModel(intent).placements[0].parentMembershipCardSourceId, 'range');
  const local = { ...input, bindingIntent: intent, stages: [stage, parentStage], placements: [parent, { ...placement, parentStructureItemId: 'parent' }],
    dataSemanticModel: { stages: [
      { id: stage.id, typedFields: [{ path: 'ipaddress.ipAddr', cardSourceId: current.id, rootClass: current.className }] },
      { id: parentStage.id, typedFields: [{ path: 'range', cardSourceId: parentRange.id, rootClass: parentRange.className }] }
    ] }
  };
  const mappings = [{ structureItemId: 'parent', materialization: 'stage', stageId: parentStage.id }, { structureItemId: 'apps-node', materialization: 'stage', stageId: stage.id }];
  const draft = assistantDiagramPlacementDraftFromResponse(local, { mappings });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  const mapping = draft.items.find((item) => item.structureItemId === 'apps-node').mapping;
  assert.equal(mapping.primary.cardSource.id, retained.id);
  const rule = mapping.hierarchyConditions.rules[0];
  assert.equal(rule.left.source.id, current.id);
  assert.equal(rule.left.column, 'ipaddress.ipAddr');
  assert.equal(rule.right.source.id, parentRange.id);
  assert.equal(rule.right.column, 'range');
  assert.equal(rule.operator, 'ipv4InCidr');
  assert.ok(assistantDiagramSemanticObligations(local, draft).obligations.every((item) => item.status === 'satisfied'));
  intent.placements[0].parentMembershipCardSourceId = 'invented';
  assert.equal(assistantDiagramPlacementDraftFromResponse(local, { mappings }).success, false);
});

function persistenceFixture() {
  const spec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1, selections: [{ id: 'selection:servers', alias: 'servers', className: 'Server', columns: ['Code', 'Description'], rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }] }],
    operations: [{ id: 'relation:apps', type: 'relation', from: 'servers', as: 'apps', domain: 'ServerApp', targetClass: 'Application', direction: 'source', columns: ['Code', 'Description'], limit: 100 }]
  });
  const source = 'scope: { app: Application }';
  const ir = normalizeDiagramImportIr({ version: 4, elements: {
    groups: [{ id: 'scope', classKeys: ['scope'], pathSegments: ['scope'] }],
    nodes: [{ id: 'scope.app', classKeys: ['app'], parentKey: 'scope', pathSegments: ['scope', 'app'] }]
  }, classes: [{ key: 'scope', usageKeys: ['scope'] }, { key: 'app', usageKeys: ['scope.app'] }] }, source);
  const proposal = createDiagramImportProposal(spec, ir, { sourceText: source });
  const stages = assistantObjectFlowDiagramStages(spec);
  const sourceStage = stages.find((item) => item.id === 'relation:apps');
  const selected = sourceStage.cardSources.find((item) => item.id === 'relation-source');
  const tree = structuredClone(proposal.structureTree);
  for (const item of tree.items) {
    const isParent = !item.parentId;
    item.mapping.materialization = { kind: isParent ? 'stage' : 'parentCard', stageId: isParent ? sourceStage.id : '' };
    item.mapping.primary = { className: selected.className, cardSource: selected, idAttribute: '_id', labelTemplate: '${Description}', structuredFields: [] };
  }
  return { spec, proposal, stages, sourceStage, selected, tree };
}

test('source Notes use placement-over-role precedence and are not natural-language requests', () => {
  const { proposal, stages, tree } = persistenceFixture();
  const root = tree.items.find((item) => !item.parentId);
  const role = proposal.roles.find((item) => item.id === root.roleId);
  role.notes = 'card-source: current\nmembership-card-source: relation-source\nparent-membership-card-source: current';
  proposal.structure.groups.find((item) => item.key === root.templateElementKey).notes = 'card-source: relation-source\nmembership-card-source: current\nparent-membership-card-source: relation-source';
  const target = assistantDiagramPlacementTargets({ ...proposal, structureTree: tree }, stages).find((item) => item.structureItemId === root.id);
  assert.equal(target.directives['card-source'], 'relation-source');
  assert.equal(target.directives['membership-card-source'], 'current');
  assert.equal(target.directives['parent-membership-card-source'], 'relation-source');
  assert.equal(assistantDiagramNotesHasNaturalLanguage(target.notes), false);
});

test('selected source survives Apply, normal Save, reload and deterministic recompilation', () => {
  const { spec, proposal, selected, tree } = persistenceFixture();
  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, spec, proposal.structure), []);
  const applied = applyDiagramImportProposal(spec, proposal, [], [], tree);
  const saved = normalizeTemplateSpecForStorage(JSON.parse(JSON.stringify(applied)));
  const imported = saved.result.diagrams[0].authoring.d2Import;
  assert.ok(imported.structureTree.items.every((item) => item.mapping.primary.cardSource.id === selected.id));
  const reloaded = createDiagramImportProposal(saved, proposal.ir || normalizeDiagramImportIr({ version: 4, elements: proposal.structure, classes: proposal.classes }, proposal.source), { sourceText: proposal.source });
  const normalized = diagramImportStructureTree(imported.structureTree, proposal.structure, proposal.roles);
  assert.ok(normalized.items.every((item) => item.mapping.primary.cardSource.id === selected.id));
  const compiled = applyDiagramImportProposal(saved, reloaded, [], [], imported.structureTree);
  const mappings = [...compiled.result.diagrams[0].nodeMappings, ...compiled.result.diagrams[0].groupMappings].filter((item) => !(item.staticRows || []).length);
  assert.equal(mappings.length, 2);
  assert.ok(mappings.every((item) => item.fields.id === 'SourceId' && item.labelTemplate === '${SourceDescription}' && item.dataProfile.className === 'Server'));
});

test('same-stage different card sources are not collapsed into parentCard', () => {
  const { spec, proposal, tree, sourceStage } = persistenceFixture();
  const child = tree.items.find((item) => item.parentId);
  child.mapping.materialization = { kind: 'stage', stageId: sourceStage.id };
  child.mapping.primary.cardSource = sourceStage.cardSources[0];
  child.mapping.primary.className = sourceStage.cardSources[0].className;
  child.mapping.hierarchyConditions = { rules: [{ operator: 'equals', left: { column: 'SourceId' }, right: { kind: 'stage', stageId: sourceStage.id, column: 'SourceId' } }] };
  const normalized = diagramImportStructureTree(tree, proposal.structure, proposal.roles);
  assert.equal(normalized.items.find((item) => item.id === child.id).mapping.materialization.kind, 'stage');
  assert.deepEqual(diagramImportStructureTreeErrors(normalized, proposal.roles, spec, proposal.structure), []);
});

test('parentCard normalization replaces stale child source with the displayed parent source', () => {
  const { proposal, tree, selected, sourceStage } = persistenceFixture();
  const child = tree.items.find((item) => item.parentId);
  child.mapping.primary.cardSource = sourceStage.cardSources[0];
  child.mapping.primary.className = sourceStage.cardSources[0].className;
  const normalized = diagramImportStructureTree(tree, proposal.structure, proposal.roles);
  assert.equal(normalized.items.find((item) => item.id === child.id).mapping.primary.cardSource.id, selected.id);
});

test('execution validation accepts typed paths only for their exact retained card source', () => {
  const { spec, proposal, selected, tree, sourceStage, stages } = persistenceFixture();
  const root = tree.items.find((item) => !item.parentId);
  const validate = (source) => {
    root.mapping.conditions = { rules: [{ origin: 'assistant', operator: 'equals', left: { column: 'endpoint.ip', source }, right: { kind: 'literal', value: 'a' } }] };
    return assistantDiagramPlacementExecutionValidation({ currentSpec: spec, stages, structureTree: tree, structure: proposal.structure, validationRoles: proposal.roles,
      dataSemanticModel: { stages: [{ id: sourceStage.id, readableFields: sourceStage.columns,
        typedFields: [{ path: 'endpoint.ip', cardSourceId: selected.id, rootClass: selected.className }] }] }
    }, tree.items.map((item) => ({ structureItemId: item.id, mapping: item.mapping })));
  };
  assert.deepEqual(validate(selected).errors, []);
  assert.ok(validate(sourceStage.cardSources[0]).errors.some((error) => /was not offered/.test(error.message)));
  assert.ok(validate({ ...selected, className: 'Invented' }).errors.some((error) => /was not offered/.test(error.message)));
  assert.ok(validate(undefined).errors.some((error) => /was not offered/.test(error.message)));
});
