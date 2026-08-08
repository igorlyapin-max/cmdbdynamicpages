import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const launcherSource = fs.readFileSync('src/CmdbDynamicPages.js', 'utf8');
const proxySource = fs.readFileSync('scripts/dev-proxy-server.mjs', 'utf8');
const buildIdentitySource = fs.readFileSync('scripts/build-identity.mjs', 'utf8');
const envExampleSource = fs.readFileSync('.env.example', 'utf8');
const nginxSource = fs.readFileSync('nginx/cmdbdynamicpages.conf', 'utf8');

test('About screen receives the embedded application build identity', () => {
  assert.match(buildIdentitySource, /const APPLICATION_VERSION_FALLBACK = '0\.0\.0\.0';/);
  assert.match(proxySource, /const APPLICATION_BUILD_IDENTITY = readApplicationBuildIdentity\(\);/);
  assert.match(proxySource, /appVersion: APPLICATION_VERSION/);
  assert.match(proxySource, /build: APPLICATION_BUILD/);
  assert.match(proxySource, /appVersion: 'Version'/);
  assert.match(proxySource, /appVersion: 'Версия'/);
  assert.match(proxySource, /data-app-version/);
  assert.match(proxySource, /data-app-revision/);
  assert.match(proxySource, /data-app-provenance/);
  assert.match(proxySource, /data-app-editor-sha256/);
});

test('Assistant browser deadline follows the configured MCP timeout with backend response grace', () => {
  const helperStart = proxySource.indexOf('function assistantRequestTimeoutMs(backendPhases)');
  const helperEnd = proxySource.indexOf('function publicSnapshotRunPath', helperStart);
  const helperSource = proxySource.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0, 'Assistant timeout helper is missing.');
  assert.match(helperSource, /assistant\.mcp\.timeoutMs/);
  assert.match(helperSource, /boot\.assistantMcpCaps/);
  assert.match(helperSource, /boot\.assistantTimeoutGraceMs/);
  assert.match(helperSource, /backendTimeout \* phases \+ grace/);
  const diagramAssistantStart = proxySource.indexOf('function assistantDiagramRequest(kind)');
  const diagramAssistantEnd = proxySource.indexOf('function assistantFlowStageSummaries', diagramAssistantStart);
  const diagramAssistantSource = proxySource.slice(diagramAssistantStart, diagramAssistantEnd);
  assert.ok(diagramAssistantStart >= 0, 'Diagram Assistant request helper is missing.');
  assert.ok(diagramAssistantEnd > diagramAssistantStart, 'Diagram Assistant request helper boundary is missing.');
  assert.match(diagramAssistantSource, /\/assistant\/diagram-import\//);
  assert.match(diagramAssistantSource, /map-selections/);
  assert.match(proxySource, /function assistantDiagramRequestAttemptCount\(kind\)/);
  assert.match(proxySource, /boot\.assistantDiagramMaxAttempts/);
  assert.match(proxySource, /function assistantDiagramMappingStageAttemptCount\(stage\)/);
  assert.match(proxySource, /function assistantDiagramMappingStageAutoRetryCount\(stage\)/);
  assert.match(proxySource, /function assistantDiagramMappingStageCorrectionRetryCount\(stage\)/);
  assert.match(proxySource, /function assistantDiagramMappingStageRetryBudget\(stage\)/);
  assert.match(proxySource, /function assistantDiagramMappingStageTimeoutMs\(stage\)/);
  assert.match(proxySource, /retries are separate checkpointed requests\.[\s\S]*return 1;/);
  assert.match(proxySource, /boot\.assistantDiagramStageAutoRetries/);
  assert.match(proxySource, /boot\.assistantDiagramStageCorrectionRetries/);
  assert.match(diagramAssistantSource, /var attemptCount = assistantDiagramRequestAttemptCount\(kind\)/);
  assert.match(diagramAssistantSource, /timeoutMs: assistantRequestTimeoutMs\(attemptCount\)/);
  assert.match(diagramAssistantSource, /timeoutMs: assistantDiagramMappingStageTimeoutMs\(stage\)/);
  assert.match(diagramAssistantSource, /stage: stage, resumeId: mappingResumeId/);
  assert.match(diagramAssistantSource, /Number\(result\.status \|\| 0\) === 202/);
  assert.match(proxySource, /assistantDiagramStageMaxAttempts: \{/);
  assert.match(proxySource, /roles: ASSISTANT_DIAGRAM_MAPPING_STAGE_MAX_ATTEMPTS/);
  assert.match(proxySource, /topology: ASSISTANT_DIAGRAM_MAPPING_STAGE_MAX_ATTEMPTS/);
  assert.match(proxySource, /roles: ASSISTANT_DIAGRAM_MAPPING_STAGE_AUTO_RETRIES/);
  assert.match(proxySource, /topology: ASSISTANT_DIAGRAM_MAPPING_STAGE_AUTO_RETRIES/);
  assert.match(proxySource, /roles: ASSISTANT_DIAGRAM_MAPPING_STAGE_CORRECTION_RETRIES/);
  assert.match(proxySource, /topology: ASSISTANT_DIAGRAM_MAPPING_STAGE_CORRECTION_RETRIES/);
  assert.match(proxySource, /const ASSISTANT_DIAGRAM_MAPPING_STAGE_MAX_ATTEMPTS = 1/);
  assert.match(proxySource, /const ASSISTANT_DIAGRAM_MAPPING_STAGE_AUTO_RETRIES = 1/);
  assert.match(proxySource, /const ASSISTANT_DIAGRAM_MAPPING_STAGE_CORRECTION_RETRIES = 2/);
  assert.match(proxySource, /assistantDiagramMaxAttempts: \{/);
  assert.match(proxySource, /map: ASSISTANT_DIAGRAM_MAPPING_MAX_ATTEMPTS/);
  assert.match(proxySource, /interpret: ASSISTANT_DIAGRAM_INTERPRET_MAX_ATTEMPTS/);
  assert.ok(proxySource.includes('/assistant/diagram-import/interpret'), 'Diagram interpretation endpoint is missing.');
  assert.ok(proxySource.includes('/assistant/diagram-import/map-selections'), 'Diagram mapping endpoint is missing.');
  const semanticRouteStart = proxySource.indexOf('/assistant/object-flow/semantic-plan');
  assert.match(proxySource.slice(semanticRouteStart, semanticRouteStart + 600), /timeoutMs: assistantRequestTimeoutMs\(1\)/);
  const flowRouteStart = proxySource.indexOf('/assistant/object-flow/plan');
  assert.match(proxySource.slice(flowRouteStart, flowRouteStart + 900), /timeoutMs: assistantRequestTimeoutMs\(1\)/);
  assert.match(proxySource.slice(flowRouteStart, flowRouteStart + 900), /resumeId: resume\.resumeId/);
  assert.match(proxySource, /function setAssistantObjectFlowPlanRetryState/);
  assert.match(proxySource, /assistant-flow-generate-retry/);
  assert.match(proxySource, /const contextDeadlineAt = contextStartedAt \+ contextTimeoutMs/);
  assert.match(proxySource, /MCP context collection stopped after/);
  assert.doesNotMatch(proxySource, /CMDP_ASSISTANT_TIMEOUT_MS/);
  assert.match(proxySource, /function createRequestAbortContext\(req, res\)/);
  assert.match(proxySource, /assistant_request_cancelled/);
  assert.match(proxySource, /assistant\.diagram_mapping\.cancelled/);
  assert.match(proxySource, /assistant\.diagram_mapping\.failed/);
  assert.match(proxySource, /assistant\.diagram_mapping\.checkpoint\.saved/);
  assert.match(proxySource, /assistant-diagram-mapping/);
  assert.match(proxySource, /D2 mapping of connections needs a resumable deterministic correction/);
  assert.match(proxySource, /function assertAssistantDiagramMappingCheckpointSize\(checkpoint\)/);
  assert.match(proxySource, /assistant_diagram_mapping_checkpoint_too_large/);
  assert.match(proxySource, /CMDP_D2_IMPORT_ASSISTANT_CHECKPOINT_MAX_BYTES/);
  assert.match(proxySource, /await cacheDelete\('assistant-diagram-mapping', mappingCheckpointOptions\.key/);

  const previewHelperStart = proxySource.indexOf('function draftPreviewRequestTimeoutMs()');
  const previewHelperEnd = proxySource.indexOf('function publicSnapshotRunPath', previewHelperStart);
  const previewHelperSource = proxySource.slice(previewHelperStart, previewHelperEnd);
  assert.ok(previewHelperStart >= 0, 'Draft preview timeout helper is missing.');
  assert.match(previewHelperSource, /boot\.draftPreviewTimeoutMs/);
  assert.match(previewHelperSource, /boot\.draftPreviewUiGraceMs/);
  assert.match(previewHelperSource, /backendTimeout \+ grace/);
  assert.match(previewHelperSource, /function requestDraftPreview\(path, template, params, requestId\)/);
  assert.match(previewHelperSource, /timeoutMs: draftPreviewRequestTimeoutMs\(\)/);
  assert.match(previewHelperSource, /function draftPreviewErrorText\(error\)/);
  assert.match(previewHelperSource, /function draftPreviewResultErrorText\(result\)/);
  assert.match(previewHelperSource, /Number\(result\.status \|\| 0\) !== 504/);
  assert.match(previewHelperSource, /Request ID/);
  assert.match(proxySource, /function clientRequestId\(\)/);
  assert.match(proxySource, /'X-Request-ID': requestContext\.requestId/);
  assert.match(proxySource, /response\.headers\.get\('x-request-id'\)/);
  assert.equal((proxySource.match(/request\(apiPrefix \+ '\/draft\/preview/g) || []).length, 0, 'Draft preview must not use the generic 15s browser request helper.');
});

test('D2 mapping keeps one LiteLLM call inside each nginx-bounded HTTP stage', () => {
  const mappingStageStart = proxySource.indexOf("if (input.kind === 'mapping') {");
  const mappingStageEnd = proxySource.indexOf('async function createAssistantDiagramMappingRolesDraft', mappingStageStart);
  const mappingStageSource = proxySource.slice(mappingStageStart, mappingStageEnd);

  assert.ok(mappingStageStart >= 0, 'D2 mapping stage builder is missing.');
  assert.ok(mappingStageEnd > mappingStageStart, 'D2 mapping stage builder boundary is missing.');
  assert.match(mappingStageSource, /Mapping retries must use a separate HTTP request/);
  assert.doesNotMatch(mappingStageSource, /callAssistantDiagramStage\(retryInput/);
  assert.match(proxySource, /const ASSISTANT_DIAGRAM_MAPPING_STAGE_MAX_ATTEMPTS = 1/);
  assert.match(proxySource, /const ASSISTANT_DIAGRAM_MAPPING_STAGE_AUTO_RETRIES = 1/);
  assert.match(proxySource, /const ASSISTANT_DIAGRAM_MAPPING_STAGE_CORRECTION_RETRIES = 2/);
  assert.match(envExampleSource, /CMDP_NGINX_CUSTOM_API_READ_TIMEOUT=70s/);
  assert.match(nginxSource, /proxy_read_timeout \$\{CMDP_NGINX_CUSTOM_API_READ_TIMEOUT\}/);
});

function generatedDynamicPagesClientScript() {
  const start = proxySource.indexOf('function dynamicPagesClientScript()');
  const end = proxySource.indexOf('\nfunction readJsonBody', start);
  assert.ok(start > -1);
  assert.ok(end > start);
  const factorySource = proxySource
    .slice(start, end)
    .replace('function dynamicPagesClientScript()', 'return function dynamicPagesClientScript()');
  const factory = new Function(
    'DEFAULT_EMPTY_RESULT_TEXT',
    'DEFAULT_PERMISSION_DENIED_TEXT',
    'DEFAULT_TEMPLATE_CACHE_TTL_SEC',
    'D2_IMPORT_SEMANTIC_MODEL_REVISION',
    'D2_IMPORT_ENDPOINT_PROFILE_VERSION',
    'D2_IMPORT_STRUCTURE_TREE_VERSION',
    'D2_IMPORT_ANALYSIS_CHECKPOINT_VERSION',
    'D2_IMPORT_ASSISTANT_CHECKPOINT_VERSION',
    'ASSISTANT_PROMPT_CONTRACT_VERSION',
    'DEFAULT_ASSISTANT_SYSTEM_PROMPT',
    'DEFAULT_ASSISTANT_OBJECT_FLOW_PROMPT',
    'DEFAULT_ASSISTANT_OBJECT_FLOW_SEMANTIC_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_SEMANTICS_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_BINDING_INTENT_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_PLACEMENT_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_CONNECTIONS_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_CRITIQUE_PROMPT',
    factorySource
  );
  return factory('empty result', 'permission denied', 3600, 10, 1, 5, 1, 3, 3, 'assistant system prompt', 'object flow prompt', 'semantic plan prompt', 'diagram semantics prompt', 'diagram binding intent prompt', 'diagram placement prompt', 'diagram connections prompt', 'diagram critique prompt')();
}

test('generated Dynamic Pages client script parses as browser JavaScript', () => {
  const clientScript = generatedDynamicPagesClientScript();
  const stageSummaryStart = clientScript.indexOf('function assistantFlowStageSummaries(model, spec)');
  const stageSummaryEnd = clientScript.indexOf('function refreshAssistantGenerationElapsed()', stageSummaryStart);
  const stageSummarySource = clientScript.slice(stageSummaryStart, stageSummaryEnd);

  assert.match(clientScript, /function clearDiagramMappingRow\(button\)/);
  assert.match(clientScript, /function diagramImportStructureItemMappingClient\(role, existing, itemId\)/);
  assert.match(clientScript, /function diagramImportPlacementFiltersClient\(value\)/);
  assert.match(clientScript, /function diagramImportDirectionPolicyGroups\(unresolved\)/);
  assert.match(clientScript, /function diagramImportDirectionPolicyMetadataSnippet\(groups\)/);
  assert.match(clientScript, /function normalizeDiagramDirectionPolicyClient\(value\)/);
  assert.match(clientScript, /function diagramImportChildTemplateTokenClient\(token\)/);
  assert.match(clientScript, /function diagramImportChildLabelCandidates\(proposal, parentItem, spec\)/);
  assert.match(clientScript, /function diagramImportLabelTemplateCandidates\(role, spec, mapping, proposal, parentItem\)/);
  assert.match(clientScript, /function diagramTemplateParameterTokenRows\(spec\)/);
  assert.match(clientScript, /function diagramImportLabelTemplateHasUnterminatedPlaceholder\(template\)/);
  assert.match(clientScript, /function diagramImportCanonicalLabelTemplate\(template, candidates\)/);
  assert.match(clientScript, /function diagramImportEnsureRelatedTemplateFields\(mapping, template, candidates\)/);
  assert.match(clientScript, /function diagramImportIsUserVisibleLabelField\(value\)/);
  assert.match(clientScript, /function renderDiagramImportLabelAutocomplete\(input\)/);
  assert.match(clientScript, /data-action="diagram-import-label-token-select"/);
  assert.match(clientScript, /data-diagram-import-label-template/);
  assert.match(clientScript, /data-diagram-import-rule-field="labelTemplate"/);
  assert.match(clientScript, /Подпись связи/);
  assert.match(clientScript, /Поля сопоставления объектов и контейнеров/);
  assert.match(clientScript, /Правило принадлежит конкретной копии элемента в структуре/);
  assert.match(clientScript, /diagram-import-confirm-rule-contract/);
  assert.doesNotMatch(clientScript, /data-diagram-import-rule-field="labelField"/);
  assert.match(clientScript, /data-diagram-template-title/);
  assert.doesNotMatch(clientScript, /renderDiagramImportLabelSuggestions/);
  assert.match(clientScript, /var sourceDirectionPolicy = normalizeDiagramDirectionPolicyClient\(candidate\.directionPolicy\)/);
  assert.match(clientScript, /function diagramImportStructureTreeClient\(proposal\)/);
  assert.match(clientScript, /function renderDiagramImportStructureTree\(proposal, spec\)/);
  assert.match(clientScript, /function diagramImportStructureViewportSnapshot\(preferredItemId\)/);
  assert.match(clientScript, /function refreshDiagramImportStructureEditor\(proposal, spec, viewportSnapshot\)/);
  assert.match(clientScript, /function selectDiagramImportStructureItem\(target\)/);
  assert.match(clientScript, /function renderDiagramSvgContract\(diagram\)/);
  assert.match(clientScript, /data-diagram-import-materialization-ledger/);
  assert.match(clientScript, /Материализованные объекты диаграммы/);
  assert.match(clientScript, /Контракт выполнения mapping/);
  assert.match(clientScript, /data-diagram-svg-contract/);
  assert.match(clientScript, /data-diagram-structure-tree/);
  assert.match(clientScript, /diagramImportCollapsedStructureItemIds: \{\}/);
  assert.match(clientScript, /function toggleDiagramImportStructureTreeBranch\(itemId\)/);
  assert.match(clientScript, /function diagramImportStructureTreeExpandAncestorsClient\(tree, itemId, includeItem\)/);
  assert.match(clientScript, /data-action="diagram-structure-toggle"/);
  assert.match(clientScript, /aria-expanded="/);
  assert.match(clientScript, /data-diagram-import-placement-mapping/);
  assert.match(clientScript, /data-diagram-import-placement-field="materialization\.kind"/);
  assert.match(clientScript, /data-diagram-import-placement-field="materialization\.stageId"/);
  assert.match(clientScript, /data-diagram-import-placement-field="conditions\.ruleJoin"/);
  assert.doesNotMatch(clientScript, /data-diagram-structure-field="sourceStageOverrideId"/);
  assert.match(clientScript, /data-diagram-structure-field="parentId"/);
  assert.match(clientScript, /data-diagram-structure-tree-drag/);
  assert.match(clientScript, /aria-keyshortcuts="Control\+ArrowUp Control\+ArrowDown"/);
  assert.match(clientScript, /aria-controls="cmdp-diagram-import-panel-/);
  assert.match(clientScript, /function focusDiagramImportEditorTab\(tab\)/);
  assert.match(clientScript, /function focusDiagramImportStructureHandle\(itemId\)/);
  assert.match(clientScript, /canvas\.addEventListener\('keydown'/);
  assert.match(clientScript, /if \(!identity\.hasIdentity \|\| !identity\.matches\)/);
  assert.match(clientScript, /не имеют identity исходника и не были наложены/);
  assert.doesNotMatch(clientScript, /diagramImportMergeLegacyRoleMappingClient/);
  assert.doesNotMatch(clientScript, /role\.mapping = diagramImportRoleMapping\(role,/);
  assert.doesNotMatch(clientScript, /renderDiagramImportNodeMappings\(proposal, spec\)/);
  assert.doesNotMatch(clientScript, /cmdp-diagram-import-tab-nodes/);
  assert.match(stageSummarySource, /flowOperations\(model\)\.forEach\(function \(operation, index\)/);
  assert.match(clientScript, /\[429, 502, 503, 504\]/);
  assert.match(clientScript, /var maxRetries = method === 'GET'/);
  assert.doesNotThrow(() => {
    new vm.Script(clientScript, { filename: 'dynamic-pages-client.js' });
  });
});

test('D2 runtime preview revisions include the full request and execute the latest queued preview', async () => {
  const clientScript = generatedDynamicPagesClientScript();
  const snapshotStart = clientScript.indexOf('function diagramImportRuntimePreviewRequestSnapshot(options)');
  const snapshotEnd = clientScript.indexOf('function openDiagramImportPreviewWorkspace()', snapshotStart);
  const previewStart = clientScript.indexOf('function runDiagramImportRuntimePreview(options)');
  const previewEnd = clientScript.indexOf('function previewCurrentDiagramImport()', previewStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, 'D2 preview snapshot helpers are missing.');
  assert.ok(previewStart >= 0 && previewEnd > previewStart, 'D2 preview runtime helper is missing.');

  const snapshotState = {
    selectedTemplate: { specHash: 'saved-v1' }
  };
  const snapshotHelpers = new Function(
    'state',
    'cloneJsonValue',
    'readRunParams',
    'stableClientJsonStringify',
    'currentDiagramImportPreviewTemplate',
    'authoringPreviewMaxRows',
    `${clientScript.slice(snapshotStart, snapshotEnd)}\nreturn { diagramImportRuntimePreviewRequestSnapshot, currentDiagramImportRuntimePreviewRevision, queueDiagramImportRuntimePreview };`
  )(
    snapshotState,
    (value) => structuredClone(value),
    () => ({ isName: 'first' }),
    (value) => JSON.stringify(value),
    () => ({ code: 'testtemplate', spec: { authoring: { d2: { source: 'source-a' } } } }),
    () => 100
  );
  const firstSnapshot = snapshotHelpers.diagramImportRuntimePreviewRequestSnapshot({ mode: 'intermediate' });
  const secondSnapshot = snapshotHelpers.diagramImportRuntimePreviewRequestSnapshot({
    mode: 'intermediate',
    params: { isName: 'second' }
  });
  assert.equal(firstSnapshot.template.expectedSpecHash, 'saved-v1');
  assert.notEqual(firstSnapshot.revision, secondSnapshot.revision);
  snapshotHelpers.queueDiagramImportRuntimePreview(firstSnapshot);
  firstSnapshot.params.isName = 'mutated-after-queue';
  assert.equal(snapshotState.diagramImportRuntimePreviewQueued.params.isName, 'first');

  const state = {
    selectedTemplate: { code: 'testtemplate' },
    diagramImportRuntimePreviewBusy: false,
    diagramImportRuntimePreviewQueued: null,
    diagramImportAppliedPendingPreview: false,
    lastDraftPreviewOk: false,
    currentPreviewRevision: 'first'
  };
  let firstResolve;
  const firstRequest = new Promise((resolve) => { firstResolve = resolve; });
  const requestedSources = [];
  let nextRequestId = 0;
  const runtimePreview = new Function(
    'state',
    'diagramImportRuntimePreviewRequestSnapshot',
    'templateAuthoringClient',
    't',
    'renderDesigner',
    'queueDiagramImportRuntimePreview',
    'clientRequestId',
    'startDiagramImportRuntimePreviewTimer',
    'requestDraftPreview',
    'currentDiagramImportRuntimePreviewRevision',
    'diagramImportRuntimePreviewDetails',
    'draftPreviewResultErrorText',
    'draftPreviewErrorText',
    'stopDiagramImportRuntimePreviewTimer',
    'apiPrefix',
    'authoringPreviewPath',
    `${clientScript.slice(previewStart, previewEnd)}\nreturn { runDiagramImportRuntimePreview };`
  )(
    state,
    () => { throw new Error('A supplied request snapshot is required for this test.'); },
    (spec) => spec.authoring,
    (key) => key,
    () => {},
    (snapshot) => {
      state.diagramImportRuntimePreviewQueued = {
        mode: snapshot.mode,
        template: structuredClone(snapshot.template),
        params: structuredClone(snapshot.params),
        revision: snapshot.revision
      };
    },
    () => `request-${++nextRequestId}`,
    () => {},
    (_path, template) => {
      requestedSources.push(template.spec.authoring.d2.source);
      return requestedSources.length === 1 ? firstRequest : Promise.resolve({ ok: true, marker: 'latest' });
    },
    () => state.currentPreviewRevision,
    () => ({ ready: true, partial: false, diagrams: [{}], message: '' }),
    () => 'preview failed',
    () => 'preview failed',
    () => {},
    '/cmdbuild/custom-api',
    () => '/cmdbuild/custom-api/draft/preview?maxRows=100&executionScope=diagrams'
  );
  const first = {
    mode: 'applied',
    revision: 'first',
    params: { isName: 'first' },
    template: { code: 'testtemplate', spec: { authoring: { d2: { source: 'source-a' } } } }
  };
  const latest = {
    mode: 'applied',
    revision: 'latest',
    params: { isName: 'latest' },
    template: { code: 'testtemplate', spec: { authoring: { d2: { source: 'source-b' } } } }
  };
  const firstRun = runtimePreview.runDiagramImportRuntimePreview({ requestSnapshot: first });
  state.currentPreviewRevision = latest.revision;
  await runtimePreview.runDiagramImportRuntimePreview({ requestSnapshot: latest });
  firstResolve({ ok: true, marker: 'stale' });
  await firstRun;

  assert.deepEqual(requestedSources, ['source-a', 'source-b']);
  assert.equal(state.diagramImportRuntimePreview.marker, 'latest');
  assert.equal(state.diagramImportRuntimePreviewBusy, false);
  assert.equal(state.diagramImportRuntimePreviewQueued, null);
});

test('D2 label template keeps related binding identifiers internal', () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helperStart = clientScript.indexOf('function diagramImportPrimaryLabelTemplateClient(primary, fallback)');
  const helperEnd = clientScript.indexOf('function diagramImportStageRows(spec)', helperStart);
  assert.ok(helperStart >= 0, 'D2 label-template helpers are missing.');
  assert.ok(helperEnd > helperStart, 'D2 label-template helper boundary is missing.');
  const helpers = new Function(
    'state',
    'uniqueList',
    'catalogAttributeOptions',
    'diagramImportStageById',
    'diagramImportStageFieldDisplayLabel',
    'diagramImportFieldDisplayLabel',
    'diagramImportClassDisplayLabel',
    'catalogDomains',
    'diagramImportCatalogDisplayLabel',
    'diagramTemplateParameterTokenRows',
    'userFacingResultLabel',
    't',
    'diagramImportRoleVisualKindClient',
    `${clientScript.slice(helperStart, helperEnd)}\nreturn { diagramImportLabelTemplateCandidates, diagramImportLabelTemplateHasUnterminatedPlaceholder, diagramImportDisplayLabelTemplate, diagramImportCanonicalLabelTemplate, diagramImportEnsureRelatedTemplateFields };`
  )(
    { diagramImportLabelTemplateDrafts: {}, diagramImportLabelTemplateErrors: {} },
    (values) => [...new Set((values || []).filter(Boolean))],
    (className) => className === 'IpAddress'
      ? [{ name: 'ipAddr' }, { name: 'Id' }, { name: '_id' }]
      : [{ name: 'Code' }, { name: 'Description' }, { name: 'Id' }, { name: '_id' }, { name: 'Class' }],
    () => ({ columns: ['Code', 'Description', 'Id', '_id', 'Class'] }),
    (_stage, field) => String(field || ''),
    (_className, field) => field,
    (className) => className,
    () => [],
    (name) => name,
    (spec) => Object.keys(spec && spec.params || {}).sort().map((name) => ({ value: `param.${name}`, label: `Параметр: ${name}` })),
    (value) => String(value || ''),
    (key, values = {}) => `${values.className || ''} ${values.path || ''} ${values.field || ''}`.trim() || key,
    (role) => String(role && role.visualKind || 'node')
  );
  const mapping = {
    materialization: { kind: 'stage', stageId: 'selection:arm' },
    primary: { className: 'ARM', structuredFields: [] },
    related: [{
      id: 'related_comparison_abc123',
      stageId: 'ipaddress',
      className: 'IpAddress',
      path: [{ kind: 'reference', name: 'ipaddress', targetClass: 'IpAddress' }],
      structuredFields: []
    }]
  };
  const role = { id: 'workstation', labelTemplate: '${related_comparison_abc123.ipAddr}' };
  const candidates = helpers.diagramImportLabelTemplateCandidates(role, { params: { system: { type: 'string' } } }, mapping);
  const related = candidates.find((candidate) => candidate.kind === 'related' && candidate.relatedField === 'ipAddr');

  assert.equal(related.displayToken, 'related.ipaddress.ipAddr');
  assert.equal(related.canonicalToken, 'related_comparison_abc123.ipAddr');
  assert.equal(candidates.some((candidate) => ['_id', 'Id', 'Class'].includes(candidate.displayToken)), false);
  assert.deepEqual(candidates.find((candidate) => candidate.kind === 'param'), {
    kind: 'param',
    displayToken: 'param.system',
    canonicalToken: 'param.system',
    label: 'Параметр: system'
  });
  assert.equal(helpers.diagramImportDisplayLabelTemplate('${related_comparison_abc123.ipAddr}', candidates).value, '${related.ipaddress.ipAddr}');
  const canonical = helpers.diagramImportCanonicalLabelTemplate('${related.ipaddress.ipAddr}', candidates);
  assert.deepEqual(canonical.errors, []);
  assert.equal(canonical.value, '${related_comparison_abc123.ipAddr}');
  assert.equal(helpers.diagramImportLabelTemplateHasUnterminatedPlaceholder('${Code'), true);
  assert.deepEqual(helpers.diagramImportDisplayLabelTemplate('${Code', candidates).errors, ['diagramImportLabelTemplateInvalid']);
  assert.deepEqual(helpers.diagramImportCanonicalLabelTemplate('${Code', candidates).errors, ['diagramImportLabelTemplateInvalid']);
  helpers.diagramImportEnsureRelatedTemplateFields(mapping, canonical.value, candidates);
  assert.deepEqual(mapping.related[0].structuredFields, ['ipAddr']);
});

test('D2 label template heading names the selected Object Flow result', () => {
  const clientScript = generatedDynamicPagesClientScript();
  assert.match(clientScript, /diagramImportLabelTemplateForResult: 'Composite label template for result fields "\{sourceName\}"'/);
  assert.match(clientScript, /diagramImportLabelTemplateForParentCard: 'Composite label template for parent branch card fields "\{sourceName\}"'/);
  assert.match(clientScript, /diagramImportLabelTemplateForStructural: 'Composite label template for a static container'/);
  const helperStart = clientScript.indexOf('function diagramImportLabelTemplateLabel(sourceInfo, materializationKind, spec)');
  const helperEnd = clientScript.indexOf('function diagramImportFieldDisplayLabel(className, fieldName)', helperStart);
  assert.ok(helperStart >= 0, 'D2 label-template source helper is missing.');
  assert.ok(helperEnd > helperStart, 'D2 label-template source helper boundary is missing.');
  const helpers = new Function(
    'userFacingResultLabel',
    'defaultSpec',
    't',
    `${clientScript.slice(helperStart, helperEnd)}\nreturn { diagramImportLabelTemplateLabel };`
  )(
    (alias) => ({ 'selection:vlan': 'Результат 2' })[alias] || alias,
    () => ({}),
    (key, values = {}) => ({
      diagramImportLabelTemplateForResult: `Составной label template полей результата «${values.sourceName}»`,
      diagramImportLabelTemplateForParentCard: `Составной label template полей карточки родительской ветви «${values.sourceName}»`,
      diagramImportLabelTemplateForStructural: 'Составной label template статического контейнера',
      diagramImportLabelTemplateForSource: 'Составной label template выбранного источника'
    })[key] || key
  );
  const source = { stageId: 'selection:vlan', stage: { alias: 'selection:vlan', label: 'Результат 2' } };
  const aliasOnly = { stageId: 'selection:vlan', stage: { alias: 'selection:vlan' } };

  assert.equal(helpers.diagramImportLabelTemplateLabel(source, 'stage', {}), 'Составной label template полей результата «Результат 2»');
  assert.equal(helpers.diagramImportLabelTemplateLabel(aliasOnly, 'stage', {}), 'Составной label template полей результата «Результат 2»');
  assert.equal(helpers.diagramImportLabelTemplateLabel(source, 'parentCard', {}), 'Составной label template полей карточки родительской ветви «Результат 2»');
  assert.equal(helpers.diagramImportLabelTemplateLabel({}, 'structural', {}), 'Составной label template статического контейнера');
  assert.equal(helpers.diagramImportLabelTemplateLabel({}, '', {}), 'Составной label template выбранного источника');
});

test('client-side D2 diagnostics validate item-owned mappings and matching conditions', () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helpersStart = clientScript.indexOf('function diagramImportStructureTreeContextCatalogClient(proposal)');
  const helpersEnd = clientScript.indexOf('\n  function renderDiagramImportStructureTreeRoleOptions', helpersStart);
  assert.ok(helpersStart >= 0, 'D2 structure-tree helper is missing.');
  assert.ok(helpersEnd > helpersStart, 'D2 structure-tree helper boundary is missing.');

  const helpers = new Function(
    'diagramImportRoleVisualKindClient',
    'diagramImportEffectiveSourceStageIdClient',
    'diagramImportNearestMaterializedAncestorClient',
    'diagramImportMaterializedStageForItemClient',
    'diagramImportStructureItemMappingClient',
    'diagramImportPlacementFiltersClient',
    'diagramImportStageById',
    'assistantFlowStageSummaries',
    'assistantFlowModel',
    'defaultSpec',
    'uniqueList',
    'diagramImportConditionStageFieldIsAvailable',
    'D2_IMPORT_STRUCTURE_TREE_VERSION',
    `${clientScript.slice(helpersStart, helpersEnd)}\nreturn { diagramImportStructureTreeClient, diagramImportStructureTreeIssuesClient };`
  )(
    (role) => String(role && role.visualKind || 'node'),
    (_role, item) => String(item && item.mapping && item.mapping.materialization && item.mapping.materialization.kind === 'stage' && item.mapping.materialization.stageId || ''),
    () => null,
    (_proposal, item, spec) => {
      const mapping = item && item.mapping || {};
      const materialization = mapping.materialization || {};
      const stageId = materialization.kind === 'stage' ? String(materialization.stageId || '') : '';
      return { mapping, stageId, stage: spec && spec.stages && spec.stages[stageId] || {}, inherited: false };
    },
    (role, value, itemId) => ({
      ...(value || {}),
      id: String(value && value.id || `mapping:${itemId}`),
      roleId: String(role && role.id || ''),
      materialization: { ...((value && value.materialization) || (String(role && role.visualKind || 'node') === 'container' ? { kind: 'structural', stageId: '' } : { kind: 'stage', stageId: '' })) },
      primary: { ...((value && value.primary) || {}) },
      conditions: value && value.conditions || { ruleJoin: 'any', rules: [] },
      related: Array.isArray(value && value.related) ? value.related : []
    }),
    (value) => value && value.rules ? value : { ruleJoin: 'any', rules: [] },
    (spec, stageId) => spec && spec.stages && spec.stages[stageId] || null,
    (_model, spec) => Object.entries(spec && spec.stages || {}).map(([id, stage]) => ({ id, ...stage })),
    () => ({}),
    () => ({}),
    (values) => [...new Set((values || []).filter(Boolean))],
    (_spec, _stageId, fieldName) => String(fieldName || '') === 'Code',
    5
  );
  const proposal = {
    version: 3,
    roles: [
      { id: 'role:group', visualKind: 'container', elementKeys: ['root'] },
      { id: 'role:node', visualKind: 'node', elementKeys: ['root.node'] }
    ],
    templateGrammar: {
      contexts: [
        { key: 'context:group', roleId: 'role:group', parentContextKey: '', elementKeys: ['root'] },
        { key: 'context:node', roleId: 'role:node', parentContextKey: 'context:group', elementKeys: ['root.node'] }
      ]
    },
    structureTree: {
      version: 5,
      items: [
        { id: 'group', roleId: 'role:group', templateContextKey: 'context:group', templateElementKey: 'root', templateElementKeys: ['root'], parentId: '', mapping: { materialization: { kind: 'structural', stageId: '' } } },
        { id: 'node', roleId: 'role:node', templateContextKey: 'context:node', templateElementKey: 'root.node', templateElementKeys: ['root.node'], parentId: 'group', mapping: { materialization: { kind: 'stage', stageId: '' } } }
      ]
    }
  };

  const spec = { stages: { 'selection:nodes': { columns: ['Code'] } } };
  assert.deepEqual(helpers.diagramImportStructureTreeIssuesClient(proposal, spec), { node: 'Выберите результат Object Flow для этого элемента D2.' });
  proposal.structureTree.items[1].mapping.materialization.stageId = 'selection:nodes';
  assert.deepEqual(helpers.diagramImportStructureTreeIssuesClient(proposal, spec), {});

  proposal.structureTree.items[1].mapping.conditions = { ruleJoin: 'any', rules: [{ left: { column: 'Missing' }, right: { kind: 'literal', value: 'x' } }] };
  assert.equal(helpers.diagramImportStructureTreeIssuesClient(proposal, spec).node, 'Укажите доступные поля и правый операнд для каждого фильтра результата.');
  proposal.structureTree.items[1].mapping.conditions = { ruleJoin: 'any', rules: [] };

  proposal.structureTree.items[0].mapping = {
    materialization: { kind: 'stage', stageId: 'selection:nodes' },
    conditions: { ruleJoin: 'all', rules: [{ left: { column: 'Code' }, right: { kind: 'literal', value: 'group' } }] }
  };
  assert.deepEqual(helpers.diagramImportStructureTreeIssuesClient(proposal, spec), {});
  proposal.structureTree.items[0].mapping = {
    materialization: { kind: 'structural', stageId: '' },
    conditions: { ruleJoin: 'all', rules: [{ left: { column: 'Code' }, right: { kind: 'literal', value: 'group' } }] }
  };
  assert.equal(helpers.diagramImportStructureTreeIssuesClient(proposal, spec).group, 'Структурная рамка не имеет результата Object Flow и не может фильтровать данные.');
  proposal.structureTree.items[0].mapping.conditions = { ruleJoin: 'any', rules: [] };

  proposal.structureTree.items[0].parentId = 'node';
  assert.equal(helpers.diagramImportStructureTreeIssuesClient(proposal, spec).group, 'Узел D2 не может содержать дочерние элементы.');
  proposal.structureTree.items[0].parentId = '';
  proposal.structureTree.items[1].roleId = 'role:group';
  proposal.structureTree.items[1].templateElementKey = 'root';
  proposal.structureTree.items[0].parentId = 'node';
  assert.equal(helpers.diagramImportStructureTreeIssuesClient(proposal, spec).group, 'Элемент должен оставаться в разрешенной ветви D2 template.');
  assert.match(clientScript, /function renderDiagramImportRelationRules\(proposal, spec\)/);
  assert.match(clientScript, /data-diagram-import-rule-row/);
});

test('D2 placement filter candidates include readable catalog paths outside Object Flow columns', () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helpersStart = clientScript.indexOf('function diagramImportConditionSourceKeyClient(source)');
  const helpersEnd = clientScript.indexOf('\n  function renderDiagramImportPlacementConditionRow', helpersStart);
  assert.ok(helpersStart >= 0, 'D2 placement-filter field helper is missing.');
  assert.ok(helpersEnd > helpersStart, 'D2 placement-filter helper boundary is missing.');

  const helpers = new Function(
    'state',
    'diagramImportStageById',
    'diagramImportStageFieldDisplayLabel',
    'normalizeDiagramImportConditionCardSourceClient',
    'diagramImportUniqueStageCardSources',
    'diagramImportCurrentStageCardSource',
    'uniqueList',
    'catalogScopePathOptions',
    'escapeHtml',
    `${clientScript.slice(helpersStart, helpersEnd)}\nreturn { diagramImportConditionStageFieldCandidates, diagramImportConditionStageFieldOptions, diagramImportConditionStageFieldIsAvailable };`
  )(
    { catalogRevision: 1, diagramImportConditionCatalogFieldsCache: {} },
    (_spec, stageId) => stageId === 'relation:block_2'
      ? {
          id: stageId,
          className: 'vlan',
          columns: ['Code', 'Description'],
          cardSources: [
            { id: 'current', className: 'vlan', classColumn: 'Class', idColumn: '_id', label: 'Карточка результата' },
            { id: 'source:ipRange', className: 'ipRange', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Связанная карточка' }
          ]
        }
      : null,
    (_stage, fieldName) => String(fieldName || ''),
    (source) => source && source.className && source.classColumn && source.idColumn ? source : null,
    (values) => values || [],
    (className) => ({ id: 'current', className, classColumn: 'Class', idColumn: '_id', label: 'Карточка результата' }),
    (values) => [...new Set((values || []).filter(Boolean))],
    (className) => className === 'vlan'
      ? [
          { value: 'Code', label: 'Code' },
          { value: 'Description', label: 'Description' },
          { value: 'isNAT', label: 'NAT (isNAT)' },
          { value: 'ipaddress.ipAddr', label: 'IP address (ipaddress.ipAddr)' },
          { value: '{IpRangeVlanDomain:vlan}.isNAT', label: 'ipRange -> VLAN -> NAT ({IpRangeVlanDomain:vlan}.isNAT)' }
        ]
      : className === 'ipRange'
        ? [{ value: 'range', label: 'Range (range)' }]
      : [],
    (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  );

  const options = helpers.diagramImportConditionStageFieldOptions({}, 'relation:block_2', 'isNAT');
  const candidates = helpers.diagramImportConditionStageFieldCandidates({}, 'relation:block_2', 'isNAT');
  const catalogCandidates = helpers.diagramImportConditionStageFieldCandidates({}, 'relation:block_2', 'isNAT', null, true);
  assert.match(options, /Уже в результате/);
  assert.match(options, /Будет дочитано из CMDBuild/);
  assert.match(options, /value="isNAT" selected/);
  assert.doesNotMatch(options, /value="ipaddress\.ipAddr"/, 'Query-first fields must not eagerly render deep catalog options.');
  assert.doesNotMatch(options, /value="\{IpRangeVlanDomain:vlan\}\.isNAT"/, 'Query-first fields must not eagerly render domain paths.');
  assert.equal(candidates.catalog.some((field) => field.value === '{IpRangeVlanDomain:vlan}.isNAT'), false, 'D2 picker must defer deep catalog paths until a query asks for them.');
  assert.equal(catalogCandidates.catalog.filter((field) => field.value === '{IpRangeVlanDomain:vlan}.isNAT').length, 1);
  assert.equal(helpers.diagramImportConditionStageFieldIsAvailable({}, 'relation:block_2', 'isNAT'), true);
  assert.equal(helpers.diagramImportConditionStageFieldIsAvailable({}, 'relation:block_2', '{IpRangeVlanDomain:vlan}.isNAT'), true);
  assert.equal(helpers.diagramImportConditionStageFieldIsAvailable(
    {},
    'relation:block_2',
    'range',
    { id: 'source:ipRange', className: 'ipRange', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Связанная карточка' }
  ), true, 'Validation must accept a retained Object Flow card source selected by the author.');
  assert.equal(helpers.diagramImportConditionStageFieldIsAvailable({}, 'relation:block_2', 'missingField'), false);
});

test('query-first pickers retain Diagram field attributes and cap lazy suggestions', () => {
  const catalogMatchStart = proxySource.indexOf('function catalogFieldPickerMatches(options, selectedName, query)');
  const catalogPickerStart = proxySource.indexOf('function renderCatalogFieldPicker(fieldAttribute, selectedName, initialOptions, context)');
  const catalogOptionsStart = proxySource.indexOf('function catalogFieldPickerOptions(picker, query)', catalogPickerStart);
  const viewportPickerStart = proxySource.indexOf('function positionFieldPickerMenu(picker)', catalogOptionsStart);
  const viewportPickerEnd = proxySource.indexOf('function closeCatalogFieldPickers(except)', viewportPickerStart);
  const catalogHandlerEnd = proxySource.indexOf('function matchingLeftColumnOptions(', catalogOptionsStart);
  const hierarchyStart = proxySource.indexOf('function renderDiagramImportHierarchyConditionRow(conditions, childStageId, parentStageId, spec, index)');
  const hierarchyEnd = proxySource.indexOf('function diagramImportHierarchyStageLabel(', hierarchyStart);
  const relatedStart = proxySource.indexOf('function renderDiagramImportRelatedConditionRow(related, primaryStageId, spec, index)');
  const relatedEnd = proxySource.indexOf('function renderDiagramImportRelatedCorrelation(', relatedStart);
  const conditionMatchStart = proxySource.indexOf('function diagramImportConditionPickerMatches(spec, stageId, selectedName, selectedSource, query)');
  const conditionPickerStart = proxySource.indexOf('function renderDiagramImportConditionFieldPicker(spec, stageId, fieldAttribute, selectedName, selectedSource)');
  const conditionPickerEnd = proxySource.indexOf('function closeDiagramImportConditionFieldPickers(', conditionPickerStart);
  const conditionRefreshStart = proxySource.indexOf('function refreshDiagramImportConditionPickerResults(input)', conditionPickerEnd);
  const conditionRefreshEnd = proxySource.indexOf('function scheduleDiagramImportConditionPickerResults(input)', conditionRefreshStart);
  const conditionToggleStart = proxySource.indexOf('function toggleDiagramImportConditionFieldPicker(target)', conditionPickerEnd);
  const conditionToggleEnd = proxySource.indexOf('function selectDiagramImportConditionPickerField(target)', conditionToggleStart);
  const relationPathStart = proxySource.indexOf('function renderRelationPathPlanner(model, spec)');
  const relationPathEnd = proxySource.indexOf('function firstResultTable(', relationPathStart);
  const classicMappingStart = proxySource.indexOf('function renderDiagramFieldSelect(spec, sourceAlias, fieldName, selectedName)');
  const classicMappingEnd = proxySource.indexOf('function diagramFieldListFromValue(', classicMappingStart);
  const dataSelectionStart = proxySource.indexOf('function renderSelectionFilterRow(filter, step)');
  const dataSelectionEnd = proxySource.indexOf('function renderDataSelectionEditor(selected)', dataSelectionStart);
  const finalViewStart = proxySource.indexOf('function renderViewComposerColumnRow(column, spec, sourceAlias)');
  const finalViewEnd = proxySource.indexOf('function renderViewComposerEditor(', finalViewStart);
  const visualizationPickerStart = proxySource.indexOf('function renderVisualizationColumnPicker(fieldAttribute, selected, tableName, columns)');
  const visualizationPickerEnd = proxySource.indexOf('function renderVisualizationRowGroupRow(', visualizationPickerStart);
  const visualizationTableStart = proxySource.indexOf('function renderVisualizationTableRow(table, settings, spec)');
  const visualizationTableEnd = proxySource.indexOf('function renderVisualizationEditor(selected)', visualizationTableStart);
  assert.ok(catalogMatchStart >= 0, 'Shared picker match helper is missing.');
  assert.ok(catalogPickerStart > catalogMatchStart, 'Shared picker renderer is missing.');
  assert.ok(catalogOptionsStart > catalogPickerStart, 'Shared picker lazy option resolver is missing.');
  assert.ok(viewportPickerStart > catalogOptionsStart && viewportPickerEnd > viewportPickerStart, 'Shared viewport picker controller is missing.');
  assert.ok(catalogHandlerEnd > catalogOptionsStart, 'Shared picker handler boundary is missing.');
  assert.ok(hierarchyStart >= 0 && hierarchyEnd > hierarchyStart, 'Diagram hierarchy condition renderer is missing.');
  assert.ok(relatedStart >= 0 && relatedEnd > relatedStart, 'Diagram related-data condition renderer is missing.');
  assert.ok(conditionMatchStart >= 0 && conditionPickerStart > conditionMatchStart, 'D2 condition candidate matcher is missing.');
  assert.ok(conditionPickerStart >= 0 && conditionPickerEnd > conditionPickerStart, 'D2 condition picker renderer is missing.');
  assert.ok(conditionRefreshStart > conditionPickerEnd && conditionRefreshEnd > conditionRefreshStart, 'D2 condition query refresh is missing.');
  assert.ok(conditionToggleStart > conditionPickerEnd && conditionToggleEnd > conditionToggleStart, 'D2 condition picker lazy loader is missing.');
  assert.ok(relationPathStart >= 0 && relationPathEnd > relationPathStart, 'Relation path planner is missing.');
  assert.ok(classicMappingStart >= 0 && classicMappingEnd > classicMappingStart, 'Classic Diagram mapping field renderer is missing.');
  assert.ok(dataSelectionStart >= 0 && dataSelectionEnd > dataSelectionStart, 'Data selection field renderer is missing.');
  assert.ok(finalViewStart >= 0 && finalViewEnd > finalViewStart, 'Final View field renderer is missing.');
  assert.ok(visualizationPickerStart >= 0 && visualizationPickerEnd > visualizationPickerStart, 'Visualization column picker is missing.');
  assert.ok(visualizationTableStart >= 0 && visualizationTableEnd > visualizationTableStart, 'Visualization table renderer is missing.');

  const catalogMatchSource = proxySource.slice(catalogMatchStart, catalogPickerStart);
  const catalogPickerSource = proxySource.slice(catalogPickerStart, catalogOptionsStart);
  const catalogHandlerSource = proxySource.slice(catalogOptionsStart, catalogHandlerEnd);
  const viewportPickerSource = proxySource.slice(viewportPickerStart, viewportPickerEnd);
  const hierarchySource = proxySource.slice(hierarchyStart, hierarchyEnd);
  const relatedSource = proxySource.slice(relatedStart, relatedEnd);
  const conditionMatchSource = proxySource.slice(conditionMatchStart, conditionPickerStart);
  const conditionPickerSource = proxySource.slice(conditionPickerStart, conditionPickerEnd);
  const conditionRefreshSource = proxySource.slice(conditionRefreshStart, conditionRefreshEnd);
  const conditionToggleSource = proxySource.slice(conditionToggleStart, conditionToggleEnd);
  const relationPathSource = proxySource.slice(relationPathStart, relationPathEnd);
  const classicMappingSource = proxySource.slice(classicMappingStart, classicMappingEnd);
  const dataSelectionSource = proxySource.slice(dataSelectionStart, dataSelectionEnd);
  const finalViewSource = proxySource.slice(finalViewStart, finalViewEnd);
  const visualizationPickerSource = proxySource.slice(visualizationPickerStart, visualizationPickerEnd);
  const visualizationTableSource = proxySource.slice(visualizationTableStart, visualizationTableEnd);

  assert.match(catalogMatchSource, /function renderCatalogFieldPickerRows\(options, selectedName, query\)/);
  assert.match(catalogMatchSource, /matches\.slice\(0, 60\)/);
  assert.match(catalogPickerSource, /<input type="hidden" data-catalog-field-picker-value data-catalog-field-picker-selected-label="' \+ escapeHtml\(label\) \+ '" ' \+ fieldAttribute/);
  assert.match(catalogPickerSource, /data-catalog-field-picker-search/);
  assert.match(catalogPickerSource, /function renderCatalogFieldMultiPicker\(fieldAttribute, selectedNames, initialOptions, context\)/);
  assert.match(catalogPickerSource, /data-catalog-field-picker-multi-value/);
  assert.match(proxySource, /function catalogFieldPickerSelectedFieldValues\(field\)/);
  assert.match(catalogHandlerSource, /function catalogFieldPickerOptions\(picker, query\)/);
  assert.match(catalogHandlerSource, /function toggleCatalogFieldPicker\(target\)/);
  assert.match(catalogHandlerSource, /if \(!query\)[\s\S]*renderCatalogFieldPickerPrompt\(\)/);
  assert.match(catalogHandlerSource, /kind === 'selection'/);
  assert.match(catalogHandlerSource, /kind === 'visualization'/);
  assert.match(catalogHandlerSource, /kind === 'objectGroupSource'/);
  assert.match(viewportPickerSource, /window\.requestAnimationFrame/);
  assert.match(viewportPickerSource, /data-catalog-field-picker\], \[data-diagram-import-condition-picker/);
  assert.match(viewportPickerSource, /--field-picker-max-height/);
  assert.match(proxySource, /\.diagram-import-condition-picker-menu,\.catalog-field-picker-menu\{position:fixed/);
  assert.match(proxySource, /document\.addEventListener\('scroll', repositionOpenFieldPickers, true\)/);
  assert.match(conditionMatchSource, /\.slice\(0, 60\)/);
  assert.match(conditionPickerSource, /data-diagram-import-condition-picker-field ' \+ fieldAttribute/);
  assert.match(conditionPickerSource, /data-diagram-import-condition-picker-search/);
  assert.match(conditionPickerSource, /renderDiagramImportConditionPickerPrompt\(\)/);
  assert.match(conditionRefreshSource, /if \(!query\)[\s\S]*renderDiagramImportConditionPickerPrompt\(\)/);
  assert.match(conditionRefreshSource, /ensureDiagramImportConditionCatalogForStage\(spec, stageId\)/);
  assert.doesNotMatch(conditionToggleSource, /ensureDiagramImportConditionCatalogForStage/, 'Opening a query-first picker must not eagerly load catalog paths.');

  assert.match(hierarchySource, /renderDiagramImportConditionFieldPicker\(spec, childStageId, 'data-diagram-import-hierarchy-field="left\.column"/);
  assert.match(hierarchySource, /renderDiagramImportConditionFieldPicker\(spec, parentStageId, 'data-diagram-import-hierarchy-field="right\.column"/);
  assert.doesNotMatch(hierarchySource, /<select data-diagram-import-hierarchy-field="(?:left|right)\.column"/);
  assert.match(relatedSource, /renderDiagramImportConditionFieldPicker\(spec, related && related\.stageId \|\| '', 'data-diagram-import-related-condition-field="left\.column"/);
  assert.match(relatedSource, /renderDiagramImportConditionFieldPicker\(spec, primaryStageId, 'data-diagram-import-related-condition-field="right\.column"/);
  assert.doesNotMatch(relatedSource, /<select data-diagram-import-related-condition-field="(?:left|right)\.column"/);
  assert.match(relationPathSource, /renderCatalogFieldPicker\(\s*'data-relation-path'/);
  assert.match(classicMappingSource, /renderCatalogFieldPicker\(/);
  assert.match(classicMappingSource, /data-diagram-mapping-field/);
  assert.match(dataSelectionSource, /renderCatalogFieldPicker\(\s*'data-selection-filter-field="attribute"/);
  assert.doesNotMatch(dataSelectionSource, /<input data-selection-filter-field="attribute"/);
  assert.match(finalViewSource, /renderCatalogFieldPicker\(\s*'data-view-column-field="field"/);
  assert.match(visualizationPickerSource, /renderCatalogFieldPicker\(/);
  assert.match(visualizationTableSource, /renderVisualizationColumnPicker\('data-visualization-field="sortColumn"/);
  assert.match(visualizationTableSource, /renderVisualizationColumnPicker\('data-visualization-field="groupBy"/);
  assert.doesNotMatch(visualizationTableSource, /data-visualization-column-options/);
});

test('full catalog cache marks successful class attributes as loaded and retries catalog errors', () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helperStart = clientScript.indexOf('function applyCatalogCache(record)');
  const helperEnd = clientScript.indexOf('\n  function viewComposerCatalogClassNames', helperStart);
  assert.ok(helperStart >= 0, 'Catalog cache helper is missing.');
  assert.ok(helperEnd > helperStart, 'Catalog cache helper boundary is missing.');

  const state = {
    catalog: null,
    catalogRevision: 0,
    catalogScopePathOptionsCache: { stale: [] },
    diagramImportConditionCatalogFieldsCache: { stale: [] },
    catalogAttributeLoaded: {},
    catalogAttributeLoads: {},
    catalogAttributeFailedAt: { broken: 1 },
    catalogStatus: {},
    selectedClass: '',
    classAttributes: []
  };
  const helpers = new Function(
    'state',
    'CATALOG_FRESH_MS',
    'catalogClassByName',
    `${clientScript.slice(helperStart, helperEnd)}\nreturn { applyCatalogCache };`
  )(
    state,
    24 * 60 * 60 * 1000,
    (name) => (state.catalog && state.catalog.classes || []).find((item) => String(item.name).toLowerCase() === String(name).toLowerCase()) || null
  );

  helpers.applyCatalogCache({
    updatedAt: new Date().toISOString(),
    catalog: {
      limits: { includeAttributes: true },
      classes: [{ name: 'vlan', attributes: [] }, { name: 'broken', attributes: [] }],
      warnings: { attributeErrors: [{ className: 'broken', cmdbuildStatus: 403 }] }
    }
  });

  assert.equal(state.catalogAttributeLoaded.vlan, true);
  assert.equal(state.catalogAttributeLoaded.broken, undefined);
  assert.equal(state.catalogAttributeFailedAt.broken, 1);
  assert.deepEqual(state.catalogScopePathOptionsCache, {});
  assert.deepEqual(state.diagramImportConditionCatalogFieldsCache, {});
});

test('D2 placement filter catalog keeps a readable domain path at configured depth', () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helperStart = clientScript.indexOf('function catalogClassInheritsFrom(className, endpointClass)');
  const helperEnd = clientScript.indexOf('\n  function renderScopePathOptions', helperStart);
  assert.ok(helperStart >= 0, 'Catalog-path helper is missing.');
  assert.ok(helperEnd > helperStart, 'Catalog-path helper boundary is missing.');

  const classes = {
    ZabbixMonitoring: {
      name: 'ZabbixMonitoring', description: 'Monitoring object', attributes: []
    },
    ipRange: {
      name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', attributes: []
    },
    vlan: {
      name: 'vlan', description: 'VLAN', attributes: [{ name: 'isNAT', description: 'NAT', type: 'boolean' }]
    }
  };
  const domains = [{
    name: 'Vlan2super', description: 'Range to VLAN',
    sources: ['vlan'], destinations: ['ZabbixMonitoring'], cardinality: 'N:1'
  }];
  const state = { maxTraversalDepth: 3, catalogRevision: 1, catalogScopePathOptionsCache: {} };
  const helpers = new Function(
    'state',
    'catalogAttributeOptions',
    'catalogClasses',
    'catalogDomains',
    'catalogClassByName',
    'isReferenceAttribute',
    'domainSources',
    'domainDestinations',
    'uniqueCatalogStrings',
    `${clientScript.slice(helperStart, helperEnd)}\nreturn { catalogScopePathOptions };`
  )(
    state,
    (className) => classes[className] ? classes[className].attributes : [],
    () => Object.values(classes),
    () => domains,
    (className) => classes[className] || null,
    (attribute) => attribute && attribute.type === 'reference',
    (domain) => domain.sources || [],
    (domain) => domain.destinations || [],
    (values) => [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
  );

  const query = 'isNAT';
  const unopened = helpers.catalogScopePathOptions('ipRange');
  assert.equal(
    unopened.some((item) => item.value === '{Vlan2super:vlan}.isNAT'),
    false,
    'Opening a picker without a query must not traverse domain paths.'
  );
  const first = helpers.catalogScopePathOptions('ipRange', query);
  const second = helpers.catalogScopePathOptions('ipRange', query);
  assert.strictEqual(second, first, 'Same catalog revision, depth, and query must reuse traversal candidates.');
  const candidate = first.find((item) => item.value === '{Vlan2super:vlan}.isNAT');
  assert.ok(candidate);
  assert.match(candidate.label, /IP range -> VLAN -> NAT/);
  state.catalogRevision += 1;
  assert.notStrictEqual(helpers.catalogScopePathOptions('ipRange', query), first, 'Catalog revision must invalidate traversal candidates.');
});

test('D2 placement filter lazily loads every readable class on a deep catalog path', async () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helperStart = clientScript.indexOf('function ensureDiagramImportConditionCatalogForStage(spec, stageId)');
  const helperEnd = clientScript.indexOf('\n  function ensureDiagramImportConditionCatalogForItem', helperStart);
  assert.ok(helperStart >= 0, 'D2 condition catalog loader is missing.');
  assert.ok(helperEnd > helperStart, 'D2 condition catalog loader boundary is missing.');

  const classes = {
    ipRange: { name: 'ipRange', attributes: [] },
    vlan: { name: 'vlan', attributes: [] }
  };
  const attributesByClass = {
    ipRange: [],
    vlan: [{ name: 'isNAT', type: 'boolean' }]
  };
  const loaded = [];
  const helpers = new Function(
    'state',
    'diagramImportStageById',
    'defaultSpec',
    'catalogClassByName',
    'catalogDomains',
    'isReferenceAttribute',
    'domainRelatedClasses',
    'ensureCatalogAttributesForClass',
    'writeCatalogCache',
    'uniqueList',
    'diagramImportStageCardSourcesClient',
    'ensureDiagramImportConditionCatalogModel',
    `${clientScript.slice(helperStart, helperEnd)}\nreturn { ensureDiagramImportConditionCatalogForStage };`
  )(
    { maxTraversalDepth: 3, catalog: { classes: Object.values(classes), domains: [] } },
    (_spec, stageId) => stageId === 'selection:ranges' ? { id: stageId, className: 'ipRange' } : null,
    () => ({}),
    (className) => classes[className] || null,
    () => [{ name: 'IpRangeVlanDomain', sources: ['ipRange'], destinations: ['vlan'] }],
    (attribute) => attribute && attribute.type === 'reference',
    (domain, className) => domain.sources.includes(className) ? domain.destinations : domain.destinations.includes(className) ? domain.sources : [],
    async (className) => {
      loaded.push(className);
      classes[className].attributes = attributesByClass[className];
      return true;
    },
    async () => ({})
    ,
    (values) => [...new Set((values || []).filter(Boolean))],
    (stage) => [{ className: stage.className }],
    async () => false
  );

  assert.equal(await helpers.ensureDiagramImportConditionCatalogForStage({}, 'selection:ranges'), true);
  assert.deepEqual(loaded, ['ipRange', 'vlan']);
});

test('D2 placement filter refreshes a legacy catalog cache before offering deep domain fields', async () => {
  const clientScript = generatedDynamicPagesClientScript();
  const helperStart = clientScript.indexOf('function catalogHasResolvedDomainEndpoints()');
  const helperEnd = clientScript.indexOf('\n  function ensureDiagramImportConditionCatalogForStage', helperStart);
  assert.ok(helperStart >= 0, 'Catalog endpoint compatibility helper is missing.');
  assert.ok(helperEnd > helperStart, 'Catalog endpoint compatibility helper boundary is missing.');

  const state = {
    root: 'Cst_QueryTool',
    catalog: {
      classes: [{ name: 'ipRange', attributes: [] }],
      domains: [{ name: 'Vlan2super' }]
    }
  };
  let requests = 0;
  let persisted = 0;
  const helpers = new Function(
    'state',
    'uniqueList',
    'diagramImportUniqueStageCardSources',
    'diagramImportCurrentStageCardSource',
    'diagramImportStageCardSourcesClient',
    'catalogClasses',
    'catalogClassByName',
    'catalogDomains',
    'request',
    'apiPrefix',
    'errorText',
    'writeCatalogCache',
    'applyCatalogCache',
    't',
    'CATALOG_DOMAIN_ENDPOINTS_VERSION',
    `${clientScript.slice(helperStart, helperEnd)}\nreturn { catalogHasResolvedDomainEndpoints, ensureDiagramImportConditionCatalogModel };`
  )(
    state,
    (values) => [...new Set((values || []).filter(Boolean))],
    (values) => values || [],
    (className) => ({ id: 'current', className, classColumn: 'Class', idColumn: '_id', label: className }),
    () => [{ className: 'ipRange' }],
    () => state.catalog.classes,
    (className) => state.catalog.classes.find((item) => item.name === className) || null,
    () => state.catalog.domains,
    async (url) => {
      requests += 1;
      assert.match(url, /\/model\/catalog\?includeAttributes=true/);
      return {
        ok: true,
        json: {
          catalog: {
            classes: [{ name: 'ipRange', attributes: [] }, { name: 'vlan', attributes: [{ name: 'isNAT', type: 'boolean' }] }],
            domains: [{ name: 'Vlan2super', sources: ['vlan'], destinations: ['ipRange'] }],
            domainEndpoints: { version: 1, attempted: true, complete: true }
          }
        }
      };
    },
    '/cmdbuild/custom-api',
    (result) => String(result),
    async (catalog) => {
      persisted += 1;
      return { catalog };
    },
    (record) => { state.catalog = record.catalog; },
    (key) => key,
    1
  );

  assert.equal(helpers.catalogHasResolvedDomainEndpoints(), false);
  assert.equal(await helpers.ensureDiagramImportConditionCatalogModel({ id: 'relation:block-5', className: 'ipRange' }), true);
  assert.equal(requests, 1);
  assert.equal(persisted, 1);
  assert.equal(helpers.catalogHasResolvedDomainEndpoints(), true);
  assert.equal(await helpers.ensureDiagramImportConditionCatalogModel({ id: 'relation:block-5', className: 'ipRange' }), false);
  assert.equal(requests, 1, 'A current cache must not trigger another catalog request.');
  state.catalog.domainEndpoints.complete = false;
  state.message = null;
  assert.equal(await helpers.ensureDiagramImportConditionCatalogModel({ id: 'relation:block-5', className: 'ipRange' }), false);
  assert.equal(requests, 1, 'Incomplete endpoint metadata must not cause a retry loop.');
  assert.deepEqual(state.message, {
    type: 'warning',
    text: 'catalogDomainEndpointsIncomplete'
  });
});

test('Assistant persists the configurable reference-path depth setting', () => {
  assert.match(proxySource, /DEFAULT_ASSISTANT_REFERENCE_PATH_MAX_DEPTH/);
  assert.match(proxySource, /CMDP_ASSISTANT_REFERENCE_PATH_MAX_DEPTH_ABSOLUTE/);
  assert.match(proxySource, /var semanticPlan = assistant\.semanticPlan \|\| \{\};/);
  assert.match(proxySource, /cmdp-assistant-semantic-plan-max-reference-path-depth/);
  assert.match(proxySource, /assistantSemanticPlanMaxReferencePathDepthHelp/);
  assert.match(proxySource, /next\.assistant\.semanticPlan\.maxReferencePathDepth = readPositiveIntField/);
  assert.match(proxySource, /maxReferencePathDepth: maxReferencePathDepthConfig\.value/);
});

test('Assistant explains why deterministic flow generation is blocked by unresolved semantic blocks', () => {
  assert.match(proxySource, /assistantSemanticPlanNeedsClarification/);
  assert.match(proxySource, /assistantFlowBlockedByUnresolved/);
  assert.match(proxySource, /data-assistant-flow-unresolved/);
  assert.match(proxySource, /aria-describedby="cmdp-assistant-flow-unresolved"/);
  assert.match(proxySource, /var flowGenerationBlocked = !semanticPlan \|\| state\.assistantFlowBusy \|\| unresolvedBlocks\.length > 0/);
});

test('CMDBuild custom page launcher redirects without relying only on afterrender', () => {
  assert.match(launcherSource, /CMDBuildUI\.view\.custompages\.CmdbDynamicPages\.CmdbDynamicPages/);
  assert.match(launcherSource, /function cmdbDynamicPagesScheduleOpenExternalUi/);
  assert.match(launcherSource, /cmdbDynamicPagesScheduleOpenExternalUi\('initComponent'\)/);
  assert.match(launcherSource, /cmdbDynamicPagesScheduleOpenExternalUi\('afterrender'\)/);
  assert.match(launcherSource, /window\.addEventListener\('hashchange'/);
  assert.match(launcherSource, /launcher-redirect/);
  assert.match(launcherSource, /function cmdbDynamicPagesIsInternalTarget/);
  assert.match(launcherSource, /target\.charAt\(0\) !== '\/'/);
  assert.match(launcherSource, /new URL\(target, window\.location\.origin\)\.origin === window\.location\.origin/);
  assert.match(launcherSource, /if \(!cmdbDynamicPagesIsInternalTarget\(target\)\) return;/);
});

test('CMDBuild UI proxy injection tracks launcher hash changes', () => {
  assert.match(proxySource, /function rewriteCmdbuildUiHtml/);
  assert.match(proxySource, /function tryPending\(\)/);
  assert.match(proxySource, /window\.addEventListener\("hashchange",tryPending\)/);
  assert.match(proxySource, /cmdbdynamicpages\.pendingTarget/);
  assert.match(proxySource, /\/cmdbuild\/dynamicpages\/ui\/designer/);
});

test('assistant draft generation auto-applies only successful drafts to editor state', () => {
  const generateStart = proxySource.indexOf('function generateAssistantDraft()');
  const applyStart = proxySource.indexOf('function applyAssistantDraft()');
  assert.ok(generateStart > -1);
  assert.ok(applyStart > generateStart);
  const generateSource = proxySource.slice(generateStart, applyStart);

  assert.match(generateSource, /if \(result\.ok && result\.json && result\.json\.spec\)/);
  assert.match(generateSource, /updateSelectedFromEditor\(applyAssistantDraftToSpec\(result\.json\.spec, state\.assistantDraftIntent, state\.assistantTaskMode\)\)/);
  assert.match(generateSource, /clearDraftExecutionState\(\)/);
  assert.match(generateSource, /assistantDraftGeneratedApplied/);
  assert.match(generateSource, /state\.objectGroupDraft = null/);
  assert.match(generateSource, /state\.relationDraft = null/);
  assert.match(generateSource, /state\.viewComposerDraft = null/);
  assert.doesNotMatch(generateSource, /\/draft\/preview/);
  assert.doesNotMatch(generateSource, /saveTemplate\(/);
  assert.doesNotMatch(generateSource, /runtimeRunPath/);
});

test('Assistant authoring is persisted only through canonical authoring on normal Save', () => {
  const hydrateStart = proxySource.indexOf('function hydrateDesignerStateFromTemplate(options)');
  const noticeStart = proxySource.indexOf('function renderNotice(message)');
  const authoringStart = proxySource.indexOf('function templateAuthoringClient(spec)');
  const authoringEnd = proxySource.indexOf('function assistantAuthoringFromState(spec)', authoringStart);
  const specWithPromptsStart = proxySource.indexOf('function assistantSpecWithPrompts(spec)');
  const specWithPromptsEnd = proxySource.indexOf('function markAssistantAuthoringChanged()', specWithPromptsStart);
  const saveStart = proxySource.indexOf('function saveTemplate()');
  const saveEnd = proxySource.indexOf('function openAssistantSection()', saveStart);
  const defaultSpecStart = proxySource.indexOf('function defaultSpec()');
  assert.ok(hydrateStart > -1);
  assert.ok(noticeStart > hydrateStart);
  assert.ok(authoringStart > -1);
  assert.ok(authoringEnd > authoringStart);
  assert.ok(specWithPromptsStart > authoringEnd);
  assert.ok(specWithPromptsEnd > specWithPromptsStart);
  assert.ok(defaultSpecStart > specWithPromptsEnd);
  assert.ok(saveStart > -1);
  assert.ok(saveEnd > saveStart);

  const hydrateSource = proxySource.slice(hydrateStart, noticeStart);
  const authoringSource = proxySource.slice(authoringStart, authoringEnd);
  const specWithPromptsSource = proxySource.slice(specWithPromptsStart, specWithPromptsEnd);
  const saveSource = proxySource.slice(saveStart, saveEnd);

  assert.match(hydrateSource, /var authoring = templateAuthoringClient\(spec\)/);
  assert.match(authoringSource, /source\.authoring/);
  assert.match(authoringSource, /systemPromptOverrides: normalizeTemplateAssistantPromptOverridesClient\(assistant\.systemPromptOverrides\)/);
  assert.doesNotMatch(authoringSource, /legacyAssistantAuthoringClient/);
  assert.match(specWithPromptsSource, /next\.authoring = assistantAuthoringFromState\(next\)/);
  assert.doesNotMatch(specWithPromptsSource, /assistantDraft/);
  assert.match(saveSource, /assistantSpecWithPrompts\(state\.selectedTemplate && state\.selectedTemplate\.spec \|\| defaultSpec\(\)\)/);
  assert.match(saveSource, /request\(path, \{ method: exists \? 'PUT' : 'POST'/);
});

test('Assistant Save persists an analyzed D2 source without replacing the applied mapping', () => {
  const authoringStart = proxySource.indexOf('function assistantAuthoringFromState(spec)');
  const authoringEnd = proxySource.indexOf('function assistantSpecWithPrompts(spec)', authoringStart);
  const saveStart = proxySource.indexOf('function saveTemplate()');
  const saveEnd = proxySource.indexOf('function openAssistantSection()', saveStart);
  assert.ok(authoringStart >= 0 && authoringEnd > authoringStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const authoringSource = proxySource.slice(authoringStart, authoringEnd);
  const saveSource = proxySource.slice(saveStart, saveEnd);

  assert.match(authoringSource, /var analyzedSource = state\.diagramImportProposal/);
  assert.match(authoringSource, /sourceText.*state\.diagramImportSource/);
  assert.match(authoringSource, /var d2Source = analyzedSource \|\| \(hasAppliedImport/);
  assert.match(saveSource, /var activeDiagramEditor = state\.designerSection === 'diagram'/);
  assert.doesNotMatch(saveSource, /var activeDiagramEditor = activeDiagramImportEditorModel/);
});

test('new templates hydrate all template-owned Assistant state', () => {
  const hydrateStart = proxySource.indexOf('function hydrateDesignerStateFromTemplate(options)');
  const noticeStart = proxySource.indexOf('function renderNotice(message)', hydrateStart);
  const newTemplateStart = proxySource.indexOf('function newTemplate()');
  const newCmdbBuildViewStart = proxySource.indexOf('function newCmdbBuildViewTemplate()', newTemplateStart);
  const deleteTemplateStart = proxySource.indexOf('function deleteTemplate(code)', newCmdbBuildViewStart);
  assert.ok(hydrateStart > -1);
  assert.ok(noticeStart > hydrateStart);
  assert.ok(newTemplateStart > -1);
  assert.ok(newCmdbBuildViewStart > newTemplateStart);
  assert.ok(deleteTemplateStart > newCmdbBuildViewStart);

  const hydrateSource = proxySource.slice(hydrateStart, noticeStart);
  const newTemplateSource = proxySource.slice(newTemplateStart, newCmdbBuildViewStart);
  const newCmdbBuildViewSource = proxySource.slice(newCmdbBuildViewStart, deleteTemplateStart);

  assert.match(newTemplateSource, /state\.selectedTemplate = \{ code: '', description: '', active: true, spec: defaultSpec\(\), paramsSchema: \{\}, resultSchema: \{\} \}/);
  assert.match(newTemplateSource, /hydrateDesignerStateFromTemplate\(\{ replaceRunParams: true \}\)/);
  assert.match(newCmdbBuildViewSource, /spec: defaultCmdbBuildViewSpecClient\(\)/);
  assert.match(newCmdbBuildViewSource, /hydrateDesignerStateFromTemplate\(\{ replaceRunParams: true \}\)/);
  assert.match(hydrateSource, /stopAssistantGenerationTimer\(\)/);
  assert.match(hydrateSource, /state\.assistantDraftResult = null/);
  assert.match(hydrateSource, /state\.assistantGenerating = false/);
  assert.match(hydrateSource, /resetAssistantObjectFlowProposal\(\)/);
  assert.match(hydrateSource, /state\.assistantFlowExpandedBlockIds = \{\}/);
  assert.match(hydrateSource, /state\.assistantFlowDragSourceId = ''/);
});

test('template Assistant prompt overrides are explicit, resettable, and kept outside global runtime settings', () => {
  const renderStart = proxySource.indexOf('function renderAssistantTemplatePromptOverrides(selected, config)');
  const taskModeStart = proxySource.indexOf('function renderAssistantTaskMode(value)', renderStart);
  const updateStart = proxySource.indexOf('function updateTemplateAssistantPromptOverride(key, mode)');
  const promptChangedStart = proxySource.indexOf('function markDiagramImportPromptChanged(kind)', updateStart);
  const inputStart = proxySource.indexOf("document.addEventListener('input', function (event)");
  const end = proxySource.indexOf("document.addEventListener('change', function (event)", inputStart);
  assert.ok(renderStart > -1);
  assert.ok(taskModeStart > renderStart);
  assert.ok(updateStart > -1);
  assert.ok(promptChangedStart > updateStart);
  assert.ok(inputStart > -1);
  assert.ok(end > inputStart);

  const renderSource = proxySource.slice(renderStart, taskModeStart);
  const updateSource = proxySource.slice(updateStart, promptChangedStart);
  const inputSource = proxySource.slice(inputStart, end);
  assert.match(renderSource, /assistantTemplatePromptInherited/);
  assert.match(renderSource, /assistantTemplatePromptOverridden/);
  assert.match(renderSource, /assistant-template-prompt-override/);
  assert.match(renderSource, /assistant-template-prompt-reset/);
  assert.match(renderSource, /readonly/);
  assert.match(renderSource, /TEMPLATE_ASSISTANT_PROMPT_OVERRIDE_MAX_CHARS/);
  assert.match(updateSource, /assistantTemplatePromptDefaults\(state\.config\)/);
  assert.match(updateSource, /delete overrides\[key\]/);
  assert.match(updateSource, /invalidateAssistantPromptDependentDrafts\(\)/);
  assert.match(inputSource, /\[data-template-assistant-system-prompt\]/);
  assert.match(inputSource, /state\.assistantTemplatePromptOverrides = promptOverrides/);
  assert.match(inputSource, /updateAssistantTemplatePromptLimit/);
  assert.match(proxySource, /function templateAssistantRuntimeConfig\(runtimeConfig, spec\)/);
  assert.match(proxySource, /currentSpec = resolveAssistantRequestSpec\(body, planContext\.template && planContext\.template\.spec \|\| \{\}\)/);
  assert.match(proxySource, /function assistantRequestTemplateRef\(body\)/);
  assert.match(proxySource, /function applyAssistantEditorDelta\(baseSpec, value\)/);
  assert.match(proxySource, /templateAssistantRuntimeConfig\(\n\s*await getRuntimeConfig\(authToken, root\),\n\s*currentSpec/);
  assert.match(proxySource, /templateAssistantPromptOverrideValidationErrors/);
  assert.match(proxySource, /function prepareAssistantObjectFlowSemanticPlan\(retry\)[\s\S]*?var requestSpec = assistantSpecWithPrompts\(state\.selectedTemplate && state\.selectedTemplate\.spec \|\| defaultSpec\(\)\);/);
  assert.match(proxySource, /function generateAssistantObjectFlow\(retry\)[\s\S]*?var requestSpec = assistantSpecWithPrompts\(state\.selectedTemplate && state\.selectedTemplate\.spec \|\| defaultSpec\(\)\);/);
});

test('deterministic editor updates keep canonical Assistant and D2 authoring', () => {
  const updateStart = proxySource.indexOf('function updateSelectedFromEditor(spec)');
  const paramsStart = proxySource.indexOf('function applyParamsEditor()', updateStart);
  const objectGroupStart = proxySource.indexOf('function buildObjectGroupSpec(model, previousSpec)');
  const relationStart = proxySource.indexOf('function buildRelationExpansionSpec(model, previousSpec)');
  const captureStart = proxySource.indexOf('function captureVisibleDesignerState()');
  const nextCaptureFunction = proxySource.indexOf('function defaultAssistantObjectFlowBlock(index, existingIds)', captureStart);
  const readSpecStart = proxySource.indexOf('function readSpecWithEditorBlocks()');
  const clearDraftStart = proxySource.indexOf('function clearDraftExecutionState(options)', readSpecStart);
  assert.ok(updateStart > -1);
  assert.ok(paramsStart > updateStart);
  assert.ok(objectGroupStart > -1);
  assert.ok(relationStart > objectGroupStart);
  assert.ok(captureStart > -1);
  assert.ok(nextCaptureFunction > captureStart);
  assert.ok(readSpecStart > -1);
  assert.ok(clearDraftStart > readSpecStart);
  const updateSource = proxySource.slice(updateStart, paramsStart);
  const objectGroupSource = proxySource.slice(objectGroupStart, relationStart);
  const relationSource = proxySource.slice(relationStart, readSpecStart);
  const captureSource = proxySource.slice(captureStart, nextCaptureFunction);
  const readSpecSource = proxySource.slice(readSpecStart, clearDraftStart);

  assert.match(updateSource, /assistantSpecWithPrompts\(spec\)/);
  assert.match(updateSource, /canonical Assistant\/D2 authoring envelope/);
  assert.match(objectGroupSource, /authoring: previousSpec && previousSpec\.authoring/);
  assert.match(objectGroupSource, /diagrams: Array\.isArray\(previousResult\.diagrams\)/);
  assert.match(relationSource, /authoring: previousSpec && previousSpec\.authoring/);
  assert.match(captureSource, /assistantSpecWithPrompts\(applyTemplateKindFromEditor/);
  assert.match(readSpecSource, /specData\.spec = assistantSpecWithPrompts\(specData\.spec\)/);
});

test('Assistant authoring has no autosave write endpoint and is excluded from flow staleness checks', () => {
  const flowSnapshotStart = proxySource.indexOf('function assistantTemplateRevisionSnapshot(template, spec, requestGeneration)');
  const applyDraftStart = proxySource.indexOf('function applyAssistantDraftToSpec(spec, intent, taskMode)');
  assert.ok(flowSnapshotStart > -1);
  assert.ok(applyDraftStart > flowSnapshotStart);

  const flowSnapshotSource = proxySource.slice(flowSnapshotStart, applyDraftStart);
  assert.match(flowSnapshotSource, /assistantSpecWithoutPromptDraft/);
  assert.doesNotMatch(proxySource, /function autosaveAssistantPrompts\(/);
  assert.doesNotMatch(proxySource, /function scheduleAssistantPromptAutosave\(/);
  assert.doesNotMatch(proxySource, /templateAction === 'assistant-draft'/);
});

test('typed assistant flow renders one in-progress proposal before deterministic apply', () => {
  const renderStart = proxySource.indexOf('function renderAssistantFlowEditor(');
  const editorStart = proxySource.indexOf('function renderAssistantEditor(');
  const generateStart = proxySource.indexOf('function generateAssistantObjectFlow(retry)');
  const applyStart = proxySource.indexOf('function applyAssistantObjectFlow()');
  assert.ok(renderStart > -1);
  assert.ok(editorStart > renderStart);
  assert.ok(generateStart > editorStart);
  assert.ok(applyStart > generateStart);
  const renderSource = proxySource.slice(renderStart, editorStart);
  const editorSource = proxySource.slice(editorStart, generateStart);
  const generateSource = proxySource.slice(generateStart, applyStart);

  assert.match(proxySource, /assistantGeneratingTitle/);
  assert.match(renderSource, /assistantGenerateBusy/);
  assert.match(renderSource, /state\.assistantFlowBusy/);
  assert.match(renderSource, /cmdp-assistant-object-flow-intent/);
  assert.match(renderSource, /assistant-flow-prepare/);
  assert.match(renderSource, /assistant-flow-block-add/);
  assert.match(renderSource, /assistant-flow-drag-handle/);
  assert.match(renderSource, /assistant-flow-disclosure/);
  assert.match(renderSource, /assistant-flow-business-actions/);
  assert.match(renderSource, /assistantObjectFlowDependencyDiagnostics/);
  assert.match(proxySource, /function renderAssistantFlowDependencyNotice\(dependencyDiagnostics\)/);
  assert.match(proxySource, /assistantFlowVisualOrderWarning/);
  assert.doesNotMatch(renderSource, /assistant-flow-block-up/);
  assert.doesNotMatch(renderSource, /assistant-flow-block-down/);
  assert.match(renderSource, /assistant-flow-generate/);
  assert.match(renderSource, /assistantFlowProposal/);
  assert.match(renderSource, /assistantFlowCanApply/);
  assert.match(renderSource, /assistantFlowSemanticPlan/);
  assert.match(renderSource, /data-assistant-flow-semantic-plan/);
  assert.doesNotMatch(renderSource, /assistant-flow-generate-selection/);
  assert.doesNotMatch(renderSource, /assistant-flow-generate-match/);
  assert.doesNotMatch(renderSource, /renderObjectGroupSelection\(/);
  assert.doesNotMatch(renderSource, /renderObjectMatchingBlock\(/);
  assert.match(editorSource, /renderAssistantFlowEditor\(\)/);
  assert.match(generateSource, /if \(state\.assistantFlowBusy \|\| !state\.assistantFlowSemanticPlan\) return/);
  assert.match(generateSource, /state\.assistantFlowProposal = null/);
  assert.match(generateSource, /state\.assistantFlowCanApply = false/);
  assert.match(generateSource, /result\.json\.canApply === true/);
  assert.match(generateSource, /\/assistant\/object-flow\/plan/);
  assert.match(proxySource, /\/assistant\/object-flow\/semantic-plan/);
  assert.match(proxySource, /function invalidateAssistantObjectFlowRequests\(\)/);
  assert.match(proxySource, /function moveAssistantObjectFlowBlockTo\(from, to\)/);
  assert.doesNotMatch(proxySource.slice(proxySource.indexOf('function updateAssistantObjectFlowIntent'), proxySource.indexOf('function addAssistantObjectFlowBlock')), /slice\(0, index\).*block\.uses/);
  assert.match(proxySource, /function assistantTemplateRevisionMismatch\(snapshot\)/);
  assert.match(proxySource, /function assistantTemplateRevisionError\(snapshot\)/);
  assert.match(proxySource, /assistantResponseStaleTemplate/);
  assert.match(proxySource, /assistantResponseStaleSpec/);
  assert.match(proxySource, /assistantResponseStaleRequest/);
  assert.match(generateSource, /state\.assistantFlowRequestGeneration = requestGeneration/);
  assert.match(generateSource, /assistantTemplateRevisionSnapshot\(state\.selectedTemplate, requestSpec, requestGeneration\)/);
  assert.match(generateSource, /mismatch === 'request'/);
  assert.match(generateSource, /assistantTemplateRevisionError\(requestRevision\)/);
  assert.match(generateSource, /state\.assistantFlowRequestGeneration \|\| 0\) === requestGeneration/);
  assert.doesNotMatch(proxySource.slice(proxySource.indexOf('function assistantTemplateRevisionSnapshot'), proxySource.indexOf('function applyAssistantDraftToSpec')), /assistantObjectFlowPrompt|hasPrompt|specHash/);
  assert.doesNotMatch(generateSource, /state\.selectedTemplate !== requestTemplate/);
  assert.match(generateSource, /state\.assistantFlowBusy = false/);
});

test('normal Save reloads canonical authoring and restores a saved D2 Assistant checkpoint without LLM', () => {
  const hydrateStart = proxySource.indexOf('function hydrateDesignerStateFromTemplate(options)');
  const noticeStart = proxySource.indexOf('function renderNotice(message)', hydrateStart);
  const loadStart = proxySource.indexOf('function loadDesigner(options)');
  const fetchVersionsStart = proxySource.indexOf('function fetchVersions(code)', loadStart);
  const saveStart = proxySource.indexOf('function saveTemplate()');
  const assistantStart = proxySource.indexOf('function openAssistantSection()', saveStart);
  assert.ok(hydrateStart > -1);
  assert.ok(noticeStart > hydrateStart);
  assert.ok(loadStart > -1);
  assert.ok(fetchVersionsStart > loadStart);
  assert.ok(saveStart > -1);
  assert.ok(assistantStart > saveStart);

  const hydrateSource = proxySource.slice(hydrateStart, noticeStart);
  const loadSource = proxySource.slice(loadStart, fetchVersionsStart);
  const saveSource = proxySource.slice(saveStart, assistantStart);

  assert.match(hydrateSource, /if \(!options\.preserveAssistantState\)/);
  assert.match(loadSource, /var selectedBeforeReload = state\.selectedTemplate/);
  assert.match(loadSource, /selectedBeforeReload\.specHash/);
  assert.match(loadSource, /preserveAssistantState: preserveAssistantState/);
  assert.match(saveSource, /loadDesigner\(\{ preserveAssistantState: false \}\)/);
  assert.doesNotMatch(hydrateSource, /analyzeDiagramImport\(/);
  assert.match(proxySource, /function restoreDiagramImportAssistantCheckpoint\(\)/);
  assert.match(loadSource, /restoreDiagramImportAssistantCheckpoint\(\)/);
  assert.match(proxySource, /\/draft\/diagram-import\/restore/);
});

test('assistant status is compact and flow capture uses proposal state without deterministic DOM fields', () => {
  const statusStart = proxySource.indexOf('function renderAssistantStatus(config)');
  const taskModeStart = proxySource.indexOf('function renderAssistantTaskMode(value)', statusStart);
  const captureStart = proxySource.indexOf('function captureAssistantObjectFlow()');
  const specWithPromptsStart = proxySource.indexOf('function assistantSpecWithPrompts(spec)');
  const specWithPromptsEnd = proxySource.indexOf('function markAssistantAuthoringChanged()', specWithPromptsStart);
  assert.ok(statusStart > -1);
  assert.ok(taskModeStart > statusStart);
  assert.ok(captureStart > -1);
  assert.ok(specWithPromptsStart > -1);
  assert.ok(specWithPromptsEnd > specWithPromptsStart);
  const statusSource = proxySource.slice(statusStart, taskModeStart);
  const captureSource = proxySource.slice(captureStart, proxySource.indexOf('function updateAssistantObjectFlowIntent', captureStart));
  const specWithPromptsSource = proxySource.slice(specWithPromptsStart, specWithPromptsEnd);

  assert.match(proxySource, /menuAssistantGroups: 'Ассистент групп и сопоставлений'/);
  assert.match(proxySource, /menuDiagramAssistant: 'Ассистент диаграмм'/);
  assert.match(proxySource, /menuCmdbBuildView: 'Отчет по модели данных CMDB'/);
  assert.match(proxySource, /assistantStatusTitle: 'Статус ассистента'/);
  assert.match(statusSource, /assistantStatusEnabled/);
  assert.match(statusSource, /assistantStatusApiKey/);
  assert.match(statusSource, /apiKeyState === 'invalid_file'/);
  assert.match(statusSource, /assistantStatusInvalidFile/);
  assert.match(statusSource, /apiKeyPillClass/);
  assert.match(statusSource, /assistantMcpTools/);
  assert.doesNotMatch(statusSource, /assistantStatusProvider/);
  assert.doesNotMatch(statusSource, /assistantStatusBaseUrl/);
  assert.doesNotMatch(statusSource, /assistantStatusModel/);
  assert.doesNotMatch(statusSource, /assistantStatusMcp/);
  assert.match(captureSource, /state\.assistantFlowProposal/);
  assert.doesNotMatch(captureSource, /captureObjectGroupDraftFromDom/);
  assert.doesNotMatch(captureSource, /readRelationExpansionFields/);
  assert.match(specWithPromptsSource, /next\.authoring = assistantAuthoringFromState\(next\)/);
  assert.doesNotMatch(specWithPromptsSource, /assistantDraft/);
});

test('Assistant D2 authoring restores canonical source and saved checkpoint without an LLM request', () => {
  const hydrateStart = proxySource.indexOf('function hydrateDesignerStateFromTemplate(options)');
  const loadDesignerStart = proxySource.indexOf('function loadDesigner(options)', hydrateStart);
  assert.ok(hydrateStart > -1);
  assert.ok(loadDesignerStart > hydrateStart);

  const hydrateSource = proxySource.slice(hydrateStart, loadDesignerStart);
  const authoringStart = hydrateSource.indexOf('var authoring = templateAuthoringClient(spec)');
  const preserveStart = hydrateSource.indexOf('if (!options.preserveAssistantState)');
  assert.ok(authoringStart > -1);
  assert.ok(preserveStart > authoringStart);
  assert.match(hydrateSource, /state\.diagramImportSource = String\(authoring\.d2\.source/);
  assert.match(hydrateSource, /state\.diagramImportAnalysisCheckpoint = cloneJsonValue\(authoring\.d2\.analysisCheckpoint, null\)/);
  assert.match(hydrateSource, /state\.diagramImportAssistantCheckpoint = cloneJsonValue\(authoring\.d2\.assistantCheckpoint, null\)/);
  assert.doesNotMatch(hydrateSource, /spec\.assistantDraft/);
  assert.doesNotMatch(hydrateSource, /analyzeDiagramImport\(/);
});

test('designer blocks template-bound menu sections until a template is selected', () => {
  const sectionNeedsStart = proxySource.indexOf('function sectionNeedsSelectedTemplate(section)');
  const canEnterStart = proxySource.indexOf('function canEnterDesignerSection(section)');
  const ensureStart = proxySource.indexOf('function ensureTemplateListOnNewDesignerSession()');
  const menuStart = proxySource.indexOf('function renderDesignerMenu()');
  const renderSectionStart = proxySource.indexOf('function renderDesignerSection(selected, config, templateRows)');
  const titleStart = proxySource.indexOf('function designerSectionTitle(section)');
  const clickStart = proxySource.indexOf("var sectionLink = event.target.closest('[data-designer-section]')");
  const actionStart = proxySource.indexOf("var target = event.target.closest('[data-action]')");
  assert.ok(sectionNeedsStart > -1);
  assert.ok(canEnterStart > sectionNeedsStart);
  assert.ok(ensureStart > canEnterStart);
  assert.ok(menuStart > ensureStart);
  assert.ok(renderSectionStart > menuStart);
  assert.ok(titleStart > renderSectionStart);
  assert.ok(clickStart > titleStart);
  assert.ok(actionStart > clickStart);

  const sectionNeedsSource = proxySource.slice(sectionNeedsStart, canEnterStart);
  const menuSource = proxySource.slice(menuStart, renderSectionStart);
  const renderSectionSource = proxySource.slice(renderSectionStart, titleStart);
  const clickSource = proxySource.slice(clickStart, actionStart);
  const loadDesignerStart = proxySource.indexOf('function loadDesigner(options)');
  const fetchVersionsStart = proxySource.indexOf('function fetchVersions(code)');
  assert.ok(loadDesignerStart > -1);
  assert.ok(fetchVersionsStart > loadDesignerStart);
  const loadDesignerSource = proxySource.slice(loadDesignerStart, fetchVersionsStart);

  const constructorStart = menuSource.indexOf("group(t('menuDesigner')");
  const runStart = menuSource.indexOf("group(t('menuRun')");
  const constructorSource = menuSource.slice(constructorStart, runStart);
  const runSource = menuSource.slice(runStart);
  assert.ok(constructorStart > -1);
  assert.ok(runStart > constructorStart);
  assert.doesNotMatch(constructorSource, /section: 'extraction'/);
  assert.doesNotMatch(constructorSource, /section: 'final-view'/);
  assert.ok(runSource.indexOf("{ section: 'extraction'") < runSource.indexOf("{ section: 'final-view'"));
  assert.ok(runSource.indexOf("{ section: 'final-view'") < runSource.indexOf("{ section: 'visualization'"));

  assert.match(sectionNeedsSource, /'template'/);
  assert.match(sectionNeedsSource, /'assistant'/);
  assert.match(sectionNeedsSource, /'diagram-assistant'/);
  assert.match(sectionNeedsSource, /'cache'/);
  assert.ok(constructorSource.indexOf("{ section: 'assistant'") < constructorSource.indexOf("{ section: 'object-group'"));
  assert.ok(constructorSource.indexOf("{ section: 'diagram-assistant'") < constructorSource.indexOf("{ section: 'diagram'"));
  assert.match(proxySource, /templateSelectionRequired/);
  assert.match(proxySource, /function redirectDesignerSectionToTemplates/);
  assert.match(menuSource, /aria-disabled="true"/);
  assert.match(menuSource, /data-disabled-template-section="true"/);
  assert.match(renderSectionSource, /if \(!canEnterDesignerSection\(section\)\)/);
  assert.match(clickSource, /data-disabled-template-section/);
  assert.match(clickSource, /redirectDesignerSectionToTemplates\(\)/);
  assert.match(loadDesignerSource, /var redirectedToTemplates = ensureTemplateListOnNewDesignerSession\(\)/);
  assert.match(loadDesignerSource, /else if \(!redirectedToTemplates \|\| !state\.message\) state\.message = null/);
});

test('designer action bar exposes the global template Save in every selected-template section', () => {
  const actionBarStart = proxySource.indexOf('function renderDesignerActionBar(selected)');
  const actionBarEnd = proxySource.indexOf('function renderDesigner()', actionBarStart);
  assert.ok(actionBarStart > -1);
  assert.ok(actionBarEnd > actionBarStart);

  const actionBarSource = proxySource.slice(actionBarStart, actionBarEnd);
  const globalSaveStart = actionBarSource.indexOf("if (section !== 'templates')");
  const templatesStart = actionBarSource.indexOf("if (section === 'templates')");
  const assistantStart = actionBarSource.indexOf("else if (section === 'assistant')");
  const diagramAssistantStart = actionBarSource.indexOf("else if (section === 'diagram-assistant')");
  const diagramStart = actionBarSource.indexOf("else if (section === 'diagram')");
  assert.ok(globalSaveStart > -1);
  assert.ok(templatesStart > -1);
  assert.ok(templatesStart > globalSaveStart);
  assert.ok(assistantStart > templatesStart);
  assert.ok(diagramAssistantStart > assistantStart);
  assert.ok(diagramStart > diagramAssistantStart);

  const templatesSource = actionBarSource.slice(templatesStart, assistantStart);
  const globalSaveSource = actionBarSource.slice(globalSaveStart, templatesStart);
  assert.match(actionBarSource, /var templateSelected = Boolean\(state\.selectedTemplate\)/);
  assert.match(actionBarSource, /templateSelectionRequired/);
  assert.match(templatesSource, /renderActionButton\('save-template', t\('save'\)/);
  assert.match(globalSaveSource, /renderActionButton\('save-template', t\('save'\), \{/);
  assert.match(globalSaveSource, /disabled: saveDisabled/);
});

test('diagram editor renders repeatable mapping tables with source-dependent field selects', () => {
  const helpersStart = proxySource.indexOf('function diagramMappingList(diagram, key)');
  const renderStart = proxySource.indexOf('function renderDiagramEditor(spec, outputMode, options)');
  const renderEnd = proxySource.indexOf('function objectSelectionPrefixForAlias(spec, alias)');
  const readRowsStart = proxySource.indexOf('function readDiagramMappingRows(kind)');
  const readStart = proxySource.indexOf('function readVisualizationSettings(required, currentSpec)');
  const readEnd = proxySource.indexOf('rows.forEach(function (row)', readStart);
  const captureStart = proxySource.indexOf('function captureVisibleDesignerState()');
  const defaultSpecStart = proxySource.indexOf('function defaultSpec()');
  const addRowStart = proxySource.indexOf('function addDiagramMappingRow(button)');
  const refreshRowsStart = proxySource.indexOf('function refreshVisualizationRowGroupLabels(container)');
  assert.ok(renderStart > -1);
  assert.ok(helpersStart > -1);
  assert.ok(helpersStart < renderStart);
  assert.ok(renderEnd > renderStart);
  assert.ok(readRowsStart > renderEnd);
  assert.ok(readStart > -1);
  assert.ok(readEnd > readStart);
  assert.ok(captureStart > -1);
  assert.ok(defaultSpecStart > captureStart);
  assert.ok(addRowStart > -1);
  assert.ok(refreshRowsStart > addRowStart);

  const helperSource = proxySource.slice(helpersStart, renderStart);
  const renderSource = proxySource.slice(renderStart, renderEnd);
  const readRowsSource = proxySource.slice(readRowsStart, readStart);
  const readSource = proxySource.slice(readStart, readEnd);
  const captureSource = proxySource.slice(captureStart, defaultSpecStart);
  const rowUiSource = proxySource.slice(addRowStart, refreshRowsStart);
  const generalIndex = renderSource.indexOf('data-diagram-editor-section="general"');
  const nodesIndex = renderSource.indexOf("renderDiagramMappingTable('nodes'");
  const edgesIndex = renderSource.indexOf("renderDiagramMappingTable('edges'");
  const groupsIndex = renderSource.indexOf("renderDiagramMappingTable('groups'");
  const hierarchyIndex = renderSource.indexOf("renderDiagramMappingTable('hierarchy'");

  assert.match(proxySource, /\.diagram-editor-sections/);
  assert.match(proxySource, /\.diagram-mapping-table/);
  assert.match(proxySource, /\.diagram-add-button/);
  assert.match(proxySource, /diagramGeneralSettings: 'General diagram settings'/);
  assert.match(proxySource, /diagramGeneralSettings: 'Общие настройки диаграммы'/);
  assert.match(proxySource, /diagramAddMapping: 'Add mapping'/);
  assert.match(proxySource, /diagramAddMapping: 'Добавить сопоставление'/);
  assert.match(proxySource, /diagramMappingSourceRequired/);
  assert.match(proxySource, /var primaryCardSource = normalizeDiagramImportConditionCardSourceClient\(primary\.cardSource\);/);
  assert.match(proxySource, /\.\.\.\(primaryCardSource \? \{ cardSource: primaryCardSource \} : \{\}\)/);
  assert.match(proxySource, /if \(suffix && name\.indexOf\(suffix\) === 0\) return name;/);
  assert.ok(generalIndex > -1);
  assert.ok(nodesIndex > generalIndex);
  assert.ok(edgesIndex > nodesIndex);
  assert.ok(groupsIndex > edgesIndex);
  assert.ok(hierarchyIndex > groupsIndex);

  assert.match(renderSource, /t\('diagramGeneralSettings'\)/);
  assert.match(renderSource, /cmdp-diagram-name/);
  assert.match(renderSource, /cmdp-diagram-title/);
  assert.match(renderSource, /cmdp-diagram-layout/);
  assert.match(renderSource, /cmdp-diagram-max-nodes/);
  assert.match(renderSource, /cmdp-diagram-max-edges/);
  assert.match(renderSource, /cmdp-diagram-metadata-max-bytes/);
  assert.match(renderSource, /cmdp-diagram-embed-d2/);
  assert.match(renderSource, /cmdp-diagram-embed-svg/);
  assert.match(renderSource, /renderDiagramMappingTable\('nodes', 'diagramNodes'/);
  assert.match(renderSource, /renderDiagramMappingTable\('edges', 'diagramEdges'/);
  assert.match(renderSource, /renderDiagramMappingTable\('groups', 'diagramGroups'/);
  assert.match(renderSource, /renderDiagramMappingTable\('hierarchy', 'diagramHierarchy'/);

  assert.match(helperSource, /function renderDiagramMappingDetail/);
  assert.match(helperSource, /function renderDiagramMultiFieldSelect/);
  assert.match(helperSource, /function renderDiagramTemplateSuggestions/);
  assert.match(helperSource, /function renderDiagramDerivedDataFields/);
  assert.match(helperSource, /data-diagram-mapping-detail/);
  assert.match(helperSource, /data-diagram-mapping-field="labelTemplate"/);
  assert.match(helperSource, /data-action="insert-diagram-template-token"/);
  assert.match(helperSource, /data-template-token/);
  assert.doesNotMatch(helperSource, /data-diagram-mapping-field="labelFields"/);
  assert.doesNotMatch(helperSource, /data-diagram-mapping-field="dataClassName"/);
  assert.doesNotMatch(helperSource, /visualizationDiagramLabelFields/);
  assert.doesNotMatch(helperSource, /visualizationDiagramDataClass/);
  assert.match(helperSource, /renderDiagramMultiFieldSelect\(spec, sourceAlias, 'dataProfileFields'/);
  assert.match(helperSource, /visualizationDiagramExtraDataFields/);
  assert.match(helperSource, /visualizationDiagramDerivedDataFields/);
  assert.match(helperSource, /data-diagram-mapping-field="dataIncludeSourceRef"/);
  assert.match(helperSource, /data-diagram-mapping-table/);
  assert.match(helperSource, /data-diagram-mapping-body/);
  assert.match(helperSource, /data-action="add-diagram-mapping-row"/);
  assert.match(helperSource, /data-action="clear-diagram-mapping-row"/);
  assert.match(helperSource, /data-diagram-mapping-field="from"/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'id'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'label'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'group'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'parent'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'nodeType'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'href'/);
  assert.match(helperSource, /data-diagram-mapping-field="type"/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'source'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'target'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'edgeType'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'edgeDirection'/);
  assert.match(helperSource, /renderDiagramFieldSelect\(spec, sourceAlias, 'child'/);
  assert.match(helperSource, /matchingColumnOptionRowsForOutput\(spec \|\| defaultSpec\(\), sourceAlias, undefined, true, searchQuery\)/);
  assert.match(helperSource, /function diagramInitialColumnOptionRowsForSource\(spec, sourceAlias, selectedNames\)/);
  assert.match(helperSource, /renderCatalogFieldPicker\(/);
  assert.match(helperSource, /renderCatalogFieldMultiPicker\(/);
  assert.doesNotMatch(helperSource, /<select data-diagram-mapping-field="' \+ escapeHtml\(fieldName\)/);

  assert.match(readSource, /readValue\('cmdp-diagram-name'\)/);
  assert.match(readSource, /readPositiveIntField\('cmdp-diagram-metadata-max-bytes'/);
  assert.match(readSource, /readChecked\('cmdp-diagram-embed-d2'\)/);
  assert.match(readSource, /readChecked\('cmdp-diagram-embed-svg'\)/);
  assert.match(readSource, /readDiagramMappingRows\('nodes'\)/);
  assert.match(readSource, /readDiagramMappingRows\('edges'\)/);
  assert.match(readSource, /readDiagramMappingRows\('groups'\)/);
  assert.match(readSource, /readDiagramMappingRows\('hierarchy'\)/);
  assert.match(readSource, /settings\.diagram\.nodeMappings/);
  assert.match(readSource, /settings\.diagram\.edgeMappings/);
  assert.match(readSource, /settings\.diagram\.groupMappings/);
  assert.match(readSource, /settings\.diagram\.hierarchyMappings/);
  assert.doesNotMatch(readSource, /readValue\('cmdp-diagram-nodes-source'\)/);
  assert.doesNotMatch(readSource, /readValue\('cmdp-diagram-edges-source'\)/);
  assert.match(readRowsSource, /document\.querySelectorAll\('\[data-diagram-mapping-row\]\[data-diagram-mapping-kind="/);
  assert.match(readRowsSource, /data-diagram-mapping-detail/);
  assert.match(readRowsSource, /function mappingValues\(name\)/);
  assert.match(readRowsSource, /function applyMappingDetails\(mapping\)/);
  assert.match(readRowsSource, /mapping\.labelTemplate = labelTemplate/);
  assert.doesNotMatch(readRowsSource, /mapping\.labelFields/);
  assert.doesNotMatch(readRowsSource, /dataClassName/);
  assert.doesNotMatch(readRowsSource, /dataProfile\.className/);
  assert.match(readRowsSource, /mapping\.dataProfile = dataProfile/);
  assert.match(readRowsSource, /if \(!from && type === 'generic'\) return/);
  assert.match(readRowsSource, /throw new Error\(t\('diagramMappingSourceRequired'\)\)/);
  assert.match(readRowsSource, /mappings\.push\(applyMappingDetails\(\{ from: from, fields: nodeFields \}/);
  assert.match(readRowsSource, /mappings\.push\(applyMappingDetails\(\{ type: type \|\| 'generic', from: from, fields: edgeFields \}/);
  assert.match(captureSource, /document\.querySelector\('\[data-diagram-mapping-row\]'\)/);
  assert.match(captureSource, /applyVisualizationToSpec\(state\.selectedTemplate\.spec \|\| defaultSpec\(\), false\)/);
  assert.match(rowUiSource, /function addDiagramMappingRow\(button\)/);
  assert.match(proxySource, /function insertDiagramTemplateToken\(button\)/);
  assert.match(rowUiSource, /function clearDiagramMappingRow\(button\)/);
  assert.match(rowUiSource, /function ensureTrailingDiagramMappingRow\(target\)/);
  assert.match(rowUiSource, /data-diagram-mapping-detail/);
  assert.match(rowUiSource, /function refreshDiagramMappingEditorAfterSourceChange\(\)/);
  assert.match(proxySource, /if \(action === 'add-diagram-mapping-row'\) addDiagramMappingRow\(target\)/);
  assert.match(proxySource, /if \(action === 'clear-diagram-mapping-row'\) clearDiagramMappingRow\(target\)/);
  assert.match(proxySource, /if \(action === 'insert-diagram-template-token'\) insertDiagramTemplateToken\(target\)/);
  assert.match(proxySource, /\[data-diagram-mapping-field="from"\]/);
  assert.match(proxySource, /function diagramImportStructureTreeIssuesClient\(proposal, spec\)/);
  assert.match(proxySource, /data-diagram-import-placement-field="materialization\.kind"/);
  assert.match(proxySource, /data-diagram-import-placement-field="materialization\.stageId"/);
  assert.match(proxySource, /data-diagram-import-placement-field="conditions\.ruleJoin"/);
  assert.doesNotMatch(proxySource, /data-diagram-structure-field="sourceStageOverrideId"/);
  assert.doesNotMatch(generatedDynamicPagesClientScript(), /binding\.unresolved/);
});

test('Assistant owns D2 analysis while Diagram saves its current structure and direct relation rules', () => {
  const flowEditorStart = proxySource.indexOf('function renderAssistantEditor(selected, config)');
  const diagramAssistantEditorStart = proxySource.indexOf('function renderDiagramAssistantEditor(selected, config)', flowEditorStart);
  const cacheEditorStart = proxySource.indexOf('function renderRuntimeCacheFields(', diagramAssistantEditorStart);
  const renderStart = proxySource.indexOf('function renderDiagramImportWorkbench(spec)');
  const renderEnd = proxySource.indexOf('function renderDiagramImportPreview()', renderStart);
  const analyzeStart = proxySource.indexOf('function analyzeDiagramImport(options)');
  const analyzeEnd = proxySource.indexOf('function diagramImportProposalMatchesCurrentRevision()', analyzeStart);
  const applyStart = proxySource.indexOf('function applyDiagramImport()', analyzeStart);
  const refreshStart = proxySource.indexOf('function refreshDiagramMappingEditorAfterSourceChange()', applyStart);
  const assistantStart = proxySource.indexOf('function assistantDiagramRequest(kind)', refreshStart);
  const captureImportStart = proxySource.indexOf('function captureDiagramImportProposalFromDom(manualBindingId)');
  const importOverridesStart = proxySource.indexOf('function diagramImportBindingOverrides(proposal)', captureImportStart);
  const appliedEditorStart = proxySource.indexOf('function diagramImportAppliedEditorFromSpec(spec)');
  const appliedEditorEnd = proxySource.indexOf('function activeDiagramImportEditorModel(spec)', appliedEditorStart);
  assert.ok(renderStart > -1);
  assert.ok(flowEditorStart > -1);
  assert.ok(diagramAssistantEditorStart > flowEditorStart);
  assert.ok(cacheEditorStart > diagramAssistantEditorStart);
  assert.ok(renderEnd > renderStart);
  assert.ok(analyzeStart > -1);
  assert.ok(analyzeEnd > analyzeStart);
  assert.ok(applyStart > analyzeStart);
  assert.ok(refreshStart > applyStart);
  assert.ok(assistantStart > refreshStart);
  assert.ok(captureImportStart > -1);
  assert.ok(importOverridesStart > captureImportStart);
  assert.ok(appliedEditorStart > -1);
  assert.ok(appliedEditorEnd > appliedEditorStart);

  const renderSource = proxySource.slice(renderStart, renderEnd);
  const flowEditorSource = proxySource.slice(flowEditorStart, diagramAssistantEditorStart);
  const diagramAssistantEditorSource = proxySource.slice(diagramAssistantEditorStart, cacheEditorStart);
  const analyzeSource = proxySource.slice(analyzeStart, analyzeEnd);
  const assistantSource = proxySource.slice(assistantStart, proxySource.indexOf('function assistantFlowStageSummaries', assistantStart));
  const applySource = proxySource.slice(applyStart, refreshStart);
  const captureImportSource = proxySource.slice(captureImportStart, importOverridesStart);
  const appliedEditorSource = proxySource.slice(appliedEditorStart, appliedEditorEnd);
  assert.match(renderSource, /cmdp-diagram-import-source/);
  assert.match(renderSource, /cmdp-diagram-import-file/);
  assert.match(renderSource, /diagram-import-analyze/);
  assert.match(renderSource, /assistant-diagram-interpret/);
  assert.match(renderSource, /assistant-diagram-map/);
  assert.match(renderSource, /assistantDiagramAnalysisRequired/);
  assert.match(renderSource, /renderDiagramImportPreview\(\)/);
  assert.doesNotMatch(renderSource, /renderDiagramImportRuntimePreview\(\)/);
  assert.match(proxySource, /function renderDiagramImportRuntimePreview\(\)/);
  assert.match(renderSource, /diagramImportAppliedAssistantHelp/);
  assert.doesNotMatch(renderSource, /renderDiagramImportV3Semantics\(/);
  assert.doesNotMatch(renderSource, /renderDiagramImportRoleMapping\(/);
  assert.doesNotMatch(renderSource, /data-action="diagram-import-apply"/);
  assert.match(flowEditorSource, /menuAssistantGroups/);
  assert.match(flowEditorSource, /renderAssistantStatus\(config\)/);
  assert.match(flowEditorSource, /renderAssistantFlowEditor\(\)/);
  assert.doesNotMatch(flowEditorSource, /renderDiagramImportWorkbench/);
  assert.match(diagramAssistantEditorSource, /menuDiagramAssistant/);
  assert.match(diagramAssistantEditorSource, /renderAssistantStatus\(config\)/);
  assert.match(diagramAssistantEditorSource, /renderAssistantPromptAutosaveControl\(\)/);
  assert.match(diagramAssistantEditorSource, /renderDiagramImportWorkbench\(spec\)/);
  assert.doesNotMatch(diagramAssistantEditorSource, /renderAssistantFlowEditor/);
  assert.match(proxySource, /if \(action === 'open-assistant-d2'\) setDesignerSection\('diagram-assistant'\)/);
  assert.match(analyzeSource, /\/draft\/diagram-import\/analyze/);
  assert.match(proxySource, /function renderDiagramImportSafely\(\)/);
  assert.match(analyzeSource, /var busyRenderError = renderDiagramImportSafely\(\)/);
  assert.match(analyzeSource, /var resultRenderError = renderDiagramImportSafely\(\)/);
  assert.match(proxySource, /function diagramImportProposalMatchesCurrentRevision\(\)/);
  assert.match(assistantSource, /\/assistant\/diagram-import\//);
  assert.match(assistantSource, /map-selections/);
  assert.match(assistantSource, /captureAssistantPromptsFromDom\(\)/);
  assert.match(assistantSource, /assistantSpecWithPrompts\(/);
  assert.match(assistantSource, /var currentSpec = assistantDiagramRequestSpec\(/);
  assert.match(assistantSource, /templateRef: assistantTemplateRefClient\(\)/);
  assert.match(assistantSource, /editorDelta: assistantEditorDeltaClient\(currentSpec\)/);
  assert.doesNotMatch(assistantSource, /currentSpec:\s*currentSpec/);
  assert.match(assistantSource, /ensureDiagramImportProposalForCurrentRevision/);
  assert.match(applySource, /\/draft\/diagram-import\/apply/);
  assert.match(applySource, /var proposal = state\.diagramImportProposal/);
  assert.doesNotMatch(applySource, /var proposal = captureDiagramImportProposalFromDom\(\)/);
  assert.match(applySource, /state\.lastDraftPreviewOk = false/);
  assert.match(applySource, /updateSelectedFromEditor\(result\.json\.spec\)/);
  assert.doesNotMatch(proxySource, /assistantSpecWithPrompts\(result\.json\.spec\)/);
  assert.match(applySource, /state\.diagramImportAppliedPendingPreview = true/);
  assert.match(applySource, /changesReadyToSave/);
  assert.match(applySource, /state\.diagramImportRuntimePreview = null/);
  assert.doesNotMatch(applySource, /state\.diagramImportPreview = null/);
  assert.match(appliedEditorSource, /authoring\.d2Import/);
  assert.match(appliedEditorSource, /editorMode: 'applied'/);
  const currentPreviewStart = proxySource.indexOf('function previewCurrentDiagramImport()');
  const currentPreviewEnd = proxySource.indexOf('function previewAppliedDiagramImport()', currentPreviewStart);
  const currentPreviewSource = proxySource.slice(currentPreviewStart, currentPreviewEnd);
  const appliedPreviewStart = proxySource.indexOf('function previewAppliedDiagramImport()');
  const appliedPreviewEnd = proxySource.indexOf('function applyDiagramImport()', appliedPreviewStart);
  const appliedPreviewSource = proxySource.slice(appliedPreviewStart, appliedPreviewEnd);
  const runtimePreviewStart = proxySource.indexOf('function runDiagramImportRuntimePreview(options)');
  const runtimePreviewEnd = proxySource.indexOf('function previewCurrentDiagramImport()', runtimePreviewStart);
  const runtimePreviewSource = proxySource.slice(runtimePreviewStart, runtimePreviewEnd);
  const previewTemplateStart = proxySource.indexOf('function diagramImportPreviewTemplate()');
  const previewTemplateEnd = proxySource.indexOf('function currentDiagramImportPreviewTemplate(mode)', previewTemplateStart);
  const previewTemplateSource = proxySource.slice(previewTemplateStart, previewTemplateEnd);
  assert.match(currentPreviewSource, /captureVisibleDesignerState\(\)/);
  assert.match(currentPreviewSource, /diagramImportPreviewTemplate\(\)/);
  assert.match(currentPreviewSource, /mode: 'intermediate'/);
  assert.doesNotMatch(currentPreviewSource, /state\.lastDraftPreviewOk/);
  assert.doesNotMatch(currentPreviewSource, /state\.diagramImportAppliedPendingPreview/);
  assert.match(appliedPreviewSource, /openDiagramImportPreviewWorkspace\(\)/);
  assert.match(appliedPreviewSource, /diagramImportAppliedPreviewTemplate\(\)/);
  assert.match(appliedPreviewSource, /mode: 'applied'/);
  assert.doesNotMatch(appliedPreviewSource, /diagramImportSpecWithSavedEditor/);
  assert.match(runtimePreviewSource, /state\.diagramImportRuntimePreview = result/);
  assert.match(runtimePreviewSource, /diagramImportRuntimePreviewDetails\(result\)/);
  assert.match(proxySource, /function diagramImportRuntimePreviewWorkflowMessage\(workflow\)/);
  assert.match(proxySource, /diagramImportRuntimePreviewSourceRefreshRequired/);
  assert.match(proxySource, /diagramImportRuntimePreviewHashes/);
  assert.match(runtimePreviewSource, /state\.lastDraftPreviewOk = result\.ok && details\.ready && !details\.partial/);
  assert.match(runtimePreviewSource, /state\.diagramImportAppliedPendingPreview = !state\.lastDraftPreviewOk/);
  assert.match(runtimePreviewSource, /state\.diagramImportRuntimePreviewBusy = true/);
  assert.match(runtimePreviewSource, /requestDraftPreview\(authoringPreviewPath\(\{ executionScope: 'diagrams' \}\), template, params, requestId\)/);
  assert.match(runtimePreviewSource, /Extraction and Diagram use one RuntimeConfigJson bound/);
  assert.match(runtimePreviewSource, /previewTemplateCode/);
  assert.match(runtimePreviewSource, /diagramImportRuntimePreviewRequestSnapshot\(options\)/);
  assert.match(runtimePreviewSource, /currentDiagramImportRuntimePreviewRevision\(mode\) !== previewRevision/);
  assert.match(previewTemplateSource, /var useEditorDraft = editor && editor\.version === 3/);
  assert.match(previewTemplateSource, /var source = String\(state\.diagramImportSource \|\| ''\);/);
  assert.match(previewTemplateSource, /var sourceChanged = Boolean\(source\.trim\(\) && source !== persistedSource\);/);
  assert.match(previewTemplateSource, /diagramImportPreviewUsesCurrentDraft\(baseSpec, sourceChanged\)/);
  assert.match(previewTemplateSource, /var previewSpec = useEditorDraft/);
  assert.match(proxySource, /function diagramImportAppliedEditorHasUnsavedChanges\(proposal, spec\)/);
  assert.match(proxySource, /function diagramImportUsesCurrentEditorDraft\(spec\)/);
  assert.match(proxySource, /function diagramImportPreviewUsesCurrentDraft\(spec, sourceChanged\)/);
  assert.match(proxySource, /state\.diagramImportAppliedEditorDirty = diagramImportAppliedEditorHasUnsavedChanges\(proposal, spec\)/);
  assert.match(proxySource, /function retryDiagramImportRuntimePreview\(\)/);
  const retryPreviewStart = proxySource.indexOf('function retryDiagramImportRuntimePreview()');
  const retryPreviewEnd = proxySource.indexOf('function applyDiagramImport()', retryPreviewStart);
  const retryPreviewSource = proxySource.slice(retryPreviewStart, retryPreviewEnd);
  assert.match(retryPreviewSource, /diagramImportPreviewUsesCurrentDraft\(spec\) \? 'intermediate' : 'applied'/);
  assert.match(retryPreviewSource, /currentDiagramImportRuntimePreviewRevision\(mode\) === String\(snapshot\.revision \|\| ''\)/);
  assert.match(proxySource, /state\.diagramImportRuntimePreviewSnapshot = snapshot/);
  assert.match(proxySource, /if \(action === 'diagram-import-preview-retry'\) retryDiagramImportRuntimePreview\(\)/);
  assert.match(runtimePreviewSource, /queueDiagramImportRuntimePreview\(snapshot\)/);
  assert.match(runtimePreviewSource, /runDiagramImportRuntimePreview\(\{ requestSnapshot: queued \}\)/);
  assert.match(proxySource, /diagramImportRuntimePreviewQueued: null/);
  assert.match(proxySource, /path: 'draft\/preview\?maxRows=' \+ authoringPreviewMaxRows\(\) \+ '&executionScope=diagrams'/);
  assert.match(proxySource, /params: params/);
  assert.match(runtimePreviewSource, /diagramImportPreviewSuperseded/);
  assert.match(runtimePreviewSource, /state\.diagramImportRuntimePreviewRequestId !== requestId/);
  assert.match(proxySource, /function diagramImportAppliedPreviewTemplate\(\)/);
  assert.match(proxySource, /function openDiagramImportPreviewWorkspace\(\)/);
  assert.match(proxySource, /diagramImportRuntimePreviewRequired/);
  assert.match(proxySource, /data-action="diagram-import-preview-retry"/);
  assert.match(proxySource, /data-action="diagram-import-preview-current"/);
  assert.match(proxySource, /function draftPreviewRequestTimeoutMs\(\)/);
  assert.doesNotMatch(proxySource, /function renderDiagramImportRuntimeSourceFallback\(\)/);
  assert.match(proxySource, /diagramImportRuntimePreviewPartial/);
  assert.match(proxySource, /diagramImportRuntimePreviewMappingPartial/);
  assert.match(proxySource, /diagramImportRuntimePreviewOmitted/);
  assert.match(proxySource, /resultBody\.diagramPreview/);
  assert.match(proxySource, /mappingOmissions/);
  assert.match(proxySource, /diagnosticPreview/);
  assert.match(proxySource, /function renderDiagramImportRuntimeExecution\(diagrams, spec\)/);
  assert.match(proxySource, /data-diagram-import-execution-contract/);
  assert.match(proxySource, /Контракт выполнения mapping/);
  assert.match(proxySource, /data-diagram-import-materialization-ledger/);
  assert.match(proxySource, /Материализованные объекты диаграммы/);
  assert.match(proxySource, /data-diagram-import-unconfigured-structure/);
  assert.match(proxySource, /Часть структуры D2 не настроена/);
  assert.match(proxySource, /function renderDiagramSvgContract\(diagram\)/);
  assert.match(proxySource, /Автоматический exemplar/);
  assert.match(proxySource, /Единственный контейнер/);
  const visualizeStart = proxySource.indexOf('function visualizeInEditor()');
  const visualizeEnd = proxySource.indexOf('function visualizeExternal()', visualizeStart);
  const visualizeSource = proxySource.slice(visualizeStart, visualizeEnd);
  assert.match(visualizeSource, /authoringPreviewPath\(diagramOnlyPreview \? \{ executionScope: 'diagrams' \} : \{\}\)/);
  assert.match(visualizeSource, /diagramImportRuntimePreviewMappingPartial/);
  const runtimeResultStart = proxySource.indexOf('function renderRuntimeResult(result)');
  const runtimeResultEnd = proxySource.indexOf('function renderExecutionTrace', runtimeResultStart);
  assert.match(proxySource.slice(runtimeResultStart, runtimeResultEnd), /renderDiagramImportRuntimeExecution/);
  assert.match(proxySource, /function diagramImportRuntimePreviewTiming\(preview, spec\)/);
  assert.doesNotMatch(currentPreviewSource, /state\.result = result/);
  assert.doesNotMatch(analyzeSource, /saveTemplate\(/);
  assert.doesNotMatch(assistantSource, /saveTemplate\(/);
  assert.doesNotMatch(applySource, /saveTemplate\(/);
  assert.doesNotMatch(analyzeSource + assistantSource + applySource, /publishSnapshot\(/);
  const diagramStart = proxySource.indexOf('function renderDiagramEditor(spec, outputMode, options)');
  const diagramEnd = proxySource.indexOf('function objectSelectionPrefixForAlias', diagramStart);
  const diagramSource = proxySource.slice(diagramStart, diagramEnd);
  assert.doesNotMatch(diagramSource, /renderDiagramImportWorkbench/);
  assert.match(diagramSource, /renderDiagramImportDeterministicMappings/);
  assert.doesNotMatch(diagramSource, /renderDiagramImportRuntimePreview\(\)/);
  const visualizationStart = proxySource.indexOf('function renderVisualizationEditor(selected)');
  const visualizationEnd = proxySource.indexOf('function renderDiagramSectionEditor(selected)', visualizationStart);
  const visualizationSource = proxySource.slice(visualizationStart, visualizationEnd);
  assert.match(visualizationSource, /renderDiagramImportPreviewWorkspace\(spec\)/);
  assert.doesNotMatch(visualizationSource, /renderDiagramEditor\(spec, outputMode\)/);
  const deterministicStart = proxySource.indexOf('function renderDiagramImportDeterministicMappings(spec)');
  const deterministicEnd = proxySource.indexOf('function renderImportedD2Status(diagram)', deterministicStart);
  const deterministicSource = proxySource.slice(deterministicStart, deterministicEnd);
  assert.match(deterministicSource, /var proposal = activeDiagramImportEditorModel\(spec\)/);
  assert.match(deterministicSource, /data-diagram-import-editor-mode/);
  assert.match(deterministicSource, /diagramImportProposalReadiness\(proposal\)/);
  assert.doesNotMatch(deterministicSource, /data-diagram-import-pending-priority/);
  assert.match(deterministicSource, /renderDiagramImportEditorTabs\(editorTab\)/);
  assert.doesNotMatch(deterministicSource, /renderDiagramImportNodeMappings\(proposal, spec\)/);
  assert.match(deterministicSource, /renderDiagramImportStructureEditor\(proposal, spec\)/);
  assert.match(deterministicSource, /renderDiagramImportRelationRules\(proposal, spec\)/);
  assert.doesNotMatch(deterministicSource, /diagram-import-preview-current/);
  assert.match(proxySource, /renderActionButton\('diagram-import-preview-current'/);
  assert.match(deterministicSource, /diagramImportEditorSaveHint/);
  assert.doesNotMatch(deterministicSource, /diagram-import-apply/);
  assert.doesNotMatch(deterministicSource, /diagram-import-update-applied/);
  assert.match(captureImportSource, /data-diagram-import-placement-mapping/);
  assert.match(captureImportSource, /mapping\.conditions = capturePlacementConditions\(\)/);
  assert.match(captureImportSource, /renderedAppliedMapping/);
  assert.match(captureImportSource, /appliedDiagramImportEditorModel\(spec\)/);
  assert.match(captureImportSource, /activeDiagramImportEditorModel\(spec\)/);
  assert.match(captureImportSource, /proposal\.structureTree = structureTree/);
  assert.match(captureImportSource, /proposal\.relationRules/);
  assert.match(proxySource, /function templateAuthoringClient\(spec\)/);
  const authoringStateStart = proxySource.indexOf('function diagramImportAnalysisCheckpointFromState(spec, persistedSource)');
  const authoringStateEnd = proxySource.indexOf('function assistantSpecWithPrompts(spec)', authoringStateStart);
  const authoringStateSource = proxySource.slice(authoringStateStart, authoringStateEnd);
  assert.ok(authoringStateStart > -1);
  assert.ok(authoringStateEnd > authoringStateStart);
  assert.match(authoringStateSource, /state\.diagramImportProposal/);
  assert.match(authoringStateSource, /analysisCheckpoint: diagramImportAnalysisCheckpointFromState\(spec, d2Source\)/);
  assert.match(authoringStateSource, /assistantCheckpoint: diagramImportAssistantCheckpointFromState\(spec, d2Source\)/);
  assert.match(authoringStateSource, /var hasAppliedImport = Boolean\(imported && imported\.version === 3/);
  assert.match(authoringStateSource, /var analyzedSource = state\.diagramImportProposal/);
  assert.match(authoringStateSource, /var d2Source = analyzedSource \|\| \(hasAppliedImport/);
  assert.match(proxySource, /function assistantSpecWithPrompts\(spec\)/);
  assert.match(proxySource, /function diagramImportAnalysisCheckpointMatchesAppliedMapping\(mapping, checkpoint\)/);
  assert.match(proxySource, /function diagramImportCheckpointCanFollowCurrentMapping\(mapping, checkpoint, sourceHash\)/);
  assert.match(proxySource, /!provisionalBaseMatches && !checkpointMatchesAppliedMapping && !currentMappingMayRebaseCheckpoint && !executableMappingIsCurrent/);
  assert.match(proxySource, /function diagramAuthoringReanalysisReasons\(spec\)/);
  assert.match(proxySource, /diagramAuthoringStatusForSpec\(next\)\.status !== 'needsReanalysis'/);
  assert.doesNotMatch(proxySource, /rebaseStoredD2AnalysisCheckpoint\(recompiled\)/);
  assert.doesNotMatch(proxySource, /rebaseStoredD2AnalysisCheckpoint\(partial\.spec\)/);
  const assistantRequestSpecStart = proxySource.indexOf('function assistantDiagramRequestSpec(spec, proposal)');
  const assistantRequestSpecEnd = proxySource.indexOf('function markAssistantAuthoringChanged()', assistantRequestSpecStart);
  const assistantRequestSpecSource = proxySource.slice(assistantRequestSpecStart, assistantRequestSpecEnd);
  assert.ok(assistantRequestSpecStart > -1);
  assert.ok(assistantRequestSpecEnd > assistantRequestSpecStart);
  assert.match(assistantRequestSpecSource, /var next = assistantSpecWithPrompts\(spec \|\| defaultSpec\(\)\)/);
  assert.match(assistantRequestSpecSource, /var proposalSource = String\(proposal && proposal\.sourceText \|\| ''\)/);
  assert.match(assistantRequestSpecSource, /next\.authoring\.d2\.source = proposalSource/);
  assert.doesNotMatch(proxySource, /function assistantD2AuthoringDraft\(\)/);
  assert.doesNotMatch(proxySource, /function assistantDraftWithAppliedD2Identity\(spec, draft\)/);
  assert.doesNotMatch(proxySource, /function resetAssistantD2AuthoringIdentity\(authoring\)/);
  assert.match(proxySource, /для каждого элемента с источником Object Flow отдельно задаются способ наполнения и дополнительная фильтрация результата/);
  assert.match(proxySource, /data-diagram-structure-tree/);
  assert.match(proxySource, /data-diagram-import-rule-row/);
  assert.match(proxySource, /directionPolicy/);
  assert.match(proxySource, /data-diagram-mapping-id/);
  assert.match(proxySource, /data-import-role-key/);
  assert.match(proxySource, /state\.diagramImportStale/);
  assert.match(proxySource, /diagramImportProposalHasReviewBlocker/);
  assert.match(proxySource, /'diagram',[\s\S]*?'visualization'/);
  assert.match(proxySource, /diagramImportAppliedPendingPreview && !state\.lastDraftPreviewOk/);
  const saveFunctionStart = proxySource.indexOf('function saveTemplate()');
  const saveFunctionEnd = proxySource.indexOf('function openAssistantSection()', saveFunctionStart);
  const saveFunctionSource = proxySource.slice(saveFunctionStart, saveFunctionEnd);
  assert.ok(saveFunctionStart > -1);
  assert.ok(saveFunctionEnd > saveFunctionStart);
  assert.match(saveFunctionSource, /diagramImportSaveBusy/);
  assert.match(saveFunctionSource, /var activeDiagramEditor = state\.designerSection === 'diagram'/);
  assert.match(saveFunctionSource, /\? activeDiagramImportEditorModel\(/);
  assert.match(saveFunctionSource, /captureDiagramImportProposalFromDom\(\) \|\| activeDiagramEditor/);
  assert.doesNotMatch(saveFunctionSource, /state\.diagramImportAppliedEditorDirty \? captureDiagramImportProposalFromDom\(\) : null/);
  assert.match(saveFunctionSource, /diagramImportSpecWithSavedEditor/);
  assert.match(proxySource, /function diagramImportSpecWithSavedEditor\(spec, proposal\)/);
  assert.doesNotMatch(proxySource, /appliedDiagramImportSpecWithSavedMapping/);
  assert.match(proxySource, /mappingValidation = \{ version: 1, status: 'needsValidation' \}/);
  assert.match(proxySource, /diagramImportSignedProposal/);
  assert.match(proxySource, /markImportedDiagramChanged/);
  assert.match(proxySource, /assistantResponseStale/);
  assert.match(proxySource, /function diagramImportRequestRevisionSnapshot\(/);
  assert.match(proxySource, /function diagramImportRequestRevisionError\(/);
  assert.doesNotMatch(analyzeSource + assistantSource + applySource, /state\.selectedTemplate !== requestTemplate/);
  assert.match(proxySource, /function normalizeD2AnalysisCheckpoint\(/);
  assert.match(proxySource, /function normalizeD2AssistantCheckpoint\(/);
  assert.match(proxySource, /D2_IMPORT_ASSISTANT_CHECKPOINT_MAX_BYTES/);
  assert.match(proxySource, /d2-import-restore/);
  assert.doesNotMatch(proxySource, /function applyAppliedDiagramImportChanges\(\)/);
  assert.doesNotMatch(proxySource, /diagram-import-update-applied/);
  const objectFlowRouteStart = proxySource.indexOf("if (requestUrl.pathname === `${BACKEND_PREFIX}/assistant/object-flow/plan`");
  const objectFlowRouteEnd = proxySource.indexOf("if (requestUrl.pathname === `${BACKEND_PREFIX}/draft/object-flow/apply`", objectFlowRouteStart);
  const objectFlowRouteSource = proxySource.slice(objectFlowRouteStart, objectFlowRouteEnd);
  assert.match(objectFlowRouteSource, /createAssistantObjectFlowDraft/);
  assert.match(proxySource, /Stage-by-stage object-flow contracts are not supported/);
  assert.match(proxySource, /assistant_contract_removed/);
  assert.doesNotMatch(objectFlowRouteSource, /createAssistantTemplateDraft/);
  const diagramAssistantRouteStart = proxySource.indexOf("if (requestUrl.pathname === `${BACKEND_PREFIX}/assistant/diagram-import/interpret`");
  const diagramAssistantRouteEnd = proxySource.indexOf("if (requestUrl.pathname === `${BACKEND_PREFIX}/assistant/diagram-import/complete`", diagramAssistantRouteStart);
  const diagramAssistantRouteSource = proxySource.slice(diagramAssistantRouteStart, diagramAssistantRouteEnd);
  assert.match(diagramAssistantRouteSource, /createAssistantDiagramStageDraft/);
  assert.doesNotMatch(diagramAssistantRouteSource, /createAssistantTemplateDraft/);
  assert.doesNotMatch(proxySource, /data-diagram-import-role-row/);
  assert.match(proxySource, /data-diagram-structure-tree-row/);
  assert.match(proxySource, /data-action="diagram-structure-add-root"/);
  assert.match(proxySource, /data-action="diagram-structure-add-child"/);
  assert.doesNotMatch(proxySource, /data-diagram-import-role-mapping/);
  assert.match(proxySource, /data-diagram-import-placement-mapping/);
  const placementMappingStart = proxySource.indexOf('function renderDiagramImportPlacementMapping(role, item, spec, proposal)');
  const placementMappingEnd = proxySource.indexOf('function renderDiagramImportRelationRules(proposal, spec)', placementMappingStart);
  const placementMappingSource = proxySource.slice(placementMappingStart, placementMappingEnd);
  assert.ok(placementMappingStart > -1);
  assert.ok(placementMappingEnd > placementMappingStart);
  assert.doesNotMatch(placementMappingSource, /data-diagram-import-placement-field="primary\.className"/);
  assert.match(placementMappingSource, /primaryCardSourceControl/);
  assert.match(proxySource, /data-diagram-import-placement-field="primary\.cardSource"/);
  assert.match(proxySource, /Карточка результата для повторения/);
  assert.match(proxySource, /function renderDiagramImportPrimaryCardSourceControl\(/);
  assert.match(proxySource, /Каждая уникальная карточка/);
  assert.match(placementMappingSource, /Подпись использует поля результата/);
  assert.doesNotMatch(placementMappingSource, /diagram-import-readonly-value/);
  assert.match(placementMappingSource, /diagramImportLabelTemplateLabel\(sourceInfo, materializationKind, spec \|\| defaultSpec\(\)\)/);
  assert.match(placementMappingSource, /renderDiagramImportNodeDataFields\(/);
  assert.match(placementMappingSource, /renderDiagramImportPlacementConditions\(/);
  assert.match(proxySource, /data-diagram-import-node-data/);
  assert.doesNotMatch(placementMappingSource, /data-diagram-import-placement-field="primary\.idAttribute"/);
  assert.match(proxySource, /function diagramImportPrimaryIdAttribute\(role, primary/);
  assert.match(proxySource, /primary\.idAttribute = '_id'/);
  assert.doesNotMatch(proxySource, /value\('materialization\.kind'\) \|\| \(diagramImportRoleVisualKindClient\(role\) === 'container' \? 'structural' : 'stage'\)/);
  assert.match(proxySource, /diagram-import-add-related/);
  assert.match(proxySource, /diagram-import-enable-rule/);
  assert.match(proxySource, /diagram-import-disable-rule/);
  assert.match(proxySource, /Поля сопоставления объектов и контейнеров/);
  assert.match(proxySource, /state\.diagramImportProposal && state\.diagramImportProposal\.version === 3/);
  assert.match(proxySource, /function catalogRelationPathOptions\(className, searchQuery\)/);
  assert.match(proxySource, /Number\(state\.maxTraversalDepth\)/);
  assert.match(proxySource, /data-relation-path/);
  assert.match(proxySource, /function renderRelationPathPlanner\(model, spec\)/);
  assert.match(proxySource, /function appendRelationPath\(\)/);
  assert.match(proxySource, /data-action="append-relation-path"/);
  assert.match(proxySource, /catalogDomainRelationPathOptions/);
  assert.match(proxySource, /renderCatalogFieldMultiPicker\(/);
  assert.doesNotMatch(proxySource, /function renderDiagramImportAttributeMultiSelect/);
  assert.match(proxySource, /diagramImportSelectedValues/);
  assert.match(placementMappingSource, /diagramImportLabelTemplateEditorValue\(role, spec \|\| defaultSpec\(\), mapping, item\.id, proposal, item\)/);
  assert.match(placementMappingSource, /data-diagram-import-label-template/);
  assert.match(placementMappingSource, /<div class="diagram-import-label-template"/);
  assert.match(placementMappingSource, /data-diagram-import-label-autocomplete/);
  assert.match(proxySource, /function selectDiagramImportLabelAutocompleteTarget\(target\)/);
  assert.match(proxySource, /addEventListener\('pointerdown'/);
  assert.doesNotMatch(placementMappingSource, /diagram-template-suggestions/);
  assert.doesNotMatch(placementMappingSource, /related_comparison_/);
  assert.match(proxySource, /function diagramImportEnsureRelatedTemplateFields\(mapping, template, candidates\)/);
  assert.match(proxySource, /diagramImportEnsureRelatedTemplateFields\(mapping, primary\.labelTemplate/);
  assert.match(proxySource, /function diagramImportEnsureChildTemplateFields\(proposal, parentItem, template, candidates\)/);
  assert.match(placementMappingSource, /Структурная рамка не имеет собственного источника/);
  assert.match(proxySource, /\['_id', 'Id', 'Class', 'SourceId', 'RelatedId'\]/);
  assert.match(proxySource, /configuredModelCatalogRequestUrl/);
  assert.doesNotMatch(proxySource, /model\/catalog\?maxClasses=500&maxDomains=500/);
  const v3ProposalStart = proxySource.indexOf('function renderDiagramImportProposal(spec)');
  const v3ProposalEnd = proxySource.indexOf('function renderDiagramImportWorkbench', v3ProposalStart);
  const v3ProposalSource = proxySource.slice(v3ProposalStart, v3ProposalEnd);
  assert.doesNotMatch(v3ProposalSource, /diagramImportSourceAlias/);
  assert.doesNotMatch(v3ProposalSource, /data-diagram-import-binding/);
  const visualizationReadStart = proxySource.indexOf('function readVisualizationSettings(required, currentSpec)');
  const visualizationReadEnd = proxySource.indexOf('function applyVisualizationToSpec', visualizationReadStart);
  const visualizationReadSource = proxySource.slice(visualizationReadStart, visualizationReadEnd);
  assert.match(visualizationReadSource, /storedDiagram\.authoring && storedDiagram\.authoring\.d2Import && storedDiagram\.authoring\.d2Import\.version === 3/);
  assert.match(visualizationReadSource, /Object\.assign\(cloneJsonValue\(storedDiagram, \{\}\)/);
  const readMappingsStart = proxySource.indexOf('function readDiagramMappingRows(kind)');
  const readMappingsEnd = proxySource.indexOf('function readVisualizationSettings', readMappingsStart);
  const readMappingsSource = proxySource.slice(readMappingsStart, readMappingsEnd);
  assert.match(readMappingsSource, /storedMappings\.find/);
  assert.match(readMappingsSource, /cloneJsonValue\(stored/);
  assert.match(readMappingsSource, /if \(!mapping\.importRole && importRoleKey\)/);
});

test('only the main Diagram editor remains; Diagram editor 2 sandbox UI and API are removed', () => {
  assert.doesNotMatch(proxySource, /data-designer-section="diagram-2"/);
  assert.doesNotMatch(proxySource, /menuDiagramSandbox/);
  assert.doesNotMatch(proxySource, /diagram-sandbox/);
  assert.doesNotMatch(proxySource, /diagramSandboxProposal/);
  const menuStart = proxySource.indexOf('function renderDesignerMenu()');
  const menuEnd = proxySource.indexOf('function renderNumberSetting', menuStart);
  const menuSource = proxySource.slice(menuStart, menuEnd);
  assert.match(menuSource, /section: 'diagram'/);
  assert.match(proxySource, /data-action="diagram-import-editor-tab"/);
  assert.match(proxySource, /diagramImportEditorTab/);
  assert.match(proxySource, /diagramImportStructureTitle/);
  assert.match(proxySource, /diagramImportEditorHierarchyTab/);
  assert.match(proxySource, /function renderDiagramImportRelatedDataForItem\(proposal, spec, item, role, mapping\)/);
  assert.match(proxySource, /data-diagram-import-related-data-row/);
  assert.match(proxySource, /function renderDiagramImportHierarchyEditor\(proposal, spec\)/);
  assert.match(proxySource, /data-diagram-import-hierarchy-row/);
  assert.match(proxySource, /data-diagram-import-hierarchy-child-stage-id/);
  assert.match(proxySource, /function diagramImportReplaceStructureItemMappingClient\(proposal, itemId, mapping\)/);
  assert.match(proxySource, /var hierarchyRuleMutation = action === 'diagram-import-add-hierarchy-condition'/);
  assert.match(proxySource, /data-diagram-import-open-structure="true"/);
  assert.match(proxySource, /data-diagram-import-hierarchy-assistant-badge/);
  assert.doesNotMatch(proxySource, /function renderDiagramImportRelatedDataEditor\(proposal, spec\)/);
  assert.doesNotMatch(proxySource, /diagramImportRelatedModeTraversal/);
  assert.match(proxySource, /diagramImportRelatedModeStage/);
  assert.match(proxySource, /function renderDiagramImportStructureTree\(proposal, spec\)/);
});

test('Assistant applies data flow locally; normal Save remains the only persistence path', () => {
  const applyStart = proxySource.indexOf('function applyAssistantObjectFlow()');
  const applyEnd = proxySource.indexOf('function assistantDiagramRequest(kind)', applyStart);
  const applySource = proxySource.slice(applyStart, applyEnd);
  const routeStart = proxySource.indexOf("if (requestUrl.pathname === `${BACKEND_PREFIX}/draft/object-flow/apply`)");
  const routeEnd = proxySource.indexOf("if (requestUrl.pathname === `${BACKEND_PREFIX}/assistant/diagram-import/interpret`", routeStart);
  const routeSource = proxySource.slice(routeStart, routeEnd);

  assert.ok(applyStart > -1);
  assert.ok(routeStart > -1);
  assert.match(proxySource, /assistantApplyFlow: 'Применить цепочку'/);
  assert.match(applySource, /captureAssistantPromptsFromDom\(\)/);
  assert.match(applySource, /result\.json\.spec/);
  assert.match(applySource, /changesReadyToSave/);
  assert.match(routeSource, /template_save_required/);
  assert.match(routeSource, /persisted: false/);
  assert.doesNotMatch(routeSource, /writeTemplateVersion/);
  assert.doesNotMatch(routeSource, /invalidateTemplateRuntimeCache/);
  assert.doesNotMatch(routeSource, /invalidateTemplateStaticSnapshots/);
  assert.doesNotMatch(proxySource, /assistant\/object-flow\/preview/);
  assert.doesNotMatch(proxySource, /data-action="assistant-flow-preview"/);
});

test('D2 skill records structured vars.data.cmdp metadata rule', () => {
  const skillSource = fs.readFileSync('.agents/skills/cmdbuild-d2-diagrams/SKILL.md', 'utf8');
  const languageReference = fs.readFileSync('.agents/skills/cmdbuild-d2-diagrams/references/d2-language-notes.md', 'utf8');

  assert.match(skillSource, /references\/d2-language-notes\.md/);
  assert.match(skillSource, /vars\.data\.cmdp/);
  assert.match(languageReference, /vars\.data\.cmdp/);
  assert.match(languageReference, /Do not serialize metadata as comments or base64 comment blocks/);
  assert.match(languageReference, /vars\.data\.cmdp\.import\.static/);
  assert.match(languageReference, /Static Template Subtree/);
  assert.match(languageReference, /https:\/\/d2lang\.com\/tour\/vars\//);
  assert.match(skillSource, /composite/);
  assert.match(skillSource, /D2 `class`/);
  assert.match(skillSource, /Every declared D2 element\/placement remains independently editable/);
  assert.match(skillSource, /structureTree\.items\[\]\.mapping/);
  assert.match(skillSource, /Do not persist `roleMappings`, `sourceStageOverrideId`, or the retired placement `source\.stageId`/);
  assert.match(skillSource, /one reviewed Object Flow stage/);
  assert.match(skillSource, /Related N:N rows remain arrays/);
  assert.match(skillSource, /Every selection and intermediate match stage/);
  assert.match(skillSource, /derive aliases server-side/);
  assert.match(languageReference, /instance paths are not mapping rows/);
  assert.doesNotMatch(skillSource, /must not merge or type mapping roles/);
});

test('D2 import helper handles stdin errors without crashing the backend', () => {
  const start = proxySource.indexOf('function runD2ImportProcess(source, options = {})');
  const end = proxySource.indexOf('function normalizeDiagramImportElement', start);
  assert.ok(start > -1 && end > start);
  assert.match(proxySource.slice(start, end), /child\.stdin\.on\('error'/);
  assert.match(proxySource, /parsed\.version >= 4/);
});

test('runtime diagram view exposes D2 rendered SVG and source download affordances', () => {
  const downloadStart = proxySource.indexOf('function runtimeD2DownloadPath(result, diagram, diagramIndex)');
  const renderStart = proxySource.indexOf('function renderDiagramToolbar(diagram, toolbarHtml, d2DownloadHref)');
  const renderRuntimeStart = proxySource.indexOf('function renderRuntimeResult(result)');
  const loadRuntimeStart = proxySource.indexOf('function loadRuntime(refresh)');
  assert.ok(downloadStart > -1);
  assert.ok(renderStart > downloadStart);
  assert.ok(renderRuntimeStart > renderStart);
  assert.ok(loadRuntimeStart > renderRuntimeStart);

  const downloadSource = proxySource.slice(downloadStart, renderStart);
  const renderSource = proxySource.slice(renderStart, renderRuntimeStart);
  const runtimeSource = proxySource.slice(renderRuntimeStart, loadRuntimeStart);
  const loadSource = proxySource.slice(loadRuntimeStart, proxySource.indexOf('function applyRenderedTableFilter'));

  assert.match(proxySource, /d2DownloadSource: 'Download D2 source'/);
  assert.match(proxySource, /d2DownloadSource: 'Скачать D2 source'/);
  assert.match(proxySource, /publicationPublicD2Source: 'Allow public D2 source download'/);
  assert.match(proxySource, /publicationPublicD2Source: 'Разрешить публичное скачивание D2 source'/);
  assert.match(proxySource, /d2RendererUnavailable/);
  assert.match(proxySource, /\.cmdp-d2-svg/);
  assert.match(proxySource, /function renderDiagramViewport\(content, title\)/);
  assert.match(proxySource, /data-action="diagram-zoom-out"/);
  assert.match(proxySource, /data-action="diagram-zoom-reset"/);
  assert.match(proxySource, /data-action="diagram-zoom-in"/);
  assert.match(proxySource, /function initializeDiagramViewport\(viewport\)/);
  assert.match(proxySource, /canvas\.addEventListener\('pointerdown'/);
  assert.match(proxySource, /function initializeDiagramViewports\(container\)/);
  assert.match(downloadSource, /params\.d2 = 'true'/);
  assert.match(downloadSource, /params\.diagram = selector/);
  assert.match(downloadSource, /publicSnapshotRunPath\(templateCode, params\)/);
  assert.match(downloadSource, /runtimeRunPath\(templateCode, params\)/);
  assert.match(renderSource, /diagramHasD2Download\(diagram\)/);
  assert.match(renderSource, /data-d2-source-download/);
  assert.match(proxySource, /data-action="download-draft-d2"/);
  assert.match(proxySource, /data-diagram-import-warning/);
  assert.match(proxySource, /new Blob\(\[source\], \{ type: 'text\/vnd\.d2;charset=utf-8' \}\)/);
  assert.match(proxySource, /URL\.revokeObjectURL\(url\)/);
  assert.match(renderSource, /data-d2-rendered-svg/);
  assert.match(renderSource, /return renderDiagramViewport\(/);
  assert.match(renderSource, /renderDiagramViewport\(fallbackSvg, title\)/);
  assert.match(renderSource, /data-d2-render-unavailable/);
  assert.match(runtimeSource, /runtimeD2DownloadPath\(result, diagram, diagramIndex\)/);
  assert.match(runtimeSource, /result\.downloadMode === 'draft'/);
  assert.match(proxySource, /result\.downloadMode = 'draft'/);
  assert.match(proxySource, /\^<svg\[\\\\s>\]/);
  assert.match(proxySource, /templateAction === 'run' && !cacheDisabled/);
  assert.doesNotMatch(proxySource, /templateAction === 'run' && !cacheDisabled && !d2Output/);
  assert.match(runtimeSource, /renderResultDiagram\(diagram, toolbar, d2DownloadHref\)/);
  assert.match(runtimeSource, /function renderRuntimeIntoApp\(result\)/);
  assert.match(runtimeSource, /initializeDiagramViewports\(app\)/);
  assert.match(loadSource, /runtimeSystemParam\(key\)/);
  assert.match(loadSource, /result\.downloadMode = 'template'/);
  assert.match(loadSource, /publicResult\.downloadMode = 'public'/);
});

test('snapshot publication saves static settings before publish and uses saved template version', () => {
  const publishStart = proxySource.indexOf('function publishSnapshot()');
  const launchStart = proxySource.indexOf('function refreshTemplateLaunchUrl()');
  assert.ok(publishStart > -1);
  assert.ok(launchStart > publishStart);
  const publishSource = proxySource.slice(publishStart, launchStart);

  assert.match(publishSource, /payload\.spec = applyPublicationToSpec\(payload\.spec, true\)/);
  assert.match(publishSource, /request\(savePath, \{ method: exists \? 'PUT' : 'POST', body: payload \}\)/);
  assert.match(publishSource, /var savedTemplate = saveResult\.json && saveResult\.json\.template \? saveResult\.json\.template : \{\}/);
  assert.match(publishSource, /state\.selectedTemplate = savedTemplate/);
  assert.match(publishSource, /publishSavedSpecHashMissing/);
  assert.match(publishSource, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(publishSource, /var publishCode = savedTemplate\.code \|\| payload\.code \|\| code/);
  assert.match(publishSource, /encodeURIComponent\(publishCode\) \+ '\/publish'/);
  assert.match(publishSource, /savedSpecHash: savedTemplate\.specHash/);
  assert.doesNotMatch(publishSource, /savedTemplate\.specHash \|\| ''/);
  assert.doesNotMatch(publishSource, /encodeURIComponent\(payload\.code\) \+ '\/publish'/);
});

test('dynamic runtime explains that snapshot publication is unavailable', () => {
  assert.match(proxySource, /publicationDynamicHint/);
  assert.match(proxySource, /snapshotPublicationEnabled/);
  assert.match(proxySource, /disabled: !snapshotPublicationEnabled/);
});

test('catalog field pickers load attributes only after a search and retry transient errors', () => {
  const ensureStart = proxySource.indexOf('function ensureCatalogAttributesForClass(className)');
  const viewClassesStart = proxySource.indexOf('function viewComposerCatalogClassNames(spec)');
  const ensureSectionStart = proxySource.indexOf('function ensureCatalogAttributesForDesignerSection()');
  const pickerClassesStart = proxySource.indexOf('function catalogFieldPickerClassNames(picker)');
  const refreshStart = proxySource.indexOf('function refreshCatalogFieldPickerResults(input)');
  const scheduleStart = proxySource.indexOf('function scheduleCatalogFieldPickerResults(input)');
  const extractLanguageStart = proxySource.indexOf('function extractLanguageFromValue(value)');
  assert.ok(ensureStart > -1);
  assert.ok(viewClassesStart > ensureStart);
  assert.ok(ensureSectionStart > viewClassesStart);
  assert.ok(pickerClassesStart > ensureSectionStart);
  assert.ok(refreshStart > pickerClassesStart);
  assert.ok(scheduleStart > refreshStart);
  assert.ok(extractLanguageStart > ensureSectionStart);
  const ensureSource = proxySource.slice(ensureStart, viewClassesStart);
  const ensureSectionSource = proxySource.slice(ensureSectionStart, pickerClassesStart);
  const pickerClassesSource = proxySource.slice(pickerClassesStart, refreshStart);
  const refreshSource = proxySource.slice(refreshStart, scheduleStart);

  assert.match(ensureSource, /request\(apiPrefix \+ '\/model\/classes\/' \+ encodeURIComponent\(name\) \+ '\/attributes'\)/);
  assert.match(ensureSource, /state\.catalogAttributeFailedAt\[key\]/);
  assert.match(ensureSource, /return mergeCatalogClassAttributes\(name, result\.json\.data\)/);
  assert.match(ensureSource, /catch\(function \(error\)/);
  assert.match(ensureSource, /return 'failed'/);
  assert.doesNotMatch(ensureSectionSource, /ensureCatalogAttributesForClass/);
  assert.match(pickerClassesSource, /kind === 'scope'/);
  assert.match(pickerClassesSource, /kind === 'objectGroupSource'/);
  assert.match(proxySource, /function ensureCatalogFieldPickerSearchAttributes\(picker, query\)/);
  assert.match(refreshSource, /if \(!query\) \{/);
  assert.match(refreshSource, /ensureCatalogFieldPickerSearchAttributes\(picker, query\)/);
  assert.doesNotMatch(ensureSource, /catch\(function \(error\) \{\s*state\.catalogAttributeLoaded\[key\] = true/);
});

test('shared authoring controls keep localized, stable, and compact UI contracts', () => {
  const numberSettingStart = proxySource.indexOf('function renderNumberSetting(id, labelKey, helpKey, value, options)');
  const numberSettingEnd = proxySource.indexOf('function assistantConfigForEditor(config)', numberSettingStart);
  const compactStart = proxySource.indexOf('function renderCompactMultiSelect(fieldAttribute, selectedValues, items, options)');
  const compactEnd = proxySource.indexOf('function catalogFieldPickerOptions(picker, query)', compactStart);
  const collapsedStart = proxySource.indexOf('function renderCollapsedObjectGroupSelection(selection, index, spec)');
  const collapsedEnd = proxySource.indexOf('function renderObjectGroupSelection(selection, index, spec, expanded, selections)', collapsedStart);
  const diagramTitleStart = proxySource.indexOf('function renderDiagramEditor(spec, outputMode, options)');
  const diagramTitleEnd = proxySource.indexOf('function renderVisualizationTableRow(table, settings, spec)', diagramTitleStart);
  assert.ok(numberSettingStart > -1 && numberSettingEnd > numberSettingStart);
  assert.ok(compactStart > -1 && compactEnd > compactStart);
  assert.ok(collapsedStart > -1 && collapsedEnd > collapsedStart);
  assert.ok(diagramTitleStart > -1 && diagramTitleEnd > diagramTitleStart);

  const numberSettingSource = proxySource.slice(numberSettingStart, numberSettingEnd);
  const compactSource = proxySource.slice(compactStart, compactEnd);
  const collapsedSource = proxySource.slice(collapsedStart, collapsedEnd);
  const diagramTitleSource = proxySource.slice(diagramTitleStart, diagramTitleEnd);
  const russianLocaleSource = proxySource.slice(proxySource.indexOf('    ru: {'), proxySource.indexOf('  function t(key, vars)'));
  assert.match(russianLocaleSource, /menuRuntimeSettings: 'Настройки выполнения'/);
  assert.doesNotMatch(russianLocaleSource, /Runtime-настройки|draft generation/);
  assert.match(numberSettingSource, /class="field-help-button"/);
  assert.match(numberSettingSource, /role="tooltip"/);
  assert.match(numberSettingSource, /aria-describedby/);
  assert.doesNotMatch(numberSettingSource, /class="muted"/);
  assert.match(compactSource, /<select multiple hidden data-compact-multi-select-value/);
  assert.match(compactSource, /type="checkbox" data-compact-multi-select-option/);
  assert.match(compactSource, /compactMultiSelectSummary/);
  assert.match(proxySource, /if \(target\.matches\('\[data-diagram-import-endpoint-profile-field="label"\]'\)\) \{\s*return;\s*\}/);
  assert.match(proxySource, /fieldPickerPrompt: 'Введите минимум 1 символ для поиска\.'/);
  assert.match(proxySource, /fieldPickerSearch: 'Поиск по имени, описанию или пути'/);
  assert.match(proxySource, /function renderCatalogFieldPickerRows[\s\S]*t\('fieldPickerNoMatches'\)/);
  assert.doesNotMatch(proxySource.slice(proxySource.indexOf('function renderCatalogFieldPickerRows'), proxySource.indexOf('function compactMultiSelectSummary')), />Ничего не найдено\.|>Введите минимум 1 символ|>Добавить поле</);
  assert.match(collapsedSource, /object-selection-summary-kind/);
  assert.match(collapsedSource, /object-selection-summary-name/);
  assert.match(collapsedSource, /object-selection-summary-meta/);
  assert.match(collapsedSource, /objectSelectionRulesCount/);
  assert.doesNotMatch(collapsedSource, /addObjectGroupRule/);
  assert.match(diagramTitleSource, /data-diagram-template-expression="params"/);
  assert.doesNotMatch(diagramTitleSource, /renderDiagramTemplateSuggestions\(spec, ''\)/);
  assert.match(proxySource, /matches\('\[data-diagram-template-expression="params"\]'\)/);
});

test('object group editor uses one right expression for literals, parameters, and previous-result fields', () => {
  const normalizeRuleStart = proxySource.indexOf('function normalizeObjectSelectionRule(rule)');
  const normalizeStart = proxySource.indexOf('function normalizeObjectSelection(selection, index)');
  const inferStart = proxySource.indexOf('function inferObjectGroupModel(spec)');
  const renderStart = proxySource.indexOf('function renderObjectGroupSelection(selection, index, spec, expanded, selections)');
  const renderRuleStart = proxySource.indexOf('function renderObjectGroupScopeRuleRow(rule, className, selections, selectionIndex, sourceAlias, spec, ruleIndex)');
  const renderRuleEnd = proxySource.indexOf('function objectGroupPathHintOptions(className)');
  const buildStart = proxySource.indexOf('function buildObjectGroupSpec(model, previousSpec)');
  const captureStart = proxySource.indexOf('function captureObjectGroupDraftFromDom()');
  const matchingStart = proxySource.indexOf('function readRelationExpansionFields()');
  assert.ok(normalizeRuleStart > -1);
  assert.ok(normalizeStart > -1);
  assert.ok(normalizeStart > normalizeRuleStart);
  assert.ok(inferStart > normalizeStart);
  assert.ok(renderStart > inferStart);
  assert.ok(renderRuleStart > -1);
  assert.ok(renderRuleEnd > renderRuleStart);
  assert.ok(buildStart > renderStart);
  assert.ok(captureStart > buildStart);
  assert.ok(matchingStart > captureStart);

  const normalizeSource = proxySource.slice(normalizeRuleStart, inferStart);
  const inferSource = proxySource.slice(inferStart, renderStart);
  const renderSource = proxySource.slice(renderStart, buildStart);
  const renderRuleSource = proxySource.slice(renderRuleStart, renderRuleEnd);
  const buildSource = proxySource.slice(buildStart, captureStart);
  const captureSource = proxySource.slice(captureStart, matchingStart);

  assert.match(normalizeSource, /from: String\(selection\.from/);
  assert.match(normalizeSource, /columns: normalizeObjectSelectionColumns/);
  assert.match(normalizeSource, /rightExpression: objectGroupRightExpression\(rule, operator\)/);
  assert.match(proxySource, /function objectGroupRightExpressionTokens\(value\)/);
  assert.match(normalizeSource, /function objectGroupFinalAliasFromSelections\(selections\)/);
  assert.match(normalizeSource, /function ensureObjectGroupValueColumnSources\(selections\)/);
  assert.match(normalizeSource, /stripObjectGroupSourceColumnPrefix\(sourceAlias/);
  assert.match(normalizeSource, /addObjectGroupSelectionColumn\(source\[sourceIndex\], column\)/);
  assert.match(inferSource, /var visual = getStoredVisualModel\(spec, 'objectGroup'\)/);
  assert.doesNotMatch(inferSource, /spec\.visualModel && spec\.visualModel\.mode === 'objectGroup'/);
  assert.match(inferSource, /var cardSteps = steps\.filter\(isDataSelectionStep\)/);
  assert.match(inferSource, /from: selection\.from \|\| ''/);
  assert.match(inferSource, /rightExpression: filter\.regexExpression !== undefined/);
  assert.match(renderSource, /data-object-selection-field="alias"/);
  assert.match(renderSource, /data-object-selection-field="from"/);
  assert.match(renderSource, /data-object-scope-field="rightExpression"/);
  assert.match(renderRuleSource, /data-object-scope-field="previousField"/);
  assert.match(renderSource, /data-action="remove-object-selection"/);
  assert.match(proxySource, /function renderObjectGroupExpressionSuggestions\(spec, selections, selectionIndex, sourceAlias, ruleIndex\)/);
  assert.doesNotMatch(renderSource, /data-object-scope-field="valueColumn"/);
  assert.doesNotMatch(renderSource, /data-object-selection-field="columns"/);
  assert.doesNotMatch(renderSource, /renderCatalogFieldMultiPicker\('data-object-selection-field="columns"/);
  assert.match(proxySource, /previous\.Name/);
  assert.doesNotMatch(renderSource, /objectSelectionColumnsText/);
  assert.match(buildSource, /if \(selection\.from\) step\.from = selection\.from/);
  assert.match(buildSource, /filter\.regexExpression = String\(rule\.rightExpression/);
  assert.match(buildSource, /filter\.valueExpression = String\(rule\.rightExpression/);
  assert.match(buildSource, /step\.columns = selection\.columns\.slice\(\)/);
  assert.match(buildSource, /ensureObjectGroupValueColumnSources\(selections\)/);
  assert.match(buildSource, /var finalAlias = objectGroupFinalAliasFromSelections\(selections\)/);
  assert.match(buildSource, /name: finalAlias/);
  assert.match(buildSource, /alias: finalAlias \|\| first\.alias \|\| 'objects'/);
  assert.match(buildSource, /title: finalSelection\.name \|\| defaultObjectSelectionName/);
  assert.match(buildSource, /columns: \[\]/);
  assert.match(buildSource, /var preservedTables = previousTables\.filter/);
  assert.match(captureSource, /data-object-selection-field="from"/);
  assert.match(captureSource, /data-object-scope-field="rightExpression"/);
  assert.match(captureSource, /columns: existing\.columns/);
  assert.match(proxySource, /function objectSelectionDependencyLabels\(selections, selectionIndex, spec\)/);
  assert.match(proxySource, /function removeObjectSelection\(index\)/);
});

test('object group path hint filters are conditional and UI-only', () => {
  const optionsStart = proxySource.indexOf('function objectGroupPathHintOptions(className)');
  const renderStart = proxySource.indexOf('function renderObjectGroupPathHintFilters(className)');
  const regexExamplesStart = proxySource.indexOf('function objectGroupRegexExamples()');
  const selectionStart = proxySource.indexOf('function renderObjectGroupSelection(selection, index, spec, expanded, selections)');
  const editorStart = proxySource.indexOf('function renderObjectGroupEditor(selected)');
  const readStart = proxySource.indexOf('function readObjectGroupFields()');
  const buildStart = proxySource.indexOf('function buildObjectGroupSpec(model, previousSpec)');
  const applyStart = proxySource.indexOf('function applyObjectPathFilter(container)');
  const visualizationStart = proxySource.indexOf('function visualizationTableNameForRowGroup(container)');
  assert.ok(optionsStart > -1);
  assert.ok(renderStart > optionsStart);
  assert.ok(regexExamplesStart > renderStart);
  assert.ok(selectionStart > regexExamplesStart);
  assert.ok(editorStart > selectionStart);
  assert.ok(readStart > editorStart);
  assert.ok(buildStart > readStart);
  assert.ok(applyStart > buildStart);
  assert.ok(visualizationStart > applyStart);

  const optionsSource = proxySource.slice(optionsStart, renderStart);
  const renderSource = proxySource.slice(renderStart, regexExamplesStart);
  const selectionSource = proxySource.slice(selectionStart, editorStart);
  const readSource = proxySource.slice(readStart, buildStart);
  const applySource = proxySource.slice(applyStart, visualizationStart);

  assert.match(optionsSource, /item\.domain \|\| item\.cardinality \|\| item\.direction/);
  assert.match(optionsSource, /Object\.keys\(provenance\)\.length > 1/);
  assert.match(renderSource, /<details class="object-group-path-hint-filters" data-object-path-filter/);
  assert.match(renderSource, /objectGroupPathHintFiltersHelp/);
  assert.match(renderSource, /objectGroupDomainFilterHelp/);
  assert.match(renderSource, /objectGroupCardinalityFilterHelp/);
  assert.match(renderSource, /objectGroupDirectionFilterHelp/);
  assert.match(selectionSource, /renderObjectGroupPathHintFilters\(selection\.className\)/);
  assert.doesNotMatch(readSource, /domainFilter|cardinalityFilter|directionFilter/);
  assert.match(applySource, /option\.hidden = !matches/);
});

test('object group final alias drives extraction defaults and diagnostics', () => {
  const aliasStart = proxySource.indexOf('function getObjectGroupOutputAlias(spec)');
  const finalAliasesStart = proxySource.indexOf('function finalExtractionAliases(spec)');
  const finalBaseStart = proxySource.indexOf('function finalBaseResultAlias(spec)');
  const resultLabelStart = proxySource.indexOf('function userFacingResultLabel(alias, spec)');
  const warningStart = proxySource.indexOf('function extractionSelectedSourceEmptyWarning(result, selectedName, spec)');
  const renderOptionsStart = proxySource.indexOf('function renderExtractionResultOptions(selectedName, spec, tables)');
  const extractStart = proxySource.indexOf('function extractByTemplate()');
  const applyStart = proxySource.indexOf('function applyDataSelectionEditor()');
  assert.ok(aliasStart > -1);
  assert.ok(resultLabelStart > -1);
  assert.ok(finalAliasesStart > aliasStart);
  assert.ok(finalBaseStart > finalAliasesStart);
  assert.ok(warningStart > finalBaseStart);
  assert.ok(renderOptionsStart > warningStart);
  assert.ok(extractStart > renderOptionsStart);
  assert.ok(applyStart > extractStart);

  const aliasSource = proxySource.slice(aliasStart, finalAliasesStart);
  const resultLabelSource = proxySource.slice(resultLabelStart, finalAliasesStart);
  const finalAliasesSource = proxySource.slice(finalAliasesStart, finalBaseStart);
  const finalBaseSource = proxySource.slice(finalBaseStart, warningStart);
  const warningSource = proxySource.slice(warningStart, renderOptionsStart);
  const extractSource = proxySource.slice(extractStart, applyStart);

  assert.match(aliasSource, /objectSelectionsFromModel\(visual\)/);
  assert.match(aliasSource, /objectGroupFinalAliasFromSelections\(selections\)/);
  assert.match(resultLabelSource, /assistantManifest\.assistantManaged/);
  assert.doesNotMatch(resultLabelSource, /assistantFlowOutputManifestInvalid/);
  assert.match(resultLabelSource, /output && output\.label/);
  assert.match(finalAliasesSource, /add\(getObjectGroupOutputAlias\(spec\)\)/);
  assert.match(finalBaseSource, /var objectGroupAlias = getObjectGroupOutputAlias\(spec\)/);
  assert.match(finalBaseSource, /if \(objectGroupAlias\) return objectGroupAlias/);
  assert.match(warningSource, /selectedTable\.rows/);
  assert.match(warningSource, /populatedTable\.rows\.length/);
  assert.match(warningSource, /userFacingResultLabel\(selected, spec\)/);
  assert.match(warningSource, /userFacingResultLabel\(populatedTable\.name, spec\)/);
  assert.match(extractSource, /var sourceWarning = extractionSelectedSourceEmptyWarning\(result, state\.extractionSource, payload\.spec\)/);
  assert.doesNotMatch(extractSource, /extractionSelectedSourceEmptyWarning\(result, state\.extractionSource, spec\)/);
  assert.match(extractSource, /type: result\.ok \? \(sourceWarning \? 'warning' : 'ok'\) : 'error'/);
  assert.match(extractSource, /sourceWarning \|\| t\('extractionCompleted'\)/);
});

test('Assistant extraction warns on incomplete provenance and keeps safe labels available', () => {
  const manifestStart = proxySource.indexOf('function computeAssistantObjectFlowOutputManifest(spec)');
  const cacheStart = proxySource.indexOf('function assistantObjectFlowOutputManifest(spec)', manifestStart);
  const outputManifestStart = proxySource.indexOf('function objectFlowOutputManifest(spec)', cacheStart);
  const finalAliasesStart = proxySource.indexOf('function finalExtractionAliases(spec)', outputManifestStart);
  const extractionOptionsStart = proxySource.indexOf('function extractionResultOptions(spec, tables)', finalAliasesStart);
  const renderStart = proxySource.indexOf('function renderExtractionEditor(selected)', extractionOptionsStart);
  const extractionStart = proxySource.indexOf('function extractByTemplate()', renderStart);
  const selectionStart = proxySource.indexOf('function applyDataSelectionEditor()', extractionStart);
  assert.ok(manifestStart > -1);
  assert.ok(cacheStart > manifestStart);
  assert.ok(outputManifestStart > cacheStart);
  assert.ok(finalAliasesStart > outputManifestStart);
  assert.ok(extractionOptionsStart > finalAliasesStart);
  assert.ok(renderStart > extractionOptionsStart);
  assert.ok(extractionStart > renderStart);
  assert.ok(selectionStart > extractionStart);

  const manifestSource = proxySource.slice(manifestStart, outputManifestStart);
  const finalAliasesSource = proxySource.slice(finalAliasesStart, extractionOptionsStart);
  const optionsSource = proxySource.slice(extractionOptionsStart, renderStart);
  const renderSource = proxySource.slice(renderStart, extractionStart);
  const extractionSource = proxySource.slice(extractionStart, selectionStart);

  assert.match(manifestSource, /output\.assistantManaged !== true/);
  assert.match(manifestSource, /assistantBlockIds/);
  assert.match(manifestSource, /assistantOutputManifest/);
  assert.match(manifestSource, /persisted\.blocks/);
  assert.match(manifestSource, /var isAssistantFlow = Boolean\(outputs\.some/);
  assert.doesNotMatch(manifestSource, /hasCompiledFlow|assistantObjectFlowIntentFromSpec/);
  assert.match(manifestSource, /warning: 'incomplete manifest'/);
  assert.match(manifestSource, /assistantObjectFlowManifestCache/);
  assert.doesNotMatch(finalAliasesSource, /assistantManifest\.error/);
  assert.doesNotMatch(optionsSource, /assistantManifest\.error/);
  assert.match(renderSource, /data-object-flow-recovery/);
  assert.match(renderSource, /assistantManifest\.warning/);
  assert.doesNotMatch(renderSource, /assistantFlowOutputManifestInvalid/);
  assert.match(renderSource, /renderExtractionResultOptions\(state\.extractionSource, spec, optionTables\)/);
  assert.match(renderSource, /extractionResultSourceHelp/);
  assert.doesNotMatch(extractionSource, /assistantManifest\.assistantManaged|assistantManifest\.error/);
});

test('Assistant-managed Object Flow aliases stay internal across deterministic and Diagram editors', () => {
  const resultLabelStart = proxySource.indexOf('function userFacingResultLabel(alias, spec)');
  const aliasFieldStart = proxySource.indexOf('function renderResultAliasField(attribute, alias, spec)');
  const priorOptionsStart = proxySource.indexOf('function renderPriorMaterializedAliasOptions(model, operationIndex, selectedName, spec)');
  const diagramStagesStart = proxySource.indexOf('function renderDiagramImportStageOptions(spec, selectedId)');
  const traceStart = proxySource.indexOf('function renderExecutionTrace(trace, spec)');
  const diagnosticsStart = proxySource.indexOf('function userFacingAssistantDiagnostics(value, spec, fieldName)');

  assert.ok(resultLabelStart > -1);
  assert.ok(aliasFieldStart > resultLabelStart);
  assert.ok(priorOptionsStart > -1);
  assert.ok(diagramStagesStart > priorOptionsStart);
  assert.ok(traceStart > diagramStagesStart);
  assert.ok(diagnosticsStart > aliasFieldStart);

  const aliasFieldSource = proxySource.slice(aliasFieldStart, proxySource.indexOf('function displayTitleForResult', aliasFieldStart));
  const priorOptionsSource = proxySource.slice(priorOptionsStart, proxySource.indexOf('function flowColumnOptionRows', priorOptionsStart));
  const diagramStagesSource = proxySource.slice(diagramStagesStart, proxySource.indexOf('function diagramImportStageById', diagramStagesStart));
  const traceSource = proxySource.slice(traceStart, proxySource.indexOf('function renderKeyValueTable', traceStart));
  const diagnosticsSource = proxySource.slice(diagnosticsStart, proxySource.indexOf('function displayTitleForResult', diagnosticsStart));

  assert.match(aliasFieldSource, /type="hidden"/);
  assert.match(aliasFieldSource, /result-display-name/);
  assert.match(aliasFieldSource, /userFacingResultLabel/);
  assert.match(priorOptionsSource, /escapeHtml\(row\.label\)/);
  assert.doesNotMatch(priorOptionsSource, /row\.label \+ ' \[' \+ row\.alias/);
  assert.match(diagramStagesSource, /userFacingResultLabel\(stage\.alias/);
  assert.doesNotMatch(diagramStagesSource, /label \+ ' \[' \+ stage\.alias/);
  assert.match(traceSource, /userFacingResultLabel\(item\.as/);
  assert.match(traceSource, /assistantFlowBlockName/);
  assert.match(diagnosticsSource, /aliasFields/);
  assert.match(diagnosticsSource, /userFacingResultLabel/);
});

test('Relations Apply preserves explicit operation order and source-driven columns', () => {
  const operationsStart = proxySource.indexOf('function flowOperations(model)');
  const columnsStart = proxySource.indexOf('function flowColumnOptionRows(model, spec, alias, operationIndex, seenAliases, includeCatalogPaths, searchQuery)', operationsStart);
  const buildStart = proxySource.indexOf('function buildRelationExpansionSpec(model, previousSpec)', columnsStart);
  const captureStart = proxySource.indexOf('function captureRelationDraftFromDom()', buildStart);
  assert.ok(operationsStart > -1);
  assert.ok(columnsStart > operationsStart);
  assert.ok(buildStart > columnsStart);
  assert.ok(captureStart > buildStart);

  const columnsSource = proxySource.slice(columnsStart, buildStart);
  const buildSource = proxySource.slice(buildStart, captureStart);
  assert.match(columnsSource, /flowOperations\(model\)\.slice\(0, operationIndex\)/);
  assert.match(columnsSource, /operation\.type === 'match'/);
  assert.match(buildSource, /var selectionSteps =/);
  assert.match(buildSource, /var operations = flowOperations\(model\)/);
  assert.match(buildSource, /var operationSteps = operations\.map/);
  assert.match(buildSource, /orderedRelationFlowStages\(selectionSteps, operationSteps\)/);
  assert.match(buildSource, /var steps = orderedStages\.ordered\.map/);
  assert.doesNotMatch(buildSource, /deduplicateCards/);
  assert.doesNotMatch(buildSource, /includeSource/);
});

test('deep catalog fields are query-first, cached, and locally refreshed in the relation editor', () => {
  const scopeStart = proxySource.indexOf('function catalogScopePathOptions(className, searchQuery)');
  const relationStart = proxySource.indexOf('function catalogRelationPathOptions(className, searchQuery)');
  const pickerRowsStart = proxySource.indexOf('function renderCatalogFieldPickerRows(options, selectedName, query)');
  const pickerStart = proxySource.indexOf('function renderCatalogFieldPicker(fieldAttribute, selectedName, initialOptions, context)');
  const refreshStart = proxySource.indexOf('function refreshMatchingBlockAfterSourceChange(node)');
  const refreshEnd = proxySource.indexOf('function clearObjectGroupScopeRuleRow(button)', refreshStart);
  const changeHandlerStart = proxySource.indexOf("document.addEventListener('change', function (event) {");
  const popstateStart = proxySource.indexOf("window.addEventListener('popstate'", changeHandlerStart);
  const diagramStageStart = proxySource.indexOf('function diagramImportStageFieldOptions(spec, stageId, searchQuery, selectedSource)');
  const diagramStageEnd = proxySource.indexOf('function renderDiagramImportStageFields(', diagramStageStart);

  assert.ok(scopeStart > -1);
  assert.ok(relationStart > scopeStart);
  assert.ok(pickerRowsStart > relationStart);
  assert.ok(pickerStart > pickerRowsStart);
  assert.ok(refreshStart > pickerStart);
  assert.ok(refreshEnd > refreshStart);
  assert.ok(changeHandlerStart > refreshStart);
  assert.ok(popstateStart > changeHandlerStart);
  assert.ok(diagramStageStart > -1 && diagramStageEnd > diagramStageStart);

  const scopeSource = proxySource.slice(scopeStart, relationStart);
  const relationSource = proxySource.slice(relationStart, pickerStart);
  const pickerRowsSource = proxySource.slice(pickerRowsStart, pickerStart);
  const pickerSource = proxySource.slice(pickerStart, refreshStart);
  const refreshSource = proxySource.slice(refreshStart, refreshEnd);
  const changeHandlerSource = proxySource.slice(changeHandlerStart, popstateStart);
  const diagramStageSource = proxySource.slice(diagramStageStart, diagramStageEnd);

  assert.match(scopeSource, /state\.catalogScopePathOptionsCache/);
  assert.match(scopeSource, /result\.limitReached = queue\.length > 0/);
  assert.match(scopeSource, /state\.maxCatalogPathCandidates/);
  assert.match(relationSource, /state\.catalogRelationPathOptionsCache/);
  assert.match(relationSource, /cachedDomainRelatedClasses/);
  assert.match(relationSource, /state\.maxCatalogPathCandidates/);
  assert.match(relationSource, /if \(!rootName \|\| !normalizedQuery\) return \[\];/);
  assert.match(relationSource, /visitedCandidates >= scanLimit/);
  assert.match(pickerRowsSource, /matches\.slice\(0, 60\)/);
  assert.match(pickerSource, /data-catalog-field-picker-search/);
  assert.match(pickerSource, /flowColumnOptionRows\(model, readCurrentSpec\(\), sourceAlias, operationIndex, \{\}, true, query\)/);
  assert.match(pickerSource, /function scheduleCatalogFieldPickerResults\(input\)/);
  assert.match(pickerSource, /\}, 120\);/);
  assert.match(refreshSource, /list\.innerHTML = rows/);
  assert.doesNotMatch(refreshSource, /renderDesigner\(\)/);
  assert.match(changeHandlerSource, /refreshMatchingBlockAfterSourceChange\(target\.closest\('\[data-matching-block\]'\)\)/);
  assert.match(diagramStageSource, /catalogAttributeOptions\(source\.className\)/);
  assert.match(diagramStageSource, /if \(query\)/);
  assert.match(diagramStageSource, /catalogScopePathOptions\(source\.className, query\)/);
});

test('object group dependency lookup indexes diagram aliases without serializing the full diagram', () => {
  const dependencyStart = proxySource.indexOf('function objectSelectionDependencyLabels(selections, selectionIndex, spec)');
  const dependencyEnd = proxySource.indexOf('function renderCollapsedObjectGroupSelection', dependencyStart);
  assert.ok(dependencyStart > -1);
  assert.ok(dependencyEnd > dependencyStart);
  const dependencySource = proxySource.slice(dependencyStart, dependencyEnd);
  assert.match(dependencySource, /diagramObjectFlowAliasIndex\(spec \|\| \{\}\)\.has\(alias\)/);
  assert.match(dependencySource, /function diagramObjectFlowAliasIndex\(spec\)/);
  assert.match(dependencySource, /assistantFlowStageSummaries\(assistantFlowModel\(spec \|\| defaultSpec\(\)\), spec \|\| defaultSpec\(\)\)/);
  assert.match(dependencySource, /addStage\(materialization\.stageId\)/);
  assert.match(dependencySource, /addStage\(rule && rule\.sourceStageId\)/);
  assert.doesNotMatch(dependencySource, /JSON\.stringify/);
});

test('relation editor shows the persisted Assistant result label without per-operation projection controls', () => {
  const relationStart = proxySource.indexOf('function renderRelationOperation(operation, operationIndex, model, spec)');
  const targetStart = proxySource.indexOf('function relatedTargetColumnOptions(className, selectedName, searchQuery)', relationStart);
  assert.ok(relationStart > -1);
  assert.ok(targetStart > relationStart);

  const relationSource = proxySource.slice(relationStart, targetStart);
  assert.match(relationSource, /userFacingResultLabel\(operation\.as, spec\)/);
  assert.doesNotMatch(relationSource, /data-relation-operation-field="columns"/);
  assert.doesNotMatch(relationSource, /data-relation-operation-field="limit"/);
  assert.doesNotMatch(proxySource, /data-exists-related-field="columns"/);
  assert.doesNotMatch(proxySource, /data-exists-related-field="limit"/);
  assert.match(proxySource, /renderRelationOperation\(operation, index, model, spec\)/);
});

test('shared relation limit controls explicit and deep relation reads', () => {
  const editorLimitsStart = proxySource.indexOf('function renderExecutionLimitFields(executionLimits)');
  const editorLimitsEnd = proxySource.indexOf('function schemaFieldValue(', editorLimitsStart);
  const runtimeStart = proxySource.indexOf('function normalizeExecutionLimitConfig(runtimeConfig)');
  const runtimeEnd = proxySource.indexOf('function normalizeRuntimeCacheConfig(runtimeConfig)', runtimeStart);
  const relationStart = proxySource.indexOf('async function executeExpandRelations(');
  const relationEnd = proxySource.indexOf('async function executeExistsRelatedRows(', relationStart);
  const pathStart = proxySource.indexOf('async function readRelationsForPath(');
  const pathEnd = proxySource.indexOf('async function resolveCardPathValues(', pathStart);
  assert.ok(editorLimitsStart >= 0 && editorLimitsEnd > editorLimitsStart, 'Runtime limit editor is missing.');
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'Runtime limit normalization is missing.');
  assert.ok(relationStart >= 0 && relationEnd > relationStart, 'Relation execution is missing.');
  assert.ok(pathStart >= 0 && pathEnd > pathStart, 'Deep relation-path execution is missing.');

  const editorLimitsSource = proxySource.slice(editorLimitsStart, editorLimitsEnd);
  const runtimeSource = proxySource.slice(runtimeStart, runtimeEnd);
  const relationSource = proxySource.slice(relationStart, relationEnd);
  const pathSource = proxySource.slice(pathStart, pathEnd);
  assert.match(editorLimitsSource, /cmdp-runtime-max-relations-per-card-default/);
  assert.match(editorLimitsSource, /cmdp-runtime-max-relations-per-card-max/);
  assert.match(runtimeSource, /maxRelationsPerCardDefault/);
  assert.match(runtimeSource, /maxRelationsPerCardMax/);
  assert.match(relationSource, /limits\.maxRelationsPerCard/);
  assert.doesNotMatch(relationSource, /step\.limit/);
  assert.match(pathSource, /pathCache\.maxRelationsPerCard/);
  assert.match(pathSource, /pathCache\.relationLimitReached = true/);
  assert.match(pathSource, /relations\?limit=\$\{readLimit\}/);
});

test('operation aliases immediately become available to later operations without a publication selector', () => {
  const refreshStart = proxySource.indexOf('function refreshRelationOperationAliases()');
  const clearScopeStart = proxySource.indexOf('function clearObjectGroupScopeRuleRow(button)', refreshStart);
  const inputStart = proxySource.indexOf("document.addEventListener('input'", clearScopeStart);
  const changeStart = proxySource.indexOf("document.addEventListener('change'", inputStart);
  assert.ok(refreshStart > -1);
  assert.ok(clearScopeStart > refreshStart);
  assert.ok(inputStart > clearScopeStart);
  assert.ok(changeStart > inputStart);

  const refreshSource = proxySource.slice(refreshStart, clearScopeStart);
  const inputSource = proxySource.slice(inputStart, changeStart);
  assert.doesNotMatch(refreshSource, /data-result-set-field="publishedAlias"/);
  assert.doesNotMatch(proxySource, /data-action="apply-extraction-published"/);
  assert.match(proxySource, /id="cmdp-view-source"/);
  assert.match(proxySource, /viewComposerSourceHelp/);
  assert.doesNotMatch(proxySource, /assistantFlowExtractionCandidate|assistantFlowCandidateOutput|extractionCandidateBlockId|extractionCandidateAlias/);
  assert.match(proxySource, /roles: input\.modelRoles \|\| input\.roles/);
  assert.match(refreshSource, /renderPriorMaterializedAliasOptions\(state\.relationDraft, index, selected, readCurrentSpec\(\)\)/);
  assert.match(refreshSource, /\['from', 'with'\]/);
  assert.match(inputSource, /\[data-set-operation-field="as"\], \[data-matching-block-field="as"\]/);
  assert.match(inputSource, /refreshRelationOperationAliases\(\)/);
  assert.match(proxySource, /alias: publishedAlias,/);
  assert.match(proxySource, /var finalAlias = model\.output && model\.output\.alias \|\| '';/);
  assert.doesNotMatch(proxySource, /publishedAlias \|\| \(operations\[operations\.length - 1\]/);
});

test('runtime result UI renders execution-limit warnings returned by preview or run', () => {
  const renderStart = proxySource.indexOf('function renderActionResult(result)');
  const traceStart = proxySource.indexOf('function renderExecutionTrace(trace, spec)', renderStart);
  assert.ok(renderStart > -1);
  assert.ok(traceStart > renderStart);

  const renderSource = proxySource.slice(renderStart, traceStart);
  assert.match(renderSource, /resultBody && Array\.isArray\(resultBody\.warnings\)/);
  assert.match(renderSource, /renderNotice\(\{ type: 'warning', text: warning \}\)/);
  assert.match(proxySource, /runtimeMaxSelectionScanRowsDefault/);
  assert.match(proxySource, /runtimeMaxSelectionScanRowsMax/);
});

test('D2 authoring overrides retain dynamic edits without reviving a static template subtree', () => {
  const overrideStart = proxySource.indexOf('function applyDiagramImportAuthoringOverrides(proposal)');
  const overrideEnd = proxySource.indexOf('function diagramImportStructureNextItemIdClient', overrideStart);
  assert.ok(overrideStart > -1, 'D2 authoring override helper is missing.');
  assert.ok(overrideEnd > overrideStart, 'D2 authoring override helper boundary is missing.');

  const overrideSource = proxySource.slice(overrideStart, overrideEnd);
  assert.match(overrideSource, /var staticElementKeys = \{\};/);
  assert.match(overrideSource, /var overriddenDynamicItems = overriddenItems\.filter/);
  assert.match(overrideSource, /return !keys\.some/);
  assert.match(overrideSource, /var currentStaticItems = currentItems\.filter/);
  assert.match(overrideSource, /overriddenDynamicItems\.concat\(currentStaticItems\)/);
});
