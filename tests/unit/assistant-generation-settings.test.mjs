import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_DIAGNOSTICS_CAPS, ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE,
  assistantConfigurationLimitDiagnostics, validateAssistantConfigurationNumbers,
  defaultRuntimeConfig, mergeRuntimeConfigDefaults, normalizeAssistantRuntimeConfig, normalizeConfigPayload
} from '../../scripts/dev-proxy-server.mjs';

test('generation token default, minimum and configured cap use the shared limit diagnostic', () => {
  assert.equal(defaultRuntimeConfig().assistant.llm.maxTokens, 16384);
  for (const value of [1, 16384, ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE]) {
    assert.equal(normalizeAssistantRuntimeConfig({ assistant: { llm: { maxTokens: value } } }).llm.maxTokens, value);
  }
  for (const value of [0, -1, 1.5, 'bad']) {
    assert.equal(normalizeAssistantRuntimeConfig({ assistant: { llm: { maxTokens: value } } }).llm.maxTokens, 16384);
  }
  const config = normalizeAssistantRuntimeConfig({ assistant: { llm: { maxTokens: 999999 } } });
  assert.equal(config.llm.maxTokens, ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE);
  assert.equal(config.llm.limitConfig.maxTokens.requested, 999999);
  assert.equal(config.llm.limitConfig.maxTokens.clampedBy, 'CMDP_ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE');
});

test('config save/read preserves requested budgets and reports their effective limits, not capture state', () => {
  const input = { assistant: { llm: { maxTokens: 999999 }, diagnostics: {
    mode: 'Verbose', activeUntil: 'future', maxBodyBytes: 999999999, captureDurationSec: 999999
  } } };
  const merged = mergeRuntimeConfigDefaults(input);
  assert.equal(merged.assistant.llm.maxTokens, 999999);
  assert.equal(merged.assistant.diagnostics.maxBodyBytes, 999999999);
  assert.equal(merged.assistant.diagnostics.captureDurationSec, 999999);
  assert.equal(merged.assistant.diagnostics.mode, undefined);
  assert.equal(merged.assistant.diagnostics.activeUntil, undefined);
  const saved = normalizeConfigPayload({ runtimeConfig: input }, 'Cst_QueryTool');
  const runtime = typeof saved.RuntimeConfigJson === 'string' ? JSON.parse(saved.RuntimeConfigJson) : saved.RuntimeConfigJson;
  assert.equal(runtime.assistant.llm.maxTokens, 999999);
  assert.deepEqual(runtime.assistant.diagnostics, merged.assistant.diagnostics);
  const warnings = assistantConfigurationLimitDiagnostics(runtime);
  assert.ok(warnings.some((item) => item.settingPath === 'assistant.llm.maxTokens' && item.requested === 999999 && item.effectiveLimit === ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE));
  assert.ok(warnings.some((item) => item.settingPath === 'assistant.diagnostics.maxBodyBytes' && item.requested === 999999999 && item.effectiveLimit === ASSISTANT_DIAGNOSTICS_CAPS.maxBodyBytes));
  assert.ok(normalizeAssistantRuntimeConfig(runtime).llm.limitClamps.some((item) => item.requested === 999999));
});

test('new settings reject invalid numeric input and report cross-budget clamps explicitly', () => {
  for (const value of [0, -1, 1.1, '123', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateAssistantConfigurationNumbers({ assistant: { llm: { maxTokens: value } } }).length, 1);
  }
  const warnings = assistantConfigurationLimitDiagnostics({ assistant: { diagnostics: { maxStoredBytes: 1000, maxTraceBytes: 2000, maxBodyBytes: 3000 } } });
  assert.ok(warnings.some((item) => item.settingPath.endsWith('maxBodyBytes') && item.clampedBy === 'assistant.diagnostics.maxTraceBytes' && item.effectiveLimit === 1000));
  assert.ok(warnings.some((item) => item.settingPath.endsWith('maxTraceBytes') && item.clampedBy === 'assistant.diagnostics.maxStoredBytes'));
});
