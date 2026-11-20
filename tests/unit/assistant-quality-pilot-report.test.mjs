import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePilotAttempt, summarizePilotAttempts } from '../../scripts/assistant-quality-pilot-report.mjs';

const accepted = { status: 'accepted' };
const row = { blockId: 'buildings', values: { id: 7, street: 0 } };
const graph = {
  placements: [
    { id: 'city-1', structureItemId: 'cities', card: { className: 'City', id: '1' }, cardSourceId: 'current' },
    { id: 'building-7', structureItemId: 'buildings', card: { className: 'Building', id: '7' }, cardSourceId: 'current' },
  ],
  hierarchy: [{ parent: 'city-1', child: 'building-7' }],
  edges: [{ id: 'address-7', from: 'building-7', to: 'city-1', direction: 'forward', label: 'Address' }],
  labels: [{ targetId: 'address-7', text: 'Address' }],
};
const flow = (rows, extra = {}) => ({ stages: { flow: accepted, rows: accepted }, rows, complete: true, ...extra });
const mapping = (snapshot, extra = {}) => ({ stages: { mapping: accepted, graph: accepted }, graph: snapshot, complete: true, ...extra });
const oracle = { outcome: 'accepted', rows: [row], graph };

test('scores full rows as an unordered, duplicate-preserving multiset', () => {
  const copy = { values: { street: 0, id: 7 }, blockId: 'buildings' };
  const otherBlock = { ...row, blockId: 'offices' };
  const otherValue = { ...row, values: { id: 7, street: null } };
  const score = (rows) => scorePilotAttempt({ mode: 'flow', oracle: { ...oracle, rows: [row, row, otherBlock] }, capture: flow(rows) });
  assert.equal(score([otherBlock, copy, copy]).exact, true);
  const partial = score([otherBlock, copy, otherValue, otherValue]);
  assert.deepEqual(partial.metrics.rows, { expected: 3, actual: 4, matched: 2, precision: 1 / 2, recall: 2 / 3 });
  assert.equal(partial.exact, false);
  assert.equal(partial.falseAcceptance, true);
});

test('scores canonical placements, hierarchy, directed edges and labels independently', () => {
  const score = (snapshot) => scorePilotAttempt({ mode: 'mapping', oracle, capture: mapping(snapshot) });
  assert.equal(score({ ...graph, placements: [...graph.placements].reverse() }).exact, true);
  const changes = {
    placements: [{ ...graph.placements[0], id: 'city-other' }, graph.placements[1]],
    hierarchy: [{ parent: 'building-7', child: 'city-1' }],
    edges: [{ ...graph.edges[0], direction: 'reverse' }],
    labels: [{ ...graph.labels[0], text: 'Wrong label' }],
  };
  for (const [field, value] of Object.entries(changes)) {
    const result = score({ ...graph, [field]: value });
    assert.equal(result.exact, false, field);
    assert.equal(result.falseAcceptance, true, field);
    assert.equal(result.metrics[field].matched, graph[field].length - 1, field);
    for (const other of Object.keys(graph).filter((key) => key !== field)) {
      assert.equal(result.metrics[other].recall, 1, `${field}:${other}`);
    }
  }
  const duplicated = score({ ...graph, edges: [...graph.edges, ...graph.edges] });
  assert.equal(duplicated.metrics.edges.precision, 1 / 2);
  assert.equal(duplicated.metrics.edges.recall, 1);
});

test('scores partial rows and graph without granting exact to failed or incomplete captures', () => {
  const previous = flow([row], { complete: false, failure: 'pilot_mapping_failure' });
  const failed = scorePilotAttempt({ mode: 'end-to-end', oracle, capture: previous });
  assert.equal(failed.metrics.rows.recall, 1);
  assert.equal(failed.metrics.placements, null);
  assert.equal(failed.failed, true);
  assert.equal(failed.failure, 'pilot_mapping_failure');
  assert.equal(failed.exact, false);
  assert.equal(failed.falseAcceptance, false);

  const capture = mapping(graph, { complete: false });
  const capped = scorePilotAttempt({ mode: 'mapping', oracle, capture });
  assert.equal(capped.metrics.edges.precision, 1);
  assert.equal(capped.exact, false);
  assert.equal(capped.failure, 'incomplete_capture');

  const missingStage = scorePilotAttempt({ mode: 'flow', oracle, capture: flow([row], { stages: { flow: accepted } }) });
  assert.equal(missingStage.exact, false);
  assert.equal(missingStage.metrics.rows.recall, 1);
});

test('requires the optional complete terminal block manifest even when an expected block has no rows', () => {
  const expected = { ...oracle, blockIds: ['buildings', 'empty'] };
  for (const mode of ['flow', 'end-to-end']) {
    const score = (blockIds) => scorePilotAttempt({ mode, oracle: expected, capture: {
      ...flow([row]), blockIds,
      ...(mode === 'end-to-end' ? { graph, stages: { flow: accepted, rows: accepted, mapping: accepted, graph: accepted } } : {}),
    } });
    assert.equal(score(['empty', 'buildings']).exact, true);
    for (const blockIds of [undefined, ['buildings'], ['buildings', 'empty', 'other'], ['buildings', 'empty', 'empty']]) {
      const scored = score(blockIds);
      assert.equal(scored.exact, false, `${mode}:${blockIds}`);
      assert.equal(scored.failure, 'incomplete_block_manifest');
      assert.equal(scored.metrics.rows.recall, 1);
    }
  }
  assert.equal(scorePilotAttempt({ mode: 'flow', oracle, capture: flow([row]) }).exact, true);
  assert.equal(scorePilotAttempt({ mode: 'mapping', oracle: expected, capture: mapping(graph) }).exact, true);
});

test('distinguishes a valid unresolved terminal from a false acceptance or a broken stage chain', () => {
  const blockedOracle = { outcome: 'unresolved' };
  const unresolved = { stages: { flow: { status: 'unresolved' } }, complete: false };
  const score = (expected, capture, mode = 'flow') => scorePilotAttempt({ mode, oracle: expected, capture });
  const correct = score(blockedOracle, unresolved);
  assert.equal(correct.validUnresolved, true);
  assert.equal(correct.correctAbstention, true);
  assert.equal(correct.failed, false);
  assert.equal(correct.exact, false);
  assert.equal(score(oracle, unresolved).correctAbstention, false);
  assert.equal(score(blockedOracle, flow([])).falseAcceptance, true);
  assert.equal(score(blockedOracle, flow(undefined)).falseAcceptance, false);
  assert.equal(score(blockedOracle, { ...unresolved, failure: 'pilot_transport_failure' }).validUnresolved, false);
  assert.equal(score(blockedOracle, { stages: { ...unresolved.stages, rows: accepted } }).validUnresolved, false);
  assert.equal(score(blockedOracle, { stages: { mapping: { status: 'unresolved' } } }, 'end-to-end').validUnresolved, false);
});

test('retains failures in denominator and aggregates flattened evaluations by scenario, variant and mode', () => {
  const item = (capture, key = {}) => ({ scenarioId: 'address', variant: 'A', mode: 'flow', ...key,
    ...scorePilotAttempt({ mode: key.mode ?? 'flow', oracle, capture }) });
  const summary = summarizePilotAttempts([
    item(flow([row], { telemetry: { durationMs: 0, calls: 0, requests: 0, repairs: 0, inputTokens: 0, outputTokens: 0 } })),
    item(undefined), item({ failure: 'pilot_provider_failure', telemetry: { durationMs: 12, requests: 2 } }),
    item(flow([]), { variant: 'B' }), item(flow([row]), { scenarioId: 'other' }),
    item(mapping(graph), { mode: 'mapping' }),
  ]);
  assert.equal(summary.groups.length, 4);
  const group = summary.groups.find(({ scenarioId, variant, mode }) => scenarioId === 'address' && variant === 'A' && mode === 'flow');
  assert.equal(group.total, 3);
  assert.equal(group.failures, 2);
  assert.equal(group.exact, 1);
  assert.equal(group.exactRate, 1 / 3);
  assert.deepEqual(group.metrics.rows, { scored: 1, expected: 1, actual: 1, matched: 1, precision: 1, recall: 1 });
  assert.deepEqual(group.telemetry.durationMs, { known: 2, total: null, mean: 6 });
  assert.deepEqual(group.telemetry.calls, { known: 1, total: null, mean: 0 });
  assert.equal(summary.overall.exactRate, 1 / 2);
  assert.equal(summary.overall.falseAcceptances, 1);
  assert.equal(summarizePilotAttempts([]).overall.exactRate, null);
});

test('reports exact empty results, mathematical zero and missing telemetry separately', () => {
  const empty = scorePilotAttempt({ mode: 'flow', oracle: { ...oracle, rows: [] }, capture: flow([]) });
  assert.equal(empty.exact, true);
  assert.deepEqual(empty.metrics.rows, { expected: 0, actual: 0, matched: 0, precision: null, recall: null });
  assert.deepEqual(empty.telemetry, { durationMs: null, calls: null, requests: null, modelRequests: null, repairs: null, inputTokens: null, outputTokens: null });
  const missed = scorePilotAttempt({ mode: 'flow', oracle, capture: flow([]) });
  assert.equal(missed.metrics.rows.recall, 0);
  const scored = scorePilotAttempt({ mode: 'flow', oracle, capture: flow([row], { telemetry: { calls: 0, repairs: 0 } }) });
  assert.equal(scored.telemetry.calls, 0);
  assert.equal(scored.telemetry.repairs, 0);
  assert.equal(scored.telemetry.inputTokens, null);
  const { telemetry } = summarizePilotAttempts([{ scenarioId: 'address', variant: 'A', mode: 'flow', ...scored }]).overall;
  assert.deepEqual(telemetry.calls, { known: 1, total: 0, mean: 0 });
  assert.deepEqual(telemetry.inputTokens, { known: 0, total: null, mean: null });
});
