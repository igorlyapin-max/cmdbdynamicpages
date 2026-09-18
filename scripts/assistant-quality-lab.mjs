#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assistantQualityCases } from '../tests/fixtures/assistant-quality-cases.mjs';

export const LAB_VERSION = '1';
export const VARIANTS = Object.freeze({
  A: 'Current-style candidate planning, abstract simulation (not production baseline)',
  B: 'Noncontradictory decomposed binding and result prompts',
  C: 'Targeted schema/domain knowledge availability manipulation (not equal-input generation)',
  D: 'Explicit business result binding obligations',
  E: 'Fixed decision compilation and one public-contract counterexample repair',
});
export const DEFAULT_LIMITS = Object.freeze({
  concurrency: 2, maxRepairs: 1, timeoutMs: 60000, maxCalls: 360,
  maxInputTokens: 16000, maxOutputTokens: 2400, maxTotalTokens: 6624000,
  maxResponseBytes: 65536,
});
const SCOPE = 'abstract-stage-simulation';
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,119}$/;
const failures = new Set(['invalid_json', 'invalid_contract', 'unknown_candidate', 'unknown_identity',
  'counterexample', 'provider_error', 'timeout', 'call_limit', 'token_limit', 'input_limit',
  'response_limit', 'model_mismatch', 'invalid_provider_model', 'invalid_usage', 'interrupted_call', 'circuit_open']);
const fail = (code) => Object.assign(new Error(code), { code });
const check = (condition, code = 'invalid_contract') => { if (!condition) throw fail(code); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const same = (a, b) => stableJson(a) === stableJson(b);

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashInput = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const multiset = (values) => values.map(stableJson).sort();

function matches(row, predicate) {
  if (predicate === null) return true;
  if (predicate.op === 'eq') return row.attrs[predicate.field] === predicate.value;
  if (predicate.op === 'and') return predicate.args.every((p) => matches(row, p));
  if (predicate.op === 'or') return predicate.args.some((p) => matches(row, p));
  if (predicate.op === 'not') return !matches(row, predicate.arg);
  throw fail('invalid_contract');
}

// This small fixture interpreter is not a production DSL compiler or CMDBuild executor.
export function compileDecision(input, candidateId) {
  const plan = input.candidates.find((candidate) => candidate.id === candidateId);
  check(plan, 'unknown_candidate');
  const selected = input.rows.filter((row) => matches(row, plan.filter));
  const selectedIds = new Set(selected.map((row) => row.id));
  const objects = new Map([...input.rows, ...input.nodes].map((item) => [item.id, item]));
  const result = { rows: [], hierarchy: [], edges: [], identities: [] };
  const hierarchy = new Map();
  for (const row of selected) {
    const copies = plan.copiesFrom ? row.refs[plan.copiesFrom] : [null];
    check(Array.isArray(copies));
    for (const copy of copies) {
      const id = plan.identity === 'copy' ? `${row.id}@${copy}` : row.id;
      // Record identity intentionally collapses copies, exposing cardinality mistakes.
      if (result.identities.some((item) => item.id === id)) continue;
      result.rows.push(row.id);
      result.identities.push({ id, rowId: row.id });
      if (copy !== null) hierarchy.set(stableJson([copy, id]), [copy, id]);
      let childId = id;
      let child = row;
      for (const field of plan.parents) {
        const parentId = child.refs[field];
        check(typeof parentId === 'string' && objects.has(parentId));
        hierarchy.set(stableJson([parentId, childId]), [parentId, childId]);
        childId = parentId;
        child = objects.get(parentId);
      }
    }
  }
  result.hierarchy = [...hierarchy.values()];
  result.edges = input.edges.filter((edge) => edge.domain === plan.edgeDomain && (
    plan.edgeScope === 'both' ? selectedIds.has(edge.from) && selectedIds.has(edge.to)
      : selectedIds.has(edge.from) || selectedIds.has(edge.to)
  )).map((edge) => ({
    id: edge.id, from: plan.direction === 'forward' ? edge.from : edge.to,
    to: plan.direction === 'forward' ? edge.to : edge.from, direction: plan.direction,
  }));
  return result;
}

export function publicCounterexample(input, candidateId) {
  const candidate = input.candidates.find((item) => item.id === candidateId);
  check(candidate, 'unknown_candidate');
  for (const field of ['identity', 'copiesFrom', 'edgeDomain', 'edgeScope', 'direction']) {
    if (candidate[field] !== input.obligations[field]) {
      return { code: 'counterexample', field, required: input.obligations[field], selected: candidate[field] };
    }
  }
  if (candidate.parents.length !== input.obligations.hierarchyDepth) {
    return { code: 'counterexample', field: 'hierarchyDepth', required: input.obligations.hierarchyDepth, selected: candidate.parents.length };
  }
  return null;
}

function identityUniverse(input) {
  const rowIds = new Set(input.rows.map((row) => row.id));
  const nodeIds = new Set([...rowIds, ...input.nodes.map((node) => node.id)]);
  const ids = new Map(input.rows.map((row) => [row.id, row.id]));
  for (const row of input.rows) {
    for (const value of Object.values(row.refs)) {
      if (Array.isArray(value)) for (const parent of value) ids.set(`${row.id}@${parent}`, row.id);
    }
  }
  return { rowIds, nodeIds, ids, edgeIds: new Set(input.edges.map((edge) => edge.id)) };
}

function validateResult(value, input) {
  check(exactKeys(value, ['rows', 'hierarchy', 'edges', 'identities']));
  check(Object.values(value).every(Array.isArray));
  const { rowIds, nodeIds, ids, edgeIds } = identityUniverse(input);
  check(value.rows.every((id) => rowIds.has(id)), 'unknown_identity');
  check(value.identities.every((item) => exactKeys(item, ['id', 'rowId']) && ids.get(item.id) === item.rowId), 'unknown_identity');
  check(value.hierarchy.every((pair) => Array.isArray(pair) && pair.length === 2 && nodeIds.has(pair[0]) && (nodeIds.has(pair[1]) || ids.has(pair[1]))), 'unknown_identity');
  check(value.edges.every((edge) => exactKeys(edge, ['id', 'from', 'to', 'direction']) && edgeIds.has(edge.id)
    && nodeIds.has(edge.from) && nodeIds.has(edge.to) && ['forward', 'reverse'].includes(edge.direction)), 'unknown_identity');
  return value;
}

export function validateStageResponse(content, stage, input) {
  check(['binding', 'materialize'].includes(stage));
  check(typeof content === 'string', 'invalid_json');
  let value;
  try { value = JSON.parse(content); } catch { throw fail('invalid_json'); }
  const field = stage === 'binding' ? 'candidateId' : 'result';
  check(exactKeys(value, ['status', field]) && ['accepted', 'unresolved'].includes(value.status));
  if (value.status === 'unresolved') { check(value[field] === null); return value; }
  if (stage === 'binding') check(input.candidates.some((item) => item.id === value.candidateId), 'unknown_candidate');
  else validateResult(value.result, input);
  return value;
}

export function evaluateResult(expected, response) {
  const accepted = response?.status === 'accepted' && plain(response.result);
  const output = accepted ? response.result : { rows: [], hierarchy: [], edges: [], identities: [] };
  const fields = ['rows', 'hierarchy', 'edges', 'identities'];
  const structured = fields.every((field) => Array.isArray(output[field]));
  const checks = Object.fromEntries(fields.map((field) => [field, Boolean(accepted && structured && same(multiset(expected[field]), multiset(output[field])))]));
  checks.rowIds = Boolean(accepted && structured && same([...new Set(expected.rows)].sort(), [...new Set(output.rows)].sort()));
  checks.cardinality = Boolean(accepted && structured && fields.every((field) => expected[field].length === output[field].length));
  const exact = Object.values(checks).every(Boolean);
  return { accepted: Boolean(accepted), exact, falseAcceptance: Boolean(accepted && !exact), unresolved: !accepted, checks };
}

const instructions = {
  A: 'Plan a candidate for this object-flow request, then produce the requested result. Use the available candidate catalog.',
  B: 'Work only on the current stage. Binding selects a candidate; materialization executes the already fixed candidate. Do not revise binding during materialization. Preserve Boolean grouping, references and identity independently.',
  C: 'Use the supplied targeted schema/domain knowledge to interpret references, identity and edge direction. Select and execute a candidate grounded in this knowledge.',
  D: 'Bind the business result explicitly. Verify selection, parent-child obligations, edge domain and direction, row cardinality and occurrence identity before accepting.',
  E: 'Choose fixed decisions from the input candidate catalog. A deterministic fixture compiler will execute them. A public-contract counterexample may be provided once; address it without inventing data.',
};

export function buildRequest({ input, variant, stage, decision = null, feedback = null }) {
  check(Object.hasOwn(VARIANTS, variant) && ['binding', 'materialize'].includes(stage));
  const { schemaKnowledge, request, rows, nodes, edges, candidates, obligations } = input;
  const data = { request, rows, nodes, edges, candidates, obligations };
  const payload = { input: data, decision, feedback };
  if (variant === 'C') payload.schemaKnowledge = schemaKnowledge;
  const contract = stage === 'binding'
    ? '{"status":"accepted","candidateId":"<catalog id>"} or {"status":"unresolved","candidateId":null}'
    : '{"status":"accepted","result":{"rows":["row ID"],"hierarchy":[["parent ID","child instance ID"]],"edges":[{"id":"edge ID","from":"node ID","to":"node ID","direction":"forward|reverse"}],"identities":[{"id":"instance ID","rowId":"row ID"}]}} or {"status":"unresolved","result":null}';
  return [
    { role: 'system', content: `${instructions[variant]} This is an abstract stage simulation, not the production assistant pipeline. If the reference meaning cannot be established from supplied data or schema Help, return unresolved; never guess an opaque reference mapping. Return exactly one JSON object, no markdown or additional keys. Stage: ${stage}. Contract: ${contract}. Rows are a multiset. Record identity is row ID; copy identity is rowID@parentID. Hierarchy tuples are directed parent to child, unique by tuple. Edges retain their own ID; reverse swaps endpoints. Empty results are valid. A null filter selects all rows. parents lists immediate parent reference first, then ancestor references. copiesFrom expands one occurrence per referenced parent, including zero occurrences for an empty list.` },
    { role: 'user', content: stableJson(payload) },
  ];
}

// Deliberately candidate-first, not an oracle solver. Offline scores test machinery only.
export async function offlineComplete({ messages, metadata }) {
  const { input, decision, feedback } = JSON.parse(messages[1].content);
  if (metadata.stage === 'binding') {
    const candidate = feedback?.code === 'counterexample'
      ? input.candidates.find((item) => !publicCounterexample(input, item.id)) || input.candidates[0]
      : input.candidates[0];
    return { content: JSON.stringify({ status: 'accepted', candidateId: candidate.id }) };
  }
  return { content: JSON.stringify({ status: 'accepted', result: compileDecision(input, decision.candidateId) }) };
}

function validateCases(cases) {
  check(Array.isArray(cases) && cases.length > 0);
  check(new Set(cases.map((item) => item.id)).size === cases.length);
  for (const item of cases) {
    check(item.synthetic === true && safeName.test(item.id) && ['development', 'holdout'].includes(item.split));
    const input = item.input;
    check(input && typeof input.request === 'string' && input.candidates.length > 0);
    check(new Set(input.candidates.map((candidate) => candidate.id)).size === input.candidates.length);
    const nodes = [...input.rows, ...input.nodes];
    check(new Set(nodes.map((node) => node.id)).size === nodes.length);
    check(nodes.every((node) => typeof node.id === 'string' && /^[A-Za-z0-9_-]+$/.test(node.id)));
    check(input.edges.every((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to)));
    validateResult(item.oracle.result, input);
    check(evaluateResult(item.oracle.result, { status: 'accepted', result: compileDecision(input, item.oracle.candidateId) }).exact, 'invalid_contract');
  }
}

function configuration(options) {
  const cases = freeze(clone(options.cases || assistantQualityCases));
  validateCases(cases);
  const variants = options.variants || Object.keys(VARIANTS);
  check(Array.isArray(variants) && variants.length > 0 && variants.every((id) => Object.hasOwn(VARIANTS, id)) && new Set(variants).size === variants.length);
  const repeats = options.repeats ?? 1;
  const seed = options.seed ?? 'quality-lab-v1';
  check(typeof seed === 'string' && safeName.test(seed));
  const temperature = options.temperature ?? 0.1;
  check(typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2);
  const diagnostics = options.diagnostics ?? 'off';
  check(['off', 'Basic', 'Verbose'].includes(diagnostics));
  check(options.onEvent === undefined || typeof options.onEvent === 'function');
  check(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 100);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  check(exactKeys(limits, Object.keys(DEFAULT_LIMITS)));
  for (const [key, value] of Object.entries(limits)) check(Number.isSafeInteger(value) && value >= (key === 'maxRepairs' ? 0 : 1));
  check(limits.concurrency <= 2 && limits.maxRepairs <= 1);
  const mode = options.mode || (options.complete ? 'live' : 'offline');
  check(['dry-run', 'offline', 'live'].includes(mode));
  const model = options.model || 'offline-candidate-first';
  const modelRevision = options.modelRevision || (mode === 'live' ? null : 'fixture-v1');
  check(typeof model === 'string' && safeName.test(model) && typeof modelRevision === 'string' && safeName.test(modelRevision));
  if (mode === 'live') check(typeof options.complete === 'function');
  if (mode === 'offline') check(!options.complete);
  const price = options.price || null;
  if (price) check(exactKeys(price, ['inputUsdPerToken', 'outputUsdPerToken'])
    && Object.values(price).every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0));
  const manifest = {
    version: LAB_VERSION, scope: SCOPE, productionReplay: 'unavailable', mode, model, modelRevision,
    variants: [...variants], repeats, seed, temperature, limits, price,
    implementationHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    cases: cases.map((item) => ({ id: item.id, split: item.split, caseHash: hashInput(item), inputHash: hashInput(item.input), oracleHash: hashInput(item.oracle) })),
  };
  return { cases, variants, repeats, seed, temperature, diagnostics, limits, mode, model, modelRevision, price, manifest, fingerprint: hashInput(manifest) };
}

export function permuteCandidates(input, seed, caseId, repeat) {
  const ordered = [...input.candidates].sort((a, b) => hashInput([seed, caseId, a.id]).localeCompare(hashInput([seed, caseId, b.id])));
  const offset = repeat % ordered.length;
  return freeze({ ...input, candidates: [...ordered.slice(offset), ...ordered.slice(0, offset)] });
}

function planRun(config) {
  const { cases, variants, repeats, limits } = config;
  const stageCount = cases.length * repeats * variants.reduce((count, id) => count + (id === 'E' ? 1 : 2), 0);
  const theoreticalMaxCalls = stageCount * (1 + limits.maxRepairs);
  const requests = cases.flatMap((item) => variants.flatMap((variant) => Array.from({ length: repeats }, (_, repeat) => {
    const input = permuteCandidates(item.input, config.seed, item.id, repeat);
    const messages = buildRequest({ input, variant, stage: 'binding' });
    return { caseId: item.id, variant, repeat, inputHash: hashInput(input), requestHash: hashInput(messages), inputTokenUpperBound: contextBound(messages) };
  })));
  return {
    jobs: cases.length * variants.length * repeats, baseCalls: stageCount, theoreticalMaxCalls,
    enforcedMaxCalls: Math.min(theoreticalMaxCalls, limits.maxCalls),
    reservedTokenUpperBound: Math.min(limits.maxTotalTokens, Math.min(theoreticalMaxCalls, limits.maxCalls) * (limits.maxInputTokens + limits.maxOutputTokens)),
    contextBudget: { maxInputTokens: limits.maxInputTokens, maxOutputTokens: limits.maxOutputTokens,
      method: 'UTF-8 bytes + 64 per message, conservative admission bound, not measured tokenizer usage', requests },
    limits, safetyCaps: { concurrency: 2, maxRepairsPerStage: 1, repeats: 100 },
  };
}

function contextBound(messages) {
  return messages.reduce((count, message) => count + Buffer.byteLength(message.content, 'utf8') + 64, 0);
}

function checkpointStore(outputDir, resume, manifest, fingerprint, onEvent) {
  const records = [];
  let journal;
  if (outputDir) {
    const directory = resolve(outputDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manifestPath = resolve(directory, 'manifest.json');
    journal = resolve(directory, 'events.jsonl');
    if (existsSync(manifestPath)) {
      check(resume, 'checkpoint_exists');
      const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
      check(previous.fingerprint === fingerprint && same(previous.manifest, manifest), 'checkpoint_mismatch');
      if (existsSync(journal)) {
        const lines = readFileSync(journal, 'utf8').split('\n');
        check(lines.pop() === '', 'checkpoint_truncated');
        for (const line of lines) {
          const record = JSON.parse(line);
          check(record.fingerprint === fingerprint && record.sequence === records.length, 'checkpoint_corrupt');
          const { digest, ...body } = record;
          check(digest === hashInput(body), 'checkpoint_corrupt');
          records.push(record);
        }
      }
    } else {
      check(!resume && !existsSync(journal), 'checkpoint_missing');
      writeFileSync(manifestPath, `${JSON.stringify({ fingerprint, manifest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  } else check(!resume, 'checkpoint_missing');
  return {
    records,
    append(event) {
      const body = { ...event, fingerprint, sequence: records.length };
      const record = { ...body, digest: hashInput(body) };
      if (journal) appendFileSync(journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      records.push(record);
      if (onEvent) onEvent(clone(record));
    },
    results(report) {
      if (!outputDir) return;
      const file = resolve(outputDir, 'results.json');
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}

function usageFrom(response) {
  if (response.usage == null) return null;
  check(exactKeys(response.usage, ['inputTokens', 'outputTokens']) && Object.values(response.usage).every((value) => Number.isSafeInteger(value) && value >= 0), 'invalid_usage');
  return response.usage;
}

function reportFor(config, plan, records, results) {
  const started = records.filter((record) => record.type === 'call_started');
  const finished = records.filter((record) => record.type === 'call_finished');
  const usage = finished.filter((record) => record.usage).reduce((sum, record) => ({
    inputTokens: sum.inputTokens + record.usage.inputTokens, outputTokens: sum.outputTokens + record.usage.outputTokens,
  }), { inputTokens: 0, outputTokens: 0 });
  const usageComplete = started.length > 0 && started.length === finished.length && finished.every((record) => record.usage !== null);
  const groups = config.variants.flatMap((variant) => ['development', 'holdout'].map((split) => {
    const subset = results.filter((result) => result.variant === variant && result.split === split);
    const count = (key) => subset.filter((result) => result.evaluation[key]).length;
    const failures = count('failed');
    const evaluated = subset.length - failures;
    const caseIds = new Set(config.cases.filter((item) => item.split === split).map((item) => item.id));
    const measuredCalls = finished.filter((record) => record.variant === variant && caseIds.has(record.key.split(':')[0]));
    const durations = measuredCalls.map((record) => record.durationMs).sort((a, b) => a - b);
    const percentile = (fraction) => durations.length ? durations[Math.ceil(durations.length * fraction) - 1] : null;
    const measuredUsage = measuredCalls.reduce((sum, record) => ({
      inputTokens: sum.inputTokens + (record.usage?.inputTokens || 0),
      outputTokens: sum.outputTokens + (record.usage?.outputTokens || 0),
    }), { inputTokens: 0, outputTokens: 0 });
    return { variant, split, total: subset.length, exact: count('exact'), falseAcceptance: count('falseAcceptance'), unresolved: count('unresolved'),
      failures, evaluated, exactRate: evaluated ? count('exact') / evaluated : null,
      modelCalls: measuredCalls.length, measuredUsage,
      callLatencyMs: { p50: percentile(0.5), p95: percentile(0.95), sum: durations.reduce((sum, ms) => sum + ms, 0) },
      available: subset.filter((result) => result.knowledgeAvailability === 'available').length,
      correctAbstention: count('correctAbstention'),
      bindingExact: subset.filter((result) => result.bindingExact).length,
      firstPassExact: subset.filter((result) => result.evaluation.exact && result.repairs === 0).length,
      repairs: subset.reduce((sum, result) => sum + result.repairs, 0) };
  }));
  return {
    fingerprint: config.fingerprint, scope: SCOPE, mode: config.mode,
    warning: 'A-E are abstract stage simulations, not full production pipeline A/B evaluations. Offline results test harness mechanics, not model quality.',
    manifest: config.manifest, plan, results, metrics: groups,
    providerModels: [...new Set(finished.map((record) => record.providerModel).filter(Boolean))].sort(),
    budget: { calls: started.length, reservedTokens: started.reduce((sum, record) => sum + record.reservedTokens, 0),
      measuredUsage: usage, usageComplete, costUsd: config.mode === 'live' && config.price && usageComplete
        ? usage.inputTokens * config.price.inputUsdPerToken + usage.outputTokens * config.price.outputUsdPerToken : null,
      costStatus: config.mode !== 'live' ? 'not-applicable' : !config.price ? 'price-unavailable' : !usageComplete ? 'usage-unavailable' : 'estimated-from-supplied-price' },
    hypotheses: config.variants.map((variant) => ({ variant, label: VARIANTS[variant],
      stagePilot: config.mode === 'live' && finished.some((record) => record.variant === variant && record.ok) ? 'tested' : 'unavailable',
      productionPipeline: 'unavailable', causalConclusion: 'unavailable',
      reason: config.mode === 'live' ? 'Stage-only pilot; production replay and statistical validation not integrated.' : 'No model quality test in offline/dry-run mode.' })),
  };
}

export async function runExperiment(options = {}) {
  const config = configuration(options);
  const plan = planRun(config);
  if (config.mode === 'dry-run') return reportFor(config, plan, [], []);
  const checkpoint = checkpointStore(options.outputDir, options.resume, config.manifest, config.fingerprint, options.onEvent);
  const { records } = checkpoint;
  const complete = config.mode === 'offline' ? offlineComplete : options.complete;
  const { limits } = config;
  let circuitOpen = records.some((record) => ['timeout', 'model_mismatch', 'token_limit'].includes(record.code));
  let observedProviderModel = records.find((record) => record.providerModel)?.providerModel || null;
  let calls = records.filter((record) => record.type === 'call_started').length;
  let reservedTokens = records.filter((record) => record.type === 'call_started').reduce((sum, record) => sum + record.reservedTokens, 0);
  const results = [];

  async function call(item, variant, repeat, stage, decision, attempt, feedback) {
    const key = `${item.id}:${variant}:${repeat}:${stage}:${attempt}`;
    const messages = buildRequest({ input: item.input, variant, stage, decision, feedback });
    const requestHash = hashInput({ model: config.model, temperature: config.temperature, messages, maxOutputTokens: limits.maxOutputTokens });
    const cached = records.find((record) => record.type === 'call_finished' && record.key === key);
    if (cached) {
      check(cached.requestHash === requestHash, 'checkpoint_mismatch');
      if (cached.ok) validateStageResponse(JSON.stringify(cached.value), stage, item.input);
      return cached;
    }
    if (records.some((record) => record.type === 'call_started' && record.key === key)) return { ok: false, code: 'interrupted_call', terminal: true };
    if (circuitOpen) return { ok: false, code: 'circuit_open', terminal: true };
    if (calls >= limits.maxCalls) return { ok: false, code: 'call_limit', terminal: true };
    const inputBound = contextBound(messages);
    if (inputBound > limits.maxInputTokens) return { ok: false, code: 'input_limit', terminal: true };
    const reservation = inputBound + limits.maxOutputTokens;
    if (reservedTokens + reservation > limits.maxTotalTokens) return { ok: false, code: 'token_limit', terminal: true };
    calls += 1;
    reservedTokens += reservation;
    checkpoint.append({ type: 'call_started', key, variant, stage, attempt, requestHash, reservedTokens: reservation });
    const controller = new AbortController();
    let timer;
    let usage = null;
    let providerModel = null;
    let outcome;
    const started = performance.now();
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => complete({
          model: config.model, temperature: config.temperature, messages: clone(messages), maxOutputTokens: limits.maxOutputTokens, signal: controller.signal,
          metadata: { caseId: item.id, variant, repeat, stage, attempt, scope: SCOPE },
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(fail('timeout')); }, limits.timeoutMs);
        }),
      ]);
      check(plain(response), 'invalid_contract');
      if (response.providerModel !== undefined) {
        check(typeof response.providerModel === 'string' && safeName.test(response.providerModel), 'invalid_provider_model');
        providerModel = response.providerModel;
        check(observedProviderModel === null || observedProviderModel === providerModel, 'model_mismatch');
        observedProviderModel = providerModel;
      }
      if (response.model !== undefined) check(response.model === config.model, 'model_mismatch');
      usage = usageFrom(response);
      if (usage) check(usage.inputTokens <= inputBound && usage.outputTokens <= limits.maxOutputTokens, 'token_limit');
      check(typeof response.content === 'string', 'invalid_json');
      check(Buffer.byteLength(response.content, 'utf8') <= limits.maxResponseBytes, 'response_limit');
      const value = validateStageResponse(response.content, stage, item.input);
      const counterexample = variant === 'E' && stage === 'binding' && value.status === 'accepted'
        ? publicCounterexample(item.input, value.candidateId) : null;
      outcome = counterexample ? { ok: false, code: 'counterexample', feedback: counterexample } : { ok: true, value };
    } catch (error) {
      const code = failures.has(error?.code) ? error.code : 'provider_error';
      if (['timeout', 'model_mismatch', 'token_limit'].includes(code)) circuitOpen = true;
      outcome = { ok: false, code, terminal: ['timeout', 'model_mismatch', 'token_limit'].includes(code) };
    } finally { clearTimeout(timer); }
    const record = { type: 'call_finished', key, variant, stage, attempt, requestHash, usage, providerModel,
      durationMs: Math.round(performance.now() - started), ...outcome };
    // Only validated IDs, public counterexamples and fixed error codes reach artifacts.
    checkpoint.append(record);
    return record;
  }

  async function stageRun(item, variant, repeat, stage, decision) {
    let feedback = null;
    for (let attempt = 0; attempt <= limits.maxRepairs; attempt += 1) {
      const response = await call(item, variant, repeat, stage, decision, attempt, feedback);
      if (response.ok || response.terminal || attempt === limits.maxRepairs) return { ...response, repairs: attempt };
      feedback = response.feedback || { code: response.code };
    }
  }

  const jobs = config.cases.flatMap((item) => config.variants.flatMap((variant) =>
    Array.from({ length: config.repeats }, (_, repeat) => ({
      item: { ...item, input: permuteCandidates(item.input, config.seed, item.id, repeat) }, variant, repeat,
    }))));
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const { item, variant, repeat } = jobs[cursor++];
      const binding = await stageRun(item, variant, repeat, 'binding', null);
      let response = binding;
      if (binding.ok && binding.value.status === 'accepted') {
        response = variant === 'E'
          ? { ok: true, repairs: 0, value: { status: 'accepted', result: compileDecision(item.input, binding.value.candidateId) } }
          : await stageRun(item, variant, repeat, 'materialize', binding.value);
      }
      const value = response.ok && response.value.result ? response.value : { status: 'unresolved', result: null };
      const modelUnresolved = response.ok === true && response.value.status === 'unresolved';
      const failed = !response.ok;
      const result = {
        caseId: item.id, split: item.split, variant, repeat,
        status: failed ? 'failed' : value.status, code: response.code || (modelUnresolved ? 'model_unresolved' : null),
        repairs: binding.repairs + (response === binding ? 0 : response.repairs),
        bindingExact: Boolean(binding.ok && binding.value.candidateId === item.oracle.candidateId),
        evaluation: { ...evaluateResult(item.oracle.result, value), failed, unresolved: modelUnresolved, correctAbstention: false },
      };
      result.knowledgeAvailability = item.oracle.knowledgeRequired && variant !== 'C' ? 'unavailable' : 'available';
      if (result.knowledgeAvailability === 'unavailable') {
        result.bindingExact = false;
        result.evaluation.semanticExact = result.evaluation.exact;
        result.evaluation.exact = false;
        result.evaluation.falseAcceptance = result.evaluation.accepted;
        result.evaluation.correctAbstention = modelUnresolved;
      }
      results.push(result);
    }
  }
  await Promise.all(Array.from({ length: limits.concurrency }, () => worker()));
  results.sort((a, b) => `${a.caseId}:${a.variant}:${a.repeat}`.localeCompare(`${b.caseId}:${b.variant}:${b.repeat}`));
  const report = reportFor(config, plan, records, results);
  checkpoint.results(report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'dry-run' }, adapter: { type: 'string' }, model: { type: 'string' },
    'model-revision': { type: 'string' }, variants: { type: 'string', default: 'A,B,C,D,E' },
    repeats: { type: 'string', default: '1' }, split: { type: 'string', default: 'all' },
    seed: { type: 'string', default: 'quality-lab-v1' },
    temperature: { type: 'string', default: '0.1' }, diagnostics: { type: 'string', default: 'off' },
    'output-dir': { type: 'string' }, resume: { type: 'boolean', default: false },
    'input-usd-per-token': { type: 'string' }, 'output-usd-per-token': { type: 'string' },
    ...Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), { type: 'string' }])),
  } });
  check(['all', 'development', 'holdout'].includes(values.split));
  let complete;
  if (values.mode === 'live') {
    check(values.adapter && values.model && values['model-revision'], 'live_configuration_required');
    ({ complete } = await import(pathToFileURL(resolve(values.adapter)).href));
  }
  const limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).flatMap((key) => {
    const cli = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    return values[cli] === undefined ? [] : [[key, Number(values[cli])]];
  }));
  const hasPrice = values['input-usd-per-token'] !== undefined || values['output-usd-per-token'] !== undefined;
  const report = await runExperiment({
    cases: assistantQualityCases.filter((item) => values.split === 'all' || item.split === values.split),
    variants: values.variants.split(','), repeats: Number(values.repeats), seed: values.seed, mode: values.mode, complete,
    temperature: Number(values.temperature), diagnostics: values.diagnostics,
    onEvent: values.diagnostics === 'off' ? undefined : (event) => {
      const diagnostic = { event: event.type, sequence: event.sequence, variant: event.variant, stage: event.stage, attempt: event.attempt };
      if (values.diagnostics === 'Verbose') Object.assign(diagnostic, { requestHash: event.requestHash, usage: event.usage, code: event.code });
      process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    },
    model: values.model, modelRevision: values['model-revision'], outputDir: values['output-dir'], resume: values.resume, limits,
    price: hasPrice ? { inputUsdPerToken: Number(values['input-usd-per-token']), outputUsdPerToken: Number(values['output-usd-per-token']) } : null,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Do not print provider/adapter errors: they can contain keys, URLs or payloads.
    const publicCodes = new Set([...failures, 'checkpoint_exists', 'checkpoint_mismatch', 'checkpoint_truncated',
      'checkpoint_corrupt', 'checkpoint_missing', 'live_configuration_required']);
    const code = publicCodes.has(error?.code) ? error.code : 'lab_failed';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
