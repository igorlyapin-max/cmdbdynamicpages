import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingReplayBatches, mergeBindingReplay, replayBinding } from '../../scripts/assistant-binding-replay.mjs';

const input = {
  prompt: 'Map named results.', businessBlockManifest: { blocks: [{ id: 'b1', name: 'Items', terminalStageId: 'selection:b1',
    primaryClass: 'Item', terminalCardSources: [{ id: 'current', className: 'Item', classColumn: 'Class', idColumn: '_id' }] }] },
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

const seededInput = () => ({ ...input, placements: [{ ...input.placements[0], directives: { 'binding-result': 'b1' },
  notes: 'binding-result: b1\nUse only the physical reference described by Help.' }],
  relationRules: [{ d2ClassKey: 'links', d2Notes: 'binding-result: b1\nDetermine source and target fields from Help.' }] });

test('seeded bindings do not discard valid unresolved natural-language Notes', () => {
  const seeded = seededInput();
  const unresolved = [{ targetType: 'placement', targetId: 'p0', reason: 'ambiguousBlock', message: 'Need physical-reference Help.' },
    { targetType: 'connection', targetId: 'links', reason: 'noCompatibleBlock', message: 'Need endpoint fields.' }];
  const draft = mergeBindingReplay(seeded, [{ unresolved }]);
  assert.equal(draft.success, true);
  assert.deepEqual(draft.intent.unresolved, unresolved);
  assert.deepEqual(draft.intent.placements, []);
  assert.deepEqual(draft.intent.connections, []);
});

test('seeded pending omissions and conflicting duplicates cannot be hidden by deterministic defaults', () => {
  const draft = mergeBindingReplay(seededInput(), []);
  assert.equal(draft.success, false);
  assert.equal(draft.errors.length, 2);
  const binding = { structureItemId: 'p0', materializationIntent: 'stage', businessBlockId: 'b1' };
  const conflicting = mergeBindingReplay({ ...input, placements: [input.placements[0]] }, [{
    placementBindings: [binding, { ...binding, membership: 'compare' }],
  }]);
  assert.equal(conflicting.success, false);
});

test('replay separates transport, valid unresolved contract and unmeasured semantics/execution', async () => {
  const report = await replayBinding({ input: seededInput(), complete: async () => ({ content: JSON.stringify({
    unresolved: [{ targetType: 'placement', targetId: 'p0', reason: 'ambiguousBlock' },
      { targetType: 'connection', targetId: 'links', reason: 'ambiguousBlock' }],
  }) }) });
  assert.equal(report.transportCompleted, true);
  assert.equal(report.contractValid, true);
  assert.equal(report.unresolved, 2);
  assert.equal(report.resolved, false);
  assert.equal(report.semanticCorrect, null);
  assert.equal(report.executionCorrect, null);
});

test('invalid JSON and contract count as failures even when transport completed', async () => {
  for (const content of ['{', '{}', '{"placementBindings":{}}', '{"placementBindings":[null]}']) {
    const report = await replayBinding({ input: seededInput(), complete: async () => ({ content }) });
    assert.equal(report.transportCompleted, true);
    assert.equal(report.contractValid, false);
    assert.equal(report.resolved, false);
    assert.ok(report.calls[0].failure);
  }
});

test('pending transport failure and uncooperative timeout remain failures, with no implicit retry', async () => {
  for (const complete of [async () => { throw new Error('private provider details'); }, () => new Promise(() => {})]) {
    const report = await replayBinding({ input: seededInput(), complete, timeoutMs: 5 });
    assert.equal(report.transportCompleted, false);
    assert.equal(report.contractValid, false);
    assert.equal(report.draft.success, false);
    assert.equal(report.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /private provider details/);
  }
});

test('invalid API limits are rejected before batching or calls', async () => {
  assert.throws(() => bindingReplayBatches(input, -1), /replay_invalid_limits/);
  await assert.rejects(replayBinding({ input, batchSize: 0.5 }), /replay_invalid_limits/);
  await assert.rejects(replayBinding({ input, maxOutputTokens: Infinity }), /replay_invalid_limits/);
});
