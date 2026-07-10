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
  assert.match(generateSource, /updateSelectedFromEditor\(result\.json\.spec\)/);
  assert.match(generateSource, /clearDraftExecutionState\(\)/);
  assert.match(generateSource, /assistantDraftGeneratedApplied/);
  assert.match(generateSource, /state\.objectGroupDraft = null/);
  assert.match(generateSource, /state\.relationDraft = null/);
  assert.match(generateSource, /state\.viewComposerDraft = null/);
  assert.doesNotMatch(generateSource, /\/draft\/preview/);
  assert.doesNotMatch(generateSource, /saveTemplate\(/);
  assert.doesNotMatch(generateSource, /runtimeRunPath/);
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
