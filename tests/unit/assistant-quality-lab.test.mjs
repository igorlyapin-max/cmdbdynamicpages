import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assistantQualityCases as cases } from '../fixtures/assistant-quality-cases.mjs';
import {
  VARIANTS, DEFAULT_LIMITS, buildRequest, compileDecision, evaluateResult, hashInput,
  offlineComplete, permuteCandidates, publicCounterexample, runExperiment, validateStageResponse,
} from '../../scripts/assistant-quality-lab.mjs';

const clone = (value) => structuredClone(value);
const accepted = (result) => ({ status: 'accepted', result });
const byId = (id) => cases.find((item) => item.id === id);
const options = (extra = {}) => ({
  cases: [cases[0]], variants: ['A'], mode: 'live', model: 'mock-model', modelRevision: 'mock-v1', ...extra,
});
// The test double uses explicit private fixtures; the runner must never pass them.
function fixtureComplete(request) {
  const item = byId(request.metadata.caseId);
  const value = request.metadata.stage === 'binding'
    ? { status: 'accepted', candidateId: item.oracle.candidateId }
    : accepted(item.oracle.result);
  return Promise.resolve({ content: JSON.stringify(value), usage: { inputTokens: 10, outputTokens: 20 } });
}
const directory = () => mkdtempSync(join(tmpdir(), 'assistant-quality-lab-'));

test('model-call latency and token metrics remain separate from browser elapsed time', async () => {
  const report = await runExperiment(options({ complete: fixtureComplete }));
  const metrics = report.metrics.find((group) => group.split === 'development');
  assert.equal(metrics.modelCalls, 2);
  assert.deepEqual(metrics.measuredUsage, { inputTokens: 20, outputTokens: 40 });
  assert.ok(metrics.callLatencyMs.p95 >= metrics.callLatencyMs.p50);
  assert.ok(metrics.callLatencyMs.sum >= 0);
  assert.equal(report.metrics.find((group) => group.split === 'holdout').callLatencyMs.p50, null);
});

test('12 immutable synthetic scenarios, six development/six holdout, handwritten oracle execution', () => {
  assert.equal(cases.length, 12);
  assert.equal(cases.filter((item) => item.split === 'development').length, 6);
  assert.equal(cases.filter((item) => item.split === 'holdout').length, 6);
  for (const item of cases) {
    assert.equal(item.synthetic, true);
    assert.equal(Object.isFrozen(item.input.candidates), true);
    const output = compileDecision(item.input, item.oracle.candidateId);
    assert.equal(evaluateResult(item.oracle.result, accepted(output)).exact, true, item.id);
  }
  assert.deepEqual(compileDecision(cases[0].input, cases[0].oracle.candidateId).rows, ['p1']);
  assert.deepEqual(compileDecision(cases[1].input, cases[1].oracle.candidateId).rows, ['s1', 's2']);
  assert.deepEqual(byId('holdout-empty-intersection').oracle.result.rows, []);
});

test('every distractor changes the result, and opaque IDs/order never reveal the answer', () => {
  for (const item of cases) {
    assert.ok(item.input.candidates.every((candidate) => /^c-[a-f0-9]{16}$/.test(candidate.id)));
    for (const candidate of item.input.candidates) {
      if (candidate.id !== item.oracle.candidateId) {
        assert.equal(evaluateResult(item.oracle.result, accepted(compileDecision(item.input, candidate.id))).exact, false, `${item.id}:${candidate.id}`);
      }
    }
    const permutations = Array.from({ length: 3 }, (_, repeat) => permuteCandidates(item.input, 'test-seed', item.id, repeat));
    assert.equal(new Set(permutations.map((input) => input.candidates[0].id)).size, 3);
    assert.deepEqual(permutations[1], permuteCandidates(item.input, 'test-seed', item.id, 1));
    for (const input of permutations) {
      for (const variant of Object.keys(VARIANTS)) {
        const request = JSON.stringify(buildRequest({ input, variant, stage: 'binding' }));
        assert.doesNotMatch(request, /p-good|p-wrong|p-leak|p-flat|oracle|expected|knowledgeRequired/);
      }
    }
  }
});

test('C alone receives opaque reference Help; other arms cannot count lucky guesses as acceptance', async () => {
  const item = byId('dev-reference-choice');
  for (const variant of Object.keys(VARIANTS)) {
    const request = buildRequest({ input: item.input, variant, stage: 'binding' });
    const payload = JSON.parse(request[1].content);
    assert.equal('schemaKnowledge' in payload, variant === 'C');
    assert.equal('schemaKnowledge' in payload.input, false);
    assert.match(JSON.stringify(payload.input.rows), /rA.*rB/);
    assert.equal(JSON.stringify(payload).includes('rA is the physical room'), variant === 'C');
  }
  const report = await runExperiment(options({ cases: [item], variants: ['A', 'C'], complete: fixtureComplete }));
  const a = report.results.find((result) => result.variant === 'A');
  const c = report.results.find((result) => result.variant === 'C');
  assert.equal(a.knowledgeAvailability, 'unavailable');
  assert.equal(a.evaluation.falseAcceptance, true);
  assert.equal(a.evaluation.exact, false);
  assert.equal(c.evaluation.exact, true);
  assert.match(report.hypotheses.find((hypothesis) => hypothesis.variant === 'C').label, /not equal-input/);
});

test('multisets, hierarchy tuples, edge IDs/endpoints/direction and occurrence identity are compared', () => {
  const copy = byId('dev-dynamic-copies').oracle.result;
  const mutations = [
    (value) => value.rows.pop(),
    (value) => { value.rows[0] = 'q2'; },
    (value) => { value.hierarchy[0].reverse(); },
    (value) => { value.identities[0].id = 'q1'; },
    (value) => value.hierarchy.push(value.hierarchy[0]),
  ];
  for (const mutate of mutations) {
    const changed = clone(copy); mutate(changed);
    assert.equal(evaluateResult(copy, accepted(changed)).falseAcceptance, true);
  }
  const links = byId('holdout-parallel-edges').oracle.result;
  for (const field of ['id', 'from', 'to', 'direction']) {
    const changed = clone(links); changed.edges[0][field] = 'different';
    assert.equal(evaluateResult(links, accepted(changed)).falseAcceptance, true, field);
  }
  const reordered = clone(copy);
  for (const values of Object.values(reordered)) values.reverse();
  assert.equal(evaluateResult(copy, accepted(reordered)).exact, true);
  assert.equal(evaluateResult(copy, { status: 'unresolved', result: null }).unresolved, true);
  assert.equal(evaluateResult(copy, { status: 'unresolved', result: null }).falseAcceptance, false);
});

test('strict response contracts reject fenced JSON, unknown keys/IDs and non-JSON', () => {
  const item = cases[0];
  const value = { status: 'accepted', candidateId: item.oracle.candidateId };
  for (const content of ['```json\n{}\n```', 'not JSON', '{}', 'null', '[]',
    JSON.stringify({ ...value, explanation: 'secret' }),
    JSON.stringify({ ...value, candidateId: 'p-good' }),
    JSON.stringify({ status: 'unresolved', candidateId: item.oracle.candidateId })]) {
    assert.throws(() => validateStageResponse(content, 'binding', item.input));
  }
  const changed = clone(item.oracle.result); changed.rows.push('unknown');
  assert.throws(() => validateStageResponse(JSON.stringify(accepted(changed)), 'materialize', item.input), /unknown_identity/);
  assert.deepEqual(validateStageResponse(JSON.stringify(value), 'binding', item.input), value);
});

test('dry-run exposes bounded calls/context budgets without invoking supplied complete', async () => {
  const report = await runExperiment({ mode: 'dry-run', repeats: 3, complete: () => assert.fail('network'), model: 'frozen-model', modelRevision: 'r1' });
  assert.equal(report.plan.jobs, 180);
  assert.equal(report.plan.baseCalls, 324);
  assert.equal(report.plan.theoreticalMaxCalls, 648);
  assert.equal(report.plan.enforcedMaxCalls, 360);
  assert.equal(report.plan.limits.maxOutputTokens, 2400);
  assert.equal(report.budget.calls, 0);
  assert.equal(report.plan.contextBudget.requests.length, 180);
  assert.ok(report.hypotheses.every((hypothesis) => hypothesis.stagePilot === 'unavailable'));
});

test('offline all variants/repeats use no network and never claim a tested model hypothesis', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('network forbidden');
  try {
    const report = await runExperiment({ mode: 'offline', repeats: 3 });
    assert.equal(report.results.length, 180);
    assert.ok(report.budget.calls <= 360);
    assert.equal(report.metrics.length, 10);
    assert.equal(report.budget.costUsd, null);
    assert.ok(report.hypotheses.every((hypothesis) => hypothesis.stagePilot === 'unavailable' && hypothesis.productionPipeline === 'unavailable'));
    assert.match(report.warning, /not full production/);
  } finally { globalThis.fetch = original; }
});

test('model sees no oracle, E compiles fixed decisions and cannot repair a semantic error using oracle', async () => {
  const item = cases[0];
  const wrong = item.input.candidates.find((candidate) => candidate.id !== item.oracle.candidateId);
  let calls = 0;
  const report = await runExperiment(options({ variants: ['E'], complete: async (request) => {
    calls += 1;
    assert.equal(request.metadata.stage, 'binding');
    assert.doesNotMatch(JSON.stringify(request), /oracle|expected|p-good|p-wrong/);
    return { content: JSON.stringify({ status: 'accepted', candidateId: wrong.id }) };
  } }));
  assert.equal(calls, 1);
  assert.equal(report.results[0].evaluation.falseAcceptance, true);
});

test('E gets exactly one public-contract counterexample, never expected result', async () => {
  const item = byId('dev-dynamic-copies');
  const collapsed = item.input.candidates.find((candidate) => candidate.copiesFrom && candidate.identity === 'record');
  let calls = 0;
  const report = await runExperiment(options({ cases: [item], variants: ['E'], complete: async (request) => {
    const payload = JSON.parse(request.messages[1].content);
    calls += 1;
    if (calls === 2) assert.deepEqual(payload.feedback, { code: 'counterexample', field: 'identity', required: 'copy', selected: 'record' });
    assert.equal(Object.hasOwn(payload, 'oracle'), false);
    return { content: JSON.stringify({ status: 'accepted', candidateId: calls === 1 ? collapsed.id : item.oracle.candidateId }) };
  } }));
  assert.equal(calls, 2);
  assert.equal(report.results[0].repairs, 1);
  assert.equal(report.results[0].evaluation.exact, true);
  assert.equal(publicCounterexample(item.input, item.oracle.candidateId), null);
});

test('invalid JSON repair budget is at most one per stage, unresolved is not repaired', async () => {
  let calls = 0;
  const report = await runExperiment(options({ complete: async () => { calls += 1; return { content: '{' }; } }));
  assert.equal(calls, 2);
  assert.equal(report.results[0].code, 'invalid_json');
  assert.equal(report.results[0].evaluation.unresolved, false);
  assert.equal(report.results[0].evaluation.failed, true);
  let unresolvedCalls = 0;
  const unresolved = await runExperiment(options({ complete: async () => {
    unresolvedCalls += 1; return { content: '{"status":"unresolved","candidateId":null}' };
  } }));
  assert.equal(unresolvedCalls, 1);
  assert.equal(unresolved.results[0].code, 'model_unresolved');
  const both = await runExperiment(options({ complete: async (request) => request.metadata.attempt === 0
    ? { content: '{' } : fixtureComplete(request) }));
  assert.equal(both.budget.calls, 4);
  assert.equal(both.results[0].repairs, 2);
  assert.equal(both.results[0].evaluation.exact, true);
});

test('max concurrency two with strict call and token admission budgets', async () => {
  let active = 0; let maximum = 0;
  const complete = async (request) => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 3)); active -= 1;
    return fixtureComplete(request);
  };
  const report = await runExperiment(options({ cases: cases.slice(0, 3), complete, limits: { maxCalls: 3 } }));
  assert.equal(maximum, 2);
  assert.equal(report.budget.calls, 3);
  assert.ok(report.results.some((result) => result.code === 'call_limit'));
  const denied = await runExperiment(options({ complete: () => assert.fail('no budget'), limits: { maxTotalTokens: 1 } }));
  assert.equal(denied.budget.calls, 0);
  assert.equal(denied.results[0].code, 'token_limit');
  const context = await runExperiment(options({ complete: () => assert.fail('no context'), limits: { maxInputTokens: 1 } }));
  assert.equal(context.results[0].code, 'input_limit');
});

test('timeout aborts and opens circuit without starting more requests or retries', async () => {
  let calls = 0; let aborted = 0;
  const report = await runExperiment(options({ cases: cases.slice(0, 3), limits: { timeoutMs: 5 }, complete: ({ signal }) => {
    calls += 1;
    signal.addEventListener('abort', () => { aborted += 1; });
    return new Promise(() => {});
  } }));
  assert.equal(calls, 2);
  assert.equal(aborted, 2);
  assert.equal(report.budget.calls, 2);
  assert.ok(report.results.every((result) => ['timeout', 'circuit_open'].includes(result.code)));
});

test('bounded responses, model freeze and usage validation fail closed', async () => {
  const large = await runExperiment(options({ complete: async () => ({ content: 'x'.repeat(100) }), limits: { maxResponseBytes: 10 } }));
  assert.equal(large.results[0].code, 'response_limit');
  const mismatch = await runExperiment(options({ complete: async () => ({ model: 'other', content: '{}' }) }));
  assert.equal(mismatch.results[0].code, 'model_mismatch');
  assert.equal(mismatch.budget.calls, 1);
  const usage = await runExperiment(options({ complete: async () => ({ content: '{}', usage: { inputTokens: -1, outputTokens: 1 } }) }));
  assert.equal(usage.results[0].code, 'invalid_usage');
  const tokens = await runExperiment(options({ complete: async (request) => ({ ...await fixtureComplete(request), usage: { inputTokens: 10, outputTokens: 2401 } }) }));
  assert.equal(tokens.results[0].code, 'token_limit');
  assert.equal(tokens.budget.calls, 1);
});

test('supplied pricing only, missing usage means unknown cost rather than invented zero', async () => {
  const price = { inputUsdPerToken: 4e-7, outputUsdPerToken: 1.6e-6 };
  const report = await runExperiment(options({ complete: fixtureComplete, price }));
  assert.equal(report.budget.costUsd, 20 * price.inputUsdPerToken + 40 * price.outputUsdPerToken);
  assert.equal(report.budget.usageComplete, true);
  const unknown = await runExperiment(options({ complete: offlineComplete, price }));
  assert.equal(unknown.budget.costUsd, null);
  assert.equal(unknown.budget.costStatus, 'usage-unavailable');
  const noPrice = await runExperiment(options({ complete: fixtureComplete }));
  assert.equal(noPrice.budget.costUsd, null);
  assert.equal(noPrice.budget.costStatus, 'price-unavailable');
});

test('checkpoint resumes completed stages without calls, freezes data/model/seed and redacts errors', async () => {
  const outputDir = directory();
  const first = await runExperiment(options({ outputDir, complete: fixtureComplete }));
  const resumed = await runExperiment(options({ outputDir, resume: true, complete: () => assert.fail('replayed network') }));
  assert.deepEqual(resumed.results, first.results);
  assert.equal(resumed.budget.calls, 2);
  assert.equal(readFileSync(join(outputDir, 'events.jsonl'), 'utf8').trim().split('\n').length, 4);
  await assert.rejects(runExperiment(options({ outputDir, resume: true, modelRevision: 'changed', complete: fixtureComplete })), /checkpoint_mismatch/);
  await assert.rejects(runExperiment(options({ outputDir, resume: true, seed: 'changed', complete: fixtureComplete })), /checkpoint_mismatch/);
  const changed = clone(cases[0]); changed.input.request += ' Changed.';
  await assert.rejects(runExperiment(options({ cases: [changed], outputDir, resume: true, complete: fixtureComplete })), /checkpoint_mismatch/);
  const privateDirectory = directory();
  await runExperiment(options({ outputDir: privateDirectory, complete: () => { throw new Error('Bearer DO_NOT_SAVE_SECRET https://private.invalid/?key=DO_NOT_SAVE_SECRET'); } }));
  for (const file of ['manifest.json', 'events.jsonl', 'results.json']) {
    assert.doesNotMatch(readFileSync(join(privateDirectory, file), 'utf8'), /DO_NOT_SAVE_SECRET|private\.invalid|Bearer/);
  }
});

test('partial-stage checkpoint reuses binding; ambiguous in-flight calls never silently replay', async () => {
  const outputDir = directory();
  await runExperiment(options({ outputDir, complete: fixtureComplete }));
  const journal = join(outputDir, 'events.jsonl');
  const lines = readFileSync(journal, 'utf8').trim().split('\n');
  writeFileSync(journal, `${lines.slice(0, 2).join('\n')}\n`);
  let calls = 0;
  const resumed = await runExperiment(options({ outputDir, resume: true, complete: (request) => {
    calls += 1; assert.equal(request.metadata.stage, 'materialize'); return fixtureComplete(request);
  } }));
  assert.equal(calls, 1);
  assert.equal(resumed.results[0].evaluation.exact, true);
  writeFileSync(journal, `${lines[0]}\n`);
  const interrupted = await runExperiment(options({ outputDir, resume: true, complete: () => assert.fail('unsafe retry') }));
  assert.equal(interrupted.results[0].code, 'interrupted_call');
  assert.equal(interrupted.budget.calls, 1);
  writeFileSync(journal, lines[0].slice(0, -5));
  await assert.rejects(runExperiment(options({ outputDir, resume: true, complete: fixtureComplete })), /checkpoint_truncated/);
});

test('case/hash corruption and invalid limits rejected, canonical object key order does not change hash', async () => {
  assert.equal(hashInput({ b: 2, a: 1 }), hashInput({ a: 1, b: 2 }));
  for (const limits of [{ concurrency: 3 }, { maxRepairs: 2 }, { timeoutMs: 0 }, { maxCalls: 1.1 }, { invented: 5 }]) {
    await assert.rejects(runExperiment({ limits }), /invalid_contract/);
  }
  const item = clone(cases[0]); item.oracle.result.rows = [];
  await assert.rejects(runExperiment({ cases: [item] }), /invalid_contract/);
  assert.equal(DEFAULT_LIMITS.concurrency, 2);
});

test('CLI dry-run is runnable and does not load adapter or secrets', () => {
  const stdout = execFileSync(process.execPath, ['scripts/assistant-quality-lab.mjs', '--mode', 'dry-run',
    '--adapter', '/does/not/exist.mjs', '--repeats', '3', '--max-output-tokens', '2400'], { encoding: 'utf8' });
  const report = JSON.parse(stdout);
  assert.equal(report.plan.jobs, 180);
  assert.equal(report.budget.calls, 0);
  assert.equal(report.scope, 'abstract-stage-simulation');
});

test('providerModel audit stores bounded safe IDs and detects revision drift', async () => {
  const outputDir = directory();
  const complete = async (request) => ({ ...await fixtureComplete(request), providerModel: 'gpt-4.1-mini-2025-04-14' });
  const report = await runExperiment(options({ outputDir, complete }));
  assert.deepEqual(report.providerModels, ['gpt-4.1-mini-2025-04-14']);
  const events = readFileSync(join(outputDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.filter((event) => event.type === 'call_finished').every((event) => event.providerModel === 'gpt-4.1-mini-2025-04-14'));
  const drift = await runExperiment(options({ complete: async (request) => ({
    ...await fixtureComplete(request), providerModel: request.metadata.stage === 'binding' ? 'revision-one' : 'revision-two',
  }) }));
  assert.equal(drift.results[0].code, 'model_mismatch');
  assert.equal(drift.budget.calls, 2);
  for (const providerModel of ['x'.repeat(121), 'https://private.invalid/?key=DO_NOT_SAVE', 'model\nDO_NOT_SAVE', { secret: 'DO_NOT_SAVE' }]) {
    const rejected = await runExperiment(options({ complete: async (request) => ({ ...await fixtureComplete(request), providerModel }) }));
    assert.equal(rejected.results[0].code, 'invalid_provider_model');
    assert.deepEqual(rejected.providerModels, []);
    assert.doesNotMatch(JSON.stringify(rejected), /DO_NOT_SAVE/);
  }
});

test('full worst-case budget is configurable and temperature is frozen and passed through', async () => {
  const dry = await runExperiment({ mode: 'dry-run', repeats: 3, limits: { maxCalls: 648, maxTotalTokens: 11923200 } });
  assert.equal(dry.plan.enforcedMaxCalls, 648);
  assert.equal(dry.plan.reservedTokenUpperBound, 11923200);
  assert.equal(dry.manifest.temperature, 0.1);
  const outputDir = directory();
  await runExperiment(options({ outputDir, temperature: 0.1, complete: (request) => {
    assert.equal(request.temperature, 0.1); return fixtureComplete(request);
  } }));
  await assert.rejects(runExperiment(options({ outputDir, resume: true, temperature: 0.2, complete: fixtureComplete })), /checkpoint_mismatch/);
});

test('public request allowlist excludes unexpected oracle keys and accepts opaque-case abstention', async () => {
  const input = { ...cases[0].input, oracle: 'DO_NOT_PASS', expected: 'DO_NOT_PASS', password: 'DO_NOT_PASS' };
  assert.doesNotMatch(JSON.stringify(buildRequest({ input, variant: 'E', stage: 'binding' })), /DO_NOT_PASS/);
  const report = await runExperiment(options({ cases: [byId('dev-reference-choice')], complete: async () => ({
    content: '{"status":"unresolved","candidateId":null}',
  }) }));
  assert.equal(report.results[0].evaluation.correctAbstention, true);
  assert.equal(report.results[0].evaluation.falseAcceptance, false);
  assert.equal(report.metrics[0].correctAbstention, 1);
});

test('quality classification: transport errors on either stage are failures, never correct abstention', async (t) => {
  const item = byId('dev-reference-choice');
  for (const failedStage of ['binding', 'materialize']) {
    await t.test(failedStage, async () => {
      const report = await runExperiment(options({ cases: [item], repeats: 3, complete: async (request) => {
        if (request.metadata.stage === failedStage) throw Object.assign(new Error('sandbox network denied'), { code: 'EPERM' });
        return fixtureComplete(request);
      } }));
      const metric = report.metrics.find((entry) => entry.variant === 'A' && entry.split === 'development');
      assert.deepEqual({
        total: metric.total, failures: metric.failures, evaluated: metric.evaluated, unresolved: metric.unresolved,
        correctAbstention: metric.correctAbstention, falseAcceptance: metric.falseAcceptance, exactRate: metric.exactRate,
      }, { total: 3, failures: 3, evaluated: 0, unresolved: 0, correctAbstention: 0, falseAcceptance: 0, exactRate: null });
      for (const result of report.results) {
        assert.equal(result.status, 'failed');
        assert.equal(result.code, 'provider_error');
        assert.equal(result.evaluation.failed, true);
        assert.equal(result.evaluation.unresolved, false);
        assert.equal(result.evaluation.correctAbstention, false);
      }
      if (failedStage === 'binding') assert.equal(report.hypotheses[0].stagePilot, 'unavailable');
    });
  }
});

test('quality classification: valid model unresolved on either stage is the only correct abstention', async (t) => {
  const item = byId('dev-reference-choice');
  for (const unresolvedStage of ['binding', 'materialize']) {
    await t.test(unresolvedStage, async () => {
      const report = await runExperiment(options({ cases: [item], repeats: 3, complete: async (request) => {
        if (request.metadata.stage !== unresolvedStage) return fixtureComplete(request);
        const field = unresolvedStage === 'binding' ? 'candidateId' : 'result';
        return { content: JSON.stringify({ status: 'unresolved', [field]: null }) };
      } }));
      const metric = report.metrics.find((entry) => entry.variant === 'A' && entry.split === 'development');
      assert.deepEqual({
        total: metric.total, failures: metric.failures, unresolved: metric.unresolved, correctAbstention: metric.correctAbstention,
      }, { total: 3, failures: 0, unresolved: 3, correctAbstention: 3 });
      for (const result of report.results) {
        assert.equal(result.status, 'unresolved');
        assert.equal(result.code, 'model_unresolved');
        assert.equal(result.evaluation.failed, false);
        assert.equal(result.evaluation.unresolved, true);
        assert.equal(result.evaluation.correctAbstention, true);
      }
    });
  }
});

test('quality classification: malformed response, admission denial and timeout are not model refusal', async (t) => {
  const item = byId('dev-reference-choice');
  const scenarios = [
    { code: 'invalid_json', complete: async () => ({ content: '{' }) },
    { code: 'input_limit', limits: { maxInputTokens: 1 }, complete: () => assert.fail('no admission') },
    { code: 'token_limit', limits: { maxTotalTokens: 1 }, complete: () => assert.fail('no admission') },
    { code: 'timeout', limits: { timeoutMs: 5 }, complete: () => new Promise(() => {}) },
  ];
  for (const { code, ...scenario } of scenarios) {
    await t.test(code, async () => {
      const report = await runExperiment(options({ cases: [item], ...scenario }));
      const result = report.results[0];
      assert.equal(result.code, code);
      assert.deepEqual({
        failed: result.evaluation.failed, unresolved: result.evaluation.unresolved,
        correctAbstention: result.evaluation.correctAbstention, falseAcceptance: result.evaluation.falseAcceptance,
      }, { failed: true, unresolved: false, correctAbstention: false, falseAcceptance: false });
    });
  }
});

test('quality classification: mixed failures, valid unresolved and accepted guesses stay separate', async () => {
  const item = byId('dev-reference-choice');
  const report = await runExperiment(options({ cases: [item], repeats: 3, complete: async (request) => {
    if (request.metadata.repeat === 0) throw new Error('transport failed');
    if (request.metadata.repeat === 1) return { content: '{"status":"unresolved","candidateId":null}' };
    return fixtureComplete(request);
  } }));
  const metric = report.metrics.find((entry) => entry.variant === 'A' && entry.split === 'development');
  assert.deepEqual({
    total: metric.total, failures: metric.failures, unresolved: metric.unresolved,
    correctAbstention: metric.correctAbstention, falseAcceptance: metric.falseAcceptance,
  }, { total: 3, failures: 1, unresolved: 1, correctAbstention: 1, falseAcceptance: 1 });
});

test('quality classification: exact rate excludes failed jobs but reports their denominator', async () => {
  const report = await runExperiment(options({ repeats: 3, complete: async (request) => {
    if (request.metadata.repeat === 0) throw new Error('transport failed');
    return fixtureComplete(request);
  } }));
  const metric = report.metrics.find((entry) => entry.variant === 'A' && entry.split === 'development');
  assert.deepEqual({
    total: metric.total, failures: metric.failures, evaluated: metric.evaluated,
    exact: metric.exact, exactRate: metric.exactRate, unresolved: metric.unresolved,
  }, { total: 3, failures: 1, evaluated: 2, exact: 2, exactRate: 1, unresolved: 0 });
});
