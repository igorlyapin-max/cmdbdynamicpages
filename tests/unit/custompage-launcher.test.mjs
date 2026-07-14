import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const launcherSource = fs.readFileSync('src/CmdbDynamicPages.js', 'utf8');
const proxySource = fs.readFileSync('scripts/dev-proxy-server.mjs', 'utf8');

test('Assistant browser deadline follows the configured MCP timeout with backend response grace', () => {
  const helperStart = proxySource.indexOf('function assistantRequestTimeoutMs(backendPhases)');
  const helperEnd = proxySource.indexOf('function publicSnapshotRunPath', helperStart);
  const helperSource = proxySource.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0, 'Assistant timeout helper is missing.');
  assert.match(helperSource, /assistant\.mcp\.timeoutMs/);
  assert.match(helperSource, /boot\.assistantMcpCaps/);
  assert.match(helperSource, /boot\.assistantTimeoutGraceMs/);
  assert.match(helperSource, /backendTimeout \* phases \+ grace/);
  [
    '/assistant/diagram-import/complete',
    '/assistant/diagram-import/',
    '/assistant/template-draft'
  ].forEach((route) => {
    const routeStart = proxySource.indexOf(route);
    assert.ok(routeStart >= 0, `Assistant route ${route} is missing.`);
    assert.match(proxySource.slice(routeStart, routeStart + 420), /timeoutMs: assistantRequestTimeoutMs\(\)/);
  });
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
    'DEFAULT_ASSISTANT_OBJECT_FLOW_PROMPT',
    'DEFAULT_ASSISTANT_OBJECT_FLOW_SEMANTIC_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_INTERPRETATION_PROMPT',
    'DEFAULT_ASSISTANT_DIAGRAM_MAPPING_PROMPT',
    factorySource
  );
  return factory('empty result', 'permission denied', 3600, 'object flow prompt', 'semantic plan prompt', 'diagram interpretation prompt', 'diagram mapping prompt')();
}

test('generated Dynamic Pages client script parses as browser JavaScript', () => {
  const clientScript = generatedDynamicPagesClientScript();

  assert.match(clientScript, /function clearDiagramMappingRow\(button\)/);
  assert.match(clientScript, /\[429, 502, 503, 504\]/);
  assert.match(clientScript, /var maxRetries = method === 'GET'/);
  assert.doesNotThrow(() => {
    new vm.Script(clientScript, { filename: 'dynamic-pages-client.js' });
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

test('CMDBuild custom page launcher redirects without relying only on afterrender', () => {
  assert.match(launcherSource, /CMDBuildUI\.view\.custompages\.CmdbDynamicPages\.CmdbDynamicPages/);
  assert.match(launcherSource, /function cmdbDynamicPagesScheduleOpenExternalUi/);
  assert.match(launcherSource, /cmdbDynamicPagesScheduleOpenExternalUi\('initComponent'\)/);
  assert.match(launcherSource, /cmdbDynamicPagesScheduleOpenExternalUi\('afterrender'\)/);
  assert.match(launcherSource, /window\.addEventListener\('hashchange'/);
  assert.match(launcherSource, /launcher-redirect/);
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

test('assistant prompt and task mode persist in template spec metadata', () => {
  const hydrateStart = proxySource.indexOf('function hydrateDesignerStateFromTemplate(options)');
  const noticeStart = proxySource.indexOf('function renderNotice(message)');
  const applyDraftStart = proxySource.indexOf('function applyAssistantDraftToSpec(spec, intent, taskMode)');
  const readBlocksStart = proxySource.indexOf('function readSpecWithEditorBlocks()');
  const captureStart = proxySource.indexOf('function captureVisibleDesignerState()');
  const defaultSpecStart = proxySource.indexOf('function defaultSpec()');
  const generateStart = proxySource.indexOf('function generateAssistantDraft()');
  const applyStart = proxySource.indexOf('function applyAssistantDraft()');
  const runDraftStart = proxySource.indexOf('function runDraftAction(action)');
  assert.ok(hydrateStart > -1);
  assert.ok(noticeStart > hydrateStart);
  assert.ok(applyDraftStart > noticeStart);
  assert.ok(readBlocksStart > applyDraftStart);
  assert.ok(captureStart > -1);
  assert.ok(defaultSpecStart > captureStart);
  assert.ok(generateStart > readBlocksStart);
  assert.ok(applyStart > generateStart);
  assert.ok(runDraftStart > applyStart);

  const hydrateSource = proxySource.slice(hydrateStart, noticeStart);
  const applyDraftSource = proxySource.slice(applyDraftStart, readBlocksStart);
  const readBlocksSource = proxySource.slice(readBlocksStart, proxySource.indexOf('function clearDraftExecutionState'));
  const captureSource = proxySource.slice(captureStart, defaultSpecStart);
  const generateSource = proxySource.slice(generateStart, applyStart);
  const applySource = proxySource.slice(applyStart, runDraftStart);

  assert.match(hydrateSource, /spec\.assistantDraft/);
  assert.match(hydrateSource, /state\.assistantDraftIntent = String\(assistantDraft\.intent/);
  assert.match(hydrateSource, /state\.assistantTaskMode = normalizeOutputMode\(assistantDraft\.taskMode/);
  assert.match(applyDraftSource, /next\.assistantDraft = \{/);
  assert.match(applyDraftSource, /intent: prompt/);
  assert.match(applyDraftSource, /taskMode: mode/);
  assert.match(applyDraftSource, /delete next\.assistantDraft/);
  assert.match(readBlocksSource, /specData\.spec = applyAssistantDraftFromDomToSpec\(specData\.spec\)/);
  assert.match(captureSource, /updateSelectedFromEditor\(applyAssistantDraftFromDomToSpec\(state\.selectedTemplate\.spec \|\| defaultSpec\(\)\)\)/);
  assert.match(generateSource, /applyAssistantDraftToSpec\(result\.json\.spec, state\.assistantDraftIntent, state\.assistantTaskMode\)/);
  assert.match(applySource, /applyAssistantDraftToSpec\(result\.json\.spec, state\.assistantDraftIntent, state\.assistantTaskMode\)/);
});

test('Assistant prompt-only autosave uses an isolated template endpoint and ignores prompt metadata in flow staleness checks', () => {
  const autosaveStart = proxySource.indexOf('function autosaveAssistantPrompts()');
  const scheduleStart = proxySource.indexOf('function scheduleAssistantPromptAutosave()');
  const flowSnapshotStart = proxySource.indexOf('function assistantTemplateRevisionSnapshot(template, spec, requestGeneration)');
  const applyDraftStart = proxySource.indexOf('function applyAssistantDraftToSpec(spec, intent, taskMode)');
  const serverDraftStart = proxySource.indexOf("if (templateAction === 'assistant-draft')");
  const serverVersionsStart = proxySource.indexOf("if (templateAction === 'versions')");
  assert.ok(autosaveStart > -1);
  assert.ok(scheduleStart > autosaveStart);
  assert.ok(flowSnapshotStart > -1);
  assert.ok(applyDraftStart > flowSnapshotStart);
  assert.ok(serverDraftStart > -1);
  assert.ok(serverVersionsStart > serverDraftStart);

  const autosaveSource = proxySource.slice(autosaveStart, scheduleStart);
  const flowSnapshotSource = proxySource.slice(flowSnapshotStart, applyDraftStart);
  const serverDraftSource = proxySource.slice(serverDraftStart, serverVersionsStart);
  assert.match(autosaveSource, /\/templates\/.*\/assistant-draft/);
  assert.match(autosaveSource, /baseSpecHash/);
  assert.match(autosaveSource, /assistantDraft: draft/);
  assert.match(flowSnapshotSource, /assistantSpecWithoutPromptDraft/);
  assert.match(serverDraftSource, /methodAllowed\(req, res, 'PUT'\)/);
  assert.match(serverDraftSource, /normalizeAssistantPromptDraft/);
  assert.match(serverDraftSource, /templatePayloadWithAssistantPromptDraft/);
  assert.doesNotMatch(serverDraftSource, /writeTemplateVersion/);
  assert.doesNotMatch(serverDraftSource, /invalidateTemplateRuntimeCache/);
  assert.doesNotMatch(serverDraftSource, /invalidateTemplateStaticSnapshots/);
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
  assert.match(renderSource, /assistantFlowVisualOrderWarning/);
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

test('same-revision Designer reload preserves transient Assistant state', () => {
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
  assert.match(saveSource, /loadDesigner\(\{ preserveAssistantState: true \}\)/);
});

test('assistant status is compact and flow capture uses proposal state without deterministic DOM fields', () => {
  const statusStart = proxySource.indexOf('function renderAssistantStatus(config)');
  const taskModeStart = proxySource.indexOf('function renderAssistantTaskMode(value)', statusStart);
  const captureStart = proxySource.indexOf('function captureAssistantObjectFlow()');
  const specWithPromptsStart = proxySource.indexOf('function assistantSpecWithPrompts(spec)', captureStart);
  const generateStart = proxySource.indexOf('function generateAssistantObjectFlow()', specWithPromptsStart);
  assert.ok(statusStart > -1);
  assert.ok(taskModeStart > statusStart);
  assert.ok(captureStart > -1);
  assert.ok(specWithPromptsStart > captureStart);
  const statusSource = proxySource.slice(statusStart, taskModeStart);
  const captureSource = proxySource.slice(captureStart, specWithPromptsStart);
  const specWithPromptsSource = proxySource.slice(specWithPromptsStart, generateStart);

  assert.match(proxySource, /menuAssistant: 'Ассистент'/);
  assert.match(proxySource, /assistantStatusTitle: 'Статус ассистента'/);
  assert.match(statusSource, /assistantStatusEnabled/);
  assert.match(statusSource, /assistantStatusApiKey/);
  assert.match(statusSource, /assistantMcpTools/);
  assert.doesNotMatch(statusSource, /assistantStatusProvider/);
  assert.doesNotMatch(statusSource, /assistantStatusBaseUrl/);
  assert.doesNotMatch(statusSource, /assistantStatusModel/);
  assert.doesNotMatch(statusSource, /assistantStatusMcp/);
  assert.match(captureSource, /state\.assistantFlowProposal/);
  assert.doesNotMatch(captureSource, /captureObjectGroupDraftFromDom/);
  assert.doesNotMatch(captureSource, /readRelationExpansionFields/);
  assert.match(specWithPromptsSource, /assistantPromptDraft\(\)/);
  assert.match(specWithPromptsSource, /delete next\.assistantDraft\.flowPrompts/);
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

  assert.match(sectionNeedsSource, /'template'/);
  assert.match(sectionNeedsSource, /'assistant'/);
  assert.match(sectionNeedsSource, /'cache'/);
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

test('designer action bar exposes template save in Assistant and Templates', () => {
  const actionBarStart = proxySource.indexOf('function renderDesignerActionBar(selected)');
  const actionBarEnd = proxySource.indexOf('function renderDesigner()', actionBarStart);
  assert.ok(actionBarStart > -1);
  assert.ok(actionBarEnd > actionBarStart);

  const actionBarSource = proxySource.slice(actionBarStart, actionBarEnd);
  const templatesStart = actionBarSource.indexOf("if (section === 'templates')");
  const assistantStart = actionBarSource.indexOf("else if (section === 'assistant')");
  const templateEditorStart = actionBarSource.indexOf("else if (section === 'template')");
  assert.ok(templatesStart > -1);
  assert.ok(assistantStart > templatesStart);
  assert.ok(templateEditorStart > assistantStart);

  const templatesSource = actionBarSource.slice(templatesStart, assistantStart);
  const assistantSource = actionBarSource.slice(assistantStart, templateEditorStart);
  assert.match(actionBarSource, /var templateSelected = Boolean\(state\.selectedTemplate\)/);
  assert.match(actionBarSource, /templateSelectionRequired/);
  assert.match(templatesSource, /renderActionButton\('save-template', t\('save'\)/);
  assert.match(assistantSource, /renderActionButton\('save-template', t\('save'\), \{ primary: true/);
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
  assert.match(proxySource, /diagramAddMapping: 'Добавить mapping'/);
  assert.match(proxySource, /diagramMappingSourceRequired/);
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
  assert.match(helperSource, /matchingColumnOptionRowsForOutput\(spec \|\| defaultSpec\(\), sourceAlias\)/);
  assert.match(helperSource, /renderMatchingColumnOptions\(diagramColumnOptionRowsForSource\(spec, sourceAlias\)/);

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
  assert.match(proxySource, /binding\.unresolved = diagramMappingSourceValue\(mapping\) \? \[\] : \['from'\]/);
});

test('assistant owns D2 import while diagram owns deterministic mappings', () => {
  const renderStart = proxySource.indexOf('function renderDiagramImportWorkbench(spec)');
  const renderEnd = proxySource.indexOf('function renderDiagramEditor(spec, outputMode, options)', renderStart);
  const analyzeStart = proxySource.indexOf('function analyzeDiagramImport()');
  const legacyAssistantStart = proxySource.indexOf('function completeDiagramImportWithAssistant()', analyzeStart);
  const assistantStart = proxySource.indexOf('function assistantDiagramRequest(kind)', analyzeStart);
  const applyStart = proxySource.indexOf('function applyDiagramImport()', legacyAssistantStart);
  const refreshStart = proxySource.indexOf('function refreshDiagramMappingEditorAfterSourceChange()', applyStart);
  const captureImportStart = proxySource.indexOf('function captureDiagramImportProposalFromDom(manualBindingId)');
  const importOverridesStart = proxySource.indexOf('function diagramImportBindingOverrides(proposal)', captureImportStart);
  assert.ok(renderStart > -1);
  assert.ok(renderEnd > renderStart);
  assert.ok(analyzeStart > -1);
  assert.ok(assistantStart > -1);
  assert.ok(applyStart > analyzeStart);
  assert.ok(refreshStart > applyStart);
  assert.ok(captureImportStart > -1);
  assert.ok(importOverridesStart > captureImportStart);

  const renderSource = proxySource.slice(renderStart, renderEnd);
  const analyzeSource = proxySource.slice(analyzeStart, legacyAssistantStart);
  const assistantSource = proxySource.slice(assistantStart, proxySource.indexOf('function assistantFlowStageSummaries', assistantStart));
  const applySource = proxySource.slice(applyStart, refreshStart);
  const captureImportSource = proxySource.slice(captureImportStart, importOverridesStart);
  assert.match(renderSource, /cmdp-diagram-import-source/);
  assert.match(renderSource, /cmdp-diagram-import-file/);
  assert.match(renderSource, /diagram-import-analyze/);
  assert.match(renderSource, /assistant-diagram-interpret/);
  assert.match(renderSource, /assistant-diagram-map/);
  assert.match(renderSource, /assistantDiagramAnalysisRequired/);
  assert.doesNotMatch(renderSource, /renderDiagramImportV3Semantics\(/);
  assert.doesNotMatch(renderSource, /renderDiagramImportRoleMapping\(/);
  assert.doesNotMatch(renderSource, /data-action="diagram-import-apply"/);
  assert.match(analyzeSource, /\/draft\/diagram-import\/analyze/);
  assert.match(assistantSource, /\/assistant\/diagram-import\//);
  assert.match(assistantSource, /map-selections/);
  assert.match(applySource, /\/draft\/diagram-import\/apply/);
  assert.match(applySource, /state\.lastDraftPreviewOk = false/);
  assert.match(applySource, /state\.diagramImportAppliedPendingPreview = true/);
  assert.doesNotMatch(analyzeSource, /saveTemplate\(/);
  assert.doesNotMatch(assistantSource, /saveTemplate\(/);
  assert.doesNotMatch(applySource, /saveTemplate\(/);
  assert.doesNotMatch(analyzeSource + assistantSource + applySource, /publishSnapshot\(/);
  const diagramStart = proxySource.indexOf('function renderDiagramEditor(spec, outputMode, options)');
  const diagramEnd = proxySource.indexOf('function objectSelectionPrefixForAlias', diagramStart);
  const diagramSource = proxySource.slice(diagramStart, diagramEnd);
  assert.doesNotMatch(diagramSource, /renderDiagramImportWorkbench/);
  assert.match(diagramSource, /renderDiagramImportDeterministicMappings/);
  const deterministicStart = proxySource.indexOf('function renderDiagramImportDeterministicMappings(spec)');
  const deterministicEnd = proxySource.indexOf('function renderImportedD2Status(diagram)', deterministicStart);
  const deterministicSource = proxySource.slice(deterministicStart, deterministicEnd);
  assert.match(deterministicSource, /renderDiagramImportV3Semantics\(proposal\)/);
  assert.match(deterministicSource, /renderDiagramImportRoleMapping\(role, spec\)/);
  assert.match(deterministicSource, /diagram-import-apply/);
  assert.match(captureImportSource, /roleMappingVisible/);
  assert.match(captureImportSource, /if \(relationRuleRows\.length\) proposal\.relationRules/);
  assert.match(captureImportSource, /if \(placementRuleRows\.length\) proposal\.placementRules/);
  assert.match(proxySource, /data-diagram-mapping-id/);
  assert.match(proxySource, /data-import-role-key/);
  assert.match(proxySource, /state\.diagramImportStale/);
  assert.match(proxySource, /diagramImportProposalHasReviewBlocker/);
  assert.match(proxySource, /'diagram',[\s\S]*?'visualization'/);
  assert.match(proxySource, /diagramImportAppliedPendingPreview && !state\.lastDraftPreviewOk/);
  assert.match(proxySource, /Boolean\(state\.diagramImportProposal\).*diagramImportAppliedPendingPreview/);
  assert.match(proxySource, /function saveTemplate\(\)[\s\S]*?if \(state\.diagramImportProposal\)/);
  assert.match(proxySource, /diagramImportSignedProposal/);
  assert.match(proxySource, /markImportedDiagramChanged/);
  assert.match(proxySource, /assistantResponseStale/);
  assert.match(proxySource, /state\.selectedTemplate !== requestTemplate/);
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
  assert.match(proxySource, /data-diagram-import-semantic/);
  assert.match(proxySource, /data-diagram-import-role-row/);
  assert.match(proxySource, /data-diagram-import-role-mapping/);
  assert.match(proxySource, /data-diagram-import-exemplar/);
  assert.match(proxySource, /data-diagram-import-role-field="primary\.className"/);
  assert.match(proxySource, /diagram-import-add-related/);
  assert.match(proxySource, /diagram-import-add-rule/);
  assert.match(proxySource, /diagram-import-add-placement/);
  assert.match(proxySource, /state\.diagramImportProposal && state\.diagramImportProposal\.version === 3/);
  assert.match(proxySource, /function catalogRelationPathOptions\(className\)/);
  assert.match(proxySource, /Number\(state\.maxTraversalDepth\)/);
  assert.match(proxySource, /data-relation-path/);
  assert.match(proxySource, /function renderRelationPathPlanner\(model, spec\)/);
  assert.match(proxySource, /function appendRelationPath\(\)/);
  assert.match(proxySource, /data-action="append-relation-path"/);
  assert.match(proxySource, /catalogDomainRelationPathOptions/);
  assert.match(proxySource, /renderDiagramImportAttributeMultiSelect/);
  assert.match(proxySource, /diagramImportSelectedValues/);
  assert.match(proxySource, /renderDiagramImportLabelSuggestions/);
  assert.match(proxySource, /configuredModelCatalogRequestUrl/);
  assert.doesNotMatch(proxySource, /model\/catalog\?maxClasses=500&maxDomains=500/);
  assert.match(proxySource, /diagramImportSemanticComposite/);
  const v3SemanticsStart = proxySource.indexOf('function renderDiagramImportV3Semantics(proposal)');
  const v3SemanticsEnd = proxySource.indexOf('function renderDiagramImportRelatedRow', v3SemanticsStart);
  const v3SemanticsSource = proxySource.slice(v3SemanticsStart, v3SemanticsEnd);
  assert.match(v3SemanticsSource, /renderDiagramImportSemanticsHelp/);
  assert.match(v3SemanticsSource, /diagramImportTypeOrContainer/);
  assert.match(v3SemanticsSource, /diagramImportBasis/);
  assert.doesNotMatch(v3SemanticsSource, /<th><\/th>/);
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

test('D2 skill records structured vars.data.cmdp metadata rule', () => {
  const skillSource = fs.readFileSync('.agents/skills/cmdbuild-d2-diagrams/SKILL.md', 'utf8');
  const languageReference = fs.readFileSync('.agents/skills/cmdbuild-d2-diagrams/references/d2-language-notes.md', 'utf8');

  assert.match(skillSource, /references\/d2-language-notes\.md/);
  assert.match(skillSource, /vars\.data\.cmdp/);
  assert.match(languageReference, /vars\.data\.cmdp/);
  assert.match(languageReference, /Do not serialize metadata as comments or base64 comment blocks/);
  assert.match(languageReference, /https:\/\/d2lang\.com\/tour\/vars\//);
  assert.match(skillSource, /composite/);
  assert.match(skillSource, /D2 `class`/);
  assert.match(skillSource, /one reusable visual\/template role/);
  assert.match(skillSource, /one reviewed object-flow stage/);
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
  assert.match(proxySource, /parsed\.version === 3/);
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

test('final view attribute lazy-load retries after transient class attribute errors', () => {
  const ensureStart = proxySource.indexOf('function ensureCatalogAttributesForClass(className)');
  const viewClassesStart = proxySource.indexOf('function viewComposerCatalogClassNames(spec)');
  const ensureSectionStart = proxySource.indexOf('function ensureCatalogAttributesForDesignerSection()');
  const extractLanguageStart = proxySource.indexOf('function extractLanguageFromValue(value)');
  assert.ok(ensureStart > -1);
  assert.ok(viewClassesStart > ensureStart);
  assert.ok(ensureSectionStart > viewClassesStart);
  assert.ok(extractLanguageStart > ensureSectionStart);
  const ensureSource = proxySource.slice(ensureStart, viewClassesStart);
  const ensureSectionSource = proxySource.slice(ensureSectionStart, extractLanguageStart);

  assert.match(ensureSource, /request\(apiPrefix \+ '\/model\/classes\/' \+ encodeURIComponent\(name\) \+ '\/attributes'\)/);
  assert.match(ensureSource, /state\.catalogAttributeFailedAt\[key\]/);
  assert.match(ensureSource, /return mergeCatalogClassAttributes\(name, result\.json\.data\)/);
  assert.match(ensureSource, /catch\(function \(error\)/);
  assert.match(ensureSource, /return 'failed'/);
  assert.match(ensureSectionSource, /item === 'failed'/);
  assert.doesNotMatch(ensureSource, /catch\(function \(error\) \{\s*state\.catalogAttributeLoaded\[key\] = true/);
});

test('object group editor preserves assistant source-row selection fields', () => {
  const normalizeRuleStart = proxySource.indexOf('function normalizeObjectSelectionRule(rule)');
  const normalizeStart = proxySource.indexOf('function normalizeObjectSelection(selection, index)');
  const inferStart = proxySource.indexOf('function inferObjectGroupModel(spec)');
  const renderStart = proxySource.indexOf('function renderObjectGroupSelection(selection, index)');
  const buildStart = proxySource.indexOf('function buildObjectGroupSpec(model, previousSpec)');
  const captureStart = proxySource.indexOf('function captureObjectGroupDraftFromDom()');
  const matchingStart = proxySource.indexOf('function readRelationExpansionFields()');
  assert.ok(normalizeRuleStart > -1);
  assert.ok(normalizeStart > -1);
  assert.ok(normalizeStart > normalizeRuleStart);
  assert.ok(inferStart > normalizeStart);
  assert.ok(renderStart > inferStart);
  assert.ok(buildStart > renderStart);
  assert.ok(captureStart > buildStart);
  assert.ok(matchingStart > captureStart);

  const normalizeSource = proxySource.slice(normalizeRuleStart, inferStart);
  const inferSource = proxySource.slice(inferStart, renderStart);
  const renderSource = proxySource.slice(renderStart, buildStart);
  const buildSource = proxySource.slice(buildStart, captureStart);
  const captureSource = proxySource.slice(captureStart, matchingStart);

  assert.match(normalizeSource, /from: String\(selection\.from/);
  assert.match(normalizeSource, /columns: normalizeObjectSelectionColumns/);
  assert.match(normalizeSource, /valueColumn: String\(rule\.valueColumn/);
  assert.match(normalizeSource, /function objectGroupFinalAliasFromSelections\(selections\)/);
  assert.match(normalizeSource, /function ensureObjectGroupValueColumnSources\(selections\)/);
  assert.match(normalizeSource, /stripObjectGroupSourceColumnPrefix\(sourceAlias/);
  assert.match(normalizeSource, /addObjectGroupSelectionColumn\(source\[sourceIndex\], column\)/);
  assert.match(inferSource, /var visual = getStoredVisualModel\(spec, 'objectGroup'\)/);
  assert.doesNotMatch(inferSource, /spec\.visualModel && spec\.visualModel\.mode === 'objectGroup'/);
  assert.match(inferSource, /var cardSteps = steps\.filter\(isDataSelectionStep\)/);
  assert.match(inferSource, /from: selection\.from \|\| ''/);
  assert.match(inferSource, /valueColumn: filter\.valueColumn \|\| filter\.sourceColumn \|\| filter\.fromColumn/);
  assert.match(renderSource, /data-object-selection-field="alias"/);
  assert.match(renderSource, /data-object-selection-field="from"/);
  assert.match(renderSource, /data-object-selection-field="columns"/);
  assert.match(renderSource, /data-object-scope-field="valueColumn"/);
  assert.match(buildSource, /if \(selection\.from\) step\.from = selection\.from/);
  assert.match(buildSource, /filter\.valueColumn = rule\.valueColumn/);
  assert.match(buildSource, /step\.columns = selection\.columns\.slice\(\)/);
  assert.match(buildSource, /ensureObjectGroupValueColumnSources\(selections\)/);
  assert.match(buildSource, /var finalAlias = objectGroupFinalAliasFromSelections\(selections\)/);
  assert.match(buildSource, /name: finalAlias/);
  assert.match(buildSource, /alias: finalAlias \|\| first\.alias \|\| 'objects'/);
  assert.match(buildSource, /columns: finalSelection\.columns && finalSelection\.columns\.length/);
  assert.match(buildSource, /var preservedTables = previousTables\.filter/);
  assert.match(captureSource, /data-object-selection-field="from"/);
  assert.match(captureSource, /data-object-scope-field="valueColumn"/);
});

test('object group path hint filters are conditional and UI-only', () => {
  const optionsStart = proxySource.indexOf('function objectGroupPathHintOptions(className)');
  const renderStart = proxySource.indexOf('function renderObjectGroupPathHintFilters(className)');
  const regexExamplesStart = proxySource.indexOf('function objectGroupRegexExamples()');
  const selectionStart = proxySource.indexOf('function renderObjectGroupSelection(selection, index)');
  const editorStart = proxySource.indexOf('function renderObjectGroupEditor(selected)');
  const readStart = proxySource.indexOf('function readObjectGroupFields()');
  const buildStart = proxySource.indexOf('function buildObjectGroupSpec(model, previousSpec)');
  const applyStart = proxySource.indexOf('function applyObjectPathFilter(container)');
  const visualizationStart = proxySource.indexOf('function visualizationColumnOptionsHtmlForRowGroup(container)');
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
  const warningStart = proxySource.indexOf('function extractionSelectedSourceEmptyWarning(result, selectedName)');
  const renderOptionsStart = proxySource.indexOf('function renderExtractionResultOptions(selectedName, spec, tables)');
  const extractStart = proxySource.indexOf('function extractByTemplate()');
  const applyStart = proxySource.indexOf('function applyDataSelectionEditor()');
  assert.ok(aliasStart > -1);
  assert.ok(finalAliasesStart > aliasStart);
  assert.ok(finalBaseStart > finalAliasesStart);
  assert.ok(warningStart > finalBaseStart);
  assert.ok(renderOptionsStart > warningStart);
  assert.ok(extractStart > renderOptionsStart);
  assert.ok(applyStart > extractStart);

  const aliasSource = proxySource.slice(aliasStart, finalAliasesStart);
  const finalAliasesSource = proxySource.slice(finalAliasesStart, finalBaseStart);
  const finalBaseSource = proxySource.slice(finalBaseStart, warningStart);
  const warningSource = proxySource.slice(warningStart, renderOptionsStart);
  const extractSource = proxySource.slice(extractStart, applyStart);

  assert.match(aliasSource, /objectSelectionsFromModel\(visual\)/);
  assert.match(aliasSource, /objectGroupFinalAliasFromSelections\(selections\)/);
  assert.match(finalAliasesSource, /add\(getObjectGroupOutputAlias\(spec\)\)/);
  assert.match(finalBaseSource, /var objectGroupAlias = getObjectGroupOutputAlias\(spec\)/);
  assert.match(finalBaseSource, /if \(objectGroupAlias\) return objectGroupAlias/);
  assert.match(warningSource, /selectedTable\.rows/);
  assert.match(warningSource, /populatedTable\.rows\.length/);
  assert.match(warningSource, /extractionSelectedSourceEmpty/);
  assert.match(extractSource, /var sourceWarning = extractionSelectedSourceEmptyWarning\(result, state\.extractionSource\)/);
  assert.match(extractSource, /type: result\.ok \? \(sourceWarning \? 'warning' : 'ok'\) : 'error'/);
  assert.match(extractSource, /sourceWarning \|\| t\('extractionCompleted'\)/);
});

test('Assistant extraction uses the persisted user-label manifest and never falls back to aliases', () => {
  const manifestStart = proxySource.indexOf('function assistantObjectFlowOutputManifest(spec)');
  const outputManifestStart = proxySource.indexOf('function objectFlowOutputManifest(spec)', manifestStart);
  const finalAliasesStart = proxySource.indexOf('function finalExtractionAliases(spec)', outputManifestStart);
  const extractionOptionsStart = proxySource.indexOf('function extractionResultOptions(spec, tables)', finalAliasesStart);
  const renderStart = proxySource.indexOf('function renderExtractionEditor(selected)', extractionOptionsStart);
  const extractionStart = proxySource.indexOf('function extractByTemplate()', renderStart);
  const selectionStart = proxySource.indexOf('function applyDataSelectionEditor()', extractionStart);
  assert.ok(manifestStart > -1);
  assert.ok(outputManifestStart > manifestStart);
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
  assert.match(manifestSource, /var hasCompiledFlow = Boolean\(objectMatching/);
  assert.match(manifestSource, /error: invalid \? 'invalid manifest'/);
  assert.match(finalAliasesSource, /if \(assistantManifest\.error\) return \[\]/);
  assert.match(optionsSource, /if \(assistantManifest\.error\) return result/);
  assert.match(renderSource, /assistantFlowOutputManifestInvalid/);
  assert.match(extractionSource, /assistantManifest\.assistantManaged && assistantManifest\.error/);
});

test('Relations Apply preserves explicit operation order and source-driven columns', () => {
  const operationsStart = proxySource.indexOf('function flowOperations(model)');
  const columnsStart = proxySource.indexOf('function flowColumnOptionRows(model, spec, alias, operationIndex, seenAliases)', operationsStart);
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

test('operation aliases immediately become available to later operations and published output', () => {
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
  assert.match(refreshSource, /data-result-set-field="publishedAlias"/);
  assert.match(refreshSource, /renderMaterializedAliasOptions\(state\.relationDraft, selectedAlias\)/);
  assert.match(refreshSource, /renderPriorMaterializedAliasOptions\(state\.relationDraft, index, selected\)/);
  assert.match(refreshSource, /\['from', 'with'\]/);
  assert.match(inputSource, /\[data-set-operation-field="as"\], \[data-matching-block-field="as"\]/);
  assert.match(inputSource, /refreshRelationOperationAliases\(\)/);
});
