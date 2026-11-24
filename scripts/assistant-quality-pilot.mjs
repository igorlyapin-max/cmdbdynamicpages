#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hashInput } from './assistant-quality-lab.mjs';
import { buildPilotDraft } from './assistant-quality-pilot-artifacts.mjs';
import { runPilotPipeline } from './assistant-quality-pilot-pipeline.mjs';
import { pilotGraphSnapshot } from './assistant-quality-pilot-graph.mjs';
import { isPilotBudgetLimit, scorePilotAttempt, summarizePilotAttempts } from './assistant-quality-pilot-report.mjs';

const modes = ['flow', 'mapping', 'end-to-end'];
const variants = ['A', 'B', 'C'];
const sha = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const loadJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const limitsBound = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function createPilotPlan({ scenarios, freeze, repeats = 3, ablations = false, limits }) {
  check(freeze && [freeze.dataHash, freeze.catalogHash, freeze.promptHash].every((hash) => sha.test(hash)) &&
    typeof freeze.model === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(freeze.model) &&
    typeof freeze.modelRevision === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(freeze.modelRevision), 'pilot_freeze_required');
  check(limitsBound(repeats, 20) && limitsBound(limits?.maxModelRequests, 1500) && limitsBound(limits?.maxRows, 5000) &&
    limitsBound(limits?.timeoutMs, 240000) && limitsBound(limits?.traversalDepth, 12), 'pilot_invalid_limits');
  check(Array.isArray(scenarios) && scenarios.length > 0 && scenarios.length <= 20, 'pilot_invalid_scenarios');
  const seen = new Set();
  const inputs = structuredClone(scenarios);
  const items = [];
  for (const item of inputs) {
    check(identifier.test(item.id) && !seen.has(item.id) && ['development', 'holdout'].includes(item.split) &&
      ['anonymized', 'synthetic', 'private-archive'].includes(item.dataKind) &&
      Array.isArray(item.modes) && item.modes.length && new Set(item.modes).size === item.modes.length && item.modes.every((mode) => modes.includes(mode)) &&
      item.input?.spec && item.oracle && !Object.hasOwn(item.input, 'oracle'), 'pilot_invalid_scenarios');
    seen.add(item.id);
    if (item.oracle.outcome === 'unresolved') {
      check(item.modes.every((mode) => {
        const stage = typeof item.oracle.expectedStage === 'string' ? item.oracle.expectedStage : item.oracle.expectedStage?.[mode];
        return (mode !== 'flow' && stage === 'mapping') || (mode !== 'mapping' && stage === 'flow');
      }), 'pilot_unresolved_stage_required');
    }
    const blockIds = item.input.spec.authoring?.assistant?.objectFlowIntent?.blocks?.map((block) => block.id);
    check(blockIds?.length && new Set(blockIds).size === blockIds.length, 'pilot_missing_block_ids');
    for (const mode of item.modes) {
      for (const variant of mode === 'flow' ? ['A', 'B'] : variants) {
        items.push({ item, mode, variant, blockIds, draft: buildPilotDraft({ ...item.input, mode, variant }) });
      }
      if (ablations) for (const [variant, useRevisedPrompts, useKnowledge] of [['B-prompt-only', true, false], ['B-knowledge-only', false, true]]) {
        items.push({ item, mode, variant, blockIds, draft: buildPilotDraft({ ...item.input, mode, variant: 'B', useRevisedPrompts, useKnowledge }) });
      }
    }
  }
  const implementationHash = hashInput(['pilot', 'pilot-pipeline', 'pilot-artifacts', 'pilot-report', 'pilot-graph']
    .map((name) => readFileSync(new URL(`assistant-quality-${name}.mjs`, import.meta.url), 'utf8')));
  const fingerprint = hashInput({ freeze, repeats, limits, implementationHash, inputs,
    drafts: items.map(({ mode, variant, draft }) => [mode, variant, hashInput(draft)]) });
  const jobs = Array.from({ length: repeats }, (_, repeat) => items.map((item) => ({ ...item, repeat })))
    .flat().sort((a, b) => a.repeat - b.repeat || hashInput([fingerprint, a.item.id, a.mode, a.variant, a.repeat])
      .localeCompare(hashInput([fingerprint, b.item.id, b.mode, b.variant, b.repeat])));
  return deepFreeze({ freeze: structuredClone(freeze), limits: structuredClone(limits), fingerprint, jobs });
}

export async function runPilot(plan, { execute, evidence, onAttempt }) {
  check(['live-frozen-bff', 'offline-simulation', 'historical-replay'].includes(evidence), 'pilot_evidence_required');
  let modelRequests = 0;
  const reserveModelRequest = () => {
    check(modelRequests < plan.limits.maxModelRequests, 'pilot_model_request_budget');
    modelRequests += 1;
  };
  const attempts = [];
  for (const { item, mode, variant, repeat, blockIds, draft } of plan.jobs) {
    const key = { scenarioId: item.id, split: item.split, mode, variant, repeat };
    let capture;
    if (modelRequests >= plan.limits.maxModelRequests) capture = { failure: 'pilot_model_request_budget' };
    else try {
      // The adapter never receives item, original spec, or evaluator-private oracle.
      capture = await execute({ ...key, draft: structuredClone(draft), params: structuredClone(item.input.params || {}),
        templateRef: structuredClone(item.input.templateRef), ignoredStaticRoles: structuredClone(item.input.ignoredStaticRoles || []),
        blockIds: [...blockIds], maxRows: plan.limits.maxRows, traversalDepth: plan.limits.traversalDepth, reserveModelRequest });
    } catch (error) {
      capture = { failure: isPilotBudgetLimit(error?.code) ? error.code : 'pilot_execution_failure' };
    }
    const evaluation = scorePilotAttempt({ mode, oracle: item.oracle, capture });
    const attempt = { ...key, evidence, failedPhase: capture?.failedPhase || null,
      events: capture?.events || [], evaluation };
    attempts.push(attempt);
    onAttempt?.(attempt);
  }
  return { fingerprint: plan.fingerprint, evidence, modelRequests, attempts,
    metrics: summarizePilotAttempts(attempts.map(({ evaluation, ...key }) => ({ ...key, ...evaluation }))) };
}

export async function createLocalPilotRequest({ timeoutMs, env = process.env, fetchImpl = fetch }) {
  const origin = 'http://127.0.0.1:8093';
  const prefix = origin + '/cmdbuild/custom-api';
  const cookie = String(env.CMDP_PILOT_COOKIE || '').trim();
  check(/^CMDBuild-Authorization=[^\s;]{1,8192}$/.test(cookie), 'pilot_missing_local_session');
  const csrfResponse = await fetchImpl(prefix + '/csrf', { redirect: 'error', headers: { cookie }, signal: AbortSignal.timeout(timeoutMs) });
  check(csrfResponse.ok, 'pilot_csrf_unavailable');
  const csrf = (await csrfResponse.json()).token;
  check(typeof csrf === 'string' && csrf, 'pilot_csrf_unavailable');
  const allowed = new Set(['/assistant/object-flow/semantic-plan', '/assistant/object-flow/plan', '/draft/object-flow/apply',
    '/draft/diagram-import/analyze', '/assistant/diagram-import/interpret', '/assistant/diagram-import/map-selections',
    '/draft/diagram-import/apply', '/draft/preview']);
  const request = async (path, body, query) => {
    check(allowed.has(path), 'pilot_forbidden_endpoint');
    const response = await fetchImpl(`${prefix}${path}?${new URLSearchParams(query)}`, { method: 'POST', redirect: 'error',
      headers: { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  request.read = async (path, query) => {
    check(path === '/config' || /^\/templates\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(path), 'pilot_forbidden_endpoint');
    const response = await fetchImpl(`${prefix}${path}?${new URLSearchParams(query)}`, { redirect: 'error',
      headers: { cookie }, signal: AbortSignal.timeout(timeoutMs) });
    check(response.ok, 'pilot_preflight_read_failed');
    return response.json();
  };
  return request;
}

async function verifyStand(request, plan) {
  const bases = new Map();
  const refs = new Map(plan.jobs.map(({ item }) => {
    const ref = item.input.templateRef;
    check(ref && identifier.test(ref.root) && identifier.test(ref.templateCode) && sha.test(ref.baseSpecHash), 'pilot_template_reference_required');
    return [hashInput(ref), ref];
  }));
  for (const [key, ref] of refs) {
    const { template } = await request.read(`/templates/${ref.templateCode}`, { root: ref.root });
    check(template?.specHash === ref.baseSpecHash, 'pilot_template_revision_changed');
    check(!['aliases', 'alias', 'objectFlow', 'publishedAlias'].some((field) => Object.hasOwn(template.spec, field)), 'pilot_saved_ref_needs_current_contract');
    bases.set(key, template.spec);
  }
  for (const root of new Set([...refs.values()].map((ref) => ref.root))) {
    const { config } = await request.read('/config', { root });
    const assistant = config?.runtimeConfig?.assistant;
    check(assistant?.llm?.enabled === true && assistant.llm.model === plan.freeze.model &&
      hashInput(assistant.prompt) === plan.freeze.promptHash &&
      hashInput(config.runtimeConfig) === plan.freeze.runtimeConfigHash, 'pilot_runtime_config_changed_or_disabled');
  }
  return bases;
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, live: { type: 'boolean' },
    'output-dir': { type: 'string' }, diagnostics: { type: 'string', default: 'off' } } });
  check(values.manifest && ['off', 'Basic', 'Verbose'].includes(values.diagnostics), 'pilot_arguments_required');
  const config = loadJson(values.manifest);
  const dir = dirname(resolve(values.manifest));
  const scenarios = config.scenarios.map(({ inputPath, oraclePath, ...item }) => ({ ...item,
    input: loadJson(resolve(dir, inputPath)), oracle: loadJson(resolve(dir, oraclePath)) }));
  const plan = createPilotPlan({ ...config, scenarios });
  if (!values.live) {
    console.log(JSON.stringify({ fingerprint: plan.fingerprint, planned: plan.jobs.length, maxModelRequests: plan.limits.maxModelRequests, status: 'dry-run' }));
    return;
  }
  check(values['output-dir'] && config.freeze.isolatedReadOnly === true && sha.test(config.freeze.runtimeConfigHash) &&
    scenarios.every((item) => item.dataKind !== 'private-archive'), 'pilot_live_requires_isolated_anonymized_snapshot');
  const outputDir = resolve(values['output-dir']);
  const request = await createLocalPilotRequest(plan.limits);
  const bases = await verifyStand(request, plan);
  mkdirSync(outputDir, { mode: 0o700 });
  const diagnostics = (event, attempt) => {
    if (values.diagnostics === 'off') return;
    console.error(JSON.stringify({ time: new Date().toISOString(), event,
      ...(attempt && values.diagnostics === 'Verbose' ? { scenarioId: attempt.scenarioId, mode: attempt.mode,
        variant: attempt.variant, repeat: attempt.repeat, exact: attempt.evaluation.exact } : {}) }));
  };
  diagnostics('assistant.quality_pilot.started');
  const report = await runPilot(plan, { evidence: 'live-frozen-bff',
    execute: ({ ignoredStaticRoles, ...input }) => runPilotPipeline({ ...input, request, baseSpec: bases.get(hashInput(input.templateRef)),
      graphSnapshot: (diagram) => pilotGraphSnapshot(diagram, { ignoredStaticRoles }) }),
    onAttempt: (attempt) => diagnostics('assistant.quality_pilot.attempt_finished', attempt) });
  try { await verifyStand(request, plan); } catch { report.valid = false; }
  report.valid ??= true;
  writeFileSync(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  diagnostics('assistant.quality_pilot.finished');
  console.log(JSON.stringify({ fingerprint: plan.fingerprint, attempted: report.attempts.length, modelRequests: report.modelRequests, valid: report.valid }));
  if (!report.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: 'assistant.quality_pilot.failed', code: /^pilot_[a-z0-9_]+$/.test(error?.code || '') ? error.code : 'pilot_failed' }));
    process.exitCode = 1;
  });
}
