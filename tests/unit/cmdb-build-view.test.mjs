import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CMDB_BUILD_VIEW_KIND,
  DEFAULT_CMDB_BUILD_VIEW_CODE,
  defaultCmdbBuildViewSpec,
  executeCmdbBuildViewSpec,
  isCmdbBuildViewSpec,
  validateCmdbBuildViewSpec
} from '../../src/special-renderers/cmdb-build-view.mjs';

test('cmdbBuildView default spec is a protected special template', () => {
  const spec = defaultCmdbBuildViewSpec();

  assert.equal(spec.kind, CMDB_BUILD_VIEW_KIND);
  assert.equal(spec.protected, true);
  assert.equal(DEFAULT_CMDB_BUILD_VIEW_CODE, 'CmdbBuildView');
  assert.equal(isCmdbBuildViewSpec(spec), true);
  assert.deepEqual(validateCmdbBuildViewSpec(spec), []);
});

test('cmdbBuildView validation rejects unsupported sections and invalid root class', () => {
  const errors = validateCmdbBuildViewSpec({
    version: 1,
    kind: CMDB_BUILD_VIEW_KIND,
    cmdbBuildView: {
      sections: ['classes', 'bad'],
      rootClass: 'bad-root',
      lookupScope: 'everything'
    }
  });

  assert.equal(errors.length, 3);
  assert.ok(errors.some((item) => item.path === '$.cmdbBuildView.sections[1]'));
  assert.ok(errors.some((item) => item.path === '$.cmdbBuildView.rootClass'));
  assert.ok(errors.some((item) => item.path === '$.cmdbBuildView.lookupScope'));
});

test('cmdbBuildView renderer builds minimal html from CMDBuild metadata', async () => {
  const spec = defaultCmdbBuildViewSpec();
  spec.cmdbBuildView.rootClass = 'Asset';
  const request = mockCmdbuildRequest({
    '/cmdbuild/services/rest/v3/translations?scope=service&limit=100000': [],
    '/cmdbuild/services/rest/v3/classes?limit=20&detailed=true': [
      { name: 'Asset', description: 'Asset', prototype: true },
      { name: 'Router', description: 'Router', parent: 'Asset', prototype: false }
    ],
    '/cmdbuild/services/rest/v3/classes/Asset/attributes?scope=service&limit=1000': [
      { name: 'Code', type: 'string' },
      { name: 'Id', type: 'integer', mode: 'syshidden' }
    ],
    '/cmdbuild/services/rest/v3/classes/Router/attributes?scope=service&limit=1000': [
      { name: 'Critical', type: 'lookup', lookupType: 'Criticality' }
    ],
    '/cmdbuild/services/rest/v3/domains?limit=20': [
      { name: 'AssetRouter', description: 'Asset Router', source: 'Asset', destination: 'Router', cardinality: '1:N' }
    ],
    '/cmdbuild/services/rest/v3/domains/AssetRouter': {
      name: 'AssetRouter',
      description: 'Asset Router',
      source: 'Asset',
      destination: 'Router',
      cardinality: '1:N'
    },
    '/cmdbuild/services/rest/v3/domains/AssetRouter/attributes?scope=service&limit=1000': [],
    '/cmdbuild/services/rest/v3/lookup_types?limit=1000': [
      { name: 'Criticality', description: 'Criticality' }
    ],
    '/cmdbuild/services/rest/v3/lookup_types/Criticality/values?scope=service&limit=1000': [
      { _id: 1, code: 'high', description: 'High', active: true }
    ]
  });

  const result = await executeCmdbBuildViewSpec(request, spec, {}, {
    limits: { maxClasses: 20, maxDomains: 20, maxRestCalls: 50 }
  });

  assert.equal(result.kind, 'html');
  assert.equal(result.htmlTrusted, true);
  assert.match(result.html, /Router/);
  assert.match(result.html, /Criticality/);
  assert.match(result.html, /data-result-filter/);
  assert.match(result.html, />1<\/span>[\s\S]*Asset/);
  assert.match(result.html, />1\.1<\/span>[\s\S]*Router/);
  assert.ok(result.html.indexOf('Asset') < result.html.indexOf('Router'));
  assert.doesNotMatch(result.html, />Id</);
  assert.equal(result.meta.classes, 2);
  assert.equal(result.meta.domains, 1);
  assert.equal(result.meta.lookups, 1);
});

function mockCmdbuildRequest(fixtures) {
  let restCalls = 0;
  const request = async (path) => {
    restCalls += 1;
    if (!Object.prototype.hasOwnProperty.call(fixtures, path)) {
      return { ok: false, statusCode: 404, json: { success: false, messages: [{ message: `missing fixture: ${path}` }] } };
    }
    const value = fixtures[path];
    return {
      ok: true,
      statusCode: 200,
      json: {
        success: true,
        data: Array.isArray(value) ? value : value
      }
    };
  };
  request.getRestCalls = () => restCalls;
  return request;
}
