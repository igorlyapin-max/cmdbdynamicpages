import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
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
    const url = `${proxyOrigin}/cmdbuild/dynamicpages/ui/run/${encodeURIComponent(runtimeTemplate)}?attrType=${encodeURIComponent(runtimeAttrType)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.runtime-page', { timeout: 10_000 });
    await page.waitForSelector('main#app', { timeout: 10_000 });
    await page.waitForTimeout(500);

    assert.equal(await page.locator('header').count(), 0);
    const hasResultShell = await page.locator('.result-table-wrap, .notice').count();
    assert.ok(hasResultShell > 0, 'Runtime page did not render a result table or notice.');
  });
});

async function withPage(fn) {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(cookiesForOrigin(cookieHeader, proxyOrigin));
    const page = await context.newPage();
    await fn(page);
  } finally {
    await browser.close();
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
