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

function objectFlowIntentFromText(algorithm, options = {}) {
  const blocks = Array.isArray(options.blocks) && options.blocks.length
    ? options.blocks
    : [{
      id: 'block-1',
      name: options.name || 'Result',
      entities: options.entities || 'CMDBuild objects from the requested algorithm.',
      algorithm,
      expectedResult: options.expectedResult || 'A deterministic result table.',
      uses: []
    }];
  return { context: options.context || '', blocks };
}

function semanticPlanForIntent(intent) {
  return {
    version: 1,
    blocks: intent.blocks.map((block) => ({
      id: block.id,
      name: block.name,
      summary: 'Confirmed by the user for deterministic planning.',
      resolvedEntities: [],
      relationPaths: [],
      dependencies: block.uses || [],
      expectedResult: block.expectedResult,
      resultContract: { outputKind: 'relationPairs', outputClass: 'CMDBCard', relationPredicates: [] },
      warnings: []
    })),
    explanation: 'Semantic plan confirmed.',
    warnings: []
  };
}

function objectFlowPlanRequest(algorithm, options = {}) {
  const intent = objectFlowIntentFromText(algorithm, options);
  return { intent, semanticPlan: semanticPlanForIntent(intent) };
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

test('Assistant object-flow preview returns intermediate rows without applying the draft', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=assistant-preview-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const flow = {
    version: 1,
    selections: [
      {
        id: 'selection:router', name: 'Маршрутизатор Test City 300', alias: 'router', className: 'routerG', from: '', limit: 1,
        columns: ['Code', 'Description', 'Location'],
        rules: [{ action: 'include', path: 'Description', negate: false, op: 'equals', value: 'Маршрутизатор для Test City 300', regex: '', valueParam: '', valueColumn: '' }]
      },
      {
        id: 'selection:arms', name: 'АРМ в местоположении маршрутизатора', alias: 'arms', className: 'ARM', from: 'router', limit: 100,
        columns: ['Code', 'Description', 'Location', 'model', 'model2'],
        rules: [{ action: 'include', path: 'Location', negate: false, op: 'equals', value: '', regex: '', valueParam: '', valueColumn: 'Location' }]
      }
    ],
    operations: [],
    publishedAlias: 'arms'
  };

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/preview`, {
    templateCode: 'AssistantObjectFlowPreview',
    currentSpec: {
      version: 1,
      steps: [{ type: 'selectCards', className: 'ARM', as: 'targetARM', filters: [], limit: 100 }],
      result: { tables: [{ name: 'targetARM', title: 'Manual ARM target' }] }
    },
    flow,
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json.success, true);
  assert.deepEqual(preview.json.preview.stages.map((stage) => [stage.as, stage.rows.length]), [
    ['router', 1],
    ['arms', 2]
  ]);
  assert.equal(preview.json.preview.stages[0].label, 'Маршрутизатор Test City 300');
  assert.equal(preview.json.preview.stages[1].rows.every((row) => row.model && row.model2), true);
  assert.deepEqual(preview.json.preview.trace.map((item) => [item.as, item.rows]), [
    ['router', 1],
    ['arms', 2]
  ]);
  assert.equal(
    mock.requests.filter((item) => item.pathname.endsWith('/classes/ARM/cards')).length,
    1,
    'Preview must not execute unrelated targetARM from the current draft.'
  );
  assert.equal(mock.requests.some((item) => item.method === 'PUT' || item.method === 'POST'), false, preview.body);
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
  assert.deepEqual(
    applied.json.spec.visualModels.find((model) => model.mode === 'objectMatching').outputs.map((output) => [output.alias, output.published]),
    [['routers', false], ['arms', false], ['coLocated', false]]
  );

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
    ...objectFlowPlanRequest('маршрутизатор с описанием Маршрутизатор для Test City 300. АРМ в том же Location.')
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.action, 'assistant-object-flow-plan');
  assert.equal(response.json.canApply, true);
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

test('LiteLLM timeout follows the configured MCP timeout', async (t) => {
  const llm = await startLiteLlmStub(t, { flow: {}, delayMs: 1200 });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: {
          llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
          mcp: { enabled: false, timeoutMs: 1000 }
        }
      })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    LITELLM_API_KEY: 'unit-test-key',
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=litellm-timeout-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const intent = objectFlowIntentFromText('Найти ИС по параметру isName.', {
    name: 'Information systems',
    entities: 'ИС',
    expectedResult: 'Карточки ИС.'
  });

  const startedAt = Date.now();
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '',
    baseSpecHash: '',
    currentSpec: { version: 1, params: { isName: { type: 'string' } }, steps: [], result: { tables: [] } },
    intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token }, 5000);

  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json.code, 'assistant_timeout');
  assert.match(response.json.message, /timed out after 1000ms/);
  assert.ok(Date.now() - startedAt >= 850, 'LiteLLM request was cancelled before the configured timeout');
  assert.equal(backend.exitCode, null);
});

test('semantic MCP context uses one configured deadline and reports partial context', async (t) => {
  const llm = await startLiteLlmStub(t, { flow: {} });
  const mock = await startMockCmdbuild(t, {
    delayByPath: {
      '/cmdbuild/services/rest/v3/classes': 650,
      '/cmdbuild/services/rest/v3/classes/IS/attributes': 650
    },
    classes: [
      { _id: 1, name: 'IS', description: 'Information system', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: {
          llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
          mcp: { timeoutMs: 1000, maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 }
        }
      })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    LITELLM_API_KEY: 'unit-test-key',
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-context-deadline-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const startedAt = Date.now();
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    stage: 'context',
    resumeId: 'semantic-context-deadline',
    templateCode: '',
    baseSpecHash: '',
    currentSpec: {
      version: 1,
      steps: [{ type: 'selectCards', as: 'systems', className: 'IS', filters: [], limit: 100 }],
      result: { tables: [{ name: 'systems' }] }
    },
    intent: objectFlowIntentFromText('Выбрать ИС.', { name: 'Information systems', entities: 'IS', expectedResult: 'Список ИС.' })
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  }, 5000);

  assert.equal(response.statusCode, 202, response.body);
  assert.ok(Date.now() - startedAt >= 850, 'MCP context did not wait for the configured deadline');
  assert.ok(Date.now() - startedAt < 1600, 'MCP context applied the timeout independently to multiple MCP reads');
  const limits = response.json?.diagnostics?.mcp?.limits || [];
  assert.ok(limits.some((limit) => limit.tool === 'buildAssistantMcpContext' && limit.limitName === 'timeoutMs' && limit.timeout), response.body);
  assert.equal(mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/domains').length, 1, 'MCP must not start relation hints after the context deadline');
  assert.equal(backend.exitCode, null);
});

test('semantic-plan retry resumes the LLM stage from a saved MCP context after a timeout', async (t) => {
  const intent = objectFlowIntentFromText('Найти информационные системы по параметру isName.', {
    name: 'Information systems',
    entities: 'Информационная система',
    expectedResult: 'Список информационных систем.'
  });
  const llm = await startLiteLlmStub(t, {
    delays: [1200, 0],
    responses: [{
      version: 1,
      blocks: [{
        id: 'block-1', name: 'Information systems', summary: 'ИС по параметру isName.',
        resolvedEntities: ['IS'], relationPaths: [], dependencies: [], expectedResult: 'Список информационных систем.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'IS' }, warnings: []
      }],
      explanation: 'Семантический план сформирован.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: {
          llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
          mcp: { timeoutMs: 1000 },
          semanticPlan: { checkpointTtlSec: 300 }
        }
      })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-retry-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const body = {
    stage: 'context',
    resumeId: 'semantic-retry-checkpoint-token',
    templateCode: '', baseSpecHash: '',
    currentSpec: { version: 1, params: { isName: { type: 'string' } }, steps: [], result: { tables: [] } },
    intent
  };
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const context = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, body, headers);
  assert.equal(context.statusCode, 202, context.body);
  assert.equal(context.json.checkpoint.resumeId, body.resumeId);
  assert.equal(context.json.checkpoint.stage, 'mcpContextReady');
  assert.equal(context.json.checkpoint.checkpointTtlSec, 300);
  const modelReadsAfterContext = mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/classes').length;
  assert.ok(modelReadsAfterContext > 0, 'MCP context reads the class catalog once');

  const firstPlan = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, { ...body, stage: 'plan' }, headers, 5000);
  assert.equal(firstPlan.statusCode, 504, firstPlan.body);
  assert.equal(firstPlan.json.retryable, true);
  assert.equal(firstPlan.json.resume.resumeId, body.resumeId);
  assert.equal(firstPlan.json.resume.stage, 'mcpContextReady');

  const retriedPlan = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, { ...body, stage: 'plan' }, headers, 5000);
  assert.equal(retriedPlan.statusCode, 200, retriedPlan.body);
  assert.equal(retriedPlan.json.semanticPlan.blocks[0].resultContract.outputClass, 'IS');
  assert.equal(mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/classes').length, modelReadsAfterContext, 'retry must not read the MCP catalog again');
  assert.equal(llm.requests, 2);
  assert.equal(backend.exitCode, null);
});

test('semantic planning resolves the submitted business blocks before Object Flow generation', async (t) => {
  const intent = objectFlowIntentFromText('Найти ИС по параметру isName и получить связанные ipRange.', {
    name: 'IP ranges of IS',
    entities: 'Информационная система и IP-диапазоны.',
    expectedResult: 'Таблица IP-диапазонов ИС.'
  });
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'block-1', name: 'IP ranges of IS', summary: 'ИС по isName и связанные ipRange.',
        resolvedEntities: ['IS', 'ipRange'], relationPaths: ['IS --ISZabbixMonitoringDomain--> ipRange'],
        dependencies: [], expectedResult: 'Таблица IP-диапазонов ИС.',
        resultContract: { outputKind: 'relationPairs', outputClass: 'IS', relationPredicates: [] }, warnings: []
      }],
      explanation: 'Проверен семантический план.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Information system', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-plan-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string' } }, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.semanticPlan.blocks[0].id, 'block-1');
  assert.deepEqual(response.json.semanticPlan.blocks[0].resolvedEntities, ['IS', 'ipRange']);
  assert.deepEqual(response.json.semanticPlan.blocks[0].resultContract, { outputKind: 'relationPairs', outputClass: 'IS', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] });
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('semantic planning explains an unexpected relation predicate in a dependency-free block', async (t) => {
  const intent = objectFlowIntentFromText('Выбрать IP-диапазоны, связанные с ИС.', {
    name: 'IP ranges of IS',
    entities: 'Информационная система и IP-диапазоны.',
    expectedResult: 'Список IP-диапазонов ИС.'
  });
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'block-1', name: 'IP ranges of IS', summary: 'Некорректное межблочное сравнение.',
        resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список IP-диапазонов ИС.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ipRange',
          relationPredicates: [{
            sourceClass: 'ipRange', relatedClass: 'ACL', comparisonBlockId: 'block-2', comparisonClass: 'ACL',
            domain: 'aclLine', direction: 'source', comparisonFields: ['range'], relatedField: 'ipaddress', operator: 'ipv4InCidr'
          }]
        },
        warnings: []
      }],
      explanation: 'Некорректный план.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-plan-dependency-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'assistant_semantic_plan_invalid');
  assert.equal(response.json.semanticPlan, undefined);
  assert.deepEqual(response.json.errors, [{
    kind: 'semanticPlanUnexpectedPredicateWithoutDependency',
    blockId: 'block-1',
    blockName: 'IP ranges of IS',
    predicateType: 'relation',
    predicateIndex: 1,
    comparisonBlockId: 'block-2',
    sourceFields: ['range'],
    comparisonField: 'ipaddress'
  }]);
  assert.match(response.json.feedback.summary, /IP ranges of IS/);
  assert.match(response.json.feedback.summary, /независимый/);
  assert.match(response.json.feedback.action, /сравнений с другим результатом/);
  assert.match(response.json.feedback.causes[0].message, /ничего не выбрано/);
  assert.ok(llm.lastRequest.messages.some((message) => /If dependencies is empty, dependencyPaths, relationPredicates and attributePredicates must all be exactly \[\]/.test(message.content)), JSON.stringify(llm.lastRequest));
  assert.equal(backend.exitCode, null);
});

test('semantic planning normalizes a direct dependency traversal to the unique MCP relation path', async (t) => {
  const intent = {
    context: 'Сформировать VLAN для IP-диапазонов первого результата.',
    blocks: [{
      id: 'ip-ranges', name: 'Результат 1', entities: 'Карточки ipRange.',
      algorithm: 'Выбрать IP-диапазоны исходной ИС.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'vlans', name: 'Результат 2', entities: 'Карточки VLAN, связанные с ipRange из Результата 1.',
      algorithm: 'Выбрать VLAN, связанные с ipRange из Результата 1.', expectedResult: 'Список VLAN.', uses: ['ip-ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ip-ranges', name: 'Результат 1', summary: 'IP-диапазоны исходной ИС.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [] }, warnings: []
      }, {
        id: 'vlans', name: 'Результат 2', summary: 'VLAN из первого результата.', resolvedEntities: ['ipRange', 'vlan'], relationPaths: ['ipRange --Vlan2super [destination]--> vlan'], dependencies: ['ip-ranges'], expectedResult: 'Список VLAN.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'vlan',
          relationPredicates: [{
            sourceClass: 'vlan', relatedClass: 'ipRange', comparisonBlockId: 'ip-ranges', comparisonClass: 'ipRange',
            domain: 'ISZabbixMonitoringDomain', direction: 'source', comparisonFields: [], relatedField: '', operator: ''
          }]
        }, warnings: []
      }],
      explanation: 'Второй блок должен пройти от ipRange к VLAN.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'vlan', description: 'VLAN', parent: 'Class', active: true },
      { _id: 4, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      vlan: [{ name: 'network', type: 'string', active: true, _can_read: true }]
    },
    domains: [
      { _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'], destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' },
      { _id: 'Vlan2super', name: 'Vlan2super', source: 'vlan', sources: ['vlan'], destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:1' },
      { _id: 'super2super', name: 'super2super', source: 'super', sources: ['vlan'], destination: 'super', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }
    ],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-direct-path-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract, {
    outputKind: 'sourceCards', outputClass: 'vlan',
    dependencyPaths: [{ comparisonBlockId: 'ip-ranges', sourceClass: 'ipRange', domain: 'Vlan2super', direction: 'destination', targetClass: 'vlan' }],
    relationPredicates: [], attributePredicates: [], referencePathPredicates: []
  });
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /normalized direct dependency path ipRange -> vlan/i.test(warning)), response.body);
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /represented a direct dependency path/i.test(warning)), response.body);
  assert.equal(backend.exitCode, null);
});

test('semantic planning normalizes a relation predicate path and explicit IPv4 comparison operator', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'acls', name: 'Результат 1', entities: 'Карточки ACL.', algorithm: 'Выбрать ACL.', expectedResult: 'Список ACL.', uses: []
    }, {
      id: 'systems', name: 'Внешние ИС', entities: 'ИС, ipRange и ACL из первого результата.',
      algorithm: 'Выбрать ИС, если связанный ipRange с range содержит IPv4 Source ipaddress или Destination ipaddress ACL из Результата 1.',
      expectedResult: 'Список ИС.', uses: ['acls']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'acls', name: 'Результат 1', summary: 'ACL.', resolvedEntities: ['ACL'], relationPaths: [], dependencies: [], expectedResult: 'Список ACL.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', relationPredicates: [] }, warnings: []
      }, {
        id: 'systems', name: 'Внешние ИС', summary: 'ИС сохраняются по range связанного ipRange.', resolvedEntities: ['IS', 'ipRange', 'ACL'], relationPaths: [], dependencies: ['acls'], expectedResult: 'Список ИС.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'IS',
          relationPredicates: [{
            sourceClass: 'IS', relatedClass: 'ipRange', comparisonBlockId: 'acls', comparisonClass: 'ACL',
            domain: 'aclLine', direction: 'destination', comparisonFields: ['ipaddress', 'dipaddress'], relatedField: 'range', operator: 'ipv4Contains'
          }, {
            sourceClass: 'IS', relatedClass: 'ipRange', comparisonBlockId: 'acls', comparisonClass: 'ACL',
            domain: 'aclLine', direction: 'destination', comparisonFields: ['ipaddress', 'dipaddress'], relatedField: 'range', operator: 'ipv4Contains'
          }]
        }, warnings: []
      }],
      explanation: 'ИС остаются результатом, а ipRange участвует только в проверке.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 4, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ACL: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }, { name: 'dipaddress', type: 'string', active: true, _can_read: true }]
    },
    domains: [
      { _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'], destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' },
      { _id: 'super2super', name: 'super2super', source: 'super', sources: ['IS'], destination: 'super', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' },
      { _id: 'aclLine', name: 'aclLine', source: 'ACL', sources: ['ACL'], destination: 'IpAddress', destinations: ['IpAddress'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }
    ],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-relation-predicate-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract.relationPredicates, [{
    sourceClass: 'IS', relatedClass: 'ipRange', comparisonBlockId: 'acls', comparisonClass: 'ACL',
    domain: 'ISZabbixMonitoringDomain', direction: 'source', comparisonFields: ['ipaddress', 'dipaddress'], relatedField: 'range', operator: 'ipv4InCidr'
  }]);
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /normalized relation predicate IS -> ipRange/i.test(warning)), response.body);
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /normalized ipv4Contains to ipv4InCidr/i.test(warning)), response.body);
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /duplicated 1 identical relation predicate/i.test(warning)), response.body);
  assert.equal(backend.exitCode, null);
});

test('semantic planning rejects a substituted class when an exact MCP binding exists', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'applications', name: 'Результат 4', entities: 'Карточки класса Application.',
      algorithm: 'Выбрать все объекты класса Application.', expectedResult: 'Список Application.', uses: []
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'applications', name: 'Результат 4', summary: 'Ближайший найденный класс.', resolvedEntities: ['ZabbixMonitoring'], relationPaths: [], dependencies: [], expectedResult: 'Список Application.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ZabbixMonitoring', relationPredicates: [], attributePredicates: [] },
        warnings: ['Класс Application не найден в MCP context, использован ZabbixMonitoring как ближайший класс']
      }],
      explanation: 'Подмена класса.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 2, name: 'ApplicG', description: 'Application', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { ZabbixMonitoring: [], ApplicG: [] },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-class-substitution-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'assistant_semantic_plan_invalid');
  assert.equal(response.json.errors[0].kind, 'semanticPlanOutputClassMismatch');
  assert.match(response.json.feedback.summary, /не тот класс результата/i);
  assert.match(response.json.feedback.causes[0].message, /ApplicG/);
  assert.equal(backend.exitCode, null);
});

test('semantic planning deterministically completes a cross-block IPv4 condition from confirmed fields', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки класса ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'acls', name: 'Результат 3', entities: 'Карточки класса ACL.',
      algorithm: 'Выбрать ACL, у которых ipaddress входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ACL.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: []
      }, {
        id: 'acls', name: 'Результат 3', summary: 'ACL.', resolvedEntities: ['ACL'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ACL.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', relationPredicates: [], attributePredicates: [] }, warnings: []
      }],
      explanation: 'Missing predicate.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 2, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }], ACL: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }] },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-missing-ipv4-predicate-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract.attributePredicates, [{
    sourceClass: 'ACL', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['ipaddress'], comparisonField: 'range', operator: 'ipv4InCidr'
  }]);
  assert.ok(response.json.warnings.some((warning) => /Deterministic semantic completion added IPv4 attribute comparison ACL\.ipaddress/i.test(warning)), response.body);
  assert.equal(backend.exitCode, null);
});

test('semantic planning removes a relation path duplicated by an IPv4 attribute comparison', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'servers', name: 'Результат 2', entities: 'Карточки phServer и ipRange первого результата.',
      algorithm: 'Выбрать phServer, у которых значение ipaddress входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список phServer.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [] }, warnings: []
      }, {
        id: 'servers', name: 'Результат 2', summary: 'Серверы с адресом в сетях первого результата.', resolvedEntities: ['ipRange', 'phServer'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список phServer.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'phServer',
          dependencyPaths: [{ comparisonBlockId: 'ranges', sourceClass: 'ipRange', domain: 'super2super', direction: 'destination', targetClass: 'phServer' }],
          attributePredicates: [
            { sourceClass: 'phServer', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['ipaddress'], comparisonField: 'range', operator: 'ipv4InCidr' },
            { sourceClass: 'phServer', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['ipaddress'], comparisonField: 'range', operator: 'ipv4InCidr' }
          ]
        }, warnings: []
      }],
      explanation: 'IPv4 comparison only.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'super', active: true },
      { _id: 2, name: 'phServer', description: 'Physical server', parent: 'super', active: true },
      { _id: 3, name: 'super', description: 'Superclass', parent: 'Class', active: true },
      { _id: 4, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 5, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      phServer: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }]
    },
    domains: [{ _id: 'super2super', name: 'super2super', source: 'super', sources: ['phServer'], destination: 'super', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-ipv4-only-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  const contract = response.json.semanticPlan.blocks[1].resultContract;
  assert.deepEqual(contract.dependencyPaths, []);
  assert.deepEqual(contract.attributePredicates, [{
    sourceClass: 'phServer', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['ipaddress'], comparisonField: 'range', operator: 'ipv4InCidr'
  }]);
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /duplicated 1 identical attribute predicate/i.test(warning)), response.body);
  assert.ok(response.json.semanticPlan.blocks[1].warnings.some((warning) => /removed direct dependency path ipRange --super2super/i.test(warning)), response.body);
  assert.equal(backend.exitCode, null);
});

test('semantic planning explains an incomplete relation predicate without empty details', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'acls', name: 'Результат 2', entities: 'Карточки ACL и сети первого результата.', algorithm: 'Выбрать ACL по условию связи.', expectedResult: 'Список ACL.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [] }, warnings: []
      }, {
        id: 'acls', name: 'Результат 2', summary: 'Неполное условие.', resolvedEntities: ['ACL', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ACL.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ACL',
          relationPredicates: [{
            sourceClass: 'ACL', relatedClass: 'ipRange', comparisonBlockId: 'ranges', comparisonClass: 'ACL',
            domain: 'AclIpRange', direction: 'source', comparisonFields: [], relatedField: '', operator: ''
          }]
        }, warnings: []
      }],
      explanation: 'Неполный план.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-incomplete-predicate-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json.errors, [{
    kind: 'semanticPlanIncompleteRelationPredicate', blockId: 'acls', blockName: 'Результат 2', predicateIndex: 1,
    comparisonBlockId: 'ranges', sourceClass: 'ACL', relatedClass: 'ipRange', comparisonClass: 'ACL', domain: 'AclIpRange', direction: 'source',
    missingFields: ['comparisonFields', 'relatedField', 'operator']
  }]);
  assert.match(response.json.feedback.summary, /Результат 2/);
  assert.match(response.json.feedback.summary, /неполное условие по связи/);
  assert.match(response.json.feedback.causes[0].message, /comparisonFields, relatedField, operator/);
  assert.equal(backend.exitCode, null);
});

test('semantic planning explains an unexpected attribute predicate in a dependency-free block', async (t) => {
  const intent = objectFlowIntentFromText('Выбрать карточки ACL.', {
    name: 'Результат 1', entities: 'Карточки ACL.', expectedResult: 'Список ACL.'
  });
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'block-1', name: 'Результат 1', summary: 'Некорректное самостоятельное сравнение.', resolvedEntities: ['ACL', 'ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ACL.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ACL', relationPredicates: [],
          attributePredicates: [{
            sourceClass: 'ACL', comparisonBlockId: '', comparisonClass: 'ipRange',
            sourceFields: ['ipaddress', 'dipaddress'], comparisonField: 'range', operator: 'ipv4InCidr'
          }]
        }, warnings: []
      }],
      explanation: 'Некорректный план.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-attribute-predicate';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json.errors, [{
    kind: 'semanticPlanUnexpectedPredicateWithoutDependency',
    blockId: 'block-1',
    blockName: 'Результат 1',
    predicateType: 'attribute',
    predicateIndex: 1,
    comparisonBlockId: '',
    sourceFields: ['ipaddress', 'dipaddress'],
    comparisonField: 'range'
  }]);
  assert.match(response.json.feedback.summary, /независимый/);
  assert.match(response.json.feedback.causes[0].message, /сравнение атрибутов/);
  assert.equal(backend.exitCode, null);
});

test('semantic planning explains that a direct attribute comparison is not a CMDBuild relation', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ip-ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать ipRange.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'acls', name: 'Результат 3', entities: 'Карточки ACL и результат 1.', algorithm: 'Сравнить IP ACL с range из Результата 1.', expectedResult: 'Список ACL.', uses: ['ip-ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ip-ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [] }, warnings: []
      }, {
        id: 'acls', name: 'Результат 3', summary: 'Некорректно описанное сравнение.', resolvedEntities: ['ACL', 'ipRange'], relationPaths: [], dependencies: ['ip-ranges'], expectedResult: 'Список ACL.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ACL',
          relationPredicates: [{
            sourceClass: 'ACL', relatedClass: 'ipRange', comparisonBlockId: 'ip-ranges', comparisonClass: 'ipRange',
            comparisonFields: ['ipaddress'], relatedField: 'range', operator: 'ipv4InCidr'
          }]
        }, warnings: []
      }],
      explanation: 'Некорректный план.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-attribute-test';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.feedback.causes[0].kind, 'semanticPlanDirectAttributeComparison');
  assert.match(response.json.feedback.summary, /прямое сравнение атрибутов/i);
  assert.match(response.json.feedback.action, /CMDBuild domain/i);
  assert.equal(backend.exitCode, null);
});

test('object-flow planning restores exact Description and an explicit business attribute match', async (t) => {
  const intent = {
    context: '',
    blocks: [
      {
        id: 'block-1',
        name: 'Router anchor',
        entities: 'Экземпляр класса маршрутизатор с Description "Маршрутизатор для Test City 300".',
        algorithm: 'Найти один маршрутизатор и вернуть Location.',
        expectedResult: 'Одна карточка маршрутизатора.',
        uses: []
      },
      {
        id: 'block-2',
        name: 'ARM at router location',
        entities: 'Карточки АРМ и Location результата первого блока.',
        algorithm: 'Найти АРМ, у которых Location равен Location выбранного маршрутизатора.',
        expectedResult: 'Таблица АРМ в том же местоположении.',
        uses: ['block-1']
      }
    ]
  };
  const semanticPlan = {
    version: 1,
    blocks: [
      {
        id: 'block-1', name: 'Router anchor', summary: 'Маршрутизатор.', resolvedEntities: ['routerG'], relationPaths: [], dependencies: [], expectedResult: 'Одна карточка маршрутизатора.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'routerG', dependencyPaths: [], relationPredicates: [], attributePredicates: [] }, warnings: []
      },
      {
        id: 'block-2', name: 'ARM at router location', summary: 'АРМ по Location.', resolvedEntities: ['ARM', 'routerG'], relationPaths: ['routerG --super2super [destination]--> ARM'], dependencies: ['block-1'], expectedResult: 'Таблица АРМ в том же местоположении.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ARM',
          dependencyPaths: [{ comparisonBlockId: 'block-1', sourceClass: 'routerG', domain: 'super2super', direction: 'destination', targetClass: 'ARM' }],
          relationPredicates: [], attributePredicates: []
        }, warnings: []
      }
    ],
    explanation: 'Semantic plan confirmed.',
    warnings: []
  };
  const llm = await startLiteLlmStub(t, {
    flow: {
      version: 1,
      selections: [
        { id: 'selection:router', alias: 'router', className: 'routerG', columns: ['Code', 'Description', 'Location'], rules: [] },
        { id: 'selection:arm', alias: 'arm', className: 'ARM', columns: ['Code', 'Description', 'Location', 'model', 'model2'], rules: [{ path: 'Location', op: 'equals', valueParam: 'router.Location' }] }
      ],
      operations: [
        { id: 'relation:wrong', type: 'relation', from: 'router', as: 'relatedArm', domain: 'super2super', targetClass: 'ARM', direction: 'source', columns: ['Code'], limit: 100, distinct: true },
        { id: 'match:redundant', type: 'match', from: 'arm', with: 'router', as: 'redundantLocationMatch', rules: [{ operator: 'equals', leftColumn: 'Location', rightColumn: 'Location' }] }
      ],
      publishedAlias: 'arm'
    }
  });
  const mock = await startMockCmdbuild(t, {
    domains: [{
      _id: 'super2super', name: 'super2super', source: 'routerG', sources: ['routerG'], destination: 'ARM', destinations: ['ARM'],
      disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=business-match-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.success, true, response.body);
  const router = response.json.flow.selections.find((selection) => selection.className === 'routerG');
  const arm = response.json.flow.selections.find((selection) => selection.className === 'ARM');
  assert.ok(router.rules.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.value === 'Маршрутизатор для Test City 300'));
  assert.equal(arm.from, 'router');
  assert.equal(arm.rules.some((rule) => rule.path === 'Location' && rule.valueColumn === 'Location'), true);
  assert.equal(response.json.flow.operations.some((operation) => operation.type === 'relation'), false);
  assert.equal(response.json.flow.operations.some((operation) => operation.type === 'match'), false);
  assert.equal(response.json.flow.publishedAlias, 'arm');
  assert.equal(backend.exitCode, null);
});

test('object-flow planning is read-only while Apply requires an explicitly denied update grant', async (t) => {
  const flow = {
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
    operations: [],
    blocks: [],
    setOperations: [],
    publishedAlias: 'assets'
  };
  const llm = await startLiteLlmStub(t, { flow });
  const savedSpec = { version: 1, steps: [], result: { tables: [] } };
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard('NoUpdateObjectFlow', savedSpec, { canUpdate: false })],
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
  const cookie = 'CMDBuild-Authorization=object-flow-read-only-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: 'NoUpdateObjectFlow',
    baseSpecHash: '',
    currentSpec: savedSpec,
    ...objectFlowPlanRequest('Выбрать все карточки АРМ.')
  }, headers);
  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.success, true);
  assert.equal(planned.json.canApply, false);
  assert.equal(planned.json.flow.publishedAlias, flow.publishedAlias);
  assert.equal(planned.json.flow.selections[0].className, flow.selections[0].className);
  assert.equal(llm.requests, 1);

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: 'NoUpdateObjectFlow',
    baseSpecHash: hashJson(savedSpec),
    currentSpec: savedSpec,
    flow
  }, headers);
  assert.equal(applied.statusCode, 403, applied.body);
  assert.equal(applied.json.reason, 'template_update_forbidden');
  assert.equal(backend.exitCode, null);
});

test('object-flow planning falls back to the template class update grant when a card omits _can_update', async (t) => {
  const flow = {
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
    operations: [],
    blocks: [],
    setOperations: [],
    publishedAlias: 'assets'
  };
  const llm = await startLiteLlmStub(t, { flow });
  const savedSpec = { version: 1, steps: [], result: { tables: [] } };
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard('ClassGrantObjectFlow', savedSpec, { includeCanUpdate: false })],
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
  const cookie = 'CMDBuild-Authorization=class-grant-object-flow-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: 'ClassGrantObjectFlow',
    baseSpecHash: hashJson(savedSpec),
    currentSpec: savedSpec,
    ...objectFlowPlanRequest('Выбрать все карточки АРМ.')
  }, headers);
  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.canApply, true);

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: 'ClassGrantObjectFlow',
    baseSpecHash: hashJson(savedSpec),
    currentSpec: savedSpec,
    flow
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json.success, true);
  assert.equal(mock.requests.some((item) => item.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate'), true);
  assert.equal(backend.exitCode, null);
});

test('Assistant prompt autosave updates only assistantDraft without versions or cache invalidation', async (t) => {
  const savedSpec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard('AssistantAutosave', savedSpec, { includeCanUpdate: false })]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=assistant-autosave-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const assistantDraft = {
    objectFlowIntent: {
      ...objectFlowIntentFromText('Выбрать АРМ.'),
      extractionCandidateBlockId: 'block-1',
      extractionCandidateAlias: 'arms'
    },
    diagramInterpretPrompt: 'Интерпретировать контейнеры.',
    diagramMappingPrompt: 'Сопоставить выборки с узлами.'
  };

  const autosaved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/AssistantAutosave/assistant-draft`, {
    baseSpecHash: hashJson(savedSpec),
    assistantDraft
  }, headers);
  assert.equal(autosaved.statusCode, 200, autosaved.body);
  assert.equal(autosaved.json.action, 'assistant-draft-autosave');
  assert.deepEqual(autosaved.json.template.spec.assistantDraft, assistantDraft);
  assert.deepEqual(autosaved.json.template.spec.steps, savedSpec.steps);
  assert.equal(autosaved.json.versionLog, undefined);
  assert.equal(autosaved.json.cacheInvalidation, undefined);
  assert.equal(mock.requests.some((item) => item.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplateVersion/cards'), false);

  const stale = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/AssistantAutosave/assistant-draft`, {
    baseSpecHash: hashJson(savedSpec),
    assistantDraft
  }, headers);
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json.reason, 'template_version_conflict');
  assert.equal(backend.exitCode, null);
});

test('assistant plans an inherited domain relation from IS to ipRange and preview returns a parameterized table', async (t) => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:informationSystems',
      name: 'Information systems',
      alias: 'IS',
      className: 'IS',
      from: '',
      limit: 1,
      columns: ['Name'],
      rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
    }],
    operations: [{
      id: 'relation:ipRanges',
      type: 'relation',
      from: 'IS',
      as: 'ipRange',
      domain: 'ISZabbixMonitoringDomain',
      targetClass: 'ipRange',
      direction: 'source',
      columns: ['range'],
      limit: 100,
      distinct: true
    }],
    publishedAlias: 'ipRange'
  };
  const llm = await startLiteLlmStub(t, { flow });
  const domain = {
    _id: 'ISZabbixMonitoringDomain',
    name: 'ISZabbixMonitoringDomain',
    description: 'N:N relation between IS and monitoring descendants',
    source: 'IS',
    sources: ['IS'],
    destination: 'ZabbixMonitoring',
    destinations: ['ipRange'],
    disabledSourceDescendants: [],
    disabledDestinationDescendants: [],
    cardinality: 'N:N'
  };
  const runtimeSpec = compileObjectFlowToSpec({ version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, flow);
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'ИС', parent: 'ZabbixMonitoring', active: true },
      { _id: 2, name: 'ipRange', description: 'ipRange', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 4, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 5, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }]
    },
    domains: [domain],
    cardsByClass: {
      IS: [{ _id: 101, Code: 'IS-001', Description: 'Target IS', Name: 'Target IS' }],
      ipRange: [{ _id: 201, Code: 'RANGE-001', Description: 'Target range', range: '10.44.0.0/24' }]
    },
    relationsByCard: {
      'IS:101': [{
        _id: 301,
        domain: 'ISZabbixMonitoringDomain',
        _sourceType: 'IS',
        _sourceId: 101,
        _sourceCode: 'IS-001',
        _sourceDescription: 'Target IS',
        _destinationType: 'ipRange',
        _destinationId: 201,
        _destinationCode: 'RANGE-001',
        _destinationDescription: 'Target range',
        _direction: 'direct'
      }]
    },
    templates: [templateCard('IsIpRangeRuntime', runtimeSpec)],
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
  const cookie = 'CMDBuild-Authorization=is-ip-range-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const relationHints = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/mcp`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'cmdbuild_relation_hints', arguments: { maxDomains: 10 } }
  }, headers);
  assert.equal(relationHints.statusCode, 200, relationHints.body);
  assert.deepEqual(relationHints.json.result.structuredContent.domains.map((item) => item.name), ['ISZabbixMonitoringDomain']);
  const prompt = 'Выборка 1\nДля информационной системы (ИС) имя которой равно параметру отчета isName, выбираем все связанные объекты ipRange';
  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '',
    baseSpecHash: '',
    currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } },
    ...objectFlowPlanRequest(prompt)
  }, headers);

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.success, true);
  assert.equal(planned.json.flow.selections[0].className, 'IS');
  assert.deepEqual(planned.json.flow.operations[0], flow.operations[0]);
  assert.equal(planned.json.flow.operations.some((operation) => operation.type === 'match'), false);

  const spec = compileObjectFlowToSpec({ version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, planned.json.flow);
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'IsIpRangePreview', spec },
    params: { isName: 'Target IS' }
  }, headers);

  assert.equal(preview.statusCode, 200, preview.body);
  const table = preview.json.result.tables.find((item) => item.name === 'ipRange');
  assert.ok(table, 'published ipRange table is present');
  assert.deepEqual(table.rows.map((row) => [row.SourceCode, row.Domain, row.Code, row.range]), [
    ['IS-001', 'ISZabbixMonitoringDomain', 'RANGE-001', '10.44.0.0/24']
  ]);
  const runtime = await requestJson('GET', `${backendOrigin}/cmdbuild/dynamicpages/ui/run/IsIpRangeRuntime?isName=Target%20IS&json=true`, undefined, { cookie });
  assert.equal(runtime.statusCode, 200, runtime.body);
  const runtimeTable = runtime.json.tables.find((item) => item.name === 'ipRange');
  assert.deepEqual(runtimeTable.rows.map((row) => [row.Code, row.range]), [['RANGE-001', '10.44.0.0/24']]);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/IS/cards/101/relations')), true);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('assistant validates an inherited IS to ipRange to vlan relation chain and returns a VLAN table', async (t) => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:informationSystems',
      name: 'Information systems',
      alias: 'IS',
      className: 'IS',
      from: '',
      limit: 1,
      columns: ['Name'],
      rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
    }],
    operations: [{
      id: 'relation:ipRanges',
      type: 'relation',
      from: 'IS',
      as: 'ipRange',
      domain: 'ISZabbixMonitoringDomain',
      targetClass: 'ipRange',
      direction: 'source',
      columns: ['range'],
      limit: 100,
      distinct: true
    }, {
      id: 'relation:vlans',
      type: 'relation',
      from: 'ipRange',
      as: 'vlan',
      domain: 'Vlan2super',
      targetClass: 'vlan',
      direction: 'destination',
      columns: ['network'],
      limit: 100,
      distinct: true
    }],
    publishedAlias: 'vlan'
  };
  const llm = await startLiteLlmStub(t, { flow });
  const isDomain = {
    _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'],
    destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
  };
  const vlanDomain = {
    _id: 'Vlan2super', name: 'Vlan2super', source: 'vlan', sources: ['vlan'],
    destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:1'
  };
  const unrelatedDomains = Array.from({ length: 24 }, (_, index) => ({
    _id: `UnrelatedDomain${index + 1}`,
    name: `UnrelatedDomain${index + 1}`,
    description: `Unrelated domain ${index + 1}: ${'x'.repeat(4096)}`,
    source: `UnrelatedSource${index + 1}`,
    sources: [`UnrelatedSource${index + 1}`],
    destination: `UnrelatedTarget${index + 1}`,
    destinations: [`UnrelatedTarget${index + 1}`],
    disabledSourceDescendants: [],
    disabledDestinationDescendants: [],
    cardinality: 'N:N'
  }));
  const runtimeSpec = compileObjectFlowToSpec({ version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, flow);
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'vlan', description: 'VLAN', parent: 'Class', active: true },
      { _id: 4, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 5, name: 'routerG', description: 'Router', parent: 'Class', active: true },
      { _id: 6, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 7, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      vlan: [{ name: 'network', type: 'string', active: true, _can_read: true }]
    },
    domains: [isDomain, vlanDomain, ...unrelatedDomains],
    cardsByClass: {
      IS: [{ _id: 101, Code: 'IS-001', Description: 'Target IS', Name: 'Target IS' }],
      ipRange: [{ _id: 201, Code: 'RANGE-001', Description: 'Target range', range: '10.44.0.0/24' }],
      vlan: [{ _id: 301, Code: 'VLAN-001', Description: 'Target VLAN', network: '10.44.0.0/24' }]
    },
    relationsByCard: {
      'IS:101': [{
        _id: 401, domain: 'ISZabbixMonitoringDomain', _sourceType: 'IS', _sourceId: 101, _sourceCode: 'IS-001', _sourceDescription: 'Target IS',
        _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Target range', _direction: 'direct'
      }],
      'ipRange:201': [{
        _id: 402, domain: 'Vlan2super', _sourceType: 'vlan', _sourceId: 301, _sourceCode: 'VLAN-001', _sourceDescription: 'Target VLAN',
        _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Target range', _direction: 'direct'
      }, {
        _id: 403, domain: 'Vlan2super', _sourceType: 'routerG', _sourceId: 302, _sourceCode: 'ROUTER-001', _sourceDescription: 'Wrong endpoint class',
        _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Target range', _direction: 'direct'
      }]
    },
    templates: [templateCard('IsIpRangeVlanRuntime', runtimeSpec)],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: {
          llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
          mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 }
        }
      })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=is-ip-range-vlan-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const prompt = [
    'Выборка 1',
    'Для информационной системы (ИС) имя которой равно параметру отчета isName.',
    '',
    'Связь 1.1',
    'Из Выборки 1 получить связанные объекты ipRange.',
    '',
    'Связь 2.1',
    'Из результата Связи 1.1 получить связанные объекты VLAN.',
    '',
    'Проверьте сформированный поток в Группе объектов и Связях перед применением draft.'
  ].join('\n');
  const intent = {
    context: prompt,
    blocks: [{
      id: 'ip-ranges', name: 'IP-диапазоны ИС', entities: 'ИС и связанные IP-диапазоны.',
      algorithm: 'Выбрать связанные с исходной ИС объекты ipRange.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'vlans', name: 'VLAN', entities: 'VLAN, связанные с IP-диапазонами первого результата.',
      algorithm: 'Выбрать связанные с ipRange из первого результата VLAN.', expectedResult: 'Таблица VLAN.', uses: ['ip-ranges']
    }]
  };
  const semanticPlan = {
    version: 1,
    blocks: [{
      id: 'ip-ranges', name: 'IP-диапазоны ИС', summary: 'Связанные IP-диапазоны.', resolvedEntities: ['IS', 'ipRange'], relationPaths: ['IS --ISZabbixMonitoringDomain [source]--> ipRange'], dependencies: [], expectedResult: 'Список ipRange.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', dependencyPaths: [], relationPredicates: [], attributePredicates: [] }, warnings: []
    }, {
      id: 'vlans', name: 'VLAN', summary: 'VLAN связаны с IP-диапазонами первого результата.', resolvedEntities: ['ipRange', 'vlan'], relationPaths: ['ipRange --Vlan2super [destination]--> vlan'], dependencies: ['ip-ranges'], expectedResult: 'Таблица VLAN.',
      resultContract: {
        outputKind: 'sourceCards', outputClass: 'vlan',
        dependencyPaths: [{ comparisonBlockId: 'ip-ranges', sourceClass: 'ipRange', domain: 'Vlan2super', direction: 'destination', targetClass: 'vlan' }],
        relationPredicates: [], attributePredicates: []
      }, warnings: []
    }],
    explanation: 'VLAN получается прямым переходом из первого результата.', warnings: []
  };
  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.success, true);
  assert.deepEqual(planned.json.flow.operations, flow.operations);
  assert.deepEqual(planned.json.diagnostics.objectFlow.relationRequirements, {
    kind: 'relationRequirements',
    chains: [{ operations: flow.operations.map(({ domain, targetClass, direction }, index) => ({
      sourceClass: index === 0 ? 'IS' : 'ipRange', domain, targetClass, direction
    })) }]
  });
  assert.ok(planned.json.diagnostics.mcp.relationPaths.some((item) => item.domain === 'Vlan2super' && item.direction === 'destination' && item.sourceClass === 'ipRange' && item.targetClass === 'vlan'), planned.body);
  assert.equal(planned.json.warnings.some((warning) => /context limit reached/i.test(warning)), false, planned.body);
  const assistantRequest = llm.lastRequest;
  const assistantPayload = JSON.parse(assistantRequest.messages.at(-1).content);
  const assistantMcpContext = JSON.parse(assistantPayload.mcpContext.data);
  assert.deepEqual(assistantMcpContext.relationHints.domains.map((item) => item.name).sort(), ['ISZabbixMonitoringDomain', 'Vlan2super']);
  assert.equal(assistantPayload.mcpContext.data.includes('UnrelatedDomain1'), false);
  assert.ok(Buffer.byteLength(assistantPayload.mcpContext.data) < 32768);

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'IsIpRangeVlanPreview', spec: runtimeSpec }, params: { isName: 'Target IS' }
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const previewTable = preview.json.result.tables.find((item) => item.name === 'vlan');
  assert.deepEqual(previewTable.rows.map((row) => [row.SourceCode, row.RelatedClass, row.Code, row.network]), [['RANGE-001', 'vlan', 'VLAN-001', '10.44.0.0/24']]);

  const runtime = await requestJson('GET', `${backendOrigin}/cmdbuild/dynamicpages/ui/run/IsIpRangeVlanRuntime?isName=Target%20IS&json=true`, undefined, { cookie });
  assert.equal(runtime.statusCode, 200, runtime.body);
  const runtimeTable = runtime.json.tables.find((item) => item.name === 'vlan');
  assert.deepEqual(runtimeTable.rows.map((row) => [row.Code, row.network]), [['VLAN-001', '10.44.0.0/24']]);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/IS/cards/101/relations')), true);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ipRange/cards/201/relations')), true);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('assistant keeps confirmed relation requirements and executes source-driven ACL IPv4 filtering', async (t) => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:informationSystems', name: 'Information systems', alias: 'informationSystems', className: 'IS', from: '', limit: 1, columns: ['Name'],
      rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
    }, {
      id: 'selection:acls', name: 'ACL rules', alias: 'acls', className: 'ACL', from: 'ipRanges', limit: 100, columns: ['Code', 'Description', 'ipaddress', 'dipaddress'],
      rules: [
        { action: 'include', path: 'ipaddress', negate: false, op: 'ipv4InCidr', value: '', regex: '', valueParam: '', valueColumn: 'range' },
        { action: 'include', path: 'dipaddress', negate: false, op: 'ipv4InCidr', value: '', regex: '', valueParam: '', valueColumn: 'range' }
      ]
    }],
    operations: [{
      id: 'relation:ipRanges', type: 'relation', from: 'informationSystems', as: 'ipRanges', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true
    }, {
      id: 'relation:vlans', type: 'relation', from: 'ipRanges', as: 'vlans', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination', columns: ['network'], limit: 100, distinct: true
    }],
    publishedAlias: ''
  };
  const llm = await startLiteLlmStub(t, { flow });
  const isDomain = {
    _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'],
    destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
  };
  const vlanDomain = {
    _id: 'Vlan2super', name: 'Vlan2super', source: 'vlan', sources: ['vlan'],
    destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:1'
  };
  const aclDomain = {
    _id: 'aclLine', name: 'aclLine', source: 'ACL', sources: ['ACL'],
    destination: 'IpAddress', destinations: ['IpAddress'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
  };
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'vlan', description: 'VLAN', parent: 'Class', active: true },
      { _id: 4, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 5, name: 'IpAddress', description: 'IP address', parent: 'ZabbixMonitoring', active: true },
      { _id: 6, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 7, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 8, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      vlan: [{ name: 'network', type: 'string', active: true, _can_read: true }],
      ACL: [
        { name: 'ipaddress', description: 'Source ipaddress', type: 'string', active: true, _can_read: true },
        { name: 'dipaddress', description: 'Destination ipaddress', type: 'string', active: true, _can_read: true }
      ],
      IpAddress: [{ name: 'ipAddr', type: 'string', active: true, _can_read: true }]
    },
    domains: [isDomain, vlanDomain, aclDomain],
    cardsByClass: {
      IS: [{ _id: 101, Code: 'IS-001', Description: 'Target IS', Name: 'Target IS' }],
      ipRange: [{ _id: 201, Code: 'RANGE-001', Description: 'Target range', range: '10.44.0.0/24' }],
      vlan: [{ _id: 301, Code: 'VLAN-001', Description: 'Target VLAN', network: '10.44.0.0/24' }],
      ACL: [
        { _id: 401, Code: 'ACL-SOURCE', Description: 'Source is in range', ipaddress: '10.44.0.10', dipaddress: '10.99.0.10' },
        { _id: 402, Code: 'ACL-DESTINATION', Description: 'Destination is in range', ipaddress: '10.99.0.20', dipaddress: '10.44.0.20' },
        { _id: 403, Code: 'ACL-OUTSIDE', Description: 'Outside range', ipaddress: '10.99.0.30', dipaddress: '10.99.0.31' }
      ]
    },
    relationsByCard: {
      'IS:101': [{
        _id: 501, domain: 'ISZabbixMonitoringDomain', _sourceType: 'IS', _sourceId: 101, _sourceCode: 'IS-001', _sourceDescription: 'Target IS',
        _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Target range', _direction: 'direct'
      }],
      'ipRange:201': [{
        _id: 502, domain: 'Vlan2super', _sourceType: 'vlan', _sourceId: 301, _sourceCode: 'VLAN-001', _sourceDescription: 'Target VLAN',
        _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Target range', _direction: 'direct'
      }]
    },
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=acl-ipv4-flow-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const prompt = [
    'Выборка 1',
    'Для информационной системы (ИС) имя которой равно параметру отчета isName.',
    '',
    'Связь 1.1',
    'Из Выборки 1 получить связанные объекты ipRange.',
    '',
    'Связь 2.1',
    'Из результата Связи 1.1 получить связанные объекты VLAN.',
    '',
    'Выборка 3',
    'Получить все ACL.',
    '',
    'Сопоставление 3.1',
    'Оставить ACL, у которых Destination ipaddress или Source ipaddress входят в range результата Связи 1.1.',
    '',
    'Проверьте сформированный поток в Группе объектов и Связях перед применением draft.'
  ].join('\n');
  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, ...objectFlowPlanRequest(prompt)
  }, headers);

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.success, true);
  assert.equal(planned.json.flow.publishedAlias, '');
  assert.equal(planned.json.diagnostics.objectFlow.fallback, null);
  assert.deepEqual(planned.json.diagnostics.objectFlow.relationRequirements, {
    kind: 'relationRequirements',
    chains: [{ operations: [
      { sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }
    ] }]
  });
  const plannedAcls = planned.json.flow.selections.find((selection) => selection.alias === 'acls');
  assert.equal(plannedAcls.from, 'ipRanges');
  assert.deepEqual(plannedAcls.rules.map((rule) => [rule.op, rule.valueColumn]), [
    ['ipv4InCidr', 'range'],
    ['ipv4InCidr', 'range']
  ]);
  assert.ok(llm.lastRequest.messages.some((message) => /prefer a source-driven selection/.test(message.content)), JSON.stringify(llm.lastRequest));

  const spec = compileObjectFlowToSpec({ version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, planned.json.flow);
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'AclIpv4FlowPreview', spec }, params: { isName: 'Target IS' }
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const matchingAlias = plannedAcls.alias;
  const matching = preview.json.result.tables.find((table) => table.name === matchingAlias);
  assert.deepEqual(matching.rows.map((row) => row.Code).sort(), ['ACL-DESTINATION', 'ACL-SOURCE']);
  assert.equal(matching.rows.some((row) => row.Code === 'ACL-OUTSIDE'), false);
  assert.equal(backend.exitCode, null);
});

test('assistant requires an expected result for every business data block before semantic planning', async (t) => {
  const llm = await startLiteLlmStub(t, { flow: {} });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=decomposition-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string' } }, steps: [], result: { tables: [] } },
    intent: { context: '', blocks: [{ id: 'ip-ranges', name: 'IP ranges', entities: 'ИС и ipRange', algorithm: 'Получить связанные IP-диапазоны.', expectedResult: '', uses: [] }] }
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json.code, 'assistant_object_flow_intent_incomplete');
  assert.match(response.json.message, /expectedResult is required/);
  assert.equal(llm.requests, 0);
  assert.equal(backend.exitCode, null);
});

test('assistant keeps a business block dependency on a later block for semantic planning', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [
        { id: 'ip-ranges', name: 'IP ranges', summary: 'IP ranges depend on VLAN context.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: ['vlans'], expectedResult: 'IP-диапазоны.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [] }, warnings: [] },
        { id: 'vlans', name: 'VLANs', summary: 'VLAN source cards.', resolvedEntities: ['vlan'], relationPaths: [], dependencies: [], expectedResult: 'VLAN.', resultContract: { outputKind: 'sourceCards', outputClass: 'vlan', relationPredicates: [] }, warnings: [] }
      ],
      explanation: 'Forward dependency accepted for semantic planning.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 2, name: 'vlan', description: 'VLAN', parent: 'Class', active: true },
      { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=undefined-selection-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string' } }, steps: [], result: { tables: [] } },
    intent: { context: '', blocks: [
      { id: 'ip-ranges', name: 'IP ranges', entities: 'ipRange', algorithm: 'Получить IP-диапазоны.', expectedResult: 'IP-диапазоны.', uses: ['vlans'] },
      { id: 'vlans', name: 'VLANs', entities: 'vlan', algorithm: 'Получить VLAN.', expectedResult: 'VLAN.', uses: [] }
    ] }
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.semanticPlan.blocks[0].dependencies, ['vlans']);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('existsRelatedRows retains source cards when a related card matches comparison rows', async (t) => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:externalSystems', name: 'External systems', alias: 'externalSystems', className: 'IS', from: '', limit: 100, columns: ['isExt'],
      rules: [{ action: 'include', path: 'isExt', negate: false, op: 'equals', value: 'true', regex: '', valueParam: '', valueColumn: '' }]
    }, {
      id: 'selection:acls', name: 'ACL', alias: 'acls', className: 'ACL', from: '', limit: 100, columns: ['ipaddress'],
      rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', value: '', regex: '.*', valueParam: '', valueColumn: '' }]
    }],
    operations: [{
      id: 'existsRelated:externalSystemsWithAcl', type: 'existsRelated', from: 'externalSystems', with: 'acls', as: 'externalSystemsWithAcl',
      domain: 'ISIpRange', targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true,
      rules: [{ action: 'include', negate: false, operator: 'ipv4InCidr', leftColumn: 'ipaddress', leftRegex: '', rightColumn: 'range', rightRegex: '' }]
    }],
    publishedAlias: 'externalSystemsWithAcl'
  };
  const spec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Information system', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 3, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 4, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 5, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'isExt', type: 'boolean', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ACL: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }]
    },
    domains: [{ _id: 'ISIpRange', name: 'ISIpRange', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }],
    cardsByClass: {
      IS: [
        { _id: 101, Code: 'EXT-001', Description: 'External one', isExt: true },
        { _id: 102, Code: 'EXT-002', Description: 'External two', isExt: true }
      ],
      ipRange: [
        { _id: 201, Code: 'RANGE-001', Description: 'Matching range', range: '10.44.0.0/24' },
        { _id: 202, Code: 'RANGE-002', Description: 'Other range', range: '10.99.0.0/24' }
      ],
      ACL: [{ _id: 301, Code: 'ACL-001', Description: 'Matching ACL', ipaddress: '10.44.0.10' }]
    },
    relationsByCard: {
      'IS:101': [{ _id: 401, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 101, _sourceCode: 'EXT-001', _sourceDescription: 'External one', _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Matching range', _direction: 'direct' }],
      'IS:102': [{ _id: 402, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 102, _sourceCode: 'EXT-002', _sourceDescription: 'External two', _destinationType: 'ipRange', _destinationId: 202, _destinationCode: 'RANGE-002', _destinationDescription: 'Other range', _direction: 'direct' }]
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=exists-related-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'ExistsRelatedPreview', spec }, params: {}
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(preview.statusCode, 200, preview.body);
  const table = preview.json.result.tables.find((item) => item.name === 'externalSystemsWithAcl');
  assert.ok(table, preview.body);
  assert.deepEqual(table.rows.map((row) => row.Code), ['EXT-001']);
  assert.equal(table.rows.some((row) => row.Code === 'EXT-002'), false);
  assert.deepEqual(preview.json.result.trace.map((item) => item.type), ['selectCards', 'selectCards', 'existsRelatedRows']);
  assert.equal(backend.exitCode, null);
});

test('assistant keeps an IS list when related ipRange is only an ACL IPv4 predicate', async (t) => {
  const intent = {
    context: 'Построить список внешних ИС вне исходной ИС.',
    blocks: [{
      id: 'result-3', name: 'Результат 3', entities: 'Карточки ACL с Source ipaddress и Destination ipaddress.',
      algorithm: 'Выбрать ACL, ранее отобранные для исходной ИС.', expectedResult: 'Список ACL.', uses: []
    }, {
      id: 'external-is', name: 'Внешние ИС с ACL', entities: 'ИС, связанные ipRange и ACL из Результата 3.',
      algorithm: 'Оставить ИС с isExt=false и Name не равным isName, если хотя бы один связанный ipRange содержит Source ipaddress или Destination ipaddress ACL из Результата 3.',
      expectedResult: 'Список ИС.', uses: ['result-3']
    }]
  };
  const semanticPlan = {
    version: 1,
    blocks: [{
      id: 'result-3', name: 'Результат 3', summary: 'Отобранные ACL.', resolvedEntities: ['ACL'], relationPaths: [], dependencies: [], expectedResult: 'Список ACL.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', relationPredicates: [] }, warnings: []
    }, {
      id: 'external-is', name: 'Внешние ИС с ACL', summary: 'ИС сохраняются при совпадении ACL с диапазоном связанного ipRange.', resolvedEntities: ['IS', 'ipRange', 'ACL'],
      relationPaths: ['IS --ISIpRange [source]--> ipRange'], dependencies: ['result-3'], expectedResult: 'Список ИС.',
      resultContract: {
        outputKind: 'sourceCards', outputClass: 'IS', relationPredicates: [{
          sourceClass: 'IS', relatedClass: 'ipRange', comparisonBlockId: 'result-3', comparisonClass: 'ACL',
          domain: 'ISIpRange', direction: 'source', comparisonFields: ['ipaddress', 'dipaddress'], relatedField: 'range', operator: 'ipv4InCidr'
        }]
      }, warnings: []
    }],
    explanation: 'ИС остается результатом; ipRange используется только как predicate.', warnings: []
  };
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:result3Acl', name: 'Результат 3', alias: 'result3Acl', className: 'ACL', from: '', limit: 100,
      columns: ['ipaddress', 'dipaddress'], rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', value: '', regex: '.*', valueParam: '', valueColumn: '' }]
    }, {
      id: 'selection:externalIs', name: 'Внешние ИС с ACL', alias: 'externalIs', className: 'IS', from: '', limit: 100,
      columns: ['Name', 'isExt'], rules: [
        { action: 'include', path: 'isExt', negate: false, op: 'equals', value: 'false', regex: '', valueParam: '', valueColumn: '' },
        { action: 'include', path: 'Name', negate: false, op: 'notEquals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }
      ]
    }],
    operations: [{
      id: 'existsRelated:externalIsWithAcl', type: 'existsRelated', from: 'externalIs', with: 'result3Acl', as: 'externalIsWithAcl',
      domain: 'ISIpRange', targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true,
      rules: [
        { action: 'include', negate: false, operator: 'ipv4InCidr', leftColumn: 'ipaddress', leftRegex: '', rightColumn: 'range', rightRegex: '' },
        { action: 'include', negate: false, operator: 'ipv4InCidr', leftColumn: 'dipaddress', leftRegex: '', rightColumn: 'range', rightRegex: '' }
      ]
    }],
    publishedAlias: 'externalIsWithAcl'
  };
  const llm = await startLiteLlmStub(t, {
    responses: [
      { flow, explanation: 'Validated test proposal.', warnings: [] },
      { flow: {}, explanation: 'Incomplete proposal.', warnings: [] }
    ]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 3, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 4, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 5, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }, { name: 'isExt', type: 'boolean', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ACL: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }, { name: 'dipaddress', type: 'string', active: true, _can_read: true }]
    },
    domains: [{ _id: 'ISIpRange', name: 'ISIpRange', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }],
    cardsByClass: {
      IS: [
        { _id: 101, Code: 'IS-001', Description: 'External matching', Name: 'External matching', isExt: false },
        { _id: 102, Code: 'IS-002', Description: 'External other', Name: 'External other', isExt: false }
      ],
      ipRange: [
        { _id: 201, Code: 'RANGE-001', Description: 'Matching range', range: '10.44.0.0/24' },
        { _id: 202, Code: 'RANGE-002', Description: 'Other range', range: '10.99.0.0/24' }
      ],
      ACL: [{ _id: 301, Code: 'ACL-001', Description: 'Matching ACL', ipaddress: '10.1.1.1', dipaddress: '10.44.0.10' }]
    },
    relationsByCard: {
      'IS:101': [{ _id: 401, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 101, _sourceCode: 'IS-001', _sourceDescription: 'External matching', _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Matching range', _direction: 'direct' }],
      'IS:102': [{ _id: 402, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 102, _sourceCode: 'IS-002', _sourceDescription: 'External other', _destinationType: 'ipRange', _destinationId: 202, _destinationCode: 'RANGE-002', _destinationDescription: 'Other range', _direction: 'direct' }]
    },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=source-cards-contract-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.flow.publishedAlias, 'externalIsWithAcl');
  assert.equal(planned.json.flow.operations.filter((operation) => operation.type === 'relation').length, 0);
  assert.deepEqual(planned.json.flow.operations[0].rules.map((rule) => rule.leftColumn), ['ipaddress', 'dipaddress']);

  const rebuilt = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);
  assert.equal(rebuilt.statusCode, 200, rebuilt.body);
  assert.deepEqual(rebuilt.json.diagnostics.objectFlow.fallback, { kind: 'semanticContractCompiler', used: true });
  const rebuiltIsSource = rebuilt.json.flow.selections.find((selection) => selection.className === 'IS');
  assert.deepEqual(rebuiltIsSource.rules.map((rule) => [rule.path, rule.op, rule.value, rule.valueParam]), [
    ['Name', 'notEquals', '', 'isName'],
    ['isExt', 'equals', 'false', '']
  ]);
  const spec = compileObjectFlowToSpec({ version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, planned.json.flow);
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'SourceCardsContractPreview', spec }, params: { isName: 'Source IS' }
  }, headers);

  assert.equal(preview.statusCode, 200, preview.body);
  const table = preview.json.result.tables.find((item) => item.name === 'externalIsWithAcl');
  assert.deepEqual(table.rows.map((row) => row.Code), ['IS-001']);
  assert.equal(table.rows[0].range, undefined);
  assert.equal(backend.exitCode, null);
});

test('assistant preserves source cards for a direct cross-block IPv4 attribute predicate', async (t) => {
  const intent = {
    context: 'Отчет по ACL в сетях из первого результата.',
    blocks: [{
      id: 'ip-ranges', name: 'Результат 1', entities: 'Карточки ipRange с атрибутом range.',
      algorithm: 'Выбрать сети ipRange.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'acls', name: 'Результат 3', entities: 'Карточки ACL и сети из Результата 1.',
      algorithm: 'Выбрать ACL, у которых ipaddress или dipaddress входит в сеть range объектов ipRange из Результата 1.',
      expectedResult: 'Список ACL.', uses: ['ip-ranges']
    }]
  };
  const semanticPlan = {
    version: 1,
    blocks: [{
      id: 'ip-ranges', name: 'Результат 1', summary: 'Сети для сравнения.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: []
    }, {
      id: 'acls', name: 'Результат 3', summary: 'ACL, чей Source или Destination IP принадлежит сети первого результата.', resolvedEntities: ['ACL', 'ipRange'], relationPaths: [], dependencies: ['ip-ranges'], expectedResult: 'Список ACL.',
      resultContract: {
        outputKind: 'sourceCards', outputClass: 'ACL', relationPredicates: [],
        attributePredicates: [{
          sourceClass: 'ACL', comparisonBlockId: 'ip-ranges', comparisonClass: 'ipRange',
          sourceFields: ['ipaddress', 'dipaddress'], comparisonField: 'range', operator: 'ipv4InCidr'
        }]
      }, warnings: []
    }],
    explanation: 'Второй результат сравнивает атрибуты с первым без CMDBuild domain.', warnings: []
  };
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:ipRanges', name: 'Результат 1', alias: 'ipRanges', className: 'ipRange', from: '', limit: 100,
      columns: ['Code', 'range'], rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', value: '', regex: '.*', valueParam: '', valueColumn: '' }]
    }, {
      id: 'selection:acls', name: 'Результат 3', alias: 'acls', className: 'ACL', from: 'ipRanges', limit: 100,
      columns: ['Code', 'ipaddress', 'dipaddress'], rules: [
        { action: 'include', path: 'ipaddress', negate: false, op: 'ipv4InCidr', value: '', regex: '', valueParam: '', valueColumn: 'range' },
        { action: 'include', path: 'dipaddress', negate: false, op: 'ipv4InCidr', value: '', regex: '', valueParam: '', valueColumn: 'range' }
      ]
    }],
    operations: [], publishedAlias: 'acls'
  };
  const llm = await startLiteLlmStub(t, {
    responses: [
      { flow, explanation: 'Validated test proposal.', warnings: [] },
      { flow: {}, explanation: 'Incomplete proposal.', warnings: [] }
    ]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 2, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ACL: [
        { name: 'ipaddress', type: 'string', active: true, _can_read: true },
        { name: 'dipaddress', type: 'string', active: true, _can_read: true }
      ]
    },
    cardsByClass: {
      ipRange: [{ _id: 1, Code: 'RANGE-10', Description: '10.44.0.0/24', range: '10.44.0.0/24' }],
      ACL: [
        { _id: 11, Code: 'ACL-SOURCE', Description: 'Source in range', ipaddress: '10.44.0.10', dipaddress: '203.0.113.10' },
        { _id: 12, Code: 'ACL-DESTINATION', Description: 'Destination in range', ipaddress: '203.0.113.20', dipaddress: '10.44.0.20' },
        { _id: 13, Code: 'ACL-OUTSIDE', Description: 'Outside range', ipaddress: '203.0.113.30', dipaddress: '203.0.113.31' }
      ]
    },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=attribute-predicate-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.flow.publishedAlias, 'acls');
  assert.equal(planned.json.flow.operations.length, 0);
  assert.deepEqual(planned.json.flow.selections[1].rules.map((rule) => [rule.path, rule.op, rule.valueColumn]), [
    ['ipaddress', 'ipv4InCidr', 'range'],
    ['dipaddress', 'ipv4InCidr', 'range']
  ]);
  assert.ok(llm.lastRequest.messages.some((message) => /attributePredicates item is a direct comparison/.test(message.content)), JSON.stringify(llm.lastRequest));

  const rebuilt = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);
  assert.equal(rebuilt.statusCode, 200, rebuilt.body);
  assert.deepEqual(rebuilt.json.diagnostics.objectFlow.fallback, { kind: 'semanticContractCompiler', used: true });
  assert.equal(rebuilt.json.flow.publishedAlias, rebuilt.json.flow.selections[1].alias);
  assert.deepEqual(rebuilt.json.flow.selections.map((selection) => [selection.className, selection.from]), [
    ['ipRange', ''],
    ['ACL', rebuilt.json.flow.selections[0].alias]
  ]);
  assert.deepEqual(rebuilt.json.flow.selections[1].rules.map((rule) => [rule.path, rule.op, rule.valueColumn]), [
    ['ipaddress', 'ipv4InCidr', 'range'],
    ['dipaddress', 'ipv4InCidr', 'range']
  ]);

  const spec = compileObjectFlowToSpec({ version: 1, params: {}, steps: [], result: { tables: [] } }, planned.json.flow);
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'AttributePredicatePreview', spec }, params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const table = preview.json.result.tables.find((item) => item.name === 'acls');
  assert.deepEqual(table.rows.map((row) => row.Code).sort(), ['ACL-DESTINATION', 'ACL-SOURCE']);
  assert.equal(table.rows.some((row) => row.Code === 'ACL-OUTSIDE'), false);
  assert.equal(backend.exitCode, null);
});

test('assistant rejects invented domain and forward aliases with confirmed relation candidates', async (t) => {
  const invalidFlow = {
    version: 1,
    selections: [{
      id: 'selection:informationSystems', name: 'Information systems', alias: 'informationSystems', className: 'IS', from: '', limit: 1, columns: ['Name'],
      rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
    }],
    operations: [{
      id: 'relation:ipRanges', type: 'relation', from: 'informationSystems', as: 'ipRanges', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true
    }, {
      id: 'match:invalidAliases', type: 'match', from: 'ipRange', with: 'vlans', as: 'invalidAliases', rightPrefix: 'invalid_',
      rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Code', leftRegex: '', rightColumn: 'Code', rightRegex: '' }]
    }, {
      id: 'relation:vlans', type: 'relation', from: 'ipRanges', as: 'vlans', domain: 'ipRangeVlanDomain', targetClass: 'vlan', direction: 'destination', columns: ['network'], limit: 100, distinct: true
    }],
    publishedAlias: 'vlans'
  };
  const llm = await startLiteLlmStub(t, { flow: invalidFlow });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'vlan', description: 'VLAN', parent: 'Class', active: true },
      { _id: 4, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }], ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }], vlan: [{ name: 'network', type: 'string', active: true, _can_read: true }] },
    domains: [
      { _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'], destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' },
      { _id: 'Vlan2super', name: 'Vlan2super', source: 'vlan', sources: ['vlan'], destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:1' }
    ],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=invalid-relation-flow-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } },
    ...objectFlowPlanRequest('Для информационной системы (ИС) с Name равным isName получить связанные ipRange, затем связанные VLAN.')
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'assistant_object_flow_invalid');
  assert.equal(response.json.flow, undefined);
  assert.deepEqual(response.json.rejectedFlow.operations, invalidFlow.operations);
  assert.equal(response.json.rejectedFlow.selections[0].alias, 'informationSystems');
  assert.ok(response.json.errors.some((item) => item.path === '$.operations[1].from' && item.availableAliases.some((alias) => alias.alias === 'ipRanges')), response.body);
  const domainError = response.json.errors.find((item) => item.path === '$.flow.operations[2].domain');
  assert.ok(domainError, response.body);
  assert.ok(domainError.candidates.some((item) => item.domain === 'Vlan2super' && item.direction === 'destination' && item.sourceClass === 'ipRange' && item.targetClass === 'vlan'), response.body);
  assert.deepEqual(response.json.diagnostics.objectFlow.relationRequirements, {
    kind: 'relationRequirements',
    chains: [{ operations: [
      { sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }
    ] }]
  });
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('assistant reports the primary missing field when LiteLLM omits Object Flow identifiers', async (t) => {
  const incompleteFlow = {
    version: 1,
    selections: [
      {
        id: 'selection:IS_by_Name', name: 'Результат 1', alias: 'IS_by_Name', className: '', from: '', limit: 100, columns: ['Id', 'Name'],
        rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', value: '', regex: '', valueParam: 'isName', valueColumn: '' }]
      },
      {
        id: 'selection:IS_to_ipRange', name: 'Результат 2', alias: 'ipRange_from_IS', className: '', from: 'IS_by_Name', limit: 1000, columns: ['Id', 'range'],
        rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
      }
    ],
    operations: [{
      id: 'existsRelated:ipRange_acl_ipaddress', type: 'existsRelated', from: 'ipRange_from_IS', with: '', as: 'ACL_with_ip_in_ipRange', domain: 'aclLine', targetClass: 'ACL', direction: 'source', columns: ['Id', 'ipaddress', 'dipaddress'], limit: 1000, distinct: true,
      rules: [{ action: 'include', negate: false, operator: 'ipv4InCidr', leftColumn: 'range', leftRegex: '', rightColumn: 'ipaddress', rightRegex: '' }]
    }],
    publishedAlias: ''
  };
  const llm = await startLiteLlmStub(t, { flow: incompleteFlow });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'ACL', description: 'ACL', parent: 'Class', active: true },
      { _id: 4, name: 'ZabbixMonitoring', description: 'Monitoring', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ACL: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }, { name: 'dipaddress', type: 'string', active: true, _can_read: true }]
    },
    domains: [{ _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'], destination: 'ZabbixMonitoring', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=incomplete-object-flow-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const planRequest = objectFlowPlanRequest('Для информационной системы (ИС) с Name равным isName получить связанные ipRange, затем оставить ipRange, у которых есть связанный ACL с ipaddress в range.');
  planRequest.semanticPlan.blocks[0].resolvedEntities = ['IS', 'ipRange', 'ACL'];
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } },
    ...planRequest
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'assistant_object_flow_invalid');
  assert.equal(response.json.feedback.causes[0].kind, 'missingOperationField', response.body);
  assert.match(response.json.feedback.summary, /отсутствует «with»/);
  assert.ok(response.json.errors.some((item) => item.path === '$.operations[0].with' && item.code === 'assistant_missing_operation_field'), response.body);
  assert.deepEqual(response.json.rejectedFlow.selections.map((selection) => selection.className), ['IS', 'ipRange']);
  assert.equal(response.json.diagnostics.objectFlow.normalizations.length, 2);
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

test('D2 analysis is allowed read-only while Apply requires an explicitly denied update grant', async (t) => {
  const savedSpec = { version: 1, steps: [], result: { tables: [{ name: 'saved' }] } };
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard('NoUpdateGrant', savedSpec, { canUpdate: false }),
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
  assert.equal(publish.json.reason, 'template_update_forbidden');
  assert.equal(publish.json.publish, undefined);
  assert.equal(publish.json.template, undefined);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('template publish fails closed when the class update permission is denied', async (t) => {
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, {
    templateClassCanUpdate: false,
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
  assert.equal(publish.json.reason, 'template_update_forbidden');
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

test('object-flow apply rejects retained Diagram sources when their class or required fields change', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('diagram-source-schema');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = {
    version: 1,
    visualModels: [{
      mode: 'objectMatching',
      selections: [{
        id: 'selection:assets', name: 'Assets', alias: 'assets', className: 'ARM', from: '', limit: 100,
        columns: ['Code', 'model2'], rules: [{ action: 'include', path: 'Code', negate: false, op: 'exists' }]
      }],
      operations: [],
      outputs: [{ alias: 'assets', label: 'Assets', kind: 'selection', published: true }]
    }],
    result: {
      tables: [{ name: 'assets', columns: ['Code', 'model2'], published: true }],
      diagrams: [{ name: 'network', type: 'd2', source: { nodes: 'assets' }, fields: { nodeId: 'Code', nodeLabel: 'model2' } }]
    }
  };
  const fieldRemoved = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: '', baseSpecHash: '', currentSpec,
    flow: {
      version: 1,
      selections: [{ alias: 'assets', className: 'ARM', columns: ['Code'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
      operations: [], publishedAlias: 'assets'
    }
  }, headers);
  assert.equal(fieldRemoved.statusCode, 422, fieldRemoved.body);
  assert.equal(fieldRemoved.json.code, 'object_flow_diagram_source_stale');
  assert.ok(fieldRemoved.json.errors.some((error) => /required fields: model2/.test(error.message)), fieldRemoved.body);

  const classChanged = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: '', baseSpecHash: '', currentSpec,
    flow: {
      version: 1,
      selections: [{ alias: 'assets', className: 'routerG', columns: ['Code', 'model2'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
      operations: [], publishedAlias: 'assets'
    }
  }, headers);
  assert.equal(classChanged.statusCode, 422, classChanged.body);
  assert.equal(classChanged.json.code, 'object_flow_diagram_source_stale');
  assert.ok(classChanged.json.errors.some((error) => /changes its Object Flow kind or class/.test(error.message)), classChanged.body);
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

test('semantic planning resolves a reference terminal attribute and deterministically returns the source class', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG и сети из Результата 1.',
      algorithm: 'Выбрать ApplicG, у которых Provider email.IP address value входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: []
      }, {
        id: 'applications', name: 'Результат 4', summary: 'Приложения с IP в диапазоне.', resolvedEntities: ['ApplicG', 'IpAddress', 'ipRange'], relationPaths: ['ApplicGIpaddressDomain'], dependencies: ['ranges'], expectedResult: 'Список ApplicG.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [],
          attributePredicates: [{ sourceClass: 'ApplicG', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['Provider email.IP address value'], comparisonField: 'Network range', operator: 'ipv4InCidr' }]
        }, warnings: []
      }],
      explanation: 'Проверен reference путь.', warnings: []
    }, {
      flow: { version: 1, selections: [], operations: [], publishedAlias: '' }, explanation: 'Incomplete flow.', warnings: []
    }]
  });
  const domain = {
    _id: 'ApplicGIpaddressDomain', name: 'ApplicGIpaddressDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'ApplicG', destinations: ['ApplicG'],
    disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N'
  };
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 2, name: 'ApplicG', description: 'Application', parent: 'Class', active: true },
      { _id: 3, name: 'IpAddress', description: 'IP address', parent: 'Class', active: true },
      { _id: 4, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 5, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', description: 'Network range', type: 'string', active: true, _can_read: true }],
      ApplicG: [{ name: 'ipaddress', description: 'Provider email', type: 'reference', targetClass: 'IpAddress', domain: 'ApplicGIpaddressDomain', active: true, _can_read: true }],
      IpAddress: [{ name: 'ipAddr', description: 'IP address value', type: 'ipAddress', active: true, _can_read: true }]
    },
    domains: [domain],
    cardsByClass: {
      ipRange: [{ _id: 101, Code: 'RANGE-001', Description: 'Target range', range: '10.44.0.0/24' }],
      IpAddress: [
        { _id: 201, Code: 'IP-IN', Description: 'In range', ipAddr: '10.44.0.10' },
        { _id: 202, Code: 'IP-OUT', Description: 'Outside range', ipAddr: '10.99.0.10' }
      ],
      ApplicG: [
        { _id: 301, Code: 'APP-IN', Description: 'In range application', ipaddress: 201 },
        { _id: 302, Code: 'APP-OUT', Description: 'Outside application', ipaddress: 202 }
      ]
    },
    relationsByCard: {
      'IpAddress:201': [{ _id: 401, domain: 'ApplicGIpaddressDomain', _sourceType: 'IpAddress', _sourceId: 201, _sourceCode: 'IP-IN', _sourceDescription: 'In range', _destinationType: 'ApplicG', _destinationId: 301, _destinationCode: 'APP-IN', _destinationDescription: 'In range application', _direction: 'direct' }],
      'IpAddress:202': [{ _id: 402, domain: 'ApplicGIpaddressDomain', _sourceType: 'IpAddress', _sourceId: 202, _sourceCode: 'IP-OUT', _sourceDescription: 'Outside range', _destinationType: 'ApplicG', _destinationId: 302, _destinationCode: 'APP-OUT', _destinationDescription: 'Outside application', _direction: 'direct' }]
    },
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 3 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-reference-path-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };

  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent
  }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  const predicate = semantic.json.semanticPlan.blocks[1].resultContract.referencePathPredicates[0];
  assert.deepEqual(predicate, {
    sourceClass: 'ApplicG', comparisonBlockId: 'ranges', comparisonClass: 'ipRange',
    hops: [{ sourceClass: 'ApplicG', attribute: 'ipaddress', domain: 'ApplicGIpaddressDomain', direction: 'destination', targetClass: 'IpAddress' }],
    terminalClass: 'IpAddress', terminalField: 'ipAddr', comparisonField: 'range', operator: 'ipv4InCidr'
  });
  assert.equal(semantic.json.semanticPlan.blocks[1].resultContract.attributePredicates.length, 0);

  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan
  }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json.success, true, draft.body);
  assert.equal(draft.json.flow.publishedAlias, 'applications');
  assert.ok(draft.json.flow.selections.some((selection) => selection.className === 'IpAddress' && selection.rules.some((rule) => rule.path === 'ipAddr' && rule.op === 'ipv4InCidr' && rule.valueColumn === 'range')));
  assert.ok(draft.json.flow.operations.some((operation) => operation.type === 'relation' && operation.domain === 'ApplicGIpaddressDomain' && operation.targetClass === 'ApplicG' && operation.direction === 'source'));

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/preview`, {
    templateCode: '', currentSpec, flow: draft.json.flow, params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const finalStage = preview.json.preview.stages.find((stage) => stage.as === draft.json.flow.publishedAlias);
  assert.ok(finalStage, preview.body);
  assert.deepEqual(finalStage.rows.map((row) => row.Code), ['APP-IN']);
  assert.equal(backend.exitCode, null);
});

test('reference-path repair restores phServer without rebuilding unrelated Assistant blocks', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG.', algorithm: 'Выбрать ApplicG, у которых ipaddress.ipAddr входит в range Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }, {
      id: 'servers', name: 'Результат 5', entities: 'Карточки phServer.', algorithm: 'Выбрать phServer, у которых ipaddress.ipAddr входит в range Результата 1.', expectedResult: 'Список phServer.', uses: ['ranges']
    }, {
      id: 'other', name: 'Смежный результат', entities: 'Карточки Other.', algorithm: 'Выбрать Other с учетом Результата 1.', expectedResult: 'Список Other.', uses: ['ranges']
    }]
  };
  const referencePredicate = (sourceClass, comparisonBlockId = 'ranges') => ({
    sourceClass,
    comparisonBlockId,
    comparisonClass: 'ipRange',
    sourcePath: ['ipaddress', 'ipAddr'],
    comparisonField: 'range',
    operator: 'ipv4InCidr'
  });
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [
        { id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: [] },
        { id: 'applications', name: 'Результат 4', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'IpAddress', 'ipRange'], relationPaths: ['ApplicGIpaddressDomain'], dependencies: ['ranges'], expectedResult: 'Список ApplicG.', resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [], attributePredicates: [], referencePathPredicates: [referencePredicate('ApplicG')] }, warnings: [] },
        { id: 'servers', name: 'Результат 5', summary: 'Физические серверы.', resolvedEntities: ['phServer', 'IpAddress', 'ipRange'], relationPaths: ['ip_addressph'], dependencies: ['ranges'], expectedResult: 'Список phServer.', resultContract: { outputKind: 'sourceCards', outputClass: 'phServer', relationPredicates: [], attributePredicates: [], referencePathPredicates: [referencePredicate('phServer')] }, warnings: [] },
        { id: 'other', name: 'Смежный результат', summary: 'Независимый сложный блок.', resolvedEntities: ['Other'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список Other.', resultContract: { outputKind: 'sourceCards', outputClass: 'Other', relationPredicates: [], attributePredicates: [] }, warnings: [] }
      ],
      explanation: 'Reference paths confirmed.', warnings: []
    }, {
      flow: {
        version: 1,
        selections: [
          { alias: 'ranges', className: 'ipRange', columns: ['Code', 'range'], rules: [{ path: 'Code', op: 'matches', regex: '.*' }] },
          { alias: 'applicationIps', className: 'IpAddress', from: 'ranges', columns: ['Code', 'ipAddr'], rules: [{ path: 'ipAddr', op: 'ipv4InCidr', valueColumn: 'range' }] },
          { alias: 'phServers', className: 'phServer', from: 'ranges', columns: ['Code', 'Description', 'ipaddress'], rules: [{ path: 'Code', op: 'matches', regex: '.*' }] },
          { alias: 'other', className: 'Other', columns: ['Code'], rules: [{ path: 'Code', op: 'matches', regex: '.*' }] }
        ],
        operations: [{ type: 'relation', from: 'applicationIps', as: 'applications', domain: 'ApplicGIpaddressDomain', targetClass: 'ApplicG', direction: 'source', columns: ['Code', 'Description'] }],
        publishedAlias: 'other'
      },
      explanation: 'phServer relation is missing.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 2, name: 'ApplicG', description: 'Application', parent: 'Class', active: true },
      { _id: 3, name: 'phServer', description: 'Physical server', parent: 'Class', active: true },
      { _id: 4, name: 'IpAddress', description: 'IP address', parent: 'Class', active: true },
      { _id: 5, name: 'Other', description: 'Other', parent: 'Class', active: true },
      { _id: 6, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 7, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ApplicG: [{ name: 'ipaddress', type: 'reference', targetClass: 'IpAddress', domain: 'ApplicGIpaddressDomain', active: true, _can_read: true }],
      phServer: [{ name: 'ipaddress', type: 'reference', targetClass: 'IpAddress', domain: 'ip_addressph', active: true, _can_read: true }],
      IpAddress: [{ name: 'ipAddr', type: 'ipAddress', active: true, _can_read: true }],
      Other: []
    },
    domains: [
      { _id: 'ApplicGIpaddressDomain', name: 'ApplicGIpaddressDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'ip_addressph', name: 'ip_addressph', source: 'IpAddress', sources: ['IpAddress'], destination: 'phServer', destinations: ['phServer'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' }
    ],
    cardsByClass: {
      ipRange: [{ _id: 101, Code: 'RANGE-001', range: '10.44.0.0/24' }],
      IpAddress: [{ _id: 201, Code: 'IP-IN', ipAddr: '10.44.0.10' }, { _id: 202, Code: 'IP-OUT', ipAddr: '10.99.0.10' }],
      ApplicG: [{ _id: 301, Code: 'APP-IN', ipaddress: 201 }],
      phServer: [{ _id: 401, Code: 'PHS-IN', ipaddress: 201 }, { _id: 402, Code: 'PHS-OUT', ipaddress: 202 }],
      Other: [{ _id: 501, Code: 'OTHER-001' }]
    },
    relationsByCard: {
      'IpAddress:201': [
        { _id: 601, domain: 'ApplicGIpaddressDomain', _sourceType: 'IpAddress', _sourceId: 201, _sourceCode: 'IP-IN', _destinationType: 'ApplicG', _destinationId: 301, _destinationCode: 'APP-IN', _direction: 'direct' },
        { _id: 602, domain: 'ip_addressph', _sourceType: 'IpAddress', _sourceId: 201, _sourceCode: 'IP-IN', _destinationType: 'phServer', _destinationId: 401, _destinationCode: 'PHS-IN', _direction: 'direct' }
      ],
      'IpAddress:202': [{ _id: 603, domain: 'ip_addressph', _sourceType: 'IpAddress', _sourceId: 202, _sourceCode: 'IP-OUT', _destinationType: 'phServer', _destinationId: 402, _destinationCode: 'PHS-OUT', _direction: 'direct' }]
    },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 3 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-reference-repair-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };
  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, { templateCode: '', baseSpecHash: '', currentSpec, intent }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, { templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json.success, true, draft.body);
  assert.equal(draft.json.diagnostics.objectFlow.fallback.kind, 'semanticReferencePathRepair');
  assert.deepEqual(draft.json.diagnostics.objectFlow.fallback.blockIds, ['servers']);
  assert.ok(draft.json.warnings.some((warning) => /rebuilt the confirmed reference path for Результат 5/i.test(warning)), draft.body);
  assert.ok(draft.json.flow.operations.some((operation) => operation.as === 'phServers' && operation.domain === 'ip_addressph' && operation.targetClass === 'phServer' && operation.direction === 'source'));

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/preview`, { templateCode: '', currentSpec, flow: draft.json.flow, params: {} }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const repairedStage = preview.json.preview.stages.find((stage) => stage.as === 'phServers');
  assert.ok(repairedStage, preview.body);
  assert.deepEqual(repairedStage.rows.map((row) => row.Code), ['PHS-IN']);
  assert.equal(backend.exitCode, null);
});

test('semantic planning rejects a reference path that exceeds the configured depth with actionable feedback', async (t) => {
  const intent = {
    context: '',
    blocks: [{ id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: [] }, {
      id: 'applications', name: 'Результат 2', entities: 'Карточки ApplicG.', algorithm: 'Выбрать ApplicG по provider.address.ipAddr и range из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: []
      }, {
        id: 'applications', name: 'Результат 2', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'Provider', 'IpAddress', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ApplicG.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [], attributePredicates: [{ sourceClass: 'ApplicG', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['provider.address.ipAddr'], comparisonField: 'range', operator: 'ipv4InCidr' }] }, warnings: []
      }], explanation: 'Путь глубже лимита.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 2, name: 'ApplicG', description: 'Application', parent: 'Class', active: true },
      { _id: 3, name: 'Provider', description: 'Provider', parent: 'Class', active: true },
      { _id: 4, name: 'IpAddress', description: 'IP address', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ApplicG: [{ name: 'provider', type: 'reference', targetClass: 'Provider', domain: 'ApplicGProviderDomain', active: true, _can_read: true }],
      Provider: [{ name: 'address', type: 'reference', targetClass: 'IpAddress', domain: 'ProviderAddressDomain', active: true, _can_read: true }],
      IpAddress: [{ name: 'ipAddr', type: 'ipAddress', active: true, _can_read: true }]
    },
    domains: [
      { _id: 'ApplicGProviderDomain', name: 'ApplicGProviderDomain', source: 'Provider', sources: ['Provider'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'ProviderAddressDomain', name: 'ProviderAddressDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'Provider', destinations: ['Provider'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' }
    ],
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 1 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=semantic-reference-depth-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.errors[0].kind, 'semanticPlanReferencePathUnresolved');
  assert.match(response.json.errors[0].reason, /maxReferencePathDepth=1/);
  assert.match(response.json.feedback.action, /Глубина reference-пути/);
  assert.equal(backend.exitCode, null);
});

test('semantic planning compiles a confirmed multi-hop reference path back to the source class', async (t) => {
  const intent = {
    context: '',
    blocks: [{ id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: [] }, {
      id: 'applications', name: 'Результат 2', entities: 'Карточки ApplicG.', algorithm: 'Выбрать ApplicG по provider.address.ipAddr и range из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{ id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: [] }, {
        id: 'applications', name: 'Результат 2', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'Provider', 'IpAddress', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ApplicG.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [], attributePredicates: [{ sourceClass: 'ApplicG', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['provider.address.ipAddr'], comparisonField: 'range', operator: 'ipv4InCidr' }] }, warnings: []
      }], explanation: 'Два reference-перехода.', warnings: []
    }, { flow: { version: 1, selections: [], operations: [], publishedAlias: '' }, explanation: 'Incomplete flow.', warnings: [] }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true }, { _id: 2, name: 'ApplicG', description: 'Application', parent: 'Class', active: true },
      { _id: 3, name: 'Provider', description: 'Provider', parent: 'Class', active: true }, { _id: 4, name: 'IpAddress', description: 'IP address', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true }, { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }],
      ApplicG: [{ name: 'provider', type: 'reference', targetClass: 'Provider', domain: 'ApplicGProviderDomain', active: true, _can_read: true }],
      Provider: [{ name: 'address', type: 'reference', targetClass: 'IpAddress', domain: 'ProviderAddressDomain', active: true, _can_read: true }],
      IpAddress: [{ name: 'ipAddr', type: 'ipAddress', active: true, _can_read: true }]
    },
    domains: [
      { _id: 'ApplicGProviderDomain', name: 'ApplicGProviderDomain', source: 'Provider', sources: ['Provider'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'ProviderAddressDomain', name: 'ProviderAddressDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'Provider', destinations: ['Provider'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' }
    ],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 2 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-reference-multihop-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };
  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, { templateCode: '', baseSpecHash: '', currentSpec, intent }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  const predicate = semantic.json.semanticPlan.blocks[1].resultContract.referencePathPredicates[0];
  assert.deepEqual(predicate.hops.map((hop) => [hop.sourceClass, hop.attribute, hop.targetClass, hop.direction]), [
    ['ApplicG', 'provider', 'Provider', 'destination'], ['Provider', 'address', 'IpAddress', 'destination']
  ]);
  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, { templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json.success, true, draft.body);
  assert.deepEqual(draft.json.flow.operations.filter((operation) => operation.type === 'relation').map((operation) => [operation.domain, operation.direction, operation.targetClass]), [
    ['ProviderAddressDomain', 'source', 'Provider'], ['ApplicGProviderDomain', 'source', 'ApplicG']
  ]);
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
  const classFixtures = Array.isArray(options.classes) ? options.classes : [
    { _id: 1, name: 'routerG', description: 'Маршрутизатор', active: true },
    { _id: 2, name: 'ARM', description: 'АРМ', active: true },
    { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
    { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
  ];
  const attributesByClass = options.attributesByClass || {};
  const domains = Array.isArray(options.domains) ? options.domains : [];
  const cardsByClass = options.cardsByClass || {};
  const relationsByCard = options.relationsByCard || {};
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({
      method: req.method || '',
      pathname: requestUrl.pathname,
      search: requestUrl.search
    });
    const delayMs = Number(
      typeof options.delayByPath === 'function'
        ? options.delayByPath(requestUrl, req)
        : options.delayByPath && options.delayByPath[requestUrl.pathname]
    );
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

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
        data: classFixtures
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
      const fixtures = Object.assign({
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
      }, attributesByClass);
      sendJson(res, 200, { data: fixtures[className] || [] });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/domains') {
      sendJson(res, 200, { data: domains });
      return;
    }
    const domainMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/domains\/([^/]+)$/);
    if (domainMatch) {
      const name = decodeURIComponent(domainMatch[1]);
      const domain = domains.find((item) => item && item.name === name);
      if (domain) sendJson(res, 200, { data: domain });
      else sendJson(res, 404, { message: `Domain not found: ${name}` });
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
        let patch = {};
        try {
          patch = await readRequestJson(req);
        } catch {
          sendJson(res, 400, { message: 'Invalid request JSON.' });
          return;
        }
        templateCards[index] = { ...templateCards[index], ...patch };
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

    const relationsMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)\/cards\/([^/]+)\/relations$/);
    if (relationsMatch) {
      const key = `${decodeURIComponent(relationsMatch[1])}:${decodeURIComponent(relationsMatch[2])}`;
      sendJson(res, 200, { data: relationsByCard[key] || [] });
      return;
    }
    const classCardMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)\/cards\/([^/]+)$/);
    if (classCardMatch) {
      const className = decodeURIComponent(classCardMatch[1]);
      const id = decodeURIComponent(classCardMatch[2]);
      const card = (cardsByClass[className] || []).find((item) => String(item && item._id) === id);
      if (card) sendJson(res, 200, { data: card });
      else sendJson(res, 404, { message: `Card not found: ${className}/${id}` });
      return;
    }
    const genericCardsMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)\/cards$/);
    if (genericCardsMatch) {
      const className = decodeURIComponent(genericCardsMatch[1]);
      if (cardsByClass[className]) {
        sendJson(res, 200, { data: paginate(requestUrl, cardsByClass[className]) });
        return;
      }
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
  let lastRequest = null;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      sendJson(res, 404, { message: 'Unknown LiteLLM route.' });
      return;
    }
    requests += 1;
    lastRequest = await readRequestJson(req);
    const delayMs = Array.isArray(proposal.delays)
      ? Number(proposal.delays[Math.min(requests - 1, proposal.delays.length - 1)])
      : Number(proposal.delayMs);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const response = Array.isArray(proposal.responses)
      ? proposal.responses[Math.min(requests - 1, proposal.responses.length - 1)]
      : { flow: proposal.flow, explanation: 'Validated test proposal.', warnings: [] };
    sendJson(res, 200, {
      choices: [{ message: { content: JSON.stringify(response) } }]
    });
  });
  await listen(server, 0);
  t.after(() => closeServer(server));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}/v1`,
    get requests() { return requests; },
    get lastRequest() { return lastRequest; }
  };
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

function testCmdbuildAuthorizationCookie(fixture) {
  return ['CMDBuild', 'Authorization'].join('-') + '=' + fixture;
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

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
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
