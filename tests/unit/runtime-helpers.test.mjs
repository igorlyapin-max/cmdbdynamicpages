import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplateParamDefaults,
  baaErrorResponse,
  baaResponseFromRuntimeResult,
  buildResultCellMeta,
  defaultRuntimeConfig,
  dependencyMapWithHash,
  executeBaaPlanObjects,
  ipv4ValueMatches,
  isSafeRuntimeLinkUrl,
  normalizedBaaRequestForCache,
  normalizeRuntimeCacheConfig,
  normalizeTemplateCacheConfig,
  normalizeTemplateSpecForStorage,
  renderCellTemplate,
  renderRuntimeParamTemplate,
  runtimeCacheKeyParts,
  runtimeJsonOutputRequested,
  runtimeJsonResponsePayload,
  templateIsProtected,
  validateBaaVerificationRequest
} from '../../scripts/dev-proxy-server.mjs';

test('only CmdbBuildView templates are protected by spec protection flag', () => {
  assert.equal(templateIsProtected({ code: 'CmdbBuildView', spec: { version: 1 } }), true);
  assert.equal(templateIsProtected({ code: 'netverify', spec: { version: 1, protected: true, endpoint: { kind: 'baaVerification' } } }), false);
  assert.equal(templateIsProtected({ code: 'ModelViewCopy', spec: { version: 1, kind: 'cmdbBuildView', protected: true } }), false);
});

test('non-special templates drop stale protected flags before storage', () => {
  assert.deepEqual(
    normalizeTemplateSpecForStorage({
      version: 1,
      protected: true,
      system: { protected: true, owner: 'admin' },
      endpoint: { kind: 'baaVerification' }
    }),
    {
      version: 1,
      system: { owner: 'admin' },
      endpoint: { kind: 'baaVerification' },
      steps: [{ type: 'baaPlanObjects', as: 'baaObjects', payloadPrefix: 'Payload.' }]
    }
  );
  assert.deepEqual(
    normalizeTemplateSpecForStorage({
      version: 1,
      kind: 'cmdbBuildView',
      protected: true,
      cmdbBuildView: { language: 'auto' },
      endpoint: { kind: 'baaVerification' }
    }, 'netverify'),
    {
      version: 1,
      endpoint: { kind: 'baaVerification' },
      steps: [{ type: 'baaPlanObjects', as: 'baaObjects', payloadPrefix: 'Payload.' }]
    }
  );
  assert.deepEqual(
    normalizeTemplateSpecForStorage({
      version: 1,
      endpoint: { kind: 'baaVerification' },
      steps: [{ type: 'enrichRows', as: 'objectsView', from: 'objects', purpose: 'viewComposer', columns: [] }],
      visualModel: { mode: 'viewComposer', source: { alias: 'objects' } }
    }, 'netverify').steps,
    [
      { type: 'baaPlanObjects', as: 'objects', payloadPrefix: 'Payload.' },
      { type: 'enrichRows', as: 'objectsView', from: 'objects', purpose: 'viewComposer', columns: [] }
    ]
  );
  assert.deepEqual(
    normalizeTemplateSpecForStorage({
      version: 1,
      endpoint: { kind: 'baaVerification' },
      steps: [
        { type: 'baaPlanObjects', as: 'objects', payloadPrefix: 'Payload.' },
        { type: 'enrichRows', as: 'objectsView', from: 'objects', purpose: 'viewComposer', columns: [] }
      ]
    }, 'netverify').steps,
    [
      { type: 'baaPlanObjects', as: 'objects', payloadPrefix: 'Payload.' },
      { type: 'enrichRows', as: 'objectsView', from: 'objects', purpose: 'viewComposer', columns: [] }
    ]
  );
  assert.deepEqual(
    normalizeTemplateSpecForStorage({
      version: 1,
      endpoint: { kind: 'baaVerification' },
      steps: [
        { type: 'selectCards', as: 'objects', className: 'Router' },
        { type: 'enrichRows', as: 'objectsView', from: 'objects', purpose: 'viewComposer', columns: [] }
      ]
    }, 'netverify').steps,
    [
      { type: 'selectCards', as: 'objects', className: 'Router' },
      { type: 'enrichRows', as: 'objectsView', from: 'objects', purpose: 'viewComposer', columns: [] }
    ]
  );
});

test('BAA plan objects can feed the objects alias used by final data', () => {
  const table = executeBaaPlanObjects({ as: 'objects', payloadPrefix: 'Payload.' }, {
    plan: {
      objects: [{
        kind: 'ACL',
        className: 'ACL',
        payload: { Code: 'ACL-001', ipaddress: '10.10.2.15' }
      }]
    }
  }, { maxRows: 100 });

  assert.deepEqual(table.rows, [{
    PlanIndex: 0,
    Kind: 'ACL',
    ClassName: 'ACL',
    PageShapeKey: '',
    MappingKey: '',
    RelationBindingStatus: '',
    'Payload.Code': 'ACL-001',
    'BAA.ACL.Code': 'ACL-001',
    'Payload.ipaddress': '10.10.2.15',
    'BAA.ACL.ipaddress': '10.10.2.15'
  }]);
});

test('template params combine defaults and explicit values without clearing defaults on empty input', () => {
  const spec = {
    defaults: { city: 'city01' },
    paramDefaults: { routerName: 'router001' },
    classNameFallback: 'Router',
    params: {
      optionalText: { type: 'string', default: 'default text' },
      explicitText: { type: 'string', default: 'old text' }
    }
  };

  const params = applyTemplateParamDefaults(spec, {
    city: 'city49',
    optionalText: '',
    explicitText: 'new text'
  });

  assert.deepEqual(params, {
    city: 'city49',
    routerName: 'router001',
    className: 'Router',
    optionalText: 'default text',
    explicitText: 'new text'
  });
});

test('runtime title templates support param placeholders', () => {
  assert.equal(
    renderRuntimeParamTemplate('Routers for ${param.city}', { city: 'city49' }),
    'Routers for city49'
  );
  assert.equal(
    renderRuntimeParamTemplate('Routers for ${params.city}', { city: 'city49' }),
    'Routers for city49'
  );
});

test('runtime cell link templates support current cell, row and params', () => {
  const rendered = renderCellTemplate(
    '/cmdbuild/ui/#classes/${mysource.sourceClass}/cards/${mysource.sourceId}?city=${param.city}&ip=${row.Выборка2.ipaddress}',
    {
      mysource: {
        value: 'router047',
        source: 'Выборка2',
        sourceClass: 'Router',
        sourceId: 47,
        attribute: 'Code',
        domainPath: 'CityRouter'
      },
      row: { 'Выборка2.ipaddress': '10.1.2.3' },
      params: { city: 'city49' }
    }
  );

  assert.equal(rendered, '/cmdbuild/ui/#classes/Router/cards/47?city=city49&ip=10.1.2.3');
});

test('runtime cell link templates support ready source URLs for matched selections', () => {
  const meta = buildResultCellMeta([
    {
      Class: 'City',
      _id: 49,
      'Выборка2.Class': 'Router',
      'Выборка2._id': 47,
      'Selection3.Class': 'Country',
      'Selection3._id': 7
    }
  ], ['Выборка2.Code']);

  assert.equal(
    renderCellTemplate('${mysource.sourceURLВыборка1}', { mysource: meta[0]['Выборка2.Code'] }),
    '/cmdbuild/ui/#classes/City/cards/49'
  );
  assert.equal(
    renderCellTemplate('${mysource.sourceURLВыборка2}', { mysource: meta[0]['Выборка2.Code'] }),
    '/cmdbuild/ui/#classes/Router/cards/47'
  );
  assert.equal(
    renderCellTemplate('${mysource.sourceURLSelection3}', { mysource: meta[0]['Выборка2.Code'] }),
    '/cmdbuild/ui/#classes/Country/cards/7'
  );
});

test('runtime source URLs tolerate underscore and id variants from final rows', () => {
  const meta = buildResultCellMeta([
    {
      Class: 'City',
      _id: 49,
      'Выборка2_Class': 'Router',
      'Выборка2_id': 47,
      Selection3RelatedClass: 'Country',
      Selection3RelatedId: 7
    }
  ], ['Code']);

  assert.equal(
    renderCellTemplate('${mysource.sourceURLВыборка2}', { mysource: meta[0].Code }),
    '/cmdbuild/ui/#classes/Router/cards/47'
  );
  assert.equal(
    renderCellTemplate('${mysource.sourceURLSelection3Related}', { mysource: meta[0].Code }),
    '/cmdbuild/ui/#classes/Country/cards/7'
  );
});

test('runtime json output flag is an output mode and not a business parameter', () => {
  assert.equal(runtimeJsonOutputRequested(new URL('http://local/run?json=true')), true);
  assert.equal(runtimeJsonOutputRequested(new URL('http://local/run?json=1')), true);
  assert.equal(runtimeJsonOutputRequested(new URL('http://local/run?json=yes')), true);
  assert.equal(runtimeJsonOutputRequested(new URL('http://local/run?json=false')), false);
});

test('runtime json response exposes visible table rows and safe cell links', () => {
  const payload = runtimeJsonResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'testtemplate', description: 'Test template' },
    params: { city: 'city49' },
    result: {
      tables: [
        {
          name: 'RawObjects',
          columns: ['Code'],
          rows: [{ Code: 'raw' }]
        },
        {
          name: 'final',
          title: 'Routers',
          columns: ['Code'],
          columnLabels: { Code: 'Router code' },
          rows: [{ Code: 'router047', Class: 'Router', _id: 47 }],
          cellMeta: buildResultCellMeta([{ Code: 'router047', Class: 'Router', _id: 47 }], ['Code']),
          presentation: {
            columnLinks: {
              Code: {
                mode: 'link',
                urlTemplate: '${mysource.sourceURL}',
                textTemplate: '${mysource.value}',
                target: 'blank'
              }
            }
          }
        }
      ]
    },
    cache: { status: 'hit', expiresAt: '2026-05-19T16:00:00Z' }
  });

  assert.equal(payload.success, true);
  assert.equal(payload.template.code, 'testtemplate');
  assert.deepEqual(payload.params, { city: 'city49' });
  assert.equal(payload.tables.length, 1);
  assert.equal(payload.tables[0].title, 'Routers');
  assert.deepEqual(payload.tables[0].columns, [{ key: 'Code', label: 'Router code' }]);
  assert.deepEqual(payload.tables[0].rows[0].values, { Code: 'router047' });
  assert.equal(payload.tables[0].rows[0].links.Code.href, '/cmdbuild/ui/#classes/Router/cards/47');
  assert.equal(payload.cache.status, 'hit');
});

test('BAA request validation and plan objects create an internal table', () => {
  const spec = {
    endpoint: { kind: 'baaVerification' },
    baaContract: {
      code: 'contract-verification-input-v1',
      version: '1',
      contractParams: [
        { name: 'strictMode', type: 'boolean', required: false, default: false }
      ],
      objects: [
        {
          alias: 'aclCandidate',
          className: 'ACL',
          payload: [
            { name: 'Code', type: 'string', required: true },
            { name: 'destinationAddress', type: 'ipv4-cidr', required: true }
          ]
        }
      ]
    }
  };
  const request = {
    source: 'CMDB BAA',
    inputContract: { code: 'contract-verification-input-v1', version: '1', checksum: 'sha256-test' },
    contractParams: [{ name: 'strictMode', type: 'boolean', required: false, defaultValue: false }],
    variables: { sourceSegment: ['office', 'dmz'] },
    variableSources: [{ name: 'sourceSegment', sourceKind: 'class', sourceExpression: 'class.ACL.segment', valuePresent: true }],
    endpoint: { code: 'network-acl-check', params: { environment: 'prod', strictMode: true } },
    plan: {
      objects: [
        {
          planIndex: 0,
          kind: 'aclCandidate',
          className: 'ACL',
          pageShapeKey: 'visio/pages/page1.xml:12',
          mappingKey: 'connector:acl',
          relationBindingStatus: 'bound',
          payload: {
            Code: 'ACL-001',
            destinationAddress: '10.0.0.0/24'
          }
        }
      ],
      missingAttributes: [],
      skipped: []
    }
  };

  assert.equal(validateBaaVerificationRequest(request, spec).ok, true);
  assert.equal(validateBaaVerificationRequest({ plan: { objects: [{ payload: [] }] } }).ok, false);
  assert.equal(validateBaaVerificationRequest({ endpoint: { params: { strictMode: 'wrong' } }, plan: { objects: [{ kind: 'aclCandidate', payload: { Code: 'ACL-001' } }] } }, spec).ok, false);
  assert.equal(renderRuntimeParamTemplate('mode ${contractparam.strictMode}', { 'contractparam.strictMode': true }), 'mode true');
  assert.deepEqual(normalizedBaaRequestForCache(request).variables.sourceSegment, ['office', 'dmz']);
  assert.equal(normalizedBaaRequestForCache(request).variableSources[0].sourceKind, 'class');

  const table = executeBaaPlanObjects({ payloadPrefix: 'Payload.' }, request, { maxRows: 100 }, spec.baaContract);
  assert.deepEqual(table.columns, [
    'PlanIndex',
    'Kind',
    'ClassName',
    'PageShapeKey',
    'MappingKey',
    'RelationBindingStatus',
    'Payload.Code',
    'BAA.aclCandidate.Code',
    'BAA.ACL.Code',
    'Payload.destinationAddress',
    'BAA.aclCandidate.destinationAddress',
    'BAA.ACL.destinationAddress'
  ]);
  assert.equal(table.rows[0].PlanIndex, 0);
  assert.equal(table.rows[0].ClassName, 'ACL');
  assert.equal(table.rows[0]['Payload.destinationAddress'], '10.0.0.0/24');
  assert.equal(table.rows[0]['BAA.aclCandidate.destinationAddress'], '10.0.0.0/24');
});

test('BAA input contract classes are treated as candidate objects', () => {
  const spec = {
    endpoint: { kind: 'baaVerification' },
    baaContract: {
      code: 'contract-verification-input-v1',
      version: '1',
      classes: [
        {
          name: 'ACL',
          attributes: [
            { name: 'Code', type: 'string', required: true },
            { name: 'destinationAddress', type: 'ipv4-cidr', required: true }
          ]
        }
      ]
    }
  };
  const request = {
    plan: {
      objects: [
        {
          planIndex: 7,
          kind: 'context',
          className: 'ACL',
          payload: {
            Code: 'ACL-001',
            destinationAddress: '10.0.0.0/24'
          }
        }
      ]
    }
  };

  assert.equal(validateBaaVerificationRequest(request, spec).ok, true);
  assert.equal(validateBaaVerificationRequest({ plan: { objects: [{ className: 'ACL', payload: { Code: 'ACL-001' } }] } }, spec).ok, false);

  const table = executeBaaPlanObjects({ payloadPrefix: 'Payload.' }, request, { maxRows: 100 }, spec.baaContract);
  assert.ok(table.columns.includes('BAA.ACL.Code'));
  assert.ok(table.columns.includes('BAA.ACL.destinationAddress'));
  assert.equal(table.rows[0]['BAA.ACL.destinationAddress'], '10.0.0.0/24');
});

test('BAA runtime adapter converts result tables and errors to BAA envelope', () => {
  const result = {
    tables: [
      {
        name: 'destination_networks',
        title: 'Destination является сетью',
        columns: ['aclCode', 'destination'],
        columnLabels: { aclCode: 'ACL', destination: 'Destination' },
        rows: [
          { aclCode: 'ACL-001', destination: '10.0.0.0/24' }
        ]
      }
    ]
  };

  const response = baaResponseFromRuntimeResult(result, { code: 'network-acl-check', description: 'Network ACL check' });
  assert.equal(response.success, true);
  assert.equal(response.status, 'completed');
  assert.equal(response.summary.rows, 1);
  assert.deepEqual(response.tables[0].columns, [
    { name: 'aclCode', title: 'ACL', type: 'string' },
    { name: 'destination', title: 'Destination', type: 'string' }
  ]);
  assert.deepEqual(response.tables[0].rows[0], {
    aclCode: 'ACL-001',
    destination: '10.0.0.0/24'
  });

  const error = baaErrorResponse('CMDB_PERMISSION_DENIED', 'Недостаточно прав');
  assert.equal(error.success, false);
  assert.equal(error.status, 'error');
  assert.equal(error.items[0].code, 'CMDB_PERMISSION_DENIED');
});

test('BAA cache context changes runtime cache keys without changing business params', () => {
  const spec = {
    version: 1,
    steps: [{ type: 'baaPlanObjects', as: 'baaObjects' }],
    result: { tables: [{ name: 'baaObjects', columns: ['PlanIndex', 'Payload.Code'] }] }
  };
  const template = { code: 'BaaProbe', active: true, spec };
  const runtimeCache = normalizeRuntimeCacheConfig(defaultRuntimeConfig());
  const config = normalizeTemplateCacheConfig({ cache: { scopeMode: 'permissionOnly' } }, runtimeCache);
  const dependencyMap = dependencyMapWithHash(spec);
  const requestA = normalizedBaaRequestForCache({ endpoint: { params: { environment: 'prod' } }, plan: { objects: [{ planIndex: 1, payload: { Code: 'ACL-001' } }] } });
  const requestB = normalizedBaaRequestForCache({ endpoint: { params: { environment: 'prod' } }, plan: { objects: [{ planIndex: 1, payload: { Code: 'ACL-002' } }] } });

  const keyA = runtimeCacheKeyParts('Cst_QueryTool', template, { environment: 'prod' }, { username: 'alice' }, {
    maxRows: 25,
    maxClasses: 10,
    maxDomains: 10,
    maxRestCalls: 50,
    maxTraversalDepth: 1
  }, runtimeCache, config, dependencyMap, {}, { baa: requestA });
  const keyB = runtimeCacheKeyParts('Cst_QueryTool', template, { environment: 'prod' }, { username: 'alice' }, {
    maxRows: 25,
    maxClasses: 10,
    maxDomains: 10,
    maxRestCalls: 50,
    maxTraversalDepth: 1
  }, runtimeCache, config, dependencyMap, {}, { baa: requestB });

  assert.notEqual(keyA.key, keyB.key);
  assert.equal(keyA.paramsHash, keyB.paramsHash);
});

test('runtime link URL safety blocks script-like protocols', () => {
  assert.equal(isSafeRuntimeLinkUrl('/cmdbuild/ui/#classes/Router/cards/47'), true);
  assert.equal(isSafeRuntimeLinkUrl('https://example.test/router047'), true);
  assert.equal(isSafeRuntimeLinkUrl('mailto:owner@example.test'), true);
  assert.equal(isSafeRuntimeLinkUrl('javascript:alert(1)'), false);
  assert.equal(isSafeRuntimeLinkUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeRuntimeLinkUrl('vbscript:msgbox(1)'), false);
});

test('result cell metadata preserves source class and card id for projected rows', () => {
  const meta = buildResultCellMeta([
    {
      __source: 'Выборка2',
      Class: 'Router',
      _id: 47,
      Domain: 'CityRouter',
      Code: 'router047'
    }
  ], ['Code']);

  assert.deepEqual(meta, {
    0: {
      Code: {
        source: 'Выборка2',
        sourceClass: 'Router',
        sourceId: '47',
        attribute: 'Code',
        domainPath: 'CityRouter',
        sourceURL: '/cmdbuild/ui/#classes/Router/cards/47',
        sourceURLSelection1: '/cmdbuild/ui/#classes/Router/cards/47',
        sourceURLВыборка1: '/cmdbuild/ui/#classes/Router/cards/47',
        sourceURLВыборка2: '/cmdbuild/ui/#classes/Router/cards/47',
        sourceUrls: {
          sourceURL: '/cmdbuild/ui/#classes/Router/cards/47',
          sourceURLSelection1: '/cmdbuild/ui/#classes/Router/cards/47',
          sourceURLВыборка1: '/cmdbuild/ui/#classes/Router/cards/47',
          sourceURLВыборка2: '/cmdbuild/ui/#classes/Router/cards/47'
        }
      }
    }
  });
});

test('ipv4 comparison operators cover address, CIDR and range cases', () => {
  assert.equal(ipv4ValueMatches('10.1.2.3', '10.1.2.0/24', 'ipv4InCidr'), true);
  assert.equal(ipv4ValueMatches('10.1.3.3', '10.1.2.0/24', 'ipv4InCidr'), false);
  assert.equal(ipv4ValueMatches('10.1.2.8', '10.1.2.1-10.1.2.20', 'ipv4InRange'), true);
  assert.equal(ipv4ValueMatches('10.1.2.0/24', '10.1.2.128/25', 'ipv4CidrContains'), true);
  assert.equal(ipv4ValueMatches('10.1.2.0/25', '10.1.2.128/25', 'ipv4CidrOverlaps'), false);
});

test('BAA plan object filters support negation and IP shape operators', () => {
  const contract = {
    objects: [{
      alias: 'aclCandidate',
      className: 'ACL',
      payload: [
        { name: 'Code', type: 'string' },
        { name: 'sourceAddress', type: 'ipv4' },
        { name: 'destinationAddress', type: 'ipv4-cidr' }
      ]
    }]
  };
  const request = {
    plan: {
      objects: [
        {
          kind: 'aclCandidate',
          className: 'ACL',
          payload: {
            Code: 'ACL-001',
            sourceAddress: '10.1.2.15',
            destinationAddress: '10.1.2.0/24'
          }
        },
        {
          kind: 'aclCandidate',
          className: 'ACL',
          payload: {
            Code: 'ACL-002',
            sourceAddress: 'not-an-ip',
            destinationAddress: 'plain-text'
          }
        }
      ]
    }
  };

  const onlyIp = executeBaaPlanObjects({
    payloadPrefix: 'Payload.',
    filters: [{ path: 'BAA.aclCandidate.sourceAddress', op: 'isIpv4' }]
  }, request, { maxRows: 100 }, contract);
  assert.deepEqual(onlyIp.rows.map((row) => row['BAA.aclCandidate.Code']), ['ACL-001']);

  const notNetwork = executeBaaPlanObjects({
    payloadPrefix: 'Payload.',
    filters: [{ path: 'BAA.aclCandidate.destinationAddress', op: 'isIpv4Network', negate: true }]
  }, request, { maxRows: 100 }, contract);
  assert.deepEqual(notNetwork.rows.map((row) => row['BAA.aclCandidate.Code']), ['ACL-002']);

  const legacyNotExists = executeBaaPlanObjects({
    payloadPrefix: 'Payload.',
    filters: [{ path: 'BAA.aclCandidate.missingField', op: 'notExists' }]
  }, request, { maxRows: 100 }, contract);
  assert.equal(legacyNotExists.rows.length, 2);
});

test('dependency map includes only fields used by selection, matching and final result', () => {
  const spec = {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        className: 'Router',
        as: 'Selection1',
        filters: [{ attribute: 'City', op: 'equals', valueParam: 'city' }],
        columns: ['Code', 'Description']
      },
      {
        type: 'selectCards',
        className: 'Network',
        as: 'Selection2',
        columns: ['Code', 'Network']
      },
      {
        type: 'matchRows',
        from: 'Selection1',
        with: 'Selection2',
        rules: [{ leftColumn: 'ipaddress', rightColumn: 'Network', operator: 'ipv4InCidr' }],
        as: 'Matched'
      }
    ],
    result: {
      tables: [{ name: 'Matched', columns: ['Code', 'Selection2_Code', 'Selection2_Network'] }]
    }
  };

  const map = dependencyMapWithHash(spec);

  assert.equal(map.strategy, 'usedFieldsOnly');
  assert.ok(map.hash);
  assert.deepEqual(map.classes.sort(), ['Network', 'Router']);
  assert.deepEqual(
    map.selections.find((item) => item.as === 'Selection1').directFields.sort(),
    ['Class', '_id', 'City', 'Code', 'Description', 'ipaddress'].sort()
  );
  assert.deepEqual(
    map.selections.find((item) => item.as === 'Selection2').directFields.sort(),
    ['Class', '_id', 'Code', 'Description', 'Network'].sort()
  );
});
