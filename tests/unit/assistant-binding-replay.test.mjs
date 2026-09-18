import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingReplayBatches, mergeBindingReplay, replayBinding } from '../../scripts/assistant-binding-replay.mjs';

const input = {
  prompt: 'Map named results.', businessBlockManifest: { blocks: [{ id: 'b1', name: 'Items', terminalStageId: 'selection:b1' }] },
  placements: [0, 1, 2].map((i) => ({ structureItemId: `p${i}`, displayName: `P${i}`, roleId: `r${i}`,
    allowedMaterialization: ['stage'], notes: 'Use the matching business result.', directives: {} })),
  relationRules: [],
};
test('binding replay batching retains global context and partitions targets without mutations', () => {
  const before = JSON.stringify(input);
  const batches = bindingReplayBatches(input, 2);
  assert.deepEqual(batches.map((batch) => batch.placements.length), [2, 1]);
  assert.equal(batches[1].businessBlockManifest, input.businessBlockManifest);
  assert.equal(JSON.stringify(input), before);
});
test('binding replay validates missing targets after merging instead of counting partial acceptance', () => {
  const draft = mergeBindingReplay(input, [{ placementBindings: [{ structureItemId: 'p0', materializationIntent: 'stage', businessBlockId: 'b1' }] }]);
  assert.equal(draft.success, false);
  assert.equal(draft.errors.length, 2);
});
test('binding replay dry run makes no model calls and live path shares production validation', async () => {
  let calls = 0;
  const complete = async ({ messages }) => {
    calls += 1;
    const payload = JSON.parse(messages.at(-1).content);
    return { content: JSON.stringify({ placementBindings: payload.placements.map((item) => ({
      structureItemId: item.structureItemId, materializationIntent: 'stage', businessBlockId: 'b1',
    })) }) };
  };
  assert.equal((await replayBinding({ input, batchSize: 2, complete, dryRun: true })).calls.length, 2);
  assert.equal(calls, 0);
  const report = await replayBinding({ input, batchSize: 2, complete });
  assert.equal(calls, 2);
  assert.equal(report.complete, true);
  assert.equal(report.draft.success, true);
});

test('binding replay scopes responses like production when global models contain other placements', async () => {
  const report = await replayBinding({ input, batchSize: 1, complete: async () => ({ content: JSON.stringify({
    placementBindings: input.placements.map((item) => ({ structureItemId: item.structureItemId,
      materializationIntent: 'stage', businessBlockId: 'b1' })),
  }) }) });
  assert.equal(report.draft.success, true);
  assert.equal(report.draft.intent.placements.length, 3);
});
