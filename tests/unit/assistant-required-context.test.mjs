import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
function harness(overrides = {}) {
  const scope = vm.createContext({
    Buffer, Date, Set, Map, uniqueStrings: (values) => [...new Set(values)],
    normalizeAssistantRuntimeConfig: (config) => config, hashJson: () => 'revision',
    truncateText: (value, limit) => String(value).slice(0, limit),
    DEFAULT_ASSISTANT_MCP_MAX_CONTEXT_BYTES: 100000,
    pickBooleans: (item, keys) => Object.fromEntries(keys.filter((key) => typeof item[key] === 'boolean').map((key) => [key, item[key]])),
    ...overrides
  });
  for (const name of [
    'assistantFinalizeSemanticContext', 'assistantSemanticPlanError', 'isCmdbuildIdentifierText',
    'assistantMcpResult', 'assistantObjectFlowMcpPayload', 'assistantLimitDiagnostic',
    'addAssistantLimitDiagnostics', 'assistantLimitDiagnosticKey',
    'boundedMcpText', 'compactMcpValue', 'mcpResultEnvelope',
    'assistantReferencePathHintsFromBlock', 'assistantReferencePathSegments',
    'assistantMcpPreferredFieldMatches', 'assistantReferenceTargetClass', 'normalizedAssistantLookupText',
    'cmdbuildClassAttributesPath', 'responseDataArray', 'sanitizeVisibleClassAttributes', 'sanitizeAttribute',
    'assistantClassMetadataReadable', 'assistantClassMetadataSummary'
  ]) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(match, name);
    vm.runInContext(source.slice(match.index, source.indexOf('\n}\n', match.index) + 3), scope);
  }
  return scope;
}

const config = (maxClasses = 8, maxContextBytes = 32768) => ({ mcp: {
  enabled: true, maxClasses, maxContextBytes, timeoutMs: 1000,
  allowedTools: ['cmdbuild_model_summary', 'cmdbuild_class_fields']
} });
const bindings = (names) => names.map((className, index) => ({ className, blockId: `b${index}`, blockName: `Result ${index}` }));
const intent = { blocks: [{ id: 'b0', algorithm: '' }, { id: 'b1', algorithm: '' }] };
function context(names, attributes = {}) {
  return { diagnostics: { contextClassNames: names, limits: [], relationPaths: [] }, results: [
    { tool: 'cmdbuild_model_summary', ok: true, result: { classes: names.map((name) => ({ name })), domains: [] } },
    { tool: 'cmdbuild_class_fields', ok: true, result: names.map((className) => ({ className, attributes: attributes[className] || [{ name: `${className}Field`, type: 'string' }] })) }
  ] };
}

test('required classes exceeding the budget fail explicitly without evicting a binding', async () => {
  const mcp = context(['Existing', 'NewAsset']);
  await assert.rejects(harness().assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing', 'NewAsset']), config(1)), (error) => {
    assert.equal(error.details[0].kind, 'semanticPlanContextIncomplete');
    assert.equal(error.details[0].reason, 'maxClasses');
    assert.equal(error.details[0].requiredCount, 2);
    assert.equal(error.details[0].effectiveLimit, 1);
    assert.equal(error.details[0].settingPath, 'assistant.mcp.maxClasses');
    assert.equal(error.details.length, 2);
    return true;
  });
  assert.deepEqual(mcp.diagnostics.contextClassNames, ['Existing', 'NewAsset']);
});

test('required classes displace optional candidates, never each other or their attributes', async () => {
  const mcp = context(['Optional', 'Existing', 'NewAsset']);
  await harness().assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing', 'NewAsset']), config(2), { allowReads: false });
  const payload = JSON.parse(mcp.text);
  assert.deepEqual(payload.classes.map((item) => item.name), ['Existing', 'NewAsset']);
  assert.deepEqual(payload.classFields.flatMap((item) => item.attributes.map((field) => field.name)), ['ExistingField', 'NewAssetField']);
  assert.equal(payload.complete, true);
  assert.equal(mcp.diagnostics.semanticContext.complete, true);
  assert.equal(mcp.diagnostics.excludedOptionalClassNames.join(','), 'Optional');
});

test('byte limit rejects a clipped required field before it can reach LiteLLM', async () => {
  const mcp = context(['Existing'], { Existing: [{ name: 'Important', description: 'x'.repeat(10000) }] });
  await assert.rejects(harness().assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing']), config(8, 2048)), (error) => {
    assert.equal(error.details[0].reason, 'maxContextBytes');
    assert.equal(error.details[0].settingPath, 'assistant.mcp.maxContextBytes');
    assert.equal(error.diagnostics.mcp.semanticContext.complete, false);
    return true;
  });
});

test('optional byte-heavy context can be removed without clipping required fields', async () => {
  const mcp = context(['Existing', 'Optional'], { Optional: [{ name: 'Extra', description: 'x'.repeat(10000) }] });
  await harness().assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing']), config(8, 2048), { allowReads: false });
  assert.equal(JSON.parse(mcp.text).complete, true);
  assert.ok(mcp.text.includes('ExistingField'));
  assert.ok(!mcp.text.includes('Extra'));
});

test('cached contexts require readable metadata and fields for every accepted binding', async () => {
  const mcp = context(['Existing']);
  mcp.results[1].result = [];
  await assert.rejects(harness().assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing']), config(), { allowReads: false }), (error) => error.details[0].reason === 'missingFields');
});

test('explicit reference target classes and confirmed domain path classes are mandatory', async () => {
  const mcp = context(['Existing', 'Target', 'Middle'], { Existing: [{ name: 'address', type: 'reference', targetClass: 'Target' }] });
  mcp.diagnostics.relationPaths = [{ sourceRoot: 'Existing', targetRoot: 'Target', sourceClass: 'Existing', targetClass: 'Middle', domain: 'Relation' }];
  await harness().assistantFinalizeSemanticContext({ blocks: [{ id: 'b0', algorithm: 'Compare "address.Value".' }] }, mcp, bindings(['Existing']), config(), { allowReads: false });
  assert.equal(mcp.diagnostics.requiredClassNames.join(','), 'Existing,Target,Middle');
  assert.ok(JSON.parse(mcp.text).classFields.some((item) => item.className === 'Middle'));
});

test('required metadata reads respect the same session, permission and deadline budgets', async () => {
  let calls = 0;
  const scope = harness({ cmdbuildRequest: async (path, token, options) => {
    calls += 1;
    assert.equal(token, 'test-session');
    assert.ok(options.deadlineAt > Date.now());
    return { ok: false, statusCode: 403 };
  } });
  const mcp = context(['Existing']);
  mcp.results[1].result = [];
  await assert.rejects(scope.assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing']), config(), { authToken: 'test-session', deadlineAt: Date.now() + 1000 }), (error) => error.details[0].reason === 'permission');
  assert.equal(calls, 1);
  await assert.rejects(scope.assistantFinalizeSemanticContext(intent, mcp, bindings(['Existing']), config(), { deadlineAt: Date.now() - 1 }), (error) => error.details[0].reason === 'timeout');
  assert.equal(calls, 1);
});

test('mandatory reference hydration cannot bypass configured depth and ignores dotted literal values', async () => {
  const mcp = context(['Existing', 'Target', 'Nested'], {
    Existing: [{ name: 'address', type: 'reference', targetClass: 'Target' }],
    Target: [{ name: 'owner', type: 'reference', targetClass: 'Nested' }]
  });
  const cfg = { ...config(), semanticPlan: { maxReferencePathDepth: 1 } };
  await assert.rejects(harness().assistantFinalizeSemanticContext({ blocks: [{ id: 'b0', algorithm: 'Compare "address.owner.Value".' }] }, mcp, bindings(['Existing']), cfg, { allowReads: false }),
    (error) => error.details[0].reason === 'maxReferencePathDepth' && error.details[0].settingPath === 'assistant.semanticPlan.maxReferencePathDepth');
  await harness().assistantFinalizeSemanticContext({ blocks: [{ id: 'b0', algorithm: 'Use "192.168.0.1".' }] }, mcp, bindings(['Existing']), cfg, { allowReads: false });
  assert.equal(mcp.diagnostics.requiredClassNames.join(','), 'Existing');
});
