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
const cookieHeader = process.env.CMDBUILD_COOKIE_HEADER || readCookieJar(cookieJar);
const playwright = await loadPlaywright();
const proxyAvailable = await canReach(`${proxyOrigin}/health/live`);
const sessionValid = proxyAvailable && cookieHeader ? await hasValidSession(cookieHeader) : false;
const skipReason = playwright
  ? proxyAvailable
    ? sessionValid
      ? false
      : 'CMDBuild session cookie is missing or invalid; set CMDBUILD_COOKIE_HEADER or refresh CMDBUILD_COOKIE_JAR.'
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
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(cookiesForOrigin(cookieHeader, options.cookieOrigin || proxyOrigin));
    const page = await context.newPage();
    await fn(page);
  } finally {
    await browser.close();
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
