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
const grouped = (item) => ({ ...item, presentation: { largeTable: { ...item.presentation.largeTable, groupKeys: ['value'] } } });
const ordinary = { ...table('Ordinary'), published: true, rows: [{ value: 'Ordinary row' }] };
const diagram = { name: 'Topology', nodes: [{ id: '1', label: 'System' }], edges: [], d2: { source: 'system' } };
const collection = (kind) => kind === 'public' ? 'public-snapshots' : 'templates';
const shellPayload = (tableView, tables = [keyed], other = {}) => ({ success: true, template: { code: 'Report' }, tableView,
  result: { tables, diagrams: [diagram] }, ...other });
const rowPage = (q, values, other = {}) => ({ table: { ...table(q.table), rows: values.map((value) => ({ value })) },
  total: values.length, offset: q.offset, limit: q.limit, ...other });
const action = (root, name) => root.locator('[data-large-action="' + name + '"]');
const viewGroup = (root, name = 'Table view') => root.getByRole('group', { name, exact: true }).and(root.locator('[data-large-view-control]'));
const viewButton = (group, view, name) => group.getByRole('button', { name, exact: true })
  .and(action(group, 'table-view')).and(group.locator('[data-large-view="' + view + '"]'));
const tableQuery = (request) => JSON.parse(new URL(request.url()).searchParams.get('cmdpTable'));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function assertViewMode(summary, rows, mode) {
  assert.equal(await summary.getAttribute('aria-pressed'), String(mode === 'summary'));
  assert.equal(await rows.getAttribute('aria-pressed'), String(mode === 'rows'));
}

async function assertVisibleInWidth(locator, width) {
  await locator.waitFor({ state: 'visible' });
  const bounds = await locator.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.x + bounds.width <= width);
}

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
    const reopened = calls.findLast((call) => call.query?.table === keyed.name && call.query.op === 'rows').query;
    assert.deepEqual([reopened.key, reopened.search, reopened.viewId], ['typed:&+/', 'tcp', undefined]);
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

test('with multiple visible tables, only grouped tables have separate header controls', async () => {
  const plain = table('Plain paged table', 'all');
  for (const tables of [[ordinary, grouped(all), plain], [ordinary, grouped(all), grouped(keyed), plain]]) {
    await withViewer({ kind: 'public', respond(call) {
      if (!call.query) return shellPayload({ kind: 'public', snapshotRevision: 'fixture-revision' }, tables, {
        snapshotFound: true, cache: { scope: 'staticSnapshot', snapshotRevision: 'fixture-revision' }
      });
      return rowPage(call.query, [(call.query.view === 'rows' ? 'Rows for ' : 'Data for ') + call.query.table]);
    } }, async (page, calls) => {
      await page.getByText('Ordinary row', { exact: true }).waitFor();
      const toolbar = page.locator('.snapshot-toolbar');
      await toolbar.waitFor();
      assert.equal(await viewGroup(toolbar).count(), 0);
      const visibleGrouped = tables.filter((item) => item.presentation.largeTable?.groupKeys?.length);
      assert.equal(await page.locator('[data-large-view-control]').count(), visibleGrouped.length);
      for (const item of visibleGrouped) {
        const header = page.getByRole('region', { name: item.name }).locator('.result-table-header');
        const group = viewGroup(header);
        await assertVisibleInWidth(group, 1280);
        await assertViewMode(viewButton(group, 'summary', 'Summary'), viewButton(group, 'rows', 'Rows'), 'summary');
      }
      const group = viewGroup(page.getByRole('region', { name: all.name }));
      await viewButton(group, 'rows', 'Rows').click();
      await page.getByText('Rows for ' + all.name, { exact: true }).waitFor();
      const switched = calls.filter(({ query }) => query?.view === 'rows');
      assert.deepEqual(switched.map(({ query }) => [query.table, query.op, query.snapshotRevision]), [
        [all.name, 'rows', 'fixture-revision']
      ]);
      if (visibleGrouped.length === 2) {
        const other = viewGroup(page.getByRole('region', { name: keyed.name }));
        await assertViewMode(viewButton(other, 'summary', 'Summary'), viewButton(other, 'rows', 'Rows'), 'summary');
      }
    });
  }
});

test('dynamic grouped view reuses its index when switching and aborts obsolete rows and detail', async () => {
  const detail = deferred();
  const pendingSummary = deferred();
  let holdSummary = false;
  const key = 'typed:&+/';
  const viewId = 'selected-index';
  try {
    await withViewer({ kind: 'dynamic', respond: async ({ query: q }) => {
      if (!q) return shellPayload({ kind: 'dynamic', pageSize: 3 }, [grouped(keyed)]);
      if (q.op === 'options') return { items: [{ key, label: 'Selected object' }], total: 1, offset: q.offset, limit: q.limit };
      if (q.op === 'details') {
        await detail.promise;
        return rowPage(q, ['Obsolete detail']);
      }
      if (holdSummary && !q.view) {
        holdSummary = false;
        await pendingSummary.promise;
        return rowPage(q, ['Obsolete summary'], { viewId, groupIds: ['old-group'] });
      }
      const label = [q.view === 'rows' ? 'Row' : 'Group', q.offset, q.search || 'unfiltered', q.sort || 'unsorted'].join(' ');
      return rowPage(q, [label], { total: 8, viewId, ...(!q.view ? { groupIds: ['group-' + q.offset] } : {}) });
    } }, async (page, calls) => {
      const region = page.getByRole('region', { name: keyed.name });
      const group = viewGroup(region.locator('.result-table-header'));
      const summary = viewButton(group, 'summary', 'Summary');
      const rows = viewButton(group, 'rows', 'Rows');
      const picker = action(region, 'picker');
      const search = region.getByRole('searchbox', { name: 'Search table' });
      await group.waitFor();
      assert.equal(await summary.isDisabled(), true);
      assert.equal(await rows.isDisabled(), true);
      await picker.click();
      await region.getByRole('button', { name: 'Selected object' }).click();
      await region.getByText('Group 0 unfiltered unsorted', { exact: true }).waitFor();
      assert.equal(await rows.isEnabled(), true);
      await assertViewMode(summary, rows, 'summary');
      await search.fill('needle');
      await region.getByText('Group 0 needle unsorted', { exact: true }).waitFor();
      await action(region, 'sort').click();
      await region.getByText('Group 0 needle value', { exact: true }).waitFor();
      await action(region, 'rows-next').click();
      await region.getByText('Group 3 needle value', { exact: true }).waitFor();
      await region.getByText('Groups: 4–6 of 8', { exact: true }).waitFor();

      await Promise.all([
        page.waitForRequest((request) => tableQuery(request)?.op === 'details'),
        action(region, 'details').click()
      ]);
      await summary.focus();
      await page.keyboard.press('Tab');
      assert.equal(await rows.evaluate((button) => button === document.activeElement), true);
      const [cancelledDetail] = await Promise.all([
        page.waitForEvent('requestfailed', (request) => tableQuery(request)?.op === 'details'),
        page.keyboard.press('Space')
      ]);
      assert.match(cancelledDetail.failure().errorText, /abort/i);
      await region.getByText('Row 0 needle value', { exact: true }).waitFor();
      await region.getByText('Rows: 1–3 of 8', { exact: true }).waitFor();
      detail.resolve();
      await assertViewMode(summary, rows, 'rows');
      assert.equal(await action(region, 'details').count(), 0);
      assert.equal(await region.locator('[data-large-detail-row]').count(), 0);
      assert.equal(await search.inputValue(), 'needle');
      assert.equal(await picker.innerText(), 'Selected object');
      assert.equal(await region.locator('[aria-sort="ascending"]').count(), 1);
      assert.equal(await rows.evaluate((button) => button === document.activeElement), true);

      holdSummary = true;
      const [oldRequest] = await Promise.all([
        page.waitForRequest((request) => {
          const q = tableQuery(request);
          return q?.op === 'rows' && !q.view && q.offset === 0;
        }),
        summary.press('Enter')
      ]);
      await region.locator('[data-large-rows][aria-busy="true"]').waitFor({ state: 'attached' });
      await assertViewMode(summary, rows, 'summary');
      const [cancelledSummary] = await Promise.all([
        page.waitForEvent('requestfailed', (request) => request === oldRequest),
        rows.press('Enter')
      ]);
      assert.match(cancelledSummary.failure().errorText, /abort/i);
      await region.getByText('Row 0 needle value', { exact: true }).waitFor();
      pendingSummary.resolve();
      await region.locator('[data-large-rows][aria-busy]').waitFor({ state: 'detached' });
      await assertViewMode(summary, rows, 'rows');
      assert.equal(await region.getByText(/^Obsolete /).count(), 0);
      const requests = calls.filter(({ query }) => query?.op === 'rows');
      assert.ok(requests.every(({ path, method, query }) => path === api + '/templates/Report/table-page' &&
        method === 'GET' && query.key === key && query.limit === 3 && !Object.hasOwn(query, 'snapshotRevision')));
      assert.deepEqual(requests.map(({ query: q }) => [q.offset, q.view, q.viewId, q.search, q.sort, q.direction]), [
        [0, undefined, undefined, '', undefined, undefined],
        [0, undefined, viewId, 'needle', undefined, undefined],
        [0, undefined, viewId, 'needle', 'value', 'asc'],
        [3, undefined, viewId, 'needle', 'value', 'asc'],
        [0, 'rows', viewId, 'needle', 'value', 'asc'],
        [0, undefined, viewId, 'needle', 'value', 'asc'],
        [0, 'rows', viewId, 'needle', 'value', 'asc']
      ]);
    });
  } finally {
    detail.resolve();
    pendingSummary.resolve();
  }
});

test('dynamic grouped view resets on key change and does not calculate automatically after expiry', async () => {
  const secondIndex = deferred();
  const reopenedIndex = deferred();
  const expiredResponse = deferred();
  let expire = false;
  try {
    await withViewer({ kind: 'dynamic', respond: async ({ query: q }) => {
      if (!q) return shellPayload({ kind: 'dynamic' }, [grouped(keyed)]);
      if (q.op === 'options') return { items: [{ key: 'one', label: 'First object' }, { key: 'two', label: 'Second object' }],
        total: 2, offset: q.offset, limit: q.limit };
      if (expire && q.viewId) {
        await expiredResponse.promise;
        return { status: 409, body: { reason: 'table_view_expired' } };
      }
      if (!q.viewId && q.key === 'two') await (expire ? reopenedIndex.promise : secondIndex.promise);
      return rowPage(q, [(q.view === 'rows' ? 'Rows for ' : 'Summary for ') + q.key], {
        viewId: q.viewId || (expire ? 'reopened' : 'index-' + q.key)
      });
    } }, async (page, calls) => {
      const region = page.getByRole('region', { name: keyed.name });
      const group = viewGroup(region);
      const summary = viewButton(group, 'summary', 'Summary');
      const rows = viewButton(group, 'rows', 'Rows');
      const select = async (name) => {
        await action(region, 'picker').click();
        await region.getByRole('button', { name, exact: true }).click();
      };
      await select('First object');
      await region.getByText('Summary for one', { exact: true }).waitFor();
      await rows.click();
      await region.getByText('Rows for one', { exact: true }).waitFor();

      await select('Second object');
      await region.locator('[data-large-rows][aria-busy="true"]').waitFor({ state: 'attached' });
      await assertViewMode(summary, rows, 'summary');
      assert.equal(await summary.isDisabled(), true);
      assert.equal(await rows.isDisabled(), true);
      secondIndex.resolve();
      await region.getByText('Summary for two', { exact: true }).waitFor();

      expire = true;
      const before = calls.length;
      await Promise.all([
        page.waitForRequest((request) => tableQuery(request)?.view === 'rows'),
        rows.press('Enter')
      ]);
      const search = region.getByRole('searchbox', { name: 'Search table' });
      await search.focus();
      expiredResponse.resolve();
      await region.getByRole('alert').filter({ hasText: 'This table view has expired.' }).waitFor();
      const reopen = action(region, 'reopen');
      await reopen.waitFor();
      assert.equal(await summary.isDisabled(), true);
      assert.equal(await rows.isDisabled(), true);
      assert.equal(await search.evaluate((input) => document.activeElement === input), true,
        'the error must not move focus after the user has left the view control');
      // Observe automatic follow-up requests, including those after the table's search debounce.
      await assert.rejects(page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.startsWith(api + '/templates/Report/');
      }, { timeout: 400 }), { name: 'TimeoutError' });
      assert.deepEqual(calls.slice(before).map(({ query: q }) => [q?.op, q?.key, q?.view, q?.viewId]), [
        ['rows', 'two', 'rows', 'index-two']
      ]);

      await reopen.click();
      await region.locator('[data-large-rows][aria-busy="true"]').waitFor({ state: 'attached' });
      await assertViewMode(summary, rows, 'summary');
      assert.equal(await rows.isDisabled(), true);
      reopenedIndex.resolve();
      await region.getByText('Summary for two', { exact: true }).waitFor();
      assert.equal(await rows.isEnabled(), true);
      const requests = calls.filter(({ query }) => query?.op === 'rows');
      assert.deepEqual(requests.map(({ query: q }) => [q.key, q.offset, q.view, q.viewId]), [
        ['one', 0, undefined, undefined], ['one', 0, 'rows', 'index-one'], ['two', 0, undefined, undefined],
        ['two', 0, 'rows', 'index-two'], ['two', 0, undefined, undefined]
      ]);
      assert.deepEqual(calls.slice(before).map(({ query }) => query?.op || 'shell'), ['rows', 'shell', 'options', 'rows']);
      const shell = calls[before + 1];
      assert.deepEqual([shell.method, shell.path, shell.params.cmdpTableShell, shell.params.snapshotParams, shell.params.refresh],
        ['GET', api + '/templates/Report/run', '1', typed, undefined]);
    });
  } finally {
    secondIndex.resolve();
    reopenedIndex.resolve();
    expiredResponse.resolve();
  }
});

test('an expired keyed view recovers after selecting the same object from refreshed options', async () => {
  const recovery = deferred();
  let optionLoads = 0;
  let expired = false;
  try {
    await withViewer({ kind: 'dynamic', viewport: { width: 390, height: 740 }, respond: async ({ query: q }) => {
      if (!q) return shellPayload({ kind: 'dynamic', pageSize: 3 }, [grouped(keyed)]);
      if (q.op === 'options') {
        optionLoads++;
        if (optionLoads === 2) return { items: [{ key: 'two', label: 'Different object' }], total: 1, offset: q.offset, limit: q.limit };
        return { items: [{ key: 'one', label: 'Only object' }], total: 1, offset: q.offset, limit: q.limit };
      }
      if (expired && q.viewId === 'original') return { status: 409, body: { reason: 'table_view_expired' } };
      if (expired && !q.viewId && optionLoads === 2) return { status: 404, body: { reason: 'table_key_unavailable' } };
      if (expired && !q.viewId) await recovery.promise;
      const viewId = expired ? 'recovered' : 'original';
      const label = [viewId, q.view || 'summary', q.search || '-', q.sort || '-'].join(' ');
      return rowPage(q, [label], { viewId });
    } }, async (page, calls) => {
      const region = page.getByRole('region', { name: keyed.name });
      const group = viewGroup(region);
      const summary = viewButton(group, 'summary', 'Summary');
      const rows = viewButton(group, 'rows', 'Rows');
      const picker = action(region, 'picker');
      const search = region.getByRole('searchbox', { name: 'Search table' });
      const object = region.getByRole('button', { name: 'Only object', exact: true }).and(action(region, 'option'));
      await assertVisibleInWidth(group, 390);
      await picker.click();
      await object.click();
      await region.getByText('original summary - -', { exact: true }).waitFor();
      await search.fill('needle');
      await region.getByText('original summary needle -', { exact: true }).waitFor();
      await action(region, 'sort').click();
      await region.getByText('original summary needle value', { exact: true }).waitFor();

      expired = true;
      const before = calls.filter(({ query }) => query?.op === 'rows').length;
      await rows.press('Enter');
      const reopen = action(region, 'reopen');
      await assertVisibleInWidth(reopen, 390);
      assert.equal(await reopen.evaluate((button) => document.activeElement === button), true);
      assert.equal(await rows.isDisabled(), true);
      assert.equal(calls.filter(({ query }) => query?.op === 'rows').length, before + 1);

      await reopen.press('Enter');
      const choose = action(region, 'choose');
      await assertVisibleInWidth(choose, 390);
      assert.equal(await picker.textContent(), 'Only object');
      assert.equal(await search.inputValue(), 'needle');
      await choose.press('Enter');
      await object.waitFor();
      assert.equal(calls.filter(({ query }) => query?.op === 'rows').length, before + 2,
        'opening the refreshed list must not recalculate the report');

      const [opening] = await Promise.all([
        page.waitForRequest((request) => tableQuery(request)?.op === 'rows'),
        object.press('Enter')
      ]);
      const q = tableQuery(opening);
      assert.deepEqual([q.key, q.view, q.viewId, q.search, q.sort, q.direction, q.offset, q.limit],
        ['one', undefined, undefined, 'needle', 'value', 'asc', 0, 3]);
      await assertViewMode(summary, rows, 'summary');
      assert.equal(await rows.isDisabled(), true);
      recovery.resolve();
      await region.getByText('recovered summary needle value', { exact: true }).waitFor();
      await rows.press('Enter');
      await region.getByText('recovered rows needle value', { exact: true }).waitFor();
      const last = calls.filter(({ query }) => query?.op === 'rows').at(-1).query;
      assert.deepEqual([last.key, last.view, last.viewId], ['one', 'rows', 'recovered']);

      await picker.click();
      await object.waitFor();
      const noDuplicate = assert.rejects(page.waitForRequest((request) => tableQuery(request)?.op === 'rows',
        { timeout: 350 }), { name: 'TimeoutError' });
      await object.press('Enter');
      await noDuplicate;
      await assertViewMode(summary, rows, 'rows');
    });
  } finally {
    recovery.resolve();
  }
});

test('reopening a dynamic report replaces the table shell when grouping is removed or added', async () => {
  let revision = 1;
  let failShell = true;
  const finishShell = deferred();
  try {
    await withViewer({ kind: 'dynamic', async respond({ query: q }) {
      const current = revision;
      if (!q) {
        if (current === 2 && failShell) {
          failShell = false;
          return { status: 502, body: { success: false } };
        }
        if (current === 2) await finishShell.promise;
        return shellPayload({ kind: 'dynamic', pageSize: 3 }, [current === 2 ? all : grouped(all)]);
      }
      if (q.viewId && q.viewId !== 'view-' + current) return { status: 409, body: { reason: 'table_view_expired' } };
      return rowPage(q, [`Revision ${current}: ${q.view || 'default'}`], { viewId: 'view-' + current });
    } }, async (page, calls) => {
      const region = page.getByRole('region', { name: all.name });
      const group = viewGroup(region);
      const rows = viewButton(group, 'rows', 'Rows');
      const search = region.getByRole('searchbox', { name: 'Search table' });
      await region.getByText('Revision 1: default', { exact: true }).waitFor();
      revision = 2;
      await rows.press('Enter');
      const reopen = action(region, 'reopen');
      await reopen.waitFor();
      await search.fill('needle');
      assert.equal(await reopen.isVisible(), true, 'editing the search does not clear the recovery action');
      await reopen.press('Enter');
      await region.getByRole('alert').waitFor();
      assert.equal(await reopen.isEnabled(), true, 'an unavailable replacement shell leaves recovery retryable');
      assert.equal(await rows.isDisabled(), true);
      await reopen.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-large-action="reopen"]')?.disabled);
      assert.equal(calls.filter(({ query }) => query?.op === 'rows').length, 2, 'wait for the replacement shell before requesting rows');
      finishShell.resolve();
      await region.getByText('Revision 2: default', { exact: true }).waitFor();
      assert.equal(await group.count(), 0);
      assert.equal(await search.inputValue(), 'needle');
      assert.equal(calls.at(-1).query.viewId, undefined);
      assert.equal(calls.at(-1).query.search, 'needle');

      revision = 3;
      await action(region, 'sort').click();
      await reopen.press('Enter');
      await region.getByText('Revision 3: default', { exact: true }).waitFor();
      await assertViewMode(viewButton(group, 'summary', 'Summary'), rows, 'summary');
      assert.deepEqual([calls.at(-1).query.search, calls.at(-1).query.sort], ['needle', 'value']);
      await rows.press('Enter');
      await region.getByText('Revision 3: rows', { exact: true }).waitFor();
      assert.deepEqual([calls.at(-1).query.viewId, calls.at(-1).query.view], ['view-3', 'rows']);
      assert.equal(calls.filter(({ query }) => query === null).length, 4);
    });
  } finally {
    finishShell.resolve();
  }
});

test('details expiry exposes table-level recovery and ignores a retired details response', async () => {
  const oldStarted = deferred();
  const finishOld = deferred();
  const expired = { status: 409, body: { reason: 'table_view_expired' } };
  let revision = 1;
  try {
    await withViewer({ kind: 'dynamic', viewport: { width: 390, height: 740 }, async respond({ query: q }) {
      if (!q) return shellPayload({ kind: 'dynamic', pageSize: 3 }, [grouped(all)]);
      if (q.op === 'details') {
        if (q.group === 'group-1') { oldStarted.resolve(); await finishOld.promise; }
        return expired;
      }
      if (q.viewId && q.viewId !== 'view-' + revision) return expired;
      return rowPage(q, ['Group ' + revision], { viewId: 'view-' + revision, groupIds: ['group-' + revision] });
    } }, async (page, calls) => {
      const region = page.getByRole('region', { name: all.name });
      const details = action(region, 'details');
      const reopen = action(region, 'reopen');
      const rows = viewButton(viewGroup(region), 'rows', 'Rows');
      await details.click();
      await oldStarted.promise;
      revision = 2;
      await rows.press('Enter');
      await reopen.press('Enter');
      await region.getByText('Group 2', { exact: true }).waitFor();
      const search = region.getByRole('searchbox', { name: 'Search table' });
      await search.focus();
      finishOld.resolve();
      const noRequest = (request) => new URL(request.url()).pathname.startsWith(api + '/templates/Report/');
      await assert.rejects(page.waitForRequest(noRequest, { timeout: 350 }), { name: 'TimeoutError' });
      assert.equal(await reopen.count(), 0);
      assert.equal(await rows.isEnabled(), true);
      assert.equal(await search.evaluate((field) => field === document.activeElement), true);

      const before = calls.length;
      await details.press('Enter');
      await assertVisibleInWidth(reopen, 390);
      assert.equal(await reopen.evaluate((button) => button === document.activeElement), true);
      assert.equal(await reopen.locator('xpath=parent::*').getAttribute('data-large-message-action'), '');
      assert.equal(await region.locator('[data-large-detail-row]').count(), 0);
      assert.equal(await rows.isDisabled(), true);
      assert.equal(await region.locator('[data-large-rows][aria-busy]').count(), 0);
      await assert.rejects(page.waitForRequest(noRequest, { timeout: 350 }), { name: 'TimeoutError' });
      assert.deepEqual(calls.slice(before).map(({ query }) => query?.op), ['details']);
      revision = 3;
      await reopen.click();
      await region.getByText('Group 3', { exact: true }).waitFor();
      assert.equal(await rows.isEnabled(), true);
    });
  } finally {
    finishOld.resolve();
  }
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

test('public reload and personal refresh keep their transport, selected key and Rows mode', async () => {
  let revision = 'before';
  await withViewer({ kind: 'public', snapshotRefreshSessionPresent: true, locale: 'ru', viewport: { width: 390, height: 840 }, async respond(call) {
    const path = call.path;
    const q = call.query;
    if (path.endsWith('/csrf')) return { success: true, token: 'fixture' };
    if (path.endsWith('/refresh-snapshot')) {
      if (call.method === 'GET') return { available: true, mode: 'personal' };
      return shellPayload({ kind: 'personal', viewId: 'personal-id' }, [grouped(keyed)], {
        snapshotFound: true, action: 'refresh-snapshot', mode: 'personal', template: { code: 'Report', active: true }, cache: null
      });
    }
    if (!q) return shellPayload({ kind: 'public', snapshotRevision: revision }, [grouped(keyed)], {
      snapshotFound: true, cache: { scope: 'staticSnapshot', snapshotRevision: revision }
    });
    const personal = path.startsWith(api + '/templates/');
    if (!personal && q.snapshotRevision !== revision) return { status: 409, body: { reason: 'table_snapshot_changed' } };
    if (q.op === 'options') return { items: [{ key: 'one', label: 'Первая' }, { key: 'two', label: 'Вторая' }], total: 2, offset: 0, limit: q.limit };
    return rowPage(q, [personal ? 'Личный результат ' + q.key : 'Снимок ' + revision + (q.view === 'rows' ? ' строки' : '')], { total: 51 });
  } }, async (page, calls) => {
    const scoped = page.getByRole('region', { name: keyed.name });
    const picker = action(scoped, 'picker');
    const toolbar = page.locator('.snapshot-toolbar');
    const refresh = toolbar.getByRole('button', { name: 'Обновить для себя', exact: true });
    const group = viewGroup(toolbar, 'Вид таблицы');
    const summary = viewButton(group, 'summary', 'Сводка');
    const rows = viewButton(group, 'rows', 'Строки');
    for (const locator of [refresh, group, summary, rows]) await assertVisibleInWidth(locator, 390);
    assert.equal(await scoped.locator('[data-large-view-control]').count(), 0);
    assert.equal(await page.locator('[data-large-view-control]').count(), 1);
    await assertViewMode(summary, rows, 'summary');
    await picker.click();
    const search = scoped.getByRole('searchbox', { name: 'Поиск объектов' });
    const bounds = await search.boundingBox();
    assert.ok(bounds && bounds.height >= 44 && bounds.x + bounds.width <= 390);
    await search.press('Escape');
    assert.equal(await picker.evaluate((el) => document.activeElement === el), true);
    await picker.click();
    await scoped.getByRole('button', { name: 'Первая' }).click();
    await scoped.getByText('Снимок before', { exact: true }).waitFor();
    await rows.press('Enter');
    await scoped.getByText('Снимок before строки', { exact: true }).waitFor();
    await assertViewMode(summary, rows, 'rows');
    revision = 'after';
    await action(scoped, 'rows-next').click();
    await scoped.getByText('Снимок изменился или истёк. Перечитайте снимок.', { exact: false }).waitFor();
    await action(scoped, 'reload').click();
    await scoped.getByText('Снимок after строки', { exact: true }).waitFor();
    await assertViewMode(summary, rows, 'rows');
    await refresh.click();
    await scoped.getByText('Личный результат one', { exact: true }).waitFor();
    await assertViewMode(summary, rows, 'rows');
    assert.equal(await page.locator('[data-d2-source-download]').count(), 0);
    await picker.click();
    await scoped.getByRole('button', { name: 'Вторая' }).click();
    await scoped.getByText('Личный результат two', { exact: true }).waitFor();
    assert.ok(calls.filter((call) => call.path.endsWith('/run') || call.method === 'POST').every((call) => call.params.cmdpTableShell === '1'));
    const personalCalls = calls.filter((call) => call.query && call.path === api + '/templates/Report/table-page');
    assert.deepEqual(personalCalls.map(({ query: q }) => [q.op, q.key, q.viewId, q.view]), [
      ['rows', 'one', 'personal-id', 'rows'], ['options', undefined, 'personal-id', undefined], ['rows', 'two', 'personal-id', 'rows']
    ]);
    const publicCalls = calls.filter((call) => call.query && call.path === api + '/public-snapshots/Report/table-page');
    assert.ok(publicCalls.every(({ query: q }) => q.snapshotRevision && !q.viewId));
    assert.deepEqual(publicCalls.filter(({ query: q }) => q.op === 'rows').map(({ query: q }) => [q.key, q.snapshotRevision, q.offset, q.view]), [
      ['one', 'before', 0, undefined], ['one', 'before', 0, 'rows'], ['one', 'before', 50, 'rows'], ['one', 'after', 0, 'rows']
    ]);
  });
});

test('shared refresh keeps Rows mode and changes the row and detail page size but not option size', async () => {
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
      return shellPayload({ kind: 'public', snapshotRevision: after, pageSize: 2 }, [grouped(keyed)], {
        snapshotFound: true, action: 'refresh-snapshot', mode: 'shared', template: { code: 'Report', active: true },
        cache: cache(after, 'snapshot-published')
      });
    }
    const q = call.query;
    if (!q) return shellPayload({ kind: 'public', snapshotRevision: before, pageSize: 3 }, [grouped(keyed)], {
      snapshotFound: true, action: 'run', cache: cache(before, 'snapshot-hit')
    });
    if (q.op === 'options') return { items: [{ key: 'item', label: 'Item' }], total: 1, offset: 0, limit: q.limit };
    if (q.op === 'details') return rowPage(q, ['Detail page ' + q.limit]);
    if (q.view === 'rows') return rowPage(q, ['Row page ' + q.limit]);
    return rowPage(q, ['Group page ' + q.limit], { groupIds: ['group-1'] });
  } }, async (page, calls) => {
    const region = page.getByRole('region', { name: keyed.name });
    const trigger = action(region, 'picker');
    const group = viewGroup(page.locator('.snapshot-toolbar'));
    const summary = viewButton(group, 'summary', 'Summary');
    const rows = viewButton(group, 'rows', 'Rows');
    await trigger.click();
    await region.getByRole('button', { name: 'Item', exact: true }).click();
    await region.getByText('Group page 3', { exact: true }).waitFor();
    await action(region, 'details').click();
    await region.getByText('Detail page 3', { exact: true }).waitFor();
    await rows.click();
    await region.getByText('Row page 3', { exact: true }).waitFor();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Refresh shared snapshot' }).click();
    await region.getByText('Row page 2', { exact: true }).waitFor();
    await assertViewMode(summary, rows, 'rows');
    await summary.click();
    await region.getByText('Group page 2', { exact: true }).waitFor();
    await action(region, 'details').click();
    await region.getByText('Detail page 2', { exact: true }).waitFor();
    await trigger.click();
    await region.getByRole('button', { name: 'Item', exact: true }).waitFor();
    const requests = calls.filter(({ query }) => query).map(({ query }) => [query.snapshotRevision, query.op, query.limit, query.view]);
    assert.deepEqual(requests, [
      [before, 'options', 10, undefined], [before, 'rows', 3, undefined], [before, 'details', 3, undefined], [before, 'rows', 3, 'rows'],
      [after, 'rows', 2, 'rows'], [after, 'rows', 2, undefined], [after, 'details', 2, undefined], [after, 'options', 10, undefined]
    ]);
  });
});
