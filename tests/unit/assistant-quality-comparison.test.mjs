import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PRODUCTION_ARMS, PRODUCTION_STAGES, createProductionComparisonPlan, compareProductionSnapshots,
  evaluateProductionScenario, productionComparisonScenarios as cases, productionScenarioInput, validateProductionSnapshot,
  loadProductionComparisonPlan,
} from '../../scripts/assistant-quality-comparison.mjs';
import { VARIANTS } from '../../scripts/assistant-quality-lab.mjs';

const freezeConfig = () => ({ schema: { revision: 'catalog-v1' }, data: { revision: 'synthetic-v1' },
  prompts: Object.fromEntries(Object.keys(PRODUCTION_ARMS).map((arm) => [arm, { intent: `intent-${arm}`, binding: `binding-${arm}` }])),
  model: { id: 'not-called', revision: 'frozen-r1' } });
const planFor = (extra = {}) => createProductionComparisonPlan({ freeze: freezeConfig(), ...extra });
const accepted = () => ({ transportCompleted: true, contractValid: true, status: 'accepted' });
const stages = () => Object.fromEntries(PRODUCTION_STAGES.map((stage) => [stage, accepted()]));
const captureFor = (plan, item = plan.scenarios[0], arm = 'A', repeat = 0) => ({
  fingerprint: plan.fingerprint, caseId: item.id, arm, repeat,
  stages: item.expected.outcome === 'unresolved'
    ? { intent: { ...accepted(), status: 'unresolved' } } : stages(),
  ...(item.expected.outcome === 'accepted' ? { snapshot: structuredClone(item.expected.snapshot) } : {}),
});
const directory = () => mkdtempSync(join(tmpdir(), 'assistant-quality-comparison-'));

test('production matrix has separate meanings; historical simulation A-E stays unchanged', () => {
  assert.deepEqual(Object.keys(PRODUCTION_ARMS), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(PRODUCTION_ARMS.A.label, 'baseline');
  assert.equal(PRODUCTION_ARMS.B.explicitBindings, true);
  assert.equal(PRODUCTION_ARMS.C.typedContext, true);
  assert.equal(PRODUCTION_ARMS.D.externalCounterexample, true);
  assert.equal(PRODUCTION_ARMS.E.deterministicCompile, true);
  assert.match(VARIANTS.D, /business result binding/);
  assert.match(VARIANTS.E, /Fixed decision/);
  const plan = planFor();
  assert.equal(plan.manifest.scope, 'production-pipeline-comparison');
  assert.match(plan.manifest.historicalSimulation, /never relabel or pool/);
  assert.equal(plan.budget.jobs, 60);
  assert.equal(plan.budget.callsExecutedByThisTool, 0);
  assert.equal(plan.budget.costUsd, null);
  assert.equal(plan.manifest.limits.maxCalls, 40);
  assert.ok(Object.isFrozen(plan.scenarios[0].input.data));
  assert.throws(() => { plan.manifest.freeze.model.revision = 'changed'; }, TypeError);
});

test('disjoint task splits cover city/street/building, ambiguous references, copies, null Boolean grouping, IPv4 and absent candidates', () => {
  assert.equal(cases.length, 12);
  const dev = cases.filter((item) => item.split === 'development');
  const holdout = cases.filter((item) => item.split === 'holdout');
  assert.equal(dev.length, 6);
  assert.equal(holdout.length, 6);
  assert.equal(new Set(cases.map((item) => item.domain)).size, 12);
  assert.ok(holdout.every((item) => dev.every((other) => other.taskId !== item.taskId)));
  for (const item of cases) {
    if (item.expected.snapshot) assert.equal(validateProductionSnapshot(item.expected.snapshot), true, item.id);
  }
  const duplicateTask = structuredClone(cases[1]); duplicateTask.taskId = cases[0].taskId;
  assert.throws(() => planFor({ scenarios: [cases[0], duplicateTask] }), /comparison_split_leak/);
});

test('only public scenario context is returned; private rows, snapshots, outcomes and injected root keys never reach model input', () => {
  const item = structuredClone(cases[2]);
  item.input.oracle = 'PRIVATE_SENTINEL'; item.input.expected = 'PRIVATE_SENTINEL';
  item.expected.note = 'PRIVATE_SENTINEL';
  const plan = planFor({ scenarios: [item] });
  for (const arm of Object.keys(PRODUCTION_ARMS)) {
    const input = productionScenarioInput(plan, item.id, arm);
    assert.equal('explicitBindings' in input, ['B', 'E'].includes(arm));
    assert.equal('typedContext' in input, ['C', 'E'].includes(arm));
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_SENTINEL|snapshot|outcome|oracle|expected/);
    assert.equal(Object.isFrozen(input.data), true);
  }
  assert.match(productionScenarioInput(plan, item.id, 'C').typedContext.help, /rA is physical/);
  assert.doesNotMatch(JSON.stringify(productionScenarioInput(plan, item.id, 'A')), /rA is physical/);
});

test('independent evaluator uses multisets and all displayed-card, placement, hierarchy, directed multiedge and label fields', () => {
  for (const index of [0, 4, 8]) {
    const item = cases[index];
    const capture = { stages: stages(), snapshot: structuredClone(item.expected.snapshot) };
    for (const values of Object.values(capture.snapshot)) values.reverse();
    assert.equal(evaluateProductionScenario(item.expected, capture).exact, true);
    for (const field of ['rows', 'displayedCards', 'placements', 'hierarchy', 'edges', 'labels']) {
      if (!item.expected.snapshot[field].length) continue;
      const changed = structuredClone(capture);
      changed.snapshot[field].push(structuredClone(changed.snapshot[field][0]));
      assert.equal(evaluateProductionScenario(item.expected, changed).exact, false, `${item.id}:${field}`);
    }
  }
  const links = cases[8];
  for (const field of ['id', 'from', 'to', 'direction', 'label']) {
    const capture = { stages: stages(), snapshot: structuredClone(links.expected.snapshot) };
    capture.snapshot.edges[0][field] = ({ id: 'other-edge', from: 'n2', to: 'n1', direction: 'reverse', label: 'wrong-label' })[field];
    const evaluation = evaluateProductionScenario(links.expected, capture);
    assert.equal(evaluation.exact, false, field);
    assert.equal(evaluation.falseAcceptance, true, field);
  }
  const duplicateRows = structuredClone(cases[4].expected);
  duplicateRows.snapshot.rows.push(duplicateRows.snapshot.rows[0]);
  assert.equal(evaluateProductionScenario(duplicateRows, { stages: stages(), snapshot: cases[4].expected.snapshot }).checks.rows, false);
});

test('completed transport, valid unresolved, semantic mismatch and incomplete execution stay separate', () => {
  const item = cases[0];
  const capture = { stages: stages(), snapshot: structuredClone(item.expected.snapshot) };
  capture.snapshot.rows = [];
  const mismatch = evaluateProductionScenario(item.expected, capture);
  assert.equal(mismatch.transportCompleted, true);
  assert.equal(mismatch.contractValid, true);
  assert.equal(mismatch.semanticCorrect, false);
  assert.equal(mismatch.executionCorrect, false);
  assert.equal(mismatch.failed, false);
  delete capture.stages.execute;
  assert.equal(evaluateProductionScenario(item.expected, capture).failed, true);
  capture.stages.execute = { ...accepted(), transportCompleted: false };
  assert.equal(evaluateProductionScenario(item.expected, capture).failed, true);
  assert.equal(evaluateProductionScenario(item.expected, null).failure, 'missing_capture');
  const unresolved = { stages: { intent: accepted(), binding: { ...accepted(), status: 'unresolved' } } };
  assert.equal(evaluateProductionScenario(cases[10].expected, unresolved).correctAbstention, true);
  assert.equal(evaluateProductionScenario(item.expected, unresolved).correctAbstention, false);
  unresolved.stages.binding.contractValid = false;
  assert.equal(evaluateProductionScenario(cases[10].expected, unresolved).unresolved, false);
  assert.equal(evaluateProductionScenario(cases[10].expected, unresolved).failed, true);
});

test('primary denominator includes missing captures and failures; exact/evaluated remains diagnostic', () => {
  const plan = planFor({ scenarios: [cases[0]], repeats: 3 });
  const captures = [captureFor(plan), captureFor(plan, plan.scenarios[0], 'A', 1)];
  const report = compareProductionSnapshots({ plan, captures });
  const metric = report.metrics.find((item) => item.arm === 'A' && item.split === 'development');
  assert.equal(metric.total, 3);
  assert.equal(metric.failures, 1);
  assert.equal(metric.exact, 2);
  assert.equal(metric.exactRate, 2 / 3);
  assert.equal(metric.success, 2);
  assert.equal(metric.successRate, 2 / 3);
  assert.equal(metric.exactPerEvaluated, 1);
  assert.equal(report.metrics.find((item) => item.arm === 'B' && item.split === 'development').failures, 3);
  assert.match(report.modelQualityClaim, /^none/);
  assert.deepEqual(report.productionMetrics, []);
});

test('actual empty diagram, failed phase and missing execution all fail success/total, legitimate empty output passes', () => {
  const item = { ...structuredClone(cases[0]), evidenceKind: 'production' };
  const plan = planFor({ scenarios: [item], repeats: 4 });
  const empty = { rows: [], displayedCards: [], placements: [], hierarchy: [], edges: [], labels: [] };
  const emptyDiagram = captureFor(plan); emptyDiagram.snapshot = empty;
  const failedPhase = captureFor(plan, item, 'A', 1);
  failedPhase.stages.binding = { transportCompleted: false, contractValid: false, status: 'failed' };
  const incomplete = captureFor(plan, item, 'A', 2); delete incomplete.stages.execute;
  const correct = captureFor(plan, item, 'A', 3);
  const report = compareProductionSnapshots({ plan, captures: [emptyDiagram, failedPhase, incomplete, correct] });
  const metric = report.productionMetrics.find((entry) => entry.arm === 'A' && entry.split === 'development');
  assert.equal(metric.total, 4);
  assert.equal(metric.success, 1);
  assert.equal(metric.successRate, 1 / 4);
  assert.equal(metric.failures, 2);
  assert.equal(metric.falseAcceptance, 1);
  assert.deepEqual(report.results.filter((entry) => entry.arm === 'A').map((entry) => entry.status), ['mismatch', 'failed', 'failed', 'passed']);
  const expectedEmpty = { outcome: 'accepted', snapshot: empty };
  assert.equal(evaluateProductionScenario(expectedEmpty, { stages: stages(), snapshot: empty }).exact, true);
  assert.equal(evaluateProductionScenario(expectedEmpty, null).exact, false);
});

test('full data-only rows remain byte-for-byte equivalent while pair displayed source is scored independently', () => {
  const item = structuredClone(cases[0]);
  item.expected.snapshot = {
    rows: [{ blockId: 'pairs', row: { Class: 'Parent', _id: 'p7', Source_Class: 'Child', Source__id: 'c7', Source_Description: 'child label', managementIp: null } }],
    displayedCards: [{ className: 'Child', id: 'c7' }],
    placements: [{ id: 'child-copy', structureItemId: 'child', cardSourceId: 'relation-source', card: { className: 'Child', id: 'c7' } }],
    hierarchy: [], edges: [], labels: [{ targetId: 'child-copy', text: 'child label' }],
  };
  const before = JSON.stringify(item.expected.snapshot.rows);
  const wrong = { stages: stages(), snapshot: structuredClone(item.expected.snapshot) };
  wrong.snapshot.displayedCards = [{ className: 'Parent', id: 'p7' }];
  wrong.snapshot.placements[0].card = wrong.snapshot.displayedCards[0];
  wrong.snapshot.placements[0].cardSourceId = 'current';
  const evaluated = evaluateProductionScenario(item.expected, wrong);
  assert.equal(evaluated.checks.rows, true);
  assert.equal(evaluated.checks.displayedCards, false);
  assert.equal(evaluated.checks.placements, false);
  assert.equal(evaluated.exact, false);
  assert.equal(JSON.stringify(wrong.snapshot.rows), before);
  assert.equal(JSON.stringify(item.expected.snapshot.rows), before);
  const right = { stages: stages(), snapshot: structuredClone(item.expected.snapshot) };
  assert.equal(evaluateProductionScenario(item.expected, right).exact, true);
  right.snapshot.placements[0].cardSourceId = 'current';
  assert.equal(evaluateProductionScenario(item.expected, right).exact, false);
  const changedRows = { stages: stages(), snapshot: structuredClone(item.expected.snapshot) };
  changedRows.snapshot.rows[0].row.Source__id = 'different-card';
  assert.equal(evaluateProductionScenario(item.expected, changedRows).checks.rows, false);
});

test('external scenario/oracle paths are loaded and content frozen without baking template IDs into harness', () => {
  const dir = directory();
  const inputPath = join(dir, 'input.json');
  const expectedPath = join(dir, 'oracle.json');
  const configPath = join(dir, 'comparison.json');
  writeFileSync(inputPath, JSON.stringify(cases[0].input));
  writeFileSync(expectedPath, JSON.stringify(cases[0].expected));
  const { input, expected, ...metadata } = cases[0];
  writeFileSync(configPath, JSON.stringify({ freeze: freezeConfig(), scenarios: [{ ...metadata, inputPath: 'input.json', expectedPath: 'oracle.json' }] }));
  const plan = loadProductionComparisonPlan(configPath);
  assert.equal(evaluateProductionScenario(plan.scenarios[0].expected, captureFor(plan)).exact, true);
  const changed = structuredClone(expected); changed.snapshot.rows = [];
  writeFileSync(expectedPath, JSON.stringify(changed));
  assert.notEqual(loadProductionComparisonPlan(configPath).fingerprint, plan.fingerprint);
});

test('opaque reference guesses cannot count as semantic correctness without curated Help', () => {
  const plan = planFor({ scenarios: [cases[2]] });
  const captures = Object.keys(PRODUCTION_ARMS).map((arm) => captureFor(plan, plan.scenarios[0], arm));
  const results = compareProductionSnapshots({ plan, captures }).results;
  for (const result of results) assert.equal(result.evaluation.exact, ['C', 'E'].includes(result.arm));
  assert.equal(results[0].evaluation.falseAcceptance, true);
});

test('stage checkpoints resume partial captures, reject conflicting rewrites and freeze schema/data/prompts/model', () => {
  const outputDir = directory();
  const plan = planFor({ scenarios: [cases[0]] });
  const capture = captureFor(plan);
  const partial = { ...capture, stages: { intent: accepted() } }; delete partial.snapshot;
  assert.equal(compareProductionSnapshots({ plan, captures: [partial], outputDir }).results[0].evaluation.failed, true);
  const complete = compareProductionSnapshots({ plan, captures: [capture], outputDir, resume: true });
  assert.equal(complete.results[0].evaluation.exact, true);
  assert.equal(compareProductionSnapshots({ plan, outputDir, resume: true }).results[0].evaluation.exact, true);
  const count = readFileSync(join(outputDir, 'events.jsonl'), 'utf8').trim().split('\n').length;
  compareProductionSnapshots({ plan, captures: [capture], outputDir, resume: true });
  assert.equal(readFileSync(join(outputDir, 'events.jsonl'), 'utf8').trim().split('\n').length, count);
  assert.throws(() => compareProductionSnapshots({ plan, captures: [{ ...capture, stages: { intent: { ...accepted(), status: 'failed' } } }], outputDir, resume: true }), /comparison_checkpoint_conflict/);
  for (const field of ['schema', 'data', 'prompts', 'model']) {
    const changed = freezeConfig();
    if (field === 'model') changed.model.revision = 'changed';
    else if (field === 'prompts') changed.prompts.A.intent = 'changed';
    else changed[field].revision = 'changed';
    const otherPlan = planFor({ scenarios: [cases[0]], freeze: changed });
    assert.throws(() => compareProductionSnapshots({ plan: otherPlan, outputDir, resume: true }), /checkpoint_mismatch/);
  }
  assert.throws(() => compareProductionSnapshots({ plan, captures: [{ ...capture, fingerprint: 'old-simulation' }] }), /comparison_invalid_capture/);
  const forged = structuredClone(plan); forged.scenarios[0].input.request = 'changed';
  assert.throws(() => compareProductionSnapshots({ plan: forged }), /comparison_freeze_mismatch/);
});

test('caps and frozen prompt/model revisions are mandatory, historical reports cannot be captures', () => {
  assert.throws(() => createProductionComparisonPlan({}), /comparison_freeze_required/);
  const missingPrompt = freezeConfig(); delete missingPrompt.prompts.E;
  assert.throws(() => planFor({ freeze: missingPrompt }), /comparison_freeze_required/);
  for (const limits of [{ concurrency: 3 }, { maxRepairs: 2 }, { maxCalls: 0 }, { maxTotalTokens: NaN }]) {
    assert.throws(() => planFor({ limits }), /comparison_invalid_limits/);
  }
  const plan = planFor({ maxSnapshotBytes: 1 });
  assert.throws(() => compareProductionSnapshots({ plan, captures: [captureFor(plan)] }), /comparison_snapshot_limit/);
  assert.throws(() => compareProductionSnapshots({ plan: planFor(), captures: [{ scope: 'abstract-stage-simulation', results: [] }] }), /comparison_invalid_capture/);
});

test('full-row snapshot size has an independent bound, not the LLM response bound; no truncation', () => {
  const item = structuredClone(cases[0]);
  item.expected.snapshot.rows[0].fullPayload = 'x'.repeat(2 * 1024 * 1024);
  const plan = planFor({ scenarios: [item], limits: { maxResponseBytes: 32 } });
  const capture = captureFor(plan);
  const before = JSON.stringify(capture.snapshot.rows);
  const report = compareProductionSnapshots({ plan, captures: [capture] });
  assert.equal(report.results[0].pass, true);
  assert.equal(JSON.stringify(capture.snapshot.rows), before);
  assert.equal(capture.snapshot.rows[0].fullPayload.length, 2 * 1024 * 1024);
});

test('offline CLI writes only plans/reports and never loads a provider or performs network calls', () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('network forbidden');
  try {
    const plan = planFor();
    const report = compareProductionSnapshots({ plan });
    assert.equal(report.results.length, 60);
    assert.ok(report.results.every((item) => item.evaluation.failed));
    const file = join(directory(), 'plan.json');
    writeFileSync(file, JSON.stringify({ freeze: freezeConfig() }));
    const stdout = execFileSync(process.execPath, ['scripts/assistant-quality-comparison.mjs', '--plan', file], { encoding: 'utf8' });
    assert.equal(JSON.parse(stdout).budget.callsExecutedByThisTool, 0);
  } finally { globalThis.fetch = original; }
});
