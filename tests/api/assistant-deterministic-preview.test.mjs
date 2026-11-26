import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import { compileObjectFlowToSpec, objectFlowStageSummaries } from '../../scripts/assistant-object-flow.mjs';
import {
  diagramImportMappingInputRevisionStatus,
  diagramImportMappingValidationIsCurrent,
  draftDiagramPreviewMappingPlan
} from '../../scripts/dev-proxy-server.mjs';

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

function semanticPlanForIntent(intent, options = {}) {
  const outputClass = String(options.outputClass || 'ARM');
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
      resultContract: { outputKind: 'sourceCards', outputClass, relationPredicates: [] },
      warnings: []
    })),
    explanation: 'Semantic plan confirmed.',
    warnings: []
  };
}

function objectFlowPlanRequest(algorithm, options = {}) {
  const intent = objectFlowIntentFromText(algorithm, options);
  return { intent, semanticPlan: semanticPlanForIntent(intent, options) };
}

function d2RoleOverride(role, mapping = role.mapping, model = {}) {
  return {
    id: role.id,
    visualKind: model.visualKind ?? role.visualKind,
    labelTemplate: model.labelTemplate ?? role.labelTemplate,
    mapping
  };
}

function d2StructureTreeWithMaterialization(proposal, roles) {
  const tree = structuredClone(proposal && proposal.structureTree || { version: 5, items: [] });
  const mappingsByRoleId = new Map((Array.isArray(roles) ? roles : []).map((role) => [
    String(role && role.id || ''),
    role && role.mapping && typeof role.mapping === 'object' ? role.mapping : null
  ]));
  tree.version = 5;
  tree.items = (Array.isArray(tree.items) ? tree.items : []).map((item) => {
    const mapping = mappingsByRoleId.get(String(item && item.roleId || ''));
    if (!mapping) return item;
    return {
      ...item,
      mapping: {
        ...structuredClone(mapping),
        id: `mapping:${item.id}`,
        roleId: String(item.roleId || '')
      }
    };
  });
  return tree;
}

function d2StaticPlacementMapping(itemId, roleId) {
  return {
    id: `mapping-${itemId}`,
    roleId,
    materialization: { kind: 'structural', stageId: '' },
    primary: { className: '', idAttribute: '_id', labelTemplate: '${Description}', structuredFields: [], filters: [] },
    conditions: { ruleJoin: 'any', rules: [] },
    related: []
  };
}

async function requestD2MappingStages(backendOrigin, headers, body, timeoutMs = 5000) {
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;
  const resumeId = crypto.randomUUID();
  const roles = await requestJson('POST', endpoint, {
    ...body,
    stage: 'roles',
    resumeId
  }, headers, timeoutMs);
  if (roles.statusCode !== 202) return roles;

  assert.equal(roles.json?.checkpoint?.resumeId, resumeId, roles.body);
  assert.equal(roles.json?.checkpoint?.nextStage, 'topology', roles.body);
  return requestJson('POST', endpoint, {
    ...body,
    stage: 'topology',
    resumeId
  }, headers, timeoutMs);
}

function d2PlacementMappings(payload, stageId, reason = 'Mapped to the corresponding deterministic result.') {
  return (Array.isArray(payload.placements) ? payload.placements : []).map((placement) => {
    const allowed = Array.isArray(placement && placement.allowedMaterialization)
      ? placement.allowedMaterialization.map(String)
      : [];
    return {
      structureItemId: placement.structureItemId,
      materialization: allowed.includes('stage') ? 'stage' : 'structural',
      stageId: allowed.includes('stage') ? stageId : '',
      reason
    };
  });
}

function d2AssistantPayloadStages(payload) {
  return Array.isArray(payload && payload.models && payload.models.dataSemanticModel && payload.models.dataSemanticModel.stages)
    ? payload.models.dataSemanticModel.stages
    : [];
}

test('LiteLLM request payload returns 413 before provider fetch when maxRequestBytes is exceeded', async (t) => {
  const maxRequestBytes = 64 * 1024;
  const llm = await startLiteLlmStub(t, {
    flow: { version: 1, selections: [], operations: [], publishedAlias: '' }
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model', maxRequestBytes } }
      })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    LITELLM_API_KEY: 'unit-test-key',
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=assistant-request-bytes-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const currentSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };
  const intent = {
    context: '',
    blocks: Array.from({ length: 12 }, (_, index) => ({
      id: `arm-${index + 1}`,
      name: `ARM result ${index + 1}`,
      entities: 'ARM cards.',
      algorithm: `Select ARM cards for bounded request ${index + 1}. ${'x'.repeat(5900)}`,
      expectedResult: 'ARM cards.',
      uses: []
    }))
  };
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '',
    baseSpecHash: '',
    currentSpec,
    intent
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 413, response.body);
  assert.equal(response.json.success, false);
  assert.equal(response.json.action, 'assistant-object-flow-semantic-plan');
  assert.equal(response.json.code, 'assistant_request_too_large');
  assert.equal(response.json.errors.length, 1, response.body);
  assert.equal(response.json.errors[0].configuredLimit, maxRequestBytes);
  assert.ok(response.json.errors[0].bytes > maxRequestBytes, response.body);
  assert.equal(llm.requests, 0, 'provider fetch must not start for an oversized serialized request');

  const missingTemplateRef = await request('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    currentSpec,
    intent
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });
  const missingTemplateRefJson = JSON.parse(missingTemplateRef.body);
  assert.equal(missingTemplateRef.statusCode, 400, missingTemplateRef.body);
  assert.equal(missingTemplateRefJson.code, 'assistant_template_ref_required');
  assert.equal(llm.requests, 0, 'legacy top-level template fields must not reach the provider');
  assert.equal(backend.exitCode, null);
});

test('LiteLLM bounded streaming response returns 502 when maxResponseBytes is exceeded', async (t) => {
  const maxResponseBytes = 64 * 1024;
  const streamChunkBytes = 4 * 1024;
  const initialSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };
  const templateCode = 'AssistantResponseBytes';
  const llm = await startLiteLlmStub(t, {
    streamResponse: {
      contentBytes: 512 * 1024,
      chunkBytes: streamChunkBytes,
      delayMs: 2
    }
  });
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard(templateCode, initialSpec)],
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model', maxResponseBytes } }
      })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    LITELLM_API_KEY: 'unit-test-key',
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=assistant-response-bytes-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode,
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    ...objectFlowPlanRequest('Select ARM cards.', { outputClass: 'ARM' })
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(response.statusCode, 502, response.body);
  assert.equal(response.json.success, false);
  assert.equal(response.json.action, 'assistant-object-flow-plan');
  assert.equal(response.json.code, 'litellm_response_too_large');
  assert.equal(response.json.errors.length, 1, response.body);
  assert.equal(response.json.errors[0].configuredLimit, maxResponseBytes);
  assert.ok(response.json.errors[0].bytes > maxResponseBytes, response.body);
  assert.ok(response.json.errors[0].bytes <= maxResponseBytes + streamChunkBytes * 2, response.body);
  assert.equal(llm.requests, 1);
  await waitFor(() => llm.streamClosedEarly, 2000, () => JSON.stringify({
    streamBytesWritten: llm.streamBytesWritten,
    streamBytesPlanned: llm.streamBytesPlanned
  }));
  assert.ok(llm.streamBytesWritten < llm.streamBytesPlanned, 'backend must cancel the provider stream after reaching the response limit');
  assert.equal(backend.exitCode, null);
});

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
        filters: [{ path: 'Description', op: 'equals', valueExpression: '${param.routerDescription}' }],
        columns: ['Code', 'Description', 'Location'],
        limit: 1
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'ARM',
        filters: [{ path: 'Location', op: 'equals', valueExpression: '${previous.Location}' }],
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
    params: { routerDescription: 'Маршрутизатор для Test City 300' }
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
  assert.equal(requestedAttributes, '');
  assert.equal(mock.requests.some((item) => item.pathname.includes('/relations')), false);
  assert.equal(backend.exitCode, null);
});

test('draft preview resolves right-expression parameters and previous rows as escaped regex literals', async (t) => {
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'TestItem', description: 'Test item', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { TestItem: [{ name: 'Code', type: 'string', active: true, _can_read: true }] },
    cardsByClass: {
      TestItem: [
        { _id: 1, Code: 'literal.1', Description: 'source' },
        { _id: 2, Code: 'literalX1', Description: 'regex decoy' },
        { _id: 3, Code: 'literal.1-child', Description: 'child' },
        { _id: 4, Code: 'literalX1-child', Description: 'child decoy' }
      ]
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=right-expression-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const spec = {
    version: 1,
    steps: [{
      type: 'selectCards', as: 'source', className: 'TestItem',
      filters: [{ path: 'Code', op: 'matches', regexExpression: '^${param.literalCode}$' }],
      columns: ['Code'], limit: 20
    }, {
      type: 'selectCards', as: 'children', from: 'source', className: 'TestItem',
      filters: [{ path: 'Code', op: 'matches', regexExpression: '^${previous.Code}-child$' }],
      columns: ['Code'], limit: 20
    }],
    result: { tables: [{ name: 'children', columns: ['Code'] }] }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'RightExpressionPreview', spec },
    params: { literalCode: 'literal.1' }
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.trace.map((item) => [item.as, item.rows]), [['source', 1], ['children', 1]]);
  const children = preview.json.result.tables.find((item) => item.name === 'children');
  assert.deepEqual(children.rows.map((row) => row.Code), ['literal.1-child']);
  assert.equal(backend.exitCode, null);
});

test('draft preview returns a bounded 504 with the caller Request ID when CMDBuild exceeds its deadline', async (t) => {
  const mock = await startMockCmdbuild(t, {
    delayByPath: {
      '/cmdbuild/services/rest/v3/classes/ARM/cards': 1600
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    CMDP_DRAFT_PREVIEW_TIMEOUT_MS: '1000',
    CMDBUILD_REQUEST_TIMEOUT_MS: '5000'
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('draft-preview-timeout');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const requestId = 'draft-preview-timeout-regression';
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=100&includeDiagrams=false`, {
    template: {
      code: 'DraftPreviewTimeout',
      spec: {
        version: 1,
        params: {},
        steps: [{ type: 'selectCards', as: 'arms', className: 'ARM', columns: ['Code'], limit: 100 }],
        result: { tables: [{ name: 'arms', columns: ['Code'] }] }
      }
    },
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token,
    'x-request-id': requestId
  }, 5000);

  assert.equal(preview.statusCode, 504, preview.body);
  assert.equal(preview.headers['x-request-id'], requestId);
  assert.equal(preview.json.success, false, preview.body);
  assert.match(preview.json.message, /Draft preview timed out after 1000ms\./);
  assert.ok(Array.isArray(preview.json.result?.trace), preview.body);
  assert.equal(preview.json.result.trace.at(-1)?.status, 'error', preview.body);
  assert.equal(backend.exitCode, null);
});

test('Object-flow preview endpoint is removed; deterministic execution uses draft preview', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=assistant-preview-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/preview`, {
    templateCode: 'AssistantObjectFlowPreview',
    params: {}
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });

  assert.equal(preview.statusCode, 404, preview.body);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), false);
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
  const initialSpec = { version: 1, steps: [], result: { tables: [] } };
  const templateCode = 'ObjectFlowApply';
  const mock = await startMockCmdbuild(t, { templates: [templateCard(templateCode, initialSpec)] });
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
    templateCode,
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
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
    [['routers', undefined], ['arms', undefined], ['coLocated', undefined]]
  );
  assert.equal(applied.json.template, undefined);
  assert.equal(applied.json.versionLog, undefined);
  assert.equal(applied.json.cacheInvalidation, undefined);
  assert.equal(mock.requests.some((item) => item.method === 'PUT' && item.pathname.includes('/classes/Cst_QueryTemplate/cards/')), false);
  assert.equal(mock.requests.some((item) => item.pathname.includes('/classes/Cst_QueryTemplateVersion/cards')), false);

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
  const initialSpec = { version: 1, steps: [], result: { tables: [] } };
  const templateCode = 'AssistantOutputLabels';
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
      publishedAlias: 'arms'
    }
  });
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard(templateCode, initialSpec)],
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
  const planRequest = objectFlowPlanRequest('маршрутизатор с описанием Маршрутизатор для Test City 300. АРМ в том же Location.', { outputClass: 'ARM' });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode,
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    ...planRequest
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
  assert.equal(response.json.flow.publishedAlias, 'arms');
  assert.deepEqual(response.json.outputBindings, [{ blockId: 'block-1', alias: 'arms' }]);
  assert.deepEqual(response.json.diagnostics.objectFlow.outputBindingErrors, []);
  const rejectedApply = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode,
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    flow: response.json.flow,
    assistantObjectFlowIntent: planRequest.intent,
    assistantOutputBindings: []
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });
  assert.equal(rejectedApply.statusCode, 422, rejectedApply.body);
  assert.equal(rejectedApply.json.code, 'assistant_output_bindings_invalid');
  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode,
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    flow: response.json.flow,
    assistantObjectFlowIntent: planRequest.intent,
    assistantOutputBindings: response.json.outputBindings
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });
  assert.equal(applied.statusCode, 200, applied.body);
  const appliedSpec = applied.json.spec;
  const outputManifest = appliedSpec.visualModels.find((model) => model.mode === 'objectMatching').outputs;
  const ownershipManifest = appliedSpec.visualModels.find((model) => model.mode === 'objectMatching').assistantOutputManifest;
  assert.deepEqual(ownershipManifest, {
    version: 1,
    blocks: [{ id: 'block-1', name: 'Result', order: 1 }]
  });
  assert.deepEqual(outputManifest.map((output) => [output.alias, output.label, output.assistantBlockId, output.assistantBlockIds]), [
    ['routers', 'Result: Выборка 1', 'block-1', ['block-1']],
    ['arms', 'Result', 'block-1', ['block-1']],
    ['matchedObjects', 'Result: Сопоставление 1', 'block-1', ['block-1']],
    ['allAssets', 'Result: Операция множеств 1', 'block-1', ['block-1']]
  ]);
  assert.equal(appliedSpec.result.tables.find((table) => table.name === 'routers').title, 'Result: Выборка 1');
  assert.equal(appliedSpec.result.tables.find((table) => table.name === 'arms').title, 'Result');
  assert.equal(appliedSpec.result.tables.find((table) => table.name === 'allAssets').title, 'Result: Операция множеств 1');
  assert.equal(appliedSpec.result.tables.find((table) => table.name === 'matchedObjects').title, 'Result: Сопоставление 1');
  const reloaded = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/templates?root=Cst_QueryTool`, undefined, { cookie });
  assert.equal(reloaded.statusCode, 200, reloaded.body);
  const reloadedSpec = reloaded.json.data.find((template) => template.code === templateCode)?.spec;
  assert.ok(reloadedSpec, reloaded.body);
  assert.deepEqual(reloadedSpec, initialSpec);
  assert.equal(mock.requests.some((item) => item.method === 'PUT' && item.pathname.includes('/classes/Cst_QueryTemplate/cards/')), false);
  const duplicateNameIntent = {
    context: '',
    blocks: [
      ...planRequest.intent.blocks,
      {
        ...planRequest.intent.blocks[0],
        id: 'block-2',
        name: ' result ',
        uses: []
      }
    ]
  };
  const duplicateName = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode,
    baseSpecHash: hashJson(initialSpec),
    currentSpec: appliedSpec,
    intent: duplicateNameIntent
  }, {
    cookie,
    origin: backendOrigin,
    'x-cmdbdynamicpages-csrf': csrf.json.token
  });
  assert.equal(duplicateName.statusCode, 400, duplicateName.body);
  assert.equal(duplicateName.json.code, 'assistant_object_flow_intent_invalid');
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('template read recovers incomplete Assistant labels without LiteLLM when LLM is disabled', async (t) => {
  const templateCode = 'RecoveredAssistantLabels';
  const alias = 'legacyArmsInternal';
  const label = 'АРМ в Test City 300';
  const legacySpec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1,
    selections: [{
      id: 'selection:arms', name: label, alias, className: 'ARM', from: '', limit: 100,
      columns: ['Code', 'Description'],
      rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
    }],
    operations: [],
    blocks: [],
    setOperations: [],
    publishedAlias: alias
  });
  legacySpec.authoring = {
    version: 1,
    assistant: { objectFlowIntent: objectFlowIntentFromText('Выбрать АРМ.', { name: label, entities: 'ARM' }) },
    d2: { source: '' }
  };
  const legacyModel = legacySpec.visualModels.find((model) => model.mode === 'objectMatching');
  legacyModel.outputs = legacyModel.outputs.map((output) => ({
    ...output,
    label: output.alias,
    assistantManaged: true,
    assistantBlockId: 'block-1'
  }));
  delete legacyModel.assistantOutputManifest;
  legacySpec.result.tables.find((table) => table.name === alias).title = 'Legacy table title';
  legacySpec.result.presentation = { tables: [{ name: alias, title: 'Опубликованные АРМ' }] };

  const invalidTemplateCode = 'InvalidStoredObjectFlow';
  const invalidSpec = structuredClone(legacySpec);
  const invalidModel = invalidSpec.visualModels.find((model) => model.mode === 'objectMatching');
  invalidModel.operations = [{
    id: 'match:unresolved', type: 'match', from: 'missing_alias', with: alias, as: 'unresolved', rightPrefix: 'Right.',
    rules: [{ action: 'include', operator: 'equals', leftColumn: 'Code', rightColumn: 'Code' }]
  }];
  invalidModel.blocks = invalidModel.operations.map((operation) => ({ ...operation }));
  invalidModel.outputs.push({ alias: 'unresolved', label: 'Неразрешенный результат', kind: 'match', assistantManaged: true, assistantBlockId: 'block-1' });
  invalidModel.output = { alias: 'unresolved', title: 'Неразрешенный результат' };
  invalidSpec.result.tables.push({ name: 'unresolved', title: 'Неразрешенный результат', columns: [] });

  const llm = await startLiteLlmStub(t, { flow: { version: 1, selections: [], operations: [] } });
  const mock = await startMockCmdbuild(t, {
    templates: [
      templateCard(templateCode, legacySpec, { canUpdate: true }),
      templateCard(invalidTemplateCode, invalidSpec, { canUpdate: true })
    ],
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: false, baseUrl: llm.origin, model: 'unit-test-model' } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    LITELLM_API_KEY: '',
    LITELLM_API_KEY_FILE: '/tmp/cmdbcustompages-missing-litellm-key',
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=recovered-labels-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const read = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/templates?root=Cst_QueryTool`, undefined, { cookie });
  assert.equal(read.statusCode, 200, read.body);
  const recovered = read.json.data.find((template) => template.code === templateCode);
  assert.equal(recovered.objectFlowRecovery.requiresSave, true);
  assert.equal(recovered.objectFlowRecovery.ownership, 'downgraded');
  const recoveredModel = recovered.spec.visualModels.find((model) => model.mode === 'objectMatching');
  assert.deepEqual(recoveredModel.outputs.map((output) => [output.alias, output.label]), [[alias, label]]);
  assert.equal(recoveredModel.outputs.some((output) => output.label === output.alias), false);
  assert.equal(recoveredModel.outputs.some((output) => output.assistantManaged === true), false);
  assert.equal(recoveredModel.assistantOutputManifest, undefined);
  assert.equal(recovered.spec.result.tables.find((table) => table.name === alias).title, 'Legacy table title');
  assert.equal(recovered.spec.result.presentation.tables[0].title, 'Опубликованные АРМ');
  assert.equal(llm.requests, 0);

  const invalidStored = read.json.data.find((template) => template.code === invalidTemplateCode);
  assert.equal(invalidStored.objectFlowRecovery.status, 'skipped_invalid_flow');
  assert.equal(invalidStored.objectFlowRecovery.requiresSave, false);
  assert.equal(invalidStored.objectFlowRecovery.executionReadyAfterSave, false);
  const invalidStoredModel = invalidStored.spec.visualModels.find((model) => model.mode === 'objectMatching');
  assert.ok(invalidStoredModel.operations.some((operation) => operation.as === 'unresolved'));
  assert.ok(invalidStoredModel.outputs.some((output) => output.alias === 'unresolved'));

  const saved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}`, {
    code: templateCode,
    expectedSpecHash: recovered.specHash,
    spec: recovered.spec
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  const savedModel = saved.json.template.spec.visualModels.find((model) => model.mode === 'objectMatching');
  assert.deepEqual(savedModel.outputs.map((output) => [output.alias, output.label]), [[alias, label]]);
  assert.equal(savedModel.assistantOutputManifest, undefined);
  assert.equal(saved.json.template.spec.result.tables.find((table) => table.name === alias).title, 'Legacy table title');
  assert.equal(saved.json.template.spec.result.presentation.tables[0].title, 'Опубликованные АРМ');

  const reread = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/templates?root=Cst_QueryTool`, undefined, { cookie });
  const persisted = reread.json.data.find((template) => template.code === templateCode);
  assert.equal(persisted.objectFlowRecovery, undefined);
  assert.equal(llm.requests, 0);
  assert.equal(backend.exitCode, null);
});

test('Object Flow uses a template prompt override from currentSpec and falls back after reset', async (t) => {
  const globalPrompt = 'GLOBAL OBJECT FLOW SEMANTIC PROMPT';
  const templatePrompt = 'TEMPLATE OBJECT FLOW SEMANTIC PROMPT';
  const intent = objectFlowIntentFromText('Выбрать все карточки АРМ.', {
    name: 'Workstations',
    entities: 'ARM',
    expectedResult: 'Список АРМ.'
  });
  const semanticPlan = semanticPlanForIntent(intent, { outputClass: 'ARM' });
  const llm = await startLiteLlmStub(t, {
    responses: [semanticPlan, semanticPlan]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ARM', description: 'Workstation', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', parent: 'Class', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', parent: 'Class', active: true }
    ],
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: {
          llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
          prompt: { objectFlowSemantic: globalPrompt }
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
  const cookie = testCmdbuildAuthorizationCookie('template-prompt-override-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const baseSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };
  const specWithOverride = {
    ...baseSpec,
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: { context: '', blocks: [] },
        diagramInterpretPrompt: '',
        diagramMappingPrompt: '',
        systemPromptOverrides: { objectFlowSemantic: templatePrompt }
      },
      d2: { source: '' }
    }
  };
  const requestSemanticPlan = async (currentSpec, resumeId) => {
    const context = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
      stage: 'context', resumeId, templateCode: '', baseSpecHash: '', currentSpec, intent
    }, headers);
    assert.equal(context.statusCode, 202, context.body);
    const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
      stage: 'plan', resumeId, templateCode: '', baseSpecHash: '', currentSpec, intent
    }, headers);
    assert.equal(planned.statusCode, 200, planned.body);
  };

  await requestSemanticPlan(specWithOverride, 'template-prompt-override');
  assert.ok(llm.lastRequest.messages.some((message) => message.role === 'system' && message.content === templatePrompt), JSON.stringify(llm.lastRequest));
  assert.equal(llm.lastRequest.messages.some((message) => message.content === globalPrompt), false, JSON.stringify(llm.lastRequest));

  await requestSemanticPlan(baseSpec, 'template-prompt-reset');
  assert.ok(llm.lastRequest.messages.some((message) => message.role === 'system' && message.content === globalPrompt), JSON.stringify(llm.lastRequest));
  assert.equal(llm.lastRequest.messages.some((message) => message.content === templatePrompt), false, JSON.stringify(llm.lastRequest));
  assert.equal(backend.exitCode, null);
});

for (const [phase, responseOptions] of [
  ['headers', { flow: {}, delayMs: 1200 }],
  ['body', { streamResponse: { contentBytes: 4, chunkBytes: 1, delayMs: 400 } }]
]) test(`LiteLLM timeout follows the configured MCP timeout during ${phase}`, async (t) => {
  const llm = await startLiteLlmStub(t, responseOptions);
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
    CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin,
    CMDP_LOG_LEVEL: 'info'
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
  assert.match(response.json.message, /assistant\.mcp\.timeoutMs/);
  assert.equal(response.json.diagnostics.limits[0].settingPath, 'assistant.mcp.timeoutMs');
  assert.equal(response.json.diagnostics.limits[0].effectiveLimit, 1000);
  assert.equal(response.json.diagnostics.limits[0].stage, 'semanticPlan');
  assert.equal(response.json.diagnostics.limits[0].timeout, true);
  assert.ok(response.json.diagnostics.limits[0].elapsedMs >= 850);
  assert.match(response.json.feedback.action, /Тайм-аут MCP/);
  assert.match(backend.testOutput, /assistant\.litellm\.timeout/);
  assert.match(backend.testOutput, /"timeoutMs":1000/);
  assert.doesNotMatch(backend.testOutput, /unit-test-key|litellm-timeout-token/);
  assert.ok(Date.now() - startedAt >= 850, 'LiteLLM request was cancelled before the configured timeout');
  assert.equal(backend.exitCode, null);
});

test('semantic plan addressed related classes share confirmed prompt and validator paths', async (t) => {
  const intent = objectFlowIntentFromText('', { blocks: ['Asset', 'Network'].map((className, index) => ({
    id: `b${index}`, name: className, entities: `класс "${className}"`,
    algorithm: `Выбрать карточки класса "${className}".`, expectedResult: `Карточки класса "${className}".`,
    uses: index ? ['b0'] : []
  })) });
  const plan = { version: 1, blocks: intent.blocks.map((block, index) => ({
    id: block.id, name: block.name, summary: block.name, dependencies: block.uses,
    resultContract: { outputKind: 'sourceCards', outputClass: block.name, dependencyPaths: index ? [{
      comparisonBlockId: 'b0', sourceClass: 'Asset', targetClass: 'Network', domain: 'AssetNetwork', direction: 'source'
    }] : [] }, warnings: []
  })), warnings: [] };
  const llm = await startLiteLlmStub(t, { responses: [plan] });
  const mock = await startMockCmdbuild(t, {
    classes: ['Other', 'Padding', 'Asset', 'Network'].map((name) => ({ name })),
    domains: [{ name: 'AssetNetwork', source: 'Asset', destination: 'Network', active: true }],
    attributesByClass: { Asset: [{ name: 'AssetValue', type: 'string' }], Network: [{ name: 'NetworkValue', type: 'string' }] },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: {
        llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
        mcp: { maxClasses: 2, timeoutMs: 10000, maxContextBytes: 32768 }
      } }) }]
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const origin = `http://127.0.0.1:${port}`;
  const cookie = testCmdbuildAuthorizationCookie('addressed-related-classes');
  const csrf = await requestJson('GET', `${origin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${origin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.semanticPlan.blocks[1].resultContract.dependencyPaths[0].domain, 'AssetNetwork');
  assert.equal(response.json.diagnostics.mcp.classLookups.filter((item) => item.status === 'found').length, 2);
  const userMessages = llm.lastRequest.messages.filter((item) => item.role === 'user');
  assert.equal(userMessages.length, 2);
  const promptContext = JSON.parse(userMessages[0].content).mcpContext;
  const task = JSON.parse(userMessages[1].content);
  const payload = promptContext.data;
  assert.equal(typeof payload, 'object');
  assert.ok(payload.classFields.some((item) => item.attributes.some((attribute) => attribute.name === 'AssetValue')));
  assert.ok(payload.classFields.some((item) => item.attributes.some((attribute) => attribute.name === 'NetworkValue')));
  assert.deepEqual(task.intent.blocks.map((block) => block.id), intent.blocks.map((block) => block.id));
  assert.match(task.instruction, /Perform the supplied intent.*JSON semantic-plan contract/);
  assert.equal('mcpContext' in task, false);
  assert.deepEqual(promptContext.contextAssembly, response.json.diagnostics.mcp.contextAssembly);
  assert.deepEqual(payload.relationPaths, response.json.diagnostics.mcp.relationPaths);
  assert.equal(payload.relationHints.domains[0].name, 'AssetNetwork');
  assert.equal(llm.requests, 1);
});

test('semantic plan evicts dense optional graph but rejects genuine required byte overflow before LiteLLM', async (t) => {
  const optional = Array.from({ length: 20 }, (_, index) => `Optional${index}`);
  const llm = await startLiteLlmStub(t, { responses: [{ version: 1, blocks: [{
    id: 'block-1', name: 'Assets', summary: 'Assets', dependencies: [],
    resultContract: { outputKind: 'sourceCards', outputClass: 'Asset' }, warnings: []
  }], warnings: [] }] });
  const mock = await startMockCmdbuild(t, {
    classes: ['Asset', ...optional, 'Oversized'].map((name) => ({ name, description: 'Candidate' })),
    domains: [{ name: 'OptionalLinks', sources: optional, destinations: optional, active: true }],
    attributesByClass: { Asset: [{ name: 'RequiredValue', type: 'string' }],
      Oversized: [{ name: 'HeavyRequiredValue', description: 'x'.repeat(40 * 1024), type: 'string' }] },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: {
        llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
        mcp: { maxClasses: 30, maxCandidateClasses: 30, timeoutMs: 10000, maxContextBytes: 32768 }
      } }) }]
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const origin = `http://127.0.0.1:${port}`;
  const cookie = testCmdbuildAuthorizationCookie('dense-optional-graph');
  const csrf = await requestJson('GET', `${origin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const submit = (className) => requestJson('POST', `${origin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } },
    intent: objectFlowIntentFromText(`Выбрать карточки класса "${className}". Candidate.`, {
      context: optional.join(' '),
      name: 'Assets', entities: `класс "${className}"`, expectedResult: `Карточки класса "${className}".`
    })
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  const response = await submit('Asset');
  assert.equal(response.statusCode, 200, response.body);
  const diagnostics = response.json.diagnostics.mcp;
  assert.equal(diagnostics.semanticContext.complete, true);
  assert.ok(diagnostics.semanticContext.serializedBytes <= 32768);
  assert.ok(diagnostics.excludedOptionalClassNames.length > 0, JSON.stringify(diagnostics));
  const selected = new Set(diagnostics.contextClassNames);
  assert.ok(diagnostics.relationPaths.every((path) => selected.has(path.sourceClass) && selected.has(path.targetClass)));
  const reference = JSON.parse(llm.lastRequest.messages.at(-2).content).mcpContext;
  const payload = reference.data;
  assert.equal(typeof payload, 'object');
  assert.match(JSON.parse(llm.lastRequest.messages.at(-1).content).instruction, /Perform the supplied intent/);
  assert.deepEqual(reference.contextAssembly, diagnostics.contextAssembly);
  assert.deepEqual(payload.relationPaths, diagnostics.relationPaths);
  assert.deepEqual(payload.relationHints.domains.map((item) => item.name), diagnostics.contextDomainNames);
  assert.ok(llm.lastRequest.messages.some((item) => item.content.includes('RequiredValue')));
  const overflow = await submit('Oversized');
  assert.equal(overflow.statusCode, 422, overflow.body);
  assert.equal(overflow.json.errors[0].reason, 'maxContextBytes');
  assert.equal(llm.requests, 1, 'genuine required overflow must stop before LiteLLM');
});

test('semantic plan directly resolves an explicit class beyond the bounded catalog and sends its fields to LiteLLM', async (t) => {
  const className = 'Technical_Network';
  const llm = await startLiteLlmStub(t, { responses: [{ version: 1, blocks: [{
    id: 'block-1', name: 'Networks', summary: 'Networks', dependencies: [],
    resultContract: { outputKind: 'sourceCards', outputClass: className }, warnings: []
  }], warnings: [] }] });
  const mock = await startMockCmdbuild(t, {
    classes: [{ name: 'OtherClass', description: className, _description_translation: 'Other localized' }, { name: className, description: 'Networks' }, { name: 'Oversized_Asset', description: 'Large metadata' }],
    attributesByClass: {
      [className]: [{ name: 'NetworkValue', type: 'string', _can_read: true }],
      Oversized_Asset: [{ name: 'ImportantField', description: 'x'.repeat(40 * 1024), type: 'string', _can_read: true }]
    },
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: {
        llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
        mcp: { maxClasses: 1, timeoutMs: 10000, maxContextBytes: 32768 }
      } }) }]
  });
  const backendPort = await freePort();
  await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const origin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('explicit-class-lookup');
  const csrf = await requestJson('GET', `${origin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${origin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } },
    intent: objectFlowIntentFromText(`Выбрать все карточки класса ${className}.`, {
      name: 'Networks', entities: `класс ${className}`, expectedResult: `Список карточек класса ${className}.`
    })
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.semanticPlan.blocks[0].resultContract.outputClass, className);
  assert.ok(mock.requests.some((item) => item.pathname === `/cmdbuild/services/rest/v3/classes/${className}`));
  assert.ok(mock.requests.some((item) => item.pathname === `/cmdbuild/services/rest/v3/classes/${className}/attributes`));
  assert.ok(llm.lastRequest.messages.some((item) => item.content.includes('NetworkValue')));
  assert.equal(response.json.diagnostics.mcp.classLookups[0].status, 'found');
  assert.equal(response.json.diagnostics.mcp.semanticContext.complete, true);
  const incomplete = await requestJson('POST', `${origin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } },
    intent: objectFlowIntentFromText(`Выбрать карточки класса "OtherClass and ${className}".`, {
      name: 'Both networks', entities: `класс "OtherClass and ${className}"`, expectedResult: 'Карточки обоих классов.'
    })
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(incomplete.statusCode, 422, incomplete.body);
  assert.equal(incomplete.json.errors[0].kind, 'semanticPlanContextIncomplete');
  assert.equal(incomplete.json.errors[0].reason, 'maxClasses');
  assert.equal(incomplete.json.errors[0].requiredCount, 2);
  assert.equal(incomplete.json.feedback.code, 'semanticPlanContextIncomplete');
  assert.equal(incomplete.json.feedback.params.settingPath, 'assistant.mcp.maxClasses');
  assert.equal(llm.requests, 1, 'required context overflow must stop before LiteLLM');
  const tooLarge = await requestJson('POST', `${origin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } },
    intent: objectFlowIntentFromText('Выбрать все карточки класса Oversized_Asset.', {
      name: 'Large metadata', entities: 'класс Oversized_Asset', expectedResult: 'Карточки класса Oversized_Asset.'
    })
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(tooLarge.statusCode, 422, tooLarge.body);
  assert.equal(tooLarge.json.errors[0].reason, 'maxContextBytes');
  assert.equal(tooLarge.json.feedback.params.settingPath, 'assistant.mcp.maxContextBytes');
  assert.equal(llm.requests, 1, 'required byte overflow must stop before LiteLLM');
  const rejected = await requestJson('POST', `${origin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, steps: [], result: { tables: [] } },
    intent: objectFlowIntentFromText('Выбрать все карточки класса Missing_Network.', {
      name: 'Networks', entities: 'класс Missing_Network', expectedResult: 'Список карточек класса Missing_Network.'
    })
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json.errors[0].reason, 'descriptionUnverified');
  assert.equal(rejected.json.errors[0].lookup.statusCode, 404);
  assert.equal(rejected.json.errors[0].lookup.status, 'nameNotFound');
  assert.ok(rejected.json.diagnostics.mcp.classCatalog);
  assert.ok(rejected.json.diagnostics.mcp.limits.some((item) => item.limitName === 'maxClasses' && item.limitHit));
  assert.doesNotMatch(rejected.json.feedback.causes[0].message, /class Code/);
  assert.equal(llm.requests, 1, 'unverified class is rejected before invoking LiteLLM');
});

test('D2 mapping timeout identifies the deterministic mapping phase', async (t) => {
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
  const cookie = 'CMDBuild-Authorization=d2-mapping-timeout-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'workstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'D2MappingTimeout',
    currentSpec,
    d2Source: 'workstation: Workstation'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`, {
    prompt: 'Map the workstation role.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles,
    stage: 'roles',
    resumeId: crypto.randomUUID()
  }, headers, 5000);

  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json.code, 'assistant_timeout');
  assert.equal(response.json.diagnostics.phase, 'roles.initial');
  assert.equal(response.json.diagnostics.attempt, 1);
  assert.match(response.json.message, /сопоставление объектов/);
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
  assert.match(firstPlan.json.feedback.action, /MCP-контекст сохранен/);
  assert.equal(firstPlan.json.diagnostics.limits[0].effectiveLimit, 1000);
  assert.ok(firstPlan.json.diagnostics.mcp);

  const retriedPlan = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, { ...body, stage: 'plan' }, headers, 5000);
  assert.equal(retriedPlan.statusCode, 200, retriedPlan.body);
  assert.equal(retriedPlan.json.semanticPlan.blocks[0].resultContract.outputClass, 'IS');
  assert.equal(mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/classes').length, modelReadsAfterContext, 'retry must not read the MCP catalog again');
  assert.equal(llm.requests, 2);
  assert.equal(backend.exitCode, null);
});

test('object-flow retry reuses the completed semantic-plan checkpoint after a LiteLLM timeout', async (t) => {
  const intent = objectFlowIntentFromText('Выбрать ИС по параметру isName.', {
    name: 'Information systems',
    entities: 'Информационная система',
    expectedResult: 'Список информационных систем.'
  });
  const semanticPlan = {
    version: 1,
    blocks: [{
      id: 'block-1', name: 'Information systems', summary: 'ИС по параметру isName.',
      resolvedEntities: ['IS'], relationPaths: [], dependencies: [], expectedResult: 'Список информационных систем.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'IS' }, warnings: []
    }],
    explanation: 'Семантический план сформирован.', warnings: []
  };
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:systems', name: 'Information systems', alias: 'systems', className: 'IS', from: '', limit: 100,
      columns: ['Code', 'Description', 'Name'],
      rules: [{ action: 'include', path: 'Name', negate: false, op: 'equals', regex: '', value: '', valueParam: 'isName', valueColumn: '' }]
    }],
    operations: [],
    publishedAlias: 'systems'
  };
  const llm = await startLiteLlmStub(t, {
    delays: [0, 1200, 0],
    responses: [semanticPlan, { flow, explanation: 'Поток сформирован.', warnings: [] }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Информационная система', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { IS: [{ name: 'Name', type: 'string', active: true, _can_read: true }] },
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
  const cookie = 'CMDBuild-Authorization=flow-retry-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const resumeId = 'object-flow-retry-checkpoint-token';
  const requestBody = {
    resumeId,
    templateCode: '', baseSpecHash: '',
    currentSpec: { version: 1, params: { isName: { type: 'string' } }, steps: [], result: { tables: [] } },
    intent,
    semanticPlan
  };

  const context = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    ...requestBody,
    stage: 'context'
  }, headers);
  assert.equal(context.statusCode, 202, context.body);
  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    ...requestBody,
    stage: 'plan'
  }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  assert.equal(semantic.json.resume.resumeId, resumeId);
  const modelReadsAfterSemantic = mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/classes').length;

  const firstDraft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    ...requestBody,
    semanticPlan: semantic.json.semanticPlan
  }, headers, 5000);
  assert.equal(firstDraft.statusCode, 504, firstDraft.body);
  assert.equal(firstDraft.json.retryable, true);
  assert.equal(firstDraft.json.resume.resumeId, resumeId);
  assert.equal(firstDraft.json.diagnostics.stage, 'flowDraft');
  assert.equal(firstDraft.json.diagnostics.mcpContextReused, true);

  const retriedDraft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    ...requestBody,
    semanticPlan: semantic.json.semanticPlan
  }, headers, 5000);
  assert.equal(retriedDraft.statusCode, 200, retriedDraft.body);
  assert.equal(retriedDraft.json.flow.publishedAlias, 'systems');
  assert.equal(retriedDraft.json.resume.resumeId, resumeId);
  assert.equal(retriedDraft.json.diagnostics.objectFlow.mcpContextReused, true);
  assert.equal(mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/classes').length, modelReadsAfterSemantic, 'flow retry must not read the MCP catalog again');
  // The timed-out flow request reached LiteLLM before the client deadline;
  // retrying the completed semantic checkpoint therefore produces request 3.
  assert.equal(llm.requests, 3);
  assert.equal(backend.exitCode, null);
});

test('semantic planning rejects relationPairs without two selected endpoint blocks', async (t) => {
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

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.errors[0].kind, 'semanticPlanRelationPairMissingEndpoint');
  assert.match(response.json.feedback.summary, /не выбраны оба набора объектов связи/i);
  assert.match(response.json.feedback.action, /Использует результаты блоков/i);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('relationPairs compiles a confirmed domain between two selected results and excludes unselected endpoints', async (t) => {
  const intent = objectFlowIntentFromText('', {
    blocks: [{
      id: 'ranges', name: 'Result 1', entities: 'Карточки класса ipRange.',
      algorithm: 'Для IS с Name равным параметру isName получить связанные ipRange через ISZabbixMonitoringDomain.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'applications', name: 'Applications', entities: 'Карточки класса Application.',
      algorithm: 'Выбрать Application, у которых ipaddress.ipAddr входит в range из Result 1.', expectedResult: 'Список Application.', uses: ['ranges']
    }, {
      id: 'servers', name: 'Result 5', entities: 'Карточки класса phServer.',
      algorithm: 'Выбрать phServer, у которых ipaddress.ipAddr входит в range из Result 1.', expectedResult: 'Список phServer.', uses: ['ranges']
    }, {
      id: 'application-servers', name: 'Applications phServers', entities: 'Связи Application и phServer.',
      algorithm: 'Взять Application из Applications и phServer из Result 5, получить связи domain phS.',
      expectedResult: 'Таблица связей между Application и phServer.', uses: ['applications', 'servers']
    }]
  });
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Result 1', summary: 'Сети целевой ИС.', resolvedEntities: ['IS', 'ipRange'], relationPaths: ['ISZabbixMonitoringDomain'], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange' }, warnings: []
      }, {
        id: 'applications', name: 'Applications', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'IpAddress', 'ipRange'], relationPaths: ['ApplicGIpaddressDomain'], dependencies: ['ranges'], expectedResult: 'Список Application.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', referencePathPredicates: [{ sourceClass: 'ApplicG', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourcePath: ['ipaddress', 'ipAddr'], comparisonField: 'range', operator: 'ipv4InCidr' }] }, warnings: []
      }, {
        id: 'servers', name: 'Result 5', summary: 'Выбранные серверы.', resolvedEntities: ['phServer', 'IpAddress', 'ipRange'], relationPaths: ['ip_addressph'], dependencies: ['ranges'], expectedResult: 'Список phServer.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'phServer', referencePathPredicates: [{ sourceClass: 'phServer', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourcePath: ['ipaddress', 'ipAddr'], comparisonField: 'range', operator: 'ipv4InCidr' }] }, warnings: []
      }, {
        id: 'application-servers', name: 'Applications phServers', summary: 'Пары приложений и серверов.', resolvedEntities: ['ApplicG', 'phServer'], relationPaths: ['phs'], dependencies: ['applications', 'servers'], expectedResult: 'Таблица связей между Application и phServer.',
        resultContract: {
          outputKind: 'relationPairs',
          pair: { mode: 'domain', fromBlockId: 'applications', fromClass: 'ApplicG', withBlockId: 'servers', withClass: 'phServer', domain: 'phS', direction: 'source', rules: [] }
        }, warnings: []
      }],
      explanation: 'Связь подтверждена.', warnings: []
    }, {
      flow: { version: 1, selections: [], operations: [], publishedAlias: '' },
      explanation: 'Assistant flow incomplete.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'IS', description: 'Information system', parent: 'Class', active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'Class', active: true },
      { _id: 3, name: 'IpAddress', description: 'IP address', parent: 'Class', active: true },
      { _id: 4, name: 'ApplicG', description: 'Application', parent: 'Class', active: true },
      { _id: 5, name: 'phServer', description: 'Physical server', parent: 'Class', active: true },
      { _id: 6, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 7, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      IS: [{ name: 'Name', description: 'Name', type: 'string', active: true, _can_read: true }],
      ipRange: [{ name: 'range', description: 'Network range', type: 'string', active: true, _can_read: true }],
      IpAddress: [{ name: 'ipAddr', description: 'IP address value', type: 'ipAddress', active: true, _can_read: true }],
      ApplicG: [{ name: 'ipaddress', description: 'IP address', type: 'reference', targetClass: 'IpAddress', domain: 'ApplicGIpaddressDomain', active: true, _can_read: true }],
      phServer: [{ name: 'ipaddress', description: 'IP address', type: 'reference', targetClass: 'IpAddress', domain: 'ip_addressph', active: true, _can_read: true }]
    },
    domains: [
      { _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' },
      { _id: 'ApplicGIpaddressDomain', name: 'ApplicGIpaddressDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'ip_addressph', name: 'ip_addressph', source: 'IpAddress', sources: ['IpAddress'], destination: 'phServer', destinations: ['phServer'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'phs', name: 'phs', description: 'Applications on physical servers', source: 'ApplicG', sources: ['ApplicG'], destination: 'phServer', destinations: ['phServer'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:1' }
    ],
    cardsByClass: {
      IS: [{ _id: 51, Code: 'IS-TARGET', Description: 'Target system', Name: 'Target system' }],
      ipRange: [{ _id: 101, Code: 'RANGE-SELECTED', Description: 'Selected range', range: '10.44.0.0/24' }],
      IpAddress: [{ _id: 201, Code: 'IP-SELECTED', Description: 'Selected IP', ipAddr: '10.44.0.10' }, { _id: 202, Code: 'IP-OTHER', Description: 'Other IP', ipAddr: '10.99.0.10' }],
      ApplicG: [{ _id: 301, Code: 'APP-SELECTED', Description: 'Selected app', ipaddress: 201 }],
      phServer: [{ _id: 401, Code: 'PHS-SELECTED', Description: 'Selected server', ipaddress: 201 }, { _id: 402, Code: 'PHS-OTHER', Description: 'Other server', ipaddress: 202 }]
    },
    relationsByCard: {
      'IS:51': [{ _id: 500, domain: 'ISZabbixMonitoringDomain', _sourceType: 'IS', _sourceId: 51, _sourceCode: 'IS-TARGET', _sourceDescription: 'Target system', _destinationType: 'ipRange', _destinationId: 101, _destinationCode: 'RANGE-SELECTED', _destinationDescription: 'Selected range', _direction: 'direct' }],
      'IpAddress:201': [
        { _id: 501, domain: 'ApplicGIpaddressDomain', _sourceType: 'IpAddress', _sourceId: 201, _sourceCode: 'IP-SELECTED', _sourceDescription: 'Selected IP', _destinationType: 'ApplicG', _destinationId: 301, _destinationCode: 'APP-SELECTED', _destinationDescription: 'Selected app', _direction: 'direct' },
        { _id: 502, domain: 'ip_addressph', _sourceType: 'IpAddress', _sourceId: 201, _sourceCode: 'IP-SELECTED', _sourceDescription: 'Selected IP', _destinationType: 'phServer', _destinationId: 401, _destinationCode: 'PHS-SELECTED', _destinationDescription: 'Selected server', _direction: 'direct' }
      ],
      'IpAddress:202': [{ _id: 503, domain: 'ip_addressph', _sourceType: 'IpAddress', _sourceId: 202, _sourceCode: 'IP-OTHER', _sourceDescription: 'Other IP', _destinationType: 'phServer', _destinationId: 402, _destinationCode: 'PHS-OTHER', _destinationDescription: 'Other server', _direction: 'direct' }],
      'ApplicG:301': [
        { _id: 504, domain: 'phs', _sourceType: 'ApplicG', _sourceId: 301, _sourceCode: 'APP-SELECTED', _sourceDescription: 'Selected app', _destinationType: 'phServer', _destinationId: 401, _destinationCode: 'PHS-SELECTED', _destinationDescription: 'Selected server', _direction: 'direct' },
        { _id: 505, domain: 'phs', _sourceType: 'ApplicG', _sourceId: 301, _sourceCode: 'APP-SELECTED', _sourceDescription: 'Selected app', _destinationType: 'phServer', _destinationId: 402, _destinationCode: 'PHS-OTHER', _destinationDescription: 'Other server', _direction: 'direct' }
      ]
    },
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 65536 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('relation-pair-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } };

  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent
  }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  const pair = semantic.json.semanticPlan.blocks[3].resultContract.pair;
  assert.equal(pair.domain, 'phs');
  assert.equal(pair.fromBlockId, 'applications');
  assert.equal(pair.withBlockId, 'servers');

  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan
  }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json.success, true, draft.body);
  const relation = draft.json.flow.operations.find((operation) => operation.type === 'relation' && operation.domain === 'phs');
  const pairMatch = draft.json.flow.operations.find((operation) => operation.type === 'match' && operation.as === draft.json.flow.publishedAlias);
  assert.ok(relation, draft.body);
  assert.equal(pairMatch.from, relation.as);
  assert.equal(pairMatch.connection.mode, 'domain');
  assert.equal(pairMatch.connection.sourceField, 'SourceId');
  assert.equal(pairMatch.connection.targetField, 'RelatedId');

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview`, {
    template: { code: 'RelationPairPreview', spec: compileObjectFlowToSpec(currentSpec, draft.json.flow) }, params: { isName: 'Target system' }
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const table = preview.json.result.tables.find((item) => item.name === draft.json.flow.publishedAlias);
  assert.ok(table, preview.body);
  assert.deepEqual(table.rows.map((row) => [row.SourceId, row.RelatedId]), [['301', '401']]);
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
    outputKind: 'sourceCards', outputClass: 'vlan', candidateFilter: null,
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

test('semantic planning defers a cross-block IPv4 condition to deterministic flow compilation', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки класса ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'acls', name: 'Результат 3', entities: 'Карточки класса ACL.',
      algorithm: 'Выбрать ACL, у которых ipaddress или dipaddress входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ACL.', uses: ['ranges']
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
    attributesByClass: { ipRange: [{ name: 'range', type: 'string', active: true, _can_read: true }], ACL: [{ name: 'ipaddress', type: 'string', active: true, _can_read: true }, { name: 'dipaddress', type: 'string', active: true, _can_read: true }] },
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
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract.attributePredicates, []);
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract.referencePathPredicates, []);
  assert.equal(backend.exitCode, null);
});

test('semantic planning removes technical IPv4 paths and predicates from the business contract', async (t) => {
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
  assert.deepEqual(contract.attributePredicates, []);
  assert.deepEqual(contract.referencePathPredicates, []);
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

test('semantic planning explains an invalid comparison class without empty details', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG и сети первого результата.', algorithm: 'Выбрать ApplicG по IPv4 условию.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [] }, warnings: []
      }, {
        id: 'applications', name: 'Результат 4', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ApplicG.',
        resultContract: {
          outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [],
          attributePredicates: [{ sourceClass: 'Application', comparisonBlockId: 'ranges', comparisonClass: 'Application network', sourceFields: ['ipaddress'], comparisonField: 'range', operator: 'ipv4InCidr' }]
        }, warnings: []
      }],
      explanation: 'Некорректный класс сравнения.', warnings: []
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
  const cookie = testCmdbuildAuthorizationCookie('semantic-invalid-comparison-class-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 422, response.body);
  assert.deepEqual(response.json.errors, [{
    kind: 'semanticPlanPredicateClassInvalid', blockId: 'applications', blockName: 'Результат 4', predicateType: 'attribute', predicateIndex: 1,
    outputClass: 'ApplicG', comparisonBlockId: 'ranges', invalidField: 'comparisonClass', value: 'Application network'
  }]);
  assert.match(response.json.feedback.summary, /Результат 4/);
  assert.match(response.json.feedback.causes[0].message, /comparisonClass/);
  assert.match(response.json.feedback.causes[0].message, /Application network/);
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
  assert.ok(router.rules.some((rule) => rule.path === 'Description' && rule.op === 'equals' && rule.rightExpression === 'Маршрутизатор для Test City 300'));
  assert.equal(arm.from, 'router');
  assert.equal(arm.rules.some((rule) => rule.path === 'Location' && rule.rightExpression === '${previous.Location}'), true);
  assert.equal(response.json.flow.operations.some((operation) => operation.type === 'relation'), false);
  assert.equal(response.json.flow.operations.some((operation) => operation.type === 'match'), false);
  assert.equal(response.json.flow.publishedAlias, 'arm');
  assert.equal(backend.exitCode, null);
});

test('object-flow planning and local Apply do not require an update grant', async (t) => {
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
    templateRef: {
      root: 'Cst_QueryTool',
      templateCode: 'NoUpdateObjectFlow',
      baseSpecHash: hashJson(savedSpec)
    },
    editorDelta: { version: 1, spec: savedSpec },
    ...objectFlowPlanRequest('Выбрать все карточки АРМ.', { outputClass: 'ARM' })
  }, headers);
  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.success, true);
  assert.equal(planned.json.canApply, true);
  assert.equal(planned.json.flow.publishedAlias, flow.publishedAlias);
  assert.equal(planned.json.flow.selections[0].className, flow.selections[0].className);
  assert.equal(llm.requests, 1);

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode: 'NoUpdateObjectFlow',
    baseSpecHash: hashJson(savedSpec),
    currentSpec: savedSpec,
    flow
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  assert.ok(applied.json.spec, applied.body);
  assert.equal(mock.requests.some((item) => item.method === 'PUT' && item.pathname.includes('/classes/Cst_QueryTemplate/cards/')), false);

  const save = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/NoUpdateObjectFlow`, {
    code: 'NoUpdateObjectFlow', expectedSpecHash: hashJson(savedSpec), spec: applied.json.spec
  }, headers);
  assert.equal(save.statusCode, 403, save.body);
  assert.equal(save.json.reason, 'template_update_forbidden');
  assert.equal(backend.exitCode, null);
});

test('object-flow planning remains locally applicable when a card omits _can_update', async (t) => {
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
    ...objectFlowPlanRequest('Выбрать все карточки АРМ.', { outputClass: 'ARM' })
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
  assert.equal(mock.requests.some((item) => item.method === 'PUT' && item.pathname.includes('/classes/Cst_QueryTemplate/cards/')), false);
  assert.equal(backend.exitCode, null);
});

test('normal template Save keeps retired Assistant authoring unsupported and the side route absent', async (t) => {
  const savedSpec = publishSpec();
  const legacySpec = {
    ...savedSpec,
    assistantDraft: {
      objectFlowIntent: objectFlowIntentFromText('Выбрать АРМ.'),
      diagramInterpretPrompt: 'Интерпретировать контейнеры.',
      diagramMappingPrompt: 'Сопоставить выборки с узлами.',
      d2Authoring: { version: 1, source: 'node: "Node" { class: server }' }
    }
  };
  const mock = await startMockCmdbuild(t, { templates: [templateCard('AssistantAuthoringSave', savedSpec)] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=assistant-authoring-save-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const retired = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/AssistantAuthoringSave/assistant-draft`, {
    baseSpecHash: hashJson(savedSpec), assistantDraft: legacySpec.assistantDraft
  }, headers);
  assert.equal(retired.statusCode, 404, retired.body);
  assert.equal(retired.json.message, 'Unknown template action: assistant-draft');

  const saved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/AssistantAuthoringSave`, {
    code: 'AssistantAuthoringSave', expectedSpecHash: hashJson(savedSpec), spec: legacySpec
  }, headers);
  assert.equal(saved.statusCode, 409, saved.body);
  assert.equal(saved.json.reason, 'd2_authoring_current_contract_required');
  assert.deepEqual(saved.json.diagramAuthoringStatus.reasons, ['assistantDraft']);
  assert.equal(mock.requests.some((item) => item.pathname.includes('/classes/Cst_QueryTemplateVersion/cards')), false);
  assert.equal(backend.exitCode, null);
});

test('normal template Save preserves incomplete canonical D2 authoring without executing it', async (t) => {
  const savedSpec = publishSpec();
  const source = 'application: "Application"';
  const draft = {
    ...savedSpec,
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: objectFlowIntentFromText('Выбрать АРМ.'),
        diagramInterpretPrompt: 'Интерпретировать роли.',
        diagramMappingPrompt: 'Сопоставить роли.'
      },
      d2: { source }
    }
  };
  const mock = await startMockCmdbuild(t, { templates: [templateCard('IncompleteD2Authoring', savedSpec)] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=incomplete-d2-authoring-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const saved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/IncompleteD2Authoring`, {
    code: 'IncompleteD2Authoring', expectedSpecHash: hashJson(savedSpec), spec: draft
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json.template.spec.authoring.d2.source, source);
  assert.equal(saved.json.template.spec.assistantDraft, undefined);
  assert.equal(saved.json.executionValidation.executable, false);
  assert.equal(saved.json.executionValidation.errors.some((item) => item.path === '$.result.diagrams'), true);
  assert.ok(saved.json.versionLog, saved.body);
  assert.equal(saved.json.cacheInvalidation.runtime.reason, 'authoring_only');
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
    ...objectFlowPlanRequest(prompt, { outputClass: 'ipRange' })
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
        _id: 402, domain: 'Vlan2super', _sourceType: 'ipRange', _sourceId: 201, _sourceCode: 'RANGE-001', _sourceDescription: 'Target range',
        _destinationType: 'vlan', _destinationId: 301, _destinationCode: 'VLAN-001', _destinationDescription: 'Target VLAN', _direction: 'inverse'
      }, {
        _id: 403, domain: 'Vlan2super', _sourceType: 'ipRange', _sourceId: 201, _sourceCode: 'RANGE-001', _sourceDescription: 'Target range',
        _destinationType: 'routerG', _destinationId: 302, _destinationCode: 'ROUTER-001', _destinationDescription: 'Wrong endpoint class', _direction: 'inverse'
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

  const plannedSpec = compileObjectFlowToSpec({
    version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] }
  }, planned.json.flow);
  const plannedPreview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&maxClasses=20&maxRestCalls=50`, {
    template: { code: 'PlannedIsIpRangeVlanPreview', spec: plannedSpec }, params: { isName: 'Target IS' }
  }, headers);
  assert.equal(plannedPreview.statusCode, 200, plannedPreview.body);
  const plannedTable = plannedPreview.json.result.tables.find((item) => item.name === planned.json.flow.publishedAlias);
  assert.ok(plannedTable, plannedPreview.body);
  assert.deepEqual(plannedTable.rows.map((row) => [row.SourceId, row.RelatedId, row.RelatedClass, row.Code, row.network]), [
    ['201', '301', 'vlan', 'VLAN-001', '10.44.0.0/24']
  ]);

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
    publishedAlias: 'acls'
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
        _id: 502, domain: 'Vlan2super', _sourceType: 'ipRange', _sourceId: 201, _sourceCode: 'RANGE-001', _sourceDescription: 'Target range',
        _destinationType: 'vlan', _destinationId: 301, _destinationCode: 'VLAN-001', _destinationDescription: 'Target VLAN', _direction: 'inverse'
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
  const intent = objectFlowIntentFromText(prompt, {
    blocks: [{
      id: 'information-systems', name: 'Выборка 1', entities: 'Карточки класса IS.',
      algorithm: 'Выбрать IS по Name из параметра isName.', expectedResult: 'Список IS.', uses: []
    }, {
      id: 'ip-ranges', name: 'Связь 1.1', entities: 'Карточки класса ipRange.',
      algorithm: 'Из Выборки 1 получить связанные ipRange.', expectedResult: 'Список ipRange.', uses: ['information-systems']
    }, {
      id: 'vlans', name: 'Связь 2.1', entities: 'Карточки класса vlan.',
      algorithm: 'Из Связи 1.1 получить связанные VLAN.', expectedResult: 'Список VLAN.', uses: ['ip-ranges']
    }, {
      id: 'acls', name: 'Выборка 3', entities: 'Карточки класса ACL.',
      algorithm: 'Оставить ACL, у которых Destination ipaddress или Source ipaddress входят в range Связи 1.1.', expectedResult: 'Список ACL.', uses: ['ip-ranges']
    }]
  });
  const semanticPlan = {
    version: 1,
    blocks: [{
      id: 'information-systems', name: 'Выборка 1', summary: 'Целевая ИС.', resolvedEntities: ['IS'], relationPaths: [], dependencies: [], expectedResult: 'Список IS.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'IS' }, warnings: []
    }, {
      id: 'ip-ranges', name: 'Связь 1.1', summary: 'Связанные сети.', resolvedEntities: ['IS', 'ipRange'], relationPaths: ['ISZabbixMonitoringDomain'], dependencies: ['information-systems'], expectedResult: 'Список ipRange.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', dependencyPaths: [{ comparisonBlockId: 'information-systems', sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', direction: 'source', targetClass: 'ipRange' }] }, warnings: []
    }, {
      id: 'vlans', name: 'Связь 2.1', summary: 'Связанные VLAN.', resolvedEntities: ['ipRange', 'vlan'], relationPaths: ['Vlan2super'], dependencies: ['ip-ranges'], expectedResult: 'Список VLAN.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'vlan', dependencyPaths: [{ comparisonBlockId: 'ip-ranges', sourceClass: 'ipRange', domain: 'Vlan2super', direction: 'destination', targetClass: 'vlan' }] }, warnings: []
    }, {
      id: 'acls', name: 'Выборка 3', summary: 'ACL с адресом в выбранных сетях.', resolvedEntities: ['ACL', 'ipRange'], relationPaths: [], dependencies: ['ip-ranges'], expectedResult: 'Список ACL.',
      resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', attributePredicates: [{ sourceClass: 'ACL', comparisonBlockId: 'ip-ranges', comparisonClass: 'ipRange', sourceFields: ['ipaddress', 'dipaddress'], comparisonField: 'range', operator: 'ipv4InCidr' }] }, warnings: []
    }],
    explanation: 'Подтвержденная цепочка и IPv4-сопоставление.', warnings: []
  };
  const planned = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);

  assert.equal(planned.statusCode, 200, planned.body);
  assert.equal(planned.json.success, true);
  assert.equal(planned.json.flow.publishedAlias, 'acls');
  assert.equal(planned.json.diagnostics.objectFlow.fallback, null, planned.body);
  assert.deepEqual(planned.json.diagnostics.objectFlow.relationRequirements, {
    kind: 'relationRequirements',
    chains: [
      { operations: [{ sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' }] },
      { operations: [{ sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }] }
    ]
  });
  const plannedAcls = planned.json.flow.selections.find((selection) => selection.alias === 'acls');
  assert.equal(plannedAcls.from, 'ipRanges');
  assert.deepEqual(plannedAcls.rules.map((rule) => [rule.op, rule.rightExpression]), [
    ['ipv4InCidr', '${previous.range}'],
    ['ipv4InCidr', '${previous.range}']
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

test('assistant requires one plain-language description for every business data block before semantic planning', async (t) => {
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
    intent: { context: '', blocks: [{ id: 'ip-ranges', name: 'IP ranges', description: '', resultKind: 'auto', uses: [] }] }
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json.code, 'assistant_object_flow_intent_incomplete');
  assert.match(response.json.message, /description is required/);
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
    domains: [
      { _id: 'ISIpRange', name: 'ISIpRange', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' },
      { _id: 'AlternativeISIpRange', name: 'AlternativeISIpRange', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }
    ],
    cardsByClass: {
      IS: [
        { _id: 101, Code: 'IS-001', Description: 'External matching', Name: 'External matching', isExt: false },
        { _id: 102, Code: 'IS-002', Description: 'External other', Name: 'External other', isExt: false },
        { _id: 103, Code: 'IS-003', Description: 'External true', Name: 'External true', isExt: true }
      ],
      ipRange: [
        { _id: 201, Code: 'RANGE-001', Description: 'Matching range', range: '10.44.0.0/24' },
        { _id: 202, Code: 'RANGE-002', Description: 'Other range', range: '10.99.0.0/24' }
      ],
      ACL: [{ _id: 301, Code: 'ACL-001', Description: 'Matching ACL', ipaddress: '10.1.1.1', dipaddress: '10.44.0.10' }]
    },
    relationsByCard: {
      'IS:101': [{ _id: 401, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 101, _sourceCode: 'IS-001', _sourceDescription: 'External matching', _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Matching range', _direction: 'direct' }],
      'IS:102': [{ _id: 402, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 102, _sourceCode: 'IS-002', _sourceDescription: 'External other', _destinationType: 'ipRange', _destinationId: 202, _destinationCode: 'RANGE-002', _destinationDescription: 'Other range', _direction: 'direct' }],
      'IS:103': [{ _id: 403, domain: 'ISIpRange', _sourceType: 'IS', _sourceId: 103, _sourceCode: 'IS-003', _sourceDescription: 'External true', _destinationType: 'ipRange', _destinationId: 201, _destinationCode: 'RANGE-001', _destinationDescription: 'Matching range', _direction: 'direct' }]
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
  assert.deepEqual(rebuiltIsSource.rules.map((rule) => [rule.path, rule.op, rule.rightExpression]), [
    ['Name', 'notEquals', '${param.isName}'],
    ['isExt', 'equals', 'false']
  ]);
  const spec = compileObjectFlowToSpec({ version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } }, planned.json.flow);
  delete spec.steps.find((step) => step.as === 'externalIs').filterJoin;
  spec.visualModels.find((model) => model.mode === 'objectMatching').assistantOutputManifest = {
    version: 1,
    blocks: [{ id: 'external-systems', name: 'Внутренние ИС', order: 1 }]
  };
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
  assert.deepEqual(planned.json.flow.selections[1].rules.map((rule) => [rule.path, rule.op, rule.rightExpression]), [
    ['ipaddress', 'ipv4InCidr', '${previous.range}'],
    ['dipaddress', 'ipv4InCidr', '${previous.range}']
  ]);
  assert.ok(llm.lastRequest.messages.some((message) => /attributePredicates item is a direct comparison/.test(message.content)), JSON.stringify(llm.lastRequest));

  const rebuilt = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent, semanticPlan
  }, headers);
  assert.equal(rebuilt.statusCode, 200, rebuilt.body);
  assert.deepEqual(rebuilt.json.diagnostics.objectFlow.fallback, { kind: 'semanticContractCompiler', used: true });
  assert.equal(rebuilt.json.flow.publishedAlias, rebuilt.json.flow.selections[1].alias);
  assert.deepEqual(rebuilt.json.outputBindings, [
    { blockId: 'ip-ranges', alias: rebuilt.json.flow.selections[0].alias },
    { blockId: 'acls', alias: rebuilt.json.flow.selections[1].alias }
  ]);
  assert.equal(rebuilt.json.canApply, true);
  assert.deepEqual(rebuilt.json.diagnostics.objectFlow.outputBindingErrors, []);
  assert.deepEqual(rebuilt.json.flow.selections.map((selection) => [selection.className, selection.from]), [
    ['ipRange', ''],
    ['ACL', rebuilt.json.flow.selections[0].alias]
  ]);
  assert.deepEqual(rebuilt.json.flow.selections[1].rules.map((rule) => [rule.path, rule.op, rule.rightExpression]), [
    ['ipaddress', 'ipv4InCidr', '${previous.range}'],
    ['dipaddress', 'ipv4InCidr', '${previous.range}']
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

test('assistant replaces invented domains and forward aliases with the confirmed deterministic relation chain', async (t) => {
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
  const intent = objectFlowIntentFromText('', { blocks: [{
    id: 'information-systems', name: 'Information systems', entities: 'Карточки IS.', algorithm: 'Выбрать IS по Name.', expectedResult: 'Список IS.', uses: []
  }, {
    id: 'ip-ranges', name: 'IP ranges', entities: 'Карточки ipRange.', algorithm: 'Получить связанные ipRange.', expectedResult: 'Список ipRange.', uses: ['information-systems']
  }, {
    id: 'vlans', name: 'VLANs', entities: 'Карточки vlan.', algorithm: 'Получить связанные VLAN.', expectedResult: 'Список VLAN.', uses: ['ip-ranges']
  }] });
  const semanticPlan = {
    version: 1,
    blocks: [{
      id: 'information-systems', name: 'Information systems', summary: 'Целевая ИС.', resolvedEntities: ['IS'], relationPaths: [], dependencies: [], expectedResult: 'Список IS.', resultContract: { outputKind: 'sourceCards', outputClass: 'IS' }, warnings: []
    }, {
      id: 'ip-ranges', name: 'IP ranges', summary: 'Связанные сети.', resolvedEntities: ['IS', 'ipRange'], relationPaths: ['ISZabbixMonitoringDomain'], dependencies: ['information-systems'], expectedResult: 'Список ipRange.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', dependencyPaths: [{ comparisonBlockId: 'information-systems', sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', direction: 'source', targetClass: 'ipRange' }] }, warnings: []
    }, {
      id: 'vlans', name: 'VLANs', summary: 'Связанные VLAN.', resolvedEntities: ['ipRange', 'vlan'], relationPaths: ['Vlan2super'], dependencies: ['ip-ranges'], expectedResult: 'Список VLAN.', resultContract: { outputKind: 'sourceCards', outputClass: 'vlan', dependencyPaths: [{ comparisonBlockId: 'ip-ranges', sourceClass: 'ipRange', domain: 'Vlan2super', direction: 'destination', targetClass: 'vlan' }] }, warnings: []
    }],
    explanation: 'Подтвержденная цепочка.', warnings: []
  };
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } },
    intent, semanticPlan
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.success, true);
  assert.deepEqual(response.json.flow.operations.map((operation) => [operation.type, operation.domain, operation.direction]), [
    ['relation', 'ISZabbixMonitoringDomain', 'source'],
    ['relation', 'Vlan2super', 'destination']
  ]);
  assert.equal(response.json.flow.operations.some((operation) => operation.as === 'invalidAliases' || operation.domain === 'ipRangeVlanDomain'), false);
  assert.equal(response.json.diagnostics.objectFlow.fallback.kind, 'semanticContractCompiler');
  assert.deepEqual(response.json.diagnostics.objectFlow.relationRequirements, {
    kind: 'relationRequirements',
    chains: [
      { operations: [{ sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' }] },
      { operations: [{ sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }] }
    ]
  });
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('assistant repairs missing Object Flow identifiers from the confirmed semantic contract', async (t) => {
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
  const planRequest = objectFlowPlanRequest('Для информационной системы (ИС) с Name равным isName получить связанные ipRange, затем оставить ipRange, у которых есть связанный ACL с ipaddress в range.', { outputClass: 'ipRange' });
  planRequest.semanticPlan.blocks[0].resolvedEntities = ['IS', 'ipRange', 'ACL'];
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: { isName: { type: 'string', required: true } }, steps: [], result: { tables: [] } },
    ...planRequest
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.success, true);
  assert.equal(response.json.flow.publishedAlias, 'block_1');
  assert.deepEqual(response.json.flow.operations.map((operation) => [operation.type, operation.domain, operation.targetClass]), [
    ['relation', 'ISZabbixMonitoringDomain', 'ipRange']
  ]);
  assert.equal(response.json.diagnostics.objectFlow.normalizations.length, 2);
  assert.equal(response.json.diagnostics.objectFlow.fallback.kind, 'semanticContractCompiler');
  assert.ok(response.json.warnings.some((warning) => /rebuilt it deterministically/i.test(warning)), response.body);
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
  const mock = await startMockCmdbuild(t, {
    domains: [{
      _id: 'AssetReference', name: 'AssetReference', source: 'routerG', sources: ['routerG'],
      destination: 'ARM', destinations: ['ARM'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }],
    relationsByCard: {
      'routerG:301': [{
        _id: 901,
        domain: 'AssetReference',
        _sourceType: 'routerG', _sourceId: 301, _sourceCode: 'router-target', _sourceDescription: 'Маршрутизатор для Test City 300',
        _destinationType: 'ARM', _destinationId: 501, _destinationCode: 'ARM-001', _destinationDescription: 'АРМ 001',
        _direction: 'direct'
      }]
    }
  });
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
    { alias: 'routers', className: 'routerG', columns: ['Code', 'Description', 'Location'] },
    { alias: 'switches', className: 'ARM', columns: ['Code', 'Description', 'Location'] }
  ], [{
    id: 'match:matchedNetwork',
    from: 'routers',
    with: 'switches',
    as: 'matchedNetwork',
    rightPrefix: 'Selection 2.',
    rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Location', leftRegex: '', rightColumn: 'Location', rightRegex: '' }]
  }]);
  const source = 'router: Router\nswitch: Switch';
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
  assert.match(analyzed.json.preview.content, /<foreignObject x="40" y="50" width="245" height="24">/);
  assert.match(analyzed.json.preview.content, /ИС LPS/);
  assert.match(analyzed.json.preview.content, /#9FF6FF/);
  assert.match(analyzed.json.preview.content, /#f503EB/);
  assert.doesNotMatch(analyzed.json.preview.content, /<script|onclick|<img|evil\.local|@import/i);
  assert.equal(analyzed.json.preview.content.includes(source), false);
  assert.ok(analyzed.json.catalog.classes.some((item) => item.name === 'ARM'));
  assert.equal(analyzed.json.proposal.catalogHash.length > 0, true);
  assert.deepEqual(analyzed.json.proposal.roles.map((role) => role.key).sort(), ['router', 'switch']);
  assert.equal(analyzed.json.proposal.unresolved.length, 3);
  assert.deepEqual(analyzed.json.proposal.relationRules.map((rule) => ({
    d2ElementKey: rule.d2ElementKey,
    d2ClassKey: rule.d2ClassKey,
    d2Label: rule.d2Label,
    mode: rule.mode
  })), [{ d2ElementKey: 'router_switch', d2ClassKey: 'network_link', d2Label: 'network_link', mode: 'deterministicEndpoints' }]);
  assert.deepEqual(analyzed.json.proposal.relationRules[0].d2ElementKeys, ['router_switch']);
  assert.match(analyzed.json.proposal.relationRules[0].d2Notes, /dedicated deterministic connection result/);
  assert.equal(analyzed.json.proposal.templateGrammar.edges[0].classKey, 'network_link');
  assert.match(analyzed.json.proposal.templateGrammar.edges[0].classNotes, /dedicated deterministic connection result/);
  const tamperedProposal = structuredClone(analyzed.json.proposal);
  tamperedProposal.sourceText += '\nchanged: true';
  const tampered = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: tamperedProposal,
    roles: []
  }, headers);
  assert.equal(tampered.statusCode, 409, tampered.body);
  assert.equal(tampered.json.code, 'diagram_import_proposal_invalid');
  const tamperedTemplateProposal = structuredClone(analyzed.json.proposal);
  tamperedTemplateProposal.template.title = 'Tampered title';
  const tamperedTemplate = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: tamperedTemplateProposal,
    roles: []
  }, headers);
  assert.equal(tamperedTemplate.statusCode, 409, tamperedTemplate.body);
  assert.equal(tamperedTemplate.json.code, 'diagram_import_proposal_invalid');

  const sourceRequired = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);
  assert.equal(sourceRequired.statusCode, 400, sourceRequired.body);
  assert.equal(sourceRequired.json.code, 'diagram_import_source_required');

  const incomplete = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);
  assert.equal(incomplete.statusCode, 200, incomplete.body);
  assert.equal(incomplete.json.success, true);
  assert.equal(incomplete.json.status, 'partial');
  assert.equal(incomplete.json.partial, true);
  assert.equal(incomplete.json.d2Workflow.state, 'pending');
  assert.equal(incomplete.json.spec.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'needsValidation');
  assert.equal(incomplete.json.spec.steps.some((step) => step.managedBy === 'd2ImportV3'), false);
  assert.equal(incomplete.json.spec.result.diagrams[0].nodeMappings.length, 0);
  assert.ok(incomplete.json.unresolved.length >= 3);

  const topologyContract = analyzed.json.proposal.relationRules[0];
  const roles = analyzed.json.proposal.roles.map((role) => {
    const sourceStage = role.key === 'router'
      ? { stageId: 'selection:routers', alias: 'routers', kind: 'selection', className: 'routerG' }
      : { stageId: 'selection:switches', alias: 'switches', kind: 'selection', className: 'ARM' };
    return d2RoleOverride(role, {
      materialization: { kind: 'stage', stageId: sourceStage.stageId },
      primary: {
        className: role.key === 'router' ? 'routerG' : 'ARM',
        idAttribute: '_id',
        labelTemplate: '${Code} ${Description}',
        structuredFields: ['Code', 'Description'],
        filters: []
      },
      related: []
    });
  });
  const structureTree = d2StructureTreeWithMaterialization(analyzed.json.proposal, roles);
  const partialApplied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree,
    relationRules: []
  }, headers);
  assert.equal(partialApplied.statusCode, 200, partialApplied.body);
  assert.equal(partialApplied.json.status, 'partial');
  assert.equal(partialApplied.json.partial, true);
  assert.equal(partialApplied.json.d2Workflow.state, 'pending');
  assert.equal(partialApplied.json.spec.result.diagrams[0].nodeMappings.length, 2);
  assert.equal(partialApplied.json.spec.steps.some((step) => step.managedBy === 'd2ImportV3'), false);
  assert.ok(partialApplied.json.omissions.some((item) => item.kind === 'connection'));
  const partialAppliedPreview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&executionScope=diagrams`, {
    template: { code: 'NetworkImport', spec: partialApplied.json.spec },
    params: {}
  }, headers);
  assert.equal(partialAppliedPreview.statusCode, 200, partialAppliedPreview.body);
  assert.equal(partialAppliedPreview.json.success, true);
  assert.equal(partialAppliedPreview.json.result.diagramPreview.partial, true);
  assert.ok(partialAppliedPreview.json.result.diagrams[0].nodes.length > 0);
  assert.equal(partialAppliedPreview.json.result.diagrams[0].edges.length, 0);
  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree,
    relationRules: [{
      ...topologyContract,
      id: 'router_switch_relation',
      kind: 'connection',
      mode: 'deterministicEndpoints',
      directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'match:matchedNetwork',
      sourceField: 'Location',
      targetField: 'Selection 2.Location',
      labelField: ''
    }]
  }, headers);

  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json.success, true);
  assert.equal(applied.json.d2Workflow.state, 'applied');
  assert.equal(applied.json.spec.result.diagrams[0].nodeMappings.length, 2);
  assert.equal(applied.json.spec.result.diagrams[0].edgeMappings.length, 1);
  assert.match(applied.json.spec.result.diagrams[0].edgeMappings[0].importRole.edgeClassNotes, /dedicated deterministic connection result/);
  assert.equal(applied.json.spec.result.diagrams[0].authoring.d2Import.source, source);
  assert.match(applied.json.spec.result.diagrams[0].authoring.d2Import.structureHash, /^[0-9a-f]{64}$/);
  assert.equal(applied.json.spec.steps[0].as, 'routers');
  assert.equal(applied.json.spec.steps.filter((step) => step.managedBy === 'd2ImportV3').length, 0);
  assert.equal(applied.json.spec.result.diagrams[0].authoring.d2Import.roleMappings, undefined);
  assert.equal(applied.json.spec.result.diagrams[0].authoring.d2Import.structureTree.items
    .filter((item) => item.mapping.materialization && item.mapping.materialization.kind === 'stage' && item.mapping.materialization.stageId).length, 2);
  assert.equal(applied.json.spec.assistantDraft, undefined);
  assert.equal(applied.json.spec.authoring.d2.source, source);
  assert.equal(applied.json.spec.authoring.d2.sourceHash, applied.json.spec.result.diagrams[0].authoring.d2Import.sourceHash);

  const intermediateSpec = structuredClone(applied.json.spec);
  intermediateSpec.result.diagrams[0].authoring.d2Import.mappingValidation = { version: 1, status: 'needsValidation' };
  const invalidPlacement = structuredClone(intermediateSpec.result.diagrams[0].authoring.d2Import.structureTree.items[0]);
  invalidPlacement.id = 'manual-invalid-router-placement';
  invalidPlacement.mapping.id = 'mapping:manual-invalid-router-placement';
  invalidPlacement.mapping.materialization = { kind: 'stage', stageId: 'selection:missing' };
  intermediateSpec.result.diagrams[0].authoring.d2Import.structureTree.items.push(invalidPlacement);
  const intermediatePlan = draftDiagramPreviewMappingPlan(intermediateSpec);
  assert.equal(intermediatePlan.spec.result.diagrams[0].edgeMappings.length, 1);
  assert.equal(intermediatePlan.spec.steps.some((step) => step.managedBy === 'd2ImportV3'), false);
  const intermediatePreview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&executionScope=diagrams`, {
    template: { code: 'NetworkImport', spec: intermediateSpec },
    params: {}
  }, headers);
  assert.equal(intermediatePreview.statusCode, 200, intermediatePreview.body);
  assert.equal(intermediatePreview.json.success, true);
  assert.equal(intermediatePreview.json.result.d2Workflow.state, 'pending');
  assert.equal(intermediatePreview.json.result.diagramPreview.partial, true);
  assert.ok(intermediatePreview.json.result.diagrams[0].nodes.length > 0);
  assert.ok(intermediatePreview.json.result.diagrams[0].edges.length > 0, intermediatePreview.body);

  const lateFailureSpec = structuredClone(applied.json.spec);
  lateFailureSpec.steps.push({
    type: 'selectCards',
    as: 'lateFailure',
    className: 'MissingPreviewClass',
    filters: [],
    columns: ['Code', 'Description'],
    limit: 20
  });
  lateFailureSpec.result.diagrams[0].nodeMappings.push({
    id: 'late-failure-node',
    from: 'lateFailure',
    fields: { id: '_id', label: 'Description' }
  });
  const partialPreview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&executionScope=diagrams`, {
    template: { code: 'NetworkImport', spec: lateFailureSpec },
    params: {}
  }, headers);
  assert.notEqual(partialPreview.statusCode, 200, partialPreview.body);
  assert.equal(partialPreview.json.success, false);
  const partialTrace = partialPreview.json.result.trace;
  assert.equal(partialTrace[0].as, 'routers');
  assert.equal(partialTrace[1].as, 'switches');
  assert.equal(partialTrace.at(-1).as, 'lateFailure');
  assert.equal(partialTrace.at(-1).status, 'error');
  assert.ok(partialTrace.slice(0, -1).every((item) => item.status === 'ok'));
  assert.equal(partialPreview.json.result.diagnosticPreview.state, 'partial');
  assert.equal(partialPreview.json.result.diagnosticPreview.incomplete, true);
  assert.deepEqual(partialPreview.json.result.diagnosticPreview.availableStages, partialTrace.slice(0, -1).map((item) => item.as));
  assert.equal(partialPreview.json.result.diagnosticPreview.failedStages[0].as, 'lateFailure');
  assert.ok(partialPreview.json.result.diagnosticPreview.diagrams[0].nodes.length > 0);
  assert.equal(partialPreview.json.result.diagnosticPreview.diagrams[0].nodes.some((node) => Object.hasOwn(node, 'data')), false);
  assert.match(partialPreview.json.result.diagnosticPreview.diagrams[0].svg.content, /^<svg data-cmdp-d2-rendered="true"/);

  const relationCardApplied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree,
    relationRules: [{
      ...topologyContract,
      id: 'router_switch_acl',
      kind: 'connection',
      mode: 'relationCard',
      directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'selection:routers',
      sourceField: 'Code',
      targetField: 'Description',
      labelField: 'Code'
    }]
  }, headers);
  assert.equal(relationCardApplied.statusCode, 200, relationCardApplied.body);
  assert.equal(relationCardApplied.json.spec.result.diagrams[0].edgeMappings[0].type, 'relationObject');
  assert.equal(relationCardApplied.json.spec.result.diagrams[0].edgeMappings[0].from, 'routers');

  const deterministicEndpointsApplied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree,
    relationRules: [{
      ...topologyContract,
      id: 'router_switch_deterministic',
      kind: 'connection',
      mode: 'deterministicEndpoints',
      directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'match:matchedNetwork',
      sourceField: 'Code',
      targetField: 'Selection 2.Code',
      labelField: ''
    }]
  }, headers);
  assert.equal(deterministicEndpointsApplied.statusCode, 200, deterministicEndpointsApplied.body);
  assert.equal(deterministicEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].type, 'computed');
  assert.equal(deterministicEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].from, 'matchedNetwork');

  const attributeEndpointProfiles = [
    {
      id: 'router-code',
      structureItemId: structureTree.items.find((item) => item.roleId === roles.find((role) => role.mapping.primary.className === 'routerG').id).id,
      roleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      field: 'Code',
      operators: ['equals']
    },
    {
      id: 'switch-code',
      structureItemId: structureTree.items.find((item) => item.roleId === roles.find((role) => role.mapping.primary.className === 'ARM').id).id,
      roleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      field: 'Code',
      operators: ['equals']
    }
  ];
  const attributeEndpointsApplied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree,
    endpointProfiles: attributeEndpointProfiles,
    relationRules: [{
      ...topologyContract,
      id: 'router_switch_attribute',
      kind: 'connection',
      mode: 'attributeEndpoints',
      directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'selection:routers',
      sourceField: 'Code',
      targetField: 'Code',
      sourceOperator: 'equals',
      targetOperator: 'equals',
      endpointOperator: 'equals',
      labelField: 'Code'
    }]
  }, headers);
  assert.equal(attributeEndpointsApplied.statusCode, 200, attributeEndpointsApplied.body);
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].type, 'attributeEndpoints');
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution.strategy, 'comparisonRules');
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution.operator, 'equals');
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution.sourceOperator, 'equals');
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution.targetOperator, 'equals');
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution.profileScope, 'allCompatiblePlacements');
  assert.equal(Object.hasOwn(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution, 'sourceEndpointProfileIds'), false);
  assert.equal(Object.hasOwn(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution, 'targetEndpointProfileIds'), false);
  assert.equal(Object.hasOwn(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].importRole, 'sourceProfileId'), false);
  assert.equal(Object.hasOwn(attributeEndpointsApplied.json.spec.result.diagrams[0].edgeMappings[0].importRole, 'targetProfileId'), false);
  assert.equal(attributeEndpointsApplied.json.spec.result.diagrams[0].authoring.d2Import.endpointProfiles.length, 2);

  const missingDirectionPolicy = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree,
    endpointProfiles: attributeEndpointProfiles,
    relationRules: [{
      ...topologyContract,
      id: 'router_switch_network_missing_direction',
      kind: 'connection',
      mode: 'attributeEndpoints',
      directionPolicy: '',
      directionPolicySuggestion: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'selection:routers',
      sourceField: 'Code',
      targetField: 'Code',
      sourceOperator: 'equals',
      targetOperator: 'equals',
      endpointOperator: 'equals',
      labelField: 'Code'
    }]
  }, headers);
  assert.equal(missingDirectionPolicy.statusCode, 200, missingDirectionPolicy.body);
  assert.equal(missingDirectionPolicy.json.status, 'complete', missingDirectionPolicy.body);
  assert.equal(missingDirectionPolicy.json.partial, false);
  assert.equal(missingDirectionPolicy.json.d2Workflow.state, 'applied');
  assert.equal(missingDirectionPolicy.json.spec.result.diagrams[0].edgeMappings.length, 1);
  assert.equal(missingDirectionPolicy.json.spec.result.diagrams[0].edgeMappings[0].endpointResolution.directionPolicy, 'dataFields');

  const formattingRefresh = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/refresh`, {
    templateCode: 'NetworkImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec: applied.json.spec,
    d2Source: `${source}\n\n# presentation-only comment`
  }, headers);
  assert.equal(formattingRefresh.statusCode, 200, formattingRefresh.body);
  assert.equal(formattingRefresh.json.d2Workflow.state, 'applied');
  assert.equal(formattingRefresh.json.spec.result.diagrams[0].authoring.d2Import.source.endsWith('# presentation-only comment'), true);

  const structuralRefresh = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/refresh`, {
    templateCode: 'NetworkImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec: applied.json.spec,
    d2Source: `${source}\nswitch -> router: reverse`
  }, headers);
  assert.equal(structuralRefresh.statusCode, 409, structuralRefresh.body);
  assert.equal(structuralRefresh.json.code, 'diagram_import_source_changed');

  const importsRejected = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'NetworkImport',
    currentSpec,
    d2Source: 'x: @other'
  }, headers);
  assert.equal(importsRejected.statusCode, 422, importsRejected.body);
  assert.match(importsRejected.json.message, /imports are not allowed/i);
  assert.equal(backend.exitCode, null);
});

test('preview ignores retired generic D2 topology specifications', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=network-endpoint-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20`, {
    template: {
      code: 'NetworkEndpoints',
      spec: {
        version: 1,
        steps: [{ type: 'selectCards', as: 'dummy', className: 'ARM', filters: [], columns: ['Code'], limit: 1 }],
        result: {
          tables: [{ name: 'dummy', columns: ['Code'] }],
          diagrams: [{
            id: 'network-endpoints', name: 'networkEndpoints', type: 'topology',
            nodeMappings: [
              { id: 'host', staticRows: [{ _id: 'host-1', Description: 'Host 10.0.0.8', ip: '10.0.0.8' }], fields: { id: '_id', label: 'Description' }, endpointFields: ['ip'], importRole: { key: 'host' } },
              { id: 'range', staticRows: [{ _id: 'range-1', Description: 'Network 10.0.0.0/24', range: '10.0.0.0/24' }], fields: { id: '_id', label: 'Description' }, endpointFields: ['range'], importRole: { key: 'range' } }
            ],
            edgeMappings: [{
              id: 'acl-edge', type: 'networkEndpoints', staticRows: [
                { sourceIp: '10.0.0.8', targetIp: '10.0.0.77', label: 'ACL allow' },
                { sourceIp: '10.0.0.8', targetIp: '203.0.113.5', label: 'ACL outside' },
                { sourceIp: '10.0.0.77', targetIp: '10.0.0.8', label: 'ACL reverse roles' }
              ],
              fields: { source: 'sourceIp', target: 'targetIp', label: 'label' },
              endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'template' },
              importRole: { key: 'acl-edge', sourceKey: 'host', targetKey: 'range' }
            }]
          }]
        }
      }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.diagrams, []);
  assert.equal(preview.json.result.d2Workflow.state, 'none');
  assert.equal(backend.exitCode, null);
});

test('preview does not execute retired role-aware generic D2 topology specifications', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-role-placement-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20`, {
    template: {
      code: 'RoleAwarePlacement',
      spec: {
        version: 1,
        steps: [{ type: 'selectCards', as: 'dummy', className: 'ARM', filters: [], columns: ['Code'], limit: 1 }],
        result: {
          tables: [{ name: 'dummy', columns: ['Code'] }],
          diagrams: [{
            id: 'role-aware-placement', name: 'roleAwarePlacement', type: 'topology',
            groupMappings: [
              { id: 'external-group', staticRows: [{ _id: 'external-container', Description: 'External systems' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'external-group', structureItemId: 'external' } },
              { id: 'dmz-group', staticRows: [{ _id: 'dmz-container', Description: 'DMZ' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'dmz-group', structureItemId: 'dmz' } },
              { id: 'target-group', staticRows: [{ _id: 'target-container', Description: 'Target zone' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'target-group', structureItemId: 'target' } }
            ],
            nodeMappings: [
              { id: 'external', staticRows: [{ _id: 'external-1', Description: 'External system', ip: '10.10.0.8', Class: 'IS' }], fields: { id: '_id', label: 'Description' }, endpointFields: ['ip'], importRole: { key: 'external-system', structureItemId: 'external-node', parentStructureItemId: 'external' } },
              { id: 'internal', staticRows: [{ _id: 'internal-1', Description: 'Internal system', ip: '10.10.0.8', Class: 'IS' }], fields: { id: '_id', label: 'Description' }, endpointFields: ['ip'], importRole: { key: 'internal-system', structureItemId: 'internal-node' } },
              { id: 'vlans-dmz', staticRows: [{ _id: 'vlan-dmz', Description: 'DMZ VLAN', isNAT: true, Class: 'vlan' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'vlan', structureItemId: 'vlan-dmz', parentStructureItemId: 'dmz' } },
              { id: 'vlans-target', staticRows: [{ _id: 'vlan-target', Description: 'Target VLAN', isNAT: false, Class: 'vlan' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'vlan', structureItemId: 'vlan-target', parentStructureItemId: 'target' } }
            ],
            edgeMappings: [{
              id: 'role-aware-edge', type: 'networkEndpoints', staticRows: [{ sourceIp: '10.10.0.8', targetIp: '10.10.0.8', label: 'ACL' }],
              fields: { source: 'sourceIp', target: 'targetIp', label: 'label' }, endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'template' },
              importRole: { key: 'acl', sourceKey: 'external-system', targetKey: 'internal-system' }
            }],
            structureTree: {
              version: 5,
              items: [
                { id: 'external', roleId: 'external-group', templateContextKey: 'external', templateElementKey: 'external-group', templateElementKeys: ['external-group'], parentId: '', mapping: d2StaticPlacementMapping('external', 'external-group') },
                { id: 'external-node', roleId: 'external-system', templateContextKey: 'external-node', templateElementKey: 'external-system', templateElementKeys: ['external-system'], parentId: 'external', mapping: d2StaticPlacementMapping('external-node', 'external-system') },
                { id: 'dmz', roleId: 'dmz-group', templateContextKey: 'dmz', templateElementKey: 'dmz-group', templateElementKeys: ['dmz-group'], parentId: '', mapping: d2StaticPlacementMapping('dmz', 'dmz-group') },
                { id: 'target', roleId: 'target-group', templateContextKey: 'target', templateElementKey: 'target-group', templateElementKeys: ['target-group'], parentId: '', mapping: d2StaticPlacementMapping('target', 'target-group') },
                { id: 'vlan-dmz', roleId: 'vlan', templateContextKey: 'vlan-dmz', templateElementKey: 'vlan', templateElementKeys: ['vlan'], parentId: 'dmz', mapping: d2StaticPlacementMapping('vlan-dmz', 'vlan') },
                { id: 'vlan-target', roleId: 'vlan', templateContextKey: 'vlan-target', templateElementKey: 'vlan', templateElementKeys: ['vlan'], parentId: 'target', mapping: d2StaticPlacementMapping('vlan-target', 'vlan') }
              ]
            }
          }]
        }
      }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.diagrams, []);
  assert.equal(preview.json.result.d2Workflow.state, 'none');
  assert.equal(backend.exitCode, null);
});

test('Extraction preview skips diagram building and D2 rendering', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=table-extraction-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&includeDiagrams=false`, {
    template: {
      code: 'TableExtractionOnly',
      spec: {
        version: 1,
        steps: [{ type: 'selectCards', as: 'arms', className: 'ARM', filters: [], columns: ['Code'], limit: 20 }],
        result: {
          tables: [{ name: 'arms', columns: ['Code'] }],
          diagrams: [{
            id: 'must-not-build',
            name: 'mustNotBuild',
            type: 'topology',
            nodeMappings: [{
              id: 'static-node',
              staticRows: [{ _id: 'node-1', Description: 'Diagram node' }],
              fields: { id: '_id', label: 'Description' },
              importRole: { key: 'static-node' }
            }],
            edgeMappings: [{
              id: 'invalid-network-endpoint-policy',
              type: 'networkEndpoints',
              staticRows: [{ sourceIp: '10.0.0.1', targetIp: '10.0.0.2' }],
              fields: { source: 'sourceIp', target: 'targetIp' },
              endpointResolution: { strategy: 'ipv4ObjectThenRange' }
            }]
          }]
        }
      }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json.success, true);
  assert.deepEqual(preview.json.result.diagrams, []);
  assert.ok(preview.json.result.tables.find((table) => table.name === 'arms')?.rows.length > 0);
  assert.equal(backend.exitCode, null);
});

test('Extraction preview materializes all readable direct attributes for its selected result only', async (t) => {
  const mock = await startMockCmdbuild(t, {
    classes: [{ _id: 1, name: 'Widget', description: 'Widget', active: true }],
    attributesByClass: {
      Widget: [
        { name: 'Code', type: 'string', active: true, _can_read: true },
        { name: 'Owner', type: 'lookup', active: true, _can_read: true },
        { name: 'PortalUrl', type: 'url', active: true, _can_read: true },
        { name: 'UnsafeUrl', type: 'url', active: true, _can_read: true },
        { name: 'SerialNumber', type: 'string', active: true, _can_read: true }
      ]
    },
    cardsByClass: {
      Widget: [{
        _id: 41,
        Code: 'W-001',
        Description: 'Selected widget',
        Owner: 7,
        _Owner_description: 'Operations team',
        PortalUrl: '<a href="https://portal.example/widgets/41">Widget page</a>',
        UnsafeUrl: '<a href="javascript:alert(1)">Unsafe page</a>',
        SerialNumber: 'SN-42'
      }]
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=materialized-extraction-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&includeDiagrams=false&extractionSource=widgets`, {
    template: {
      code: 'MaterializedExtraction',
      spec: {
        version: 1,
        steps: [{ type: 'selectCards', as: 'widgets', className: 'Widget', filters: [], columns: ['Code'], limit: 20 }],
        result: { tables: [{ name: 'widgets', columns: ['Code'] }] }
      }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const table = preview.json.result.tables.find((item) => item.name === 'widgets');
  assert.ok(table, preview.body);
  assert.ok(table.columns.includes('Owner'));
  assert.ok(table.columns.includes('SerialNumber'));
  assert.equal(table.rows[0].Owner, 'Operations team');
  assert.equal(table.rows[0].SerialNumber, 'SN-42');
  assert.equal(table.rows[0].PortalUrl, 'https://portal.example/widgets/41');
  assert.equal(table.cellMeta[0].PortalUrl.autoHref, 'https://portal.example/widgets/41');
  assert.equal(table.rows[0].UnsafeUrl, 'javascript:alert(1)');
  assert.equal(table.cellMeta[0].UnsafeUrl.autoHref, undefined);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/Widget/cards/41')), true);
  assert.equal(backend.exitCode, null);
});

test('relation result tables normalize typed fields by related card class and reuse attribute metadata', async (t) => {
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'Source', description: 'Source', active: true },
      { _id: 2, name: 'Target', description: 'Target', active: true }
    ],
    attributesByClass: {
      Source: [
        { name: 'Owner', type: 'string', active: true, _can_read: true },
        { name: 'PortalUrl', type: 'string', active: true, _can_read: true }
      ],
      Target: [
        { name: 'Owner', type: 'lookup', active: true, _can_read: true },
        { name: 'PortalUrl', type: 'url', active: true, _can_read: true },
        { name: 'DisplayOnly', type: 'string', active: true, _can_read: true }
      ]
    },
    cardsByClass: {
      Source: [{
        _id: 11,
        Code: 'SOURCE-1',
        Description: 'Source card',
        Owner: 'source-owner',
        PortalUrl: 'https://source.example/item/11'
      }],
      Target: [{
        _id: 21,
        Code: 'TARGET-1',
        Description: 'Target card',
        Owner: 7,
        _Owner_description: 'Target owner',
        PortalUrl: '<a href="https://target.example/item/21">Target page</a>',
        DisplayOnly: 'Materialized direct attribute'
      }]
    },
    relationsByCard: {
      'Source:11': [{
        _id: 31,
        domain: 'SourceTarget',
        _sourceType: 'Source', _sourceId: 11, _sourceCode: 'SOURCE-1', _sourceDescription: 'Source card',
        _destinationType: 'Target', _destinationId: 21, _destinationCode: 'TARGET-1', _destinationDescription: 'Target card',
        _direction: 'direct'
      }]
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=relation-normalization-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&includeDiagrams=false`, {
    template: {
      code: 'RelationNormalization',
      spec: {
        version: 1,
        steps: [
          { type: 'selectCards', as: 'sources', className: 'Source', filters: [], columns: ['Owner', 'PortalUrl'], limit: 20 },
          { type: 'expandRelations', as: 'relatedOne', from: 'sources', domain: 'SourceTarget', targetClass: 'Target', direction: 'source', columns: ['Owner', 'PortalUrl'], limit: 20 },
          { type: 'expandRelations', as: 'relatedTwo', from: 'sources', domain: 'SourceTarget', targetClass: 'Target', direction: 'source', columns: ['Owner', 'PortalUrl'], limit: 20 }
        ],
        result: {
          tables: [
            { name: 'relatedOne', columns: ['Owner', 'PortalUrl', 'Source_Owner', 'Source_PortalUrl'] },
            { name: 'relatedTwo', columns: [] }
          ]
        }
      }
    },
    params: {}
  }, headers);

  assert.equal(preview.statusCode, 200, preview.body);
  const first = preview.json.result.tables.find((table) => table.name === 'relatedOne');
  const second = preview.json.result.tables.find((table) => table.name === 'relatedTwo');
  assert.equal(first.rows[0].Owner, 'Target owner');
  assert.equal(first.rows[0].PortalUrl, 'https://target.example/item/21');
  assert.equal(first.cellMeta[0].PortalUrl.autoHref, 'https://target.example/item/21');
  assert.equal(first.rows[0].Source_Owner, 'source-owner');
  assert.equal(first.rows[0].Source_PortalUrl, 'https://source.example/item/11');
  assert.equal(first.cellMeta[0].Source_PortalUrl?.autoHref, undefined);
  assert.equal(second.rows[0].Owner, 'Target owner');
  assert.ok(second.columns.includes('DisplayOnly'));
  assert.equal(second.rows[0].DisplayOnly, 'Materialized direct attribute');
  assert.equal(mock.requests.filter((item) => item.pathname === '/cmdbuild/services/rest/v3/classes/Target/attributes').length, 1);
  assert.equal(backend.exitCode, null);
});

test('all relation execution paths use the shared runtime per-card limit', async (t) => {
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'Source', description: 'Source', active: true },
      { _id: 2, name: 'Target', description: 'Target', active: true }
    ],
    attributesByClass: {
      Source: [{ name: 'Name', type: 'string', active: true, _can_read: true }],
      Target: [{ name: 'Value', type: 'string', active: true, _can_read: true }]
    },
    cardsByClass: {
      Source: [{ _id: 11, Code: 'SOURCE-1', Description: 'Source card', Name: 'Source 1' }],
      Target: [
        { _id: 21, Code: 'TARGET-1', Description: 'Target one', Value: 'one' },
        { _id: 22, Code: 'TARGET-2', Description: 'Target two', Value: 'two' }
      ]
    },
    relationsByCard: {
      'Source:11': [
        {
          _id: 31,
          domain: 'SourceTarget',
          _sourceType: 'Source', _sourceId: 11, _sourceCode: 'SOURCE-1', _sourceDescription: 'Source card',
          _destinationType: 'Target', _destinationId: 21, _destinationCode: 'TARGET-1', _destinationDescription: 'Target one',
          _direction: 'direct'
        },
        {
          _id: 32,
          domain: 'SourceTarget',
          _sourceType: 'Source', _sourceId: 11, _sourceCode: 'SOURCE-1', _sourceDescription: 'Source card',
          _destinationType: 'Target', _destinationId: 22, _destinationCode: 'TARGET-2', _destinationDescription: 'Target two',
          _direction: 'direct'
        }
      ]
    },
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRelationsPerCardDefault: 1, maxRelationsPerCardMax: 4 } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=relation-limit-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&includeDiagrams=false`, {
    template: {
      code: 'SharedRelationLimit',
      spec: {
        version: 1,
        steps: [
          { type: 'selectCards', as: 'sources', className: 'Source', filters: [], columns: [], limit: 20 },
          // A legacy per-step limit must not override the Runtime relation bound.
          { type: 'expandRelations', as: 'targets', from: 'sources', domain: 'SourceTarget', targetClass: 'Target', direction: 'source', limit: 20, columns: [] }
        ],
        result: { tables: [{ name: 'targets', columns: [] }] }
      }
    },
    params: {}
  }, headers);

  assert.equal(preview.statusCode, 200, preview.body);
  const targets = preview.json.result.tables.find((table) => table.name === 'targets');
  assert.deepEqual(targets.rows.map((row) => row.Value), ['one']);
  assert.equal(targets.truncated, true);
  const relationTrace = preview.json.result.trace.find((item) => item.as === 'targets');
  assert.ok(relationTrace.limitDiagnostics.some((item) => item.limitName === 'maxRelationsPerCard'));
  const relationRead = mock.requests.find((item) => item.pathname === '/cmdbuild/services/rest/v3/classes/Source/cards/11/relations');
  assert.ok(relationRead, JSON.stringify(mock.requests));
  assert.equal(new URLSearchParams(relationRead.search).get('limit'), '2');
  assert.equal(backend.exitCode, null);
});

test('table extraction ignores incomplete D2 mapping and diagram preview excludes template exemplars', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    CMDP_D2_BINARY: `${process.cwd()}/tests/fixtures/d2-render-stub.mjs`
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=pending-d2-preview-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const source = 'router: Router';
  const spec = {
    version: 1,
    authoring: { version: 1, d2: { source, sourceHash: crypto.createHash('sha256').update(source).digest('hex') } },
    steps: [
      { type: 'selectCards', as: 'arms', className: 'ARM', filters: [], columns: ['Code', 'Description'], limit: 20 },
      { type: 'selectCards', as: 'staleDiagramStep', className: 'MissingPreviewClass', filters: [], columns: ['Code'], limit: 20, managedBy: 'd2ImportV3' }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Code', 'Description'] }],
      diagrams: [{
        id: 'pending-d2',
        name: 'pendingD2',
        type: 'topology',
        authoring: {
          d2Import: {
            version: 3,
            source,
            sourceHash: crypto.createHash('sha256').update(source).digest('hex'),
            mappingValidation: { version: 1, status: 'needsValidation' }
          }
        }
      }]
    }
  };

  const extraction = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&includeDiagrams=false`, {
    template: { code: 'PendingD2Extraction', spec },
    params: {}
  }, headers);
  assert.equal(extraction.statusCode, 200, extraction.body);
  assert.equal(extraction.json.success, true);
  assert.deepEqual(extraction.json.result.trace.map((item) => item.as), ['arms']);
  assert.equal(extraction.json.result.tables[0].rows.length, 3);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/MissingPreviewClass/cards')), false);

  const diagramPreview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&executionScope=diagrams`, {
    template: { code: 'PendingD2Preview', spec },
    params: {}
  }, headers);
  assert.equal(diagramPreview.statusCode, 200, diagramPreview.body);
  assert.equal(diagramPreview.json.success, true);
  assert.equal(diagramPreview.json.result.d2Workflow.state, 'pending');
  assert.equal(diagramPreview.json.result.diagnosticPreview.state, 'unavailable');
  assert.deepEqual(diagramPreview.json.result.diagnosticPreview.diagrams, []);
  assert.match(diagramPreview.json.result.diagnosticPreview.message, /No template example objects are shown/);

  const strictValidation = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: { code: 'PendingD2Validation', spec },
    params: {}
  }, headers);
  assert.equal(strictValidation.statusCode, 400, strictValidation.body);
  assert.equal(strictValidation.json.success, false);
  assert.ok(strictValidation.json.errors.some((item) => item.code === 'd2_authoring_reanalysis_required'));
  assert.equal(backend.exitCode, null);
});

test('diagram-only preview does not execute retired generic D2 topology specifications', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-scope-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=20&executionScope=diagrams`, {
    template: {
      code: 'DiagramScopeOnly',
      spec: {
        version: 1,
        steps: [
          { type: 'selectCards', as: 'unrelatedRouter', className: 'routerG', filters: [], columns: ['Code'], limit: 20 },
          { type: 'selectCards', as: 'diagramArms', className: 'ARM', filters: [], columns: ['Code', 'Description'], limit: 20 }
        ],
        result: {
          tables: [{ name: 'diagramArms', columns: ['Code', 'Description'] }],
          diagrams: [{
            id: 'scope-diagram',
            name: 'scopeDiagram',
            type: 'topology',
            nodeMappings: [{
              id: 'scope-nodes',
              from: 'diagramArms',
              fields: { id: '_id', label: 'Description' },
              importRole: { key: 'arm' }
            }]
          }]
        }
      }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.diagrams, []);
  assert.equal(preview.json.result.d2Workflow.state, 'none');
  assert.equal(backend.exitCode, null);
});

test('diagram preview uses the configured execution bound and does not duplicate inherited row-limit diagnostics', async (t) => {
  const cards = Array.from({ length: 30 }, (_, index) => ({
    _id: index + 1,
    Code: index < 28 ? `NOISE-${index + 1}` : ['INTERNAL-DNS', 'INTERNAL-AD'][index - 28],
    Description: index < 28 ? `Noise ${index + 1}` : ['DNS', 'AD'][index - 28]
  }));
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'TestItem', description: 'Test item', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { TestItem: [{ name: 'Code', type: 'string', active: true, _can_read: true }] },
    cardsByClass: { TestItem: cards },
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRowsDataPreviewDefault: 100 } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('diagram-preview-execution-bound');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const spec = {
    version: 1,
    steps: [
      { type: 'selectCards', as: 'allSystems', className: 'TestItem', limit: 100, filters: [], columns: ['Code', 'Description'] },
      { type: 'filterRows', as: 'internalSystems', from: 'allSystems', filters: [{ column: 'Code', op: 'startsWith', value: 'INTERNAL-' }] }
    ],
    result: {
      tables: [{ name: 'internalSystems', columns: ['Code', 'Description'] }],
      diagrams: [{
        id: 'internal-systems', name: 'internalSystems', type: 'topology',
        maxNodes: 20,
        nodeMappings: [{ id: 'internal-system', from: 'internalSystems', fields: { id: '_id', label: 'Description' }, importRole: { key: 'internal_system' } }]
      }]
    }
  };

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=100&executionScope=diagrams`, {
    template: { code: 'DiagramPreviewExecutionBound', spec }, params: {}
  }, headers);

  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.tables[0].rows.map((row) => row.Description), ['DNS', 'AD']);
  assert.deepEqual(preview.json.result.diagrams, []);
  assert.equal(preview.json.result.limits.maxRows >= 30, true);
  assert.equal(preview.json.result.trace.some((item) => /MCP context/i.test(item.warning || '')), false);
  assert.deepEqual(preview.json.result.limitDiagnostics, []);
  assert.equal(backend.exitCode, null);
});

test('D2 import preview adds frames for styled Markdown nodes', async (t) => {
  const mock = await startMockCmdbuild(t);
  const backendPort = await freePort();
  await startBackend(t, backendPort, mock.origin, {
    CMDP_D2_BINARY: `${process.cwd()}/tests/fixtures/d2-render-stub.mjs`
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-markdown-frame-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'assets', className: 'ARM', columns: ['Code'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'MarkdownFrameImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    d2Source: 'markdown-frame: Preview'
  }, headers);

  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.equal(analyzed.json.preview.rendered, true);
  assert.match(analyzed.json.preview.content, /data-cmdp-d2-markdown-frame="true"/);
  assert.match(analyzed.json.preview.content, /fill="#EFF6FF" stroke="#1D4ED8" stroke-width="2" rx="8" stroke-dasharray="14,14" x="20" y="30" width="180" height="64"/);
  assert.match(analyzed.json.preview.content, /Markdown frame preview/);
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

test('D2 import keeps untyped containers as source-free frames and places mapped nodes inside them', async (t) => {
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
  assert.equal(users.visualKind, 'container');
  assert.equal(analyzed.json.proposal.structureTree.items.some((item) => item.roleId === users.id && item.mapping.materialization.kind === 'structural'), true);
  assert.equal(analyzed.json.proposal.roles.some((role) => role.key === 'users.operator'), false);
  const workstationItems = analyzed.json.proposal.structureTree.items.filter((item) => item.roleId === workstation.id);
  assert.equal(workstationItems.length, 1);
  assert.deepEqual(workstationItems[0].templateElementKeys, ['users.administrator', 'users.operator']);
  assert.equal(analyzed.json.proposal.unresolved.length, 1);
  const roles = [d2RoleOverride(workstation, {
      materialization: { kind: 'stage', stageId: 'selection:workstations' },
      primary: {
        className: 'ARM',
        idAttribute: '_id',
        labelTemplate: '${Code} ${Description}',
        structuredFields: ['Code', 'Description', 'model', 'model2'],
        filters: []
      },
      related: []
    }), d2RoleOverride(users)];
  const structureTree = d2StructureTreeWithMaterialization(analyzed.json.proposal, roles);

  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    roles,
    structureTree
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  const diagram = applied.json.spec.result.diagrams[0];
  assert.equal(diagram.nodeMappings.length, 1);
  assert.equal(diagram.nodeMappings.every((mapping) => mapping.importRole.key === 'workstation'), true);
  assert.equal(diagram.groupMappings.length, 1);
  assert.equal(diagram.groupMappings[0].importRole.key, 'users');
  assert.deepEqual(diagram.hierarchyMappings, []);
  assert.equal(diagram.authoring.d2Import.version, 3);
  assert.equal(diagram.placementRules, undefined);
  assert.equal(diagram.authoring.d2Import.structureTree.version, 5);
  assert.deepEqual(
    diagram.authoring.d2Import.structureTree.items.map((item) => [item.id, item.roleId, item.parentId, item.mapping.materialization.kind, item.mapping.materialization.stageId, item.mapping.primary.labelTemplate]),
    structureTree.items.map((item) => [item.id, item.roleId, item.parentId, item.mapping.materialization.kind, item.mapping.materialization.stageId, item.mapping.primary.labelTemplate])
  );
  assert.equal(diagram.authoring.d2Import.structureTree.items.every((item) => item.mapping.conditions && Array.isArray(item.mapping.conditions.rules)), true);

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=10`, {
    template: {
      code: 'CompositeImport',
      spec: {
        ...applied.json.spec,
        authoring: { ...applied.json.spec.authoring, bodyLimitProbe: 'x'.repeat(70 * 1024) }
      }
    },
    params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const previewDiagram = preview.json.result.diagrams[0];
  assert.ok(previewDiagram.nodes.length > 0);
  assert.equal(previewDiagram.groups.length, 1);
  assert.equal(previewDiagram.nodes.every((node) => node.group === previewDiagram.groups[0].id), true, JSON.stringify(previewDiagram));
  assert.doesNotMatch(previewDiagram.nodes.map((node) => node.label).join('\n'), /model2-a/);
  assert.match(previewDiagram.d2.source, /vars:\s+\{/);
  assert.match(previewDiagram.d2.source, /model2/);
  assert.match(previewDiagram.d2.source, /model2-a/);
  assert.doesNotMatch(previewDiagram.d2.source, /users\.operator|users\.administrator/);
  assert.equal(backend.exitCode, null);
});

test('D2 interpretation retries an invalid container visual kind with the node/container contract', async (t) => {
  const readRoles = ({ request }) => JSON.parse(request.messages.at(-1).content).roles;
  const llm = await startLiteLlmStub(t, {
    responses: [
      ({ request }) => {
        return {
          decisions: readRoles({ request }).map((role) => ({
            roleId: role.id,
            visualKind: 'node',
            confidence: 'high',
            reason: role.isContainer ? 'Incorrect container decision.' : 'Node decision.'
          }))
        };
      },
      ({ request }) => {
        return {
          decisions: readRoles({ request }).map((role) => role.isContainer
            ? {
                roleId: role.id,
                visualKind: 'container',
                confidence: 'high',
                reason: 'Container remains a structural D2 container.'
              }
            : { roleId: role.id, visualKind: 'node', confidence: 'high', reason: 'Node decision.' })
        };
      }
    ]
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
  const cookie = 'CMDBuild-Authorization=d2-semantic-retry-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'applications', className: 'ARM', columns: ['Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'SemanticRetryImport',
    currentSpec,
    d2Source: 'container-class users: { operator: Operator; administrator: Administrator }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const containerRole = analyzed.json.proposal.roles.find((role) => role.key === 'application_group');
  assert.ok(containerRole, analyzed.body);
  assert.equal(containerRole.visualKind, 'container');
  assert.equal(containerRole.repeatModeOptions, undefined);
  assert.deepEqual(containerRole.allowedOwnerRoleIds, []);

  const interpreted = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/interpret`, {
    prompt: 'Interpret the supplied D2 roles.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);

  assert.equal(interpreted.statusCode, 200, interpreted.body);
  const decision = interpreted.json.decisions.find((item) => item.roleId === containerRole.id);
  assert.equal(decision.visualKind, 'container');
  assert.equal(decision.repeatMode, undefined);
  assert.equal(decision.ownerRoleId, undefined);
  assert.equal(interpreted.json.diagnostics.attempts, 2);
  assert.equal(llm.requests, 2);
  const correctionMessage = llm.lastRequest.messages.find((message) => (
    message.role === 'system' && String(message.content || '').includes('previous response was rejected')
  ));
  assert.ok(correctionMessage, llm.lastRequest.messages);
  assert.match(correctionMessage.content, new RegExp(containerRole.id));
  assert.match(correctionMessage.content, /allowed visual kind/);
  assert.equal(backend.exitCode, null);
});

test('D2 interpretation accepts a container without role-level repeat or owner settings', async (t) => {
  const readRoles = ({ request }) => JSON.parse(request.messages.at(-1).content).roles;
  const llm = await startLiteLlmStub(t, {
    responses: [({ request }) => ({
      decisions: readRoles({ request }).map((role) => role.isContainer
        ? { roleId: role.id, visualKind: 'container', confidence: 'medium', reason: 'Structural visual frame.' }
        : { roleId: role.id, visualKind: 'node', confidence: 'medium', reason: 'Node decision.' })
    })]
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
  const cookie = 'CMDBuild-Authorization=d2-repeat-fallback-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'applications', className: 'ARM', columns: ['Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'RepeatFallbackImport',
    currentSpec,
    d2Source: 'container-class users: { operator: Operator; administrator: Administrator }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const containerRole = analyzed.json.proposal.roles.find((role) => role.key === 'application_group');
  assert.ok(containerRole, analyzed.body);

  const interpreted = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/interpret`, {
    prompt: 'Interpret the supplied D2 roles.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);

  assert.equal(interpreted.statusCode, 200, interpreted.body);
  assert.equal(interpreted.json.decisions.find((item) => item.roleId === containerRole.id).visualKind, 'container');
  assert.equal(interpreted.json.diagnostics.attempts, 1);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('D2 interpretation uses the template-specific system prompt from currentSpec', async (t) => {
  const globalPrompt = 'GLOBAL D2 INTERPRETATION PROMPT';
  const templatePrompt = 'TEMPLATE D2 INTERPRETATION PROMPT';
  const llm = await startLiteLlmStub(t, {
    responses: [({ request }) => ({
      decisions: JSON.parse(request.messages.at(-1).content).roles.map((role) => ({
        roleId: role.id,
        visualKind: role.isContainer ? 'container' : 'node',
        confidence: 'high',
        reason: 'Confirmed by template-specific policy.'
      }))
    })]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({
        assistant: {
          llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' },
          prompt: { diagramSemantics: globalPrompt }
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
  const cookie = testCmdbuildAuthorizationCookie('d2-template-prompt-override-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const d2Source = 'workstation: Workstation';
  const currentSpec = {
    ...apiObjectFlowSpec([{ alias: 'workstations', className: 'ARM', columns: ['Code', 'Description'] }]),
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: { context: '', blocks: [] },
        promptContractVersion: 3,
        diagramSemanticsPrompt: '',
        diagramPlacementPrompt: '',
        diagramConnectionsPrompt: '',
        systemPromptOverrides: { diagramSemantics: templatePrompt }
      },
      d2: { source: d2Source }
    }
  };
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'TemplatePromptD2Import',
    currentSpec,
    d2Source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);

  const interpreted = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/interpret`, {
    prompt: 'Interpret the supplied D2 roles.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);

  assert.equal(interpreted.statusCode, 200, interpreted.body);
  assert.ok(llm.lastRequest.messages.some((message) => message.role === 'system' && message.content === templatePrompt), JSON.stringify(llm.lastRequest));
  assert.equal(llm.lastRequest.messages.some((message) => message.content === globalPrompt), false, JSON.stringify(llm.lastRequest));
  const assistantPayload = JSON.parse(llm.lastRequest.messages.at(-1).content);
  assert.equal(assistantPayload.models.d2StructuralModel.kind, 'D2StructuralModel');
  assert.equal(assistantPayload.models.d2StructuralModel.version, 1);
  assert.match(assistantPayload.models.d2StructuralModel.modelHash, /^[a-f0-9]{64}$/);
  assert.equal(interpreted.json.models.d2SemanticModel.kind, 'D2SemanticModel');
  assert.equal(interpreted.json.models.d2StructuralModel.modelHash, assistantPayload.models.d2StructuralModel.modelHash);
  assert.equal(backend.exitCode, null);
});

test('D2 interpretation reports an invalid container visual kind by visible role name', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [
      ({ request }) => ({
        decisions: JSON.parse(request.messages.at(-1).content).roles.map((role) => ({
          roleId: role.id,
          visualKind: 'node',
          reason: role.isContainer ? 'Invalid container decision.' : 'Node decision.'
        }))
      }),
      ({ request }) => ({
        decisions: JSON.parse(request.messages.at(-1).content).roles.map((role) => ({
          roleId: role.id,
          visualKind: 'node',
          reason: role.isContainer ? 'Invalid container decision again.' : 'Node decision.'
        }))
      })
    ]
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
  const cookie = 'CMDBuild-Authorization=d2-semantic-diagnostic-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'applications', className: 'ARM', columns: ['Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'SemanticDiagnosticImport',
    currentSpec,
    d2Source: 'container-class users: { operator: Operator; administrator: Administrator }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);

  const interpreted = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/interpret`, {
    prompt: 'Interpret the supplied D2 roles.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: []
  }, headers);

  assert.equal(interpreted.statusCode, 422, interpreted.body);
  assert.equal(interpreted.json.code, 'assistant_diagram_stage_invalid');
  assert.equal(llm.requests, 2);
  assert.deepEqual(interpreted.json.errors[0].allowedVisualKinds, ['container']);
  assert.equal(interpreted.json.errors[0].displayName, 'application_group');
  assert.match(interpreted.json.errors[0].message, /application_group/);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping rejects direct CMDB paths and requires an Object Flow connection result', async (t) => {
  const diagramResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    if (Array.isArray(payload.topology)) {
      assert.equal(Object.prototype.hasOwnProperty.call(payload.topology[0], 'directPaths'), false);
      return {
        relationRules: [{
          d2ElementKey: payload.topology[0].d2ElementKey,
          mode: 'direct',
          pathId: 'not-offered'
        }]
      };
    }
    const stages = d2AssistantPayloadStages(payload);
    return {
      mappings: payload.placements.map((placement, index) => ({
        structureItemId: placement.structureItemId,
        materialization: placement.allowedMaterialization.includes('stage') ? 'stage' : 'structural',
        stageId: placement.allowedMaterialization.includes('stage')
          ? stages[index % stages.length].id
          : '',
        reason: 'Mapped to the corresponding deterministic result.'
      }))
    };
  };
  const llm = await startLiteLlmStub(t, {
    responses: [diagramResponse, diagramResponse, diagramResponse]
  });
  const mock = await startMockCmdbuild(t, {
    domains: [{
      _id: 'AssetReference', name: 'AssetReference', source: 'routerG', sources: ['routerG'],
      destination: 'ARM', destinations: ['ARM'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }, {
      _id: 'AclRouter', name: 'AclRouter', source: 'ACL', sources: ['ACL'],
      destination: 'routerG', destinations: ['routerG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-catalog-path-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'routers', className: 'routerG', columns: ['Code', 'Description'] },
    { alias: 'workstations', className: 'ARM', columns: ['Code', 'Description'] },
    { alias: 'acls', className: 'ACL', columns: ['Code', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'CatalogPathImport', currentSpec, d2Source: 'router: Router\nworkstation: Workstation\nrouter -> workstation: link'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const invalid = await requestD2MappingStages(backendOrigin, headers, {
    prompt: 'Map the roles and connection.', currentSpec, proposal: analyzed.json.proposal, roles, traversalDepth: 1
  });
  assert.equal(invalid.statusCode, 422, invalid.body);
  assert.ok(invalid.json.errors.some((error) => /Unsupported D2 connection mode direct/.test(error.message)), invalid.body);
  assert.equal(invalid.json.partial, true, invalid.body);
  assert.ok(invalid.json.mappings.some((mapping) => mapping.structureItemId), invalid.body);
  assert.equal(invalid.json.mapping.mappedRoles, invalid.json.mapping.requiredRoles, invalid.body);
  assert.equal(invalid.json.models.d2BindingModel.placements.length, invalid.json.mappings.length, invalid.body);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping validates a partial placement draft before starting topology', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [({ request }) => {
      const payload = JSON.parse(request.messages.at(-1).content);
      assert.ok(Array.isArray(payload.placements), JSON.stringify(payload));
      const [mapped, ...unresolved] = payload.placements;
      return {
        mappings: [{
          structureItemId: mapped.structureItemId,
          materialization: 'stage',
          stageId: 'selection:applications',
          conditions: {
            rules: [{
              operator: 'equals',
              left: { column: 'NotMaterialized' },
              right: { kind: 'literal', value: 'active' }
            }]
          }
        }],
        unresolved: unresolved.map((placement) => ({
          structureItemId: placement.structureItemId,
          reason: 'noCompatibleStage',
          message: 'No compatible result was selected for this placement.'
        }))
      };
    }]
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
  const cookie = 'CMDBuild-Authorization=test-session';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclIntrasystem', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'PartialPlacementValidation', currentSpec, d2Source: 'same-role-edges'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;
  const response = await requestJson('POST', endpoint, {
    prompt: 'Map only independently valid placements.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role)),
    stage: 'roles',
    resumeId: crypto.randomUUID()
  }, headers, 5000);

  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'assistant_diagram_stage_retry');
  assert.equal(response.json.retryKind, 'correction');
  assert.equal(response.json.resume.nextStage, 'roles');
  assert.equal(response.json.diagnostics.executionValidation.checked, true);
  assert.equal(response.json.diagnostics.executionValidation.failures, 1);
  assert.ok(response.json.errors.some((error) => error.code === 'diagram_placement_condition_invalid' && /NotMaterialized/.test(error.message)), response.body);
  assert.equal(llm.requests, 1, 'topology must not call the provider before partial placement validation succeeds');
  assert.equal(JSON.parse(llm.requestLog[0].messages.at(-1).content).topology, undefined);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping resumes the topology stage without repeating confirmed role mapping', async (t) => {
  const roleResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    return {
      mappings: d2PlacementMappings(payload, 'selection:applications', 'Applications are materialized by the selected result.')
    };
  };
  const topologyResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    const connection = payload.topology[0];
    const candidate = connection.networkEndpointStages.find((item) => item.sourceStageId === 'selection:aclIntrasystem');
    return {
      relationRules: [{
        d2ClassKey: connection.d2ClassKey,
        mode: 'networkEndpoints',
        candidateId: candidate.candidateId,
        sourceStageId: candidate.sourceStageId,
        sourceField: candidate.sourceField,
        targetField: candidate.targetField,
        labelField: candidate.labelField
      }]
    };
  };
  const llm = await startLiteLlmStub(t, {
    delays: [0, 1200, 250],
    responses: [roleResponse, topologyResponse, topologyResponse]
  });
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
  const cookie = 'CMDBuild-Authorization=d2-resume-topology-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclIntrasystem', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'ResumeTopologyMapping', currentSpec, d2Source: 'same-role-edges'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const body = {
    prompt: 'Map applications and one dedicated ACL relation result.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles
  };
  const resumeId = crypto.randomUUID();
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;
  const accepted = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers, 5000);
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(accepted.json.checkpoint.nextStage, 'topology');
  assert.equal(llm.requests, 1);

  const timedOut = await requestJson('POST', endpoint, { ...body, stage: 'topology', resumeId }, headers, 5000);
  assert.equal(timedOut.statusCode, 504, timedOut.body);
  assert.equal(timedOut.json.retryable, true, timedOut.body);
  assert.equal(timedOut.json.resume.resumeId, resumeId);
  assert.equal(timedOut.json.resume.nextStage, 'topology');
  assert.equal(timedOut.json.diagnostics.stage, 'topology');
  assert.equal(timedOut.json.diagnostics.rolesReused, true);
  assert.match(timedOut.json.message, /сопоставление связей/);
  assert.match(timedOut.json.message, /сопоставление объектов сохранено временно/);
  assert.equal(timedOut.json.models.d2BindingModel.kind, 'D2BindingModel');
  assert.equal(timedOut.json.models.coverageModel.kind, 'CoverageModel');
  assert.equal(timedOut.json.models.coverageModel.status, 'partial');
  assert.deepEqual({
    requiredConnections: timedOut.json.models.coverageModel.requiredConnections,
    mappedConnections: timedOut.json.models.coverageModel.mappedConnections
  }, { requiredConnections: 1, mappedConnections: 0 });
  assert.equal(llm.requests, 2);

  const concurrentResumes = await Promise.all([
    requestJson('POST', endpoint, { ...body, stage: 'topology', resumeId }, headers, 5000),
    requestJson('POST', endpoint, { ...body, stage: 'topology', resumeId }, headers, 5000)
  ]);
  assert.deepEqual(concurrentResumes.map((response) => response.statusCode).sort((left, right) => left - right), [200, 409]);
  const resumed = concurrentResumes.find((response) => response.statusCode === 200);
  const contended = concurrentResumes.find((response) => response.statusCode === 409);
  assert.ok(resumed, concurrentResumes.map((response) => response.body).join('\n'));
  assert.equal(contended.json.success, false, contended.body);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json.mapping.status, 'complete');
  assert.deepEqual(resumed.json.mapping.connectionCoverage, { mapped: 1, required: 1 });
  assert.equal(resumed.json.diagnostics.phases.roles, 'accepted');
  assert.equal(resumed.json.diagnostics.phases.topology, 'accepted');
  assert.equal(resumed.json.models.dataSemanticModel.kind, 'DataSemanticModel');
  assert.equal(resumed.json.models.d2StructuralModel.kind, 'D2StructuralModel');
  assert.equal(resumed.json.models.d2BindingModel.kind, 'D2BindingModel');
  assert.equal(resumed.json.models.coverageModel.kind, 'CoverageModel');
  assert.equal(resumed.json.models.coverageModel.status, 'complete');
  const rolePayload = JSON.parse(llm.requestLog[0].messages.at(-1).content);
  const topologyPayload = JSON.parse(llm.requestLog.at(-1).messages.at(-1).content);
  assert.equal(rolePayload.prompt, body.prompt);
  assert.equal(rolePayload.stages, undefined);
  assert.equal(rolePayload.models.dataSemanticModel.kind, 'DataSemanticModel');
  assert.equal(rolePayload.models.d2StructuralModel.kind, 'D2StructuralModel');
  assert.equal(topologyPayload.prompt, body.prompt);
  assert.equal(topologyPayload.models.d2BindingModel.kind, 'D2BindingModel');
  assert.equal(llm.requests, 3, 'concurrent resume claims must produce exactly one provider call');
  assert.equal(backend.exitCode, null);
});

test('D2 mapping with named business blocks completes intent, placement, connections, and semantic critic stages', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        const blocks = payload.models.businessBlockManifest.blocks;
        const applicationBlock = blocks.find((block) => block.name === 'Applications');
        const aclBlock = blocks.find((block) => block.name === 'ACL links');
        return {
          placementBindings: payload.placements.map((placement) => {
            const materializationIntent = placement.allowedMaterialization.includes('stage') ? 'stage' : placement.allowedMaterialization[0];
            return {
              structureItemId: placement.structureItemId,
              materializationIntent,
              ...(materializationIntent === 'stage' ? { businessBlockId: applicationBlock.id } : {})
            };
          }),
          connectionBindings: payload.connections.map((connection) => ({ d2ClassKey: connection.d2ClassKey, businessBlockId: aclBlock.id })),
          unresolved: []
        };
      },
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        const connection = payload.topology[0];
        const candidate = connection.networkEndpointStages[0];
        return {
          relationRules: [{
            d2ClassKey: connection.d2ClassKey,
            mode: 'attributeEndpoints',
            candidateId: candidate.candidateId,
            sourceStageId: candidate.sourceStageId,
            sourceField: candidate.sourceField,
            targetField: candidate.targetField
          }]
        };
      },
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        assert.equal(payload.models.semanticObligationMatrix.status, 'satisfied');
        return { approved: true, violations: [] };
      }
    ]
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
  const cookie = 'CMDBuild-Authorization=d2-business-intent-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclLinks', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const objectMatching = currentSpec.visualModels.find((model) => model.mode === 'objectMatching');
  objectMatching.outputs = objectMatching.outputs.map((output) => ({
    ...output,
    assistantManaged: true,
    assistantBlockIds: [output.alias === 'applications' ? 'block-applications' : 'block-acl']
  }));
  currentSpec.authoring = {
    version: 1,
    assistant: {
      objectFlowIntent: {
        context: 'Build one application topology.',
        blocks: [
          { id: 'block-applications', name: 'Applications', entities: 'ApplicG', algorithm: 'Select application cards.', expectedResult: 'Application cards.', uses: [] },
          { id: 'block-acl', name: 'ACL links', entities: 'ACL', algorithm: 'Select ACL edge cards.', expectedResult: 'ACL cards with source and destination fields.', uses: [] }
        ]
      }
    },
    d2: { source: '' }
  };
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'BusinessIntentMapping', currentSpec, d2Source: 'same-role-edges'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const body = {
    prompt: 'Map exact named business results.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role))
  };
  const resumeId = crypto.randomUUID();
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;
  for (const [stage, nextStage] of [['roles', 'roles'], ['roles', 'topology'], ['topology', 'topology']]) {
    const response = await requestJson('POST', endpoint, { ...body, stage, resumeId }, headers, 5000);
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json.checkpoint.nextStage, nextStage, response.body);
    if (stage === 'roles' && nextStage === 'topology') assert.equal(response.json.diagnostics.source, 'confirmed-binding-intent');
  }
  const completed = await requestJson('POST', endpoint, { ...body, stage: 'topology', resumeId }, headers, 5000);
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json.mapping.status, 'complete', completed.body);
  assert.equal(completed.json.endpointProfiles.length, completed.json.mapping.requiredRoles, completed.body);
  assert.ok(completed.json.endpointProfiles.every((profile) => profile.field === 'Description' && profile.operators.includes('equals')), completed.body);
  assert.equal(completed.json.relationRules[0].sourceOperator, 'equals');
  assert.equal(completed.json.relationRules[0].targetOperator, 'equals');
  assert.equal(completed.json.diagnostics.phases.intent, 'accepted');
  assert.equal(completed.json.diagnostics.phases.critique, 'accepted');
  assert.equal(llm.requests, 2, 'the confirmed intent must compile without another model placement decision');
  const connectionPayload = JSON.parse(llm.requestLog[1].messages.at(-1).content);
  assert.deepEqual(connectionPayload.topology[0].networkEndpointStages.map((candidate) => candidate.sourceStageId), ['selection:aclLinks']);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping resumes a timed-out roles stage before starting topology', async (t) => {
  const roleResponse = ({ request }) => ({
    mappings: d2PlacementMappings(
      JSON.parse(request.messages.at(-1).content),
      'selection:applications',
      'Applications are materialized by the selected result.'
    )
  });
  const invalidRoleResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    const invalid = payload.placements.find((placement) => placement.visualKind === 'node') || payload.placements[0];
    return {
      mappings: d2PlacementMappings(payload, 'selection:applications').map((mapping) => (
        mapping.structureItemId === invalid.structureItemId
          ? { structureItemId: mapping.structureItemId, materialization: 'structural', reason: 'Invalid materialization for correction coverage.' }
          : mapping
      ))
    };
  };
  const topologyResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    const connection = payload.topology[0];
    const candidate = connection.networkEndpointStages.find((item) => item.sourceStageId === 'selection:aclIntrasystem');
    return {
      relationRules: [{
        d2ClassKey: connection.d2ClassKey,
        mode: 'networkEndpoints',
        candidateId: candidate.candidateId,
        sourceStageId: candidate.sourceStageId,
        sourceField: candidate.sourceField,
        targetField: candidate.targetField,
        labelField: candidate.labelField
      }]
    };
  };
  const llm = await startLiteLlmStub(t, {
    delays: [1200, 0, 0, 0],
    responses: [roleResponse, invalidRoleResponse, roleResponse, topologyResponse]
  });
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
  const cookie = 'CMDBuild-Authorization=d2-resume-roles-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclIntrasystem', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'ResumeRolesMapping', currentSpec, d2Source: 'same-role-edges'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const body = {
    prompt: 'Map applications and one dedicated ACL relation result.',
    currentSpec,
    proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role))
  };
  const resumeId = crypto.randomUUID();
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;

  const timedOut = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers, 5000);
  assert.equal(timedOut.statusCode, 504, timedOut.body);
  assert.equal(timedOut.json.retryable, true, timedOut.body);
  assert.equal(timedOut.json.resume.resumeId, resumeId);
  assert.equal(timedOut.json.resume.nextStage, 'roles');
  assert.equal(timedOut.json.resume.automaticRetriesRemaining, 0);
  assert.equal(timedOut.json.resume.correctionRetriesRemaining, 2);
  assert.equal(timedOut.json.diagnostics.stage, 'roles');
  assert.equal(timedOut.json.diagnostics.rolesReused, false);
  assert.equal(llm.requests, 1);

  const correction = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers, 5000);
  assert.equal(correction.statusCode, 422, correction.body);
  assert.equal(correction.json.retryKind, 'correction');
  assert.equal(correction.json.resume.nextStage, 'roles');
  assert.equal(correction.json.resume.automaticRetriesRemaining, 0);
  assert.equal(correction.json.resume.correctionRetriesRemaining, 1);
  assert.equal(llm.requests, 2);

  const roles = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers, 5000);
  assert.equal(roles.statusCode, 202, roles.body);
  assert.equal(roles.json.checkpoint.nextStage, 'topology');
  assert.equal(llm.requests, 3);

  const topology = await requestJson('POST', endpoint, { ...body, stage: 'topology', resumeId }, headers, 5000);
  assert.equal(topology.statusCode, 200, topology.body);
  assert.equal(topology.json.mapping.status, 'complete');
  assert.deepEqual(topology.json.mapping.connectionCoverage, { mapped: 1, required: 1 });
  assert.equal(llm.requests, 4);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping combines same-class arrows into one Object Flow relation contract', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        return {
          mappings: d2PlacementMappings(payload, 'selection:applications', 'Applications are materialized by the selected result.')
        };
      },
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        assert.equal(payload.topology.length, 1);
        assert.equal(payload.topology[0].d2ClassKey, 'acl_intrasystem');
        assert.deepEqual(payload.topology[0].d2ElementKeys.sort(), ['application_a_b_1', 'application_a_b_2']);
        assert.match(payload.topology[0].notes, /Dedicated ACL result/);
        assert.equal(payload.topology[0].sourceRoleId, payload.topology[0].targetRoleId);
        const candidate = payload.topology[0].networkEndpointStages.find((item) => item.sourceStageId === 'selection:aclIntrasystem');
        return {
          relationRules: [{
            d2ClassKey: payload.topology[0].d2ClassKey,
            mode: 'networkEndpoints',
            candidateId: candidate.candidateId,
            sourceStageId: candidate.sourceStageId,
            sourceField: candidate.sourceField,
            targetField: candidate.targetField,
            labelField: candidate.labelField
          }]
        };
      }
    ]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-same-role-connection-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclIntrasystem', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'SameRoleConnections', currentSpec, d2Source: 'same-role-edges'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.equal(analyzed.json.proposal.relationRules.length, 1);
  assert.equal(analyzed.json.proposal.relationRules[0].d2ClassKey, 'acl_intrasystem');
  assert.equal(Object.hasOwn(analyzed.json.proposal.relationRules[0], 'parentRoleId'), false);
  assert.equal(Object.hasOwn(analyzed.json.proposal.relationRules[0], 'childRoleId'), false);
  assert.deepEqual(analyzed.json.proposal.relationRules[0].d2ElementKeys.sort(), ['application_a_b_1', 'application_a_b_2']);
  assert.match(analyzed.json.proposal.relationRules[0].d2Notes, /Dedicated ACL result/);

  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const mapped = await requestD2MappingStages(backendOrigin, headers, {
    prompt: 'Map applications and one dedicated ACL relation result for the acl_intrasystem class.', currentSpec, proposal: analyzed.json.proposal, roles
  });
  assert.equal(mapped.statusCode, 200, mapped.body);
  assert.equal(mapped.json.mapping.status, 'complete');
  assert.deepEqual([mapped.json.mapping.requiredConnections, mapped.json.mapping.mappedConnections], [1, 1]);
  assert.equal(mapped.json.relationRules.length, 1);
  assert.equal(mapped.json.relationRules[0].d2ClassKey, 'acl_intrasystem');
  assert.equal(mapped.json.connectionUnresolved.length, 0);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping leaves an omitted connection result unresolved instead of auto-selecting a unique candidate', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        return { mappings: d2PlacementMappings(payload, 'selection:applications', 'Application result.') };
      },
      () => ({ relationRules: [] })
    ]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-missing-connection-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclIntrasystem', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'MissingDedicatedConnection', currentSpec, d2Source: 'same-role-edges'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const mapped = await requestD2MappingStages(backendOrigin, headers, {
    prompt: 'Map only confirmed D2 relation results.', currentSpec, proposal: analyzed.json.proposal, roles
  });

  assert.equal(mapped.statusCode, 200, mapped.body);
  assert.equal(mapped.json.mapping.status, 'partial');
  assert.deepEqual(mapped.json.mapping.objectCoverage, { mapped: 1, required: 1 });
  assert.deepEqual(mapped.json.mapping.connectionCoverage, { mapped: 0, required: 1 });
  assert.equal(mapped.json.relationRules.length, 0);
  assert.equal(mapped.json.connectionUnresolved.length, 1);
  assert.equal(mapped.json.connectionUnresolved[0].code, 'missingDedicatedConnectionResult');
  assert.equal(backend.exitCode, null);
});

test('D2 mapping requires separate named Object Flow results for different D2 relation classes', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        return {
          mappings: d2PlacementMappings(payload, 'selection:applications', 'Application result.')
        };
      },
      ({ request }) => {
        const payload = JSON.parse(request.messages.at(-1).content);
        const shared = payload.topology[0].networkEndpointStages.find((item) => item.sourceStageId === 'selection:aclHttp');
        return {
          relationRules: payload.topology.map((connection) => ({
            d2ElementKey: connection.d2ElementKey,
            mode: 'networkEndpoints',
            candidateId: shared.candidateId,
            sourceStageId: shared.sourceStageId,
            sourceField: shared.sourceField,
            targetField: shared.targetField,
            labelField: shared.labelField
          }))
        };
      }
    ]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-dedicated-connection-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'applications', className: 'ApplicG', columns: ['_id', 'Code', 'Description'] },
    { alias: 'aclHttp', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] },
    { alias: 'applicationDependencies', className: 'ACL', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'DedicatedConnections', currentSpec, d2Source: 'multiple-relation-classes'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.deepEqual(analyzed.json.proposal.relationRules.map((rule) => rule.d2ClassKey).sort(), ['acl_intrasystem', 'application_dependency']);

  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const mapped = await requestD2MappingStages(backendOrigin, headers, {
    prompt: 'Map each D2 relation class to a dedicated result.', currentSpec, proposal: analyzed.json.proposal, roles
  });
  assert.equal(mapped.statusCode, 200, mapped.body);
  assert.equal(mapped.json.mapping.status, 'partial');
  assert.deepEqual([mapped.json.mapping.requiredConnections, mapped.json.mapping.mappedConnections], [2, 0]);
  assert.equal(mapped.json.relationRules.length, 0);
  assert.equal(mapped.json.connectionUnresolved.length, 2);
  assert.ok(mapped.json.connectionUnresolved.every((item) => item.code === 'sharedConnectionResult'), mapped.body);
  assert.match(mapped.json.connectionUnresolved[0].message, /separate named result/);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping reports an uncovered placement without inventing a container stage', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [({ request }) => {
      const payload = JSON.parse(request.messages.at(-1).content);
      const placement = payload.placements.find((item) => item.visualKind !== 'container') || payload.placements[0];
      return { mappings: [], unresolved: [{ structureItemId: placement.structureItemId, reason: 'noCompatibleStage', message: 'No dedicated source stage exists.' }] };
    }]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-partial-mapping-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'applications', className: 'ARM', columns: ['Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'PartialMappingImport', currentSpec, d2Source: 'container-class users: { operator: Operator; administrator: Administrator }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const mapped = await requestD2MappingStages(backendOrigin, headers, {
    prompt: 'Map every dynamic role or state why no source exists.', currentSpec, proposal: analyzed.json.proposal, roles
  });

  assert.equal(mapped.statusCode, 422, mapped.body);
  assert.equal(mapped.json.code, 'assistant_diagram_stage_retry');
  assert.equal(mapped.json.retryable, true);
  assert.equal(mapped.json.retryKind, 'correction');
  assert.equal(mapped.json.resume.nextStage, 'roles');
  assert.equal(mapped.json.mapping.status, 'partial');
  assert.deepEqual([mapped.json.mapping.mappedRoles, mapped.json.mapping.requiredRoles], [0, 1]);
  assert.equal(mapped.json.mappings.length, 0);
  assert.equal(mapped.json.mapping.unresolved[0].code, 'assistantOmittedPlacement');
  assert.equal(mapped.json.mapping.unresolved[0].displayName, 'application_group');
  assert.equal(mapped.json.mapping.requiredContainers, 1);
  assert.equal(mapped.json.mapping.mappedContainers, 0);
  assert.equal(mapped.json.diagnostics.attempts, 1);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping reports complete when every node role is covered by an Object Flow result', async (t) => {
  const llm = await startLiteLlmStub(t, {
    responses: [({ request }) => {
      const payload = JSON.parse(request.messages.at(-1).content);
      return { mappings: d2PlacementMappings(payload, d2AssistantPayloadStages(payload)[0].id, 'Node source.') };
    }]
  });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-complete-mapping-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'applications', className: 'ARM', columns: ['Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'CompleteMappingImport', currentSpec, d2Source: 'container-class users: { operator: Operator; administrator: Administrator }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const mapped = await requestD2MappingStages(backendOrigin, headers, {
    prompt: 'Map every dynamic role.', currentSpec, proposal: analyzed.json.proposal, roles
  });

  assert.equal(mapped.statusCode, 200, mapped.body);
  assert.equal(mapped.json.mapping.status, 'complete');
  assert.deepEqual([mapped.json.mapping.mappedRoles, mapped.json.mapping.requiredRoles], [1, 1]);
  assert.deepEqual([mapped.json.mapping.mappedContainers, mapped.json.mapping.requiredContainers], [1, 1]);
  assert.deepEqual(mapped.json.mapping.unresolved, []);
  assert.equal(mapped.json.mappings.length, 2);
  assert.equal(mapped.json.diagnostics.attempts, 1);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping recovers an invalid parentCard response with one deterministic container source', async (t) => {
  const invalidParentCardResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    assert.ok(Array.isArray(payload.placements), JSON.stringify(payload));
    return {
      mappings: payload.placements.map((placement) => ({
        structureItemId: placement.structureItemId,
        materialization: placement.visualKind === 'container' ? 'structural' : 'parentCard',
        reason: 'Use the container card for the child.'
      })),
      unresolved: []
    };
  };
  const llm = await startLiteLlmStub(t, { responses: [invalidParentCardResponse] });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-parent-card-recovery-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'workstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'ParentCardRecoveryImport', currentSpec, d2Source: 'container-class users: { operator: Operator }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => d2RoleOverride(role));
  const mapped = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`, {
    prompt: 'Map the available workstation result to the D2 container and child.', currentSpec, proposal: analyzed.json.proposal, roles
  }, headers);

  assert.equal(mapped.statusCode, 200, mapped.body);
  assert.equal(mapped.json.mapping.status, 'complete');
  assert.equal(mapped.json.errors.length, 0);
  assert.equal(mapped.json.diagnostics.attempts, 1);
  assert.equal(llm.requests, 1);
  const container = mapped.json.mappings.find((item) => item.mapping?.materialization?.kind === 'stage');
  const child = mapped.json.mappings.find((item) => item.mapping?.materialization?.kind === 'parentCard');
  assert.equal(container?.source?.stageId, 'selection:workstations');
  assert.equal(child?.source?.stageId, 'selection:workstations');
  assert.ok(mapped.json.warnings.some((warning) => /parentCard/i.test(warning)), JSON.stringify(mapped.json.warnings));
  assert.equal(backend.exitCode, null);
});

test('D2 mapping rejects conflicting duplicate placements with an explicit correction contract', async (t) => {
  let conflictingItemId = '';
  const response = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    const [first, ...rest] = payload.placements;
    conflictingItemId = first.structureItemId;
    return {
      mappings: [
        { structureItemId: first.structureItemId, materialization: 'parentCard', reason: 'Use an inherited card.' },
        { structureItemId: first.structureItemId, materialization: 'stage', stageId: 'selection:workstations', reason: 'Direct result is executable.' },
        ...rest.map((placement) => ({ structureItemId: placement.structureItemId, materialization: 'stage', stageId: 'selection:workstations', reason: 'Direct result.' }))
      ]
    };
  };
  const llm = await startLiteLlmStub(t, { responses: [response] });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-duplicate-container-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'workstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] },
    { alias: 'otherWorkstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'DuplicateContainerMapping', currentSpec, d2Source: 'container-class scope_server: { server: Server }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const resumeId = crypto.randomUUID();
  const mapped = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`, {
    prompt: 'Map the server scope and server node.', currentSpec, proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role)),
    stage: 'roles',
    resumeId
  }, headers);

  assert.equal(mapped.statusCode, 422, mapped.body);
  assert.equal(mapped.json.success, false);
  assert.equal(mapped.json.code, 'assistant_diagram_stage_retry');
  assert.equal(mapped.json.retryable, true);
  assert.equal(mapped.json.retryKind, 'correction');
  assert.equal(mapped.json.resume.resumeId, resumeId);
  assert.equal(mapped.json.resume.nextStage, 'roles');
  const conflict = mapped.json.errors.find((error) => error.code === 'diagram_placement_duplicate');
  assert.ok(conflict, mapped.body);
  assert.equal(conflict.path, '$.mappings[1].structureItemId');
  assert.equal(conflict.structureItemId, conflictingItemId);
  assert.equal(mapped.json.partial, true);
  assert.equal(mapped.json.mappings.length, 1);
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping deduplicates exact-identical placements before completing the roles stage', async (t) => {
  const response = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    const [first, ...rest] = payload.placements;
    const duplicate = {
      structureItemId: first.structureItemId,
      materialization: 'stage',
      stageId: 'selection:workstations',
      reason: 'Direct result is executable.'
    };
    return {
      mappings: [
        duplicate,
        structuredClone(duplicate),
        ...rest.map((placement) => ({
          structureItemId: placement.structureItemId,
          materialization: 'stage',
          stageId: 'selection:workstations',
          reason: 'Direct result.'
        }))
      ]
    };
  };
  const llm = await startLiteLlmStub(t, { responses: [response] });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-identical-duplicate-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'workstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] },
    { alias: 'otherWorkstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'IdenticalDuplicateMapping', currentSpec, d2Source: 'container-class scope_server: { server: Server }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const resumeId = crypto.randomUUID();
  const mapped = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`, {
    prompt: 'Map the server scope and server node.', currentSpec, proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role)),
    stage: 'roles',
    resumeId
  }, headers);

  assert.equal(mapped.statusCode, 202, mapped.body);
  assert.equal(mapped.json.success, true);
  assert.equal(mapped.json.checkpoint.nextStage, 'topology');
  assert.deepEqual([mapped.json.mapping.mappedRoles, mapped.json.mapping.requiredRoles], [2, 2]);
  assert.equal(mapped.json.models.d2BindingModel.kind, 'D2BindingModel');
  assert.equal(mapped.json.models.d2BindingModel.placements.length, 2);
  assert.equal(new Set(mapped.json.models.d2BindingModel.placements.map((placement) => placement.structureItemId)).size, 2);
  assert.ok(mapped.json.warnings.some((warning) => /идентичные варианты объединены/i.test(warning)), JSON.stringify(mapped.json.warnings));
  assert.equal(llm.requests, 1);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping resumes only invalid placements and keeps its partial role draft', async (t) => {
  const firstResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    const nodePlacement = payload.placements.find((placement) => placement.visualKind === 'node');
    assert.ok(nodePlacement, JSON.stringify(payload.placements));
    return {
      mappings: payload.placements.map((placement, index) => ({
        structureItemId: placement.structureItemId,
        materialization: 'stage',
        stageId: index === 0 ? 'selection:workstations' : 'selection:workstations',
        reason: 'Direct result.'
      })).concat({
        structureItemId: nodePlacement.structureItemId,
        materialization: 'stage',
        stageId: 'selection:otherWorkstations',
        reason: 'Conflicting duplicate result.'
      })
    };
  };
  const invalidCorrectionResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    assert.equal(payload.placements.length, 1, JSON.stringify(payload.placements));
    assert.equal(payload.placements[0].visualKind, 'node');
    assert.equal(payload.models.d2BindingModel.kind, 'D2BindingModel');
    assert.equal(payload.models.d2BindingModel.placements.length, 1);
    return {
      mappings: [{ structureItemId: payload.placements[0].structureItemId, materialization: 'structural', reason: 'Invalid node mapping.' }]
    };
  };
  const correctionResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    assert.equal(payload.placements.length, 1, JSON.stringify(payload.placements));
    assert.equal(payload.placements[0].visualKind, 'node');
    assert.equal(payload.models.d2BindingModel.kind, 'D2BindingModel');
    assert.equal(payload.models.d2BindingModel.placements.length, 1);
    return {
      mappings: [{ structureItemId: payload.placements[0].structureItemId, materialization: 'stage', stageId: 'selection:workstations', reason: 'Direct result.' }]
    };
  };
  const llm = await startLiteLlmStub(t, { responses: [firstResponse, invalidCorrectionResponse, correctionResponse] });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-branch-resume-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([
    { alias: 'workstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] },
    { alias: 'otherWorkstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] }
  ]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'BranchResumeMapping', currentSpec, d2Source: 'container-class scope_server: { server: Server }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const body = {
    prompt: 'Map the server scope and server node.', currentSpec, proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role))
  };
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;
  const resumeId = crypto.randomUUID();
  const rejected = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers);
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json.retryKind, 'correction');
  assert.equal(rejected.json.partial, true);
  assert.equal(rejected.json.resume.resumeId, resumeId);
  assert.equal(rejected.json.mappings.length, 1);

  const secondRejected = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers);
  assert.equal(secondRejected.statusCode, 422, secondRejected.body);
  assert.equal(secondRejected.json.retryKind, 'correction');
  assert.equal(secondRejected.json.partial, true);
  assert.ok(secondRejected.json.errors.some((error) => error.code === 'diagram_materialization_not_allowed'), secondRejected.body);
  assert.equal(secondRejected.json.resume.resumeId, resumeId);

  const resumed = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers);
  assert.equal(resumed.statusCode, 202, resumed.body);
  assert.equal(resumed.json.checkpoint.nextStage, 'topology');
  assert.deepEqual([resumed.json.mapping.mappedRoles, resumed.json.mapping.requiredRoles], [2, 2]);
  assert.equal(llm.requests, 3);
  assert.equal(backend.exitCode, null);
});

test('D2 mapping retries Assistant-omitted placements but preserves explicit unresolved decisions', async (t) => {
  const firstResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    assert.equal(payload.placements.length, 2, JSON.stringify(payload.placements));
    return { mappings: d2PlacementMappings({ placements: [payload.placements[0]] }, d2AssistantPayloadStages(payload)[0].id, 'First confirmed placement.') };
  };
  const correctionResponse = ({ request }) => {
    const payload = JSON.parse(request.messages.at(-1).content);
    assert.equal(payload.placements.length, 1, JSON.stringify(payload.placements));
    return { mappings: d2PlacementMappings(payload, d2AssistantPayloadStages(payload)[0].id, 'Recovered omitted placement.') };
  };
  const llm = await startLiteLlmStub(t, { responses: [firstResponse, correctionResponse] });
  const mock = await startMockCmdbuild(t, {
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-omitted-placement-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = apiObjectFlowSpec([{ alias: 'workstations', className: 'ARM', columns: ['_id', 'Code', 'Description'] }]);
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'OmittedPlacementRecovery', currentSpec, d2Source: 'container-class scope_server: { server: Server }'
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const body = {
    prompt: 'Map every placement or explicitly explain why no stage is compatible.', currentSpec, proposal: analyzed.json.proposal,
    roles: analyzed.json.proposal.roles.map((role) => d2RoleOverride(role))
  };
  const endpoint = `${backendOrigin}/cmdbuild/custom-api/assistant/diagram-import/map-selections`;
  const resumeId = crypto.randomUUID();
  const rejected = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers);
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json.retryKind, 'correction');
  assert.equal(rejected.json.partial, true);
  assert.ok(rejected.json.mapping.unresolved.some((item) => item.code === 'assistantOmittedPlacement'), rejected.body);

  const resumed = await requestJson('POST', endpoint, { ...body, stage: 'roles', resumeId }, headers);
  assert.equal(resumed.statusCode, 202, resumed.body);
  assert.deepEqual([resumed.json.mapping.mappedRoles, resumed.json.mapping.requiredRoles], [2, 2]);
  assert.equal(llm.requests, 2);
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
    d2Source: response.json.proposal.sourceText,
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

test('saved D2 Assistant checkpoint restores a fresh signed proposal without LiteLLM', async (t) => {
  const baseSpec = { version: 1, steps: [], result: { tables: [] } };
  const source = 'router: Router';
  const initialSpec = {
    ...baseSpec,
    authoring: {
      version: 1,
      assistant: { objectFlowIntent: { context: '', blocks: [] }, diagramInterpretPrompt: '', diagramMappingPrompt: '' },
      d2: { source }
    }
  };
  const mock = await startMockCmdbuild(t, { templates: [templateCard('RestoreD2Checkpoint', initialSpec, { canUpdate: true })] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, {
    CMDP_D2_IMPORT_ASSISTANT_CHECKPOINT_MAX_BYTES: '16384'
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-restore-checkpoint-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'RestoreD2Checkpoint', baseSpecHash: hashJson(initialSpec), currentSpec: initialSpec, d2Source: source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const proposal = analyzed.json.proposal;
  const analysisCheckpoint = {
    version: 1,
    proposalId: proposal.proposalId,
    deterministicSpecHash: proposal.deterministicSpecHash,
    deterministicSpecRevision: proposal.deterministicSpecRevision,
    source: {
      hash: proposal.source.hash,
      structureHash: proposal.source.structureHash,
      mappingContractHash: proposal.source.mappingContractHash
    },
    roles: proposal.roles.map((role) => ({ id: role.id, visualKind: role.visualKind, labelTemplate: role.labelTemplate })),
    relationRules: proposal.relationRules,
    structureTree: proposal.structureTree
  };
  const assistantCheckpoint = {
    ...analysisCheckpoint,
    version: 1,
    interpretation: { explanation: 'Saved interpretation', warnings: [], decisions: [] },
    mapping: { explanation: 'Saved mapping', warnings: [], result: { mapping: { status: 'partial', mappedRoles: 0, requiredRoles: 1 } } }
  };
  const restored = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: 'RestoreD2Checkpoint', baseSpecHash: hashJson(initialSpec), currentSpec: initialSpec, analysisCheckpoint, assistantCheckpoint
  }, headers);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json.action, 'diagram-import-restore');
  assert.equal(restored.json.restoreKind, 'assistant');
  assert.equal(restored.json.proposal.proposalId, analysisCheckpoint.proposalId);
  assert.ok(restored.json.proposal.signature, restored.body);
  assert.equal(restored.json.interpretation.explanation, 'Saved interpretation');
  assert.equal(restored.json.mapping.result.mapping.status, 'partial');

  const oversizedAnalysisCheckpoint = {
    ...analysisCheckpoint,
    relationRules: [{ id: 'checkpoint-size-test', padding: 'x'.repeat(17 * 1024) }]
  };
  const oversizedAnalysis = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: 'RestoreD2Checkpoint',
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    analysisCheckpoint: oversizedAnalysisCheckpoint
  }, headers);
  assert.equal(oversizedAnalysis.statusCode, 422, oversizedAnalysis.body);
  assert.equal(oversizedAnalysis.json.code, 'd2_import_restore_failed');
  assert.match(oversizedAnalysis.json.message, /analysisCheckpoint exceeded configured maxBytes=16384/);

  const oversizedAssistantCheckpoint = structuredClone(assistantCheckpoint);
  oversizedAssistantCheckpoint.mapping.result.padding = 'x'.repeat(17 * 1024);
  const oversizedAssistant = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: 'RestoreD2Checkpoint',
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    analysisCheckpoint,
    assistantCheckpoint: oversizedAssistantCheckpoint
  }, headers);
  assert.equal(oversizedAssistant.statusCode, 200, oversizedAssistant.body);
  assert.equal(oversizedAssistant.json.restoreKind, 'analysis');
  assert.match(oversizedAssistant.json.assistantRestoreWarning, /assistantCheckpoint exceeded configured maxBytes=16384/);

  const changed = structuredClone(initialSpec);
  changed.steps.push({ type: 'selectCards', as: 'routers', className: 'routerG', columns: ['Code'], limit: 10 });
  const conflict = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: '', currentSpec: changed, analysisCheckpoint
  }, headers);
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json.code, 'd2_import_analysis_checkpoint_spec_conflict');
  assert.equal(backend.exitCode, null);
});

test('saved deterministic D2 analysis restores without an Assistant checkpoint', async (t) => {
  const baseSpec = { version: 1, steps: [], result: { tables: [] } };
  const source = 'router: Router';
  const initialSpec = {
    ...baseSpec,
    authoring: {
      version: 1,
      assistant: { objectFlowIntent: { context: '', blocks: [] }, diagramInterpretPrompt: '', diagramMappingPrompt: '' },
      d2: { source }
    }
  };
  const mock = await startMockCmdbuild(t, { templates: [templateCard('RestoreD2Analysis', initialSpec, { canUpdate: true })] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-restore-analysis-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'RestoreD2Analysis', baseSpecHash: hashJson(initialSpec), currentSpec: initialSpec, d2Source: source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const proposal = analyzed.json.proposal;
  const analysisCheckpoint = {
    version: 1,
    proposalId: proposal.proposalId,
    deterministicSpecHash: proposal.deterministicSpecHash,
    deterministicSpecRevision: proposal.deterministicSpecRevision,
    source: {
      hash: proposal.source.hash,
      structureHash: proposal.source.structureHash,
      mappingContractHash: proposal.source.mappingContractHash
    },
    roles: proposal.roles.map((role) => ({ id: role.id, visualKind: role.visualKind, labelTemplate: role.labelTemplate })),
    relationRules: proposal.relationRules,
    structureTree: proposal.structureTree
  };
  const restoreUrl = `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`;
  const restoreBody = {
    templateCode: 'RestoreD2Analysis', baseSpecHash: hashJson(initialSpec),
    currentSpec: { ...initialSpec, result: { ...initialSpec.result, presentation: { outputMode: 'tables' } } },
    analysisCheckpoint
  };
  const restored = await requestJson('POST', restoreUrl, restoreBody, headers);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json.restoreKind, 'analysis');
  assert.equal(restored.json.proposal.proposalId, analysisCheckpoint.proposalId);
  assert.equal(restored.json.proposal.deterministicSpecHash, proposal.deterministicSpecHash);
  assert.equal(restored.json.proposal.deterministicSpecRevision, proposal.deterministicSpecRevision);
  assert.ok(restored.json.proposal.signature, restored.body);
  assert.deepEqual(restored.json.interpretation, {});
  assert.deepEqual(restored.json.mapping, {});
  const retiredCheckpoint = { ...analysisCheckpoint, deterministicSpecHash: hashJson(baseSpec) };
  delete retiredCheckpoint.deterministicSpecRevision;
  const retired = await requestJson('POST', restoreUrl, { ...restoreBody, analysisCheckpoint: retiredCheckpoint }, headers);
  assert.equal(retired.statusCode, 409, retired.body);
  assert.equal(retired.json.code, 'd2_import_analysis_checkpoint_revision');
  assert.match(retired.json.message, /Analyze the current D2 source again/);
  const staleHash = await requestJson('POST', restoreUrl, {
    ...restoreBody, analysisCheckpoint: { ...analysisCheckpoint, deterministicSpecHash: retiredCheckpoint.deterministicSpecHash }
  }, headers);
  assert.equal(staleHash.statusCode, 409, staleHash.body);
  assert.equal(staleHash.json.code, 'd2_import_analysis_checkpoint_spec_conflict');
  const fallback = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: 'RestoreD2Analysis',
    baseSpecHash: hashJson(initialSpec),
    currentSpec: initialSpec,
    analysisCheckpoint,
    assistantCheckpoint: { version: 1 }
  }, headers);
  assert.equal(fallback.statusCode, 200, fallback.body);
  assert.equal(fallback.json.restoreKind, 'analysis');
  assert.match(fallback.json.assistantRestoreWarning, /Assistant result is incomplete/i);
  assert.equal(backend.exitCode, null);
});

test('signed D2 import Apply accepts an output mode change and stays local until normal Save', async (t) => {
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
  const { diagrams: _diagrams, presentation: _presentation, ...analysisResult } = currentSpec.result;
  currentSpec.result = analysisResult;
  const mock = await startMockCmdbuild(t, {
    domains: [{
      _id: 'AssetReference', name: 'AssetReference', source: 'routerG', sources: ['routerG'],
      destination: 'ARM', destinations: ['ARM'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }],
    templates: [templateCard('PersistedImport', currentSpec, { canUpdate: true })]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-persist-test-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const source = 'router: Router';
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'PersistedImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    d2Source: source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const currentSpecWithAuthoring = {
    ...currentSpec,
    result: { ...currentSpec.result, presentation: { outputMode: 'diagrams' } },
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: objectFlowIntentFromText('Выбрать маршрутизаторы.'),
        diagramIntentPrompt: 'Проверить контейнеры.\n\nСопоставить этапы с ролями.'
      },
      d2: { source }
    }
  };
  const roles = analyzed.json.proposal.roles.map((role) => {
    const isRouter = role.key === 'router';
    return d2RoleOverride(role, {
        materialization: { kind: 'stage', stageId: isRouter ? 'selection:routers' : 'selection:switches' },
        primary: {
          className: isRouter ? 'routerG' : 'ARM',
          idAttribute: '_id', labelTemplate: '${Code}', structuredFields: ['Code'], filters: []
        },
        related: []
      });
  });
  const proposal = analyzed.json.proposal;
  const structureTree = d2StructureTreeWithMaterialization(proposal, roles);
  const applyUrl = `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`;
  const applyBody = {
    templateCode: 'PersistedImport',
    baseSpecHash: hashJson(currentSpec),
    currentSpec: currentSpecWithAuthoring,
    d2Source: source,
    proposal,
    persist: true,
    roles,
    structureTree,
    relationRules: [{
      ...analyzed.json.proposal.relationRules[0],
      id: 'router_switch_persisted',
      kind: 'connection',
      mode: 'deterministicEndpoints',
      directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'match:matchedNetwork',
      sourceField: 'Code',
      targetField: 'Selection 2.Code',
      labelField: ''
    }]
  };
  const apply = (overrides = {}) => requestJson('POST', applyUrl, { ...applyBody, ...overrides }, headers);
  assert.match(proposal.signature, /^[a-f0-9]{64}$/);
  const applied = await apply();
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json.success, true);
  assert.equal(applied.json.template, undefined);
  assert.equal(applied.json.versionLog, undefined);
  assert.equal(applied.json.cacheInvalidation, undefined);
  assert.equal(applied.json.status, 'complete');
  assert.equal(applied.json.spec.result.presentation.outputMode, 'diagrams');
  assert.equal(applied.json.spec.authoring.assistant.promptContractVersion, 4);
  assert.equal(applied.json.spec.authoring.assistant.diagramIntentPrompt, 'Проверить контейнеры.\n\nСопоставить этапы с ролями.');
  assert.equal(applied.json.spec.result.diagrams[0].authoring.d2Import.source, source);

  const { proposalId, deterministicSpecHash, deterministicSpecRevision, source: sourceIdentity } = proposal;
  const restored = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: applyBody.templateCode, baseSpecHash: applyBody.baseSpecHash, currentSpec: currentSpecWithAuthoring,
    analysisCheckpoint: {
      version: 1, proposalId, deterministicSpecHash, deterministicSpecRevision,
      source: sourceIdentity, roles: proposal.roles, relationRules: proposal.relationRules, structureTree: proposal.structureTree
    }
  }, headers);
  assert.equal(restored.statusCode, 200, restored.body);
  const switchedAgain = structuredClone(currentSpecWithAuthoring);
  switchedAgain.result.presentation.outputMode = 'tables';
  const appliedFromRestore = await apply({ proposal: restored.json.proposal, currentSpec: switchedAgain });
  assert.equal(appliedFromRestore.statusCode, 200, appliedFromRestore.body);
  assert.equal(appliedFromRestore.json.status, 'complete');
  assert.equal(appliedFromRestore.json.spec.result.presentation.outputMode, 'tables');

  const stepsChanged = structuredClone(currentSpecWithAuthoring);
  stepsChanged.steps[0].limit += 1;
  const changedPresentation = structuredClone(currentSpecWithAuthoring);
  changedPresentation.result.presentation.tables = [{ name: 'routers', title: 'Changed title' }];
  const changedSource = structuredClone(currentSpecWithAuthoring);
  changedSource.authoring.d2.source = 'router: Different';
  const { signature: _signature, deterministicSpecRevision: _revision, ...retiredProposal } = proposal;
  retiredProposal.deterministicSpecHash = hashJson(currentSpec);
  retiredProposal.signature = crypto.createHmac('sha256', 'preview-test-csrf-secret')
    .update('d2-persist-test-token\n').update(stableJsonStringify(retiredProposal)).digest('hex');
  for (const [overrides, code] of [
    [{ currentSpec: stepsChanged }, 'diagram_import_deterministic_conflict'],
    [{ currentSpec: changedPresentation }, 'diagram_import_deterministic_conflict'],
    [{ currentSpec: changedSource, d2Source: changedSource.authoring.d2.source }, 'diagram_import_source_conflict'],
    [{ proposal: { ...proposal, catalogHash: 'tampered' } }, 'diagram_import_proposal_invalid'],
    [{ proposal: retiredProposal, currentSpec }, 'diagram_import_proposal_version']
  ]) {
    const rejected = await apply(overrides);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json.code, code, rejected.body);
    assert.match(rejected.json.message, /Analyze/);
  }
  assert.equal(mock.requests.some((item) => item.method === 'PUT' && item.pathname.includes('/classes/Cst_QueryTemplate/cards/')), false);

  const saved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/PersistedImport`, {
    code: 'PersistedImport', expectedSpecHash: hashJson(currentSpec), spec: applied.json.spec
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json.template.spec.authoring.d2.source, source);
  assert.equal(saved.json.template.spec.assistantDraft, undefined);
  assert.ok(saved.json.versionLog, saved.body);
  assert.ok(saved.json.cacheInvalidation, saved.body);
  assert.equal(backend.exitCode, null);
});

test('manual D2 mapping changes are persisted by normal template Save without a second apply endpoint', async (t) => {
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
  const mock = await startMockCmdbuild(t, {
    domains: [{
      _id: 'AssetReference', name: 'AssetReference', source: 'routerG', sources: ['routerG'],
      destination: 'ARM', destinations: ['ARM'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }],
    templates: [templateCard('AppliedMappingEditor', currentSpec, { canUpdate: true })]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-applied-editor-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const source = 'router: Router';
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: 'AppliedMappingEditor', baseSpecHash: hashJson(currentSpec), currentSpec, d2Source: source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => {
    const isRouter = role.key === 'router';
    return d2RoleOverride(role, {
      materialization: { kind: 'stage', stageId: isRouter ? 'selection:routers' : 'selection:switches' },
      primary: { className: isRouter ? 'routerG' : 'ARM', idAttribute: '_id', labelTemplate: '${Code}', structuredFields: ['Code'], filters: [] },
      related: []
    }, { labelTemplate: '${Code}' });
  });
  const structureTree = d2StructureTreeWithMaterialization(analyzed.json.proposal, roles);
  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    templateCode: 'AppliedMappingEditor',
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    persist: true,
    roles,
    structureTree,
    relationRules: [{
      ...analyzed.json.proposal.relationRules[0],
      id: 'router_switch_applied_editor',
      kind: 'connection',
      mode: 'deterministicEndpoints',
      directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'match:matchedNetwork',
      sourceField: 'Code',
      targetField: 'Selection 2.Code',
      labelField: ''
    }]
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  const appliedSpec = applied.json.spec;
  const imported = appliedSpec.result.diagrams[0].authoring.d2Import;
  assert.equal(imported.diagramId, appliedSpec.result.diagrams[0].id);
  assert.equal(appliedSpec.authoring.d2.source, source);
  assert.equal(appliedSpec.assistantDraft, undefined);
  const updatedStructureTree = structuredClone(imported.structureTree);
  const mappedItemIds = new Set();
  for (const item of updatedStructureTree.items) {
    if (!item.mapping || !item.mapping.materialization || item.mapping.materialization.kind !== 'stage' || !item.mapping.materialization.stageId) continue;
    item.mapping.primary.labelTemplate = '${Description}';
    mappedItemIds.add(item.id);
  }
  assert.ok(mappedItemIds.size > 0);
  const manualSpec = structuredClone(appliedSpec);
  const manualImport = manualSpec.result.diagrams[0].authoring.d2Import;
  manualImport.structureTree = updatedStructureTree;
  manualImport.mappingValidation = { version: 1, status: 'needsValidation' };
  delete manualImport.mappingInputRevision;
  const templateWritesBefore = mock.requests.filter((request) => request.method === 'PUT' && request.pathname.includes('/classes/Cst_QueryTemplate/cards/')).length;

  const saved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/AppliedMappingEditor`, {
    code: 'AppliedMappingEditor', expectedSpecHash: hashJson(currentSpec), spec: manualSpec
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.ok(saved.json.versionLog, saved.body);
  assert.equal(mock.requests.filter((request) => request.method === 'PUT' && request.pathname.includes('/classes/Cst_QueryTemplate/cards/')).length, templateWritesBefore + 1);
  const savedImport = saved.json.template.spec.result.diagrams[0].authoring.d2Import;
  assert.equal(savedImport.mappingValidation.status, 'needsValidation');
  assert.equal(savedImport.structureTree.items
    .filter((item) => mappedItemIds.has(item.id))
    .every((item) => item.mapping.primary.labelTemplate === '${Description}'), true);

  assert.equal(backend.exitCode, null);
});

test.skip('retired read-time D2 recovery is not part of the current-only contract', async (t) => {
  const templateCode = 'RecoveredMappingSaveRequired';
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
  const templateCards = [templateCard(templateCode, currentSpec, { canUpdate: true })];
  const mock = await startMockCmdbuild(t, { templates: templateCards });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=d2-recovery-save-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const source = 'router: Router';
  const analyzed = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode, baseSpecHash: hashJson(currentSpec), currentSpec, d2Source: source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const roles = analyzed.json.proposal.roles.map((role) => {
    const isRouter = role.key === 'router';
    return d2RoleOverride(role, {
      materialization: { kind: 'stage', stageId: isRouter ? 'selection:routers' : 'selection:switches' },
      primary: { className: isRouter ? 'routerG' : 'ARM', idAttribute: '_id', labelTemplate: '${Description}', structuredFields: ['Code', 'Description'], filters: [] },
      related: []
    }, { labelTemplate: '${Description}' });
  });
  const structureTree = d2StructureTreeWithMaterialization(analyzed.json.proposal, roles);
  const routerRole = roles.find((role) => role.mapping.primary.className === 'routerG');
  const switchRole = roles.find((role) => role.mapping.primary.className === 'ARM');
  const relationRules = [{
    ...analyzed.json.proposal.relationRules[0],
    id: 'router_switch_recovery',
    kind: 'connection',
    mode: 'deterministicEndpoints',
    directionPolicy: 'dataFields',
    parentRoleId: routerRole.id,
    childRoleId: switchRole.id,
    sourceStageId: 'match:matchedNetwork',
    sourceField: 'Code',
    targetField: 'Selection 2.Code',
    labelField: ''
  }];
  const applied = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    templateCode,
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    d2Source: source,
    proposal: analyzed.json.proposal,
    persist: true,
    roles,
    structureTree,
    relationRules
  }, headers);
  assert.equal(applied.statusCode, 200, applied.body);

  const baselineSave = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}`, {
    code: templateCode,
    expectedSpecHash: hashJson(currentSpec),
    spec: applied.json.spec
  }, headers);
  assert.equal(baselineSave.statusCode, 200, baselineSave.body);
  assert.equal(baselineSave.json.template.spec.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'valid');

  const staleSpec = structuredClone(baselineSave.json.template.spec);
  staleSpec.result.diagrams[0].authoring.d2Import.mappingValidation.signature = 'stale-signature';
  templateCards[0].SpecJson = JSON.stringify(staleSpec);

  const listed = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/templates?root=Cst_QueryTool`, undefined, { cookie });
  assert.equal(listed.statusCode, 200, listed.body);
  const recovered = listed.json.data.find((item) => item.code === templateCode);
  const recoveredDraftValidation = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: { code: templateCode, spec: recovered.spec },
    params: {}
  }, headers);
  const recoveredImport = recovered.spec.result.diagrams[0].authoring.d2Import;
  assert.equal(recovered.authoringRecovery.requiresSave, true);
  assert.equal(recovered.authoringRecovery.executionReadyAfterSave, true, JSON.stringify({
    response: recoveredDraftValidation.json,
    validationCurrent: diagramImportMappingValidationIsCurrent(recoveredImport),
    inputRevision: diagramImportMappingInputRevisionStatus(recovered.spec, recoveredImport),
    validation: recoveredImport.mappingValidation
  }));
  assert.ok(recovered.authoringRecovery.statuses.includes('reattested'), listed.body);
  assert.equal(recovered.spec.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'valid');
  assert.notEqual(recovered.spec.result.diagrams[0].authoring.d2Import.mappingValidation.signature, 'stale-signature');

  for (const [action, request] of [
    ['validate', () => requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/validate`, {}, headers)],
    ['run', () => requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/run?json=true`, undefined, { cookie })],
    ['publish', () => publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/publish`, { params: {}, savedSpecHash: recovered.specHash }, headers)]
  ]) {
    const response = await request();
    assert.equal(response.statusCode, 409, `${action}: ${response.body}`);
    assert.equal(response.json.reason, 'd2_mapping_recovery_save_required', response.body);
    assert.equal(response.json.nextAction, 'saveTemplate', response.body);
    assert.equal(response.json.authoringRecovery.requiresSave, true, response.body);
    assert.match(response.json.message, /Save the template once/);
  }

  const tableOnlySpec = structuredClone(staleSpec);
  tableOnlySpec.result.presentation = { ...(tableOnlySpec.result.presentation || {}), outputMode: 'tables' };
  tableOnlySpec.publish = { mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true };
  templateCards[0].SpecJson = JSON.stringify(tableOnlySpec);
  const tableOnlyValidation = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/validate`, {}, headers);
  assert.equal(tableOnlyValidation.statusCode, 200, tableOnlyValidation.body);
  assert.equal(tableOnlyValidation.json.success, true);
  const tableOnlyRun = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/run?json=true&noCache=1`, undefined, { cookie });
  assert.equal(tableOnlyRun.statusCode, 200, tableOnlyRun.body);
  assert.deepEqual(tableOnlyRun.json.diagrams, []);
  const tableOnlyPublish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/publish`, {
    params: {},
    savedSpecHash: hashJson(tableOnlySpec)
  }, headers);
  assert.equal(tableOnlyPublish.statusCode, 200, tableOnlyPublish.body);
  assert.deepEqual(tableOnlyPublish.json.result.diagrams, []);

  templateCards[0].SpecJson = JSON.stringify(staleSpec);
  const saved = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}`, {
    code: templateCode,
    expectedSpecHash: recovered.specHash,
    spec: recovered.spec
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json.template.spec.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'valid');

  const validatedAfterSave = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/${templateCode}/validate`, {}, headers);
  assert.equal(validatedAfterSave.statusCode, 200, validatedAfterSave.body);
  assert.equal(validatedAfterSave.json.success, true);
  assert.equal(backend.exitCode, null);
});

test('Diagram editor 2 sandbox API is unavailable', async (t) => {
  const currentSpec = apiObjectFlowSpec([{ alias: 'routers', className: 'routerG', columns: ['Code'] }]);
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard('MainDiagramOnly', currentSpec, { canUpdate: true })]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=main-diagram-only-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/templates/MainDiagramOnly/diagram-sandbox/reset`, {
    baseSpecHash: hashJson(currentSpec)
  }, headers);
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(backend.exitCode, null);
});

test('D2 analysis and local Apply do not require an update grant', async (t) => {
  const savedSpec = apiObjectFlowSpec([{ alias: 'routers', className: 'routerG', columns: ['Code', 'Description'] }]);
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

  const role = analyzedReadOnly.json.proposal.roles.find((item) => item.key === 'router');
  assert.ok(role, analyzedReadOnly.body);
  const roles = [d2RoleOverride(role, {
    materialization: { kind: 'stage', stageId: 'selection:routers' },
    primary: { className: 'routerG', idAttribute: '_id', labelTemplate: '${Code}', structuredFields: ['Code'], filters: [] },
    related: []
  })];
  const localApply = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    templateCode: 'NoUpdateGrant',
    baseSpecHash: hashJson(savedSpec),
    currentSpec: savedSpec,
    d2Source: analyzedReadOnly.json.proposal.sourceText,
    proposal: analyzedReadOnly.json.proposal,
    roles,
    structureTree: d2StructureTreeWithMaterialization(analyzedReadOnly.json.proposal, roles)
  }, headers);
  assert.equal(localApply.statusCode, 200, localApply.body);
  assert.equal(localApply.json.status, 'partial');
  assert.equal(localApply.json.partial, true);
  assert.equal(localApply.json.d2Workflow.state, 'pending');
  assert.ok(localApply.json.omissions.some((item) => item.kind === 'connection'));
  assert.notEqual(localApply.json.reason, 'template_update_forbidden');

  const forbiddenSave = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/NoUpdateGrant`, {
    code: 'NoUpdateGrant', expectedSpecHash: hashJson(savedSpec), spec: savedSpec
  }, headers);
  assert.equal(forbiddenSave.statusCode, 403, forbiddenSave.body);
  assert.equal(forbiddenSave.json.reason, 'template_update_forbidden');

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

test('CSRF token treats a malformed CMDBuild session as unauthorized', async (t) => {
  const mock = await startMockCmdbuild(t, { sessionStatus: 400 });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const response = await requestJson('GET', `http://127.0.0.1:${backendPort}/cmdbuild/custom-api/csrf`, undefined, {
    cookie: 'CMDBuild-Authorization=malformed-token'
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
    d2Source: analyzed.json.proposal.sourceText,
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

test('template run ignores retired generic D2 diagram definitions', async (t) => {
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
  assert.deepEqual(json.json.diagrams, []);
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

  const publishUrl = `${backendOrigin}/cmdbuild/custom-api/templates/DynamicPublishTemplate/publish`;
  const baseline = await requestPublishBaseline(publishUrl, {}, { cookie });
  assert.equal(baseline.statusCode, 400, baseline.body);
  assert.equal(baseline.json.reason, 'publication_settings_not_saved');
  const publish = await requestJson('POST', publishUrl, {
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

test('template publish blocks diagram output while a saved D2 source has no applied deterministic mapping', async (t) => {
  const spec = publishSpec({
    authoring: {
      version: 1,
      assistant: { objectFlowIntent: { context: '', blocks: [] }, diagramInterpretPrompt: '', diagramMappingPrompt: '' },
      d2: { source: 'app: "Application"' }
    },
    result: {
      presentation: { outputMode: 'both' },
      tables: [{ name: 'arms', columns: ['Code', 'Description', 'Location'], published: true }],
      diagrams: [{
        name: 'topology',
        source: { nodes: 'arms', edges: 'arms' },
        nodeMappings: [{ from: 'arms', fields: { id: 'Code', label: 'Description' } }]
      }]
    }
  });
  const mock = await startMockCmdbuild(t, { templates: [templateCard('PendingD2PublishTemplate', spec)] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=pending-d2-publish-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });

  const publish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/PendingD2PublishTemplate/publish`, {
    params: {}, savedSpecHash: hashJson(spec)
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(publish.statusCode, 400, publish.body);
  assert.equal(publish.json.errors.some((item) => item.path === '$.result.diagrams'), true);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
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

  const publish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/StalePublishTemplate/publish`, {
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
  assert.equal(publish.json.code, 'template_version_conflict');
  assert.equal(publish.json.savedSpecHash, undefined);
  assert.ok(publish.json.currentSpecHash);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/routerG/cards')), false);
  assert.equal(mock.requests.some((item) => item.pathname.endsWith('/classes/ARM/cards')), false);
  assert.equal(backend.exitCode, null);
});

function deferredSignal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function signalBeforeTimeout(signal, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      signal.then(() => true),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startTemplateRace(t, code, mockOptions, envOverrides = {}) {
  const mock = await startMockCmdbuild(t, { templateCodeFilter: true, ...mockOptions });
  const port = await freePort();
  const backend = await startBackend(t, port, mock.origin, {
    CMDBDYNAMICPAGES_ROOT: 'Cst_QueryTool',
    CMDBUILD_REQUEST_TIMEOUT_MS: '8000',
    CMDP_LOG_FORMAT: 'json',
    ...envOverrides
  });
  const origin = `http://127.0.0.1:${port}`;
  const api = `${origin}/cmdbuild/custom-api`;
  const cookie = testCmdbuildAuthorizationCookie('template-race-session');
  const csrf = await requestJson('GET', `${api}/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200, csrf.body);
  return {
    backend,
    mock,
    templateUrl: `${api}/templates/${code}`,
    snapshotUrl: `${api}/public-snapshots/${code}/run?json=true`,
    headers: { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token }
  };
}

test('concurrent template PUTs with the same expectedSpecHash write only the winning SpecJson', async (t) => {
  const code = 'ConcurrentTemplateSave';
  const spec = publishSpec();
  const expectedSpecHash = hashJson(spec);
  const firstSpec = structuredClone(spec);
  firstSpec.steps[1].limit = 1;
  const secondSpec = structuredClone(spec);
  secondSpec.steps[1].limit = 2;
  const templates = [templateCard(code, spec)];
  const templatePutPatches = [];
  const versionCards = [];
  const cardPath = `/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate/cards/${code}`;
  const firstWrite = deferredSignal();
  const secondWrite = deferredSignal();
  let upstreamWrites = 0;
  const { mock, templateUrl, headers } = await startTemplateRace(t, code, {
    templates, templatePutPatches, versionCards,
    async responseOverride(url, req) {
      if (req.method !== 'PUT' || url.pathname !== cardPath) return;
      if (++upstreamWrites === 1) {
        firstWrite.resolve();
        // A serialized writer cannot reach CMDBuild until the first write completes.
        await signalBeforeTimeout(secondWrite.promise, 1500);
      } else {
        secondWrite.resolve();
      }
    }
  });
  const save = (changedSpec) => requestJson('PUT', templateUrl, { code, expectedSpecHash, spec: changedSpec }, headers);

  const first = save(firstSpec);
  const second = (async () => {
    assert.equal(await signalBeforeTimeout(firstWrite.promise, 4000), true, 'first PUT reached CMDBuild before the second save');
    return save(secondSpec);
  })();
  const [saved, conflict] = await Promise.all([first, second]);

  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(conflict.statusCode, 409, `second PUT status: ${conflict.statusCode}; upstream PUTs: ${upstreamWrites}`);
  assert.equal(conflict.json.success, false);
  assert.equal(conflict.json.code, 'template_version_conflict');
  assert.equal(saved.json.template.specHash, hashJson(firstSpec));
  assert.notEqual(saved.json.template.specHash, expectedSpecHash);
  assert.equal(conflict.json.currentSpecHash, saved.json.template.specHash);
  assert.equal(mock.requests.filter(({ method, pathname }) => method === 'PUT' && pathname === cardPath).length, 1);
  assert.equal(templatePutPatches.length, 1);
  assert.deepEqual(JSON.parse(templatePutPatches[0].SpecJson), firstSpec);
  assert.deepEqual(JSON.parse(templates[0].SpecJson), firstSpec);
  assert.equal(versionCards.length, 1);
});

for (const method of ['PUT', 'DELETE']) {
  test(`in-flight template publish rejects a stale snapshot after ${method} commits`, async (t) => {
    const code = method === 'PUT' ? 'SaveDuringPublish' : 'DeleteDuringPublish';
    const spec = publishSpec();
    const savedSpecHash = hashJson(spec);
    const templates = [templateCard(code, spec)];
    const changedSpec = structuredClone(spec);
    changedSpec.steps[1].limit = 1;
    const executionStarted = deferredSignal();
    const resumeExecution = deferredSignal();
    let blocked = false;
    let executionBarrierTimedOut = false;
    const { mock, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
      templates,
      async responseOverride(url, req) {
        if (blocked || req.method !== 'GET' || url.pathname !== '/cmdbuild/services/rest/v3/classes/routerG/cards') return;
        blocked = true;
        executionStarted.resolve();
        executionBarrierTimedOut = !await signalBeforeTimeout(resumeExecution.promise, 4000);
        if (executionBarrierTimedOut) {
          return { statusCode: 500, body: { message: 'Timed out waiting for the concurrent template mutation.' } };
        }
      }
    });

    const publishing = publishWithBaseline(`${templateUrl}/publish`, { params: {}, savedSpecHash }, headers, 8000);
    const mutating = (async () => {
      try {
        assert.equal(await signalBeforeTimeout(executionStarted.promise, 4000), true, 'publish began reading execution data');
        const body = method === 'PUT' ? { code, expectedSpecHash: savedSpecHash, spec: changedSpec } : undefined;
        const mutation = await requestJson(method, templateUrl + '?root=Cst', body, headers);
        assert.equal(mutation.statusCode, 200, mutation.body);
        const cardPath = `/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate/cards/${code}`;
        assert.equal(mock.requests.filter((req) => req.method === method && req.pathname === cardPath).length, 1);
        if (method === 'PUT') {
          assert.deepEqual(JSON.parse(templates[0].SpecJson), changedSpec);
          assert.notEqual(mutation.json.template.specHash, savedSpecHash);
        } else {
          assert.deepEqual(templates, []);
        }
      } finally {
        resumeExecution.resolve();
      }
    })();
    const [stale] = await Promise.all([publishing, mutating]);

    assert.equal(executionBarrierTimedOut, false, 'template mutation completed while publication execution was blocked');
    const publicRun = await requestJson('GET', snapshotUrl);
    assert.equal(publicRun.statusCode, 200, publicRun.body);
    assert.equal(publicRun.json.snapshotFound, false, publicRun.body);
    assert.equal(publicRun.json.cache.status, 'snapshot-miss');
    assert.deepEqual(publicRun.json.tables, []);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json.success, false);
    assert.equal(stale.json.reason, 'publication_saved_spec_mismatch');
    assert.equal(stale.json.code, 'template_version_conflict');
  });
}

test('snapshot revocation preserves the previous generation on confirmed CMDB rejection', async (t) => {
  const code = 'RejectedSnapshotMutation';
  const nextCode = 'RejectedSnapshotRename';
  const spec = publishSpec();
  const templates = [templateCard(code, spec)];
  const redis = await startSnapshotRedisFixture(t);
  let statusCode;
  const { mock, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates,
    responseOverride(url, req) {
      if (['PUT', 'DELETE'].includes(req.method) && url.pathname.endsWith(`/Cst_QueryTemplate/cards/${code}`)) {
        return { statusCode, body: { success: false, message: 'Fixture mutation rejected.' } };
      }
    }
  }, redis.env);
  const expectedSpecHash = hashJson(spec);
  const publish = await publishWithBaseline(templateUrl + '/publish', { params: {}, savedSpecHash: expectedSpecHash }, headers);
  assert.equal(publish.statusCode, 200, publish.body);
  const stateEntries = () => [...redis.values].filter(([key]) => key.includes(':snapshot-state:'));
  const previous = stateEntries();
  assert.equal(previous.length, 1);
  assert.match(previous[0][1], /^ready:/);
  const cached = await requestJson('GET', snapshotUrl);
  assert.equal(cached.json.snapshotFound, true);

  const rejections = [['DELETE', 401], ['DELETE', 403], ['PUT', 400], ['PUT', 409], ['PUT', 412], ['PUT', 422]];
  for (const [method, status] of rejections) {
    statusCode = status;
    const rejected = await requestJson(method, templateUrl,
      method === 'PUT' ? { code: nextCode, expectedSpecHash, spec } : undefined, headers);
    assert.equal(rejected.statusCode, 502, rejected.body);
    assert.equal(rejected.json.cmdbuildStatus, status);
    assert.equal(rejected.json.snapshotRevocationPending, false);
    assert.deepEqual(stateEntries(), previous, 'restore previous ready marker and remove an initially absent rename marker');
    assert.deepEqual((await requestJson('GET', snapshotUrl)).json, cached.json);
  }
  assert.deepEqual(templates, [templateCard(code, spec)]);
  assert.deepEqual(mock.requests.filter(({ method }) => ['PUT', 'DELETE'].includes(method)).map(({ method }) => method),
    rejections.map(([method]) => method));
});

for (const outcome of [200, 202, 408, 429, 502, 'disconnect']) {
  test(`ambiguous CMDB mutation (${outcome}) leaves the old snapshot revoked and blocks republishing`, async (t) => {
    const code = 'UnconfirmedSnapshotMutation';
    const spec = publishSpec();
    const { mock, backend, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
      templates: [templateCard(code, spec)],
      responseOverride(url, req) {
        if (req.method === 'PUT' && url.pathname.endsWith(`/Cst_QueryTemplate/cards/${code}`)) {
          if (outcome === 'disconnect') req.socket.destroy();
          return { statusCode: outcome === 'disconnect' ? 502 : outcome,
            body: { message: 'Unconfirmed fixture response.', ...(outcome === 200 ? { success: false } : {}) } };
        }
      }
    });
    const body = { params: {}, savedSpecHash: hashJson(spec) };
    const publishUrl = templateUrl + '/publish';
    assert.equal((await publishWithBaseline(publishUrl, body, headers)).statusCode, 200);
    const baseline = await requestPublishBaseline(publishUrl, body.params, headers);
    assert.equal(baseline.statusCode, 200, baseline.body);
    const requestId = 'unconfirmed-mutation-fixture';
    const changed = await requestJson('PUT', templateUrl, { code, expectedSpecHash: body.savedSpecHash,
      spec: { ...spec, publish: { mode: 'dynamicUser' } } }, { ...headers, 'x-request-id': requestId });
    assert.equal(changed.statusCode, 502, changed.body);
    assert.equal(changed.json.cmdbuildStatus, outcome === 'disconnect' ? 0 : outcome);
    assert.equal(changed.json.snapshotRevocationPending, true);
    const [, , pending] = await assertSnapshotRevocationLog(backend, requestId, changed.json.snapshotRevocationOperationId,
      ['attempted', 'started', 'pending'], 1);
    assert.equal(pending.mutationOutcome, 'unconfirmed');
    assert.equal(pending.reason, 'mutation_unconfirmed');
    assert.equal(mock.requests.filter(({ method }) => method === 'PUT').length, 1, 'never retry an ambiguous write');
    assert.equal((await requestJson('GET', snapshotUrl)).json.snapshotFound, false);
    const blocked = await requestPublishBaseline(publishUrl, body.params, headers);
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json.reason, 'snapshot_revocation_pending');
    const retry = await requestJson('POST', publishUrl, { ...body, publishBaseline: baseline.json.publishBaseline }, headers);
    assert.equal(retry.statusCode, 409, retry.body);
    assert.equal(retry.json.reason, 'snapshot_revocation_pending');
  });
}

test('template delete denied by class permissions does not revoke a published snapshot', async (t) => {
  const code = 'SnapshotCannotBeDeleted';
  const spec = publishSpec();
  const { mock, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)], templateClassCanDelete: false
  });
  assert.equal((await publishWithBaseline(templateUrl + '/publish', { params: {}, savedSpecHash: hashJson(spec) }, headers)).statusCode, 200);
  const denied = await requestJson('DELETE', templateUrl, undefined, headers);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json.reason, 'template_delete_forbidden');
  assert.ok(!mock.requests.some((request) => request.method === 'DELETE'));
  assert.equal((await requestJson('GET', snapshotUrl)).json.snapshotFound, true);
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

  const publishUrl = `${backendOrigin}/cmdbuild/custom-api/templates/DeniedPublishTemplate/publish`;
  const baseline = await requestPublishBaseline(publishUrl, {}, { cookie });
  assert.equal(baseline.statusCode, 403, baseline.body);
  assert.equal(baseline.json.reason, 'template_update_forbidden');
  assert.equal(baseline.json.publishBaseline, undefined);
  const publish = await requestJson('POST', publishUrl, {
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

  const publishUrl = `${backendOrigin}/cmdbuild/custom-api/templates/MissingPermissionPublishTemplate/publish`;
  const baseline = await requestPublishBaseline(publishUrl, {}, { cookie });
  assert.equal(baseline.statusCode, 403, baseline.body);
  assert.equal(baseline.json.reason, 'template_update_forbidden');
  assert.equal(baseline.json.publishBaseline, undefined);
  const publish = await requestJson('POST', publishUrl, {
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

test('runtime permissionOnly cache bypasses unconfirmed probes and never returns rows on data denial', async (t) => {
  const code = 'RuntimeAccessProbe';
  const spec = {
    version: 1,
    steps: [{ type: 'selectCards', as: 'arms', className: 'ARM', columns: ['Code'], limit: 1 }],
    result: { tables: [{ name: 'arms', columns: ['Code'] }] }
  };
  const cardsPath = '/cmdbuild/services/rest/v3/classes/ARM/cards';
  const attributesPath = '/cmdbuild/services/rest/v3/classes/ARM/attributes';
  const templatePath = '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate/cards';
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard(code, spec)],
    armCards: [{ _id: 501, Code: 'PERMITTED-ARM' }],
    responseOverride(url, req) {
      const token = req.headers['cmdbuild-authorization'];
      if (url.pathname === '/cmdbuild/services/rest/v3/sessions/current') {
        if (token === 'expired-session') return { statusCode: 401, body: { success: false } };
        return { statusCode: 200, body: { data: { username: token, role: 'Reader' } } };
      }
      if (url.pathname === attributesPath && ['probe-forbidden', 'probe-missing', 'cards-forbidden'].includes(token)) {
        return { statusCode: token === 'probe-missing' ? 404 : 403, body: { message: 'Mock attributes unavailable' } };
      }
      if ((url.pathname === cardsPath && token === 'cards-forbidden') ||
          (url.pathname === templatePath && token === 'technical-forbidden')) {
        return { statusCode: 403, body: { message: 'Mock access denied' } };
      }
      if (url.pathname === cardsPath && ['probe-forbidden', 'probe-missing'].includes(token)) {
        return { statusCode: 200, body: { data: [{ _id: 502, Code: 'CALLER-ARM' }] } };
      }
    }
  });
  const backendPort = await freePort();
  await startBackend(t, backendPort, mock.origin);
  const origin = `http://127.0.0.1:${backendPort}`;
  const api = `${origin}/cmdbuild/custom-api`;
  const endpoint = `${api}/templates/${code}/run?json=true`;
  const run = (token) => requestJson('GET', endpoint, undefined, { cookie: testCmdbuildAuthorizationCookie(token) });

  const warm = await run('permitted-session');
  assert.equal(warm.statusCode, 200, warm.body);
  assert.equal(warm.json.cache.status, 'miss');
  assert.equal(warm.json.cache.scopeMode, 'permissionOnly');
  assert.deepEqual(warm.json.tables[0].rows, [{ Code: 'PERMITTED-ARM' }]);

  const sharedHit = await run('second-permitted-session');
  assert.equal(sharedHit.statusCode, 200, sharedHit.body);
  assert.equal(sharedHit.json.cache.status, 'hit');
  assert.equal(sharedHit.json.cache.key, warm.json.cache.key);

  for (const token of ['probe-forbidden', 'probe-missing']) {
    const start = mock.requests.length;
    const runWithoutCache = await run(token);
    assert.equal(runWithoutCache.statusCode, 200, runWithoutCache.body);
    assert.equal(runWithoutCache.json.cache.status, 'bypass');
    assert.equal(runWithoutCache.json.cache.reason, 'access_probe_unconfirmed');
    assert.deepEqual(runWithoutCache.json.tables[0].rows, [{ Code: 'CALLER-ARM' }]);
    const dataReads = mock.requests.slice(start).filter((item) => [attributesPath, cardsPath].includes(item.pathname));
    assert.deepEqual(dataReads.map((item) => item.pathname), [attributesPath, cardsPath]);
  }

  const cookie = testCmdbuildAuthorizationCookie('probe-forbidden');
  const csrf = await requestJson('GET', `${api}/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const draft = await requestJson('POST', `${api}/draft/preview?root=Cst_QueryTool`, {
    template: { code, spec }, params: {}
  }, { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(draft.statusCode, 200, draft.body);
  const directUrl = await requestJson('GET', `${origin}/cmdbuild/dynamicpages/ui/run/${code}?root=Cst_QueryTool&json=true`, undefined, { cookie });
  assert.equal(directUrl.statusCode, 200, directUrl.body);
  assert.equal(directUrl.json.cache.status, 'bypass');
  assert.deepEqual(directUrl.json.tables[0].rows, draft.json.result.tables[0].rows);

  const start = mock.requests.length;
  const denied = await run('cards-forbidden');
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json.reason, 'data_access_denied');
  assert.equal(denied.json.result, undefined);
  assert.deepEqual(denied.json.tables ?? [], []);
  assert.ok(mock.requests.slice(start).some((item) => item.pathname === cardsPath));

  const technicalStart = mock.requests.length;
  const technicalDenied = await run('technical-forbidden');
  assert.equal(technicalDenied.statusCode, 403, technicalDenied.body);
  assert.equal(technicalDenied.json.reason, 'technical_schema_access_denied');
  assert.equal(technicalDenied.json.result, undefined);
  assert.deepEqual(technicalDenied.json.tables ?? [], []);
  assert.equal(mock.requests.slice(technicalStart).some((item) => [attributesPath, cardsPath].includes(item.pathname)), false);

  for (const [token, deniedResponse] of [
    ['cards-forbidden', denied],
    ['technical-forbidden', technicalDenied]
  ]) {
    const directDenied = await requestJson('GET', `${origin}/cmdbuild/dynamicpages/ui/run/${code}?json=true`, undefined, {
      cookie: testCmdbuildAuthorizationCookie(token)
    });
    assert.equal(directDenied.statusCode, 403, directDenied.body);
    assert.equal(directDenied.json.reason, deniedResponse.json.reason);
    assert.equal(directDenied.json.result, undefined);
    assert.deepEqual(directDenied.json.tables ?? [], []);
  }

  const expiredStart = mock.requests.length;
  const expired = await run('expired-session');
  assert.equal(expired.statusCode, 401, expired.body);
  assert.equal(expired.json.reason, 'cmdbuild_session_invalid');
  assert.ok(expired.headers['x-request-id']);
  assert.equal(mock.requests.slice(expiredStart).some((item) => item.pathname === templatePath || item.pathname === cardsPath), false);

  const stillShared = await run('permitted-session');
  assert.equal(stillShared.statusCode, 200, stillShared.body);
  assert.equal(stillShared.json.cache.status, 'hit');
  assert.deepEqual(stillShared.json.tables[0].rows, [{ Code: 'PERMITTED-ARM' }]);
});

test('runtime and public snapshot caches isolate templates with the same code by root', async (t) => {
  const runtimeCode = 'RuntimeRootIsolation';
  const snapshotCode = 'SnapshotRootIsolation';
  const specForClass = (className) => ({
    version: 1,
    params: { code: { type: 'string', required: true } },
    steps: [{
      type: 'selectCards', as: 'items', className, columns: ['Code', 'Description'], limit: 1,
      filters: [{ path: 'Code', op: 'equals', valueParam: 'code' }]
    }],
    result: { tables: [{ name: 'items', columns: ['Code', 'Description'] }] }
  });
  const defaultSpec = specForClass('ARM');
  const alternateSpec = specForClass('routerG');
  const publish = { mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true };
  const defaultSnapshot = { ...defaultSpec, publish };
  const alternateSnapshot = { ...alternateSpec, publish };
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true,
    templates: [templateCard(runtimeCode, defaultSpec), templateCard(snapshotCode, defaultSnapshot)],
    cardsByClass: {
      Acme_QueryTemplate: [templateCard(runtimeCode, alternateSpec), templateCard(snapshotCode, alternateSnapshot)],
      Acme_QueryToolConfig: []
    },
    armCards: [{ _id: 501, Code: 'selected', Description: 'Default root row' }],
    routerCards: [{ _id: 301, Code: 'selected', Description: 'Alternate root row' }],
    responseOverride(url, req) {
      if (url.pathname.endsWith('/sessions/current') && req.headers['cmdbuild-authorization'] === 'expired-session') {
        return { statusCode: 401, body: { success: false } };
      }
    }
  });
  const backendPort = await freePort();
  await startBackend(t, backendPort, mock.origin, { CMDBDYNAMICPAGES_ROOT: 'Cst_QueryTool' });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const api = `${backendOrigin}/cmdbuild/custom-api`;
  const cookie = testCmdbuildAuthorizationCookie('root-isolation-session');
  const csrf = await requestJson('GET', `${api}/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const params = { code: 'selected' };
  const runQuery = 'json=true&code=selected';
  const defaultRoot = '&root=Cst_QueryTool';
  const alternateRoot = '&root=Acme_QueryTool';
  const directUrl = `${backendOrigin}/cmdbuild/dynamicpages/ui/run/${snapshotCode}`;
  const expiredCookie = testCmdbuildAuthorizationCookie('expired-session');
  const run = (code, root) => requestJson('GET', `${api}/templates/${code}/run?${runQuery}${root}`, undefined, { cookie });
  const publicRun = (root) => requestJson('GET', `${api}/public-snapshots/${snapshotCode}/run?${runQuery}${root}`);
  const readBoot = (html) => {
    assert.equal(html.statusCode, 200);
    assert.match(html.headers['content-type'], /^text\/html/);
    const bootMatch = /<script>window\.CMDP_BOOT=(.*);<\/script>/.exec(html.body);
    assert.ok(bootMatch, 'HTML contains runtime boot data');
    return JSON.parse(bootMatch[1]);
  };
  const assertRows = (response, cacheStatus, description) => {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.cache.status, cacheStatus, response.body);
    assert.deepEqual(response.json.params, params);
    assert.deepEqual(response.json.tables[0].rows, [{ Code: params.code, Description: description }]);
  };

  const defaultRun = await run(runtimeCode, '');
  assertRows(defaultRun, 'miss', 'Default root row');
  const alternateRun = await run(runtimeCode, alternateRoot);
  assertRows(alternateRun, 'miss', 'Alternate root row');
  assert.notEqual(defaultRun.json.cache.key, alternateRun.json.cache.key);
  const explicitDefault = await run(runtimeCode, defaultRoot);
  assertRows(explicitDefault, 'hit', 'Default root row');
  assert.equal(explicitDefault.json.cache.key, defaultRun.json.cache.key);
  assertRows(await run(runtimeCode, alternateRoot), 'hit', 'Alternate root row');

  const publishSnapshot = async (spec, query) => {
    const response = await publishWithBaseline(`${api}/templates/${snapshotCode}/publish${query}`, {
      params, savedSpecHash: hashJson(spec)
    }, headers);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json.cache.status, 'snapshot-published', response.body);
  };
  await publishSnapshot(defaultSnapshot, '');
  const missing = await publicRun(alternateRoot);
  assert.equal(missing.statusCode, 200, missing.body);
  assert.equal(missing.json.snapshotFound, false);
  assert.equal(missing.json.cache.status, 'snapshot-miss');
  assert.deepEqual(missing.json.params, params);
  const alternateMiss = await requestJson('GET', `${directUrl}?${runQuery}${alternateRoot}`);
  assert.equal(alternateMiss.statusCode, 200, alternateMiss.body);
  assert.deepEqual(alternateMiss.json, missing.json);
  await publishSnapshot(alternateSnapshot, '?root=Acme_QueryTool');
  assertRows(await run(snapshotCode, ''), 'snapshot-hit', 'Default root row');
  assertRows(await run(snapshotCode, alternateRoot), 'snapshot-hit', 'Alternate root row');

  const publicStart = mock.requests.length;
  const defaultPublic = await publicRun('');
  const alternatePublic = await publicRun(alternateRoot);
  assertRows(defaultPublic, 'snapshot-hit', 'Default root row');
  assertRows(alternatePublic, 'snapshot-hit', 'Alternate root row');
  assert.notEqual(defaultPublic.json.cache.key, alternatePublic.json.cache.key);

  for (const requestHeaders of [{}, { cookie }, { cookie: expiredCookie }]) {
    for (const [root, expected] of [[defaultRoot, defaultPublic], [alternateRoot, alternatePublic]]) {
      const json = await requestJson('GET', `${directUrl}?${runQuery}${root}`, undefined, requestHeaders);
      assert.equal(json.statusCode, 200, json.body);
      assert.deepEqual(json.json, expected.json);
    }

    const html = await request('GET', `${directUrl}?code=selected${alternateRoot}`, undefined, requestHeaders);
    const { mode, publicRuntime, session, root, templateCode } = readBoot(html);
    assert.deepEqual({ mode, publicRuntime, session, root, templateCode }, {
      mode: 'runtime', publicRuntime: true, session: {}, root: 'Acme_QueryTool', templateCode: snapshotCode
    });
  }
  assert.equal(mock.requests.length, publicStart, 'snapshot hits make no CMDBuild requests, including session checks');

  const wrongParamsUrl = `${directUrl}?json=true&code=unpublished${alternateRoot}`;
  const anonymousMiss = await requestJson('GET', wrongParamsUrl);
  assert.equal(anonymousMiss.statusCode, 200, anonymousMiss.body);
  assert.equal(anonymousMiss.json.snapshotFound, false);
  assert.equal(anonymousMiss.json.cache.status, 'snapshot-miss');
  assert.deepEqual(anonymousMiss.json.tables, []);
  assert.equal(mock.requests.length, publicStart, 'anonymous misses make no CMDBuild requests');

  const expiredMiss = await requestJson('GET', wrongParamsUrl, undefined, { cookie: expiredCookie });
  assert.equal(expiredMiss.statusCode, 401, expiredMiss.body);
  assert.equal(expiredMiss.json.reason, 'cmdbuild_session_invalid');

  const wrongParamsHtmlUrl = `${directUrl}?code=unpublished${alternateRoot}`;
  const expiredHtml = await requestJson('GET', wrongParamsHtmlUrl, undefined, { cookie: expiredCookie });
  assert.equal(expiredHtml.statusCode, 401, expiredHtml.body);
  assert.equal(expiredHtml.json.reason, 'cmdbuild_session_invalid');
  const authenticatedHtml = await request('GET', wrongParamsHtmlUrl, undefined, { cookie });
  const authenticatedBoot = readBoot(authenticatedHtml);
  assert.equal(authenticatedBoot.publicRuntime, false);
  assert.equal(authenticatedBoot.session.username, 'preview-user');
  assert.deepEqual(mock.requests.slice(publicStart).map(({ pathname }) => pathname), [
    '/cmdbuild/services/rest/v3/sessions/current',
    '/cmdbuild/services/rest/v3/sessions/current',
    '/cmdbuild/services/rest/v3/sessions/current'
  ]);
});

async function startSnapshotRedisFixture(t) {
  const values = new Map();
  const sets = new Map();
  const faults = { mset: false, del: false, finalize: false };
  const resp = (value) => value == null ? '$-1\r\n' : typeof value === 'number' ? `:${value}\r\n`
    : Array.isArray(value) ? `*${value.length}\r\n${value.map(resp).join('')}` : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  const redis = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      const end = input.indexOf('\r\n');
      if (end === -1) return;
      const count = Number(input.subarray(1, end));
      const parts = [];
      let offset = end + 2;
      for (let index = 0; index < count; index++) {
        const header = input.indexOf('\r\n', offset);
        if (header === -1) return;
        const length = Number(input.subarray(offset + 1, header));
        if (input.length < header + 2 + length + 2) return;
        parts.push(input.subarray(header + 2, header + 2 + length).toString());
        offset = header + 2 + length + 2;
      }
      input = input.subarray(offset);
      const [command, key, ...args] = parts;
      const add = (set, item) => { if (!sets.has(set)) sets.set(set, new Set()); sets.get(set).add(item); };
      switch (command) {
        case 'PING': return socket.end('+PONG\r\n');
        case 'TIME': {
          const now = Date.now();
          return socket.write(resp([String(Math.floor(now / 1000)), String(now % 1000 * 1000)]));
        }
        case 'GET': return socket.end(resp(values.get(key)));
        case 'MGET': return socket.end(resp([key, ...args].map((item) => values.get(item))));
        case 'SET':
          if (args[1] === 'NX' && values.has(key)) return socket.end(resp(null));
          values.set(key, args[0]);
          return socket.end('+OK\r\n');
        case 'MSET': {
          if (faults.mset === true) return socket.end('-ERR cannot persist revocation\r\n');
          const pairs = [key, ...args];
          for (let i = 0; i < pairs.length; i += 2) values.set(pairs[i], pairs[i + 1]);
          if (faults.mset === 'lost-ack') return socket.end();
          return socket.end('+OK\r\n');
        }
        case 'SMEMBERS': return socket.end(resp([...(sets.get(key) || [])]));
        case 'DEL':
          if (faults.del && key.includes(':snapshot:')) return socket.end('-ERR cannot delete old payload\r\n');
          return socket.end(resp(Number(values.delete(key) || sets.delete(key))));
        case 'EVAL': {
          const keyCount = Number(args[0]);
          const keys = args.slice(1, 1 + keyCount);
          const [expected, ...next] = args.slice(1 + keyCount);
          if (key.includes('SADD')) {
            const [snapshot, indexMember, deadline, compare, raw, generation] = next;
            const [stateKey, snapshotKey, indexKey] = keys;
            if (Date.now() >= Number(deadline)) return socket.end(resp(-1));
            if ((values.get(stateKey) ?? '') !== expected ||
                !(compare === 'missing' && !values.has(snapshotKey) || compare === 'value' && values.get(snapshotKey) === raw)) {
              return socket.end(resp(0));
            }
            values.set(snapshotKey, snapshot);
            add(indexKey, indexMember);
            if (!values.has(stateKey)) values.set(stateKey, generation);
          } else {
            if (faults.finalize) return socket.end('-ERR cannot finalize revocation\r\n');
            if (keys.some((item) => values.get(item) !== expected)) return socket.end(resp(0));
            keys.forEach((item, index) => next[index] === '-' ? values.delete(item) : values.set(item, next[index]));
          }
          return socket.end(resp(1));
        }
        default: return socket.end('-ERR unexpected fixture command\r\n');
      }
    });
  });
  await listen(redis, 0);
  t.after(() => closeServer(redis));
  return { faults, values, env: { CMDBDYNAMIC_REDIS_ENABLED: 'true', CMDBDYNAMIC_REDIS_REQUIRED: 'false',
    CMDBDYNAMIC_REDIS_URL: `redis://127.0.0.1:${redis.address().port}/0` } };
}

async function assertSnapshotRevocationLog(backend, requestId, operationId, outcomes, keyCount) {
  assert.match(operationId, /^[0-9a-f-]{36}$/);
  let events;
  await waitFor(() => {
    events = backend.testOutput.split('\n').filter((line) => line.includes('"event":"snapshot.revocation_') && line.endsWith('}'))
      .map((line) => JSON.parse(line)).filter((item) => item.requestId === requestId);
    return events.length >= outcomes.length;
  }, 1500, () => backend.testOutput);
  assert.deepEqual(events.map(({ event }) => event), outcomes.map((outcome) => `snapshot.revocation_${outcome}`));
  const [{ stateKeys }] = events;
  assert.equal(stateKeys.length, keyCount);
  for (const event of events) {
    assert.equal(event.operationId, operationId);
    assert.deepEqual(event.stateKeys, stateKeys);
  }
  return events;
}

test('snapshot revocation with a lost MSET ACK leaves both rename markers discoverable and never writes CMDB', async (t) => {
  const code = 'LostRevocationAck';
  const nextCode = 'LostRevocationAckRename';
  const spec = publishSpec();
  const redis = await startSnapshotRedisFixture(t);
  const { mock, backend, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)]
  }, { ...redis.env, CMDBDYNAMIC_REDIS_RETRY_AFTER_MS: '1000', CMDBDYNAMIC_REDIS_TIMEOUT_MS: '2500' });
  const expectedSpecHash = hashJson(spec);
  const publishBody = { params: {}, savedSpecHash: expectedSpecHash };
  const publishUrl = templateUrl + '/publish';
  assert.equal((await publishWithBaseline(publishUrl, publishBody, headers)).statusCode, 200);
  const baseline = await requestPublishBaseline(publishUrl, publishBody.params, headers);
  assert.equal(baseline.statusCode, 200, baseline.body);
  assert.equal((await requestJson('GET', snapshotUrl)).json.snapshotFound, true);

  const requestId = 'lost-revocation-ack-fixture';
  redis.faults.mset = 'lost-ack';
  const saving = requestJson('PUT', templateUrl, { code: nextCode, expectedSpecHash, spec },
    { ...headers, 'x-request-id': requestId });
  let pending;
  await waitFor(() => (pending = [...redis.values.values()].find((value) => value.startsWith('pending:'))), 1000);
  const operationId = pending.slice('pending:'.length);
  const [attempt] = await assertSnapshotRevocationLog(backend, requestId, operationId, ['attempted'], 2);
  assert.deepEqual(attempt.templateCodes, [code, nextCode]);
  assert.deepEqual(attempt.stateKeys.map((key) => redis.values.get(key)), [pending, pending]);

  const blocked = await saving;
  assert.equal(blocked.statusCode, 503, blocked.body);
  assert.equal(blocked.headers['x-request-id'], requestId);
  assert.equal(blocked.json.code, 'snapshot_revocation_unavailable');
  assert.equal(blocked.json.snapshotRevocationPending, true);
  assert.equal(blocked.json.snapshotRevocationOperationId, operationId);
  const [, unavailable] = await assertSnapshotRevocationLog(backend, requestId, operationId,
    ['attempted', 'unavailable'], 2);
  assert.equal(unavailable.reason, 'pending_write_unconfirmed');
  assert.deepEqual(attempt.stateKeys.map((key) => redis.values.get(key)), [pending, pending]);
  assert.ok(!mock.requests.some(({ method }) => ['PUT', 'DELETE', 'POST'].includes(method)), 'no card or version write');

  // Wait for the client backoff; the persisted marker must still fence the old payload.
  await waitFor(async () => (await requestJson('GET', snapshotUrl)).statusCode === 200, 4000);
  assert.equal((await requestJson('GET', snapshotUrl)).json.snapshotFound, false);
  const blockedBaseline = await requestPublishBaseline(publishUrl, publishBody.params, headers);
  assert.equal(blockedBaseline.statusCode, 409, blockedBaseline.body);
  assert.equal(blockedBaseline.json.reason, 'snapshot_revocation_pending');
  const retry = await requestJson('POST', publishUrl, { ...publishBody, publishBaseline: baseline.json.publishBaseline }, headers);
  assert.equal(retry.statusCode, 409, retry.body);
  assert.equal(retry.json.reason, 'snapshot_revocation_pending');
});

test('snapshot revocation reports pending if restoration of a rejected write cannot be confirmed', async (t) => {
  const code = 'RejectedSnapshotRestoreUnavailable';
  const spec = publishSpec();
  const redis = await startSnapshotRedisFixture(t);
  const { templateUrl, headers, backend } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    responseOverride(url, req) {
      if (req.method === 'DELETE' && url.pathname.endsWith(`/Cst_QueryTemplate/cards/${code}`)) {
        return { statusCode: 403, body: { success: false } };
      }
    }
  }, redis.env);
  assert.equal((await publishWithBaseline(templateUrl + '/publish', { params: {}, savedSpecHash: hashJson(spec) }, headers)).statusCode, 200);
  redis.faults.finalize = true;
  const requestId = 'unconfirmed-restoration-fixture';
  const rejected = await requestJson('DELETE', templateUrl, undefined, { ...headers, 'x-request-id': requestId });
  assert.equal(rejected.statusCode, 502, rejected.body);
  assert.equal(rejected.json.cmdbuildStatus, 403);
  assert.equal(rejected.json.snapshotRevocationPending, true);
  const operationId = rejected.json.snapshotRevocationOperationId;
  const [attempt, , pending] = await assertSnapshotRevocationLog(backend, requestId, operationId,
    ['attempted', 'started', 'pending'], 1);
  assert.equal(pending.reason, 'state_finalization_unconfirmed');
  assert.equal(pending.mutationOutcome, 'rejected');
  assert.equal(redis.values.get(attempt.stateKeys[0]), `pending:${operationId}`);
});

test('snapshot revocation uses the same class across root spellings and fences stale Redis payloads across restart', async (t) => {
  const code = 'FencedSnapshot';
  const spec = publishSpec();
  const mock = await startMockCmdbuild(t, { templates: [templateCard(code, spec)] });
  const redis = await startSnapshotRedisFixture(t);
  const makeOrigin = async () => {
    const port = await freePort();
    const backend = await startBackend(t, port, mock.origin, redis.env);
    return { backend, origin: `http://127.0.0.1:${port}` };
  };
  const { backend, origin } = await makeOrigin();
  const cookie = testCmdbuildAuthorizationCookie('fenced-snapshot-session');
  const headersFor = async (target) => {
    const csrf = await requestJson('GET', `${target}/cmdbuild/custom-api/csrf`, undefined, { cookie });
    return { cookie, origin: target, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  };
  const headers = await headersFor(origin);
  const templatePath = `/cmdbuild/custom-api/templates/${code}`;
  const oldPublicPath = `/cmdbuild/custom-api/public-snapshots/${code}/run?root=Cst_QueryTool&json=true`;
  const publish = await publishWithBaseline(`${origin}${templatePath}/publish?root=Cst_QueryTool`,
    { params: {}, savedSpecHash: hashJson(spec) }, headers);
  assert.equal(publish.statusCode, 200, publish.body);
  assert.equal((await requestJson('GET', origin + oldPublicPath)).json.snapshotFound, true);

  redis.faults.mset = true;
  const start = mock.requests.length;
  for (const [method, body] of [['DELETE', undefined], ['PUT', { code, expectedSpecHash: hashJson(spec),
    spec: { ...spec, publish: { mode: 'dynamicUser' } } }]]) {
    const blocked = await requestJson(method, `${origin}${templatePath}?root=Cst`, body, headers);
    assert.equal(blocked.statusCode, 503, blocked.body);
    assert.equal(blocked.json.code, 'snapshot_revocation_unavailable');
  }
  assert.ok(!mock.requests.slice(start).some((entry) => entry.method === 'DELETE' || entry.method === 'PUT'));
  redis.faults.mset = false;
  // Restart clears the client-side Redis outage backoff, but keeps all Redis data.
  backend.kill();
  const recovered = await makeOrigin();
  const nextHeaders = await headersFor(recovered.origin);
  assert.equal((await requestJson('GET', recovered.origin + oldPublicPath)).json.snapshotFound, true);
  redis.faults.del = true;
  const deleted = await requestJson('DELETE', `${recovered.origin}${templatePath}?root=Cst`, undefined, nextHeaders);
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json.cacheInvalidation.staticSnapshots.complete, false);
  assert.ok([...redis.values.keys()].some((key) => key.includes(':snapshot:v3:')), 'old payload still exists in Redis');
  redis.faults.del = false;
  recovered.backend.kill();
  const restarted = await makeOrigin();
  const missing = await requestJson('GET', restarted.origin + oldPublicPath);
  assert.equal(missing.statusCode, 200, missing.body);
  assert.equal(missing.json.snapshotFound, false);
});

test('public snapshot storage outage returns a controlled 503 without CMDBuild fallback', async (t) => {
  const mock = await startMockCmdbuild(t);
  let redisRequests = 0;
  const redis = net.createServer((socket) => {
    socket.once('data', () => {
      redisRequests++;
      socket.end('-ERR fixture storage unavailable\r\n');
    });
  });
  await listen(redis, 0);
  t.after(() => closeServer(redis));
  const cookie = testCmdbuildAuthorizationCookie('snapshot-storage-session');
  for (const redisRequired of ['false', 'true']) {
    await t.test(`Redis required: ${redisRequired}`, async (subtest) => {
      const port = await freePort();
      await startBackend(subtest, port, mock.origin, {
        CMDBDYNAMIC_REDIS_ENABLED: 'true',
        CMDBDYNAMIC_REDIS_REQUIRED: redisRequired,
        CMDBDYNAMIC_REDIS_URL: `redis://127.0.0.1:${redis.address().port}/0`
      });
      const origin = `http://127.0.0.1:${port}`;
      const directUrl = `${origin}/cmdbuild/dynamicpages/ui/run/SnapshotStorageOutage`;
      const start = redisRequests;
      for (const [url, headers] of [
        [`${origin}/cmdbuild/custom-api/public-snapshots/SnapshotStorageOutage/run?json=true`, {}],
        [`${directUrl}?json=true`, { cookie }],
        [directUrl, { cookie }]
      ]) {
        const response = await requestJson('GET', url, undefined, headers);
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json.success, false);
        assert.equal(response.json.reason, 'snapshot_storage_unavailable');
        assert.doesNotMatch(response.body, /fixture storage unavailable/);
      }
      assert.ok(redisRequests > start, 'backend attempted to use the fake Redis');
      assert.deepEqual(mock.requests, []);
    });
  }
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

  const publish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/StaticPublishTemplate/publish`, {
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

function assertSnapshotLimitError(response, reason, expected, status = 422) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json.reason, reason, response.body);
  assert.equal(response.json.code, reason, response.body);
  assert.equal(response.json.result, undefined);
  const limits = response.json.diagnostics?.limits;
  assert.ok(Array.isArray(limits) && limits.length > 0 && limits.length <= 16, response.body);
  const stringKeys = ['table', 'stepAlias', 'stepType', 'limitName', 'configKey', 'sourceAlias', 'sourceLabel', 'stepLabel'];
  const countKeys = ['stepIndex', 'requested', 'effectiveLimit', 'observed', 'total'];
  const flagKeys = ['limitHit', 'truncated', 'timeout', 'canUseLargeTable', 'usedByDiagram'];
  const rowLimitCauses = ['stepLimit', 'ordinaryCeiling', 'runtimeMaximum', 'pagedCeiling'];
  const enums = {
    phase: ['selector', 'rows', 'index'],
    source: ['runtime-settings', 'object-flow-step', 'product', 'upstream'],
        unit: ['cards', 'relations', 'calls', 'rows', 'memberships', 'bytes', 'classes', 'domains', 'milliseconds', 'checks'],
    reason: ['limit_exceeded', 'completeness_unconfirmed', 'deadline_exceeded', 'row_limit_configuration_conflict'],
    rowLimitMode: ['ordinary', 'paged']
  };
  for (const entry of limits) {
    assert.equal(typeof entry.table, 'string', response.body);
    assert.ok(enums.phase.includes(entry.phase) && enums.reason.includes(entry.reason), response.body);
    for (const [key, value] of Object.entries(entry)) {
      const valid = stringKeys.includes(key) ? typeof value === 'string'
        : countKeys.includes(key) ? Number.isSafeInteger(value) && value >= 0
          : flagKeys.includes(key) ? typeof value === 'boolean'
            : key === 'rowLimitCauses' ? Array.isArray(value) && value.length > 0 && value.every((cause) => rowLimitCauses.includes(cause))
              : Object.hasOwn(enums, key) && enums[key].includes(value);
      assert.ok(valid, `Unexpected diagnostic field ${key}: ${response.body}`);
    }
  }
  const match = limits.find((entry) => Object.entries(expected).every(([key, value]) => entry[key] === value));
  assert.ok(match, `Expected ${JSON.stringify(expected)}: ${response.body}`);
  return limits;
}

test('large-table publication accepts exactly 10000 projected rows and retains the snapshot on overflow', async (t) => {
  const code = 'ExactLargeTableBudget';
  const spec = {
    version: 1,
    steps: [
      { type: 'selectCards', as: 'cards', className: 'ARM' },
      { type: 'enrichRows', as: 'view', from: 'cards', purpose: 'viewComposer', columns: [{ path: 'Code', as: 'Code' }] }
    ],
    result: { tables: [{ name: 'view', columns: ['Code'], published: true, presentation: { largeTable: { mode: 'all' } } }] },
    publish: { ...publishSpec().publish, refreshMode: 'shared', sharedRefreshAccepted: true }
  };
  let total = 10000;
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true,
    templates: [templateCard(code, spec)],
    responseOverride(url) {
      if (url.pathname.endsWith('/classes/ARM/cards')) {
        const offset = Number(url.searchParams.get('start') || 0);
        const limit = Number(url.searchParams.get('limit') || 1000);
        const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) },
          (_, index) => ({ _id: offset + index + 1, Code: 'R' + (offset + index) }));
        return { statusCode: 200, body: { data, meta: { total } } };
      }
      if (/\/classes\/ARM\/cards\/[^/]+$/.test(url.pathname)) {
        return { statusCode: 503, body: { message: 'The materialized projection must not reload each card.' } };
      }
    }
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin);
  const origin = `http://127.0.0.1:${port}`;
  const api = origin + '/cmdbuild/custom-api';
  const headers = { cookie: testCmdbuildAuthorizationCookie('editor'), origin };
  headers['x-cmdbdynamicpages-csrf'] = (await requestJson('GET', api + '/csrf', undefined, headers)).json.token;
  const publish = await publishWithBaseline(`${api}/templates/${code}/publish`, { savedSpecHash: hashJson(spec) }, headers);
  assert.equal(publish.statusCode, 200, publish.body.slice(0, 2000));
  const publicPath = `${api}/public-snapshots/${code}`;
  const opened = await requestJson('GET', publicPath + '/run?cmdpTableShell=1');
  const revision = opened.json.tableView.snapshotRevision;
  const pagePath = publicPath + '/table-page?cmdpTable=' + encodeURIComponent(JSON.stringify({
    table: 'view', op: 'rows', offset: 9999, snapshotRevision: revision
  }));
  const page = await requestJson('GET', pagePath);
  assert.equal(page.statusCode, 200);
  assert.equal(page.json.total, 10000);
  assert.deepEqual(page.json.table.rows, [{ Code: 'R9999' }]);
  assert.equal(page.json.incomplete, false);
  total += 1;
  const refresh = await requestJson('POST', `${api}/templates/${code}/refresh-snapshot`, {
    expectedMode: 'shared', expectedSnapshotRevision: revision
  }, headers);
  const limits = assertSnapshotLimitError(refresh, 'table_result_incomplete', {
    table: 'view', phase: 'rows', stepAlias: 'cards', stepType: 'selectCards',
    limitName: 'maxSelectionScanRows', source: 'product', rowLimitMode: 'paged', canUseLargeTable: false,
    unit: 'cards', effectiveLimit: 10000, observed: 10000, total: 10001, reason: 'limit_exceeded'
  });
  assert.deepEqual(limits.find((entry) => entry.limitName === 'maxSelectionScanRows').rowLimitCauses, ['pagedCeiling']);
  assert.ok(!limits.some((entry) => entry.limitName === 'maxRows'), refresh.body);
  assert.deepEqual((await requestJson('GET', pagePath)).json, page.json);
});

test('large-table publication distinguishes relation totals, unconfirmed ends and index membership budgets', async (t) => {
  const relationSpec = {
    version: 1,
    steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM' },
      { type: 'expandRelations', as: 'links', from: 'assets', direction: 'source', fetchRelated: false }
    ],
    result: { tables: [{ name: 'links', columns: ['Code'], published: true, presentation: { largeTable: { mode: 'all' } } }] },
    publish: publishSpec().publish
  };
  const budgetSpec = {
    version: 1, steps: [{ type: 'selectCards', as: 'assets', className: 'ARM' }],
    result: { tables: [{ name: 'assets', columns: ['Code'], published: true, presentation: { largeTable: {
      mode: 'key', selector: { kind: 'class', source: 'IS', idField: 'Code', labelField: 'Description', matchField: 'Memberships' }
    } } }] },
    publish: publishSpec().publish
  };
  let totalRelations = 2;
  let relationsReturned = 1;
  const asset = { _id: 501, Code: 'ARM-One', Memberships: ['IS-One'] };
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true,
    templates: [templateCard('ClampedRelationPage', relationSpec), templateCard('LargeTableMembershipBudget', budgetSpec)],
    armCards: [asset],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRelationsPerCardDefault: 1, maxRelationsPerCardMax: 1 } }) }],
    responseOverride(url) {
      if (url.pathname.endsWith('/classes/IS/cards')) {
        return { statusCode: 200, body: { data: [{ _id: 1, Code: 'IS-One' }], meta: { total: 1 } } };
      }
      if (!url.pathname.endsWith('/classes/ARM/cards/501/relations')) return;
      assert.equal(url.searchParams.get('limit'), '1');
      const data = [{ _id: 51, domain: 'AssetSystem', _direction: 'direct', _sourceType: 'ARM', _sourceId: 501,
        _destinationType: 'IS', _destinationId: 1, _destinationCode: 'IS-One' }];
      return { statusCode: 200, body: {
        data: data.slice(0, relationsReturned), ...(totalRelations === null ? {} : { meta: { total: totalRelations } })
      } };
    }
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin);
  const origin = `http://127.0.0.1:${port}`;
  const api = origin + '/cmdbuild/custom-api';
  const headers = { cookie: testCmdbuildAuthorizationCookie('editor'), origin };
  headers['x-cmdbdynamicpages-csrf'] = (await requestJson('GET', api + '/csrf', undefined, headers)).json.token;
  const publish = (code, spec) => publishWithBaseline(`${api}/templates/${code}/publish`, { savedSpecHash: hashJson(spec) }, headers);
  for (const [upstreamTotal, returned] of [[2, 1], [2, 0], [null, 1]]) {
    totalRelations = upstreamTotal;
    relationsReturned = returned;
    const partial = await publish('ClampedRelationPage', relationSpec);
    assertSnapshotLimitError(partial, 'table_result_incomplete', {
      table: 'links', phase: 'rows', stepAlias: 'links', stepType: 'expandRelations',
      limitName: 'maxRelationsPerCard', source: 'runtime-settings', unit: 'relations',
      effectiveLimit: 1, observed: returned, total: upstreamTotal ?? undefined,
      reason: upstreamTotal === null ? 'completeness_unconfirmed' : 'limit_exceeded'
    });
  }
  totalRelations = 1;
  const exact = await publish('ClampedRelationPage', relationSpec);
  assert.equal(exact.statusCode, 200, exact.body);
  const indexed = await publish('LargeTableMembershipBudget', budgetSpec);
  assert.equal(indexed.statusCode, 200, indexed.body);
  const snapshotUrl = api + '/public-snapshots/LargeTableMembershipBudget/run?cmdpTableShell=1';
  const before = await requestJson('GET', snapshotUrl);
  assert.equal(before.statusCode, 200, before.body);
  assert.ok(before.json.tableView.snapshotRevision, before.body);
  asset.Memberships = Array(100001).fill('IS-One');
  const budget = await publish('LargeTableMembershipBudget', budgetSpec);
  assertSnapshotLimitError(budget, 'large_table_membership_limit', {
    table: 'assets', phase: 'index', limitName: 'maxIndexMemberships', source: 'product',
    unit: 'memberships', effectiveLimit: 100000, observed: 100001, reason: 'limit_exceeded'
  });
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
});

test('publication row ceilings respect the independent scan maximum without an explicit scanLimit', async (t) => {
  for (const large of [true, false]) {
    await t.test(large ? '11000 rows within the paged budget of 12000' : '3000 rows cannot override a scan maximum of 2000', async (t) => {
      const code = large ? 'RaisedPagedBudget' : 'OrdinaryScanMaximum';
      const total = large ? 11000 : 2500;
      const spec = publishSpec({
        steps: [{ type: 'selectCards', as: 'assets', className: 'ARM', ...(large ? { limit: 11000,
          filters: [{ path: 'Code', op: 'matches', regex: '^R' }] } : {}) }],
        result: { tables: [{ name: 'assets', columns: ['Code'], published: true,
          ...(large ? { presentation: { largeTable: { mode: 'all' } } } : {}) }] }
      });
      let fetched = 0;
      const { templateUrl, headers } = await startTemplateRace(t, code, {
        templates: [templateCard(code, spec)],
        configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
          RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRowsMax: 3000,
            maxSelectionScanRowsDefault: 10000, maxSelectionScanRowsMax: large ? 50000 : 2000 } }) }],
        responseOverride(url) {
          if (!url.pathname.endsWith('/classes/ARM/cards')) return;
          const offset = Number(url.searchParams.get('start') || 0);
          const count = Math.min(Number(url.searchParams.get('limit')), total - offset);
          const data = Array.from({ length: Math.max(0, count) }, (_, index) => ({ _id: offset + index + 1, Code: 'R' + (offset + index) }));
          fetched += data.length;
          return { statusCode: 200, body: { data, meta: { total } } };
        }
      }, { CMDP_EXECUTION_MAX_ROWS_ABSOLUTE: '3000', CMDP_LARGE_TABLE_MAX_ROWS: '12000' });
      const response = await publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
      if (large) {
        assert.equal(response.statusCode, 200, response.body.slice(0, 1800));
        assert.equal(fetched, 11000);
      } else {
        assertSnapshotLimitError(response, 'table_result_incomplete', {
          table: 'assets', stepAlias: 'assets', limitName: 'maxSelectionScanRows', source: 'runtime-settings',
          configKey: 'maxSelectionScanRowsMax', effectiveLimit: 2000, observed: 2000, total: 2500
        });
        assert.equal(fetched, 2000);
      }
    });
  }
});

test('matchRows with no matches stops at its budget without replacing the published snapshot', async (t) => {
  const code = 'BoundedMatchingPublication';
  const spec = publishSpec({
    steps: [
      { type: 'selectCards', as: 'left', className: 'ARM' },
      { type: 'selectCards', as: 'right', className: 'routerG' },
      { type: 'matchRows', as: 'different', from: 'left', with: 'right',
        rules: [{ leftColumn: 'Code', rightColumn: 'Code', operator: 'equals' }] }
    ],
    result: { tables: [{ name: 'different', columns: ['Code'], published: true, presentation: { largeTable: { mode: 'all' } } }] }
  });
  let total = 1;
  const lastPage = deferredSignal();
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    responseOverride(url) {
      if (!/\/(ARM|routerG)\/cards$/.test(url.pathname)) return;
      const arm = url.pathname.endsWith('/ARM/cards');
      const offset = Number(url.searchParams.get('start') || 0);
      const size = Math.min(Number(url.searchParams.get('limit')), total - offset);
      const data = Array.from({ length: Math.max(0, size) }, (_, index) => ({ _id: offset + index + 1,
        Code: (total === 1 || arm ? 'A' : 'B') + (offset + index) }));
      if (!arm && total > 1 && offset + data.length === total) lastPage.resolve();
      return { statusCode: 200, body: { data, meta: { total } } };
    }
  });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const initial = await publish();
  assert.equal(initial.statusCode, 200, initial.body.slice(0, 1000));
  const before = await requestJson('GET', snapshotUrl);
  total = 2300;
  const inflight = publish();
  assert.equal(await signalBeforeTimeout(lastPage.promise, 10000), true, 'both input datasets were read');
  let finished = false;
  void inflight.then(() => { finished = true; });
  assert.equal((await requestJson('GET', headers.origin + '/health/live')).statusCode, 200);
  assert.equal(finished, false, 'backend serves liveness while matching is in progress');
  assertSnapshotLimitError(await inflight, 'table_result_incomplete', {
    limitName: 'maxMatchRuleChecks', stepAlias: 'different', effectiveLimit: 5000000, observed: 5000000, unit: 'checks'
  });
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
});

test('large-table publication and personal refresh distinguish selector scan and explicit row limits', async (t) => {
  const code = 'PagedSelectorAndRowLimits';
  const spec = publishSpec({
    steps: [
      { type: 'selectCards', as: 'options', className: 'routerG', scanLimit: 1 },
      { type: 'selectCards', as: 'assets', className: 'ARM', limit: 1, scanLimit: 2 }
    ],
    result: { tables: [{ name: 'assets', columns: ['Code'], published: true, presentation: { largeTable: {
      mode: 'key',
      selector: { kind: 'result', source: 'options', idField: 'Code', labelField: 'Description', matchField: 'OwnerKey' }
    } } }] }
  });
  let selectorTotal = 1;
  let assetTotal = 1;
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxSelectionScanRowsDefault: 1 } }) }],
    responseOverride(url) {
      if (url.pathname.endsWith('/classes/routerG/cards')) return {
        statusCode: 200, body: { data: [{ _id: 1, Code: 'A', Description: 'Option A' }], meta: { total: selectorTotal } }
      };
      if (url.pathname.endsWith('/classes/ARM/cards')) return {
        statusCode: 200, body: {
          data: Array.from({ length: assetTotal }, (_, i) => ({ _id: 100 + i, Code: `Asset-${i}`, OwnerKey: 'A' })),
          meta: { total: assetTotal }
        }
      };
    }
  });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const initial = await publish();
  assert.equal(initial.statusCode, 200, initial.body);
  const before = await requestJson('GET', snapshotUrl);
  assert.equal(before.statusCode, 200, before.body);
  const revision = before.json.cache.snapshotRevision;
  assert.ok(revision, before.body);
  selectorTotal = 2;
  assertSnapshotLimitError(await publish(), 'table_result_incomplete', {
    table: 'assets', phase: 'selector', stepAlias: 'options', limitName: 'maxSelectionScanRows',
    source: 'object-flow-step', configKey: 'scanLimit', unit: 'cards', effectiveLimit: 1, observed: 1, total: 2, reason: 'limit_exceeded'
  });
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
  selectorTotal = 1;
  assetTotal = 2;
  const personal = await requestJson('POST', templateUrl + '/refresh-snapshot', {
    expectedMode: 'personal', expectedSnapshotRevision: revision
  }, headers);
  assertSnapshotLimitError(personal, 'table_result_incomplete', {
    table: 'assets', phase: 'rows', stepAlias: 'assets', limitName: 'maxRows',
    source: 'object-flow-step', requested: 1, effectiveLimit: 1, observed: 2, unit: 'rows', reason: 'limit_exceeded'
  });
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
});

test('large-table publication reports only CMDBuild REST calls sent before the budget rejects the next call', async (t) => {
  const code = 'PagedRestBudget';
  const spec = publishSpec({
    steps: [{ type: 'selectCards', as: 'assets', className: 'ARM' }],
    result: { tables: [{ name: 'assets', columns: ['Code'], presentation: { largeTable: { mode: 'all' } } }] }
  });
  const { mock, templateUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRestCallsDefault: 1 } }) }]
  });
  const start = mock.requests.length;
  const response = await publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const executionCalls = mock.requests.slice(start).filter(({ pathname }) =>
    pathname.endsWith('/rest/v3/classes') || pathname.endsWith('/classes/ARM/cards'));
  assert.equal(executionCalls.length, 1);
  assertSnapshotLimitError(response, 'table_result_incomplete', {
    table: 'assets', phase: 'rows', stepAlias: 'assets', limitName: 'maxRestCalls',
    source: 'runtime-settings', unit: 'calls', effectiveLimit: 1, observed: executionCalls.length,
    total: undefined, reason: 'limit_exceeded'
  });
});

test('large-table publish and shared refresh keep real deadlines at 504 and retain the snapshot', async (t) => {
  const code = 'PagedSnapshotDeadline';
  const spec = publishSpec({
    steps: [{ type: 'selectCards', as: 'assets', className: 'ARM' }],
    result: { tables: [{ name: 'assets', columns: ['Code'], presentation: { largeTable: { mode: 'all' } } }] },
    publish: { ...publishSpec().publish, refreshMode: 'shared', sharedRefreshAccepted: true }
  });
  let slow = false;
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    delayByPath: (url) => slow && url.pathname.endsWith('/classes/ARM/cards') ? 1500 : 0
  }, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: '1000' });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const initial = await publish();
  assert.equal(initial.statusCode, 200, initial.body);
  const before = await requestJson('GET', snapshotUrl);
  assert.equal(before.statusCode, 200, before.body);
  const revision = before.json.cache.snapshotRevision;
  assert.ok(revision, before.body);
  const expected = {
    table: 'assets', phase: 'rows', limitName: 'executionTimeoutMs', effectiveLimit: 1000,
    unit: 'milliseconds', reason: 'deadline_exceeded', timeout: true
  };
  slow = true;
  assertSnapshotLimitError(await publish(), 'draft_preview_timeout', expected, 504);
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
  const refresh = await requestJson('POST', templateUrl + '/refresh-snapshot', {
    expectedMode: 'shared', expectedSnapshotRevision: revision
  }, headers);
  assertSnapshotLimitError(refresh, 'snapshot_refresh_timeout', expected, 504);
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
});

test('snapshot lookahead blocked by the REST budget identifies the budget and keeps the previous data', async (t) => {
  const code = 'SnapshotLookaheadBudget';
  const spec = publishSpec({ steps: [{ type: 'selectCards', as: 'assets', className: 'ARM', limit: 1 }],
    result: { tables: [{ name: 'assets', columns: ['Code'] }] } });
  let incomplete = false;
  const { mock, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRestCallsDefault: 2 } }) }],
    responseOverride(url) {
      if (url.pathname.endsWith('/classes/ARM/cards')) return { statusCode: 200, body: {
        data: [{ _id: 501, Code: incomplete ? 'unconfirmed' : 'published' }],
        meta: incomplete ? { count: 1 } : { total: 1 }
      } };
    }
  });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const published = await publish();
  assert.equal(published.statusCode, 200, published.body);
  const before = await requestJson('GET', snapshotUrl);
  incomplete = true;
  const start = mock.requests.length;
  const result = await publish();
  assertSnapshotLimitError(result, 'table_result_incomplete', {
    table: 'assets', phase: 'rows', stepAlias: 'assets', limitName: 'maxRestCalls', effectiveLimit: 2,
    observed: 2, unit: 'calls', total: undefined, reason: 'limit_exceeded'
  });
  assert.deepEqual(result.json.diagnostics.limits.map(({ limitName }) => limitName), ['maxRestCalls']);
  assert.equal(mock.requests.slice(start).filter(({ pathname }) => pathname.endsWith('/classes/ARM/cards')).length, 1);
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
});

test('snapshot completeness rejects ordinary publish and mixed personal refresh without a partial view', async (t) => {
  for (const mixed of [false, true]) {
    await t.test(mixed ? 'mixed personal refresh' : 'ordinary publish', async (t) => {
      const code = mixed ? 'MixedSnapshotCompleteness' : 'OrdinarySnapshotCompleteness';
      const spec = publishSpec({
        steps: [
          { type: 'selectCards', as: 'items', className: 'ARM', limit: 1, scanLimit: 2 },
          ...(mixed ? [{ type: 'selectCards', as: 'paged', className: 'routerG' }] : [])
        ],
        result: { tables: [
          { name: 'items', columns: ['Code'] },
          ...(mixed ? [{ name: 'paged', columns: ['Code'], published: true, presentation: { largeTable: { mode: 'all' } } }] : [])
        ] }
      });
      let rows = [{ _id: 501, Code: 'published' }];
      const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
        templates: [templateCard(code, spec)],
        responseOverride(url) {
          if (url.pathname.endsWith('/classes/ARM/cards')) return {
            statusCode: 200, body: { data: rows, meta: { total: rows.length } }
          };
        }
      });
      const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
      const initial = await publish();
      assert.equal(initial.statusCode, 200, initial.body);
      const before = await requestJson('GET', snapshotUrl);
      assert.equal(before.statusCode, 200, before.body);
      const revision = before.json.cache.snapshotRevision;
      assert.ok(revision, before.body);
      const refresh = () => requestJson('POST', templateUrl + '/refresh-snapshot?cmdpTableShell=1', {
        expectedMode: 'personal', expectedSnapshotRevision: revision
      }, headers);
      if (mixed) {
        const complete = await refresh();
        assert.equal(complete.statusCode, 200, complete.body);
        assert.deepEqual(complete.json.result.tables.map(({ name }) => name), ['items', 'paged']);
        assert.equal(complete.json.tableView.kind, 'personal');
        assert.ok(complete.json.tableView.viewId);
      }

      rows = [{ _id: 502, Code: 'not-published' }, { _id: 503, Code: 'overflow' }];
      const failed = await (mixed ? refresh() : publish());
      assertSnapshotLimitError(failed, 'table_result_incomplete', {
        table: 'items', phase: 'rows', stepAlias: 'items', limitName: 'maxRows',
        effectiveLimit: 1, observed: 2, unit: 'rows', reason: 'limit_exceeded'
      });
      assert.equal(failed.json.tableView, undefined);
      assert.equal(failed.json.diagnostics.omittedCount ?? 0, 0);
      assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
    });
  }
});

test('snapshot report diagnostics bound overflow, retain deadline evidence and mask API and log labels', async (t) => {
  const code = 'SnapshotDiagnosticOverflow';
  const table = 'ghp_' + 'A'.repeat(36);
  const maskedAlias = 'sk-' + 'B'.repeat(32);
  const aliases = [maskedAlias, ...Array.from({ length: 16 }, (_, index) => `items${index + 1}`), 'lateRead'];
  const stepLimitCount = aliases.length - 1;
  const steps = aliases.map((as, index) => ({ type: 'selectCards', as,
    ...(index < stepLimitCount ? { className: 'ARM', limit: 1, scanLimit: 2 } : { className: 'routerG' }) }));
  let output = aliases[0];
  for (const withAlias of aliases.slice(1)) {
    const as = withAlias === aliases.at(-1) ? table : `combined${steps.length}`;
    steps.push({ type: 'unionRows', as, from: output, with: withAlias, on: 'Code' });
    output = as;
  }
  const spec = publishSpec({ steps, result: { tables: [{ name: table, columns: ['Code'] }] } });
  const timeoutMs = 1500;
  let expire = false;
  const { backend, templateUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    armCards: [{ _id: 501, Code: 'first' }, { _id: 502, Code: 'second' }],
    delayByPath: (url) => expire && url.pathname.endsWith('/classes/routerG/cards') ? timeoutMs + 400 : 0
  }, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: String(timeoutMs), CMDP_LOG_LEVEL: 'warn' });

  for (const timedOut of [false, true]) {
    expire = timedOut;
    const response = await publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
    const expected = timedOut ? {
      phase: 'rows', limitName: 'executionTimeoutMs', effectiveLimit: timeoutMs,
      unit: 'milliseconds', reason: 'deadline_exceeded', timeout: true
    } : { phase: 'rows', stepAlias: 'items1', limitName: 'maxRows', reason: 'limit_exceeded' };
    const limits = assertSnapshotLimitError(response, timedOut ? 'draft_preview_timeout' : 'table_result_incomplete',
      expected, timedOut ? 504 : 422);
    assert.equal(limits.length, 16);
    assert.equal(response.json.diagnostics.omittedCount, 1 + Number(timedOut));
    assert.ok(limits.every((entry) => entry.table === '[REDACTED]'));
    assert.equal(limits.find((entry) => entry.stepIndex === 0)?.stepAlias, '[REDACTED]');
    assert.ok(!response.body.includes(table) && !response.body.includes(maskedAlias));

    const requestId = response.headers['x-request-id'];
    assert.ok(requestId);
    let failure;
    await waitFor(() => {
      failure = backend.testOutput.split('\n')
        .filter((line) => line.includes('"event":"template.execution_failed"') && line.endsWith('}'))
        .map((line) => JSON.parse(line)).find((entry) => entry.requestId === requestId);
      return Boolean(failure);
    }, 1500);
    assert.deepEqual(failure.diagnostics, response.json.diagnostics);
    assert.ok(!backend.testOutput.includes(table) && !backend.testOutput.includes(maskedAlias));
  }
});

test('snapshot index budget masks the complete diagnostic label before clipping it in the API and log', async (t) => {
  const code = 'SnapshotIndexLabel';
  const prefix = 'Report' + 'a'.repeat(110);
  const simulatedCredential = 'template-race-session';
  const table = prefix + simulatedCredential;
  const spec = publishSpec({ steps: [
    { type: 'selectCards', as: 'options', className: 'routerG' },
    { type: 'selectCards', as: table, className: 'ARM' }
  ], result: { tables: [{ name: table, columns: ['Code'], presentation: { largeTable: {
    mode: 'key', selector: { kind: 'result', source: 'options', idField: 'Code', labelField: 'Code', matchField: 'Membership' }
  } } }] } });
  const { backend, templateUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    armCards: [{ _id: 501, Code: 'asset', Membership: Array.from({ length: 100001 }, () => 'membership') }]
  }, { CMDP_LOG_LEVEL: 'warn' });
  const failed = await publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const limits = assertSnapshotLimitError(failed, 'large_table_membership_limit', {
    table: prefix + '[REDACTED]', phase: 'index', limitName: 'maxIndexMemberships', observed: 100001
  });
  assert.ok(!failed.body.includes(table.slice(0, 128)));
  const requestId = failed.headers['x-request-id'];
  let failure;
  await waitFor(() => {
    failure = backend.testOutput.split('\n')
      .filter((line) => line.includes('"event":"template.execution_failed"') && line.endsWith('}'))
      .map((line) => JSON.parse(line)).find((entry) => entry.requestId === requestId);
    return Boolean(failure);
  }, 1500);
  assert.deepEqual(failure.diagnostics.limits, limits);
});

function assertSnapshotCommitDeadline(response, reason, timeoutMs) {
  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json.reason, reason, response.body);
  assert.equal(response.json.code, reason, response.body);
  assert.equal(response.json.result, undefined);
  assert.equal(response.json.tableView, undefined);
  assert.equal(response.json.diagnostics.omittedCount ?? 0, 0);
  const [entry] = response.json.diagnostics.limits;
  assert.equal(response.json.diagnostics.limits.length, 1);
  assert.deepEqual([entry.phase, entry.table, entry.limitName, entry.reason, entry.effectiveLimit, entry.unit, entry.timeout],
    ['commit', '', 'executionTimeoutMs', 'deadline_exceeded', timeoutMs, 'milliseconds', true]);
  for (const field of ['stepAlias', 'stepType', 'stepIndex']) assert.equal(entry[field], undefined);
}

test('snapshot deadline at template recheck prevents publish and shared refresh commits', async (t) => {
  const code = 'SnapshotCommitDeadline';
  const spec = publishSpec({
    steps: [{ type: 'selectCards', as: 'items', className: 'ARM' }],
    result: { tables: [{ name: 'items', columns: ['Code'] }] },
    publish: { ...publishSpec().publish, refreshMode: 'shared', sharedRefreshAccepted: true }
  });
  const timeoutMs = 1000;
  let expire = false;
  let dataRead = false;
  let rechecks = 0;
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    async responseOverride(url) {
      if (url.pathname.endsWith('/classes/ARM/cards')) {
        dataRead = true;
        return { statusCode: 200, body: { data: [{ _id: 501, Code: expire ? 'not-published' : 'published' }], meta: { total: 1 } } };
      }
      if (expire && dataRead && url.pathname.endsWith('/classes/Cst_QueryTemplate/cards')) {
        dataRead = false;
        rechecks++;
        await new Promise((resolve) => setTimeout(resolve, timeoutMs + 300));
      }
    }
  }, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: String(timeoutMs) });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const initial = await publish();
  assert.equal(initial.statusCode, 200, initial.body);
  const before = await requestJson('GET', snapshotUrl);
  assert.equal(before.statusCode, 200, before.body);
  const revision = before.json.cache.snapshotRevision;
  assert.ok(revision, before.body);
  const refresh = () => requestJson('POST', templateUrl + '/refresh-snapshot', {
    expectedMode: 'shared', expectedSnapshotRevision: revision
  }, headers);

  expire = true;
  for (const [invoke, reason] of [[publish, 'draft_preview_timeout'], [refresh, 'snapshot_refresh_timeout']]) {
    dataRead = false;
    const priorRechecks = rechecks;
    const response = await invoke();
    assert.equal(rechecks, priorRechecks + 1, 'deadline fixture reached the post-execution template read');
    assertSnapshotCommitDeadline(response, reason, timeoutMs);
    assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
  }
});

test('snapshot deadline in the mutation queue does not let the next writer overtake its predecessor', async (t) => {
  const code = 'SnapshotCommitQueueDeadline';
  const spec = publishSpec({
    steps: [{ type: 'selectCards', as: 'items', className: 'ARM' }],
    result: { tables: [{ name: 'items', columns: ['Code'] }] },
    publish: { ...publishSpec().publish, refreshMode: 'shared', sharedRefreshAccepted: true }
  });
  const savedSpecHash = hashJson(spec);
  const timeoutMs = 1000;
  const predecessorEntered = deferredSignal();
  const releasePredecessor = deferredSignal();
  const nextWriterEntered = deferredSignal();
  const nextWriterToken = 'snapshot-queue-next-writer';
  let holdNextRead = false;
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    async responseOverride(url, req) {
      if (req.method !== 'GET' || !url.pathname.endsWith('/classes/Cst_QueryTemplate/cards')) return;
      if (holdNextRead) {
        holdNextRead = false;
        predecessorEntered.resolve();
        await releasePredecessor.promise;
      } else if (req.headers['cmdbuild-authorization'] === nextWriterToken) {
        nextWriterEntered.resolve();
      }
    }
  }, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: String(timeoutMs) });
  const initial = await publishWithBaseline(templateUrl + '/publish', { savedSpecHash }, headers);
  assert.equal(initial.statusCode, 200, initial.body);
  const before = await requestJson('GET', snapshotUrl);
  assert.equal(before.statusCode, 200, before.body);
  const revision = before.json.cache.snapshotRevision;
  assert.ok(revision, before.body);
  const cookie = testCmdbuildAuthorizationCookie(nextWriterToken);
  const csrf = await requestJson('GET', `${headers.origin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const nextHeaders = { ...headers, cookie, 'x-cmdbdynamicpages-csrf': csrf.json.token };

  holdNextRead = true;
  const predecessor = requestJson('PUT', templateUrl, { code, spec, expectedSpecHash: 'f'.repeat(64) }, headers);
  let nextWriter;
  try {
    assert.equal(await signalBeforeTimeout(predecessorEntered.promise, 2000), true, 'first PUT holds the mutation lock');
    const refresh = await requestJson('POST', templateUrl + '/refresh-snapshot', {
      expectedMode: 'shared', expectedSnapshotRevision: revision
    }, headers, 2500);
    assertSnapshotCommitDeadline(refresh, 'snapshot_refresh_timeout', timeoutMs);
    assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);

    nextWriter = requestJson('PUT', templateUrl, { code, spec, expectedSpecHash: savedSpecHash }, nextHeaders);
    assert.equal(await signalBeforeTimeout(nextWriterEntered.promise, 250), false, 'second PUT must still be queued');
  } finally {
    releasePredecessor.resolve();
    await Promise.allSettled([predecessor, nextWriter]);
  }
  const conflict = await predecessor;
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json.code, 'template_version_conflict');
  const saved = await nextWriter;
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(await signalBeforeTimeout(nextWriterEntered.promise, 100), true);
});

test('snapshot catalog rejects invalid envelopes and conflicting counts without replacing the report', async (t) => {
  const code = 'SnapshotInvalidCatalog';
  const spec = publishSpec({ steps: [{ type: 'listDomains', as: 'domains' }],
    result: { tables: [{ name: 'domains', columns: ['Domain'], published: true, presentation: { largeTable: { mode: 'all' } } }] } });
  const domain = { name: 'AssetLocation', source: 'ARM', destination: 'Location' };
  let catalog = { data: [domain], meta: { total: 1 } };
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    responseOverride(url) {
      if (url.pathname.endsWith('/rest/v3/domains')) return { statusCode: 200, body: catalog };
      if (url.pathname.endsWith('/domains/AssetLocation')) return { statusCode: 200, body: { data: domain } };
    }
  });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const initial = await publish();
  assert.equal(initial.statusCode, 200, initial.body);
  const before = await requestJson('GET', snapshotUrl);
  for (const invalid of [
    { meta: { total: 1 } }, { success: false, data: [] }, { data: [domain], meta: { count: 2 } },
    { data: [domain], meta: { total: 0 } }, { data: [domain], meta: { total: 'unknown' } }
  ]) {
    catalog = invalid;
    for (const result of [await publish(), await requestJson('POST', templateUrl + '/refresh-snapshot?cmdpTableShell=1', {
      expectedMode: 'personal', expectedSnapshotRevision: before.json.cache.snapshotRevision
    }, headers)]) {
      assertSnapshotLimitError(result, 'table_result_incomplete', {
        limitName: 'maxDomains', reason: 'completeness_unconfirmed', total: undefined, stepAlias: 'domains'
      });
      assert.equal(result.json.tableView, undefined);
    }
    assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
  }
});

for (const mode of ['shared', 'personal']) {
  test(`runtime settings failures stop Publish and ${mode} refresh before reading report data`, async (t) => {
    const code = `SnapshotStrictRuntimeConfig_${mode}`;
    const spec = publishSpec({
      steps: [{ type: 'selectCards', as: 'items', className: 'ARM' }],
      result: { tables: [{ name: 'items', columns: ['Code'], published: true, presentation: { largeTable: { mode: 'all' } } }] },
      publish: { ...publishSpec().publish, refreshMode: mode, sharedRefreshAccepted: mode === 'shared' }
    });
    let configFailure;
    let configDelayed = false;
    const { mock, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
      templates: [templateCard(code, spec)],
      delayByPath: (url) => configDelayed && url.pathname.endsWith('/classes/Cst_QueryToolConfig/cards') ? 1400 : 0,
      responseOverride(url) {
        if (url.pathname.endsWith('/classes/Cst_QueryToolConfig/cards')) return configFailure;
      }
    }, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: '1000', CMDBUILD_RETRY_MAX_ATTEMPTS: '1' });
    const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
    const initial = await publish();
    assert.equal(initial.statusCode, 200, initial.body); // A confirmed empty config collection uses defaults.
    const before = await requestJson('GET', snapshotUrl);
    const revision = before.json.cache.snapshotRevision;
    const refresh = () => requestJson('POST', templateUrl + '/refresh-snapshot?cmdpTableShell=1', {
      expectedMode: mode, expectedSnapshotRevision: revision
    }, headers);
    const failures = [
      [503, { message: 'private upstream config detail' }, 502, 'report_runtime_config_unavailable'],
      [200, { success: false, data: [] }, 502, 'report_runtime_config_unavailable'],
      [200, { data: [], meta: { total: 1 } }, 502, 'report_runtime_config_unavailable'],
      [200, { data: [{ Code: 'Cst_QueryTool', Active: true, RuntimeConfigJson: '{invalid' }] }, 502, 'report_runtime_config_unavailable'],
      [403, { message: 'private upstream config detail' }, 403, 'data_access_denied']
    ];
    for (const [statusCode, body, expectedStatus, reason] of failures) {
      configFailure = { statusCode, body };
      const start = mock.requests.length;
      for (const result of [await publish(), await refresh()]) {
        assert.equal(result.statusCode, expectedStatus, result.body);
        assert.equal(result.json.reason, reason, result.body);
        assert.equal(result.json.tableView, undefined);
        assert.doesNotMatch(result.body, /private upstream config detail|\{invalid/);
      }
      assert.equal(mock.requests.slice(start).filter(({ pathname }) => pathname.endsWith('/classes/ARM/cards')).length, 0);
      assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
    }
    configFailure = undefined;
    configDelayed = true;
    const start = mock.requests.length;
    const publishTimeout = await publish();
    const refreshTimeout = await refresh();
    assert.equal(publishTimeout.statusCode, 504, publishTimeout.body);
    assert.equal(publishTimeout.json.reason, 'draft_preview_timeout');
    assert.equal(refreshTimeout.statusCode, 504, refreshTimeout.body);
    assert.equal(refreshTimeout.json.reason, 'snapshot_refresh_timeout');
    assert.equal(mock.requests.slice(start).filter(({ pathname }) => pathname.endsWith('/classes/ARM/cards')).length, 0);
    assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
  });
}

for (const mode of ['shared', 'personal']) {
  test(`snapshot selector and rows share the REST budget during Publish and ${mode} refresh`, async (t) => {
    const code = `SnapshotCombinedRestBudget_${mode}`;
    const spec = publishSpec({
      steps: [{ type: 'selectCards', as: 'items', className: 'ARM' }],
      result: { tables: [{ name: 'items', columns: ['Code'], published: true, presentation: { largeTable: {
        mode: 'key', selector: { kind: 'class', source: 'IS', idField: 'Code', labelField: 'Description', matchField: 'Code' }
      } } }] },
      publish: { ...publishSpec().publish, refreshMode: mode, sharedRefreshAccepted: mode === 'shared' }
    });
    const configCard = { _id: 1, Code: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRestCallsDefault: 4 } }) };
    const { mock, templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
      templates: [templateCard(code, spec)],
      configCards: [configCard],
      responseOverride(url) {
        if (!/\/classes\/(IS|ARM)\/cards$/.test(url.pathname)) return;
        return { statusCode: 200, body: { data: [{ _id: 51, Code: 'item', Description: 'Option' }], meta: { total: 1 } } };
      }
    });
    const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
    const readPhases = (start) => mock.requests.slice(start).flatMap(({ pathname }) =>
      /\/rest\/v3\/(classes(?:\/(?:IS|ARM)\/cards)?)\/?$/.exec(pathname)?.[1] || []);
    const initial = await publish();
    assert.equal(initial.statusCode, 200, initial.body);
    assert.deepEqual(readPhases(0), ['classes', 'classes/IS/cards', 'classes', 'classes/ARM/cards'], 'each phase fits in two requests');
    const before = await requestJson('GET', snapshotUrl);
    const revision = before.json.cache.snapshotRevision;
    configCard.RuntimeConfigJson = JSON.stringify({ executionLimits: { maxRestCallsDefault: 2 } });
    const refresh = () => requestJson('POST', templateUrl + '/refresh-snapshot?cmdpTableShell=1', {
      expectedMode: mode, expectedSnapshotRevision: revision
    }, headers);
    for (const execute of [publish, refresh]) {
      const start = mock.requests.length;
      const result = await execute();
      assert.equal(result.statusCode, 422, result.body);
      assert.equal(result.json.reason, 'table_result_incomplete', result.body);
      assert.equal(result.json.tableView, undefined);
      const { table, phase, effectiveLimit, observed } = result.json.diagnostics.limits.find((item) => item.limitName === 'maxRestCalls');
      assert.deepEqual({ table, phase, effectiveLimit, observed }, { table: 'items', phase: 'rows', effectiveLimit: 2, observed: 2 });
      assert.deepEqual(readPhases(start), ['classes', 'classes/IS/cards'], 'rows may not start another CMDBuild request');
      assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
    }
  });
}

test('snapshot traversal keeps the reverse row visible when a smaller depth cap rejects a replacement', async (t) => {
  const code = 'SnapshotReaderDomainDepth';
  const spec = {
    version: 1,
    steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM' },
      { type: 'traverseDomains', as: 'domains', from: 'assets', direction: 'both', depth: 2 }
    ],
    result: { tables: [{ name: 'domains', columns: ['Depth', 'Class', 'Domain', 'Direction'], published: true, presentation: { largeTable: { mode: 'all' } } }] },
    publish: publishSpec().publish
  };
  const domains = [{ name: 'AssetLocation', source: 'ARM', destination: 'Location' }];
  const configCard = { _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
    RuntimeConfigJson: JSON.stringify({ executionLimits: { maxTraversalDepthMax: 2 } }) };
  const { templateUrl, snapshotUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)],
    configCards: [configCard],
    responseOverride(url) {
      if (url.pathname.endsWith('/rest/v3/domains')) {
        return { statusCode: 200, body: { data: domains, meta: { total: domains.length } } };
      }
      const domain = domains.find(({ name }) => url.pathname.endsWith('/domains/' + name));
      if (domain) return { statusCode: 200, body: { data: domain } };
    }
  });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const terminal = await publish();
  assert.equal(terminal.statusCode, 200, terminal.body);
  const before = await requestJson('GET', snapshotUrl);
  const query = encodeURIComponent(JSON.stringify({ table: 'domains', op: 'rows', snapshotRevision: before.json.cache.snapshotRevision }));
  const pageUrl = snapshotUrl.replace('/run?json=true', '/table-page?cmdpTable=' + query);
  const page = await requestJson('GET', pageUrl);
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(page.json.table.rows.map(({ Depth, Class, Domain, Direction }) => [Number(Depth), Class, Domain, Direction]), [
    [1, 'ARM', 'AssetLocation', 'source'], [2, 'Location', 'AssetLocation', 'destination']
  ]);
  configCard.RuntimeConfigJson = JSON.stringify({ executionLimits: { maxTraversalDepthMax: 1 } });
  const incomplete = await publish();
  assert.equal(incomplete.statusCode, 422, incomplete.body);
  assert.equal(incomplete.json.reason, 'table_result_incomplete', incomplete.body);
  const evidence = incomplete.json.diagnostics?.limits?.find((item) => item.limitName === 'maxTraversalDepth');
  assert.deepEqual(evidence, {
    table: 'domains', phase: 'rows', stepAlias: 'domains', stepIndex: 1, stepType: 'traverseDomains',
    source: 'runtime-settings', configKey: 'maxTraversalDepthMax', limitName: 'maxTraversalDepth', reason: 'limit_exceeded',
    unit: 'hops', requested: 2, effectiveLimit: 1, observed: 2, limitHit: true, truncated: true, timeout: false
  }, incomplete.body);
  assert.deepEqual((await requestJson('GET', snapshotUrl)).json, before.json);
  assert.deepEqual((await requestJson('GET', pageUrl)).json, page.json);
});

test('snapshot reader resolves relation targets past a partial catalog without swallowing denied detail reads', async (t) => {
  const code = 'SnapshotReaderRelationClassScope';
  const spec = {
    version: 1,
    steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM' },
      { type: 'expandRelations', as: 'links', from: 'assets', targetClass: 'Target', direction: 'source', fetchRelated: false }
    ],
    result: { tables: [{ name: 'links', columns: ['RelatedClass'], published: true }] },
    publish: publishSpec().publish
  };
  const catalog = [
    { name: 'ARM', active: true }, { name: 'Target', active: true, prototype: true },
    ...Array.from({ length: 498 }, (_, i) => ({ name: 'Other' + i, active: true })),
    { name: 'Child', active: true, parent: 'Target' }
  ];
  let detailStatus = 404;
  let relationTotal = 2;
  const relations = ['Child', 'Other0'].map((_destinationType, i) => ({
    _id: 51 + i, domain: 'AssetTarget', _direction: 'direct', _sourceType: 'ARM', _sourceId: 501,
    _destinationType, _destinationId: 1 + i
  }));
  const { mock, templateUrl, headers } = await startTemplateRace(t, code, {
    templates: [templateCard(code, spec)], classes: catalog,
    armCards: [{ _id: 501, Code: 'Source' }],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRelationsPerCardDefault: 2, maxRelationsPerCardMax: 3 } }) }],
    responseOverride(url) {
      if (url.pathname.endsWith('/classes/Target')) return { statusCode: detailStatus, body: { success: false } };
      if (url.pathname.endsWith('/ARM/cards/501/relations')) return {
        statusCode: 200, body: { data: relations, meta: { count: relations.length, total: relationTotal } }
      };
    }
  });
  const publish = () => publishWithBaseline(templateUrl + '/publish', { savedSpecHash: hashJson(spec) }, headers);
  const complete = await publish();
  assert.equal(complete.statusCode, 200, complete.body);
  assert.deepEqual(complete.json.result.tables[0].rows, [{ RelatedClass: 'Child' }]);
  assert.equal(mock.requests.filter(({ pathname, search }) =>
    pathname.endsWith('/rest/v3/classes') && new URLSearchParams(search).get('start') === '500').length, 2);

  relationTotal = undefined;
  const unconfirmed = await publish();
  assertSnapshotLimitError(unconfirmed, 'table_result_incomplete', {
    limitName: 'maxRelationsPerCard', reason: 'completeness_unconfirmed', effectiveLimit: 2, observed: 2, unit: 'relations'
  });
  const relationRequests = mock.requests.filter(({ pathname }) => pathname.endsWith('/ARM/cards/501/relations'));
  assert.deepEqual(relationRequests.map(({ search }) => new URLSearchParams(search).get('limit')), ['3', '3']);

  detailStatus = 403;
  const start = mock.requests.length;
  const denied = await publish();
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json.diagnostics, undefined);
  assert.ok(!mock.requests.slice(start).some(({ pathname }) => pathname.endsWith('/relations')));
});

test('large tables page 400 options, 4000 linked rows and 6000 unrestricted rows without sending the entire result', async (t) => {
  const optionCards = Array.from({ length: 400 }, (_, index) => ({
    _id: index + 1, Code: 'IS-' + index, Description: index < 2 ? 'Shared name' : 'Object ' + index
  }));
  const rows = Array.from({ length: 6000 }, (_, index) => ({
    _id: 10_000 + index,
    Code: 'Row-' + String(index).padStart(5, '0'),
    OwnerKey: index < 110 ? 'IS-0' : 'IS-' + (1 + (index - 110) % 399),
    Description: 'Description ' + index
  }));
  const keyed = {
    version: 1, steps: [{ type: 'selectCards', as: 'items', className: 'ARM' }],
    result: { tables: [{ name: 'items', columns: ['Code', 'Description'], presentation: { largeTable: {
      mode: 'key', selector: { kind: 'class', source: 'IS', idField: 'Code', labelField: 'Description', matchField: 'OwnerKey' }
    } } }] }
  };
  const unscoped = {
    ...keyed, steps: [{ type: 'selectCards', as: 'items', className: 'routerG' }],
    result: { tables: [{ name: 'items', columns: ['Code'], presentation: { largeTable: { mode: 'all' } } }] }
  };
  const snapshotSpec = { ...keyed, publish: { ...publishSpec().publish, refreshMode: 'shared', sharedRefreshAccepted: true } };
  const personalSpec = { ...keyed, publish: { ...publishSpec().publish, refreshMode: 'personal' } };
  let failReads = false;
  let sourceVersion = '';
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true,
    templates: [templateCard('PagedKey', keyed), templateCard('PagedAll', unscoped), templateCard('PagedSnapshot', snapshotSpec),
      templateCard('PagedPersonal', personalSpec)],
    async responseOverride(url) {
      const className = /\/classes\/(IS|ARM|routerG)\/cards$/.exec(url.pathname)?.[1];
      if (!className) return;
      if (failReads) return { statusCode: 403, body: { success: false } };
      const source = className === 'IS' ? optionCards : className === 'ARM' ? rows.slice(0, 4000) : rows;
      const start = Number(url.searchParams.get('start') || 0);
      const limit = Number(url.searchParams.get('limit') || 1000);
      const data = source.slice(start, start + limit);
      return { statusCode: 200, body: { data: sourceVersion && className === 'ARM'
        ? data.map((row) => ({ ...row, Description: row.Description + sourceVersion })) : data, meta: { total: source.length } } };
    }
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin);
  const origin = `http://127.0.0.1:${port}`;
  const api = origin + '/cmdbuild/custom-api';
  const reader = { cookie: testCmdbuildAuthorizationCookie('reader') };
  const other = { cookie: testCmdbuildAuthorizationCookie('other') };
  const editor = { cookie: testCmdbuildAuthorizationCookie('editor'), origin };
  editor['x-cmdbdynamicpages-csrf'] = (await requestJson('GET', api + '/csrf', undefined, editor)).json.token;
  const query = (data) => '?cmdpTable=' + encodeURIComponent(JSON.stringify({ table: 'items', ...data }));
  const page = (code, data, headers = reader, prefix = 'templates') =>
    requestJson('GET', `${api}/${prefix}/${code}/table-page${query(data)}`, undefined, headers);
  const report = (code, headers = reader, prefix = 'templates') =>
    requestJson('GET', `${api}/${prefix}/${code}/run?cmdpTableShell=1`, undefined, headers);
  const readRows = () => mock.requests.filter((request) => /\/classes\/(ARM|routerG)\/cards$/.test(request.pathname)).length;

  const before = readRows();
  const initial = await report('PagedKey');
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json.tableView, { kind: 'dynamic', pageSize: 50 });
  assert.deepEqual(initial.json.result.tables[0].rows, []);
  const options = await page('PagedKey', { op: 'options' });
  assert.equal(options.statusCode, 200, options.body);
  assert.equal(options.json.total, 400);
  assert.equal(options.json.items.length, 50);
  const named = await page('PagedKey', { op: 'options', search: 'Shared name' });
  assert.equal(named.json.items.length, 2);
  assert.notEqual(named.json.items[0].key, named.json.items[1].key);
  assert.equal(readRows(), before, 'opening the report or searching choices ran its dependent table');
  const chosen = await Promise.all(named.json.items.map(({ key }) => page('PagedKey', { op: 'rows', key })));
  const first = chosen.find((entry) => entry.json.total === 110);
  assert.ok(first, chosen.map((entry) => entry.body).join('\n'));
  const key = named.json.items[chosen.indexOf(first)].key;
  assert.equal(first.json.table.rows.length, 50);
  const afterCalculation = readRows();
  const next = await page('PagedKey', { op: 'rows', key, offset: 50, viewId: first.json.viewId });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json.table.rows[0].Code, 'Row-00050');
  assert.equal(readRows(), afterCalculation);
  const crossSession = await page('PagedKey', { op: 'rows', key, viewId: first.json.viewId }, other);
  assert.equal(crossSession.statusCode, 409, crossSession.body);
  const sixThousand = await page('PagedAll', { op: 'rows', sort: 'Code', direction: 'desc', offset: 5950, limit: 100 });
  assert.equal(sixThousand.statusCode, 200, sixThousand.body);
  assert.equal(sixThousand.json.total, 6000);
  assert.equal(sixThousand.json.table.rows.length, 50);
  assert.equal(sixThousand.json.table.rows[0].Code, 'Row-00049');
  assert.equal(sixThousand.json.incomplete, false);

  const publish = await publishWithBaseline(api + '/templates/PagedSnapshot/publish', { savedSpecHash: hashJson(snapshotSpec) }, editor);
  assert.equal(publish.statusCode, 200, publish.body);
  const publishedPersonal = await publishWithBaseline(api + '/templates/PagedPersonal/publish', { savedSpecHash: hashJson(personalSpec) }, editor);
  assert.equal(publishedPersonal.statusCode, 200, publishedPersonal.body);
  const startPublic = mock.requests.length;
  const publicly = await report('PagedSnapshot', {}, 'public-snapshots');
  assert.equal(publicly.statusCode, 200, publicly.body);
  assert.deepEqual(publicly.json.result.tables[0].rows, []);
  const { snapshotRevision } = publicly.json.tableView;
  const publicPage = await page('PagedSnapshot', { op: 'rows', key, snapshotRevision }, {}, 'public-snapshots');
  assert.equal(publicPage.statusCode, 200, publicPage.body);
  assert.equal(publicPage.json.total, 110);
  assert.equal(mock.requests.length, startPublic, 'anonymous paging must not contact CMDBuild');
  failReads = true;
  const refresh = (revision) => requestJson('POST', api + '/templates/PagedSnapshot/refresh-snapshot?cmdpTableShell=1',
    { expectedMode: 'shared', expectedSnapshotRevision: revision }, editor);
  const failed = await refresh(snapshotRevision);
  assert.equal(failed.statusCode, 403, failed.body);
  assert.deepEqual((await page('PagedSnapshot', { op: 'rows', key, snapshotRevision }, {}, 'public-snapshots')).json, publicPage.json);
  failReads = false;
  sourceVersion = ' updated';
  const refreshed = await refresh(snapshotRevision);
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const latestRevision = refreshed.json.tableView.snapshotRevision;
  assert.notEqual(latestRevision, snapshotRevision);
  assert.equal((await page('PagedSnapshot', { op: 'rows', key, snapshotRevision }, {}, 'public-snapshots')).statusCode, 409);
  const latest = await page('PagedSnapshot', { op: 'rows', key, snapshotRevision: latestRevision }, {}, 'public-snapshots');
  assert.equal(latest.json.table.rows[0].Description, 'Description 0 updated');
  const personalBefore = await report('PagedPersonal', {}, 'public-snapshots');
  const personalRevision = personalBefore.json.tableView.snapshotRevision;
  const personal = await requestJson('POST', api + '/templates/PagedPersonal/refresh-snapshot?cmdpTableShell=1',
    { expectedMode: 'personal', expectedSnapshotRevision: personalRevision }, editor);
  assert.equal(personal.statusCode, 200, personal.body);
  assert.deepEqual(personal.json.result.tables[0].rows, []);
  assert.equal(personal.json.tableView.kind, 'personal');
  const viewId = personal.json.tableView.viewId;
  const personalPage = await page('PagedPersonal', { op: 'rows', key, viewId }, editor);
  assert.equal(personalPage.statusCode, 200, personalPage.body);
  assert.equal(personalPage.json.table.rows[0].Description, 'Description 0 updated');
  assert.equal((await page('PagedPersonal', { op: 'rows', key, viewId }, other)).statusCode, 409);
  const staticPage = await page('PagedPersonal', { op: 'rows', key, snapshotRevision: personalRevision }, {}, 'public-snapshots');
  assert.equal(staticPage.json.table.rows[0].Description, 'Description 0');
});

test('large report selector filters the computed difference without restricting the exclusion input', async (t) => {
  const spec = { version: 1, steps: [
    { type: 'selectCards', as: 'items', className: 'ARM' },
    { type: 'selectCards', as: 'owners', className: 'routerG' },
    { type: 'differenceRows', from: 'items', with: 'owners', on: 'Ticket', as: 'remaining' }
  ], result: { presentation: { outputMode: 'tables' }, tables: [{ name: 'remaining', columns: ['Code', 'OwnerKey'],
    presentation: { largeTable: { mode: 'key', groupKeys: ['OwnerKey'], reductions: [{ column: 'Code', kind: 'unique' }], selector: {
      kind: 'result', source: 'owners', idField: 'Code', labelField: 'Description', matchField: 'OwnerKey'
    } } } }] } };
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true, templates: [templateCard('PagedDifference', spec)],
    armCards: [{ _id: 1, Code: 'excluded', OwnerKey: 'A', Ticket: 'X' },
      { _id: 2, Code: 'retained', OwnerKey: 'A', Ticket: 'Z' },
      { _id: 3, Code: 'other', OwnerKey: 'B', Ticket: 'Z' }],
    routerCards: [{ _id: 4, Code: 'A', Ticket: 'Y', Description: 'First' },
      { _id: 5, Code: 'B', Ticket: 'X', Description: 'Second' }]
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin);
  const url = `http://127.0.0.1:${port}/cmdbuild/custom-api/templates/PagedDifference`;
  const headers = { cookie: testCmdbuildAuthorizationCookie('reader') };
  const page = (op, key) => requestJson('GET', url + '/table-page?cmdpTable=' + encodeURIComponent(JSON.stringify({
    table: 'remaining', op, key
  })), undefined, headers);
  const full = await requestJson('GET', url + '/run', undefined, headers);
  assert.equal(full.statusCode, 200, full.body);
  const expected = full.json.result.tables[0].rows.filter((row) => row.OwnerKey === 'A');
  assert.deepEqual(expected, [{ Code: 'retained', OwnerKey: 'A' }]);
  const options = await page('options');
  assert.equal(options.statusCode, 200, options.body);
  const start = mock.requests.length;
  const chosen = await page('rows', options.json.items.find((item) => item.label === 'First').key);
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.deepEqual(chosen.json.table.rows, expected);
  const exclusionReads = mock.requests.slice(start).filter((request) => request.pathname.endsWith('/routerG/cards'));
  assert.equal(exclusionReads.length, 1, 'the selector result is executed only as the right input of differenceRows');
  assert.equal(new URLSearchParams(exclusionReads[0].search).has('filter'), false);
});

test('large report selector validates a standalone source and binds Designer expressions through composeRows.right', async (t) => {
  const createSpec = (filter) => ({ version: 1, params: { selected: { type: 'string', default: 'Not selected' } }, steps: [
    { type: 'selectCards', as: 'owners', className: 'Location' },
    { type: 'selectCards', as: 'items', className: 'ARM', filters: [filter] },
    { type: 'selectCards', as: 'details', className: 'routerG' },
    { type: 'composeRows', as: 'combined', from: 'items', right: 'details', on: 'Ticket', columns: [
      { name: 'OwnerKey', column: 'OwnerKey' }, { name: 'Detail', source: 'right', column: 'Description' }
    ] }
  ], result: { presentation: { outputMode: 'tables' }, tables: [{ name: 'combined', columns: ['Detail'],
    presentation: { largeTable: { mode: 'key', selector: {
      kind: 'result', source: 'owners', idField: 'Code', labelField: 'Description', matchField: 'OwnerKey', parameter: 'selected'
    } } } }] } });
  const testCases = [
    ['PagedValueExpression', { path: 'OwnerKey', op: 'equals', valueExpression: '${param.selected}' }],
    ['PagedRegexExpression', { path: 'OwnerKey', op: 'matches', regexExpression: '^${param.selected}$' }]
  ];
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true, templates: testCases.map(([code, filter]) => templateCard(code, createSpec(filter))),
    cardsByClass: { Location: [{ _id: 9, Code: 'A[1]', Description: 'Selected owner' }] },
    armCards: [
      { _id: 1, Code: 'retained', OwnerKey: 'A[1]', Ticket: 'X' },
      { _id: 2, Code: 'excluded', OwnerKey: 'A1', Ticket: 'Y' }
    ],
    routerCards: [{ _id: 3, Ticket: 'X', Description: 'Matched detail' }, { _id: 4, Ticket: 'Y', Description: 'Other detail' }]
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin);
  const origin = `http://127.0.0.1:${port}`;
  const api = origin + '/cmdbuild/custom-api';
  const headers = { origin, cookie: testCmdbuildAuthorizationCookie('editor') };
  headers['x-cmdbdynamicpages-csrf'] = (await requestJson('GET', api + '/csrf', undefined, headers)).json.token;
  const rowsRead = (after, name) => mock.requests.slice(after).filter((request) => request.pathname.endsWith(`/${name}/cards`));
  for (const [code, filter] of testCases) {
    const url = `${api}/templates/${code}`;
    const spec = createSpec(filter);
    const save = await requestJson('PUT', url, { code, expectedSpecHash: hashJson(spec), spec }, headers);
    assert.equal(save.statusCode, 200, save.body);
    const shellStart = mock.requests.length;
    const shell = await requestJson('GET', url + '/run?cmdpTableShell=1', undefined, headers);
    assert.equal(shell.statusCode, 200, shell.body);
    assert.deepEqual(shell.json.result.tables[0].rows, []);
    assert.equal(rowsRead(shellStart, 'Location').length, 0);
    assert.equal(rowsRead(shellStart, 'ARM').length, 0);
    const page = (op, key, reqHeaders = headers) => requestJson('GET', url + '/table-page?cmdpTable=' +
      encodeURIComponent(JSON.stringify({ table: 'combined', op, key })), undefined, reqHeaders);
    const options = await page('options');
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json.total, 1);
    assert.equal(rowsRead(shellStart, 'Location').length, 1);
    assert.equal(rowsRead(shellStart, 'ARM').length, 0);
    const { key } = options.json.items[0];
    const start = mock.requests.length;
    const foreign = await page('rows', key, { cookie: testCmdbuildAuthorizationCookie('other') });
    assert.equal(foreign.statusCode, 404, foreign.body);
    assert.equal(foreign.json.reason, 'table_key_unavailable');
    assert.equal(rowsRead(start, 'Location').length, 0);
    assert.equal(rowsRead(start, 'ARM').length, 0);
    const result = await page('rows', key);
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json.table.rows, [{ Detail: 'Matched detail' }]);
    assert.equal(rowsRead(start, 'Location').length, 0, 'a row request must not execute an independent options graph');
    assert.equal(rowsRead(start, 'routerG').length, 1, 'composeRows.right is a runtime dependency');
  }
});

test('large report selector from Object Flow restricts relation reads before execution', async (t) => {
  const spec = {
    version: 1, steps: [
      { type: 'selectCards', as: 'parents', className: 'Source' },
      { type: 'expandRelations', as: 'children', from: 'parents', domain: 'SourceTarget', direction: 'source',
        targetClass: 'Target', fetchRelated: false },
      { type: 'composeRows', as: 'projected', from: 'children', columns: [{ name: 'Code', column: 'Code' },
        { name: 'ParentKey', column: 'SourceId' }] }
    ], result: { tables: [{ name: 'projected', columns: ['Code'], presentation: { largeTable: {
      mode: 'key', selector: { kind: 'result', source: 'parents', idField: '_id', labelField: 'Description', matchField: 'ParentKey' }
    } } }] }
  };
  const targetMatch = structuredClone(spec);
  targetMatch.steps[2].columns[1].column = 'RelatedId';
  const classes = [
    { _id: 'Source', name: 'Source', description: 'Source', active: true },
    { _id: 'Target', name: 'Target', description: 'Target', active: true }
  ];
  const related = (id, sourceId, targetId, code) => ({ _id: id, domain: 'SourceTarget', _direction: 'direct',
    _sourceType: 'Source', _sourceId: sourceId, _destinationType: 'Target', _destinationId: targetId,
    _destinationCode: code });
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard('PagedRelations', spec), templateCard('PagedRelationTargets', targetMatch)], templateCodeFilter: true,
    classes: [...classes, ...['Cst_QueryTool', 'Cst_QueryToolConfig', 'Cst_QueryTemplate', 'Cst_QueryTemplateVersion']
      .map((name) => ({ _id: name, name, active: true }))],
    cardsByClass: { Source: [{ _id: 11, Code: 'A', Description: 'First' }, { _id: 12, Code: 'B', Description: 'Second' }] },
    relationsByCard: { 'Source:11': [related(31, 11, 12, 'A child')], 'Source:12': [related(32, 12, 11, 'B child')] }
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin);
  const api = `http://127.0.0.1:${port}/cmdbuild/custom-api/templates/`;
  const cookie = testCmdbuildAuthorizationCookie('reader');
  const page = (op, key, code = 'PagedRelations') => requestJson('GET', api + code + '/table-page?cmdpTable=' +
    encodeURIComponent(JSON.stringify({ table: 'projected', op, key })), undefined, { cookie });
  const options = await page('options');
  assert.equal(options.statusCode, 200, options.body);
  assert.equal(options.json.total, 2);
  assert.equal(mock.requests.filter((request) => request.pathname.endsWith('/relations')).length, 0);
  const chosen = await page('rows', options.json.items.find((item) => item.label === 'First').key);
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.deepEqual(chosen.json.table.rows, [{ Code: 'A child' }]);
  assert.deepEqual(mock.requests.filter((request) => request.pathname.endsWith('/relations')).map((request) => request.pathname),
    ['/cmdbuild/services/rest/v3/classes/Source/cards/11/relations']);
  const alternateOptions = await page('options', undefined, 'PagedRelationTargets');
  assert.equal(alternateOptions.statusCode, 200, alternateOptions.body);
  const start = mock.requests.length;
  const byTarget = await page('rows', alternateOptions.json.items.find((item) => item.label === 'First').key, 'PagedRelationTargets');
  assert.equal(byTarget.statusCode, 200, byTarget.body);
  assert.deepEqual(byTarget.json.table.rows, [{ Code: 'B child' }]);
  assert.equal(mock.requests.slice(start).filter((request) => request.pathname.endsWith('/relations')).length, 2,
    'a target id does not prove source lineage');
});

test('static snapshot refresh keeps personal data local and uses the opened exact or saved ignore parameters', async (t) => {
  const exactCode = 'PersonalSnapshotRefresh';
  const sharedCode = 'SharedSnapshotRefresh';
  const params = { code: 'published', slot: 42, enabled: false };
  const spec = {
    version: 1,
    params: { code: { type: 'string', required: true }, slot: { type: 'number', required: true }, enabled: { type: 'boolean', required: true } },
    steps: [{ type: 'selectCards', as: 'items', className: 'ARM', columns: ['Code', 'Description'], limit: 2,
      filters: [{ path: 'Code', op: 'equals', valueParam: 'code' }] }],
    result: { tables: [{ name: 'items', columns: ['Code', 'Description'] }] },
    publish: publishSpec().publish
  };
  const shared = { ...spec, publish: { ...spec.publish, paramsMode: 'ignore', refreshMode: 'shared', sharedRefreshAccepted: true } };
  const protectedPath = '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate/cards';
  const sharedCard = templateCard(sharedCode, shared);
  let sourceStatus = 200;
  let malformedData = false;
  let empty = false;
  let truncate = false;
  let delayMs = 0;
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true,
    templates: [templateCard(exactCode, spec), sharedCard],
    async responseOverride(url, req) {
      const token = req.headers['cmdbuild-authorization'];
      if (url.pathname.endsWith('/sessions/current')) return {
        statusCode: 200, body: { data: { username: token, role: token === 'editor' ? 'Admin' : 'Reader' } }
      };
      if (url.pathname === protectedPath && token === 'no-template-read') return { statusCode: 403, body: {} };
      if (url.pathname === protectedPath && token !== 'editor') return {
        statusCode: 200, body: { data: [templateCard(exactCode, spec, { canUpdate: false }), { ...sharedCard, _can_update: false }] }
      };
      if (!url.pathname.endsWith('/classes/ARM/cards')) return;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (sourceStatus !== 200) return { statusCode: sourceStatus, body: { success: false } };
      if (malformedData) return { statusCode: 200, body: { success: true } };
      const row = { _id: 501, Code: 'published', Description: token };
      const data = empty ? [] : truncate ? [row, { ...row, _id: 502 }, { ...row, _id: 503 }] : [row];
      return { statusCode: 200, body: { data, meta: { total: data.length } } };
    }
  });
  const port = await freePort();
  await startBackend(t, port, mock.origin, { CMDP_DRAFT_PREVIEW_TIMEOUT_MS: '1000' });
  const origin = `http://127.0.0.1:${port}`;
  const api = `${origin}/cmdbuild/custom-api`;
  const headers = async (token) => {
    const cookie = testCmdbuildAuthorizationCookie(token);
    const csrf = await requestJson('GET', `${api}/csrf`, undefined, { cookie });
    assert.equal(csrf.statusCode, 200, csrf.body);
    return { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  };
  const editor = await headers('editor');
  const reader = await headers('reader');
  const denied = await headers('no-template-read');
  const query = (value) => 'snapshotParams=' + encodeURIComponent(JSON.stringify(Object.entries(value)));
  const refresh = (code, value = params) => `${api}/templates/${code}/refresh-snapshot?${query(value)}`;
  const publicReport = (code) => requestJson('GET', `${api}/public-snapshots/${code}/run?json=true&${query(params)}`);
  for (const [code, savedSpec] of [[exactCode, spec], [sharedCode, shared]]) {
    const missing = await requestJson('GET', refresh(code), undefined, reader);
    assert.equal(missing.statusCode, 404, missing.body);
    const published = await publishWithBaseline(`${api}/templates/${code}/publish`, { params, savedSpecHash: hashJson(savedSpec) }, editor);
    assert.equal(published.statusCode, 200, published.body);
  }
  const anonymousGet = await requestJson('GET', refresh(exactCode));
  assert.equal(anonymousGet.statusCode, 401, anonymousGet.body);
  const anonymousPost = await requestJson('POST', refresh(exactCode), { expectedMode: 'personal' });
  assert.equal(anonymousPost.statusCode, 401, anonymousPost.body);
  const noCsrf = await requestJson('POST', refresh(exactCode), { expectedMode: 'personal' }, { cookie: reader.cookie, origin });
  assert.equal(noCsrf.statusCode, 403, noCsrf.body);
  const noMode = await requestJson('POST', refresh(exactCode), {}, reader);
  assert.equal(noMode.statusCode, 400, noMode.body);
  const noRevision = await requestJson('POST', refresh(exactCode), { expectedMode: 'personal' }, reader);
  assert.equal(noRevision.statusCode, 400, noRevision.body);
  assert.equal(noRevision.json.reason, 'snapshot_refresh_revision_required');
  const noTemplateRead = await requestJson('GET', refresh(exactCode), undefined, denied);
  assert.equal(noTemplateRead.statusCode, 403, noTemplateRead.body);
  const exactBefore = await publicReport(exactCode);
  const sharedBefore = await publicReport(sharedCode);
  const expectPersonal = { expectedMode: 'personal', expectedSnapshotRevision: exactBefore.json.cache.snapshotRevision };
  const wrongParams = await requestJson('POST', refresh(exactCode, { ...params, slot: '42' }), expectPersonal, reader);
  assert.equal(wrongParams.statusCode, 404, wrongParams.body);
  const malformed = await requestJson('GET', `${api}/templates/${exactCode}/refresh-snapshot?snapshotParams=invalid`, undefined, reader);
  assert.equal(malformed.statusCode, 400, malformed.body);
  const exactGet = await requestJson('GET', refresh(exactCode), undefined, reader);
  assert.deepEqual(exactGet.json, { available: true, mode: 'personal' }, exactGet.body);

  const personal = await requestJson('POST', refresh(exactCode), { ...expectPersonal, params: { code: 'tampered' } }, reader);
  assert.equal(personal.statusCode, 200, personal.body);
  assert.equal(personal.json.mode, 'personal');
  assert.deepEqual(personal.json.params, params);
  assert.equal(personal.json.result.tables[0].rows[0].Description, 'reader');
  assert.deepEqual((await publicReport(exactCode)).json, exactBefore.json);

  const untrusted = { code: 'tampered', slot: 99, enabled: true };
  const sharedGet = await requestJson('GET', refresh(sharedCode, untrusted), undefined, reader);
  assert.deepEqual(sharedGet.json, { available: true, mode: 'shared' }, sharedGet.body);
  const previousShared = { expectedMode: 'shared', expectedSnapshotRevision: sharedBefore.json.cache.snapshotRevision };
  const wrongMode = await requestJson('POST', refresh(sharedCode, untrusted), { ...previousShared, expectedMode: 'personal' }, reader);
  assert.equal(wrongMode.statusCode, 409, wrongMode.body);
  assert.equal(wrongMode.json.reason, 'snapshot_refresh_conflict');
  const updated = await requestJson('POST', refresh(sharedCode, untrusted), previousShared, reader);
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json.mode, 'shared');
  assert.deepEqual(updated.json.params, params);
  assert.equal(updated.json.result.tables[0].rows[0].Description, 'reader');
  const publicUpdated = await publicReport(sharedCode);
  assert.equal(publicUpdated.json.tables[0].rows[0].Description, 'reader');
  const expectShared = { expectedMode: 'shared', expectedSnapshotRevision: updated.json.cache.snapshotRevision };
  assert.equal(expectShared.expectedSnapshotRevision, publicUpdated.json.cache.snapshotRevision);
  assert.notEqual(expectShared.expectedSnapshotRevision, previousShared.expectedSnapshotRevision);
  const obsolete = await requestJson('POST', refresh(sharedCode, untrusted), previousShared, reader);
  assert.equal(obsolete.statusCode, 409, obsolete.body);
  const originalSpecJson = sharedCard.SpecJson;
  sharedCard.SpecJson = JSON.stringify({ ...shared, publish: { ...shared.publish, publicD2Source: true } });
  const beforeDirectChange = mock.requests.length;
  const stalePolicy = await requestJson('POST', refresh(sharedCode), expectShared, reader);
  assert.equal(stalePolicy.statusCode, 409, stalePolicy.body);
  assert.equal(mock.requests.slice(beforeDirectChange).some((item) => item.pathname.endsWith('/classes/ARM/cards')), false);
  sharedCard.SpecJson = originalSpecJson;

  sourceStatus = 403;
  const dataDenied = await requestJson('POST', refresh(sharedCode), expectShared, reader);
  assert.equal(dataDenied.statusCode, 403, dataDenied.body);
  assert.equal(dataDenied.json.reason, 'data_access_denied');
  assert.equal(dataDenied.json.result, undefined);
  sourceStatus = 200;
  malformedData = true;
  const incompleteRead = await requestJson('POST', refresh(sharedCode), expectShared, reader);
  assert.equal(incompleteRead.statusCode, 502, incompleteRead.body);
  assert.equal(incompleteRead.json.reason, 'snapshot_refresh_data_unavailable');
  malformedData = false;
  truncate = true;
  const partial = await requestJson('POST', refresh(sharedCode), expectShared, reader);
  assertSnapshotLimitError(partial, 'table_result_incomplete', {
    table: 'items', phase: 'rows', stepAlias: 'items', limitName: 'maxRows', reason: 'limit_exceeded'
  });
  assert.deepEqual((await publicReport(sharedCode)).json, publicUpdated.json);
  truncate = false;
  delayMs = 1300;
  const timedOut = await requestJson('POST', refresh(sharedCode), expectShared, reader);
  assertSnapshotLimitError(timedOut, 'snapshot_refresh_timeout', {
    table: 'items', phase: 'rows', limitName: 'executionTimeoutMs', effectiveLimit: 1000,
    unit: 'milliseconds', reason: 'deadline_exceeded', timeout: true
  }, 504);
  assert.deepEqual((await publicReport(sharedCode)).json, publicUpdated.json);
  delayMs = 0;
  empty = true;
  const updatedEmpty = await requestJson('POST', refresh(sharedCode), expectShared, reader);
  assert.equal(updatedEmpty.statusCode, 200, updatedEmpty.body);
  assert.deepEqual((await publicReport(sharedCode)).json.tables[0].rows, []);
});

test('static snapshot refresh CAS rejects another refresh or a generation change across backends', async (t) => {
  const code = 'SharedSnapshotRefreshCAS';
  const spec = {
    version: 1,
    steps: [{ type: 'selectCards', as: 'items', className: 'ARM', columns: ['Code'] }],
    result: { tables: [{ name: 'items', columns: ['Code'] }] },
    publish: { ...publishSpec().publish, refreshMode: 'shared', sharedRefreshAccepted: true }
  };
  const redis = await startSnapshotRedisFixture(t);
  let blocked;
  const mock = await startMockCmdbuild(t, {
    templateCodeFilter: true,
    templates: [templateCard(code, spec)],
    async responseOverride(url, req) {
      if (!url.pathname.endsWith('/classes/ARM/cards')) return;
      const user = String(req.headers['cmdbuild-authorization']);
      if (user === 'slow') {
        const gate = blocked;
        gate.entered.resolve();
        await gate.released.promise;
      }
      return { statusCode: 200, body: { data: [{ _id: 501, Code: user, Location: 300 }], meta: { total: 1 } } };
    }
  });
  const endpoints = [];
  for (const token of ['slow', 'fast']) {
    const port = await freePort();
    await startBackend(t, port, mock.origin, redis.env);
    const origin = `http://127.0.0.1:${port}`;
    const api = `${origin}/cmdbuild/custom-api`;
    const cookie = testCmdbuildAuthorizationCookie(token);
    const csrf = await requestJson('GET', `${api}/csrf`, undefined, { cookie });
    assert.equal(csrf.statusCode, 200, csrf.body);
    const headers = { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
    const template = `${api}/templates/${code}`;
    endpoints.push({ template, headers,
      refresh: (expectedSnapshotRevision) => requestJson('POST', `${template}/refresh-snapshot`, { expectedMode: 'shared', expectedSnapshotRevision }, headers),
      publicReport: () => requestJson('GET', `${api}/public-snapshots/${code}/run?json=true`) });
  }
  const [slow, fast] = endpoints;
  const published = await publishWithBaseline(`${fast.template}/publish`, { params: {}, savedSpecHash: hashJson(spec) }, fast.headers);
  assert.equal(published.statusCode, 200, published.body);
  let stateKey;
  for (const key of redis.values.keys()) if (key.includes(':snapshot-state:')) stateKey = key;
  assert.ok(stateKey);

  for (const race of ['snapshot', 'generation', 'template']) {
    const beforeState = redis.values.get(stateKey);
    const before = await fast.publicReport();
    const revision = before.json.cache.snapshotRevision;
    blocked = { entered: deferredSignal(), released: deferredSignal() };
    const pending = slow.refresh(revision);
    try {
      await Promise.race([blocked.entered.promise, pending.then((response) => assert.fail(response.body))]);
      if (race === 'snapshot') {
        const winner = await fast.refresh(revision);
        assert.equal(winner.statusCode, 200, winner.body);
      } else if (race === 'generation') {
        redis.values.set(stateKey, `pending:${crypto.randomUUID()}`);
      } else {
        const deactivated = await requestJson('PUT', fast.template, { code, active: false, spec, expectedSpecHash: hashJson(spec) }, fast.headers);
        assert.equal(deactivated.statusCode, 200, deactivated.body);
      }
    } finally {
      blocked.released.resolve();
    }
    const stale = await pending;
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json.reason, 'snapshot_refresh_conflict');
    const current = await fast.publicReport();
    assert.equal(current.json.snapshotFound, race === 'snapshot');
    if (race === 'snapshot') assert.equal(current.json.tables[0].rows[0].Code, 'fast');
    if (race === 'generation') redis.values.set(stateKey, beforeState);
  }
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

  const publish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke/publish`, {
    params: {},
    savedSpecHash: hashJson(spec)
  }, headers);
  assert.equal(publish.statusCode, 200, publish.body);

  const beforeDelete = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/public-snapshots/StaticSnapshotRevoke/run?json=true`);
  assert.equal(beforeDelete.statusCode, 200, beforeDelete.body);
  assert.equal(beforeDelete.json.snapshotFound, true);
  const directUrl = `${backendOrigin}/cmdbuild/dynamicpages/ui/run/StaticSnapshotRevoke?json=true`;
  const directBeforeDelete = await requestJson('GET', directUrl, undefined, { cookie });
  assert.equal(directBeforeDelete.statusCode, 200, directBeforeDelete.body);
  assert.deepEqual(directBeforeDelete.json, beforeDelete.json);

  const updated = await requestJson('PUT', `${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke`, {
    code: 'StaticSnapshotRevoke',
    spec
  }, headers);
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json.cacheInvalidation.staticSnapshots.invalidated, 0);
  assert.equal(updated.json.cacheInvalidation.staticSnapshots.reason, 'authoring_only');

  const afterUpdate = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/public-snapshots/StaticSnapshotRevoke/run?json=true`);
  assert.equal(afterUpdate.statusCode, 200, afterUpdate.body);
  assert.equal(afterUpdate.json.snapshotFound, true);

  const republished = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/StaticSnapshotRevoke/publish`, {
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
  const directAfterDelete = await requestJson('GET', directUrl);
  assert.equal(directAfterDelete.statusCode, 200, directAfterDelete.body);
  assert.deepEqual(directAfterDelete.json, afterDelete.json);
  const authenticatedAfterDelete = await requestJson('GET', directUrl, undefined, { cookie });
  assert.equal(authenticatedAfterDelete.statusCode, 404, authenticatedAfterDelete.body);
  assert.equal(authenticatedAfterDelete.json.success, false);
  assert.equal(authenticatedAfterDelete.json.tables, undefined);
  assert.equal(backend.exitCode, null);
});

test('object-flow apply rejects Diagram mappings whose source aliases are removed', async (t) => {
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

  const templateCode = 'DiagramSourceStale';
  const mock = await startMockCmdbuild(t, { templates: [templateCard(templateCode, currentSpec)] });
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

  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode,
    baseSpecHash: hashJson(currentSpec),
    currentSpec,
    flow
  }, headers);
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json.code, 'object_flow_diagram_source_stale');
  assert.ok(response.json.errors.some((error) => error.path === '$.result.diagrams[0].source.nodes'));
  assert.equal(backend.exitCode, null);
});

test('object-flow apply rejects retained Diagram sources when their class or required fields change', async (t) => {
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
  const templateCode = 'DiagramSourceSchema';
  const mock = await startMockCmdbuild(t, { templates: [templateCard(templateCode, currentSpec)] });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('diagram-source-schema');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const fieldRemoved = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/object-flow/apply`, {
    templateCode, baseSpecHash: hashJson(currentSpec), currentSpec,
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
    templateCode, baseSpecHash: hashJson(currentSpec), currentSpec,
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

test('model catalog hydrates domain endpoints omitted by the CMDBuild domain list', async (t) => {
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ZabbixMonitoring', description: 'Monitoring', prototype: true, active: true },
      { _id: 2, name: 'ipRange', description: 'IP range', parent: 'ZabbixMonitoring', active: true },
      { _id: 3, name: 'vlan', description: 'VLAN', active: true }
    ],
    domains: [{ _id: 1, name: 'Vlan2super', description: 'VLAN relation', active: true }],
    domainDetails: {
      Vlan2super: {
        _id: 1,
        name: 'Vlan2super',
        description: 'VLAN relation',
        source: 'vlan',
        sources: ['vlan'],
        destination: 'ZabbixMonitoring',
        destinations: ['ipRange'],
        cardinality: 'N:1',
        active: true
      }
    }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=domain-detail-test-token';

  const catalog = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/model/catalog?maxClasses=5&maxDomains=5&includeAttributes=false`,
    undefined,
    { cookie }
  );

  assert.equal(catalog.statusCode, 200, catalog.body);
  const domain = catalog.json.catalog.domains.find((item) => item.name === 'Vlan2super');
  assert.deepEqual(domain && domain.sources, ['vlan']);
  assert.deepEqual(domain && domain.destinations, ['ipRange']);
  assert.deepEqual(catalog.json.catalog.domainEndpoints, {
    version: 1,
    attempted: true,
    complete: true
  });
  assert.equal(mock.requests.some((item) => item.pathname === '/cmdbuild/services/rest/v3/domains/Vlan2super'), true);
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

test('public snapshots ignore retired generic D2 diagram definitions', async (t) => {
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

  const blockedPublish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/D2PublicBlockedTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(blockedSpec)
  }, headers, 10_000);
  assert.equal(blockedPublish.statusCode, 200, blockedPublish.body);

  const blockedJson = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/public-snapshots/D2PublicBlockedTemplate/run?json=true`,
    undefined,
    {},
    10_000
  );
  assert.equal(blockedJson.statusCode, 200, blockedJson.body);
  assert.deepEqual(blockedJson.json.diagrams, []);

  const allowedPublish = await publishWithBaseline(`${backendOrigin}/cmdbuild/custom-api/templates/D2PublicAllowedTemplate/publish`, {
    params: {},
    savedSpecHash: hashJson(allowedSpec)
  }, headers, 10_000);
  assert.equal(allowedPublish.statusCode, 200, allowedPublish.body);

  const allowedJson = await requestJson(
    'GET',
    `${backendOrigin}/cmdbuild/custom-api/public-snapshots/D2PublicAllowedTemplate/run?json=true`,
    undefined,
    {},
    10_000
  );
  assert.equal(allowedJson.statusCode, 200, allowedJson.body);
  assert.deepEqual(allowedJson.json.diagrams, []);
  assert.equal(backend.exitCode, null);
});

test('semantic planning keeps an explicit reference field as a business requirement for deterministic compilation', async (t) => {
  const intent = {
    context: '',
    blocks: [
      { id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: [] },
      { id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG и сети из Результата 1.', algorithm: 'Выбрать ApplicG, у которых "ipaddress.IP address value" входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges'] }
    ]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [
        { id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: [] },
        { id: 'applications', name: 'Результат 4', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'IpAddress', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ApplicG.', resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [{ sourceClass: 'ApplicG', relatedClass: 'IpAddress', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', domain: 'super2super', direction: 'source', comparisonFields: ['ipAddr'], relatedField: 'range', operator: 'ipv4InCidr' }] }, warnings: [] }
      ],
      explanation: 'Путь reference указан в алгоритме.', warnings: []
    }]
  });
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
    domains: [
      { _id: 'ApplicGIpaddressDomain', name: 'ApplicGIpaddressDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'ApplicGMgmtDomain', name: 'ApplicGMgmtDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'super2super', name: 'super2super', source: 'super', sources: ['ApplicG'], destination: 'super', destinations: ['IpAddress'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }
    ],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-relation-reference-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract.relationPredicates, []);
  assert.deepEqual(response.json.semanticPlan.blocks[1].resultContract.referencePathPredicates, []);
  assert.equal(backend.exitCode, null);
});

test('semantic planning defers an explicit IPv4 reference path to deterministic flow compilation', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG и сети из Результата 1.',
      algorithm: 'Выбрать ApplicG, у которых "ipaddress.IP address value" входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
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
          attributePredicates: [{ sourceClass: 'IpAddress', comparisonBlockId: 'ranges', comparisonClass: 'ipRange', sourceFields: ['ipAddr'], comparisonField: 'Network range', operator: 'ipv4InCidr' }]
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
  const mgmtDomain = {
    _id: 'ApplicGMgmtDomain', name: 'ApplicGMgmtDomain', source: 'IpAddress', sources: ['IpAddress'], destination: 'ApplicG', destinations: ['ApplicG'],
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
      ApplicG: [
        { name: 'ipaddress', description: 'Provider email', type: 'reference', targetClass: 'IpAddress', domain: 'ApplicGIpaddressDomain', active: true, _can_read: true },
        { name: 'mgmt', description: 'ipaddress', type: 'reference', targetClass: 'IpAddress', domain: 'ApplicGMgmtDomain', active: true, _can_read: true }
      ],
      IpAddress: [{ name: 'ipAddr', description: 'IP address value', type: 'ipAddress', active: true, _can_read: true }]
    },
    domains: [domain, mgmtDomain],
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
  assert.equal(semantic.json.semanticPlan.blocks[1].resultContract.outputKind, 'sourceCards');
  assert.equal(semantic.json.semanticPlan.blocks[1].resultContract.outputClass, 'ApplicG');
  assert.deepEqual(semantic.json.semanticPlan.blocks[1].resultContract.referencePathPredicates, []);
  assert.deepEqual(semantic.json.semanticPlan.blocks[1].resultContract.attributePredicates, []);

  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan
  }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json.success, true, draft.body);
  assert.ok(draft.json.warnings.some((warning) => /resolved user reference path ipaddress\.ipAddr/i.test(warning)), draft.body);
  assert.equal(draft.json.flow.publishedAlias, 'applications');
  assert.ok(draft.json.flow.selections.some((selection) => selection.className === 'IpAddress' && selection.rules.some((rule) => rule.path === 'ipAddr' && rule.op === 'ipv4InCidr' && rule.rightExpression === '${previous.range}')), draft.body);
  assert.ok(draft.json.flow.operations.some((operation) => operation.type === 'relation' && operation.domain === 'ApplicGIpaddressDomain' && operation.targetClass === 'ApplicG' && operation.direction === 'source'));

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview`, {
    template: { code: 'ReferencePathPreview', spec: compileObjectFlowToSpec(currentSpec, draft.json.flow) }, params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const finalTable = preview.json.result.tables.find((table) => table.name === draft.json.flow.publishedAlias);
  assert.ok(finalTable, preview.body);
  assert.deepEqual(finalTable.rows.map((row) => row.Code), ['APP-IN']);
  assert.equal(backend.exitCode, null);
});

test('deterministic flow completes an unambiguous IPv4 reference predicate from confirmed MCP schema', async (t) => {
  const intent = {
    context: '',
    blocks: [{
      id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: []
    }, {
      id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG и сети из Результата 1.',
      algorithm: 'Выбрать ApplicG, у которых ipaddress входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [{
        id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: []
      }, {
        id: 'applications', name: 'Результат 4', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'IpAddress', 'ipRange'], relationPaths: ['ApplicGIpaddressDomain'], dependencies: ['ranges'], expectedResult: 'Список ApplicG.',
        resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [], attributePredicates: [] }, warnings: []
      }],
      explanation: 'LLM omitted the predicate.', warnings: []
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
      ApplicG: [{ name: 'ipaddress', description: 'IP address', type: 'reference', targetClass: 'IpAddress', domain: 'ApplicGIpaddressDomain', active: true, _can_read: true }],
      IpAddress: [{ name: 'ipAddr', description: 'IP address value', type: 'ipAddress', active: true, _can_read: true }]
    },
    domains: [domain],
    cardsByClass: {
      ipRange: [{ _id: 101, Code: 'RANGE-001', range: '10.44.0.0/24' }],
      IpAddress: [{ _id: 201, Code: 'IP-IN', ipAddr: '10.44.0.10' }, { _id: 202, Code: 'IP-OUT', ipAddr: '10.99.0.10' }],
      ApplicG: [{ _id: 301, Code: 'APP-IN', ipaddress: 201 }, { _id: 302, Code: 'APP-OUT', ipaddress: 202 }]
    },
    relationsByCard: {
      'IpAddress:201': [{ _id: 401, domain: 'ApplicGIpaddressDomain', _sourceType: 'IpAddress', _sourceId: 201, _destinationType: 'ApplicG', _destinationId: 301, _direction: 'direct' }],
      'IpAddress:202': [{ _id: 402, domain: 'ApplicGIpaddressDomain', _sourceType: 'IpAddress', _sourceId: 202, _destinationType: 'ApplicG', _destinationId: 302, _direction: 'direct' }]
    },
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 3 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-omitted-reference-predicate-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = { version: 1, params: {}, steps: [], result: { tables: [] } };

  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent
  }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  assert.deepEqual(semantic.json.semanticPlan.blocks[1].resultContract.referencePathPredicates, []);

  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan
  }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview`, {
    template: { code: 'ReferencePredicatePreview', spec: compileObjectFlowToSpec(currentSpec, draft.json.flow) }, params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const finalTable = preview.json.result.tables.find((table) => table.name === draft.json.flow.publishedAlias);
  assert.deepEqual(finalTable.rows.map((row) => row.Code), ['APP-IN']);
  assert.equal(backend.exitCode, null);
});

test('semantic planning accepts an ambiguous IPv4 reference and deterministic flow reports the ambiguity', async (t) => {
  const intent = {
    context: '',
    blocks: [{ id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.', algorithm: 'Выбрать сети.', expectedResult: 'Список ipRange.', uses: [] }, {
      id: 'applications', name: 'Результат 4', entities: 'Карточки ApplicG и сети из Результата 1.',
      algorithm: 'Выбрать ApplicG, у которых ipaddress входит в сеть range объектов ipRange из Результата 1.', expectedResult: 'Список ApplicG.', uses: ['ranges']
    }]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [
        { id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.', resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', relationPredicates: [], attributePredicates: [] }, warnings: [] },
        { id: 'applications', name: 'Результат 4', summary: 'Приложения.', resolvedEntities: ['ApplicG', 'IpAddressA', 'IpAddressB', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ApplicG.', resultContract: { outputKind: 'sourceCards', outputClass: 'ApplicG', relationPredicates: [], attributePredicates: [] }, warnings: [] }
      ], explanation: 'Missing predicate.', warnings: []
    }]
  });
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'ipRange', description: 'IP range', parent: 'Class', active: true }, { _id: 2, name: 'ApplicG', description: 'Application', parent: 'Class', active: true },
      { _id: 3, name: 'IpAddressA', description: 'Primary IP address', parent: 'Class', active: true }, { _id: 4, name: 'IpAddressB', description: 'Secondary IP address', parent: 'Class', active: true },
      { _id: 5, name: 'Cst_QueryToolConfig', description: 'Config', active: true }, { _id: 6, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: {
      ipRange: [{ name: 'range', description: 'Network range', type: 'string', active: true, _can_read: true }],
      ApplicG: [
        { name: 'primaryIp', description: 'Primary ipaddress', type: 'reference', targetClass: 'IpAddressA', domain: 'ApplicGPrimaryIpDomain', active: true, _can_read: true },
        { name: 'secondaryIp', description: 'Secondary ipaddress', type: 'reference', targetClass: 'IpAddressB', domain: 'ApplicGSecondaryIpDomain', active: true, _can_read: true }
      ],
      IpAddressA: [{ name: 'ipAddr', description: 'IP address value', type: 'ipAddress', active: true, _can_read: true }],
      IpAddressB: [{ name: 'ipAddr', description: 'IP address value', type: 'ipAddress', active: true, _can_read: true }]
    },
    domains: [
      { _id: 'ApplicGPrimaryIpDomain', name: 'ApplicGPrimaryIpDomain', source: 'IpAddressA', sources: ['IpAddressA'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' },
      { _id: 'ApplicGSecondaryIpDomain', name: 'ApplicGSecondaryIpDomain', source: 'IpAddressB', sources: ['IpAddressB'], destination: 'ApplicG', destinations: ['ApplicG'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N' }
    ],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 3 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 32768 } } }) }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('semantic-ambiguous-reference-predicate-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });

  assert.equal(response.statusCode, 200, response.body);
  const contract = response.json.semanticPlan.blocks[1].resultContract;
  assert.equal(contract.outputKind, 'sourceCards');
  assert.deepEqual(contract.referencePathPredicates, []);
  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec: { version: 1, params: {}, steps: [], result: { tables: [] } }, intent, semanticPlan: response.json.semanticPlan
  }, { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token });
  assert.equal(draft.statusCode, 422, draft.body);
  assert.equal(draft.json.code, 'assistant_semantic_plan_invalid');
  assert.match(draft.json.message, /cannot resolve/i);
  assert.deepEqual(draft.json.errors[0].candidates, ['primaryIp.ipAddr', 'secondaryIp.ipAddr']);
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

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview`, { template: { code: 'ReferenceRepairPreview', spec: compileObjectFlowToSpec(currentSpec, draft.json.flow) }, params: {} }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const repairedTable = preview.json.result.tables.find((table) => table.name === 'phServers');
  assert.ok(repairedTable, preview.body);
  assert.deepEqual(repairedTable.rows.map((row) => row.Code), ['PHS-IN']);
  assert.equal(backend.exitCode, null);
});

test('candidate filter retains named ACL candidates through a parameterized IS to ipRange path', async (t) => {
  const intent = {
    context: 'Проверка ACL для выбранной информационной системы.',
    blocks: [
      {
        id: 'ranges', name: 'Результат 1', entities: 'Карточки ipRange.',
        algorithm: 'Выбрать все объекты класса ipRange.', expectedResult: 'Список ipRange.', uses: []
      },
      {
        id: 'all-acl', name: 'Все ACL', entities: 'Карточки ACL и сети из Результата 1.',
        algorithm: 'Выбрать ACL, у которых Destination ipaddress или Source ipaddress входит в network range объектов из Результата 1.',
        expectedResult: 'Список ACL.', uses: ['ranges']
      },
      {
        id: 'target-acl', name: 'ACL внутри target системы', entities: 'Карточки ACL из Все ACL, IS и ipRange.',
        algorithm: 'Из Все ACL оставить карточки, у которых network range связанных объектов ipRange для IS, у которой Description равно параметру isName, включает Destination ipaddress или Source ipaddress.',
        expectedResult: 'Список ACL.', uses: ['all-acl']
      },
      {
        id: 'external-systems', name: 'Внешние ИС', entities: 'Карточки IS.',
        algorithm: 'Выбрать IS, у которых isExt равно true и range связанных через ISZabbixMonitoringDomain объектов ipRange включает Destination ipaddress или Source ipaddress из Все ACL.',
        expectedResult: 'Список внешних ИС.', uses: ['all-acl']
      },
      {
        id: 'external-acl', name: 'ACL внешних ИС', entities: 'Все ACL, Внешние ИС, ipRange, domain ISZabbixMonitoringDomain.',
        algorithm: 'Из Все ACL оставить карточки, у которых range связанных с Внешние ИС объектов ipRange включает Destination ipaddress или Source ipaddress.',
        expectedResult: 'Список ACL внешних ИС.', uses: ['all-acl', 'external-systems']
      }
    ]
  };
  const llm = await startLiteLlmStub(t, {
    responses: [{
      version: 1,
      blocks: [
        {
          id: 'ranges', name: 'Результат 1', summary: 'Сети.', resolvedEntities: ['ipRange'], relationPaths: [], dependencies: [], expectedResult: 'Список ipRange.',
          resultContract: { outputKind: 'sourceCards', outputClass: 'ipRange', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: []
        },
        {
          id: 'all-acl', name: 'Все ACL', summary: 'Все ACL в известных сетях.', resolvedEntities: ['ACL', 'ipRange'], relationPaths: [], dependencies: ['ranges'], expectedResult: 'Список ACL.',
          resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: []
        },
        {
          id: 'target-acl', name: 'ACL внутри target системы', summary: 'ACL выбранной ИС.', resolvedEntities: ['ACL', 'IS', 'ipRange'], relationPaths: ['aclLine', 'ISZabbixMonitoringDomain'], dependencies: ['all-acl'], expectedResult: 'Список ACL.',
          resultContract: {
            outputKind: 'sourceCards', outputClass: 'ACL', dependencyPaths: [], attributePredicates: [], referencePathPredicates: [],
            relationPredicates: [{
              sourceClass: 'ACL', relatedClass: 'ipRange', comparisonBlockId: 'all-acl', comparisonClass: 'IS',
              domain: 'aclLine', direction: 'destination', comparisonFields: ['dipaddress', 'ipaddress'], relatedField: 'range', operator: 'ipv4InCidr'
            }]
          }, warnings: []
        },
        {
          id: 'external-systems', name: 'Внешние ИС', summary: 'Внешние ИС, сети которых содержат адреса ACL.', resolvedEntities: ['IS', 'ipRange', 'ACL'], relationPaths: ['ISZabbixMonitoringDomain'], dependencies: ['all-acl'], expectedResult: 'Список внешних ИС.',
          resultContract: { outputKind: 'sourceCards', outputClass: 'IS', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: []
        },
        {
          id: 'external-acl', name: 'ACL внешних ИС', summary: 'ACL внешних ИС.', resolvedEntities: ['ACL', 'IS', 'ipRange'], relationPaths: [], dependencies: ['all-acl', 'external-systems'], expectedResult: 'Список ACL внешних ИС.',
          resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] }, warnings: []
        }
      ],
      explanation: 'LLM supplied a stale relation predicate for the final ACL block.', warnings: []
    }, {
      flow: { version: 1, selections: [], operations: [], publishedAlias: '' },
      explanation: 'Incomplete LLM flow forces deterministic compilation.', warnings: []
    }]
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
      IS: [
        { name: 'Description', description: 'Description', type: 'string', active: true, _can_read: true },
        { name: 'isExt', description: 'External system', type: 'boolean', active: true, _can_read: true }
      ],
      ipRange: [{ name: 'range', description: 'Network range', type: 'string', active: true, _can_read: true }],
      ACL: [
        { name: 'ipaddress', description: 'Source ipaddress', type: 'string', active: true, _can_read: true },
        { name: 'dipaddress', description: 'Destination ipaddress', type: 'string', active: true, _can_read: true }
      ]
    },
    domains: [{
      _id: 'ISZabbixMonitoringDomain', name: 'ISZabbixMonitoringDomain', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'],
      disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: '1:N'
    }, {
      _id: 'AlternativeISRangeDomain', name: 'AlternativeISRangeDomain', source: 'IS', sources: ['IS'], destination: 'ipRange', destinations: ['ipRange'],
      disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N'
    }],
    cardsByClass: {
      IS: [
        { _id: 11, Code: 'TARGET', Description: 'Target system', isExt: false },
        { _id: 12, Code: 'OTHER', Description: 'Other system', isExt: true }
      ],
      ipRange: [
        { _id: 21, Code: 'TARGET-RANGE', Description: 'Target range', range: '10.44.0.0/24' },
        { _id: 22, Code: 'OTHER-RANGE', Description: 'Other range', range: '10.55.0.0/24' }
      ],
      ACL: [
        { _id: 31, Code: 'ACL-TARGET', Description: 'Target ACL', ipaddress: '10.44.0.10', dipaddress: '192.0.2.10' },
        { _id: 32, Code: 'ACL-OTHER', Description: 'Other ACL', ipaddress: '10.55.0.10', dipaddress: '192.0.2.20' },
        { _id: 33, Code: 'ACL-OUTSIDE', Description: 'Outside ACL', ipaddress: '10.66.0.10', dipaddress: '192.0.2.30' }
      ]
    },
    relationsByCard: {
      'IS:11': [{ _id: 101, domain: 'ISZabbixMonitoringDomain', _sourceType: 'IS', _sourceId: 11, _sourceCode: 'TARGET', _sourceDescription: 'Target system', _destinationType: 'ipRange', _destinationId: 21, _destinationCode: 'TARGET-RANGE', _destinationDescription: 'Target range', _direction: 'direct' }],
      'IS:12': [{ _id: 102, domain: 'ISZabbixMonitoringDomain', _sourceType: 'IS', _sourceId: 12, _sourceCode: 'OTHER', _sourceDescription: 'Other system', _destinationType: 'ipRange', _destinationId: 22, _destinationCode: 'OTHER-RANGE', _destinationDescription: 'Other range', _direction: 'direct' }]
    },
    configCards: [{
      _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' }, semanticPlan: { maxReferencePathDepth: 3 }, mcp: { maxClasses: 100, maxDomains: 100, maxRelationDomains: 100, maxContextBytes: 65536 } } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin, { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('candidate-filter-token');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const currentSpec = { version: 1, params: { isName: { name: 'isName', type: 'string', required: true } }, steps: [], result: { tables: [] } };

  const semantic = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/semantic-plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent
  }, headers);
  assert.equal(semantic.statusCode, 200, semantic.body);
  const finalContract = semantic.json.semanticPlan.blocks.find((block) => block.id === 'target-acl').resultContract;
  assert.equal(finalContract.candidateFilter.candidateBlockId, 'all-acl');
  assert.equal(finalContract.candidateFilter.comparisonSource.kind, 'selection');
  assert.equal(finalContract.candidateFilter.comparisonSource.className, 'IS');
  assert.deepEqual(finalContract.candidateFilter.comparisonPath.map((hop) => [hop.sourceClass, hop.domain, hop.direction, hop.targetClass]), [
    ['IS', 'ISZabbixMonitoringDomain', 'source', 'ipRange']
  ]);
  assert.equal(finalContract.candidateFilter.ruleJoin, 'any');
  assert.deepEqual(finalContract.relationPredicates, []);
  const externalContract = semantic.json.semanticPlan.blocks.find((block) => block.id === 'external-acl').resultContract;
  assert.equal(externalContract.candidateFilter.candidateBlockId, 'all-acl');
  assert.deepEqual(externalContract.candidateFilter.comparisonSource, {
    kind: 'block', blockId: 'external-systems', className: 'IS', rules: []
  });
  assert.deepEqual(externalContract.candidateFilter.comparisonPath.map((hop) => [hop.sourceClass, hop.domain, hop.direction, hop.targetClass]), [
    ['IS', 'ISZabbixMonitoringDomain', 'source', 'ipRange']
  ]);

  const draft = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/assistant/object-flow/plan`, {
    templateCode: '', baseSpecHash: '', currentSpec, intent, semanticPlan: semantic.json.semanticPlan
  }, headers);
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json.success, true, draft.body);
  assert.ok(draft.json.flow.operations.some((operation) => operation.type === 'semiJoin' && operation.ruleJoin === 'any'), draft.body);
  assert.ok(draft.json.flow.operations.some((operation) => operation.type === 'relation' && operation.domain === 'ISZabbixMonitoringDomain'), draft.body);
  assert.equal(draft.json.flow.operations.some((operation) => operation.domain === 'aclLine'), false, draft.body);

  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview`, {
    template: { code: 'CandidateFilterPreview', spec: compileObjectFlowToSpec(currentSpec, draft.json.flow) },
    params: { isName: 'Target system' }
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  const allAclBinding = draft.json.outputBindings.find((binding) => binding.blockId === 'all-acl');
  const targetBinding = draft.json.outputBindings.find((binding) => binding.blockId === 'target-acl');
  const externalBinding = draft.json.outputBindings.find((binding) => binding.blockId === 'external-acl');
  assert.deepEqual(preview.json.result.tables.find((table) => table.name === allAclBinding.alias).rows.map((row) => row.Code).sort(), ['ACL-OTHER', 'ACL-TARGET']);
  assert.deepEqual(preview.json.result.tables.find((table) => table.name === targetBinding.alias).rows.map((row) => row.Code), ['ACL-TARGET']);
  assert.deepEqual(preview.json.result.tables.find((table) => table.name === externalBinding.alias).rows.map((row) => row.Code), ['ACL-OTHER']);
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
  assert.match(response.json.feedback.action, /Проверьте reference attribute/);
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

function transferAuthoringTemplate(code = 'PortableSource', className = 'ARM') {
  const spec = apiObjectFlowSpec([{ alias: 'portableAssets', className, columns: ['Code', 'Description'] }]);
  spec.authoring = {
    version: 1,
    assistant: {
      promptContractVersion: 4,
      objectFlowIntent: { context: 'Keep business context id/token verbatim.', blocks: [{
        id: 'portable-business-block', name: 'Portable named business result',
        description: 'Keep the current unsaved authoring prompt.', uses: [], resultKind: 'sourceCards'
      }] },
      diagramIntentPrompt: 'Keep this reviewed diagram prompt.',
      systemPromptOverrides: { diagramSemantics: 'Keep the author-selected semantic instructions.' }
    },
    d2: { source: '' }
  };
  return { code, description: 'Unsaved portable definition', spec, paramsSchema: null, resultSchema: null };
}

async function transferApiFixture(t, mockOptions = {}, envOverrides = {}) {
  const mock = await startMockCmdbuild(t, mockOptions);
  const port = await freePort();
  const backend = await startBackend(t, port, mock.origin, envOverrides);
  const origin = `http://127.0.0.1:${port}`;
  const cookie = testCmdbuildAuthorizationCookie('template-transfer-api');
  const csrf = await requestJson('GET', `${origin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const headers = { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  return { mock, backend, origin, headers,
    put: (code, body) => requestJson('PUT', `${origin}/cmdbuild/custom-api/templates/${code}`, body, headers, 15000),
    create: (body) => requestJson('POST', `${origin}/cmdbuild/custom-api/templates`, body, headers, 15000),
    post: (action, body) => requestJson('POST', `${origin}/cmdbuild/custom-api/template-transfer/${action}`, body, headers, 15000) };
}

function transferReplacementSaveBody(prepared) {
  const { template: { code, description, spec, paramsSchema, resultSchema }, changes: { targetId, targetRevision } } = prepared.json;
  return { code, description, spec, paramsSchema, resultSchema, transferReplace: { targetId, revision: targetRevision } };
}

test('general config save preserves an above-ceiling row limit and validates changes made in Runtime settings', async (t) => {
  const configCard = {
    _id: 42, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Description: 'Existing settings', Active: false,
    RuntimeConfigJson: JSON.stringify({
      executionLimits: { maxRowsMax: 2000, maxRowsDefault: 600, maxClassesDefault: 17, maxRelationsPerCardMax: 321,
        maxSelectionScanRowsDefault: 30000, maxSelectionScanRowsMax: 50000, maxRestCallsDefault: 110, maxRestCallsMax: 110 },
      runtimeCache: { refreshCooldownSec: 180 },
      assistant: { llm: { maxTokens: 4096 } }
    })
  };
  let writes = 0;
  const { origin, headers } = await transferApiFixture(t, {
    configCards: [configCard],
    async responseOverride(url, request) {
      if (request.method !== 'PUT' || url.pathname !== '/cmdbuild/services/rest/v3/classes/Cst_QueryToolConfig/cards/42') return;
      writes++;
      Object.assign(configCard, await readRequestJson(request));
      return { statusCode: 200, body: { data: configCard } };
    }
  }, { CMDP_EXECUTION_MAX_ROWS_ABSOLUTE: '1800', CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE: '30000' });
  const configUrl = origin + '/cmdbuild/custom-api/config?root=Cst_QueryTool';
  const update = await requestJson('PUT', configUrl + '&scope=general', {
    active: true, runtimeConfig: { runtimeCache: { refreshCooldownSec: 240 }, executionLimits: { maxRowsMax: 1500 } }
  }, headers);
  assert.equal(update.statusCode, 200, update.body);
  const { runtimeConfig, active, description } = update.json.config;
  assert.equal(active, false);
  assert.equal(description, 'Existing settings');
  assert.equal(runtimeConfig.executionLimits.maxRowsMax, 2000);
  assert.equal(runtimeConfig.executionLimits.maxRowsDefault, 600);
  assert.equal(runtimeConfig.assistant.llm.maxTokens, 4096);
  assert.equal(runtimeConfig.runtimeCache.refreshCooldownSec, 240);
  assert.equal(JSON.parse(configCard.RuntimeConfigJson).executionLimits.maxRowsMax, 2000);
  const invalid = await requestJson('PUT', configUrl, { runtimeConfig }, headers);
  assert.equal(invalid.statusCode, 422, invalid.body);
  assert.equal(invalid.json.errors[0].path, 'executionLimits.maxRowsMax');
  assert.equal(writes, 1);
  runtimeConfig.executionLimits.maxRowsMax = 1800;
  runtimeConfig.executionLimits.reportPageSize = 101;
  const invalidPage = await requestJson('PUT', configUrl, { runtimeConfig }, headers);
  assert.equal(invalidPage.statusCode, 422, invalidPage.body);
  assert.equal(invalidPage.json.errors[0].path, 'executionLimits.reportPageSize');
  assert.equal(writes, 1);
  runtimeConfig.executionLimits.reportPageSize = 37;
  for (const [key, cap] of [['maxSelectionScanRowsDefault', 30000], ['maxRestCallsDefault', 110]]) {
    for (const invalidValue of [0, 1.5, '10', cap + 1]) {
      runtimeConfig.executionLimits[key] = invalidValue;
      const rejected = await requestJson('PUT', configUrl, { runtimeConfig }, headers);
      assert.equal(rejected.statusCode, 422, rejected.body);
      assert.equal(rejected.json.code, 'runtime_config_invalid');
      const { path, max } = rejected.json.errors[0];
      assert.deepEqual({ path, max }, { path: `executionLimits.${key}`, max: cap });
      assert.equal(writes, 1, 'out-of-range config must not write a card');
    }
    runtimeConfig.executionLimits[key] = cap;
  }
  const valid = await requestJson('PUT', configUrl, { runtimeConfig }, headers);
  assert.equal(valid.statusCode, 200, valid.body);
  const savedLimits = JSON.parse(configCard.RuntimeConfigJson).executionLimits;
  assert.equal(savedLimits.maxRowsMax, 1800);
  assert.equal(savedLimits.reportPageSize, 37);
  assert.equal(savedLimits.maxClassesDefault, 17);
  assert.equal(savedLimits.maxRelationsPerCardMax, 321);
  assert.equal(savedLimits.maxSelectionScanRowsMax, 50000);
  assert.equal(savedLimits.maxSelectionScanRowsDefault, 30000);
  assert.equal(savedLimits.maxRestCallsDefault, 110);
  assert.equal(writes, 2);
});

function assertTransferReadOnly(mock) {
  assert.deepEqual(mock.requests.filter((item) => !['GET', 'HEAD'].includes(item.method)), [],
    'export/prepare must not mutate CMDBuild cards, schema, runtime config or version history');
}

test('template transfer export uses current unsaved authoring without writes or source identity', async (t) => {
  const template = transferAuthoringTemplate();
  const stored = templateCard(template.code, { version: 1, steps: [], result: { tables: [] } });
  const fixture = await transferApiFixture(t, { templates: [stored] });
  const before = structuredClone(stored);
  const result = await fixture.post('export', { template: { ...template, id: 'source-id', active: true, owner: 'source-owner' } });
  assert.equal(result.statusCode, 200, result.body);
  assert.match(result.json.fileName, /\.cmdp-template\.json$/);
  assert.equal(result.json.package.format, 'cmdbdynamicpages.template');
  assert.equal(result.json.package.formatVersion, 1);
  assert.deepEqual(result.json.package.template.spec, template.spec);
  assert.equal(result.json.package.template.paramsSchema, null);
  assert.equal(result.json.package.template.resultSchema, null);
  assert.ok(result.json.package.dependencies.directFields.some((item) => item.className === 'ARM' && item.field === 'Code' && /^\$\.spec\.visualModels\[\d+\]\.selections\[0\]\.columns/.test(item.path)), result.body);
  for (const key of ['id', 'active', 'owner', 'updatedAt', 'specHash', 'history', 'runtimeConfig']) {
    assert.equal(Object.hasOwn(result.json.package.template, key), false, key);
  }
  assert.deepEqual(stored, before);
  assertTransferReadOnly(fixture.mock);
  assert.equal(fixture.backend.exitCode, null);
});

test('template transfer prepare new is inactive and preserves IDs, names and prompts without writes', async (t) => {
  const fixture = await transferApiFixture(t);
  const source = transferAuthoringTemplate();
  const exported = await fixture.post('export', { template: source });
  assert.equal(exported.statusCode, 200, exported.body);
  const prepared = await fixture.post('prepare', {
    package: exported.json.package, mode: 'new', targetCode: 'PortableNew', description: 'Target description', overrides: []
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.template.code, 'PortableNew');
  assert.equal(prepared.json.template.description, 'Target description');
  assert.equal(prepared.json.template.active, false);
  assert.ok(!prepared.json.template.id);
  assert.deepEqual(prepared.json.template.spec.visualModel, source.spec.visualModel);
  assert.deepEqual(prepared.json.template.spec.visualModels, source.spec.visualModels);
  assert.deepEqual(prepared.json.template.spec.authoring.assistant, source.spec.authoring.assistant);
  assert.deepEqual(prepared.json.template.spec.steps, source.spec.steps);
  assert.ok(['ready', 'needsAttention'].includes(prepared.json.checks.status));
  assert.equal(typeof prepared.json.checks.executionReady, 'boolean');
  assert.ok(Array.isArray(prepared.json.checks.environmentReferences));
  assert.ok(Object.hasOwn(prepared.json, 'changes'));
  assertTransferReadOnly(fixture.mock);
});

test('template transfer replace keeps target identity/activity/hash and rejects stale hash or new collision', async (t) => {
  const targetSpec = apiObjectFlowSpec([{ alias: 'targetRouters', className: 'routerG', columns: ['Code'] }]);
  const target = { ...templateCard('PortableTarget', targetSpec), _id: 791, Active: true, Owner: 'target-owner' };
  const before = structuredClone(target);
  const fixture = await transferApiFixture(t, { templates: [target] });
  const exported = await fixture.post('export', { template: transferAuthoringTemplate() });
  assert.equal(exported.statusCode, 200, exported.body);
  const body = { package: exported.json.package, mode: 'replace', targetCode: target.Code, baseSpecHash: hashJson(targetSpec), overrides: [] };
  const prepared = await fixture.post('prepare', body);
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.template.id, target._id);
  assert.equal(prepared.json.template.code, target.Code);
  assert.equal(prepared.json.template.active, target.Active);
  assert.equal(prepared.json.template.owner, target.Owner);
  assert.equal(prepared.json.template.updatedAt, target.UpdatedAt);
  assert.equal(prepared.json.template.specHash, hashJson(targetSpec));
  assert.equal(prepared.json.changes.targetId, target._id);
  assert.match(prepared.json.changes.targetRevision, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(prepared.json.template.spec.steps, exported.json.package.template.spec.steps);
  const stale = await fixture.post('prepare', { ...body, baseSpecHash: '0'.repeat(64) });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json.code, 'template_spec_conflict');
  const collision = await fixture.post('prepare', { ...body, mode: 'new' });
  assert.equal(collision.statusCode, 409, collision.body);
  assert.deepEqual(target, before);
  assertTransferReadOnly(fixture.mock);
});

test('template transfer replace sends a partial PUT without metadata and appends history', async (t) => {
  for (const active of [false, true]) {
    const targetCode = active ? 'OwnedActiveTarget' : 'OwnedInactiveTarget';
    const targetSpec = apiObjectFlowSpec([{ alias: 'existingRouters', className: 'routerG', columns: ['Code'] }]);
    const targetCard = { ...templateCard(targetCode, targetSpec), _id: active ? 8202 : 8201,
      Active: active, Owner: 'original-target-owner' };
    const oldVersion = { _id: 'old-history-entry', Code: `VER_${targetCode}_3`, Description: 'Existing history',
      TemplateCode: targetCode, Version: 3, SpecJson: JSON.stringify(targetSpec), ChangedBy: 'original-author',
      ChangedAt: '2026-07-01T00:00:00.000Z', ChangeComment: 'Existing version must remain unchanged.' };
    const versions = [structuredClone(oldVersion)];
    const templatePutPatches = [];
    const fixture = await transferApiFixture(t, { templates: [targetCard], versionCards: versions, templatePutPatches });
    const exported = await fixture.post('export', { template: transferAuthoringTemplate('DifferentSourceOwner') });
    assert.equal(exported.statusCode, 200, exported.body);
    const prepared = await fixture.post('prepare', {
      package: exported.json.package, mode: 'replace', targetCode, baseSpecHash: hashJson(targetSpec), overrides: []
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.template.specHash, hashJson(targetSpec));
    assert.equal(prepared.json.template.owner, targetCard.Owner);
    assert.equal(prepared.json.template.active, active);
    assertTransferReadOnly(fixture.mock);
    assert.deepEqual(versions, [oldVersion], 'prepare must not append history');
    const draft = prepared.json.template;
    const saveBody = { ...transferReplacementSaveBody(prepared), active: !active, Owner: 'must-not-write',
      changeComment: 'Save after transfer replacement.' };
    const saved = await fixture.put(targetCode, saveBody);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(Object.keys(templatePutPatches[0]).sort(), ['Description', 'ParamsSchemaJson', 'ResultSchemaJson', 'SpecJson', 'UpdatedAt']);
    assert.equal(saved.json.versionLog.success, true, saved.body);
    const read = await requestJson('GET', `${fixture.origin}/cmdbuild/custom-api/templates/${targetCode}`, undefined, { cookie: fixture.headers.cookie });
    assert.equal(read.statusCode, 200, read.body);
    for (const result of [saved.json.template, read.json.template]) {
      assert.equal(result.id, targetCard._id);
      assert.equal(result.code, targetCode);
      assert.equal(result.owner, 'original-target-owner');
      assert.equal(result.active, active);
      assert.equal(result.specHash, hashJson(result.spec));
      assert.notEqual(result.specHash, hashJson(targetSpec));
      assert.deepEqual(result.spec.steps, draft.spec.steps);
      assert.deepEqual(result.spec.authoring.assistant, draft.spec.authoring.assistant);
    }
    const history = await requestJson('GET', `${fixture.origin}/cmdbuild/custom-api/templates/${targetCode}/versions`, undefined, { cookie: fixture.headers.cookie });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json.meta.total, 2);
    assert.deepEqual(history.json.data.map((item) => item.version), [4, 3]);
    assert.equal(history.json.data[0].templateCode, targetCode);
    assert.equal(history.json.data[0].changedBy, 'preview-user', 'history records the actor without replacing template ownership');
    assert.equal(history.json.data[0].changeComment, saveBody.changeComment);
    assert.deepEqual(history.json.data[0].spec, read.json.template.spec);
    assert.deepEqual(versions[0], oldVersion);
    assert.equal(versions.length, 2);
    assert.equal(fixture.mock.requests.filter((item) => item.method === 'PUT' && item.pathname.endsWith(`/classes/Cst_QueryTemplate/cards/${targetCard._id}`)).length, 1);
    assert.equal(fixture.mock.requests.filter((item) => item.method === 'POST' && item.pathname.endsWith('/classes/Cst_QueryTemplateVersion/cards')).length, 1);
  }
});

test('template transfer replace rejects stale metadata, wrong identity, malformed mode and revoked update permission without a write', async (t) => {
  const targetSpec = transferRawSpec();
  const card = { ...templateCard('RevisionTarget', targetSpec), _id: 4300, Active: true, Owner: 'original' };
  const cards = [card];
  const fixture = await transferApiFixture(t, { templates: cards, versionCards: [] });
  const pkg = (await fixture.post('export', { template: transferAuthoringTemplate() })).json.package;
  const prepare = { package: pkg, mode: 'replace', targetCode: card.Code, baseSpecHash: hashJson(targetSpec) };
  const prepared = await fixture.post('prepare', prepare);
  assert.equal(prepared.statusCode, 200, prepared.body);
  const body = transferReplacementSaveBody(prepared);
  for (const patch of [{ Description: 'renamed' }, { Active: false }, { Owner: 'other' },
    { ParamsSchemaJson: '{"changed":true}' }, { ResultSchemaJson: '{"changed":true}' }, { UpdatedAt: 'later' }, { _id: 4301 }]) {
    cards[0] = { ...card, ...patch };
    const changed = await fixture.put(card.Code, body);
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json.code, 'template_transfer_revision_conflict');
  }
  cards[0] = { ...card, _can_update: false };
  const denied = await fixture.put(card.Code, body);
  assert.equal(denied.statusCode, 403, denied.body);
  cards[0] = card;
  const invalid = await fixture.put(card.Code, { ...body, transferReplace: null });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.equal(invalid.json.code, 'template_transfer_replace_invalid');
  const incomplete = await fixture.put(card.Code, { ...body, spec: { version: 1, steps: [], result: { tables: [] } } });
  assert.equal(incomplete.statusCode, 422, incomplete.body);
  assert.equal(incomplete.json.code, 'template_transfer_incomplete');
  cards.length = 0;
  assert.equal((await fixture.put(card.Code, body)).statusCode, 409);
  assertTransferReadOnly(fixture.mock);
});

test('template transfer replace reruns list checks on final save and rechecks target after catalog reads', async (t) => {
  const targetSpec = transferRawSpec();
  const card = { ...templateCard('FinalValidationTarget', targetSpec), _id: 4302, Active: false };
  const cards = [card];
  let changeDuringValidation = false;
  const fixture = await transferApiFixture(t, transferReferenceCatalog({
    templates: cards, versionCards: [],
    delayByPath(url) {
      if (changeDuringValidation && url.pathname.endsWith('/classes/Location/cards/901')) {
        cards[0] = { ...card, Owner: 'changed-while-validating' };
      }
      return 0;
    }
  }));
  const spec = transferRawSpec();
  spec.steps[0].filters = [{ attribute: 'Location', op: 'in', values: [901, 902] }];
  const exported = await fixture.post('export', { template: { ...transferAuthoringTemplate(), spec } });
  const prepared = await fixture.post('prepare', { package: exported.json.package, mode: 'replace', targetCode: card.Code, baseSpecHash: hashJson(targetSpec) });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.executionReady, true, prepared.body);
  const body = transferReplacementSaveBody(prepared);
  const edited = structuredClone(body);
  edited.spec.steps[0].filters[0].values[1] = 999;
  const rejected = await fixture.put(card.Code, edited);
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json.code, 'template_transfer_incomplete');
  assert.ok(rejected.json.issues.some((issue) => issue.path === '$.spec.steps[0].filters[0].values[1]' && issue.code === 'template_transfer_card_unavailable'));
  changeDuringValidation = true;
  const changed = await fixture.put(card.Code, body);
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json.code, 'template_transfer_revision_conflict');
  assertTransferReadOnly(fixture.mock);
});

test('template transfer missing target class remains editable needsAttention with nonblocking issues', async (t) => {
  const fixture = await transferApiFixture(t);
  const source = transferAuthoringTemplate('MissingSource', 'MissingPortableClass');
  const exported = await fixture.post('export', { template: source });
  assert.equal(exported.statusCode, 200, exported.body);
  const prepared = await fixture.post('prepare', { package: exported.json.package, mode: 'new', targetCode: 'MissingTarget', overrides: [] });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.status, 'needsAttention');
  assert.equal(prepared.json.checks.executionReady, false);
  assert.deepEqual(prepared.json.template.spec.steps, source.spec.steps);
  const issue = prepared.json.checks.issues.find((item) => /class/i.test(item.code) && /MissingPortableClass/.test(item.message));
  assert.ok(issue, prepared.body);
  assert.equal(typeof issue.path, 'string');
  assert.equal(typeof issue.severity, 'string');
  assert.equal(issue.blocking, false);
  assertTransferReadOnly(fixture.mock);
});

test('template transfer rejects corrupted checksum and requires auth and CSRF on both endpoints', async (t) => {
  const fixture = await transferApiFixture(t);
  const template = transferAuthoringTemplate();
  const exported = await fixture.post('export', { template });
  assert.equal(exported.statusCode, 200, exported.body);
  const pkg = structuredClone(exported.json.package);
  pkg.template.spec.authoring.assistant.diagramIntentPrompt += ' tampered';
  const corrupted = await fixture.post('prepare', { package: pkg, mode: 'new', targetCode: 'TamperedTarget', overrides: [] });
  assert.ok([400, 422].includes(corrupted.statusCode), corrupted.body);
  assert.equal(corrupted.json.success, false);
  for (const [action, body] of [
    ['export', { template }],
    ['prepare', { package: exported.json.package, mode: 'new', targetCode: 'ProtectedTarget', overrides: [] }]
  ]) {
    const url = `${fixture.origin}/cmdbuild/custom-api/template-transfer/${action}`;
    const anonymous = await requestJson('POST', url, body, { origin: fixture.origin });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    const noCsrf = await requestJson('POST', url, body, { cookie: fixture.headers.cookie, origin: fixture.origin });
    assert.equal(noCsrf.statusCode, 403, noCsrf.body);
    const wrongCsrf = await requestJson('POST', url, body, { ...fixture.headers, 'x-cmdbdynamicpages-csrf': 'invalid-csrf' });
    assert.equal(wrongCsrf.statusCode, 403, wrongCsrf.body);
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer reattests signed D2 across backend secrets without LLM or mapping changes', async (t) => {
  const llm = await startLiteLlmStub(t, { flow: { version: 1, selections: [], operations: [], publishedAlias: '' } });
  const runtime = { assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } };
  const mockOptions = { configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify(runtime) }] };
  const env = { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin };
  const source = await transferApiFixture(t, mockOptions, { ...env, CMDBDYNAMICPAGES_CSRF_SECRET: 'transfer-source-test-secret' });
  const target = await transferApiFixture(t, mockOptions, { ...env, CMDBDYNAMICPAGES_CSRF_SECRET: 'transfer-target-test-secret' });
  const currentSpec = apiObjectFlowSpec([
    { alias: 'routers', className: 'routerG', columns: ['Code', 'Description'] },
    { alias: 'arms', className: 'ARM', columns: ['Code', 'Description'] }
  ], [{ id: 'match:portableNetwork', from: 'routers', with: 'arms', as: 'portableNetwork', rightPrefix: 'Selection 2.',
    rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Code', leftRegex: '', rightColumn: 'Code', rightRegex: '' }] }]);
  const d2Source = 'router: Router\nswitch: Switch\nrouter -> switch: Connection';
  currentSpec.authoring = structuredClone(transferAuthoringTemplate().spec.authoring);
  currentSpec.authoring.d2.source = d2Source;
  const analyzed = await requestJson('POST', `${source.origin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: '', baseSpecHash: '', currentSpec, d2Source
  }, source.headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const proposal = analyzed.json.proposal;
  assert.ok(proposal.signature, analyzed.body);
  const roles = proposal.roles.map((role) => d2RoleOverride(role, {
    materialization: { kind: 'stage', stageId: role.key === 'router' ? 'selection:routers' : 'selection:arms' },
    primary: { className: role.key === 'router' ? 'routerG' : 'ARM', idAttribute: '_id', labelTemplate: '${Code}', structuredFields: ['Code'], filters: [] }, related: []
  }));
  const applied = await requestJson('POST', `${source.origin}/cmdbuild/custom-api/draft/diagram-import/apply`, {
    templateCode: '', baseSpecHash: '', currentSpec, d2Source, proposal, roles,
    structureTree: d2StructureTreeWithMaterialization(proposal, roles),
    relationRules: [{ ...proposal.relationRules[0], id: 'portable-reviewed-connection', kind: 'connection', mode: 'deterministicEndpoints', directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'routerG').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'ARM').id,
      sourceStageId: 'match:portableNetwork', sourceField: 'Code', targetField: 'Selection 2.Code', labelField: '' }]
  }, source.headers);
  assert.equal(applied.statusCode, 200, applied.body);
  const sourceImported = applied.json.spec.result.diagrams[0].authoring.d2Import;
  assert.ok(sourceImported.mappingValidation.signature, applied.body);
  const exported = await source.post('export', { template: { ...transferAuthoringTemplate(), spec: applied.json.spec } });
  assert.equal(exported.statusCode, 200, exported.body);
  const portableImported = exported.json.package.template.spec.result.diagrams[0].authoring.d2Import;
  for (const key of ['mappingValidation', 'proposalId', 'importedAt']) assert.equal(Object.hasOwn(portableImported, key), false, key);
  for (const key of ['sourceHash', 'structureHash', 'mappingContractHash', 'roles', 'structureTree', 'relationRules']) {
    assert.deepEqual(portableImported[key], sourceImported[key], key);
  }
  const prepared = await target.post('prepare', { package: exported.json.package, mode: 'new', targetCode: 'ReattestedTarget', overrides: [] });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const targetImported = prepared.json.template.spec.result.diagrams[0].authoring.d2Import;
  assert.equal(prepared.json.checks.executionReady, true, prepared.body);
  assert.equal(targetImported.mappingValidation.status, 'valid', prepared.body);
  assert.match(targetImported.mappingValidation.signature, /^[a-f0-9]{64}$/);
  assert.notEqual(targetImported.mappingValidation.signature, sourceImported.mappingValidation.signature);
  for (const key of ['roles', 'structureTree', 'relationRules', 'sourceHash', 'structureHash', 'mappingContractHash']) {
    assert.deepEqual(targetImported[key], sourceImported[key], key);
  }
  assert.deepEqual(prepared.json.template.spec.authoring.assistant, applied.json.spec.authoring.assistant);
  assert.equal(llm.requests, 0, 'portable reviewed D2 compile/reattest must not call LLM');
  assertTransferReadOnly(source.mock);
  assertTransferReadOnly(target.mock);
  assert.equal(source.backend.exitCode, null);
  assert.equal(target.backend.exitCode, null);
});

test('template transfer rehydrates unapplied reviewed checkpoints and Save/read retains their payload without LLM', async (t) => {
  const llm = await startLiteLlmStub(t, { flow: { version: 1, selections: [], operations: [], publishedAlias: '' } });
  const configCards = [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
    RuntimeConfigJson: JSON.stringify({ assistant: { llm: { enabled: true, baseUrl: llm.origin, model: 'unit-test-model' } } }) }];
  const env = { LITELLM_API_KEY: 'unit-test-key', CMDP_LITELLM_ALLOWED_BASE_URLS: llm.origin };
  const source = await transferApiFixture(t, { configCards }, { ...env, CMDBDYNAMICPAGES_CSRF_SECRET: 'unapplied-source-test-secret' });
  const template = transferAuthoringTemplate('UnappliedSource');
  const d2Source = 'router: Router\nswitch: Switch\nrouter -> switch: Connection';
  template.spec.authoring.d2.source = d2Source;
  const analyzed = await requestJson('POST', `${source.origin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: '', baseSpecHash: '', currentSpec: template.spec, d2Source
  }, source.headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const proposal = analyzed.json.proposal;
  const reviewedRoles = proposal.roles.map((role) => ({ id: role.id, visualKind: role.visualKind, labelTemplate: 'Reviewed ${Code}' }));
  const rolesWithMappings = proposal.roles.map((role) => d2RoleOverride(role, {
    materialization: { kind: 'stage', stageId: 'selection:portableAssets' },
    primary: { className: 'ARM', idAttribute: '_id', labelTemplate: '${Code}', structuredFields: ['Code'], filters: [] }, related: []
  }));
  const analysisCheckpoint = {
    version: 1, proposalId: proposal.proposalId, deterministicSpecHash: proposal.deterministicSpecHash,
    deterministicSpecRevision: proposal.deterministicSpecRevision,
    source: { hash: proposal.source.hash, structureHash: proposal.source.structureHash, mappingContractHash: proposal.source.mappingContractHash },
    roles: reviewedRoles, relationRules: proposal.relationRules,
    structureTree: d2StructureTreeWithMaterialization(proposal, rolesWithMappings)
  };
  const assistantCheckpoint = {
    ...structuredClone(analysisCheckpoint),
    interpretation: { explanation: 'Reviewed interpretation, not yet applied.', warnings: ['Keep this review warning.'],
      decisions: reviewedRoles.map((role) => ({ ...role, roleId: role.id, reason: 'Reviewed by author.' })) },
    mapping: { explanation: 'Reviewed mapping, not yet applied.', warnings: [],
      result: { mapping: { status: 'partial', mappedRoles: reviewedRoles.length, requiredRoles: reviewedRoles.length }, partial: true } }
  };
  template.spec.authoring.d2.analysisCheckpoint = analysisCheckpoint;
  template.spec.authoring.d2.assistantCheckpoint = assistantCheckpoint;
  assert.equal(template.spec.result.diagrams?.length || 0, 0, 'checkpoint fixture must remain unapplied');
  const exported = await source.post('export', { template });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json.package.formatVersion, 1);
  assert.equal(exported.json.package.template.spec.version, 1);
  for (const name of ['analysisCheckpoint', 'assistantCheckpoint']) {
    const checkpoint = exported.json.package.template.spec.authoring.d2[name];
    for (const key of ['proposalId', 'deterministicSpecHash', 'source']) assert.equal(Object.hasOwn(checkpoint, key), false, `${name}.${key}`);
    assert.equal(checkpoint.deterministicSpecRevision, proposal.deterministicSpecRevision);
  }
  const targetCode = 'UnappliedReviewedTarget';
  const target = await transferApiFixture(t, { configCards, persistNewTemplates: true, versionCards: [] },
    { ...env, CMDBDYNAMICPAGES_CSRF_SECRET: 'unapplied-target-test-secret' });
  const prepared = await target.post('prepare', {
    package: exported.json.package, mode: 'new', targetCode, overrides: []
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.status, 'needsAttention');
  assert.equal(prepared.json.checks.executionReady, false);
  assert.equal(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_d2_checkpoint_invalid'), false, prepared.body);
  const preparedD2 = prepared.json.template.spec.authoring.d2;
  for (const name of ['analysisCheckpoint', 'assistantCheckpoint']) {
    const checkpoint = preparedD2[name];
    assert.match(checkpoint.proposalId, /^[a-f0-9-]{36}$/);
    assert.notEqual(checkpoint.proposalId, proposal.proposalId);
    assert.match(checkpoint.deterministicSpecHash, /^[a-f0-9]{64}$/);
    assert.equal(checkpoint.deterministicSpecRevision, proposal.deterministicSpecRevision);
    assert.deepEqual(checkpoint.source, analysisCheckpoint.source);
    for (const key of ['roles', 'structureTree', 'relationRules']) assert.deepEqual(checkpoint[key], analysisCheckpoint[key], `${name}.${key}`);
  }
  assert.deepEqual(preparedD2.assistantCheckpoint.mapping, assistantCheckpoint.mapping);
  assert.equal(preparedD2.assistantCheckpoint.interpretation.explanation, assistantCheckpoint.interpretation.explanation);
  assertTransferReadOnly(source.mock);
  assertTransferReadOnly(target.mock);
  const saved = await target.create(prepared.json.template);
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json.template.active, false, saved.body);
  const read = await requestJson('GET', `${target.origin}/cmdbuild/custom-api/templates/${targetCode}`, undefined, { cookie: target.headers.cookie });
  assert.equal(read.statusCode, 200, read.body);
  const persistedD2 = { ...preparedD2, sourceHash: crypto.createHash('sha256').update(d2Source).digest('hex') };
  assert.deepEqual(saved.json.template.spec.authoring.d2, persistedD2);
  assert.deepEqual(read.json.template.spec.authoring.d2, persistedD2);
  const restored = await requestJson('POST', `${target.origin}/cmdbuild/custom-api/draft/diagram-import/restore`, {
    templateCode: targetCode, baseSpecHash: read.json.template.specHash, currentSpec: read.json.template.spec,
    analysisCheckpoint: preparedD2.analysisCheckpoint, assistantCheckpoint: preparedD2.assistantCheckpoint
  }, target.headers);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json.restoreKind, 'assistant');
  assert.ok(restored.json.proposal.signature);
  assert.equal(restored.json.interpretation.explanation, assistantCheckpoint.interpretation.explanation);
  assert.deepEqual(restored.json.mapping.result, assistantCheckpoint.mapping.result);
  assert.equal(llm.requests, 0);
  assert.equal(target.mock.requests.filter((item) => item.method === 'POST' && item.pathname.endsWith('/classes/Cst_QueryTemplate/cards')).length, 1);
});

test('template transfer overrides catalog-typed card and lookup values at actual visualModels and mirror paths', async (t) => {
  const template = transferAuthoringTemplate('TypedReferenceSource');
  template.spec = compileObjectFlowToSpec(template.spec, { version: 1, selections: [{
    id: 'selection:typedAssets', name: 'Typed assets', alias: 'typedAssets', className: 'ARM', limit: 100, columns: ['Code'],
    rules: [{ action: 'include', path: 'Location', op: 'equals', value: '901' }, { action: 'include', path: 'Status', op: 'equals', value: '7' }]
  }], operations: [] });
  template.spec.visualModel = structuredClone(template.spec.visualModels.find((model) => model.mode === 'objectMatching'));
  const fixture = await transferApiFixture(t, {
    attributesByClass: { ARM: [
      { name: 'Location', type: 'reference', targetClass: 'Location', active: true, _can_read: true },
      { name: 'Status', type: 'lookup', lookupType: 'AssetStatus', active: true, _can_read: true }
    ] },
    cardsByClass: { Location: [{ _id: 902, Code: 'target-location', _can_read: true }] },
    lookupValuesByType: { AssetStatus: [{ _id: 8, code: 'target-status', active: true }] }
  });
  const exported = await fixture.post('export', { template });
  assert.equal(exported.statusCode, 200, exported.body);
  const body = { package: exported.json.package, mode: 'new', targetCode: 'TypedReferenceTarget', overrides: [] };
  const originalPackage = structuredClone(body.package);
  const initial = await fixture.post('prepare', body);
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json.checks.status, 'needsAttention');
  const refs = initial.json.checks.environmentReferences.filter((ref) => ['card', 'lookup'].includes(ref.kind));
  assert.equal(refs.length, 6, initial.body);
  assert.equal(refs.filter((ref) => ref.kind === 'card').length, 3);
  assert.equal(refs.filter((ref) => ref.kind === 'lookup').length, 3);
  assert.ok(refs.some((ref) => /^\$\.spec\.visualModels\[\d+\]\.selections\[0\]\.rules\[0\]\.rightExpression$/.test(ref.path)));
  assert.ok(refs.some((ref) => ref.path === '$.spec.visualModel.selections[0].rules[1].rightExpression'));
  assert.ok(refs.some((ref) => /^\$\.spec\.visualModels\[\d+\]\.selections\[0\]\.scopeRules\[1\]\.rightExpression$/.test(ref.path)));
  assert.ok(refs.every((ref) => ref.requiresConfirmation === true));
  assert.ok(initial.json.checks.issues.some((issue) => issue.code === 'template_transfer_card_unavailable'));
  assert.ok(initial.json.checks.issues.some((issue) => issue.code === 'template_transfer_lookup_unavailable'));
  const overrides = refs.map((ref) => ({ path: ref.path, value: ref.kind === 'card' ? '902' : '8' }));
  const prepared = await fixture.post('prepare', { ...body, overrides });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.executionReady, true, prepared.body);
  assert.equal(prepared.json.checks.issues.some((issue) => /_(card|lookup)_unavailable$/.test(issue.code)), false, prepared.body);
  assert.deepEqual(prepared.json.checks.environmentReferences.filter((ref) => ['card', 'lookup'].includes(ref.kind)).map(({ path, value }) => ({ path, value })), overrides);
  const matching = prepared.json.template.spec.visualModels.find((model) => model.mode === 'objectMatching');
  assert.deepEqual(matching.selections[0].rules.map((rule) => rule.rightExpression), ['902', '8']);
  assert.deepEqual(prepared.json.template.spec.visualModel.selections[0].rules.map((rule) => rule.rightExpression), ['902', '8']);
  assert.deepEqual(prepared.json.template.spec.visualModels.find((model) => model.mode === 'objectGroup').selections[0].scopeRules.map((rule) => rule.rightExpression), ['902', '8']);
  assert.deepEqual(prepared.json.template.spec.steps.find((step) => step.as === 'typedAssets').filters.map((filter) => filter.valueExpression), ['902', '8']);
  assert.equal(matching.selections[0].id, 'selection:typedAssets');
  assert.deepEqual(prepared.json.template.spec.authoring.assistant, template.spec.authoring.assistant);
  assert.deepEqual(body.package, originalPackage);
  assert.ok(fixture.mock.requests.some((item) => item.pathname.endsWith('/classes/Location/cards/902')));
  assert.ok(fixture.mock.requests.some((item) => item.pathname.endsWith('/lookup_types/AssetStatus/values/8')));
  const invalidPath = await fixture.post('prepare', { ...body, overrides: [{ path: '$.spec.visualModel.selections[0].id', value: '902' }] });
  assert.equal(invalidPath.statusCode, 400, invalidPath.body);
  assertTransferReadOnly(fixture.mock);
});

test('template transfer checks match-only fields absent from displayed direct-selection columns', async (t) => {
  const fixture = await transferApiFixture(t);
  for (const missingSide of ['left', 'right']) {
    const template = transferAuthoringTemplate(`ImplicitMatch${missingSide}`);
    template.spec = apiObjectFlowSpec([
      { alias: 'assets', className: 'ARM', columns: ['Code'] },
      { alias: 'routers', className: 'routerG', columns: ['Code'] }
    ], [{
      id: 'match:implicitField', from: 'assets', with: 'routers', as: 'matchedAssets', rightPrefix: 'Router.',
      rules: [{ action: 'include', negate: false, operator: 'equals',
        leftColumn: missingSide === 'left' ? 'MissingAttribute' : 'Code', leftRegex: '',
        rightColumn: missingSide === 'right' ? 'MissingAttribute' : 'Code', rightRegex: '' }]
    }]);
    const matching = template.spec.visualModels.find((model) => model.mode === 'objectMatching');
    assert.deepEqual(matching.selections.map((selection) => selection.columns), [['Code'], ['Code']],
      'the unavailable attribute is used only by matching, never an explicit displayed column');
    const sourceAlias = missingSide === 'left' ? 'assets' : 'routers';
    assert.equal((template.spec.steps.find((step) => step.as === sourceAlias).columns || []).some((column) => column.path === 'MissingAttribute'), false,
      'direct card attributes are implicitly materialized, not explicit technical step projections');
    const exported = await fixture.post('export', { template });
    assert.equal(exported.statusCode, 200, exported.body);
    const prepared = await fixture.post('prepare', {
      package: exported.json.package, mode: 'new', targetCode: `ImplicitMatchTarget${missingSide}`, overrides: []
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.status, 'needsAttention', prepared.body);
    assert.equal(prepared.json.checks.executionReady, false, prepared.body);
    const className = missingSide === 'left' ? 'ARM' : 'routerG';
    const issue = prepared.json.checks.issues.find((item) => item.code === 'template_transfer_field_unavailable'
      && item.message.includes(`${className}.MissingAttribute`));
    assert.ok(issue, prepared.body);
    assert.match(issue.path, /^\$\.spec\./);
    assert.equal(issue.severity, 'error');
    assert.equal(issue.blocking, false);
    assert.deepEqual(prepared.json.template.spec.steps, template.spec.steps);
    assert.deepEqual(prepared.json.template.spec.visualModels, template.spec.visualModels);
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer accepts generated relation metadata and source display columns without schema attributes', async (t) => {
  const fixture = await transferApiFixture(t, {
    attributesByClass: { routerG: [], ARM: [] },
    domains: [{ _id: 'RouterArm', name: 'RouterArm', source: 'routerG', sources: ['routerG'],
      destination: 'ARM', destinations: ['ARM'], disabledSourceDescendants: [], disabledDestinationDescendants: [], cardinality: 'N:N' }]
  });
  const template = transferAuthoringTemplate('RelationMetadataSource');
  template.spec = apiObjectFlowSpec([
    { alias: 'routers', className: 'routerG', columns: ['Code', '_Name', '_isExt'] }
  ], [{ id: 'relation:relatedAssets', type: 'relation', from: 'routers', as: 'relatedAssets',
    domain: 'RouterArm', direction: 'source', targetClass: 'ARM', columns: ['Code', '_Name', '_isExt'] }]);
  const matching = template.spec.visualModels.find((model) => model.mode === 'objectMatching');
  const stages = objectFlowStageSummaries(matching);
  const source = stages.find((stage) => stage.id === 'selection:routers');
  const related = stages.find((stage) => stage.id === 'relation:relatedAssets');
  for (const column of ['_Name', '_isExt']) assert.ok(source.columns.includes(column), column);
  for (const column of ['Domain', 'RelationId', 'RelationDirection', 'RelationSourceSide', 'RelatedClass', 'RelatedId']) {
    assert.ok(related.columns.includes(column), `relation stage must generate ${column}`);
    assert.equal(matching.operations[0].columns.includes(column), false, `${column} is runtime metadata, not an authored schema field`);
  }
  const exported = await fixture.post('export', { template });
  assert.equal(exported.statusCode, 200, exported.body);
  const prepared = await fixture.post('prepare', {
    package: exported.json.package, mode: 'new', targetCode: 'RelationMetadataTarget', overrides: []
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.status, 'ready', prepared.body);
  assert.equal(prepared.json.checks.executionReady, true, prepared.body);
  assert.deepEqual(prepared.json.checks.issues, []);
  assert.deepEqual(prepared.json.template.spec.steps, template.spec.steps);
  assert.deepEqual(prepared.json.template.spec.visualModels, template.spec.visualModels);
  for (const className of ['routerG', 'ARM']) {
    assert.ok(fixture.mock.requests.some((item) => item.pathname.endsWith(`/classes/${className}/attributes`)), `catalog attributes were checked for ${className}`);
  }
  assert.ok(fixture.mock.requests.some((item) => item.pathname.endsWith('/domains/RouterArm')));
  for (const displayField of ['_Name', '_isExt']) {
    const filtered = structuredClone(template);
    for (const model of filtered.spec.visualModels) {
      const selection = model.selections?.[0];
      if (selection) (selection.rules || selection.scopeRules)[0].path = displayField;
    }
    const filteredExport = await fixture.post('export', { template: filtered });
    assert.equal(filteredExport.statusCode, 200, filteredExport.body);
    const filteredPrepare = await fixture.post('prepare', {
      package: filteredExport.json.package, mode: 'new', targetCode: `StrictDisplayRule${displayField}`, overrides: []
    });
    assert.equal(filteredPrepare.statusCode, 200, filteredPrepare.body);
    assert.equal(filteredPrepare.json.checks.status, 'needsAttention');
    assert.equal(filteredPrepare.json.checks.executionReady, false);
    assert.ok(filteredPrepare.json.checks.issues.some((issue) => issue.code === 'template_transfer_field_unavailable'
      && issue.message.includes(`routerG.${displayField}`)), filteredPrepare.body);
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer denies create and update before target model or catalog checks', async (t) => {
  const targetSpec = apiObjectFlowSpec([{ alias: 'existingAssets', className: 'ARM', columns: ['Code'] }]);
  const targetCode = 'PermissionDeniedTarget';
  for (const mode of ['new', 'replace-card', 'replace-class']) {
    const templates = mode === 'new' ? [] : [templateCard(targetCode, targetSpec,
      mode === 'replace-card' ? { canUpdate: false } : { includeCanUpdate: false })];
    const fixture = await transferApiFixture(t, {
      templates, templateClassCanCreate: false, templateClassCanUpdate: false
    });
    const exported = await fixture.post('export', { template: transferAuthoringTemplate('DeniedSource', 'MissingDeniedClass') });
    assert.equal(exported.statusCode, 200, exported.body);
    const before = fixture.mock.requests.length;
    const denied = await fixture.post('prepare', {
      package: exported.json.package, mode: mode === 'new' ? 'new' : 'replace', targetCode,
      ...(mode === 'new' ? {} : { baseSpecHash: hashJson(targetSpec) }), overrides: []
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json.reason, mode === 'new' ? 'template_create_forbidden' : 'template_update_forbidden');
    assert.equal(denied.json.template, undefined);
    assert.equal(denied.json.checks, undefined);
    const reads = fixture.mock.requests.slice(before);
    assert.ok(reads.length > 0);
    assert.ok(reads.every((item) => /^\/cmdbuild\/services\/rest\/v3\/(sessions\/current|classes\/Cst_QueryTemplate(?:\/cards)?)$/.test(item.pathname)),
      `permission denial must precede runtime/model/catalog reads: ${JSON.stringify(reads)}`);
    assertTransferReadOnly(fixture.mock);
  }
});

test('template transfer finds replacement and code collision beyond 1000 target cards', async (t) => {
  const targetSpec = apiObjectFlowSpec([{ alias: 'lateTarget', className: 'ARM', columns: ['Code'] }]);
  const templates = Array.from({ length: 1005 }, (_, index) => templateCard(`EarlierTemplate${index}`, targetSpec));
  const targetCode = 'TemplateAfterFirstThousand';
  templates.push({ ...templateCard(targetCode, targetSpec), Active: false, _id: 6001 });
  for (const templateCodeFilter of [false, true]) {
    const fixture = await transferApiFixture(t, { templates, templateCodeFilter });
    const exported = await fixture.post('export', { template: transferAuthoringTemplate() });
    assert.equal(exported.statusCode, 200, exported.body);
    const body = { package: exported.json.package, targetCode, overrides: [] };
    const collision = await fixture.post('prepare', { ...body, mode: 'new' });
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal(collision.json.code, 'template_transfer_code_collision');
    const replacement = await fixture.post('prepare', { ...body, mode: 'replace', baseSpecHash: hashJson(targetSpec) });
    assert.equal(replacement.statusCode, 200, replacement.body);
    assert.equal(replacement.json.template.id, 6001);
    assert.equal(replacement.json.template.active, false);
    assert.equal(replacement.json.template.specHash, hashJson(targetSpec));
    const lookups = fixture.mock.requests.filter((item) => item.pathname.endsWith('/classes/Cst_QueryTemplate/cards'));
    assert.equal(lookups.some((item) => new URLSearchParams(item.search).get('start') === '1000'), !templateCodeFilter);
    assert.ok(lookups.every((item) => {
      const filter = JSON.parse(new URLSearchParams(item.search).get('filter'));
      return filter.attribute.simple.attribute === 'Code' && filter.attribute.simple.value[0] === targetCode;
    }));
    assertTransferReadOnly(fixture.mock);
  }
});

function transferRawSpec(extra = {}) {
  return { version: 1, steps: [{ type: 'selectCards', as: 'assets', className: 'ARM',
    filters: [], columns: ['Code'], limit: 100 }], result: { tables: [{ name: 'assets', columns: ['Code'] }] }, ...extra };
}

function transferReferenceCatalog(extra = {}) {
  return { classes: ['ARM', 'routerG', 'Location', 'Cst_QueryToolConfig', 'Cst_QueryTemplate'].map((name) => ({ name, active: true })),
    cardsByClass: { Location: [901, 902, 903, 904, 905].map((_id) => ({ _id, Code: `site-${_id}`, _can_read: true })) }, ...extra };
}

async function prepareRawTransfer(fixture, spec, code, overrides = []) {
  const exported = await fixture.post('export', { template: { code, description: '', spec, paramsSchema: null, resultSchema: null } });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json.package.formatVersion, 1);
  return fixture.post('prepare', { package: exported.json.package, mode: 'new', targetCode: code, overrides });
}

test('template transfer attests large table selectors in the target catalog without reading rows', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog({ attributesByClass: {
    ARM: [{ name: 'Location', type: 'reference', targetClass: 'Location', active: true, _can_read: true }],
    Location: [{ name: 'DisplayName', type: 'string', active: true, _can_read: true },
      { name: 'HiddenName', type: 'string', active: true, _can_read: false }]
  } }));
  const selectorPath = '$.spec.result.tables[0].presentation.largeTable.selector.';
  for (const [name, override, missing] of [
    ['Class', {}, []],
    ['UnknownClass', { source: 'UnattestedClass' }, ['source']],
    ['UnknownLabel', { labelField: 'HiddenName' }, ['labelField']],
    ['UnknownId', { idField: 'HiddenId' }, ['idField']],
    ['UnknownMatch', { matchField: 'HiddenMatch' }, ['matchField']],
    ['Result', { kind: 'result', source: 'options', idField: 'ChoiceId', labelField: 'ChoiceLabel' }, []],
    ['UnknownResultField', { kind: 'result', source: 'options', idField: 'ChoiceId', labelField: 'HiddenLabel' }, ['labelField']],
  ]) {
    const selector = { kind: 'class', source: 'Location', idField: '_id', labelField: 'DisplayName', matchField: 'SiteKey', ...override };
    const spec = transferRawSpec({
      publish: { mode: 'staticSnapshot', warningAccepted: true },
      steps: [
        { type: 'selectCards', as: 'assets', className: 'ARM', columns: ['Code'] },
        { type: 'enrichRows', as: 'projected', from: 'assets', columns: [{ path: 'Location', as: 'SiteKey' }] },
        { type: 'selectCards', as: 'locations', className: 'Location', columns: ['_id', 'DisplayName'] },
        { type: 'composeRows', as: 'options', from: 'locations', columns: [
          { name: 'ChoiceId', column: '_id' }, { name: 'ChoiceLabel', column: 'DisplayName' }
        ] }
      ],
      result: { tables: [{ name: 'projected', columns: ['Code'], presentation: { largeTable: { mode: 'key', selector } } }] }
    });
    const prepared = await prepareRawTransfer(fixture, spec, `LargeSelector${name}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.deepEqual(prepared.json.template.spec.result.tables[0].presentation.largeTable.selector, selector);
    assert.equal(prepared.json.checks.executionReady, !missing.length, prepared.body);
    assert.equal(prepared.json.checks.status, missing.length ? 'needsAttention' : 'ready', prepared.body);
    for (const field of missing) {
      assert.ok(prepared.json.checks.issues.some((issue) => issue.path === selectorPath + field && issue.severity === 'error' && issue.blocking === false), prepared.body);
    }
    if (name === 'UnknownResultField') {
      const rejected = await fixture.create(prepared.json.template);
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.ok(rejected.json.errors.some((error) => error.path === '$.result.tables[0].presentation.largeTable.selector.labelField'), rejected.body);
    }
  }
  assert.ok(fixture.mock.requests.some((request) => request.pathname.endsWith('/classes/Location/attributes')));
  assert.equal(fixture.mock.requests.some((request) => /\/classes\/(ARM|Location|UnattestedClass)\/cards/.test(request.pathname)), false);
  assertTransferReadOnly(fixture.mock);
});

test('template transfer parameter reference matrix checks only effective physical defaults and preserves shadowed candidates', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog());
  for (const [index, effectivePath] of ['$.spec.defaults.site', '$.spec.paramDefaults.site', '$.spec.params.site.default', '$.spec.params.site.defaultValue'].entries()) {
    const spec = transferRawSpec({ params: { site: { type: 'string', default: '903', defaultValue: '904' } } });
    if (index < 1) spec.defaults = { site: '901' };
    if (index < 2) spec.paramDefaults = { site: '902' };
    if (index > 2) delete spec.params.site.default;
    spec.steps[0].filters = [{ path: 'Location', op: 'equals', valueExpression: '${param.site}' }];
    const from = fixture.mock.requests.length;
    const prepared = await prepareRawTransfer(fixture, spec, `DefaultMatrix${index}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.executionReady, true, prepared.body);
    const refs = prepared.json.checks.environmentReferences.filter((ref) => ref.parameterName === 'site');
    assert.equal(refs.length, 4 - index, prepared.body);
    assert.equal(refs.filter((ref) => ref.effective).length, 1, prepared.body);
    assert.equal(refs.find((ref) => ref.effective).path, effectivePath);
    for (const ref of refs) {
      assert.equal(ref.requiresConfirmation, ref.effective);
      assert.equal(ref.shadowedBy, ref.effective ? '' : effectivePath);
    }
    assert.deepEqual(fixture.mock.requests.slice(from).filter((request) => /\/classes\/Location\/cards\//.test(request.pathname)).map((request) => request.pathname.split('/').pop()), [String(901 + index)]);
    const changed = await prepareRawTransfer(fixture, spec, `ChangedDefault${index}`, [{ path: effectivePath, value: '905' }]);
    assert.equal(changed.json.checks.executionReady, true, changed.body);
    assert.equal(changed.json.checks.environmentReferences.find((ref) => ref.effective && ref.parameterName === 'site').value, '905');
    assert.deepEqual(changed.json.checks.environmentReferences.filter((ref) => ref.parameterName === 'site' && !ref.effective).map(({ path, value }) => ({ path, value })), refs.filter((ref) => !ref.effective).map(({ path, value }) => ({ path, value })));
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer shadowed override changes only its physical path and is not execution ready', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog());
  const spec = transferRawSpec({ defaults: { site: '901' }, paramDefaults: { site: '902' },
    params: { site: { type: 'string', referenceType: 'card', targetClass: 'Location', default: '903', defaultValue: '904' } } });
  spec.steps[0].filters = [{ path: 'Location', op: 'equals', valueExpression: '${param.site}' }];
  const prepared = await prepareRawTransfer(fixture, spec, 'ShadowedOverride', [{ path: '$.spec.params.site.defaultValue', value: '905' }]);
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.status, 'needsAttention');
  assert.equal(prepared.json.checks.executionReady, false);
  assert.ok(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_override_shadowed' && issue.severity === 'error' && issue.path === '$.spec.params.site.defaultValue'));
  const next = prepared.json.template.spec;
  assert.deepEqual(next.defaults, spec.defaults);
  assert.deepEqual(next.paramDefaults, spec.paramDefaults);
  assert.deepEqual(next.params.site, { ...spec.params.site, defaultValue: '905' });
  assert.equal(prepared.json.checks.environmentReferences.find((ref) => ref.effective && ref.parameterName === 'site').value, '901');
  assertTransferReadOnly(fixture.mock);
});

test('template transfer metadata defaultValue lookup and raw literal card references are checked and overridable', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog({ lookupValuesByType: { Status: [{ _id: 8, code: 'active', active: true }] } }));
  const spec = transferRawSpec({ params: { state: { type: 'string', referenceType: 'lookup', lookupType: 'Status', defaultValue: '7' } } });
  spec.steps[0].filters = [{ path: 'Location', op: 'equals', valueExpression: '999' }];
  const initial = await prepareRawTransfer(fixture, spec, 'LookupDefaultValue');
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json.checks.executionReady, false);
  for (const code of ['template_transfer_card_unavailable', 'template_transfer_lookup_unavailable']) assert.ok(initial.json.checks.issues.some((issue) => issue.code === code), initial.body);
  const prepared = await prepareRawTransfer(fixture, spec, 'LookupDefaultFixed', [
    { path: '$.spec.params.state.defaultValue', value: '8' }, { path: '$.spec.steps[0].filters[0].valueExpression', value: '902' }
  ]);
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json.checks.executionReady, true, prepared.body);
  assert.equal(prepared.json.template.spec.params.state.defaultValue, '8');
  assert.equal(prepared.json.template.spec.steps[0].filters[0].valueExpression, '902');
  assertTransferReadOnly(fixture.mock);
});

test('template transfer checks each values and valuesParam index using runtime precedence; overrides change only that index', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog({
    attributesByClass: { ARM: [
      { name: 'Location', type: 'reference', targetClass: 'Location', active: true, _can_read: true },
      { name: 'Status', type: 'lookup', lookupType: 'Status', active: true, _can_read: true }
    ] },
    lookupValuesByType: { Status: [{ _id: 8, code: 'active', active: true }, { _id: 9, code: 'next', active: true }] }
  }));
  const spec = transferRawSpec({
    defaults: { statuses: [8, 777] },
    paramDefaults: { statuses: [778, 779] },
    params: { statuses: { type: 'string', default: [780, 781] }, winner: { type: 'string', default: 903 } }
  });
  spec.steps[0].filters = [
    { attribute: 'Location', op: 'in', values: [901, 998] },
    { attribute: 'Status', op: 'in', valuesParam: 'statuses', value: 980, values: [981] },
    { attribute: 'Location', op: 'in', valueParam: 'winner', valuesParam: 'ignored', values: [982] }
  ];
  const prepared = await prepareRawTransfer(fixture, spec, 'ListReferences');
  assert.equal(prepared.json.checks.executionReady, false, prepared.body);
  const refs = prepared.json.checks.environmentReferences;
  assert.ok(refs.some((ref) => ref.path === '$.spec.defaults.statuses[0]' && ref.effective && ref.requiresConfirmation));
  assert.ok(refs.some((ref) => ref.path === '$.spec.paramDefaults.statuses[1]' && !ref.effective && ref.shadowedBy === '$.spec.defaults.statuses'));
  assert.ok(refs.some((ref) => ref.path === '$.spec.steps[0].filters[0].values[0]' && ref.value === 901 && ref.requiresConfirmation));
  for (const [path, code] of [
    ['$.spec.steps[0].filters[0].values[1]', 'template_transfer_card_unavailable'],
    ['$.spec.defaults.statuses[1]', 'template_transfer_lookup_unavailable']
  ]) assert.ok(prepared.json.checks.issues.some((item) => item.path === path && item.code === code), prepared.body);
  const fixed = await prepareRawTransfer(fixture, spec, 'ListReferencesFixed', [
    { path: '$.spec.steps[0].filters[0].values[1]', value: 902 },
    { path: '$.spec.defaults.statuses[1]', value: 9 }
  ]);
  assert.equal(fixed.json.checks.executionReady, true, fixed.body);
  assert.deepEqual(fixed.json.template.spec.steps[0].filters[0].values, [901, 902]);
  assert.deepEqual(fixed.json.template.spec.defaults.statuses, [8, 9]);
  assert.deepEqual(fixed.json.template.spec.paramDefaults.statuses, [778, 779]);
  const requests = fixture.mock.requests.map((req) => req.pathname);
  for (const path of ['/classes/Location/cards/901', '/classes/Location/cards/902', '/classes/Location/cards/903',
    '/lookup_types/Status/values/8', '/lookup_types/Status/values/9']) assert.ok(requests.some((req) => req.endsWith(path)), path);
  assert.ok(!requests.some((req) => /\/(778|779|780|781|980|981|982)$/.test(req)));
  assertTransferReadOnly(fixture.mock);
});

test('template transfer raw DSL resolves reference and domain paths and rejects missing terminal fields', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog({ domains: [{ name: 'AssetLocation', source: 'ARM', sources: ['ARM'], destination: 'Location', destinations: ['Location'], cardinality: 'N:1' }] }));
  for (const [index, path] of ['Location.Code', '{AssetLocation:Location}.Code', 'Location.NoSuchField', '{AssetLocation:Location}.NoSuchField'].entries()) {
    const spec = transferRawSpec();
    spec.steps[0].filters = [{ path, op: 'equals', valueExpression: 'site' }];
    const prepared = await prepareRawTransfer(fixture, spec, `RawPath${index}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.executionReady, index < 2, prepared.body);
    assert.equal(prepared.json.checks.status, index < 2 ? 'ready' : 'needsAttention', prepared.body);
    if (index >= 2) assert.ok(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_field_unavailable' && issue.path.startsWith('$.spec.steps[0]')), prepared.body);
  }
  assert.equal(fixture.mock.requests.some((request) => /\/classes\/(ARM|Location)\/cards/.test(request.pathname)), false, 'schema path validation never runs card queries');
  assertTransferReadOnly(fixture.mock);
});

test('template transfer raw DSL tracks projections and join right-side provenance', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog());
  for (const missing of [false, true]) {
    const spec = transferRawSpec({ steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM', columns: [{ path: 'Location.Code', as: 'site' }], filters: [], limit: 100 },
      { type: 'selectCards', as: 'routers', className: 'routerG', columns: [{ path: 'Location.Code', as: 'site' }], filters: [], limit: 100 },
      { type: 'joinRows', as: 'joined', from: 'assets', with: 'routers', on: [{ left: 'site', right: missing ? 'NoSuchField' : 'site' }], includeRightKeys: true, rightPrefix: 'R_' },
      { type: 'composeRows', as: 'projected', from: 'joined', columns: [{ name: 'locationCode', column: 'R_site' }] },
      { type: 'filterRows', as: 'filtered', from: 'projected', filters: [{ column: 'locationCode', op: 'equals', value: 'site' }] }
    ], result: { tables: [{ name: 'filtered', columns: ['locationCode'] }] } });
    const prepared = await prepareRawTransfer(fixture, spec, `RawJoin${missing}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.executionReady, !missing, prepared.body);
    if (missing) assert.ok(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_field_unavailable' && issue.message.includes('routerG.NoSuchField')), prepared.body);
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer raw DSL uses effective dynamic class parameters and fails closed for unverified classes', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog());
  for (const resolved of [false, true]) {
    const spec = transferRawSpec({ params: { target: { type: 'string', required: true } } });
    delete spec.steps[0].className;
    spec.steps[0].classNameParam = 'target';
    if (resolved) spec.paramDefaults = { target: 'ARM' };
    const prepared = await prepareRawTransfer(fixture, spec, `DynamicClass${resolved}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.executionReady, resolved, prepared.body);
    if (!resolved) {
      assert.equal(prepared.json.checks.status, 'needsAttention');
      assert.ok(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_dependency_unverified' && issue.severity === 'error'), prepared.body);
    }
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer raw managed DSL validates relation metadata, exists-related comparison sides and D2 enrich projections', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog({
    attributesByClass: { routerG: [{ name: 'ComparisonCode', type: 'string', active: true, _can_read: true }] },
    domains: [{ name: 'AssetLocation', source: 'ARM', sources: ['ARM'], destination: 'Location', destinations: ['Location'], cardinality: 'N:1' }]
  }));
  for (const missing of [false, true]) {
    const spec = transferRawSpec({ steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM', columns: ['Code'], filters: [], purpose: 'objectGroup' },
      { type: 'selectCards', as: 'comparison', className: 'routerG', columns: ['ComparisonCode'], filters: [], purpose: 'objectGroup' },
      { type: 'existsRelatedRows', as: 'scoped', from: 'assets', with: 'comparison', domain: 'AssetLocation', targetClass: 'Location', direction: 'source',
        rules: [{ left: { column: 'ComparisonCode' }, right: { column: missing ? 'NoSuchField' : 'Code' }, operator: 'equals' }], purpose: 'objectMatching' },
      { type: 'expandRelations', as: 'related', from: 'scoped', domain: 'AssetLocation', targetClass: 'Location', direction: 'source', columns: ['Code'], purpose: 'objectMatching' },
      { type: 'matchRows', as: 'matched', from: 'related', with: 'comparison', rightPrefix: 'Endpoint_', rules: [{ leftColumn: 'RelatedId', rightColumn: '_id' }], purpose: 'objectMatching' },
      { type: 'enrichRows', as: 'd2_condition', from: 'matched', classColumn: 'Class', idColumn: '_id', columns: [{ path: '_id', as: '__d2_condition_parent' }], managedBy: 'd2ImportV3', purpose: 'd2PlacementFilter' }
    ], result: { tables: [{ name: 'd2_condition', columns: ['SourceDescription', 'RelatedId', 'Endpoint_ComparisonCode', '__d2_condition_parent'] }] } });
    const prepared = await prepareRawTransfer(fixture, spec, `ManagedRaw${missing}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.executionReady, !missing, prepared.body);
    if (!missing) assert.deepEqual(prepared.json.checks.issues, [], prepared.body);
    else assert.ok(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_field_unavailable' && issue.message.includes('Location.NoSuchField')), prepared.body);
  }
  assertTransferReadOnly(fixture.mock);
});

test('template transfer catalog limits cannot turn partially checked raw dependencies ready', async (t) => {
  for (const executionLimits of [{ maxRestCallsDefault: 1 }, { maxClassesDefault: 1 }, { maxTraversalDepthMax: 1 }]) {
    const fixture = await transferApiFixture(t, transferReferenceCatalog({
      attributesByClass: { Location: [{ name: 'Parent', type: 'reference', targetClass: 'Location', active: true, _can_read: true }] },
      configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true, RuntimeConfigJson: JSON.stringify({ executionLimits }) }]
    }));
    const spec = transferRawSpec();
    spec.steps[0].columns = ['Location.Parent.Parent.Code'];
    const prepared = await prepareRawTransfer(fixture, spec, `Budget${Object.keys(executionLimits)[0]}`);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.executionReady, false, prepared.body);
    assert.equal(prepared.json.checks.status, 'needsAttention');
    assert.ok(prepared.json.checks.issues.some((issue) => issue.code === 'template_transfer_catalog_limit' && issue.severity === 'error'), prepared.body);
    assert.ok(prepared.json.checks.summary.restCalls <= prepared.json.checks.summary.limits.maxRestCallsDefault);
    assertTransferReadOnly(fixture.mock);
  }
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
  const classFixtures = (Array.isArray(options.classes) ? options.classes : [
    { _id: 1, name: 'routerG', description: 'Маршрутизатор', active: true },
    { _id: 2, name: 'ARM', description: 'АРМ', active: true },
    { _id: 3, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
    { _id: 4, name: 'Cst_QueryTemplate', description: 'Template', active: true }
  ]).map((item) => ({ ...item }));
  const attributesByClass = Object.fromEntries(Object.entries(options.attributesByClass || {}).map(([className, attributes]) => [
    className,
    Array.isArray(attributes) ? attributes.map((attribute) => ({ ...attribute })) : []
  ]));
  const domains = Array.isArray(options.domains) ? options.domains : [];
  const domainDetails = options.domainDetails && typeof options.domainDetails === 'object' ? options.domainDetails : {};
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

    const responseOverride = options.responseOverride && await options.responseOverride(requestUrl, req);
    if (responseOverride) {
      sendJson(res, responseOverride.statusCode, responseOverride.body);
      return;
    }

    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/sessions/current') {
      const status = Number(options.sessionStatus || 200);
      sendJson(res, status, status === 200 ? {
        data: {
          username: 'preview-user',
          role: 'Admin',
          rolePrivileges: options.rolePrivileges === undefined ? { admin_classes_modify: true } : options.rolePrivileges
        }
      } : { message: 'session rejected' });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplate') {
      sendJson(res, 200, {
        data: {
          name: 'Cst_QueryTemplate',
          _can_read: true,
          _can_create: options.templateClassCanCreate !== false,
          _can_update: options.templateClassCanUpdate !== false,
          _can_delete: options.templateClassCanDelete !== false
        }
      });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes') {
      sendJson(res, 200, {
        data: paginate(requestUrl, classFixtures),
        meta: { total: classFixtures.length }
      });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/' && req.method === 'POST') {
      const payload = await readRequestJson(req);
      const failure = typeof options.schemaMutationFailure === 'function'
        ? options.schemaMutationFailure({ type: 'class', name: payload.name, payload })
        : null;
      if (failure) {
        sendJson(res, Number(failure.statusCode || 500), { message: failure.message || 'schema class create failed' });
        return;
      }
      const created = { _id: classFixtures.length + 100, active: true, ...payload };
      classFixtures.push(created);
      sendJson(res, 200, { data: created });
      return;
    }
    const classDetailMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)$/);
    if (classDetailMatch) {
      const className = decodeURIComponent(classDetailMatch[1]);
      const classDefinition = classFixtures.find((item) => String(item && item.name || '') === className);
      if (classDefinition) sendJson(res, 200, { data: classDefinition });
      else sendJson(res, 404, { message: `Class not found: ${className}` });
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/[^/]+\/attributes$/)) {
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
    const attributeDetailMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)\/attributes\/([^/]+)$/);
    if (attributeDetailMatch) {
      const className = decodeURIComponent(attributeDetailMatch[1]);
      const attributeName = decodeURIComponent(attributeDetailMatch[2]);
      const attribute = (attributesByClass[className] || []).find((item) => String(item && item.name || '') === attributeName);
      if (attribute) sendJson(res, 200, { data: attribute });
      else sendJson(res, 404, { message: `Attribute not found: ${className}.${attributeName}` });
      return;
    }
    const attributeCreateMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([^/]+)\/attributes$/);
    if (attributeCreateMatch && req.method === 'POST') {
      const className = decodeURIComponent(attributeCreateMatch[1]);
      const payload = await readRequestJson(req);
      const failure = typeof options.schemaMutationFailure === 'function'
        ? options.schemaMutationFailure({ type: 'attribute', className, name: payload.name, payload })
        : null;
      if (failure) {
        sendJson(res, Number(failure.statusCode || 500), { message: failure.message || 'schema attribute create failed' });
        return;
      }
      attributesByClass[className] = attributesByClass[className] || [];
      const created = { active: true, ...payload };
      attributesByClass[className].push(created);
      sendJson(res, 200, { data: created });
      return;
    }
    if (requestUrl.pathname === '/cmdbuild/services/rest/v3/domains') {
      sendJson(res, 200, { data: domains });
      return;
    }
    const domainMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/domains\/([^/]+)$/);
    if (domainMatch) {
      const name = decodeURIComponent(domainMatch[1]);
      const domain = domainDetails[name] || domains.find((item) => item && item.name === name);
      if (domain) sendJson(res, 200, { data: domain });
      else sendJson(res, 404, { message: `Domain not found: ${name}` });
      return;
    }
    const lookupValueMatch = requestUrl.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/lookup_types\/([^/]+)\/values\/([^/]+)$/);
    if (lookupValueMatch && req.method === 'GET') {
      const lookupType = decodeURIComponent(lookupValueMatch[1]);
      const lookupId = decodeURIComponent(lookupValueMatch[2]);
      const value = (options.lookupValuesByType?.[lookupType] || []).find((item) => String(item._id) === lookupId);
      if (value) sendJson(res, 200, { data: value });
      else sendJson(res, 404, { message: `Lookup value not found: ${lookupType}/${lookupId}` });
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
      if (req.method === 'POST' && options.persistNewTemplates) {
        const card = { ...await readRequestJson(req), _id: templateCards.length + 1 };
        templateCards.push(card);
        sendJson(res, 200, { data: card });
        return;
      }
      let rows = templateCards;
      if (options.templateCodeFilter && requestUrl.searchParams.has('filter')) {
        const filter = JSON.parse(requestUrl.searchParams.get('filter'));
        const simple = filter.attribute?.simple;
        if (simple?.attribute !== 'Code' || simple.operator !== 'equal' || !Array.isArray(simple.value)) {
          sendJson(res, 400, { message: 'Unsupported mock template filter.' });
          return;
        }
        rows = rows.filter((card) => simple.value.includes(card.Code));
      }
      sendJson(res, 200, { data: paginate(requestUrl, rows), meta: { total: rows.length } });
      return;
    }
    if (Array.isArray(options.versionCards) && requestUrl.pathname === '/cmdbuild/services/rest/v3/classes/Cst_QueryTemplateVersion/cards') {
      if (req.method === 'GET') {
        sendJson(res, 200, { data: paginate(requestUrl, options.versionCards), meta: { total: options.versionCards.length } });
      } else if (req.method === 'POST') {
        const payload = await readRequestJson(req);
        const created = { ...payload, _id: `mock-version-${options.versionCards.length + 1}` };
        options.versionCards.push(created);
        sendJson(res, 200, { data: created });
      } else sendJson(res, 405, { message: 'Unsupported mock version method.' });
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
        options.templatePutPatches?.push(patch);
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
  let streamBytesWritten = 0;
  let streamBytesPlanned = 0;
  let streamClosedEarly = false;
  const requestLog = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      sendJson(res, 404, { message: 'Unknown LiteLLM route.' });
      return;
    }
    requests += 1;
    lastRequest = await readRequestJson(req);
    requestLog.push(lastRequest);
    const delayMs = Array.isArray(proposal.delays)
      ? Number(proposal.delays[Math.min(requests - 1, proposal.delays.length - 1)])
      : Number(proposal.delayMs);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (proposal.streamResponse) {
      const prefix = '{"choices":[{"message":{"content":"';
      const suffix = '"}}]}';
      const contentBytes = Math.max(1, Number(proposal.streamResponse.contentBytes) || 1);
      const chunkBytes = Math.max(1, Number(proposal.streamResponse.chunkBytes) || 1024);
      const streamDelayMs = Math.max(0, Number(proposal.streamResponse.delayMs) || 0);
      streamBytesPlanned = Buffer.byteLength(prefix) + contentBytes + Buffer.byteLength(suffix);
      res.once('close', () => {
        if (streamBytesWritten < streamBytesPlanned) streamClosedEarly = true;
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      const writeChunk = async (chunk) => {
        if (res.destroyed || res.writableEnded) {
          streamClosedEarly = true;
          return false;
        }
        streamBytesWritten += Buffer.byteLength(chunk);
        res.write(chunk);
        if (streamDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
        return true;
      };
      if (!await writeChunk(prefix)) return;
      let remaining = contentBytes;
      while (remaining > 0) {
        const size = Math.min(chunkBytes, remaining);
        if (!await writeChunk('x'.repeat(size))) return;
        remaining -= size;
      }
      if (!await writeChunk(suffix)) return;
      res.end();
      return;
    }
    const configuredResponse = Array.isArray(proposal.responses)
      ? proposal.responses[Math.min(requests - 1, proposal.responses.length - 1)]
      : { flow: proposal.flow, explanation: 'Validated test proposal.', warnings: [] };
    const response = typeof configuredResponse === 'function'
      ? await configuredResponse({ request: lastRequest, requests })
      : configuredResponse;
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
    get lastRequest() { return lastRequest; },
    get requestLog() { return requestLog.slice(); },
    get streamBytesWritten() { return streamBytesWritten; },
    get streamBytesPlanned() { return streamBytesPlanned; },
    get streamClosedEarly() { return streamClosedEarly; }
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
        columns: ['Code', 'Description', 'Location']
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

test('filtered selections scan beyond the result row limit and report an explicit scan warning when capped', async (t) => {
  const cards = Array.from({ length: 2101 }, (_, index) => ({
    _id: index + 1,
    Code: index === 2100 ? 'MATCH-AFTER-2000' : `ITEM-${String(index + 1).padStart(4, '0')}`,
    Description: `Item ${index + 1}`
  }));
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'TestItem', description: 'Test item', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { TestItem: [{ name: 'Code', type: 'string', active: true, _can_read: true }] },
    cardsByClass: { TestItem: cards },
    configCards: [{
      _id: 1,
      Code: 'Cst_QueryTool',
      RootCode: 'Cst_QueryTool',
      Active: true,
      RuntimeConfigJson: JSON.stringify({ executionLimits: { maxRowsMax: 2000, maxSelectionScanRowsDefault: 3000, maxSelectionScanRowsMax: 3000 } })
    }]
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = 'CMDBuild-Authorization=selection-scan-token';
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const spec = {
    version: 1,
    params: {},
    steps: [{
      type: 'selectCards', as: 'items', className: 'TestItem', limit: 10, columns: ['Code'],
      filters: [{ path: 'Code', op: 'equals', value: 'MATCH-AFTER-2000' }]
    }],
    result: { tables: [{ name: 'items', title: 'Items', columns: ['Code'] }] }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=10&maxClasses=20&maxRestCalls=20`, {
    template: { code: 'SelectionScanPreview', spec }, params: {}
  }, headers);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json.result.tables[0].rows.map((row) => row.Code), ['MATCH-AFTER-2000']);
  assert.equal(preview.json.result.trace[0].selectionScan, null);
  const selection = preview.json.result.trace[0];
  assert.equal(selection.scannedCards, cards.length);
  assert.ok(selection.restCalls > 0);
  assert.ok(preview.json.result.limits.restCalls >= selection.restCalls);

  const cappedPreview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=10&maxClasses=20&maxRestCalls=20`, {
    template: { code: 'SelectionScanCappedPreview', spec: { ...spec, steps: [{ ...spec.steps[0], scanLimit: 2000 }] } }, params: {}
  }, headers);
  assert.equal(cappedPreview.statusCode, 200, cappedPreview.body);
  assert.deepEqual(cappedPreview.json.result.tables[0].rows, []);
  assert.equal(cappedPreview.json.result.trace[0].selectionScan.scanLimit, 2000);
  assert.equal(cappedPreview.json.result.trace[0].scannedCards, 2000);
  assert.match(cappedPreview.json.result.warnings[0], /Results may be incomplete/i);
  assert.equal(backend.exitCode, null);
});

test('filtered selections report both row and scan limits when both bounds are reached', async (t) => {
  const cards = Array.from({ length: 3000 }, (_, index) => ({
    _id: index + 1,
    Code: `ITEM-${String(index + 1).padStart(4, '0')}`,
    Description: `Item ${index + 1}`
  }));
  const mock = await startMockCmdbuild(t, {
    classes: [
      { _id: 1, name: 'TestItem', description: 'Test item', parent: 'Class', active: true },
      { _id: 2, name: 'Cst_QueryToolConfig', description: 'Config', active: true },
      { _id: 3, name: 'Cst_QueryTemplate', description: 'Template', active: true }
    ],
    attributesByClass: { TestItem: [{ name: 'Code', type: 'string', active: true, _can_read: true }] },
    cardsByClass: { TestItem: cards }
  });
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('selection-scan-and-row-limit');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const spec = {
    version: 1,
    params: {},
    steps: [{
      type: 'selectCards', as: 'items', className: 'TestItem', limit: 10, scanLimit: 2000, columns: ['Code'],
      filters: [{ path: 'Code', op: 'matches', regex: '^ITEM-' }]
    }],
    result: { tables: [{ name: 'items', title: 'Items', columns: ['Code'] }] }
  };
  const preview = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/draft/preview?maxRows=10&maxClasses=20&maxRestCalls=20`, {
    template: { code: 'SelectionScanAndRowLimitPreview', spec }, params: {}
  }, headers);

  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json.result.tables[0].rows.length, 10);
  assert.equal(preview.json.result.trace[0].rowLimitReached, true);
  assert.equal(preview.json.result.trace[0].selectionScan.scanLimit, 2000);
  assert.deepEqual(preview.json.result.limitDiagnostics.map((item) => item.limitName), ['maxRows', 'maxSelectionScanRows']);
  assert.equal(preview.json.result.warnings.length, 2);
  assert.ok(preview.json.result.warnings.every((warning) => /Results may be incomplete/i.test(warning)));
  assert.equal(backend.exitCode, null);
});

async function bootstrapSchemaRequest(t, mockOptions = {}, body = { root: 'Acme_QueryTool', parent: 'Class' }) {
  const mock = await startMockCmdbuild(t, mockOptions);
  const backendPort = await freePort();
  const backend = await startBackend(t, backendPort, mock.origin);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const cookie = testCmdbuildAuthorizationCookie('schema-bootstrap');
  const csrf = await requestJson('GET', `${backendOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  const headers = { cookie, origin: backendOrigin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const response = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/schema/bootstrap`, body, headers);
  return { mock, backend, backendOrigin, cookie, headers, response };
}

test('schema bootstrap creates only missing technical classes and is idempotent', async (t) => {
  const initialClasses = [];
  const { mock, backendOrigin, headers, response, backend } = await bootstrapSchemaRequest(t, { classes: initialClasses });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.success, true);
  const firstMutationCount = mock.requests.filter((request) => request.method === 'POST' && /\/classes\/?(?:$|\/)/.test(request.pathname)).length;
  assert.ok(firstMutationCount > 0);

  const repeat = await requestJson('POST', `${backendOrigin}/cmdbuild/custom-api/schema/bootstrap`, { root: 'Acme_QueryTool', parent: 'Class' }, headers);
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json.success, true);
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && /\/classes\/?(?:$|\/)/.test(request.pathname)).length, firstMutationCount);
  assert.equal(backend.exitCode, null);
});

test('schema bootstrap rejects missing admin privilege before CMDBuild schema mutations', async (t) => {
  const { mock, response, backend } = await bootstrapSchemaRequest(t, { classes: [], rolePrivileges: {} });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(mock.requests.some((request) => request.method === 'POST' && request.pathname.includes('/classes')), false);
  assert.equal(backend.exitCode, null);
});

test('schema bootstrap returns conflict without attempting mutations', async (t) => {
  const { mock, response, backend } = await bootstrapSchemaRequest(t, {
    classes: [{ _id: 1, name: 'Acme_QueryTool', description: 'Acme', parent: 'WrongParent', prototype: true, active: true }]
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json.schema.status, 'conflict');
  assert.equal(response.json.schema.rootCause.kind, 'conflict');
  assert.equal(response.json.schema.conflicts.length, 1);
  assert.equal(mock.requests.some((request) => request.method === 'POST' && request.pathname.includes('/classes')), false);
  assert.equal(backend.exitCode, null);
});

test('schema bootstrap reports CMDBuild mutation failure and stops subsequent writes', async (t) => {
  const { mock, response, backend } = await bootstrapSchemaRequest(t, {
    classes: [],
    schemaMutationFailure: ({ type }) => type === 'class' ? { statusCode: 500, message: 'class create unavailable' } : null
  });
  assert.equal(response.statusCode, 502, response.body);
  assert.equal(response.json.success, false);
  assert.equal(response.json.schema.rootCause.kind, 'operation_failed');
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.pathname === '/cmdbuild/services/rest/v3/classes/').length, 1);
  assert.equal(backend.exitCode, null);
});

test('schema bootstrap rejects invalid local input before CMDBuild schema mutations', async (t) => {
  const { mock, response, backend } = await bootstrapSchemaRequest(t, { classes: [] }, { root: 'bad-root' });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json.reason, 'technical_schema_bootstrap_invalid_input');
  assert.equal(response.json.rootCause.kind, 'invalid_input');
  assert.equal(mock.requests.some((request) => request.method === 'POST' && request.pathname.includes('/classes')), false);
  assert.equal(backend.exitCode, null);
});

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
  Object.defineProperty(child, 'testOutput', { get: () => output });
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

function requestPublishBaseline(url, params, headers) {
  const baselineUrl = new URL(url);
  const pairs = Object.entries(params ?? {});
  if (pairs.length) baselineUrl.searchParams.set('snapshotParams', JSON.stringify(pairs));
  return requestJson('GET', baselineUrl.href, undefined, headers);
}

async function publishWithBaseline(url, body, headers, timeoutMs) {
  const baseline = await requestPublishBaseline(url, body.params, headers);
  assert.equal(baseline.statusCode, 200, baseline.body);
  assert.equal(baseline.json.success, true);
  assert.equal(baseline.json.action, 'publish');
  assert.match(baseline.json.savedSpecHash, /^[a-f0-9]{64}$/);
  if (baseline.json.snapshotRevision !== null) assert.match(baseline.json.snapshotRevision, /^[a-f0-9]{64}$/);
  assert.match(baseline.json.publishBaseline, /^[a-f0-9]{64}$/);
  const response = await requestJson('POST', url, { ...body, publishBaseline: baseline.json.publishBaseline }, headers, timeoutMs);
  if (response.statusCode === 200) {
    assert.match(response.json.cache.snapshotRevision, /^[a-f0-9]{64}$/);
    assert.notEqual(response.json.cache.snapshotRevision, baseline.json.snapshotRevision);
  }
  return response;
}

async function requestJson(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const result = await request(method, url, currentAssistantRequestBody(url, body), extraHeaders, timeoutMs);
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

function currentAssistantRequestBody(url, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    !/\/cmdbuild\/custom-api\/assistant\/(?:object-flow\/(?:semantic-plan|plan)|diagram-import\/(?:interpret|map-selections))$/.test(new URL(url).pathname)) {
    return body;
  }
  const currentSpec = body.currentSpec && typeof body.currentSpec === 'object' && !Array.isArray(body.currentSpec)
    ? body.currentSpec
    : {};
  const editorSpec = {};
  for (const key of ['version', 'params', 'steps', 'visualModel', 'visualModels', 'authoring']) {
    if (Object.prototype.hasOwnProperty.call(currentSpec, key)) editorSpec[key] = structuredClone(currentSpec[key]);
  }
  if (currentSpec.result && typeof currentSpec.result === 'object' && !Array.isArray(currentSpec.result)) {
    editorSpec.result = {};
    if (Object.prototype.hasOwnProperty.call(currentSpec.result, 'tables')) editorSpec.result.tables = structuredClone(currentSpec.result.tables);
    if (Object.prototype.hasOwnProperty.call(currentSpec.result, 'emptyText')) editorSpec.result.emptyText = String(currentSpec.result.emptyText || '');
    if (Object.prototype.hasOwnProperty.call(currentSpec.result, 'permissionDeniedText')) editorSpec.result.permissionDeniedText = String(currentSpec.result.permissionDeniedText || '');
  }
  const next = { ...body };
  next.templateRef = next.templateRef || {
    root: String(body.root || 'Cst_QueryTool'),
    templateCode: String(body.templateCode || ''),
    baseSpecHash: String(body.baseSpecHash || '')
  };
  next.editorDelta = next.editorDelta || { version: 1, spec: editorSpec };
  delete next.root;
  delete next.templateCode;
  delete next.baseSpecHash;
  delete next.currentSpec;
  delete next.semanticsPrompt;
  delete next.placementPrompt;
  delete next.connectionsPrompt;
  return next;
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

async function edgeAggregationApiFixture(t, aggregation = { enabled: true, groupBy: ['Category'], format: 'compact', duplicates: 'distinct', maxLabelChars: 2000 }) {
  const code = 'EdgeAggregation';
  const columns = ['Source', 'Target', 'Category', 'Value'];
  const cards = Array.from({ length: 100 }, (_, index) => ({
    _id: index + 1, Code: `connection-${index + 1}`, Source: 'a', Target: 'b',
    Category: index % 2 ? 'B' : 'A', Value: index + 1, PrivatePayload: 'not-selected'
  }));
  const currentSpec = apiObjectFlowSpec([
    { alias: 'sources', className: 'SourceObject', columns: ['Code', 'Description'] },
    { alias: 'targets', className: 'TargetObject', columns: ['Code', 'Description'] },
    { alias: 'links', className: 'Connection', columns }
  ]);
  const mock = await startMockCmdbuild(t, {
    templates: [templateCard(code, currentSpec)],
    classes: ['SourceObject', 'TargetObject', 'Connection', 'Cst_QueryToolConfig', 'Cst_QueryTemplate'].map((name, index) => ({ _id: index + 1, name, active: true })),
    attributesByClass: { Connection: columns.map((name) => ({ name, type: name === 'Value' ? 'integer' : 'string', active: true, _can_read: true })) },
    cardsByClass: {
      SourceObject: [{ _id: 'a', Code: 'a', Description: 'Source object' }],
      TargetObject: [{ _id: 'b', Code: 'b', Description: 'Target object' }], Connection: cards
    }
  });
  const port = await freePort();
  const backend = await startBackend(t, port, mock.origin, { CMDP_D2_BINARY: `${process.cwd()}/tests/fixtures/d2-render-stub.mjs` });
  const origin = `http://127.0.0.1:${port}`;
  const cookie = testCmdbuildAuthorizationCookie('edge-aggregation-api');
  const csrf = await requestJson('GET', `${origin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const headers = { cookie, origin, 'x-cmdbdynamicpages-csrf': csrf.json.token };
  const d2Source = 'router: Router\nswitch: Switch\nrouter -> switch: Connection';
  const analyzed = await requestJson('POST', `${origin}/cmdbuild/custom-api/draft/diagram-import/analyze`, {
    templateCode: code, baseSpecHash: hashJson(currentSpec), currentSpec, d2Source
  }, headers);
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const proposal = analyzed.json.proposal;
  const roles = proposal.roles.map((role) => d2RoleOverride(role, {
    materialization: { kind: 'stage', stageId: role.key === 'router' ? 'selection:sources' : 'selection:targets' },
    primary: { className: role.key === 'router' ? 'SourceObject' : 'TargetObject', idAttribute: '_id', labelTemplate: '${Description}', structuredFields: [], filters: [] },
    related: []
  }));
  const applyBody = {
    templateCode: code, baseSpecHash: hashJson(currentSpec),
    currentSpec: { ...currentSpec, authoring: { version: 1, d2: { source: d2Source } } },
    d2Source, proposal, roles, structureTree: d2StructureTreeWithMaterialization(proposal, roles),
    relationRules: [{
      ...proposal.relationRules[0], id: 'generic-connections', kind: 'connection', mode: 'deterministicEndpoints', directionPolicy: 'dataFields',
      parentRoleId: roles.find((role) => role.mapping.primary.className === 'SourceObject').id,
      childRoleId: roles.find((role) => role.mapping.primary.className === 'TargetObject').id,
      sourceStageId: 'selection:links', sourceField: 'Source', targetField: 'Target', labelTemplate: '${Value}', aggregation
    }]
  };
  const applied = await requestJson('POST', `${origin}/cmdbuild/custom-api/draft/diagram-import/apply`, applyBody, headers);
  assert.equal(applied.statusCode, 200, applied.body);
  return { origin, headers, backend, mock, code, cards, currentSpec, applyBody, spec: applied.json.spec };
}

test('direct runtime enforces the published D2 source toggle even with a valid cookie', async (t) => {
  const { origin, headers, mock, code, currentSpec, spec } = await edgeAggregationApiFixture(t);
  const templateUrl = `${origin}/cmdbuild/custom-api/templates/${code}`;
  const directUrl = `${origin}/cmdbuild/dynamicpages/ui/run/${code}`;
  const params = { site: 42, enabled: false };
  const wire = encodeURIComponent(JSON.stringify(Object.entries(params)));
  let savedSpecHash = hashJson(currentSpec);

  for (const publicD2Source of [false, true]) {
    const saved = await requestJson('PUT', templateUrl, {
      code,
      expectedSpecHash: savedSpecHash,
      spec: { ...spec, publish: { ...publishSpec().publish, publicD2Source, refreshMode: 'shared', sharedRefreshAccepted: true } }
    }, headers);
    assert.equal(saved.statusCode, 200, saved.body);
    savedSpecHash = saved.json.template.specHash;
    const published = await publishWithBaseline(`${templateUrl}/publish`, { params, savedSpecHash }, headers);
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json.cache.status, 'snapshot-published');

    const start = mock.requests.length;
    const anonymous = await request('GET', `${directUrl}?d2=true&snapshotParams=${wire}`);
    const authenticated = await request('GET', `${directUrl}?d2=true&snapshotParams=${wire}`, undefined, { cookie: headers.cookie });
    for (const response of [anonymous, authenticated]) {
      assert.equal(response.statusCode, publicD2Source ? 200 : 403, response.body);
      if (publicD2Source) {
        assert.match(response.headers['content-type'], /^text\/vnd\.d2/);
        assert.match(response.headers['content-disposition'], /^attachment; filename="[^"]+\.d2"$/);
        assert.match(response.body, /Source object/);
      } else {
        assert.equal(response.headers['content-disposition'], undefined);
        assert.match(JSON.parse(response.body).message, /not enabled for this published snapshot/);
      }
    }
    assert.equal(authenticated.body, anonymous.body);
    const runtime = await requestJson('GET', `${directUrl}?json=true&snapshotParams=${wire}`, undefined, { cookie: headers.cookie });
    assert.equal(runtime.statusCode, 200, runtime.body);
    assert.equal(runtime.json.diagrams[0].d2.downloadAvailable, publicD2Source);
    assert.equal(runtime.json.diagrams[0].d2.source, undefined);
    assert.equal(mock.requests.length, start, 'published D2 reads make no CMDBuild requests');

    const refreshed = await requestJson('POST', `${templateUrl}/refresh-snapshot?snapshotParams=${wire}`, {
      expectedMode: 'shared', expectedSnapshotRevision: runtime.json.cache.snapshotRevision
    }, headers);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(refreshed.json.result.diagrams[0].d2.downloadAvailable, publicD2Source);
    assert.equal(refreshed.json.result.diagrams[0].d2.source, undefined);
  }

  const dynamic = await requestJson('PUT', templateUrl, { code, expectedSpecHash: savedSpecHash,
    spec: { ...spec, publish: { mode: 'dynamicUser' } } }, headers);
  assert.equal(dynamic.statusCode, 200, dynamic.body);
  const protectedD2 = await request('GET', `${directUrl}?d2=true&snapshotParams=${wire}`, undefined, { cookie: headers.cookie });
  assert.equal(protectedD2.statusCode, 200, protectedD2.body);
  assert.match(protectedD2.body, /Source object/);
  const malformed = await requestJson('GET', `${templateUrl}/run?d2=true&snapshotParams=invalid`, undefined, { cookie: headers.cookie });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(malformed.json.reason, 'snapshot_params_invalid');
});

test('edge aggregation HTTP draft preview merges 100 distinct mock records and is deterministic', async (t) => {
  const fixture = await edgeAggregationApiFixture(t);
  const { origin, headers, spec, code, cards, mock, backend, currentSpec } = fixture;
  const preview = () => requestJson('POST', `${origin}/cmdbuild/custom-api/draft/preview?maxRows=200&maxRestCalls=100`, {
    template: { code, spec }, params: {}
  }, headers);
  const first = await preview();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json.success, true);
  assert.equal(first.json.result.diagrams.length, 1);
  const diagram = first.json.result.diagrams[0];
  assert.equal(diagram.edges.length, 1);
  const aggregated = diagram.edges[0];
  assert.equal(aggregated.data.aggregation.memberCount, 100);
  assert.equal(aggregated.data.aggregation.members.length, 100);
  assert.deepEqual(Object.keys(aggregated.data), ['aggregation']);
  assert.equal(diagram.svg.rendered, true);
  const block = /<metadata id="cmdp-diagram-data" type="application\/json">([\s\S]*?)<\/metadata>/.exec(diagram.svg.content);
  assert.ok(block, 'HTTP SVG contains structured connection details');
  const metadata = JSON.parse(block[1].replace(/&(amp|lt|gt);/g, (_entity, name) => ({ amp: '&', lt: '<', gt: '>' })[name]));
  const data = metadata.objects[aggregated.d2Id];
  assert.deepEqual(aggregated.data.aggregation, data.aggregation);
  assert.equal(data.aggregation.memberCount, 100);
  assert.equal(data.aggregation.connectionCount, 100);
  assert.equal(data.aggregation.members.length, 100);
  assert.equal(new Set(data.aggregation.members.map((member) => member.id)).size, 100);
  assert.match(aggregated.label, /^A \[/);
  assert.match(aggregated.label, /\nB \[/);
  assert.equal(diagram.execution.aggregation[0].inputEdges, 100);
  assert.equal(diagram.execution.aggregation[0].outputEdges, 1);
  assert.doesNotMatch(JSON.stringify(data), /PrivatePayload|not-selected|runtimeRow/);
  assert.ok(mock.requests.some((request) => request.pathname.endsWith('/classes/Connection/cards')));
  cards.reverse();
  const second = await preview();
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json.result.diagrams[0].edges, diagram.edges);
  assert.equal(second.json.result.diagrams[0].d2.source, diagram.d2.source);
  const saved = await requestJson('PUT', `${origin}/cmdbuild/custom-api/templates/${code}`, {
    code, expectedSpecHash: hashJson(currentSpec), spec
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  const run = await requestJson('GET', `${origin}/cmdbuild/custom-api/templates/${code}/run?json=true&noCache=1`, undefined, { cookie: headers.cookie });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json.diagrams.length, 1);
  assert.equal(run.json.diagrams[0].edges.length, 1);
  assert.equal(run.json.diagrams[0].edges[0].aggregation.memberCount, 100);
  assert.equal(run.json.diagrams[0].edges[0].data, undefined);
  assert.doesNotMatch(JSON.stringify(run.json), /"members"|"sourceRef"|runtimeRow/);
  assert.equal(backend.exitCode, null);
});

test('edge aggregation normal template Save and GET preserve disabled configuration', async (t) => {
  const aggregation = { enabled: false, groupBy: ['Category'], format: 'tree', duplicates: 'preserve', maxLabelChars: 128 };
  const { origin, headers, code, spec, currentSpec, mock, backend } = await edgeAggregationApiFixture(t, aggregation);
  const saved = await requestJson('PUT', `${origin}/cmdbuild/custom-api/templates/${code}`, {
    code, expectedSpecHash: hashJson(currentSpec), spec
  }, headers);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json.template.spec.result.diagrams[0].authoring.d2Import.relationRules[0].aggregation, aggregation);
  const listed = await requestJson('GET', `${origin}/cmdbuild/custom-api/templates?root=Cst_QueryTool`, undefined, { cookie: headers.cookie });
  assert.equal(listed.statusCode, 200, listed.body);
  const reloaded = listed.json.data.find((template) => template.code === code);
  assert.ok(reloaded, listed.body);
  assert.deepEqual(reloaded.spec.result.diagrams[0].authoring.d2Import.relationRules[0].aggregation, aggregation);
  assert.deepEqual(reloaded.spec.result.diagrams[0].edgeMappings[0].aggregation, aggregation);
  assert.ok(mock.requests.some((request) => request.method === 'PUT' && request.pathname.endsWith(`/classes/Cst_QueryTemplate/cards/${code}`)));
  assert.equal(backend.exitCode, null);
});

test('edge aggregation strict Apply rejects invalid settings with 422 while table extraction stays usable', async (t) => {
  const { origin, headers, code, spec, applyBody, mock, backend } = await edgeAggregationApiFixture(t);
  const invalid = { enabled: true, groupBy: ['Category'], format: 'invalid' };
  const rules = applyBody.relationRules.map((rule) => ({ ...rule, aggregation: invalid }));
  const rejected = await requestJson('POST', `${origin}/cmdbuild/custom-api/draft/diagram-import/apply`, { ...applyBody, relationRules: rules }, headers);
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json.success, false);
  assert.ok(rejected.json.errors.some((error) => error.path.endsWith('.aggregation.format')), rejected.body);
  const draft = structuredClone(spec);
  draft.result.diagrams[0].authoring.d2Import.relationRules[0].aggregation = invalid;
  draft.result.diagrams[0].edgeMappings[0].aggregation = invalid;
  const extraction = await requestJson('POST', `${origin}/cmdbuild/custom-api/draft/preview?maxRows=200&includeDiagrams=false`, {
    template: { code, spec: draft }, params: {}
  }, headers);
  assert.equal(extraction.statusCode, 200, extraction.body);
  assert.equal(extraction.json.success, true);
  assert.deepEqual(extraction.json.result.diagrams, []);
  const table = extraction.json.result.tables.find((item) => item.name === 'links');
  assert.ok(table, extraction.body);
  assert.equal(table.rows.length, 100);
  assert.deepEqual([...new Set(table.rows.map((row) => row.Category))].sort(), ['A', 'B']);
  assert.equal(mock.requests.some((request) => request.method === 'PUT'), false);
  assert.equal(backend.exitCode, null);
});

test('runtime cache probe preserves projected cards 403 despite successful unprojected reads', async (t) => {
  const code = 'ProjectedCardsAccess';
  const cardsPath = '/cmdbuild/services/rest/v3/classes/ARM/cards';
  const restricted = 'projected-cards-restricted';
  const spec = {
    version: 1,
    cache: { scopeMode: 'permissionOnly' },
    steps: [{ type: 'selectCards', as: 'assets', className: 'ARM', columns: ['model'], limit: 1 }],
    result: { tables: [{ name: 'assets', columns: ['model'] }] }
  };
  const fixture = await transferApiFixture(t, {
    templates: [templateCard(code, spec)],
    armCards: [{ _id: 501, model: 'warm-model' }],
    responseOverride(url, req) {
      if (url.pathname !== cardsPath || req.headers['cmdbuild-authorization'] !== restricted) return;
      return url.searchParams.has('attributes')
        ? { statusCode: 403, body: { message: 'Projected read denied' } }
        : { statusCode: 200, body: { data: [{ _id: 502, model: 'unprojected-model' }] } };
    }
  });
  const { mock } = fixture;
  const unprojected = await requestJson('GET', `${mock.origin}${cardsPath}?limit=1`, undefined, { 'cmdbuild-authorization': restricted });
  assert.equal(unprojected.statusCode, 200, unprojected.body);
  assert.equal(unprojected.json.data[0].model, 'unprojected-model');

  const endpoint = `${fixture.origin}/cmdbuild/custom-api/templates/${code}/run?json=true`;
  const warm = await requestJson('GET', endpoint, undefined, { cookie: fixture.headers.cookie });
  assert.equal(warm.statusCode, 200, warm.body);
  assert.equal(warm.json.cache.status, 'miss');
  assert.deepEqual(warm.json.tables[0].rows, [{ model: 'warm-model' }]);

  const start = mock.requests.length;
  const denied = await requestJson('GET', endpoint, undefined, { cookie: testCmdbuildAuthorizationCookie(restricted) });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json.reason, 'data_access_denied');
  assert.equal(denied.json.cmdbuildStatus, 403);
  assert.equal(denied.json.permissionDenied, true);
  assert.equal(denied.json.cache, undefined);
  assert.equal(denied.json.result, undefined);
  assert.equal(denied.json.tables, undefined);
  assert.deepEqual(mock.requests.slice(start).filter(({ pathname }) => pathname === cardsPath)
    .map(({ search }) => new URLSearchParams(search).get('attributes')), ['model']);
});

test('runtime relation cache isolates users and access contexts and expires despite hits', async (t) => {
  const code = 'PrivateRelationCache';
  const relationsPath = '/cmdbuild/services/rest/v3/classes/ARM/cards/501/relations';
  const relationReads = [];
  let denyAlice = false;
  const spec = {
    version: 1,
    cache: { scopeMode: 'permissionOnly', ttlSeconds: 3 },
    steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM', limit: 1 },
      { type: 'expandRelations', as: 'related', from: 'assets', domain: 'AssetLocation', fetchRelated: false }
    ],
    result: { tables: [{ name: 'related', columns: ['Code'] }] }
  };
  const fixture = await transferApiFixture(t, {
    templates: [templateCard(code, spec)],
    armCards: [{ _id: 501, Code: 'ASSET' }],
    responseOverride(url, req) {
      const token = req.headers['cmdbuild-authorization'];
      if (url.pathname.endsWith('/sessions/current')) {
        const username = token === 'relation-auditor' || token === 'relation-alice-renewed' ? 'relation-alice' : token;
        return { statusCode: 200, body: { data: { username, role: token === 'relation-auditor' ? 'Auditor' : 'Reader' } } };
      }
      if (url.pathname !== relationsPath) return;
      relationReads.push(token);
      if (denyAlice && token === 'relation-alice-renewed') return { statusCode: 403, body: { message: 'Relations denied' } };
      return { statusCode: 200, body: { data: [{
        domain: 'AssetLocation', _sourceType: 'ARM', _sourceId: 501,
        _destinationType: 'Location', _destinationId: 9, _destinationCode: token
      }] } };
    }
  });
  const endpoint = `${fixture.origin}/cmdbuild/custom-api/templates/${code}/run?json=true`;
  const run = (token, query = '') => requestJson('GET', endpoint + query, undefined, { cookie: testCmdbuildAuthorizationCookie(token) });
  const warm = await run('relation-alice');
  assert.equal(warm.statusCode, 200, warm.body);
  assert.equal(warm.json.cache.status, 'miss');
  assert.equal(warm.json.cache.scope, 'per-user');
  assert.equal(warm.json.cache.scopeMode, 'privateUser');
  assert.equal(warm.json.cache.sharedAcrossUsers, false);
  assert.deepEqual(warm.json.tables[0].rows, [{ Code: 'relation-alice' }]);
  assert.equal(Date.parse(warm.json.cache.expiresAt) - Date.parse(warm.json.cache.generatedAt), 3000);

  for (const token of ['relation-bob', 'relation-auditor']) {
    const isolated = await run(token);
    assert.equal(isolated.statusCode, 200, isolated.body);
    assert.equal(isolated.json.cache.status, 'miss');
    assert.notEqual(isolated.json.cache.key, warm.json.cache.key);
    assert.deepEqual(isolated.json.tables[0].rows, [{ Code: token }]);
  }

  const expiresAt = Date.parse(warm.json.cache.expiresAt);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() - 1200)));
  const hit = await run('relation-alice-renewed');
  assert.equal(hit.statusCode, 200, hit.body);
  assert.equal(hit.json.cache.status, 'hit');
  assert.equal(hit.json.cache.key, warm.json.cache.key);
  assert.equal(hit.json.cache.generatedAt, warm.json.cache.generatedAt);
  assert.equal(hit.json.cache.expiresAt, warm.json.cache.expiresAt);
  assert.ok(hit.json.cache.ttlSec < warm.json.cache.ttlSec);
  assert.deepEqual(hit.json.tables[0].rows, [{ Code: 'relation-alice' }]);
  assert.deepEqual(relationReads, ['relation-alice', 'relation-bob', 'relation-auditor']);

  denyAlice = true;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
  const denied = await run('relation-alice-renewed', '&refresh=1');
  assertRuntimeRelationDenied(denied);
  assert.deepEqual(relationReads, ['relation-alice', 'relation-bob', 'relation-auditor', 'relation-alice-renewed']);
});

test('runtime relation path cache rejects eligible refresh on related card denial without stale rows', async (t) => {
  const code = 'PrivateRelationPathCache';
  const path = '{AssetLocation:Location}.Code';
  const deniedReads = [];
  const spec = {
    version: 1,
    cache: { scopeMode: 'visibilityHash', ttlSeconds: 20 },
    steps: [{ type: 'selectCards', as: 'assets', className: 'ARM', limit: 2 }],
    result: { tables: [{ name: 'assets', columns: ['Code', path] }] }
  };
  const fixture = await transferApiFixture(t, {
    templates: [templateCard(code, spec)],
    configCards: [{ _id: 1, Code: 'Cst_QueryTool', RootCode: 'Cst_QueryTool', Active: true,
      RuntimeConfigJson: JSON.stringify({ runtimeCache: { refreshCooldownSec: 1 } }) }],
    armCards: [{ _id: 501, Code: 'ASSET-1' }, { _id: 502, Code: 'ASSET-2' }],
    relationsByCard: Object.fromEntries([501, 502].map((id) => [`ARM:${id}`, [{
      domain: 'AssetLocation', _sourceType: 'ARM', _sourceId: id,
      _destinationType: 'Location', _destinationId: id, _destinationCode: 'Fallback'
    }]])),
    cardsByClass: { Location: [{ _id: 501, Code: 'East' }, { _id: 502, Code: 'West' }] },
    responseOverride(url, req) {
      const token = req.headers['cmdbuild-authorization'];
      if (token !== 'relation-refresh' || !url.pathname.endsWith('/classes/Location/cards/502')) return;
      deniedReads.push(token);
      return { statusCode: 403, body: { message: 'Related card denied' } };
    }
  });
  const endpoint = `${fixture.origin}/cmdbuild/custom-api/templates/${code}/run?json=true`;
  const warm = await requestJson('GET', endpoint, undefined, { cookie: fixture.headers.cookie });
  assert.equal(warm.statusCode, 200, warm.body);
  assert.equal(warm.json.cache.scopeMode, 'privateUser');
  assert.equal(warm.json.cache.refreshCooldownSec, 1);
  assert.deepEqual(warm.json.tables[0].rows, [{ Code: 'ASSET-1', [path]: 'East' }, { Code: 'ASSET-2', [path]: 'West' }]);

  const refreshHeaders = { cookie: testCmdbuildAuthorizationCookie('relation-refresh') };
  const wait = Math.max(0, Date.parse(warm.json.cache.nextRefreshAllowedAt) - Date.now() + 20);
  await new Promise((resolve) => setTimeout(resolve, wait));
  const denied = await requestJson('GET', `${endpoint}&refresh=1`, undefined, refreshHeaders);
  assertRuntimeRelationDenied(denied);
  const deniedAgain = await requestJson('GET', endpoint, undefined, refreshHeaders);
  assertRuntimeRelationDenied(deniedAgain);
  assert.deepEqual(deniedReads, ['relation-refresh', 'relation-refresh']);
});

test('runtime relation traversal rejects denied domain details instead of using list data', async (t) => {
  const code = 'PrivateDomainTraversal';
  const spec = {
    version: 1,
    steps: [
      { type: 'selectCards', as: 'assets', className: 'ARM', limit: 1 },
      { type: 'traverseDomains', as: 'related', from: 'assets', depth: 1 }
    ],
    result: { tables: [{ name: 'related', columns: ['RelatedClass'] }] }
  };
  const fixture = await transferApiFixture(t, {
    templates: [templateCard(code, spec)],
    armCards: [{ _id: 501, Code: 'ASSET' }],
    domains: [{ name: 'AssetLocation', source: 'ARM', destination: 'Location' }],
    responseOverride(url, req) {
      const token = req.headers['cmdbuild-authorization'];
      if (url.pathname.endsWith('/sessions/current')) {
        return { statusCode: 200, body: { data: { username: token, role: 'Reader' } } };
      }
      if (token !== 'relation-domain-restricted' || !url.pathname.endsWith('/domains/AssetLocation')) return;
      return { statusCode: 403, body: { message: 'Domain detail denied' } };
    }
  });
  const endpoint = `${fixture.origin}/cmdbuild/custom-api/templates/${code}/run?json=true`;
  const warm = await requestJson('GET', endpoint, undefined, { cookie: fixture.headers.cookie });
  assert.equal(warm.statusCode, 200, warm.body);
  assert.equal(warm.json.cache.scopeMode, 'privateUser');
  assert.deepEqual(warm.json.tables[0].rows, [{ RelatedClass: 'Location' }]);

  const denied = await requestJson('GET', endpoint, undefined, { cookie: testCmdbuildAuthorizationCookie('relation-domain-restricted') });
  assertRuntimeRelationDenied(denied);
});

function assertRuntimeRelationDenied(response) {
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json.reason, 'data_access_denied');
  assert.equal(response.json.cmdbuildStatus, 403);
  assert.equal(response.json.permissionDenied, true);
  assert.equal(response.json.cache, undefined);
  assert.equal(response.json.result, undefined);
  assert.equal(response.json.tables, undefined);
}

test('template transfer roundtrips raw and managed text filters on card and lookup fields', async (t) => {
  const fixture = await transferApiFixture(t, transferReferenceCatalog({
    persistNewTemplates: true,
    versionCards: [],
    attributesByClass: { ARM: [
      { name: 'Location', type: 'reference', targetClass: 'Location', active: true, _can_read: true },
      { name: 'Status', type: 'lookup', lookupType: 'AssetStatus', active: true, _can_read: true }
    ] },
    armCards: [
      { _id: 501, Code: 'MATCH', Location: 901, _Location_description: 'North Campus', Status: 7, _Status_description: 'Active' },
      { _id: 502, Code: 'OTHER_SITE', Location: 902, _Location_description: 'South Office', Status: 7, _Status_description: 'Active' },
      { _id: 503, Code: 'OTHER_STATUS', Location: 901, _Location_description: 'North Campus', Status: 8, _Status_description: 'Archived' }
    ]
  }));
  const rules = [
    { path: 'Location', op: 'contains', value: 'Campus' },
    { path: 'Status', op: 'endsWith', value: 'ive' }
  ];
  const raw = transferRawSpec();
  raw.steps[0].filters = rules;
  const managed = compileObjectFlowToSpec(transferRawSpec({ steps: [] }), { version: 1, operations: [], selections: [{
    id: 'selection:assets', name: 'Assets', alias: 'assets', className: 'ARM', limit: 100, columns: ['Code'], filterJoin: 'all',
    rules: rules.map((rule) => ({ ...rule, action: 'include' }))
  }] });
  for (const [code, spec] of [['RawTextFilters', raw], ['ManagedTextFilters', managed]]) {
    const start = fixture.mock.requests.length;
    const prepared = await prepareRawTransfer(fixture, spec, code);
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json.checks.status, 'ready', prepared.body);
    assert.equal(prepared.json.checks.executionReady, true, prepared.body);
    assert.deepEqual(prepared.json.checks.environmentReferences, []);
    assert.deepEqual(prepared.json.template.spec.steps[0].filters, spec.steps[0].filters);

    const saved = await fixture.create(prepared.json.template);
    assert.equal(saved.statusCode, 201, saved.body);
    assert.deepEqual(saved.json.template.spec.steps[0].filters, spec.steps[0].filters);
    const run = await requestJson('GET', `${fixture.origin}/cmdbuild/custom-api/templates/${code}/run?json=true&noCache=1`,
      undefined, { cookie: fixture.headers.cookie });
    assert.equal(run.statusCode, 200, run.body);
    const table = run.json.tables.find(({ name }) => name === 'assets');
    assert.deepEqual(table?.rows.map(({ Code }) => Code), ['MATCH']);
    assert.ok(!fixture.mock.requests.slice(start).some(({ pathname }) => /\/(classes\/Location\/cards|lookup_types\/AssetStatus\/values)\//.test(pathname)));
  }
});
