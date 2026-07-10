import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplateParamDefaults,
  assistantCandidateClassesFromSummary,
  assistantClassMentionsFromText,
  assistantLimitWarningsFromDiagnostics,
  assistantMessages,
  assistantSearchTermsFromText,
  buildResultCellMeta,
  buildResultDiagrams,
  callLiteLLM,
  cmdbuildClassAttributesPath,
  defaultRuntimeConfig,
  dependencyMapWithHash,
  extractAssistantDraftSpec,
  ipv4ValueMatches,
  isSafeRuntimeLinkUrl,
  mcpToolDefinitions,
  normalizeAssistantDraftSpec,
  normalizeAssistantRuntimeConfig,
  normalizeRuntimeCacheConfig,
  normalizeTemplateCacheConfig,
  normalizeTemplateSpecForStorage,
  parseAssistantJson,
  renderCellTemplate,
  renderRuntimeParamTemplate,
  runtimeCacheKeyParts,
  runtimeJsonOutputRequested,
  runtimeJsonResponsePayload,
  sanitizeVisibleClassAttributes,
  templateIsProtected,
  validateTemplateSpec
} from '../../scripts/dev-proxy-server.mjs';

test('only CmdbBuildView templates are protected by spec protection flag', () => {
  assert.equal(templateIsProtected({ code: 'CmdbBuildView', spec: { version: 1 } }), true);
  assert.equal(templateIsProtected({ code: 'networkview', spec: { version: 1, protected: true, endpoint: { kind: 'runtime' } } }), false);
  assert.equal(templateIsProtected({ code: 'ModelViewCopy', spec: { version: 1, kind: 'cmdbBuildView', protected: true } }), false);
});

test('non-special templates drop stale protected flags and legacy BAA fields before storage', () => {
  assert.deepEqual(
    normalizeTemplateSpecForStorage({
      version: 1,
      protected: true,
      system: { protected: true, owner: 'admin' },
      endpoint: { kind: 'baaVerification' },
      baaContract: { code: 'legacy' },
      steps: [{ type: 'selectCards', as: 'objects', className: 'Router' }]
    }),
    {
      version: 1,
      system: { owner: 'admin' },
      steps: [{ type: 'selectCards', as: 'objects', className: 'Router' }]
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
      kind: 'cmdbBuildView',
      cmdbBuildView: { language: 'auto' }
    }
  );
});

test('class attribute metadata uses service scope and keeps inherited readable attributes', () => {
  assert.equal(
    cmdbuildClassAttributesPath('routerG'),
    '/cmdbuild/services/rest/v3/classes/routerG/attributes?scope=service&limit=1000'
  );

  const attributes = sanitizeVisibleClassAttributes([
    { name: 'model', type: 'string', inherited: true, _can_read: true, active: true },
    { name: 'model2', type: 'string', inherited: false, _can_read: true, active: true },
    { name: 'hiddenModel', type: 'string', inherited: true, _can_read: false, active: true },
    { name: 'inactiveModel', type: 'string', inherited: true, _can_read: true, active: false }
  ]);

  assert.deepEqual(attributes.map((item) => ({
    name: item.name,
    type: item.type,
    inherited: item.inherited
  })), [
    { name: 'model', type: 'string', inherited: true },
    { name: 'model2', type: 'string', inherited: false }
  ]);
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

test('runtime json response honors table and diagram output mode', () => {
  const baseResult = {
    presentation: { outputMode: 'diagrams' },
    tables: [{
      name: 'final',
      title: 'Routers',
      columns: ['Code'],
      rows: [{ Code: 'router047' }]
    }],
    diagrams: [{
      name: 'topology',
      title: 'Topology',
      type: 'topology',
      nodes: [{ id: 'router047', label: 'router047' }],
      edges: []
    }]
  };

  const diagramsOnly = runtimeJsonResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'topology' },
    result: baseResult
  });
  assert.equal(diagramsOnly.tables.length, 0);
  assert.equal(diagramsOnly.diagrams.length, 1);

  const tablesOnly = runtimeJsonResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'topology' },
    result: { ...baseResult, presentation: { outputMode: 'tables' } }
  });
  assert.equal(tablesOnly.tables.length, 1);
  assert.equal(tablesOnly.diagrams.length, 0);
});

test('result diagrams build deterministic topology payloads and runtime json exposes them', () => {
  const diagrams = buildResultDiagrams({
    result: {
      diagrams: [{
        name: 'topology',
        title: 'ACL topology ${param.system}',
        source: { nodes: 'nodes', edges: 'edges' },
        fields: {
          nodeId: 'Id',
          nodeLabel: 'Label',
          nodeGroup: 'Group',
          nodeHref: 'Href',
          edgeSource: 'Source',
          edgeTarget: 'Target',
          edgeLabel: 'Label'
        }
      }]
    }
  }, {
    nodes: {
      rows: [
        { Id: 'srv-1', Label: 'Server 1', Group: 'Server', Href: '/cmdbuild/ui/#classes/Server/cards/1' },
        { Id: 'vlan-1', Label: 'VLAN 1', Group: 'VLAN', Href: 'javascript:alert(1)' }
      ]
    },
    edges: {
      rows: [{ Source: 'srv-1', Target: 'vlan-1', Label: 'connected' }]
    }
  }, { system: 'billing' }, { maxRows: 100 });

  assert.equal(diagrams.length, 1);
  assert.equal(diagrams[0].title, 'ACL topology billing');
  assert.equal(diagrams[0].nodes.length, 2);
  assert.equal(diagrams[0].nodes[0].href, '/cmdbuild/ui/#classes/Server/cards/1');
  assert.equal(diagrams[0].nodes[1].href, '');
  assert.deepEqual(diagrams[0].edges, [{ source: 'srv-1', target: 'vlan-1', label: 'connected' }]);

  const payload = runtimeJsonResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'topology' },
    result: { diagrams }
  });
  assert.equal(payload.diagrams.length, 1);
  assert.equal(payload.diagrams[0].nodes.length, 2);
  assert.equal(payload.diagrams[0].edges[0].label, 'connected');
});

test('assistant MCP config keeps known allowed tools and bounded defaults', () => {
  const defaultConfig = normalizeAssistantRuntimeConfig(defaultRuntimeConfig());
  const allTools = mcpToolDefinitions(defaultConfig).map((tool) => tool.name);

  assert.deepEqual(defaultConfig.mcp.allowedTools, allTools);

  const blankConfig = normalizeAssistantRuntimeConfig({
    assistant: {
      mcp: {
        enabled: true,
        allowedTools: []
      }
    }
  });
  assert.deepEqual(blankConfig.mcp.allowedTools, allTools);

  const config = normalizeAssistantRuntimeConfig({
    assistant: {
      mcp: {
        enabled: true,
        allowedTools: ['cmdbuild_model_summary', 'unknown_tool', 'cmdbuild_template_context'],
        maxContextBytes: 999999,
        timeoutMs: 1,
        maxClasses: 375,
        maxDomains: 225,
        maxRelationDomains: 175,
        maxCandidateClasses: 25,
        maxClassFields: 12
      }
    }
  });

  assert.deepEqual(config.mcp.allowedTools, ['cmdbuild_model_summary', 'cmdbuild_template_context']);
  assert.equal(config.mcp.maxContextBytes, 999999);
  assert.equal(config.mcp.timeoutMs, 1000);
  assert.equal(config.mcp.maxClasses, 375);
  assert.equal(config.mcp.maxDomains, 225);
  assert.equal(config.mcp.maxRelationDomains, 175);
  assert.equal(config.mcp.maxCandidateClasses, 25);
  assert.equal(Object.prototype.hasOwnProperty.call(config.mcp, 'maxClassFields'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config.mcp.limitConfig, 'maxClassFields'), false);
  assert.equal(
    mcpToolDefinitions(config).find((tool) => tool.name === 'cmdbuild_model_summary').inputSchema.properties.maxClasses.maximum,
    5000
  );
  assert.deepEqual(
    mcpToolDefinitions(config).map((tool) => tool.name),
    ['cmdbuild_model_summary', 'cmdbuild_template_context']
  );

  const unknownOnlyConfig = normalizeAssistantRuntimeConfig({
    assistant: {
      mcp: {
        enabled: true,
        allowedTools: ['unknown_tool']
      }
    }
  });
  assert.deepEqual(unknownOnlyConfig.mcp.allowedTools, []);
  assert.deepEqual(unknownOnlyConfig.mcp.invalidAllowedTools, ['unknown_tool']);
  assert.deepEqual(mcpToolDefinitions(unknownOnlyConfig), []);
});

test('assistant MCP limits fall back to runtime execution limits and surface warnings', () => {
  const config = normalizeAssistantRuntimeConfig({
    assistant: {
      mcp: {
        enabled: true,
        maxCandidateClasses: 50,
        maxClassFields: 50
      }
    },
    executionLimits: {
      maxClassesDefault: 42,
      maxClassesMax: 64,
      maxDomainsDefault: 35,
      maxDomainsMax: 70
    }
  });

  assert.equal(config.mcp.maxClasses, 42);
  assert.equal(config.mcp.maxDomains, 35);
  assert.equal(config.mcp.maxRelationDomains, 35);
  assert.equal(config.mcp.maxCandidateClasses, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(config.mcp, 'maxClassFields'), false);
  assert.ok(config.mcp.limitClamps.some((item) => item.limitName === 'maxCandidateClasses' && item.rawConfigured === 50 && item.effectiveLimit === 42));
  assert.equal(config.mcp.limitClamps.some((item) => item.limitName === 'maxClassFields'), false);

  const warnings = assistantLimitWarningsFromDiagnostics([{
    source: 'mcp',
    tool: 'cmdbuild_model_summary',
    limitName: 'maxClasses',
    configuredLimit: 42,
    requested: 42,
    limit: 42,
    returned: 42,
    limitHit: true
  }]);

  assert.deepEqual(warnings, [
    'CMDBuild class context limit reached: returned 42 of configured maxClasses=42. Results may be incomplete.'
  ]);
});

test('assistant explicit MCP limits are not silently clamped by runtime execution limits', () => {
  const config = normalizeAssistantRuntimeConfig({
    assistant: {
      mcp: {
        enabled: true,
        maxDomains: 1000,
        maxRelationDomains: 1000,
        maxContextBytes: 200000
      }
    },
    executionLimits: {
      maxDomainsDefault: 70,
      maxDomainsMax: 140
    }
  });

  assert.equal(config.mcp.maxDomains, 1000);
  assert.equal(config.mcp.maxRelationDomains, 1000);
  assert.equal(config.mcp.maxContextBytes, 200000);
  assert.equal(config.mcp.limitClamps.some((item) => ['maxDomains', 'maxRelationDomains', 'maxContextBytes'].includes(item.limitName)), false);
});

test('assistant limit warnings report requested and effective values when clamped', () => {
  const warnings = assistantLimitWarningsFromDiagnostics([{
    source: 'config',
    tool: 'assistant.mcp',
    limitName: 'maxContextBytes',
    rawConfigured: 2000000,
    configuredLimit: 1048576,
    effectiveLimit: 1048576,
    requested: 2000000,
    limit: 1048576,
    absoluteCap: 1048576,
    clamped: true,
    clampedBy: 'CMDP_ASSISTANT_MCP_MAX_CONTEXT_BYTES_ABSOLUTE'
  }]);

  assert.deepEqual(warnings, [
    'assistant.mcp maxContextBytes was clamped: requested maxContextBytes=2000000, effective maxContextBytes=1048576 by CMDP_ASSISTANT_MCP_MAX_CONTEXT_BYTES_ABSOLUTE=1048576. Results may be incomplete.'
  ]);
});

test('assistant prompt config has default and preserves custom system prompt', () => {
  const defaultConfig = defaultRuntimeConfig();
  const normalizedDefault = normalizeAssistantRuntimeConfig(defaultConfig);

  assert.match(defaultConfig.assistant.prompt.system, /Code/);
  assert.match(defaultConfig.assistant.prompt.system, /Description/);
  assert.match(defaultConfig.assistant.prompt.system, /1:N, N:1 и N:N/);
  assert.doesNotMatch(defaultConfig.assistant.prompt.system, /Маршрутизатор ядра/);
  assert.equal(normalizedDefault.prompt.system, defaultConfig.assistant.prompt.system);

  const legacyConfig = normalizeAssistantRuntimeConfig({
    assistant: {
      llm: { enabled: true },
      mcp: { enabled: true }
    }
  });
  assert.equal(legacyConfig.prompt.system, defaultConfig.assistant.prompt.system);

  const customConfig = normalizeAssistantRuntimeConfig({
    assistant: {
      prompt: {
        system: 'Use customer CMDB terms.'
      }
    }
  });
  assert.equal(customConfig.prompt.system, 'Use customer CMDB terms.');

  const blankConfig = normalizeAssistantRuntimeConfig({
    assistant: {
      prompt: {
        system: '   '
      }
    }
  });
  assert.equal(blankConfig.prompt.system, defaultConfig.assistant.prompt.system);
});

test('assistant messages include configured system prompt without changing user payload', () => {
  const messages = assistantMessages(
    {
      intent: 'Построй таблицу серверов',
      taskMode: 'tables',
      currentSpec: { version: 1, steps: [] }
    },
    { enabled: false },
    {
      assistant: {
        prompt: {
          system: 'Custom CMDB semantic rule.'
        }
      }
    }
  );

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'system');
  assert.match(messages[0].content, /Return strict JSON only/);
  assert.equal(messages[1].content, 'Custom CMDB semantic rule.');
  assert.equal(messages[2].role, 'user');
  assert.match(messages[2].content, /Построй таблицу серверов/);
  assert.doesNotMatch(messages[2].content, /Custom CMDB semantic rule/);
});

test('assistant LLM gate follows runtime config before deployment key availability', async () => {
  await assert.rejects(
    callLiteLLM([], {
      assistant: {
        llm: {
          enabled: false,
          baseUrl: 'http://127.0.0.1:4000/v1',
          model: 'unit-test-model'
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'assistant_disabled');
      assert.match(error.message, /RuntimeConfigJson/);
      return true;
    }
  );

  await assert.rejects(
    callLiteLLM([], {
      assistant: {
        llm: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:9999/v1',
          model: 'unit-test-model'
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'assistant_base_url_not_allowed');
      return true;
    }
  );

  await assert.rejects(
    callLiteLLM([], {
      assistant: {
        llm: {
          enabled: true,
          baseUrl: 'http://127.0.0.1:4000/v1',
          model: 'unit-test-model'
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'assistant_not_configured');
      assert.equal(error.message, 'LiteLLM API key is not configured.');
      return true;
    }
  );
});

test('assistant draft normalization repairs select-card aliases before validation', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'findCard',
        as: 'servers',
        class: 'Server',
        where: [{ path: 'Code', op: 'contains', value: 'acl' }],
        limit: 50
      },
      {
        type: 'findCards',
        as: 'containers',
        classCode: 'Container',
        where: [{ path: 'Status', op: 'equals', value: 'Active' }],
        limit: 50
      }
    ],
    result: {
      tables: [{ source: 'servers', columns: ['Code'] }]
    }
  });

  assert.deepEqual(draft.spec.steps.map((step) => step.type), ['selectCards', 'selectCards']);
  assert.equal(draft.spec.steps[0].className, 'Server');
  assert.equal(draft.spec.steps[0].class, undefined);
  assert.deepEqual(draft.spec.steps[0].filters, [{ path: 'Code', op: 'contains', value: 'acl' }]);
  assert.equal(draft.spec.steps[0].where, undefined);
  assert.equal(draft.spec.steps[1].className, 'Container');
  assert.equal(draft.spec.steps[1].classCode, undefined);
  assert.equal(draft.warnings.length, 2);
  assert.match(draft.warnings[0], /findCard to selectCards/);
  assert.match(draft.warnings[1], /findCards to selectCards/);
  assert.equal(validateTemplateSpec(draft.spec).some((error) => /Unsupported step type/.test(error.message)), false);
});

test('assistant draft normalization repairs expandRelations domain descriptions from relation hints', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      {
        type: 'expandRelations',
        as: 'serverVlans',
        from: 'servers',
        sourceClass: 'Server',
        domain: 'Серверы - VLAN',
        targetClass: 'Vlan'
      }
    ],
    result: {
      tables: [{ source: 'serverVlans', columns: ['Code'] }]
    }
  }, {
    relationDomainHints: [{
      name: 'ServerVlan',
      description: 'Серверы - VLAN'
    }]
  });

  assert.equal(draft.spec.steps[1].domain, 'ServerVlan');
  assert.match(draft.warnings.join(' '), /normalized expandRelations domain/);
  assert.equal(validateTemplateSpec(draft.spec).some((error) => error.path === '$.steps[1].domain'), false);
});

test('assistant draft normalization removes unmapped invalid expandRelations domains only', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      {
        type: 'expandRelations',
        as: 'serverVlans',
        from: 'servers',
        sourceClass: 'Server',
        domain: 'связь серверов с vlan',
        targetClass: 'VLAN сеть'
      }
    ],
    result: {
      tables: [{ source: 'serverVlans', columns: ['Code'] }]
    }
  }, {
    relationDomainHints: [{
      name: 'ServerContainer',
      description: 'Серверы - контейнеры'
    }]
  });
  const errors = validateTemplateSpec(draft.spec);

  assert.equal(draft.spec.steps[1].domain, undefined);
  assert.match(draft.warnings.join(' '), /removed invalid expandRelations domain/);
  assert.equal(errors.some((error) => error.path === '$.steps[1].domain'), false);
  assert.deepEqual(
    errors.filter((error) => error.path === '$.steps[1].targetClass').map((error) => error.message),
    ['expandRelations targetClass must contain CMDBuild identifiers.']
  );
});

test('assistant draft normalization repairs matchRows aliases and rules from side objects', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      { type: 'selectCards', as: 'vlans', className: 'Vlan' },
      {
        type: 'matchRows',
        as: 'serverVlans',
        left: { source: 'servers', column: 'Code' },
        right: { source: 'vlans', column: 'ServerCode' },
        operator: 'equals'
      }
    ],
    result: {
      tables: [{ source: 'serverVlans', columns: ['Code', 'vlans_Code'] }]
    }
  });
  const step = draft.spec.steps[2];

  assert.equal(step.from, 'servers');
  assert.equal(step.with, 'vlans');
  assert.deepEqual(step.rules, [{ leftColumn: 'Code', rightColumn: 'ServerCode', operator: 'equals' }]);
  assert.equal(step.left, undefined);
  assert.equal(step.right, undefined);
  assert.match(draft.warnings.join(' '), /normalized matchRows aliases and rules/);
  assert.equal(validateTemplateSpec(draft.spec).some((error) => error.path.startsWith('$.steps[2].')), false);
});

test('assistant draft normalization repairs matchRows aliases and on object', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      { type: 'selectCards', as: 'ips', className: 'IPAddress' },
      {
        type: 'matchRows',
        as: 'serverIps',
        leftSource: 'servers',
        rightSource: 'ips',
        on: { left: 'Code', right: 'ServerCode' },
        op: 'contains'
      }
    ],
    result: {
      tables: [{ source: 'serverIps', columns: ['Code', 'ips_Address'] }]
    }
  });
  const step = draft.spec.steps[2];

  assert.equal(step.from, 'servers');
  assert.equal(step.with, 'ips');
  assert.deepEqual(step.rules, [{ leftColumn: 'Code', rightColumn: 'ServerCode', operator: 'contains' }]);
  assert.equal(step.leftSource, undefined);
  assert.equal(step.rightSource, undefined);
  assert.equal(step.on, undefined);
  assert.equal(validateTemplateSpec(draft.spec).some((error) => error.path.startsWith('$.steps[2].')), false);
});

test('assistant draft normalization repairs matchRows keys arrays', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      { type: 'selectCards', as: 'containers', className: 'Container' },
      {
        type: 'matchRows',
        as: 'serverContainers',
        source: 'servers',
        target: 'containers',
        keys: [['Code', 'ServerCode'], 'Environment']
      }
    ],
    result: {
      tables: [{ source: 'serverContainers', columns: ['Code', 'containers_Code'] }]
    }
  });
  const step = draft.spec.steps[2];

  assert.equal(step.from, 'servers');
  assert.equal(step.with, 'containers');
  assert.deepEqual(step.rules, [
    { leftColumn: 'Code', rightColumn: 'ServerCode' },
    { leftColumn: 'Environment', rightColumn: 'Environment' }
  ]);
  assert.equal(step.source, undefined);
  assert.equal(step.target, undefined);
  assert.equal(step.keys, undefined);
  assert.equal(validateTemplateSpec(draft.spec).some((error) => error.path.startsWith('$.steps[2].')), false);
});

test('assistant draft normalization leaves incomplete matchRows rejected by validator', () => {
  const noColumns = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      { type: 'selectCards', as: 'ips', className: 'IPAddress' },
      {
        type: 'matchRows',
        as: 'serverIps',
        leftSource: 'servers',
        rightSource: 'ips'
      }
    ],
    result: {
      tables: [{ source: 'serverIps', columns: ['Code'] }]
    }
  });
  const noColumnsErrors = validateTemplateSpec(noColumns.spec);
  assert.equal(noColumns.spec.steps[2].from, 'servers');
  assert.equal(noColumns.spec.steps[2].with, 'ips');
  assert.equal(noColumnsErrors.some((error) => error.path === '$.steps[2].rules'), true);
  assert.equal(noColumnsErrors.some((error) => error.path === '$.steps[2].from'), false);
  assert.equal(noColumnsErrors.some((error) => error.path === '$.steps[2].with'), false);

  const noAliases = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      { type: 'selectCards', as: 'servers', className: 'Server' },
      { type: 'selectCards', as: 'ips', className: 'IPAddress' },
      {
        type: 'matchRows',
        as: 'serverIps',
        on: { left: 'Code', right: 'ServerCode' }
      }
    ],
    result: {
      tables: [{ source: 'serverIps', columns: ['Code'] }]
    }
  });
  const noAliasesErrors = validateTemplateSpec(noAliases.spec);
  assert.deepEqual(noAliases.spec.steps[2].rules, [{ leftColumn: 'Code', rightColumn: 'ServerCode' }]);
  assert.equal(noAliasesErrors.some((error) => error.path === '$.steps[2].rules'), false);
  assert.equal(noAliasesErrors.some((error) => error.path === '$.steps[2].from'), true);
  assert.equal(noAliasesErrors.some((error) => error.path === '$.steps[2].with'), true);
});

test('assistant intent terms and model summary select relevant CMDBuild classes', () => {
  const terms = assistantSearchTermsFromText('найти все карточки АРМ которые находятся в том же местоположении что и "Маршрутизатор для Test City 300"');
  assert.ok(terms.includes('арм'));
  assert.ok(terms.includes('маршрутизатор'));
  assert.ok(terms.includes('test'));
  assert.ok(terms.includes('city'));

  const candidates = assistantCandidateClassesFromSummary({
    classes: [
      { name: 'Workstation', description: 'АРМ' },
      { name: 'Router', description: 'Маршрутизатор' },
      { name: 'UserAccount', description: 'Пользователь' }
    ]
  }, terms, 5);

  assert.deepEqual(candidates.map((item) => item.name).sort(), ['Router', 'Workstation']);
});

test('assistant class selection prefers exact generic description over specialized partial description', () => {
  const intent = 'найти все карточки класса маршрутизатор';
  const terms = assistantSearchTermsFromText(intent);
  const classMentions = assistantClassMentionsFromText(intent);
  const candidates = assistantCandidateClassesFromSummary({
    classes: [
      { name: 'routeCore', description: 'Маршрутизатор ядра' },
      { name: 'Router', description: 'Маршрутизатор' }
    ]
  }, terms, 5);
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routers',
        className: 'routeCore',
        filters: [{ path: 'Описание', op: 'contains', value: 'Test City' }],
        columns: ['Код', 'Описание']
      }
    ],
    result: {
      tables: [{ name: 'routers', columns: ['Код', 'Описание'] }]
    }
  }, {
    intentTerms: terms,
    classMentions,
    classHints: [
      { name: 'routeCore', description: 'Маршрутизатор ядра' },
      { name: 'Router', description: 'Маршрутизатор' }
    ],
    classFieldHints: [
      {
        className: 'Router',
        attributes: [
          { name: 'Code', description: 'Код' },
          { name: 'Description', description: 'Описание' }
        ]
      }
    ]
  });

  assert.deepEqual(classMentions, ['маршрутизатор']);
  assert.equal(candidates[0].name, 'Router');
  assert.equal(draft.spec.steps[0].className, 'Router');
  assert.equal(draft.spec.steps[0].filters[0].path, 'Description');
  assert.deepEqual(draft.spec.result.tables[0].columns, ['Code', 'Description']);
  assert.match(draft.warnings.join(' '), /class mention "маршрутизатор" exactly matches class Description "Маршрутизатор"/);
  assert.ok(draft.diagnostics.normalizedClasses.some((item) => item.from === 'routeCore' && item.to === 'Router'));
});

test('assistant class selection does not replace source class with unrelated target class mention', () => {
  const intent = 'найти все карточки класса АРМ которые находятся в том же местоположении что и экземпляр класса "маршрутизатор" с описанием "Маршрутизатор для Test City 300"';
  const terms = assistantSearchTermsFromText(intent);
  const classMentions = assistantClassMentionsFromText(intent);
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'routerCore',
        filters: [{ path: 'Описание', op: 'contains', value: 'Маршрутизатор для Test City 300' }]
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'АРМ',
        filters: [{ path: 'Местоположение', op: 'equals', valueColumn: 'Местоположение' }]
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Код', 'Описание', 'Местоположение'] }]
    }
  }, {
    intentTerms: terms,
    classMentions,
    classHints: [
      { name: 'ARM', description: 'АРМ' },
      { name: 'routerG', description: 'Маршрутизатор' },
      { name: 'routerCore', description: 'Маршрутизатор ядра' }
    ],
    classFieldHints: [
      {
        className: 'ARM',
        attributes: [
          { name: 'Code', description: 'Код' },
          { name: 'Description', description: 'Описание' },
          { name: 'Location', description: 'Местоположение' }
        ]
      }
    ]
  });

  assert.deepEqual([...classMentions].sort(), ['арм', 'маршрутизатор']);
  assert.equal(draft.spec.steps[0].className, 'routerG');
  assert.equal(draft.spec.steps[1].className, 'ARM');
  assert.equal(draft.diagnostics.normalizedClasses.some((item) => item.from === 'routerCore' && item.to === 'ARM'), false);
  assert.ok(draft.diagnostics.normalizedClasses.some((item) => item.from === 'routerCore' && item.to === 'routerG'));
  assert.ok(draft.diagnostics.normalizedClasses.some((item) => item.from === 'АРМ' && item.to === 'ARM'));
  assert.deepEqual(draft.errors, []);
});

test('assistant class selection warns but keeps executable partial fallback when class context limit was hit', () => {
  const intent = 'найти все карточки класса АРМ которые находятся в том же местоположении что и экземпляр класса "маршрутизатор" с описанием "Маршрутизатор для Test City 300"';
  const terms = assistantSearchTermsFromText(intent);
  const classMentions = assistantClassMentionsFromText(intent);
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'routerCore',
        filters: [{ path: 'Описание', op: 'contains', value: 'Маршрутизатор для Test City 300' }]
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'АРМ',
        filters: [{ path: 'Местоположение', op: 'equals', valueColumn: 'Местоположение' }]
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Код', 'Описание', 'Местоположение'] }]
    }
  }, {
    intentTerms: terms,
    classMentions,
    mcpContext: {
      diagnostics: {
        limits: [{
          source: 'mcp',
          tool: 'cmdbuild_model_summary',
          limitName: 'maxClasses',
          configuredLimit: 100,
          requested: 100,
          limit: 100,
          returned: 100,
          limitHit: true
        }]
      }
    },
    classHints: [
      { name: 'ARM', description: 'АРМ' },
      { name: 'routerCore', description: 'Маршрутизатор ядра' }
    ]
  });

  assert.equal(draft.spec.steps[0].className, 'routerCore');
  assert.equal(draft.spec.steps[1].className, 'ARM');
  assert.deepEqual(draft.errors, []);
  assert.match(draft.warnings.join(' '), /CMDBuild class context limit was reached/);
});

test('assistant class selection keeps specialized class when user names full description or code', () => {
  const classHints = [
    { name: 'routeCore', description: 'Маршрутизатор ядра' },
    { name: 'Router', description: 'Маршрутизатор' }
  ];
  const explicitDescriptionIntent = 'найти экземпляр класса "маршрутизатор ядра"';
  const explicitCodeIntent = 'найти класс routeCore маршрутизатор';
  const explicitDescriptionTerms = assistantSearchTermsFromText(explicitDescriptionIntent);
  const explicitCodeTerms = assistantSearchTermsFromText(explicitCodeIntent);
  const explicitDescriptionMentions = assistantClassMentionsFromText(explicitDescriptionIntent);
  const explicitCodeMentions = assistantClassMentionsFromText(explicitCodeIntent);

  assert.ok(explicitDescriptionTerms.includes('маршрутизатор ядра'));
  assert.ok(explicitCodeTerms.includes('routecore'));
  assert.deepEqual(explicitDescriptionMentions, ['маршрутизатор ядра']);

  const byDescription = normalizeAssistantDraftSpec({
    version: 1,
    steps: [{ type: 'selectCards', as: 'routers', className: 'routeCore' }],
    result: { tables: [{ name: 'routers', columns: ['Code'] }] }
  }, {
    intentTerms: explicitDescriptionTerms,
    classMentions: explicitDescriptionMentions,
    classHints
  });
  const byCode = normalizeAssistantDraftSpec({
    version: 1,
    steps: [{ type: 'selectCards', as: 'routers', className: 'routeCore' }],
    result: { tables: [{ name: 'routers', columns: ['Code'] }] }
  }, {
    intentTerms: explicitCodeTerms,
    classMentions: explicitCodeMentions,
    classHints
  });

  assert.equal(byDescription.spec.steps[0].className, 'routeCore');
  assert.equal(byCode.spec.steps[0].className, 'routeCore');
  assert.deepEqual(byDescription.diagnostics.normalizedClasses, []);
  assert.deepEqual(byCode.diagnostics.normalizedClasses, []);
});

test('assistant draft normalization maps class and field descriptions for source-row selection', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'Маршрутизатор',
        filters: [{ path: 'Описание', op: 'contains', value: 'Маршрутизатор для Test City 300' }],
        columns: ['Код', 'Описание'],
        limit: 5
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'АРМ',
        filters: [{ path: 'Местоположение', op: 'equals', valueColumn: 'Местоположение' }],
        columns: ['Код', 'Описание', 'Местоположение'],
        limit: 100
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Код', 'Описание', 'Местоположение'] }]
    }
  }, {
    classHints: [
      { name: 'Router', description: 'Маршрутизатор' },
      { name: 'Workstation', description: 'АРМ' }
    ],
    classFieldHints: [
      {
        className: 'Router',
        attributes: [
          { name: 'Code', description: 'Код' },
          { name: 'Description', description: 'Описание' },
          { name: 'Location', description: 'Местоположение' }
        ]
      },
      {
        className: 'Workstation',
        attributes: [
          { name: 'Code', description: 'Код' },
          { name: 'Description', description: 'Описание' },
          { name: 'Location', description: 'Местоположение' }
        ]
      }
    ]
  });

  assert.equal(draft.spec.steps[0].className, 'Router');
  assert.equal(draft.spec.steps[0].filters[0].path, 'Description');
  assert.deepEqual(draft.spec.steps[0].columns, ['Code', 'Description', 'Location']);
  assert.equal(draft.spec.steps[1].className, 'Workstation');
  assert.equal(draft.spec.steps[1].filters[0].path, 'Location');
  assert.equal(draft.spec.steps[1].filters[0].valueColumn, 'Location');
  assert.deepEqual(draft.spec.steps[1].columns, ['Code', 'Description', 'Location']);
  assert.deepEqual(draft.spec.result.tables[0].columns, ['Code', 'Description', 'Location']);
  assert.equal(validateTemplateSpec(draft.spec).length, 0);
  assert.ok(draft.diagnostics.normalizedClasses.some((item) => item.from === 'АРМ' && item.to === 'Workstation'));
  assert.ok(draft.diagnostics.normalizedFields.some((item) => item.from === 'Местоположение' && item.to === 'Location'));
});

test('assistant draft normalization adds a missing result table for source-row selection', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'routerAnchor',
        className: 'Маршрутизатор',
        filters: [{ path: 'Описание', op: 'contains', value: 'Маршрутизатор для Test City 300' }],
        columns: ['Код', 'Описание'],
        limit: 1
      },
      {
        type: 'selectCards',
        as: 'arms',
        from: 'routerAnchor',
        className: 'АРМ',
        filters: [{ path: 'Местоположение', op: 'equals', valueColumn: 'Местоположение' }],
        columns: ['Код', 'Описание', 'Местоположение'],
        limit: 100
      }
    ],
    result: { tables: [] }
  }, {
    taskMode: 'tables',
    classHints: [
      { name: 'Router', description: 'Маршрутизатор' },
      { name: 'Workstation', description: 'АРМ' }
    ],
    classFieldHints: [
      {
        className: 'Router',
        attributes: [
          { name: 'Code', description: 'Код' },
          { name: 'Description', description: 'Описание' },
          { name: 'Location', description: 'Местоположение' }
        ]
      },
      {
        className: 'Workstation',
        attributes: [
          { name: 'Code', description: 'Код' },
          { name: 'Description', description: 'Описание' },
          { name: 'Location', description: 'Местоположение' }
        ]
      }
    ]
  });

  assert.deepEqual(draft.spec.result.tables, [{ name: 'arms', columns: ['Code', 'Description', 'Location'] }]);
  assert.equal(validateTemplateSpec(draft.spec).length, 0);
  assert.match(draft.warnings.join(' '), /Assistant did not define result\.tables/);
  assert.deepEqual(draft.diagnostics.resultRepair, [{
    path: '$.result.tables',
    action: 'addedDefaultTable',
    alias: 'arms',
    step: 1,
    columns: ['Code', 'Description', 'Location']
  }]);
});

test('assistant draft normalization repairs exact source Description filters from intent', () => {
  const baseOptions = {
    exactDescriptionFilters: [{
      classMention: 'маршрутизатор',
      description: 'Маршрутизатор для Test City 300'
    }],
    classHints: [
      { name: 'routerG', description: 'Маршрутизатор' },
      { name: 'ARM', description: 'АРМ' }
    ],
    classFieldHints: [
      {
        className: 'routerG',
        attributes: [
          { name: 'Description', description: 'Описание' },
          { name: 'Location', description: 'Местоположение' }
        ]
      }
    ]
  };
  const tightened = normalizeAssistantDraftSpec({
    version: 1,
    steps: [{
      type: 'selectCards',
      as: 'routerAnchor',
      className: 'routerG',
      filters: [{ path: 'Description', op: 'contains', value: 'Маршрутизатор для Test City 300' }],
      columns: ['Code', 'Description', 'Location']
    }],
    result: { tables: [{ name: 'routerAnchor', columns: ['Code', 'Description', 'Location'] }] }
  }, baseOptions);
  const added = normalizeAssistantDraftSpec({
    version: 1,
    steps: [{
      type: 'selectCards',
      as: 'routerAnchor',
      className: 'routerG',
      columns: ['Code', 'Description', 'Location']
    }],
    result: { tables: [{ name: 'routerAnchor', columns: ['Code', 'Description', 'Location'] }] }
  }, baseOptions);

  assert.deepEqual(tightened.spec.steps[0].filters, [{ path: 'Description', op: 'equals', value: 'Маршрутизатор для Test City 300' }]);
  assert.deepEqual(tightened.diagnostics.descriptionFilterRepair, [{
    step: 0,
    className: 'routerG',
    action: 'tightenedToEquals',
    previousOp: 'contains',
    value: 'Маршрутизатор для Test City 300'
  }]);
  assert.deepEqual(added.spec.steps[0].filters, [{ path: 'Description', op: 'equals', value: 'Маршрутизатор для Test City 300' }]);
  assert.deepEqual(added.diagnostics.descriptionFilterRepair, [{
    step: 0,
    className: 'routerG',
    action: 'addedExactDescriptionFilter',
    value: 'Маршрутизатор для Test City 300'
  }]);
});

test('assistant draft normalization does not add a result table for diagram-only task mode', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [{ type: 'selectCards', as: 'nodes', className: 'Server' }],
    result: { tables: [] }
  }, {
    taskMode: 'diagrams'
  });
  const errors = validateTemplateSpec(draft.spec);

  assert.deepEqual(draft.spec.result.tables, []);
  assert.equal(errors.some((error) => error.path === '$.result'), true);
  assert.equal(draft.diagnostics.resultRepair, undefined);
});

test('assistant draft normalization does not guess ambiguous class or field descriptions', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [
      {
        type: 'selectCards',
        as: 'arms',
        className: 'АРМ',
        filters: [{ path: 'Местоположение', op: 'equals', value: 'Москва' }]
      }
    ],
    result: {
      tables: [{ name: 'arms', columns: ['Местоположение'] }]
    }
  }, {
    classHints: [
      { name: 'Workstation', description: 'АРМ' },
      { name: 'ThinClient', description: 'АРМ' }
    ],
    classFieldHints: [
      {
        className: 'Workstation',
        attributes: [
          { name: 'Location', description: 'Местоположение' },
          { name: 'Placement', description: 'Местоположение' }
        ]
      }
    ]
  });

  assert.equal(draft.spec.steps[0].className, 'АРМ');
  assert.equal(draft.spec.steps[0].filters[0].path, 'Местоположение');
  assert.deepEqual(draft.diagnostics.normalizedClasses, []);
  assert.deepEqual(draft.diagnostics.normalizedFields, []);
  assert.equal(validateTemplateSpec(draft.spec).some((error) => error.path === '$.steps[0].className'), true);
});

test('assistant system prompt documents source-row selection with valueColumn', () => {
  const messages = assistantMessages({
    intent: 'same location as router',
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    taskMode: 'tables'
  }, { enabled: false }, defaultRuntimeConfig());

  assert.ok(messages.some((message) => /valueColumn/.test(message.content) && /selectCards\.from/.test(message.content)));
  assert.ok(messages.some((message) => /explanation text is not executable/.test(message.content) && /spec\.result/.test(message.content)));
  assert.ok(messages.some((message) => /с описанием/.test(message.content) && /Description/.test(message.content) && /equals/.test(message.content)));
});

test('assistant draft extraction accepts common response wrappers', () => {
  const spec = {
    version: 1,
    steps: [{ type: 'selectCards', as: 'servers', className: 'Server' }],
    result: {
      tables: [{ source: 'servers', columns: ['Code'] }]
    }
  };

  assert.deepEqual(extractAssistantDraftSpec({ spec }).spec, spec);

  const templateSpec = extractAssistantDraftSpec({ templateSpec: spec });
  assert.deepEqual(templateSpec.spec, spec);
  assert.equal(templateSpec.error, null);
  assert.match(templateSpec.warnings.join(' '), /templateSpec/);

  const nestedDraft = extractAssistantDraftSpec({ draft: { spec } });
  assert.deepEqual(nestedDraft.spec, spec);
  assert.equal(nestedDraft.error, null);
});

test('assistant JSON parser accepts model prose around a valid draft object', () => {
  const draft = {
    spec: {
      version: 1,
      steps: [{ type: 'selectCards', as: 'servers', className: 'Server' }],
      result: { tables: [{ source: 'servers', columns: ['Code'] }] }
    },
    explanation: 'Use {Code} and escaped quote \\" safely.',
    warnings: []
  };

  assert.deepEqual(parseAssistantJson(`${JSON.stringify(draft)}\n\nDone.`), draft);
  assert.deepEqual(parseAssistantJson(`Here is the draft:\n${JSON.stringify(draft)}`), draft);
  assert.deepEqual(parseAssistantJson(`\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\nAdditional note.`), draft);
});

test('assistant JSON parser keeps first valid object when model returns multiple JSON blocks', () => {
  const first = {
    spec: {
      version: 1,
      steps: [{ type: 'selectCards', as: 'servers', className: 'Server' }],
      result: { tables: [{ source: 'servers', columns: ['Code'] }] }
    },
    explanation: 'first',
    warnings: []
  };
  const second = {
    spec: {
      version: 1,
      steps: [{ type: 'selectCards', as: 'containers', className: 'Container' }],
      result: { tables: [{ source: 'containers', columns: ['Code'] }] }
    },
    explanation: 'second',
    warnings: []
  };

  assert.deepEqual(parseAssistantJson(`${JSON.stringify(first)}\n${JSON.stringify(second)}`), first);
});

test('assistant JSON parser reports controlled error when content has no JSON draft', () => {
  assert.throws(
    () => parseAssistantJson('plain assistant prose without a JSON object'),
    (error) => {
      assert.equal(error.code, 'assistant_invalid_json');
      assert.equal(error.statusCode, 502);
      assert.equal(error.message, 'Assistant response did not contain parseable JSON.');
      return true;
    }
  );
});

test('assistant draft extraction wraps top-level steps arrays before validation', () => {
  const extracted = extractAssistantDraftSpec([
    { type: 'findCard', as: 'servers', class: 'Server', where: [{ path: 'Code', op: 'contains', value: 'acl' }] }
  ]);
  const draft = normalizeAssistantDraftSpec(extracted.spec);
  const errors = validateTemplateSpec(draft.spec);

  assert.equal(extracted.error, null);
  assert.equal(draft.spec.version, 1);
  assert.equal(draft.spec.steps[0].type, 'selectCards');
  assert.equal(draft.spec.steps[0].className, 'Server');
  assert.equal(errors.some((error) => error.message === 'Template spec must be an object.'), false);
  assert.equal(errors.some((error) => error.path === '$.result'), false);
  assert.deepEqual(draft.spec.result.tables, [{ name: 'servers', columns: ['Code', 'Description'] }]);
  assert.match([...extracted.warnings, ...draft.warnings].join(' '), /wrapped it into a DSL spec object/);
  assert.match(draft.warnings.join(' '), /added default table for step alias "servers"/);
});

test('assistant draft extraction reports missing DSL objects clearly', () => {
  const values = ['plain text', null, [{ message: 'not a step' }]];

  values.forEach((value) => {
    const extracted = extractAssistantDraftSpec(value);
    assert.deepEqual(extracted.spec, {});
    assert.deepEqual(extracted.error, {
      path: '$',
      message: 'Assistant response did not contain a DSL spec object.'
    });
    assert.equal(validateTemplateSpec(extracted.spec).some((error) => error.message === 'Template spec must be an object.'), false);
  });
});

test('assistant draft extraction rejects empty DSL wrappers before template validation', () => {
  const values = [
    {
      value: { spec: {} },
      path: '$.spec.steps'
    },
    {
      value: { version: 2, steps: [] },
      path: '$.steps'
    },
    {
      value: { result: { tables: [] } },
      path: '$.steps'
    },
    {
      value: { kind: 'dsl' },
      path: '$.steps'
    },
    {
      value: { templateSpec: { result: { tables: [] } } },
      path: '$.templateSpec.steps'
    }
  ];

  values.forEach(({ value, path }) => {
    const extracted = extractAssistantDraftSpec(value);
    const errors = extracted.error ? [extracted.error] : validateTemplateSpec(extracted.spec);

    assert.deepEqual(extracted.spec, {});
    assert.deepEqual(errors, [{
      path,
      message: 'Assistant response did not contain any DSL steps.'
    }]);
    assert.equal(errors.some((error) => error.message === 'Only DSL version 1 is supported.'), false);
    assert.equal(errors.some((error) => error.message === 'Template spec must contain at least one step.'), false);
  });
});

test('assistant draft normalization keeps unknown step types rejected by validator', () => {
  const draft = normalizeAssistantDraftSpec({
    version: 1,
    steps: [{ type: 'deleteCards', as: 'bad', className: 'Server' }],
    result: {
      tables: [{ source: 'bad', columns: ['Code'] }]
    }
  });

  assert.equal(draft.spec.steps[0].type, 'deleteCards');
  assert.deepEqual(draft.warnings, []);
  assert.deepEqual(validateTemplateSpec(draft.spec).filter((error) => error.path === '$.steps[0].type').map((error) => error.message), ['Unsupported step type: deleteCards']);
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

test('dependency map includes explicitly selected model attributes without auto-expanding all fields', () => {
  const spec = {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        className: 'routerG',
        as: 'routers',
        columns: ['Code', 'Description', 'model', 'model2']
      }
    ],
    result: {
      tables: [{ name: 'routers', columns: ['Code', 'Description', 'model', 'model2'] }]
    }
  };

  const map = dependencyMapWithHash(spec);
  const fields = map.selections.find((item) => item.as === 'routers').directFields;

  assert.deepEqual(fields.sort(), ['Class', '_id', 'Code', 'Description', 'model', 'model2'].sort());
  assert.equal(fields.includes('serialNumber'), false);
});

test('dependency map includes diagram source fields', () => {
  const spec = {
    version: 1,
    steps: [
      {
        type: 'selectCards',
        className: 'NetworkNode',
        as: 'nodes',
        columns: ['Code']
      },
      {
        type: 'selectCards',
        className: 'NetworkLink',
        as: 'edges',
        columns: ['Code']
      }
    ],
    result: {
      diagrams: [
        {
          name: 'topology',
          source: {
            nodes: 'nodes',
            edges: 'edges'
          },
          fields: {
            nodeId: 'NodeCode',
            nodeLabel: 'NodeName',
            nodeGroup: 'NodeType',
            nodeHref: 'NodeUrl',
            edgeSource: 'FromNode',
            edgeTarget: 'ToNode',
            edgeLabel: 'LinkName'
          }
        }
      ]
    }
  };

  const map = dependencyMapWithHash(spec);

  assert.deepEqual(
    map.selections.find((item) => item.as === 'nodes').directFields.sort(),
    ['Class', '_id', 'Code', 'Description', 'NodeCode', 'NodeName', 'NodeType', 'NodeUrl'].sort()
  );
  assert.deepEqual(
    map.selections.find((item) => item.as === 'edges').directFields.sort(),
    ['Class', '_id', 'Code', 'Description', 'FromNode', 'ToNode', 'LinkName'].sort()
  );
});
