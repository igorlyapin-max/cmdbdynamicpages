import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const nginxOrigin = process.env.CMDBDYNAMIC_NGINX_ORIGIN || 'http://localhost:8088';
const cookieJar = process.env.CMDBUILD_COOKIE_JAR || '/tmp/cmdbuild-ui-cookie.txt';
const runtimeTemplate = process.env.CMDBDYNAMIC_E2E_TEMPLATE || 'ProbeClassesByAttributeType';
const runtimeAttrType = process.env.CMDBDYNAMIC_E2E_ATTR_TYPE || 'reference';
const runtimeCacheLayoutTemplate = process.env.CMDBDYNAMIC_E2E_CACHE_TEMPLATE || 'testtemplate';
const runtimeDiagramTemplate = process.env.CMDBDYNAMIC_E2E_D2_TEMPLATE || 'testtemplate';
const loginUsername = process.env.CMDBUILD_USERNAME || '';
const loginPassword = process.env.CMDBUILD_PASSWORD || '';
const loginRole = process.env.CMDBUILD_ROLE || '';
const loginScope = process.env.CMDBUILD_SCOPE || 'ui';
const assistantIntent = process.env.CMDBDYNAMIC_E2E_ASSISTANT_INTENT || 'найти все карточки класса АРМ которые находятся в том же местоположении что и экземпляр класса "маршрутизатор" с описанием "Маршрутизатор для Test City 300"';
let cookieHeader = process.env.CMDBUILD_COOKIE_HEADER || readCookieJar(cookieJar);
const playwright = await loadPlaywright();
const proxyAvailable = await canReach(`${proxyOrigin}/health/live`);
let sessionValid = proxyAvailable && cookieHeader ? await hasValidSession(cookieHeader) : false;
let loginError = '';
if (playwright && proxyAvailable && !sessionValid && loginUsername && loginPassword) {
  try {
    cookieHeader = await loginCmdbuild();
    sessionValid = await hasValidSession(cookieHeader);
    if (!sessionValid) loginError = 'CMDBuild login succeeded, but backend session validation failed.';
  } catch (error) {
    loginError = error && error.message ? error.message : String(error);
  }
}
const skipReason = playwright
  ? proxyAvailable
    ? sessionValid
      ? false
      : loginError || 'CMDBuild session cookie is missing or invalid; set CMDBUILD_COOKIE_HEADER, refresh CMDBUILD_COOKIE_JAR, or set CMDBUILD_USERNAME/CMDBUILD_PASSWORD.'
    : `proxy is not reachable at ${proxyOrigin}`
  : 'Playwright is not installed; install it locally to run browser UI smoke tests.';
const requireLiveUi = process.env.CMDBDYNAMIC_E2E_REQUIRED === '1' || Boolean(loginUsername && loginPassword && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
const requireLiveDiagramUi = process.env.CMDBDYNAMIC_E2E_D2_REQUIRED === '1';
if (requireLiveUi && skipReason) {
  throw new Error(`Browser UI smoke is required but cannot run: ${skipReason}`);
}

async function addAssistantBusinessBlock(page, values = {}) {
  if (await page.locator('[data-assistant-flow-block]').count() === 0) {
    await page.locator('button[data-action="assistant-flow-block-add"]').click();
  }
  const block = page.locator('[data-assistant-flow-block]').last();
  const index = (await page.locator('[data-assistant-flow-block]').count()) - 1;
  await block.locator(`#assistant-flow-${index}-name`).fill(values.name || `Result ${index + 1}`);
  await block.locator(`#assistant-flow-${index}-entities`).fill(values.entities || 'CMDBuild objects');
  await block.locator(`#assistant-flow-${index}-algorithm`).fill(values.algorithm || 'Select the requested objects.');
  await block.locator(`#assistant-flow-${index}-expected-result`).fill(values.expectedResult || 'A deterministic result table.');
  return block;
}

test('Designer opens on the template list with fixed menu and action bar', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.waitForSelector('.designer-actionbar', { timeout: 10_000 });

    assert.equal(await page.locator('#cmdp-title').count(), 1);
    assert.equal(await page.locator('#cmdp-catalog-header').count(), 1);
    assert.equal(await page.locator('#cmdp-designer-menu').evaluate((node) => getComputedStyle(node).position), 'fixed');
    assert.ok(await page.locator('.designer-actionbar').isVisible());
    assert.ok(await page.locator('.designer-actionbar button[data-action="new-template"]').isVisible());
    assert.ok(await page.locator('a[data-designer-section="schema"]').isVisible());
  });
});

test('Designer blocks template-bound menu sections until a template is selected', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer/cache`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.waitForSelector('#cmdp-template-list', { timeout: 10_000 });

    const menuGroups = await page.locator('#cmdp-designer-menu .menu-group').evaluateAll((groups) => groups.map((group) =>
      Array.from(group.querySelectorAll('[data-designer-section]')).map((link) => link.getAttribute('data-designer-section'))
    ));
    const templateGroup = menuGroups.find((sections) => sections.includes('templates')) || [];
    const constructorGroup = menuGroups.find((sections) => sections.includes('params')) || [];
    const runGroup = menuGroups.find((sections) => sections.includes('run')) || [];
    assert.equal(templateGroup.includes('assistant'), false);
    assert.deepEqual(constructorGroup.slice(0, 3), ['params', 'assistant', 'object-group']);
    assert.equal(constructorGroup.includes('extraction'), false);
    assert.equal(constructorGroup.includes('final-view'), false);
    assert.equal(constructorGroup.indexOf('diagram-assistant') + 1, constructorGroup.indexOf('diagram'));
    assert.deepEqual(runGroup.slice(0, 3), ['extraction', 'final-view', 'visualization']);

    assert.equal(await page.locator('#cmdp-cache-editor').count(), 0);
    assert.match(new URL(page.url()).pathname, /\/cmdbuild\/dynamicpages\/ui\/designer\/?$/);
    assert.match(await page.locator('.notice').first().innerText(), /Select or create a template|Выберите или создайте шаблон/);
    await assertMenuLinkDisabled(page, 'cache');
    await assertMenuLinkDisabled(page, 'assistant');
    await assertMenuLinkDisabled(page, 'diagram-assistant');

    await page.locator('a[data-designer-section="cache"]').dispatchEvent('click');
    await page.waitForSelector('#cmdp-template-list', { timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-cache-editor').count(), 0);

    await page.locator('a[data-designer-section="schema"]').click();
    await page.waitForSelector('#cmdp-schema-manager', { timeout: 10_000 });
  });
});

test('main Diagram editor is the only diagram authoring entry point', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `DiagramSandboxUiSmoke${Date.now()}`;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Diagram editor UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      const editorLink = page.locator('a[data-designer-section="diagram"]');
      await editorLink.waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector('a[data-designer-section="diagram"]')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 10_000 });
      assert.equal((await editorLink.innerText()).trim(), 'Редактор диаграмм');
      await editorLink.click();
      try {
        await page.waitForSelector('#cmdp-diagram-section-editor', { timeout: 10_000 });
      } catch (error) {
        const body = await page.locator('body').innerText().catch(() => '');
        assert.fail(`${error.message}\nBrowser errors: ${pageErrors.join(' | ') || '(none)'}\nBody: ${body.slice(0, 2000)}`);
      }
      assert.equal(await page.locator('#cmdp-diagram-section-editor').count(), 1);
      assert.equal(await page.locator('a[data-designer-section="diagram-2"]').count(), 0);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        const deleteResponse = await deleteResponsePromise;
        assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
      }
    }
  });
});

test('testtemplate preview keeps mapped server scopes and server cards in their declared branches', {
  skip: skipReason || !requireLiveDiagramUi
    ? (skipReason || 'Set CMDBDYNAMIC_E2E_D2_REQUIRED=1 to run the live testtemplate D2 regression.')
    : false,
  timeout: 120_000
}, async () => {
  await withPage(async (page) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    const templateButton = page.locator(`[data-action="select-template"][data-code="${runtimeDiagramTemplate}"]`);
    await templateButton.waitFor({ state: 'visible', timeout: 20_000 });
    await templateButton.click();
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-section-editor', { timeout: 20_000 });

    const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await structurePanel.waitFor({ state: 'visible', timeout: 20_000 });
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const collapsed = structurePanel.locator('button[data-action="diagram-structure-toggle"][aria-expanded="false"]');
      if (await collapsed.count() === 0) break;
      await collapsed.first().click();
    }
    const serverScopeIds = await structurePanel
      .locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]')
      .evaluateAll((rows) => rows
        .filter((row) => /scope_server/i.test(String(row.textContent || '')))
        .map((row) => String(row.getAttribute('data-diagram-structure-tree-row') || ''))
        .filter(Boolean));
    assert.ok(serverScopeIds.length >= 3, 'The imported D2 tree must retain the root server scope and both declared DMZ server scopes.');

    const previewResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/cmdbuild/custom-api/draft/preview') && response.request().method() === 'POST'
    ));
    await page.locator('button[data-action="diagram-import-preview-current"]').first().click();
    const previewResponse = await previewResponsePromise;
    assert.equal(previewResponse.status(), 200, await previewResponse.text());
    const payload = await previewResponse.json();
    const diagrams = payload && payload.result && Array.isArray(payload.result.diagrams) ? payload.result.diagrams : [];
    assert.ok(diagrams.length > 0, 'Preview must return a D2 diagram.');
    const diagram = diagrams[0];
    const scopes = (diagram.groups || []).filter((group) => group && group.importRole && group.importRole.key === 'scope_server');
    const servers = (diagram.nodes || []).filter((node) => node && node.importRole && node.importRole.key === 'server');
    const executionSummary = {
      workflow: payload && payload.result && payload.result.d2Workflow || {},
      partialPreview: payload && payload.result && payload.result.diagramPreview || {},
      bindings: (diagram.execution && diagram.execution.bindings || []).filter((binding) => binding && binding.role && ['scope_server', 'server'].includes(binding.role.key)),
      unconfigured: diagram.execution && diagram.execution.unconfigured || [],
      unplaced: diagram.unplaced || [],
      trace: payload && payload.result && payload.result.trace || []
    };
    assert.ok(scopes.length >= 3, `Every configured server scope placement must materialize. ${JSON.stringify(executionSummary)}`);
    assert.ok(servers.length >= 2, `Each non-empty mapped server result must materialize as a server node. ${JSON.stringify(executionSummary)}`);
    assert.ok(servers.every((server) => String(server.label || '').trim()), 'Every server node must have a data label.');
    const scopeIds = new Set(scopes.map((scope) => String(scope.id || '')));
    assert.ok(servers.every((server) => scopeIds.has(String(server.group || ''))), 'Every server node must remain inside its materialized scope.');
    const populatedScopeIds = new Set(servers.map((server) => String(server.group || '')));
    assert.ok(scopes.filter((scope) => populatedScopeIds.has(String(scope.id || ''))).every((scope) => String(scope.label || '').trim()), 'Every non-empty server scope must have a data label.');
    assert.ok(scopes.filter((scope) => String(scope.blueprintKey || '').startsWith('target_system.dmz.')).length >= 2, 'Both DMZ server scopes must remain in their declared template branches.');
    assert.ok(scopes.some((scope) => String(scope.blueprintKey || '').startsWith('target_system.vlan_2_scope.')), 'The root VLAN server scope must remain in its declared template branch.');
    assert.ok(scopes.length > servers.length, 'Configured empty server scopes must remain visible as empty containers when showEmpty is enabled.');
    const approvedStructureItemIds = new Set((diagram.structureTree && Array.isArray(diagram.structureTree.items) ? diagram.structureTree.items : [])
      .map((item) => String(item && item.id || ''))
      .filter(Boolean));
    const runtimeItems = [...(diagram.groups || []), ...(diagram.nodes || [])];
    assert.ok(runtimeItems.every((item) => approvedStructureItemIds.has(String(item && item.importRole && item.importRole.structureItemId || ''))), 'Preview must not materialize objects outside the saved D2 structure tree.');
    const allGroupIds = new Set((diagram.groups || []).map((group) => String(group && group.id || '')).filter(Boolean));
    assert.ok((diagram.nodes || []).every((node) => node && allGroupIds.has(String(node.group || ''))), 'Every dynamic node must be placed in an approved container branch, never at the diagram root.');
    const rootGroups = (diagram.groups || []).filter((group) => !String(group && group.parent || ''));
    const treeMappingById = new Map((diagram.structureTree && Array.isArray(diagram.structureTree.items) ? diagram.structureTree.items : [])
      .map((item) => [String(item && item.id || ''), item && item.mapping || {}]));
    assert.ok(rootGroups.every((group) => String(group && group.importRole && group.importRole.semantic || '') === 'structural'), `Only declared structural D2 containers may remain at the diagram root. ${JSON.stringify(rootGroups.map((group) => ({ label: group.label, role: group.importRole && group.importRole.key, semantic: group.importRole && group.importRole.semantic, structureItemId: group.importRole && group.importRole.structureItemId, materialization: treeMappingById.get(String(group && group.importRole && group.importRole.structureItemId || '')) && treeMappingById.get(String(group && group.importRole && group.importRole.structureItemId || '')).materialization })))}`);
    assert.ok(runtimeItems.every((item) => !/mapping_|^structure:|missing-endpoint/i.test(String(item && item.label || ''))), 'Preview labels must not expose mapping identifiers or synthetic endpoints.');
    assert.ok((diagram.edges || []).every((edge) => (diagram.nodes || []).some((node) => String(node && node.id || '') === String(edge && edge.source || '')) && (diagram.nodes || []).some((node) => String(node && node.id || '') === String(edge && edge.target || ''))), 'Every rendered connection must retain two materialized endpoints.');

    const preview = page.locator('[data-diagram-import-runtime-preview]');
    await preview.waitFor({ state: 'visible', timeout: 20_000 });
    const svg = preview.locator('[data-d2-rendered-svg]').first();
    await svg.waitFor({ state: 'visible', timeout: 20_000 });
    const box = await svg.boundingBox();
    assert.ok(box && box.width > 40 && box.height > 40, 'Rendered D2 preview must be visibly non-empty.');
    const visibleSvgLabels = await svg.locator('text, foreignObject').allTextContents();
    assert.ok(visibleSvgLabels.every((label) => !/mapping_|^structure:|missing-endpoint/i.test(String(label || '').trim())), 'Rendered D2 SVG must not expose internal runtime identifiers as visible labels.');
    assert.equal(await preview.locator('[data-diagram-import-unconfigured-structure]').count(), 0, 'Preview must not substitute an unconfigured structural scope.');
    assert.deepEqual(pageErrors, []);
  });
});

test('testtemplate defers deep VLAN catalog requests until a Result 5 diagram-filter query', {
  skip: skipReason || !requireLiveDiagramUi
    ? (skipReason || 'Set CMDBDYNAMIC_E2E_D2_REQUIRED=1 to run the live testtemplate D2 regression.')
    : false,
  timeout: 90_000
}, async () => {
  await withPage(async (page) => {
    const pageErrors = [];
    const modelRequests = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    page.on('request', (request) => {
      if (/\/cmdbuild\/custom-api\/model\/(?:catalog|classes)(?:[/?]|$)/.test(request.url())) modelRequests.push(request.url());
    });
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    const templateButton = page.locator(`[data-action="select-template"][data-code="${runtimeDiagramTemplate}"]`);
    await templateButton.waitFor({ state: 'visible', timeout: 20_000 });
    await templateButton.click();
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-section-editor', { timeout: 20_000 });

    const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await structurePanel.waitFor({ state: 'visible', timeout: 20_000 });
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const collapsed = structurePanel.locator('button[data-action="diagram-structure-toggle"][aria-expanded="false"]');
      if (await collapsed.count() === 0) break;
      await collapsed.first().click();
    }

    const rows = structurePanel.locator('[data-diagram-structure-tree-row]');
    let placement = null;
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      await row.locator('button[data-action="diagram-structure-select"]').click();
      const candidate = structurePanel.locator('[data-diagram-import-placement-mapping]');
      const stage = candidate.locator('[data-diagram-import-placement-field="materialization.stageId"]');
      if (await stage.count() === 0) continue;
      const selectedText = await stage.locator('option:checked').innerText();
      if (/Результат 5/i.test(selectedText)) {
        placement = candidate;
        break;
      }
    }
    assert.ok(placement, 'testtemplate must retain a placement sourced from Result 5.');
    await placement.locator('button[data-action="diagram-import-add-condition"]').click();
    const editorHandle = await page.locator('#cmdp-diagram-section-editor').elementHandle();
    assert.ok(editorHandle, 'Diagram editor must remain mounted while editing a condition.');
    const picker = placement.locator('[data-diagram-import-condition-picker]').last();
    await picker.waitFor({ state: 'visible', timeout: 20_000 });
    const modelRequestsBeforeOpening = modelRequests.length;
    await picker.locator('button[data-action="diagram-import-condition-picker-toggle"]').click();
    const search = picker.locator('[data-diagram-import-condition-picker-search]');
    assert.match(await picker.locator('[data-diagram-import-condition-picker-results]').innerText(), /Введите минимум 1 символ/i, 'Picker must wait for a query before rendering suggestions.');
    await page.waitForTimeout(250);
    assert.deepEqual(
      modelRequests.slice(modelRequestsBeforeOpening),
      [],
      `Opening a D2 condition picker must not request model metadata before typing: ${JSON.stringify(modelRequests.slice(modelRequestsBeforeOpening))}`
    );
    await search.fill('isNAT');
    const option = picker.locator('button[data-action="diagram-import-condition-picker-select"][data-diagram-import-condition-picker-value="{Vlan2super:vlan}.isNAT"]').first();
    await option.waitFor({ state: 'visible', timeout: 20_000 });
    assert.match(await option.innerText(), /VLAN|isNAT/i);
    assert.equal(await picker.locator('select').count(), 0, 'Query-first picker must not render an eager select.');
    assert.ok(await picker.locator('button[data-action="diagram-import-condition-picker-select"]').count() <= 60, 'Picker must bound rendered suggestions.');
    await option.click();
    assert.equal(await picker.locator('[data-diagram-import-condition-field="left.column"]').inputValue(), '{Vlan2super:vlan}.isNAT');
    assert.equal(await editorHandle.evaluate((editor) => editor.isConnected), true, 'Selecting a picker option must not replace the Diagram editor.');
    await editorHandle.dispose();
    assert.deepEqual(pageErrors, []);
  });
});

test('Diagram structure exposes shared filters for dynamic containers and inherited nodes', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `DiagramPlacementFiltersUiSmoke${Date.now()}`;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 placement filters UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
      await page.locator('button[data-action="save-template"]').click();
      assert.equal((await createResponsePromise).status(), 201);

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('#cmdp-diagram-import-source').fill([
        'classes: {',
        '  group: {}',
        '  system: {}',
        '}',
        'systems: "Systems" {',
        '  class: group',
        '  system: "System" { class: system }',
        '}'
      ].join('\n'));
      const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze') && response.request().method() === 'POST');
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      const analyzeResponse = await analyzeResponsePromise;
      assert.equal(analyzeResponse.status(), 200, await analyzeResponse.text());

      await page.locator('a[data-designer-section="diagram"]').click();
      const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
      await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      const containerRow = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first();
      await containerRow.locator('button[data-action="diagram-structure-select"]').click();
      let placement = structurePanel.locator('[data-diagram-import-placement-mapping]');
      assert.match(await placement.innerText(), /Сначала выберите способ наполнения элемента D2/);
      assert.equal(await placement.locator('[data-diagram-import-placement-field="conditions.ruleJoin"]').count(), 0);
      const showEmpty = placement.locator('[data-diagram-import-placement-field="showEmpty"]');
      assert.equal(await showEmpty.count(), 1, 'A container must expose its empty-visibility control.');
      assert.equal(await showEmpty.isChecked(), true);
      await showEmpty.uncheck();
      await structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="showEmpty"]').waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="showEmpty"]').isChecked(), false);

      const saveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
      await page.locator('button[data-action="save-template"]').click();
      assert.equal((await saveResponsePromise).status(), 200);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram"]').click();
      const reloadedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
      await reloadedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      const reloadedContainerRow = reloadedStructurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first();
      await reloadedContainerRow.locator('button[data-action="diagram-structure-select"]').click();
      placement = reloadedStructurePanel.locator('[data-diagram-import-placement-mapping]');
      await placement.locator('[data-diagram-import-placement-field="showEmpty"]').waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await placement.locator('[data-diagram-import-placement-field="showEmpty"]').isChecked(), false, 'Normal Save must restore the selected empty-container policy.');

      await placement.locator('[data-diagram-import-placement-field="materialization.kind"]').selectOption('stage');
      placement = structurePanel.locator('[data-diagram-import-placement-mapping]');
      await placement.locator('[data-diagram-import-placement-field="materialization.stageId"]').waitFor({ state: 'visible', timeout: 10_000 });
      assert.match(await placement.innerText(), /Дополнительная фильтрация результата/);
      assert.equal(await placement.locator('[data-diagram-import-placement-field="conditions.ruleJoin"]').count(), 1);
      assert.equal(await placement.locator('button[data-action="diagram-import-add-condition"]').count(), 1);

      const nodeRow = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').first();
      await nodeRow.locator('button[data-action="diagram-structure-select"]').click();
      placement = structurePanel.locator('[data-diagram-import-placement-mapping]');
      await placement.locator('[data-diagram-import-placement-field="materialization.kind"]').selectOption('parentCard');
      placement = structurePanel.locator('[data-diagram-import-placement-mapping]');
      assert.match(await placement.innerText(), /Фильтр применяется к результату, унаследованному от родительской ветви/);
      assert.equal(await placement.locator('[data-diagram-import-placement-field="conditions.ruleJoin"]').count(), 1);
      assert.equal(await placement.locator('[data-diagram-import-placement-field="showEmpty"]').count(), 0, 'Nodes must not expose a container visibility control.');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        assert.equal((await deleteResponsePromise).status(), 200);
      }
    }
  });
});

test('Diagram structure tree adds inline, clones branches, and deletes explicitly', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `DiagramStructureTreeActionsUiSmoke${Date.now()}`;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 structure tree action UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    assert.equal((await createResponsePromise).status(), 201);

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('#cmdp-diagram-import-source').fill([
        'classes: {',
        '  scope_server: {}',
        '  server: { shape: rectangle }',
        '}',
        'scope_server: "Server scope" {',
        '  server: "Server" { class: server }',
        '}'
      ].join('\n'));
      const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze') && response.request().method() === 'POST');
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      const analyzeResponse = await analyzeResponsePromise;
      assert.equal(analyzeResponse.status(), 200, await analyzeResponse.text());

      await page.locator('a[data-designer-section="diagram"]').click();
      const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
      await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      const tree = structurePanel.locator('[data-diagram-structure-tree-list]');
      const containerRows = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]');
      const firstContainer = containerRows.first();
      await firstContainer.locator('button[data-action="diagram-structure-select"]').click();
      assert.equal(await firstContainer.locator('button[data-action="diagram-structure-add-child"]').count(), 1);
      assert.equal(await firstContainer.locator('button[data-action="diagram-structure-duplicate"]').count(), 1);
      assert.equal(await firstContainer.locator('button[data-action="diagram-structure-remove"]').count(), 1);
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-inspector] button[data-action="diagram-structure-duplicate"]').count(), 0);
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-inspector] button[data-action="diagram-structure-remove"]').count(), 0);
      const initialNode = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').first();
      const containerBox = await firstContainer.boundingBox();
      const nodeBox = await initialNode.boundingBox();
      assert.ok(containerBox && nodeBox && nodeBox.x > containerBox.x, 'A nested D2 item must be visibly indented below its container.');
      const disclosure = firstContainer.locator('button[data-action="diagram-structure-toggle"]');
      assert.equal(await disclosure.count(), 1);
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
      await disclosure.click();
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').length === 0, null, { timeout: 10_000 });
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      assert.match(await firstContainer.innerText(), /\+1/);
      await disclosure.click();
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').length === 1, null, { timeout: 10_000 });
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');

      await firstContainer.locator('button[data-action="diagram-structure-duplicate"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').length === 2, null, { timeout: 10_000 });
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').count(), 2, 'Duplicating a container must include its nested node placements.');

      const copiedContainer = containerRows.nth(1);
      page.once('dialog', (dialog) => dialog.accept());
      await copiedContainer.locator('button[data-action="diagram-structure-remove"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').length === 1, null, { timeout: 10_000 });
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').count(), 1, 'Deleting a branch must remove its nested node placements.');

      await containerRows.first().locator('button[data-action="diagram-structure-select"]').click();
      const placement = structurePanel.locator('[data-diagram-import-placement-mapping]');
      await placement.locator('[data-diagram-import-placement-field="materialization.kind"]').selectOption('stage');
      const refreshedContainer = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first();
      await refreshedContainer.locator('button[data-action="diagram-structure-toggle"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').length === 0, null, { timeout: 10_000 });
      await refreshedContainer.locator('button[data-action="diagram-structure-add-child"]').click();
      const addMenu = tree.locator('[data-diagram-structure-add-menu]').first();
      await addMenu.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await addMenu.evaluate((node) => Boolean(node.closest('[data-diagram-structure-tree-list]'))), true);
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-inspector] [data-diagram-structure-add-menu]').count(), 0);
      await addMenu.locator('button[data-action="diagram-structure-add-role"]').click();
      const nodes = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').length === 2, null, { timeout: 10_000 });
      await nodes.last().locator('button[data-action="diagram-structure-select"]').click();
      assert.equal(await structurePanel.locator('[data-diagram-import-placement-field="materialization.kind"]').inputValue(), 'parentCard');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        assert.equal((await deleteResponsePromise).status(), 200);
      }
    }
  });
});

test('Diagram structure selection keeps the scrolled tree viewport', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    const templateButton = page.locator(`[data-action="select-template"][data-code="${runtimeDiagramTemplate}"]`);
    await templateButton.waitFor({ state: 'visible', timeout: 20_000 });
    await templateButton.click();
    await page.locator('a[data-designer-section="diagram"]').click();
    const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await structurePanel.waitFor({ state: 'visible', timeout: 20_000 });
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const collapsed = structurePanel.locator('button[data-action="diagram-structure-toggle"][aria-expanded="false"]');
      if (await collapsed.count() === 0) break;
      await collapsed.first().click();
    }
    const tree = structurePanel.locator('[data-diagram-structure-tree-list]');
    const targetRow = structurePanel.locator('[data-diagram-structure-tree-row]').last();
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '[data-diagram-structure-tree-list]{max-height:120px!important}';
      document.head.appendChild(style);
    });
    await targetRow.scrollIntoViewIfNeeded();
    const before = await tree.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return { scrollTop: node.scrollTop, maxScrollTop: node.scrollHeight - node.clientHeight };
    });
    assert.ok(before.maxScrollTop > 0, 'Fixture must overflow the structure tree viewport.');
    const targetId = await targetRow.getAttribute('data-diagram-structure-tree-row');
    await targetRow.locator('button[data-action="diagram-structure-select"]').click();
    await page.waitForFunction((itemId) => document.querySelector('[data-diagram-structure-tree-inspector]')?.getAttribute('data-diagram-structure-tree-inspector') === itemId, targetId, { timeout: 10_000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await tree.evaluate((node) => ({ scrollTop: node.scrollTop }));
    assert.ok(after.scrollTop > 0, `Selecting an element reset the tree to the top: ${JSON.stringify({ before, after })}`);
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 2, `Selecting an element changed the tree viewport: ${JSON.stringify({ before, after })}`);
    assert.deepEqual(pageErrors, []);
  });
});

test('testtemplate keeps deep editors lazy and bounds render serialization', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    await page.addInitScript(() => {
      const originalStringify = JSON.stringify;
      const metrics = window.__cmdpRenderMetrics = { calls: 0, bytes: 0, longTasks: [] };
      JSON.stringify = function (...args) {
        const value = originalStringify.apply(this, args);
        metrics.calls += 1;
        metrics.bytes += value.length;
        return value;
      };
      if (typeof PerformanceObserver === 'function') {
        new PerformanceObserver((entries) => {
          entries.getEntries().forEach((entry) => metrics.longTasks.push(Math.round(entry.duration)));
        }).observe({ type: 'longtask', buffered: true });
      }
    });
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    const templateButton = page.locator(`[data-action="select-template"][data-code="${runtimeDiagramTemplate}"]`);
    await templateButton.waitFor({ state: 'visible', timeout: 20_000 });
    await templateButton.click();

    async function open(section, marker) {
      await page.evaluate(() => {
        window.__cmdpRenderMetrics.calls = 0;
        window.__cmdpRenderMetrics.bytes = 0;
        window.__cmdpRenderMetrics.longTasks = [];
      });
      await page.locator(`a[data-designer-section="${section}"]`).click();
      await page.locator(marker).waitFor({ state: 'visible', timeout: 30_000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.evaluate(() => ({
        activeObjectSelections: document.querySelectorAll('[data-object-selection]').length,
        objectSelectionSummaries: document.querySelectorAll('[data-object-selection-summary]').length,
        activeFlowOperations: document.querySelectorAll('[data-flow-operation]').length,
        flowOperationSummaries: document.querySelectorAll('[data-flow-operation-summary]').length,
        selectOptions: document.querySelectorAll('select option').length,
        structureRows: document.querySelectorAll('[data-diagram-structure-tree-row]').length,
        metrics: window.__cmdpRenderMetrics
      }));
    }

    const objectGroup = await open('object-group', '#cmdp-object-group-editor');
    assert.equal(objectGroup.activeObjectSelections, 1);
    assert.ok(objectGroup.objectSelectionSummaries >= 1, JSON.stringify(objectGroup));
    assert.ok(objectGroup.selectOptions <= 64, JSON.stringify(objectGroup));
    assert.equal(objectGroup.metrics.calls, 0, JSON.stringify(objectGroup));

    const relations = await open('relations', '#cmdp-relation-expansion-editor');
    assert.equal(relations.activeFlowOperations, 1);
    assert.ok(relations.flowOperationSummaries >= 1, JSON.stringify(relations));
    assert.ok(relations.selectOptions <= 96, JSON.stringify(relations));
    assert.equal(relations.metrics.calls, 0, JSON.stringify(relations));

    const diagram = await open('diagram', '[data-diagram-import-editor-panel="structure"]');
    assert.ok(diagram.structureRows >= 1, JSON.stringify(diagram));
    assert.ok(diagram.selectOptions <= 64, JSON.stringify(diagram));
    // A cold template load can still perform small JSON clones while normalizing
    // the persisted D2 structure. The old full-spec rebuild exceeded 34k calls
    // and 500 MB for this fixture; keep the regression guard above that noise.
    assert.ok(diagram.metrics.calls < 20_000, JSON.stringify(diagram));
    assert.ok(diagram.metrics.bytes < 1_000_000, JSON.stringify(diagram));
    assert.ok(diagram.metrics.longTasks.every((duration) => duration < 250), JSON.stringify(diagram));
  });
});

test('Diagram editor offers template parameters in D2 mapping labels without changing D2 source', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `DiagramParameterUiSmoke${Date.now()}`;
    const source = [
      'classes: {',
      '  server: { shape: rectangle }',
      '  traffic: {}',
      '}',
      'sources: "Sources" {',
      '  source: "Source" { class: server }',
      '}',
      'targets: "Targets" {',
      '  target: "Target" { class: server }',
      '}',
      'sources.source -> targets.target: "Traffic" { class: traffic }'
    ].join('\n');
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Diagram template parameters UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="params"]').click();
      await page.waitForSelector('#cmdp-params-editor', { timeout: 10_000 });
      const parameter = page.locator('[data-param-row]').last();
      await parameter.locator('[data-param-field="name"]').fill('system');
      await parameter.locator('[data-param-field="required"]').check();
      await parameter.locator('[data-param-field="description"]').fill('System name');
      const saveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
      await page.locator('button[data-action="save-template"]').click();
      const saveResponse = await saveResponsePromise;
      assert.equal(saveResponse.status(), 200, await saveResponse.text());

      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('#cmdp-diagram-import-source').fill(source);
      const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze') && response.request().method() === 'POST');
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      const analyzeResponse = await analyzeResponsePromise;
      assert.equal(analyzeResponse.status(), 200, await analyzeResponse.text());

      await page.locator('a[data-designer-section="diagram"]').click();
      await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
      const mappingBlock = page.locator('[data-diagram-editor-section="d2-mappings"]');
      const structureRow = mappingBlock.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').first();
      await structureRow.locator('button[data-action="diagram-structure-select"]').click();
      const nodeTemplate = mappingBlock.locator('input[data-diagram-import-placement-field="primary.labelTemplate"]');
      await nodeTemplate.waitFor({ state: 'visible', timeout: 10_000 });
      const parameterSuggestions = mappingBlock.locator('[data-diagram-import-label-template-parameters]');
      await parameterSuggestions.waitFor({ state: 'visible', timeout: 10_000 });
      const parameterSuggestionsBox = await parameterSuggestions.boundingBox();
      assert.ok(parameterSuggestionsBox && parameterSuggestionsBox.width > 0 && parameterSuggestionsBox.height > 0, 'Template parameter suggestions are not visibly rendered.');
      const parameterButton = parameterSuggestions.locator('[data-action="insert-diagram-template-token"][data-template-token="param.system"]');
      await parameterButton.waitFor({ state: 'visible', timeout: 10_000 });
      await nodeTemplate.focus();
      await nodeTemplate.press('End');
      await parameterButton.click();
      assert.equal(await nodeTemplate.inputValue(), '${Description}${param.system}');
      await nodeTemplate.fill('${par');
      const parameterOption = mappingBlock.locator('[data-diagram-import-label-option="param.system"]');
      await parameterOption.waitFor({ state: 'visible', timeout: 10_000 });
      const parameterBox = await parameterOption.boundingBox();
      assert.ok(parameterBox && parameterBox.width > 0 && parameterBox.height > 0, 'Parameter autocomplete option is not visible.');
      await parameterOption.click();
      assert.equal(await nodeTemplate.inputValue(), '${param.system}');

      await mappingBlock.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="connections"]').click();
      const connectionTemplate = mappingBlock.locator('input[data-diagram-import-rule-field="labelTemplate"]').first();
      await connectionTemplate.waitFor({ state: 'visible', timeout: 10_000 });
      const connectionParameter = mappingBlock.locator('[data-diagram-import-rule-row] [data-template-token="param.system"]').first();
      await connectionParameter.waitFor({ state: 'visible', timeout: 10_000 });
      await connectionParameter.click();
      assert.equal(await connectionTemplate.inputValue(), '${param.system}');
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      const sourceField = page.locator('#cmdp-diagram-import-source');
      await sourceField.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await sourceField.inputValue(), source);
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        const deleteResponse = await deleteResponsePromise;
        assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
      }
    }
  });
});

test('Diagram editor separates element data from hierarchy correlations', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `DiagramEditorTabsUiSmoke${Date.now()}`;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Diagram editor tabs UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="object-group"]').click();
      await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
      for (let index = 0; index < 2; index += 1) {
        if (index > 0) await page.locator('button[data-action="add-object-selection"]').click();
        const selection = page.locator('[data-object-selection]').first();
        const className = selection.locator('[data-object-selection-field="className"]');
        if (await className.locator('option[value="ARM"]').count() === 0) {
          await page.locator('#cmdp-catalog-header').click();
          await className.locator('option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
        }
        await selection.locator('[data-object-selection-field="name"]').fill(index === 0 ? 'Родительский результат' : 'Дочерний результат');
        await selection.locator('[data-object-selection-field="alias"]').fill(index === 0 ? 'hierarchyParent' : 'hierarchyChild');
        await className.selectOption('ARM');
      }
      await page.locator('button[data-action="apply-object-group"]').click();
      const assistantLink = page.locator('a[data-designer-section="diagram-assistant"]');
      await assistantLink.waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector('a[data-designer-section="diagram-assistant"]')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 10_000 });
      await assistantLink.click();
      try {
        await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      } catch (error) {
        const body = await page.locator('body').innerText().catch(() => '');
        assert.fail(`${error.message}\nBrowser errors: ${pageErrors.join(' | ') || '(none)'}\nBody: ${body.slice(0, 2000)}`);
      }
      await page.locator('#cmdp-diagram-import-source').fill([
        'classes: { server: { shape: rectangle } }',
        'servers: "Servers" {',
        '  first: "Server A" { class: server }',
        '  second: "Server B" { class: server }',
        '}',
        'servers.first -> servers.second: "connects"'
      ].join('\n'));
      const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze'));
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      const analyzeResponse = await analyzeResponsePromise;
      const analyzeBody = await analyzeResponse.json();
      assert.equal(analyzeResponse.status(), 200, `D2 analysis failed: ${JSON.stringify(analyzeBody)}`);

      await page.locator('a[data-designer-section="diagram"]').click();
      await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
      const mappingBlock = page.locator('[data-diagram-editor-section="d2-mappings"]');
      assert.equal(await mappingBlock.isVisible(), true);
      const nodesTab = mappingBlock.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="nodes"]');
      const structureTab = mappingBlock.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="structure"]');
      const hierarchyTab = mappingBlock.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="hierarchy"]');
      const connectionsTab = mappingBlock.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="connections"]');
      assert.equal(await nodesTab.count(), 0);
      assert.equal(await structureTab.getAttribute('aria-selected'), 'true');
      assert.equal(await hierarchyTab.getAttribute('aria-selected'), 'false');
      assert.equal(await connectionsTab.getAttribute('aria-selected'), 'false');
      const structurePanel = mappingBlock.locator('[data-diagram-import-editor-panel="structure"]');
      await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await structureTab.getAttribute('aria-selected'), 'true');
      const structureBox = await structurePanel.boundingBox();
      assert.ok(structureBox && structureBox.width > 0 && structureBox.height > 0, 'Structure panel is not visible.');
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree]').count(), 1, 'Structure panel must expose the persisted tree.');
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-root]').count(), 1);
      assert.ok(await structurePanel.locator('[data-diagram-structure-tree-row]').count() > 0, 'Structure panel must expose D2 tree items.');
      assert.equal(await structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').count(), 1, 'Sibling D2 exemplars in one role-path context must share one editable mapping.');
      assert.doesNotMatch(await structurePanel.innerText(), /D2 exemplar/);
      assert.equal(await mappingBlock.locator('[data-diagram-import-editor-panel="nodes"]').count(), 0);

      const nodeRow = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').first();
      await nodeRow.locator('button[data-action="diagram-structure-select"]').click();
      const placementMapping = structurePanel.locator('[data-diagram-import-placement-mapping]');
      await placementMapping.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await placementMapping.locator('[data-diagram-import-placement-field="materialization.kind"]').count(), 1);
      assert.equal(await placementMapping.locator('[data-diagram-import-placement-field="materialization.stageId"]').count(), 1);
      assert.equal(await placementMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').count(), 1);
      assert.equal(await placementMapping.locator('[data-diagram-import-placement-field="primary.structuredFields"]').count(), 1);
      assert.equal(await placementMapping.locator('[data-diagram-import-placement-field="conditions.ruleJoin"]').count(), 1);
      assert.equal(await placementMapping.locator('button[data-action="diagram-import-add-condition"]').count(), 1);
      assert.equal(await placementMapping.locator('[data-diagram-import-label-data]').count(), 1, 'Related label and structured data must be edited with the selected element.');
      assert.equal(await placementMapping.locator('[data-diagram-import-related-empty-row]').count(), 1, 'The selected element must explain why additional data cannot be added before its Object Flow result is selected.');

      const structureWorkbench = structurePanel.locator('[data-diagram-structure-tree]');
      const structureTree = structureWorkbench.locator('[data-diagram-structure-tree-list]');
      const structureInspector = structureWorkbench.locator('.diagram-element-inspector');
      const structureLayout = () => structureWorkbench.evaluate((workbench) => {
        const rect = (node) => {
          const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
          return { left, top, right, bottom, width, height };
        };
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          overflowing: Array.from(document.body.querySelectorAll('*')).map((node) => {
            const bounds = node.getBoundingClientRect();
            return {
              tag: node.tagName.toLowerCase(),
              className: String(node.className || ''),
              testId: node.getAttribute('data-diagram-import-placement-mapping') || node.getAttribute('data-diagram-import-conditions') || '',
              action: node.getAttribute('data-action') || '',
              text: String(node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180),
              right: bounds.right
            };
          }).filter((item) => item.right > window.innerWidth + 1).slice(0, 12),
          workbench: rect(workbench),
          tree: rect(workbench.querySelector('[data-diagram-structure-tree-list]')),
          inspector: rect(workbench.querySelector('.diagram-element-inspector'))
        };
      });

      await page.setViewportSize({ width: 1280, height: 900 });
      assert.equal(await structureTree.isVisible(), true);
      assert.equal(await structureInspector.isVisible(), true);
      const desktopLayout = await structureLayout();
      assert.ok(desktopLayout.tree.width >= 240 && desktopLayout.tree.width <= 280, JSON.stringify(desktopLayout));
      assert.ok(desktopLayout.tree.left < desktopLayout.inspector.left, JSON.stringify(desktopLayout));
      assert.ok(desktopLayout.tree.right <= desktopLayout.inspector.left - 8, JSON.stringify(desktopLayout));
      assert.ok(Math.abs(desktopLayout.inspector.right - desktopLayout.workbench.right) <= 1, JSON.stringify(desktopLayout));
      assert.ok(desktopLayout.documentWidth <= desktopLayout.viewportWidth, JSON.stringify(desktopLayout));

      await page.setViewportSize({ width: 390, height: 844 });
      const mobileLayout = await structureLayout();
      assert.ok(mobileLayout.tree.bottom <= mobileLayout.inspector.top - 8, JSON.stringify(mobileLayout));
      assert.ok(Math.abs(mobileLayout.tree.left - mobileLayout.inspector.left) <= 1, JSON.stringify(mobileLayout));
      assert.ok(Math.abs(mobileLayout.tree.right - mobileLayout.inspector.right) <= 1, JSON.stringify(mobileLayout));
      assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth, JSON.stringify(mobileLayout));

      await connectionsTab.click();
      const connectionsPanel = mappingBlock.locator('[data-diagram-import-editor-panel="connections"]');
      await connectionsPanel.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await connectionsTab.getAttribute('aria-selected'), 'true');
      assert.equal(await connectionsPanel.getByRole('heading', { name: 'Связи D2' }).count(), 1, 'D2 connection rules must remain available in a separate editor tab.');
      assert.ok(await connectionsPanel.locator('[data-diagram-import-rule-field="sourceStageId"]').count() > 0, 'Connection must select a named Object Flow result.');
      assert.ok(await connectionsPanel.locator('[data-diagram-import-rule-field="sourceField"]').count() > 0, 'Connection must select its source endpoint field from the result.');
      assert.equal(await connectionsPanel.locator('[data-diagram-import-rule-field="path"]').count(), 0, 'Diagram must not expose a second CMDB path editor.');
      assert.doesNotMatch(await connectionsPanel.innerText(), /CMDB relation path|Путь CMDBuild/);
      await hierarchyTab.click();
      const hierarchyPanel = mappingBlock.locator('[data-diagram-import-editor-panel="hierarchy"]');
      await hierarchyPanel.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await hierarchyTab.getAttribute('aria-selected'), 'true');
      assert.equal(await hierarchyPanel.getByRole('heading', { name: 'Связи иерархии' }).count(), 1);
      assert.equal(await hierarchyPanel.locator('[data-diagram-import-hierarchy-tree]').count(), 1, 'Hierarchy must use the saved D2 structure tree instead of a flat table.');
      assert.ok(await hierarchyPanel.locator('[data-diagram-hierarchy-tree-row]').count() > 0, 'Hierarchy must expose every element of the saved branch.');
      const configureStructure = hierarchyPanel.locator('button[data-action="diagram-structure-select"][data-diagram-import-open-structure="true"]').first();
      assert.equal(await configureStructure.isVisible(), true, 'A missing Object Flow prerequisite must provide a visible route to the specific Structure item.');
      const configureBox = await configureStructure.boundingBox();
      assert.ok(configureBox && configureBox.width > 0 && configureBox.height > 0, 'The Structure route must be actionable in the rendered hierarchy panel.');
      await configureStructure.click();
      assert.equal(await structureTab.getAttribute('aria-selected'), 'true', 'The prerequisite action must open the Structure editor.');
      await structurePanel.locator('[data-diagram-structure-tree-inspector]').waitFor({ state: 'visible', timeout: 10_000 });
      const containerRow = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first();
      await containerRow.locator('button[data-action="diagram-structure-select"]').click();
      const parentMapping = structurePanel.locator('[data-diagram-import-placement-mapping]');
      await parentMapping.locator('[data-diagram-import-placement-field="materialization.kind"]').selectOption('stage');
      await parentMapping.locator('[data-diagram-import-placement-field="materialization.stageId"]').selectOption('selection:hierarchyParent');
      await structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="node"]').first().locator('button[data-action="diagram-structure-select"]').click();
      const childMapping = structurePanel.locator('[data-diagram-import-placement-mapping]');
      await childMapping.locator('[data-diagram-import-placement-field="materialization.kind"]').selectOption('stage');
      await childMapping.locator('[data-diagram-import-placement-field="materialization.stageId"]').selectOption('selection:hierarchyChild');
      await hierarchyTab.click();
      await hierarchyPanel.waitFor({ state: 'visible', timeout: 10_000 });
      const readyHierarchy = hierarchyPanel.locator('[data-diagram-import-hierarchy-row]').first();
      await readyHierarchy.waitFor({ state: 'visible', timeout: 10_000 });
      const addHierarchyCondition = readyHierarchy.locator('button[data-action="diagram-import-add-hierarchy-condition"]');
      assert.equal(await addHierarchyCondition.isVisible(), true, 'Two materialized results must expose an add action for a hierarchy condition.');
      const hierarchyContract = await readyHierarchy.evaluate((row) => ({
        childStage: row.getAttribute('data-diagram-import-hierarchy-child-stage-id'),
        parentStage: row.getAttribute('data-diagram-import-hierarchy-parent-stage-id'),
        buttonChildStage: row.querySelector('button[data-action="diagram-import-add-hierarchy-condition"]')?.getAttribute('data-diagram-import-hierarchy-source-stage-id'),
        buttonParentStage: row.querySelector('button[data-action="diagram-import-add-hierarchy-condition"]')?.getAttribute('data-diagram-import-hierarchy-parent-stage-id')
      }));
      assert.deepEqual(hierarchyContract, {
        childStage: 'selection:hierarchyChild',
        parentStage: 'selection:hierarchyParent',
        buttonChildStage: 'selection:hierarchyChild',
        buttonParentStage: 'selection:hierarchyParent'
      });
      await addHierarchyCondition.click();
      const hierarchyCondition = readyHierarchy.locator('[data-diagram-import-hierarchy-condition-row]').first();
      await hierarchyCondition.waitFor({ state: 'visible', timeout: 10_000 });
      await page.setViewportSize({ width: 1280, height: 900 });
      const childFieldPicker = hierarchyCondition.locator('[data-diagram-import-condition-picker]').first();
      await childFieldPicker.locator('button[data-action="diagram-import-condition-picker-toggle"]').click();
      await childFieldPicker.locator('[data-diagram-import-condition-picker-search]').fill('Code');
      const childFieldOption = childFieldPicker.locator('button[data-action="diagram-import-condition-picker-select"]').first();
      await childFieldOption.waitFor({ state: 'visible', timeout: 10_000 });
      const hierarchyPickerLayout = await childFieldPicker.evaluate((picker) => {
        const menu = picker.querySelector('[data-diagram-import-condition-picker-menu]');
        const rect = menu.getBoundingClientRect();
        const style = getComputedStyle(menu);
        const clippingAncestor = picker.closest('.table-wrap');
        const ancestorRect = clippingAncestor && clippingAncestor.getBoundingClientRect();
        return {
          position: style.position,
          width: rect.width,
          maxHeight: Number.parseFloat(style.maxHeight),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          ancestorRight: ancestorRect && ancestorRect.right
        };
      });
      assert.equal(hierarchyPickerLayout.position, 'fixed', JSON.stringify(hierarchyPickerLayout));
      assert.ok(hierarchyPickerLayout.width >= 500, JSON.stringify(hierarchyPickerLayout));
      assert.ok(hierarchyPickerLayout.maxHeight > 260, JSON.stringify(hierarchyPickerLayout));
      assert.ok(hierarchyPickerLayout.left >= 0 && hierarchyPickerLayout.right <= hierarchyPickerLayout.viewportWidth, JSON.stringify(hierarchyPickerLayout));
      assert.ok(hierarchyPickerLayout.top >= 0 && hierarchyPickerLayout.bottom <= hierarchyPickerLayout.viewportHeight, JSON.stringify(hierarchyPickerLayout));
      assert.ok(hierarchyPickerLayout.right > hierarchyPickerLayout.ancestorRight, JSON.stringify(hierarchyPickerLayout));
      await page.setViewportSize({ width: 960, height: 620 });
      await page.waitForFunction(() => {
        const menu = document.querySelector('[data-diagram-import-condition-picker-menu]:not([hidden])');
        if (!menu) return false;
        const rect = menu.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }, null, { timeout: 10_000 });
      await page.setViewportSize({ width: 1280, height: 900 });
      await childFieldOption.click();
      const parentFieldPicker = hierarchyCondition.locator('[data-diagram-import-condition-picker]').nth(1);
      await parentFieldPicker.locator('button[data-action="diagram-import-condition-picker-toggle"]').click();
      await parentFieldPicker.locator('[data-diagram-import-condition-picker-search]').fill('Code');
      const parentFieldOption = parentFieldPicker.locator('button[data-action="diagram-import-condition-picker-select"]').first();
      await parentFieldOption.waitFor({ state: 'visible', timeout: 10_000 });
      await parentFieldOption.click();
      await connectionsTab.click();
      await hierarchyTab.click();
      const retainedHierarchyCondition = hierarchyPanel.locator('[data-diagram-import-hierarchy-condition-row]').first();
      assert.equal(await retainedHierarchyCondition.locator('[data-diagram-import-hierarchy-field="left.column"]').inputValue(), 'Code');
      assert.equal(await retainedHierarchyCondition.locator('[data-diagram-import-hierarchy-field="right.column"]').inputValue(), 'Code');
      assert.equal(await hierarchyPanel.locator('[data-diagram-import-related-data-row]').count(), 0, 'Hierarchy must not edit related label data.');
      assert.equal(await hierarchyPanel.locator('[data-diagram-import-hierarchy-field="className"]').count(), 0, 'Hierarchy must not choose a CMDB class.');
      assert.equal(await hierarchyPanel.locator('[data-diagram-import-hierarchy-field="path"]').count(), 0, 'Hierarchy must not define a CMDB path.');
      const saveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
      await page.locator('button[data-action="save-template"]').click();
      assert.equal((await saveResponsePromise).status(), 200);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram"]').click();
      const savedMappingBlock = page.locator('[data-diagram-editor-section="d2-mappings"]');
      const savedHierarchyTab = savedMappingBlock.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="hierarchy"]');
      await savedHierarchyTab.click();
      const savedHierarchyPanel = savedMappingBlock.locator('[data-diagram-import-editor-panel="hierarchy"]');
      await savedHierarchyPanel.waitFor({ state: 'visible', timeout: 10_000 });
      const savedCondition = savedHierarchyPanel.locator('[data-diagram-import-hierarchy-condition-row]').first();
      assert.equal(await savedCondition.locator('[data-diagram-import-hierarchy-field="left.column"]').inputValue(), 'Code', 'Global Save must persist the hierarchy condition.');
      assert.equal(await savedCondition.locator('[data-diagram-import-hierarchy-field="right.column"]').inputValue(), 'Code', 'Global Save must persist the hierarchy parent field.');
      await savedCondition.locator('button[data-action="diagram-import-remove-hierarchy-condition"]').click();
      assert.equal(await savedHierarchyPanel.locator('[data-diagram-import-hierarchy-condition-row]').count(), 0, 'The hierarchy editor must allow a manually added condition to be removed.');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        const deleteResponse = await deleteResponsePromise;
        assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
      }
    }
  });
});

test('Diagram editor saves incomplete structure edits as template state', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `DiagramIncompleteSaveUiSmoke${Date.now()}`;
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Incomplete D2 editor persistence smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    assert.equal((await createResponsePromise).status(), 201);

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('#cmdp-diagram-import-source').fill([
        'classes: { server: { shape: rectangle } }',
        'servers: "Servers" {',
        '  first: "Server A" { class: server }',
        '  second: "Server B" { class: server }',
        '}'
      ].join('\n'));
      const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze'));
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      assert.equal((await analyzeResponsePromise).status(), 200);

      await page.locator('a[data-designer-section="diagram"]').click();
      const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
      await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      const containerRow = structurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first();
      await containerRow.locator('button[data-action="diagram-structure-select"]').click();
      const placement = structurePanel.locator('[data-diagram-import-placement-mapping]');
      const labelTemplate = placement.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
      await labelTemplate.fill('Сохраненная группа');
      await labelTemplate.blur();
      assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false);

      await page.locator('button[data-action="open-visualization"]').click();
      const visualization = page.locator('#cmdp-visualization-editor');
      await visualization.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await visualization.locator('[data-diagram-editor-section="d2-mappings"]').count(), 0, 'Visualization must not duplicate the D2 mapping editor.');
      const intermediatePreview = visualization.locator('button[data-action="diagram-import-preview-current"]');
      assert.equal(await intermediatePreview.isEnabled(), true);
      // An incomplete mapping intentionally has no backend data diagram. This response
      // isolates the client invariant: a successful prior preview must survive navigation
      // and unsaved editor changes until the user explicitly refreshes it.
      await page.route('**/cmdbuild/custom-api/draft/preview?*', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          result: {
            trace: [],
            diagrams: [{
              id: 'ui-preview',
              name: 'ui-preview',
              title: 'UI preview',
              nodes: [{ id: 'server-a', label: 'Server A' }],
              edges: [],
              svg: { rendered: true, content: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><text x="8" y="36">Server A</text></svg>' }
            }]
          }
        })
      }));
      const previewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview') && request.method() === 'POST');
      const previewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview') && response.request().method() === 'POST');
      await intermediatePreview.click();
      const previewRequest = await previewRequestPromise;
      const previewResponse = await previewResponsePromise;
      const previewPayload = previewRequest.postDataJSON();
      assert.equal(previewPayload.template.spec.authoring?.d2?.source.includes('servers: "Servers"'), true);
      assert.equal(previewPayload.template.spec.result?.diagrams?.[0]?.authoring?.d2Import?.mappingValidation?.status, 'needsValidation');
      assert.equal(previewPayload.template.spec.result?.diagrams?.[0]?.authoring?.d2Import?.structureTree?.items.some((item) => item.mapping?.primary?.labelTemplate === 'Сохраненная группа'), true, 'Intermediate preview must use the current unsaved structure fields.');
      assert.equal(previewResponse.status(), 200, await previewResponse.text());
      const previewBlock = visualization.locator('[data-diagram-import-runtime-preview]');
      await previewBlock.waitFor({ state: 'visible', timeout: 30_000 });
      await previewBlock.locator('[data-d2-rendered-svg]').first().waitFor({ state: 'visible', timeout: 30_000 });

      await page.locator('a[data-designer-section="diagram"]').click();
      await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="primary.labelTemplate"]').inputValue(), 'Сохраненная группа');

      const changedLabelTemplate = structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="primary.labelTemplate"]');
      await changedLabelTemplate.fill('Сохраненная группа после preview');
      await changedLabelTemplate.blur();
      await page.locator('a[data-designer-section="visualization"]').click();
      await visualization.waitFor({ state: 'visible', timeout: 10_000 });
      const retainedPreview = visualization.locator('[data-diagram-import-runtime-preview]');
      await retainedPreview.locator('[data-d2-rendered-svg]').first().waitFor({ state: 'visible', timeout: 30_000 });
      assert.match(await retainedPreview.innerText(), /построена до изменения текущего draft|built before the current draft changed/i);

      const retryPreviewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview') && request.method() === 'POST');
      const retryPreviewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview') && response.request().method() === 'POST');
      await retainedPreview.locator('button[data-action="diagram-import-preview-retry"]').click();
      const retryPreviewRequest = await retryPreviewRequestPromise;
      const retryPreviewPayload = retryPreviewRequest.postDataJSON();
      assert.equal(
        retryPreviewPayload.template.spec.result?.diagrams?.[0]?.authoring?.d2Import?.structureTree?.items
          .some((item) => item.mapping?.primary?.labelTemplate === 'Сохраненная группа после preview'),
        true,
        'Retry must build a new preview from the current unsaved D2 editor state instead of replaying an older request snapshot.'
      );
      assert.equal((await retryPreviewResponsePromise).status(), 200);

      await page.locator('a[data-designer-section="diagram"]').click();
      await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="primary.labelTemplate"]').inputValue(), 'Сохраненная группа после preview');

      const saveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
      await page.locator('button[data-action="save-template"]').click();
      assert.equal((await saveResponsePromise).status(), 200);

      await page.locator('a[data-designer-section="templates"]').click();
      await page.waitForSelector('#cmdp-template-list', { timeout: 10_000 });
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram"]').click();
      const reloadedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
      await reloadedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      const reloadedContainerRow = reloadedStructurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first();
      await reloadedContainerRow.locator('button[data-action="diagram-structure-select"]').click();
      const reloadedLabelTemplate = reloadedStructurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="primary.labelTemplate"]');
      await reloadedLabelTemplate.waitFor({ state: 'visible', timeout: 10_000 });
      const reloadedLabelBox = await reloadedLabelTemplate.boundingBox();
      assert.ok(reloadedLabelBox && reloadedLabelBox.width > 0 && reloadedLabelBox.height > 0, 'The restored label editor must remain visibly usable.');
      assert.equal(await reloadedLabelTemplate.inputValue(), 'Сохраненная группа после preview');
      assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false, 'An incomplete mapping must not block normal template Save after reopening Diagram.');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram"]').click();
      const restoredStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
      await restoredStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
      await restoredStructurePanel.locator('[data-diagram-structure-tree-row][data-diagram-structure-tree-kind="container"]').first().locator('button[data-action="diagram-structure-select"]').click();
      assert.equal(await restoredStructurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="primary.labelTemplate"]').inputValue(), 'Сохраненная группа после preview');
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        assert.equal((await deleteResponsePromise).status(), 200);
      }
    }
  });
});

test('Runtime settings expose a configurable Assistant reference-path depth', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-runtime-settings', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');

    const field = page.locator('#cmdp-assistant-semantic-plan-max-reference-path-depth');
    await field.waitFor({ timeout: 10_000 });
    assert.equal(await field.isVisible(), true);
    assert.match(await field.locator('xpath=..').innerText(), /Глубина reference-пути/);
  });
});

test('Assistant keeps prompts separate from deterministic Designer controls', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('AssistantPromptOnlyUiSmoke');
    await page.locator('#cmdp-description').fill('Assistant prompt-only UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });

    assert.equal((await page.locator('a[data-designer-section="assistant"]').innerText()).trim(), 'Ассистент групп и сопоставлений');
    assert.equal((await page.locator('#cmdp-assistant-editor h2').first().innerText()).trim(), 'Ассистент групп и сопоставлений');
    assert.match(await page.locator('#cmdp-assistant-editor').innerText(), /Статус ассистента/);
    assert.doesNotMatch(await page.locator('#cmdp-assistant-editor').innerText(), /Provider|Base URL|Model|MCP context/);
    assert.equal(await page.locator('[data-object-selection], [data-matching-block], [data-matching-rule-row], [data-diagram-import-role-mapping]').count(), 0);
    assert.equal(await page.locator('#cmdp-assistant-diagram-mapping-prompt').count(), 0);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').count(), 0);

    await addAssistantBusinessBlock(page);
    const flowPrompt = page.locator('#assistant-flow-0-algorithm');
    assert.equal(await flowPrompt.isVisible(), true);
    assert.equal(await page.locator('[data-assistant-flow-selection], [data-assistant-flow-match]').count(), 0);
    const promptWidth = await flowPrompt.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const parentRect = node.closest('[data-assistant-flow-block]').getBoundingClientRect();
      return { width: rect.width, parentWidth: parentRect.width };
    });
    assert.ok(promptWidth.width >= promptWidth.parentWidth - 24, JSON.stringify(promptWidth));

    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    assert.equal((await page.locator('a[data-designer-section="diagram-assistant"]').innerText()).trim(), 'Ассистент диаграмм');
    assert.match(await page.locator('#cmdp-diagram-assistant-editor').innerText(), /Статус ассистента/);
    assert.equal(await page.locator('#cmdp-diagram-import-source').count(), 1);
    assert.equal(await page.locator('#assistant-flow-0-algorithm').count(), 0);
  });
});

test('Assistant persists canonical authoring only through the explicit template Save', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `AssistantAuthoringSaveUiSmoke${Date.now()}`;
    const prompts = {
      objectFlow: {
        name: 'IP ranges of information system',
        entities: 'Информационная система по параметру isName и связанные IP-диапазоны.',
        algorithm: 'Найти ИС по isName и получить связанные ipRange.',
        expectedResult: 'Таблица IP-диапазонов выбранной ИС.'
      },
      interpret: 'Контейнеры являются визуальными группами, а узлы - экземплярами CMDB-классов.',
      mapping: 'Сопоставить выборки с D2-ролями по семантике и доступным атрибутам.'
    };
    const d2Source = 'server: "Server" { class: server }';
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Assistant canonical authoring Save UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());

    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    const retiredAssistantDraftRequests = [];
    page.on('request', (request) => {
      if (request.url().includes(`/cmdbuild/custom-api/templates/${encodeURIComponent(code)}/assistant-draft`)) {
        retiredAssistantDraftRequests.push({ method: request.method(), url: request.url() });
      }
    });
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, prompts.objectFlow);
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    await page.locator('#cmdp-diagram-import-source').fill(d2Source);
    await page.locator('#cmdp-assistant-diagram-interpret-prompt').fill(prompts.interpret);
    await page.locator('#cmdp-assistant-diagram-mapping-prompt').fill(prompts.mapping);
    await page.waitForTimeout(700);
    assert.deepEqual(retiredAssistantDraftRequests, [], 'Assistant input must not use the retired assistant-draft endpoint.');

    const saveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${encodeURIComponent(code)}`) && response.request().method() === 'PUT');
    await page.locator('button[data-action="save-template"]').click();
    const saveResponse = await saveResponsePromise;
    const saveRequest = saveResponse.request().postDataJSON();
    const saveBody = await saveResponse.json();
    assert.equal(saveResponse.status(), 200, JSON.stringify(saveBody));
    const expectedObjectFlowIntent = {
      context: '',
      blocks: [{ id: 'block-1', uses: [], ...prompts.objectFlow }]
    };
    assert.deepEqual(saveRequest?.spec?.authoring?.assistant?.objectFlowIntent, expectedObjectFlowIntent);
    assert.equal(saveRequest?.spec?.authoring?.assistant?.diagramInterpretPrompt, prompts.interpret);
    assert.equal(saveRequest?.spec?.authoring?.assistant?.diagramMappingPrompt, prompts.mapping);
    assert.equal(saveRequest?.spec?.authoring?.d2?.source, d2Source);
    const storedAuthoring = saveBody?.template?.spec?.authoring;
    assert.equal(storedAuthoring?.version, 1);
    assert.deepEqual(storedAuthoring?.assistant?.objectFlowIntent, expectedObjectFlowIntent);
    assert.equal(storedAuthoring?.assistant?.diagramInterpretPrompt, prompts.interpret);
    assert.equal(storedAuthoring?.assistant?.diagramMappingPrompt, prompts.mapping);
    assert.equal(storedAuthoring?.d2?.source, d2Source);
    assert.equal(storedAuthoring?.d2?.sourceHash, createHash('sha256').update(d2Source).digest('hex'));
    assert.equal(saveBody?.template?.spec?.assistantDraft, undefined);
    assert.equal(saveBody?.cacheInvalidation?.runtime?.reason, 'authoring_only');
    assert.equal(saveBody?.cacheInvalidation?.staticSnapshots?.reason, 'authoring_only');
    assert.deepEqual(retiredAssistantDraftRequests, [], 'Explicit Save must use the normal template endpoint.');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    assert.equal(await page.locator('#assistant-flow-0-name').inputValue(), prompts.objectFlow.name);
    assert.equal(await page.locator('#assistant-flow-0-entities').inputValue(), prompts.objectFlow.entities);
    assert.equal(await page.locator('#assistant-flow-0-algorithm').inputValue(), prompts.objectFlow.algorithm);
    assert.equal(await page.locator('#assistant-flow-0-expected-result').inputValue(), prompts.objectFlow.expectedResult);
    assert.equal(await page.locator('[data-assistant-flow-block]').count(), 1);
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-assistant-diagram-interpret-prompt').inputValue(), prompts.interpret);
    assert.equal(await page.locator('#cmdp-assistant-diagram-mapping-prompt').inputValue(), prompts.mapping);
    assert.equal(await page.locator('#cmdp-diagram-import-source').inputValue(), d2Source);

    // A deterministic rebuild must preserve the complete canonical authoring
    // envelope even though the Object Group builder replaces steps and tables.
    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
    const selection = page.locator('[data-object-selection]').first();
    if (await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').count() === 0) {
      await page.locator('#cmdp-catalog-header').click();
      await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
    }
    await selection.locator('[data-object-selection-field="name"]').fill('Рабочие места');
    await selection.locator('[data-object-selection-field="className"]').selectOption('ARM');
    await page.locator('button[data-action="apply-object-group"]').click();
    const rebuildSavePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${encodeURIComponent(code)}`) && response.request().method() === 'PUT');
    await page.locator('button[data-action="save-template"]').click();
    const rebuildSave = await rebuildSavePromise;
    const rebuildBody = await rebuildSave.json();
    assert.equal(rebuildSave.status(), 200, JSON.stringify(rebuildBody));
    assert.equal(rebuildBody?.template?.spec?.authoring?.assistant?.diagramInterpretPrompt, prompts.interpret);
    assert.equal(rebuildBody?.template?.spec?.authoring?.assistant?.diagramMappingPrompt, prompts.mapping);
    assert.equal(rebuildBody?.template?.spec?.authoring?.d2?.source, d2Source);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-assistant-diagram-interpret-prompt').inputValue(), prompts.interpret);
    assert.equal(await page.locator('#cmdp-assistant-diagram-mapping-prompt').inputValue(), prompts.mapping);
    assert.equal(await page.locator('#cmdp-diagram-import-source').inputValue(), d2Source);

    await page.locator('a[data-designer-section="templates"]').click();
    const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
    await deleteButton.waitFor({ timeout: 10_000 });
    page.once('dialog', (dialog) => dialog.accept());
    const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
    await deleteButton.click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
  });
});

test('Assistant keeps an Object Flow response after updating a saved template variable and reloading it', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `AssistantFlowRevisionUiSmoke${Date.now()}`;
    const prompt = [
      'Выборка 1',
      'Для информационной системы (ИС) имя которой равно параметру отчета isName, выбираем все связанные объекты ipRange.'
    ].join('\n');
    const flow = {
      version: 1,
      selections: [{
        id: 'selection:informationSystems',
        name: 'Information systems',
        alias: 'informationSystems',
        className: 'IS',
        from: '',
        limit: 1,
        columns: ['Name'],
        rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
      }],
      operations: [{
        id: 'relation:ipRanges',
        type: 'relation',
        from: 'informationSystems',
        as: 'ipRanges',
        domain: 'ISZabbixMonitoringDomain',
        targetClass: 'ipRange',
        direction: 'source',
        columns: ['range'],
        limit: 100,
        distinct: true
      }],
      blocks: [],
      setOperations: [],
      publishedAlias: 'ipRanges'
    };

    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Assistant revision guard UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    const createdTemplatesReloadPromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates?limit=1000') && response.request().method() === 'GET');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());
    await createdTemplatesReloadPromise;

    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="params"]').click();
    await page.waitForSelector('#cmdp-params-editor', { timeout: 10_000 });
    const variableRow = page.locator('[data-param-row]').last();
    await variableRow.locator('[data-param-field="name"]').fill('isName');
    await variableRow.locator('[data-param-field="required"]').check();

    const saveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
    const savedTemplatesReloadPromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates?limit=1000') && response.request().method() === 'GET');
    await page.locator('button[data-action="save-template"]').click();
    const saveResponse = await saveResponsePromise;
    assert.equal(saveResponse.status(), 200, await saveResponse.text());
    await savedTemplatesReloadPromise;
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, {
      name: 'IP ranges of selected IS',
      entities: 'Информационная система и ipRange.',
      algorithm: prompt,
      expectedResult: 'Таблица связанных IP-диапазонов.'
    });

    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          semanticPlan: { version: 1, blocks: [{ id: 'block-1', name: 'IP ranges of selected IS', summary: 'ИС -> ipRange', resolvedEntities: ['IS', 'ipRange'], relationPaths: ['IS --ISZabbixMonitoringDomain--> ipRange'], dependencies: [], expectedResult: 'Таблица связанных IP-диапазонов.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: [] }], explanation: 'Semantic plan ready.', warnings: [] }
        })
      });
    });

    let releaseFlowResponse;
    const flowResponseGate = new Promise((resolve) => { releaseFlowResponse = resolve; });
    let flowRequestSeen;
    const flowRequestSeenPromise = new Promise((resolve) => { flowRequestSeen = resolve; });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/plan?*', async (route) => {
      flowRequestSeen();
      await flowResponseGate;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, action: 'assistant-object-flow-plan', flow, canApply: true, explanation: 'Flow ready.', warnings: [] })
      });
    });

    const semanticResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/object-flow/semantic-plan'));
    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    await semanticResponsePromise;
    await page.locator('button[data-action="assistant-flow-generate"]').click();
    await flowRequestSeenPromise;
    await page.locator('#assistant-flow-0-algorithm').evaluate((node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, `${prompt}\n`);
    const refreshResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates?limit=1000') && response.request().method() === 'GET');
    await page.locator('button[data-action="refresh"]').click();
    await refreshResponsePromise;
    await page.waitForFunction((value) => document.querySelector('#assistant-flow-0-algorithm')?.value === value, `${prompt}\n`, { timeout: 10_000 });

    releaseFlowResponse();
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-action="assistant-flow-apply"]');
      return Boolean(button && !button.disabled);
    }, null, { timeout: 10_000 });
    assert.match(await page.locator('#cmdp-assistant-editor').innerText(), /Flow ready\./);
    assert.match(await page.locator('#cmdp-assistant-object-flow').innerText(), /ISZabbixMonitoringDomain/);
    assert.doesNotMatch(await page.locator('.notice').first().innerText(), /предыдущей ревизии|older template revision/i);

    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/plan?*');
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
    await page.locator('a[data-designer-section="templates"]').click();
    const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
    await deleteButton.waitFor({ timeout: 10_000 });
    page.once('dialog', (dialog) => dialog.accept());
    const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
    await deleteButton.click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
  });
});

test('Assistant shows a read-only Object Flow draft and disables Apply', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    const flow = {
      version: 1,
      selections: [{
        id: 'selection:assets',
        name: 'Assets',
        alias: 'assets',
        className: 'ARM',
        from: '',
        limit: 100,
        columns: ['Code'],
        rules: []
      }],
      operations: [],
      blocks: [],
      setOperations: [],
      publishedAlias: 'assets'
    };
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantReadOnlyUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant read-only proposal UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, { name: 'Assets', entities: 'АРМ', algorithm: 'Выбрать все карточки АРМ.', expectedResult: 'Таблица АРМ.' });
    const entitiesExample = page.locator('[data-assistant-flow-entities-example]').first();
    assert.equal(await entitiesExample.count(), 1);
    assert.equal(await entitiesExample.evaluate((element) => element.open), false);
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, semanticPlan: { version: 1, blocks: [{ id: 'block-1', name: 'Assets', summary: 'АРМ', resolvedEntities: ['ARM'], relationPaths: [], dependencies: [], expectedResult: 'Таблица АРМ.', resultContract: { outputKind: 'sourceCards', outputClass: 'ARM', relationPredicates: [], attributePredicates: [{ sourceClass: 'ARM', comparisonBlockId: 'locations', comparisonClass: 'Location', sourceFields: ['Location'], comparisonField: 'Code', operator: 'equals' }] }, warnings: [] }], explanation: 'Semantic plan ready.', warnings: [] } }) });
    });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/plan?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, action: 'assistant-object-flow-plan', flow, canApply: false, explanation: 'Read-only flow ready.', warnings: [] })
      });
    });

    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    await page.waitForSelector('[data-assistant-flow-semantic-plan]', { timeout: 10_000 });
    const semanticPlanText = await page.locator('[data-assistant-flow-semantic-plan]').innerText();
    assert.match(semanticPlanText, /ARM/);
    assert.match(semanticPlanText, /Сравнение атрибутов|Attribute comparison/);
    assert.match(semanticPlanText, /ARM\.Location equals Location\.Code/);
    await page.locator('button[data-action="assistant-flow-generate"]').click();
    const applyButton = page.locator('button[data-action="assistant-flow-apply"]');
    await page.waitForFunction(() => Boolean(document.querySelector('#cmdp-assistant-object-flow')?.textContent?.includes('Read-only flow ready.')), null, { timeout: 10_000 });
    assert.equal(await applyButton.isDisabled(), true);
    assert.match(await page.locator('#cmdp-assistant-object-flow').innerText(), /Read-only flow ready\./);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/plan?*');
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Assistant renders a direct dependency path in the Semantic Plan', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantDependencyPathUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant dependency path UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, {
      name: 'Результат 1', entities: 'IP-диапазоны.', algorithm: 'Выбрать IP-диапазоны исходной ИС.', expectedResult: 'Список ipRange.'
    });
    await page.locator('button[data-action="assistant-flow-block-add"]').click();
    const secondBlock = page.locator('[data-assistant-flow-block]').last();
    await secondBlock.locator('#assistant-flow-1-name').fill('Результат 2');
    await secondBlock.locator('#assistant-flow-1-entities').fill('VLAN, связанные с первым результатом.');
    await secondBlock.locator('#assistant-flow-1-algorithm').fill('Выбрать VLAN, связанные с ipRange из первого результата.');
    await secondBlock.locator('#assistant-flow-1-expected-result').fill('Список VLAN.');
    await secondBlock.locator('[data-assistant-flow-field="uses"]').selectOption('block-1');
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          semanticPlan: {
            version: 1,
            blocks: [{
              id: 'block-1', name: 'Результат 1', summary: 'IP-диапазоны.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
              resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', dependencyPaths: [], relationPredicates: [], attributePredicates: [] }, warnings: []
            }, {
              id: 'block-2', name: 'Результат 2', summary: 'VLAN первого результата.', resolvedEntities: ['ipRange', 'vlan'], relationPaths: ['ipRange --Vlan2super [destination]--> vlan'], dependencies: ['block-1'], expectedResult: 'Список VLAN.',
              resultContract: {
                outputKind: 'sourceCards', outputClass: 'vlan',
                dependencyPaths: [{ comparisonBlockId: 'block-1', sourceClass: 'ipRange', domain: 'Vlan2super', direction: 'destination', targetClass: 'vlan' }],
                relationPredicates: [], attributePredicates: []
              }, warnings: []
            }],
            explanation: 'Semantic plan ready.', warnings: []
          }
        })
      });
    });

    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    const semanticPlan = page.locator('[data-assistant-flow-semantic-plan]');
    await semanticPlan.waitFor({ timeout: 10_000 });
    assert.equal(await semanticPlan.isVisible(), true);
    const box = await semanticPlan.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, JSON.stringify(box));
    const text = await semanticPlan.innerText();
    assert.match(text, /Прямой путь зависимости|Direct dependency path/);
    assert.match(text, /ipRange --Vlan2super \[destination\]--> vlan/);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Assistant renders a relation pair between two selected block results', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantRelationPairUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant relation-pair UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });

    await addAssistantBusinessBlock(page, {
      name: 'Applications', entities: 'Карточки класса Application.', algorithm: 'Выбрать Application.', expectedResult: 'Список Application.'
    });
    await page.locator('button[data-action="assistant-flow-block-add"]').click();
    await addAssistantBusinessBlock(page, {
      name: 'Результат 5', entities: 'Карточки класса phServer.', algorithm: 'Выбрать phServer.', expectedResult: 'Список phServer.'
    });
    await page.locator('button[data-action="assistant-flow-block-add"]').click();
    const pairBlock = await addAssistantBusinessBlock(page, {
      name: 'Applications phServers', entities: 'Связи Application и phServer.',
      algorithm: 'Связать Application из Applications с phServer из Результата 5 через domain phs.',
      expectedResult: 'Таблица связей Application и phServer.'
    });
    await pairBlock.locator('[data-assistant-flow-field="uses"]').selectOption(['block-1', 'block-2']);

    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          semanticPlan: {
            version: 1,
            blocks: [{
              id: 'block-1', name: 'Applications', summary: 'Приложения.', resolvedEntities: ['ApplicG'], relationPaths: [], dependencies: [], expectedResult: 'Список Application.',
              resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG' }, warnings: []
            }, {
              id: 'block-2', name: 'Результат 5', summary: 'Физические серверы.', resolvedEntities: ['phServer'], relationPaths: [], dependencies: [], expectedResult: 'Список phServer.',
              resultContract: { outputKind: 'sourceCards', outputClass: 'phServer' }, warnings: []
            }, {
              id: 'block-3', name: 'Applications phServers', summary: 'Связи выбранных приложений и серверов.', resolvedEntities: ['ApplicG', 'phServer'], relationPaths: ['phs'], dependencies: ['block-1', 'block-2'], expectedResult: 'Таблица связей Application и phServer.',
              resultContract: { outputKind: 'relationPairs', pair: { mode: 'domain', fromBlockId: 'block-1', fromClass: 'ApplicG', withBlockId: 'block-2', withClass: 'phServer', domain: 'phs', direction: 'source', rules: [] } }, warnings: []
            }],
            explanation: 'Подтвержденная связь выбранных результатов.', warnings: []
          }
        })
      });
    });

    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    const semanticPlan = page.locator('[data-assistant-flow-semantic-plan]');
    await semanticPlan.waitFor({ timeout: 10_000 });
    const text = await semanticPlan.innerText();
    assert.match(text, /пары по связи/i);
    assert.match(text, /ApplicG \(block-1\) --phs \[source\]--> phServer \(block-2\)/);
    assert.equal(await page.locator('button[data-action="assistant-flow-generate"]').isEnabled(), true);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Assistant explains a predicate erroneously added to an independent Semantic Plan block', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantSemanticDependencyUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant semantic dependency feedback UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, {
      name: 'Результат 1',
      entities: 'Информационная система и IP-диапазоны.',
      algorithm: 'Выбрать IP-диапазоны ИС.',
      expectedResult: 'Список IP-диапазонов ИС.'
    });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'assistant_semantic_plan_invalid',
          message: 'Semantic plan block Результат 1 has no selected dependencies and may not define relation predicates.',
          errors: [{
            kind: 'semanticPlanUnexpectedPredicateWithoutDependency',
            blockId: 'block-1',
            blockName: 'Результат 1',
            predicateType: 'relation',
            predicateIndex: 1,
            comparisonBlockId: 'block-2',
            sourceFields: ['range'],
            comparisonField: 'ipaddress'
          }],
          feedback: {
            summary: 'Семантический план не подготовлен: независимый «Результат 1» содержит переход по связи.',
            action: 'Сформируйте семантический план повторно. У независимого блока не должно быть сравнений с другим результатом или переходов к нему; связь с входным параметром или CMDBuild domain опишите как путь выбора внутри этого блока.',
            causes: [{ kind: 'semanticPlanUnexpectedPredicateWithoutDependency', message: 'Assistant добавил переход по связи с результатом «block-2» для полей range и ipaddress, хотя в «Использует результаты блоков» ничего не выбрано.' }],
            affectedStages: [{ label: 'Результат 1', alias: 'block-1' }],
            confirmedRelations: []
          }
        })
      });
    });

    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    const rejected = page.locator('[data-assistant-flow-rejected]');
    await rejected.waitFor({ timeout: 10_000 });
    assert.equal(await rejected.isVisible(), true);
    const box = await rejected.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, JSON.stringify(box));
    const text = await rejected.innerText();
    assert.match(text, /Семантический план отклонен|Semantic plan was rejected/);
    assert.match(text, /Результат 1/);
    assert.match(text, /независимый/);
    assert.match(text, /сравнений с другим результатом/);
    assert.doesNotMatch(text, /comparisonBlockId/);
    const technicalDetails = rejected.locator('details').first();
    assert.equal(await technicalDetails.evaluate((details) => details.open), false);
    await technicalDetails.locator('summary').click();
    assert.match(await technicalDetails.innerText(), /comparisonBlockId/);
    assert.equal(await page.locator('button[data-action="assistant-flow-generate"]').isDisabled(), true);
    assert.equal(await page.locator('button[data-action="assistant-flow-apply"]').isDisabled(), true);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Assistant retries a timed-out semantic plan from the saved MCP stage', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantSemanticRetryUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant semantic retry UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, {
      name: 'Результат 1',
      entities: 'Информационная система.',
      algorithm: 'Выбрать ИС по параметру isName.',
      expectedResult: 'Список ИС.'
    });

    const stages = [];
    let planAttempts = 0;
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      const body = route.request().postDataJSON();
      stages.push(body.stage);
      if (body.stage === 'context') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            checkpoint: { resumeId: body.resumeId, stage: 'mcpContextReady', mcpContextReused: false, checkpointTtlSec: 900, expiresAt: '2030-01-01T00:00:00.000Z' },
            diagnostics: { mcp: {} }
          })
        });
        return;
      }
      planAttempts += 1;
      if (planAttempts === 1) {
        await route.fulfill({
          status: 504,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            code: 'assistant_timeout',
            retryable: true,
            resume: { resumeId: body.resumeId, stage: 'mcpContextReady', mcpContextReused: true, checkpointTtlSec: 900, expiresAt: '2030-01-01T00:00:00.000Z' },
            message: 'LiteLLM request timed out.'
          })
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          semanticPlan: {
            version: 1,
            blocks: [{
              id: 'block-1', name: 'Результат 1', summary: 'ИС по параметру.', resolvedEntities: ['IS'], relationPaths: [], dependencies: [], expectedResult: 'Список ИС.',
              resultContract: { outputKind: 'sourceCards', outputClass: 'IS', dependencyPaths: [], relationPredicates: [], attributePredicates: [] }, warnings: []
            }],
            explanation: 'Семантический план готов.', warnings: []
          }
        })
      });
    });

    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    const retry = page.locator('button[data-action="assistant-flow-prepare-retry"]');
    await retry.waitFor({ timeout: 10_000 });
    assert.equal(await retry.isVisible(), true);
    assert.match(await page.locator('[data-assistant-flow-rejected]').innerText(), /Контекст CMDB сохранен|CMDB context was saved/);
    await retry.click();
    await page.locator('[data-assistant-flow-semantic-plan]').waitFor({ timeout: 10_000 });
    assert.deepEqual(stages, ['context', 'plan', 'plan']);
    assert.equal(planAttempts, 2);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Assistant retries a timed-out flow generation with the saved semantic checkpoint', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantFlowRetryUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant flow retry UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, {
      name: 'Результат 1', entities: 'Информационная система.', algorithm: 'Выбрать ИС по параметру isName.', expectedResult: 'Список ИС.'
    });

    let semanticRequests = 0;
    const flowResumeIds = [];
    let flowAttempts = 0;
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      semanticRequests += 1;
      const body = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          resume: { resumeId: body.resumeId, stage: 'completed', mcpContextReused: true, checkpointTtlSec: 900, expiresAt: '2030-01-01T00:00:00.000Z' },
          semanticPlan: {
            version: 1,
            blocks: [{
              id: 'block-1', name: 'Результат 1', summary: 'ИС по параметру.', resolvedEntities: ['IS'], relationPaths: [], dependencies: [], expectedResult: 'Список ИС.',
              resultContract: { outputKind: 'sourceCards', outputClass: 'IS', dependencyPaths: [], relationPredicates: [], attributePredicates: [] }, warnings: []
            }],
            explanation: 'Семантический план готов.', warnings: []
          }
        })
      });
    });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/plan?*', async (route) => {
      const body = route.request().postDataJSON();
      flowResumeIds.push(body.resumeId);
      flowAttempts += 1;
      if (flowAttempts === 1) {
        await route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body>504 Gateway Time-out</body></html>' });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          flow: {
            version: 1,
            selections: [{ id: 'selection:systems', name: 'Результат 1', alias: 'systems', className: 'IS', from: '', limit: 100, columns: ['Code', 'Description'], rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }] }],
            operations: [], publishedAlias: 'systems'
          },
          explanation: 'Поток готов.', warnings: [], canApply: true
        })
      });
    });

    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    await page.locator('[data-assistant-flow-semantic-plan]').waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-action="assistant-flow-generate"]');
      return Boolean(button && !button.disabled);
    }, null, { timeout: 10_000 });
    await page.locator('button[data-action="assistant-flow-generate"]').click();
    const retry = page.locator('button[data-action="assistant-flow-generate-retry"]');
    await retry.waitFor({ timeout: 10_000 });
    assert.equal(await retry.isVisible(), true);
    const rejected = page.locator('[data-assistant-flow-rejected]');
    assert.equal(await rejected.isVisible(), true);
    const box = await rejected.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, JSON.stringify(box));
    assert.match(await rejected.innerText(), /Reverse proxy|reverse proxy/);
    await retry.click();
    await page.waitForFunction(() => Boolean(document.querySelector('button[data-action="assistant-flow-apply"]:not([disabled])')), null, { timeout: 10_000 });
    assert.equal(semanticRequests, 1);
    assert.deepEqual(flowResumeIds, [flowResumeIds[0], flowResumeIds[0]]);
    assert.ok(flowResumeIds[0]);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/plan?*');
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Assistant renders rejected Object Flow diagnostics without enabling Apply', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    const rejectedFlow = {
      version: 1,
      selections: [{
        id: 'selection:informationSystems', name: 'Information systems', alias: 'informationSystems', className: 'IS', from: '', limit: 1, columns: ['Name'],
        rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
      }],
      operations: [{
        id: 'relation:ipRanges', type: 'relation', from: 'informationSystems', as: 'ipRanges', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true
      }, {
        id: 'relation:vlans', type: 'relation', from: 'ipRanges', as: 'vlans', domain: 'ipRangeVlanDomain', targetClass: 'vlan', direction: 'destination', columns: ['network'], limit: 100, distinct: true
      }],
      publishedAlias: 'vlans'
    };
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(`AssistantRejectedFlowUiSmoke${Date.now()}`);
    await page.locator('#cmdp-description').fill('Assistant rejected flow UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    await addAssistantBusinessBlock(page, { name: 'VLANs', entities: 'ИС, ipRange и VLAN', algorithm: 'Для ИС получить IP-диапазоны и VLAN.', expectedResult: 'Таблица VLAN.' });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, semanticPlan: { version: 1, blocks: [{ id: 'block-1', name: 'VLANs', summary: 'ИС -> ipRange -> VLAN', resolvedEntities: ['IS', 'ipRange', 'vlan'], relationPaths: [], dependencies: [], expectedResult: 'Таблица VLAN.', resultContract: { outputKind: 'sourceCards', outputClass: 'vlan', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: [] }], explanation: 'Semantic plan ready.', warnings: [] } }) });
    });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/plan?*', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'assistant_object_flow_invalid',
          message: 'Assistant response did not pass deterministic object-flow validation.',
          feedback: {
            summary: 'Assistant добавил неподтвержденный переход по связи ipRangeVlanDomain. Черновик не применен.',
            action: 'Уточните алгоритм блока или оставьте сравнение атрибутов условием без перехода по связи.',
            causes: [{ kind: 'unexpectedRelation', message: 'Неподтвержденный переход: ipRangeVlanDomain.' }],
            affectedStages: [{ label: 'VLANs', alias: 'vlans' }],
            confirmedRelations: ['IS --ISZabbixMonitoringDomain [source]--> ipRange']
          },
          rejectedFlow,
          errors: [{
            path: '$.flow.operations[1].domain',
            message: 'CMDBuild domain ipRangeVlanDomain is not present in the available MCP relation context.',
            candidates: [{ domain: 'Vlan2super', direction: 'destination', sourceClass: 'ipRange', targetClass: 'vlan', sourceEndpoint: ['ZabbixMonitoring', 'ipRange'], targetEndpoint: ['vlan'] }]
          }, {
            path: '$.operations[1].from',
            message: 'Operation from must reference an alias declared earlier in the flow.',
            availableAliases: [{ alias: 'informationSystems', classNames: ['IS'] }, { alias: 'ipRanges', classNames: ['ipRange'] }]
          }],
          diagnostics: {
            objectFlow: {
              aliases: [{ alias: 'informationSystems', classNames: ['IS'] }, { alias: 'ipRanges', classNames: ['ipRange'] }],
              relationRequirements: {
                kind: 'relationRequirements',
                chains: [{ operations: [
                  { sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
                  { sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }
                ] }]
              }
            }
          }
        })
      });
    });

    const prompt = page.locator('#assistant-flow-0-algorithm');
    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    await page.waitForSelector('[data-assistant-flow-semantic-plan]', { timeout: 10_000 });
    await page.locator('button[data-action="assistant-flow-generate"]').click();
    const rejected = page.locator('[data-assistant-flow-rejected]');
    await rejected.waitFor({ timeout: 10_000 });
    assert.equal(await rejected.isVisible(), true);
    const box = await rejected.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, JSON.stringify(box));
    const text = await rejected.innerText();
    assert.match(text, /неподтвержденный переход/i);
    assert.match(text, /Корневая причина|Root cause/);
    assert.match(text, /Затронутые этапы|Affected stages/);
    assert.match(text, /VLANs/);
    assert.match(text, /Что нужно исправить|What to fix/);
    const technicalDetails = rejected.locator('details').first();
    assert.equal(await technicalDetails.evaluate((details) => details.open), false);
    await technicalDetails.locator('summary').click();
    assert.match(await technicalDetails.innerText(), /ipRangeVlanDomain/);
    assert.match(await technicalDetails.innerText(), /declared earlier/);
    assert.equal(await page.locator('button[data-action="assistant-flow-apply"]').isDisabled(), true);

    await prompt.fill('Измененный промпт.');
    await page.waitForFunction(() => !document.querySelector('[data-assistant-flow-rejected]'), null, { timeout: 10_000 });
    assert.equal(await page.locator('button[data-action="assistant-flow-apply"]').isDisabled(), true);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/plan?*');
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
  });
});

test('Designer run page exposes contextual buttons after selecting a template', { skip: skipReason }, async (t) => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`#cmdp-designer-menu`, { timeout: 10_000 });
    await page.waitForSelector('#cmdp-template-list', { timeout: 10_000 });
    const visibleTemplates = page.locator('[data-action="select-template"][data-code]');
    if (await visibleTemplates.count() === 0) {
      t.skip('No saved templates are visible to the current CMDBuild user.');
      return;
    }
    await visibleTemplates.first().click();
    await page.locator('a[data-designer-section="run"]').click();
    await page.waitForSelector('.designer-actionbar', { timeout: 10_000 });

    assert.ok(await page.locator('button[data-action="visualize-editor"]').isVisible());
    assert.ok(await page.locator('button[data-action="force-refresh-editor"]').isVisible());
    assert.ok(await page.locator('button[data-action="visualize-external"]').isVisible());
    assert.ok(await page.locator('#cmdp-run-launch-url, .run-launch-url a').count() > 0);
  });
});

test('Designer exposes Save in Assistant and Templates for the selected template', { skip: skipReason }, async (t) => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    const visibleTemplates = page.locator('[data-action="select-template"][data-code]');
    const initialTemplatesSave = page.locator('.designer-actionbar button[data-action="save-template"]');
    await initialTemplatesSave.waitFor({ timeout: 10_000 });
    assert.equal(await initialTemplatesSave.isDisabled(), true);
    if (await visibleTemplates.count() === 0) {
      t.skip('No saved templates are visible to the current CMDBuild user.');
      return;
    }

    await visibleTemplates.first().click();
    const templatesSave = page.locator('.designer-actionbar button[data-action="save-template"]');
    await templatesSave.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('.designer-actionbar button[data-action="save-template"]');
      return Boolean(button && !button.disabled);
    }, null, { timeout: 10_000 });
    assert.equal(await templatesSave.isVisible(), true);
    assert.equal(await templatesSave.isDisabled(), false);
    const templatesSaveBox = await templatesSave.boundingBox();
    assert.ok(templatesSaveBox && templatesSaveBox.width > 0 && templatesSaveBox.height > 0, JSON.stringify(templatesSaveBox));

    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    const assistantSave = page.locator('.designer-actionbar button[data-action="save-template"]');
    assert.equal(await assistantSave.isVisible(), true);
    assert.equal(await assistantSave.isDisabled(), false);
    const assistantSaveBox = await assistantSave.boundingBox();
    assert.ok(assistantSaveBox && assistantSaveBox.width > 0 && assistantSaveBox.height > 0, JSON.stringify(assistantSaveBox));
  });
});

test('Designer cache launch URLs do not collapse into one-character columns', { skip: skipReason }, async (t) => {
  if (!await templateCodeExists(cookieHeader, runtimeCacheLayoutTemplate)) {
    t.skip(`Template ${runtimeCacheLayoutTemplate} is not visible to the current CMDBuild user.`);
    return;
  }

  await withPage(async (page) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    const selector = `[data-action="select-template"][data-code="${cssEscape(runtimeCacheLayoutTemplate)}"]`;
    if (await page.locator(selector).count() === 0) {
      const diagnostic = await page.evaluate(async () => {
        const response = await fetch('/cmdbuild/custom-api/templates?limit=1000', { credentials: 'same-origin' });
        const json = await response.json().catch(() => ({}));
        return {
          url: location.href,
          status: response.status,
          apiCodes: Array.isArray(json.data) ? json.data.map((item) => item.code || item.Code || '') : [],
          listText: document.querySelector('#cmdp-template-list')?.textContent || ''
        };
      });
      assert.fail(`Template row is absent after Designer load: ${JSON.stringify(diagnostic)}`);
    }
    await page.locator(selector).first().click();
    await page.locator('a[data-designer-section="cache"]').click();
    await page.waitForSelector('#cmdp-cache-editor', { timeout: 10_000 });
    await page.waitForSelector('#cmdp-run-launch-url', { timeout: 10_000 });

    const launchUrl = await launchUrlLayoutMetrics(page, '#cmdp-run-launch-url');
    const jsonUrl = await launchUrlLayoutMetrics(page, '#cmdp-run-launch-json-url');
    assert.match(launchUrl.text, new RegExp(`/run/${runtimeCacheLayoutTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(launchUrl.width >= 180, `Launch URL is too narrow and may wrap per character: ${JSON.stringify(launchUrl)}`);
    assert.ok(launchUrl.height <= 80, `Launch URL is too tall and may wrap per character: ${JSON.stringify(launchUrl)}`);
    assert.notEqual(launchUrl.overflowWrap, 'anywhere', `Launch URL uses overflow-wrap:anywhere: ${JSON.stringify(launchUrl)}`);
    assert.ok(jsonUrl.width >= 180, `JSON URL is too narrow and may wrap per character: ${JSON.stringify(jsonUrl)}`);
    assert.ok(jsonUrl.height <= 80, `JSON URL is too tall and may wrap per character: ${JSON.stringify(jsonUrl)}`);
    assert.notEqual(jsonUrl.overflowWrap, 'anywhere', `JSON URL uses overflow-wrap:anywhere: ${JSON.stringify(jsonUrl)}`);
  });
});

test('Relations Apply keeps 3-stage dependency order and custom match columns', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('ThreeStageRelationsUiSmoke');
    await page.locator('#cmdp-description').fill('Three stage Relations UI smoke');
    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });

    for (let index = 0; index < 3; index += 1) {
      if (index > 0) await page.locator('button[data-action="add-object-selection"]').click();
      const selection = page.locator('[data-object-selection]').first();
      if (await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').count() === 0) {
        await page.locator('#cmdp-catalog-header').click();
        await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
      }
      await selection.locator('[data-object-selection-field="className"]').selectOption('ARM');
    }
    await page.locator('button[data-action="apply-object-group"]').click();
    await page.locator('a[data-designer-section="relations"]').click();
    await page.waitForSelector('#cmdp-relation-expansion-editor', { timeout: 10_000 });
    assert.equal(await page.locator('[data-matching-block]').count(), 0);
    await page.locator('button[data-action="add-matching-block"]').click();
    let matchingBlock = page.locator('[data-matching-block]').first();
    assert.deepEqual(await matchingBlock.locator('[data-matching-block-field="from"] option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean)), ['objects', 'objects2', 'objects3']);
    const firstBlockHandle = await matchingBlock.elementHandle();
    await matchingBlock.locator('[data-matching-block-field="from"]').selectOption('objects');
    await matchingBlock.locator('[data-matching-block-field="with"]').selectOption('objects2');
    assert.equal(await firstBlockHandle.evaluate((node) => node.isConnected), true, 'Changing a relation source must update only its rules, without replacing the editor.');
    await matchingBlock.locator('[data-matching-block-field="as"]').fill('matchedObjects');
    await matchingBlock.locator('button[data-action="add-matching-rule-row"]').click();
    const relationPicker = matchingBlock.locator('[data-catalog-field-picker]').first();
    await relationPicker.locator('button[data-action="catalog-field-picker-toggle"]').click();
    await relationPicker.locator('[data-catalog-field-picker-search]').fill('model');
    assert.ok(await relationPicker.locator('button[data-action="catalog-field-picker-select"]').count() <= 60, 'Relation field picker must bound rendered suggestions.');
    const relationPickerLayout = await relationPicker.evaluate((picker) => {
      const menu = picker.querySelector('[data-catalog-field-picker-menu]');
      const rect = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);
      return {
        position: style.position,
        width: rect.width,
        maxHeight: Number.parseFloat(style.maxHeight),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
    });
    assert.equal(relationPickerLayout.position, 'fixed', JSON.stringify(relationPickerLayout));
    assert.ok(relationPickerLayout.width >= 500, JSON.stringify(relationPickerLayout));
    assert.ok(relationPickerLayout.maxHeight > 260, JSON.stringify(relationPickerLayout));
    assert.ok(relationPickerLayout.left >= 0 && relationPickerLayout.right <= relationPickerLayout.viewportWidth, JSON.stringify(relationPickerLayout));
    assert.ok(relationPickerLayout.top >= 0 && relationPickerLayout.bottom <= relationPickerLayout.viewportHeight, JSON.stringify(relationPickerLayout));
    await page.locator('button[data-action="add-matching-block"]').click();
    matchingBlock = page.locator('[data-matching-block]').first();
    assert.deepEqual(await matchingBlock.locator('[data-matching-block-field="from"] option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean)), ['objects', 'objects2', 'objects3', 'matchedObjects']);
    await matchingBlock.locator('[data-matching-block-field="from"]').selectOption('matchedObjects');
    await matchingBlock.locator('[data-matching-block-field="with"]').selectOption('objects3');
    await matchingBlock.locator('[data-matching-block-field="as"]').fill('matchedObjects3');
    await page.locator('button[data-action="add-set-operation"]').click();
    const setOperation = page.locator('[data-set-operation]').first();
    assert.deepEqual(await setOperation.locator('[data-set-operation-field="from"] option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean)), ['objects', 'objects2', 'objects3', 'matchedObjects', 'matchedObjects3']);
    await setOperation.locator('[data-set-operation-field="type"]').selectOption('union');
    await setOperation.locator('[data-set-operation-field="from"]').selectOption('objects');
    await setOperation.locator('[data-set-operation-field="with"]').selectOption('objects2');
    await setOperation.locator('[data-set-operation-field="as"]').fill('allArms');
    assert.equal(await page.locator('[data-result-set-field="publishedAlias"]').count(), 0);
    await page.locator('button[data-action="apply-relation-expansion"]').click();

    await page.locator('a[data-designer-section="extraction"]').click();
    await page.waitForSelector('#cmdp-extraction-editor', { timeout: 10_000 });
    await page.locator('#cmdp-extraction-source').selectOption('allArms');
    await page.locator('button[data-action="apply-extraction-published"]').click();

    await page.locator('a[data-designer-section="assistant"]').click();
    await page.route('**/cmdbuild/custom-api/draft/preview?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, result: { tables: [] } })
      });
    });
    const previewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview'));
    const previewResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/cmdbuild/custom-api/draft/preview'),
      { timeout: 60_000 }
    );
    await page.locator('button[data-action="draft-preview"]').click();
    let previewRequest;
    let previewResponse;
    try {
      [previewRequest, previewResponse] = await Promise.all([previewRequestPromise, previewResponsePromise]);
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        notices: Array.from(document.querySelectorAll('.notice,[role="alert"]')).map((node) => node.textContent),
        previewButton: document.querySelector('button[data-action="draft-preview"]')?.outerHTML || ''
      }));
      throw new Error(`Draft preview did not start: ${JSON.stringify(diagnostic)} cause=${error.message || String(error)}`);
    }
    const payload = previewRequest.postDataJSON();
    const spec = payload?.template?.spec || {};
    assert.deepEqual(spec.steps?.map((step) => step.as), ['objects', 'objects2', 'objects3', 'matchedObjects', 'matchedObjects3', 'allArms']);
    assert.equal(spec.steps?.some((step) => Object.hasOwn(step, 'includeSource')), false);
    assert.equal(spec.steps?.some((step) => Object.hasOwn(step, 'deduplicateCards')), false);
    assert.equal(spec.steps?.find((step) => step.as === 'matchedObjects3')?.from, 'matchedObjects');
    assert.equal(spec.steps?.find((step) => step.as === 'matchedObjects3')?.with, 'objects3');
    const finalTable = spec.result?.tables?.find((table) => table.name === 'matchedObjects3');
    assert.equal(finalTable?.columns?.includes('model'), true, JSON.stringify(finalTable));
    assert.ok(finalTable?.columns?.some((column) => String(column).endsWith('model2')), JSON.stringify(finalTable));
    assert.ok(finalTable?.columns?.some((column) => String(column).endsWith('Location')), JSON.stringify(finalTable));
    const previewStatus = previewResponse.status();
    assert.equal(previewStatus, 200, previewStatus === 200 ? '' : await previewResponse.text());

    await page.locator('a[data-designer-section="relations"]').click();
    await page.locator('[data-flow-operation-summary] button[data-action="relation-operation-expand"]').first().click();
    await page.locator('[data-matching-block]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('button[data-action="clear-matching-block"]').first().click();
    assert.equal(await page.locator('[data-matching-block]').count(), 1);
    assert.equal(await page.locator('[data-flow-operation-summary]').count(), 2);
    await page.locator('[role="alert"]').waitFor({ timeout: 10_000 });
    assert.match(await page.locator('[role="alert"]').innerText(), /Cannot remove Matching block 1/);

    await page.locator('[data-flow-operation-summary] button[data-action="relation-operation-expand"]').last().click();
    await page.locator('[data-set-operation]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-set-operation-field="from"]').selectOption('');
    await page.locator('button[data-action="apply-relation-expansion"]').click();
    await page.locator('[role="alert"]').waitFor({ timeout: 10_000 });
    assert.match(await page.locator('[role="alert"]').innerText(), /requires both source aliases/);
    await page.unroute('**/cmdbuild/custom-api/draft/preview?*');
  });
});

test('Object Group keeps path suggestion filters conditional and out of the Spec', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('ObjectGroupPathHintUiSmoke');
    await page.locator('#cmdp-description').fill('Object group path hint UI smoke');
    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });

    const selection = page.locator('[data-object-selection]').first();
    const classField = selection.locator('[data-object-selection-field="className"]');
    if (await classField.locator('option[value="ARM"]').count() === 0) {
      await page.locator('#cmdp-catalog-header').click();
      await classField.locator('option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
    }
    await classField.selectOption('ARM');

    const provenance = await selection.locator('[data-object-scope-field="path"]').first().evaluate((field) => {
      const values = Array.from(field.options)
        .map((option) => [option.dataset.domain || '', option.dataset.cardinality || '', option.dataset.direction || ''])
        .filter((parts) => parts.some(Boolean));
      return new Set(values.map((parts) => parts.join('\u0000'))).size;
    });
    const filters = selection.locator('details[data-object-path-filter]');
    assert.equal(await filters.count(), provenance > 1 ? 1 : 0);
    if (provenance > 1) {
      assert.equal(await filters.evaluate((node) => node.open), false);
      await filters.locator('summary').click();
      assert.match(await filters.innerText(), /Сужают только подсказки в поле «Атрибут\/путь класса»/);
      assert.match(await filters.innerText(), /Домен:|Кардинальность:|Направление:/);
    }

    await page.locator('button[data-action="apply-object-group"]').click();
    await page.locator('a[data-designer-section="assistant"]').click();
    const previewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview'));
    const previewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview'));
    await page.locator('button[data-action="draft-preview"]').click();
    const previewRequest = await previewRequestPromise;
    const spec = previewRequest.postDataJSON()?.template?.spec || {};
    for (const step of spec.steps || []) {
      assert.equal(Object.hasOwn(step, 'domainFilter'), false);
      assert.equal(Object.hasOwn(step, 'cardinalityFilter'), false);
      assert.equal(Object.hasOwn(step, 'directionFilter'), false);
    }
    const previewResponse = await previewResponsePromise;
    assert.equal(previewResponse.status(), 200, await previewResponse.text());
  });
});

test('Designer renders D2 import preview before structure interpretation', { skip: skipReason, timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('D2ImportPreviewUiSmoke');
    await page.locator('#cmdp-description').fill('D2 import preview UI smoke');
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    const importPreview = page.locator('[data-diagram-import-preview]');
    assert.equal(await importPreview.count(), 1);
    assert.equal(await importPreview.getAttribute('data-diagram-import-preview-state'), 'empty');
    assert.equal(await importPreview.isVisible(), true);
    assert.ok((await importPreview.boundingBox())?.height >= 240, 'Empty D2 preview area is not visibly reserved.');
    await page.locator('#cmdp-diagram-import-source').fill([
      'direction: right',
      'classes: {',
      '  network_device: {',
      '    Notes: |md',
      '      CMDB network endpoint used for topology mapping.',
      '    |',
      '  }',
      '}',
      'router: Router { class: network_device }',
      'switch: Switch { class: network_device }',
      'gateway: Gateway { class: network_device }',
      'database: Database { class: network_device }',
      'service: Service { class: network_device }',
      'router -> switch: uplink',
      'switch -> gateway',
      'gateway -> database',
      'database -> service'
    ].join('\n'));

    const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const analyzeResponse = await analyzeResponsePromise;
    const analyzeBody = await analyzeResponse.json();
    assert.equal(analyzeResponse.status(), 200, `D2 preview analysis failed: ${JSON.stringify(analyzeBody)}`);
    assert.equal(analyzeBody.preview?.rendered, true, `D2 preview was not rendered: ${JSON.stringify(analyzeBody.preview)}`);
    await page.waitForFunction(() => document.querySelector('[data-diagram-import-preview]')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.diagram-import-shell').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('button[data-action="diagram-import-analyze"]').isEnabled(), true);
    assert.deepEqual(pageErrors, []);

    assert.equal(await importPreview.getAttribute('data-diagram-import-preview-state'), 'rendered');
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').count(), 1);
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').isVisible(), true);
    assert.ok((await importPreview.locator('[data-d2-rendered-svg]').boundingBox())?.height >= 220, 'Rendered D2 SVG has no visible height.');
    const notesRoles = page.locator('[data-diagram-notes-role]');
    assert.equal(await notesRoles.count(), 1);
    assert.match(await notesRoles.first().innerText(), /network_device/);
    assert.match(await notesRoles.locator('textarea[readonly]').inputValue(), /CMDB network endpoint used for topology mapping/);
    const routerElement = importPreview.locator('[data-cmdp-d2-key="router"]').first();
    assert.equal(await routerElement.count(), 1, 'Rendered D2 router element is not selectable.');
    await routerElement.click();
    const notesRoleState = await notesRoles.first().evaluate((element) => ({
      selected: element.classList.contains('selected'),
      roleId: element.getAttribute('data-diagram-notes-role'),
      text: element.innerText
    }));
    assert.equal(notesRoleState.selected, true, 'Selecting D2 element must select its Notes role: ' + JSON.stringify({
      selectedKey: await routerElement.getAttribute('data-cmdp-d2-key'),
      notesRoleState,
      roles: (analyzeBody.proposal?.roles || []).map((role) => ({ id: role.id, key: role.key, elementKeys: role.elementKeys })),
      pageErrors
    }));
    const viewport = importPreview.locator('[data-diagram-viewport]');
    const viewportCanvas = viewport.locator('[data-diagram-viewport-canvas]');
    assert.equal(await viewport.count(), 1);
    assert.equal(await viewport.locator('button[data-action="diagram-zoom-out"]').count(), 1);
    assert.equal(await viewport.locator('button[data-action="diagram-zoom-reset"]').count(), 1);
    assert.equal(await viewport.locator('button[data-action="diagram-zoom-in"]').count(), 1);
    await viewport.locator('button[data-action="diagram-zoom-in"]').click();
    assert.equal(await viewport.locator('[data-diagram-viewport-scale-label]').innerText(), '125%');
    for (let index = 0; index < 7; index += 1) await viewport.locator('button[data-action="diagram-zoom-in"]').click();
    assert.equal(await viewport.locator('[data-diagram-viewport-scale-label]').innerText(), '300%');
    assert.equal(await viewportCanvas.evaluate((canvas) => canvas.scrollWidth > canvas.clientWidth || canvas.scrollHeight > canvas.clientHeight), true);
    await viewportCanvas.scrollIntoViewIfNeeded();
    const canvasBox = await viewportCanvas.boundingBox();
    assert.ok(canvasBox);
    const beforePan = await viewportCanvas.evaluate((canvas) => ({
      scrollLeft: canvas.scrollLeft,
      scrollTop: canvas.scrollTop,
      scrollWidth: canvas.scrollWidth,
      scrollHeight: canvas.scrollHeight,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight
    }));
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.7, canvasBox.y + canvasBox.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.25, canvasBox.y + canvasBox.height * 0.25);
    await page.mouse.up();
    const afterPan = await viewportCanvas.evaluate((canvas) => ({ scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop }));
    assert.equal(afterPan.scrollLeft > beforePan.scrollLeft || afterPan.scrollTop > beforePan.scrollTop, true, 'Expected drag to pan viewport: ' + JSON.stringify({ beforePan, afterPan }));
    await viewport.locator('button[data-action="diagram-zoom-reset"]').click();
    assert.equal(await viewport.locator('[data-diagram-viewport-scale-label]').innerText(), '100%');
    const previewBeforeInterpretation = await page.locator('#cmdp-diagram-assistant-editor').evaluate((root) => {
      const preview = root.querySelector('[data-diagram-import-preview]');
      const interpretation = root.querySelector('.assistant-d2-prompt');
      return Boolean(preview && interpretation && (preview.compareDocumentPosition(interpretation) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(previewBeforeInterpretation, true, 'D2 preview must be rendered before D2 structure interpretation.');

    await page.locator('#cmdp-diagram-import-source').fill('router: Router\nswitch: Switch\nrouter -> switch: changed uplink');
    assert.equal(await page.locator('[data-diagram-import-stale]:visible').count(), 1);
    assert.equal(await importPreview.getAttribute('data-diagram-import-preview-state'), 'empty');
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').count(), 0);
    assert.match(await importPreview.locator('[data-diagram-import-preview-status]').innerText(), /Analyze D2 source|анализ D2 source/i);
    assert.deepEqual(pageErrors, []);
  });
});

test('Diagram Assistant applies valid D2 mappings partially and previews only confirmed data', { skip: skipReason, timeout: 120_000 }, async () => {
  await withPage(async (page) => {
    const code = `D2PartialApplyUiSmoke${Date.now()}`;
    const source = [
      'classes: {',
      '  workstation: { shape: person }',
      '  service: { shape: rectangle }',
      '}',
      'users: "Users" {',
      '  operator: "Operator workstation" { class: workstation }',
      '}',
      'services: "Services" {',
      '  api: "Unmapped service" { class: service }',
      '}',
      'users.operator -> services.api: "Unmapped connection"'
    ].join('\n');
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('#cmdp-language').selectOption('ru');
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 partial mapping UI smoke');
    const createResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST'
    );
    await page.locator('button[data-action="save-template"]').click();
    assert.equal((await createResponsePromise).status(), 201);

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="object-group"]').click();
      await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
      const selection = page.locator('[data-object-selection]').first();
      if (await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').count() === 0) {
        await page.locator('#cmdp-catalog-header').click();
        await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
      }
      await selection.locator('[data-object-selection-field="name"]').fill('Workstations');
      await selection.locator('[data-object-selection-field="alias"]').fill('workstations');
      await selection.locator('[data-object-selection-field="className"]').selectOption('ARM');
      await page.locator('button[data-action="apply-object-group"]').click();
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('#cmdp-diagram-import-source').fill(source);
      const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      assert.equal((await analyzeResponsePromise).status(), 200);

      await page.route('**/cmdbuild/custom-api/assistant/diagram-import/interpret**', async (route) => {
        const body = route.request().postDataJSON();
        const roles = Array.isArray(body?.proposal?.roles) ? body.proposal.roles : [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            decisions: roles.map((role) => ({
              roleId: role.id,
              visualKind: ['users', 'services'].includes(role.key) ? 'container' : 'node',
              reason: 'Partial mapping browser smoke.'
            })),
            explanation: 'Assistant proposal prepared.'
          })
        });
      });
      await page.route('**/cmdbuild/custom-api/assistant/diagram-import/map-selections**', async (route) => {
        const body = route.request().postDataJSON();
        if (body?.stage === 'roles') {
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              checkpoint: { resumeId: body.resumeId, stage: 'roles', nextStage: 'topology', rolesReused: false },
              mapping: { status: 'partial', mappedRoles: 0, requiredRoles: 0, mappedConnections: 0, requiredConnections: 0 }
            })
          });
          return;
        }
        const rolesById = new Map((Array.isArray(body?.roles) ? body.roles : []).map((role) => [String(role.id || ''), role]));
        const mappings = (body?.structureTree?.items || []).flatMap((item) => {
          const role = rolesById.get(String(item?.roleId || '')) || {};
          if (role.visualKind === 'container') {
            return [{ structureItemId: item.id, roleId: item.roleId, source: {}, mapping: { materialization: { kind: 'structural', stageId: '' } } }];
          }
          return [{ structureItemId: item.id, roleId: item.roleId, source: { stageId: 'selection:workstations' }, mapping: { materialization: { kind: 'stage', stageId: 'selection:workstations' } } }];
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            mappings,
            relationRules: [],
            connectionUnresolved: [],
            explanation: 'Partial mapping proposal prepared.',
            mapping: { status: 'partial', mappedRoles: mappings.length, requiredRoles: (body?.structureTree?.items || []).length, mappedConnections: 0, requiredConnections: 0 }
          })
        });
      });

      await page.locator('#cmdp-assistant-diagram-interpret-prompt').fill('users и services - контейнеры; workstation и service - объекты.');
      await page.locator('button[data-action="assistant-diagram-interpret"]').click();
      await page.locator('.notice').filter({ hasText: 'Assistant proposal prepared.' }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('#cmdp-assistant-diagram-mapping-prompt').fill('Сопоставь объекты с Workstations. Связь оставь незаполненной.');
      const mappingResponsePromise = page.waitForResponse((response) => (
        response.url().includes('/assistant/diagram-import/map-selections') && response.status() === 200
      ));
      await page.locator('button[data-action="assistant-diagram-map"]').click();
      const mappingResponse = await mappingResponsePromise;
      assert.equal(mappingResponse.status(), 200, await mappingResponse.text());

      const applyButton = page.locator('button[data-action="diagram-import-apply"]');
      try {
        await applyButton.waitFor({ state: 'visible', timeout: 10_000 });
      } catch (error) {
        throw new Error(`Partial D2 proposal did not expose Apply. ${await page.locator('#cmdp-diagram-assistant-editor').innerText()} Browser errors: ${pageErrors.join(' | ') || '(none)'}`);
      }
      if (!await applyButton.isEnabled()) {
        throw new Error(`Partial D2 proposal Apply is disabled. ${await page.locator('#cmdp-diagram-assistant-editor').innerText()} Browser errors: ${pageErrors.join(' | ') || '(none)'}`);
      }
      assert.equal((await applyButton.innerText()).trim(), 'Применить доступные сопоставления');
      const applyResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/apply'));
      const previewResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/preview?') && response.request().method() === 'POST');
      await applyButton.click();
      const applyResponse = await applyResponsePromise;
      const applyBody = await applyResponse.json();
      assert.equal(applyResponse.status(), 200, JSON.stringify(applyBody));
      assert.equal(applyBody.status, 'partial');
      assert.equal(applyBody.partial, true);
      assert.equal(applyBody.d2Workflow.state, 'pending');
      const previewResponse = await previewResponsePromise;
      const previewBody = await previewResponse.json();
      assert.equal(previewResponse.status(), 200, JSON.stringify(previewBody));
      assert.equal(previewBody.result.diagramPreview.partial, true);
      assert.ok(previewBody.result.diagrams[0].nodes.some((node) => node.importRole?.key === 'workstation'));
      assert.equal(previewBody.result.diagrams[0].edges.length, 0);
      assert.ok(previewBody.result.diagramPreview.omissions.some((item) => item.kind === 'connection'));
      const preview = page.locator('[data-diagram-import-runtime-preview]');
      await preview.locator('[data-d2-rendered-svg]').waitFor({ state: 'visible', timeout: 30_000 });
      assert.match(await preview.innerText(), /только независимо проверенные|неподтвержденные mapping исключены/i);
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.unroute('**/cmdbuild/custom-api/assistant/diagram-import/interpret**');
      await page.unroute('**/cmdbuild/custom-api/assistant/diagram-import/map-selections**');
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        assert.equal((await deleteResponsePromise).status(), 200);
      }
    }
  });
});

test('Designer preserves D2 Markdown and container class styles in the import preview', { skip: skipReason, timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('D2MarkdownStyleUiSmoke');
    await page.locator('#cmdp-description').fill('D2 Markdown and class style UI smoke');
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    await page.locator('#cmdp-diagram-import-source').fill([
      'classes: {',
      '  group_external: {',
      '    style.stroke: "#f503EB"',
      '    style.stroke-width: 2',
      '    style.stroke-dash: 7',
      '    style.fill: "#9FF6FF"',
      '    style.border-radius: 10',
      '  }',
      '  external_system: {',
      '    style.stroke: "#1D4ED8"',
      '    style.stroke-width: 2',
      '    style.stroke-dash: 7',
      '    style.fill: "#EFF6FF"',
      '    style.border-radius: 8',
      '  }',
      '}',
      '',
      'external_systems: "Внешние системы" {',
      '  class: group_external',
      '  lps: |md',
      '    **ИС LPS**',
      '    ipRange: `192.168.5.0/24`',
      '  | { class: external_system }',
      '  lpd: |md',
      '    **ИС LPD**',
      '    ipRange: `6.0/24`',
      '  | { class: external_system }',
      '}'
    ].join('\n'));

    const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const analyzeResponse = await analyzeResponsePromise;
    assert.equal(analyzeResponse.status(), 200, await analyzeResponse.text());

    const svg = page.locator('[data-diagram-import-preview] [data-d2-rendered-svg]');
    assert.equal(await svg.isVisible(), true);
    assert.ok((await svg.boundingBox())?.height >= 100, 'D2 Markdown preview is not visibly rendered.');
    assert.equal(await svg.locator('foreignObject').count(), 2);
    assert.match(await svg.innerText(), /ИС LPS/);
    assert.match(await svg.innerText(), /192\.168\.5\.0\/24/);
    const container = svg.locator('g.group_external rect').first();
    assert.equal(await container.getAttribute('fill'), '#9FF6FF');
    assert.equal(await container.getAttribute('stroke'), '#f503EB');
    const markdownFrames = svg.locator('[data-cmdp-d2-markdown-frame="true"]');
    assert.equal(await markdownFrames.count(), 2);
    assert.equal(await markdownFrames.first().getAttribute('fill'), '#EFF6FF');
    assert.equal(await markdownFrames.first().getAttribute('stroke'), '#1D4ED8');
    assert.equal(await markdownFrames.first().getAttribute('stroke-dasharray'), '14,14');
    const firstFrameBox = await markdownFrames.first().boundingBox();
    assert.ok(firstFrameBox && firstFrameBox.width > 0 && firstFrameBox.height > 0, JSON.stringify(firstFrameBox));
  });
});

test('Diagram Assistant continues a staged D2 mapping through bounded correction retries', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `D2MappingResumeUiSmoke${Date.now()}`;
    const mappingCalls = [];
    const pageErrors = [];
    let rolesAttempts = 0;
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${nginxOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 mapping resume UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    assert.equal((await createResponsePromise).status(), 201);
    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
    const selection = page.locator('[data-object-selection]').first();
    if (await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').count() === 0) {
      await page.locator('#cmdp-catalog-header').click();
      await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
    }
    await selection.locator('[data-object-selection-field="name"]').fill('Workstations');
    await selection.locator('[data-object-selection-field="alias"]').fill('workstations');
    await selection.locator('[data-object-selection-field="className"]').selectOption('ARM');
    await page.locator('button[data-action="apply-object-group"]').click();
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    await page.locator('#cmdp-diagram-import-source').fill('workstation: Workstation');
    const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    assert.equal((await analyzeResponsePromise).status(), 200);
    await page.locator('#cmdp-assistant-diagram-mapping-prompt').fill('Сопоставь каждый объект с доступной выборкой.');

    await page.route('**/cmdbuild/custom-api/assistant/diagram-import/map-selections?*', async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      mappingCalls.push({ stage: body.stage, resumeId: body.resumeId });
      if (body.stage === 'roles') {
        rolesAttempts += 1;
        if (rolesAttempts === 1) {
          await route.fulfill({
            status: 504,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              code: 'assistant_timeout',
              retryable: true,
              retryKind: 'transient',
              resume: { resumeId: body.resumeId, stage: 'roles', nextStage: 'roles', rolesReused: false },
              message: 'D2 object mapping timed out.'
            })
          });
          return;
        }
        if (rolesAttempts === 2 || rolesAttempts === 3) {
          await route.fulfill({
            status: 422,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              code: 'assistant_diagram_stage_retry',
              retryable: true,
              retryKind: 'correction',
              resume: { resumeId: body.resumeId, stage: 'roles', nextStage: 'roles', rolesReused: false },
              message: 'D2 mapping needs deterministic correction.'
            })
          });
          return;
        }
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            action: 'assistant-diagram-import-map-selections-roles',
            checkpoint: { resumeId: body.resumeId, stage: 'roles', nextStage: 'topology', rolesReused: false },
            mapping: { status: 'partial', mappedRoles: 0, requiredRoles: 0, mappedConnections: 0, requiredConnections: 1 },
            diagnostics: { phases: { roles: 'accepted', topology: 'pending' } }
          })
        });
        return;
      }
      const structureItems = Array.isArray(body.structureTree?.items) ? body.structureTree.items : [];
      const rolesById = new Map((Array.isArray(body.roles) ? body.roles : []).map((role) => [String(role.id || ''), role]));
      const mappings = structureItems.map((item) => {
        const role = rolesById.get(String(item.roleId || '')) || {};
        const materialization = role.visualKind === 'container'
          ? { kind: 'structural', stageId: '' }
          : { kind: 'stage', stageId: 'selection:workstations' };
        return {
          structureItemId: item.id,
          roleId: item.roleId,
          source: materialization.kind === 'stage' ? { stageId: 'selection:workstations' } : {},
          mapping: { materialization }
        };
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          action: 'assistant-diagram-import-map-selections',
          mappings,
          relationRules: [],
          connectionUnresolved: [],
          mapping: { status: 'complete', mappedRoles: mappings.length, requiredRoles: mappings.length, mappedConnections: 0, requiredConnections: 0 },
          diagnostics: { phases: { roles: 'accepted', topology: 'accepted' } }
        })
      });
    });
    try {
      const completedResponsePromise = page.waitForResponse((response) =>
        response.url().includes('/assistant/diagram-import/map-selections') && response.status() === 200
      );
      await page.locator('button[data-action="assistant-diagram-map"]').click();
      const completed = await completedResponsePromise;
      assert.equal((await completed.json()).mapping.status, 'complete');
      assert.deepEqual(mappingCalls.map((call) => call.stage), ['roles', 'roles', 'roles', 'roles', 'topology']);
      assert.equal(mappingCalls[0].resumeId, mappingCalls[1].resumeId);
      assert.equal(mappingCalls[1].resumeId, mappingCalls[2].resumeId);
      assert.equal(mappingCalls[2].resumeId, mappingCalls[3].resumeId);
      assert.equal(mappingCalls[3].resumeId, mappingCalls[4].resumeId);
      await page.waitForFunction(() => !document.querySelector('button[data-action="assistant-diagram-map"]')?.disabled, null, { timeout: 10_000 });
      assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    } finally {
      await page.unroute('**/cmdbuild/custom-api/assistant/diagram-import/map-selections?*');
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
        await deleteButton.click();
        assert.equal((await deleteResponsePromise).status(), 200);
      }
    }
  });
});

test('Designer restores saved D2 analysis after selecting a template from the list', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `D2AnalysisSelectionRestoreUiSmoke${Date.now()}`;
    const source = [
      'classes: { server: { shape: rectangle } }',
      'systems: "Systems" {',
      '  server_1: "Server 1" { class: server }',
      '}'
    ].join('\n');
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 analysis selection restore UI smoke');
    const createResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST'
    );
    await page.locator('button[data-action="save-template"]').click();
    assert.equal((await createResponsePromise).status(), 201);

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('#cmdp-diagram-import-source').fill(source);
      const analyzeResponsePromise = page.waitForResponse((response) =>
        response.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze') && response.request().method() === 'POST'
      );
      await page.locator('button[data-action="diagram-import-analyze"]').click();
      assert.equal((await analyzeResponsePromise).status(), 200);

      const saveResponsePromise = page.waitForResponse((response) =>
        response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT'
      );
      await page.locator('button[data-action="save-template"]').click();
      assert.equal((await saveResponsePromise).status(), 200);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
      let analyzeRequestsAfterSelection = 0;
      const countAnalyzeRequest = (request) => {
        if (request.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze')) analyzeRequestsAfterSelection += 1;
      };
      page.on('request', countAnalyzeRequest);
      const restoreResponsePromise = page.waitForResponse((response) =>
        response.url().includes('/cmdbuild/custom-api/draft/diagram-import/restore') && response.request().method() === 'POST'
      );
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      const restoreResponse = await restoreResponsePromise;
      const restoreText = await restoreResponse.text();
      const restoreRequest = restoreResponse.request().postDataJSON();
      const restoredImport = restoreRequest.currentSpec && restoreRequest.currentSpec.result && Array.isArray(restoreRequest.currentSpec.result.diagrams)
        ? restoreRequest.currentSpec.result.diagrams.find((diagram) => diagram && diagram.authoring && diagram.authoring.d2Import)?.authoring?.d2Import
        : null;
      assert.equal(restoreResponse.status(), 200, `${restoreText}\nRestore context: ${JSON.stringify({
        checkpointHash: restoreRequest.analysisCheckpoint && restoreRequest.analysisCheckpoint.deterministicSpecHash,
        provisionalMappingStatus: restoredImport && restoredImport.mappingValidation && restoredImport.mappingValidation.status,
        provisionalMappingReasons: restoredImport && restoredImport.mappingValidation && restoredImport.mappingValidation.reasons
      })}`);
      const restoreBody = JSON.parse(restoreText);
      assert.equal(restoreBody.restoreKind, 'analysis', JSON.stringify(restoreBody));
      await page.locator('a[data-designer-section="diagram-assistant"]').click();
      await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
      await page.locator('[data-diagram-import-analysis-restored]').waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await page.locator('#cmdp-diagram-import-source').inputValue(), source);
      const restoredPreview = page.locator('[data-diagram-import-preview] [data-d2-rendered-svg]');
      assert.equal(await restoredPreview.count(), 1);
      const restoredPreviewBox = await restoredPreview.boundingBox();
      assert.ok(restoredPreviewBox && restoredPreviewBox.width > 0 && restoredPreviewBox.height > 0, JSON.stringify(restoredPreviewBox));
      assert.equal(await page.locator('button[data-action="assistant-diagram-interpret"]').isEnabled(), true);
      assert.equal(analyzeRequestsAfterSelection, 0, 'Selecting an unchanged saved template must restore, not analyze D2 source again.');
      page.off('request', countAnalyzeRequest);
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) =>
          response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE'
        );
        await deleteButton.click();
        assert.equal((await deleteResponsePromise).status(), 200);
      }
    }
  });
});

test('Designer analyzes and applies a reviewed D2 structure template', { skip: skipReason, timeout: 180_000 }, async () => {
  await withPage(async (page) => {
    const code = `D2AssistantMappingUiSmoke${Date.now()}`;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message || String(error)));
    await page.route('**/cmdbuild/custom-api/config?*', async (route) => {
      const response = await route.fetch();
      const responseBody = await response.json();
      const config = responseBody && responseBody.config && typeof responseBody.config === 'object'
        ? responseBody.config
        : responseBody;
      if (config && typeof config === 'object') {
        config.runtimeConfig = config.runtimeConfig && typeof config.runtimeConfig === 'object' ? config.runtimeConfig : {};
        config.runtimeConfig.assistant = config.runtimeConfig.assistant && typeof config.runtimeConfig.assistant === 'object'
          ? config.runtimeConfig.assistant
          : {};
        config.runtimeConfig.assistant.llm = Object.assign({}, config.runtimeConfig.assistant.llm || {}, { enabled: true });
        config.assistant = Object.assign({}, config.assistant || {}, { enabled: true });
      }
      await route.fulfill({ response, json: responseBody });
    });
    await page.goto(`${nginxOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 Assistant mapping UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());
    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
    const firstSelection = page.locator('[data-object-selection]').first();
    if (await firstSelection.locator('[data-object-selection-field="className"] option[value="ARM"]').count() === 0) {
      await page.locator('#cmdp-catalog-header').click();
      await firstSelection.locator('[data-object-selection-field="className"] option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
    }
    await firstSelection.locator('[data-object-selection-field="name"]').fill('Workstations');
    await firstSelection.locator('[data-object-selection-field="alias"]').fill('workstations');
    await firstSelection.locator('[data-object-selection-field="className"]').selectOption('ARM');
    await page.locator('button[data-action="apply-object-group"]').click();
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    assert.equal(await page.locator('[data-object-selection], [data-matching-block]').count(), 0);
    assert.equal(await page.locator('#cmdp-diagram-import-source').count(), 1);
    assert.equal(await page.locator('#cmdp-assistant-diagram-mapping-prompt').count(), 1);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isDisabled(), true);
    const d2Source = [
      'classes: { workstation: { shape: person } }',
      'users: "Пользователи и отдельные подключения" {',
      '  operator: "Рабочее место оператора" { class: workstation }',
      '  administrator: "Рабочее место администратора" { class: workstation }',
      '}'
    ].join('\n');
    await page.locator('#cmdp-diagram-import-source').fill(d2Source);
    const analyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    assert.equal(await page.locator('#cmdp-diagram-import-source').isDisabled(), true);
    const analyzeResponse = await analyzeResponsePromise;
    const analyzeBody = await analyzeResponse.json();
    assert.equal(analyzeResponse.status(), 200, `D2 analyze failed: ${JSON.stringify(analyzeBody)}`);
    assert.equal(analyzeBody.preview?.rendered, true, `D2 import preview was not rendered: ${JSON.stringify(analyzeBody.preview)}`);
    const importPreview = page.locator('[data-diagram-import-preview]');
    assert.equal(await importPreview.count(), 1);
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').count(), 1);
    const previewBeforeInterpretation = await page.locator('#cmdp-diagram-assistant-editor').evaluate((root) => {
      const preview = root.querySelector('[data-diagram-import-preview]');
      const interpretation = root.querySelector('.assistant-d2-prompt');
      return Boolean(preview && interpretation && (preview.compareDocumentPosition(interpretation) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(previewBeforeInterpretation, true, 'D2 preview must be rendered before D2 structure interpretation.');
    const analyzedRoles = analyzeBody.proposal?.roles || [];
    assert.deepEqual(analyzedRoles.map((role) => role.key).sort(), ['users', 'workstation']);
    assert.equal(analyzedRoles.some((role) => role.key === 'users.operator' || role.key === 'users.administrator'), false);
    const workstationRole = analyzedRoles.find((role) => role.key === 'workstation');
    const usersRole = analyzedRoles.find((role) => role.key === 'users');
    assert.ok(workstationRole);
    assert.ok(usersRole);
    assert.equal(await page.locator('#cmdp-diagram-section-editor').count(), 0);
    assert.equal(await page.locator('button[data-action="diagram-import-apply"]').isDisabled(), true);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isEnabled(), true);

    // Analyze is a deterministic authoring action. Saving it must restore the
    // proposal on reload even though no Assistant prompt has been submitted.
    const analysisSaveResponsePromise = page.waitForResponse((response) =>
      response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT'
    );
    const analysisRestoreResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/restore'));
    await page.locator('button[data-action="save-template"]').click();
    const analysisSaveResponse = await analysisSaveResponsePromise;
    assert.equal(analysisSaveResponse.status(), 200, await analysisSaveResponse.text());
    const analysisRestoreResponse = await analysisRestoreResponsePromise;
    assert.equal(analysisRestoreResponse.status(), 200, await analysisRestoreResponse.text());
    const analysisRestoreBody = await analysisRestoreResponse.json();
    assert.equal(analysisRestoreBody.restoreKind, 'analysis', JSON.stringify(analysisRestoreBody));
    await page.locator('[data-diagram-import-analysis-restored]').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.locator('#cmdp-diagram-import-source').inputValue(), d2Source);
    assert.equal(await page.locator('button[data-action="assistant-diagram-interpret"]').isEnabled(), true);

    // This test covers browser persistence and the real deterministic restore
    // route. LiteLLM availability is outside that contract, so supply valid
    // deterministic Assistant responses for interpretation and mapping.
    let interpretationRouteCalls = 0;
    await page.route('**/cmdbuild/custom-api/assistant/diagram-import/interpret**', async (route) => {
      interpretationRouteCalls += 1;
      const body = route.request().postDataJSON();
      const roles = Array.isArray(body?.proposal?.roles) ? body.proposal.roles : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          decisions: roles.map((role) => ({
            roleId: role.id,
            visualKind: role.key === 'users' ? 'container' : 'node',
            reason: 'Deterministic UI smoke interpretation.'
          })),
          explanation: 'Assistant proposal prepared.'
        })
      });
    });
    await page.route('**/cmdbuild/custom-api/assistant/diagram-import/map-selections**', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.stage === 'roles') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            checkpoint: { resumeId: body.resumeId, stage: 'roles', nextStage: 'topology', rolesReused: false },
            mapping: { status: 'partial', mappedRoles: 0, requiredRoles: 0, mappedConnections: 0, requiredConnections: 0 }
          })
        });
        return;
      }
      const rolesById = new Map((Array.isArray(body?.roles) ? body.roles : []).map((role) => [String(role.id || ''), role]));
      const mappings = (body?.structureTree?.items || []).map((item) => {
        const role = rolesById.get(String(item?.roleId || '')) || {};
        const structural = role.visualKind === 'container';
        return {
          structureItemId: item.id,
          roleId: item.roleId,
          source: structural ? {} : { stageId: 'selection:workstations' },
          mapping: {
            materialization: structural
              ? { kind: 'structural', stageId: '' }
              : { kind: 'stage', stageId: 'selection:workstations' }
          }
        };
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          mappings,
          relationRules: [],
          connectionUnresolved: [],
          explanation: 'Mapping proposal prepared.',
          mapping: { status: 'complete', mappedRoles: mappings.length, requiredRoles: mappings.length, mappedConnections: 0, requiredConnections: 0 }
        })
      });
    });

    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-action="assistant-diagram-interpret"]');
      return Boolean(button && !button.disabled);
    }, null, { timeout: 10_000 });

    await page.locator('#cmdp-assistant-diagram-interpret-prompt').fill('Интерпретируй workstation как объект, а users как статический контейнер. Не меняй role id.');
    await page.locator('button[data-action="assistant-diagram-interpret"]').click();
    await page.waitForTimeout(250);
    assert.equal(interpretationRouteCalls, 1, await page.locator('#cmdp-diagram-assistant-editor').innerText());
    await page.locator('.notice').filter({ hasText: 'Assistant proposal prepared.' }).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-diagram-assistant-editor').count(), 1);
    assert.equal(await page.locator('#cmdp-diagram-section-editor').count(), 0);

    await page.locator('#cmdp-assistant-diagram-mapping-prompt').fill('Сопоставь workstation с выборкой Workstations, users оставь статическим. Используй только доступные stage id.');
    await page.locator('button[data-action="assistant-diagram-map"]').click();
    await page.locator('.notice').filter({ hasText: 'Mapping proposal prepared.' }).waitFor({ state: 'visible', timeout: 10_000 });

    const directApply = page.locator('button[data-action="diagram-import-apply"]');
    assert.equal(await directApply.isEnabled(), true);
    const saveResponsePromise = page.waitForResponse((response) =>
      response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT'
    );
    const restoreResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/restore'));
    await page.locator('button[data-action="save-template"]').click();
    const saveResponse = await saveResponsePromise;
    assert.equal(saveResponse.status(), 200, await saveResponse.text());
    const restoreResponse = await restoreResponsePromise;
    assert.equal(restoreResponse.status(), 200, await restoreResponse.text());
    await directApply.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await directApply.isEnabled(), true, 'Saved Assistant proposal must be restored without repeated analysis.');
    const noticesAfterSave = await page.locator('.notice').allInnerTexts();
    assert.equal(noticesAfterSave.some((text) => /предыдущей ревизии шаблона|older template revision/i.test(text)), false, noticesAfterSave.join('\n'));

    const directApplyRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/diagram-import/apply'));
    const directApplyResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/apply'));
    const directPreviewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview')).catch(() => null);
    await directApply.click();
    const directApplyResponse = await directApplyResponsePromise;
    const directApplyRequest = await directApplyRequestPromise;
    assert.equal(directApplyRequest.postDataJSON().d2Source, d2Source);
    assert.equal(Object.hasOwn(directApplyRequest.postDataJSON(), 'persist'), false, 'D2 Apply must remain a local draft operation until normal Save.');
    const directApplyBody = await directApplyResponse.json();
    assert.equal(directApplyResponse.status(), 200, `Assistant direct D2 apply failed: ${JSON.stringify(directApplyBody)}`);
    assert.equal(directApplyBody.d2Workflow?.state, 'applied', JSON.stringify(directApplyBody));
    assert.ok(directApplyBody.spec, JSON.stringify(directApplyBody));
    assert.equal(directApplyBody.template, undefined);
    assert.equal(directApplyBody.versionLog, undefined);
    await page.locator('#cmdp-visualization-editor').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('[data-diagram-editor-section="d2-mappings"]').count(), 0, 'Applied preview must open the dedicated visualization workspace.');
    await page.locator('[data-diagram-import-runtime-preview] [data-diagram-import-runtime-preview-elapsed]').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false, 'Save must remain available while background D2 preview runs.');
    const directPreviewResponse = await directPreviewResponsePromise;
    assert.ok(directPreviewResponse, 'D2 Apply must start the local draft preview.');
    const directPreviewBody = await directPreviewResponse.json();
    assert.equal(directPreviewResponse.status(), 200, `Assistant direct D2 preview failed: ${JSON.stringify(directPreviewBody)}`);
    assert.ok(directPreviewBody.result?.diagrams?.length, `Assistant direct D2 preview returned no diagram: ${JSON.stringify(directPreviewBody.result)}`);
    await page.locator('[data-diagram-import-runtime-preview] [data-d2-rendered-svg]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#cmdp-diagram-assistant-editor').count(), 0);
    assert.equal(await page.locator('[data-diagram-import-runtime-preview] [data-d2-rendered-svg]').count(), 1);
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false);
    assert.doesNotMatch(await page.locator('#cmdp-visualization-editor').innerText(), /Сначала выполните детерминированный анализ D2/);

    let appliedEditorAnalyzeRequests = 0;
    const countAppliedEditorAnalysis = (request) => {
      if (request.url().includes('/cmdbuild/custom-api/draft/diagram-import/analyze')) appliedEditorAnalyzeRequests += 1;
    };
    page.on('request', countAppliedEditorAnalysis);
    await page.locator('a[data-designer-section="diagram"]').click();
    try {
      await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
    } catch (error) {
      const notices = await page.locator('.notice').allInnerTexts();
      throw new Error(`Diagram editor did not render after applying D2 mapping. url=${page.url()} notices=${JSON.stringify(notices)} pageErrors=${JSON.stringify(pageErrors)} cause=${error.message || String(error)}`);
    }
    const appliedMappingBlock = page.locator('[data-diagram-editor-section="d2-mappings"][data-diagram-import-editor-mode="applied"]');
    assert.equal(await appliedMappingBlock.isVisible(), true);
    const appliedMappingBox = await appliedMappingBlock.boundingBox();
    assert.ok(appliedMappingBox && appliedMappingBox.width > 0 && appliedMappingBox.height > 0, 'Applied D2 mapping must be visibly rendered in the Diagram editor.');
    assert.equal(await page.locator('#cmdp-diagram-import-source').count(), 0);
    const structureTab = page.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="structure"]');
    assert.equal(await page.locator('button[data-action="diagram-import-editor-tab"][data-diagram-import-editor-tab="nodes"]').count(), 0);
    assert.equal(await structureTab.isVisible(), true);
    assert.equal(await structureTab.getAttribute('aria-selected'), 'true');
    const structurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await structurePanel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await structureTab.getAttribute('aria-selected'), 'true');
    const structurePanelBox = await structurePanel.boundingBox();
    assert.ok(structurePanelBox && structurePanelBox.width > 0 && structurePanelBox.height > 0, 'Structure mapping panel must be visibly rendered.');
    assert.equal(await structurePanel.locator('[data-diagram-structure-tree]').count(), 1);
    const appliedTreeRows = structurePanel.locator('[data-diagram-structure-tree-row]');
    assert.equal(await appliedTreeRows.count(), 2, 'Sibling D2 exemplars with the same role-path context must be represented by one structure-tree item.');
    const appliedTreeText = await appliedTreeRows.allInnerTexts();
    assert.ok(appliedTreeText.some((text) => /users|Пользователи/i.test(text)), JSON.stringify(appliedTreeText));
    assert.ok(appliedTreeText.some((text) => /workstation/i.test(text)), JSON.stringify(appliedTreeText));
    const appliedUsersTreeRow = appliedTreeRows.filter({ hasText: /users|Пользователи/i }).first();
    await appliedUsersTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    const appliedUsersMapping = structurePanel.locator('[data-diagram-import-placement-mapping]');
    await appliedUsersMapping.waitFor({ state: 'visible', timeout: 10_000 });
    const appliedUsersShowEmpty = appliedUsersMapping.locator('[data-diagram-import-placement-field="showEmpty"]');
    assert.equal(await appliedUsersShowEmpty.count(), 1, 'Containers must expose the empty-container visibility control.');
    assert.equal(await appliedUsersShowEmpty.isChecked(), true);
    await appliedUsersShowEmpty.uncheck();
    await structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="showEmpty"]').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await structurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="showEmpty"]').isChecked(), false);
    const appliedUsersLabelTemplate = appliedUsersMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
    assert.equal(await appliedUsersLabelTemplate.count(), 1, 'Containers must expose the same label editor as nodes.');
    await appliedUsersLabelTemplate.fill('Пользователи: ' + '$' + '{child.');
    const childLabelCandidate = page.locator('[data-diagram-import-label-autocomplete] button').filter({ hasText: /Дочерний элемент/i }).first();
    await childLabelCandidate.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(String(await childLabelCandidate.getAttribute('data-diagram-import-label-option') || ''), /^child\./);
    await childLabelCandidate.click();
    await appliedUsersLabelTemplate.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(await appliedUsersLabelTemplate.inputValue(), /\$\{child\.[^}]+\}/);
    const appliedWorkstationTreeRow = appliedTreeRows.filter({ hasText: /workstation/i }).first();
    await appliedWorkstationTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    const appliedWorkstationMapping = structurePanel.locator('[data-diagram-import-placement-mapping]');
    await appliedWorkstationMapping.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await appliedWorkstationMapping.locator('[data-diagram-import-placement-field="showEmpty"]').count(), 0, 'Nodes must not expose a container visibility policy.');
    assert.equal(await appliedWorkstationMapping.locator('[data-diagram-import-placement-field="materialization.kind"]').inputValue(), 'stage');
    assert.equal(await appliedWorkstationMapping.locator('[data-diagram-import-placement-field="materialization.stageId"]').inputValue(), 'selection:workstations');
    assert.equal(await appliedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.className"]').inputValue(), 'ARM');
    const appliedLabelTemplate = appliedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
    await appliedLabelTemplate.fill('${Code');
    assert.equal(await page.locator('button[data-action="diagram-import-update-applied"]').count(), 0, 'The manual Diagram editor must not expose a second deterministic Apply action.');
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false, 'Typing into the label template must immediately enable normal Save for an applied mapping.');
    const invalidMappingSaveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
    await page.locator('button[data-action="save-template"]').click();
    const invalidMappingSaveResponse = await invalidMappingSaveResponsePromise;
    assert.equal(invalidMappingSaveResponse.status(), 200, await invalidMappingSaveResponse.text());
    const savedWorkstationTreeRow = structurePanel.locator('[data-diagram-structure-tree-row]').filter({ hasText: /workstation/i }).first();
    await savedWorkstationTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    await appliedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await appliedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').inputValue(), '${Code');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
    const reloadedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await reloadedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
    const reloadedUsersTreeRow = reloadedStructurePanel.locator('[data-diagram-structure-tree-row]').filter({ hasText: /users|Пользователи/i }).first();
    await reloadedUsersTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    const reloadedUsersMapping = reloadedStructurePanel.locator('[data-diagram-import-placement-mapping]');
    await reloadedUsersMapping.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await reloadedUsersMapping.locator('[data-diagram-import-placement-field="showEmpty"]').isChecked(), false, 'A normal template save must preserve the empty-container visibility setting.');
    const reloadedWorkstationTreeRow = reloadedStructurePanel.locator('[data-diagram-structure-tree-row]').filter({ hasText: /workstation/i }).first();
    await reloadedWorkstationTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    const reloadedWorkstationMapping = reloadedStructurePanel.locator('[data-diagram-import-placement-mapping]');
    await reloadedWorkstationMapping.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await reloadedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').inputValue(), '${Code', 'A normal template save must restore the applied mapping after a fresh Designer reload.');

    const unsavedPreviewLabel = reloadedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
    await unsavedPreviewLabel.fill('${Description}');
    await unsavedPreviewLabel.blur();
    const unsavedPreviewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview') && request.method() === 'POST');
    await page.locator('button[data-action="diagram-import-preview-current"]').click();
    const unsavedPreviewRequest = await unsavedPreviewRequestPromise;
    const unsavedVisualization = page.locator('#cmdp-visualization-editor');
    await unsavedVisualization.waitFor({ state: 'visible', timeout: 10_000 });
    const unsavedPreviewPayload = unsavedPreviewRequest.postDataJSON();
    assert.equal(
      unsavedPreviewPayload.template.spec.result?.diagrams?.[0]?.authoring?.d2Import?.structureTree?.items
        .some((item) => item.mapping?.primary?.labelTemplate === '${Description}'),
      true,
      'Current preview must use an unsaved applied D2 mapping instead of the saved template mapping.'
    );

    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
    const unsavedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await unsavedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
    const unsavedWorkstationTreeRow = unsavedStructurePanel.locator('[data-diagram-structure-tree-row]').filter({ hasText: /workstation/i }).first();
    await unsavedWorkstationTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    const unsavedWorkstationMapping = unsavedStructurePanel.locator('[data-diagram-import-placement-mapping]');
    await unsavedWorkstationMapping.waitFor({ state: 'visible', timeout: 10_000 });

    await unsavedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').fill('${Code} ${Description}');
    await unsavedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').blur();
    const updatedPreviewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview'));
    await page.locator('button[data-action="diagram-import-preview-current"]').click();
    assert.equal(appliedEditorAnalyzeRequests, 0, 'Opening or editing the applied mapping must not trigger a new D2 analysis.');
    await updatedPreviewResponsePromise;
    await page.locator('#cmdp-visualization-editor').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-diagram-import-runtime-preview] [data-d2-rendered-svg]').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false);
    page.off('request', countAppliedEditorAnalysis);
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
    const updatedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await updatedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
    const updatedWorkstationTreeRow = updatedStructurePanel.locator('[data-diagram-structure-tree-row]').filter({ hasText: /workstation/i }).first();
    await updatedWorkstationTreeRow.locator('button[data-action="diagram-structure-select"]').click();
    const updatedWorkstationMapping = updatedStructurePanel.locator('[data-diagram-import-placement-mapping]');
    await updatedWorkstationMapping.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await updatedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]').inputValue(), '${Code} ${Description}');
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });

    const analyzedSource = await page.locator('#cmdp-diagram-import-source').inputValue();
    await page.locator('#cmdp-diagram-import-source').fill(`${analyzedSource}\n# changed`);
    assert.equal(await page.locator('[data-diagram-import-stale]:visible').count(), 1);
    assert.equal(await page.locator('[data-diagram-import-preview]').getAttribute('data-diagram-import-preview-state'), 'empty');
    assert.equal(await page.locator('[data-diagram-import-preview] [data-d2-rendered-svg]').count(), 0);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isDisabled(), true);
    const refreshAnalyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const refreshAnalyzeResponse = await refreshAnalyzeResponsePromise;
    const refreshAnalyzeBody = await refreshAnalyzeResponse.json();
    assert.equal(refreshAnalyzeResponse.status(), 200, `D2 reanalyze failed: ${JSON.stringify(refreshAnalyzeBody)}`);
    const changedSource = `${analyzedSource}\n# changed`;
    await page.locator('#cmdp-assistant-diagram-interpret-prompt').fill('Повторно интерпретируй workstation как объект, а users как статический контейнер. Не меняй role id.');
    const refreshedInterpretRequestPromise = page.waitForRequest((request) => request.url().includes('/assistant/diagram-import/interpret') && request.method() === 'POST');
    const refreshedInterpretResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/diagram-import/interpret') && response.request().method() === 'POST');
    await page.locator('button[data-action="assistant-diagram-interpret"]').click();
    const refreshedInterpretRequest = await refreshedInterpretRequestPromise;
    const refreshedInterpretResponse = await refreshedInterpretResponsePromise;
    const refreshedInterpretBody = await refreshedInterpretResponse.json();
    assert.equal(refreshedInterpretResponse.status(), 200, `Assistant must accept the source just analyzed: ${JSON.stringify(refreshedInterpretBody)}`);
    const refreshedInterpretPayload = refreshedInterpretRequest.postDataJSON();
    assert.equal(refreshedInterpretPayload?.proposal?.sourceText, changedSource);
    assert.equal(
      refreshedInterpretPayload?.currentSpec?.authoring?.d2?.source,
      changedSource,
      'Assistant request must use the analyzed proposal source without persisting it as the applied source.'
    );
    assert.equal(
      refreshedInterpretPayload?.currentSpec?.result?.diagrams?.[0]?.authoring?.d2Import?.source,
      analyzedSource,
      'Assistant request must keep the already applied D2 mapping source unchanged.'
    );
    const refreshedRoles = refreshAnalyzeBody.proposal?.roles || [];
    const refreshedWorkstation = refreshedRoles.find((role) => role.key === 'workstation');
    const refreshedUsers = refreshedRoles.find((role) => role.key === 'users');
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-diagram-import-source').count(), 0);
    const refreshedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await refreshedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await refreshedStructurePanel.locator('[data-diagram-structure-tree]').count(), 1);
    const refreshedTreeRows = refreshedStructurePanel.locator('[data-diagram-structure-tree-row]');
    assert.equal(await refreshedTreeRows.count(), 2, 'Reanalysis must preserve one container and one collapsed sibling role item.');
    const refreshedTreeText = await refreshedTreeRows.allInnerTexts();
    assert.ok(refreshedTreeText.some((text) => /users|Пользователи/i.test(text)), JSON.stringify(refreshedTreeText));
    assert.ok(refreshedTreeText.some((text) => /workstation/i.test(text)), JSON.stringify(refreshedTreeText));
    const refreshedWorkstationTreeRows = refreshedTreeRows.filter({ hasText: /workstation/i });
    assert.equal(await refreshedWorkstationTreeRows.count(), 1, 'Sibling D2 workstation exemplars must share one structure-tree item.');
    for (let index = 0; index < await refreshedWorkstationTreeRows.count(); index += 1) {
      const refreshedWorkstationTreeRow = refreshedWorkstationTreeRows.nth(index);
      await refreshedWorkstationTreeRow.locator('button[data-action="diagram-structure-select"]').click();
      const sourceStage = refreshedStructurePanel.locator('[data-diagram-import-placement-mapping] [data-diagram-import-placement-field="materialization.stageId"]');
      const sourceOptions = await sourceStage.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
      assert.ok(sourceOptions.includes('selection:workstations'), `Workstation selection is absent from D2 tree sources: ${JSON.stringify(sourceOptions)}`);
      await sourceStage.selectOption('selection:workstations');
    }
    await refreshedWorkstationTreeRows.first().locator('button[data-action="diagram-structure-select"]').click();
    const workstationMapping = refreshedStructurePanel.locator('[data-diagram-import-placement-mapping]');
    await workstationMapping.waitFor({ state: 'visible', timeout: 10_000 });
    const primaryClass = workstationMapping.locator('[data-diagram-import-placement-field="primary.className"]');
    assert.equal(await primaryClass.inputValue(), 'ARM');
    assert.equal(await workstationMapping.locator('[data-diagram-import-primary-class-label]').count(), 0);
    assert.equal(await workstationMapping.getByText(/^Класс CMDBuild$|^CMDBuild class$/i).count(), 0);
    const labelTemplateLabel = workstationMapping.locator('[data-diagram-import-label-template-field] > label');
    assert.match(await labelTemplateLabel.innerText(), /атрибутов класса|attributes/i);
    assert.match(await labelTemplateLabel.innerText(), /ARM/i);
    assert.equal(await workstationMapping.locator('[data-diagram-import-placement-field="primary.idAttribute"]').count(), 0);
    const nodeData = workstationMapping.locator('[data-diagram-import-node-data]');
    assert.equal(await nodeData.count(), 1);
    assert.match(await nodeData.locator('summary').innerText(), /Дополнительные атрибуты данных узла|Additional node data/i);
    assert.equal(await nodeData.locator('[data-diagram-import-data-field-row="Description"]').count(), 0);
    assert.doesNotMatch(await nodeData.locator('thead').innerText(), /Используется для|Used by/i);
    const addDataField = nodeData.locator('[data-diagram-import-add-data-field]');
    const additionalFieldOptions = await addDataField.locator('option').evaluateAll((options) => options
      .map((option) => option.value)
      .filter(Boolean));
    const addedDataFields = additionalFieldOptions.slice(0, 2);
    for (const field of addedDataFields) {
      await nodeData.locator('[data-diagram-import-add-data-field]').selectOption(field);
      await nodeData.locator('button[data-action="diagram-import-add-data-field"]').click();
      await nodeData.locator(`[data-diagram-import-data-field-row="${field}"]`).waitFor({ state: 'attached', timeout: 10_000 });
    }
    const labelInput = workstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
    await labelInput.fill('${');
    const labelAutocomplete = workstationMapping.locator('[data-diagram-import-label-autocomplete]');
    await labelAutocomplete.waitFor({ state: 'visible', timeout: 10_000 });
    const labelAutocompleteBox = await labelAutocomplete.boundingBox();
    assert.ok(labelAutocompleteBox && labelAutocompleteBox.width > 0 && labelAutocompleteBox.height > 0, 'Label template autocomplete is not visibly rendered.');
    const labelOptions = await labelAutocomplete.locator('[data-diagram-import-label-option]').evaluateAll((options) => options.map((option) => option.getAttribute('data-diagram-import-label-option')));
    assert.ok(labelOptions.includes('Code'));
    assert.ok(labelOptions.includes('Description'));
    assert.equal(labelOptions.some((option) => ['_id', 'Id', 'Class', 'SourceId', 'RelatedId'].includes(option)), false);
    assert.equal(await nodeData.locator('[data-action="insert-diagram-template-token"]').count(), 0);
    assert.equal(await workstationMapping.locator('[data-diagram-import-node-data]').getByText(/Поля для подписи элемента|Label template fields/i).count(), 0);
    const codeToken = labelAutocomplete.locator('[data-diagram-import-label-option="Code"]');
    await codeToken.click();
    const selectedLabelInput = workstationMapping.locator('[data-diagram-import-placement-field="primary.labelTemplate"]');
    await selectedLabelInput.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await selectedLabelInput.inputValue(), '${Code}');
    await labelInput.fill('${Code} ${Description}');
    await labelInput.blur();
    assert.equal(await nodeData.locator('[data-diagram-import-data-field-row="Code"]').count(), 0);
    await page.locator('[data-diagram-import-editor-panel="structure"]').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('[data-diagram-structure-tree]').count(), 1);
    assert.equal(await page.locator('button[data-action="diagram-import-apply"]').count(), 0, 'The manual Diagram editor must not expose Assistant Apply.');
    const previewRequestPromise = page.waitForRequest(
      (request) => request.url().includes('/cmdbuild/custom-api/draft/preview'),
      { timeout: 60_000 }
    ).catch(() => null);
    const previewResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/cmdbuild/custom-api/draft/preview'),
      { timeout: 60_000 }
    ).catch(() => null);
    await page.locator('button[data-action="diagram-import-preview-current"]').click();
    await page.locator('#cmdp-visualization-editor').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('[data-diagram-mapping-row]').count(), 0);
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false);
    const previewRequest = await previewRequestPromise;
    assert.ok(previewRequest, 'The current Diagram editor state must start a local draft preview.');
    const previewRequestBody = previewRequest.postDataJSON();
    const requestedDiagrams = previewRequestBody?.template?.spec?.result?.diagrams || [];
    assert.equal(requestedDiagrams.length, 1, `Draft preview lost imported diagram: ${JSON.stringify(requestedDiagrams)}`);
    assert.equal(requestedDiagrams[0].authoring?.d2Import?.version, 3);
    assert.equal(requestedDiagrams[0].authoring?.d2Import?.mappingValidation?.status, 'needsValidation', 'Manual editor preview must keep the mapping non-executable until normal template Save recompiles it.');
    assert.deepEqual(requestedDiagrams[0].authoring?.d2Import?.roles?.map((role) => role.key).sort(), ['users', 'workstation']);
    const previewResponse = await previewResponsePromise;
    assert.ok(previewResponse, 'Current Diagram editor preview did not return a response.');
    const previewBody = await previewResponse.json();
    const previewDiagrams = previewBody?.result?.diagrams || [];
    assert.equal(previewDiagrams.length, 1, `Draft preview returned no diagram: ${JSON.stringify({ trace: previewBody?.result?.trace, tables: previewBody?.result?.tables?.map((table) => ({ name: table.name, rows: table.rows?.length })) })}`);
    assert.ok(previewDiagrams[0].nodes?.length > 0, `Draft preview returned an empty diagram: ${JSON.stringify({
      warnings: previewDiagrams[0].warnings || [],
      trace: previewBody?.result?.trace,
      tables: previewBody?.result?.tables?.map((table) => ({ name: table.name, rows: table.rows?.length })),
      nodeMappings: requestedDiagrams[0]?.nodeMappings,
      groupMappings: requestedDiagrams[0]?.groupMappings
    })}`);
    assert.equal(previewDiagrams[0].svg?.rendered, true, JSON.stringify(previewDiagrams[0].warnings || []));
    assert.match(previewDiagrams[0].svg?.content || '', /^<svg[\s>]/i);
    assert.equal(previewBody?.result?.presentation?.outputMode, 'both');
    const runtimePreview = page.locator('[data-diagram-import-runtime-preview]');
    await runtimePreview.waitFor({ state: 'visible', timeout: 30_000 });
    const renderedSvgCount = await runtimePreview.locator('[data-d2-rendered-svg]').count();
    const runtimePreviewHtml = await runtimePreview.innerHTML();
    assert.equal(renderedSvgCount, 1, `Draft SVG is absent in the embedded D2 preview: ${runtimePreviewHtml.slice(0, 1200)}`);
    const renderedSvg = await runtimePreview.locator('[data-d2-rendered-svg]').first().innerHTML();
    assert.match(renderedSvg, /АРМ|ARM/i);
    assert.doesNotMatch(renderedSvg, /Рабочее место оператора|Рабочее место администратора/);
    const draftDownload = page.locator('button[data-action="download-draft-d2"]').first();
    assert.equal(await draftDownload.isVisible(), true);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      draftDownload.click()
    ]);
    assert.match(download.suggestedFilename(), /\.d2$/);
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.locator('#cmdp-diagram-editor').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('[data-diagram-mapping-row]').count(), 0);
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), false, 'A completed intermediate preview must not block template Save.');
    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    const reopenAnalyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const reopenAnalyzeResponse = await reopenAnalyzeResponsePromise;
    const reopenAnalyzeBody = await reopenAnalyzeResponse.json();
    assert.equal(reopenAnalyzeResponse.status(), 200, `D2 reopen analyze failed: ${JSON.stringify(reopenAnalyzeBody)}`);
    assert.equal(reopenAnalyzeBody.proposal?.roles?.length, 2);
    await page.locator('a[data-designer-section="diagram"]').click();
    const reopenedStructurePanel = page.locator('[data-diagram-import-editor-panel="structure"]');
    await reopenedStructurePanel.waitFor({ state: 'visible', timeout: 10_000 });
    const reopenedAppliedBlock = page.locator('[data-diagram-editor-section="d2-mappings"][data-diagram-import-editor-mode="applied"]');
    assert.equal(await reopenedAppliedBlock.isVisible(), true, 'Analyze must not replace the saved mapping shown by Diagram editor.');
    assert.equal(await page.locator('[data-diagram-editor-section="d2-mappings"][data-diagram-import-editor-mode="proposal"]').count(), 0);
    assert.equal(await reopenedAppliedBlock.locator('button[data-action="diagram-import-apply"]').count(), 0, 'Assistant Apply must remain in Diagram Assistant, not the manual editor.');
    assert.equal(await reopenedAppliedBlock.locator('button[data-action="diagram-import-update-applied"]').count(), 0);
    assert.equal(await reopenedAppliedBlock.locator('[data-diagram-import-pending-priority]').count(), 0);
    await reopenedStructurePanel.locator('[data-diagram-structure-tree-row]').filter({ hasText: /workstation/i }).first().locator('button[data-action="diagram-structure-select"]').click();
    const reopenedWorkstationMapping = reopenedStructurePanel.locator('[data-diagram-import-placement-mapping]');
    await reopenedWorkstationMapping.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await reopenedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.className"]').inputValue(), 'ARM');
    const reopenedStructuredFields = await reopenedWorkstationMapping.locator('[data-diagram-import-placement-field="primary.structuredFields"]').evaluate((select) => Array.from(select.selectedOptions).map((option) => option.value));
    assert.ok(addedDataFields.every((field) => reopenedStructuredFields.includes(field)), JSON.stringify(reopenedStructuredFields));
    assert.equal(await page.locator('#cmdp-diagram-title').count(), 0);
    const preservedSaveRequestPromise = page.waitForRequest((request) => request.url().includes(`/cmdbuild/custom-api/templates/${code}`) && request.method() === 'PUT');
    const preservedSaveResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'PUT');
    await page.locator('button[data-action="save-template"]').click();
    const preservedSaveRequest = await preservedSaveRequestPromise;
    const preservedSaveResponse = await preservedSaveResponsePromise;
    assert.equal(preservedSaveResponse.status(), 200, await preservedSaveResponse.text());
    const preservedSaveRequestImport = preservedSaveRequest.postDataJSON()?.spec?.result?.diagrams?.[0]?.authoring?.d2Import;
    assert.equal(preservedSaveRequestImport?.mappingValidation?.status, 'needsValidation', JSON.stringify(preservedSaveRequestImport));
    const preservedSaveBody = await preservedSaveResponse.json();
    const preservedImport = preservedSaveBody?.template?.spec?.result?.diagrams?.[0]?.authoring?.d2Import;
    assert.equal(preservedImport?.mappingValidation?.status, 'valid', JSON.stringify(preservedImport));
    assert.equal(preservedImport?.source, analyzedSource);
    assert.equal(
      preservedSaveBody?.template?.spec?.authoring?.d2?.source,
      analyzedSource,
      'Normal Save must retain the applied source until the author explicitly applies the analyzed mapping.'
    );
    assert.ok(
      preservedImport?.structureTree?.items?.some((item) => item.mapping?.primary?.className === 'ARM'),
      JSON.stringify(preservedImport?.structureTree)
    );
    assert.deepEqual(pageErrors, []);
    await page.locator('a[data-designer-section="templates"]').click();
    const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
    if (await deleteButton.count()) {
      page.once('dialog', (dialog) => dialog.accept());
      const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
      await deleteButton.click();
      const deleteResponse = await deleteResponsePromise;
      assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
    }
  }, { cookieOrigin: nginxOrigin });
});

test('Assistant uses current in-browser D2 authoring without prompt autosave', { skip: skipReason, timeout: 120_000 }, async () => {
  await withPage(async (page) => {
    const code = `D2AssistantRevisionUiSmoke${Date.now()}`;
    await page.goto(`${nginxOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('D2 Assistant revision race smoke');
    const saveResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    assert.equal((await saveResponsePromise).status(), 201);

    await page.locator('a[data-designer-section="diagram-assistant"]').click();
    await page.waitForSelector('#cmdp-diagram-assistant-editor', { timeout: 10_000 });
    await page.locator('#cmdp-diagram-import-source').fill([
      'classes: { workstation: { shape: person } }',
      'users: "Users" {',
      '  operator: "Operator workstation" { class: workstation }',
      '}'
    ].join('\n'));
    const initialAnalyzePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const initialAnalyze = await initialAnalyzePromise;
    const initialBody = await initialAnalyze.json();
    assert.equal(initialAnalyze.status(), 200, JSON.stringify(initialBody));
    let reanalysisRequests = 0;
    const retiredAssistantDraftRequests = [];
    page.on('request', (request) => {
      if (request.url().includes('/draft/diagram-import/analyze')) reanalysisRequests += 1;
      if (request.url().includes(`/templates/${encodeURIComponent(code)}/assistant-draft`)) {
        retiredAssistantDraftRequests.push({ method: request.method(), url: request.url() });
      }
    });

    await page.route('**/cmdbuild/custom-api/assistant/diagram-import/interpret**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          decisions: [{ roleId: initialBody.proposal?.roles?.[0]?.id, visualKind: 'node', reason: 'UI revision smoke.' }],
          explanation: 'Assistant proposal prepared.'
        })
      });
    });

    await page.locator('#cmdp-assistant-diagram-interpret-prompt').fill('Interpret workstation as a CMDB object and users as a static container.');
    await page.waitForTimeout(700);
    assert.deepEqual(retiredAssistantDraftRequests, [], 'Editing a D2 Assistant prompt must not persist it automatically.');
    const interpretRequestPromise = page.waitForRequest((request) => request.url().includes('/assistant/diagram-import/interpret'));
    const interpretResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/diagram-import/interpret'));
    await page.locator('button[data-action="assistant-diagram-interpret"]').click();

    const interpretRequest = await interpretRequestPromise;
    const interpretPayload = interpretRequest.postDataJSON();
    assert.equal(interpretPayload?.templateCode, code);
    assert.equal(interpretPayload?.baseSpecHash, initialBody.proposal?.baseSpecHash);
    assert.equal(interpretPayload?.proposal?.baseSpecHash, initialBody.proposal?.baseSpecHash);
    assert.equal(interpretPayload?.proposal?.deterministicSpecHash, initialBody.proposal?.deterministicSpecHash);
    assert.equal(interpretPayload?.currentSpec?.authoring?.assistant?.diagramInterpretPrompt, 'Interpret workstation as a CMDB object and users as a static container.');
    assert.equal(reanalysisRequests, 0, 'Changing a prompt must not trigger another D2 analysis.');
    assert.deepEqual(retiredAssistantDraftRequests, [], 'D2 Assistant requests must carry current authoring instead of using assistant-draft.');
    const interpretResponse = await interpretResponsePromise;
    assert.equal(interpretResponse.status(), 200, await interpretResponse.text());
    assert.doesNotMatch(await page.locator('#cmdp-diagram-assistant-editor').innerText(), /changed by another editor|изменен другим редактором/i);
  }, { cookieOrigin: nginxOrigin });
});

test('Assistant generates an ARM by router Location object group and preview renders rows', { skip: skipReason, timeout: 180_000 }, async () => {
  await withPage(async (page) => {
    const code = `AssistantArmRouterLocationUiSmoke${Date.now()}`;
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Assistant ARM router Location UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());
    await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });

    await addAssistantBusinessBlock(page, {
      name: 'Маршрутизатор Test City 300',
      entities: 'Экземпляр класса маршрутизатор с Description "Маршрутизатор для Test City 300".',
      algorithm: 'Найти один маршрутизатор и вернуть Code, Description и Location.',
      expectedResult: 'Одна карточка маршрутизатора с Location.'
    });
    await page.locator('button[data-action="assistant-flow-block-add"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-assistant-flow-block]').length === 2);
    await addAssistantBusinessBlock(page, {
      name: 'АРМ в местоположении маршрутизатора',
      entities: 'Карточки класса АРМ и Location результата первого блока.',
      algorithm: 'Найти АРМ, у которых Location равен Location выбранного маршрутизатора; вернуть Code, Description, Location, model и model2.',
      expectedResult: 'Таблица всех АРМ в том же местоположении.'
    });
    await page.locator('[data-assistant-flow-block]').nth(1).locator('[data-assistant-flow-field="uses"]').selectOption('block-1');
    const semanticPlan = {
      version: 1,
      blocks: [{
        id: 'block-1',
        name: 'Маршрутизатор Test City 300',
        summary: 'Точная карточка routerG по Description.',
        resolvedEntities: ['routerG'],
        relationPaths: [],
        dependencies: [],
        expectedResult: 'Одна карточка маршрутизатора с Location.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'routerG', dependencyPaths: [], relationPredicates: [], attributePredicates: [] },
        warnings: []
      }, {
        id: 'block-2',
        name: 'АРМ в местоположении маршрутизатора',
        summary: 'Карточки ARM, у которых Location совпадает с результатом первого блока.',
        resolvedEntities: ['ARM', 'routerG'],
        relationPaths: [],
        dependencies: ['block-1'],
        expectedResult: 'Таблица всех АРМ в том же местоположении.',
        resultContract: {
          outputKind: 'sourceCards',
          outputClass: 'ARM',
          dependencyPaths: [],
          relationPredicates: [],
          attributePredicates: [{
            sourceClass: 'ARM',
            comparisonBlockId: 'block-1',
            comparisonClass: 'routerG',
            sourceFields: ['Location'],
            comparisonField: 'Location',
            operator: 'equals'
          }]
        },
        warnings: []
      }],
      explanation: 'Семантический план готов.',
      warnings: []
    };
    const flow = {
      version: 1,
      selections: [{
        id: 'selection:routerAnchor',
        name: 'Маршрутизатор Test City 300',
        alias: 'routerAnchor',
        className: 'routerG',
        from: '',
        limit: 1,
        columns: ['Code', 'Description', 'Location'],
        rules: [{ action: 'include', path: 'Description', negate: false, op: 'equals', rightExpression: 'Маршрутизатор для Test City 300' }]
      }, {
        id: 'selection:arms',
        name: 'АРМ в местоположении маршрутизатора',
        alias: 'arms',
        className: 'ARM',
        from: 'routerAnchor',
        limit: 100,
        columns: ['Code', 'Description', 'Location', 'model', 'model2'],
        rules: [{ action: 'include', path: 'Location', negate: false, op: 'equals', rightExpression: '${previous.Location}' }]
      }],
      operations: [],
      blocks: [],
      setOperations: [],
      publishedAlias: 'arms'
    };
    // The browser test verifies the real deterministic apply/preview/extraction path.
    // LLM responses are isolated so model variability cannot make this regression flaky.
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, semanticPlan }) });
    });
    await page.route('**/cmdbuild/custom-api/assistant/object-flow/plan?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          action: 'assistant-object-flow-plan',
          flow,
          canApply: true,
          outputBindings: [
            { blockId: 'block-1', alias: 'routerAnchor' },
            { blockId: 'block-2', alias: 'arms' }
          ],
          explanation: 'Flow ready.',
          warnings: []
        })
      });
    });
    assert.equal(await page.locator('button[data-action="assistant-flow-apply"]').isDisabled(), true);
    await page.locator('button[data-action="assistant-flow-prepare"]').click();
    await page.locator('[data-assistant-flow-semantic-plan]').waitFor({ timeout: 60_000 });
    const flowResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/object-flow/plan'));
    await page.locator('button[data-action="assistant-flow-generate"]').click();
    const flowResponse = await flowResponsePromise;
    const flowBody = await flowResponse.json();
    assert.equal(flowResponse.status(), 200, JSON.stringify(flowBody));
    assert.equal(flowBody.flow?.selections?.[0]?.className, 'routerG');
    assert.equal(flowBody.flow?.selections?.[1]?.className, 'ARM');
    assert.ok(flowBody.flow?.selections?.[0]?.rules?.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.rightExpression === 'Маршрутизатор для Test City 300'), JSON.stringify(flowBody));
    assert.equal(flowBody.flow?.selections?.[1]?.from, flowBody.flow?.selections?.[0]?.alias, JSON.stringify(flowBody));
    assert.ok(flowBody.flow?.selections?.[1]?.rules?.some((rule) => rule.path === 'Location' && rule.op === 'equals' && rule.rightExpression === '${previous.Location}'), JSON.stringify(flowBody));
    assert.equal(flowBody.flow?.operations?.some((operation) => operation.type === 'match'), false, JSON.stringify(flowBody));
    assert.equal(await page.locator('[data-object-selection], [data-matching-block], [data-matching-rule-row]').count(), 0);
    assert.equal(await page.locator('[data-object-selection], [data-matching-block], [data-matching-rule-row]').count(), 0);
    assert.equal(await page.locator('button[data-action="assistant-flow-preview"]').count(), 0);
    assert.match(await page.locator('button[data-action="assistant-flow-apply"]').innerText(), /Применить цепочку|Apply data flow/);
    const applyResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/object-flow/apply'));
    await page.locator('button[data-action="assistant-flow-apply"]').click();
    let applyResponse;
    try {
      applyResponse = await applyResponsePromise;
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        notices: Array.from(document.querySelectorAll('.notice,[role="alert"]')).map((node) => node.textContent),
        applyButton: document.querySelector('button[data-action="assistant-flow-apply"]')?.outerHTML || ''
      }));
      throw new Error(`Assistant Object Flow apply did not start: ${JSON.stringify(diagnostic)} cause=${error.message || String(error)}`);
    }
    assert.equal(applyResponse.status(), 200, await applyResponse.text());
    await page.waitForFunction(() => /изменения готовы|changes are ready/i.test(String(document.querySelector('.notice')?.textContent || '')), null, { timeout: 30_000 });

    await page.locator('a[data-designer-section="extraction"]').click();
    await page.waitForSelector('#cmdp-extraction-editor', { timeout: 10_000 });
    const extractionOptions = await extractionResultOptions(page);
    assert.deepEqual(
      extractionOptions.map((item) => item.value),
      [flowBody.flow.selections[0].alias, flowBody.flow.selections[1].alias],
      `Extraction must list each Assistant business result once: ${JSON.stringify(extractionOptions)}`
    );
    assert.match(extractionOptions[0].text, /Маршрутизатор/i);
    assert.equal(extractionOptions[1].text, 'АРМ в местоположении маршрутизатора');
    assert.equal(extractionOptions[1].text.includes('Final result'), false);
    assert.equal(extractionOptions.some((item) => /routerAnchor|\barms\b/i.test(item.text)), false, `Extraction must not show technical aliases: ${JSON.stringify(extractionOptions)}`);
    const finalExtractionSource = extractionOptions.find((item) => item.text === 'АРМ в местоположении маршрутизатора')?.value || '';
    assert.ok(finalExtractionSource, `Extraction source options do not include a final matching stage: ${JSON.stringify(extractionOptions)}`);
    await page.locator('#cmdp-extraction-source').selectOption(finalExtractionSource);
    const extractionPreviewRoute = /\/cmdbuild\/custom-api\/draft\/preview\?maxRows=100&includeDiagrams=false&extractionSource=[^&]+$/;
    let delayedExtractionPreview = false;
    await page.route(extractionPreviewRoute, async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      delayedExtractionPreview = true;
      await route.fulfill({ response });
    });
    const extractionStartedAt = Date.now();
    const extractionResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview'), { timeout: 60_000 });
    await page.locator('button[data-action="extract-template"]').first().click();
    const extractionResponse = await extractionResponsePromise;
    const extractionBody = await extractionResponse.json();
    assert.equal(extractionResponse.status(), 200, `Assistant extraction failed: ${JSON.stringify(extractionBody)}`);
    assert.equal(delayedExtractionPreview, true, 'The browser regression must delay the extraction preview past the legacy 15s timeout.');
    assert.ok(Date.now() - extractionStartedAt >= 15_500, 'Extraction preview was not delayed beyond the legacy 15s browser timeout.');
    await page.unroute(extractionPreviewRoute);
    const extractionTables = extractionBody?.result?.tables || [];
    const finalExtractionTable = extractionTables.find((table) => table.name === finalExtractionSource);
    const extractionResultRows = finalExtractionTable?.rows || [];
    assert.ok(
      extractionResultRows.some((row) => /ARM|АРМ/i.test(JSON.stringify(row)) && /300|Test City/i.test(JSON.stringify(row))),
      `Assistant final extraction JSON has no Test City 300 ARM rows: ${JSON.stringify({ source: finalExtractionSource, trace: extractionBody?.result?.trace, tables: extractionTables })}`
    );
    await page.waitForSelector('#cmdp-extraction-editor tbody tr', { timeout: 10_000 });
    const extractionRows = await extractionPreviewRows(page);
    assert.ok(extractionRows.length > 0, 'Assistant draft extraction rendered no result rows.');
    assert.ok(extractionRows.some((row) => /ARM|АРМ/i.test(row) && /300|Test City/i.test(row)), `Assistant draft extraction rows do not look like Test City 300 ARM cards: ${JSON.stringify(extractionRows.slice(0, 5))}`);

    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
    assert.equal(await page.locator('[data-object-selection-field="columns"]').count(), 0, 'Object Group must not expose internal result projections.');
    assert.ok(await page.locator('button[data-action="remove-object-selection"]').count() > 0, 'Object Group must expose removal for an open selection.');
    // The editor keeps one Object Flow selection open. Read the first source,
    // then expand and read the source-driven selection without changing that UX.
    const firstSelection = (await objectGroupSelections(page))[0];
    await page.locator('[data-object-selection-summary] button[data-action="object-selection-expand"]').click();
    const secondSelection = (await objectGroupSelections(page))[0];
    const selections = [firstSelection, secondSelection];
    const routerSelection = selections.find((item) => item.className === 'routerG');
    const armSelection = selections.find((item) => item.className === 'ARM');
    assert.ok(routerSelection, `routerG object selection was not rendered: ${JSON.stringify(selections)}`);
    assert.ok(armSelection, `ARM object selection was not rendered: ${JSON.stringify(selections)}`);
    assert.ok(routerSelection.rules.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.rightExpression === 'Маршрутизатор для Test City 300'), `routerG selection has no exact Description filter: ${JSON.stringify(routerSelection.rules)}`);
    assert.equal(armSelection.from, routerSelection.alias, `ARM selection is not source-driven from the router anchor: ${JSON.stringify(armSelection)}`);
    assert.ok(armSelection.rules.some((rule) => rule.path === 'Location' && rule.rightExpression === '${previous.Location}'), `ARM selection has no source-row expression filter: ${JSON.stringify(armSelection.rules)}`);
    assert.equal(await page.locator('[data-object-scope-field="valueParam"], [data-object-scope-field="valueColumn"]').count(), 0);
    await page.locator('a[data-designer-section="relations"]').click();
    await page.waitForSelector('#cmdp-relation-expansion-editor', { timeout: 10_000 });
    assert.equal(await page.locator('[data-matching-block]').count(), 0);

    await page.locator('a[data-designer-section="final-view"]').click();
    await page.waitForSelector('#cmdp-view-composer-editor', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const values = Array.from(document.querySelectorAll('[data-view-column-field="field"] option')).map((option) => option.value);
      return values.some((value) => value === 'model' || /[._]model$/.test(value))
        && values.some((value) => value === 'model2' || /[._]model2$/.test(value));
    }, null, { timeout: 30_000 });
    const finalFieldOptions = await viewComposerFieldOptions(page);
    const modelField = finalFieldOptions.find((field) => field === 'model' || /[._]model$/.test(field));
    const model2Field = finalFieldOptions.find((field) => field === 'model2' || /[._]model2$/.test(field));
    assert.ok(modelField, `Final data field options do not include model: ${JSON.stringify(finalFieldOptions)}`);
    assert.ok(model2Field, `Final data field options do not include model2: ${JSON.stringify(finalFieldOptions)}`);
    const finalRowsBeforeAutoAdd = await page.locator('[data-view-column-row]').count();
    await setViewComposerColumns(page, [
      { field: modelField, title: 'model' },
      { field: model2Field, title: 'model2' }
    ]);
    const finalRowsAfterAutoAdd = await page.locator('[data-view-column-row]').count();
    assert.ok(finalRowsAfterAutoAdd >= finalRowsBeforeAutoAdd + 2, `Final data did not auto-add rows after filling the last empty row: before=${finalRowsBeforeAutoAdd} after=${finalRowsAfterAutoAdd}`);
    await page.locator('button[data-action="apply-view-composer"]').first().click();
    await page.locator('a[data-designer-section="run"]').click();
    await page.waitForSelector('button[data-action="visualize-editor"]', { timeout: 10_000 });
    await page.locator('button[data-action="visualize-editor"]').first().click();
    await page.waitForSelector('[data-result-table]', { timeout: 60_000 });
    const headers = await visibleResultHeaders(page);
    assert.ok(headers.includes('model'), `Assistant preview headers do not include model: ${JSON.stringify(headers)}`);
    assert.ok(headers.includes('model2'), `Assistant preview headers do not include model2: ${JSON.stringify(headers)}`);
    const rows = await visibleResultRows(page);
    assert.ok(rows.length > 0, 'Assistant preview rendered no result rows.');
    assert.ok(rows.some((row) => /ARM|АРМ/i.test(row) && /300|Test City/i.test(row)), `Assistant preview rows do not look like Test City 300 ARM cards: ${JSON.stringify(rows.slice(0, 5))}`);
    const headerCells = await visibleResultHeaderCells(page);
    const tableRows = await visibleResultTableRows(page);
    const modelIndex = headerCells.indexOf('model');
    const model2Index = headerCells.indexOf('model2');
    assert.ok(modelIndex >= 0, `Assistant preview header cells do not include model: ${JSON.stringify(headerCells)}`);
    assert.ok(model2Index >= 0, `Assistant preview header cells do not include model2: ${JSON.stringify(headerCells)}`);
    assert.ok(tableRows.every((row) => row.length > modelIndex), `Assistant preview did not render model cells: ${JSON.stringify(tableRows.slice(0, 5))}`);
    assert.ok(tableRows.every((row) => row.length > model2Index), `Assistant preview did not render model2 cells: ${JSON.stringify(tableRows.slice(0, 5))}`);
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/plan?*');
    await page.unroute('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*');
    await page.locator('a[data-designer-section="templates"]').click();
    const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
    await deleteButton.waitFor({ timeout: 10_000 });
    page.once('dialog', (dialog) => dialog.accept());
    const deleteResponsePromise = page.waitForResponse((response) => response.url().includes(`/cmdbuild/custom-api/templates/${code}`) && response.request().method() === 'DELETE');
    await deleteButton.click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 200, await deleteResponse.text());
  });
});

test('Runtime page renders the compact runtime shell and table area', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.goto(runtimeUrl(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.runtime-page', { timeout: 10_000 });
    await page.waitForSelector('main#app', { timeout: 10_000 });
    await page.waitForTimeout(500);

    assert.equal(await page.locator('header').count(), 0);
    const hasResultShell = await page.locator('.result-table-wrap, .notice').count();
    assert.ok(hasResultShell > 0, 'Runtime page did not render a result table or notice.');
  });
});

test('Runtime renders normalized URL values as safe automatic links', { skip: skipReason }, async () => {
  await withPage(async (page) => {
    await page.route('**/cmdbuild/custom-api/templates/*/run**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          result: {
            tables: [{
              name: 'urls',
              title: 'URLs',
              columns: ['PortalUrl', 'UnsafeUrl'],
              rows: [{ PortalUrl: 'https://portal.example/item/42', UnsafeUrl: 'javascript:alert(1)' }],
              cellMeta: {
                0: {
                  PortalUrl: { autoHref: 'https://portal.example/item/42' },
                  UnsafeUrl: {}
                }
              },
              presentation: {}
            }]
          }
        })
      });
    });
    await page.goto(runtimeUrl(), { waitUntil: 'domcontentloaded' });
    const table = page.locator('[data-result-table]').first();
    await table.waitFor({ timeout: 15_000 });
    const portalLink = table.locator('a[href="https://portal.example/item/42"]');
    await portalLink.waitFor({ timeout: 10_000 });
    assert.equal(await portalLink.innerText(), 'https://portal.example/item/42');
    assert.equal(await table.locator('a[href^="javascript:"]').count(), 0);
    assert.match(await table.innerText(), /javascript:alert\(1\)/);
  });
});

test('Runtime cache header stays readable on a narrow viewport', { skip: skipReason }, async (t) => {
  const url = `${nginxOrigin}/cmdbuild/dynamicpages/ui/run/${encodeURIComponent(runtimeCacheLayoutTemplate)}`;
  const probe = await request('GET', `${url}?json=1`, undefined, { cookie: cookieHeader });
  if (probe.statusCode !== 200) {
    t.skip(`Runtime cache layout template is not available: HTTP ${probe.statusCode}.`);
    return;
  }
  let json = {};
  try {
    json = JSON.parse(probe.body || '{}');
  } catch {
    t.skip('Runtime cache layout template did not return JSON.');
    return;
  }
  if (!json.cache || !json.cache.enabled) {
    t.skip('Runtime cache layout template does not expose cache metadata.');
    return;
  }

  await withPage(async (page) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.result-table-title h3, .runtime-notice-shell .notice', { timeout: 10_000 });

    const title = page.locator('.result-table-title h3').first();
    if (await title.count()) {
      const titleBox = await title.boundingBox();
      const titleText = (await title.innerText()).trim();
      assert.ok(titleBox && titleBox.height <= 80, `Runtime cache table title may wrap per character: ${JSON.stringify(titleBox)}`);
      if (titleText.length > 20) {
        assert.ok(titleBox && titleBox.width >= 180, `Long runtime cache table title is too narrow: ${JSON.stringify({ titleText, titleBox })}`);
      }
      assert.ok(titleText.length > 4, 'Runtime cache table title is unexpectedly empty.');
    } else {
      const notice = page.locator('.runtime-notice-shell .notice').first();
      const noticeBox = await notice.boundingBox();
      assert.ok(noticeBox && noticeBox.width >= 180, `Runtime cache notice is too narrow: ${JSON.stringify(noticeBox)}`);
      assert.match(await notice.innerText(), /Страница отсутствует|В результате|not found|No/i);
    }

    assert.equal(await page.locator('[data-runtime-cache] [data-action="runtime-refresh"]').count(), 1);
    await page.locator('[data-runtime-cache] [data-action="runtime-refresh"]').hover();
    assert.ok(await page.locator('.runtime-cache-tooltip').first().isVisible());
  }, { cookieOrigin: originFromUrl(nginxOrigin) || nginxOrigin });
});

test('Runtime table search and sort work on rendered rows', { skip: skipReason }, async (t) => {
  await withPage(async (page) => {
    await page.goto(runtimeUrl(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.runtime-page', { timeout: 10_000 });
    await page.waitForSelector('main#app', { timeout: 10_000 });
    await page.waitForTimeout(500);

    const table = page.locator('[data-result-table]').first();
    if (await table.count() === 0) {
      t.skip('Runtime did not render a table for the current template.');
      return;
    }

    const filter = table.locator('[data-result-filter]').first();
    const sortButton = table.locator('[data-result-sort]').first();
    const rowCount = await table.locator('tr[data-result-row]').count();
    if (await filter.count() === 0 || await sortButton.count() === 0 || rowCount < 2) {
      t.skip('Current runtime table does not expose filter/sort controls with at least two rows.');
      return;
    }

    const filterToken = await bestFilterToken(table);
    if (!filterToken) {
      t.skip('Current runtime table has no selective cell text for filter verification.');
      return;
    }
    await filter.fill(filterToken);
    const visibleAfterFilter = await visibleRowTexts(table);
    assert.ok(visibleAfterFilter.length >= 1, 'Filter hid every row.');
    assert.ok(visibleAfterFilter.every((text) => text.toLowerCase().includes(filterToken.toLowerCase())), 'Filter left a non-matching row visible.');
    await filter.fill('');

    const before = await columnValuesForButton(table, sortButton);
    const comparable = before.filter((value) => value !== '');
    if (new Set(comparable).size < 2) {
      t.skip('First sortable column does not have varied values.');
      return;
    }
    await sortButton.click();
    const desc = await columnValuesForButton(table, sortButton);
    assert.deepEqual(desc, sortedValues(desc, 'desc'), 'Runtime sort button did not sort the column descending.');
    await sortButton.click();
    const asc = await columnValuesForButton(table, sortButton);
    assert.deepEqual(asc, sortedValues(asc, 'asc'), 'Runtime sort button did not sort the column ascending.');
  });
});

test('Runtime row grouping disables table controls', { skip: skipReason }, async (t) => {
  await withPage(async (page) => {
    await page.goto(runtimeUrl(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.runtime-page', { timeout: 10_000 });
    await page.waitForSelector('main#app', { timeout: 10_000 });
    await page.waitForTimeout(500);

    const groupedTable = page.locator('[data-result-table]').filter({ has: page.locator('.cmdp-row-group-cell') }).first();
    if (await groupedTable.count() === 0) {
      t.skip('Current runtime template does not render a grouped table.');
      return;
    }

    assert.equal(await groupedTable.locator('[data-result-filter]').count(), 0);
    assert.equal(await groupedTable.locator('[data-result-sort]').count(), 0);
    assert.ok(await groupedTable.locator('.result-table-note').isVisible());
  });
});

test('Runtime subtable sorting stays local to each rendered group', { skip: skipReason }, async (t) => {
  await withPage(async (page) => {
    await page.goto(runtimeUrl(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.runtime-page', { timeout: 10_000 });
    await page.waitForSelector('main#app', { timeout: 10_000 });
    await page.waitForTimeout(500);

    const table = page.locator('[data-result-table]').filter({ has: page.locator('[data-result-group]') }).first();
    if (await table.count() === 0 || await table.locator('[data-result-group]').count() < 2 || await table.locator('[data-result-sort]').count() === 0) {
      t.skip('Current runtime template does not render sortable split subtables.');
      return;
    }

    const sortButton = table.locator('[data-result-sort]').first();
    await sortButton.click();
    const groups = await groupedColumnValuesForButton(table, sortButton);
    if (groups.length < 2 || groups.some((group) => new Set(group.filter(Boolean)).size < 2)) {
      t.skip('Rendered subtables do not have varied values for local sort verification.');
      return;
    }
    groups.forEach((group) => {
      assert.deepEqual(group, sortedValues(group, 'desc'));
    });
  });
});

test('Assistant data blocks collapse, retain forward dependencies, and support mouse reordering', { skip: skipReason, timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });

    await addAssistantBusinessBlock(page, {
      name: 'Applications',
      entities: 'Application cards.',
      algorithm: 'Select applications.',
      expectedResult: 'Application cards.'
    });
    await page.locator('[data-assistant-flow-details] > summary').first().click();
    await page.locator('button[data-action="assistant-flow-block-add"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-assistant-flow-block]').length === 2);
    await addAssistantBusinessBlock(page, {
      name: 'Networks',
      entities: 'ipRange cards.',
      algorithm: 'Select networks.',
      expectedResult: 'Network cards.'
    });

    const blocks = page.locator('[data-assistant-flow-block]');
    assert.equal(await blocks.nth(0).locator('[data-assistant-flow-details]').evaluate((node) => node.open), false);
    assert.equal(await blocks.nth(1).locator('[data-assistant-flow-details]').evaluate((node) => node.open), true);
    assert.equal(await page.locator('[data-action="assistant-flow-block-up"], [data-action="assistant-flow-block-down"]').count(), 0);
    assert.equal(await blocks.nth(0).locator('[data-action="assistant-flow-block-remove"]').isVisible(), false);
    assert.equal(await blocks.nth(1).locator('[data-action="assistant-flow-block-remove"]').isVisible(), true);
    const titleLayout = await blocks.nth(1).locator('[data-assistant-flow-details] > summary').evaluate((summary) => {
      const label = summary.querySelector('.assistant-flow-business-summary strong').getBoundingClientRect();
      const name = summary.querySelector('[data-assistant-flow-summary-name]').getBoundingClientRect();
      return { labelLeft: label.left, labelTop: label.top, labelRight: label.right, nameLeft: name.left, nameTop: name.top };
    });
    assert.ok(titleLayout.nameLeft >= titleLayout.labelRight, JSON.stringify(titleLayout));
    assert.ok(Math.abs(titleLayout.nameTop - titleLayout.labelTop) <= 2, JSON.stringify(titleLayout));
    await blocks.nth(0).locator('[data-assistant-flow-details] > summary').click();
    await blocks.nth(0).locator('[data-assistant-flow-field="uses"]').selectOption('block-2');
    assert.equal(await page.locator('[data-assistant-flow-dependency-warning]').isVisible(), true);
    assert.equal(await page.locator('button[data-action="assistant-flow-prepare"]').isDisabled(), false);

    await blocks.nth(1).locator('[data-assistant-flow-drag-handle]').dragTo(blocks.nth(0));
    await page.waitForFunction(() => document.querySelector('[data-assistant-flow-block]')?.getAttribute('data-assistant-flow-block') === 'block-2');
    assert.equal(await page.locator('[data-assistant-flow-block]').nth(1).locator('[data-assistant-flow-field="uses"]').evaluate((select) => Array.from(select.selectedOptions).map((option) => option.value).includes('block-2')), true);
    assert.equal(await page.locator('button[data-action="assistant-flow-prepare"]').isDisabled(), false);
  });
});

test('Object Group exposes one right expression for parameters and previous-result fields', { skip: skipReason, timeout: 90_000 }, async () => {
  await withPage(async (page) => {
    const code = `ObjectGroupRightExpressionUiSmoke${Date.now()}`;
    const semanticPlan = {
      version: 1,
      blocks: [{
        id: 'block-1',
        name: 'Маршрутизатор',
        summary: 'Маршрутизатор по параметру.',
        resolvedEntities: ['routerG'],
        relationPaths: [],
        dependencies: [],
        expectedResult: 'Карточка маршрутизатора.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'routerG', dependencyPaths: [], relationPredicates: [], attributePredicates: [] },
        warnings: []
      }, {
        id: 'block-2',
        name: 'АРМ маршрутизатора',
        summary: 'АРМ с тем же Location.',
        resolvedEntities: ['ARM'],
        relationPaths: [],
        dependencies: ['block-1'],
        expectedResult: 'Карточки АРМ.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ARM', dependencyPaths: [], relationPredicates: [],
          attributePredicates: [{
            sourceClass: 'ARM', comparisonBlockId: 'block-1', comparisonClass: 'routerG',
            sourceFields: ['Location'], comparisonField: 'Location', operator: 'equals'
          }]
        },
        warnings: []
      }],
      explanation: 'Семантический план готов.',
      warnings: []
    };
    const flow = {
      version: 1,
      selections: [{
        id: 'selection:router', name: 'Маршрутизатор', alias: 'router', className: 'routerG', from: '', limit: 10,
        columns: ['Code', 'Location'],
        rules: [{ action: 'include', path: 'Description', negate: false, op: 'matches', rightExpression: '^${param.routerName}$' }]
      }, {
        id: 'selection:arms', name: 'АРМ маршрутизатора', alias: 'arms', className: 'ARM', from: 'router', limit: 100,
        columns: ['Code', 'Location'],
        rules: [{ action: 'include', path: 'Location', negate: false, op: 'equals', rightExpression: '${previous.Location}' }]
      }],
      operations: [], blocks: [], setOperations: [], publishedAlias: 'arms'
    };

    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.locator('#cmdp-code').fill(code);
    await page.locator('#cmdp-description').fill('Object Group right expression UI smoke');
    const createResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/templates') && response.request().method() === 'POST');
    await page.locator('button[data-action="save-template"]').click();
    const createResponse = await createResponsePromise;
    assert.equal(createResponse.status(), 201, await createResponse.text());

    try {
      await page.locator(`[data-action="select-template"][data-code="${code}"]`).click();
      await page.locator('a[data-designer-section="assistant"]').click();
      await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
      await addAssistantBusinessBlock(page, { name: 'Маршрутизатор', entities: 'routerG', algorithm: 'Выбрать маршрутизатор.', expectedResult: 'Карточка маршрутизатора.' });
      await page.locator('button[data-action="assistant-flow-block-add"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-assistant-flow-block]').length === 2);
      await addAssistantBusinessBlock(page, { name: 'АРМ маршрутизатора', entities: 'ARM', algorithm: 'Выбрать АРМ по Location.', expectedResult: 'Карточки АРМ.' });
      await page.locator('[data-assistant-flow-block]').nth(1).locator('[data-assistant-flow-field="uses"]').selectOption('block-1');
      await page.route('**/cmdbuild/custom-api/assistant/object-flow/semantic-plan?*', async (route) => {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, semanticPlan }) });
      });
      await page.route('**/cmdbuild/custom-api/assistant/object-flow/plan?*', async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true, flow, canApply: true,
            outputBindings: [{ blockId: 'block-1', alias: 'router' }, { blockId: 'block-2', alias: 'arms' }],
            explanation: 'Flow ready.', warnings: []
          })
        });
      });
      await page.locator('button[data-action="assistant-flow-prepare"]').click();
      await page.locator('[data-assistant-flow-semantic-plan]').waitFor({ timeout: 30_000 });
      await page.locator('button[data-action="assistant-flow-generate"]').click();
      await page.waitForFunction(() => !document.querySelector('button[data-action="assistant-flow-apply"]')?.disabled, null, { timeout: 30_000 });
      await page.locator('button[data-action="assistant-flow-apply"]').click();
      await page.waitForFunction(() => /изменения готовы|changes are ready/i.test(String(document.querySelector('.notice')?.textContent || '')), null, { timeout: 30_000 });

      await page.locator('a[data-designer-section="object-group"]').click();
      await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
      assert.equal(await page.locator('[data-object-scope-field="rightExpression"]').count(), 1);
      assert.equal(await page.locator('[data-object-scope-field="value"], [data-object-scope-field="valueParam"], [data-object-scope-field="valueColumn"]').count(), 0);
      assert.equal(await page.locator('[data-object-scope-field="rightExpression"]').inputValue(), '^${param.routerName}$');
      await page.locator('[data-object-selection-summary] button[data-action="object-selection-expand"]').click();
      await page.locator('[data-object-scope-field="rightExpression"]').waitFor({ timeout: 10_000 });
      assert.equal(await page.locator('[data-object-scope-field="rightExpression"]').inputValue(), '${previous.Location}');
      await page.locator('#cmdp-object-group-editor details summary').last().click();
      const examples = await page.locator('#cmdp-object-group-editor').innerText();
      assert.match(examples, /предыдущего результата|previous result/i);
      assert.match(examples, /параметр шаблона|template parameter/i);
    } finally {
      await page.locator('a[data-designer-section="templates"]').click();
      const deleteButton = page.locator(`[data-action="delete-template"][data-code="${code}"]`);
      if (await deleteButton.count()) {
        page.once('dialog', (dialog) => dialog.accept());
        await deleteButton.click();
      }
    }
  });
});

async function withPage(fn, options = {}) {
  const launchOptions = { headless: true };
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || findChromeExecutable();
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await playwright.chromium.launch(launchOptions);
  try {
    const context = await browser.newContext();
    await context.addCookies(cookiesForOrigin(cookieHeader, options.cookieOrigin || proxyOrigin));
    const page = await context.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function objectGroupSelections(page) {
  return await page.locator('[data-object-selection]').evaluateAll((nodes) => nodes.map((node) => {
    function value(selector) {
      const field = node.querySelector(selector);
      if (field && field.matches('[data-catalog-field-picker-multi-value]')) {
        return Array.from(field.selectedOptions).map((option) => String(option.value || '').trim()).filter(Boolean).join(', ');
      }
      return String(field && field.value || '').trim();
    }
    const rules = Array.from(node.querySelectorAll('[data-object-scope-row]')).map((row) => {
      function ruleValue(selector) {
        const field = row.querySelector(selector);
        return String(field && field.value || '').trim();
      }
      return {
        path: ruleValue('[data-object-scope-field="path"]'),
        op: ruleValue('[data-object-scope-field="op"]'),
        rightExpression: ruleValue('[data-object-scope-field="rightExpression"]')
      };
    });
    return {
      name: value('[data-object-selection-field="name"]'),
      alias: value('[data-object-selection-field="alias"]'),
      className: value('[data-object-selection-field="className"]'),
      from: value('[data-object-selection-field="from"]'),
      limit: value('[data-object-selection-field="limit"]'),
      columns: value('[data-object-selection-field="columns"]'),
      rules
    };
  }));
}

async function visibleResultRows(page) {
  return await page.locator('[data-result-table] tr[data-result-row]').evaluateAll((rows) => rows
    .filter((row) => getComputedStyle(row).display !== 'none')
    .map((row) => String(row.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function visibleResultTableRows(page) {
  return await page.locator('[data-result-table]').first().locator('tr[data-result-row]').evaluateAll((rows) => rows
    .filter((row) => getComputedStyle(row).display !== 'none')
    .map((row) => Array.from(row.querySelectorAll('td')).map((cell) => String(cell.textContent || '').replace(/\s+/g, ' ').trim())));
}

async function visibleResultHeaderCells(page) {
  return await page.locator('[data-result-table]').first().locator('th').evaluateAll((headers) => headers
    .map((header) => String(header.textContent || '').replace(/\s+/g, ' ').trim()));
}

async function visibleResultHeaders(page) {
  return await page.locator('[data-result-table]').first().locator('th').evaluateAll((headers) => headers
    .map((header) => String(header.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function launchUrlLayoutMetrics(page, selector) {
  return await page.locator(selector).evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      text: String(node.textContent || '').trim(),
      width: box.width,
      height: box.height,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      whiteSpace: style.whiteSpace
    };
  });
}

async function assertMenuLinkDisabled(page, section) {
  const link = page.locator(`a[data-designer-section="${section}"]`);
  assert.equal(await link.getAttribute('aria-disabled'), 'true');
  const className = await link.getAttribute('class');
  assert.match(className || '', /\bdisabled\b/);
}

async function extractionResultOptions(page) {
  return await page.locator('#cmdp-extraction-source option').evaluateAll((options) => options
    .map((option) => ({
      value: String(option.value || '').trim(),
      text: String(option.textContent || '').replace(/\s+/g, ' ').trim()
    }))
    .filter((option) => option.value || option.text));
}

async function extractionPreviewRows(page) {
  return await page.locator('#cmdp-extraction-editor tbody tr').evaluateAll((rows) => rows
    .filter((row) => getComputedStyle(row).display !== 'none')
    .map((row) => String(row.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function viewComposerFieldOptions(page) {
  return await page.locator('[data-view-column-field="field"]').first().locator('option').evaluateAll((options) => options
    .map((option) => String(option.value || '').trim())
    .filter(Boolean));
}

async function setViewComposerColumns(page, columns) {
  for (const column of columns) {
    const rowsBefore = await page.locator('[data-view-column-row]').count();
    await page.locator('#cmdp-view-column-rows').evaluate((body, desiredColumn) => {
      const rows = Array.from(body.querySelectorAll('[data-view-column-row]'));
      const row = rows[rows.length - 1];
      if (!row) throw new Error(`Missing empty Final data row for ${desiredColumn.field}`);
      const field = row.querySelector('[data-view-column-field="field"]');
      const title = row.querySelector('[data-view-column-field="title"]');
      if (!field || !Array.from(field.options).some((option) => option.value === desiredColumn.field)) {
        throw new Error(`Final data field option is missing: ${desiredColumn.field}`);
      }
      field.value = desiredColumn.field;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      if (title) {
        title.value = desiredColumn.title || desiredColumn.field;
        title.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, column);
    await page.waitForFunction((expectedMinimum) => {
      return document.querySelectorAll('[data-view-column-row]').length > expectedMinimum;
    }, rowsBefore, { timeout: 5_000 });
  }
}

function runtimeUrl() {
  return `${proxyOrigin}/cmdbuild/dynamicpages/ui/run/${encodeURIComponent(runtimeTemplate)}?attrType=${encodeURIComponent(runtimeAttrType)}`;
}

async function bestFilterToken(table) {
  const rows = await table.locator('tr[data-result-row]').evaluateAll((nodes) => nodes.map((row) => {
    const cells = Array.from(row.querySelectorAll('td')).map((cell) => String(cell.textContent || '').trim()).filter(Boolean);
    return { text: String(row.getAttribute('data-filter-text') || '').toLowerCase(), cells };
  }));
  const total = rows.length;
  const candidates = [];
  rows.forEach((row) => {
    row.cells.forEach((cell) => {
      const token = cell.trim();
      if (token.length >= 2 && token.length <= 80) candidates.push(token);
    });
  });
  const unique = Array.from(new Set(candidates));
  unique.sort((left, right) => {
    const leftCount = rows.filter((row) => row.text.includes(left.toLowerCase())).length;
    const rightCount = rows.filter((row) => row.text.includes(right.toLowerCase())).length;
    return leftCount - rightCount || left.length - right.length;
  });
  return unique.find((token) => {
    const count = rows.filter((row) => row.text.includes(token.toLowerCase())).length;
    return count > 0 && count < total;
  }) || '';
}

async function visibleRowTexts(table) {
  return await table.locator('tr[data-result-row]').evaluateAll((rows) => rows
    .filter((row) => getComputedStyle(row).display !== 'none')
    .map((row) => String(row.getAttribute('data-filter-text') || row.textContent || '')));
}

async function columnValuesForButton(table, sortButton) {
  const index = Number(await sortButton.getAttribute('data-column-index') || 0);
  return await table.locator('tbody').first().locator('tr[data-result-row]').evaluateAll((rows, columnIndex) => rows.map((row) => String(row.children[columnIndex] && row.children[columnIndex].textContent || '').trim()), index);
}

async function groupedColumnValuesForButton(table, sortButton) {
  const index = Number(await sortButton.getAttribute('data-column-index') || 0);
  return await table.locator('tbody').evaluateAll((bodies, columnIndex) => bodies.map((body) => Array.from(body.querySelectorAll('tr[data-result-row]')).map((row) => String(row.children[columnIndex] && row.children[columnIndex].textContent || '').trim())), index);
}

function sortedValues(values, direction) {
  const multiplier = direction === 'desc' ? -1 : 1;
  return values.slice().sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const result = !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && left !== '' && right !== ''
      ? leftNumber - rightNumber
      : left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    return result * multiplier;
  });
}

function originFromUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

async function loadPlaywright() {
  try {
    const mod = await import('playwright');
    return mod.chromium ? mod : null;
  } catch {
    try {
      const mod = await import('@playwright/test');
      return mod.chromium ? mod : null;
    } catch {
      return null;
    }
  }
}

async function canReach(url) {
  try {
    const result = await request('GET', url, undefined, {}, 1500);
    return result.statusCode > 0;
  } catch {
    return false;
  }
}

async function hasValidSession(cookie) {
  try {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/session`, undefined, { cookie });
    if (result.statusCode !== 200) return false;
    const json = JSON.parse(result.body || '{}');
    return json.success === true;
  } catch {
    return false;
  }
}

async function templateCodeExists(cookie, code) {
  try {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates?limit=1000`, undefined, { cookie });
    if (result.statusCode !== 200) return false;
    const json = JSON.parse(result.body || '{}');
    const data = Array.isArray(json.data) ? json.data : [];
    return data.some((item) => String(item.code || item.Code || '') === code);
  } catch {
    return false;
  }
}

async function loginCmdbuild() {
  const payload = {
    username: loginUsername,
    password: loginPassword
  };
  if (loginRole) payload.role = loginRole;
  const origins = uniqueValues([
    process.env.CMDBUILD_LOGIN_ORIGIN || '',
    proxyOrigin,
    process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090'
  ]);
  const errors = [];
  for (const origin of origins) {
    try {
      const url = `${origin.replace(/\/+$/, '')}/cmdbuild/services/rest/v3/sessions?scope=${encodeURIComponent(loginScope)}`;
      const result = await request('POST', url, payload, {}, 10_000);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        errors.push(`${origin}: HTTP ${result.statusCode}`);
        continue;
      }
      const header = cookieHeaderFromLoginResponse(result);
      if (header) return header;
      errors.push(`${origin}: login response did not include CMDBuild-Authorization`);
    } catch (error) {
      errors.push(`${origin}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  throw new Error(`CMDBuild login failed. ${errors.join('; ')}`);
}

function cookieHeaderFromLoginResponse(result) {
  const setCookie = result.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const cookie of cookies) {
    const token = cookieValue(cookie, 'CMDBuild-Authorization');
    if (token) return `CMDBuild-Authorization=${token}`;
  }
  try {
    const json = JSON.parse(result.body || '{}');
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    const token = data._id || data.token || data.sessionId || json._id || json.token || json.sessionId || '';
    if (token) return `CMDBuild-Authorization=${token}`;
  } catch {
    return '';
  }
  return '';
}

function cookieValue(header, name) {
  const firstPart = String(header || '').split(';')[0] || '';
  const index = firstPart.indexOf('=');
  if (index === -1) return '';
  return firstPart.slice(0, index).trim() === name ? firstPart.slice(index + 1).trim() : '';
}

function request(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      accept: 'application/json,text/html,*/*',
      ...extraHeaders
    };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = transport.request({
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function findChromeExecutable() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  return candidates.find((item) => fs.existsSync(item)) || '';
}

function uniqueValues(values) {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
}

function cookiesForOrigin(header, origin) {
  const target = new URL(origin);
  return String(header || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf('=');
      return {
        name: eq === -1 ? item : item.slice(0, eq),
        value: eq === -1 ? '' : item.slice(eq + 1),
        domain: target.hostname,
        path: '/'
      };
    })
    .filter((cookie) => cookie.name);
}

function readCookieJar(path) {
  if (!fs.existsSync(path)) return '';
  const cookies = [];
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (let line of lines) {
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) {
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\t/);
    if (parts.length >= 7) {
      cookies.push(`${parts[5]}=${parts.slice(6).join('\t')}`);
    }
  }
  return cookies.join('; ');
}

function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
