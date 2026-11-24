import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSelectCards } from '../../scripts/dev-proxy-server.mjs';
import { encodeLargeTableKey } from '../../scripts/report-table-pages.mjs';

const classesPath = '/cmdbuild/services/rest/v3/classes';
const classItem = (name, fields = {}) => ({ name, active: true, ...fields });
const page = (data, meta) => ({ ok: true, statusCode: 200, json: { data, meta } });
const cards = (count, start = 0) => Array.from({ length: count }, (_, i) => ({
  _id: start + i + 1, Code: 'card-' + (start + i + 1)
}));

function fixture(handler, limits = {}) {
  const requests = [];
  const evidence = [];
  const request = async (path, options) => {
    const url = new URL(path, 'http://mock');
    const start = Number(url.searchParams.get('start') || 0);
    const limit = Number(url.searchParams.get('limit') || 0);
    requests.push({ path: url.pathname, start, limit, query: url.searchParams, options });
    return handler(url.pathname, start, limit);
  };
  request.getRestCalls = () => requests.length;
  request.recordReportLimit = (item) => evidence.push(item);
  const run = (step = {}, context = {}, strict = true, restriction = null) => executeSelectCards(
    request, { as: 'asset', className: 'Asset', ...step }, {}, context,
    { maxRows: 2, maxSelectionScanRows: 2, maxSelectionScanRowsMax: 10000, maxClasses: 500, maxClassesMax: 500,
      maxRestCalls: 1000, ...limits }, null, new Set(), strict, restriction
  );
  return { run, requests, evidence };
}

test('strict selection uses exactly one lookahead with the same filter, even on ordinary tables', async () => {
  for (const probe of [[], cards(1, 2)]) {
    const f = fixture((path, start) => path === classesPath
      ? page([classItem('Asset')], { total: 1 })
      : start ? page(probe, { count: probe.length }) : page(cards(2).map((row) => ({ ...row, Code: 'wanted' })), { count: 2 }));
    const result = await f.run({}, {}, true, { field: 'Code', idField: 'Code', value: 'wanted', token: encodeLargeTableKey('wanted') });
    assert.equal(result.truncated, Boolean(probe.length));
    assert.deepEqual(result.rows.map((row) => row._id), [1, 2]);
    assert.deepEqual(f.requests.slice(1).map(({ start, limit }) => [start, limit]), [[0, 2], [2, 1]]);
    const filter = f.requests[1].query.get('filter');
    assert.ok(filter);
    assert.equal(f.requests[2].query.get('filter'), filter);
    assert.deepEqual(f.evidence.map((item) => [item.limitName, item.reason, item.observed]),
      probe.length ? [['maxSelectionScanRows', 'limit_exceeded', 2]] : []);
  }
});

test('strict selection rejects a short count conflict and prioritizes a consistent total above the scan cap', async () => {
  for (const [meta, reason, total] of [
    [{ count: 2 }, 'completeness_unconfirmed', undefined],
    [{ count: 9, total: 1 }, undefined, 1],
    [{ count: 0 }, undefined, null],
    [{ total: 2 }, 'completeness_unconfirmed', 2],
    [{ total: 0 }, 'completeness_unconfirmed', undefined],
    [{ total: 'invalid' }, 'completeness_unconfirmed', undefined],
    [{ count: 2, total: 3 }, 'limit_exceeded', 3]
  ]) {
    const f = fixture((path) => path === classesPath ? page([classItem('Asset')], { total: 1 }) : page(cards(1), meta));
    assert.equal((await f.run()).truncated, Boolean(reason));
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.evidence.map((item) => [item.reason, item.observed, item.total]), reason ? [[reason, 1, total]] : []);
  }
});

test('strict selection keeps total across missing pages and rejects contradictory totals', async () => {
  for (const [later, complete] of [[undefined, true], [1001, true], [1002, false], [1000, false]]) {
    const f = fixture((path, start) => {
      if (path === classesPath) return page([classItem('Asset')], { total: 1 });
      return start ? page(cards(1, start), { count: 1001, total: later }) : page(cards(1000), { total: '1001' });
    }, { maxRows: 1002, maxSelectionScanRows: 1002 });
    assert.equal((await f.run()).truncated, !complete);
    assert.deepEqual(f.requests.slice(1).map(({ start, limit }) => [start, limit]), [[0, 1000], [1000, 2]]);
    assert.deepEqual(f.evidence.map((item) => item.reason), complete ? [] : ['completeness_unconfirmed']);
  }
});

test('strict selection does not probe without a REST slot, or accept a repeated lookahead row', async () => {
  for (const maxRestCalls of [2, 3]) {
    const f = fixture((path, start) => path === classesPath
      ? page([classItem('Asset')], { total: 1 }) : page(cards(start ? 1 : 2)), { maxRestCalls });
    assert.equal((await f.run()).truncated, true);
    assert.equal(f.requests.length, maxRestCalls);
    assert.deepEqual(f.evidence.map((item) => item.reason), ['completeness_unconfirmed']);
  }
});

test('non-snapshot selection keeps its existing single-read behavior for a full count-only page', async () => {
  const f = fixture((path) => path === classesPath ? page([classItem('Asset')]) : page(cards(2), { count: 2 }));
  const result = await f.run({}, {}, false);
  assert.equal(result.rows.length, 2);
  assert.equal(result.selectionScan, null);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.evidence, []);
});

function pagedCatalog(items, detail, { repeat = false, denyCards = false } = {}) {
  return (path, start, limit) => {
    if (path === classesPath) return page(items.slice(repeat ? 0 : start, (repeat ? 0 : start) + limit), { total: items.length });
    if (path === classesPath + '/Asset') return detail === null ? { ok: false, statusCode: 404 } : page(detail);
    assert.match(path, /\/cards$/);
    return denyCards ? { ok: false, statusCode: 403 } : page([], { total: 0 });
  };
}

test('strict class selection is independent of global catalog size at 500 and 501', async () => {
  const leaf = classItem('Asset', { prototype: false, _can_read: true });
  for (const size of [500, 501]) {
    const items = [...Array.from({ length: size - 1 }, (_, i) => classItem('Other' + i)), leaf];
    const f = fixture(pagedCatalog(items, leaf), { maxClasses: 1 });
    assert.equal((await f.run()).truncated, false);
    assert.deepEqual(f.evidence, []);
    assert.deepEqual(f.requests.map(({ path, start, limit }) => [path, start, limit]), [
      [classesPath, 0, 500],
      ...(size === 501 ? [[classesPath + '/Asset', 0, 0], [classesPath, 500, 500]] : []),
      [classesPath + '/Asset/cards', 0, 2]
    ]);
    assert.equal(f.requests[0].query.get('scope'), 'service');
    if (size === 501) {
      assert.equal(f.requests[1].query.get('scope'), 'service');
      assert.deepEqual(f.requests[1].options, { optionalMissing: true });
    }
  }
});

test('strict class selection pages for every required descendant and reports 501, not global catalog size', async () => {
  const root = classItem('Asset', { prototype: true, _can_read: false });
  const bridge = classItem('Bridge', { parent: 'Asset', prototype: true, _can_read: false });
  for (const required of [500, 501]) {
    const items = [
      root, bridge, classItem('Hidden', { parent: 'Bridge', _can_read: false }), classItem('Unrelated'),
      ...Array.from({ length: required }, (_, i) => classItem('Child' + i, { parent: 'Bridge' }))
    ];
    const f = fixture(pagedCatalog(items, root));
    assert.equal((await f.run()).truncated, required > 500);
    assert.deepEqual(f.requests.filter((item) => item.path === classesPath).map(({ start, limit }) => [start, limit]),
      [[0, 500], [500, 500]]);
    const cardRequests = f.requests.filter((item) => item.path.endsWith('/cards'));
    assert.deepEqual(cardRequests.map(({ path }) => path), required === 500
      ? Array.from({ length: required }, (_, i) => classesPath + '/Child' + i + '/cards') : []);
    assert.deepEqual(f.evidence.map((item) => [item.limitName, item.reason, item.effectiveLimit, item.observed]),
      required === 500 ? [] : [['maxClasses', 'limit_exceeded', 500, 501]]);
  }
});

test('strict class lookup does not infer leafhood or read denied classes from partial metadata', async () => {
  const root = classItem('Asset');
  const items = [root, ...Array.from({ length: 499 }, (_, i) => classItem('Other' + i)),
    classItem('Child', { parent: 'Asset' })];
  for (const detail of [null, root, classItem('Wrong', { prototype: false, _can_read: true }),
    classItem('Asset', { prototype: false, _can_read: true })]) {
    const f = fixture(pagedCatalog(items, detail));
    assert.equal((await f.run()).truncated, false);
    assert.equal(f.requests.at(-1).path, classesPath + '/Child/cards');
  }
  const repeated = fixture(pagedCatalog(items, root, { repeat: true }));
  assert.equal((await repeated.run()).truncated, true);
  assert.equal(repeated.requests.length, 3);
  assert.equal(repeated.evidence[0].reason, 'completeness_unconfirmed');

  const deniedMetadata = fixture(pagedCatalog([classItem('Asset', { _can_read: false })]));
  await assert.rejects(deniedMetadata.run(), { cmdbuildStatus: 403 });
  assert.equal(deniedMetadata.requests.length, 1);

  const leaf = classItem('Asset', { prototype: false, _can_read: true });
  const deniedRead = fixture(pagedCatalog(items.slice(1).map((item) => ({ ...item, parent: 'Class' })), leaf, { denyCards: true }),
    { maxClassesMax: 499 });
  await assert.rejects(deniedRead.run(), /cards request for Asset failed with status 403/);
  assert.equal(deniedRead.requests.at(-1).path, classesPath + '/Asset/cards');
});

test('strict selection class budget spans driver-resolved class names, and row evidence identifies the owner', async () => {
  const names = [classItem('Asset'), classItem('Other')];
  const scoped = fixture(pagedCatalog(names), { maxClasses: 1 });
  const context = { driver: { rows: [{ Type: 'Asset' }, { Type: 'Other' }] } };
  assert.equal((await scoped.run({ className: '', from: 'driver', classColumn: 'Type' }, context)).truncated, true);
  assert.deepEqual(scoped.evidence.map((item) => [item.limitName, item.observed]), [['maxClasses', 2]]);
  for (const largeTableExecution of [false, true]) {
    const f = fixture((path) => path === classesPath ? page(names, { total: 2 }) : page(cards(2), { total: 2 }),
      { largeTableExecution });
    const result = await f.run({ className: '', from: 'driver', classColumn: 'Type' }, context);
    assert.equal(result.rowLimitReached, true);
    assert.deepEqual(f.evidence.map((item) => [item.limitName, item.source, item.configKey]), [
      ['maxRows', largeTableExecution ? 'product' : 'runtime-settings', largeTableExecution ? undefined : 'maxRowsDefault']
    ]);
  }
});
