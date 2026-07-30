import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  applyTemplateParamDefaults,
  assistantCandidateClassesFromSummary,
  assistantClassMentionsFromText,
  assistantDiagramSelectionMappings,
  assistantDiagramAttachRelatedNetworkStages,
  assistantDiagramPlacementCorrection,
  assistantDiagramPlacementDraftFromResponse,
  assistantDiagramRecoverParentCardMappings,
  assistantDiagramPlacementTargets,
  assistantDiagramResolveStageId,
  assistantDiagramStageDraftFromResponse,
  assistantDiagramTopologyRequirements,
  assistantLimitWarningsFromDiagnostics,
  assistantLiteLlmTimeoutMs,
  assistantMessages,
  assistantObjectFlowCandidate,
  assistantObjectFlowDiagramStages,
  assistantObjectFlowMessages,
  assistantSearchTermsFromText,
  assertDiagramImportProposal,
  buildResultCellMeta,
  buildResultDiagrams,
  cmdbuildSessionFailureHttpStatus,
  createDiagramImportProposal,
  callLiteLLM,
  cmdbuildClassAttributesPath,
  d2RendererConfigSummary,
  d2CacheContext,
  d2SourceForCompiler,
  d2WorkflowStatusForSpec,
  decorateD2MarkdownFrames,
  diagramSvgExecutionContract,
  d2ImportConfigSummary,
  diagramImportDeterministicSpecHash,
  diagramImportImplicitConditionSources,
  diagramImportInferImplicitConditionSource,
  diagramImportDirectRelationParentCorrelation,
  diagramImportPrimaryCardSource,
  diagramImportCardSourceField,
  diagramImportMappingInputRevision,
  diagramImportMappingValidationIsCurrent,
  migrateDiagramImportToCurrentRevision,
  signDiagramImportMappingValidation,
  diagramImportCloneStructureBranch,
  diagramImportStructureTree,
  diagramImportStructureTreeErrors,
  embedDiagramSvgMetadata,
  diagramImportAssistantSpec,
  defaultRuntimeConfig,
  dependencyMapWithHash,
  executeFilterRows,
  executeSemiJoinRows,
  extractAssistantDraftSpec,
  ipv4ValueMatches,
  isSafeRuntimeLinkUrl,
  mcpToolDefinitions,
  normalizeAssistantDraftSpec,
  normalizeAssistantObjectFlowIntent,
  normalizeAssistantRuntimeConfig,
  normalizeTemplateAssistantPromptOverrides,
  normalizeRuntimeCacheConfig,
  normalizeDiagramImportIr,
  normalizeTemplateCacheConfig,
  normalizeTemplateSpecForStorage,
  parseAssistantJson,
  renderCellTemplate,
  renderRuntimeParamTemplate,
  applyDiagramImportProposal,
  applyPartialDiagramImportProposal,
  diagramImportCurrentInputRecompileRequired,
  diagramImportRolesForStoredStructure,
  draftDiagramPreviewMappingPlan,
  draftDiagramPreviewRequiresPartialPlan,
  runtimeCacheKeyParts,
  runtimeD2OutputRequested,
  runtimeDisplayResponsePayload,
  runtimeJsonOutputRequested,
  runtimeJsonResponsePayload,
  sanitizeD2Svg,
  svgContainsD2ElementKey,
  stripSensitiveDiagramArtifacts,
  sanitizeVisibleClassAttributes,
  templateIsProtected,
  templateAssistantRuntimeConfig,
  validateDiagramImportV3Catalog,
  validateTemplateSpec,
  validateTemplateSpecForStorage
} from '../../scripts/dev-proxy-server.mjs';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';

test('CMDBuild session failures distinguish invalid authorization from upstream unavailability', () => {
  assert.equal(cmdbuildSessionFailureHttpStatus(400), 401);
  assert.equal(cmdbuildSessionFailureHttpStatus(401), 401);
  assert.equal(cmdbuildSessionFailureHttpStatus(403), 401);
  assert.equal(cmdbuildSessionFailureHttpStatus(0), 502);
  assert.equal(cmdbuildSessionFailureHttpStatus(500), 502);
});

test('template Assistant system prompt overrides inherit global policy without mutating it', () => {
  const runtimeConfig = {
    assistant: {
      prompt: {
        system: 'Global system prompt.',
        objectFlowSemantic: 'Global semantic prompt.',
        objectFlow: 'Global flow prompt.',
        diagramInterpretation: 'Global interpretation prompt.',
        diagramMapping: 'Global mapping prompt.'
      }
    }
  };
  const stored = normalizeTemplateSpecForStorage({
    version: 1,
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: { context: '', blocks: [] },
        diagramInterpretPrompt: 'Interpret the current D2 source.',
        diagramMappingPrompt: 'Map the selected results.',
        systemPromptOverrides: {
          system: 'Template-specific system prompt.',
          diagramMapping: 'Template-specific mapping prompt.',
          unknown: 'Must not be persisted.'
        }
      },
      d2: { source: 'node: Node' }
    }
  });

  assert.deepEqual(normalizeTemplateAssistantPromptOverrides(stored.authoring.assistant.systemPromptOverrides), {
    system: 'Template-specific system prompt.',
    diagramMapping: 'Template-specific mapping prompt.'
  });
  assert.equal(stored.authoring.assistant.systemPromptOverrides.unknown, undefined);

  const effective = normalizeAssistantRuntimeConfig(templateAssistantRuntimeConfig(runtimeConfig, stored));
  const inherited = normalizeAssistantRuntimeConfig(runtimeConfig);
  assert.equal(effective.prompt.system, 'Template-specific system prompt.');
  assert.equal(effective.prompt.diagramMapping, 'Template-specific mapping prompt.');
  assert.equal(effective.prompt.objectFlow, 'Global flow prompt.');
  assert.equal(effective.prompt.objectFlowSemantic, 'Global semantic prompt.');
  assert.equal(effective.prompt.diagramInterpretation, 'Global interpretation prompt.');
  assert.equal(inherited.prompt.system, 'Global system prompt.');
  assert.equal(inherited.prompt.diagramMapping, 'Global mapping prompt.');
  assert.equal(runtimeConfig.assistant.prompt.system, 'Global system prompt.');

  const reset = normalizeTemplateSpecForStorage({
    ...stored,
    authoring: {
      ...stored.authoring,
      assistant: {
        ...stored.authoring.assistant,
        systemPromptOverrides: {}
      }
    }
  });
  const resetEffective = normalizeAssistantRuntimeConfig(templateAssistantRuntimeConfig(runtimeConfig, reset));
  assert.equal(reset.authoring.assistant.systemPromptOverrides, undefined);
  assert.equal(resetEffective.prompt.system, 'Global system prompt.');
  assert.equal(resetEffective.prompt.diagramMapping, 'Global mapping prompt.');
});

test('template Assistant prompt overrides reject over-limit input without truncating it', () => {
  const prompt = 'x'.repeat(20_001);
  const spec = {
    version: 1,
    params: {},
    steps: [],
    result: { tables: [] },
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: { context: '', blocks: [] },
        diagramInterpretPrompt: '',
        diagramMappingPrompt: '',
        systemPromptOverrides: { objectFlow: prompt }
      },
      d2: { source: '' }
    }
  };

  const errors = validateTemplateSpecForStorage(spec);
  assert.deepEqual(errors, [{
    path: '$.authoring.assistant.systemPromptOverrides.objectFlow',
    message: 'Template Assistant prompt override must not exceed 20000 characters.'
  }]);
  assert.equal(
    normalizeTemplateSpecForStorage(spec).authoring.assistant.systemPromptOverrides.objectFlow.length,
    prompt.length,
    'The normalizer must not silently shorten a user prompt before the route returns validation errors.'
  );
});

test('runtime cache key ignores Assistant authoring overrides but changes for executable template state', () => {
  const baseSpec = {
    version: 1,
    steps: [{
      type: 'selectCards',
      as: 'systems',
      className: 'IS',
      filters: [],
      columns: ['Code', 'Description'],
      limit: 100
    }],
    result: { tables: [{ name: 'systems', columns: ['Code', 'Description'] }] }
  };
  const withPromptOverride = {
    ...structuredClone(baseSpec),
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: { context: '', blocks: [] },
        diagramInterpretPrompt: '',
        diagramMappingPrompt: '',
        systemPromptOverrides: { objectFlow: 'Use the result names supplied by this template.' }
      },
      d2: { source: 'systems: Systems' }
    }
  };
  const withExecutableChange = structuredClone(baseSpec);
  withExecutableChange.steps[0].limit = 250;
  const runtimeCache = normalizeRuntimeCacheConfig(defaultRuntimeConfig());
  const templateCache = normalizeTemplateCacheConfig({}, runtimeCache);
  const executionOptions = {
    maxRows: 100,
    maxClasses: 20,
    maxDomains: 20,
    maxRestCalls: 100,
    maxTraversalDepth: 1
  };
  const cacheKey = (spec) => runtimeCacheKeyParts(
    'Cst_QueryTool',
    { code: 'AssistantPromptCache', active: true, spec },
    {},
    { username: 'tester' },
    executionOptions,
    runtimeCache,
    templateCache,
    dependencyMapWithHash(spec),
    {}
  );

  const baseline = cacheKey(baseSpec);
  const authoringOnly = cacheKey(withPromptOverride);
  const executable = cacheKey(withExecutableChange);
  assert.equal(authoringOnly.key, baseline.key);
  assert.equal(authoringOnly.specHash, baseline.specHash);
  assert.notEqual(executable.key, baseline.key);
  assert.notEqual(executable.specHash, baseline.specHash);
});

function selectionFlowSpec(selections, blocks = []) {
  return compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1,
    selections: selections.map((selection, index) => ({
      id: selection.id || `selection:${selection.alias}`,
      name: selection.name || `Selection ${index + 1}`,
      alias: selection.alias,
      className: selection.className,
      from: selection.from || '',
      limit: selection.limit || 100,
      columns: selection.columns || [],
      rules: selection.rules || [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
    })),
    blocks
  });
}

function d2StructureTreeFixture() {
  const currentSpec = selectionFlowSpec([
    { alias: 'systemsA', className: 'IS', columns: ['Code', 'Description'] },
    { alias: 'systemsB', className: 'IS', columns: ['Code', 'Description'] }
  ]);
  const source = [
    'target: {',
    '  dmz: { vlan_scope: { vlan: VLAN } }',
    '  vlan_scope: { vlan: VLAN }',
    '}'
  ].join('\n');
  const ir = normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [
        { id: 'target', label: 'Target', classKeys: ['group-target'], pathSegments: ['target'] },
        { id: 'target.dmz', label: 'DMZ', parentKey: 'target', classKeys: ['group-dmz'], pathSegments: ['target', 'dmz'] },
        { id: 'target.dmz.vlan_scope', label: 'VLAN scope', parentKey: 'target.dmz', classKeys: ['scope-vlan'], pathSegments: ['target', 'dmz', 'vlan_scope'] },
        { id: 'target.vlan_scope', label: 'VLAN scope', parentKey: 'target', classKeys: ['scope-vlan'], pathSegments: ['target', 'vlan_scope'] }
      ],
      nodes: [
        { id: 'target.dmz.vlan_scope.vlan', label: 'VLAN', parentKey: 'target.dmz.vlan_scope', classKeys: ['vlan'], pathSegments: ['target', 'dmz', 'vlan_scope', 'vlan'] },
        { id: 'target.vlan_scope.vlan', label: 'VLAN', parentKey: 'target.vlan_scope', classKeys: ['vlan'], pathSegments: ['target', 'vlan_scope', 'vlan'] }
      ]
    },
    classes: [
      { key: 'group-target', usageKeys: ['target'] },
      { key: 'group-dmz', usageKeys: ['target.dmz'] },
      { key: 'scope-vlan', usageKeys: ['target.dmz.vlan_scope', 'target.vlan_scope'] },
      { key: 'vlan', usageKeys: ['target.dmz.vlan_scope.vlan', 'target.vlan_scope.vlan'] }
    ]
  }, source);
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: source });
  return {
    currentSpec,
    source,
    ir,
    proposal,
    roles: Object.fromEntries(proposal.roles.map((role) => [role.key, role]))
  };
}

function structureTreeWithStage(tree, roleId, stageId) {
  return {
    ...structuredClone(tree),
    items: tree.items.map((item) => String(item.roleId) === String(roleId)
      ? {
          ...item,
          mapping: {
            ...(item.mapping || {}),
            materialization: { kind: 'stage', stageId }
          }
        }
      : { ...item })
  };
}

function structureTreeItemWithSource(tree, itemId, stageId, mapping = {}) {
  return {
    ...structuredClone(tree),
    items: tree.items.map((item) => String(item.id) === String(itemId)
      ? {
          ...item,
          mapping: {
            ...(item.mapping || {}),
            ...mapping,
            materialization: { kind: 'stage', stageId }
          }
        }
      : { ...item })
  };
}

test('D2 mapping executable identity ignores Assistant prompts but preserves source and stage contracts', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const applied = applyDiagramImportProposal(
    currentSpec,
    proposal,
    [],
    [],
    structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA')
  );
  const imported = applied.result.diagrams[0].authoring.d2Import;
  const before = diagramImportMappingInputRevision(applied, imported);
  applied.authoring.assistant.diagramInterpretPrompt = 'Новый prompt интерпретации.';
  applied.authoring.assistant.diagramMappingPrompt = 'Новый prompt сопоставления.';
  const after = diagramImportMappingInputRevision(applied, imported);

  assert.deepEqual(after, before);
  assert.equal((await d2WorkflowStatusForSpec(applied)).state, 'applied');
  applied.authoring.d2.source += '\nchanged: Source';
  assert.equal((await d2WorkflowStatusForSpec(applied)).reason, 'source_changed');
});

test('only CmdbBuildView templates are protected by spec protection flag', () => {
  assert.equal(templateIsProtected({ code: 'CmdbBuildView', spec: { version: 1 } }), true);
  assert.equal(templateIsProtected({ code: 'networkview', spec: { version: 1, protected: true, endpoint: { kind: 'runtime' } } }), false);
  assert.equal(templateIsProtected({ code: 'ModelViewCopy', spec: { version: 1, kind: 'cmdbBuildView', protected: true } }), false);
});

test('semiJoin keeps a left row when inclusion and exclusion match different right rows', () => {
  const context = {
    left: { columns: ['Location', 'Blocked'], rows: [{ Location: 'A', Blocked: 'blocked' }] },
    right: {
      columns: ['Site', 'Scope'],
      rows: [
        { Site: 'A', Scope: 'allow' },
        { Site: 'B', Scope: 'blocked' }
      ]
    }
  };
  const step = {
    from: 'left',
    with: 'right',
    ruleJoin: 'any',
    rules: [
      { action: 'include', operator: 'equals', left: { column: 'Location' }, right: { column: 'Site' } },
      { action: 'exclude', operator: 'equals', left: { column: 'Blocked' }, right: { column: 'Scope' } }
    ]
  };

  assert.deepEqual(executeSemiJoinRows(step, {}, context, { maxRows: 100 }).rows, [{ Location: 'A', Blocked: 'blocked' }]);

  context.right.rows[0].Scope = 'blocked';
  assert.deepEqual(executeSemiJoinRows(step, {}, context, { maxRows: 100 }).rows, []);
});

test('D2 structure tree reports an explicit unavailable template element instead of coercing it', () => {
  const roles = [{ id: 'role:server', key: 'server', label: 'Server', visualKind: 'node', elementKeys: ['root.server'] }];
  const tree = diagramImportStructureTree({
    version: 4,
    items: [{
      id: 'server',
      roleId: 'role:server',
      templateContextKey: '',
      templateElementKey: 'root.other',
      templateElementKeys: ['root.other'],
      parentId: '',
      mapping: { source: { stageId: 'selection:servers' } }
    }]
  }, null, roles);

  assert.equal(tree.items[0].templateElementKey, 'root.other');
  const errors = diagramImportStructureTreeErrors(tree, roles, {
    version: 1,
    steps: [{ type: 'selectCards', as: 'servers', className: 'Server', columns: ['Code'] }]
  }, {
    nodes: [{ key: 'root.server', classKeys: ['server'] }]
  });
  assert.ok(errors.some((error) => /must use a D2 element/.test(error.message)));
});

test('D2 structure branch clone retains hierarchy and complete deterministic bindings', () => {
  const roles = [
    { id: 'role:scope', key: 'scope', label: 'Scope', visualKind: 'container', elementKeys: ['root.scope'] },
    { id: 'role:server', key: 'server', label: 'Server', visualKind: 'node', elementKeys: ['root.scope.server'] }
  ];
  const sourceTree = {
    version: 5,
    items: [
      {
        id: 'scope-a',
        roleId: 'role:scope',
        templateContextKey: 'scope-context',
        templateElementKey: 'root.scope',
        templateElementKeys: ['root.scope'],
        parentId: '',
        mapping: {
          materialization: { kind: 'stage', stageId: 'selection:physicalServers' },
          primary: { className: 'phServer', labelTemplate: 'Server ${Description}', structuredFields: ['Code', 'Description'] },
          conditions: { ruleJoin: 'all', rules: [{ left: { column: 'Code' }, right: { kind: 'literal', value: 'A' } }] }
        }
      },
      {
        id: 'server-a',
        roleId: 'role:server',
        templateContextKey: 'server-context',
        templateElementKey: 'root.scope.server',
        templateElementKeys: ['root.scope.server'],
        parentId: 'scope-a',
        mapping: {
          materialization: { kind: 'parentCard', stageId: '' },
          primary: { className: 'phServer', labelTemplate: '${Description}', structuredFields: ['Code', 'Description'] },
          conditions: { ruleJoin: 'any', rules: [] }
        }
      }
    ]
  };

  const cloned = diagramImportCloneStructureBranch(sourceTree, null, roles, 'scope-a');
  assert.ok(cloned);
  assert.equal(cloned.tree.items.length, 4);
  const clonedScope = cloned.tree.items.find((item) => item.id === cloned.rootId);
  const clonedServer = cloned.tree.items.find((item) => item.parentId === cloned.rootId);
  assert.ok(clonedScope);
  assert.ok(clonedServer);
  assert.equal(clonedScope.mapping.materialization.kind, 'stage');
  assert.equal(clonedScope.mapping.materialization.stageId, 'selection:physicalServers');
  assert.equal(clonedScope.mapping.conditions.ruleJoin, 'all');
  assert.equal(clonedScope.mapping.conditions.rules.length, 1);
  assert.equal(clonedScope.mapping.conditions.rules[0].left.column, 'Code');
  assert.equal(clonedScope.mapping.conditions.rules[0].right.value, 'A');
  assert.equal(clonedScope.mapping.primary.labelTemplate, 'Server ${Description}');
  assert.equal(clonedServer.mapping.materialization.kind, 'parentCard');
  assert.equal(clonedServer.mapping.primary.labelTemplate, '${Description}');
  assert.equal(sourceTree.items[0].mapping.materialization.stageId, 'selection:physicalServers');
  assert.equal(sourceTree.items[1].parentId, 'scope-a');
});

test('template Save migrates retired assistantDraft into canonical authoring and removes the sandbox', () => {
  const before = {
    version: 1,
    steps: [{ type: 'selectCards', as: 'assets', className: 'ARM', columns: ['Code'] }],
    result: { tables: [{ name: 'assets', columns: ['Code'] }] },
    assistantDraft: {
      diagramSandbox: { source: 'obsolete', overrides: { roles: [] } },
      d2Authoring: {
        version: 1,
        source: 'server: Server',
        sourceHash: crypto.createHash('sha256').update('server: Server').digest('hex'),
        semanticModelRevision: 3,
        overrides: { semanticModelRevision: 3, roles: [] }
      }
    }
  };
  const stored = normalizeTemplateSpecForStorage(before);
  assert.equal(Object.hasOwn(stored, 'assistantDraft'), false);
  assert.deepEqual(stored.authoring, {
    version: 1,
    assistant: {
      objectFlowIntent: { context: '', blocks: [] },
      diagramInterpretPrompt: '',
      diagramMappingPrompt: ''
    },
    d2: {
      source: 'server: Server',
      sourceHash: crypto.createHash('sha256').update('server: Server').digest('hex')
    }
  });
});

test('D2 workflow accepts only canonical authoring source and matching deterministic mapping', async () => {
  const source = 'app: "Application"';
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  const semanticModelRevision = 11;
  const diagramId = 'd2_test';
  const structureHash = 'structure_test';
  const mappingContractHash = 'mapping_contract_test';
  const missingIdentity = {
    version: 1,
    authoring: { version: 1, assistant: {}, d2: { source } },
    result: { diagrams: [] }
  };
  assert.deepEqual(await d2WorkflowStatusForSpec(missingIdentity), {
    state: 'pending',
    reason: 'mapping_missing',
    sourceHash,
    appliedSourceHash: ''
  });
  const spec = {
    version: 1,
    authoring: {
      version: 1,
      assistant: { objectFlowIntent: { context: '', blocks: [] } },
      d2: {
        source,
        sourceHash
      }
    },
    result: {
      diagrams: [{
        name: 'topology',
        source: { nodes: 'published', edges: 'published' }
      }]
    }
  };
  assert.deepEqual(await d2WorkflowStatusForSpec(spec), {
    state: 'pending',
    reason: 'mapping_missing',
    sourceHash,
    appliedSourceHash: ''
  });

  spec.result.diagrams[0].authoring = {
    d2Import: {
      version: 3,
      sourceHash,
      source,
      semanticModelRevision,
      diagramId,
      structureHash,
      mappingContractHash,
      roles: [{ id: 'role:application' }],
      // A newly analyzed node is allowed to declare `stage` before the user
      // selects its Object Flow result. It is incomplete, not a retired
      // source-stage mapping.
      structureTree: { version: 5, items: [{ mapping: { materialization: { kind: 'stage', stageId: '' } } }] }
    }
  };
  assert.deepEqual(await d2WorkflowStatusForSpec(spec), {
    state: 'pending',
    reason: 'template_grammar_missing',
    sourceHash,
    appliedSourceHash: sourceHash
  });
  spec.result.diagrams[0].templateGrammar = { version: 3, elements: [], roles: [], contexts: [], edges: [], fingerprint: 'test' };
  assert.deepEqual(await d2WorkflowStatusForSpec(spec), {
    state: 'pending',
    reason: 'mapping_validation_required',
    sourceHash,
    appliedSourceHash: sourceHash
  });

  spec.authoring.d2.source = 'app: "Changed application"';
  assert.equal((await d2WorkflowStatusForSpec(spec)).state, 'pending');
  assert.equal((await d2WorkflowStatusForSpec(spec)).reason, 'source_changed');

  delete spec.authoring;
  assert.deepEqual(await d2WorkflowStatusForSpec(spec), {
    state: 'pending',
    reason: 'authoring_source_missing',
    sourceHash: '',
    appliedSourceHash: sourceHash
  });
});

test('template storage migrates old D2 source into canonical authoring and discards retired overrides', () => {
  const source = 'app: "Application"';
  const normalized = normalizeTemplateSpecForStorage({
    version: 1,
    assistantDraft: {
      d2Authoring: {
        version: 1,
        source,
        semanticModelRevision: 3,
        diagramId: 'old_diagram',
        sourceHash: 'stale_source_hash',
        structureHash: 'stale_structure_hash',
        overrides: {
          semanticModelRevision: 3,
          diagramId: 'old_diagram',
          sourceHash: 'stale_source_hash',
          structureHash: 'stale_structure_hash',
          roles: [],
          relationRules: []
        }
      }
    }
  });
  assert.equal(Object.hasOwn(normalized, 'assistantDraft'), false);
  const authoring = normalized.authoring;
  assert.equal(authoring.d2.sourceHash, crypto.createHash('sha256').update(source).digest('hex'));
  assert.equal(authoring.d2.source, source);
  assert.deepEqual(authoring.assistant.objectFlowIntent, { context: '', blocks: [] });
  assert.equal(authoring.assistant.diagramInterpretPrompt, '');
  assert.equal(authoring.assistant.diagramMappingPrompt, '');
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
  const warnings = [];
  assert.equal(
    renderRuntimeParamTemplate('Routers for ${param.city}', {}, warnings, 'diagram topology title'),
    'Routers for '
  );
  assert.deepEqual(warnings, ['Diagram template diagram topology title references unavailable parameter city.']);
});

test('diagram mapping templates resolve report parameters and keep missing values visible as warnings', () => {
  const diagram = buildResultDiagrams({
    version: 1,
    steps: [],
    result: {
      diagrams: [{
        name: 'parameterized',
        title: 'Topology for ${param.system}',
        nodeMappings: [{
          id: 'parameterized_node',
          from: 'nodes',
          fields: { id: 'Code', label: 'Description' },
          labelTemplate: '${Description} (${param.system})'
        }],
        edgeMappings: [{
          id: 'parameterized_edge',
          from: 'edges',
          fields: { source: 'Source', target: 'Target', label: 'Label' },
          labelTemplate: '${param.system}: ${Label}'
        }]
      }]
    }
  }, {
    nodes: { rows: [{ Code: 'srv-1', Description: 'Server 1' }, { Code: 'srv-2', Description: 'Server 2' }] },
    edges: { rows: [{ Source: 'srv-1', Target: 'srv-2', Label: 'HTTPS' }] }
  }, { system: 'billing' }, { maxRows: 100 })[0];

  assert.equal(diagram.title, 'Topology for billing');
  assert.equal(diagram.nodes[0].label, 'Server 1 (billing)');
  assert.equal(diagram.edges[0].label, 'billing: HTTPS');
  assert.deepEqual(diagram.warnings, []);

  const missing = buildResultDiagrams({
    version: 1,
    steps: [],
    result: {
      diagrams: [{
        name: 'missing-parameter',
        title: 'Topology ${param.system}',
        nodeMappings: [{
          id: 'missing_parameter_node',
          from: 'nodes',
          fields: { id: 'Code', label: 'Description' },
          labelTemplate: '${Description} ${param.system}'
        }]
      }]
    }
  }, { nodes: { rows: [{ Code: 'srv-1', Description: 'Server 1' }] } }, {}, { maxRows: 100 })[0];
  assert.equal(missing.title, 'Topology ');
  assert.equal(missing.nodes[0].label, 'Server 1');
  assert.match(missing.warnings.join('\n'), /unavailable parameter system/);
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
  assert.equal(runtimeD2OutputRequested(new URL('http://local/run?d2=true')), true);
  assert.equal(runtimeD2OutputRequested(new URL('http://local/run?d2=1')), true);
  assert.equal(runtimeD2OutputRequested(new URL('http://local/run?d2=false')), false);
});

test('publish D2 source flag is explicit and type-checked', () => {
  assert.deepEqual(validateTemplateSpec({
    version: 1,
    publish: { mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true, publicD2Source: true },
    steps: [{ type: 'selectCards', as: 'objects', className: 'Server' }],
    result: { tables: [{ name: 'objects', columns: ['Code'] }] }
  }), []);

  assert.deepEqual(validateTemplateSpec({
    version: 1,
    publish: { mode: 'staticSnapshot', paramsMode: 'exact', warningAccepted: true, publicD2Source: 'yes' },
    steps: [{ type: 'selectCards', as: 'objects', className: 'Server' }],
    result: { tables: [{ name: 'objects', columns: ['Code'] }] }
  }), [{ path: '$.publish.publicD2Source', message: 'Publish publicD2Source must be boolean.' }]);
});

test('D2 renderer is enabled by default and SVG sanitizer strips unsafe content', () => {
  const config = d2RendererConfigSummary();
  assert.equal(config.enabled, true);
  assert.equal(config.required, true);
  assert.equal(config.binary, '/usr/local/bin/d2');
  assert.equal(config.maxDiagrams, 8);
  assert.equal(config.concurrency, 2);
  assert.deepEqual(config.layoutAllowlist, ['dagre', 'elk']);
  assert.equal(d2CacheContext().d2.sourceBuilderVersion, 3);
  assert.equal(d2CacheContext().d2.markdownFrameRevision, 1);

  const sanitized = sanitizeD2Svg('<?xml version="1.0"?><svg onclick="alert(1)"><script>alert(1)</script><foreignObject><body>Bad</body></foreignObject><style>@import url(http://evil)</style><animate attributeName="x"></animate><image href="https://evil.local/a.png"></image><a href="javascript:alert(1)"><text>Bad</text></a><a href="ftp://evil.local/a"><text>FTP</text></a><a href="/cmdbuild/ui/#classes/Server/cards/1" style="fill:#111"><text>Good</text></a><text style="background:url(https://evil.local/a.png)">Styled</text></svg>');
  assert.match(sanitized, /^<svg data-cmdp-d2-rendered="true"/);
  assert.doesNotMatch(sanitized, /<script|onclick|javascript:|ftp:\/\/evil|foreignObject|<style|<animate|<image|https:\/\/evil|url\(/i);
  assert.match(sanitized, /href="\/cmdbuild\/ui\/#classes\/Server\/cards\/1"/);
  assert.match(sanitized, /style="fill:#111"/);

  const d2Markdown = sanitizeD2Svg('<svg data-d2-version="v0.7.1"><style type="text/css">.group_external { fill:#9FF6FF; stroke:#f503EB; } @font-face { src: url("data:application/font-woff;base64,QUJDRA=="); }</style><g class="group_external"><rect fill="#9FF6FF" stroke="#f503EB" /></g><foreignObject x="40" y="50" width="245" height="24"><div xmlns="http://www.w3.org/1999/xhtml" class="md" onclick="alert(1)"><p><strong>ИС LPS</strong> <code>192.168.5.0/24</code><img src="https://evil.local/a.png"></p></div></foreignObject></svg>');
  assert.match(d2Markdown, /<style type="text\/css">/);
  assert.match(d2Markdown, /#9FF6FF/);
  assert.match(d2Markdown, /#f503EB/);
  assert.match(d2Markdown, /<foreignObject x="40" y="50" width="245" height="24">/);
  assert.match(d2Markdown, /ИС LPS/);
  assert.match(d2Markdown, /192\.168\.5\.0\/24/);
  assert.doesNotMatch(d2Markdown, /onclick|<img|evil\.local|@import/i);

  const framedMarkdown = decorateD2MarkdownFrames(
    '<svg data-d2-version="v0.7.1"><g class="ZXh0ZXJuYWxfc3lzdGVtcy5scHM= external_system"><g class="shape"></g><g><foreignObject x="20" y="30" width="180" height="64"><div>ИС LPS</div></foreignObject></g></g></svg>',
    {
      elements: {
        nodes: [{
          key: 'external_systems.lps',
          kind: 'text',
          styleHints: { shape: 'text', style: { fill: '#EFF6FF', stroke: '#1D4ED8', 'stroke-width': '2', 'stroke-dash': '7', 'border-radius': '8' } }
        }]
      }
    }
  );
  assert.equal(framedMarkdown.decorated, 1);
  assert.match(framedMarkdown.content, /data-cmdp-d2-markdown-frame="true"/);
  assert.match(framedMarkdown.content, /fill="#EFF6FF" stroke="#1D4ED8" stroke-width="2" rx="8" stroke-dasharray="14,14" x="20" y="30" width="180" height="64"/);
  assert.doesNotMatch(framedMarkdown.content, /<g class="shape"><\/g>/);

  const unstyledMarkdown = decorateD2MarkdownFrames(
    '<svg><g class="ZXh0ZXJuYWxfc3lzdGVtcy5scHM= external_system"><g class="shape"></g><g><foreignObject x="20" y="30" width="180" height="64"><div>ИС LPS</div></foreignObject></g></g></svg>',
    { elements: { nodes: [{ key: 'external_systems.lps', kind: 'text', styleHints: { shape: 'text', style: { stroke: 'url(https://evil.local/a)' } } }] } }
  );
  assert.equal(unstyledMarkdown.decorated, 0);
  assert.doesNotMatch(unstyledMarkdown.content, /data-cmdp-d2-markdown-frame|evil\.local/);

  const embedded = embedDiagramSvgMetadata('<svg><text>Safe</text></svg>', '<metadata id="cmdp-diagram-data">{}</metadata>');
  assert.equal(embedded.embedded, true);
  assert.match(embedded.content, /^<svg><metadata id="cmdp-diagram-data">\{\}<\/metadata>/);
});

test('D2 import normalizes structural IR and exposes bounded helper configuration', () => {
  const config = d2ImportConfigSummary();
  assert.equal(config.binary, '/usr/local/bin/cmdp-d2-import');
  assert.equal(config.maxElements, 5000);
  assert.equal(config.templateRequestMaxBytes, 5767168);

  const ir = normalizeDiagramImportIr({
    source: { parserVersion: 'd2-0.7.1', lossless: true },
    template: { title: 'Network' },
    elements: {
      nodes: [{ id: 'router', label: 'Router', kind: 'router' }],
      edges: [{ id: 'uplink', source: 'router', target: 'switch', label: 'uplink' }],
      groups: [{ id: 'vlan', label: 'VLAN', children: ['router'] }],
      hierarchy: [{ id: 'contains', child: 'router', parent: 'vlan' }]
    }
  }, 'router -> switch');

  assert.equal(ir.version, 1);
  assert.equal(ir.template.title, 'Network');
  assert.equal(ir.elements.nodes[0].key, 'router');
  assert.equal(ir.elements.edges[0].sourceKey, 'router');
  assert.equal(ir.elements.hierarchies[0].parentKey, 'vlan');
  assert.equal(ir.elements.hierarchies[0].childKey, 'router');
  assert.deepEqual(ir.elements.groups[0].childrenKeys, ['router']);
  assert.match(ir.source.hash, /^[0-9a-f]{64}$/);
});

test('D2 mapping contract hash changes for Notes and direction policy without changing topology', () => {
  const source = 'source: Source\ntarget: Target\nsource -> target: Traffic';
  const base = {
    version: 4,
    elements: {
      nodes: [
        { id: 'source', label: 'Source', classKeys: ['system'] },
        { id: 'target', label: 'Target', classKeys: ['application'] }
      ],
      edges: [{ id: 'source_target', source: 'source', target: 'target', classKeys: ['acl'] }]
    },
    classes: [
      { key: 'system', usageKeys: ['source'] },
      { key: 'application', usageKeys: ['target'] },
      { key: 'acl', usageKeys: ['source_target'], notes: 'Build from ACL cards.', directionPolicy: 'dataFields' }
    ]
  };
  const noteChanged = structuredClone(base);
  noteChanged.classes[2].notes = 'Build from a dedicated ACL result.';
  const policyChanged = structuredClone(base);
  policyChanged.classes[2].directionPolicy = 'undirected';

  const baseIr = normalizeDiagramImportIr(base, source);
  const noteChangedIr = normalizeDiagramImportIr(noteChanged, source);
  const policyChangedIr = normalizeDiagramImportIr(policyChanged, source);

  assert.equal(noteChangedIr.source.structureHash, baseIr.source.structureHash);
  assert.equal(policyChangedIr.source.structureHash, baseIr.source.structureHash);
  assert.notEqual(noteChangedIr.source.mappingContractHash, baseIr.source.mappingContractHash);
  assert.notEqual(policyChangedIr.source.mappingContractHash, baseIr.source.mappingContractHash);
});

test('D2 renderer masks class Notes without treating braces in values as structure', () => {
  const source = [
    'classes: {',
    '  application: {',
    '    tooltip: "A quoted closing brace } is not structure"',
    '    # A comment with } is not structure either.',
    '    Notes: |md',
    '      Authoring note with a closing brace } and # Markdown text.',
    '    |',
    '    description: |md',
    '      This Markdown value must remain, including }.',
    '    |',
    '  }',
    '}',
    'app: Application { class: application }'
  ].join('\r\n');

  const compilerSource = d2SourceForCompiler(source);

  assert.equal(compilerSource.split(/\r?\n/).length, source.split(/\r?\n/).length);
  assert.doesNotMatch(compilerSource, /Authoring note/);
  assert.match(compilerSource, /This Markdown value must remain, including }\./);
  assert.match(compilerSource, /tooltip: "A quoted closing brace } is not structure"/);
  assert.match(compilerSource, /app: Application \{ class: application \}/);
});

test('D2 structure tree keeps placements from distinct ancestor contexts independent and normalizes node conditions', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = diagramImportStructureTree(proposal.structureTree, proposal.structure, proposal.roles);
  const vlanItems = tree.items.filter((item) => item.roleId === roles.vlan.id);
  const byId = new Map(tree.items.map((item) => [item.id, item]));

  assert.equal(tree.version, 5);
  assert.equal(vlanItems.length, 2);
  assert.notEqual(vlanItems[0].id, vlanItems[1].id);
  assert.notEqual(vlanItems[0].templateContextKey, vlanItems[1].templateContextKey);
  assert.notEqual(vlanItems[0].mapping.id, vlanItems[1].mapping.id);
  assert.deepEqual(vlanItems.map((item) => byId.get(item.parentId).templateElementKey).sort(), [
    'target.dmz.vlan_scope',
    'target.vlan_scope'
  ]);

  let staged = structureTreeItemWithSource(tree, vlanItems[0].id, 'selection:systemsA', {
    conditions: {
      ruleJoin: 'all',
      rules: [{
        action: 'include',
        op: 'equals',
        leftColumn: 'Description',
        rightStageId: 'selection:systemsB',
        rightColumn: 'Description'
      }]
    }
  });
  staged = structureTreeItemWithSource(staged, vlanItems[1].id, 'selection:systemsB');
  const normalized = diagramImportStructureTree(staged, proposal.structure, proposal.roles);
  const normalizedFirst = normalized.items.find((item) => item.id === vlanItems[0].id);
  assert.equal(normalizedFirst.mapping.materialization.stageId, 'selection:systemsA');
  assert.deepEqual(normalizedFirst.mapping.conditions, {
    ruleJoin: 'all',
    rules: [{
      id: normalizedFirst.mapping.conditions.rules[0].id,
      action: 'include',
      negate: false,
      operator: 'equals',
      caseSensitive: false,
      left: { column: 'Description', regex: '' },
      right: { kind: 'stage', value: '', name: '', stageId: 'selection:systemsB', column: 'Description', regex: '' }
    }]
  });
  assert.deepEqual(diagramImportStructureTreeErrors(staged, proposal.roles, currentSpec, proposal.structure), []);

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], staged);
  assert.equal(applied.result.diagrams[0].nodeMappings.length, 2);
  const conditionStep = applied.steps.find((step) => step.type === 'semiJoinRows' && step.managedBy === 'd2ImportV3');
  assert.ok(conditionStep);
  assert.deepEqual(executeSemiJoinRows(conditionStep, {}, {
    systemsA: { columns: ['Description'], rows: [{ Description: 'match' }, { Description: 'skip' }] },
    systemsB: { columns: ['Description'], rows: [{ Description: 'match' }] }
  }, { maxRows: 10 }).rows, [{ Description: 'match' }]);
});

test('D2 structure tree collapses sibling exemplars with the same role-path context', () => {
  const source = 'systems: { first: System second: System }';
  const proposal = createDiagramImportProposal(selectionFlowSpec([{ alias: 'systems', className: 'IS' }]), normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [{ id: 'systems', label: 'Systems', pathSegments: ['systems'] }],
      nodes: [
        { id: 'systems.first', label: 'First', parentKey: 'systems', classKeys: ['system'], pathSegments: ['systems', 'first'] },
        { id: 'systems.second', label: 'Second', parentKey: 'systems', classKeys: ['system'], pathSegments: ['systems', 'second'] }
      ]
    },
    classes: [{ key: 'system', usageKeys: ['systems.first', 'systems.second'] }]
  }, source), { sourceText: source });
  const role = proposal.roles.find((item) => item.key === 'system');
  const placements = proposal.structureTree.items.filter((item) => item.roleId === role.id);

  assert.deepEqual(role.elementKeys.sort(), ['systems.first', 'systems.second']);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].templateElementKey, 'systems.first');
  assert.deepEqual(placements[0].templateElementKeys, ['systems.first', 'systems.second']);
});

test('D2 structure tree permits an explicit duplicate only in the same template context', () => {
  const source = 'systems: { first: System second: System }';
  const currentSpec = selectionFlowSpec([{ alias: 'systems', className: 'IS' }]);
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [{ id: 'systems', label: 'Systems', pathSegments: ['systems'] }],
      nodes: [
        { id: 'systems.first', label: 'First', parentKey: 'systems', classKeys: ['system'], pathSegments: ['systems', 'first'] },
        { id: 'systems.second', label: 'Second', parentKey: 'systems', classKeys: ['system'], pathSegments: ['systems', 'second'] }
      ]
    },
    classes: [{ key: 'system', usageKeys: ['systems.first', 'systems.second'] }]
  }, source), { sourceText: source });
  const role = proposal.roles.find((item) => item.key === 'system');
  const tree = structureTreeWithStage(proposal.structureTree, role.id, 'selection:systems');
  const original = tree.items.find((item) => item.roleId === role.id);
  tree.items.push({
    ...structuredClone(original),
    id: 'structure:system-copy',
    mapping: { ...structuredClone(original.mapping), id: 'structure_mapping:system-copy' }
  });

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const systemMappings = applied.result.diagrams[0].nodeMappings.filter((mapping) => mapping.importRole.key === 'system');
  assert.equal(systemMappings.length, 2);
  assert.equal(new Set(systemMappings.map((mapping) => mapping.id)).size, 2);
  assert.ok(systemMappings.every((mapping) => mapping.from === 'systems'));
});

test('D2 structure tree accepts blank static containers and rejects node parents or cycles', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const valid = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  assert.deepEqual(diagramImportStructureTreeErrors(valid, proposal.roles, currentSpec, proposal.structure), []);

  const invalid = structuredClone(valid);
  const target = invalid.items.find((item) => item.templateElementKey === 'target');
  const vlan = invalid.items.find((item) => item.templateElementKey === 'target.dmz.vlan_scope.vlan');
  target.parentId = vlan.id;
  const errors = diagramImportStructureTreeErrors(invalid, proposal.roles, currentSpec, proposal.structure);
  assert.ok(errors.some((item) => item.message.includes('cannot contain children')));
  assert.ok(errors.some((item) => item.message.includes('containment cycle')));
});

test('D2 structure tree is preserved only for the exact source revision and legacy mappings fail closed', () => {
  const { currentSpec, source, ir, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const imported = {
    version: 3,
    semanticModelRevision: proposal.semanticModelRevision,
    sourceHash: ir.source.hash,
    structureHash: ir.source.structureHash,
    mappingContractHash: ir.source.mappingContractHash,
    roles: proposal.roles,
    relationRules: [],
    structureTree: tree
  };
  const saved = {
    ...currentSpec,
    result: { ...currentSpec.result, diagrams: [{ authoring: { d2Import: imported } }] }
  };

  const restored = createDiagramImportProposal(saved, ir, { sourceText: source });
  const restoredVlanItems = restored.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  assert.equal(restoredVlanItems.length, 2);
  assert.ok(restoredVlanItems.every((item) => item.mapping.materialization.stageId === 'selection:systemsA'));

  const changed = normalizeDiagramImportIr(ir, `${source}\n# revised`);
  const reanalyzed = createDiagramImportProposal(saved, changed, { sourceText: `${source}\n# revised` });
  assert.ok(reanalyzed.warnings.some((warning) => warning.includes('saved structure tree was not reused')));
  assert.ok(reanalyzed.structureTree.items.filter((item) => item.roleId === roles.vlan.id).every((item) => !item.mapping.materialization.stageId));

  const legacy = structuredClone(saved);
  delete legacy.result.diagrams[0].authoring.d2Import.structureTree;
  const rejectedLegacy = createDiagramImportProposal(legacy, ir, { sourceText: source });
  assert.ok(rejectedLegacy.warnings.some((warning) => warning.includes('retired placement model')));
});

test('D2 edge class direction policy is a typed contract, not an Assistant choice', () => {
  const source = 'source: Source\ntarget: Target\nsource -> target: Traffic';
  const proposal = createDiagramImportProposal(selectionFlowSpec([
    { alias: 'sources', className: 'IS' },
    { alias: 'targets', className: 'ApplicG' }
  ]), normalizeDiagramImportIr({
    version: 4,
    elements: {
      nodes: [
        { id: 'source', label: 'Source', classKeys: ['source'] },
        { id: 'target', label: 'Target', classKeys: ['target'] }
      ],
      edges: [{ id: 'source_target', source: 'source', target: 'target', label: 'Traffic', direction: '->', classKeys: ['acl'] }]
    },
    classes: [
      { key: 'source', usageKeys: ['source'] },
      { key: 'target', usageKeys: ['target'] },
      { key: 'acl', usageKeys: ['source_target'], directionPolicy: 'dataFields' }
    ]
  }, source), { sourceText: source });
  assert.equal(proposal.relationRules.length, 1);
  assert.equal(proposal.relationRules[0].directionPolicy, 'dataFields');
  assert.equal(proposal.unresolved.some((item) => item.fields && item.fields.includes('directionPolicy')), false);
});

test('D2 mapping source catalog retains intermediate Assistant results', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:systems',
      name: 'Информационные системы',
      alias: 'systems',
      className: 'IS',
      from: '',
      limit: 100,
      columns: ['Name'],
      rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
    }],
    operations: [{
      id: 'relation:systemsIpRanges',
      type: 'relation',
      from: 'systems',
      as: 'ipRanges',
      domain: 'ISZabbixMonitoringDomain',
      targetClass: 'ipRange',
      direction: 'source',
      columns: ['range'],
      limit: 100,
      distinct: true
    }],
    blocks: [],
    setOperations: [],
    publishedAlias: 'ipRanges'
  };
  const spec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow, {
    outputMetadata: [
      { alias: 'systems', label: 'Результат 1', assistantBlockId: 'block-1' },
      { alias: 'ipRanges', label: 'Результат 2', assistantBlockId: 'block-2' }
    ],
    assistantOutputManifest: {
      version: 1,
      blocks: [
        { id: 'block-1', name: 'Результат 1', order: 1 },
        { id: 'block-2', name: 'Результат 2', order: 2 }
      ]
    }
  });

  const stages = assistantObjectFlowDiagramStages(spec);
  assert.deepEqual(stages.map((stage) => stage.alias), ['systems', 'ipRanges']);
  assert.equal(stages.find((stage) => stage.alias === 'systems').className, 'IS');
  assert.equal(stages.find((stage) => stage.alias === 'ipRanges').className, 'ipRange');
  assert.deepEqual(stages.find((stage) => stage.alias === 'ipRanges').cardSources.map((source) => [source.className, source.classColumn, source.idColumn]), [
    ['ipRange', 'Class', '_id'],
    ['IS', 'SourceClass', 'SourceId']
  ]);
});

test('D2 preview keeps every retained source for a legacy deep condition and never guesses between them', () => {
  const stage = {
    columns: ['Class', '_id', 'SourceClass', 'SourceId', 'Source_SourceClass', 'Source_SourceId'],
    cardSources: [
      { id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Server' },
      { id: 'relation-source', className: 'IpAddress', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'IP address' },
      { id: 'Source_relation-source', className: 'ipRange', classColumn: 'Source_SourceClass', idColumn: 'Source_SourceId', label: 'Network' }
    ]
  };
  assert.deepEqual(
    diagramImportImplicitConditionSources(stage, '{Vlan2super:vlan}.isNAT').map((source) => source.className),
    ['phServer', 'IpAddress', 'ipRange']
  );
  assert.equal(diagramImportInferImplicitConditionSource(stage, '{Vlan2super:vlan}.isNAT'), null);
  const onlySource = { ...stage, cardSources: [stage.cardSources[2]] };
  assert.deepEqual(
    diagramImportInferImplicitConditionSource(onlySource, '{Vlan2super:vlan}.isNAT'),
    stage.cardSources[2]
  );
});

test('D2 nested match projects the retained child card instead of its parent card', () => {
  const stage = {
    className: 'phServer',
    cardSources: [
      { id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Физический сервер' },
      { id: 'relation-source', className: 'ApplicG', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Приложение' },
      { id: 'Source_relation-source', className: 'IpAddress', classColumn: 'Source_SourceClass', idColumn: 'Source_SourceId', label: 'IP-адрес' }
    ]
  };
  const projection = diagramImportPrimaryCardSource(stage, { className: 'phServer' }, { className: 'phServer' });

  assert.equal(projection.ambiguous, false);
  assert.equal(projection.inferred, true);
  assert.equal(projection.source.className, 'ApplicG');
  assert.equal(projection.source.idColumn, 'SourceId');
  assert.equal(diagramImportCardSourceField(projection.source, '_id'), 'SourceId');
  assert.equal(diagramImportCardSourceField(projection.source, 'Description'), 'SourceDescription');
});

test('D2 direct retained relation source restores an assistant hierarchy correlation to the parent card', () => {
  const sourceStage = {
    id: 'match:applicationsServers',
    className: 'phServer',
    cardSources: [
      { id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Сервер' },
      { id: 'relation-source', className: 'ApplicG', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Приложение' }
    ]
  };
  const parentStage = {
    id: 'relation:servers',
    className: 'phServer',
    cardSources: [{ id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Сервер' }]
  };
  const repaired = diagramImportDirectRelationParentCorrelation({
    primary: { className: 'vServer' },
    hierarchyConditions: {
      ruleJoin: 'any',
      rules: [{
        origin: 'assistant',
        action: 'include',
        operator: 'equals',
        left: { column: 'phs.Id' },
        right: { kind: 'stage', stageId: 'relation:servers', column: '_id' }
      }]
    }
  }, sourceStage, parentStage, 'application-placement');

  assert.equal(repaired.changed, true);
  assert.equal(repaired.correlationChanged, true);
  assert.equal(repaired.mapping.primary.className, 'ApplicG');
  assert.equal(repaired.mapping.primary.cardSource.id, 'relation-source');
  assert.equal(repaired.mapping.hierarchyConditions.rules[0].left.column, '_id');
  assert.equal(repaired.mapping.hierarchyConditions.rules[0].right.stageId, 'relation:servers');
  assert.equal(repaired.mapping.hierarchyConditions.rules[0].right.column, '_id');
});

test('D2 filter rows preserve source-resolution diagnostics for preview bindings', () => {
  const result = executeFilterRows({
    from: 'enriched',
    filters: [{ action: 'include', column: 'isNAT', op: 'equals', value: true }]
  }, {}, {
    enriched: {
      columns: ['isNAT'],
      rows: [{ isNAT: false }],
      sourceResolution: { resolved: 0, equivalent: 0, ambiguous: 1, unavailable: 0 }
    }
  }, { maxRows: 20 });
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.sourceResolution, { resolved: 0, equivalent: 0, ambiguous: 1, unavailable: 0 });
});

test('D2 placements reject legacy related CMDB traversal mappings', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const vlanItems = proposal.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  let tree = structureTreeItemWithSource(proposal.structureTree, vlanItems[0].id, 'selection:systemsA', {
    related: [{
      id: 'related_network',
      className: 'ipRange',
      path: [{ kind: 'domain', name: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' }],
      structuredFields: ['range']
    }]
  });
  tree = structureTreeItemWithSource(tree, vlanItems[1].id, 'selection:systemsA', {
    related: [{
      id: 'related_network',
      className: 'ipRange',
      path: [{ kind: 'domain', name: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' }],
      structuredFields: ['range']
    }]
  });
  assert.throws(
    () => applyDiagramImportProposal(currentSpec, proposal, [], [], tree),
    (error) => error && error.code === 'diagram_import_unresolved'
  );
});

test('D2 mapping keeps its signed executable inputs on reload and ignores a prompt change', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const appliedImport = applied.result.diagrams[0].authoring.d2Import;

  assert.equal(appliedImport.mappingInputRevision.version, 2);
  assert.equal(diagramImportMappingValidationIsCurrent(appliedImport), true);
  assert.deepEqual(await d2WorkflowStatusForSpec(applied), {
    state: 'applied',
    sourceHash: appliedImport.sourceHash,
    diagramId: appliedImport.diagramId,
    roles: appliedImport.roles.length
  });

  const reloaded = normalizeTemplateSpecForStorage(applied);
  assert.equal(reloaded.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'valid');
  assert.equal(diagramImportMappingValidationIsCurrent(reloaded.result.diagrams[0].authoring.d2Import), true);

  const promptChanged = structuredClone(applied);
  promptChanged.authoring.assistant.diagramMappingPrompt = 'Измененный mapping prompt';
  const reviewed = normalizeTemplateSpecForStorage(promptChanged);
  const reviewedImport = reviewed.result.diagrams[0].authoring.d2Import;
  assert.equal(reviewedImport.mappingValidation.status, 'valid');
  assert.equal(diagramImportMappingValidationIsCurrent(reviewedImport), true);
  assert.equal((await d2WorkflowStatusForSpec(reviewed)).state, 'applied');
});

test('normal template Save rebases the retained D2 checkpoint after mapping materialization', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const beforeMaterializationHash = proposal.deterministicSpecHash;
  applied.authoring.d2.analysisCheckpoint = {
    version: 1,
    proposalId: proposal.proposalId,
    deterministicSpecHash: beforeMaterializationHash,
    source: {
      hash: proposal.source.hash,
      structureHash: proposal.source.structureHash,
      mappingContractHash: proposal.source.mappingContractHash
    },
    roles: proposal.roles.map((role) => ({ id: role.id, visualKind: role.visualKind, labelTemplate: role.labelTemplate })),
    relationRules: proposal.relationRules,
    structureTree: proposal.structureTree
  };

  const stored = normalizeTemplateSpecForStorage(applied);
  const checkpoint = stored.authoring.d2.analysisCheckpoint;
  assert.notEqual(diagramImportDeterministicSpecHash(applied), beforeMaterializationHash);
  assert.equal(checkpoint.deterministicSpecHash, diagramImportDeterministicSpecHash(stored));
  assert.equal(checkpoint.source.hash, stored.result.diagrams[0].authoring.d2Import.sourceHash);
});

test('normal template Save rebases a checkpoint for a provisional D2 analysis diagram only', () => {
  const { currentSpec, proposal } = d2StructureTreeFixture();
  const checkpoint = {
    version: 1,
    proposalId: proposal.proposalId,
    deterministicSpecHash: proposal.deterministicSpecHash,
    source: {
      hash: proposal.source.hash,
      structureHash: proposal.source.structureHash,
      mappingContractHash: proposal.source.mappingContractHash
    },
    roles: proposal.roles.map((role) => ({ id: role.id, visualKind: role.visualKind, labelTemplate: role.labelTemplate })),
    relationRules: proposal.relationRules,
    structureTree: proposal.structureTree
  };
  const provisional = {
    ...currentSpec,
    result: {
      ...currentSpec.result,
      diagrams: [{
        id: 'diagram_provisional',
        name: 'topology',
        type: 'topology',
        authoring: {
          d2Import: {
            version: 3,
            source: proposal.sourceText,
            sourceHash: proposal.source.hash,
            structureHash: proposal.source.structureHash,
            mappingContractHash: proposal.source.mappingContractHash,
            roles: proposal.roles,
            relationRules: proposal.relationRules,
            structureTree: proposal.structureTree,
            mappingValidation: { version: 1, status: 'needsReview', reasons: ['inputRevision'] }
          }
        }
      }]
    },
    authoring: {
      version: 1,
      assistant: { objectFlowIntent: { context: '', blocks: [] }, diagramInterpretPrompt: '', diagramMappingPrompt: '' },
      d2: { source: proposal.sourceText, analysisCheckpoint: checkpoint }
    }
  };

  const stored = normalizeTemplateSpecForStorage(provisional);
  assert.equal(
    stored.authoring.d2.analysisCheckpoint.deterministicSpecHash,
    diagramImportDeterministicSpecHash(stored),
    JSON.stringify({
      status: stored.result.diagrams[0].authoring.d2Import.mappingValidation.status,
      reasons: stored.result.diagrams[0].authoring.d2Import.mappingValidation.reasons,
      sourceHash: stored.result.diagrams[0].authoring.d2Import.sourceHash,
      checkpointHash: stored.authoring.d2.analysisCheckpoint.deterministicSpecHash,
      currentHash: diagramImportDeterministicSpecHash(stored)
    })
  );
  assert.equal(stored.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'needsReview');
});

test('normal Save keeps retired D2 mapping revisions pending re-analysis', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const signedVersion = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const historicVersion = structuredClone(signedVersion);
  const versionImport = historicVersion.result.diagrams[0].authoring.d2Import;

  // Simulate the immediately previous persisted revision: it had a verified
  // mapping but predated the current placement representation and input stamp.
  // Its placement IDs are deliberately different from the current source tree.
  const legacyIds = new Map(versionImport.structureTree.items.map((item, index) => [item.id, `legacy_item_${index + 1}`]));
  versionImport.structureTree.items = versionImport.structureTree.items.map((item) => ({
    ...item,
    id: legacyIds.get(item.id),
    parentId: item.parentId ? legacyIds.get(item.parentId) : ''
  }));
  versionImport.semanticModelRevision = 8;
  versionImport.structureTree.version = 3;
  delete versionImport.mappingInputRevision;
  versionImport.mappingValidation = {
    version: 1,
    status: 'valid',
    signature: signDiagramImportMappingValidation(versionImport)
  };
  assert.equal(diagramImportMappingValidationIsCurrent(versionImport), true);

  const lostMarker = structuredClone(historicVersion);
  const lostImport = lostMarker.result.diagrams[0].authoring.d2Import;
  lostImport.mappingValidation = { version: 1, status: 'needsValidation' };
  const identity = {
    ok: true,
    sourceHash: signedVersion.result.diagrams[0].authoring.d2Import.sourceHash,
    structureHash: signedVersion.result.diagrams[0].authoring.d2Import.structureHash,
    mappingContractHash: signedVersion.result.diagrams[0].authoring.d2Import.mappingContractHash,
    ir: {
      source: { parser: signedVersion.result.diagrams[0].authoring.d2Import.parser },
      template: signedVersion.result.diagrams[0].authoring.d2Import.template,
      elements: signedVersion.result.diagrams[0].authoring.d2Import.structure,
      classes: signedVersion.result.diagrams[0].authoring.d2Import.classes
    }
  };

  assert.equal(migrateDiagramImportToCurrentRevision(lostMarker, versionImport, {
    diagramId: versionImport.diagramId
  }), null, 'A retained legacy tree must never be promoted without a fresh D2 identity.');

  const recovered = normalizeTemplateSpecForStorage(lostMarker, '', {
    recoveryVersions: [{ version: 53, spec: historicVersion }],
    d2SourceIdentities: [identity]
  });
  const recoveredImport = recovered.result.diagrams[0].authoring.d2Import;
  assert.equal(recoveredImport.semanticModelRevision, 8);
  assert.equal(recoveredImport.structureTree.version, 3);
  assert.equal(recoveredImport.mappingValidation.status, 'needsReview');
  assert.equal(diagramImportMappingValidationIsCurrent(recoveredImport), false);
  assert.equal((await d2WorkflowStatusForSpec(recovered)).state, 'pending');

  const changedPrompt = structuredClone(lostMarker);
  changedPrompt.authoring.assistant.diagramInterpretPrompt = 'Новый prompt без повторного mapping';
  const notRecovered = normalizeTemplateSpecForStorage(changedPrompt, '', {
    recoveryVersions: [{ version: 53, spec: historicVersion }],
    d2SourceIdentities: [identity]
  });
  assert.equal(notRecovered.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'needsReview');
});

test('retired D2 source-stage mappings require an explicit current materialization', () => {
  const source = 'users: { dns: DNS { class: system }; ad: AD { class: system } }';
  const currentSpec = selectionFlowSpec([{ alias: 'internalSystems', className: 'IS', columns: ['_id', 'Description'] }]);
  currentSpec.authoring = { d2: { source } };
  const ir = normalizeDiagramImportIr({
    version: 3,
    elements: {
      groups: [{ id: 'users', label: 'Users', pathSegments: ['users'] }],
      nodes: [
        { id: 'users.dns', label: 'DNS', parentKey: 'users', classKeys: ['system'], pathSegments: ['users', 'dns'] },
        { id: 'users.ad', label: 'AD', parentKey: 'users', classKeys: ['system'], pathSegments: ['users', 'ad'] }
      ]
    },
    classes: [{ key: 'system', usageKeys: ['users.dns', 'users.ad'] }]
  }, source);
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: source });
  const groupRole = proposal.roles.find((role) => role.key === 'users');
  const systemRole = proposal.roles.find((role) => role.key === 'system');
  assert.ok(groupRole);
  assert.ok(systemRole);
  const groupItem = proposal.structureTree.items.find((item) => item.roleId === groupRole.id);
  const systemItem = proposal.structureTree.items.find((item) => item.roleId === systemRole.id);
  const legacyMapping = structuredClone(systemItem.mapping);
  delete legacyMapping.materialization;
  legacyMapping.source = { stageId: 'selection:internalSystems', alias: 'internalSystems', kind: 'selection', className: 'IS' };
  const legacy = {
    ...structuredClone(proposal),
    source,
    sourceHash: proposal.source.hash,
    structureHash: proposal.source.structureHash,
    mappingContractHash: proposal.source.mappingContractHash,
    parser: proposal.source.parser,
    semanticModelRevision: 8,
    structureTree: {
      version: 3,
      items: [
        { id: 'legacy-users', roleId: groupRole.id, templateElementKey: groupItem.templateElementKey, parentId: '', mapping: { ...structuredClone(groupItem.mapping), materialization: undefined, source: { stageId: '', alias: '', kind: '', className: '' } } },
        { id: 'legacy-dns', roleId: systemRole.id, templateElementKey: 'users.dns', parentId: 'legacy-users', mapping: structuredClone(legacyMapping) },
        { id: 'legacy-ad', roleId: systemRole.id, templateElementKey: 'users.ad', parentId: 'legacy-users', mapping: structuredClone(legacyMapping) }
      ]
    }
  };
  const identity = {
    ok: true,
    sourceHash: proposal.source.hash,
    structureHash: proposal.source.structureHash,
    mappingContractHash: proposal.source.mappingContractHash,
    ir
  };
  const migrationDiagnostics = [];
  const migrated = migrateDiagramImportToCurrentRevision(currentSpec, legacy, { diagramId: proposal.diagramId, identity, diagnostics: migrationDiagnostics });
  assert.equal(migrated, null);
  assert.ok(migrationDiagnostics.includes('materializationRevisionRequired'));
});

test('normal Save keeps a retired D2 source-stage mapping pending explicit review', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const currentTree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], currentTree);
  const retired = structuredClone(applied);
  const retiredImport = retired.result.diagrams[0].authoring.d2Import;
  retiredImport.semanticModelRevision = 9;
  retiredImport.structureTree = {
    version: 4,
    items: retiredImport.structureTree.items.map((item) => {
      const mapping = structuredClone(item.mapping || {});
      const materialization = mapping.materialization || {};
      mapping.source = {
        stageId: String(materialization.stageId || ''),
        alias: String(materialization.stageId || '').replace(/^selection:/, ''),
        kind: materialization.stageId ? 'selection' : '',
        className: materialization.stageId ? 'IS' : ''
      };
      delete mapping.materialization;
      return { ...item, mapping };
    })
  };
  retiredImport.mappingValidation = { version: 1, status: 'needsReview' };
  const identity = {
    ok: true,
    sourceHash: retiredImport.sourceHash,
    structureHash: retiredImport.structureHash,
    mappingContractHash: retiredImport.mappingContractHash,
    ir: {
      source: { parser: retiredImport.parser },
      template: retiredImport.template,
      elements: retiredImport.structure,
      classes: retiredImport.classes
    }
  };

  const migrated = normalizeTemplateSpecForStorage(retired, '', { d2SourceIdentities: [identity] });
  const migratedImport = migrated.result.diagrams[0].authoring.d2Import;
  assert.equal(migratedImport.semanticModelRevision, 9);
  assert.equal(migratedImport.structureTree.version, 4);
  assert.equal(migratedImport.mappingValidation.status, 'needsReview');
  assert.equal(diagramImportMappingValidationIsCurrent(migratedImport), false);
  assert.equal((await d2WorkflowStatusForSpec(migrated)).state, 'pending');
});

test('normal Save reattests a current D2 mapping after signing-secret rotation', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA'));
  const stale = structuredClone(applied);
  const staleImport = stale.result.diagrams[0].authoring.d2Import;
  staleImport.mappingValidation.signature = 'stale-signature';
  const identity = {
    ok: true,
    sourceHash: staleImport.sourceHash,
    structureHash: staleImport.structureHash,
    mappingContractHash: staleImport.mappingContractHash,
    ir: {
      source: { parser: staleImport.parser },
      template: staleImport.template,
      elements: staleImport.structure,
      classes: staleImport.classes
    }
  };

  const reattested = normalizeTemplateSpecForStorage(stale, '', { d2SourceIdentities: [identity] });
  const reattestedImport = reattested.result.diagrams[0].authoring.d2Import;

  assert.equal(reattestedImport.semanticModelRevision, 11);
  assert.equal(reattestedImport.structureTree.version, 5);
  assert.equal(reattestedImport.mappingValidation.status, 'valid');
  assert.equal(diagramImportMappingValidationIsCurrent(reattestedImport), true);
  assert.equal((await d2WorkflowStatusForSpec(reattested)).state, 'applied');
});

test('normal Save does not recompile a retired D2 mapping after signing-secret rotation', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA'));
  const historicalVersion = structuredClone(applied);
  const historicImport = historicalVersion.result.diagrams[0].authoring.d2Import;
  historicImport.semanticModelRevision = 8;
  historicImport.structureTree.version = 3;
  historicImport.diagramId = '';
  delete historicImport.mappingInputRevision;
  // This shape represents a mapping saved before the server's signing secret
  // was rotated. It is never accepted as runtime validation by itself.
  historicImport.mappingValidation = { version: 1, status: 'valid', signature: 'a'.repeat(64) };

  const current = structuredClone(historicalVersion);
  current.result.diagrams[0].authoring.d2Import.mappingValidation = { version: 1, status: 'needsReview', reasons: ['inputRevision'] };
  const currentImport = current.result.diagrams[0].authoring.d2Import;
  const identity = {
    ok: true,
    sourceHash: applied.result.diagrams[0].authoring.d2Import.sourceHash,
    structureHash: applied.result.diagrams[0].authoring.d2Import.structureHash,
    mappingContractHash: applied.result.diagrams[0].authoring.d2Import.mappingContractHash,
    ir: {
      source: { parser: applied.result.diagrams[0].authoring.d2Import.parser },
      template: applied.result.diagrams[0].authoring.d2Import.template,
      elements: applied.result.diagrams[0].authoring.d2Import.structure,
      classes: applied.result.diagrams[0].authoring.d2Import.classes
    }
  };

  const recovered = normalizeTemplateSpecForStorage(current, '', {
    recoveryVersions: [{ version: 53, spec: historicalVersion }],
    d2SourceIdentities: [identity]
  });
  assert.equal(recovered.result.diagrams[0].authoring.d2Import.semanticModelRevision, 8);
  assert.equal(recovered.result.diagrams[0].authoring.d2Import.structureTree.version, 3);
  assert.equal(recovered.result.diagrams[0].authoring.d2Import.diagramId, '');
  assert.equal(diagramImportMappingValidationIsCurrent(recovered.result.diagrams[0].authoring.d2Import), false);
  assert.equal(recovered.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'needsReview');

  const unsupportedVersion = structuredClone(historicalVersion);
  unsupportedVersion.result.diagrams[0].authoring.d2Import.semanticModelRevision = 7;
  const blocked = normalizeTemplateSpecForStorage(current, '', {
    recoveryVersions: [{ version: 52, spec: unsupportedVersion }],
    d2SourceIdentities: [identity]
  });
  assert.equal(blocked.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'needsReview');
  assert.equal(currentImport.mappingValidation.status, 'needsReview');
});

test('normal Save does not collapse retired placements into a current structure tree', () => {
  const currentSpec = selectionFlowSpec([{ alias: 'systems', className: 'IS', columns: ['Code', 'Description'] }]);
  const source = 'target: { left: Left; right: Right }';
  const ir = normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [{ id: 'target', label: 'Target', classKeys: ['scope'], pathSegments: ['target'] }],
      nodes: [
        { id: 'target.left', label: 'Left', parentKey: 'target', classKeys: ['system'], pathSegments: ['target', 'left'] },
        { id: 'target.right', label: 'Right', parentKey: 'target', classKeys: ['system'], pathSegments: ['target', 'right'] }
      ]
    },
    classes: [
      { key: 'scope', usageKeys: ['target'] },
      { key: 'system', usageKeys: ['target.left', 'target.right'] }
    ]
  }, source);
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: source });
  const systemRole = proposal.roles.find((role) => role.key === 'system');
  const mergedItem = proposal.structureTree.items.find((item) => item.roleId === systemRole.id);
  assert.deepEqual(mergedItem.templateElementKeys, ['target.left', 'target.right']);
  const tree = structureTreeWithStage(proposal.structureTree, systemRole.id, 'selection:systems');
  const applied = applyDiagramImportProposal({
    ...currentSpec,
    authoring: {
      version: 1,
      assistant: { objectFlowIntent: { context: '', blocks: [] }, diagramInterpretPrompt: '', diagramMappingPrompt: '' },
      d2: { source }
    }
  }, proposal, [], [], tree);
  const historicalVersion = structuredClone(applied);
  const historicImport = historicalVersion.result.diagrams[0].authoring.d2Import;
  const historicMergedItem = historicImport.structureTree.items.find((item) => item.roleId === systemRole.id);
  historicImport.structureTree.items = historicImport.structureTree.items.flatMap((item) => {
    if (item.id !== historicMergedItem.id) return [item];
    return item.templateElementKeys.map((templateElementKey, index) => {
      const split = structuredClone(item);
      split.id = `legacy_system_${index + 1}`;
      split.templateElementKey = templateElementKey;
      delete split.templateElementKeys;
      return split;
    });
  });
  historicImport.semanticModelRevision = 8;
  historicImport.structureTree.version = 3;
  delete historicImport.mappingInputRevision;
  historicImport.mappingValidation = {
    version: 1,
    status: 'valid',
    signature: signDiagramImportMappingValidation(historicImport)
  };
  const current = structuredClone(historicalVersion);
  current.result.diagrams[0].authoring.d2Import.mappingValidation = { version: 1, status: 'needsValidation' };
  const recovered = normalizeTemplateSpecForStorage(current, '', {
    recoveryVersions: [{ version: 53, spec: historicalVersion }],
    d2SourceIdentities: [{
      ok: true,
      sourceHash: applied.result.diagrams[0].authoring.d2Import.sourceHash,
      structureHash: applied.result.diagrams[0].authoring.d2Import.structureHash,
      mappingContractHash: applied.result.diagrams[0].authoring.d2Import.mappingContractHash,
      ir
    }]
  });
  const recoveredImport = recovered.result.diagrams[0].authoring.d2Import;
  assert.equal(recoveredImport.structureTree.items.filter((item) => item.roleId === systemRole.id).length, 2);
  assert.equal(recoveredImport.mappingValidation.status, 'needsReview');
  assert.equal(diagramImportMappingValidationIsCurrent(recoveredImport), false);
});

test('D2 container labels use exactly one direct child value and materialize related child fields', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const scopeItems = tree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  scopeItems.forEach((scope) => {
    const child = tree.items.find((item) => item.parentId === scope.id && item.roleId === roles.vlan.id);
    assert.ok(child);
    const primaryToken = 'child:' + child.id + ':primary:Code';
    scope.mapping.primary.labelTemplate = 'VLAN ' + '$' + '{' + primaryToken + '}';
  });

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const exact = buildResultDiagrams(applied, {
    systemsA: { rows: [{ _id: 101, Code: 'VLAN-A', Description: 'VLAN A' }] }
  }, {}, { maxRows: 100 })[0];
  const scopeLabels = exact.groups
    .filter((group) => group.importRole && group.importRole.key === 'scope-vlan')
    .map((group) => group.label);
  assert.deepEqual(scopeLabels, ['VLAN VLAN-A', 'VLAN VLAN-A']);
  assert.equal(exact.warnings.some((warning) => /expected exactly one direct child card/.test(warning)), false);
  const malformedTree = structuredClone(tree);
  malformedTree.items.find((item) => item.roleId === roles['scope-vlan'].id).mapping.primary.labelTemplate = 'VLAN ' + '$' + '{Code';
  assert.ok(diagramImportStructureTreeErrors(malformedTree, proposal.roles, currentSpec, proposal.structure).some((error) => /unterminated placeholder/.test(error.message)));

  const multiple = buildResultDiagrams(applied, {
    systemsA: { rows: [
      { _id: 101, Code: 'VLAN-A', Description: 'VLAN A' },
      { _id: 102, Code: 'VLAN-B', Description: 'VLAN B' }
    ] }
  }, {}, { maxRows: 100 })[0];
  assert.deepEqual(
    multiple.groups.filter((group) => group.importRole && group.importRole.key === 'scope-vlan').map((group) => group.label),
    ['VLAN', 'VLAN']
  );
  assert.ok(multiple.warnings.some((warning) => /expected exactly one direct child card, received 2/.test(warning)));

  tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const relatedSignature = 'stage:selection:systemsB:binding:related_network';
  tree.items.filter((item) => item.roleId === roles.vlan.id).forEach((child) => {
    child.mapping.related = [{
      id: 'related_network',
      stageId: 'selection:systemsB',
      structuredFields: ['Description'],
      conditions: {
        ruleJoin: 'all',
        rules: [{
          id: 'same-code', action: 'include', negate: false, operator: 'equals',
          left: { column: 'Code' },
          right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
        }]
      }
    }];
  });
  scopeItems.forEach((originalScope) => {
    const scope = tree.items.find((item) => item.id === originalScope.id);
    const child = tree.items.find((item) => item.parentId === scope.id && item.roleId === roles.vlan.id);
    const relatedToken = 'child:' + child.id + ':related:' + encodeURIComponent(relatedSignature) + ':Description';
    scope.mapping.primary.labelTemplate = 'Network ' + '$' + '{' + relatedToken + '}';
  });
  const relatedApplied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const relatedContext = {
    systemsA: { rows: [{ _id: 101, Code: 'VLAN-A', Description: 'VLAN A' }] }
  };
  relatedApplied.result.diagrams[0].nodeMappings.forEach((mapping) => {
    const binding = mapping.relatedBindings[0];
    relatedContext[binding.alias] = { rows: [{ _id: 201, Code: 'VLAN-A', Description: '10.10.0.0/24' }] };
  });
  const relatedExact = buildResultDiagrams(relatedApplied, relatedContext, {}, { maxRows: 100 })[0];
  assert.deepEqual(
    relatedExact.groups.filter((group) => group.importRole && group.importRole.key === 'scope-vlan').map((group) => group.label),
    ['Network 10.10.0.0/24', 'Network 10.10.0.0/24']
  );

  relatedApplied.result.diagrams[0].nodeMappings.forEach((mapping) => {
    const binding = mapping.relatedBindings[0];
    relatedContext[binding.alias] = { rows: [
      { _id: 201, Code: 'VLAN-A', Description: '10.10.0.0/24' },
      { _id: 202, Code: 'VLAN-A', Description: '10.20.0.0/24' }
    ] };
  });
  const relatedMultiple = buildResultDiagrams(relatedApplied, relatedContext, {}, { maxRows: 100 })[0];
  assert.deepEqual(
    relatedMultiple.groups.filter((group) => group.importRole && group.importRole.key === 'scope-vlan').map((group) => group.label),
    ['Network', 'Network']
  );
  assert.ok(relatedMultiple.warnings.some((warning) => /expected exactly one value, received 2/.test(warning)));
});

test('D2 related Object Flow results require explicit correlation and preserve every matching card', () => {
  const spec = {
    version: 1,
    steps: [],
    result: {
      diagrams: [{
        name: 'related-stage',
        nodeMappings: [{
          id: 'systems',
          from: 'systems',
          fields: { id: '_id', label: 'Code' },
          labelTemplate: '${related_stage.Description}',
          dataProfile: { className: 'IS', fields: ['related_stage.Description'] },
          relatedBindings: [{
            id: 'related_stage',
            mode: 'stage',
            alias: 'systemsB',
            className: 'IS',
            labelValueMode: 'single',
            structuredFields: ['Description'],
            conditions: {
              ruleJoin: 'all',
              rules: [{
                action: 'include',
                negate: false,
                operator: 'equals',
                left: { column: 'Code' },
                right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
              }]
            }
          }]
        }]
      }]
    }
  };
  const diagrams = buildResultDiagrams(spec, {
    systems: { rows: [{ _id: 1, Code: 'IS-A' }] },
    systemsB: { rows: [
      { _id: 11, Code: 'IS-A', Description: 'Related A' },
      { _id: 12, Code: 'IS-A', Description: 'Related B' },
      { _id: 13, Code: 'IS-B', Description: 'Unrelated' }
    ] }
  }, {}, { maxRows: 100 });
  const node = diagrams[0].nodes[0];
  assert.deepEqual(node.data.fields['related_stage.Description'].value, ['Related A', 'Related B']);
  assert.equal(node.label, 'IS-A', 'A single-value label rule must not pick or join multiple related cards.');
  assert.ok(diagrams[0].warnings.some((warning) => /related_stage\.Description.*returned 2 values/.test(warning)));

  const joined = structuredClone(spec);
  joined.result.diagrams[0].nodeMappings[0].relatedBindings[0].labelValueMode = 'join';
  joined.result.diagrams[0].nodeMappings[0].relatedBindings[0].labelSeparator = ' / ';
  const joinedNode = buildResultDiagrams(joined, {
    systems: { rows: [{ _id: 1, Code: 'IS-A' }] },
    systemsB: { rows: [
      { _id: 11, Code: 'IS-A', Description: 'Related A' },
      { _id: 12, Code: 'IS-A', Description: 'Related B' }
    ] }
  }, {}, { maxRows: 100 })[0].nodes[0];
  assert.equal(joinedNode.label, 'Related A / Related B');
});

test('D2 placement compiles a related Object Flow result without an implicit traversal', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  tree.items.filter((item) => String(item.roleId) === String(roles.vlan.id)).forEach((item) => {
    item.mapping.related = [{
      id: 'related_system_stage',
      stageId: 'selection:systemsB',
      labelValueMode: 'single',
      labelSeparator: ', ',
      structuredFields: ['Description'],
      conditions: {
        ruleJoin: 'all',
        rules: [{
          id: 'same-code', action: 'include', negate: false, operator: 'equals',
          left: { column: 'Code' },
          right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
        }]
      }
    }];
  });
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const bindings = applied.result.diagrams[0].nodeMappings.flatMap((mapping) => mapping.relatedBindings || []);
  assert.ok(bindings.length > 0);
  assert.ok(bindings.every((binding) => binding.alias === 'systemsB'));
  assert.ok(bindings.every((binding) => !binding.rootIdField));
  assert.equal(applied.steps.some((step) => String(step.as || '').startsWith('d2_related_')), false, 'A stage source must not synthesize a traversal.');
});

test('D2 import deterministic revision ignores Assistant prompts but not template schema', () => {
  const { currentSpec, proposal } = d2StructureTreeFixture();
  const promptOnly = structuredClone(currentSpec);
  promptOnly.authoring = {
    version: 1,
    assistant: {
      objectFlowIntent: { context: 'Prompt context', blocks: [] },
      diagramInterpretPrompt: 'Interpret the D2 template.',
      diagramMappingPrompt: 'Map deterministic stages.'
    },
    d2: { source: 'target: Target' }
  };
  const changedSchema = structuredClone(currentSpec);
  changedSchema.steps[0].columns = ['Code', 'Description', 'Location'];

  assert.equal(proposal.deterministicSpecHash, diagramImportDeterministicSpecHash(currentSpec));
  assert.equal(diagramImportDeterministicSpecHash(promptOnly), diagramImportDeterministicSpecHash(currentSpec));
  assert.notEqual(diagramImportDeterministicSpecHash(changedSchema), diagramImportDeterministicSpecHash(currentSpec));
});

test('D2 import rejects legacy proposal revisions and requires re-analysis', () => {
  assert.throws(
    () => assertDiagramImportProposal({ version: 1 }, 'token'),
    (error) => error.code === 'diagram_import_proposal_version' && error.statusCode === 409
  );
  assert.throws(
    () => assertDiagramImportProposal({ version: 3 }, 'token'),
    (error) => error.code === 'diagram_import_deterministic_revision_missing' && error.statusCode === 409
  );
});

test('D2 import reports every unresolved node placement independently', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const unresolved = proposal.unresolved.filter((item) => item.family === 'structureTree');
  const missingStages = unresolved.filter((item) => item.id.includes('mapping.materialization.stageId'));

  assert.equal(missingStages.length, 2);
  assert.ok(missingStages.every((item) => item.fields[0].includes('requires a materialized Object Flow result')));
  assert.ok(missingStages.every((item) => item.id.includes('mapping.materialization.stageId')));
  assert.ok(unresolved.some((item) => item.id.includes('mapping.materialization')));

  const staged = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  assert.deepEqual(diagramImportStructureTreeErrors(staged, proposal.roles, currentSpec, proposal.structure), []);
});

test('D2 direct connections stay separate from the structure tree', () => {
  const source = 'source: Source\ntarget: Target\nsource -> target: Traffic';
  const proposal = createDiagramImportProposal(selectionFlowSpec([
    { alias: 'sources', className: 'IS' },
    { alias: 'targets', className: 'ApplicG' }
  ]), normalizeDiagramImportIr({
    version: 4,
    elements: {
      nodes: [
        { id: 'source', label: 'Source', classKeys: ['source'] },
        { id: 'target', label: 'Target', classKeys: ['target'] }
      ],
      edges: [{ id: 'source-target', source: 'source', target: 'target', classKeys: ['traffic'], direction: '->' }]
    },
    classes: [
      { key: 'source', usageKeys: ['source'] },
      { key: 'target', usageKeys: ['target'] },
      { key: 'traffic', usageKeys: ['source-target'], directionPolicy: 'dataFields' }
    ]
  }, source), { sourceText: source });

  assert.equal(proposal.relationRules.length, 1);
  assert.equal(proposal.relationRules[0].directionPolicy, 'dataFields');
  assert.equal(proposal.structureTree.items.some((item) => item.templateElementKey === 'source-target'), false);
});

test('D2 structure placement override changes only its own branch', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const vlanItems = proposal.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  let tree = structureTreeItemWithSource(proposal.structureTree, vlanItems[0].id, 'selection:systemsA');
  tree = structureTreeItemWithSource(tree, vlanItems[1].id, 'selection:systemsB');

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);

  assert.deepEqual(applied.result.diagrams[0].nodeMappings.map((mapping) => mapping.from).sort(), ['systemsA', 'systemsB']);
  assert.equal(new Set(applied.result.diagrams[0].nodeMappings.map((mapping) => mapping.importRole.structureItemId)).size, 2);
  assert.equal(new Set(applied.result.diagrams[0].nodeMappings.map((mapping) => mapping.id)).size, 2);
});

test('D2 structure tree keeps blank containers static and allows a dynamic container per instance', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  tree = structureTreeWithStage(tree, roles['scope-vlan'].id, 'selection:systemsB');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const mappings = applied.result.diagrams[0].groupMappings;

  assert.equal(mappings.filter((mapping) => mapping.importRole.semantic === 'structural').length, 2);
  assert.equal(mappings.filter((mapping) => mapping.importRole.key === 'scope-vlan').length, 2);
  assert.ok(mappings.filter((mapping) => mapping.importRole.key === 'scope-vlan').every((mapping) => mapping.from === 'systemsB'));
  assert.equal(new Set(mappings.map((mapping) => mapping.id)).size, mappings.length);
});

test('D2 structural root container keeps its declared D2 label and never inherits a child VLAN stage', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const target = applied.result.diagrams[0].groupMappings.find((mapping) => mapping.importRole.key === 'group-target');

  assert.ok(target);
  assert.equal(target.from, '');
  assert.ok(!target.importRole.sourceStageId);
  assert.equal(target.staticRows.length, 1);
  assert.equal(target.staticRows[0].Description, 'Target');
  assert.equal(target.staticRows[0].Code, 'target');
});

test('D2 parentCard materialization reuses its dynamic container card without a second source', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const groupMappings = applied.result.diagrams[0].groupMappings.filter((mapping) => mapping.importRole.key === 'scope-vlan');
  const nodeMappings = applied.result.diagrams[0].nodeMappings.filter((mapping) => mapping.importRole.key === 'vlan');

  assert.equal(groupMappings.length, 2);
  assert.equal(nodeMappings.length, 2);
  assert.ok(groupMappings.every((mapping) => mapping.from === 'systemsA'));
  assert.ok(nodeMappings.every((mapping) => mapping.from === 'systemsA'));
  assert.equal(applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'selectCards').length, 0);
});

test('D2 hierarchy conditions place child rows without filtering their Object Flow source', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const scopeItem = proposal.structureTree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  const vlanItem = proposal.structureTree.items.find((item) => String(item.parentId) === String(scopeItem.id) && String(item.roleId) === String(roles.vlan.id));
  let tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsB');
  tree = structureTreeItemWithSource(tree, scopeItem.id, 'selection:systemsA');
  tree = structureTreeItemWithSource(tree, vlanItem.id, 'selection:systemsB', {
    hierarchyConditions: {
      ruleJoin: 'all',
      rules: [{
        id: 'vlan-parent-code', action: 'include', negate: false, operator: 'equals',
        left: { column: 'Code' },
        right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
      }]
    }
  });

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  assert.equal(applied.steps.some((step) => step.managedBy === 'd2ImportV3' && ['semiJoinRows', 'filterRows'].includes(step.type)), false);
  const context = {
    systemsA: { rows: [{ _id: 'parent-1', Code: 'vlan-1', Description: 'VLAN 1' }] },
    systemsB: {
      rows: [
        { _id: 'child-1', Code: 'vlan-1', Description: 'Server in VLAN 1' },
        { _id: 'child-2', Code: 'vlan-2', Description: 'Server in VLAN 2' }
      ]
    }
  };
  const diagram = buildResultDiagrams(applied, context, {}, { maxRows: 20 })[0];
  const vlanNodes = diagram.nodes.filter((node) => node.importRole && node.importRole.structureItemId === vlanItem.id);

  // A child that cannot be correlated with its only approved parent branch
  // is reported as unplaced and omitted; it must not fall back to diagram root.
  assert.deepEqual(vlanNodes.map((node) => node.label).sort(), ['Server in VLAN 1']);
  const runtimeMapping = applied.result.diagrams[0].nodeMappings.find((mapping) => mapping.importRole && mapping.importRole.structureItemId === vlanItem.id);
  assert.deepEqual(runtimeMapping.importRole.parentCorrelations.map((rule) => [rule.childColumn, rule.parentColumn]), [['Code', 'Code']]);
  const bindings = diagram.execution.bindings.filter((item) => item.role && item.role.key === 'vlan');
  assert.ok(bindings.some((binding) => binding.inputRows === 2 && binding.materialized === 2));
  assert.equal(vlanNodes.filter((node) => String(node.group || '')).length, 1);
  assert.ok(diagram.unplaced.some((item) => item.structureItemId === vlanItem.id && item.businessId === 'child-2'));
});

test('D2 hierarchy conditions repeat one child card in every matching parent branch', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const scopeItem = proposal.structureTree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  const vlanItem = proposal.structureTree.items.find((item) => String(item.parentId) === String(scopeItem.id) && String(item.roleId) === String(roles.vlan.id));
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree = structureTreeWithStage(tree, roles.vlan.id, 'selection:systemsB');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id) && String(item.id) !== String(vlanItem.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  tree = structureTreeItemWithSource(tree, vlanItem.id, 'selection:systemsB', {
    hierarchyConditions: {
      ruleJoin: 'all',
      rules: [{
        id: 'repeat-under-every-parent', action: 'include', negate: false, operator: 'equals',
        left: { column: 'Code' },
        right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
      }]
    }
  });

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const diagramSpec = applied.result.diagrams[0];
  const repeatedEdgeKey = '(target.dmz.vlan_scope.vlan -> target.dmz.vlan_scope.vlan)[0]';
  diagramSpec.templateGrammar.edges.push({
    key: repeatedEdgeKey,
    sourceKey: 'target.dmz.vlan_scope.vlan',
    targetKey: 'target.dmz.vlan_scope.vlan',
    sourceRoleKey: 'vlan',
    targetRoleKey: 'vlan',
    direction: '->'
  });
  diagramSpec.edgeMappings.push({
    id: 'repeat-child-edge',
    from: 'systemsB',
    fields: { source: '_id', target: '_id', label: 'Description' },
    importRole: {
      key: 'repeat-child-edge',
      semantic: 'connection',
      elementKey: repeatedEdgeKey,
      sourceKey: 'vlan',
      targetKey: 'vlan'
    }
  });
  const diagram = buildResultDiagrams(applied, {
    systemsA: {
      rows: [
        { _id: 'scope-a', Code: 'shared', Description: 'Scope A' },
        { _id: 'scope-b', Code: 'shared', Description: 'Scope B' }
      ]
    },
    systemsB: { rows: [{ _id: 'child-shared', Code: 'shared', Description: 'Shared VLAN' }] }
  }, {}, { maxRows: 20 })[0];
  const scopes = diagram.groups.filter((group) => String(group && group.importRole && group.importRole.structureItemId || '') === String(scopeItem.id));
  const children = diagram.nodes.filter((node) => String(node && node.importRole && node.importRole.structureItemId || '') === String(vlanItem.id));

  assert.equal(scopes.length, 2);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((node) => node.label), ['Shared VLAN', 'Shared VLAN']);
  assert.deepEqual(new Set(children.map((node) => node.group)), new Set(scopes.map((group) => group.id)));
  assert.equal(new Set(children.map((node) => node.businessId)).size, 1, 'Repeated occurrences retain one CMDBuild business card.');
  const mapping = applied.result.diagrams[0].nodeMappings.find((item) => item.importRole && item.importRole.structureItemId === vlanItem.id);
  assert.equal(mapping.importRole.parentCorrelations[0].ruleJoin, 'all');
  assert.equal(mapping.importRole.parentCorrelations[0].action, 'include');
  assert.equal(diagram.edges.length, 2, 'A direct D2 connection is expanded only across compatible repeated visual branches.');
  assert.ok(diagram.edges.every((edge) => edge.source === edge.target));
});

test('D2 structure tree exposes saved parent comparisons through hierarchy conditions', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const scopeItem = proposal.structureTree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  const vlanItem = proposal.structureTree.items.find((item) => String(item.parentId) === String(scopeItem.id) && String(item.roleId) === String(roles.vlan.id));
  let tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsB');
  tree = structureTreeItemWithSource(tree, scopeItem.id, 'selection:systemsA');
  tree = structureTreeItemWithSource(tree, vlanItem.id, 'selection:systemsB', {
    conditions: {
      ruleJoin: 'all',
      rules: [{
        id: 'saved-parent-code', action: 'include', negate: false, operator: 'equals',
        left: { column: 'Code' },
        right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
      }]
    }
  });

  const normalized = diagramImportStructureTree(tree, proposal.structure, proposal.roles);
  const child = normalized.items.find((item) => String(item.id) === String(vlanItem.id));

  assert.deepEqual(child.mapping.conditions.rules, []);
  assert.deepEqual(child.mapping.hierarchyConditions.rules.map((rule) => ({
    left: rule.left.column,
    rightStageId: rule.right.stageId,
    right: rule.right.column
  })), [{ left: 'Code', rightStageId: 'selection:systemsA', right: 'Code' }]);
  assert.deepEqual(diagramImportStructureTreeErrors(normalized, proposal.roles, currentSpec, proposal.structure), []);
});

test('D2 structure tree keeps an inherited-card filter out of hierarchy conditions', () => {
  const { proposal, roles } = d2StructureTreeFixture();
  const scopeItem = proposal.structureTree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  const vlanItem = proposal.structureTree.items.find((item) => String(item.parentId) === String(scopeItem.id) && String(item.roleId) === String(roles.vlan.id));
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree = structureTreeItemWithSource(tree, vlanItem.id, 'selection:systemsA', {
    materialization: { kind: 'parentCard', stageId: '' },
    conditions: {
      ruleJoin: 'all',
      rules: [{
        id: 'inherited-filter', action: 'include', negate: false, operator: 'equals',
        left: { column: 'Code' },
        right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code' }
      }]
    }
  });

  const normalized = diagramImportStructureTree(tree, proposal.structure, proposal.roles);
  const child = normalized.items.find((item) => String(item.id) === String(vlanItem.id));

  assert.equal(child.mapping.conditions.rules.length, 1);
  assert.deepEqual(child.mapping.hierarchyConditions.rules, []);
});

test('D2 Assistant applies repeated scope placements independently and renders their inherited nodes', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const stages = assistantObjectFlowDiagramStages(currentSpec);
  const placements = assistantDiagramPlacementTargets(proposal, stages);
  const scopeItems = proposal.structureTree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  const vlanItems = proposal.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  const staticItems = proposal.structureTree.items.filter((item) => !scopeItems.includes(item) && !vlanItems.includes(item));
  const response = {
    mappings: [
      ...staticItems.map((item) => ({ structureItemId: item.id, materialization: 'structural' })),
      { structureItemId: scopeItems[0].id, materialization: 'stage', stageId: 'selection:systemsA' },
      { structureItemId: scopeItems[1].id, materialization: 'stage', stageId: 'selection:systemsB' },
      ...vlanItems.map((item) => ({ structureItemId: item.id, materialization: 'parentCard' }))
    ],
    unresolved: []
  };
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, response);
  assert.equal(draft.success, true);
  assert.equal(draft.items.length, proposal.structureTree.items.length);

  const mappingByItemId = new Map(draft.items.map((item) => [item.structureItemId, item.mapping]));
  const tree = {
    ...structuredClone(proposal.structureTree),
    items: proposal.structureTree.items.map((item) => ({ ...item, mapping: mappingByItemId.get(item.id) || item.mapping }))
  };
  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const diagram = buildResultDiagrams(applied, {
    systemsA: { rows: [{ _id: 'vlan-dmz', Code: 'dmz-vlan', Description: 'VLAN DMZ' }] },
    systemsB: { rows: [{ _id: 'vlan-root', Code: 'root-vlan', Description: 'VLAN Root' }] }
  }, {}, { maxRows: 20 })[0];
  const scopes = diagram.groups.filter((group) => group.importRole && group.importRole.key === 'scope-vlan');
  const vlans = diagram.nodes.filter((node) => node.importRole && node.importRole.key === 'vlan');

  assert.deepEqual(scopes.map((group) => group.label).sort(), ['VLAN DMZ', 'VLAN Root']);
  assert.deepEqual(vlans.map((node) => node.label).sort(), ['VLAN DMZ', 'VLAN Root']);
  assert.equal(diagram.groups.some((group) => group.label === 'scope_vlan'), false);
  assert.equal(new Set(vlans.map((node) => node.group)).size, 2);
});

test('D2 Assistant adds one uniquely confirmed hierarchy correlation after selecting parent and child stages', () => {
  const stages = [
    { id: 'selection:parent', alias: 'parentRows', label: 'Родители', className: 'Parent', columns: ['_id', 'Source_LinkKey'] },
    { id: 'selection:child', alias: 'childRows', label: 'Дочерние', className: 'Child', columns: ['_id', 'Source_LinkKey'] }
  ];
  const placements = [
    { structureItemId: 'parent-item', roleId: 'parent-role', displayName: 'Родитель', parentStructureItemId: '', allowedMaterialization: ['stage'], currentMapping: {} },
    { structureItemId: 'child-item', roleId: 'child-role', displayName: 'Дочерний', parentStructureItemId: 'parent-item', allowedMaterialization: ['stage'], currentMapping: {} }
  ];
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, {
    mappings: [
      { structureItemId: 'parent-item', materialization: 'stage', stageId: 'selection:parent' },
      { structureItemId: 'child-item', materialization: 'stage', stageId: 'selection:child' }
    ],
    unresolved: []
  });
  const child = draft.items.find((item) => item.structureItemId === 'child-item');

  assert.equal(draft.success, true);
  assert.deepEqual(child.mapping.hierarchyConditions.rules.map((rule) => ({
    left: rule.left.column,
    rightStageId: rule.right.stageId,
    right: rule.right.column
  })), [{ left: 'Source_LinkKey', rightStageId: 'selection:parent', right: 'Source_LinkKey' }]);
  assert.ok(draft.warnings.some((warning) => /confirmed hierarchy correlation/i.test(warning)));
});

test('D2 server scopes keep separate phServer and vServer sources and render inherited labels', () => {
  const currentSpec = selectionFlowSpec([
    { alias: 'physicalServers', name: 'Физические серверы', className: 'phServer', columns: ['_id', 'Description'] },
    { alias: 'virtualServers', name: 'Виртуальные серверы', className: 'vServer', columns: ['_id', 'Description'] }
  ]);
  const source = 'target: { dmz: { physical_vlan_scope: { physical_scope: { physical_server: Server { class: server } } } } virtual_vlan_scope: { virtual_scope: { virtual_server: Server { class: server } } } }';
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [
        { id: 'target', label: 'Target', classKeys: ['root'], pathSegments: ['target'] },
        { id: 'target.dmz', label: 'DMZ', parentKey: 'target', classKeys: ['dmz'], pathSegments: ['target', 'dmz'] },
        { id: 'target.dmz.physical_vlan_scope', label: '', parentKey: 'target.dmz', classKeys: ['scope-vlan'], pathSegments: ['target', 'dmz', 'physical_vlan_scope'] },
        { id: 'target.dmz.physical_vlan_scope.physical_scope', label: '', parentKey: 'target.dmz.physical_vlan_scope', classKeys: ['scope-server'], pathSegments: ['target', 'dmz', 'physical_vlan_scope', 'physical_scope'] },
        { id: 'target.virtual_vlan_scope', label: '', parentKey: 'target', classKeys: ['scope-vlan'], pathSegments: ['target', 'virtual_vlan_scope'] },
        { id: 'target.virtual_vlan_scope.virtual_scope', label: '', parentKey: 'target.virtual_vlan_scope', classKeys: ['scope-server'], pathSegments: ['target', 'virtual_vlan_scope', 'virtual_scope'] }
      ],
      nodes: [
        { id: 'target.dmz.physical_vlan_scope.physical_scope.physical_server', label: 'Physical server', parentKey: 'target.dmz.physical_vlan_scope.physical_scope', classKeys: ['server'], pathSegments: ['target', 'dmz', 'physical_vlan_scope', 'physical_scope', 'physical_server'] },
        { id: 'target.virtual_vlan_scope.virtual_scope.virtual_server', label: 'Virtual server', parentKey: 'target.virtual_vlan_scope.virtual_scope', classKeys: ['server'], pathSegments: ['target', 'virtual_vlan_scope', 'virtual_scope', 'virtual_server'] }
      ]
    },
    classes: [
      { key: 'root', usageKeys: ['target'] },
      { key: 'dmz', usageKeys: ['target.dmz'] },
      { key: 'scope-vlan', usageKeys: ['target.dmz.physical_vlan_scope', 'target.virtual_vlan_scope'] },
      { key: 'scope-server', usageKeys: ['target.dmz.physical_vlan_scope.physical_scope', 'target.virtual_vlan_scope.virtual_scope'] },
      { key: 'server', usageKeys: ['target.dmz.physical_vlan_scope.physical_scope.physical_server', 'target.virtual_vlan_scope.virtual_scope.virtual_server'] }
    ]
  }, source), { sourceText: source });
  const roles = Object.fromEntries(proposal.roles.map((role) => [role.key, role]));
  const physicalScope = proposal.structureTree.items.find((item) => item.templateElementKey === 'target.dmz.physical_vlan_scope.physical_scope');
  const virtualScope = proposal.structureTree.items.find((item) => item.templateElementKey === 'target.virtual_vlan_scope.virtual_scope');
  const physicalServer = proposal.structureTree.items.find((item) => item.templateElementKey === 'target.dmz.physical_vlan_scope.physical_scope.physical_server');
  const virtualServer = proposal.structureTree.items.find((item) => item.templateElementKey === 'target.virtual_vlan_scope.virtual_scope.virtual_server');
  assert.ok(physicalScope && virtualScope && physicalServer && virtualServer);

  const tree = {
    ...structuredClone(proposal.structureTree),
    items: proposal.structureTree.items.map((item) => {
      const mapping = structuredClone(item.mapping || {});
      if (item.id === physicalScope.id) {
        mapping.materialization = { kind: 'stage', stageId: 'selection:physicalServers' };
        mapping.primary = { ...mapping.primary, className: 'phServer', labelTemplate: '${Description}' };
      }
      if (item.id === virtualScope.id) {
        mapping.materialization = { kind: 'stage', stageId: 'selection:virtualServers' };
        mapping.primary = { ...mapping.primary, className: 'vServer', labelTemplate: '${Description}' };
      }
      if (item.id === physicalServer.id || item.id === virtualServer.id) {
        mapping.materialization = { kind: 'parentCard', stageId: '' };
        mapping.primary = { ...mapping.primary, labelTemplate: '${Description}' };
      }
      return { ...item, mapping };
    })
  };
  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const diagram = buildResultDiagrams(applied, {
    physicalServers: { rows: [{ _id: 'ph-1', Description: 'Physical 1' }] },
    virtualServers: { rows: [{ _id: 'vm-1', Description: 'Virtual 1' }] }
  }, {}, { maxRows: 20 })[0];
  const scopes = diagram.groups.filter((group) => group.importRole && group.importRole.key === 'scope-server');
  const servers = diagram.nodes.filter((node) => node.importRole && node.importRole.key === 'server');

  assert.deepEqual(scopes.map((group) => group.label).sort(), ['Physical 1', 'Virtual 1']);
  assert.deepEqual(servers.map((node) => node.label).sort(), ['Physical 1', 'Virtual 1']);
  assert.deepEqual(scopes.map((group) => group.importRole.sourceStageId).sort(), ['selection:physicalServers', 'selection:virtualServers']);
  assert.equal(new Set(servers.map((node) => node.group)).size, 2);
  assert.equal(scopes.find((group) => group.label === 'Physical 1').blueprintKey, 'target.dmz.physical_vlan_scope.physical_scope');
  assert.equal(scopes.find((group) => group.label === 'Virtual 1').blueprintKey, 'target.virtual_vlan_scope.virtual_scope');
  assert.equal(servers.find((node) => node.label === 'Physical 1').blueprintKey, 'target.dmz.physical_vlan_scope.physical_scope.physical_server');
  assert.equal(servers.find((node) => node.label === 'Virtual 1').blueprintKey, 'target.virtual_vlan_scope.virtual_scope.virtual_server');
  assert.equal(roles.server.visualKind, 'node');
});

test('partial D2 preview omits a legacy server scope instead of rendering an empty frame', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const stale = structuredClone(applied);
  const imported = stale.result.diagrams[0].authoring.d2Import;
  const staleScope = imported.structureTree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  delete staleScope.mapping.materialization;
  staleScope.mapping.source = { stageId: 'selection:systemsA', alias: 'systemsA', className: 'IS' };

  const workflow = await d2WorkflowStatusForSpec(stale);
  assert.equal(workflow.reason, 'materialization_contract_required');
  const partial = draftDiagramPreviewMappingPlan(stale);
  const diagram = partial.spec.result.diagrams[0];

  assert.ok(partial.omissions.some((item) => item.kind === 'container-data' && item.roleId === roles['scope-vlan'].id));
  assert.equal(diagram.groupMappings.some((mapping) => mapping.importRole && mapping.importRole.structureItemId === staleScope.id), false);
  assert.equal(diagram.nodeMappings.some((mapping) => mapping.importRole && mapping.importRole.parentStructureItemId === staleScope.id), false);

  const preview = buildResultDiagrams(partial.spec, {
    systemsA: { rows: [{ _id: 'system-1', Description: 'System 1' }] }
  }, {}, { maxRows: 20 })[0];
  assert.equal(preview.groups.some((group) => group.importRole && group.importRole.structureItemId === staleScope.id), false);
});

test('partial D2 Apply preserves reviewed authoring and previews only independently valid placements', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item, index) => {
    if (String(item.roleId) !== String(roles.vlan.id)) return item;
    return {
      ...item,
      mapping: {
        ...(item.mapping || {}),
        materialization: index === tree.items.findIndex((candidate) => String(candidate.roleId) === String(roles.vlan.id))
          ? { kind: 'parentCard', stageId: '' }
          : { kind: 'stage', stageId: 'selection:missing' }
      }
    };
  });

  const partial = applyPartialDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const imported = partial.spec.result.diagrams[0].authoring.d2Import;

  assert.ok(partial.reviewed.unresolved.length > 0);
  assert.equal(imported.mappingValidation.status, 'needsValidation');
  assert.deepEqual(partial.spec.steps.filter((step) => step.managedBy === 'd2ImportV3'), []);
  assert.deepEqual(partial.spec.result.diagrams[0].nodeMappings, []);
  assert.deepEqual(partial.spec.result.diagrams[0].groupMappings, []);
  assert.equal(imported.structureTree.items.length, tree.items.length);
  assert.ok(partial.omissions.some((item) => item.kind === 'node-data'));

  const workflow = await d2WorkflowStatusForSpec(partial.spec);
  assert.equal(workflow.state, 'pending');
  const previewPlan = draftDiagramPreviewMappingPlan(partial.spec);
  const previewDiagram = previewPlan.spec.result.diagrams[0];
  assert.ok(previewDiagram.groupMappings.length > 0);
  assert.ok(previewDiagram.nodeMappings.length > 0);
  assert.equal(previewDiagram.nodeMappings.some((mapping) => String(mapping.importRole && mapping.importRole.structureItemId || '') === String(tree.items.at(-1).id)), false);

  const preview = buildResultDiagrams(previewPlan.spec, {
    systemsA: { rows: [{ _id: 'system-1', Code: 'vlan-1', Description: 'VLAN 1' }] }
  }, {}, { maxRows: 20 })[0];
  assert.ok(preview.groups.length > 0);
  assert.ok(preview.nodes.length > 0);
  assert.equal(preview.nodes.some((node) => /VLAN/.test(String(node.label || ''))), true);
});

test('partial D2 preview temporarily restores one proven parent correlation for an older copied branch', () => {
  const { proposal, roles } = d2StructureTreeFixture();
  const stale = selectionFlowSpec([
    { alias: 'systemsA', className: 'IS', columns: ['Source_range'] },
    { alias: 'systemsB', className: 'IS', columns: ['Source_Source_range'] }
  ]);
  proposal.deterministicSpecHash = diagramImportDeterministicSpecHash(stale);
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree = structureTreeWithStage(tree, roles.vlan.id, 'selection:systemsB');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? {
        ...item,
        mapping: {
          ...(item.mapping || {}),
          conditions: {
            ruleJoin: 'all',
            rules: [{
              action: 'include',
              operator: 'equals',
              left: { column: 'Source_Source_range' },
              right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Source_range' }
            }]
          }
        }
      }
    : item);
  const applied = applyDiagramImportProposal(stale, proposal, [], [], tree);
  const imported = applied.result.diagrams[0].authoring.d2Import;
  const copiedVlan = imported.structureTree.items.find((item) =>
    String(item.roleId) === String(roles.vlan.id) && String(item.parentId || '').includes('structure_item'));
  assert.ok(copiedVlan);
  copiedVlan.mapping.conditions = { ruleJoin: 'any', rules: [] };
  copiedVlan.mapping.hierarchyConditions = { ruleJoin: 'any', rules: [] };
  imported.mappingValidation = { version: 1, status: 'needsReview', reasons: ['inputRevision'] };

  const plan = draftDiagramPreviewMappingPlan(applied);
  const diagram = plan.spec.result.diagrams[0];

  assert.ok(plan.repairs.length >= 1, 'A single source-provenance match must restore the copied branch only for preview.');
  assert.equal(plan.omissions.some((item) => item.roleId === copiedVlan.roleId && /parent/i.test(item.message)), false);
  assert.ok(diagram.nodeMappings.some((mapping) => String(mapping.importRole && mapping.importRole.structureItemId || '') === String(copiedVlan.id)));
  assert.deepEqual(copiedVlan.mapping.conditions, { ruleJoin: 'any', rules: [] }, 'Preview repair must not mutate the saved mapping.');
  assert.deepEqual(copiedVlan.mapping.hierarchyConditions, { ruleJoin: 'any', rules: [] }, 'Preview repair must not mutate the saved hierarchy mapping.');
});

test('runtime reports an incomplete D2 container instead of rendering a blank structural fallback', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree = {
    ...tree,
    items: tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
      ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
      : item)
  };
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const broken = structuredClone(applied);
  const diagram = broken.result.diagrams[0];
  const scope = diagram.structureTree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  assert.ok(scope);
  delete scope.mapping.materialization;
  diagram.groupMappings = diagram.groupMappings.filter((mapping) =>
    String(mapping && mapping.importRole && mapping.importRole.structureItemId || '') !== String(scope.id)
  );

  const preview = buildResultDiagrams(broken, {
    systemsA: { rows: [{ _id: 'system-1', Description: 'System 1' }] }
  }, {}, { maxRows: 20 })[0];
  assert.equal(preview.groups.some((group) => group.importRole && group.importRole.structureItemId === scope.id), false);
  assert.ok(preview.execution.unconfigured.some((item) => item.structureItemId === scope.id && item.reason === 'missingMaterialization'));
});

test('D2 repeated scope placements keep distinct filters when they use one Object Flow stage', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const scopeItems = proposal.structureTree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  assert.equal(scopeItems.length, 2);

  const expectedCodeByItemId = new Map([
    [scopeItems[0].id, 'dmz-vlan'],
    [scopeItems[1].id, 'root-vlan']
  ]);
  const tree = {
    ...structuredClone(proposal.structureTree),
    items: proposal.structureTree.items.map((item) => {
      const mapping = structuredClone(item.mapping || {});
      if (String(item.roleId) === String(roles['scope-vlan'].id)) {
        mapping.materialization = { kind: 'stage', stageId: 'selection:systemsA' };
        mapping.conditions = {
          ruleJoin: 'all',
          rules: [{
            id: `scope-filter-${item.id}`,
            action: 'include',
            negate: false,
            operator: 'equals',
            left: { column: 'Code', regex: '' },
            right: { kind: 'literal', value: expectedCodeByItemId.get(item.id), name: '', stageId: '', column: '', regex: '' }
          }]
        };
      }
      if (String(item.roleId) === String(roles.vlan.id)) {
        mapping.materialization = { kind: 'parentCard', stageId: '' };
      }
      return { ...item, mapping };
    })
  };

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const filterSteps = applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'filterRows' && step.from === 'systemsA');
  assert.equal(filterSteps.length, 2);
  assert.equal(new Set(filterSteps.map((step) => step.as)).size, 2);
  assert.deepEqual(filterSteps.map((step) => step.filters[0].value).sort(), ['dmz-vlan', 'root-vlan']);

  const context = {
    systemsA: {
      columns: ['_id', 'Code', 'Description'],
      rows: [
        { _id: 'vlan-dmz', Code: 'dmz-vlan', Description: 'DMZ VLAN' },
        { _id: 'vlan-root', Code: 'root-vlan', Description: 'Root VLAN' }
      ]
    }
  };
  for (const step of filterSteps) context[step.as] = executeFilterRows(step, {}, context, { maxRows: 20 });

  const diagram = buildResultDiagrams(applied, context, {}, { maxRows: 20 })[0];
  const scopeGroups = diagram.groups.filter((group) => group.importRole && group.importRole.key === 'scope-vlan');
  const vlanNodes = diagram.nodes.filter((node) => node.importRole && node.importRole.key === 'vlan');
  assert.deepEqual(scopeGroups.map((group) => group.label).sort(), ['DMZ VLAN', 'Root VLAN']);
  assert.deepEqual(vlanNodes.map((node) => node.label).sort(), ['DMZ VLAN', 'Root VLAN']);
  assert.equal(new Set(vlanNodes.map((node) => node.group)).size, 2);

  const scopeBindings = diagram.execution.bindings.filter((binding) => binding.role.key === 'scope-vlan');
  assert.equal(scopeBindings.length, 2);
  assert.equal(new Set(scopeBindings.map((binding) => binding.source.alias)).size, 2);
  assert.ok(scopeBindings.every((binding) => binding.inputRows === 1 && binding.materialized === 1));
});

test('D2 Assistant coalesces identical placement mappings and corrects only an invalid parentCard ancestry', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const stages = assistantObjectFlowDiagramStages(currentSpec);
  const placements = assistantDiagramPlacementTargets(proposal, stages);
  const scopeItems = proposal.structureTree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  const vlanItems = proposal.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  const staticItem = proposal.structureTree.items.find((item) => !scopeItems.includes(item) && !vlanItems.includes(item));
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, {
    mappings: [
      { structureItemId: staticItem.id, materialization: 'structural' },
      { structureItemId: staticItem.id, materialization: 'structural' },
      { structureItemId: scopeItems[0].id, materialization: 'stage', stageId: 'selection:systemsA' },
      { structureItemId: scopeItems[1].id, materialization: 'structural' },
      ...vlanItems.map((item) => ({ structureItemId: item.id, materialization: 'parentCard' }))
    ],
    unresolved: []
  });

  assert.equal(draft.success, false);
  assert.ok(draft.warnings.some((warning) => /повторил сопоставление элемента/.test(warning)));
  assert.equal(draft.errors.some((error) => error.code === 'diagram_placement_duplicate'), false);
  assert.ok(draft.errors.some((error) => error.code === 'diagram_parent_card_parent_missing'));
  const correction = assistantDiagramPlacementCorrection(draft.errors);
  assert.ok(correction);
  assert.deepEqual(new Set(correction.invalidMappings.map((item) => item.code)), new Set(['diagram_parent_card_parent_missing']));
});

test('D2 Assistant recovers a parentCard dependency only when one deterministic stage is available', () => {
  const stages = [{ id: 'selection:vlans', alias: 'vlans', label: 'VLAN', className: 'vlan', columns: ['_id', 'Code', 'Description'] }];
  const placements = [
    {
      structureItemId: 'scope', roleId: 'scope-role', displayName: 'scope_vlan', parentStructureItemId: '',
      visualKind: 'container', allowedMaterialization: ['structural', 'stage'], currentMapping: {}
    },
    {
      structureItemId: 'vlan', roleId: 'vlan-role', displayName: 'vlan', parentStructureItemId: 'scope',
      visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: {}
    },
    {
      structureItemId: 'gateway', roleId: 'gateway-role', displayName: 'gateway', parentStructureItemId: 'scope',
      visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: {}
    }
  ];
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, {
    mappings: [
      { structureItemId: 'scope', materialization: 'structural' },
      { structureItemId: 'vlan', materialization: 'parentCard' },
      { structureItemId: 'gateway', materialization: 'parentCard' }
    ],
    unresolved: []
  });

  assert.equal(draft.success, false);
  const recovered = assistantDiagramRecoverParentCardMappings({ kind: 'mapping', placements, stages }, draft);
  assert.equal(recovered.success, true);
  assert.deepEqual(recovered.errors, []);
  const scope = recovered.items.find((item) => item.structureItemId === 'scope');
  const vlan = recovered.items.find((item) => item.structureItemId === 'vlan');
  const gateway = recovered.items.find((item) => item.structureItemId === 'gateway');
  assert.deepEqual(scope.mapping.materialization, { kind: 'stage', stageId: 'selection:vlans' });
  assert.deepEqual(vlan.mapping.materialization, { kind: 'parentCard', stageId: '' });
  assert.deepEqual(gateway.mapping.materialization, { kind: 'parentCard', stageId: '' });
  assert.equal(recovered.unresolved.length, 0);
});

test('D2 Assistant leaves parentCard mapping unresolved when no deterministic parent stage can be chosen', () => {
  const stages = [
    { id: 'selection:vlans', alias: 'vlans', label: 'VLAN', className: 'vlan', columns: ['_id', 'Code'] },
    { id: 'selection:servers', alias: 'servers', label: 'Серверы', className: 'vServer', columns: ['_id', 'Code'] }
  ];
  const placements = [
    {
      structureItemId: 'scope', roleId: 'scope-role', displayName: 'scope_vlan', parentStructureItemId: '',
      visualKind: 'container', allowedMaterialization: ['structural', 'stage'], currentMapping: {}
    },
    {
      structureItemId: 'vlan', roleId: 'vlan-role', displayName: 'vlan', parentStructureItemId: 'scope',
      visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: {}
    }
  ];
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, {
    mappings: [
      { structureItemId: 'scope', materialization: 'structural' },
      { structureItemId: 'vlan', materialization: 'parentCard' }
    ],
    unresolved: []
  });

  const recovered = assistantDiagramRecoverParentCardMappings({ kind: 'mapping', placements, stages }, draft);
  assert.equal(recovered.success, false);
  assert.deepEqual(recovered.errors.map((error) => error.code), ['diagram_parent_card_parent_missing']);
  assert.equal(recovered.items.some((item) => item.structureItemId === 'vlan'), false);
  assert.deepEqual(recovered.unresolved.map((item) => [item.structureItemId, item.code]), [['vlan', 'parentCardParentStageMissing']]);
  assert.match(recovered.unresolved[0].message, /scope_vlan/);
});

test('D2 preview recognizes a complete saved mapping that needs only Object Flow input recompilation', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const stale = structuredClone(applied);
  stale.steps[0].limit = Number(stale.steps[0].limit || 100) + 1;
  stale.result.diagrams[0].authoring.d2Import.mappingValidation = {
    version: 1,
    status: 'needsReview',
    reasons: ['inputRevision']
  };

  assert.equal(diagramImportCurrentInputRecompileRequired(stale), true);
  stale.result.diagrams[0].authoring.d2Import.mappingValidation = {
    version: 1,
    status: 'needsReview',
    reasons: ['source']
  };
  assert.equal(diagramImportCurrentInputRecompileRequired(stale), false);
});

test('D2 structure normalizes a node mapped to its parent stage into parentCard', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree = structureTreeWithStage(tree, roles.vlan.id, 'selection:systemsA');
  const normalized = diagramImportStructureTree(tree, proposal.structure, proposal.roles);
  const inheritedVlans = normalized.items.filter((item) => (
    String(item.roleId) === String(roles.vlan.id) &&
    String(item.mapping && item.mapping.materialization && item.mapping.materialization.kind) === 'parentCard'
  ));

  assert.ok(inheritedVlans.length > 0);
  assert.equal(diagramImportStructureTreeErrors(normalized, proposal.roles, currentSpec, proposal.structure)
    .some((error) => error.message.includes('Use parentCard instead')), false);
});

test('D2 nested relation stage is already correlated with its direct parent stage', () => {
  const { proposal, roles } = d2StructureTreeFixture();
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:systems', name: 'Systems', alias: 'systems', className: 'IS', from: '', limit: 100,
      columns: ['Code', 'Description'],
      rules: [{ action: 'include', path: 'Code', negate: false, op: 'matches', regex: '.*', value: '', valueParam: '', valueColumn: '' }]
    }],
    operations: [{
      id: 'relation:systemRanges', type: 'relation', from: 'systems', as: 'ranges',
      domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source',
      columns: ['Code', 'Description', 'range'], limit: 100, distinct: true
    }],
    blocks: [], setOperations: [], publishedAlias: 'ranges'
  };
  const currentSpec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  let tree = structureTreeWithStage(proposal.structureTree, roles['group-target'].id, 'selection:systems');
  tree = structureTreeWithStage(tree, roles['scope-vlan'].id, 'relation:systemRanges');
  const errors = diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure);
  const scopeIndexes = tree.items
    .map((item, index) => String(item.roleId) === String(roles['scope-vlan'].id) ? index : -1)
    .filter((index) => index >= 0);

  assert.equal(errors.some((error) => scopeIndexes.some((index) => error.path.startsWith(`$.structureTree.items[${index}]`)) && error.message.includes('explicitly match the parent result')), false);
});

test('D2 preview recompiles a current mapping when compiled bindings drift from the saved structure tree', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  applied.result.diagrams[0].groupMappings = applied.result.diagrams[0].groupMappings.map((mapping) => ({
    ...mapping,
    from: '',
    importRole: { ...mapping.importRole, materialization: 'structural' }
  }));

  assert.equal(draftDiagramPreviewRequiresPartialPlan(applied, { state: 'ready' }), true);
});

test('D2 partial preview recompiles current structure mappings instead of stale compiled mappings', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const stale = structuredClone(applied);
  stale.result.diagrams[0].authoring.d2Import.mappingValidation = {
    version: 1,
    status: 'needsReview',
    reasons: ['inputRevision']
  };
  stale.result.diagrams[0].groupMappings = stale.result.diagrams[0].groupMappings.map((mapping) => ({
    ...mapping,
    from: '',
    importRole: { ...mapping.importRole, materialization: 'structural' }
  }));
  const imported = stale.result.diagrams[0].authoring.d2Import;
  assert.deepEqual(
    diagramImportStructureTreeErrors(
      imported.structureTree,
      diagramImportRolesForStoredStructure(imported),
      stale,
      imported.structure
    ),
    []
  );

  const plan = draftDiagramPreviewMappingPlan(stale);
  const diagram = plan.spec.result.diagrams[0];
  const scopes = diagram.groupMappings.filter((mapping) => mapping.importRole && mapping.importRole.key === 'scope-vlan');
  const vlans = diagram.nodeMappings.filter((mapping) => mapping.importRole && mapping.importRole.key === 'vlan');

  assert.deepEqual(plan.omissions, []);
  assert.equal(scopes.length, 2);
  assert.deepEqual(scopes.map((mapping) => ({ from: mapping.from, materialization: mapping.importRole.materialization })), [
    { from: 'systemsA', materialization: 'stage' },
    { from: 'systemsA', materialization: 'stage' }
  ]);
  assert.ok(scopes.every((mapping) => mapping.importRole.materialization === 'stage'));
  assert.equal(vlans.length, 2);
  assert.ok(vlans.every((mapping) => mapping.from === 'systemsA'));
  assert.ok(vlans.every((mapping) => mapping.importRole.materialization === 'parentCard'));
});

test('D2 Assistant offers readable CMDBuild attributes for placement-only filters', () => {
  const { proposal } = d2StructureTreeFixture();
  const targets = assistantDiagramPlacementTargets(proposal, [{
    id: 'selection:vlans',
    alias: 'vlans',
    label: 'Все VLAN',
    className: 'vlan',
    columns: ['_id', 'Code', 'Description']
  }], {
    classes: [{
      name: 'vlan',
      attributes: [{ name: 'isNAT' }, { name: 'NetworkRole' }]
    }]
  });

  assert.ok(targets.length > 0);
  assert.deepEqual(targets[0].stages[0].filterFields, ['_id', 'Code', 'Description', 'isNAT', 'NetworkRole']);
});

test('D2 placement filters apply independently to dynamic containers and inherited nodes', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => {
    if (String(item.roleId) === String(roles['scope-vlan'].id)) {
      return {
        ...item,
        mapping: {
          ...(item.mapping || {}),
          conditions: {
            ruleJoin: 'all',
            rules: [{
              action: 'include',
              negate: false,
              operator: 'equals',
              left: { column: 'Code', regex: '' },
              right: { kind: 'literal', value: 'dmz', name: '', stageId: '', column: '', regex: '' }
            }]
          }
        }
      };
    }
    if (String(item.roleId) === String(roles.vlan.id)) {
      return {
        ...item,
        mapping: {
          ...(item.mapping || {}),
          materialization: { kind: 'parentCard', stageId: '' },
          conditions: {
            ruleJoin: 'all',
            rules: [{
              action: 'include',
              negate: false,
              operator: 'contains',
              left: { column: 'Description', regex: '' },
              right: { kind: 'literal', value: 'VLAN', name: '', stageId: '', column: '', regex: '' }
            }]
          }
        }
      };
    }
    return item;
  });

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const filterSteps = applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'filterRows');
  assert.equal(filterSteps.length, 4);
  const containerFilterSteps = filterSteps.filter((step) => step.from === 'systemsA');
  assert.equal(containerFilterSteps.length, 2);
  assert.ok(containerFilterSteps.every((step) => step.filters[0].column === 'Code'));

  const containerAliases = new Set(containerFilterSteps.map((step) => step.as));
  const nodeFilterSteps = filterSteps.filter((step) => containerAliases.has(step.from));
  assert.equal(nodeFilterSteps.length, 2);
  assert.ok(nodeFilterSteps.every((step) => step.filters[0].column === 'Description'));
  const nodeAliases = new Set(nodeFilterSteps.map((step) => step.as));
  const groups = applied.result.diagrams[0].groupMappings.filter((mapping) => mapping.importRole.key === 'scope-vlan');
  const nodes = applied.result.diagrams[0].nodeMappings.filter((mapping) => mapping.importRole.key === 'vlan');
  assert.ok(groups.every((mapping) => containerAliases.has(mapping.from)));
  assert.ok(nodes.every((mapping) => nodeAliases.has(mapping.from)));
  assert.equal(applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'selectCards').length, 0);

  const rows = executeFilterRows(containerFilterSteps[0], {}, {
    systemsA: { columns: ['Code', 'Description'], rows: [{ Code: 'dmz', Description: 'DMZ VLAN' }, { Code: 'internal', Description: 'Internal VLAN' }] }
  }, { maxRows: 10 }).rows;
  assert.deepEqual(rows, [{ Code: 'dmz', Description: 'DMZ VLAN' }]);
});

test('D2 placement filters enrich catalog fields that Object Flow does not materialize', () => {
  const fixture = d2StructureTreeFixture();
  const currentSpec = selectionFlowSpec([
    { alias: 'vlans', className: 'vlan', columns: ['Code', 'Description'] },
    { alias: 'networks', className: 'ipRange', columns: ['Code', 'Description'] }
  ]);
  const proposal = createDiagramImportProposal(currentSpec, fixture.ir, { sourceText: fixture.source });
  const roles = Object.fromEntries(proposal.roles.map((role) => [role.key, role]));
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:vlans');
  tree.items = tree.items.map((item) => {
    if (String(item.roleId) === String(roles.vlan.id)) {
      return {
        ...item,
        mapping: {
          ...(item.mapping || {}),
          materialization: { kind: 'parentCard', stageId: '' }
        }
      };
    }
    if (String(item.roleId) !== String(roles['scope-vlan'].id)) return item;
    return {
      ...item,
      mapping: {
        ...(item.mapping || {}),
        conditions: {
          ruleJoin: 'all',
          rules: [
            {
              action: 'include', negate: false, operator: 'equals',
              left: { column: 'isNAT', regex: '' },
              right: { kind: 'literal', value: 'true', name: '', stageId: '', column: '', regex: '' }
            },
            {
              action: 'include', negate: false, operator: 'equals',
              left: { column: 'ipaddress.ipAddr', regex: '' },
              right: { kind: 'stage', value: '', name: '', stageId: 'selection:networks', column: 'range', regex: '' }
            }
          ]
        }
      }
    };
  });

  const catalog = {
    classes: [
      {
        name: 'vlan',
        attributes: [
          { name: 'isNAT', type: 'boolean' },
          { name: 'ipaddress', type: 'reference', targetClass: 'IpAddress' }
        ]
      },
      { name: 'IpAddress', attributes: [{ name: 'ipAddr', type: 'string' }] },
      { name: 'ipRange', attributes: [{ name: 'range', type: 'string' }] }
    ],
    domains: []
  };
  const reviewedProposal = { ...proposal, structureTree: tree };

  assert.deepEqual(validateDiagramImportV3Catalog(reviewedProposal, catalog, currentSpec), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const enrichments = applied.steps.filter((step) => step.type === 'enrichRows' && step.purpose === 'd2PlacementFilter');
  const vlanEnrichments = enrichments.filter((step) => step.from === 'vlans');
  const networkEnrichments = enrichments.filter((step) => step.from === 'networks');

  assert.equal(vlanEnrichments.length, 2);
  assert.ok(vlanEnrichments.every((step) => step.columns.includes('isNAT') && step.columns.includes('ipaddress.ipAddr')));
  assert.equal(networkEnrichments.length, 2);
  assert.ok(networkEnrichments.every((step) => step.columns.includes('range')));
  const joins = applied.steps.filter((step) => step.type === 'semiJoinRows' && step.managedBy === 'd2ImportV3');
  assert.equal(joins.length, 2);
  assert.ok(joins.every((step) => vlanEnrichments.some((enrichment) => enrichment.as === step.from)));
  assert.ok(joins.every((step) => networkEnrichments.some((enrichment) => enrichment.as === step.with)));
});

test('D2 placement filters preserve one related-card row through an inherited CMDBuild domain endpoint', () => {
  const fixture = d2StructureTreeFixture();
  const currentSpec = selectionFlowSpec([
    { alias: 'ranges', className: 'ipRange', columns: ['Code', 'Description'] }
  ]);
  const proposal = createDiagramImportProposal(currentSpec, fixture.ir, { sourceText: fixture.source });
  const roles = Object.fromEntries(proposal.roles.map((role) => [role.key, role]));
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:ranges');
  tree.items = tree.items.map((item) => {
    if (String(item.roleId) === String(roles.vlan.id)) {
      return {
        ...item,
        mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } }
      };
    }
    if (String(item.roleId) !== String(roles['scope-vlan'].id)) return item;
    return {
      ...item,
      mapping: {
        ...(item.mapping || {}),
        conditions: {
          ruleJoin: 'all',
          rules: [{
            action: 'include', negate: false, operator: 'equals',
            left: { column: '{Vlan2super:vlan}.isNAT', regex: '' },
            right: { kind: 'literal', value: 'true', name: '', stageId: '', column: '', regex: '' }
          }]
        }
      }
    };
  });
  const catalog = {
    classes: [
      { name: 'ZabbixMonitoring', attributes: [] },
      { name: 'ipRange', parent: 'ZabbixMonitoring', attributes: [] },
      { name: 'vlan', attributes: [{ name: 'isNAT', type: 'boolean' }] }
    ],
    domains: [{ name: 'Vlan2super', sources: ['vlan'], destinations: ['ZabbixMonitoring'], cardinality: 'N:1' }]
  };
  const reviewedProposal = { ...proposal, structureTree: tree };

  assert.deepEqual(validateDiagramImportV3Catalog(reviewedProposal, catalog, currentSpec), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const enrichment = applied.steps.find((step) => step.type === 'enrichRows' && step.purpose === 'd2PlacementFilter' && step.from === 'ranges');
  assert.ok(enrichment);
  assert.deepEqual(enrichment.columns, [{
    path: '{Vlan2super:vlan}.isNAT',
    as: '{Vlan2super:vlan}.isNAT',
    multiMode: 'rows',
    correlationKey: '{Vlan2super:vlan}'
  }]);
});

test('D2 placement filters resolve a deep path from a retained source card', () => {
  const fixture = d2StructureTreeFixture();
  const currentSpec = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1,
    selections: [
      { id: 'selection:ranges', name: 'Ranges', alias: 'ranges', className: 'ipRange', limit: 100, columns: ['range'], rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }] },
      { id: 'selection:addresses', name: 'Addresses', alias: 'addresses', className: 'IpAddress', from: 'ranges', limit: 100, columns: ['ipAddr'], rules: [{ action: 'include', path: 'ipAddr', op: 'ipv4InCidr', valueColumn: 'range' }] }
    ],
    operations: [{
      id: 'relation:servers', type: 'relation', from: 'addresses', as: 'servers', domain: 'ipaddress', targetClass: 'vServer', direction: 'source', columns: ['Code'], limit: 100, distinct: true
    }]
  });
  const proposal = createDiagramImportProposal(currentSpec, fixture.ir, { sourceText: fixture.source });
  const roles = Object.fromEntries(proposal.roles.map((role) => [role.key, role]));
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'relation:servers');
  tree.items = tree.items.map((item) => {
    if (String(item.roleId) === String(roles.vlan.id)) {
      return { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } };
    }
    if (String(item.roleId) !== String(roles['scope-vlan'].id)) return item;
    return {
      ...item,
      mapping: {
        ...(item.mapping || {}),
        conditions: {
          ruleJoin: 'all',
          rules: [{
            action: 'include', negate: false, operator: 'equals',
            left: {
              column: '{IpRangeVlanDomain:vlan}.isNAT', regex: '',
              source: { className: 'ipRange', classColumn: 'Source_Source_Class', idColumn: 'Source_Source__id', label: 'Исходная сеть' }
            },
            right: { kind: 'literal', value: 'true', name: '', stageId: '', column: '', regex: '' }
          }]
        }
      }
    };
  });
  const catalog = {
    classes: [
      { name: 'ipRange', attributes: [] },
      { name: 'IpAddress', attributes: [{ name: 'ipAddr', type: 'string' }] },
      { name: 'vServer', attributes: [] },
      { name: 'vlan', attributes: [{ name: 'isNAT', type: 'boolean' }] }
    ],
    domains: [
      { name: 'IpRangeVlanDomain', sources: ['ipRange'], destinations: ['vlan'], cardinality: '1:N' },
      { name: 'ipaddress', sources: ['IpAddress'], destinations: ['vServer'], cardinality: '1:N' }
    ]
  };
  const reviewedProposal = { ...proposal, structureTree: tree };

  assert.deepEqual(validateDiagramImportV3Catalog(reviewedProposal, catalog, currentSpec), []);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const enrichment = applied.steps.find((step) => step.type === 'enrichRows' && step.purpose === 'd2PlacementFilter' && step.from === 'servers');
  assert.ok(enrichment);
  assert.equal(enrichment.classColumn, 'Source_Source_Class');
  assert.equal(enrichment.idColumn, 'Source_Source__id');
  assert.equal(enrichment.columns[0].path, '{IpRangeVlanDomain:vlan}.isNAT');
  assert.match(enrichment.columns[0].as, /^__d2_condition_/);
});

test('D2 structural containers reject placement filters', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structuredClone(proposal.structureTree);
  const target = tree.items.find((item) => String(item.roleId) === String(roles['group-target'].id));
  target.mapping = {
    ...(target.mapping || {}),
    conditions: {
      ruleJoin: 'all',
      rules: [{
        action: 'include', negate: false, operator: 'equals',
        left: { column: 'Code', regex: '' },
        right: { kind: 'literal', value: 'target', name: '', stageId: '', column: '', regex: '' }
      }]
    }
  };

  const errors = diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure);
  assert.ok(errors.some((error) => error.message.includes('structural D2 container has no Object Flow source')));
});

test('D2 nested independent stage requires an explicit comparison to the materialized parent', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree = structureTreeWithStage(tree, roles.vlan.id, 'selection:systemsB');

  const missingCondition = diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure);
  assert.ok(missingCondition.some((error) => error.message.includes('explicitly match the parent result')));

  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? {
        ...item,
        mapping: {
          ...(item.mapping || {}),
          conditions: {
            ruleJoin: 'all',
            rules: [{
              action: 'include',
              negate: false,
              operator: 'equals',
              left: { column: 'Code', regex: '' },
              right: { kind: 'stage', stageId: 'selection:systemsA', column: 'Code', value: '', name: '', regex: '' }
            }]
          }
        }
      }
    : item);

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);
});

test('D2 nested independent stages place each child under its matched parent card', () => {
  const spec = {
    version: 1,
    steps: [],
    result: {
      diagrams: [{
        name: 'nested-stage-correlation',
        groupMappings: [{
          id: 'parents-mapping',
          from: 'parents',
          fields: { id: '_id', label: 'Description' },
          importRole: { key: 'parent', structureItemId: 'parent' }
        }],
        nodeMappings: [{
          id: 'children-mapping',
          from: 'children',
          fields: { id: '_id', label: 'Description' },
          importRole: {
            key: 'child',
            structureItemId: 'child',
            parentStructureItemId: 'parent',
            parentCorrelations: [{
              parentStructureItemId: 'parent',
              childColumn: 'ParentCode',
              childRegex: '',
              parentColumn: 'Code',
              parentRegex: '',
              operator: 'equals',
              caseSensitive: false
            }]
          }
        }],
        structureTree: {
          version: 5,
          items: [
            { id: 'parent', roleId: 'parent', parentId: '', mapping: {} },
            { id: 'child', roleId: 'child', parentId: 'parent', mapping: {} }
          ]
        }
      }]
    }
  };
  const diagrams = buildResultDiagrams(spec, {
    parents: { rows: [
      { _id: 'parent-a', Code: 'A', Description: 'Parent A' },
      { _id: 'parent-b', Code: 'B', Description: 'Parent B' }
    ] },
    children: { rows: [
      { _id: 'child-a', ParentCode: 'A', Description: 'Child A' },
      { _id: 'child-b', ParentCode: 'B', Description: 'Child B' }
    ] }
  }, {}, { maxRows: 100 });
  const diagram = diagrams[0];
  const groupByBusinessId = new Map(diagram.groups.map((group) => [group.businessId, group]));
  const nodeByBusinessId = new Map(diagram.nodes.map((node) => [node.businessId, node]));

  assert.equal(nodeByBusinessId.get('child-a').group, groupByBusinessId.get('parent-a').id);
  assert.equal(nodeByBusinessId.get('child-b').group, groupByBusinessId.get('parent-b').id);
  assert.deepEqual(diagram.unplaced, []);
});

test('composite runtime scopes duplicate business ids by mapping and enforces expanded shape limits', () => {
  const template = (rootKey, childKey) => ({
    version: 1,
    rootKey,
    groups: [{ key: rootKey, label: rootKey }],
    nodes: [{ key: `${rootKey}.${childKey}`, parentKey: rootKey, label: childKey }],
    edges: [],
    hierarchies: []
  });
  const spec = {
    version: 1,
    steps: [],
    result: { diagrams: [{
      name: 'composites',
      maxNodes: 10,
      nodeMappings: [{
        id: 'mapping_users',
        from: 'objects',
        fields: { id: 'Code', label: 'Description' },
        importRole: { key: 'users', semantic: 'composite' },
        d2Template: template('users', 'operator')
      }, {
        id: 'mapping_services',
        from: 'objects',
        fields: { id: 'Code', label: 'Description' },
        importRole: { key: 'services', semantic: 'composite' },
        d2Template: template('services', 'api')
      }]
    }] }
  };
  const diagrams = buildResultDiagrams(spec, { objects: { rows: [{ Code: 'same', Description: 'Shared id' }] } }, {}, { maxRows: 100 });
  assert.equal(diagrams[0].nodes.length, 2);
  assert.deepEqual(diagrams[0].nodes.map((node) => node.id).sort(), ['mapping_services:same', 'mapping_users:same']);

  const normalizedRows = buildResultDiagrams(spec, { objects: { rows: [{
    Class: 'ARM',
    Code: 'same',
    Description: 'Shared id',
    mapping_users: '',
    mapping_services: ''
  }] } }, {}, { maxRows: 100 });
  assert.equal(normalizedRows[0].nodes.length, 2);
  assert.match(normalizedRows[0].d2.source, /class: \["cmdp_node"; "cmdb_arm_[0-9a-f]{12}"\]/);
  assert.doesNotMatch(normalizedRows[0].d2.source, /class: \["cmdp_node",/);

  spec.result.diagrams[0].maxNodes = 3;
  spec.result.diagrams[0].nodeMappings = [spec.result.diagrams[0].nodeMappings[0]];
  const limited = buildResultDiagrams(spec, { objects: { rows: [
    { Code: 'one', Description: 'One' },
    { Code: 'two', Description: 'Two' }
  ] } }, {}, { maxRows: 100 });
  assert.equal(limited[0].nodes.length, 1);
  assert.equal(limited[0].expandedShapeCount, 2);
  assert.equal(limited[0].truncated, true);
  assert.match(limited[0].warnings.join('\n'), /expanded composite shape limit/);
});

test('runtime keeps duplicate business ids separate across non-composite node and group roles', () => {
  const spec = {
    version: 1,
    steps: [],
    result: { diagrams: [{
      name: 'role-scoped',
      maxNodes: 20,
      maxGroups: 20,
      nodeMappings: [{
        id: 'mapping_left_node',
        from: 'objects',
        fields: { id: 'Code', label: 'Description', group: 'Group' },
        importRole: { key: 'left.node', semantic: 'node', parentKey: 'left' }
      }, {
        id: 'mapping_right_node',
        from: 'objects',
        fields: { id: 'Code', label: 'Description', group: 'Group' },
        importRole: { key: 'right.node', semantic: 'node', parentKey: 'right' }
      }],
      groupMappings: [{
        id: 'mapping_left_group',
        from: 'groups',
        fields: { id: 'Code', label: 'Description' },
        importRole: { key: 'left', semantic: 'group' }
      }, {
        id: 'mapping_right_group',
        from: 'groups',
        fields: { id: 'Code', label: 'Description' },
        importRole: { key: 'right', semantic: 'group' }
      }]
    }] }
  };
  const diagram = buildResultDiagrams(spec, {
    objects: { rows: [{ Code: 'same', Description: 'Shared object', Group: 'zone' }] },
    groups: { rows: [{ Code: 'zone', Description: 'Shared zone' }] }
  }, {}, { maxRows: 100 })[0];

  assert.deepEqual(diagram.nodes.map((node) => node.id).sort(), ['mapping_left_node:same', 'mapping_right_node:same']);
  assert.deepEqual(diagram.groups.map((group) => group.id).sort(), ['mapping_left_group:zone', 'mapping_right_group:zone']);
  assert.equal(diagram.nodes.find((node) => node.importRole.key === 'left.node').group, 'mapping_left_group:zone');
  assert.equal(diagram.nodes.find((node) => node.importRole.key === 'right.node').group, 'mapping_right_group:zone');
  assert.deepEqual(Object.values(diagram.data.import.roles).map((role) => role.sourceRole).sort(), ['left', 'right']);
});

test('runtime emits structured semantic metadata for an empty dynamic group', () => {
  const diagram = buildResultDiagrams({
    version: 1,
    steps: [],
    result: { diagrams: [{
      name: 'empty-group',
      groupMappings: [{
        id: 'mapping_empty_group',
        from: 'groups',
        fields: { id: 'Code', label: 'Description' },
        importRole: { key: 'empty', semantic: 'group' }
      }]
    }] }
  }, {
    groups: { rows: [{ Code: 'zone-empty', Description: 'Empty zone' }] }
  }, {}, { maxRows: 100 })[0];

  assert.equal(diagram.nodes.length, 0);
  assert.equal(diagram.groups.length, 1);
  assert.equal(diagram.groups[0].id, 'mapping_empty_group:zone-empty');
  assert.deepEqual(Object.values(diagram.data.import.roles), [{ semantic: 'group', sourceRole: 'empty' }]);
  assert.match(diagram.d2.source, new RegExp(`${diagram.groups[0].d2Id}: \\{`));
});

test('runtime materializes an empty dynamic container once for every materialized parent', () => {
  const diagramSpec = (showEmpty) => ({
    version: 1,
    steps: [],
    result: { diagrams: [{
      name: 'empty-dynamic-container-per-parent',
      structureTree: {
        version: 5,
        items: [
          { id: 'parent', roleId: 'parent-role', parentId: '', mapping: { materialization: { kind: 'stage', stageId: 'parents' } } },
          { id: 'child', roleId: 'child-role', parentId: 'parent', mapping: { materialization: { kind: 'stage', stageId: 'children' }, showEmpty } }
        ]
      },
      groupMappings: [
        {
          id: 'mapping_parent',
          from: 'parents',
          fields: { id: 'Code', label: 'Description' },
          importRole: { key: 'parent', semantic: 'group', visualKind: 'container', materialization: 'stage', structureItemId: 'parent', showEmpty: true }
        },
        {
          id: 'mapping_child',
          from: 'children',
          fields: { id: 'Code', label: 'Description' },
          importRole: { key: 'child', semantic: 'group', visualKind: 'container', materialization: 'stage', structureItemId: 'child', parentStructureItemId: 'parent', showEmpty }
        }
      ]
    }] }
  });
  const context = {
    parents: { rows: [
      { Code: 'parent-1', Description: 'Parent 1' },
      { Code: 'parent-2', Description: 'Parent 2' }
    ] },
    children: { rows: [] }
  };

  const shown = buildResultDiagrams(diagramSpec(true), context, {}, { maxRows: 20 })[0];
  const shownParents = shown.groups.filter((group) => group.importRole && group.importRole.structureItemId === 'parent');
  const shownChildren = shown.groups.filter((group) => group.importRole && group.importRole.structureItemId === 'child');
  assert.equal(shownParents.length, 2);
  assert.equal(shownChildren.length, 2);
  assert.deepEqual(shownChildren.map((group) => group.parent).sort(), shownParents.map((group) => group.id).sort());
  assert.ok(shownChildren.every((group) => group.emptyContainer === true));
  assert.ok(shownChildren.every((group) => group.label === ''), 'An empty container must stay visibly blank rather than exposing its runtime mapping id.');
  assert.match(shown.d2.source, /label: ""/);
  assert.doesNotMatch(shown.d2.source, /label: "mapping_child:/);
  const shownBinding = shown.execution.bindings.find((binding) => binding.role && binding.role.key === 'child');
  assert.equal(shownBinding.inputRows, 0);
  assert.equal(shownBinding.materialized, 2);
  assert.ok(shown.execution.items.filter((item) => item.role && item.role.key === 'child').every((item) => item.reason === 'emptyContainer'));

  const hidden = buildResultDiagrams(diagramSpec(false), context, {}, { maxRows: 20 })[0];
  assert.equal(hidden.groups.filter((group) => group.importRole && group.importRole.structureItemId === 'child').length, 0);
  const rootless = buildResultDiagrams(diagramSpec(true), { parents: { rows: [] }, children: { rows: [] } }, {}, { maxRows: 20 })[0];
  assert.equal(rootless.groups.filter((group) => group.importRole && group.importRole.structureItemId === 'child').length, 0);
});

test('runtime hides opted-out empty containers and keeps containers with visible descendants', () => {
  const diagram = buildResultDiagrams({
    version: 1,
    steps: [],
    result: { diagrams: [{
      name: 'empty-container-visibility',
      groupMappings: [
        {
          id: 'mapping_hidden_container',
          from: 'emptyContainers',
          fields: { id: 'Code', label: 'Description' },
          importRole: { key: 'scope-server', semantic: 'group', visualKind: 'container', showEmpty: false }
        },
        {
          id: 'mapping_visible_container',
          from: 'visibleContainers',
          fields: { id: 'Code', label: 'Description' },
          importRole: { key: 'scope-vlan', semantic: 'group', visualKind: 'container', showEmpty: false }
        },
        {
          id: 'mapping_hidden_structural_container',
          fields: { id: 'Code', label: 'Description' },
          staticRows: [{ Code: 'empty-frame', Description: 'Empty frame' }],
          importRole: { key: 'empty-frame', semantic: 'structural', visualKind: 'container', showEmpty: false }
        }
      ],
      nodeMappings: [{
        id: 'mapping_vlan',
        from: 'vlans',
        fields: { id: 'Code', label: 'Description', group: 'Scope' },
        importRole: { key: 'vlan', semantic: 'object', visualKind: 'node' }
      }]
    }] }
  }, {
    emptyContainers: { rows: [{ Code: 'server-scope', Description: 'Server scope' }] },
    visibleContainers: { rows: [{ Code: 'vlan-scope', Description: 'VLAN scope' }] },
    vlans: { rows: [{ Code: 'vlan-1', Description: 'VLAN 1', Scope: 'vlan-scope' }] }
  }, {}, { maxRows: 100 })[0];

  assert.equal(diagram.groups.length, 1);
  assert.equal(diagram.groups[0].id, 'mapping_visible_container:vlan-scope');
  assert.equal(diagram.nodes.length, 1);
  assert.equal(diagram.nodes[0].group, diagram.groups[0].id);
  assert.ok(diagram.execution.items.some((item) => item.role.key === 'scope-server' && item.status === 'omitted' && item.reason === 'emptyContainer'));
  assert.ok(diagram.execution.items.some((item) => item.role.key === 'empty-frame' && item.status === 'omitted' && item.reason === 'emptyContainer'));
});

test('diagram validation rejects malformed composite template structure', () => {
  const spec = {
    version: 1,
    steps: [],
    result: { diagrams: [{
      name: 'invalid-composite',
      nodeMappings: [{
        from: 'objects',
        fields: { id: 'Code', label: 'Description' },
        importRole: { key: 'users', semantic: 'composite' },
        d2Template: {
          version: 1,
          rootKey: 'users',
          groups: [{ key: 'users' }],
          nodes: [{ key: 'users.operator', parentKey: 'missing' }],
          edges: [{ sourceKey: 'users.operator', targetKey: 'missing', direction: 'sideways' }],
          hierarchies: []
        }
      }]
    }] }
  };
  const errors = validateTemplateSpec(spec);
  assert.ok(errors.some((item) => item.path.endsWith('.nodes[0].parentKey')));
  assert.ok(errors.some((item) => item.path.endsWith('.edges[0].targetKey')));
  assert.ok(errors.some((item) => item.path.endsWith('.edges[0].direction')));
});

test('runtime D2 ids remain unique when normalized labels collide', () => {
  const diagrams = buildResultDiagrams({
    result: { diagrams: [{
      name: 'collisions',
      nodeMappings: [{ from: 'objects', fields: { id: 'Id', label: 'Label' } }]
    }] }
  }, {
    objects: { rows: [{ Id: 'a-b', Label: 'Dash' }, { Id: 'a b', Label: 'Space' }] }
  }, {}, { maxRows: 10 });
  const ids = diagrams[0].nodes.map((node) => node.d2Id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(Object.keys(diagrams[0].data.objects).length, 2);
  ids.forEach((id) => assert.match(diagrams[0].d2.source, new RegExp(`${id}: \\{`)));
});

test('D2 assistant context removes retained raw source and structural IR', () => {
  const safe = diagramImportAssistantSpec({
    version: 1,
    steps: [],
    result: {
      diagrams: [{
        authoring: {
          d2Import: {
            source: 'secret-shaped D2 source',
            structure: { nodes: [{ id: 'server-a' }] },
            template: { title: 'Sensitive structure' },
            sourceHash: 'abc'
          }
        },
        nodeMappings: [{
          id: 'mapping_users',
          importRole: { key: 'users', semantic: 'composite' },
          d2Template: { version: 1, rootKey: 'users', nodes: [], groups: [], edges: [], hierarchies: [] }
        }]
      }, {
        nodeMappings: [{
          id: 'mapping_without_authoring',
          importRole: { key: 'services', semantic: 'composite' },
          d2Template: { version: 1, rootKey: 'services', nodes: [], groups: [], edges: [], hierarchies: [] }
        }]
      }]
    }
  });

  assert.equal(safe.result.diagrams[0].authoring.d2Import.source, undefined);
  assert.equal(safe.result.diagrams[0].authoring.d2Import.structure, undefined);
  assert.equal(safe.result.diagrams[0].authoring.d2Import.template, undefined);
  assert.equal(safe.result.diagrams[0].nodeMappings[0].d2Template, undefined);
  assert.equal(safe.result.diagrams[0].authoring.d2Import.sourceHash, 'abc');
  assert.equal(safe.result.diagrams[1].nodeMappings[0].d2Template, undefined);
});

test('D2 assistant context carries the persisted structure tree without raw source structure', () => {
  const source = 'switch: Switch { class: network-switch }';
  const proposal = createDiagramImportProposal({ version: 1, steps: [], result: { tables: [] } }, normalizeDiagramImportIr({
    version: 3,
    elements: { nodes: [{ id: 'switch', label: 'Switch', classKeys: ['network-switch'] }] },
    classes: [{ key: 'network-switch', usageCount: 1, sampleElementKeys: ['switch'] }]
  }, source), { sourceText: source });
  proposal.structure = { nodes: [{ key: 'secret-instance' }] };
  const safe = diagramImportAssistantSpec({ version: 1, steps: [], result: { tables: [] } }, proposal);
  const imported = safe.result.diagrams[0].authoring.d2Import;
  assert.equal(imported.version, 3);
  assert.equal(imported.roles[0].id, proposal.roles[0].id);
  assert.equal(imported.placementMappings[0].roleId, proposal.roles[0].id);
  assert.equal(imported.placementMappings[0].structureItemId, proposal.structureTree.items[0].id);
  assert.equal(Object.hasOwn(imported, 'roleMappings'), false);
  assert.equal(imported.source, undefined);
  assert.equal(imported.structure, undefined);
  assert.deepEqual(imported.structureTree, proposal.structureTree);
  assert.doesNotMatch(JSON.stringify(safe), /secret-instance/);
});

test('D2 class Notes are preserved as typed role guidance without exposing source structure', () => {
  const source = 'switch: Switch { class: network-switch }';
  const proposal = createDiagramImportProposal({ version: 1, steps: [], result: { tables: [] } }, normalizeDiagramImportIr({
    version: 3,
    elements: { nodes: [{ id: 'switch', label: 'Switch', classKeys: ['network-switch'] }] },
    classes: [{ key: 'network-switch', notes: 'CMDB switch endpoint. It participates in connections.', usageCount: 1, sampleElementKeys: ['switch'] }]
  }, source), { sourceText: source });
  const role = proposal.roles.find((item) => item.key === 'network-switch');
  assert.equal(role.notes, 'CMDB switch endpoint. It participates in connections.');
  const safe = diagramImportAssistantSpec({ version: 1, steps: [], result: { tables: [] } }, proposal);
  assert.equal(safe.result.diagrams[0].authoring.d2Import.roles[0].notes, role.notes);
  assert.equal(safe.result.diagrams[0].authoring.d2Import.structure, undefined);
});

test('D2 template grammar is derived from arbitrary AST role paths without role-name hardcode', () => {
  const source = 'region: Region { class: region-frame; street: Street { class: street-frame; address: Address { class: address-card } } }';
  const proposal = createDiagramImportProposal({ version: 1, steps: [], result: { tables: [] } }, normalizeDiagramImportIr({
    version: 3,
    elements: {
      groups: [
        { id: 'region', label: 'Region', classKeys: ['region-frame'] },
        { id: 'region.street', label: 'Street', parentKey: 'region', classKeys: ['street-frame'] }
      ],
      nodes: [{ id: 'region.street.address', label: 'Address', parentKey: 'region.street', classKeys: ['address-card'] }]
    },
    classes: [
      { key: 'region-frame', usageCount: 1, sampleElementKeys: ['region'] },
      { key: 'street-frame', usageCount: 1, sampleElementKeys: ['region.street'] },
      { key: 'address-card', usageCount: 1, sampleElementKeys: ['region.street.address'] }
    ]
  }, source), { sourceText: source });

  const street = proposal.templateGrammar.roles.find((role) => role.roleKey === 'street-frame');
  const address = proposal.templateGrammar.roles.find((role) => role.roleKey === 'address-card');
  assert.deepEqual(street.parentRoleKeys, ['region-frame']);
  assert.deepEqual(address.parentRoleKeys, ['street-frame']);
  assert.equal(proposal.templateGrammar.elements.find((item) => item.key === 'region.street.address').parentKey, 'region.street');
  assert.ok(proposal.templateGrammar.fingerprint);
});

test('D2 assistant interpretation changes role semantics but not the persisted structure tree', () => {
  const role = { id: 'role-workstation', visualKind: 'node', visualKindOptions: ['node', 'container'] };
  const roleModel = assistantDiagramStageDraftFromResponse({
    kind: 'interpretation',
    roleModelRevision: 11,
    roles: [role]
  }, {
    decisions: [{ roleId: role.id, visualKind: 'node', confidence: 'high', reason: 'Leaf card.' }]
  });
  assert.equal(roleModel.success, true);
  assert.deepEqual(roleModel.items, [{
    roleId: role.id,
    visualKind: 'node',
    labelTemplate: '',
    confidence: 'high',
    reason: 'Leaf card.'
  }]);
  assert.equal(Object.hasOwn(roleModel.items[0], 'sourceStageId'), false);
  assert.equal(Object.hasOwn(roleModel.items[0], 'repeatMode'), false);

  const { proposal, roles } = d2StructureTreeFixture();
  const interpretedTree = structuredClone(proposal.structureTree);
  assert.equal(interpretedTree.items.filter((item) => item.roleId === roles.vlan.id).length, 2);
});

test('D2 Assistant mapping keeps exact Object Flow stage metadata per placement', () => {
  const role = { id: 'role-workstation', visualKind: 'node', visualKindOptions: ['node'] };
  const mappingSpec = {
    result: { diagrams: [{ authoring: { d2Import: { placementMappings: [{
      structureItemId: 'placement-workstation',
      roleId: role.id,
      mapping: {
        materialization: { kind: 'stage', stageId: 'selection:workstations' },
        primary: { idAttribute: 'Code', labelTemplate: '${Description}', structuredFields: ['Code', 'model', 'notAvailable'] }
      }
    }] } } }] }
  };
  const mappings = assistantDiagramSelectionMappings(mappingSpec, { roles: [role] }, [{
    id: 'selection:workstations',
    kind: 'selection',
    alias: 'workstations',
    className: 'ARM',
    columns: ['Class', '_id', 'Code', 'Description', 'model']
  }]);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].structureItemId, 'placement-workstation');
  assert.deepEqual(mappings[0].source, { stageId: 'selection:workstations', alias: 'workstations', kind: 'selection', className: 'ARM' });
  assert.equal(mappings[0].mapping.primary.idAttribute, '_id');
  assert.deepEqual(mappings[0].mapping.primary.structuredFields, ['Description', 'Code', 'model']);
});

test('D2 import compiles only saved deterministic placement sources', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  proposal.dslSteps = [{ type: 'selectCards', as: 'assistant_alias', className: 'Other' }];
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);

  assert.equal(applied.steps.some((step) => step.as === 'assistant_alias'), false);
  assert.ok(applied.result.diagrams[0].nodeMappings.every((mapping) => mapping.from === 'systemsA'));
});

test('D2 structure tree rejects manual reparenting outside the declared template context', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const vlanItems = tree.items.filter((item) => item.roleId === roles.vlan.id);

  const firstParentId = vlanItems[0].parentId;
  vlanItems[0].parentId = vlanItems[1].parentId;
  vlanItems[1].parentId = firstParentId;
  const errors = diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure);
  assert.ok(errors.some((error) => /requires its declared parent container/.test(error.message)));
});

test('D2 structure tree permits an explicit duplicate static container in its declared context', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA');
  const scopeItems = tree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  const staticContainer = tree.items.find((item) => item.roleId === roles['group-dmz'].id);
  const target = tree.items.find((item) => item.roleId === roles['group-target'].id);

  const copiedStaticContainer = {
    ...structuredClone(staticContainer),
    id: 'structure:dmz-copy-a',
    parentId: target.id,
    mapping: { ...structuredClone(staticContainer.mapping), id: 'structure_mapping:dmz-copy-a' }
  };
  tree.items.push(copiedStaticContainer);
  const dmzScope = scopeItems.find((item) => item.parentId === staticContainer.id);
  dmzScope.parentId = copiedStaticContainer.id;

  assert.deepEqual(diagramImportStructureTreeErrors(tree, proposal.roles, currentSpec, proposal.structure), []);

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const groupMappings = applied.result.diagrams[0].groupMappings;
  const staticMappings = groupMappings.filter((mapping) => [staticContainer.id, copiedStaticContainer.id].includes(mapping.importRole.structureItemId));

  assert.equal(staticMappings.length, 2);
  assert.ok(staticMappings.every((mapping) => mapping.importRole.semantic === 'structural'));
  assert.deepEqual(new Set(staticMappings.map((mapping) => mapping.importRole.parentStructureItemId)), new Set([target.id]));
});

test('D2 relation-class Notes drive a data-fields direction suggestion without selecting it', () => {
  const roles = [
    { id: 'external', displayName: 'External', visualKind: 'node' },
    { id: 'application', displayName: 'Application', visualKind: 'node' }
  ];
  const mappings = [
    { roleId: 'external', source: { className: 'IS' } },
    { roleId: 'application', source: { className: 'ApplicG' } }
  ];
  const [requirement] = assistantDiagramTopologyRequirements([{
    d2ElementKey: 'edge-1', d2ClassKey: 'acl_external', d2Notes: 'ACL uses source and destination IP address fields.',
    d2ExampleLabels: ['TCP 443'], parentRoleId: 'external', childRoleId: 'application', direction: '->'
  }], roles, mappings, [{ id: 'selection:acl', label: 'ACL external', className: 'ACL', kind: 'selection', columns: ['ipaddress', 'dipaddress', 'Description'] }], null, 1);
  assert.equal(requirement.trafficOrProtocol, true);
  assert.equal(requirement.directionPolicySuggestion, 'dataFields');
  assert.equal(requirement.directionPolicy, '');
  assert.equal(requirement.networkEndpointStages[0].sourceStageId, 'selection:acl');
});

test('D2 relation candidates prefer a dedicated named descendant by label and lineage', () => {
  const roles = [
    { id: 'outside', visualType: 'outside_system', displayName: 'Outside system', visualKind: 'node' },
    { id: 'inside', visualType: 'inside_system', displayName: 'Inside system', visualKind: 'node' },
    { id: 'service', visualType: 'service', displayName: 'Service', visualKind: 'node' }
  ];
  const mappings = [
    { roleId: 'outside', source: { alias: 'outsideRows', className: 'System' } },
    { roleId: 'inside', source: { alias: 'insideRows', className: 'System' } },
    { roleId: 'service', source: { alias: 'services', className: 'Service' } }
  ];
  const columns = ['ipaddress', 'dipaddress', 'Description'];
  const stages = [
    { id: 'selection:allLinks', alias: 'allLinks', label: 'All links', className: 'Link', columns, lineageAliases: ['allLinks'], lineageLabels: ['All links'] },
    { id: 'match:outsideLinks', alias: 'outsideLinks', label: 'Outside links', className: 'Link', columns, lineageAliases: ['outsideLinks', 'allLinks', 'outsideRows'], lineageLabels: ['Outside links', 'All links', 'Outside systems'] },
    { id: 'match:insideLinks', alias: 'insideLinks', label: 'Inside links', className: 'Link', columns, lineageAliases: ['insideLinks', 'allLinks', 'insideRows'], lineageLabels: ['Inside links', 'All links', 'Inside systems'] }
  ];
  const [outsideRequirement] = assistantDiagramTopologyRequirements([{
    d2ElementKey: 'outside-edge', d2ClassKey: 'outside_link', d2Notes: 'Connect only objects in outside_system.',
    parentRoleId: 'outside', childRoleId: 'service', direction: '->'
  }], roles, mappings, stages, null, 1);

  assert.equal(outsideRequirement.networkEndpointStages[0].sourceStageId, 'match:outsideLinks');
  assert.ok(outsideRequirement.networkEndpointStages[0].semanticScore > outsideRequirement.networkEndpointStages[1].semanticScore);
  assert.ok(outsideRequirement.networkEndpointStages[0].mappedRoleKeys.includes('outside_system'));
});

test('D2 role mapping does not synthesize related data from relation-source metadata', () => {
  const stages = [{
    id: 'relation:applications', alias: 'applications', className: 'Application', kind: 'relation', columns: ['_id', 'Description'],
    relationSource: { className: 'Address', domain: 'ApplicationAddress', direction: 'destination', structuredFields: ['Value'] }
  }];
  const [mapped] = assistantDiagramAttachRelatedNetworkStages([{
    roleId: 'application',
    source: { stageId: 'relation:applications', alias: 'applications' },
    mapping: { related: [] }
  }], [{ id: 'application', visualKind: 'node' }], stages);

  assert.deepEqual(mapped.mapping.related, []);
});

test('D2 topology validation replaces one reused broad result with unique named descendants', () => {
  const columns = ['ipaddress', 'dipaddress', 'Description'];
  const stages = [
    { id: 'selection:outsideRows', alias: 'outsideRows', label: 'Outside systems', className: 'System', kind: 'selection', columns: ['_id', 'Description'] },
    { id: 'selection:services', alias: 'services', label: 'Services', className: 'Service', kind: 'selection', columns: ['_id', 'Description'] },
    { id: 'selection:allLinks', alias: 'allLinks', label: 'All links', className: 'Link', kind: 'selection', columns },
    { id: 'match:outsideLinks', alias: 'outsideLinks', label: 'Outside links', className: 'Link', kind: 'semiJoin', columns },
    { id: 'match:insideLinks', alias: 'insideLinks', label: 'Inside links', className: 'Link', kind: 'semiJoin', columns }
  ];
  const candidate = (id, stageId, score) => ({
    candidateId: id,
    sourceStageId: stageId,
    sourceField: 'ipaddress',
    targetField: 'dipaddress',
    labelField: 'Description',
    semanticScore: score
  });
  const topology = [{
    d2ElementKey: 'outside-edge', d2ClassKey: 'outside_link', sourceRoleId: 'outside', targetRoleId: 'service', directionPolicy: 'dataFields',
    networkEndpointStages: [candidate('outside', 'match:outsideLinks', 3), candidate('all-outside', 'selection:allLinks', 1)]
  }, {
    d2ElementKey: 'inside-edge', d2ClassKey: 'inside_link', sourceRoleId: 'outside', targetRoleId: 'service', directionPolicy: 'dataFields',
    networkEndpointStages: [candidate('inside', 'match:insideLinks', 3), candidate('all-inside', 'selection:allLinks', 1)]
  }];
  const draft = assistantDiagramStageDraftFromResponse({
    kind: 'mapping', mappingPhase: 'topology', stages, topology, associations: [],
    roles: [
      { id: 'outside', displayName: 'Outside', visualKind: 'node' },
      { id: 'service', displayName: 'Service', visualKind: 'node' }
    ],
    acceptedItems: [
      { roleId: 'outside', source: { stageId: 'selection:outsideRows', alias: 'outsideRows', className: 'System' }, mapping: { id: 'outside-map' } },
      { roleId: 'service', source: { stageId: 'selection:services', alias: 'services', className: 'Service' }, mapping: { id: 'service-map' } }
    ]
  }, {
    relationRules: [{
      d2ElementKey: 'outside_link', mode: 'networkEndpoints', candidateId: 'all-outside', sourceStageId: 'selection:allLinks', sourceField: 'ipaddress', targetField: 'dipaddress', labelField: 'Description'
    }, {
      d2ElementKey: 'inside_link', mode: 'networkEndpoints', candidateId: 'all-inside', sourceStageId: 'selection:allLinks', sourceField: 'ipaddress', targetField: 'dipaddress', labelField: 'Description'
    }]
  });

  assert.equal(draft.success, true);
  assert.deepEqual(draft.relationRules.map((rule) => rule.sourceStageId).sort(), ['match:insideLinks', 'match:outsideLinks']);
  assert.deepEqual(draft.relationRules.map((rule) => rule.directionPolicy), ['dataFields', 'dataFields']);
  assert.equal(draft.connectionUnresolved.length, 0);
  assert.equal(draft.warnings.filter((warning) => warning.includes('uniquely matching named result')).length, 2);
  assert.equal(draft.warnings.filter((warning) => warning.includes('unique connection contract')).length, 2);
});

test('D2 Assistant repairs only an unambiguous object-flow stage kind prefix', () => {
  const stages = [
    { id: 'relation:block_5' },
    { id: 'selection:block_6' }
  ];
  assert.equal(assistantDiagramResolveStageId('relation:block_5', stages), 'relation:block_5');
  assert.equal(assistantDiagramResolveStageId('match:block_5', stages), 'relation:block_5');
  assert.equal(assistantDiagramResolveStageId('block_5', stages), '');
  assert.equal(assistantDiagramResolveStageId('match:block_7', stages), '');
  assert.equal(assistantDiagramResolveStageId('match:block_5', stages.concat({ id: 'selection:block_5' })), '');
});

test('D2 mapping persists a source only on its owning structure item', () => {
  const currentSpec = selectionFlowSpec([
    { alias: 'physicalServers', className: 'Server', columns: ['Code', 'Description'] },
    { alias: 'virtualServers', className: 'Server', columns: ['Code', 'Description'] }
  ]);
  const source = 'server: Server { class: server-role }';
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 3,
    elements: { nodes: [{ id: 'server', label: 'Server', classKeys: ['server-role'] }] },
    classes: [{ key: 'server-role', usageCount: 1, sampleElementKeys: ['server'] }]
  }, source), { sourceText: source });
  const role = proposal.roles[0];
  const tree = structureTreeItemWithSource(proposal.structureTree, proposal.structureTree.items[0].id, 'selection:physicalServers');
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const [mapping] = applied.result.diagrams[0].nodeMappings;

  assert.equal(applied.result.diagrams[0].nodeMappings.length, 1);
  assert.equal(mapping.from, 'physicalServers');
  assert.equal(mapping.importRole.structureItemId, tree.items[0].id);
  assert.equal(Object.hasOwn(applied.result.diagrams[0].authoring.d2Import, 'roleMappings'), false);
  assert.equal(applied.result.diagrams[0].structureTree.items[0].mapping.materialization.stageId, 'selection:physicalServers');
  assert.equal(role.id, applied.result.diagrams[0].structureTree.items[0].mapping.roleId);
});

test('diagram validation rejects duplicate stable mapping ids', () => {
  const spec = {
    version: 1,
    steps: [{ type: 'selectCards', as: 'objects', className: 'Server' }],
    result: {
      tables: [{ name: 'objects' }],
      diagrams: [{
        id: 'diagram_main',
        name: 'main',
        nodeMappings: [{ id: 'mapping_same', from: 'objects', fields: { id: 'Code' } }],
        groupMappings: [{ id: 'mapping_same', from: 'objects', fields: { id: 'Code' } }]
      }]
    }
  };
  assert.ok(validateTemplateSpec(spec).some((item) => item.path === '$.result.diagrams[0].groupMappings[0].id'));
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

test('runtime json automatically links normalized URL cells and honors text override', () => {
  const result = {
    tables: [{
      name: 'final',
      columns: ['PortalUrl', 'UnsafeUrl'],
      rows: [{ PortalUrl: 'https://portal.example/item/42', UnsafeUrl: 'javascript:alert(1)' }],
      cellMeta: {
        0: {
          PortalUrl: { autoHref: 'https://portal.example/item/42' },
          UnsafeUrl: {}
        }
      },
      presentation: {}
    }]
  };
  const automatic = runtimeJsonResponsePayload({ success: true, result });
  assert.equal(automatic.tables[0].rows[0].links.PortalUrl.href, 'https://portal.example/item/42');
  assert.equal(Object.hasOwn(automatic.tables[0].rows[0].links, 'UnsafeUrl'), false);

  result.tables[0].presentation = { columnLinks: { PortalUrl: { mode: 'text' } } };
  const textOnly = runtimeJsonResponsePayload({ success: true, result });
  assert.deepEqual(textOnly.tables[0].rows[0], {
    PortalUrl: 'https://portal.example/item/42',
    UnsafeUrl: 'javascript:alert(1)'
  });

  result.tables[0].presentation = {
    columnLinks: {
      PortalUrl: {
        mode: 'auto',
        urlTemplate: 'https://stale.example/${mysource.value}',
        textTemplate: 'stale label',
        target: 'blank'
      }
    }
  };
  const explicitAuto = runtimeJsonResponsePayload({ success: true, result });
  assert.deepEqual(explicitAuto.tables[0].rows[0].links.PortalUrl, {
    href: 'https://portal.example/item/42',
    text: 'https://portal.example/item/42',
    value: 'https://portal.example/item/42',
    target: 'blank'
  });
});

test('published result table overrides legacy final-table visibility', () => {
  const payload = runtimeJsonResponsePayload({
    success: true,
    result: {
      presentation: { outputMode: 'tables' },
      tables: [
        { name: 'first', title: 'First', columns: ['Code'], rows: [{ Code: 'FIRST' }] },
        { name: 'published', title: 'Published', published: true, columns: ['Code'], rows: [{ Code: 'PUBLISHED' }] },
        { name: 'last', title: 'Last', columns: ['Code'], rows: [{ Code: 'LAST' }] }
      ]
    }
  });
  assert.deepEqual(payload.tables.map((table) => table.name), ['published']);
  assert.equal(payload.tables[0].rows[0].Code, 'PUBLISHED');
  assert.deepEqual(validateTemplateSpec({
    version: 1,
    steps: [{ type: 'extractVariables', as: 'first', sourceValue: 'first', regex: '.*', all: false }],
    result: { tables: [{ name: 'first', published: true }, { name: 'second', published: true }] }
  }).filter((error) => error.path === '$.result.tables').map((error) => error.message), ['Only one result table can be published.']);
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
  assert.equal(diagrams[0].edges[0].source, 'srv-1');
  assert.equal(diagrams[0].edges[0].target, 'vlan-1');
  assert.equal(diagrams[0].edges[0].label, 'connected');
  assert.match(diagrams[0].d2.source, /vars: \{/);
  assert.match(diagrams[0].d2.source, /data: \{/);
  assert.match(diagrams[0].d2.source, /cmdp: \{/);
  assert.doesNotMatch(diagrams[0].d2.source, /base64|cmdp:metadata/i);
  assert.match(diagrams[0].svg.metadata, /<metadata id="cmdp-diagram-data" type="application\/json">/);
  diagrams[0].svg.content = '<svg data-cmdp-d2-rendered="true"><text>Rendered by D2</text></svg>';
  diagrams[0].svg.rendered = true;
  diagrams[0].svg.renderer = 'd2';
  diagrams[0].svg.layout = 'dagre';

  const payload = runtimeJsonResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'topology' },
    result: { diagrams }
  });
  assert.equal(payload.diagrams.length, 1);
  assert.equal(payload.diagrams[0].nodes.length, 2);
  assert.equal(payload.diagrams[0].edges[0].label, 'connected');
  assert.equal(payload.diagrams[0].d2.source, undefined);
  assert.equal(payload.diagrams[0].d2.downloadAvailable, true);
  assert.equal(payload.diagrams[0].d2.sourceHash, diagrams[0].d2.sourceHash);
  assert.equal(payload.diagrams[0].d2.metadataEmbedded, true);
  assert.equal(payload.diagrams[0].svg.metadataEmbedded, false);
  assert.equal(payload.diagrams[0].svg.rendered, true);
  assert.equal(payload.diagrams[0].svg.content, undefined);
  assert.equal(payload.diagrams[0].svg.metadata, undefined);
  assert.equal(payload.diagrams[0].svg.renderer, 'd2');

  const displayPayload = runtimeDisplayResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'topology' },
    result: { diagrams }
  });
  assert.equal(displayPayload.result.diagrams[0].d2.source, undefined);
  assert.equal(displayPayload.result.diagrams[0].d2.downloadAvailable, true);
  assert.match(displayPayload.result.diagrams[0].svg.content, /Rendered by D2/);
  assert.equal(displayPayload.result.diagrams[0].nodes[0].data, undefined);
});

test('D2 execution contract accounts for every row of the explicitly selected Object Flow result', () => {
  const diagram = buildResultDiagrams({
    result: {
      diagrams: [{
        name: 'internal-systems',
        nodeMappings: [{
          id: 'mapping_internal_systems',
          from: 'internalSystems',
          fields: { id: '_id', label: 'Description' },
          importRole: { key: 'internal_system', label: 'Внутренние ИС', sourceLabel: 'Внутренние ИС' }
        }]
      }]
    }
  }, {
    internalSystems: {
      rows: [
        { _id: 'dns', Description: 'DNS' },
        { _id: 'ad', Description: 'AD' }
      ]
    }
  }, {}, { maxRows: 100 })[0];

  assert.deepEqual(diagram.nodes.map((node) => node.label).sort(), ['AD', 'DNS']);
  assert.deepEqual(diagram.execution.bindings, [{
    family: 'node',
    role: { key: 'internal_system', label: 'Внутренние ИС' },
    source: {
      stageLabel: 'Внутренние ИС',
      alias: 'internalSystems',
      baseInputRows: 2,
      filtered: false,
      sourceResolution: { resolved: 0, equivalent: 0, ambiguous: 0, unavailable: 0 },
      materialization: ''
    },
    inputRows: 2,
    materialized: 2,
    duplicates: 0,
    omitted: { missingId: 0, limit: 0, invalid: 0, emptyContainer: 0 },
    templateResolution: { explicit: 0, businessKey: 0, exemplar: 0, roleDefault: 0, unavailable: 2 },
    placementResolution: { parentCorrelation: 0, sourceKey: 0, structuralSingleParent: 0, unresolved: 0 }
  }]);
  assert.deepEqual(diagram.execution.items.map((item) => ({
    role: item.role.label,
    source: item.source.stageLabel,
    label: item.label,
    status: item.status,
    placement: item.placement
  })), [
    { role: 'Внутренние ИС', source: 'Внутренние ИС', label: 'DNS', status: 'materialized', placement: 'resolved' },
    { role: 'Внутренние ИС', source: 'Внутренние ИС', label: 'AD', status: 'materialized', placement: 'resolved' }
  ]);
  assert.ok(diagram.execution.items.every((item) => item.d2Path));
  assert.equal(diagram.execution.svgContract.status, 'pending');
});

test('D2 SVG execution contract reports the materialized item that is absent from SVG', () => {
  const d2Path = 'internal_system_ad';
  const token = Buffer.from(d2Path, 'utf8').toString('base64');
  const diagram = {
    execution: {
      items: [
        { family: 'node', role: { key: 'internal_system', label: 'Внутренние ИС' }, label: 'DNS', status: 'materialized', d2Path: 'internal_system_dns' },
        { family: 'node', role: { key: 'internal_system', label: 'Внутренние ИС' }, label: 'AD', status: 'materialized', d2Path }
      ]
    }
  };
  const svg = '<svg><g class="shape ' + token + '"></g></svg>';

  assert.equal(svgContainsD2ElementKey(svg, d2Path), true);
  assert.deepEqual(diagramSvgExecutionContract(diagram, svg), {
    status: 'failed',
    expected: 2,
    verified: 1,
    missing: [{
      family: 'node',
      role: { key: 'internal_system', label: 'Внутренние ИС' },
      label: 'DNS',
      d2Path: 'internal_system_dns'
    }]
  });
});

test('result diagrams retain unresolved connections as fake endpoint objects', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'partial-topology',
      nodeMappings: [{ from: 'nodes', fields: { id: 'Id', label: 'Label' } }],
      edgeMappings: [{ from: 'edges', fields: { source: 'Source', target: 'Target', label: 'Label' } }]
    }] }
  }, {
    nodes: { rows: [{ Id: 'known', Label: 'Known node' }] },
    edges: { rows: [
      { Source: 'known', Target: '', Label: 'missing target' },
      { Source: '', Target: 'external-card', Label: 'missing source' }
    ] }
  }, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 2);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 3);
  assert.ok(diagram.edges.every((edge) => edge.source && edge.target));
  assert.ok(diagram.edges.every((edge) => edge.sourceMissing || edge.targetMissing));
  assert.doesNotMatch(diagram.warnings.join('\n'), /Skipped edge without source or target/);
  assert.doesNotMatch(diagram.d2.source, /Не извлечено:|Нет данных/);
  assert.match(diagram.d2.source, /Заглушка/);
});

test('result diagrams deduplicate relation rows by relation class and card identity', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'deduplicated-topology',
      nodeMappings: [{ staticRows: [{ Id: 'application-a', Label: 'Application A' }, { Id: 'application-b', Label: 'Application B' }], fields: { id: 'Id', label: 'Label' } }],
      edgeMappings: [{
        staticRows: [
          { _id: 101, Source: 'application-a', Target: 'application-b', Label: 'TCP 443' },
          { _id: 101, Source: 'application-a', Target: 'application-b', Label: 'TCP 443' }
        ],
        fields: { source: 'Source', target: 'Target', label: 'Label' },
        importRole: { edgeClassKey: 'acl_intrasystem' }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.nodes.length, 2);
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].label, 'TCP 443');
});

test('network endpoint mappings classify shared relation rows by D2 endpoint roles', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'role-aware-network-topology',
      nodeMappings: [
        {
          id: 'external',
          from: 'external',
          fields: { id: '_id', label: 'Description' },
          relatedBindings: [{
            id: 'network',
            alias: 'externalNetworks',
            structuredFields: ['range'],
            conditions: {
              ruleJoin: 'all',
              rules: [{ action: 'include', operator: 'equals', left: { column: 'SourceId' }, right: { kind: 'stage', stageId: 'external', column: '_id' } }]
            }
          }],
          importRole: { key: 'external_system' }
        },
        {
          id: 'applications',
          from: 'applications',
          fields: { id: '_id', label: 'Description' },
          relatedBindings: [{
            id: 'address',
            alias: 'applicationAddresses',
            structuredFields: ['ipAddr'],
            conditions: {
              ruleJoin: 'all',
              rules: [{ action: 'include', operator: 'equals', left: { column: 'SourceId' }, right: { kind: 'stage', stageId: 'applications', column: '_id' } }]
            }
          }],
          importRole: { key: 'application' }
        }
      ],
      edgeMappings: [
        {
          id: 'external-acl',
          type: 'networkEndpoints',
          from: 'acl',
          fields: { source: 'ipaddress', target: 'dipaddress', label: 'Description' },
          endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'dataFields' },
          importRole: { key: 'acl_external', edgeClassKey: 'acl_external', sourceKey: 'external_system', targetKey: 'application', directionPolicy: 'dataFields' }
        },
        {
          id: 'internal-acl',
          type: 'networkEndpoints',
          from: 'acl',
          fields: { source: 'ipaddress', target: 'dipaddress', label: 'Description' },
          endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'dataFields' },
          importRole: { key: 'acl_intrasystem', edgeClassKey: 'acl_intrasystem', sourceKey: 'application', targetKey: 'application', directionPolicy: 'dataFields' }
        }
      ]
    }] }
  }, {
    external: { rows: [
      { _id: 'external-1', Description: 'External 1', range: '192.168.6.0/24' },
      { _id: 'external-2', Description: 'External 2', range: '192.168.6.0/24' }
    ] },
    externalNetworks: { rows: [
      { SourceId: 'external-1', range: '192.168.6.0/24' },
      { SourceId: 'external-2', range: '192.168.6.0/24' }
    ] },
    applications: { rows: [
      { _id: 'app-1', Description: 'App 1', inheritedRange: '192.168.6.0/24' },
      { _id: 'app-2', Description: 'App 2', inheritedRange: '192.168.6.0/24' }
    ] },
    applicationAddresses: { rows: [{ SourceId: 'app-1', ipAddr: '192.168.1.1' }, { SourceId: 'app-2', ipAddr: '192.168.4.3' }] },
    acl: { rows: [
      { _id: 'acl-external', Description: 'External to app', ipaddress: '192.168.6.1', dipaddress: '192.168.1.1' },
      { _id: 'acl-inside', Description: 'App to app', ipaddress: '192.168.1.1', dipaddress: '192.168.4.3' },
      { _id: 'acl-missing', Description: 'External to missing', ipaddress: '192.168.6.1', dipaddress: '192.168.1.99' }
    ] }
  }, {}, { maxRows: 100 })[0];

  assert.deepEqual(diagram.edges.map((edge) => edge.label).sort(), [
    'App to app',
    'External to app',
    'External to app',
    'External to missing',
    'External to missing'
  ]);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 1);
  assert.match(diagram.warnings.join('\n'), /Skipped D2 network row acl-inside for relation class acl_external/);
  assert.match(diagram.warnings.join('\n'), /Skipped D2 network row acl-external for relation class acl_intrasystem/);
  assert.match(diagram.warnings.join('\n'), /Expanded D2 network row acl-external to 2 endpoint combinations/);
  assert.doesNotMatch(diagram.warnings.join('\n'), /ambiguousNetwork/);
});

test('strict D2 grammar omits a connection whose endpoint is absent from the approved structure', () => {
  const grammar = {
    version: 3,
    fingerprint: 'test-grammar',
    elements: [
      { key: 'root-template', kind: 'group', roleKey: 'root-role', parentKey: '', parentRoleKey: '' },
      { key: 'root-template.child-template', kind: 'node', roleKey: 'child-role', parentKey: 'root-template', parentRoleKey: 'root-role' }
    ],
    roles: [
      { roleId: 'root', roleKey: 'root-role', label: 'Root', semantic: 'structural', mode: 'static', rootAllowed: true, parentRoleKeys: [], childRoleKeys: ['child-role'], elementKeys: ['root-template'], nodeElementKeys: [], groupElementKeys: ['root-template'], exemplarKey: 'root-template' },
      { roleId: 'child', roleKey: 'child-role', label: 'Child', semantic: 'object', mode: 'static', rootAllowed: false, parentRoleKeys: ['root-role'], childRoleKeys: [], elementKeys: ['root-template.child-template'], nodeElementKeys: ['root-template.child-template'], groupElementKeys: [], exemplarKey: 'root-template.child-template' }
    ],
    contexts: [
      { key: 'context:root', roleId: 'root', parentContextKey: '', elementKeys: ['root-template'] },
      { key: 'context:child', roleId: 'child', parentContextKey: 'context:root', elementKeys: ['root-template.child-template'] }
    ],
    edges: [{ key: '(root-template.child-template -> root-template.child-template)[0]', sourceKey: 'root-template.child-template', targetKey: 'root-template.child-template', sourceRoleKey: 'child-role', targetRoleKey: 'child-role', direction: '->' }]
  };
  const spec = (groupValue) => ({
    result: { diagrams: [{
      name: 'strict-template',
      templateGrammar: grammar,
      structureTree: {
        version: 5,
        items: [
          { id: 'root-tree-item', roleId: 'root', templateContextKey: 'context:root', templateElementKey: 'root-template', templateElementKeys: ['root-template'], parentId: '', mapping: {} },
          { id: 'child-tree-item', roleId: 'child', templateContextKey: 'context:child', templateElementKey: 'root-template.child-template', templateElementKeys: ['root-template.child-template'], parentId: 'root-tree-item', mapping: {} }
        ]
      },
      groupMappings: [{ id: 'root', from: 'incorrectRootData', fields: { id: '_id', label: 'Description' }, importRole: { roleId: 'root', key: 'root-role', semantic: 'group', elementKey: 'root-template', structureItemId: 'root-tree-item' } }],
      nodeMappings: [{ id: 'child', staticRows: [{ _id: 'known', Description: 'Known', Group: groupValue }], fields: { id: '_id', label: 'Description', group: 'Group' }, labelTemplate: '${Description}', importRole: { roleId: 'child', key: 'child-role', semantic: 'object', elementKey: 'root-template.child-template', structureItemId: 'child-tree-item', parentStructureItemId: 'root-tree-item' } }],
      edgeMappings: [{ id: 'edge', staticRows: [{ Source: 'known', Target: 'missing', Label: 'uses' }], fields: { source: 'Source', target: 'Target', label: 'Label' }, importRole: { key: 'edge-role', semantic: 'connection', elementKey: '(root-template.child-template -> root-template.child-template)[0]', sourceKey: 'child-role', targetKey: 'child-role' } }]
    }] }
  });

  const diagram = buildResultDiagrams(spec('root-template'), {
    incorrectRootData: { rows: [{ _id: 'wrong-a', Description: 'Wrong A' }, { _id: 'wrong-b', Description: 'Wrong B' }] }
  }, {}, { maxRows: 20 })[0];
  const root = diagram.groups.find((group) => group.importRole.key === 'root-role');
  assert.ok(root);
  assert.equal(root.label, 'Root');
  assert.equal(diagram.groups.filter((group) => group.importRole.key === 'root-role').length, 1);
  assert.equal(diagram.nodes.some((node) => node.fakeEndpoint), false);
  assert.equal(diagram.nodes.every((node) => node.importRole.key === 'child-role'), true);
  assert.equal(diagram.nodes[0].label, 'Known');
  assert.equal(diagram.nodes.some((node) => node.label === 'Child'), false);
  assert.equal(diagram.edges.length, 0);
  assert.match(diagram.warnings.join('\n'), /endpoint cards are absent from the approved D2 structure/);
});

test('strict D2 grammar ignores stale generic mappings instead of emitting undeclared runtime elements', () => {
  const grammar = {
    version: 3,
    fingerprint: 'strict-stale-mapping-grammar',
    elements: [
      { key: 'root-template', kind: 'group', roleKey: 'root-role', parentKey: '', parentRoleKey: '' },
      { key: 'root-template.child-template', kind: 'node', roleKey: 'child-role', parentKey: 'root-template', parentRoleKey: 'root-role' }
    ],
    roles: [
      { roleId: 'root', roleKey: 'root-role', label: 'Root', visualKind: 'container', rootAllowed: true, parentRoleKeys: [], childRoleKeys: ['child-role'], elementKeys: ['root-template'], nodeElementKeys: [], groupElementKeys: ['root-template'] },
      { roleId: 'child', roleKey: 'child-role', label: 'Child', visualKind: 'node', rootAllowed: false, parentRoleKeys: ['root-role'], childRoleKeys: [], elementKeys: ['root-template.child-template'], nodeElementKeys: ['root-template.child-template'], groupElementKeys: [] }
    ],
    contexts: [
      { key: 'context:root', roleId: 'root', parentContextKey: '', elementKeys: ['root-template'] },
      { key: 'context:child', roleId: 'child', parentContextKey: 'context:root', elementKeys: ['root-template.child-template'] }
    ],
    edges: [{ key: '(root-template.child-template -> root-template.child-template)[0]', sourceKey: 'root-template.child-template', targetKey: 'root-template.child-template', sourceRoleKey: 'child-role', targetRoleKey: 'child-role', direction: '->' }]
  };
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'strict-stale-mappings',
      templateGrammar: grammar,
      structureTree: {
        version: 5,
        items: [
          { id: 'root-tree-item', roleId: 'root', templateContextKey: 'context:root', templateElementKey: 'root-template', templateElementKeys: ['root-template'], parentId: '', mapping: {} },
          { id: 'child-tree-item', roleId: 'child', templateContextKey: 'context:child', templateElementKey: 'root-template.child-template', templateElementKeys: ['root-template.child-template'], parentId: 'root-tree-item', mapping: {} }
        ]
      },
      groupMappings: [{ id: 'root', staticRows: [{ _id: 'root', Description: 'Root' }], fields: { id: '_id', label: 'Description' }, importRole: { roleId: 'root', key: 'root-role', elementKey: 'root-template', structureItemId: 'root-tree-item' } }],
      nodeMappings: [
        { id: 'child', staticRows: [{ _id: 'known', Description: 'Known' }], fields: { id: '_id', label: 'Description' }, importRole: { roleId: 'child', key: 'child-role', elementKey: 'root-template.child-template', structureItemId: 'child-tree-item' } },
        { id: 'legacy-node', staticRows: [{ _id: 'legacy', Description: 'Legacy' }], fields: { id: '_id', label: 'Description' } }
      ],
      edgeMappings: [
        { id: 'declared-edge', staticRows: [{ Source: 'known', Target: 'missing', Label: 'uses' }], fields: { source: 'Source', target: 'Target', label: 'Label' }, importRole: { key: 'edge-role', elementKey: '(root-template.child-template -> root-template.child-template)[0]', sourceKey: 'child-role', targetKey: 'child-role' } },
        { id: 'legacy-edge', staticRows: [{ Source: 'legacy', Target: 'missing', Label: 'legacy' }], fields: { source: 'Source', target: 'Target', label: 'Label' } }
      ]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.nodes.some((node) => node.businessId === 'legacy'), false);
  assert.equal(diagram.edges.some((edge) => edge.label === 'legacy'), false);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
  assert.match(diagram.warnings.join('\n'), /Ignored D2 runtime mapping outside the current template contract: legacy-node: missing declared D2 role/);
  assert.match(diagram.warnings.join('\n'), /Ignored D2 runtime mapping outside the current template contract: legacy-edge: missing declared D2 edge blueprint/);
});

test('strict D2 placement preserves copied branches and omits a node outside its declared parent branch', () => {
  const grammar = {
    version: 3,
    fingerprint: 'copied-branches-grammar',
    elements: [
      { key: 'root', kind: 'group', roleKey: 'root-role', parentKey: '', parentRoleKey: '' },
      { key: 'root.scope', kind: 'group', roleKey: 'scope-role', parentKey: 'root', parentRoleKey: 'root-role' },
      { key: 'root.scope.server', kind: 'node', roleKey: 'server-role', parentKey: 'root.scope', parentRoleKey: 'scope-role' }
    ],
    roles: [
      { roleId: 'root', roleKey: 'root-role', label: 'Root', visualKind: 'container', elementKeys: ['root'], nodeElementKeys: [], groupElementKeys: ['root'] },
      { roleId: 'scope', roleKey: 'scope-role', label: 'Scope', visualKind: 'container', elementKeys: ['root.scope'], nodeElementKeys: [], groupElementKeys: ['root.scope'] },
      { roleId: 'server', roleKey: 'server-role', label: 'Server', visualKind: 'node', elementKeys: ['root.scope.server'], nodeElementKeys: ['root.scope.server'], groupElementKeys: [] }
    ],
    contexts: [],
    edges: []
  };
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'copied-branches',
      templateGrammar: grammar,
      structureTree: {
        version: 5,
        items: [
          { id: 'root-item', roleId: 'root', templateElementKey: 'root', parentId: '', mapping: {} },
          { id: 'scope-a', roleId: 'scope', templateElementKey: 'root.scope', parentId: 'root-item', mapping: {} },
          { id: 'scope-b', roleId: 'scope', templateElementKey: 'root.scope', parentId: 'root-item', mapping: {} },
          { id: 'server-a', roleId: 'server', templateElementKey: 'root.scope.server', parentId: 'scope-a', mapping: {} },
          { id: 'server-b', roleId: 'server', templateElementKey: 'root.scope.server', parentId: 'scope-b', mapping: {} }
        ]
      },
      groupMappings: [
        {
          id: 'root-mapping',
          staticRows: [{ _id: 'root-card', Description: 'Root' }],
          fields: { id: '_id', label: 'Description' },
          importRole: { roleId: 'root', key: 'root-role', semantic: 'structural', elementKey: 'root', structureItemId: 'root-item' }
        },
        {
          id: 'scope-a-mapping', from: 'scopesA', fields: { id: '_id', label: 'Description' },
          importRole: { roleId: 'scope', key: 'scope-role', semantic: 'group', elementKey: 'root.scope', structureItemId: 'scope-a', parentStructureItemId: 'root-item' }
        },
        {
          id: 'scope-b-mapping', from: 'scopesB', fields: { id: '_id', label: 'Description' },
          importRole: { roleId: 'scope', key: 'scope-role', semantic: 'group', elementKey: 'root.scope', structureItemId: 'scope-b', parentStructureItemId: 'root-item' }
        }
      ],
      nodeMappings: [
        {
          id: 'server-a-mapping', from: 'serversA', fields: { id: '_id', label: 'Description' },
          importRole: {
            roleId: 'server', key: 'server-role', semantic: 'object', elementKey: 'root.scope.server',
            structureItemId: 'server-a', parentStructureItemId: 'scope-a',
            parentCorrelations: [{ parentStructureItemId: 'scope-a', childColumn: 'ScopeCode', parentColumn: 'Code', operator: 'equals', caseSensitive: false }]
          }
        },
        {
          id: 'server-b-mapping', from: 'serversB', fields: { id: '_id', label: 'Description' },
          importRole: {
            roleId: 'server', key: 'server-role', semantic: 'object', elementKey: 'root.scope.server',
            structureItemId: 'server-b', parentStructureItemId: 'scope-b',
            parentCorrelations: [{ parentStructureItemId: 'scope-b', childColumn: 'ScopeCode', parentColumn: 'Code', operator: 'equals', caseSensitive: false }]
          }
        }
      ]
    }] }
  }, {
    scopesA: { rows: [{ _id: 'scope-a-card', Code: 'A', Description: 'Scope A' }] },
    scopesB: { rows: [{ _id: 'scope-b-card', Code: 'B', Description: 'Scope B' }] },
    serversA: { rows: [
      { _id: 'server-a-card', ScopeCode: 'A', Description: 'Server A' },
      { _id: 'server-outside-card', ScopeCode: 'outside', Description: 'Server outside branch' }
    ] },
    serversB: { rows: [{ _id: 'server-b-card', ScopeCode: 'B', Description: 'Server B' }] }
  }, {}, { maxRows: 50 })[0];

  const root = diagram.groups.find((group) => group.importRole.structureItemId === 'root-item');
  const scopeA = diagram.groups.find((group) => group.importRole.structureItemId === 'scope-a');
  const scopeB = diagram.groups.find((group) => group.importRole.structureItemId === 'scope-b');
  assert.ok(root);
  assert.ok(scopeA);
  assert.ok(scopeB);
  assert.equal(scopeA.parent, root.id);
  assert.equal(scopeB.parent, root.id);
  assert.deepEqual(diagram.nodes.map((node) => node.label).sort(), ['Server A', 'Server B']);
  assert.equal(diagram.nodes.find((node) => node.label === 'Server A').group, scopeA.id);
  assert.equal(diagram.nodes.find((node) => node.label === 'Server B').group, scopeB.id);
  assert.equal(diagram.nodes.some((node) => /mapping_/.test(node.label)), false);
  assert.ok(diagram.unplaced.some((item) => item.structureItemId === 'server-a' && item.businessId === 'server-outside-card'));
});

test('result diagrams build graph mappings for groups hierarchy and object relation edges', () => {
  const spec = {
    version: 1,
    steps: [{ type: 'selectCards', as: 'graphNodes', className: 'Server', columns: ['Id', 'Label'] }],
    result: {
      diagrams: [{
        name: 'infra',
        title: 'Infrastructure graph',
        nodeMappings: [{
          from: 'graphNodes',
          labelTemplate: '${Id} ${Label}',
          dataProfile: {
            name: 'cmdb-node'
          },
          fields: {
            id: 'Id',
            label: 'Label',
            group: 'Vlan',
            parent: 'Parent',
            nodeType: 'Kind',
            href: 'Href'
          }
        }],
        edgeMappings: [{
          type: 'object',
          from: 'aclRows',
          labelTemplate: '${Port} ${Action}',
          dataProfile: {
            name: 'cmdb-edge'
          },
          fields: {
            source: 'Source',
            target: 'Target',
            label: 'Port',
            edgeType: 'Action',
            edgeDirection: 'Direction'
          }
        }],
        groupMappings: [{
          from: 'vlans',
          labelTemplate: '${Vlan} ${Name}',
          importRole: {
            key: 'vlan',
            semantic: 'group',
            styleHints: { style: { fill: '#FAFAFA', stroke: '#9E9E9E' } }
          },
          fields: { id: 'Vlan', label: 'Name' }
        }],
        hierarchyMappings: [{
          from: 'contains',
          labelTemplate: '${Relation}',
          fields: { parent: 'Parent', child: 'Child', label: 'Relation' }
        }],
        layout: { type: 'hierarchical' },
        maxNodes: 20,
        maxEdges: 20,
        metadata: {
          embedInD2: true,
          embedInSvg: true,
          maxBytes: 200000
        }
      }]
    }
  };
  assert.deepEqual(validateTemplateSpec(spec), []);

  const diagrams = buildResultDiagrams(spec, {
    graphNodes: {
      rows: [
        { Class: 'Server', _id: 1, Id: 'srv-1', Label: 'Server 1', Vlan: 'vlan-10', Kind: 'server', Href: '/cmdbuild/ui/#classes/Server/cards/1' },
        { Id: 'docker-1', Label: 'Docker 1', Vlan: 'vlan-10', Parent: 'srv-1', Kind: 'container' },
        { Id: 'svc-1', Label: 'Service 1', Vlan: 'vlan-10', Parent: 'docker-1', Kind: 'service' }
      ]
    },
    aclRows: {
      rows: [{ Source: 'srv-1', Target: 'svc-1', Port: '443/tcp', Action: 'allow', Direction: 'direct' }]
    },
    vlans: {
      rows: [{ Vlan: 'vlan-10', Name: 'VLAN 10' }]
    },
    contains: {
      rows: [
        { Parent: 'srv-1', Child: 'docker-1', Relation: 'hosts' },
        { Parent: 'docker-1', Child: 'svc-1', Relation: 'runs' }
      ]
    }
  }, {}, { maxRows: 100 });

  assert.equal(diagrams.length, 1);
  assert.equal(diagrams[0].layout.type, 'hierarchical');
  assert.equal(diagrams[0].nodes.length, 3);
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'srv-1').label, 'srv-1 Server 1');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'srv-1').data.fields.Kind.display, 'server');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'srv-1').data.fields.Id.display, 'srv-1');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'srv-1').data.fields.Label.display, 'Server 1');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'srv-1').data.className, 'Server');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'srv-1').data.sourceRef.id, '1');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'docker-1').parent, 'srv-1');
  assert.equal(diagrams[0].nodes.find((node) => node.id === 'svc-1').type, 'service');
  assert.equal(diagrams[0].groups[0].id, 'vlan:vlan-10');
  assert.equal(diagrams[0].groups[0].businessId, 'vlan-10');
  assert.equal(diagrams[0].groups[0].label, 'vlan-10 VLAN 10');
  assert.equal(diagrams[0].groups[0].data.fields.Name.display, 'VLAN 10');
  assert.ok(diagrams[0].edges.some((edge) => edge.source === 'srv-1' && edge.target === 'svc-1' && edge.mappingType === 'object' && edge.kind === 'allow' && edge.direction === 'direct'));
  assert.equal(diagrams[0].edges.find((edge) => edge.source === 'srv-1' && edge.target === 'svc-1').data.fields.Action.display, 'allow');
  assert.equal(diagrams[0].edges.find((edge) => edge.source === 'srv-1' && edge.target === 'svc-1').data.fields.Direction.display, 'direct');
  assert.ok(diagrams[0].edges.some((edge) => edge.source === 'srv-1' && edge.target === 'docker-1' && edge.mappingType === 'hierarchy'));
  assert.match(diagrams[0].d2.source, /vars: \{/);
  assert.match(diagrams[0].d2.source, /cmdp: \{/);
  assert.match(diagrams[0].d2.source, /node_srv_1/);
  const serverNode = diagrams[0].nodes.find((node) => node.id === 'srv-1');
  const vlanGroup = diagrams[0].groups.find((group) => group.businessId === 'vlan-10');
  assert.equal(serverNode.d2Path, `${vlanGroup.d2Path}.${serverNode.d2Id}`);
  assert.match(diagrams[0].d2.source, new RegExp(`${vlanGroup.d2Id}: \\{[\\s\\S]*${serverNode.d2Id}: \\{`));
  assert.match(diagrams[0].d2.source, /fill: "#FAFAFA"/);
  assert.equal(diagrams[0].data.objects[serverNode.d2Path].fields.Kind.display, 'server');
  assert.match(diagrams[0].svg.metadata, /cmdp-diagram-data/);

  const payload = runtimeJsonResponsePayload({
    success: true,
    action: 'run',
    template: { code: 'infra' },
    result: { diagrams }
  });
  assert.equal(payload.diagrams[0].nodes.find((node) => node.id === 'docker-1').parent, 'srv-1');
  assert.equal(payload.diagrams[0].groups[0].id, 'vlan:vlan-10');
  assert.equal(payload.diagrams[0].edges.find((edge) => edge.mappingType === 'object').kind, 'allow');
  assert.equal(payload.diagrams[0].nodes.find((node) => node.id === 'srv-1').data, undefined);
  assert.equal(payload.diagrams[0].data, undefined);
  assert.equal(payload.diagrams[0].d2.source, undefined);
  assert.equal(payload.diagrams[0].d2.downloadAvailable, true);

  const stripped = stripSensitiveDiagramArtifacts({ diagrams }, { includeSvgContent: false });
  assert.equal(stripped.diagrams[0].nodes.find((node) => node.id === 'srv-1').data, undefined);
  assert.equal(stripped.diagrams[0].svg.content, '');
  assert.equal(stripped.diagrams[0].d2.downloadAvailable, true);
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
  assert.equal(assistantLiteLlmTimeoutMs({ assistant: { mcp: { timeoutMs: 1 } } }), 1000);
  assert.equal(assistantLiteLlmTimeoutMs({ assistant: { mcp: { timeoutMs: 60000 } } }), 60000);
  assert.equal(assistantLiteLlmTimeoutMs({ assistant: { mcp: { timeoutMs: 60001 } } }), 60000);
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

test('template row limits are not reported as MCP context truncation', () => {
  const warnings = assistantLimitWarningsFromDiagnostics([
    {
      source: 'template-execution',
      limitName: 'maxRows',
      configuredLimit: 25,
      returned: 25,
      truncated: true,
      limitHit: true
    },
    {
      source: 'mcp',
      tool: 'buildAssistantMcpContext',
      limitName: 'maxContextBytes',
      configuredLimit: 64000,
      returned: 80000,
      truncated: true,
      limitHit: true
    }
  ]);

  assert.match(warnings[0], /Template execution row limit reached: returned 25 of configured maxRows=25/);
  assert.doesNotMatch(warnings[0], /MCP context/i);
  assert.match(warnings[1], /buildAssistantMcpContext context limit reached/);
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
  assert.match(defaultConfig.assistant.prompt.objectFlow, /ObjectFlowProposal/);
  assert.match(defaultConfig.assistant.prompt.diagramInterpretation, /D2 class/);
  assert.match(defaultConfig.assistant.prompt.diagramMapping, /stage ids/);
  assert.equal(normalizedDefault.prompt.objectFlow, defaultConfig.assistant.prompt.objectFlow);

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

test('object-flow planning messages keep the full-flow contract and configured prompt separate from user input', () => {
  const messages = assistantObjectFlowMessages(
    {
      intent: { context: '', blocks: [{ id: 'servers', name: 'Servers', entities: 'Servers', algorithm: 'Select servers.', expectedResult: 'Server cards', uses: [] }] },
      semanticPlan: { version: 1, blocks: [] },
      planningText: 'Business data block: Servers.',
      currentSpec: { version: 1, steps: [], result: { tables: [] } }
    },
    { enabled: false },
    {
      assistant: {
        prompt: {
          system: 'Custom common CMDB rule.',
          objectFlow: 'Custom full-flow CMDB rule.'
        }
      }
    }
  );

  assert.equal(messages.length, 4);
  assert.equal(messages[0].content, 'Custom common CMDB rule.');
  assert.equal(messages[1].content, 'Custom full-flow CMDB rule.');
  assert.match(messages[2].content, /"flow"/);
  assert.match(messages[3].content, /Business data block/);
  assert.doesNotMatch(messages[3].content, /Custom full-flow CMDB rule/);

  const parameterMessages = assistantObjectFlowMessages(
    {
      intent: { context: '', blocks: [{ id: 'is', name: 'Information systems', entities: 'ИС', algorithm: 'Найти ИС по параметру isName.', expectedResult: 'ИС', uses: [] }] },
      semanticPlan: { version: 1, blocks: [] },
      planningText: 'Найти ИС по параметру isName.',
      currentSpec: {
        version: 1,
        params: [{ name: 'isName', label: 'Information system', type: 'string', required: true }],
        steps: [],
        result: { tables: [] }
      }
    },
    { enabled: false },
    defaultRuntimeConfig()
  );
  assert.match(parameterMessages[2].content, /availableParameters/);
  assert.match(parameterMessages[3].content, /"name":"isName"/);
});

test('object-flow intent drops obsolete extraction-candidate fields and keeps forward block dependencies', () => {
  const intent = normalizeAssistantObjectFlowIntent({
    context: '',
    extractionCandidateBlockId: 'applications',
    extractionCandidateAlias: 'applicationsResult',
    blocks: [
      { id: 'applications', name: 'Applications', entities: 'Application', algorithm: 'Select applications.', expectedResult: 'Applications.', uses: ['networks'] },
      { id: 'networks', name: 'Networks', entities: 'ipRange', algorithm: 'Select networks.', expectedResult: 'Networks.', uses: [] }
    ]
  });
  assert.deepEqual(intent.blocks[0].uses, ['networks']);
  assert.equal(Object.hasOwn(intent, 'extractionCandidateBlockId'), false);
  assert.equal(Object.hasOwn(intent, 'extractionCandidateAlias'), false);
  assert.throws(
    () => normalizeAssistantObjectFlowIntent({ context: '', blocks: [{ id: 'applications', name: 'Applications', entities: 'Application', algorithm: 'Select applications.', expectedResult: 'Applications.', uses: ['missing'] }] }),
    /another declared block/
  );
  assert.throws(
    () => normalizeAssistantObjectFlowIntent({ context: '', blocks: [{ id: 'applications', name: 'Applications', entities: 'Application', algorithm: 'Select applications.', expectedResult: 'Applications.', uses: ['applications'] }] }),
    /another declared block/
  );
  const obsolete = normalizeAssistantObjectFlowIntent({ context: '', extractionCandidateBlockId: 'missing', extractionCandidateAlias: 'legacyAlias', blocks: [{ id: 'applications', name: 'Applications', entities: 'Application', algorithm: 'Select applications.', expectedResult: 'Applications.', uses: [] }] });
  assert.equal(Object.hasOwn(obsolete, 'extractionCandidateBlockId'), false);
  assert.equal(Object.hasOwn(obsolete, 'extractionCandidateAlias'), false);
});

test('object-flow proposal adapter accepts equivalent LLM field names before strict validation', () => {
  const candidate = assistantObjectFlowCandidate({
    version: 1,
    selections: [
      {
        id: 'routers',
        class: { name: 'routerG' },
        as: 'routers',
        fields: ['Code', 'Description', 'Location'],
        filters: [{ field: 'Description', operator: 'equal', value: 'Маршрутизатор для Test City 300' }]
      },
      {
        id: 'arms',
        classCode: 'ARM',
        alias: 'arms',
        sourceAlias: 'routers',
        attributes: ['Code', 'Description', 'Location', 'model', 'model2'],
        filters: [{ field: 'Location', operator: 'equal', sourceColumn: 'Location' }]
      }
    ],
    operations: [{
      operation: 'match',
      id: 'coLocated',
      alias: 'matchedObjects',
      leftAlias: 'routers',
      rightAlias: 'arms',
      rules: [{ op: 'equal', left: { field: 'Location' }, right: { field: 'Location' } }]
    }]
  });

  assert.deepEqual(candidate.flow.selections.map((selection) => ({ id: selection.id, alias: selection.alias, className: selection.className, from: selection.from })), [
    { id: 'selection:routers', alias: 'routers', className: 'routerG', from: '' },
    { id: 'selection:arms', alias: 'arms', className: 'ARM', from: 'routers' }
  ]);
  assert.equal(candidate.flow.operations[0].id, 'match:coLocated');
  assert.equal(candidate.flow.operations[0].from, 'routers');
  assert.equal(candidate.flow.operations[0].with, 'arms');
  assert.equal(candidate.flow.operations[0].rules[0].operator, 'equals');
  assert.deepEqual(candidate.flow.selections[1].rules[0], {
    action: 'include', path: 'Location', negate: false, op: 'equals', rightExpression: '${previous.Location}'
  });
});

test('object-flow proposal adapter normalizes common relation direction aliases before validation', () => {
  const candidate = assistantObjectFlowCandidate({
    version: 1,
    selections: [{
      id: 'systems',
      className: 'IS',
      alias: 'systems',
      columns: ['Name'],
      rules: [{ path: 'Name', valueParam: 'isName' }]
    }],
    operations: [{
      operation: 'relation',
      id: 'ranges',
      from: 'systems',
      as: 'ranges',
      domain: 'ISZabbixMonitoringDomain',
      targetClass: 'ipRange',
      direction: 'source-to-target',
      columns: ['range']
    }]
  });

  assert.equal(candidate.flow.operations[0].type, 'relation');
  assert.equal(candidate.flow.operations[0].direction, 'source');
  assert.deepEqual(candidate.warnings, []);
});

test('object-flow proposal adapter repairs empty selection rules with an explicit warning', () => {
  const candidate = assistantObjectFlowCandidate({
    version: 1,
    selections: [{
      id: 'arms',
      className: 'ARM',
      alias: 'arms',
      columns: ['Code'],
      rules: [{}]
    }],
    operations: []
  });

  assert.deepEqual(candidate.flow.selections[0].rules, [{
    action: 'include',
    path: 'Code',
    negate: false,
    op: 'matches',
    rightExpression: '.*'
  }]);
  assert.match(candidate.warnings.join(' '), /selection arms had no usable filter/);
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

test('assistant resolves a short Cyrillic class acronym only as an exact Code match', () => {
  const candidates = assistantCandidateClassesFromSummary({
    classes: [
      { name: 'IS', description: 'Информационная система' },
      { name: 'C2MService', description: 'Сервис ИС' },
      { name: 'C2MSystem', description: 'Подсистема' }
    ]
  }, ['ис'], 5);

  assert.deepEqual(candidates.map((item) => item.name), ['IS']);
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

test('assistant system prompt documents source-row selection with rightExpression', () => {
  const messages = assistantMessages({
    intent: 'same location as router',
    currentSpec: { version: 1, steps: [], result: { tables: [] } },
    taskMode: 'tables'
  }, { enabled: false }, defaultRuntimeConfig());

  assert.ok(messages.some((message) => /rightExpression/.test(message.content) && /selectCards\.from/.test(message.content)));
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
          nodeMappings: [{
            from: 'nodes',
            labelTemplate: '${NodeName} ${NodeModel}',
            dataProfile: { fields: ['NodeSerial'] },
            fields: {
              id: 'NodeCode',
              label: 'NodeName',
              group: '_Location_description',
              href: 'NodeUrl'
            }
          }],
          edgeMappings: [{
            from: 'edges',
            dataProfile: { fields: ['LinkProtocol'] },
            fields: {
              source: 'FromNode',
              target: 'ToNode',
              label: 'LinkName'
            }
          }]
        }
      ]
    }
  };

  const map = dependencyMapWithHash(spec);

  assert.deepEqual(
    map.selections.find((item) => item.as === 'nodes').directFields.sort(),
    ['Class', '_id', 'Code', 'Description', 'NodeCode', 'NodeName', 'Location', 'NodeUrl', 'NodeModel', 'NodeSerial'].sort()
  );
  assert.deepEqual(
    map.selections.find((item) => item.as === 'edges').directFields.sort(),
    ['Class', '_id', 'Code', 'Description', 'FromNode', 'ToNode', 'LinkName', 'LinkProtocol'].sort()
  );
});

test('dependency map resolves D2 related binding fields through their materialized relation alias', () => {
  const spec = {
    version: 1,
    steps: [
      { type: 'selectCards', className: 'IS', as: 'systems', columns: ['Code'] },
      {
        type: 'expandRelations',
        as: 'systemRanges',
        from: 'systems',
        targetClass: 'ipRange',
        domain: 'ISZabbixMonitoringDomain',
        direction: 'source',
        columns: ['range']
      }
    ],
    result: {
      diagrams: [{
        name: 'topology',
        nodeMappings: [{
          id: 'systems-role',
          from: 'systems',
          dataProfile: { fields: ['related_range.range', 'primary.Code'] },
          relatedBindings: [{
            id: 'related_range',
            alias: 'systemRanges',
            structuredFields: ['range']
          }]
        }]
      }]
    }
  };

  const map = dependencyMapWithHash(spec);
  const systems = map.selections.find((item) => item.as === 'systems');
  const ranges = map.selections.find((item) => item.as === 'systemRanges');

  assert.ok(systems);
  assert.ok(ranges);
  assert.equal(systems.directFields.includes('related_range'), false);
  assert.equal(systems.directFields.includes('primary'), false);
  assert.equal(systems.directFields.includes('Code'), true);
  assert.equal(ranges.kind, 'expandRelations');
  assert.equal(ranges.className, 'ipRange');
  assert.equal(ranges.directFields.includes('range'), true);
  assert.deepEqual(map.invalidDiagramDependencies, []);
});

test('dependency map reports unresolved generated D2 related binding references', () => {
  const spec = {
    version: 1,
    steps: [{ type: 'selectCards', className: 'IS', as: 'systems', columns: ['Code'] }],
    result: {
      diagrams: [{
        name: 'topology',
        nodeMappings: [{
          id: 'systems-role',
          from: 'systems',
          dataProfile: { fields: ['related_missing.range'] },
          relatedBindings: []
        }]
      }]
    }
  };

  const map = dependencyMapWithHash(spec);
  assert.equal(map.selections.find((item) => item.as === 'systems').directFields.includes('related_missing'), false);
  assert.deepEqual(map.invalidDiagramDependencies, [{
    mappingId: 'systems-role',
    source: 'systems',
    field: 'related_missing.range',
    message: 'Diagram mapping references related binding related_missing, but that binding is not materialized.'
  }]);
});
