import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LARGE_TABLE_DEFAULT_PAGE_SIZE,
  LARGE_TABLE_MAX_PAGE_SIZE,
  LARGE_TABLE_ROW_BUDGET,
  LARGE_TABLE_MAX_MEMBERSHIPS,
  LARGE_TABLE_MAX_AGGREGATE_CELL_LENGTH,
  normalizeLargeTablePresentation,
  validateLargeTablePresentation,
  buildLargeTableIndex,
  encodeLargeTableKey,
  resolveLargeTableKey,
  queryLargeTablePage
} from '../../scripts/report-table-pages.mjs';

const selector = { kind: 'result', source: 'parents', idField: 'identity', labelField: 'title', matchField: 'Parent' };
const allConfig = { mode: 'all', groupKeys: [], reductions: [] };
const keyConfig = { ...allConfig, mode: 'key', selector };

function table(config, columns, rows) {
  return { name: 'result', published: true, columns, rows, presentation: { largeTable: config } };
}

test('large tables are opt-in and normalized without copying unrelated configuration', () => {
  assert.equal(normalizeLargeTablePresentation(undefined), null);
  assert.equal(normalizeLargeTablePresentation({}), null);
  assert.deepEqual(validateLargeTablePresentation(null), []);
  assert.equal(buildLargeTableIndex(table(undefined, ['N'], [{ N: 1 }])), null);
  assert.equal(queryLargeTablePage(null), null);
  assert.deepEqual(normalizeLargeTablePresentation({ mode: 'all' }), allConfig);
  assert.deepEqual(normalizeLargeTablePresentation({
    mode: 'key', selector: { ...selector, kind: 'class', source: ' ParentClass ', parameter: ' object ', extra: 7 },
    groupKeys: [' Group '], reductions: [{ column: ' Info ', kind: 'tuples', fields: [' Proto ', 'Port'], separator: ' | ', unknown: true }]
  }), {
    mode: 'key', selector: { ...selector, kind: 'class', source: 'ParentClass', parameter: 'object' },
    groupKeys: ['Group'], reductions: [{ column: 'Info', kind: 'tuples', fields: ['Proto', 'Port'], separator: ' | ' }]
  });
});

test('validation distinguishes hidden selector match from forbidden hidden group and reduction fields', () => {
  const catalog = { fields: ['Parent', 'Visible', 'Ports', 'Hidden'], visibleFields: ['Visible', 'Ports'], optionFields: new Set(['identity', 'title']) };
  assert.deepEqual(validateLargeTablePresentation(keyConfig, catalog), []);
  assert.deepEqual(validateLargeTablePresentation({
    ...keyConfig,
    selector: { ...selector, labelField: 'notAvailable' },
    groupKeys: ['Visible', 'Hidden'],
    reductions: [
      { column: 'Ports', kind: 'tuples', fields: ['Ports', 'Hidden'] },
      { column: 'Ports', kind: 'count', separator: '!' },
      { column: 'Visible', kind: 'unique' }
    ]
  }, catalog).map(({ path }) => path), [
    'selector.labelField', 'groupKeys[1]', 'reductions[0].fields[1]', 'reductions[1].column',
    'reductions[1].separator', 'reductions[2].column'
  ]);
  assert.throws(() => buildLargeTableIndex(table({ ...allConfig, groupKeys: ['Hidden'] }, ['Visible'], [])),
    { code: 'invalid_large_table_presentation' });
});

test('option keys preserve scalar types and CMDB card identity; matches accept arrays and private raw values', () => {
  const identities = [7, '7', false, 0, { Class: 'A', _id: 7, secret: 'private' }, { className: 'B', id: 7 }];
  const [number, string, bool, zero, a, b] = identities.map(encodeLargeTableKey);
  assert.equal(new Set(identities.map(encodeLargeTableKey)).size, identities.length);
  assert.equal(encodeLargeTableKey({ _type: 'A', _id: 7 }), a);
  for (const value of [null, {}, ['7'], Infinity, NaN, '']) assert.equal(encodeLargeTableKey(value), null);
  const rows = ['number and class A', 'string', 'false', 'zero', 'class B', 'unmatched', 'number again'].map((Value) => ({ Value }));
  const options = identities.map((identity) => ({ identity, title: 'Same label', extra: 'not projected' }));
  const index = buildLargeTableIndex(table(keyConfig, ['Value'], rows), [
    { identity: 7, title: '' }, ...options, { identity: 7, title: 'Ignored' }, { identity: {}, title: 'No identity' }
  ], { matchValues: [[7, 7, { className: 'A', id: 7 }], '7', false, 0, { class: 'B', id: 7 }, null, 7] });
  const optionPage = queryLargeTablePage(index, { op: 'options', search: 'ＳＡＭＥ' });
  assert.equal(optionPage.total, 6);
  assert.deepEqual(optionPage.items.map((item) => Object.keys(item)), Array.from({ length: 6 }, () => ['key', 'label']));
  assert.deepEqual(new Set(optionPage.items.map((item) => item.key)), new Set([number, string, bool, zero, a, b]));
  assert.deepEqual(resolveLargeTableKey(index, a), { className: 'A', id: 7 });
  assert.equal(resolveLargeTableKey(index, bool), false);
  assert.equal(resolveLargeTableKey(index, encodeLargeTableKey('unknown')), null);
  assert.deepEqual([number, string, bool, zero, a, b].map((key) => queryLargeTablePage(index, { key }).table.rows.map(({ Value }) => Value)), [
    ['number and class A', 'number again'], ['string'], ['false'], ['zero'], ['number and class A'], ['class B']
  ]);
  assert.equal(queryLargeTablePage(index).total, 0);
  assert.equal(queryLargeTablePage(index, { key: encodeLargeTableKey('unknown') }).total, 0);
});

test('matches the 400-option/4,000-row workload without sending unrelated rows or all options', () => {
  const options = Array.from({ length: 400 }, (_, identity) => ({ identity, title: `Object ${String(identity).padStart(3, '0')}` }));
  const rows = Array.from({ length: 4000 }, (_, Value) => ({
    Value, Parent: Value < 350 ? [0, Value % 400] : Value % 400, hidden: 'not shown'
  }));
  const index = buildLargeTableIndex(table(keyConfig, ['Value'], rows), options);
  const first = queryLargeTablePage(index, new URLSearchParams('op=options'));
  assert.equal(first.total, 400);
  assert.equal(first.items.length, 50);
  assert.deepEqual(queryLargeTablePage(index, { op: 'options', search: '399' }).items, [
    { key: encodeLargeTableKey(399), label: 'Object 399' }
  ]);
  const scoped = queryLargeTablePage(index, { key: first.items[0].key, sort: 'Value', offset: 95, limit: 200 });
  assert.equal(scoped.total, 359);
  assert.equal(scoped.limit, 100);
  assert.deepEqual(scoped.table.rows, Array.from({ length: 100 }, (_, i) => ({ Value: 95 + i })));
  assert.equal(queryLargeTablePage(index, { key: encodeLargeTableKey(399) }).total, 10);
});

test('pages 6,000 rows after global numeric sorting and visible search, with deterministic ties', () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({ Key: 6000 - i, Text: i % 100 === 0 ? 'needle' : 'hay' }));
  const base = table(allConfig, ['Key', 'Text'], rows);
  const index = buildLargeTableIndex(base);
  const page = queryLargeTablePage(index, { sort: 'Key', direction: 'asc' });
  assert.equal(page.total, 6000);
  assert.equal(page.limit, LARGE_TABLE_DEFAULT_PAGE_SIZE);
  assert.deepEqual(page.table.rows.map((row) => row.Key), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.deepEqual(queryLargeTablePage(index, { sort: 'Key', search: 'NEEDLE', offset: 49, limit: 5 }).table.rows.map((row) => row.Key), [
    5000, 5100, 5200, 5300, 5400
  ]);
  assert.deepEqual(queryLargeTablePage(index, { sort: 'Text', direction: 'asc', limit: 2 }).table.rows.map((row) => row.Key), [5999, 5998]);
  const typed = buildLargeTableIndex(table(allConfig, ['Value'], [null, '2', 10, 2, '10', true, false].map((Value) => ({ Value }))));
  assert.deepEqual(queryLargeTablePage(typed, { sort: 'Value' }).table.rows.map((row) => row.Value), [false, true, 2, 10, '10', '2', null]);
});

test('prebuilds scoped groups, keeps tuple associations and paginates original details', () => {
  const config = { ...keyConfig, groupKeys: ['IP'], reductions: [
    { column: 'Service', kind: 'tuples', fields: ['Protocol', 'Port'] },
    { column: 'Count', kind: 'count' },
    { column: 'Name', kind: 'unique', separator: ' | ' }
  ] };
  const rows = [
    { IP: '10.0.0.1', Protocol: 'UDP', Port: 53, Name: 'Beta', Secret: 'raw secret' },
    { IP: '10.0.0.1', Protocol: 'TCP', Port: 443, Name: 'Alpha' },
    { IP: '10.0.0.1', Protocol: 'TCP', Port: 80, Name: 'Alpha' },
    { IP: '10.0.0.1', Protocol: 'UDP', Port: 53, Name: 'Beta' },
    { IP: '10.0.0.1', Protocol: 'UDP', Port: 999, Name: 'Not this scope' },
    { IP: '10.0.0.2', Protocol: 'TCP', Port: 22, Name: 'Other group' }
  ];
  const source = table(config, ['IP', 'Service', 'Protocol', 'Port', 'Count', 'Name'], rows);
  source.cellMeta = { 0: { Port: { attribute: 'Port', sourceId: 'hidden source ID' } } };
  const index = buildLargeTableIndex(source, [{ identity: 1, title: 'One' }, { identity: 2, title: 'Two' }],
    { matchValues: [1, 1, [1, 2], 1, 2, 1] });
  const key = encodeLargeTableKey(1);
  const secondKey = encodeLargeTableKey(2);
  const page = queryLargeTablePage(index, { key, sort: 'IP', limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.table.rows[0], {
    IP: '10.0.0.1', Service: 'TCP [80, 443]; UDP [53]', Protocol: 'TCP, UDP', Port: '53, 80, 443', Count: 4, Name: 'Alpha | Beta'
  });
  assert.deepEqual(page.table.cellMeta, {});
  const [group] = page.groupIds;
  assert.notEqual(queryLargeTablePage(index, { key, limit: 1, offset: 1 }).groupIds[0], group);
  assert.equal(queryLargeTablePage(index, { key, search: '443' }).total, 1);
  assert.equal(queryLargeTablePage(index, { key, search: 'raw secret' }).total, 0);
  assert.equal(queryLargeTablePage(index, { key: secondKey }).table.rows[0].Service, 'TCP [80]; UDP [999]');
  assert.equal(queryLargeTablePage(index, { op: 'details', key: secondKey, group }).total, 2);
  assert.equal(queryLargeTablePage(index, { op: 'details', group }).total, 0);
  const detail = queryLargeTablePage(index, { op: 'details', key, group, sort: 'Port', direction: 'desc', offset: 2, limit: 1 });
  assert.equal(detail.total, 4);
  assert.equal(detail.table.rows[0].Port, 53);
  assert.deepEqual(detail.table.cellMeta, { 0: { Port: { attribute: 'Port' } } });
  assert.equal(Object.hasOwn(detail.table.rows[0], 'Secret'), false);
  assert.deepEqual(queryLargeTablePage(JSON.parse(JSON.stringify(index)), { key, limit: 1 }), page);
});

test('typed private group keys may share the same display without exposing raw values', () => {
  const config = { ...allConfig, groupKeys: ['Group'], reductions: [{ column: 'Count', kind: 'count' }] };
  const raw = { className: 'Parent', id: 'private-key-one' };
  const source = table(config, ['Group', 'Count'], [
    { Group: 'Same display' }, { Group: 'Same display' }, { Group: 'Same display' }
  ]);
  const index = buildLargeTableIndex(source, [], { groupValues: [[raw], [{ ...raw, internal: 'private' }], [{ ...raw, id: 1 }]] });
  const result = queryLargeTablePage(index);
  assert.deepEqual(result.table.rows, [{ Group: 'Same display', Count: 2 }, { Group: 'Same display', Count: 1 }]);
  assert.equal(new Set(result.groupIds).size, 2);
  assert.doesNotMatch(JSON.stringify(index), /private-key-one|internal/);
  assert.throws(() => buildLargeTableIndex(source, [], { groupValues: [[raw]] }), { code: 'invalid_large_table_rows' });
});

test('projects regular page metadata to local indexes and makes a detached immutable index', () => {
  const source = table(allConfig, ['Text'], [{ Text: 0 }, { Text: { label: 'Display', data: 'sensitive' }, Hidden: 'hidden data' }]);
  source.columnLabels = { Text: 'Title', Hidden: 'hidden label' };
  source.presentation.columnLinks = { Text: { mode: 'auto', internal: 'private config' }, Hidden: { mode: 'link' } };
  source.cellMeta = {
    1: { Text: { attributeType: 'url', autoHref: 'https://example.test/page', sourceId: 'private field', sourceUrls: { internal: 'secret' } },
      Hidden: { attribute: 'hidden' } }
  };
  const index = buildLargeTableIndex(source);
  source.rows[1].Text.label = 'changed';
  source.columnLabels.Text = 'changed';
  const page = queryLargeTablePage(index, { offset: 1, limit: 1 });
  assert.deepEqual(page.table.rows, [{ Text: 'Display' }]);
  assert.deepEqual(page.table.columnLabels, { Text: 'Title' });
  assert.deepEqual(page.table.cellMeta, { 0: { Text: { attributeType: 'url', autoHref: 'https://example.test/page' } } });
  assert.deepEqual(page.table.presentation.columnLinks, { Text: { mode: 'auto' } });
  assert.doesNotMatch(JSON.stringify(index), /sensitive|hidden data|sourceId|private config|private field|sourceUrls/);
  assert.throws(() => { index.rows[1].visible.Text = 'changed'; }, TypeError);
  assert.equal(queryLargeTablePage(index, { search: 'hidden data' }).total, 0);
  assert.throws(() => queryLargeTablePage(index, { sort: 'Hidden' }), { code: 'invalid_large_table_query' });
});

test('sets incomplete on every operation and rejects malformed pagination and keys', () => {
  const source = table(keyConfig, ['Name'], [{ Name: 'one', Parent: 1 }]);
  source.truncated = true;
  const index = buildLargeTableIndex(source, [{ identity: 1, title: 'One' }]);
  for (const op of ['options', 'rows', 'details']) assert.equal(queryLargeTablePage(index, { op }).incomplete, true);
  assert.equal(queryLargeTablePage(index, { limit: 1000 }).limit, LARGE_TABLE_MAX_PAGE_SIZE);
  for (const query of [
    { op: 'bad' }, { limit: '-5' }, { limit: 0 }, { offset: '1e3' }, { offset: 1.2 }, { direction: 'up' }, { key: 'one' }, { group: 'bad' },
    new URLSearchParams('limit=2&limit=5')
  ]) assert.throws(() => queryLargeTablePage(index, query), { code: 'invalid_large_table_query' });
});

test('enforces original row and derived membership budgets without publishing a partial index', () => {
  const rows = Array.from({ length: LARGE_TABLE_ROW_BUDGET }, (_, index) => ({ Value: index }));
  assert.equal(queryLargeTablePage(buildLargeTableIndex(table(allConfig, ['Value'], rows))).total, LARGE_TABLE_ROW_BUDGET);
  assert.throws(() => buildLargeTableIndex(table(allConfig, ['Value'], [...rows, {}])), { code: 'large_table_row_limit' });
  const options = [{ identity: 1, title: 'One' }];
  assert.throws(() => buildLargeTableIndex(table(keyConfig, ['Value'], [{ Value: 'one' }, { Value: 'two' }]), options, {
    matchValues: [Array(LARGE_TABLE_MAX_MEMBERSHIPS / 2).fill(1), Array(LARGE_TABLE_MAX_MEMBERSHIPS / 2 + 1).fill(1)]
  }), { code: 'large_table_membership_limit' });
});

test('limits very broad aggregate cell text without dropping any detail rows', () => {
  const config = { ...allConfig, groupKeys: ['Parent'], reductions: [{ column: 'Values', kind: 'tuples', fields: ['Parent', 'Values'] }] };
  const rows = Array.from({ length: 6000 }, (_, Value) => ({ Parent: 'Group', Values: `Record-${Value}` }));
  const index = buildLargeTableIndex(table(config, ['Parent', 'Values'], rows));
  const page = queryLargeTablePage(index);
  assert.equal(page.table.rows.length, 1);
  assert.equal(page.incomplete, false);
  const text = page.table.rows[0].Values;
  assert.equal(text.length, LARGE_TABLE_MAX_AGGREGATE_CELL_LENGTH);
  assert.match(text, /\.\.\.$/u);
  const detail = queryLargeTablePage(index, { op: 'details', group: page.groupIds[0], offset: 5975 });
  assert.equal(detail.total, 6000);
  assert.deepEqual(detail.table.rows.at(-1), rows.at(-1));
});

test('bounds total precomputed aggregate text across independently expandable groups', () => {
  const config = { ...allConfig, groupKeys: ['Group'] };
  const Value = 'x'.repeat(LARGE_TABLE_MAX_AGGREGATE_CELL_LENGTH);
  const rows = Array.from({ length: 4097 }, (_, Group) => ({ Group, Value }));
  assert.throws(() => buildLargeTableIndex(table(config, ['Group', 'Value'], rows)), { code: 'large_table_aggregate_limit' });
});
