import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcherSource = fs.readFileSync('src/CmdbDynamicPages.js', 'utf8');
const proxySource = fs.readFileSync('scripts/dev-proxy-server.mjs', 'utf8');

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

test('assistant draft generation renders an in-progress state before the request completes', () => {
  const renderStart = proxySource.indexOf('function renderAssistantDraftResult()');
  const editorStart = proxySource.indexOf('function renderAssistantEditor(');
  const generateStart = proxySource.indexOf('function generateAssistantDraft()');
  const applyStart = proxySource.indexOf('function applyAssistantDraft()');
  assert.ok(renderStart > -1);
  assert.ok(editorStart > renderStart);
  assert.ok(generateStart > editorStart);
  assert.ok(applyStart > generateStart);
  const renderSource = proxySource.slice(renderStart, editorStart);
  const editorSource = proxySource.slice(editorStart, generateStart);
  const generateSource = proxySource.slice(generateStart, applyStart);

  assert.match(proxySource, /assistantGeneratingTitle/);
  assert.match(proxySource, /assistantGeneratingElapsed/);
  assert.match(proxySource, /data-assistant-elapsed/);
  assert.match(renderSource, /aria-busy/);
  assert.match(renderSource, /renderAssistantBusyNotice\(\)/);
  assert.match(editorSource, /assistantGenerateBusy/);
  assert.match(editorSource, /disabled aria-disabled="true" aria-busy="true"/);
  assert.match(editorSource, /disabled aria-disabled="true"/);
  assert.match(generateSource, /if \(state\.assistantGenerating\) return/);
  assert.match(generateSource, /state\.assistantGeneratingStartedAt = Date\.now\(\)/);
  assert.match(generateSource, /renderDesigner\(\);\n\s*startAssistantGenerationTimer\(\)/);
  assert.match(generateSource, /stopAssistantGenerationTimer\(\)/);
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
  const loadDesignerStart = proxySource.indexOf('function loadDesigner()');
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
  assert.match(helperSource, /data-diagram-mapping-detail/);
  assert.match(helperSource, /data-diagram-mapping-field="labelTemplate"/);
  assert.match(helperSource, /renderDiagramMultiFieldSelect\(spec, sourceAlias, 'labelFields'/);
  assert.match(helperSource, /renderDiagramMultiFieldSelect\(spec, sourceAlias, 'dataProfileFields'/);
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
  assert.match(readRowsSource, /function applyMappingDetails\(mapping, fallbackLabelField\)/);
  assert.match(readRowsSource, /mapping\.labelTemplate = labelTemplate/);
  assert.match(readRowsSource, /mapping\.labelFields = labelFields/);
  assert.match(readRowsSource, /mapping\.dataProfile = dataProfile/);
  assert.match(readRowsSource, /if \(!from && type === 'generic'\) return/);
  assert.match(readRowsSource, /throw new Error\(t\('diagramMappingSourceRequired'\)\)/);
  assert.match(readRowsSource, /mappings\.push\(applyMappingDetails\(\{ from: from, fields: nodeFields \}/);
  assert.match(readRowsSource, /mappings\.push\(applyMappingDetails\(\{ type: type \|\| 'generic', from: from, fields: edgeFields \}/);
  assert.match(captureSource, /document\.querySelector\('\[data-diagram-mapping-row\]'\)/);
  assert.match(captureSource, /applyVisualizationToSpec\(state\.selectedTemplate\.spec \|\| defaultSpec\(\), false\)/);
  assert.match(rowUiSource, /function addDiagramMappingRow\(button\)/);
  assert.match(rowUiSource, /function clearDiagramMappingRow\(button\)/);
  assert.match(rowUiSource, /function ensureTrailingDiagramMappingRow\(target\)/);
  assert.match(rowUiSource, /data-diagram-mapping-detail/);
  assert.match(rowUiSource, /function refreshDiagramMappingEditorAfterSourceChange\(\)/);
  assert.match(proxySource, /if \(action === 'add-diagram-mapping-row'\) addDiagramMappingRow\(target\)/);
  assert.match(proxySource, /if \(action === 'clear-diagram-mapping-row'\) clearDiagramMappingRow\(target\)/);
  assert.match(proxySource, /\[data-diagram-mapping-field="from"\]/);
});

test('D2 skill records structured vars.data.cmdp metadata rule', () => {
  const skillSource = fs.readFileSync('.agents/skills/cmdbuild-d2-diagrams/SKILL.md', 'utf8');
  const languageReference = fs.readFileSync('.agents/skills/cmdbuild-d2-diagrams/references/d2-language-notes.md', 'utf8');

  assert.match(skillSource, /references\/d2-language-notes\.md/);
  assert.match(skillSource, /vars\.data\.cmdp/);
  assert.match(languageReference, /vars\.data\.cmdp/);
  assert.match(languageReference, /Do not serialize metadata as comments or base64 comment blocks/);
  assert.match(languageReference, /https:\/\/d2lang\.com\/tour\/vars\//);
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
  assert.match(downloadSource, /params\.d2 = 'true'/);
  assert.match(downloadSource, /params\.diagram = selector/);
  assert.match(downloadSource, /publicSnapshotRunPath\(templateCode, params\)/);
  assert.match(downloadSource, /runtimeRunPath\(templateCode, params\)/);
  assert.match(renderSource, /diagramHasD2Download\(diagram\)/);
  assert.match(renderSource, /data-d2-source-download/);
  assert.match(renderSource, /data-d2-rendered-svg/);
  assert.match(renderSource, /data-d2-render-unavailable/);
  assert.match(runtimeSource, /runtimeD2DownloadPath\(result, diagram, diagramIndex\)/);
  assert.match(runtimeSource, /renderResultDiagram\(diagram, toolbar, d2DownloadHref\)/);
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
