import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const nginxOrigin = process.env.CMDBDYNAMIC_NGINX_ORIGIN || 'http://localhost:8088';
const wikiIframeUrl = process.env.CMDBDYNAMIC_WIKI_IFRAME_URL || '';
const cookieJar = process.env.CMDBUILD_COOKIE_JAR || '/tmp/cmdbuild-ui-cookie.txt';
const runtimeTemplate = process.env.CMDBDYNAMIC_E2E_TEMPLATE || 'ProbeClassesByAttributeType';
const runtimeAttrType = process.env.CMDBDYNAMIC_E2E_ATTR_TYPE || 'reference';
const runtimeCacheLayoutTemplate = process.env.CMDBDYNAMIC_E2E_CACHE_TEMPLATE || 'testtemplate';
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
if (requireLiveUi && skipReason) {
  throw new Error(`Browser UI smoke is required but cannot run: ${skipReason}`);
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

    assert.equal(await page.locator('#cmdp-cache-editor').count(), 0);
    assert.match(new URL(page.url()).pathname, /\/cmdbuild\/dynamicpages\/ui\/designer\/?$/);
    assert.match(await page.locator('.notice').first().innerText(), /Select or create a template|Выберите или создайте шаблон/);
    await assertMenuLinkDisabled(page, 'cache');
    await assertMenuLinkDisabled(page, 'assistant');

    await page.locator('a[data-designer-section="cache"]').dispatchEvent('click');
    await page.waitForSelector('#cmdp-template-list', { timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-cache-editor').count(), 0);

    await page.locator('a[data-designer-section="schema"]').click();
    await page.waitForSelector('#cmdp-schema-manager', { timeout: 10_000 });
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

    assert.equal((await page.locator('a[data-designer-section="assistant"]').innerText()).trim(), 'Ассистент');
    assert.equal((await page.locator('#cmdp-assistant-editor h2').first().innerText()).trim(), 'Ассистент');
    assert.match(await page.locator('#cmdp-assistant-editor').innerText(), /Статус ассистента/);
    assert.doesNotMatch(await page.locator('#cmdp-assistant-editor').innerText(), /Provider|Base URL|Model|MCP context/);
    assert.equal(await page.locator('[data-object-selection], [data-matching-block], [data-matching-rule-row], [data-diagram-import-role-mapping]').count(), 0);
    assert.equal(await page.locator('#cmdp-assistant-diagram-mapping-prompt').count(), 1);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isDisabled(), true);

    const flowPrompt = page.locator('#cmdp-assistant-object-flow-prompt');
    assert.equal(await flowPrompt.isVisible(), true);
    assert.equal(await page.locator('[data-assistant-flow-selection], [data-assistant-flow-match]').count(), 0);
    const promptWidth = await flowPrompt.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const parentRect = node.parentElement.getBoundingClientRect();
      return { width: rect.width, parentWidth: parentRect.width };
    });
    assert.ok(promptWidth.width >= promptWidth.parentWidth - 1, JSON.stringify(promptWidth));
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
      const selection = page.locator('[data-object-selection]').nth(index);
      if (await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').count() === 0) {
        await page.locator('#cmdp-catalog-header').click();
        await selection.locator('[data-object-selection-field="className"] option[value="ARM"]').waitFor({ state: 'attached', timeout: 60_000 });
      }
      await selection.locator('[data-object-selection-field="className"]').selectOption('ARM');
      await selection.locator('[data-object-selection-field="columns"]').fill(index === 0 ? 'model' : index === 1 ? 'model2' : 'Location');
    }
    await page.locator('button[data-action="apply-object-group"]').click();
    await page.locator('a[data-designer-section="relations"]').click();
    await page.waitForSelector('#cmdp-relation-expansion-editor', { timeout: 10_000 });
    assert.equal(await page.locator('[data-matching-block]').count(), 0);
    await page.locator('button[data-action="add-matching-block"]').click();
    let matchingBlock = page.locator('[data-matching-block]').first();
    assert.deepEqual(await matchingBlock.locator('[data-matching-block-field="from"] option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean)), ['objects', 'objects2', 'objects3']);
    await matchingBlock.locator('[data-matching-block-field="from"]').selectOption('objects');
    await matchingBlock.locator('[data-matching-block-field="with"]').selectOption('objects2');
    await matchingBlock.locator('[data-matching-block-field="as"]').fill('matchedObjects');
    await page.locator('button[data-action="add-matching-block"]').click();
    matchingBlock = page.locator('[data-matching-block]').nth(1);
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
    await page.locator('[data-result-set-field="publishedAlias"]').selectOption('allArms');
    await page.locator('button[data-action="apply-relation-expansion"]').click();

    await page.locator('a[data-designer-section="assistant"]').click();
    const previewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview'));
    const previewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview'));
    await page.locator('button[data-action="draft-preview"]').click();
    const [previewRequest, previewResponse] = await Promise.all([previewRequestPromise, previewResponsePromise]);
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
    assert.equal(spec.result?.tables?.find((table) => table.name === 'allArms')?.published, true);
    const previewStatus = previewResponse.status();
    assert.equal(previewStatus, 200, previewStatus === 200 ? '' : await previewResponse.text());

    await page.locator('a[data-designer-section="relations"]').click();
    await page.locator('button[data-action="clear-matching-block"]').first().click();
    assert.equal(await page.locator('[data-matching-block]').count(), 2);
    await page.locator('[role="alert"]').waitFor({ timeout: 10_000 });
    assert.match(await page.locator('[role="alert"]').innerText(), /Cannot remove matchedObjects/);

    await page.locator('[data-set-operation-field="from"]').selectOption('');
    await page.locator('button[data-action="apply-relation-expansion"]').click();
    await page.locator('[role="alert"]').waitFor({ timeout: 10_000 });
    assert.match(await page.locator('[role="alert"]').innerText(), /requires both source aliases/);
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
    await page.goto(`${nginxOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('D2ImportPreviewUiSmoke');
    await page.locator('#cmdp-description').fill('D2 import preview UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    const importPreview = page.locator('[data-diagram-import-preview]');
    assert.equal(await importPreview.count(), 1);
    assert.equal(await importPreview.getAttribute('data-diagram-import-preview-state'), 'empty');
    assert.equal(await importPreview.isVisible(), true);
    assert.ok((await importPreview.boundingBox())?.height >= 240, 'Empty D2 preview area is not visibly reserved.');
    await page.locator('#cmdp-diagram-import-source').fill([
      'direction: right',
      'router: Router',
      'switch: Switch',
      'gateway: Gateway',
      'database: Database',
      'service: Service',
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

    assert.equal(await importPreview.getAttribute('data-diagram-import-preview-state'), 'rendered');
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').count(), 1);
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').isVisible(), true);
    assert.ok((await importPreview.locator('[data-d2-rendered-svg]').boundingBox())?.height >= 220, 'Rendered D2 SVG has no visible height.');
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
    const previewBeforeInterpretation = await page.locator('#cmdp-assistant-editor').evaluate((root) => {
      const preview = root.querySelector('[data-diagram-import-preview]');
      const interpretation = root.querySelector('.assistant-d2-prompt');
      return Boolean(preview && interpretation && (preview.compareDocumentPosition(interpretation) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(previewBeforeInterpretation, true, 'D2 preview must be rendered before D2 structure interpretation.');

    await page.locator('#cmdp-diagram-import-source').fill('router: Router\nswitch: Switch\nrouter -> switch: changed uplink');
    assert.equal(await page.locator('[data-diagram-import-stale]:visible').count(), 1);
    assert.equal(await importPreview.getAttribute('data-diagram-import-preview-state'), 'stale');
    assert.equal(await importPreview.locator('[data-d2-rendered-svg]').isVisible(), true);
    assert.match(await importPreview.locator('[data-diagram-import-preview-status]').innerText(), /previous|предыдущему/i);
    assert.deepEqual(pageErrors, []);
  }, { cookieOrigin: nginxOrigin });
});

test('Designer analyzes and applies a reviewed D2 structure template', { skip: skipReason, timeout: 180_000 }, async () => {
  await withPage(async (page) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));
    await page.goto(`${nginxOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('D2AssistantMappingUiSmoke');
    await page.locator('#cmdp-description').fill('D2 Assistant mapping UI smoke');
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
    await firstSelection.locator('[data-object-selection-field="columns"]').fill('Code, Description, model, model2');
    await page.locator('button[data-action="apply-object-group"]').click();
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });
    assert.equal(await page.locator('[data-object-selection], [data-matching-block]').count(), 0);
    assert.equal(await page.locator('#cmdp-diagram-import-source').count(), 1);
    assert.equal(await page.locator('#cmdp-assistant-diagram-mapping-prompt').count(), 1);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isDisabled(), true);
    await page.locator('#cmdp-diagram-import-source').fill([
      'classes: { workstation: { shape: person } }',
      'users: "Пользователи и отдельные подключения" {',
      '  operator: "Рабочее место оператора" { class: workstation }',
      '  administrator: "Рабочее место администратора" { class: workstation }',
      '}'
    ].join('\n'));
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
    const previewBeforeInterpretation = await page.locator('#cmdp-assistant-editor').evaluate((root) => {
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
    assert.equal(await page.locator('[data-diagram-import-role-row], [data-diagram-import-role-mapping], [data-diagram-import-rule-row], [data-diagram-import-placement-row]').count(), 0);
    assert.equal(await page.locator('button[data-action="diagram-import-apply"]').count(), 0);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isEnabled(), true);

    await page.locator('#cmdp-assistant-diagram-interpret-prompt').fill('Интерпретируй workstation как объект, а users как статический контейнер. Не меняй role id.');
    const interpretResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/diagram-import/interpret'));
    await page.locator('button[data-action="assistant-diagram-interpret"]').click();
    const interpretResponse = await interpretResponsePromise;
    const interpretBody = await interpretResponse.json();
    assert.equal(interpretResponse.status(), 200, `D2 interpretation Assistant failed: ${JSON.stringify(interpretBody)}`);
    assert.ok(interpretBody.decisions?.length > 0, JSON.stringify(interpretBody));
    assert.equal(interpretBody.decisions?.find((item) => item.roleId === workstationRole.id)?.semantic, 'object', JSON.stringify(interpretBody));
    assert.equal(await page.locator('#cmdp-assistant-editor').count(), 1);
    assert.equal(await page.locator('#cmdp-diagram-section-editor').count(), 0);

    await page.locator('#cmdp-assistant-diagram-mapping-prompt').fill('Сопоставь workstation с выборкой Workstations, users оставь статическим. Используй только доступные stage id.');
    const mappingResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/diagram-import/map-selections'));
    await page.locator('button[data-action="assistant-diagram-map"]').click();
    const mappingResponse = await mappingResponsePromise;
    const mappingBody = await mappingResponse.json();
    assert.equal(mappingResponse.status(), 200, `D2 mapping Assistant failed: ${JSON.stringify(mappingBody)}`);
    assert.ok(mappingBody.mappings?.some((item) => item.source?.stageId === 'selection:workstations'), JSON.stringify(mappingBody));

    const analyzedSource = await page.locator('#cmdp-diagram-import-source').inputValue();
    await page.locator('#cmdp-diagram-import-source').fill(`${analyzedSource}\n# changed`);
    assert.equal(await page.locator('[data-diagram-import-stale]:visible').count(), 1);
    assert.equal(await page.locator('[data-diagram-import-preview]').getAttribute('data-diagram-import-preview-state'), 'stale');
    assert.equal(await page.locator('[data-diagram-import-preview] [data-d2-rendered-svg]').isVisible(), true);
    assert.equal(await page.locator('button[data-action="assistant-diagram-map"]').isDisabled(), true);
    const refreshAnalyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const refreshAnalyzeResponse = await refreshAnalyzeResponsePromise;
    const refreshAnalyzeBody = await refreshAnalyzeResponse.json();
    assert.equal(refreshAnalyzeResponse.status(), 200, `D2 reanalyze failed: ${JSON.stringify(refreshAnalyzeBody)}`);
    const refreshedRoles = refreshAnalyzeBody.proposal?.roles || [];
    const refreshedWorkstation = refreshedRoles.find((role) => role.key === 'workstation');
    const refreshedUsers = refreshedRoles.find((role) => role.key === 'users');
    await page.locator('a[data-designer-section="diagram"]').click();
    await page.waitForSelector('#cmdp-diagram-editor', { timeout: 10_000 });
    assert.equal(await page.locator('#cmdp-diagram-import-source').count(), 0);
    assert.equal(await page.locator(`[data-diagram-import-semantic="${cssEscape(refreshedWorkstation.id)}"]`).inputValue(), 'object');
    assert.equal(await page.locator(`[data-diagram-import-semantic="${cssEscape(refreshedUsers.id)}"]`).inputValue(), 'static');
    assert.equal(await page.locator('.diagram-import-help summary').count(), 1);
    assert.match(await page.locator('.diagram-import-help summary').textContent(), /семантик|semantic/i);
    const workstationMapping = `[data-diagram-import-role-mapping="${cssEscape(refreshedWorkstation.id)}"]`;
    const sourceStage = page.locator(`${workstationMapping} [data-diagram-import-role-field="source.stageId"]`);
    const sourceOptions = await sourceStage.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
    assert.ok(sourceOptions.includes('selection:workstations'), `Workstation selection is absent from D2 mapping sources: ${JSON.stringify(sourceOptions)}`);
    await sourceStage.selectOption('selection:workstations');
    const primaryClass = page.locator(`${workstationMapping} [data-diagram-import-role-field="primary.className"]`);
    assert.equal(await primaryClass.inputValue(), 'ARM');
    await page.waitForSelector(`${workstationMapping} [data-diagram-import-role-field="primary.structuredFields"] option[value="model"]`, { state: 'attached', timeout: 10_000 });
    await page.locator(`${workstationMapping} [data-diagram-import-role-field="primary.structuredFields"]`).selectOption(['Code', 'Description', 'model', 'model2']);
    const labelInput = page.locator(`${workstationMapping} [data-diagram-import-role-field="primary.labelTemplate"]`);
    await labelInput.fill('${Code} ${Description}');
    assert.ok(await page.locator(`${workstationMapping} [data-action="insert-diagram-template-token"]`).count() > 0);
    assert.equal(await page.locator('[data-diagram-import-placement-row]').count(), 1, `Trailing placement row is absent. pageErrors=${JSON.stringify(pageErrors)}`);
    await page.locator('[data-diagram-import-placement-row] [data-diagram-import-placement-field="parentRoleId"]').first().selectOption(refreshedUsers.id);
    await page.locator('[data-diagram-import-placement-row] [data-diagram-import-placement-field="childRoleId"]').first().selectOption(refreshedWorkstation.id);
    assert.equal(await page.locator('button[data-action="diagram-import-apply"]').isEnabled(), true);
    const applyResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/diagram-import/apply'));
    await page.locator('button[data-action="diagram-import-apply"]').click();
    const applyResponse = await applyResponsePromise;
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status(), 200, `D2 mapping apply failed: ${JSON.stringify(applyBody)}`);
    await page.waitForFunction(() => /mapping.*applied|mapping.*применен/i.test(String(document.querySelector('.notice') && document.querySelector('.notice').textContent || '')), null, { timeout: 30_000 });
    assert.equal(await page.locator('[data-diagram-mapping-row]').count(), 0);
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), true);
    const previewRequestPromise = page.waitForRequest((request) => request.url().includes('/cmdbuild/custom-api/draft/preview'));
    const previewResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview'));
    await page.locator('button[data-action="preview-template"]').click();
    const previewRequest = await previewRequestPromise;
    const previewRequestBody = previewRequest.postDataJSON();
    const requestedDiagrams = previewRequestBody?.template?.spec?.result?.diagrams || [];
    assert.equal(requestedDiagrams.length, 1, `Draft preview lost imported diagram: ${JSON.stringify(requestedDiagrams)}`);
    assert.equal(requestedDiagrams[0].authoring?.d2Import?.version, 3);
    assert.equal(requestedDiagrams[0].nodeMappings?.[0]?.importRole?.key, 'workstation');
    assert.equal(requestedDiagrams[0].groupMappings?.[0]?.importRole?.key, 'users');
    assert.deepEqual(requestedDiagrams[0].authoring?.d2Import?.roles?.map((role) => role.key).sort(), ['users', 'workstation']);
    assert.equal(requestedDiagrams[0].nodeMappings?.[0]?.dataProfile?.fields?.includes('model2'), true);
    const previewResponse = await previewResponsePromise;
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
    await page.waitForSelector('#cmdp-result-section', { timeout: 30_000 });
    await page.waitForTimeout(100);
    const renderedSvgCount = await page.locator('[data-d2-rendered-svg]').count();
    const resultSectionHtml = await page.locator('#cmdp-result-section').innerHTML();
    assert.equal(renderedSvgCount, 1, `Draft SVG is absent in UI: ${resultSectionHtml.slice(0, 1200)}`);
    const renderedSvg = await page.locator('[data-d2-rendered-svg]').first().innerHTML();
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
    assert.equal(await page.locator('[data-diagram-mapping-row]').count(), 0);
    await page.locator('#cmdp-diagram-title').fill('Changed after preview');
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), true);
    await page.locator('a[data-designer-section="assistant"]').click();
    const reopenAnalyzeResponsePromise = page.waitForResponse((response) => response.url().includes('/draft/diagram-import/analyze'));
    await page.locator('button[data-action="diagram-import-analyze"]').click();
    const reopenAnalyzeResponse = await reopenAnalyzeResponsePromise;
    const reopenAnalyzeBody = await reopenAnalyzeResponse.json();
    assert.equal(reopenAnalyzeResponse.status(), 200, `D2 reopen analyze failed: ${JSON.stringify(reopenAnalyzeBody)}`);
    assert.equal(reopenAnalyzeBody.proposal?.roles?.length, 2);
    await page.locator('a[data-designer-section="diagram"]').click();
    const reopenedWorkstationMapping = `[data-diagram-import-role-mapping="${cssEscape(refreshedWorkstation.id)}"]`;
    assert.equal(await page.locator(`${reopenedWorkstationMapping} [data-diagram-import-role-field="primary.className"]`).inputValue(), 'ARM');
    const reopenedStructuredFields = await page.locator(`${reopenedWorkstationMapping} [data-diagram-import-role-field="primary.structuredFields"]`).evaluate((select) => Array.from(select.selectedOptions).map((option) => option.value));
    assert.ok(reopenedStructuredFields.includes('model2'), JSON.stringify(reopenedStructuredFields));
    assert.equal(await page.locator('#cmdp-diagram-title').count(), 0);
    assert.equal(await page.locator('button[data-action="save-template"]').isDisabled(), true);
    assert.deepEqual(pageErrors, []);
  }, { cookieOrigin: nginxOrigin });
});

test('Assistant generates an ARM by router Location object group and preview renders rows', { skip: skipReason, timeout: 180_000 }, async () => {
  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cmdp-designer-menu', { timeout: 10_000 });
    await page.locator('button[data-action="new-template"]').click();
    await page.waitForSelector('#cmdp-template-editor', { timeout: 10_000 });
    await page.locator('#cmdp-code').fill('AssistantArmRouterLocationUiSmoke');
    await page.locator('#cmdp-description').fill('Assistant ARM router Location UI smoke');
    await page.locator('a[data-designer-section="assistant"]').click();
    await page.waitForSelector('#cmdp-assistant-editor', { timeout: 10_000 });

    await page.locator('#cmdp-assistant-object-flow-prompt').fill([
      'Выборка 1: найти экземпляр класса "маршрутизатор" с точным описанием "Маршрутизатор для Test City 300", вернуть Code, Description и Location.',
      'Выборка 2: найти все карточки класса АРМ, вернуть Code, Description, Location, model и model2.',
      'Соединяем: оставить только АРМ, у которых Location равен Location выбранного маршрутизатора.'
    ].join('\n'));
    assert.equal(await page.locator('button[data-action="assistant-flow-apply"]').isDisabled(), true);
    const flowResponsePromise = page.waitForResponse((response) => response.url().includes('/assistant/object-flow/plan'));
    await page.locator('button[data-action="assistant-flow-generate"]').click();
    const flowResponse = await flowResponsePromise;
    const flowBody = await flowResponse.json();
    assert.equal(flowResponse.status(), 200, JSON.stringify(flowBody));
    assert.equal(flowBody.flow?.selections?.[0]?.className, 'routerG');
    assert.equal(flowBody.flow?.selections?.[1]?.className, 'ARM');
    assert.ok(flowBody.flow?.selections?.[0]?.rules?.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.value === 'Маршрутизатор для Test City 300'), JSON.stringify(flowBody));
    assert.deepEqual(flowBody.flow?.blocks?.[0]?.rules?.map((rule) => ({ left: rule.leftColumn, right: rule.rightColumn, operator: rule.operator })), [{ left: 'Location', right: 'Location', operator: 'equals' }]);
    assert.equal(await page.locator('[data-object-selection], [data-matching-block], [data-matching-rule-row]').count(), 0);
    await page.locator('button[data-action="assistant-flow-apply"]').click();
    await page.waitForFunction(() => /цепочк|data flow/i.test(String(document.querySelector('.notice')?.textContent || '')), null, { timeout: 30_000 });

    await page.locator('a[data-designer-section="extraction"]').click();
    await page.waitForSelector('#cmdp-extraction-editor', { timeout: 10_000 });
    const extractionOptions = await extractionResultOptions(page);
    const finalExtractionSource = extractionOptions.find((item) => /^Final result/.test(item.text))?.value || '';
    assert.ok(finalExtractionSource, `Extraction source options do not include a final matching stage: ${JSON.stringify(extractionOptions)}`);
    const extractionResponsePromise = page.waitForResponse((response) => response.url().includes('/cmdbuild/custom-api/draft/preview'));
    await page.locator('button[data-action="extract-template"]').first().click();
    const extractionResponse = await extractionResponsePromise;
    const extractionBody = await extractionResponse.json();
    assert.equal(extractionResponse.status(), 200, `Assistant extraction failed: ${JSON.stringify(extractionBody)}`);
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
    const selections = await objectGroupSelections(page);
    const routerSelection = selections.find((item) => item.className === 'routerG');
    const armSelection = selections.find((item) => item.className === 'ARM');
    assert.ok(routerSelection, `routerG object selection was not rendered: ${JSON.stringify(selections)}`);
    assert.ok(armSelection, `ARM object selection was not rendered: ${JSON.stringify(selections)}`);
    assert.ok(routerSelection.rules.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.value === 'Маршрутизатор для Test City 300'), `routerG selection has no exact Description filter: ${JSON.stringify(routerSelection.rules)}`);
    await page.locator('a[data-designer-section="relations"]').click();
    await page.waitForSelector('[data-matching-block]', { timeout: 10_000 });
    const matchRule = await page.locator('[data-matching-rule-row]').first().evaluate((row) => ({
      left: row.querySelector('[data-matching-rule-field="leftColumn"]')?.value || '',
      right: row.querySelector('[data-matching-rule-field="rightColumn"]')?.value || '',
      operator: row.querySelector('[data-matching-rule-field="operator"]')?.value || ''
    }));
    assert.equal(matchRule.left, 'Location');
    assert.equal(matchRule.right, 'Location');
    assert.equal(matchRule.operator, 'equals');

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

test('Wiki page embeds runtime iframe in a browser context', { skip: playwright && wikiIframeUrl ? false : 'Set CMDBDYNAMIC_WIKI_IFRAME_URL and install Playwright to run browser-level wiki iframe smoke.' }, async () => {
  await withPage(async (page) => {
    await page.goto(wikiIframeUrl, { waitUntil: 'domcontentloaded' });
    const frameHandle = page.frameLocator('iframe[src*="/cmdbuild/dynamicpages/ui/run/"]').first();
    await frameHandle.locator('body').waitFor({ timeout: 10_000 });
    const shellCount = await frameHandle.locator('.result-table-wrap, .notice').count();
    assert.ok(shellCount > 0, 'Runtime iframe did not render a result table or notice.');
  }, { cookieOrigin: originFromUrl(wikiIframeUrl) || nginxOrigin });
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
        value: ruleValue('[data-object-scope-field="value"], [data-object-scope-field="regex"]'),
        valueParam: ruleValue('[data-object-scope-field="valueParam"]'),
        valueColumn: ruleValue('[data-object-scope-field="valueColumn"]')
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
