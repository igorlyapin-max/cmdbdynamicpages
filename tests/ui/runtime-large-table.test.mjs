import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';
import { createAssistantDiagnosticsUi } from '../../scripts/assistant-diagnostics-ui.mjs';
import { LARGE_TABLE_DEFAULT_PAGE_SIZE, LARGE_TABLE_MAX_PAGE_SIZE, queryLargeTablePage } from '../../scripts/report-table-pages.mjs';
import { resolveTemplateParameters, staticSnapshotParamPairs } from '../../scripts/template-parameters.mjs';
import { createUiRequestDiagnostics } from '../../scripts/ui-request-diagnostics.mjs';
import { bindViewLargeExecutionHelpers } from '../fixtures/view-large-execution-helpers.mjs';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const first = source.indexOf('function renderDynamicPagesShell(');
const last = source.indexOf('\nfunction isCollectionLimitedAuthoringRequest(', first);
assert.ok(first >= 0 && last > first);
const shellSource = source.slice(first, last).replace('  function reportLimitSummary(diagnostic) {',
  '  window.reportLimitTest = { summary: reportLimitSummary, fields: renderExecutionLimitFields, view: renderViewLargeTable };\n' +
  '  function reportLimitSummary(diagnostic) {');
// Render the actual embedded script and stylesheet without starting the backend.
const shellBindings = Object.fromEntries([...shellSource.matchAll(/(?<!\\)\$\{(?:JSON\.stringify\()?([A-Z][A-Z0-9_]+)\b/g)].map(([, name]) => [name, 1]));
Object.assign(shellBindings, {
  ...Object.fromEntries([...shellSource.slice(0, shellSource.indexOf('  const headerHtml')).matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)].map(([name]) => [name, 1])),
  BACKEND_PREFIX: '/cmdbuild/custom-api',
  DEFAULT_TECHNICAL_ROOT: 'Root_A',
  APPLICATION_VERSION: 'test',
  LARGE_TABLE_DEFAULT_PAGE_SIZE,
  LARGE_TABLE_MAX_PAGE_SIZE,
  DRAFT_PREVIEW_TIMEOUT_MS: 5000,
  REPORT_ROW_LIMITS: { ordinary: 1800, paged: 8000, recommendedOrdinary: 2000, recommendedPaged: 10000 },
  DEFAULT_EMPTY_RESULT_TEXT: 'Nothing to display.',
  DEFAULT_PERMISSION_DENIED_TEXT: 'Denied',
  assistantStatus: () => ({}),
  renderViewLargeExecutionHelpers: bindViewLargeExecutionHelpers(source),
  createAssistantDiagnosticsUi, createUiRequestDiagnostics, resolveTemplateParameters, staticSnapshotParamPairs
});
const renderShell = Function(...Object.keys(shellBindings), shellSource + '\nreturn renderDynamicPagesShell;')(...Object.values(shellBindings));

const api = '/cmdbuild/custom-api';
const origin = 'https://report-table.test';
const typed = JSON.stringify([['region', 42], ['enabled', false]]);
const table = (name, mode) => ({ name, title: name, columns: ['value'], columnLabels: { value: 'Value' },
  presentation: mode ? { largeTable: { mode } } : {}, rows: [] });
const keyed = table('Linked objects', 'key');
const all = table('All objects', 'all');
const ordinary = { ...table('Ordinary'), published: true, rows: [{ value: 'Ordinary row' }] };
const diagram = { name: 'Topology', nodes: [{ id: '1', label: 'System' }], edges: [], d2: { source: 'system' } };
const collection = (kind) => kind === 'public' ? 'public-snapshots' : 'templates';
const shellPayload = (tableView, tables = [keyed], other = {}) => ({ success: true, template: { code: 'Report' }, tableView,
  result: { tables, diagrams: [diagram] }, ...other });
const rowPage = (q, values, other = {}) => ({ table: { ...table(q.table), rows: values.map((value) => ({ value })) },
  total: values.length, offset: q.offset, limit: q.limit, ...other });
const action = (root, name) => root.locator('[data-large-action="' + name + '"]');

async function withViewer({ kind, snapshotRefreshSessionPresent = false, locale = 'en', viewport = { width: 1280, height: 900 }, respond }, run) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome' });
  try {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(5000);
    const errors = [];
    const calls = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(origin + '/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: renderShell({
        mode: 'runtime', session: null, templateCode: 'Report', root: 'Root_A', publicRuntime: kind === 'public', snapshotRefreshSessionPresent
      }) });
      if (url.pathname === api + '/client-log') return route.fulfill({ status: 204 });
      const wire = url.searchParams.get('cmdpTable');
      const call = { path: url.pathname, method: route.request().method(), params: Object.fromEntries(url.searchParams),
        query: wire === null ? null : JSON.parse(wire), body: route.request().postData() ? route.request().postDataJSON() : null };
      calls.push(call);
      const answer = await respond(call);
      await route.fulfill({ status: answer.status || 200, json: answer.body || answer }).catch((error) => {
        if (!/aborted|closed|interception/i.test(error.message)) throw error;
      });
    });
    const url = new URL(origin);
    url.searchParams.set('snapshotParams', typed);
    url.searchParams.set('region', 'url-value');
    url.searchParams.set('lang', locale);
    await page.goto(url.href);
    try {
      await run(page, calls);
    } catch (error) {
      assert.deepEqual(errors, [], 'Viewer raised a browser error before the assertion');
      throw error;
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

test('report limit controls and remediation use deployment values in both locales', async () => {
  for (const [locale, source, action, clear] of [
    ['ru', /Итоговые данные → Источник данных/, /Все строки, постранично/, /уменьшите значение или очистите поле/i],
    ['en', /Final data → Data source/, /All rows, paginated/, /lower the value or clear it/i]
  ]) {
    await withViewer({ kind: 'dynamic', locale, respond: () => shellPayload(null, [ordinary]) }, async (page) => {
      const summary = await page.evaluate(() => {
        const fixture = document.createElement('section');
        fixture.id = 'row-limit-fixture';
        fixture.innerHTML = window.reportLimitTest.fields({ maxRowsMax: 1700, maxRowsDefault: 500,
          maxRowsPreviewDefault: 25, maxRowsDataPreviewDefault: 100 }) +
          window.reportLimitTest.view({ sourceAlias: 'chosen' }, [], {});
        document.body.append(fixture);
        const ordinary = { reason: 'row_limit_configuration_conflict', phase: 'rows', sourceLabel: 'Source label',
          stepAlias: 'internal_alias', stepLabel: 'Step label', requested: 5000, effectiveLimit: 1800,
          rowLimitMode: 'ordinary', rowLimitCauses: ['ordinaryCeiling'], canUseLargeTable: true };
        return {
          ordinary: window.reportLimitTest.summary({ diagnostics: { limits: [{ ...ordinary, phase: 'selector' }, ordinary] } }),
          paged: window.reportLimitTest.summary({ diagnostics: { limits: [{ ...ordinary, reason: 'limit_exceeded',
            rowLimitMode: 'paged', rowLimitCauses: ['pagedCeiling'], effectiveLimit: 8000, observed: 8001, canUseLargeTable: false }] } })
        };
      });
      assert.match(summary.ordinary, source);
      assert.match(summary.ordinary, action);
      assert.match(summary.ordinary, clear);
      assert.equal(summary.ordinary.split('Step label.').length, 2);
      assert.doesNotMatch(summary.ordinary, /internal_alias/);
      assert.doesNotMatch(summary.paged, action);
      assert.match(summary.paged, /8001/);
      assert.equal(await page.locator('[data-report-limit-controls] input').count(), 5);
      assert.equal(await page.locator('#cmdp-report-page-size').inputValue(), '50');
      assert.equal(await page.locator('#cmdp-report-page-size').getAttribute('max'), '100');
      assert.equal(await page.locator('#cmdp-report-timeout[readonly]').inputValue(), '5');
      const technical = page.locator('#row-limit-fixture details');
      await technical.locator('summary').click();
      assert.match(await technical.innerText(), /1800/);
      assert.match(await technical.innerText(), /8000/);
      assert.equal(await technical.locator('input').count(), 0);
      assert.equal(await page.locator('#cmdp-runtime-max-rows-max').getAttribute('max'), '1800');
      const help = await page.locator('#cmdp-view-large-mode-help').textContent();
      for (const value of ['1800', '8000', '2000', '10000']) assert.match(help, new RegExp(value));
    });
  }
});

test('dynamic viewer separates table views and rejects late keyed rows', async () => {
  let expire = false;
  let unblockFirst;
  let finishFirst;
  const firstFinished = new Promise((resolve) => { finishFirst = resolve; });
  let startedFirst;
  const firstStarted = new Promise((resolve) => { startedFirst = resolve; });
  const slow = new Promise((resolve) => { unblockFirst = resolve; });
  await withViewer({ kind: 'dynamic', async respond(call) {
    const q = call.query;
    if (!q) return shellPayload({ kind: 'dynamic', viewId: 'root-view' }, [ordinary, keyed, all]);
    if (q.op === 'options') {
      const items = q.search ? [{ key: 'typed:&+/', label: 'Second' }] : [{ key: 'slow', label: 'First' }];
      return { items, total: q.search ? 1 : 400, offset: q.offset, limit: q.limit };
    }
    if (q.table === all.name) return rowPage(q, ['All table data'], { viewId: 'all-view' });
    if (q.key === 'slow') { startedFirst(); await slow; finishFirst(); return rowPage(q, ['Late row'], { viewId: 'slow-view' }); }
    if (q.op === 'details') return rowPage(q, ['Detail ' + q.offset], { total: 51 });
    if (expire && q.viewId) return { status: 409, body: { reason: 'table_view_expired' } };
    return rowPage(q, ['Keyed row ' + q.offset], { viewId: 'keyed-view', total: 61, groupIds: ['group-' + q.offset], incomplete: Boolean(q.search) });
  } }, async (page, calls) => {
    const scoped = page.getByRole('region', { name: keyed.name });
    await page.getByText('All table data', { exact: true }).waitFor();
    await page.getByText('Ordinary row', { exact: true }).waitFor();
    assert.equal(calls.some((call) => call.query?.table === keyed.name), false);
    assert.equal(calls[0].params.cmdpTableShell, '1');
    assert.equal(calls.find((call) => call.query?.table === all.name).query.viewId, 'root-view');
    const d2 = new URL(await page.locator('[data-d2-source-download]').getAttribute('href'), origin);
    assert.equal(d2.searchParams.has('cmdpTableShell'), false);
    assert.equal(d2.searchParams.get('snapshotParams'), typed);
    await action(scoped, 'picker').click();
    await action(scoped, 'options-next').click();
    await scoped.getByText('11–20 of 400', { exact: true }).waitFor();
    const optionSearch = scoped.getByRole('searchbox', { name: 'Search objects' });
    await optionSearch.press('ArrowDown');
    await scoped.getByRole('button', { name: 'First' }).press('Enter');
    await firstStarted;
    await action(scoped, 'picker').click();
    await optionSearch.fill('second');
    await scoped.getByRole('button', { name: 'Second' }).click();
    await scoped.getByText('Keyed row 0', { exact: true }).waitFor();
    unblockFirst();
    await firstFinished;
    await action(scoped, 'rows-next').click();
    await scoped.getByText('Keyed row 50', { exact: true }).waitFor();
    assert.equal(await page.getByText('Late row', { exact: true }).count(), 0);
    await action(scoped, 'details').click();
    await scoped.getByText('Detail 0', { exact: true }).waitFor();
    await action(scoped, 'details-next').click();
    await scoped.getByText('Detail 50', { exact: true }).waitFor();
    await action(scoped, 'details').click();
    assert.equal(await scoped.getByText('Detail 50', { exact: true }).isVisible(), false);
    await action(scoped, 'sort').click();
    await scoped.locator('[aria-sort="ascending"]').waitFor();
    await scoped.getByRole('searchbox', { name: 'Search table' }).fill('tcp');
    await scoped.getByText('The table is incomplete.', { exact: false }).waitFor();
    const queries = calls.filter((call) => call.query);
    assert.ok(queries.every((call) => call.path === api + '/templates/Report/table-page' && call.method === 'GET' &&
      call.params.snapshotParams === typed && call.params.region === 'url-value' && call.params.root === 'Root_A' &&
      !('key' in call.params) && !('offset' in call.params) && !('cmdpTableShell' in call.params) &&
      call.query.limit === (call.query.op === 'options' ? 10 : 50)));
    const keyedRows = queries.filter(({ query }) => query.table === keyed.name && query.op === 'rows');
    assert.deepEqual(keyedRows.slice(0, 3).map(({ query: q }) => [q.key, q.offset, q.viewId]), [
      ['slow', 0, undefined], ['typed:&+/', 0, undefined], ['typed:&+/', 50, 'keyed-view']
    ]);
    assert.deepEqual(keyedRows.slice(-2).map(({ query: q }) => [q.sort, q.direction, q.search, q.viewId]), [
      ['value', 'asc', '', 'keyed-view'], ['value', 'asc', 'tcp', 'keyed-view']
    ]);
    assert.deepEqual(queries.filter(({ query }) => query.op === 'details').map(({ query: q }) => [q.key, q.group, q.offset, q.viewId]), [
      ['typed:&+/', 'group-50', 0, 'keyed-view'], ['typed:&+/', 'group-50', 50, 'keyed-view']
    ]);
    expire = true;
    await action(scoped, 'rows-next').click();
    await scoped.getByText('This table view has expired.', { exact: false }).waitFor();
    await action(scoped, 'reopen').click();
    await scoped.getByText('Keyed row 0', { exact: true }).waitFor();
    assert.deepEqual([calls.at(-1).query.key, calls.at(-1).query.search, calls.at(-1).query.viewId], ['typed:&+/', 'tcp', undefined]);
  });
});

test('diagram-only output does not mount or load paged tables', async () => {
  await withViewer({ kind: 'dynamic', async respond(call) {
    assert.equal(call.query, null);
    return shellPayload({ kind: 'dynamic' }, [], { result: { outputMode: 'diagrams', tables: [keyed, all], diagrams: [diagram] } });
  } }, async (page, calls) => {
    const output = page.locator('[data-result-diagram]');
    await output.waitFor();
    assert.ok((await output.boundingBox()).height > 0);
    assert.equal(await page.locator('[data-large-table]').count(), 0);
    assert.equal(calls.filter((call) => call.query).length, 0);
  });
});

test('paged tables use global, named and local flags in the same order as final tables', async () => {
  const named = table('Named', 'all');
  const local = { ...table('Local', 'all'), presentation: { largeTable: { mode: 'all' }, filters: false, sortable: true } };
  for (const kind of ['dynamic', 'public']) await withViewer({ kind, async respond(call) {
    if (!call.query) return { ...shellPayload({ kind, snapshotRevision: 'rev' }), result: {
      tables: [all, named, local], presentation: { filters: false, sortable: false, tables: [
        { name: named.name, filters: true, sortable: true }, { name: local.name, filters: true, sortable: false }
      ] }
    } };
    return rowPage(call.query, ['Rows for ' + call.query.table]);
  } }, async (page) => {
    for (const [name, filters, sortable] of [[all.name, false, false], [named.name, true, true], [local.name, false, true]]) {
      const region = page.getByRole('region', { name });
      await region.getByText('Rows for ' + name, { exact: true }).waitFor();
      assert.equal(await region.getByRole('searchbox', { name: 'Search table' }).count(), Number(filters), name);
      assert.equal(await action(region, 'sort').count(), Number(sortable), name);
    }
  });
});

test('object picker contains search, scrolling options and pager at 390x450', async () => {
  await withViewer({ kind: 'dynamic', viewport: { width: 390, height: 450 }, async respond(call) {
    if (!call.query) return { ...shellPayload({ kind: 'dynamic' }, [keyed]), result: { tables: [keyed] } };
    assert.equal(call.query.op, 'options');
    return { total: 400, limit: call.query.limit, offset: call.query.offset, items: Array.from({ length: call.query.limit }, (_, index) => ({
      key: 'key-' + (call.query.offset + index), label: 'Object ' + (call.query.offset + index)
    })) };
  } }, async (page) => {
    const region = page.getByRole('region', { name: keyed.name });
    const trigger = action(region, 'picker');
    await region.evaluate((node) => { node.style.marginTop = '290px'; });
    const triggerBefore = await trigger.boundingBox();
    assert.ok(triggerBefore.y >= 240, JSON.stringify(triggerBefore));
    const scrollBefore = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }));
    await trigger.click();
    const panel = region.locator('[data-large-picker]');
    const list = region.locator('[data-large-options]');
    const next = action(region, 'options-next');
    await next.waitFor();
    const [popup, pager] = await Promise.all([panel.boundingBox(), next.boundingBox()]);
    assert.ok(popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= 390 && popup.y + popup.height <= 450, JSON.stringify(popup));
    assert.ok(popup.y + popup.height <= triggerBefore.y, JSON.stringify({ popup, triggerBefore }));
    assert.ok(pager.y >= popup.y && pager.y + pager.height <= 450 && pager.height >= 44, JSON.stringify(pager));
    assert.ok(await list.evaluate((node) => node.scrollHeight > node.clientHeight && node.clientHeight >= 44));
    await list.evaluate((node) => { node.scrollTop = 200; });
    assert.equal(await list.evaluate((node) => node.scrollTop), 200);
    assert.equal(await panel.evaluate((node) => node.scrollTop), 0);
    assert.deepEqual(await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight })), scrollBefore);
    await next.click();
    await region.getByText('11–20 of 400', { exact: true }).waitFor();
    assert.equal(await list.evaluate((node) => node.scrollTop), 0);
    await region.getByRole('searchbox', { name: 'Search objects' }).press('Escape');
    assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
  });
});

test('published object picker shows ten choices and searches beyond the first page', async () => {
  const options = Array.from({ length: 36 }, (_, index) => ({
    key: 'key-' + index, label: (index < 24 ? 'Object ' : 'Match ') + index
  }));
  await withViewer({ kind: 'public', respond(call) {
    const q = call.query;
    if (!q) return shellPayload({ kind: 'public', snapshotRevision: 'rev', pageSize: 17 }, [keyed], { snapshotFound: true });
    if (q.op === 'rows') return rowPage(q, ['Rows for ' + q.key]);
    return queryLargeTablePage({ table: keyed, options }, q);
  } }, async (page, calls) => {
    const region = page.getByRole('region', { name: keyed.name });
    const trigger = action(region, 'picker');
    const search = region.getByRole('searchbox', { name: 'Search objects' });
    const list = region.locator('[data-large-options]');
    await trigger.waitFor();
    assert.equal(calls.some(({ query }) => query), false);
    await trigger.click();
    await region.getByText('1–10 of 36', { exact: true }).waitFor();
    assert.equal(await search.inputValue(), '');
    assert.equal(await action(list, 'option').count(), 10);
    assert.equal(await action(list, 'option').first().textContent(), 'Object 0');
    assert.equal(calls.some(({ query }) => query?.op === 'rows'), false);

    await search.fill('match');
    await region.getByText('1–10 of 12', { exact: true }).waitFor();
    assert.equal(await action(list, 'option').first().textContent(), 'Match 24');
    assert.equal(await action(list, 'option').count(), 10);
    await action(region, 'options-next').click();
    await region.getByText('11–12 of 12', { exact: true }).waitFor();
    assert.equal(await action(list, 'option').count(), 2);
    assert.equal(calls.some(({ query }) => query?.op === 'rows'), false);

    await search.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Match 34');
    await page.keyboard.press('Enter');
    await region.getByText('Rows for key-34', { exact: true }).waitFor();
    assert.equal(await trigger.textContent(), 'Match 34');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
    await trigger.click();
    await region.getByText('1–10 of 36', { exact: true }).waitFor();
    assert.equal(await search.inputValue(), '');
    assert.equal(await trigger.textContent(), 'Match 34');

    const queries = calls.filter(({ query }) => query);
    assert.ok(queries.every(({ path, method, query }) => path === api + '/public-snapshots/Report/table-page' &&
      method === 'GET' && query.snapshotRevision === 'rev' && !query.viewId));
    assert.deepEqual(queries.filter(({ query }) => query.op === 'options').map(({ query }) => [
      query.search, query.offset, query.limit, query.key
    ]), [['', 0, 10, undefined], ['match', 0, 10, undefined], ['match', 10, 10, undefined], ['', 0, 10, undefined]]);
    assert.deepEqual(queries.filter(({ query }) => query.op === 'rows').map(({ query }) => [
      query.key, query.offset, query.limit
    ]), [['key-34', 0, 17]]);
  });
});

test('public snapshot and personal refresh keep their own transport and restore a selection', async () => {
  let revision = 'before';
  await withViewer({ kind: 'public', snapshotRefreshSessionPresent: true, locale: 'ru', viewport: { width: 390, height: 840 }, async respond(call) {
    const path = call.path;
    const q = call.query;
    if (path.endsWith('/csrf')) return { success: true, token: 'fixture' };
    if (path.endsWith('/refresh-snapshot')) {
      if (call.method === 'GET') return { available: true, mode: 'personal' };
      return shellPayload({ kind: 'personal', viewId: 'personal-id' }, [keyed], {
        snapshotFound: true, action: 'refresh-snapshot', mode: 'personal', template: { code: 'Report', active: true }, cache: null
      });
    }
    if (!q) return shellPayload({ kind: 'public', snapshotRevision: revision }, [keyed], { snapshotFound: true, cache: { scope: 'staticSnapshot', snapshotRevision: revision } });
    const personal = path.startsWith(api + '/templates/');
    if (!personal && q.snapshotRevision !== revision) return { status: 409, body: { reason: 'table_snapshot_changed' } };
    if (q.op === 'options') return { items: [{ key: 'one', label: 'Первая' }, { key: 'two', label: 'Вторая' }], total: 2, offset: 0, limit: q.limit };
    return rowPage(q, [personal ? 'Личный результат ' + q.key : 'Снимок ' + revision], { total: 51 });
  } }, async (page, calls) => {
    const scoped = page.getByRole('region', { name: keyed.name });
    const picker = action(scoped, 'picker');
    await picker.click();
    const search = scoped.getByRole('searchbox', { name: 'Поиск объектов' });
    const bounds = await search.boundingBox();
    assert.ok(bounds && bounds.height >= 44 && bounds.x + bounds.width <= 390);
    await search.press('Escape');
    assert.equal(await picker.evaluate((el) => document.activeElement === el), true);
    await picker.click();
    await scoped.getByRole('button', { name: 'Первая' }).click();
    await scoped.getByText('Снимок before', { exact: true }).waitFor();
    revision = 'after';
    await action(scoped, 'rows-next').click();
    await scoped.getByText('Снимок изменился или истёк. Перечитайте снимок.', { exact: false }).waitFor();
    await action(scoped, 'reload').click();
    await scoped.getByText('Снимок after', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Обновить для себя' }).click();
    await scoped.getByText('Личный результат one', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-d2-source-download]').count(), 0);
    await picker.click();
    await scoped.getByRole('button', { name: 'Вторая' }).click();
    await scoped.getByText('Личный результат two', { exact: true }).waitFor();
    assert.ok(calls.filter((call) => call.path.endsWith('/run') || call.method === 'POST').every((call) => call.params.cmdpTableShell === '1'));
    const personalCalls = calls.filter((call) => call.query && call.path === api + '/templates/Report/table-page');
    assert.deepEqual(personalCalls.map(({ query: q }) => [q.op, q.key, q.viewId]), [
      ['rows', 'one', 'personal-id'], ['options', undefined, 'personal-id'], ['rows', 'two', 'personal-id']
    ]);
    const publicCalls = calls.filter((call) => call.query && call.path === api + '/public-snapshots/Report/table-page');
    assert.ok(publicCalls.every(({ query: q }) => q.snapshotRevision && !q.viewId));
    assert.ok(publicCalls.some(({ query: q }) => q.key === 'one' && q.snapshotRevision === 'after'));
  });
});

test('shared refresh replaces the row and detail page size but not the filter option size', async () => {
  const before = 'a'.repeat(64);
  const after = 'b'.repeat(64);
  const cache = (snapshotRevision, status) => ({
    scope: 'staticSnapshot', status, enabled: true, sharedAcrossUsers: true, backend: 'redis',
    key: 'a'.repeat(16), publishedAt: '2026-11-26T06:00:00Z', specHash: 'c'.repeat(64), paramsHash: 'any', snapshotRevision
  });
  await withViewer({ kind: 'public', snapshotRefreshSessionPresent: true, respond(call) {
    if (call.path.endsWith('/csrf')) return { success: true, token: 'fixture' };
    if (call.path.endsWith('/refresh-snapshot')) {
      if (call.method === 'GET') return { available: true, mode: 'shared' };
      return shellPayload({ kind: 'public', snapshotRevision: after, pageSize: 2 }, [keyed], {
        snapshotFound: true, action: 'refresh-snapshot', mode: 'shared', template: { code: 'Report', active: true },
        cache: cache(after, 'snapshot-published')
      });
    }
    const q = call.query;
    if (!q) return shellPayload({ kind: 'public', snapshotRevision: before, pageSize: 3 }, [keyed], {
      snapshotFound: true, action: 'run', cache: cache(before, 'snapshot-hit')
    });
    if (q.op === 'options') return { items: [{ key: 'item', label: 'Item' }], total: 1, offset: 0, limit: q.limit };
    if (q.op === 'details') return rowPage(q, ['Detail page ' + q.limit]);
    return rowPage(q, ['Group page ' + q.limit], { groupIds: ['group-1'] });
  } }, async (page, calls) => {
    const region = page.getByRole('region', { name: keyed.name });
    const trigger = action(region, 'picker');
    await trigger.click();
    await region.getByRole('button', { name: 'Item', exact: true }).click();
    await region.getByText('Group page 3', { exact: true }).waitFor();
    await action(region, 'details').click();
    await region.getByText('Detail page 3', { exact: true }).waitFor();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Refresh shared snapshot' }).click();
    await region.getByText('Group page 2', { exact: true }).waitFor();
    await action(region, 'details').click();
    await region.getByText('Detail page 2', { exact: true }).waitFor();
    await trigger.click();
    await region.getByRole('button', { name: 'Item', exact: true }).waitFor();
    const requests = calls.filter(({ query }) => query).map(({ query }) => [query.snapshotRevision, query.op, query.limit]);
    assert.deepEqual(requests, [
      [before, 'options', 10], [before, 'rows', 3], [before, 'details', 3],
      [after, 'rows', 2], [after, 'details', 2], [after, 'options', 10]
    ]);
  });
});
