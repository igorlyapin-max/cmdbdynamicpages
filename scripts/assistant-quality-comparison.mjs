#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkpointStore, DEFAULT_LIMITS, hashInput, stableJson } from './assistant-quality-lab.mjs';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const same = (a, b) => stableJson(a) === stableJson(b);
const multiset = (values) => values.map(stableJson).sort();
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,159}$/.test(value);
const text = (value) => typeof value === 'string';
const exactKeys = (value, keys) => plain(value) && same(Object.keys(value).sort(), [...keys].sort());
const validStage = (value) => exactKeys(value, ['transportCompleted', 'contractValid', 'status'])
  && typeof value.transportCompleted === 'boolean' && typeof value.contractValid === 'boolean'
  && ['accepted', 'unresolved', 'failed'].includes(value.status);

export const PRODUCTION_COMPARISON_VERSION = '1';
export const DEFAULT_PRODUCTION_LIMITS = Object.freeze({ ...DEFAULT_LIMITS, maxCalls: 40, maxTotalTokens: 736000 });
export const PRODUCTION_ARMS = freeze({
  A: { label: 'baseline', revisedPrompts: false, explicitBindings: false, typedContext: false, deterministicCompile: false, externalCounterexample: false },
  B: { label: 'prompts+explicit-bindings', revisedPrompts: true, explicitBindings: true, typedContext: false, deterministicCompile: false, externalCounterexample: false },
  C: { label: 'typed-context', revisedPrompts: false, explicitBindings: false, typedContext: true, deterministicCompile: false, externalCounterexample: false },
  D: { label: 'deterministic-compile+external-counterexample', revisedPrompts: false, explicitBindings: false, typedContext: false, deterministicCompile: true, externalCounterexample: true },
  E: { label: 'combined', revisedPrompts: true, explicitBindings: true, typedContext: true, deterministicCompile: true, externalCounterexample: true },
});
export const PRODUCTION_STAGES = Object.freeze(['intent', 'binding', 'compile', 'execute']);
const FIELDS = ['rows', 'displayedCards', 'placements', 'hierarchy', 'edges', 'labels'];
const cardValid = (value) => exactKeys(value, ['className', 'id']) && id(value.className) && id(value.id);

export function validateProductionSnapshot(value) {
  if (!exactKeys(value, FIELDS) || !FIELDS.every((field) => Array.isArray(value[field]))) return false;
  if (!value.rows.every(plain) || !value.displayedCards.every(cardValid)) return false;
  if (!value.placements.every((p) => exactKeys(p, ['id', 'structureItemId', 'card', 'cardSourceId']) && id(p.id) && id(p.structureItemId)
    && (p.card === null ? p.cardSourceId === null : cardValid(p.card) && id(p.cardSourceId)))) return false;
  const placementIds = new Set(value.placements.map((p) => p.id));
  if (placementIds.size !== value.placements.length) return false;
  if (!same(multiset(value.placements.filter((p) => p.card !== null).map((p) => p.card)), multiset(value.displayedCards))) return false;
  if (!value.hierarchy.every((pair) => exactKeys(pair, ['parent', 'child']) && placementIds.has(pair.parent) && placementIds.has(pair.child))) return false;
  if (!value.edges.every((edge) => exactKeys(edge, ['id', 'from', 'to', 'direction', 'label']) && id(edge.id)
    && placementIds.has(edge.from) && placementIds.has(edge.to) && ['forward', 'reverse'].includes(edge.direction) && text(edge.label))) return false;
  const labelTargets = new Set([...placementIds, ...value.edges.map((edge) => edge.id)]);
  return value.labels.every((label) => exactKeys(label, ['targetId', 'text']) && labelTargets.has(label.targetId) && text(label.text));
}

function publicScenario(item, arm) {
  const { request, schema, data, explicitBindings, typedContext } = item.input;
  return { request, schema, data,
    ...(PRODUCTION_ARMS[arm].explicitBindings ? { explicitBindings } : {}),
    ...(PRODUCTION_ARMS[arm].typedContext ? { typedContext } : {}) };
}

/** Only public inputs cross this boundary. Private expected snapshots never do. */
export function productionScenarioInput(plan, caseId, arm) {
  check(Object.hasOwn(PRODUCTION_ARMS, arm), 'comparison_unknown_arm');
  const item = plan.scenarios.find((scenario) => scenario.id === caseId);
  check(item, 'comparison_unknown_case');
  return freeze(clone(publicScenario(item, arm)));
}

export function createProductionComparisonPlan(options) {
  const scenarios = clone(options.scenarios || productionComparisonScenarios);
  check(Array.isArray(scenarios) && scenarios.length > 0, 'comparison_invalid_scenarios');
  const keys = new Set();
  const tasks = new Map();
  for (const item of scenarios) {
    check(id(item.id) && !keys.has(item.id) && id(item.taskId) && id(item.domain) && ['synthetic', 'production'].includes(item.evidenceKind) &&
      ['development', 'holdout'].includes(item.split), 'comparison_invalid_scenarios');
    keys.add(item.id);
    // Paraphrases or differently named copies of a development task cannot be holdout.
    check(!tasks.has(item.taskId) || tasks.get(item.taskId) === item.split, 'comparison_split_leak');
    tasks.set(item.taskId, item.split);
    check(plain(item.input) && text(item.input.request) && plain(item.input.schema) && plain(item.input.data)
      && plain(item.input.explicitBindings) && plain(item.input.typedContext), 'comparison_invalid_scenarios');
    check(['accepted', 'unresolved'].includes(item.expected?.outcome) &&
      (item.expected.outcome === 'unresolved' ? item.expected.snapshot === null : validateProductionSnapshot(item.expected.snapshot)), 'comparison_invalid_oracle');
  }
  const frozen = clone(options.freeze || {});
  check(exactKeys(frozen, ['schema', 'data', 'prompts', 'model']) && plain(frozen.model) &&
    id(frozen.model.id) && id(frozen.model.revision), 'comparison_freeze_required');
  check(plain(frozen.schema) && plain(frozen.data) && plain(frozen.prompts) && Object.keys(frozen.schema).length > 0
    && Object.keys(frozen.data).length > 0 && Object.keys(PRODUCTION_ARMS).every((arm) => plain(frozen.prompts[arm]) &&
      ['intent', 'binding'].every((stage) => text(frozen.prompts[arm][stage]) && frozen.prompts[arm][stage].trim())), 'comparison_freeze_required');
  const limits = { ...DEFAULT_PRODUCTION_LIMITS, ...options.limits };
  check(exactKeys(limits, Object.keys(DEFAULT_LIMITS)) && Object.entries(limits).every(([key, value]) =>
    Number.isSafeInteger(value) && value >= (key === 'maxRepairs' ? 0 : 1)) && limits.concurrency <= 2 && limits.maxRepairs <= 1, 'comparison_invalid_limits');
  const repeats = options.repeats ?? 1;
  check(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 100, 'comparison_invalid_limits');
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 16 * 1024 * 1024;
  check(Number.isSafeInteger(maxSnapshotBytes) && maxSnapshotBytes > 0 && maxSnapshotBytes <= 64 * 1024 * 1024, 'comparison_invalid_limits');
  const manifest = {
    version: PRODUCTION_COMPARISON_VERSION, scope: 'production-pipeline-comparison', mode: 'plan-and-snapshot-evaluation',
    historicalSimulation: 'Separate abstract-stage-simulation A-E; never relabel or pool those results.',
    implementationHash: hashInput(readFileSync(new URL(import.meta.url), 'utf8')),
    freeze: frozen, freezeHashes: Object.fromEntries(Object.entries(frozen).map(([key, value]) => [key, hashInput(value)])),
    arms: PRODUCTION_ARMS, stages: PRODUCTION_STAGES, limits, repeats, snapshotLimits: { maxBytes: maxSnapshotBytes },
    scenarios: scenarios.map((item) => ({ id: item.id, taskId: item.taskId, split: item.split, domain: item.domain, evidenceKind: item.evidenceKind, hash: hashInput(item) })),
    repairPolicy: 'At most one public typed-contract counterexample for D/E. Never expected rows, snapshots or oracle feedback. No holdout prompt tuning.',
  };
  const jobs = scenarios.length * 5 * repeats;
  const theoreticalMaxCalls = jobs * 2 * (1 + limits.maxRepairs);
  return freeze({ manifest, scenarios, fingerprint: hashInput(manifest),
    budget: { jobs, theoreticalMaxCalls, enforcedMaxCalls: Math.min(theoreticalMaxCalls, limits.maxCalls),
      reservedTokenUpperBound: Math.min(limits.maxTotalTokens, Math.min(theoreticalMaxCalls, limits.maxCalls) * (limits.maxInputTokens + limits.maxOutputTokens)),
      callsExecutedByThisTool: 0, costUsd: null, status: 'plan-only; caller must enforce admission before any live call' } });
}

export function evaluateProductionScenario(expected, capture, { knowledgeAvailable = true } = {}) {
  const empty = { transportCompleted: false, contractValid: false, unresolved: false, semanticCorrect: null,
    executionCorrect: null, exact: false, correctAbstention: false, falseAcceptance: false, failed: true, checks: {} };
  if (!capture) return { ...empty, failure: 'missing_capture' };
  const stages = capture.stages || {};
  if (!plain(stages) || Object.entries(stages).some(([stage, value]) => !PRODUCTION_STAGES.includes(stage) || !validStage(value))) {
    return { ...empty, failure: 'invalid_stage_contract' };
  }
  const supplied = PRODUCTION_STAGES.filter((stage) => stages[stage]);
  const terminalIndex = PRODUCTION_STAGES.findIndex((stage) => stages[stage]?.status === 'unresolved');
  const required = terminalIndex < 0 ? PRODUCTION_STAGES : PRODUCTION_STAGES.slice(0, terminalIndex + 1);
  const transportCompleted = ['intent', 'binding'].filter((stage) => required.includes(stage))
    .every((stage) => stages[stage]?.transportCompleted === true);
  const contractValid = required.every((stage) => stages[stage]?.contractValid === true);
  const failed = !transportCompleted || !contractValid || required.some((stage) => !stages[stage] || !stages[stage].transportCompleted || stages[stage].status === 'failed')
    || (terminalIndex >= 0 && supplied.length !== required.length);
  if (failed) return { ...empty, transportCompleted, contractValid, failure: 'failed_or_incomplete_stage' };
  const unresolved = terminalIndex >= 0;
  if (unresolved) return { ...empty, transportCompleted, contractValid, failed: false, unresolved: true,
    correctAbstention: expected.outcome === 'unresolved' || !knowledgeAvailable, failure: null };
  const valid = validateProductionSnapshot(capture.snapshot);
  if (!valid) return { ...empty, transportCompleted, contractValid: false, failure: 'invalid_snapshot' };
  const checks = Object.fromEntries(FIELDS.map((field) => [field,
    expected.outcome === 'accepted' && same(multiset(expected.snapshot[field]), multiset(capture.snapshot[field]))]));
  const exact = knowledgeAvailable && Object.values(checks).every(Boolean);
  // Semantic correctness is measured against an independent executed snapshot, not transport acceptance.
  return { transportCompleted, contractValid, unresolved: false, semanticCorrect: exact, executionCorrect: exact,
    exact, correctAbstention: false, falseAcceptance: !exact, failed: false, checks, failure: null };
}

/** Ingest externally captured stages only. This module has no provider or network entrypoint. */
export function compareProductionSnapshots({ plan, captures = [], outputDir, resume = false, onEvent }) {
  check(plan.fingerprint === hashInput(plan.manifest), 'comparison_freeze_mismatch');
  check(same(plan.scenarios.map((item) => hashInput(item)), plan.manifest.scenarios.map((item) => item.hash)), 'comparison_freeze_mismatch');
  check(Array.isArray(captures), 'comparison_invalid_capture');
  const store = checkpointStore(outputDir, resume, plan.manifest, plan.fingerprint, onEvent);
  const captured = new Map();
  for (const record of store.records) {
    check(record.type === 'production_stage' || record.type === 'production_snapshot', 'comparison_invalid_checkpoint');
    const previous = captured.get(record.key) || { stages: {} };
    if (record.type === 'production_stage') previous.stages[record.stage] = record.value;
    else previous.snapshot = record.value;
    captured.set(record.key, previous);
  }
  for (const capture of captures) {
    check(capture.fingerprint === plan.fingerprint && Object.hasOwn(PRODUCTION_ARMS, capture.arm)
      && plan.scenarios.some((item) => item.id === capture.caseId) && Number.isSafeInteger(capture.repeat)
      && capture.repeat >= 0 && capture.repeat < plan.manifest.repeats && plain(capture.stages), 'comparison_invalid_capture');
    check(Object.keys(capture.stages).every((stage) => PRODUCTION_STAGES.includes(stage)), 'comparison_invalid_capture');
    const key = stableJson([capture.caseId, capture.arm, capture.repeat]);
    const previous = captured.get(key) || { stages: {} };
    for (const [stage, value] of Object.entries(capture.stages)) {
      check(validStage(value), 'comparison_invalid_capture');
      if (previous.stages[stage]) check(same(previous.stages[stage], value), 'comparison_checkpoint_conflict');
      else {
        store.append({ type: 'production_stage', key, stage, value: clone(value) });
        previous.stages[stage] = clone(value);
      }
    }
    if (capture.snapshot !== undefined) {
      check(Buffer.byteLength(stableJson(capture.snapshot)) <= plan.manifest.snapshotLimits.maxBytes, 'comparison_snapshot_limit');
      if (previous.snapshot !== undefined) check(same(previous.snapshot, capture.snapshot), 'comparison_checkpoint_conflict');
      else { store.append({ type: 'production_snapshot', key, value: clone(capture.snapshot) }); previous.snapshot = clone(capture.snapshot); }
    }
    captured.set(key, previous);
  }
  const results = plan.scenarios.flatMap((item) => Object.keys(PRODUCTION_ARMS).flatMap((arm) =>
    Array.from({ length: plan.manifest.repeats }, (_, repeat) => ({ caseId: item.id, domain: item.domain, split: item.split, evidenceKind: item.evidenceKind, arm, repeat,
      knowledgeAvailability: item.expected.knowledgeRequired && !PRODUCTION_ARMS[arm].typedContext ? 'unavailable' : 'available',
      evaluation: evaluateProductionScenario(item.expected, captured.get(stableJson([item.id, arm, repeat])),
        { knowledgeAvailable: !item.expected.knowledgeRequired || PRODUCTION_ARMS[arm].typedContext }) }))));
  for (const result of results) {
    result.pass = result.evaluation.exact;
    result.status = result.evaluation.failed ? 'failed' : result.evaluation.unresolved ? 'unresolved' : result.pass ? 'passed' : 'mismatch';
  }
  const populations = [...new Set(plan.scenarios.map((item) => item.evidenceKind))];
  const metrics = populations.flatMap((evidenceKind) => Object.keys(PRODUCTION_ARMS).flatMap((arm) => ['development', 'holdout'].map((split) => {
    const subset = results.filter((result) => result.arm === arm && result.split === split && result.evidenceKind === evidenceKind);
    const count = (field) => subset.filter((result) => result.evaluation[field]).length;
    const total = subset.length;
    const evaluated = total - count('failed');
    return { arm, split, evidenceKind, total, evaluated, failures: count('failed'), exact: count('exact'), success: count('exact'),
      successRate: total ? count('exact') / total : null,
      exactRate: total ? count('exact') / total : null, exactPerEvaluated: evaluated ? count('exact') / evaluated : null,
      transportCompleted: count('transportCompleted'), contractValid: count('contractValid'), unresolved: count('unresolved'),
      correctAbstention: count('correctAbstention'), falseAcceptance: count('falseAcceptance') };
  })));
  const report = { version: PRODUCTION_COMPARISON_VERSION, scope: plan.manifest.scope, fingerprint: plan.fingerprint,
    evidence: 'externally-supplied-snapshots', modelQualityClaim: 'none; requires trusted production captures, not synthetic fixtures or historical simulations',
    primaryMetric: 'exact/total (including missing captures and failures)', diagnosticMetric: 'exact/evaluated',
    results, metrics, productionMetrics: metrics.filter((metric) => metric.evidenceKind === 'production'), budget: plan.budget };
  store.results(report);
  return report;
}

const card = (className, key) => ({ className, id: key });
const placement = (key, className, cardId, structureItemId = 'items', cardSourceId = 'current') => ({ id: key, structureItemId, card: card(className, cardId), cardSourceId });
const snapshot = (rows, placements, hierarchy = [], edges = [], labels = []) => ({
  rows, displayedCards: placements.filter((p) => p.card !== null).map((p) => p.card), placements, hierarchy, edges, labels,
});
function scenario(split, domain, name, request, data, result, schema = {}, referenceHelp = '') {
  return { id: `${split}-${name}`, taskId: `${domain}-${name}`, split, domain, evidenceKind: 'synthetic',
    input: { request, schema, data, explicitBindings: { rowGrain: schema.rowGrain || 'card', identity: schema.identity || 'record' },
      typedContext: { help: referenceHelp || schema.help || 'Use only catalog-proven fields and reference paths; abstain on absent candidates.' } },
    expected: { outcome: result === null ? 'unresolved' : 'accepted', snapshot: result, knowledgeRequired: Boolean(referenceHelp) } };
}

// Independent synthetic development/holdout tasks. Expected rows are evaluator-private.
export const productionComparisonScenarios = freeze([
  scenario('development', 'geography', 'building-ancestors', 'Show buildings under their street and city; labels use each card Description.',
    { cities: [{ id: 'c1', Description: 'North' }], streets: [{ id: 's1', city: 'c1', Description: 'Main' }], buildings: [{ id: 'b1', street: 's1', Description: 'Depot' }] },
    snapshot([{ building: 'b1' }], [placement('city', 'City', 'c1', 'cities'), placement('street', 'Street', 's1', 'streets'), placement('building', 'Building', 'b1')],
      [{ parent: 'city', child: 'street' }, { parent: 'street', child: 'building' }], [], [{ targetId: 'city', text: 'North' }, { targetId: 'street', text: 'Main' }, { targetId: 'building', text: 'Depot' }]),
    { help: 'Building.street references Street; Street.city references City; Description belongs to the referenced card.' }),
  scenario('holdout', 'facilities', 'campus-room-ancestors', 'Show rooms under their wing and campus, not under the billing campus.',
    { rooms: [{ id: 'r7', wing: 'w7', billingCampus: 'c8' }], wings: [{ id: 'w7', campus: 'c7' }], campuses: [{ id: 'c7' }, { id: 'c8' }] },
    snapshot([{ room: 'r7' }], [placement('campus', 'Campus', 'c7', 'campuses'), placement('wing', 'Wing', 'w7', 'wings'), placement('room', 'Room', 'r7')],
      [{ parent: 'campus', child: 'wing' }, { parent: 'wing', child: 'room' }]), { help: 'Room.wing is physical placement; billingCampus is administrative only.' }),
  scenario('development', 'compute', 'reference-choice', 'Show devices in their physical room, not their owner room.',
    { devices: [{ id: 'd1', rA: 'r1', rB: 'r2' }], rooms: [{ id: 'r1' }, { id: 'r2' }] },
    snapshot([{ device: 'd1', room: 'r1' }], [placement('room', 'Room', 'r1', 'rooms'), placement('device', 'Device', 'd1')], [{ parent: 'room', child: 'device' }]),
    { help: 'Device.rA and Device.rB are references to Room; names alone do not establish their business meaning.' },
    'Device.rA is physical placement; Device.rB is the administrative owner room. No inferred inverse path.'),
  scenario('holdout', 'library', 'reference-choice', 'Show editions at the holding branch, not the purchasing branch.',
    { editions: [{ id: 'e9', refX: 'b8', refY: 'b9' }], branches: [{ id: 'b8' }, { id: 'b9' }] },
    snapshot([{ edition: 'e9', branch: 'b9' }], [placement('branch', 'Branch', 'b9', 'branches'), placement('edition', 'Edition', 'e9')], [{ parent: 'branch', child: 'edition' }]),
    { help: 'Edition.refX and Edition.refY reference Branch; opaque names do not prove holding semantics.' },
    'Edition.refY is the holding branch; Edition.refX is the purchasing branch. These are independent references.'),
  scenario('development', 'warehouse', 'pairs-copies', 'One row per bin/item pair; show the same item once in each bin.',
    { pairs: [{ bin: 'b1', item: 'i1' }, { bin: 'b2', item: 'i1' }] },
    snapshot([{ bin: 'b1', item: 'i1' }, { bin: 'b2', item: 'i1' }], [placement('bin1', 'Bin', 'b1', 'bins'), placement('bin2', 'Bin', 'b2', 'bins'), placement('i1@b1', 'Item', 'i1'), placement('i1@b2', 'Item', 'i1')],
      [{ parent: 'bin1', child: 'i1@b1' }, { parent: 'bin2', child: 'i1@b2' }]), { rowGrain: 'pair', identity: 'copy' }),
  scenario('holdout', 'training', 'pairs-copies', 'Display a tutor in each assigned cohort; preserve assignment rows.',
    { pairs: [{ cohort: 'g8', tutor: 't7' }, { cohort: 'g9', tutor: 't7' }] },
    snapshot([{ cohort: 'g8', tutor: 't7' }, { cohort: 'g9', tutor: 't7' }], [placement('g8', 'Cohort', 'g8', 'cohorts'), placement('g9', 'Cohort', 'g9', 'cohorts'), placement('t7@g8', 'Tutor', 't7'), placement('t7@g9', 'Tutor', 't7')],
      [{ parent: 'g8', child: 't7@g8' }, { parent: 'g9', child: 't7@g9' }]), { rowGrain: 'pair', identity: 'copy' }),
  scenario('development', 'assets', 'boolean-null', 'Select active=true AND (owner is null OR spare=true). Null is not false.',
    { rows: [{ id: 'a1', active: true, owner: null, spare: false }, { id: 'a2', active: false, owner: null, spare: true }, { id: 'a3', active: true, owner: 'u1', spare: false }] },
    snapshot([{ id: 'a1' }], [placement('a1', 'Asset', 'a1')])),
  scenario('holdout', 'procurement', 'boolean-null', 'Select approved=true AND (supplier is null OR emergency=true). Preserve grouping.',
    { rows: [{ id: 'o7', approved: true, supplier: 's7', emergency: true }, { id: 'o8', approved: false, supplier: null, emergency: true }, { id: 'o9', approved: true, supplier: 's7', emergency: false }] },
    snapshot([{ id: 'o7' }], [placement('o7', 'Order', 'o7')])),
  scenario('development', 'network-policy', 'ipv4-parallel', 'Keep candidates with either endpoint in 10.1.0.0/24. Draw only edges with both displayed endpoints; keep parallel edges and direction.',
    { nodes: [{ id: 'n1', ip: '10.1.0.1' }, { id: 'n2', ip: '10.1.0.2' }], links: [{ id: 'l1', from: '10.1.0.1', to: '10.1.0.2', label: 'HTTPS' }, { id: 'l2', from: '10.1.0.1', to: '10.1.0.2', label: 'SSH' }, { id: 'l3', from: '10.1.0.1', to: '10.2.0.1', label: 'outside' }] },
    snapshot([{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }], [placement('n1', 'Endpoint', 'n1'), placement('n2', 'Endpoint', 'n2')], [],
      [{ id: 'l1', from: 'n1', to: 'n2', direction: 'forward', label: 'HTTPS' }, { id: 'l2', from: 'n1', to: 'n2', direction: 'forward', label: 'SSH' }])),
  scenario('holdout', 'telemetry', 'ipv4-boundary', 'Select source OR destination in 192.0.2.0/25. Draw directed edges only when both endpoints are displayed; preserve the boundary address.',
    { nodes: [{ id: 'x7', ip: '192.0.2.0' }, { id: 'x8', ip: '192.0.2.127' }], links: [{ id: 'f7', from: '192.0.2.127', to: '192.0.2.0', label: 'flow' }, { id: 'f8', from: '192.0.2.128', to: '192.0.2.129' }] },
    snapshot([{ id: 'f7' }], [placement('x7', 'Probe', 'x7'), placement('x8', 'Probe', 'x8')], [], [{ id: 'f7', from: 'x8', to: 'x7', direction: 'forward', label: 'flow' }])),
  scenario('development', 'transit', 'missing-candidate', 'Map vehicles to a certified route result. Catalog has no compatible route path; report unresolved.',
    { candidates: [], vehicles: [{ id: 'v1' }] }, null),
  scenario('holdout', 'accounting', 'missing-candidate', 'Map invoices to a verified cost-center result. Available payment references do not establish cost centers.',
    { candidates: [{ id: 'payment', className: 'Payment' }], invoices: [{ id: 'inv9' }] }, null),
]);

/** Files are explicit trusted local inputs; their contents, not paths alone, enter the freeze. */
export function loadProductionComparisonPlan(file) {
  const directory = dirname(resolve(file));
  const read = (path) => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
  const options = JSON.parse(readFileSync(resolve(file), 'utf8'));
  if (options.scenariosPath) options.scenarios = read(options.scenariosPath);
  if (options.scenarios) options.scenarios = options.scenarios.map(({ inputPath, expectedPath, ...item }) => ({
    ...item, ...(inputPath ? { input: read(inputPath) } : {}), ...(expectedPath ? { expected: read(expectedPath) } : {}),
  }));
  return createProductionComparisonPlan(options);
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { plan: { type: 'string' }, captures: { type: 'string' },
    'output-dir': { type: 'string' }, resume: { type: 'boolean', default: false } } });
  check(values.plan, 'comparison_plan_required');
  const plan = loadProductionComparisonPlan(values.plan);
  const report = values.captures ? compareProductionSnapshots({ plan,
    captures: JSON.parse(readFileSync(values.captures, 'utf8')), outputDir: values['output-dir'], resume: values.resume })
    : { scope: plan.manifest.scope, fingerprint: plan.fingerprint, manifest: plan.manifest, budget: plan.budget };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch { process.stderr.write('{"error":"comparison_failed"}\n'); process.exitCode = 1; }
}
