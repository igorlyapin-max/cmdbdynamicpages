import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';

function apiObjectFlowSpec(selections, operations = []) {
  return compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1,
    selections: selections.map((selection, index) => ({
      id: `selection:${selection.alias}`,
      name: `Selection ${index + 1}`,
      alias: selection.alias,
      className: selection.className,
      from: '',
      limit: 100,
      columns: selection.columns || [],
      rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
    })),
    operations: operations.map((operation) => Object.assign({ type: 'match' }, operation))
  });
}

test('draft preview executes exact router anchor before selecting ARM cards by Location', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=preview-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const spec = {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'routerG',
        filters: [{ path: 'Description', op: 'equals', value: 'Маршрутизатор для Test City 300' }],
        columns: ['Code', 'Description', 'Location'],
        limit: 1
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'ARM',
        filters: [{ path: 'Location', op: 'equals', valueColumn: 'Location' }],
        columns: ['Code', 'Description', 'Location', 'model', 'model2'],
        limit: 100
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Code', 'Description', 'Location', 'model', 'model2'] }]
    }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: {
      code: 'RouterArmPreview',
      spec
    },
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json.success, true);
  assert.deepEqual(preview.json.result.trace.map((item) => [item.as, item.rows]), [
    ['routerAnchor', 1],
    ['arms', 2]
  ]);
  const table = preview.json.result.tables.find((item) => item.name === 'arms');
  assert.ok(table, 'arms table is present');
  assert.deepEqual(table.rows.map((row) => row.Code).sort(), ['ARM-001', 'ARM-002']);
  assert.deepEqual(
    table.rows.map((row) => [row.Code, row.model, row.model2]).sort((left, right) => left[0].localeCompare(right[0])),
    [
      ['ARM-001', 'model-a', 'model2-a'],
      ['ARM-002', 'model-b', 'model2-b']
    ]
  );
  assert.equal(table.rows.some((row) => row.Code === 'ARM-003'), false);
  assert.equal(table.rows.some((row) => row.Class === 'routerG'), false);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), true);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), true);
  const armCardsRequest = mock.requests.find((item) => item.pathname.endsWith('/classes/ARM/cards'));
  const requestedAttributes = new URLSearchParams(armCardsRequest.search).get('attributes') || '';
  assert.ok(requestedAttributes.split(',').includes('model'));
  assert.ok(requestedAttributes.split(',').includes('model2'));
  assert.equal(mock.requests.some((item) => item.pathname.includes('/relations')), false);
  assert.equal(backend.exitCode, null);
});

test('explicit matchRows preserves matching cards without hidden selection rewriting', async (t) => {
  const mock = await startMockCmdbuild(t, {
    routerCards: [
      { _id: 301, Code: 'router-a', Description: 'Router A', Location: 301, _Location_description: 'Shared location' },
      { _id: 302, Code: 'router-b', Description: 'Router B', Location: 302, _Location_description: 'Shared location' }
    ],
    armCards: [
      { _id: 501, Code: 'ARM-001', Description: 'ARM 001', Location: 901, _Location_description: 'Shared location' }
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=deduplicate-match-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const spec = apiObjectFlowSpec([
    { alias: 'routers', className: 'routerG', columns: ['Location'] },
    { alias: 'arms', className: 'ARM', columns: ['Location'] }
  ], [{
    id: 'match:coLocated',
    from: 'routers',
    with: 'arms',
    as: 'coLocated',
    rightPrefix: 'Arms.',
    rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Location', leftRegex: '', rightColumn: 'Location', rightRegex: '' }]
  }]);

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'DeduplicatedExactMatch', spec },
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.trace.map((item) => [item.as, item.rows]), [
    ['routers', 2],
    ['arms', 1],
    ['coLocated', 2]
  ]);
  const table = preview.json.result.tables.find((item) => item.name === 'coLocated');
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows.map((row) => row.Code).sort(), ['router-a', 'router-b']);
  assert.equal(backend.exitCode, null);
});

test('draft preview executes unionRows and differenceRows without CMDBuild reads', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=set-operations-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const spec = {
    version: 1,
    steps: [
      { type: 'extractVariables', as: 'left', sourceValue: ['A', 'B'], regex: '^(?<Code>.+)$', all: true },
      { type: 'extractVariables', as: 'right', sourceValue: ['B', 'C'], regex: '^(?<Code>.+)$', all: true },
      { type: 'unionRows', as: 'allCodes', from: 'left', with: 'right', on: 'Code', distinct: true },
      { type: 'differenceRows', as: 'leftOnly', from: 'left', with: 'right', on: 'Code', distinct: true }
    ],
    result: {
      tables: [
        { name: 'left', columns: ['Code'] },
        { name: 'allCodes', columns: ['Code'], published: true },
        { name: 'leftOnly', columns: ['Code'] }
      ]
    }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20`, {
    template: { code: 'SetOperationsPreview', spec },
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.trace.map((item) => item.as), ['left', 'right', 'allCodes', 'leftOnly']);
  const tables = new Map(preview.json.result.tables.map((table) => [table.name, table]));
  assert.deepEqual(tables.get('allCodes').rows.map((row) => row.Code), ['A', 'B', 'C']);
  assert.deepEqual(tables.get('leftOnly').rows.map((row) => row.Code), ['A']);
  assert.equal(mock.requests.some((item) => /\/classes\/(?:routerG|ARM)\/cards$/.test(item.pathname)), false);
  assert.equal(backend.exitCode, null);
});

test('set operations keep documented case and duplicate semantics', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=set-operation-case-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const spec = {
    version: 1,
    steps: [
      { type: 'extractVariables', as: 'left', sourceValue: ['A', 'B', 'B'], regex: '^(?<Code>.+)$', all: true },
      { type: 'extractVariables', as: 'right', sourceValue: ['b', 'C'], regex: '^(?<Code>.+)$', all: true },
      { type: 'intersectRows', as: 'intersectDefault', from: 'left', with: 'right', on: 'Code' },
      { type: 'intersectRows', as: 'intersectInsensitive', from: 'left', with: 'right', on: 'Code', caseSensitive: false },
      { type: 'intersectRows', as: 'intersectDuplicates', from: 'left', with: 'right', on: 'Code', caseSensitive: false, distinct: false },
      { type: 'unionRows', as: 'unionDefault', from: 'left', with: 'right', on: 'Code' },
      { type: 'unionRows', as: 'unionSensitive', from: 'left', with: 'right', on: 'Code', caseSensitive: true },
      { type: 'differenceRows', as: 'differenceDefault', from: 'left', with: 'right', on: 'Code' },
      { type: 'differenceRows', as: 'differenceSensitive', from: 'left', with: 'right', on: 'Code', caseSensitive: true }
    ],
    result: {
      tables: ['intersectDefault', 'intersectInsensitive', 'intersectDuplicates', 'unionDefault', 'unionSensitive', 'differenceDefault', 'differenceSensitive'].map((name) => ({ name, columns: ['Code'] }))
    }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20`, {
    template: { code: 'SetOperationCasePreview', spec },
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 200, preview.body);
  const tables = new Map(preview.json.result.tables.map((table) => [table.name, table.rows.map((row) => row.Code)]));
  assert.deepEqual(tables.get('intersectDefault'), []);
  assert.deepEqual(tables.get('intersectInsensitive'), ['B']);
  assert.deepEqual(tables.get('intersectDuplicates'), ['B', 'B']);
  assert.deepEqual(tables.get('unionDefault'), ['A', 'B', 'C']);
  assert.deepEqual(tables.get('unionSensitive'), ['A', 'B', 'b', 'C']);
  assert.deepEqual(tables.get('differenceDefault'), ['A']);
  assert.deepEqual(tables.get('differenceSensitive'), ['A', 'B']);
  assert.equal(mock.requests.some((item) => /\/classes\/(?:routerG|ARM)\/cards$/.test(item.pathname)), false);
  assert.equal(backend.exitCode, null);
});

test('typed object-flow apply compiles deterministic stages and removed Assistant contracts return 410', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=object-flow-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const flow = {
    version: 1,
    selections: [
      { id: 'selection:routers', name: 'Routers', alias: 'routers', className: 'routerG', from: '', limit: 100, columns: ['Location'], rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }] },
      { id: 'selection:arms', name: 'ARM', alias: 'arms', className: 'ARM', from: '', limit: 100, columns: ['Location'], rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }] }
    ],
    operations: [{ type: 'match', id: 'match:coLocated', from: 'routers', with: 'arms', as: 'coLocated', rightPrefix: 'Selection 2.', rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Location', leftRegex: '', rightColumn: 'Location', rightRegex: '' }] }]
  };
  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: '',
    baseSpecHash: '',
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    flow
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  assert.deepEqual(applied.json.spec.steps.map((step) => step.type), ['selectCards', 'selectCards', 'matchRows']);
  assert.equal(applied.json.spec.steps[1].from, undefined);
  assert.equal(applied.json.spec.steps[1].filters.some((filter) => filter.valueColumn), false);
  assert.equal(applied.json.spec.steps[2].from, 'routers');
  assert.equal(applied.json.spec.steps[2].with, 'arms');
  assert.equal(applied.json.spec.visualModels.some((model) => model.mode === 'objectMatching'), true);

  const removed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/template-draft`, { prompt: 'ignored' }, headers);
  assert.equal(removed.statusCode, 410, removed.body);
  assert.equal(removed.json.code, 'assistant_contract_removed');
  for (const route of ['selection', 'match']) {
    const legacy = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/${route}`, { prompt: 'ignored' }, headers);
    assert.equal(legacy.statusCode, 410, legacy.body);
    assert.equal(legacy.json.code, 'assistant_contract_removed');
  }
  assert.equal(backend.exitCode, null);
});

test('full object-flow planning returns a validated proposal without mutating the editor spec', async (t) => {
  const llm = await startLiteLlmStub(t, {
    flow: {
      version: 1,
      selections: [
        {
          id: 'selection:routers', name: 'Routers', alias: 'routers', className: 'routerG', from: '', limit: 1,
          columns: ['Code', 'Description', 'Location'],
          rules: [{ action: 'include', path: 'Description', negate: false, op: 'equals', value: 'Маршрутизатор для Test City 300', regex: '', valueParam: '', valueColumn: '' }]
        },
        {
          id: 'selection:arms', name: 'ARM', alias: 'arms', className: 'ARM', from: 'routers', limit: 100,
          columns: ['Code', 'Description', 'Location', 'model', 'model2'],
          rules: [{ action: 'include', path: 'Location', negate: false, op: 'equals', value: '', regex: '', valueParam: '', valueColumn: 'Location' }]
        }
      ],
      operations: [{
        type: 'match',
        id: 'match:coLocated', from: 'routers', with: 'arms', as: 'matchedObjects', rightPrefix: 'Arms.',
        rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Location', leftRegex: '', rightColumn: 'Location', rightRegex: '' }]
      }, {
        id: 'set:allAssets', type: 'union', from: 'routers', with: 'arms', as: 'allAssets',
        on: [{ left: 'Class', right: 'Class' }, { left: '_id', right: '_id' }], distinct: true, caseSensitive: false
      }],
      publishedAlias: 'allAssets'
    }
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    LITELLM_API_KEY: 'unit-test-key',
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=object-flow-plan-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '',
    baseSpecHash: '',
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    prompt: 'Выборка 1: маршрутизатор с описанием Маршрутизатор для Test City 300. Выборка 2: АРМ. Соединяем по Location.'
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.action, 'assistant-object-flow-plan');
  assert.equal(response.json.flow.selections[0].className, 'routerG');
  assert.equal(response.json.flow.selections[1].from, 'routers');
  assert.equal(response.json.flow.operations[0].as, 'matchedObjects');
  assert.deepEqual(response.json.flow.operations[1], {
    id: 'set:allAssets', type: 'union', from: 'routers', with: 'arms', as: 'allAssets',
    on: [{ left: 'Class', right: 'Class' }, { left: '_id', right: '_id' }], distinct: true, caseSensitive: false
  });
  assert.equal(response.json.flow.publishedAlias, 'allAssets');
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('typed object-flow apply denies unsaved drafts without template create permission', async (t) => {
  const mock = await startMockCmdbuild(t, { templateClassCanCreate: false });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=object-flow-denied-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: 'UnsavedObjectFlow',
    baseSpecHash: '',
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    flow: {
      version: 1,
      selections: [{
        id: 'selection:assets',
        name: 'Assets',
        alias: 'assets',
        className: 'ARM',
        from: '',
        limit: 100,
        columns: ['Code'],
        rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
      }],
      blocks: []
    }
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json.reason, 'template_create_forbidden');
  assert.equal(backend.exitCode, null);
});

test('D2 import analyzes reusable class roles and applies only reviewed CMDBuild mappings', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    CMDP_D2_BINARY: `${process.cwd()}/tests/fixtures/d2-render-stub.mjs`
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-import-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'routers', className: 'routerG', columns: ['Code', 'Description'] },
    { alias: 'switches', className: 'ARM', columns: ['Code', 'Description'] }
  ], [{
    id: 'match:matchedNetwork',
    from: 'routers',
    with: 'switches',
    as: 'matchedNetwork',
    rightPrefix: 'Selection 2.',
    rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Code', leftRegex: '', rightColumn: 'Code', rightRegex: '' }]
  }]);
  const source = 'router: Router\nswitch: Switch\nrouter -> switch: uplink';
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'NetworkImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    d2Source: source
  }, headers);

  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.equal(analyzed.json.success, true);
  assert.equal(analyzed.json.ir.elements.nodes.length, 2);
  assert.equal(analyzed.json.ir.elements.edges.length, 1);
  assert.equal(analyzed.json.proposal.version, 3);
  assert.equal(analyzed.json.preview.rendered, true);
  assert.equal(analyzed.json.preview.reason, 'ok');
  assert.equal(analyzed.json.preview.layout, 'dagre');
  assert.match(analyzed.json.preview.content, /^<svg data-cmdp-d2-rendered="true"/);
  assert.match(analyzed.json.preview.content, /D2 import preview/);
  assert.doesNotMatch(analyzed.json.preview.content, /<script|onclick|foreignObject/i);
  assert.equal(analyzed.json.preview.content.includes(source), false);
  assert.ok(analyzed.json.catalog.classes.some((item) => item.name === 'ARM'));
  assert.equal(analyzed.json.proposal.catalogHash.length > 0, true);
  assert.deepEqual(analyzed.json.proposal.roles.map((role) => role.key).sort(), ['router', 'switch']);
  assert.equal(analyzed.json.proposal.unresolved.length, 2);
  const tamperedProposal = structuredClone(analyzed.json.proposal);
  tamperedProposal.sourceText += '\nchanged: true';
  const tampered = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    proposal: tamperedProposal,
    roles: []
  }, headers);
  assert.equal(tampered.statusCode, 409, tampered.body);
  assert.equal(tampered.json.code, 'diagram_import_proposal_invalid');
  const tamperedTemplateProposal = structuredClone(analyzed.json.proposal);
  tamperedTemplateProposal.template.title = 'Tampered title';
  const tamperedTemplate = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    proposal: tamperedTemplateProposal,
    roles: []
  }, headers);
  assert.equal(tamperedTemplate.statusCode, 409, tamperedTemplate.body);
  assert.equal(tamperedTemplate.json.code, 'diagram_import_proposal_invalid');

  const assistantConflict = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/interpret`, {
    prompt: 'Interpret roles',
    currentSpec: { ...currentSpec, description: 'changed after analysis' },
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);
  assert.equal(assistantConflict.statusCode, 409, assistantConflict.body);
  assert.equal(assistantConflict.json.code, 'diagram_import_editor_conflict');
  const roles = analyzed.json.proposal.roles.map((role) => {
    const sourceStage = role.key === 'router'
      ? { stageId: 'selection:routers', alias: 'routers', kind: 'selection', className: 'routerG' }
      : { stageId: 'selection:switches', alias: 'switches', kind: 'selection', className: 'ARM' };
    return {
    id: role.id,
    selectedSemantic: 'object',
    mapping: {
      source: sourceStage,
      primary: {
        className: role.key === 'router' ? 'routerG' : 'ARM',
        idAttribute: '_id',
        labelTemplate: '${Code} ${Description}',
        structuredFields: ['Code', 'Description'],
        filters: []
      },
      related: []
    }
  }; });
  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    proposal: analyzed.json.proposal,
    roles
  }, headers);

  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json.success, true);
  assert.equal(applied.json.spec.result.diagrams[0].nodeMappings.length, 2);
  assert.equal(applied.json.spec.result.diagrams[0].edgeMappings.length, 0);
  assert.equal(applied.json.spec.result.diagrams[0].authoring.d2Import.source, source);
  assert.equal(applied.json.spec.steps[0].as, 'routers');
  assert.equal(applied.json.spec.steps.filter((step) => step.managedBy === 'd2ImportV3').length, 0);
  assert.equal(applied.json.spec.result.diagrams[0].authoring.d2Import.roleMappings.length, 2);

  const importsRejected = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'NetworkImport',
    currentSpec,
    d2Source: 'x: @other'
  }, headers);
  assert.equal(importsRejected.statusCode, 422, importsRejected.body);
  assert.match(importsRejected.json.message, /imports are not allowed/i);
  assert.equal(backend.exitCode, null);
});

test('D2 import analysis keeps the structural proposal when preview rendering is unavailable', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { CMDP_D2_RENDER_ENABLED: 'false' });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-preview-disabled-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'PreviewDisabledImport',
    currentSpec: apiObjectFlowSpec([{ alias: 'routers', className: 'routerG', columns: ['Code'] }]),
    d2Source: 'router: Router'
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json.proposal);
  assert.equal(response.json.preview.rendered, false);
  assert.equal(response.json.preview.content, '');
  assert.equal(response.json.preview.reason, 'disabled');
  assert.match(response.json.preview.renderError, /disabled/i);
  assert.equal(backend.exitCode, null);
});

test('D2 import keeps untyped containers structural and places class-mapped objects inside them', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-composite-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'workstations', className: 'ARM', columns: ['Code', 'Description', 'model', 'model2'] }]);
  const source = 'users: { operator: Operator; administrator: Administrator }';
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'CompositeImport',
    currentSpec,
    d2Source: source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const workstation = analyzed.json.proposal.roles.find((role) => role.key === 'workstation');
  const users = analyzed.json.proposal.roles.find((role) => role.key === 'users');
  assert.ok(workstation);
  assert.ok(users);
  assert.equal(users.kind, 'untypedContainer');
  assert.equal(users.selectedSemantic, 'static');
  assert.equal(analyzed.json.proposal.roles.some((role) => role.key === 'users.operator'), false);
  assert.equal(analyzed.json.proposal.unresolved.length, 1);
  const roles = [{
    id: workstation.id,
    selectedSemantic: 'object',
    mapping: {
      source: { stageId: 'selection:workstations', alias: 'workstations', kind: 'selection', className: 'ARM' },
      primary: {
        className: 'ARM',
        idAttribute: '_id',
        labelTemplate: '${Code} ${Description}',
        structuredFields: ['Code', 'Description', 'model', 'model2'],
        filters: []
      },
      related: []
    }
  }, {
    id: users.id,
    selectedSemantic: 'static',
    mapping: users.mapping
  }];

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    proposal: analyzed.json.proposal,
    roles,
    placementRules: [{ id: 'users_workstations', parentRoleId: users.id, childRoleId: workstation.id }]
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  const diagram = applied.json.spec.result.diagrams[0];
  assert.equal(diagram.nodeMappings.length, 1);
  assert.equal(diagram.nodeMappings[0].importRole.key, 'workstation');
  assert.equal(diagram.groupMappings.length, 1);
  assert.equal(diagram.groupMappings[0].importRole.key, 'users');
  assert.deepEqual(diagram.hierarchyMappings, []);
  assert.equal(diagram.authoring.d2Import.version, 3);
  assert.equal(diagram.placementRules[0].parentRoleKey, 'users');

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=10`, {
    template: {
      code: 'CompositeImport',
      spec: { ...applied.json.spec, authoring: { bodyLimitProbe: 'x'.repeat(70 * 1024) } }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const previewDiagram = preview.json.result.diagrams[0];
  assert.ok(previewDiagram.nodes.length > 0);
  assert.equal(previewDiagram.groups.length, 1);
  assert.equal(previewDiagram.nodes.every((node) => node.group === previewDiagram.groups[0].id), true);
  assert.doesNotMatch(previewDiagram.d2.source, /users\.operator|users\.administrator/);
  assert.equal(backend.exitCode, null);
});

test('D2 import analysis is read-only while Apply checks the saved template version', async (t) => {
  const savedSpec = { version: 1, steps: [], result: { tables: [{ name: 'saved' }] } };
  const currentSpec = { version: 1, steps: [], result: { tables: [{ name: 'local' }] } };
  const mock = await startMockCmdbuild(t, { templates: [templateCard('NetworkImport', savedSpec, { canUpdate: true })] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-version-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'NetworkImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    d2Source: 'router: Router'
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.success, true);
  assert.ok(response.json.proposal);

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    proposal: response.json.proposal,
    roles: []
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });
  assert.equal(applied.statusCode, 409, applied.body);
  assert.equal(applied.json.reason, 'template_version_conflict');
  assert.equal(backend.exitCode, null);
});

test('D2 analysis is allowed read-only while Apply requires an update grant', async (t) => {
  const savedSpec = { version: 1, steps: [], result: { tables: [{ name: 'saved' }] } };
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('NoUpdateGrant', savedSpec, { includeCanUpdate: false }),
      templateCard('MissingBaseHash', savedSpec, { canUpdate: true })
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-authoring-guard-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const analyzedReadOnly = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'NoUpdateGrant',
    baseSpecHash: hashJson(savedSpec),
    currentSpec: savedSpec,
    d2Source: 'router: Router'
  }, headers);
  assert.equal(analyzedReadOnly.statusCode, 200, analyzedReadOnly.body);
  assert.equal(analyzedReadOnly.json.success, true);
  assert.ok(analyzedReadOnly.json.proposal);

  const forbiddenApply = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec: savedSpec,
    proposal: analyzedReadOnly.json.proposal,
    roles: []
  }, headers);
  assert.equal(forbiddenApply.statusCode, 403, forbiddenApply.body);
  assert.equal(forbiddenApply.json.reason, 'template_update_forbidden');

  const missingBaseHash = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'MissingBaseHash',
    baseSpecHash: '',
    currentSpec: savedSpec,
    d2Source: 'router: Router'
  }, headers);
  assert.equal(missingBaseHash.statusCode, 200, missingBaseHash.body);
  assert.equal(missingBaseHash.json.success, true);
  assert.ok(missingBaseHash.json.proposal);
  assert.equal(backend.exitCode, null);
});

test('typed authoring endpoints reject malformed and non-object JSON with 400', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=typed-json-body-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = {
    cookie,
    origin: backendOrigin,
    'content-type': 'application/json',
    'x-cmdbdynamicpages-csrf': csrf.json.token
  };

  const malformed = await requestRaw('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, '{', headers);
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(JSON.parse(malformed.body).code, 'invalid_json_body');

  const nonObject = await requestRaw('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, 'null', headers);
  assert.equal(nonObject.statusCode, 400, nonObject.body);
  assert.equal(JSON.parse(nonObject.body).code, 'invalid_json_body');
  assert.equal(backend.exitCode, null);
});

test('CSRF token is not issued when CMDBuild rejects the session', async (t) => {
  const mock = await startMockCmdbuild(t, { sessionStatus: 401 });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const response = await requestJson('GET', `http://127.0.0.1:${backendPort}/cmdbuild/custom-api/csrf`, undefined, {
    cookie: 'CMDBuild-Authorization=invalid-token'
  });

  assert.equal(response.statusCode, 401, response.body);
  assert.equal(response.json.reason, 'cmdbuild_session_invalid');
  assert.equal(response.json.token, undefined);
  assert.equal(backend.exitCode, null);
});

test('D2 analysis permits unsaved drafts while Apply requires template create permission', async (t) => {
  const mock = await startMockCmdbuild(t, { templateClassCanCreate: false });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-create-denied-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'UnsavedDiagram',
    baseSpecHash: '',
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    d2Source: 'router: Router'
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.equal(analyzed.json.success, true);
  assert.ok(analyzed.json.proposal);

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    proposal: analyzed.json.proposal,
    roles: []
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });
  assert.equal(applied.statusCode, 403, applied.body);
  assert.equal(applied.json.reason, 'template_create_forbidden');
  assert.equal(backend.exitCode, null);
});

test('template run exposes D2 source only through dedicated download endpoint', async (t) => {
  const spec = {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'arms',
        className: 'ARM',
        columns: ['Code', 'Description', 'Location'],
        limit: 2
      }
    ],
    result: {
      diagrams: [{
        name: 'armsDiagram',
        title: 'ARM diagram',
        source: { nodes: 'arms' },
        fields: {
          nodeId: 'Code',
          nodeLabel: 'Description',
          nodeGroup: '_Location_description'
        },
        metadata: { embedInD2: true }
      }]
    }
  };
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('D2SourceTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-source-test-token';

  const json = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/templates/D2SourceTemplate/run?json=true`,
    undefined,
    { cookie },
    10_000
  );
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(json.json.success, true);
  assert.equal(json.json.diagrams.length, 1);
  assert.equal(json.json.diagrams[0].d2.source, undefined);
  assert.equal(json.json.diagrams[0].d2.downloadAvailable, true);
  assert.equal(json.json.diagrams[0].svg.content, undefined);
  assert.equal(json.json.diagrams[0].nodes[0].data, undefined);

  const source = await request(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/templates/D2SourceTemplate/run?d2=true&diagram=armsDiagram`,
    undefined,
    { cookie },
    10_000
  );
  assert.equal(source.statusCode, 200, source.body);
  assert.match(String(source.headers['content-type'] || ''), /text\/vnd\.d2/);
  assert.match(String(source.headers['content-disposition'] || ''), /D2SourceTemplate-armsDiagram\.d2/);
  assert.match(source.body, /vars: \{/);
  assert.match(source.body, /cmdp: \{/);
  assert.match(source.body, /ARM-001|ARM 001/);
  assert.equal(hashJson(source.body), json.json.diagrams[0].d2.sourceHash);
  assert.equal(backend.exitCode, null);
});

test('template publish rejects unsaved static snapshot settings with actionable reason', async (t) => {
  const spec = publishSpec({
    publish: { mode: 'dynamicUser', paramsMode: 'exact', warningAccepted: false }
  });
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('DynamicPublishTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-dynamic-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/DynamicPublishTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 400, publish.body);
  assert.equal(publish.json.success, false);
  assert.equal(publish.json.reason, 'publication_settings_not_saved');
  assert.match(publish.json.message, /Publication settings were not saved/);
  assert.equal(publish.json.publish.mode, 'dynamicUser');
  assert.equal(backend.exitCode, null);
});

test('template publish rejects stale saved spec hash before executing the snapshot', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('StalePublishTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-stale-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/StalePublishTemplate/publish`, {
    params: {},
    savedSpecHash: 'f'.repeat(64)
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 409, publish.body);
  assert.equal(publish.json.success, false);
  assert.equal(publish.json.reason, 'publication_saved_spec_mismatch');
  assert.equal(publish.json.savedSpecHash, undefined);
  assert.ok(publish.json.currentSpecHash);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish rejects missing saved spec hash before executing the snapshot', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('MissingHashPublishTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-missing-hash-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/MissingHashPublishTemplate/publish`, {
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 400, publish.body);
  assert.equal(publish.json.success, false);
  assert.equal(publish.json.reason, 'publication_saved_spec_hash_required');
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish rejects invalid saved spec hash without echoing it', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('InvalidHashPublishTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-invalid-hash-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/InvalidHashPublishTemplate/publish`, {
    params: {},
    savedSpecHash: 'not-a-spec-hash'
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 400, publish.body);
  assert.equal(publish.json.reason, 'publication_saved_spec_hash_required');
  assert.equal(JSON.stringify(publish.json).includes('not-a-spec-hash'), false);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish denies users without explicit update permission before publication validation', async (t) => {
  const spec = publishSpec({
    publish: { mode: 'dynamicUser', paramsMode: 'exact', warningAccepted: false }
  });
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('DeniedPublishTemplate', spec, { canUpdate: false })
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-denied-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/DeniedPublishTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 403, publish.body);
  assert.equal(publish.json.reason, 'technical_schema_access_denied');
  assert.equal(publish.json.publish, undefined);
  assert.equal(publish.json.template, undefined);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish fails closed when update permission flag is missing', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('MissingPermissionPublishTemplate', spec, { includeCanUpdate: false })
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=missing-perm';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/MissingPermissionPublishTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 403, publish.body);
  assert.equal(publish.json.reason, 'technical_schema_access_denied');
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish returns controlled client errors for malformed or null JSON bodies', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('BadBodyPublishTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-bad-body-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);
  const headers = {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token,
    'content-type': 'application/json'
  };

  const malformed = await requestRaw('POST', `${backendOrigin}/cmdbuild/custom-api/templates/BadBodyPublishTemplate/publish`, '{not json', headers);
  assert.equal(malformed.statusCode, 400, malformed.body);
  const malformedJson = JSON.parse(malformed.body);
  assert.equal(malformedJson.reason, 'request_body_invalid_json');

  const nullBody = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/BadBodyPublishTemplate/publish`, null, headers);
  assert.equal(nullBody.statusCode, 400, nullBody.body);
  assert.equal(nullBody.json.reason, 'request_body_must_be_object');
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish executes static snapshot spec and returns published cache metadata', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('StaticPublishTemplate', spec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-static-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/StaticPublishTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(publish.statusCode, 200, publish.body);
  assert.equal(publish.json.success, true);
  assert.equal(publish.json.action, 'publish');
  assert.equal(publish.json.cache.status, 'snapshot-published');
  assert.equal(publish.json.cache.scope, 'staticSnapshot');
  const table = publish.json.result.tables.find((item) => item.name === 'arms');
  assert.ok(table, 'arms table is present');
  assert.deepEqual(table.rows.map((row) => row.Code).sort(), ['ARM-001', 'ARM-002']);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), true);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), true);
  assert.equal(backend.exitCode, null);
});

test('template deletion revokes all public static snapshots', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard('StaticSnapshotRevoke', spec)]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=static-snapshot-revoke-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  };

  const publish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, headers);
  assert.equal(publish.statusCode, 200, publish.body);

  const beforeDelete = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/public-snapshots/StaticSnapshotRevoke/run?json=true`);
  assert.equal(beforeDelete.statusCode, 200, beforeDelete.body);
  assert.equal(beforeDelete.json.snapshotFound, true);

  const updated = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke`, {
    code: 'StaticSnapshotRevoke',
    spec
  }, headers);
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json.cacheInvalidation.staticSnapshots.invalidated, 1);

  const afterUpdate = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/public-snapshots/StaticSnapshotRevoke/run?json=true`);
  assert.equal(afterUpdate.statusCode, 200, afterUpdate.body);
  assert.equal(afterUpdate.json.snapshotFound, false);

  const republished = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, headers);
  assert.equal(republished.statusCode, 200, republished.body);

  const deleted = await requestJson('DELETE', `${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke`, undefined, headers);
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json.cacheInvalidation.staticSnapshots.invalidated, 1);

  const afterDelete = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/public-snapshots/StaticSnapshotRevoke/run?json=true`);
  assert.equal(afterDelete.statusCode, 200, afterDelete.body);
  assert.equal(afterDelete.json.snapshotFound, false);
  assert.equal(afterDelete.json.cache.status, 'snapshot-miss');
  assert.equal(backend.exitCode, null);
});

test('object-flow apply rejects Diagram mappings whose source aliases are removed', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization' + '=' + 'diagram-source';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  };
  const currentSpec = {
    version: 1,
    visualModels: [{
      mode: 'objectGroup',
      selections: [{
        alias: 'oldAssets',
        className: 'ARM',
        scopeRules: [{ action: 'include', path: 'Code', negate: false, op: 'exists' }]
      }]
    }],
    result: {
      tables: [{ name: 'oldAssets', columns: ['Code'] }],
      diagrams: [{ name: 'network', type: 'd2', source: { nodes: 'oldAssets' } }]
    }
  };
  const flow = {
    version: 1,
    selections: [{
      alias: 'newAssets',
      className: 'ARM',
      rules: [{ action: 'include', path: 'Code', negate: false, op: 'exists' }]
    }],
    operations: []
  };

  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: '',
    baseSpecHash: '',
    currentSpec,
    flow
  }, headers);
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'object_flow_diagram_source_stale');
  assert.ok(response.json.errors.some((error) => error.path === '$.result.diagrams[0].source.nodes'));
  assert.equal(backend.exitCode, null);
});

test('model metadata endpoints read inherited attributes with service scope', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=metadata-test-token';

  const attributes = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/classes/routerG/attributes`,
    undefined,
    { cookie }
  );

  assert.equal(attributes.statusCode, 200, attributes.body);
  assert.deepEqual(attributes.json.data.map((item) => [item.name, item.inherited]), [
    ['Location', false],
    ['model', true],
    ['model2', false]
  ]);
  assert.equal(attributes.json.data.some((item) => item.name === 'hiddenModel'), false);

  const catalog = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/catalog?maxClasses=5&maxDomains=5&includeAttributes=true`,
    undefined,
    { cookie }
  );

  assert.equal(catalog.statusCode, 200, catalog.body);
  const routerClass = catalog.json.catalog.classes.find((item) => item.name === 'routerG');
  assert.ok(routerClass, 'routerG catalog class is present');
  assert.deepEqual(routerClass.attributes.map((item) => item.name), ['Location', 'model', 'model2']);
  assert.equal(mock.requests.some((item) =>
    item.pathname.endsWith('/classes/routerG/attributes') &&
    item.search === '?scope=service&limit=1000'
  ), true);
  assert.equal(backend.exitCode, null);
});

test('model class attributes endpoint preserves CMDBuild permission and missing statuses', async (t) => {
  const mock = await startMockCmdbuild(t, {
    attributeStatusByClass: {
      ForbiddenClass: 403,
      MissingClass: 404
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=metadata-status-test-token';

  const forbidden = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/classes/ForbiddenClass/attributes`,
    undefined,
    { cookie }
  );
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json.success, false);
  assert.equal(forbidden.json.cmdbuildStatus, 403);

  const missing = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/classes/MissingClass/attributes`,
    undefined,
    { cookie }
  );
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json.success, false);
  assert.equal(missing.json.cmdbuildStatus, 404);
  assert.equal(backend.exitCode, null);
});

test('public snapshot D2 source requires explicit publication flag', async (t) => {
  const blockedSpec = d2PublishSpec(false);
  const allowedSpec = d2PublishSpec(true);
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('D2PublicBlockedTemplate', blockedSpec),
      templateCard('D2PublicAllowedTemplate', allowedSpec)
    ]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=publish-d2-public-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200);
  const headers = {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  };

  const blockedPublish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/D2PublicBlockedTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(blockedSpec)
  }, headers, 10_000);
  assert.equal(blockedPublish.statusCode, 200, blockedPublish.body);

  const blockedSource = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/public-snapshots/D2PublicBlockedTemplate/run?d2=true&diagram=armsDiagram`,
    undefined,
    {},
    10_000
  );
  assert.equal(blockedSource.statusCode, 403, blockedSource.body);
  assert.match(blockedSource.json.message, /not enabled/);

  const blockedJson = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/public-snapshots/D2PublicBlockedTemplate/run?json=true`,
    undefined,
    {},
    10_000
  );
  assert.equal(blockedJson.statusCode, 200, blockedJson.body);
  assert.equal(blockedJson.json.diagrams[0].d2.source, undefined);
  assert.equal(blockedJson.json.diagrams[0].d2.downloadAvailable, false);

  const allowedPublish = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/D2PublicAllowedTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(allowedSpec)
  }, headers, 10_000);
  assert.equal(allowedPublish.statusCode, 200, allowedPublish.body);

  const allowedSource = await request(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/public-snapshots/D2PublicAllowedTemplate/run?d2=true&diagram=armsDiagram`,
    undefined,
    {},
    10_000
  );
  assert.equal(allowedSource.statusCode, 200, allowedSource.body);
  assert.match(String(allowedSource.headers['content-type'] || ''), /text\/vnd\.d2/);
  assert.match(allowedSource.body, /vars: \{/);
  assert.match(allowedSource.body, /cmdp: \{/);
  assert.equal(backend.exitCode, null);
});

async function startMockCmdbuild(t, options = {}) {
  const requests = [];
  const templateCards = Array.isArray(options.templates) ? options.templates : [];
  const configCards = Array.isArray(options.configCards) ? options.configCards : [];
  const attributeStatusByClass = options.attributeStatusByClass || {};
  const routerCards = Array.isArray(options.routerCards) ? options.routerCards : [
    {
      _id: 302,
      Code: 'router-other',
      Description: 'Маршрутизатор для Test City 300 backup',
      Location: 400,
      _Location_description: 'Test City 400'
    },
    {
      _id: 301,
      Code: 'router-target',
      Description: 'Маршрутизатор для Test City 300',
      Location: 300,
      _Location_description: 'Test City 300'
    }
  ];
  const armCards = Array.isArray(options.armCards) ? options.armCards : [
    {
      _id: 503,
      Code: 'ARM-003',
      Description: 'АРМ 003',
      Location: 400,
      _Location_description: 'Test City 400'
    },
    {
      _id: 501,
      Code: 'ARM-001',
      Description: 'АРМ 001',
      Location: 901,
      _Location_description: 'Test City 300',
      model: 'model-a',
      model2: 'model2-a'
    },
    {
      _id: 502,
      Code: 'ARM-002',
      Description: 'АРМ 002',
      Location: 902,
      _Location_description: 'Test City 300',
      model: 'model-b',
      model2: 'model2-b'
    }
  ];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({
      method: req.method || '',
      pathname: requestUrl.pathname,
      search: requestUrl.search
    });

    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/sessions/current') {
      const status = Number(options.sessionStatus || 200);
      sendJson(res, status, status === 200 ? { data: { username: 'preview-user', role: 'Admin' } } : { message: 'session rejected' });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate') {
      sendJson(res, 200, {
        data: {
          name: 'Cst_QueryTemplate',
          _can_read: true,
          _can_create: options.templateClassCanCreate !== false,
          _can_update: options.templateClassCanUpdate !== false
        }
      });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes') {
      sendJson(res, 200, {
        data: [
          { _id: 1, name: 'routerG', description: 'Маршрутизатор', active: true },
          { _id: 2, name: 'ARM', description: 'АРМ', active: true },
          { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
          { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
        ]
      });
      return;
    }
    if (requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/[^/]+\/attributes$/)) {
      if (requestUrl.searchParams.get('scope') !== 'service' || requestUrl.searchParams.get('limit') !== '1000') {
        sendJson(res, 404, { message: `missing service-scope attributes query: ${requestUrl.pathname}${requestUrl.search}` });
        return;
      }
      const className = decodeURIComponent(requestUrl.pathname.split('/').at(-2));
      if (attributeStatusByClass[className]) {
        sendJson(res, attributeStatusByClass[className], { message: `attributes unavailable for ${className}` });
        return;
      }
      const fixtures = {
        routerG: [
          { name: 'Location', type: 'reference', targetClass: 'Location', inherited: false, active: true, _can_read: true },
          { name: 'model', type: 'string', inherited: true, active: true, _can_read: true },
          { name: 'model2', type: 'string', inherited: false, active: true, _can_read: true },
          { name: 'hiddenModel', type: 'string', inherited: true, active: true, _can_read: false },
          { name: 'inactiveModel', type: 'string', inherited: true, active: false, _can_read: true }
        ],
        ARM: [
          { name: 'Location', type: 'reference', targetClass: 'Location', inherited: false, active: true, _can_read: true },
          { name: 'model', type: 'string', inherited: true, active: true, _can_read: true },
          { name: 'model2', type: 'string', inherited: false, active: true, _can_read: true }
        ],
        Cst_QueryToolConfig: [],
        Cst_QueryTemplate: []
      };
      sendJson(res, 200, { data: fixtures[className] || [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/domains') {
      sendJson(res, 200, { data: [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/lookup_types') {
      sendJson(res, 200, { data: [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryToolConfig/cards') {
      sendJson(res, 200, { data: paginate(requestUrl, configCards) });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate/cards') {
      sendJson(res, 200, { data: paginate(requestUrl, templateCards) });
      return;
    }
    const templateCardMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/Cst_QueryTemplate\/cards\/([^/]+)$/);
    if (templateCardMatch) {
      const cardId = decodeURIComponent(templateCardMatch[1]);
      const index = templateCards.findIndex((card) => String(card && (card._id || card.Id || card.id)) === cardId);
      if (req.method === 'PUT' && index >= 0) {
        sendJson(res, 200, { data: templateCards[index] });
        return;
      }
      if (req.method === 'DELETE' && index >= 0) {
        const [deleted] = templateCards.splice(index, 1);
        sendJson(res, 200, { data: deleted });
        return;
      }
      sendJson(res, 404, { message: `Template card not found: ${cardId}` });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/routerG/cards') {
      sendJson(res, 200, { data: paginate(requestUrl, routerCards) });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/ARM/cards') {
      sendJson(res, 200, { data: paginate(requestUrl, armCards) });
      return;
    }

    sendJson(res, 404, { message: `Unhandled mock CMDBuild route: ${requestUrl.pathname}` });
  });
  await listen(server, 0);
  t.after(() => closeServer(server));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests
  };
}

async function startLiteLlmStub(t, proposal) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      sendJson(res, 404, { message: 'Unknown LiteLLM route.' });
      return;
    }
    requests += 1;
    sendJson(res, 200, {
      choices: [{ message: { content: JSON.stringify({ flow: proposal.flow, explanation: 'Validated test proposal.', warnings: [] }) } }]
    });
  });
  await listen(server, 0);
  t.after(() => closeServer(server));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}/v1`, get requests() { return requests; } };
}

function publishSpec(overrides = {}) {
  return {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'routerG',
        filters: [{ path: 'Description', op: 'equals', value: 'Маршрутизатор для Test City 300' }],
        columns: ['Code', 'Description', 'Location'],
        limit: 1
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'ARM',
        filters: [{ path: 'Location', op: 'equals', valueColumn: 'Location' }],
        columns: ['Code', 'Description', 'Location'],
        limit: 100
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Code', 'Description', 'Location'] }]
    },
    publish: { mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true },
    ...overrides
  };
}

function d2PublishSpec(publicD2Source) {
  return {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'arms',
        className: 'ARM',
        columns: ['Code', 'Description', 'Location'],
        limit: 2
      }
    ],
    result: {
      diagrams: [{
        name: 'armsDiagram',
        title: 'ARM diagram',
        source: { nodes: 'arms' },
        fields: {
          nodeId: 'Code',
          nodeLabel: 'Description',
          nodeGroup: '_Location_description'
        },
        metadata: { embedInD2: true }
      }]
    },
    publish: { mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true, publicD2Source }
  };
}

function templateCard(code, spec, options = {}) {
  const card = {
    _id: code,
    Code: code,
    Description: code,
    Active: true,
    SpecJson: JSON.stringify(spec),
    ParamsSchemaJson: '{}',
    ResultSchemaJson: '{}',
    Owner: 'preview-user',
    UpdatedAt: '2026-07-10T00:00:00.000Z'
  };
  if (options.includeCanUpdate !== false) card._can_update = options.canUpdate === undefined ? true : Boolean(options.canUpdate);
  return card;
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function paginate(requestUrl, rows) {
  const limit = Number(requestUrl.searchParams.get('limit') || rows.length);
  const start = Number(requestUrl.searchParams.get('start') || 0);
  return rows.slice(start, start + limit);
}

async function startBackend(t, port, cmdbuildOrigin, envOverrides = {}) {
  const child = spawn(process.execPath, ['scripts/dev-proxy-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: String(port),
      CMDBUILD_ORIGIN: cmdbuildOrigin,
      CMDBDYNAMIC_REDIS_ENABLED: 'false',
      CMDBDYNAMIC_HEALTH_REDIS_REQUIRED: 'false',
      CMDBDYNAMICPAGES_CSRF_SECRET: 'preview-test-csrf-secret',
      CMDP_LOG_LEVEL: 'silent',
      CMDP_LOG_TARGET: 'stdout',
      CMDP_D2_IMPORT_BINARY: `${process.cwd()}/tests/fixtures/d2-import-stub.mjs`,
      ...envOverrides,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  t.after(() => stopChild(child));
  await waitFor(async () => {
    const result = await requestJson('GET', `http://127.0.0.1:${port}/health/live`, undefined, {}, 500);
    return result.statusCode === 200;
  }, 5000, () => output);
  return child;
}

async function requestJson(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const result = await request(method, url, body, extraHeaders, timeoutMs);
  let json = null;
  try {
    json = result.body ? JSON.parse(result.body) : null;
  } catch {
    json = null;
  }
  return {
    ...result,
    json
  };
}

function request(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      accept: 'application/json,*/*',
      ...extraHeaders
    };
    if (payload !== null) {
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
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

function requestRaw(method, url, payload, extraHeaders = {}, timeoutMs = 5000) {
  const target = new URL(url);
  const text = payload === undefined || payload === null ? '' : String(payload);
  return new Promise((resolve, reject) => {
    const headers = {
      accept: 'application/json,*/*',
      ...extraHeaders,
      'content-length': Buffer.byteLength(text)
    };
    const req = http.request({
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
    if (text) req.write(text);
    req.end();
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function hasHeader(headers, name) {
  const normalized = String(name || '').toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(check, timeoutMs, details) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const suffix = typeof details === 'function' ? details() : '';
  throw new Error(`Timed out waiting for backend startup.${lastError ? ` Last error: ${lastError.message}` : ''}${suffix ? `\n${suffix}` : ''}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
