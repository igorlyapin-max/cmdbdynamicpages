import { stableJson } from './assistant-quality-lab.mjs';

const STAGES = {
  flow: ['flow', 'rows'],
  mapping: ['mapping', 'graph'],
  'end-to-end': ['flow', 'rows', 'mapping', 'graph'],
};
const GRAPH_FIELDS = ['placements', 'hierarchy', 'edges', 'labels']; // Card identity is part of each placement.
const FIELDS = ['rows', ...GRAPH_FIELDS];
const TELEMETRY_FIELDS = ['durationMs', 'requests', 'modelRequests', 'calls', 'inputTokens', 'outputTokens', 'repairs'];
const rate = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
export const isPilotBudgetLimit = (code) => code === 'pilot_model_request_budget' || code === 'pilot_attempt_request_budget';

function counts(expected, actual, matched) {
  return { expected, actual, matched, precision: rate(matched, actual), recall: rate(matched, expected) };
}

function compareMultisets(expected, actual) {
  const remaining = new Map();
  for (const item of expected) {
    const key = stableJson(item);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let matched = 0;
  for (const item of actual) {
    const key = stableJson(item);
    const count = remaining.get(key) ?? 0;
    if (count === 0) continue;
    matched++;
    remaining.set(key, count - 1);
  }
  return counts(expected.length, actual.length, matched);
}

function compareField(expected, actual) {
  return Array.isArray(expected) && Array.isArray(actual) ? compareMultisets(expected, actual) : null;
}

const allMatched = (metric) => metric !== null && metric.expected === metric.matched && metric.actual === metric.matched;

function observedTelemetry(telemetry) {
  return Object.fromEntries(TELEMETRY_FIELDS.map((field) => {
    const value = telemetry?.[field];
    const valid = field === 'durationMs' ? Number.isFinite(value) : Number.isSafeInteger(value);
    return [field, valid && value >= 0 ? value : null];
  }));
}

/** oracle.blockIds may be omitted when all expected terminal blocks emit rows. */
export function scorePilotAttempt({ mode, oracle, capture }) {
  if (!Object.hasOwn(STAGES, mode)) throw new TypeError('pilot_invalid_mode');
  const required = STAGES[mode];
  const metrics = {
    rows: required.includes('rows') ? compareField(oracle.rows, capture?.rows) : null,
    ...Object.fromEntries(GRAPH_FIELDS.map((field) => [field,
      required.includes('graph') ? compareField(oracle.graph?.[field], capture?.graph?.[field]) : null])),
  };
  const hasFailure = capture?.failure != null;
  const blocksMatch = !required.includes('rows') || oracle.blockIds === undefined ||
    allMatched(compareField(oracle.blockIds, capture?.blockIds));
  const completeStages = required.every((stage) => capture?.stages?.[stage]?.status === 'accepted');
  const unresolvedAt = required.findIndex((stage) => capture?.stages?.[stage]?.status === 'unresolved');
  const unresolvedStage = required[unresolvedAt];
  const expectedStage = typeof oracle.expectedStage === 'string' ? oracle.expectedStage : oracle.expectedStage?.[mode];
  const validUnresolved = Boolean(!hasFailure && unresolvedAt >= 0 &&
    ['flow', 'mapping'].includes(unresolvedStage) &&
    required.slice(0, unresolvedAt).every((stage) => capture.stages?.[stage]?.status === 'accepted') &&
    required.slice(unresolvedAt + 1).every((stage) => !Object.hasOwn(capture.stages, stage)));
  const correctAbstention = validUnresolved && oracle.outcome === 'unresolved' && unresolvedStage === expectedStage &&
    (!required.slice(0, unresolvedAt).includes('rows') || blocksMatch && allMatched(metrics.rows));
  const requiredMetrics = FIELDS.filter((field) => required.includes(field === 'rows' ? 'rows' : 'graph'));
  const snapshotsPresent = requiredMetrics.every((field) => Array.isArray(field === 'rows' ? capture?.rows : capture?.graph?.[field]));
  const complete = capture?.complete === true && !hasFailure && completeStages && blocksMatch && snapshotsPresent &&
    (oracle.outcome === 'unresolved' || requiredMetrics.every((field) => metrics[field] !== null));
  const exact = complete && oracle.outcome !== 'unresolved' && requiredMetrics.every((field) => allMatched(metrics[field]));
  const failure = !capture ? 'missing_capture' : capture.failure ??
    (validUnresolved && oracle.outcome === 'unresolved' && !correctAbstention ? 'pilot_unresolved_oracle_mismatch'
      : complete || validUnresolved ? null : !blocksMatch ? 'incomplete_block_manifest' : 'incomplete_capture');
  const budgetSkipped = isPilotBudgetLimit(failure);
  return { exact, complete, validUnresolved, correctAbstention,
    falseAcceptance: complete && !exact, failed: failure !== null && !budgetSkipped, failure, budgetSkipped, metrics,
    telemetry: observedTelemetry(capture?.telemetry) };
}

function summarizeGroup(attempts) {
  const total = attempts.length;
  const evaluated = attempts.filter((attempt) => !attempt.budgetSkipped);
  const budgetSkipped = total - evaluated.length;
  const count = (field) => attempts.filter((attempt) => attempt[field]).length;
  const exact = count('exact');
  const metrics = Object.fromEntries(FIELDS.map((field) => {
    const scored = evaluated.map((attempt) => attempt.metrics[field]).filter((metric) => metric !== null);
    const sum = (key) => scored.reduce((acc, metric) => acc + metric[key], 0);
    return [field, scored.length ? { scored: scored.length, ...counts(sum('expected'), sum('actual'), sum('matched')) } : null];
  }));
  const telemetry = Object.fromEntries(TELEMETRY_FIELDS.map((field) => {
    const values = attempts.map((attempt) => attempt.telemetry[field]).filter((value) => value !== null);
    const sum = values.reduce((acc, value) => acc + value, 0);
    return [field, { known: values.length, total: total > 0 && values.length === total ? sum : null,
      mean: rate(sum, values.length) }];
  }));
  return { total, evaluated: evaluated.length, budgetSkipped, exact, exactRate: rate(exact, evaluated.length),
    failures: count('failed'), complete: count('complete'),
    validUnresolved: count('validUnresolved'), correctAbstentions: count('correctAbstention'),
    falseAcceptances: count('falseAcceptance'), metrics, telemetry };
}

export function summarizePilotAttempts(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    const { scenarioId, variant, mode } = attempt;
    const key = stableJson([scenarioId, variant, mode]);
    if (!groups.has(key)) groups.set(key, { scenarioId, variant, mode, attempts: [] });
    groups.get(key).attempts.push(attempt);
  }
  const summaries = [...groups.values()].map(({ attempts: subset, ...key }) => ({ ...key, ...summarizeGroup(subset) }));
  const comparisons = [];
  for (const [baseline, candidate] of [['A', 'B'], ['B', 'C'], ['B-prompt-only', 'B'], ['B-knowledge-only', 'B']]) {
    for (const after of summaries.filter((item) => item.variant === candidate)) {
      const before = summaries.find((item) => item.scenarioId === after.scenarioId && item.mode === after.mode && item.variant === baseline);
      if (!before) continue;
      const pair = { scenarioId: after.scenarioId, mode: after.mode, baseline, candidate };
      if (before.budgetSkipped || after.budgetSkipped) {
        comparisons.push({ ...pair, status: 'incomplete', reason: 'request_budget',
          budgetSkipped: { baseline: before.budgetSkipped, candidate: after.budgetSkipped } });
        continue;
      }
      comparisons.push({ ...pair, status: 'complete',
        exactRateDelta: after.exactRate - before.exactRate, falseAcceptanceDelta: after.falseAcceptances - before.falseAcceptances,
        failureDelta: after.failures - before.failures, correctAbstentionDelta: after.correctAbstentions - before.correctAbstentions });
    }
  }
  return { overall: summarizeGroup(attempts), groups: summaries, comparisons };
}
