import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assistantDiagramBindingIntentMessages, assistantDiagramBindingIntentSeed,
  assistantDiagramBindingIntentDraftFromResponse, normalizeAssistantDiagramBindingIntentResponse,
} from './dev-proxy-server.mjs';
import { hashInput } from './assistant-quality-lab.mjs';
import { complete } from './assistant-quality-openai.mjs';

export function bindingReplayBatches(input, batchSize = 0) {
  const seed = assistantDiagramBindingIntentSeed(input);
  const placements = input.placements.filter((item) => seed.pendingPlacementIds.includes(item.structureItemId));
  const relationRules = input.relationRules.filter((item) => seed.pendingConnectionKeys.includes(item.d2ClassKey || item.d2ElementKey));
  if (!batchSize) return placements.length || relationRules.length ? [{ ...input, placements, relationRules }] : [];
  const batches = [];
  for (let i = 0; i < placements.length; i += batchSize) {
    batches.push({ ...input, placements: placements.slice(i, i + batchSize), relationRules: [] });
  }
  for (let i = 0; i < relationRules.length; i += batchSize) {
    batches.push({ ...input, placements: [], relationRules: relationRules.slice(i, i + batchSize) });
  }
  return batches;
}

export function mergeBindingReplay(input, responses) {
  const seed = assistantDiagramBindingIntentSeed(input);
  const pendingPlacements = new Set(seed.pendingPlacementIds);
  const pendingConnections = new Set(seed.pendingConnectionKeys);
  const normalized = normalizeAssistantDiagramBindingIntentResponse(input, {
    placementBindings: responses.flatMap((response) => response.placementBindings || [])
      .filter((item) => pendingPlacements.has(item.structureItemId)),
    connectionBindings: responses.flatMap((response) => response.connectionBindings || [])
      .filter((item) => pendingConnections.has(item.d2ClassKey)),
    unresolved: responses.flatMap((response) => response.unresolved || []).filter((item) => item.targetType === 'placement'
      ? pendingPlacements.has(item.targetId) : pendingConnections.has(item.targetId)),
  });
  const merge = (bases, candidates, field) => {
    const baseIds = new Set(bases.map((item) => item[field]));
    return bases.map((base) => ({ ...base, ...candidates.find((item) => item[field] === base[field]) }))
      .concat(candidates.filter((item) => !baseIds.has(item[field])));
  };
  const seededPlacements = new Set(seed.placementBindings.map((item) => item.structureItemId));
  const seededConnections = new Set(seed.connectionBindings.map((item) => item.d2ClassKey));
  return assistantDiagramBindingIntentDraftFromResponse(input, {
    ...normalized,
    placementBindings: merge(seed.placementBindings, normalized.placementBindings || [], 'structureItemId'),
    connectionBindings: merge(seed.connectionBindings, normalized.connectionBindings || [], 'd2ClassKey'),
    unresolved: (normalized.unresolved || []).filter((item) => item.targetType === 'placement'
      ? !seededPlacements.has(item.targetId) : !seededConnections.has(item.targetId)),
  });
}

export async function replayBinding({ input, runtimeConfig, complete: provider = complete,
  model, batchSize = 0, maxOutputTokens = 2400, timeoutMs = 60000, dryRun = false }) {
  const batches = bindingReplayBatches(input, batchSize);
  if (batches.length > 32) throw new Error('replay_batch_limit');
  const calls = [];
  const responses = [];
  for (const batch of batches) {
    const messages = assistantDiagramBindingIntentMessages(batch, runtimeConfig);
    const inputBytes = Buffer.byteLength(JSON.stringify(messages));
    if (inputBytes > 400000) throw new Error('replay_context_limit');
    const call = { requestHash: hashInput(messages), inputBytes, placements: batch.placements.length,
      connections: batch.relationRules.length, maxOutputTokens };
    if (dryRun) { calls.push(call); continue; }
    const start = performance.now();
    try {
      const response = await provider({ model, messages, maxOutputTokens, signal: AbortSignal.timeout(timeoutMs) });
      call.usage = response.usage;
      call.providerModel = response.providerModel;
      const parsed = JSON.parse(response.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_response');
      const placementIds = new Set(batch.placements.map((item) => item.structureItemId));
      const connectionKeys = new Set(batch.relationRules.map((item) => item.d2ClassKey || item.d2ElementKey));
      responses.push({
        placementBindings: (parsed.placementBindings || []).filter((item) => placementIds.has(item.structureItemId)),
        connectionBindings: (parsed.connectionBindings || []).filter((item) => connectionKeys.has(item.d2ClassKey)),
        unresolved: (parsed.unresolved || []).filter((item) => item.targetType === 'placement'
          ? placementIds.has(item.targetId) : connectionKeys.has(item.targetId)),
      });
      call.completed = true;
    } catch (error) {
      call.completed = false;
      call.failure = ['provider_http_error', 'output_truncated', 'response_limit', 'invalid_json',
        'invalid_provider_response'].includes(error?.code) ? error.code : 'provider_or_response_failure';
    }
    call.durationMs = Math.round(performance.now() - start);
    calls.push(call);
    if (!call.completed) break;
  }
  const draft = dryRun ? null : mergeBindingReplay(input, responses);
  return { scope: 'production-binding-stage-replay', inputHash: hashInput(input),
    runtimePromptHash: hashInput(runtimeConfig?.assistant?.prompt || {}), batchSize, calls,
    complete: !dryRun && calls.length === batches.length && calls.every((call) => call.completed),
    draft, quality: 'Contract acceptance and obligations only; no row or diagram execution oracle.' };
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, 'runtime-config': { type: 'string' }, 'output-dir': { type: 'string' },
    model: { type: 'string', default: 'corp-openai-gpt-4.1-mini' }, 'batch-size': { type: 'string', default: '0' },
    'max-output-tokens': { type: 'string', default: '2400' }, 'timeout-ms': { type: 'string', default: '60000' },
    live: { type: 'boolean', default: false },
  } });
  if (!values.input || !values['runtime-config'] || !values['output-dir']) throw new Error('replay_arguments_required');
  const batchSize = Number(values['batch-size']);
  const maxOutputTokens = Number(values['max-output-tokens']);
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(batchSize) || batchSize < 0 || batchSize > 64 ||
    !Number.isInteger(maxOutputTokens) || maxOutputTokens < 100 || maxOutputTokens > 16000 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('replay_invalid_limits');
  const input = JSON.parse(readFileSync(values.input, 'utf8'));
  const runtimeConfig = JSON.parse(readFileSync(values['runtime-config'], 'utf8'));
  const result = await replayBinding({ input, runtimeConfig, batchSize, model: values.model,
    maxOutputTokens, timeoutMs, dryRun: !values.live });
  const dir = resolve(values['output-dir']);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(dir, 'binding-report.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ scope: result.scope, complete: result.complete, calls: result.calls.length,
    valid: result.draft?.success, unresolved: result.draft?.intent?.unresolved?.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Binding replay failed. Check inputs and limits; provider details are redacted.'); process.exitCode = 1; });
}
