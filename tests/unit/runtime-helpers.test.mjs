import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplateParamDefaults,
  buildResultCellMeta,
  dependencyMapWithHash,
  ipv4ValueMatches,
  isSafeRuntimeLinkUrl,
  renderCellTemplate,
  renderRuntimeParamTemplate,
  runtimeJsonOutputRequested,
  runtimeJsonResponsePayload
} from '../../scripts/dev-proxy-server.mjs';

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
