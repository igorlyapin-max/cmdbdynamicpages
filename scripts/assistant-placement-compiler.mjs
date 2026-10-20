export function assistantPlacementHasStageAncestor(itemId, placements, kinds) {
  const byId = new Map((placements || []).map((item) => [item.structureItemId, item]));
  const seen = new Set([itemId]);
  let id = byId.get(itemId)?.parentStructureItemId;
  while (id) {
    if (seen.has(id) || !byId.has(id) || !kinds.has(id)) return null;
    seen.add(id);
    if (kinds.get(id) === 'stage') return true;
    id = byId.get(id).parentStructureItemId;
  }
  return false;
}

/** Compile confirmed authoring decisions, never infer a stage from names or lineage. */
export function compileAssistantPlacementIntent(input) {
  if (!input?.bindingIntent) return null;
  const manifest = new Map((input.businessBlockManifest?.blocks || []).map((block) => [block.id, block]));
  const stages = new Set((input.stages || []).map((stage) => stage.id));
  const bindings = new Map((input.bindingIntent.placements || []).map((binding) => [binding.structureItemId, binding]));
  const unresolvedById = new Map((input.bindingIntent.unresolved || []).filter((item) => item.targetType === 'placement')
    .map((item) => [item.targetId, item]));
  const mappings = [], unresolved = [];
  for (const placement of input.placements || []) {
    if (placement.templateStatic) continue;
    const id = placement.structureItemId;
    const binding = bindings.get(id);
    const pending = unresolvedById.get(id);
    if (binding && pending) return null;
    if (!binding) {
      if (!pending) return null;
      unresolved.push({ structureItemId: id, reason: pending.reason === 'ambiguousBlock' ? 'ambiguousStage' : 'noCompatibleStage',
        message: String(pending.message || '') });
      continue;
    }
    const kind = binding.materializationIntent;
    if (!(placement.allowedMaterialization || []).includes(kind)) return null;
    const candidate = { structureItemId: id, materialization: kind, confidence: 'high',
      reason: 'Compiled from confirmed business binding intent.' };
    if (kind === 'stage') {
      // A helper-allowed policy does not identify which helper the author chose.
      if (binding.stagePolicy === 'helper-allowed') return null;
      const block = manifest.get(binding.businessBlockId);
      if (!block?.terminalStageId || !stages.has(block.terminalStageId)) return null;
      candidate.stageId = block.terminalStageId;
      candidate.cardSourceId = binding.cardSourceId;
    } else if (!['structural', 'parentCard'].includes(kind)) return null;
    for (const family of ['conditions', 'hierarchyConditions']) {
      if (placement.currentMapping?.[family] !== undefined) {
        candidate[family] = structuredClone(placement.currentMapping[family]);
      }
    }
    mappings.push(candidate);
  }
  return { mappings, unresolved, explanation: 'Размещения скомпилированы из подтвержденного binding intent без повторного выбора моделью.', warnings: [] };
}
