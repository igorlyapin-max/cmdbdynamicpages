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

test('Designer run page exposes contextual buttons after selecting a template', { skip: skipReason }, async (t) => {
  const template = await firstTemplateCode(cookieHeader);
  if (!template) {
    t.skip('No saved templates are visible to the current CMDBuild user.');
    return;
  }

  await withPage(async (page) => {
    await page.goto(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`#cmdp-designer-menu`, { timeout: 10_000 });
    const selector = `[data-action="select-template"][data-code="${cssEscape(template)}"]`;
    await page.locator(selector).first().click();
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

    await page.locator('input[name="cmdp-assistant-task-mode"][value="tables"]').check({ force: true });
    await page.locator('#cmdp-assistant-intent').fill(assistantIntent);
    await page.locator('button[data-action="assistant-generate"]').first().click();
    await page.locator('[data-assistant-busy]').waitFor({ timeout: 10_000 });
    await page.locator('button[data-action="assistant-generate"]:not([disabled])').first().waitFor({ timeout: 140_000 });

    const assistantText = await page.locator('#cmdp-assistant-editor').innerText();
    assert.doesNotMatch(assistantText, /Validation errors|Template spec must|routerCore|Маршрутизатор ядра/);
    assert.match(assistantText, /routerG/);
    assert.match(assistantText, /\bARM\b/);

    await page.locator('button[data-action="assistant-apply-draft"]').first().click();
    await page.locator('a[data-designer-section="object-group"]').click();
    await page.waitForSelector('#cmdp-object-group-editor', { timeout: 10_000 });
    const selections = await objectGroupSelections(page);
    const routerSelection = selections.find((item) => item.className === 'routerG');
    const armSelection = selections.find((item) => item.className === 'ARM');
    assert.ok(routerSelection, `routerG object selection was not rendered: ${JSON.stringify(selections)}`);
    assert.ok(armSelection, `ARM object selection was not rendered: ${JSON.stringify(selections)}`);
    assert.ok(routerSelection.rules.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.value === 'Маршрутизатор для Test City 300'), `routerG selection has no exact Description filter: ${JSON.stringify(routerSelection.rules)}`);
    assert.ok(armSelection.from, `ARM selection is not linked to the router anchor: ${JSON.stringify(armSelection)}`);
    assert.ok(armSelection.rules.some((rule) => rule.path === 'Location' && rule.op === 'equals' && rule.valueColumn === 'Location'), `ARM selection has no Location valueColumn filter: ${JSON.stringify(armSelection.rules)}`);

    await page.locator('button[data-action="apply-object-group"]').first().click();
    await page.locator('a[data-designer-section="final-view"]').click();
    await page.waitForSelector('#cmdp-view-composer-editor', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const values = Array.from(document.querySelectorAll('[data-view-column-field="field"] option')).map((option) => option.value);
      return values.includes('model') && values.includes('model2');
    }, null, { timeout: 30_000 });
    const finalFieldOptions = await viewComposerFieldOptions(page);
    assert.ok(finalFieldOptions.includes('model'), `Final data field options do not include model: ${JSON.stringify(finalFieldOptions)}`);
    assert.ok(finalFieldOptions.includes('model2'), `Final data field options do not include model2: ${JSON.stringify(finalFieldOptions)}`);
    const finalRowsBeforeAutoAdd = await page.locator('[data-view-column-row]').count();
    await setViewComposerColumns(page, [
      { field: 'model', title: 'model' },
      { field: 'model2', title: 'model2' }
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
      assert.ok(titleBox && titleBox.width >= 180, `Runtime cache table title is too narrow: ${JSON.stringify(titleBox)}`);
      assert.ok((await title.innerText()).trim().length > 4, 'Runtime cache table title is unexpectedly empty.');
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

async function firstTemplateCode(cookie) {
  try {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates?limit=1`, undefined, { cookie });
    if (result.statusCode !== 200) return '';
    const json = JSON.parse(result.body || '{}');
    const data = Array.isArray(json.data) ? json.data : [];
    return data[0] && data[0].code || data[0] && data[0].Code || '';
  } catch {
    return '';
  }
}

async function templateCodeExists(cookie, code) {
  try {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates?limit=100`, undefined, { cookie });
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
