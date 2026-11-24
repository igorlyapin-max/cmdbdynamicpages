import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';
import { executeTemplateRunWithCache, validateTemplateTransferTarget } from '../../scripts/dev-proxy-server.mjs';

const rest = '/cmdbuild/services/rest/v3';
const root = 'Cst_QueryTool';
const assetPath = `${rest}/classes/Asset`;
const assetAttributes = [
  { name: 'Location', type: 'reference', targetClass: 'Site', active: true },
  { name: 'Status', type: 'lookup', lookupType: 'AssetStatus', active: true }
];

function mockCmdbuild(t, respond) {
  const paths = [];
  for (const transport of [http, https]) t.mock.method(transport, 'request', (options, callback) => {
    assert.equal(options.method, 'GET');
    const url = new URL(options.path, 'http://mock.invalid');
    paths.push(url);
    const { statusCode = 200, data } = respond(url);
    return Object.assign(new EventEmitter(), {
      setTimeout() {},
      end() {
        const response = Object.assign(new EventEmitter(), { statusCode });
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({ data })));
        response.emit('end');
      }
    });
  });
  return paths;
}

for (const statusCode of [401, 403]) {
  test(`cache permission probe preserves ${statusCode} without retrying cards or running the template`, async (t) => {
    const paths = mockCmdbuild(t, (url) => {
      switch (url.pathname) {
        case `${rest}/classes`: return { data: [{ name: 'Asset' }] };
        case `${assetPath}/attributes`: return { data: assetAttributes };
        case `${assetPath}/cards`: return url.searchParams.has('attributes')
          ? { statusCode } : { data: [{ _id: 1, Location: 9 }] };
        default: assert.fail(url.pathname);
      }
    });
    const spec = {
      version: 1,
      cache: { scopeMode: 'permissionOnly' },
      steps: [{ type: 'selectCards', as: 'assets', className: 'Asset', columns: ['Location'] }],
      result: { tables: [{ name: 'assets', columns: ['Location'] }] }
    };
    await assert.rejects(executeTemplateRunWithCache('mock', root, { code: 'Probe', spec }, {}, {}, { maxRows: 10 }),
      { cmdbuildStatus: statusCode });
    assert.deepEqual(paths.map((url) => url.pathname), [`${rest}/classes`, `${assetPath}/attributes`, `${assetPath}/cards`]);
    assert.equal(paths.at(-1).searchParams.get('attributes'), 'Location');
  });
}

function mockTransferCatalog(t) {
  return mockCmdbuild(t, (url) => {
    switch (url.pathname) {
      case `${rest}/classes/Cst_QueryToolConfig/cards`: return { data: [] };
      case assetPath: return { data: { name: 'Asset', active: true } };
      case `${assetPath}/attributes`: return { data: assetAttributes };
      case `${rest}/classes/Site/cards/9`: return { data: { _id: 9 } };
      case `${rest}/lookup_types/AssetStatus/values/7`: return { data: { _id: 7 } };
      case `${rest}/lookup_types/AssetStatus/values/8`: return { statusCode: 404 };
      default: assert.fail(url.pathname);
    }
  });
}

const idReferences = (result) => result.environmentReferences.filter(({ kind }) => kind === 'card' || kind === 'lookup');
const idReads = (paths) => paths.map(({ pathname }) => pathname).filter((path) => /\/(cards|values)\/\d+$/.test(path));

test('transfer validates raw filter fields without treating text operands as IDs', async (t) => {
  const paths = mockTransferCatalog(t);
  const spec = {
    version: 1,
    params: { prefix: { type: 'string', default: 'North' } },
    steps: [
      { type: 'selectCards', as: 'assets', className: 'Asset', filters: [
        { attribute: 'Location', op: 'contains', value: 'central' },
        { attribute: 'Status', op: 'startsWith', value: '77' }
      ] },
      { type: 'filterRows', as: 'filtered', from: 'assets', filters: [
        { column: 'Location', op: 'startsWith', valueParam: 'prefix' },
        { column: 'Status', op: 'endsWith', value: 'active' },
        { column: 'Location', value: 9 },
        { column: 'Status', op: 'in', values: [7, 8] }
      ] }
    ]
  };
  const validation = await validateTemplateTransferTarget('mock', root, spec);
  assert.deepEqual(idReferences(validation).map(({ value }) => value), [9, 7, 8]);
  assert.deepEqual(validation.issues.map(({ code, path }) => [code, path]), [
    ['template_transfer_lookup_unavailable', '$.spec.steps[1].filters[3].values[1]']
  ]);
  assert.deepEqual(idReads(paths), [`${rest}/classes/Site/cards/9`, `${rest}/lookup_types/AssetStatus/values/7`, `${rest}/lookup_types/AssetStatus/values/8`]);
});

test('transfer excludes managed text rules and their compiled mirrors from ID checks', async (t) => {
  const paths = mockTransferCatalog(t);
  const spec = compileObjectFlowToSpec({ version: 1, steps: [] }, { version: 1, operations: [], selections: [{
    id: 'selection:assets', name: 'Assets', alias: 'assets', className: 'Asset', columns: ['Location', 'Status'], rules: [
      { action: 'include', path: 'Location', op: 'startsWith', rightExpression: 'North' },
      { action: 'include', path: 'Status', op: 'endsWith', rightExpression: '77' },
      { action: 'exclude', path: 'Location', op: 'notEquals', rightExpression: '9' },
      { action: 'include', path: 'Status', op: 'in', rightExpression: '7,8' }
    ]
  }] });
  const validation = await validateTemplateTransferTarget('mock', root, spec);
  const refs = idReferences(validation);
  assert.equal(refs.length, 4);
  assert.deepEqual([...new Set(refs.map(({ value }) => value))].sort(), ['7,8', '9']);
  assert.ok(refs.every(({ path }) => path.startsWith('$.spec.visualModels[')));
  assert.deepEqual(new Set(validation.issues.map(({ code }) => code)), new Set(['template_transfer_lookup_unavailable']));
  assert.deepEqual(idReads(paths), [`${rest}/classes/Site/cards/9`, `${rest}/lookup_types/AssetStatus/values/7`, `${rest}/lookup_types/AssetStatus/values/8`]);
});
