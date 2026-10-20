import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAssistantPlacementIntent } from '../../scripts/assistant-placement-compiler.mjs';
import { assistantDiagramPlacementDraftFromResponse } from '../../scripts/dev-proxy-server.mjs';

function fixture() {
  return { placements: [
    { structureItemId: 'frame', visualKind: 'container', allowedMaterialization: ['structural'], directives: {} },
    { structureItemId: 'scope', roleId: 'city', parentStructureItemId: 'frame', visualKind: 'container', allowedMaterialization: ['stage'], directives: {} },
    { structureItemId: 'node', roleId: 'city-card', parentStructureItemId: 'scope', visualKind: 'node', allowedMaterialization: ['parentCard'], directives: {} }
  ], stages: [{ id: 'selection:cities', alias: 'cities', className: 'City', columns: ['_id', 'Class', 'Description'], stageRole: 'terminal',
    assistantBlockIds: ['selected'], cardSources: [{ id: 'current', className: 'City', idColumn: '_id', classColumn: 'Class' }] }],
  businessBlockManifest: { blocks: [{ id: 'selected', terminalStageId: 'selection:cities' }] },
  bindingIntent: { placements: [
    { structureItemId: 'frame', materializationIntent: 'structural' },
    { structureItemId: 'scope', materializationIntent: 'stage', businessBlockId: 'selected', cardSourceId: 'current' },
    { structureItemId: 'node', materializationIntent: 'parentCard' }
  ], unresolved: [] } };
}

test('confirmed business intent compiles placements without a second stage selection or mutation', () => {
  const input = fixture(), before = structuredClone(input);
  const response = compileAssistantPlacementIntent(input);
  assert.equal(response.mappings[1].stageId, 'selection:cities');
  assert.equal(response.mappings[1].cardSourceId, 'current');
  assert.equal(response.mappings[2].materialization, 'parentCard');
  const draft = assistantDiagramPlacementDraftFromResponse(input, response);
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.equal(draft.items[2].mapping.primary.cardSource.className, 'City');
  assert.deepEqual(input, before);
});

test('compiler preserves each copy and unresolved authoring target instead of guessing', () => {
  const input = fixture();
  input.placements.push({ ...input.placements[2], structureItemId: 'copy' });
  input.bindingIntent.placements.push({ ...input.bindingIntent.placements[2], structureItemId: 'copy' });
  assert.deepEqual(compileAssistantPlacementIntent(input).mappings.map((item) => item.structureItemId), ['frame', 'scope', 'node', 'copy']);
  input.bindingIntent.placements = input.bindingIntent.placements.filter((item) => item.structureItemId !== 'scope');
  input.bindingIntent.unresolved.push({ targetType: 'placement', targetId: 'scope', reason: 'ambiguousBlock', message: 'Choose a result.' });
  const response = compileAssistantPlacementIntent(input);
  assert.equal(response.unresolved[0].reason, 'ambiguousStage');
  assert.equal(response.mappings.some((item) => item.structureItemId === 'scope'), false);
});

test('missing, invalid, or helper-allowed choices remain decisions for the existing assistant path', () => {
  assert.equal(compileAssistantPlacementIntent({}), null);
  for (const edit of [
    (i) => { i.bindingIntent.placements.pop(); },
    (i) => { i.bindingIntent.placements[1].stagePolicy = 'helper-allowed'; },
    (i) => { i.businessBlockManifest.blocks[0].terminalStageId = 'invented'; },
    (i) => { i.bindingIntent.placements[1].materializationIntent = 'invented'; },
    (i) => { i.bindingIntent.unresolved.push({ targetType: 'placement', targetId: 'node' }); }
  ]) {
    const input = fixture(); edit(input);
    assert.equal(compileAssistantPlacementIntent(input), null);
  }
});
