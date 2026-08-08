import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  applyTemplateParamDefaults,
  assistantCandidateClassesFromSummary,
  assistantClassMentionsFromText,
  assistantDiagramSelectionMappings,
  assistantDiagramNotesHasNaturalLanguage,
  assistantEditorDeltaFromSpec,
  applyAssistantEditorDelta,
  assistantDiagramAttachRelatedNetworkStages,
  assistantDiagramPlacementCorrection,
  assistantDiagramPlacementDraftFromResponse,
  assistantDiagramPlacementExecutionValidation,
  assistantDiagramRecoverParentCardMappings,
  assistantDiagramPlacementTargets,
  assistantDiagramEndpointProfilesFromBindings,
  assistantObjectFlowBusinessBlockManifest,
  assistantDataSemanticModel,
  assistantD2StructuralModel,
  assistantD2SemanticModel,
  assistantD2BindingIntentModel,
  assistantD2BindingModel,
  assistantSemanticObligationModel,
  assistantD2CritiqueModel,
  assistantCoverageModel,
  assistantDiagramBindingIntentSeed,
  normalizeAssistantDiagramBindingIntentResponse,
  assistantDiagramBindingIntentDraftFromResponse,
  assistantDiagramMappingCoverage,
  assistantDiagramTopologyWithBindingIntent,
  assistantDiagramSemanticObligations,
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
  boundedMcpText,
  cmdbuildClassAttributesPath,
  d2RendererConfigSummary,
  d2CacheContext,
  d2SourceForCompiler,
  d2WorkflowStatusForSpec,
  diagramAuthoringStatusForSpec,
  decorateD2MarkdownFrames,
  diagramSvgExecutionContract,
  d2ImportConfigSummary,
  diagramImportDeterministicSpecHash,
  diagramImportImplicitConditionSources,
  diagramImportInferImplicitConditionSource,
  diagramImportDirectRelationParentCorrelation,
  diagramImportBindRelationRulesToStructureItems,
  diagramImportTopologyRules,
  diagramImportEndpointProfiles,
  diagramImportEndpointProfilesForStructure,
  diagramImportCompileRoleMapping,
  diagramMappingField,
  diagramImportMappingInputRevision,
  diagramImportMappingValidationIsCurrent,
  signDiagramImportMappingValidation,
  diagramImportCloneStructureBranch,
  diagramImportStructureTree,
  diagramImportStructureTreeErrors,
  embedDiagramSvgMetadata,
  executionValidationForSpec,
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
  normalizeAssistantPromptContract,
  normalizeApplicationVersion,
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
  templateOutputIncludesDiagrams,
  templateAssistantRuntimeConfig,
  validateRuntimeConfig,
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

test('application version uses the pre-handoff fallback and accepts only the handoff format', () => {
  assert.equal(normalizeApplicationVersion(undefined), '0.0.0.0');
  assert.equal(normalizeApplicationVersion('00.00.00.00\n'), '0.0.0.0');
  assert.equal(normalizeApplicationVersion('00.00.00.01\n'), '00.00.00.01');
  assert.throws(() => normalizeApplicationVersion('0.0.0.0\n'), /VERSION must contain exactly/);
  assert.throws(() => normalizeApplicationVersion('00.00.00.01'), /VERSION must contain exactly/);
  assert.throws(() => normalizeApplicationVersion('00.00.00.01\nextra'), /VERSION must contain exactly/);
});

test('invalid application version is reported through runtime configuration validation', () => {
  const validation = validateRuntimeConfig({
    nodeEnv: 'development',
    redisEnabled: false,
    logTargets: ['stdout'],
    applicationVersionError: 'VERSION must contain exactly XX.YY.ZZ.NN followed by a newline.'
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors.filter((error) => error.code === 'application_version_invalid'), [{
    code: 'application_version_invalid',
    file: 'VERSION',
    message: 'VERSION must contain exactly XX.YY.ZZ.NN followed by a newline.'
  }]);
});

test('invalid build identity is reported through runtime configuration validation', () => {
  const validation = validateRuntimeConfig({
    nodeEnv: 'development',
    redisEnabled: false,
    logTargets: ['stdout'],
    applicationBuildError: 'BUILD_INFO.json version does not match VERSION.'
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors.filter((error) => error.code === 'application_build_invalid'), [{
    code: 'application_build_invalid',
    file: 'BUILD_INFO.json',
    message: 'BUILD_INFO.json version does not match VERSION.'
  }]);
});

test('template Assistant system prompt overrides inherit global policy without mutating it', () => {
  const runtimeConfig = {
    assistant: {
      prompt: {
        system: 'Global system prompt.',
        objectFlowSemantic: 'Global semantic prompt.',
        objectFlow: 'Global flow prompt.',
        diagramSemantics: 'Global interpretation prompt.',
        diagramPlacement: 'Global placement prompt.',
        diagramConnections: 'Global connection prompt.'
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
    system: 'Template-specific system prompt.'
  });
  assert.equal(stored.authoring.assistant.systemPromptOverrides.unknown, undefined);

  const effective = normalizeAssistantRuntimeConfig(templateAssistantRuntimeConfig(runtimeConfig, stored));
  const inherited = normalizeAssistantRuntimeConfig(runtimeConfig);
  assert.equal(effective.prompt.system, 'Template-specific system prompt.');
  assert.equal(effective.prompt.diagramSemantics, 'Global interpretation prompt.');
  assert.equal(effective.prompt.diagramPlacement, 'Global placement prompt.');
  assert.equal(effective.prompt.diagramConnections, 'Global connection prompt.');
  assert.equal(effective.prompt.objectFlow, 'Global flow prompt.');
  assert.equal(effective.prompt.objectFlowSemantic, 'Global semantic prompt.');
  assert.equal(effective.prompt.diagramSemantics, 'Global interpretation prompt.');
  assert.equal(inherited.prompt.system, 'Global system prompt.');
  assert.equal(inherited.prompt.diagramPlacement, 'Global placement prompt.');
  assert.equal(inherited.prompt.diagramConnections, 'Global connection prompt.');
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
  assert.equal(resetEffective.prompt.diagramPlacement, 'Global placement prompt.');
  assert.equal(resetEffective.prompt.diagramConnections, 'Global connection prompt.');
});

test('Assistant editor delta excludes generated diagrams and preserves saved output state on merge', () => {
  const saved = {
    version: 1,
    params: [{ name: 'systemCode', type: 'string' }],
    result: {
      tables: [{ name: 'old' }],
      diagrams: [{ name: 'saved-diagram' }],
      cache: { enabled: true }
    },
    publish: { mode: 'tableAndDiagram' }
  };
  const edited = structuredClone(saved);
  edited.result.tables = [{ name: 'new' }];
  edited.result.diagrams = [{ name: 'generated-preview' }];
  edited.authoring = { version: 1, assistant: { diagramIntentPrompt: 'Show dependencies.' } };

  const delta = assistantEditorDeltaFromSpec(edited);
  assert.equal(delta.version, 1);
  assert.match(delta.hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(delta.spec.result, 'diagrams'), false);
  assert.equal(Object.hasOwn(delta.spec, 'publish'), false);

  const merged = applyAssistantEditorDelta(saved, delta);
  assert.deepEqual(merged.result.tables, [{ name: 'new' }]);
  assert.deepEqual(merged.result.diagrams, [{ name: 'saved-diagram' }]);
  assert.deepEqual(merged.result.cache, { enabled: true });
  assert.deepEqual(merged.publish, { mode: 'tableAndDiagram' });
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

test('D2 mapping input revision tracks executable stage inputs but ignores presentation and unused columns', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const tree = structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsB');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? {
        ...item,
        mapping: {
          ...item.mapping,
          primary: { ...(item.mapping && item.mapping.primary || {}), labelTemplate: '${Code}' },
          conditions: {
            ruleJoin: 'all',
            rules: [{
              action: 'include', operator: 'equals', left: { column: 'Code' },
              right: { kind: 'literal', value: 'active' }
            }]
          }
        }
      }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const imported = structuredClone(applied.result.diagrams[0].authoring.d2Import);
  imported.relationRules = [{
    d2ElementKey: 'used-field-contract',
    sourceStageId: 'selection:systemsB',
    sourceField: 'BusinessKey',
    targetField: 'BusinessKey'
  }];
  const objectMatching = (spec) => spec.visualModels.find((model) => model.mode === 'objectMatching');
  const selection = (spec, alias) => objectMatching(spec).selections.find((item) => item.alias === alias);
  const updateSelectionColumns = (spec, alias, update) => {
    for (const model of Array.isArray(spec.visualModels) ? spec.visualModels : []) {
      for (const item of Array.isArray(model && model.selections) ? model.selections : []) {
        if (String(item && item.alias || '') !== alias) continue;
        item.columns = update(Array.isArray(item.columns) ? item.columns.slice() : []);
        if (item.source && Array.isArray(item.source.columns)) item.source.columns = item.columns.slice();
        if (item.output && Array.isArray(item.output.columns)) item.output.columns = item.columns.slice();
      }
    }
    for (const table of spec.result && Array.isArray(spec.result.tables) ? spec.result.tables : []) {
      if (String(table && table.name || '') === alias) table.columns = update(Array.isArray(table.columns) ? table.columns.slice() : []);
    }
  };
  updateSelectionColumns(applied, 'systemsB', (columns) => Array.from(new Set(columns.concat('BusinessKey'))));
  const revision = (mutate) => {
    const spec = structuredClone(applied);
    mutate(spec);
    return diagramImportMappingInputRevision(spec, imported);
  };
  const baseline = diagramImportMappingInputRevision(applied, imported);

  assert.notDeepEqual(revision((spec) => {
    selection(spec, 'systemsB').rules[0].rightExpression = 'active';
  }), baseline, 'a selected-stage filter changes executable mapping input');
  assert.notDeepEqual(revision((spec) => {
    selection(spec, 'systemsB').from = 'systemsA';
  }), baseline, 'a selected-stage dependency changes executable mapping input');
  assert.notDeepEqual(revision((spec) => {
    updateSelectionColumns(spec, 'systemsB', (columns) => columns.filter((field) => field !== 'BusinessKey'));
  }), baseline, 'removing a field used by the mapping changes executable mapping input');
  assert.deepEqual(revision((spec) => {
    selection(spec, 'systemsB').name = 'Presentation-only label';
  }), baseline, 'a stage label is not executable mapping input');
  assert.deepEqual(revision((spec) => {
    updateSelectionColumns(spec, 'systemsB', (columns) => columns.concat('UnusedPresentationColumn'));
  }), baseline, 'an unused materialized column is not executable mapping input');
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

test('legacy D2 endpoint rules become independent rules for copied placements', () => {
  const roles = [{ id: 'server', key: 'server', label: 'Сервер', visualKind: 'node' }];
  const tree = {
    version: 5,
    items: [
      { id: 'server-a', roleId: 'server', parentId: '', mapping: { materialization: { kind: 'stage', stageId: 'selection:phServers' } } },
      { id: 'server-b', roleId: 'server', parentId: '', mapping: { materialization: { kind: 'stage', stageId: 'selection:phServers' } } }
    ]
  };
  const profiles = diagramImportEndpointProfilesForStructure([{
    id: 'server-ip', roleId: 'server', stageId: 'selection:phServers', field: 'ipaddress', operators: ['ipv4InCidr']
  }], tree, roles);

  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((profile) => profile.structureItemId).sort(), ['server-a', 'server-b']);
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, 2);
  assert.ok(profiles.every((profile) => profile.stageId === ''));
});

test('template storage preserves retired assistantDraft for an explicit current-only reset', () => {
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
  assert.deepEqual(stored, before);
  assert.equal(diagramAuthoringStatusForSpec(stored).status, 'unsupported');
});

test('template storage recovers Object Flow labels without Assistant and is idempotent', () => {
  const before = {
    version: 1,
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: {
          version: 2,
          context: '',
          blocks: [{ id: 'block-1', name: 'Внутренние ИС', entities: 'IS', algorithm: 'Select IS.', expectedResult: 'Внутренние ИС', usesBlockIds: [], order: 1 }]
        }
      },
      d2: { source: '' }
    },
    visualModels: [{
      version: 1,
      mode: 'objectMatching',
      selections: [
        { id: 'selection:block_1', name: 'Внутренние ИС', alias: 'block_1', className: 'IS', from: '', limit: 100, columns: [], rules: [{ action: 'include', path: 'Code', op: 'exists' }] },
        { id: 'selection:block_2', name: 'block_2', alias: 'block_2', className: 'IS', from: '', limit: 100, columns: [], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }
      ],
      operations: [],
      outputs: [
        { alias: 'block_1', label: 'Внутренние ИС', kind: 'selection', assistantManaged: true, assistantBlockId: 'block-1' },
        { alias: 'block_2', label: 'block_2', kind: 'selection', assistantManaged: true, assistantBlockId: 'block-1' }
      ],
      output: { alias: 'block_2', title: 'block_2' }
    }],
    steps: [
      { type: 'selectCards', className: 'IS', filters: [], limit: 100, as: 'block_1' },
      { type: 'selectCards', className: 'IS', filters: [], limit: 100, as: 'block_2' }
    ],
    result: {
      tables: [
        { name: 'block_1', title: 'Внутренние ИС', columns: [] },
        { name: 'block_2', title: 'block_2', columns: [] }
      ]
    }
  };

  const stored = normalizeTemplateSpecForStorage(before);
  const model = stored.visualModels.find((item) => item.mode === 'objectMatching');
  assert.deepEqual(model.outputs.map((output) => ({ alias: output.alias, label: output.label, assistantManaged: output.assistantManaged })), [
    { alias: 'block_1', label: 'Внутренние ИС', assistantManaged: undefined },
    { alias: 'block_2', label: 'Выборка 2', assistantManaged: undefined }
  ]);
  assert.equal(model.assistantOutputManifest, undefined);
  assert.deepEqual(stored.result.tables.map((table) => [table.name, table.title]), [
    ['block_1', 'Внутренние ИС'],
    ['block_2', 'block_2']
  ]);
  assert.equal(stored.authoring.assistant.objectFlowIntent.blocks[0].name, 'Внутренние ИС');
  assert.deepEqual(normalizeTemplateSpecForStorage(stored), stored);
});

test('Object Flow storage canonicalizes legacy operations without losing the final result', () => {
  const before = {
    version: 1,
    visualModels: [{
      version: 1,
      mode: 'objectMatching',
      selections: [
        { id: 'selection:left', name: 'Левая выборка', alias: 'left', className: 'Asset', limit: 100, columns: ['Code'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] },
        { id: 'selection:right', name: 'Правая выборка', alias: 'right', className: 'Asset', limit: 100, columns: ['Code'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }
      ],
      blocks: [{
        id: 'match:joined', from: 'left', with: 'right', as: 'joined', rightPrefix: 'Right.',
        rules: [{ action: 'include', operator: 'equals', leftColumn: 'Code', rightColumn: 'Code' }]
      }],
      setOperations: [],
      output: { alias: 'joined', title: 'Результат сопоставления' }
    }],
    steps: [
      { type: 'selectCards', className: 'Asset', filters: [], limit: 100, as: 'left' },
      { type: 'selectCards', className: 'Asset', filters: [], limit: 100, as: 'right' },
      { type: 'matchRows', from: 'left', with: 'right', rules: [], rightPrefix: 'Right.', as: 'joined' }
    ],
    result: { tables: [
      { name: 'left', title: 'Левая выборка', columns: [] },
      { name: 'right', title: 'Правая выборка', columns: [] },
      { name: 'joined', title: 'Пользовательский заголовок', columns: [] }
    ] }
  };
  const outcomes = [];
  const stored = normalizeTemplateSpecForStorage(before, '', { objectFlowOutcomes: outcomes });
  const model = stored.visualModels.find((item) => item.mode === 'objectMatching');

  assert.deepEqual(model.operations.map((operation) => operation.as), ['joined']);
  assert.deepEqual(model.outputs.map((output) => output.alias), ['left', 'right', 'joined']);
  assert.equal(stored.result.tables.find((table) => table.name === 'joined').title, 'Пользовательский заголовок');
  assert.equal(outcomes[0].status, 'recovered');
  assert.ok(outcomes[0].reasons.includes('canonicalOperations'));
});

test('Object Flow storage preserves an invalid authoring model instead of dropping unresolved outputs', () => {
  const model = {
    version: 1,
    mode: 'objectMatching',
    selections: [{ id: 'selection:assets', name: 'Активы', alias: 'assets', className: 'Asset', limit: 100, columns: ['Code'], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
    operations: [{ id: 'match:missing', type: 'match', from: 'missing', with: 'assets', as: 'unresolved', rightPrefix: 'Assets.', rules: [{ action: 'include', operator: 'equals', leftColumn: 'Code', rightColumn: 'Code' }] }],
    outputs: [{ alias: 'assets', label: 'Активы' }, { alias: 'unresolved', label: 'Неразрешенный результат' }],
    output: { alias: 'unresolved', title: 'Неразрешенный результат' }
  };
  const before = {
    version: 1,
    visualModels: [structuredClone(model)],
    steps: [{ type: 'selectCards', className: 'Asset', filters: [], limit: 100, as: 'assets' }],
    result: { tables: [{ name: 'assets', title: 'Активы' }, { name: 'unresolved', title: 'Неразрешенный результат' }] }
  };
  const outcomes = [];
  const stored = normalizeTemplateSpecForStorage(before, '', { objectFlowOutcomes: outcomes });

  assert.deepEqual(stored.visualModels[0], model);
  assert.deepEqual(stored.result.tables, before.result.tables);
  assert.equal(outcomes[0].status, 'skipped_invalid_flow');
  assert.equal(outcomes[0].changed, false);
  assert.ok(outcomes[0].reasons.some((reason) => reason.path === '$.operations[0].from'));

  const aliasMismatch = {
    version: 1,
    visualModels: [{
      version: 1,
      mode: 'objectMatching',
      selections: [{ id: 'selection:visual_alias', name: 'Визуальный результат', alias: 'visual_alias', className: 'Asset', limit: 100, columns: [], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
      operations: [],
      outputs: [{ alias: 'visual_alias', label: 'Визуальный результат' }],
      output: { alias: 'visual_alias', title: 'Визуальный результат' }
    }],
    steps: [{ type: 'selectCards', purpose: 'objectGroup', className: 'Asset', filters: [], limit: 100, as: 'runtime_alias' }],
    result: { tables: [{ name: 'visual_alias', title: 'Визуальный результат' }, { name: 'runtime_alias', title: 'Исполняемый результат' }] }
  };
  const mismatchOutcomes = [];
  const mismatchStored = normalizeTemplateSpecForStorage(aliasMismatch, '', { objectFlowOutcomes: mismatchOutcomes });
  assert.deepEqual(mismatchStored.visualModels, aliasMismatch.visualModels);
  assert.equal(mismatchOutcomes[0].status, 'skipped_invalid_flow');
  assert.ok(mismatchOutcomes[0].reasons.some((reason) => /no executable step/.test(reason.message)));
});

test('visualModels wins over a divergent visualModel mirror and table presentation remains independent', () => {
  const canonical = {
    version: 1,
    mode: 'objectMatching',
    selections: [{ id: 'selection:assets', name: 'Активы', alias: 'assets', className: 'Asset', limit: 100, columns: [], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
    operations: [],
    outputs: [{ alias: 'assets', label: 'Активы', kind: 'selection' }],
    output: { alias: 'assets', title: 'Активы' }
  };
  const staleMirror = {
    ...structuredClone(canonical),
    selections: [{ ...canonical.selections[0], name: 'Старое имя', alias: 'stale_assets' }],
    outputs: [{ alias: 'stale_assets', label: 'Старое имя', kind: 'selection' }],
    output: { alias: 'stale_assets', title: 'Старое имя' }
  };
  const before = {
    version: 1,
    visualModels: [canonical],
    visualModel: staleMirror,
    steps: [{ type: 'selectCards', className: 'Asset', filters: [], limit: 100, as: 'assets' }],
    result: {
      tables: [{ name: 'assets', title: 'Legacy table title', columns: [] }],
      presentation: { tables: [{ name: 'assets', title: 'Published assets' }] }
    }
  };
  const outcomes = [];
  const stored = normalizeTemplateSpecForStorage(before, '', { objectFlowOutcomes: outcomes });

  assert.deepEqual(stored.visualModel, stored.visualModels.find((item) => item.mode === 'objectMatching'));
  assert.equal(stored.visualModel.outputs[0].alias, 'assets');
  assert.equal(stored.result.tables[0].title, 'Legacy table title');
  assert.equal(stored.result.presentation.tables[0].title, 'Published assets');
  assert.ok(outcomes[0].reasons.includes('visualModelMirrorConflict'));
});

test('primary-only Object Flow migrates to visualModels without publishing a result implicitly', () => {
  const primary = {
    version: 1,
    mode: 'objectMatching',
    selections: [{ id: 'selection:assets', name: 'Активы', alias: 'assets', className: 'Asset', limit: 100, columns: [], rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
    operations: [],
    outputs: [{ alias: 'assets', label: 'Активы', kind: 'selection' }],
    output: { alias: '', title: '' }
  };
  const before = {
    version: 1,
    visualModel: primary,
    steps: [{ type: 'selectCards', purpose: 'objectGroup', className: 'Asset', filters: [], limit: 100, as: 'assets' }],
    result: { tables: [{ name: 'assets', title: 'Активы', columns: [] }] }
  };
  const outcomes = [];
  const stored = normalizeTemplateSpecForStorage(before, '', { objectFlowOutcomes: outcomes });
  const canonical = stored.visualModels.find((item) => item.mode === 'objectMatching');

  assert.ok(canonical);
  assert.equal(canonical.output.alias, '');
  assert.equal(stored.visualModel.output.alias, '');
  assert.deepEqual(stored.visualModel, canonical);
  assert.ok(outcomes[0].reasons.includes('canonicalVisualModels'));
});

test('D2 workflow accepts only canonical authoring source and matching deterministic mapping', async () => {
  const source = 'app: "Application"';
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  const semanticModelRevision = 15;
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

test('template storage leaves an old D2 authoring contract unchanged', () => {
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
  assert.equal(normalized.assistantDraft.d2Authoring.source, source);
  assert.equal(normalized.authoring, undefined);
});

test('template storage removes retired diagram prompts from the current authoring contract', async () => {
  const legacy = {
    version: 1,
    authoring: {
      version: 1,
      assistant: {
        promptContractVersion: 3,
        diagramSemanticsPrompt: 'Системы являются объектами.',
        diagramPlacementPrompt: 'Системы являются объектами.',
        diagramConnectionsPrompt: 'Связи строятся по карточкам ACL.'
      },
      d2: { source: '' }
    }
  };
  const stored = normalizeTemplateSpecForStorage(legacy);
  assert.deepEqual(stored, {
    version: 1,
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: { context: '', blocks: [] },
        promptContractVersion: 4,
        diagramIntentPrompt: ''
      },
      d2: { source: '', sourceHash: '' }
    }
  });
  assert.equal(diagramAuthoringStatusForSpec(stored).status, 'absent');
  assert.equal((await d2WorkflowStatusForSpec(stored)).state, 'none');
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
      { key: 'acl', usageKeys: ['source_target'], notes: 'Build from ACL cards.', directionPolicy: 'template' }
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

test('D2 static template subtree extends a saved mapping without resetting dynamic placements', () => {
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
    structure: proposal.structure,
    classes: proposal.classes,
    structureTree: tree
  };
  const saved = {
    ...currentSpec,
    result: { ...currentSpec.result, diagrams: [{ authoring: { d2Import: imported } }] }
  };
  const staticSource = `${source}\nlegend: { left: "External" right: "Internal" left -> right: "example" }`;
  const staticIr = normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: proposal.structure.groups.concat([{ id: 'legend', label: 'Legend', static: true, children: ['legend.left', 'legend.right'], pathSegments: ['legend'] }]),
      nodes: proposal.structure.nodes.concat([
        { id: 'legend.left', label: 'External', parentKey: 'legend', pathSegments: ['legend', 'left'] },
        { id: 'legend.right', label: 'Internal', parentKey: 'legend', pathSegments: ['legend', 'right'] }
      ]),
      edges: [{ id: 'legend_edge', source: 'legend.left', target: 'legend.right', label: 'example', direction: '->' }]
    },
    classes: proposal.classes
  }, staticSource);

  const extended = createDiagramImportProposal(saved, staticIr, { sourceText: staticSource });
  const restoredVlanItems = extended.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  const staticItems = extended.structureTree.items.filter((item) => item.templateStatic === true);

  assert.ok(extended.warnings.some((warning) => warning.includes('static D2 template subtree')));
  assert.equal(restoredVlanItems.length, 2);
  assert.ok(restoredVlanItems.every((item) => item.mapping.materialization.stageId === 'selection:systemsA'));
  assert.equal(staticItems.length, 3);
  assert.ok(staticItems.every((item) => item.mapping.materialization.kind === 'structural'));
  assert.ok(staticItems.every((item) => !item.mapping.materialization.stageId));

  const legacySource = `${source}\nlegend: { left: "External" right: "Internal" left -> right: "example" }`;
  const legacyIr = normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: proposal.structure.groups.concat([{ id: 'legend', label: 'Legend', children: ['legend.left', 'legend.right'], pathSegments: ['legend'] }]),
      nodes: proposal.structure.nodes.concat([
        { id: 'legend.left', label: 'External', parentKey: 'legend', pathSegments: ['legend', 'left'] },
        { id: 'legend.right', label: 'Internal', parentKey: 'legend', pathSegments: ['legend', 'right'] }
      ]),
      edges: [{ id: 'legend_edge', source: 'legend.left', target: 'legend.right', label: 'example', direction: '->' }]
    },
    classes: proposal.classes
  }, legacySource);
  const legacyProposal = createDiagramImportProposal(currentSpec, legacyIr, { sourceText: legacySource });
  const legacyLegend = legacyProposal.structureTree.items.find((item) => item.templateElementKey === 'legend');
  const legacyTree = structureTreeItemWithSource(legacyProposal.structureTree, legacyLegend.id, 'selection:systemsA');
  const legacySaved = {
    ...currentSpec,
    result: {
      ...currentSpec.result,
      diagrams: [{ authoring: { d2Import: {
        version: 3,
        semanticModelRevision: legacyProposal.semanticModelRevision,
        sourceHash: legacyIr.source.hash,
        structureHash: legacyIr.source.structureHash,
        mappingContractHash: legacyIr.source.mappingContractHash,
        roles: legacyProposal.roles,
        relationRules: [],
        structure: legacyProposal.structure,
        classes: legacyProposal.classes,
        structureTree: legacyTree
      } } }]
    }
  };
  const replacedLegacy = createDiagramImportProposal(legacySaved, staticIr, { sourceText: staticSource });
  const legendItems = replacedLegacy.structureTree.items.filter((item) => item.templateElementKey === 'legend');
  assert.equal(legendItems.length, 1);
  assert.equal(legendItems[0].templateStatic, true);
  assert.equal(legendItems[0].mapping.materialization.kind, 'structural');
  assert.equal(legendItems[0].mapping.materialization.stageId, '');

  const staleStaticSaved = {
    ...currentSpec,
    result: {
      ...currentSpec.result,
      diagrams: [{ authoring: { d2Import: {
        version: 3,
        semanticModelRevision: replacedLegacy.semanticModelRevision,
        sourceHash: staticIr.source.hash,
        structureHash: staticIr.source.structureHash,
        mappingContractHash: staticIr.source.mappingContractHash,
        roles: replacedLegacy.roles,
        relationRules: [],
        structure: replacedLegacy.structure,
        classes: replacedLegacy.classes,
        structureTree: {
          version: replacedLegacy.structureTree.version,
          items: legacyTree.items.concat(replacedLegacy.structureTree.items.filter((item) => item.templateStatic === true))
        }
      } } }]
    }
  };
  const repairedStatic = createDiagramImportProposal(staleStaticSaved, staticIr, { sourceText: staticSource });
  assert.equal(repairedStatic.structureTree.items.filter((item) => item.templateElementKey === 'legend').length, 1);
});

test('D2 edge class uses relation-result direction unless explicitly undirected', () => {
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
      { key: 'acl', usageKeys: ['source_target'], directionPolicy: 'template' }
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
      { alias: 'systems', label: 'Результат 1', assistantBlockId: 'block-1', assistantStageRole: 'terminal' },
      { alias: 'ipRanges', label: 'Результат 2', assistantBlockId: 'block-2', assistantStageRole: 'terminal' }
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

test('D2 placement preserves a retained-card primary source for deterministic compilation', () => {
  const { proposal, roles } = d2StructureTreeFixture();
  const vlanItem = proposal.structureTree.items.find((item) => String(item.roleId) === String(roles.vlan.id));
  const tree = structureTreeItemWithSource(proposal.structureTree, vlanItem.id, 'selection:systemsA', {
    primary: {
      className: 'ipRange',
      cardSource: { id: 'relation-source', className: 'ipRange', classColumn: 'SourceClass', idColumn: 'SourceId' },
      labelTemplate: '${Description}'
    }
  });
  const normalized = diagramImportStructureTree(tree, proposal.structure, proposal.roles);
  const mapping = normalized.items.find((item) => item.id === vlanItem.id).mapping;

  assert.deepEqual(mapping.primary.cardSource, {
    id: 'relation-source',
    className: 'ipRange',
    classColumn: 'SourceClass',
    idColumn: 'SourceId',
    label: ''
  });
  assert.equal(mapping.primary.labelTemplate, '${Description}');
  assert.equal(mapping.primary.idAttribute, '_id');
});

test('D2 retained relation provenance materializes the related child and correlates it with the parent', () => {
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
  assert.equal(repaired.mapping.hierarchyConditions.rules.length, 1);
  assert.equal(repaired.mapping.hierarchyConditions.rules[0].left.column, '_id');
  assert.equal(repaired.mapping.hierarchyConditions.rules[0].right.stageId, 'relation:servers');
  assert.equal(repaired.mapping.hierarchyConditions.rules[0].right.column, '_id');
});

test('D2 legacy primary class cannot override the current Object Flow result without an explicit card source', () => {
  const stage = {
    id: 'relation:vlans',
    className: 'vlan',
    cardSources: [
      { id: 'current', className: 'vlan', classColumn: 'Class', idColumn: '_id', label: 'VLAN' },
      { id: 'relation-source', className: 'ipRange', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Network' }
    ]
  };
  const compiled = diagramImportCompileRoleMapping({
    id: 'vlan-role', key: 'vlan', label: 'VLAN', kind: 'd2Class', visualKind: 'node', elementKeys: ['vlan']
  }, {
    materialization: { kind: 'stage', stageId: stage.id },
    primary: { className: 'ipRange', idAttribute: '_id', labelTemplate: '${Description}' }
  }, 'vlan-placement', new Map([[stage.id, stage]]), {
    stageId: stage.id, alias: 'vlans', baseAlias: 'vlans', className: stage.className, label: 'VLANs'
  });

  assert.deepEqual(compiled.runtimeMapping.fields, { id: '_id', label: 'Description', code: 'Code' });
  assert.equal(compiled.runtimeMapping.dataProfile.className, 'vlan');
  assert.equal(compiled.runtimeMapping.labelTemplate, '${Description}');
});

test('D2 primary card source projects runtime identity and label to the selected retained card', () => {
  const stage = {
    id: 'match:applicationsServers',
    alias: 'applicationsServers',
    className: 'phServer',
    cardSources: [
      { id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Сервер' },
      { id: 'relation-source', className: 'ApplicG', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Приложение' }
    ]
  };
  const compiled = diagramImportCompileRoleMapping({
    id: 'application-role',
    key: 'application',
    label: 'Приложение',
    kind: 'd2Class',
    visualKind: 'node',
    elementKeys: ['application']
  }, {
    materialization: { kind: 'stage', stageId: stage.id },
    primary: {
      className: 'ApplicG',
      cardSource: stage.cardSources[1],
      idAttribute: '_id',
      labelTemplate: '${Description}',
      structuredFields: ['Code', 'Description']
    }
  }, 'application-placement', new Map([[stage.id, stage]]), {
    stageId: stage.id,
    alias: stage.alias,
    baseAlias: stage.alias,
    className: stage.className,
    label: 'Applications phServers'
  });

  assert.deepEqual(compiled.runtimeMapping.fields, { id: 'SourceId', label: 'SourceDescription', code: 'SourceCode' });
  assert.equal(compiled.runtimeMapping.labelTemplate, '${SourceDescription}');
  assert.equal(compiled.runtimeMapping.dataProfile.className, 'ApplicG');
  assert.deepEqual(compiled.runtimeMapping.dataProfile.fields.sort(), ['SourceCode', 'SourceDescription']);
  assert.equal(compiled.runtimeMapping.importRole.primaryCardSourceClassName, 'ApplicG');
});

test('D2 retained relation card labels keep an already projected field stable', () => {
  const stage = {
    id: 'match:applicationsServers',
    alias: 'applicationsServers',
    className: 'vServer',
    cardSources: [
      { id: 'current', className: 'vServer', classColumn: 'Class', idColumn: '_id', label: 'Сервер' },
      { id: 'relation-source', className: 'ApplicG', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Приложение' }
    ]
  };
  const compiled = diagramImportCompileRoleMapping({
    id: 'application-role',
    key: 'application',
    label: 'Приложение',
    kind: 'd2Class',
    visualKind: 'node',
    elementKeys: ['application']
  }, {
    materialization: { kind: 'stage', stageId: stage.id },
    primary: {
      className: 'ApplicG',
      cardSource: stage.cardSources[1],
      idAttribute: '_id',
      labelTemplate: '${SourceDescription}',
      structuredFields: ['SourceCode', 'SourceDescription']
    }
  }, 'application-placement', new Map([[stage.id, stage]]), {
    stageId: stage.id,
    alias: stage.alias,
    baseAlias: stage.alias,
    className: stage.className,
    label: 'Applications vServer'
  });

  assert.deepEqual(compiled.runtimeMapping.fields, { id: 'SourceId', label: 'SourceDescription', code: 'SourceCode' });
  assert.equal(compiled.runtimeMapping.labelTemplate, '${SourceDescription}');
  assert.deepEqual(compiled.runtimeMapping.dataProfile.fields.sort(), ['SourceCode', 'SourceDescription']);
});

test('D2 endpoint profile authoring preserves incomplete rows and repairs duplicate ids', () => {
  const normalized = diagramImportEndpointProfiles([
    { id: 'same-profile', structureItemId: 'external-placement', roleId: 'external-role', label: 'Main network', field: 'range', operators: ['ipv4InCidr'] },
    { id: 'same-profile', structureItemId: 'server-placement', roleId: 'server-role', label: 'Management address', field: 'managementIp', operators: ['ipv4InCidr'] },
    { id: 'draft-profile', structureItemId: '', roleId: '', label: '', field: '', operators: [] }
  ]);

  assert.equal(normalized.length, 3);
  assert.equal(new Set(normalized.map((profile) => profile.id)).size, 3);
  assert.equal(normalized[0].id, 'same-profile');
  assert.equal(normalized[1].structureItemId, 'server-placement');
  assert.deepEqual(normalized[2], {
    id: 'draft-profile',
    structureItemId: '',
    roleId: '',
    label: '',
    stageId: '',
    field: '',
    valueKind: 'ipv4',
    operators: ['ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains']
  });

  const structureProfiles = diagramImportEndpointProfilesForStructure(normalized, { items: [] }, []);
  assert.equal(structureProfiles.length, 3, 'Incomplete authoring rows must survive structure normalization.');
});

test('D2 endpoint profile binds one structure placement to its own Object Flow card', () => {
  const systemStage = {
    id: 'selection:external-systems',
    alias: 'externalSystems',
    className: 'IS',
    columns: ['Class', '_id', 'Description', 'range'],
    cardSources: [{ id: 'current', className: 'IS', classColumn: 'Class', idColumn: '_id', label: 'ИС' }]
  };
  const compiled = diagramImportCompileRoleMapping({
    id: 'external-system-role', key: 'external_system', label: 'Внешняя ИС', kind: 'd2Class', visualKind: 'node', elementKeys: ['external_system']
  }, {
    materialization: { kind: 'stage', stageId: systemStage.id },
    primary: { className: 'IS', idAttribute: '_id', labelTemplate: '${Description}' }
  }, 'external-system-placement', new Map([
    [systemStage.id, systemStage]
  ]), {
    stageId: systemStage.id,
    alias: systemStage.alias,
    baseAlias: systemStage.alias,
    className: systemStage.className,
    label: 'Внешние ИС'
  }, new Map(), [], [{
    id: 'external-network',
    structureItemId: 'external-system-placement',
    roleId: 'external-system-role',
    field: 'range',
    valueKind: 'ipv4'
  }]);

  assert.equal(compiled.runtimeMapping.relatedBindings.length, 0);
  assert.equal(compiled.runtimeMapping.endpointProfiles.length, 1);
  assert.equal(compiled.runtimeMapping.endpointProfiles[0].id, 'external-network');
  assert.equal(compiled.runtimeMapping.endpointProfiles[0].field, 'range');
});

test('D2 primary-card reference fields are enriched from the author-selected Object Flow card', () => {
  const applicationStage = {
    id: 'match:application-ip',
    alias: 'applicationIp',
    className: 'IpAddress',
    columns: ['Class', '_id', 'Description', 'SourceClass', 'SourceId', 'SourceDescription'],
    cardSources: [
      { id: 'current', className: 'IpAddress', classColumn: 'Class', idColumn: '_id', label: 'IP-адрес' },
      { id: 'relation-source', className: 'ApplicG', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Приложение' }
    ]
  };
  const compiled = diagramImportCompileRoleMapping({
    id: 'application-role', key: 'application', label: 'Приложение', kind: 'd2Class', visualKind: 'node', elementKeys: ['application']
  }, {
    materialization: { kind: 'stage', stageId: applicationStage.id },
    primary: {
      className: 'ApplicG',
      cardSource: applicationStage.cardSources[1],
      idAttribute: '_id',
      labelTemplate: '${ipaddress.ipAddr}',
      structuredFields: ['ipaddress.ipAddr']
    }
  }, 'application-placement', new Map([
    [applicationStage.id, applicationStage]
  ]), {
    stageId: applicationStage.id,
    alias: applicationStage.alias,
    baseAlias: applicationStage.alias,
    className: applicationStage.className,
    label: 'Applications'
  });

  const enrichment = compiled.steps.find((step) => step.type === 'enrichRows');
  assert.ok(enrichment);
  assert.equal(enrichment.classColumn, 'SourceClass');
  assert.equal(enrichment.idColumn, 'SourceId');
  const projected = compiled.runtimeMapping.dataProfile.fields.find((field) => field.startsWith('__d2_condition_'));
  assert.ok(projected);
  assert.equal(compiled.runtimeMapping.labelTemplate, '${' + projected + '}');
});

test('D2 endpoint profile enriches a reference field from its retained Object Flow card', () => {
  const systemStage = {
    id: 'selection:external-systems',
    alias: 'externalSystems',
    className: 'IS',
    columns: ['Class', '_id', 'Description'],
    cardSources: [{ id: 'current', className: 'IS', classColumn: 'Class', idColumn: '_id', label: 'ИС' }]
  };
  const compiled = diagramImportCompileRoleMapping({
    id: 'external-system-role', key: 'external_system', label: 'Внешняя ИС', kind: 'd2Class', visualKind: 'node', elementKeys: ['external_system']
  }, {
    materialization: { kind: 'stage', stageId: systemStage.id },
    primary: { className: 'IS', idAttribute: '_id', labelTemplate: '${Description}' }
  }, 'external-system-placement', new Map([
    [systemStage.id, systemStage]
  ]), {
    stageId: systemStage.id,
    alias: systemStage.alias,
    baseAlias: systemStage.alias,
    className: systemStage.className,
    label: 'Внешние ИС'
  }, new Map(), [], [{
    id: 'external-network',
    structureItemId: 'external-system-placement',
    roleId: 'external-system-role',
    field: 'ipRange.range',
    source: systemStage.cardSources[0],
    valueKind: 'ipv4'
  }]);

  assert.ok(compiled.steps.some((step) => step.type === 'enrichRows' && step.purpose === 'd2PlacementFilter'));
  assert.match(compiled.runtimeMapping.endpointProfiles[0].field, /^__d2_condition_/);
});

test('D2 retained primary cards do not collapse distinct applications sharing one server', () => {
  const diagram = buildResultDiagrams({
    result: {
      diagrams: [{
        name: 'applications',
        nodeMappings: [{
          id: 'mapping_application',
          from: 'applicationsServers',
          fields: { id: 'SourceId', label: 'SourceDescription', code: 'SourceCode' },
          labelTemplate: '${SourceDescription}',
          dataProfile: { className: 'ApplicG', fields: ['SourceCode', 'SourceDescription'] },
          importRole: { key: 'application', label: 'Приложение', sourceLabel: 'Applications phServers' }
        }]
      }]
    }
  }, {
    applicationsServers: {
      rows: [
        { _id: 'phserver-1', Description: 'phserver1', SourceId: 'application-1', SourceCode: 'app-1', SourceDescription: 'Application 1' },
        { _id: 'phserver-1', Description: 'phserver1', SourceId: 'application-2', SourceCode: 'app-2', SourceDescription: 'Application 2' },
        { _id: 'phserver-1', Description: 'phserver1', SourceId: 'application-1', SourceCode: 'app-1', SourceDescription: 'Application 1' }
      ]
    }
  }, {}, { maxRows: 100 })[0];

  assert.deepEqual(diagram.nodes.map((node) => [node.businessId, node.label]).sort(), [
    ['application-1', 'Application 1'],
    ['application-2', 'Application 2']
  ]);
  assert.equal(diagram.execution.bindings[0].materialized, 2);
  assert.equal(diagram.execution.bindings[0].duplicates, 1);
  assert.deepEqual(diagram.nodes.map((node) => node.data.sourceRef), [
    { className: 'ApplicG', id: 'application-1', code: 'app-1', description: 'Application 1' },
    { className: 'ApplicG', id: 'application-2', code: 'app-2', description: 'Application 2' }
  ]);
});

test('D2 current mapping fields override stale relation-source aliases', () => {
  const mapping = {
    id: 'vlan-mapping',
    from: 'vlans',
    // Pre-cardSource mappings stored these legacy aliases at the top level.
    // They must not override a later explicit current-card projection.
    nodeId: 'SourceId',
    nodeLabel: 'SourceDescription',
    fields: { id: '_id', label: 'Description', code: 'Code' },
    labelTemplate: '${Description}',
    dataProfile: { className: 'vlan', fields: ['Code', 'Description'] },
    importRole: { key: 'vlan', label: 'VLAN', sourceLabel: 'Результат 2' }
  };
  assert.equal(diagramMappingField(mapping, ['nodeId', 'id', 'idColumn'], 'id'), '_id');
  assert.equal(diagramMappingField(mapping, ['nodeLabel', 'label', 'labelColumn'], 'label'), 'Description');

  const diagram = buildResultDiagrams({
    result: { diagrams: [{ name: 'vlans', nodeMappings: [mapping] }] }
  }, {
    vlans: {
      rows: [{
        SourceId: 'range-1',
        SourceDescription: 'range1',
        _id: 'vlan-1',
        Code: 'vlan1',
        Description: 'vlan1'
      }]
    }
  }, {}, { maxRows: 20 })[0];

  assert.deepEqual(diagram.nodes.map((node) => [node.businessId, node.label]), [['vlan-1', 'vlan1']]);
  assert.deepEqual(diagram.nodes[0].data.sourceRef, {
    className: 'vlan', id: 'vlan-1', code: 'vlan1', description: 'vlan1'
  });
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

  assert.equal(appliedImport.mappingInputRevision.version, 3);
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

test('normal template Save keeps the D2 analysis identity stable after generated mapping materialization', () => {
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
  assert.equal(diagramImportDeterministicSpecHash(applied), beforeMaterializationHash);
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

  const recovered = normalizeTemplateSpecForStorage(lostMarker, '', {
    recoveryVersions: [{ version: 53, spec: historicVersion }],
    d2SourceIdentities: [identity]
  });
  const recoveredImport = recovered.result.diagrams[0].authoring.d2Import;
  assert.equal(recoveredImport.semanticModelRevision, 8);
  assert.equal(recoveredImport.structureTree.version, 3);
  assert.equal(recoveredImport.mappingValidation.status, 'needsValidation');
  assert.equal(diagramImportMappingValidationIsCurrent(recoveredImport), false);
  assert.equal((await d2WorkflowStatusForSpec(recovered)).state, 'pending');
  assert.equal(diagramAuthoringStatusForSpec(recovered).status, 'needsReanalysis');

  const changedPrompt = structuredClone(lostMarker);
  changedPrompt.authoring.assistant.diagramInterpretPrompt = 'Новый prompt без повторного mapping';
  const notRecovered = normalizeTemplateSpecForStorage(changedPrompt, '', {
    recoveryVersions: [{ version: 53, spec: historicVersion }],
    d2SourceIdentities: [identity]
  });
  assert.equal(notRecovered.result.diagrams[0].authoring.d2Import.mappingValidation.status, 'needsValidation');
});

test('normal Save retains revision 11 D2 mapping as historical non-executable state', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const applied = applyDiagramImportProposal(
    currentSpec,
    proposal,
    [],
    [],
    structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA')
  );
  const before = structuredClone(applied);
  const beforeImport = before.result.diagrams[0].authoring.d2Import;
  beforeImport.semanticModelRevision = 11;
  beforeImport.mappingValidation = {
    version: 1,
    status: 'valid',
    signature: signDiagramImportMappingValidation(beforeImport)
  };
  const identity = {
    ok: true,
    sourceHash: beforeImport.sourceHash,
    structureHash: beforeImport.structureHash,
    mappingContractHash: beforeImport.mappingContractHash,
    ir: {
      source: { parser: beforeImport.parser },
      template: beforeImport.template,
      elements: beforeImport.structure,
      classes: beforeImport.classes
    }
  };

  const stored = normalizeTemplateSpecForStorage(before, '', { d2SourceIdentities: [identity] });
  const migrated = stored.result.diagrams[0].authoring.d2Import;

  assert.equal(migrated.semanticModelRevision, 11);
  assert.equal(migrated.structureTree.version, 5);
  assert.deepEqual(migrated.structureTree.items.map((item) => item.id), beforeImport.structureTree.items.map((item) => item.id));
  assert.equal(migrated.mappingValidation.status, 'valid');
  assert.equal(diagramImportMappingValidationIsCurrent(migrated), true);
  assert.equal(diagramAuthoringStatusForSpec(stored).status, 'needsReanalysis');
  assert.equal((await d2WorkflowStatusForSpec(stored)).state, 'pending');
});

test('normal Save retains revision 12 D2 mapping for explicit re-analysis', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const applied = applyDiagramImportProposal(
    currentSpec,
    proposal,
    [],
    [],
    structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA')
  );
  const before = structuredClone(applied);
  const beforeImport = before.result.diagrams[0].authoring.d2Import;
  beforeImport.semanticModelRevision = 12;
  beforeImport.mappingValidation = {
    version: 1,
    status: 'needsValidation',
    reasons: ['partialMapping']
  };
  const identity = {
    ok: true,
    sourceHash: beforeImport.sourceHash,
    structureHash: beforeImport.structureHash,
    mappingContractHash: beforeImport.mappingContractHash,
    ir: {
      source: { parser: beforeImport.parser },
      template: beforeImport.template,
      elements: beforeImport.structure,
      classes: beforeImport.classes
    }
  };

  const stored = normalizeTemplateSpecForStorage(before, '', { d2SourceIdentities: [identity] });
  const migrated = stored.result.diagrams[0].authoring.d2Import;

  assert.equal(migrated.semanticModelRevision, 12);
  assert.equal(migrated.mappingValidation.status, 'needsValidation');
  assert.deepEqual(migrated.mappingValidation.reasons, ['partialMapping']);
  assert.equal(diagramImportMappingValidationIsCurrent(migrated), false);
  assert.equal(diagramAuthoringStatusForSpec(stored).status, 'needsReanalysis');
  assert.equal((await d2WorkflowStatusForSpec(stored)).state, 'pending');
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
  const stored = normalizeTemplateSpecForStorage({
    ...currentSpec,
    result: { diagrams: [{ id: proposal.diagramId, authoring: { d2Import: legacy } }] }
  });
  assert.equal(diagramAuthoringStatusForSpec(stored).status, 'needsReanalysis');
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

test('normal Save does not reattest a D2 mapping after signing-secret rotation', async () => {
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

  assert.equal(reattestedImport.semanticModelRevision, 15);
  assert.equal(reattestedImport.structureTree.version, 5);
  assert.equal(reattestedImport.mappingValidation.status, 'valid');
  assert.equal(diagramImportMappingValidationIsCurrent(reattestedImport), false);
  assert.equal((await d2WorkflowStatusForSpec(reattested)).state, 'pending');
});

test('table-only execution ignores D2 recovery while diagram execution remains strict', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], structureTreeWithStage(proposal.structureTree, roles.vlan.id, 'selection:systemsA'));
  const stale = structuredClone(applied);
  stale.result.diagrams[0].authoring.d2Import.mappingValidation.signature = 'stale-signature';

  assert.equal(templateOutputIncludesDiagrams(stale), true);
  assert.equal(executionValidationForSpec(stale).executable, false);

  const tableOnly = structuredClone(stale);
  tableOnly.result.presentation = { ...(tableOnly.result.presentation || {}), outputMode: 'tables' };
  assert.equal(templateOutputIncludesDiagrams(tableOnly), false);
  assert.equal(executionValidationForSpec(tableOnly).executable, true);
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
  assert.equal(recoveredImport.mappingValidation.status, 'needsValidation');
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
      { key: 'traffic', usageKeys: ['source-target'], directionPolicy: 'template' }
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

test('D2 static template subtree keeps its Notes, nodes, and arrows without Object Flow', () => {
  const source = [
    'legend: "Типы ACL-связей" {',
    '  external: "Внешняя связь"',
    '  internal: "Внутренняя связь"',
    '  external -> internal: "пример"',
    '}'
  ].join('\n');
  const ir = normalizeDiagramImportIr({
    version: 4,
    elements: {
      groups: [{ id: 'legend', label: 'Типы ACL-связей', static: true, children: ['legend.external', 'legend.internal'] }],
      nodes: [
        { id: 'legend.external', label: 'Внешняя связь', parent: 'legend' },
        { id: 'legend.internal', label: 'Внутренняя связь', parent: 'legend' }
      ],
      edges: [{ id: '(legend.external -> legend.internal)[0]', source: 'legend.external', target: 'legend.internal', label: 'пример', direction: '->' }]
    }
  }, source);
  ir.elements.groups[0].notes = 'Весь блок статический и показывается на каждой диаграмме.';
  const currentSpec = { version: 1, authoring: { version: 1, assistant: {}, d2: { source } }, steps: [], result: { tables: [] } };
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: source });
  const legendRole = proposal.roles.find((role) => role.key === 'legend');

  assert.equal(legendRole.notes, 'Весь блок статический и показывается на каждой диаграмме.');
  assert.equal(legendRole.templateStatic, true);
  assert.equal(proposal.relationRules.length, 0);
  assert.ok(proposal.structureTree.items.every((item) => item.templateStatic === true));
  assert.deepEqual(diagramImportStructureTreeErrors(proposal.structureTree, proposal.roles, currentSpec, proposal.structure), []);

  const placementTargets = assistantDiagramPlacementTargets(proposal, [], { classes: [] });
  assert.ok(placementTargets.every((placement) => placement.templateStatic === true));
  assert.ok(placementTargets.every((placement) => placement.allowedMaterialization.join(',') === 'structural'));
  const placementDraft = assistantDiagramPlacementDraftFromResponse({ placements: placementTargets, stages: [] }, {
    mappings: [],
    unresolved: []
  });
  assert.equal(placementDraft.success, true);
  assert.equal(placementDraft.items.length, placementTargets.length);
  assert.ok(placementDraft.items.every((item) => item.mapping.materialization.kind === 'structural'));
  const structuralModel = assistantD2StructuralModel(proposal.roles, placementTargets, proposal.relationRules);
  assert.ok(structuralModel.placements.every((placement) => placement.templateStatic === true));

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], proposal.structureTree);
  const diagramSpec = applied.result.diagrams[0];
  assert.equal(diagramSpec.nodeMappings.length, 2);
  assert.equal(diagramSpec.edgeMappings.length, 1);
  assert.ok(diagramSpec.nodeMappings.every((mapping) => Array.isArray(mapping.staticRows) && mapping.staticRows.length === 1));
  const diagram = buildResultDiagrams(applied, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.groups.length, 1);
  assert.equal(diagram.groups[0].label, 'Типы ACL-связей');
  assert.deepEqual(diagram.nodes.map((node) => node.label).sort(), ['Внешняя связь', 'Внутренняя связь']);
  assert.deepEqual(diagram.edges.map((edge) => edge.label), ['пример']);
  assert.equal(diagram.nodes.some((node) => /^mapping_/.test(node.label)), false);
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
  assert.ok(nodeMappings.every((mapping) => mapping.fields.id === '_id' && mapping.fields.label === 'Description'));
  assert.ok(nodeMappings.every((mapping) => mapping.labelTemplate === '${Description}'));
  assert.equal(applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'selectCards').length, 0);
});

test('D2 parentCard child is the only endpoint for its dynamic container card', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  const scopeItem = tree.items.find((item) => String(item.roleId) === String(roles['scope-vlan'].id));
  const vlanItem = tree.items.find((item) => String(item.parentId) === String(scopeItem.id) && String(item.roleId) === String(roles.vlan.id));
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const endpointProfiles = [
    {
      id: 'scope-code', structureItemId: scopeItem.id, roleId: roles['scope-vlan'].id,
      field: 'Code', operators: ['equals']
    },
    {
      id: 'vlan-code', structureItemId: vlanItem.id, roleId: roles.vlan.id,
      field: 'Code', operators: ['equals']
    }
  ];

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree, endpointProfiles);
  const diagram = applied.result.diagrams[0];
  const scopeMappings = diagram.groupMappings.filter((mapping) => mapping.importRole && mapping.importRole.key === 'scope-vlan');
  const vlanMapping = diagram.nodeMappings.find((mapping) => (
    mapping.importRole && String(mapping.importRole.structureItemId || '') === String(vlanItem.id)
  ));
  const savedProfiles = diagram.authoring && diagram.authoring.d2Import && diagram.authoring.d2Import.endpointProfiles || [];

  assert.ok(scopeMappings.length > 0);
  assert.ok(scopeMappings.every((mapping) => (mapping.endpointProfiles || []).length === 0), 'The visual container must not duplicate its parentCard node as an endpoint.');
  assert.deepEqual((vlanMapping.endpointProfiles || []).map((profile) => profile.id), ['vlan-code']);
  assert.deepEqual(savedProfiles.map((profile) => profile.id).sort(), ['scope-code', 'vlan-code'], 'The legacy container rule must remain editable in saved authoring data.');
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

test('D2 structure tree preserves saved parent comparisons as placement conditions', () => {
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

  assert.deepEqual(child.mapping.conditions.rules.map((rule) => ({
    left: rule.left.column,
    rightStageId: rule.right.stageId,
    right: rule.right.column
  })), [{ left: 'Code', rightStageId: 'selection:systemsA', right: 'Code' }]);
  assert.deepEqual(child.mapping.hierarchyConditions.rules, []);
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
  mappingByItemId.get(scopeItems[0].id).primary.labelTemplate = 'DMZ ${Code}';
  mappingByItemId.get(scopeItems[1].id).primary.labelTemplate = 'Root ${Description}';
  for (const vlanItem of vlanItems) mappingByItemId.get(vlanItem.id).primary.labelTemplate = 'VLAN ${Description}';
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

  assert.deepEqual(scopes.map((group) => group.label).sort(), ['DMZ dmz-vlan', 'Root VLAN Root']);
  assert.deepEqual(vlans.map((node) => node.label).sort(), ['VLAN VLAN DMZ', 'VLAN VLAN Root']);
  assert.equal(diagram.groups.some((group) => group.label === 'scope_vlan'), false);
  assert.equal(new Set(vlans.map((node) => node.group)).size, 2);
});

test('D2 structure placements preserve an explicit blank container label without changing its parent-card node label', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const scopeItem = proposal.structureTree.items.find((item) => item.roleId === roles['scope-vlan'].id);
  const vlanItem = proposal.structureTree.items.find((item) => item.parentId === scopeItem.id && item.roleId === roles.vlan.id);
  const tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  for (const item of tree.items) {
    if (item.roleId !== roles.vlan.id) continue;
    item.mapping.materialization = { kind: 'parentCard', stageId: '' };
    item.mapping.primary.labelTemplate = 'VLAN ${Description}';
  }
  const scopeMapping = tree.items.find((item) => item.id === scopeItem.id).mapping;
  scopeMapping.primary.labelTemplate = '';

  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const appliedScopeMapping = applied.result.diagrams[0].groupMappings.find((mapping) =>
    String(mapping.importRole && mapping.importRole.structureItemId) === String(scopeItem.id)
  );
  assert.equal(appliedScopeMapping.labelTemplate, '');
  const diagram = buildResultDiagrams(applied, {
    systemsA: { rows: [{ _id: 'vlan-dmz', Code: 'dmz-vlan', Description: 'VLAN DMZ' }] }
  }, {}, { maxRows: 20 })[0];
  const scope = diagram.groups.find((group) => String(group.importRole && group.importRole.structureItemId) === String(scopeItem.id));
  const vlan = diagram.nodes.find((node) => String(node.importRole && node.importRole.structureItemId) === String(vlanItem.id));

  assert.equal(scope.label, '');
  assert.equal(vlan.label, 'VLAN VLAN DMZ');
  assert.equal(vlan.group, scope.id);
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
  assert.equal(workflow.reason, 'semantic_model_revision_required');
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
  currentSpec.authoring = {
    version: 1,
    assistant: { objectFlowIntent: { context: '', blocks: [] }, diagramInterpretPrompt: '', diagramMappingPrompt: '' },
    d2: {
      source: proposal.sourceText,
      analysisCheckpoint: {
        version: 1,
        proposalId: proposal.proposalId,
        deterministicSpecHash: proposal.deterministicSpecHash,
        source: proposal.source,
        roles: proposal.roles.map((role) => ({ id: role.id, visualKind: role.visualKind, labelTemplate: role.labelTemplate })),
        relationRules: proposal.relationRules,
        structureTree: proposal.structureTree
      }
    }
  };
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
  assert.ok(partial.spec.result.diagrams[0].nodeMappings.length > 0);
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

  const stored = normalizeTemplateSpecForStorage(partial.spec);
  const checkpoint = stored.authoring.d2.analysisCheckpoint;
  const storedImport = stored.result.diagrams[0].authoring.d2Import;
  assert.equal(checkpoint.deterministicSpecHash, diagramImportDeterministicSpecHash(stored));
  assert.deepEqual(checkpoint.relationRules, storedImport.relationRules);
  assert.deepEqual(checkpoint.structureTree, storedImport.structureTree);
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
        mapping.primary = { ...(mapping.primary || {}), labelTemplate: '${Description}' };
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
        mapping.primary = { ...(mapping.primary || {}), labelTemplate: '${Description}' };
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

test('D2 Assistant correction resolves parentCard through immutable accepted bindings', () => {
  const stages = [{ id: 'selection:vlans', alias: 'vlans', label: 'VLAN', className: 'vlan', columns: ['_id', 'Code', 'Description'] }];
  const acceptedItems = [{
    structureItemId: 'scope',
    roleId: 'scope-role',
    source: { stageId: 'selection:vlans', alias: 'vlans', kind: 'selection', className: 'vlan' },
    mapping: { materialization: { kind: 'stage', stageId: 'selection:vlans' } }
  }];
  const placements = [{
    structureItemId: 'vlan', roleId: 'vlan-role', displayName: 'vlan', parentStructureItemId: 'scope',
    visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: { primary: { labelTemplate: '' } }
  }];
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages, acceptedItems }, {
    mappings: [
      { structureItemId: 'scope', materialization: 'stage', stageId: 'selection:vlans' },
      { structureItemId: 'vlan', materialization: 'parentCard' }
    ],
    unresolved: []
  });

  assert.equal(draft.success, true);
  assert.equal(draft.items.length, 1);
  assert.deepEqual(draft.items[0].mapping.materialization, { kind: 'parentCard', stageId: '' });
  assert.ok(draft.warnings.some((warning) => /already accepted D2 placement/.test(warning)));
});

test('D2 Assistant rejects conflicting duplicate placements and disallowed materialization', () => {
  const stages = [
    { id: 'selection:systemsA', alias: 'systemsA', className: 'IS', kind: 'selection', columns: ['_id', 'Code'] },
    { id: 'selection:systemsB', alias: 'systemsB', className: 'IS', kind: 'selection', columns: ['_id', 'Code'] }
  ];
  const placements = [{
    structureItemId: 'system', roleId: 'system-role', displayName: 'System', parentStructureItemId: '',
    visualKind: 'node', allowedMaterialization: ['stage'], currentMapping: { primary: { labelTemplate: '${Code}' } }
  }];
  const input = { kind: 'mapping', placements, stages };

  const conflicting = assistantDiagramPlacementDraftFromResponse(input, {
    mappings: [
      { structureItemId: 'system', materialization: 'stage', stageId: 'selection:systemsA' },
      { structureItemId: 'system', materialization: 'stage', stageId: 'selection:systemsB' }
    ],
    unresolved: []
  });
  assert.equal(conflicting.success, false);
  assert.deepEqual(conflicting.items, []);
  assert.equal(conflicting.errors.length, 1);
  assert.equal(conflicting.errors[0].code, 'diagram_placement_duplicate');
  assert.equal(conflicting.errors[0].structureItemId, 'system');

  const invalidMaterialization = assistantDiagramPlacementDraftFromResponse(input, {
    mappings: [{ structureItemId: 'system', materialization: 'structural' }],
    unresolved: []
  });
  assert.equal(invalidMaterialization.success, false);
  assert.deepEqual(invalidMaterialization.items, []);
  assert.equal(invalidMaterialization.errors.length, 1);
  assert.equal(invalidMaterialization.errors[0].code, 'diagram_materialization_not_allowed');
  assert.deepEqual(invalidMaterialization.errors[0].allowedMaterialization, ['stage']);
  assert.equal(invalidMaterialization.errors[0].receivedMaterialization, 'structural');
});

test('D2 Assistant drops empty placement rules and keeps literal filters separate from hierarchy', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const stages = assistantObjectFlowDiagramStages(currentSpec);
  const placements = assistantDiagramPlacementTargets(proposal, stages);
  const scopeItems = proposal.structureTree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  const vlanItems = proposal.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  const structuralItems = proposal.structureTree.items.filter((item) => !scopeItems.includes(item) && !vlanItems.includes(item));
  const response = {
    mappings: [
      ...structuralItems.map((item) => ({ structureItemId: item.id, materialization: 'structural' })),
      ...scopeItems.map((item, index) => ({
        structureItemId: item.id,
        materialization: 'stage',
        stageId: index ? 'selection:systemsB' : 'selection:systemsA',
        conditions: {
          rules: [{ operator: 'equals', left: { column: 'Code' }, right: { kind: 'literal', value: index ? 'root' : 'dmz' } }]
        },
        hierarchyConditions: { rules: [{}] }
      })),
      ...vlanItems.map((item) => ({ structureItemId: item.id, materialization: 'parentCard' }))
    ],
    unresolved: []
  };
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, response);

  assert.equal(draft.success, true);
  assert.ok(draft.warnings.some((warning) => /empty D2 placement rule/.test(warning)));
  const scopeMappings = draft.items.filter((item) => item.roleId === roles['scope-vlan'].id).map((item) => item.mapping);
  assert.ok(scopeMappings.every((mapping) => mapping.conditions.rules.length === 1));
  assert.ok(scopeMappings.every((mapping) => mapping.hierarchyConditions.rules.length === 0));
  const validation = assistantDiagramPlacementExecutionValidation({
    placements,
    stages,
    currentSpec,
    structureTree: proposal.structureTree,
    structure: proposal.structure,
    validationRoles: proposal.roles
  }, draft.items);
  assert.equal(validation.checked, true);
  assert.deepEqual(validation.errors, []);
});

test('D2 Assistant resolves parentCard and nested match cards through the nearest materialized ancestor', () => {
  const stages = [
    {
      id: 'relation:servers', alias: 'servers', label: 'Servers', kind: 'relation', className: 'phServer',
      columns: ['Class', '_id', 'Code', 'Description', 'SourceClass', 'SourceId', 'SourceDescription'],
      cardSources: [
        { id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Server' },
        { id: 'relation-source', className: 'ipRange', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Network' }
      ]
    },
    {
      id: 'match:applications', alias: 'applications', label: 'Applications', kind: 'match', className: 'phServer',
      from: 'application_relations', with: 'servers',
      columns: ['Class', '_id', 'Code', 'Description', 'SourceClass', 'SourceId', 'SourceDescription'],
      cardSources: [
        { id: 'current', className: 'phServer', classColumn: 'Class', idColumn: '_id', label: 'Server' },
        { id: 'relation-source', className: 'ApplicG', classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Application' }
      ]
    }
  ];
  const placements = [
    {
      structureItemId: 'scope', roleId: 'scope-role', displayName: 'scope_server', parentStructureItemId: '',
      visualKind: 'container', allowedMaterialization: ['structural', 'stage'], currentMapping: { primary: { labelTemplate: '${Description}' } }
    },
    {
      structureItemId: 'server', roleId: 'server-role', displayName: 'server', parentStructureItemId: 'scope',
      visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: { primary: { labelTemplate: '${Description}' } }
    },
    {
      structureItemId: 'applications-group', roleId: 'group-role', displayName: 'applications_group', parentStructureItemId: 'scope',
      visualKind: 'container', allowedMaterialization: ['structural', 'stage'], currentMapping: { primary: { labelTemplate: '' } }
    },
    {
      structureItemId: 'application', roleId: 'application-role', displayName: 'application', parentStructureItemId: 'applications-group',
      visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: { id: 'application-mapping', primary: { labelTemplate: '${Description}' } }
    }
  ];
  const invalidHierarchy = {
    rules: [{
      operator: 'equals', left: { column: 'SourceId' },
      right: { kind: 'stage', stageId: 'structure_mapping.current', column: '_id' }
    }]
  };
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, {
    mappings: [
      { structureItemId: 'scope', materialization: 'stage', stageId: 'relation:servers' },
      { structureItemId: 'server', materialization: 'parentCard', hierarchyConditions: invalidHierarchy },
      { structureItemId: 'applications-group', materialization: 'structural' },
      { structureItemId: 'application-mapping', materialization: 'stage', stageId: 'match:applications', hierarchyConditions: invalidHierarchy }
    ],
    unresolved: [{
      structureItemId: 'application', reason: 'ambiguousStage',
      message: 'Redundant uncertainty after returning an executable mapping.'
    }]
  });

  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  const server = draft.items.find((item) => item.structureItemId === 'server');
  const application = draft.items.find((item) => item.structureItemId === 'application');
  assert.equal(server.mapping.primary.cardSource.id, 'current');
  assert.equal(server.mapping.primary.className, 'phServer');
  assert.deepEqual(server.mapping.hierarchyConditions.rules, []);
  assert.equal(application.mapping.primary.cardSource.id, 'relation-source');
  assert.equal(application.mapping.primary.className, 'ApplicG');
  assert.deepEqual(application.mapping.hierarchyConditions.rules.map((rule) => ({
    left: rule.left.column,
    stageId: rule.right.stageId,
    right: rule.right.column
  })), [{ left: '_id', stageId: 'relation:servers', right: '_id' }]);
  assert.ok(draft.warnings.some((warning) => /normalized to its unique current structure item/.test(warning)));
  assert.ok(draft.warnings.some((warning) => /both mapped and unresolved/.test(warning)));
  assert.ok(draft.warnings.some((warning) => /exact materialized parent contract/.test(warning)));
});

test('D2 Assistant execution gate rejects an invalid child-parent field contract before apply', () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  const stages = assistantObjectFlowDiagramStages(currentSpec);
  const placements = assistantDiagramPlacementTargets(proposal, stages);
  const scopeItems = proposal.structureTree.items.filter((item) => item.roleId === roles['scope-vlan'].id);
  const vlanItems = proposal.structureTree.items.filter((item) => item.roleId === roles.vlan.id);
  const structuralItems = proposal.structureTree.items.filter((item) => !scopeItems.includes(item) && !vlanItems.includes(item));
  const draft = assistantDiagramPlacementDraftFromResponse({ kind: 'mapping', placements, stages }, {
    mappings: [
      ...structuralItems.map((item) => ({ structureItemId: item.id, materialization: 'structural' })),
      { structureItemId: scopeItems[0].id, materialization: 'stage', stageId: 'selection:systemsA' },
      { structureItemId: vlanItems[0].id, materialization: 'stage', stageId: 'selection:systemsB' },
      { structureItemId: scopeItems[1].id, materialization: 'stage', stageId: 'selection:systemsB' },
      { structureItemId: vlanItems[1].id, materialization: 'parentCard' }
    ],
    unresolved: []
  });
  const invalidItem = draft.items.find((item) => item.structureItemId === vlanItems[0].id);
  invalidItem.mapping.hierarchyConditions = {
    ruleJoin: 'any',
    rules: [{
      id: 'invalid-assistant-rule', action: 'include', negate: false, origin: 'assistant', operator: 'equals', caseSensitive: false,
      left: { column: 'NotMaterialized', regex: '' },
      right: { kind: 'stage', value: '', name: '', stageId: 'selection:systemsB', column: 'Code', regex: '' }
    }]
  };
  const validation = assistantDiagramPlacementExecutionValidation({
    placements,
    stages,
    currentSpec,
    structureTree: proposal.structureTree,
    structure: proposal.structure,
    validationRoles: proposal.roles
  }, draft.items);

  assert.equal(validation.checked, true);
  assert.ok(validation.errors.some((error) => error.code === 'diagram_hierarchy_condition_invalid' && error.structureItemId === vlanItems[0].id));
  assert.ok(validation.errors.some((error) => /not offered/.test(error.message)));
  assert.ok(validation.errors.some((error) => /nearest materialized parent/.test(error.message)));
  const correction = assistantDiagramPlacementCorrection(validation.errors, placements, stages);
  assert.ok(correction);
  assert.ok(correction.retryPlacementIds.includes(vlanItems[0].id));
  assert.ok(correction.retryPlacementIds.includes(scopeItems[0].id));
  assert.ok(correction.invalidMappings[0].selectedStage.fields.includes('Code'));
  assert.ok(correction.invalidMappings[0].parentStage.fields.includes('Code'));
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
      visualKind: 'node', allowedMaterialization: ['stage', 'parentCard'], currentMapping: { primary: { labelTemplate: '' } }
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
  assert.equal(vlan.mapping.primary.labelTemplate, '');
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

test('D2 preview requires current semantic mapping instead of implicit Object Flow input recompilation', async () => {
  const { currentSpec, proposal, roles } = d2StructureTreeFixture();
  let tree = structureTreeWithStage(proposal.structureTree, roles['scope-vlan'].id, 'selection:systemsA');
  tree.items = tree.items.map((item) => String(item.roleId) === String(roles.vlan.id)
    ? { ...item, mapping: { ...(item.mapping || {}), materialization: { kind: 'parentCard', stageId: '' } } }
    : item);
  const applied = applyDiagramImportProposal(currentSpec, proposal, [], [], tree);
  const stale = structuredClone(applied);
  stale.result.diagrams[0].authoring.d2Import.semanticModelRevision = 14;
  assert.equal(diagramAuthoringStatusForSpec(stale).status, 'needsReanalysis');
  const workflow = await d2WorkflowStatusForSpec(stale);
  assert.equal(workflow.state, 'pending');
  assert.equal(workflow.reason, 'semantic_model_revision_required');
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
  const stages = [{
    id: 'selection:vlans',
    alias: 'vlans',
    label: 'Все VLAN',
    className: 'vlan',
    columns: ['_id', 'Code', 'Description']
  }];
  const targets = assistantDiagramPlacementTargets(proposal, stages, {
    classes: [{
      name: 'vlan',
      attributes: [{ name: 'isNAT' }, { name: 'NetworkRole' }]
    }]
  });
  const dataModel = assistantDataSemanticModel(stages, {
    classes: [{
      name: 'vlan',
      attributes: [{ name: 'isNAT' }, { name: 'NetworkRole' }]
    }]
  });

  assert.ok(targets.length > 0);
  assert.equal(targets[0].stages, undefined);
  assert.deepEqual(dataModel.stages[0].readableFields, ['_id', 'Code', 'Description', 'isNAT', 'NetworkRole']);
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
    roleModelRevision: 15,
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

test('D2 relation-class Notes retain data-result direction by default', () => {
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
  assert.equal(requirement.directionPolicy, 'dataFields');
  assert.equal(requirement.networkEndpointStages[0].sourceStageId, 'selection:acl');
});

test('D2 topology requirements coalesce repeated concrete arrows into one class contract', () => {
  const roles = [
    { id: 'external', displayName: 'External', visualKind: 'node' },
    { id: 'application', displayName: 'Application', visualKind: 'node' }
  ];
  const mappings = [
    { roleId: 'external', source: { className: 'IS' } },
    { roleId: 'application', source: { className: 'ApplicG' } }
  ];
  const requirements = assistantDiagramTopologyRequirements([
    {
      d2ElementKey: 'external-app-80', d2ClassKey: 'acl_external', d2Notes: 'Dedicated ACL result.',
      d2ExampleLabels: ['TCP 80'], parentRoleId: 'external', childRoleId: 'application', direction: '->'
    },
    {
      d2ElementKey: 'external-app-443', d2ClassKey: 'acl_external', d2Notes: 'Dedicated ACL result.',
      d2ExampleLabels: ['TCP 443'], parentRoleId: 'external', childRoleId: 'application', direction: '->'
    }
  ], roles, mappings, [{ id: 'selection:acl', label: 'ACL external', className: 'ACL', kind: 'selection', columns: ['ipaddress', 'dipaddress'] }]);

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].d2ClassKey, 'acl_external');
  assert.deepEqual(requirements[0].d2ElementKeys.sort(), ['external-app-443', 'external-app-80']);
  assert.deepEqual(requirements[0].exampleLabels.sort(), ['TCP 80', 'TCP 443'].sort());
});

test('D2 connection editor keeps one ACL algorithm and flags divergent legacy pairs', () => {
  const roles = [
    { id: 'server', key: 'server', elementKeys: ['target.vmserver', 'target.phserver'], visualKind: 'node' },
    { id: 'internal-system', key: 'internal_system', elementKeys: ['internal.dns', 'internal.ad'], visualKind: 'node' }
  ];
  const structure = {
    groups: [{ key: 'legend', templateStatic: true }],
    nodes: [
      { key: 'target.vmserver' },
      { key: 'target.phserver' },
      { key: 'internal.dns' },
      { key: 'internal.ad' },
      { key: 'legend.source', parentKey: 'legend' },
      { key: 'legend.target', parentKey: 'legend' }
    ],
    edges: [
      { key: 'vm-dns-tcp', sourceKey: 'target.vmserver', targetKey: 'internal.dns', classKeys: ['acl_internal'], label: 'TCP 53', direction: '->' },
      { key: 'vm-dns-udp', sourceKey: 'target.vmserver', targetKey: 'internal.dns', classKeys: ['acl_internal'], label: 'UDP 53', direction: '->' },
      { key: 'ph-ad', sourceKey: 'target.phserver', targetKey: 'internal.ad', classKeys: ['acl_internal'], label: 'UDP 139', direction: '->' },
      { key: 'legend-edge', sourceKey: 'legend.source', targetKey: 'legend.target', classKeys: ['acl_internal'], label: 'Legend', direction: '->' }
    ]
  };
  const rules = diagramImportTopologyRules(roles, structure, [
    {
      id: 'legacy-vm', d2ClassKey: 'acl_internal', d2ElementKey: 'vm-dns-tcp', parentRoleId: 'server', childRoleId: 'internal-system',
      mode: 'networkEndpoints', sourceStageId: 'selection:aclA', sourceField: 'ipaddress', targetField: 'dipaddress', labelTemplate: '${Description}', directionPolicy: 'dataFields'
    },
    {
      id: 'legacy-ph', d2ClassKey: 'acl_internal', d2ElementKey: 'ph-ad', parentRoleId: 'server', childRoleId: 'internal-system',
      mode: 'networkEndpoints', sourceStageId: 'selection:aclB', sourceField: 'sourceIp', targetField: 'destinationIp', labelTemplate: '${Description}', directionPolicy: 'dataFields'
    }
  ], [{ key: 'acl_internal', notes: 'Internal ACL.' }]);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].d2ClassKey, 'acl_internal');
  assert.deepEqual(rules[0].d2ElementKeys.sort(), ['ph-ad', 'vm-dns-tcp', 'vm-dns-udp']);
  assert.match(rules[0].mappingConflict.message, /разные алгоритмы/i);
});

test('D2 connection binding leaves template exemplars out of the endpoint contract', () => {
  const [rule] = diagramImportBindRelationRulesToStructureItems([{
    id: 'external-app',
    sourceElementKey: 'external.lps',
    targetElementKey: 'target.nginx'
  }], {
    version: 5,
    items: [
      {
        id: 'external-placement',
        templateElementKey: 'external.lpd',
        templateElementKeys: ['external.lpd', 'external.lps']
      },
      {
        id: 'application-placement',
        templateElementKey: 'target.apisix',
        templateElementKeys: ['target.apisix', 'target.nginx']
      }
    ]
  });

  assert.equal(rule.sourceStructureItemId, undefined);
  assert.equal(rule.targetStructureItemId, undefined);
  assert.equal(rule.sourceElementKey, undefined);
  assert.equal(rule.targetElementKey, undefined);
});

test('D2 connection binding keeps one editable algorithm for copied placements', () => {
  const rules = diagramImportBindRelationRulesToStructureItems([{
    id: 'external-app',
    sourceElementKey: 'external.system',
    targetElementKey: 'target.application'
  }], {
    version: 5,
    items: [
      { id: 'external-placement', templateElementKey: 'external.system', templateElementKeys: ['external.system'] },
      { id: 'application-placement-a', templateElementKey: 'target.application', templateElementKeys: ['target.application'] },
      { id: 'application-placement-b', templateElementKey: 'target.application', templateElementKeys: ['target.application'] }
    ]
  });

  assert.equal(rules.length, 1);
  assert.equal(rules[0].targetStructureItemId, undefined);
  assert.equal(rules[0].id, 'external-app');
});

test('D2 Assistant coalesces different visual pairs into one class algorithm', () => {
  const requirements = assistantDiagramTopologyRequirements([
    {
      id: 'internal-dns', d2ClassKey: 'acl_internal', d2ElementKey: 'server-dns',
      parentRoleId: 'server', childRoleId: 'internal-system', direction: '->'
    },
    {
      id: 'internal-application', d2ClassKey: 'acl_internal', d2ElementKey: 'application-dns',
      parentRoleId: 'application', childRoleId: 'internal-system', direction: '->'
    }
  ], [
    { id: 'server', displayName: 'Server' },
    { id: 'application', displayName: 'Application' },
    { id: 'internal-system', displayName: 'Internal system' }
  ], [
    { roleId: 'server', source: { className: 'vServer' } },
    { roleId: 'application', source: { className: 'ApplicG' } },
    { roleId: 'internal-system', source: { className: 'IS' } }
  ]);

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].d2ClassKey, 'acl_internal');
  assert.deepEqual(requirements[0].d2ElementKeys.sort(), ['application-dns', 'server-dns']);
  assert.equal(Object.hasOwn(requirements[0], 'rolePairConflict'), false);
});

test('D2 connection classes group concrete template arrows into one Object Flow contract', () => {
  const source = 'external -> application: "TCP 80" { class: acl_external }\nexternal -> application: "TCP 443" { class: acl_external }';
  const proposal = createDiagramImportProposal(selectionFlowSpec([
    { alias: 'external', className: 'IS' },
    { alias: 'applications', className: 'ApplicG' }
  ]), normalizeDiagramImportIr({
    version: 4,
    elements: {
      nodes: [
        { id: 'external', label: 'External', classKeys: ['external_system'], pathSegments: ['external'] },
        { id: 'application', label: 'Application', classKeys: ['application'], pathSegments: ['application'] }
      ],
      edges: [
        { id: 'external-app-80', sourceKey: 'external', targetKey: 'application', label: 'TCP 80', direction: '->', classKeys: ['acl_external'] },
        { id: 'external-app-443', sourceKey: 'external', targetKey: 'application', label: 'TCP 443', direction: '->', classKeys: ['acl_external'] }
      ]
    },
    classes: [
      { key: 'external_system', usageKeys: ['external'] },
      { key: 'application', usageKeys: ['application'] },
      { key: 'acl_external', usageKeys: ['external-app-80', 'external-app-443'] }
    ]
  }, source), { sourceText: source });

  assert.equal(proposal.relationRules.length, 1);
  assert.equal(proposal.relationRules[0].d2ClassKey, 'acl_external');
  assert.equal(proposal.relationRules[0].d2Label, 'acl_external');
  assert.deepEqual(proposal.relationRules[0].d2ElementKeys.sort(), ['external-app-443', 'external-app-80']);
  assert.deepEqual(proposal.relationRules[0].d2ExampleLabels.sort(), ['TCP 443', 'TCP 80']);
});

test('D2 connection migration consolidates copied template pairs into one class algorithm', () => {
  const structure = {
    nodes: [],
    edges: [
      { key: 'external-app', sourceKey: 'external', targetKey: 'application', label: 'TCP 443', direction: '->', classKeys: ['acl_external'] },
      { key: 'external-server', sourceKey: 'external', targetKey: 'server', label: 'TCP 8443', direction: '->', classKeys: ['acl_external'] }
    ]
  };
  const profiles = [
    { id: 'external-left', structureItemId: 'external-left-item', roleId: 'external', field: 'range', operators: ['ipv4InCidr'] },
    { id: 'external-right', structureItemId: 'external-right-item', roleId: 'external', field: 'range', operators: ['ipv4InCidr'] },
    { id: 'application-ip', structureItemId: 'application-item', roleId: 'application', field: 'ipaddress', operators: ['equals'] },
    { id: 'server-ip', structureItemId: 'server-item', roleId: 'server', field: 'ipaddress', operators: ['equals'] }
  ];
  const rules = diagramImportTopologyRules([], structure, [
    {
      id: 'legacy-app', d2ClassKey: 'acl_external', d2ElementKey: 'external-app',
      mode: 'attributeEndpoints', sourceStageId: 'acl', sourceField: 'ipaddress', targetField: 'dipaddress',
      sourceOperator: 'ipv4InCidr', targetOperator: 'equals', directionPolicy: 'template',
      sourceStructureItemId: 'external-left-item', targetStructureItemId: 'application-item',
      parentRoleId: 'external', childRoleId: 'application'
    },
    {
      id: 'legacy-server', d2ClassKey: 'acl_external', d2ElementKey: 'external-server',
      mode: 'attributeEndpoints', sourceStageId: 'acl', sourceField: 'ipaddress', targetField: 'dipaddress',
      sourceOperator: 'ipv4InCidr', targetOperator: 'equals', directionPolicy: 'template',
      sourceStructureItemId: 'external-right-item', targetStructureItemId: 'server-item',
      parentRoleId: 'external', childRoleId: 'server'
    }
  ], [{ key: 'acl_external', usageKeys: ['external-app', 'external-server'] }], profiles);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].d2ClassKey, 'acl_external');
  assert.equal(Object.hasOwn(rules[0], 'sourceEndpointProfileIds'), false);
  assert.equal(Object.hasOwn(rules[0], 'targetEndpointProfileIds'), false);
  assert.equal(Object.hasOwn(rules[0], 'sourceStructureItemId'), false);
  assert.equal(Object.hasOwn(rules[0], 'targetStructureItemId'), false);
  assert.equal(Object.hasOwn(rules[0], 'parentRoleId'), false);
  assert.equal(Object.hasOwn(rules[0], 'childRoleId'), false);
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

test('D2 network roles reuse one explicit retained-card endpoint bridge', () => {
  const primary = {
    id: 'relation:applications', alias: 'applications', className: 'ApplicG', kind: 'relation',
    columns: ['_id', 'Description', 'SourceId'],
    cardSources: [
      { id: 'current', className: 'ApplicG', classColumn: 'Class', idColumn: '_id' },
      { id: 'relation-source', className: 'IpAddress', classColumn: 'SourceClass', idColumn: 'SourceId' }
    ]
  };
  const addresses = {
    id: 'selection:applicationAddresses', alias: 'applicationAddresses', className: 'IpAddress', kind: 'selection',
    columns: ['_id', 'ipAddr'], lineageAliases: ['applicationAddresses', 'applications'],
    cardSources: [{ id: 'current', className: 'IpAddress', classColumn: 'Class', idColumn: '_id' }]
  };
  const unrelatedAddresses = {
    id: 'selection:otherAddresses', alias: 'otherAddresses', className: 'IpAddress', kind: 'selection',
    columns: ['_id', 'ipAddr'], lineageAliases: ['otherAddresses'],
    cardSources: [{ id: 'current', className: 'IpAddress', classColumn: 'Class', idColumn: '_id' }]
  };
  const [mapped] = assistantDiagramAttachRelatedNetworkStages([{
    roleId: 'application',
    structureItemId: 'application-item',
    source: { stageId: primary.id, alias: primary.alias, className: primary.className },
    mapping: { id: 'application-mapping', related: [] }
  }], [{ id: 'application', visualKind: 'node' }], [primary, addresses, unrelatedAddresses], [{
    sourceRoleId: 'application', targetRoleId: 'other',
    networkEndpointStages: [{ sourceStageId: 'selection:acl', sourceField: 'ipaddress', targetField: 'dipaddress' }]
  }]);

  assert.equal(mapped.mapping.related.length, 1);
  const [binding] = mapped.mapping.related;
  assert.equal(binding.stageId, addresses.id);
  assert.deepEqual(binding.structuredFields, ['ipAddr']);
  assert.deepEqual(binding.conditions.rules[0].left, { column: '_id', regex: '' });
  assert.equal(binding.conditions.rules[0].right.stageId, primary.id);
  assert.equal(binding.conditions.rules[0].right.column, 'SourceId');
});

test('D2 topology leaves an omitted network connection unresolved instead of auto-selecting it', () => {
  const external = { id: 'selection:external', alias: 'external', className: 'IS', kind: 'selection', columns: ['_id', 'Description'] };
  const applications = { id: 'selection:applications', alias: 'applications', className: 'ApplicG', kind: 'selection', columns: ['_id', 'Description'] };
  const acl = { id: 'selection:aclExternal', alias: 'aclExternal', className: 'ACL', kind: 'selection', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] };
  const draft = assistantDiagramStageDraftFromResponse({
    kind: 'mapping', mappingPhase: 'topology', stages: [external, applications, acl],
    roles: [{ id: 'external', displayName: 'External', visualKind: 'node' }, { id: 'application', displayName: 'Application', visualKind: 'node' }],
    acceptedItems: [
      { roleId: 'external', source: { stageId: 'selection:external', alias: 'external', className: 'IS' }, mapping: { id: 'external-map' } },
      { roleId: 'external', structureItemId: 'external-static-example', source: { stageId: '', alias: '', className: '' }, mapping: { id: 'external-static-map', materialization: { kind: 'structural' } } },
      { roleId: 'application', source: { stageId: 'selection:applications', alias: 'applications', className: 'ApplicG' }, mapping: { id: 'application-map' } }
    ],
    topology: [{
      d2ElementKey: 'external-acl', d2ClassKey: 'acl_external', label: 'External ACL', sourceRoleId: 'external', targetRoleId: 'application',
      directionPolicy: 'template', trafficOrProtocol: true,
      networkEndpointStages: [{ candidateId: 'acl-candidate', sourceStageId: acl.id, sourceField: 'ipaddress', targetField: 'dipaddress', labelField: 'Description', semanticScore: 1 }],
      relationCardStages: [], deterministicEndpointStages: []
    }]
  }, { relationRules: [] });

  assert.equal(draft.success, true);
  assert.equal(draft.items.length, 2);
  assert.deepEqual(draft.relationRules, []);
  assert.deepEqual(draft.connectionUnresolved, [{
    connectionKey: 'external-acl',
    d2ClassKey: 'acl_external',
    displayName: 'acl_external',
    code: 'missingDedicatedConnectionResult',
    message: 'No dedicated named Object Flow result was mapped to D2 relation class acl_external.'
  }]);
});

test('D2 topology rejects a candidate id offered only for another connection mode', () => {
  const systems = { id: 'selection:systems', alias: 'systems', className: 'IS', kind: 'selection', columns: ['_id', 'Description'] };
  const applications = { id: 'selection:applications', alias: 'applications', className: 'ApplicG', kind: 'selection', columns: ['_id', 'Description'] };
  const acl = { id: 'semiJoin:internalAcl', alias: 'internalAcl', className: 'ACL', kind: 'semiJoin', columns: ['_id', 'ipaddress', 'dipaddress', 'Description'] };
  const draft = assistantDiagramStageDraftFromResponse({
    kind: 'mapping', mappingPhase: 'topology', stages: [systems, applications, acl],
    roles: [{ id: 'system', displayName: 'System', visualKind: 'node' }, { id: 'application', displayName: 'Application', visualKind: 'node' }],
    acceptedItems: [
      { roleId: 'system', source: { stageId: systems.id, alias: systems.alias, className: systems.className }, mapping: { id: 'system-map' } },
      { roleId: 'application', source: { stageId: applications.id, alias: applications.alias, className: applications.className }, mapping: { id: 'application-map' } }
    ],
    topology: [{
      d2ElementKey: 'internal-edge', d2ClassKey: 'acl_internal', label: 'Internal ACL', sourceRoleId: 'system', targetRoleId: 'application',
      directionPolicy: 'dataFields',
      networkEndpointStages: [{ candidateId: 'network-candidate', sourceStageId: acl.id, sourceField: 'ipaddress', targetField: 'dipaddress' }],
      deterministicEndpointStages: [{ candidateId: 'deterministic-candidate', sourceStageId: acl.id, fields: ['_id', 'ipaddress', 'dipaddress', 'Description'] }],
      relationCardStages: []
    }]
  }, {
    relationRules: [{
      d2ClassKey: 'acl_internal', mode: 'deterministicEndpoints', candidateId: 'network-candidate',
      sourceStageId: acl.id, sourceField: 'ipaddress', targetField: 'dipaddress'
    }]
  });

  assert.equal(draft.success, false);
  assert.deepEqual(draft.relationRules, []);
  assert.equal(draft.errors.length, 1);
  assert.equal(draft.errors[0].code, 'diagram_connection_candidate_not_offered');
  assert.deepEqual(draft.errors[0].received, {
    mode: 'deterministicEndpoints',
    candidateId: 'network-candidate',
    sourceStageId: acl.id,
    sourceField: 'ipaddress',
    targetField: 'dipaddress'
  });
  assert.deepEqual(draft.errors[0].offeredCandidates.map((candidate) => candidate.candidateId), ['deterministic-candidate']);
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
    d2ElementKey: 'outside-edge', d2ClassKey: 'outside_link', sourceRoleId: 'outside', targetRoleId: 'service', directionPolicy: 'template',
    networkEndpointStages: [candidate('outside', 'match:outsideLinks', 3), candidate('all-outside', 'selection:allLinks', 1)]
  }, {
    d2ElementKey: 'inside-edge', d2ClassKey: 'inside_link', sourceRoleId: 'outside', targetRoleId: 'service', directionPolicy: 'template',
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
  assert.equal(draft.warnings.filter((warning) => warning.includes('uniquely matching named result')).length, 2);
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

test('D2 labels keep Description from the selected Object Flow result instead of SourceDescription provenance', () => {
  const diagram = buildResultDiagrams({
    result: {
      diagrams: [{
        name: 'vlans',
        nodeMappings: [{
          id: 'mapping_vlan',
          from: 'vlans',
          fields: { id: '_id', label: 'Description' },
          labelTemplate: '${Description}',
          importRole: { key: 'vlan', label: 'VLAN', sourceLabel: 'Результат 2' }
        }]
      }]
    }
  }, {
    vlans: {
      rows: [{ _id: 'vlan-1', Description: 'vlan1', SourceDescription: 'range4' }]
    }
  }, {}, { maxRows: 100 })[0];

  assert.deepEqual(diagram.nodes.map((node) => node.label), ['vlan1']);
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

test('result diagrams omit unresolved connections without synthetic endpoint objects', () => {
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

  assert.equal(diagram.edges.length, 0);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
  assert.match(diagram.warnings.join('\n'), /one or both endpoint cards are absent from the approved D2 structure/);
  assert.doesNotMatch(diagram.d2.source, /Не извлечено:|Нет данных/);
  assert.doesNotMatch(diagram.d2.source, /Заглушка/);
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

test('network endpoint mappings use explicit object profiles and never expand one ACL row', () => {
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
          endpointProfiles: [{ id: 'external-network', roleId: 'external', stageId: 'external', field: 'network.range', valueKind: 'ipv4' }],
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
          endpointProfiles: [{ id: 'application-address', roleId: 'application', stageId: 'applications', field: 'address.ipAddr', valueKind: 'ipv4' }],
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
          importRole: {
            key: 'acl_external', edgeClassKey: 'acl_external', sourceKey: 'external_system', targetKey: 'application',
            sourceProfileId: 'external-network', targetProfileId: 'application-address', directionPolicy: 'dataFields'
          }
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
      { _id: 'external-2', Description: 'External 2', range: '192.168.7.0/24' }
    ] },
    externalNetworks: { rows: [
      { SourceId: 'external-1', range: '192.168.6.0/24' },
      { SourceId: 'external-2', range: '192.168.7.0/24' }
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

  assert.deepEqual(diagram.edges.map((edge) => edge.label).sort(), ['App to app', 'External to app']);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
  assert.match(diagram.warnings.join('\n'), /Skipped D2 network row acl-inside for relation class acl_external/);
  assert.match(diagram.warnings.join('\n'), /Skipped D2 network row acl-external for relation class acl_intrasystem/);
  assert.match(diagram.warnings.join('\n'), /Skipped D2 network row acl-missing for relation class acl_external: target endpoint was not resolved by the selected D2 object profile/);
  assert.doesNotMatch(diagram.warnings.join('\n'), /ambiguousNetwork/);
});

test('attribute endpoint rules use every compatible field of one D2 type without duplicating its node', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'generic-comparison-rules',
      nodeMappings: [
        {
          id: 'external',
          staticRows: [{ _id: 'external-1', Description: 'External', range: '10.10.0.0/24' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-range', roleId: 'external', stageId: 'external', field: 'range', operators: ['ipv4InCidr'] }],
          importRole: { key: 'external' }
        },
        {
          id: 'server',
          staticRows: [{ _id: 'server-1', Description: 'Server', primaryIp: '192.168.1.10', managementIp: '192.168.1.11' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [
            { id: 'server-primary', roleId: 'server', stageId: 'server', field: 'primaryIp', operators: ['ipv4InCidr'] },
            { id: 'server-management', roleId: 'server', stageId: 'server', field: 'managementIp', operators: ['ipv4InCidr'] }
          ],
          importRole: { key: 'server' }
        }
      ],
      edgeMappings: [{
        id: 'acl-external',
        type: 'attributeEndpoints',
        staticRows: [
          { _id: 'acl-main', source: '10.10.0.3', target: '192.168.1.10', Description: 'Main' },
          { _id: 'acl-management', source: '10.10.0.3', target: '192.168.1.11', Description: 'Management' }
        ],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', operator: 'ipv4InCidr', directionPolicy: 'template' },
        importRole: { key: 'acl_external', edgeClassKey: 'acl_external', sourceKey: 'external', targetKey: 'server', directionPolicy: 'template' }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.nodes.filter((node) => node.importRole.key === 'server').length, 1);
  assert.equal(diagram.edges.length, 2);
  assert.equal(new Set(diagram.edges.map((edge) => edge.target)).size, 1);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
});

test('one ACL class algorithm resolves every selected technical endpoint category', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'acl-class-algorithm',
      nodeMappings: [
        {
          id: 'external',
          staticRows: [{ _id: 'external-1', Description: 'External IS', range: '10.50.0.0/24' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-range', roleId: 'external_system', field: 'range', operators: ['ipv4InCidr'] }],
          importRole: { key: 'external_system' }
        },
        {
          id: 'application',
          staticRows: [{ _id: 'application-1', Description: 'Application', ipaddress: '10.60.0.10' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'application-ip', roleId: 'application', field: 'ipaddress', operators: ['equals'] }],
          importRole: { key: 'application' }
        },
        {
          id: 'server',
          staticRows: [{ _id: 'server-1', Description: 'Server', ipaddress: '10.60.0.20' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'server-ip', roleId: 'server', field: 'ipaddress', operators: ['equals'] }],
          importRole: { key: 'server' }
        },
        {
          id: 'equipment',
          staticRows: [{ _id: 'equipment-1', Description: 'Equipment', ipaddress: '10.60.0.30' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'equipment-ip', roleId: 'equipment', field: 'ipaddress', operators: ['equals'] }],
          importRole: { key: 'equipment' }
        }
      ],
      edgeMappings: [{
        id: 'acl-external',
        type: 'attributeEndpoints',
        staticRows: [
          { _id: 'acl-app', source: '10.50.0.11', target: '10.60.0.10', Description: 'To application' },
          { _id: 'acl-server', source: '10.50.0.12', target: '10.60.0.20', Description: 'To server' },
          { _id: 'acl-equipment', source: '10.50.0.13', target: '10.60.0.30', Description: 'To equipment' }
        ],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: {
          strategy: 'comparisonRules',
          sourceOperator: 'ipv4InCidr',
          targetOperator: 'equals',
          profileScope: 'allCompatiblePlacements',
          // A v13 saved subset must not constrain the revision-14 runtime.
          sourceEndpointProfileIds: ['external-range'],
          targetEndpointProfileIds: ['application-ip'],
          directionPolicy: 'dataFields'
        },
        importRole: {
          key: 'acl_external', edgeClassKey: 'acl_external',
          sourceEndpointProfileIds: ['external-range'],
          targetEndpointProfileIds: ['application-ip'],
          directionPolicy: 'dataFields'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 3);
  assert.deepEqual(diagram.edges.map((edge) => edge.label).sort(), ['To application', 'To equipment', 'To server']);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
  assert.equal(diagram.execution.connections.length, 1);
  assert.equal(diagram.execution.connections[0].relation.key, 'acl_external');
});

test('attribute endpoint rules keep every real placement pair and deduplicate repeated ACL rows', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'attribute-endpoint-pairs',
      nodeMappings: [
        {
          id: 'external',
          staticRows: [{ _id: 'external-1', Description: 'External A', city: 'Moscow' }, { _id: 'external-2', Description: 'External B', city: 'Moscow' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-city', roleId: 'external', field: 'city', operators: ['equals'] }],
          importRole: { key: 'external' }
        },
        {
          id: 'service',
          staticRows: [{ _id: 'service-1', Description: 'Service A', city: 'Tver' }, { _id: 'service-2', Description: 'Service B', city: 'Tver' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'service-city', roleId: 'service', field: 'city', operators: ['equals'] }],
          importRole: { key: 'service' }
        }
      ],
      edgeMappings: [{
        id: 'city-link',
        type: 'attributeEndpoints',
        staticRows: [
          { _id: 'acl-1', source: 'Moscow', target: 'Tver', Description: 'City link' },
          { _id: 'acl-1', source: 'Moscow', target: 'Tver', Description: 'City link' }
        ],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', operator: 'equals', directionPolicy: 'template', requiresProfiles: true },
        importRole: {
          key: 'city-link', edgeClassKey: 'city-link', sourceKey: 'external', targetKey: 'service',
          sourceProfileId: 'external-city', targetProfileId: 'service-city', directionPolicy: 'template'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 4);
  assert.equal(diagram.nodes.some((node) => node.fakeEndpoint), false);
  assert.deepEqual(diagram.execution.connections, [{
    relation: { key: 'city-link', label: 'city-link' },
    source: { stageLabel: '', alias: '' },
    inputRows: 2,
    uniqueCards: 1,
    duplicateInputRows: 1,
    unidentifiedRows: 0,
    candidatePairs: 8,
    emittedPairs: 4,
    duplicatePairs: 4,
    skipped: { sourceUnresolved: 0, targetUnresolved: 0, bothUnresolved: 0, incompatible: 0 }
  }]);
});

test('attribute endpoint rules apply separate source and target operators to every compatible placement profile', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'asymmetric-placement-comparison-rules',
      nodeMappings: [
        {
          id: 'external',
          staticRows: [{ _id: 'external-1', Description: 'External', range: '10.10.0.0/24' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-range', structureItemId: 'external-item', roleId: 'external', field: 'range', operators: ['ipv4InCidr'] }],
          importRole: { key: 'external', structureItemId: 'external-item' }
        },
        {
          id: 'server',
          staticRows: [{ _id: 'server-1', Description: 'Server', primaryIp: '192.168.1.10', secondaryIp: '192.168.1.10' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [
            { id: 'server-primary', structureItemId: 'server-item', roleId: 'server', field: 'primaryIp', operators: ['equals'] },
            { id: 'server-secondary', structureItemId: 'server-item', roleId: 'server', field: 'secondaryIp', operators: ['equals'] }
          ],
          importRole: { key: 'server', structureItemId: 'server-item' }
        }
      ],
      edgeMappings: [{
        id: 'acl-external',
        type: 'attributeEndpoints',
        staticRows: [{ _id: 'acl-1', source: '10.10.0.3', target: '192.168.1.10', Description: 'ACL' }],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: {
          strategy: 'comparisonRules',
          sourceOperator: 'ipv4InCidr',
          targetOperator: 'equals',
          profileScope: 'placement',
          directionPolicy: 'template'
        },
        importRole: {
          key: 'acl_external',
          edgeClassKey: 'acl_external',
          sourceKey: 'external',
          targetKey: 'server',
          sourceStructureItemId: 'external-item',
          targetStructureItemId: 'server-item',
          directionPolicy: 'template'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 2, 'Each compatible profile pair is an explicit user-authored match and must remain visible.');
  assert.equal(new Set(diagram.edges.map((edge) => edge.id)).size, 2);
  assert.equal(diagram.execution.connections[0].candidatePairs, 2);
  assert.equal(diagram.execution.connections[0].emittedPairs, 2);
  assert.equal(diagram.execution.connections[0].duplicatePairs, 0);
});

test('D2 attribute endpoint rules use every compatible copied placement rule', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'placement-scoped-comparison-rule',
      nodeMappings: [
        {
          id: 'external-left',
          staticRows: [{ _id: 'external-left-card', Description: 'External left', city: 'Moscow' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-left-city', roleId: 'external', field: 'city', operators: ['equals'] }],
          importRole: { key: 'external' }
        },
        {
          id: 'external-right',
          staticRows: [{ _id: 'external-right-card', Description: 'External right', alternateCity: 'Moscow' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-right-city', roleId: 'external', field: 'alternateCity', operators: ['equals'] }],
          importRole: { key: 'external' }
        },
        {
          id: 'service',
          staticRows: [{ _id: 'service-card', Description: 'Service', city: 'Tver' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'service-city', roleId: 'service', field: 'city', operators: ['equals'] }],
          importRole: { key: 'service' }
        }
      ],
      edgeMappings: [{
        id: 'city-link',
        type: 'attributeEndpoints',
        staticRows: [{ _id: 'city-link-row', source: 'Moscow', target: 'Tver', Description: 'City link' }],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', operator: 'equals', directionPolicy: 'template', requiresProfiles: true },
        importRole: {
          key: 'city-link',
          edgeClassKey: 'city-link',
          sourceKey: 'external',
          targetKey: 'service',
          sourceProfileId: 'external-left-city',
          targetProfileId: 'service-city',
          directionPolicy: 'template'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  const left = diagram.nodes.find((node) => node.label === 'External left');
  const right = diagram.nodes.find((node) => node.label === 'External right');
  const service = diagram.nodes.find((node) => node.label === 'Service');
  assert.ok(left && right && service);
  assert.equal(diagram.edges.length, 2);
  assert.deepEqual(new Set(diagram.edges.map((edge) => edge.source)), new Set([left.id, right.id]));
  assert.ok(diagram.edges.every((edge) => edge.target === service.id));
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
});

test('attribute endpoint rules may target a dynamic D2 container', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'container-comparison-rule',
      nodeMappings: [{
        id: 'external',
        staticRows: [{ _id: 'external-1', Description: 'External', site: 'Moscow' }],
        fields: { id: '_id', label: 'Description' },
        endpointProfiles: [{ id: 'external-site', roleId: 'external', stageId: 'external', field: 'site', operators: ['equals'] }],
        importRole: { key: 'external' }
      }],
      groupMappings: [{
        id: 'server-scope',
        staticRows: [{ _id: 'scope-1', Description: 'Server scope', site: 'Tver' }],
        fields: { id: '_id', label: 'Description' },
        endpointProfiles: [{ id: 'scope-site', roleId: 'scope_server', stageId: 'scope', field: 'site', operators: ['equals'] }],
        importRole: { key: 'scope_server' }
      }],
      edgeMappings: [{
        id: 'location-link',
        type: 'attributeEndpoints',
        staticRows: [{ _id: 'edge-1', source: 'Moscow', target: 'Tver', Description: 'Location' }],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', operator: 'equals', directionPolicy: 'template' },
        importRole: { key: 'location_link', edgeClassKey: 'location_link', sourceKey: 'external', targetKey: 'scope_server', directionPolicy: 'template' }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  const scope = diagram.groups.find((group) => group.importRole.key === 'scope_server');
  assert.ok(scope);
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].target, scope.id);
});

test('runtime excludes a dynamic container endpoint when its direct child inherits the same card', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'parent-card-container-is-not-an-endpoint',
      structureTree: {
        version: 5,
        items: [
          { id: 'external-item', roleId: 'external-role', parentId: '', mapping: { materialization: { kind: 'stage', stageId: 'external' } } },
          { id: 'scope-item', roleId: 'scope-role', parentId: '', mapping: { materialization: { kind: 'stage', stageId: 'servers' } } },
          { id: 'server-item', roleId: 'server-role', parentId: 'scope-item', mapping: { materialization: { kind: 'parentCard', stageId: '' } } }
        ]
      },
      authoring: { d2Import: { roles: [
        { id: 'external-role', visualKind: 'node' },
        { id: 'scope-role', visualKind: 'container' },
        { id: 'server-role', visualKind: 'node' }
      ] } },
      nodeMappings: [
        {
          id: 'external', staticRows: [{ _id: 'external-1', Description: 'External', city: 'Moscow' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-city', structureItemId: 'external-item', field: 'city', operators: ['equals'] }],
          importRole: { roleId: 'external-role', key: 'external', structureItemId: 'external-item', elementKey: 'external' }
        },
        {
          id: 'server', staticRows: [{ _id: 'server-1', Description: 'Server', city: 'Tver' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'server-city', structureItemId: 'server-item', field: 'city', operators: ['equals'] }],
          importRole: { roleId: 'server-role', key: 'server', structureItemId: 'server-item', elementKey: 'scope.server', parentStructureItemId: 'scope-item' }
        }
      ],
      groupMappings: [{
        id: 'scope', staticRows: [{ _id: 'server-1', Description: 'Server scope', city: 'Tver' }],
        fields: { id: '_id', label: 'Description' },
        endpointProfiles: [{ id: 'scope-city', structureItemId: 'scope-item', field: 'city', operators: ['equals'] }],
        importRole: { roleId: 'scope-role', key: 'scope', structureItemId: 'scope-item', elementKey: 'scope' }
      }],
      edgeMappings: [{
        id: 'city-link', type: 'attributeEndpoints', staticRows: [{ _id: 'edge-1', source: 'Moscow', target: 'Tver', Description: 'City link' }],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', sourceOperator: 'equals', targetOperator: 'equals', directionPolicy: 'dataFields' },
        importRole: { key: 'city-link', edgeClassKey: 'city-link', sourceKey: 'external', targetKey: 'scope', directionPolicy: 'dataFields' }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  const scope = diagram.groups.find((group) => group && group.importRole && group.importRole.key === 'scope');
  const server = diagram.nodes.find((node) => node && node.importRole && node.importRole.key === 'server');
  assert.ok(scope && server);
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].target, server.id);
  assert.notEqual(diagram.edges[0].target, scope.id);
});

test('strict D2 grammar omits an unresolved container endpoint without changing the template structure', () => {
  const grammar = {
    version: 3,
    fingerprint: 'container-placeholder-grammar',
    elements: [
      { key: 'root', kind: 'group', roleKey: 'root', parentKey: '', parentRoleKey: '' },
      { key: 'root.external', kind: 'node', roleKey: 'external', parentKey: 'root', parentRoleKey: 'root' },
      { key: 'root.scope', kind: 'group', roleKey: 'scope', parentKey: 'root', parentRoleKey: 'root' }
    ],
    roles: [
      { roleId: 'root', roleKey: 'root', label: 'Root', visualKind: 'container', nodeElementKeys: [], groupElementKeys: ['root'] },
      { roleId: 'external', roleKey: 'external', label: 'External', visualKind: 'node', nodeElementKeys: ['root.external'], groupElementKeys: [] },
      { roleId: 'scope', roleKey: 'scope', label: 'Scope', visualKind: 'container', nodeElementKeys: [], groupElementKeys: ['root.scope'] }
    ],
    contexts: [
      { key: 'root-context', roleId: 'root', parentContextKey: '', elementKeys: ['root'] },
      { key: 'external-context', roleId: 'external', parentContextKey: 'root-context', elementKeys: ['root.external'] },
      { key: 'scope-context', roleId: 'scope', parentContextKey: 'root-context', elementKeys: ['root.scope'] }
    ],
    edges: [{ key: '(root.external -> root.scope)[0]', sourceKey: 'root.external', targetKey: 'root.scope', sourceRoleKey: 'external', targetRoleKey: 'scope', direction: '->' }]
  };
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'container-placeholder',
      templateGrammar: grammar,
      structureTree: {
        version: 5,
        items: [
          { id: 'root-item', roleId: 'root', templateContextKey: 'root-context', templateElementKey: 'root', templateElementKeys: ['root'], parentId: '', mapping: {} },
          { id: 'external-item', roleId: 'external', templateContextKey: 'external-context', templateElementKey: 'root.external', templateElementKeys: ['root.external'], parentId: 'root-item', mapping: {} },
          { id: 'scope-item', roleId: 'scope', templateContextKey: 'scope-context', templateElementKey: 'root.scope', templateElementKeys: ['root.scope'], parentId: 'root-item', mapping: {} }
        ]
      },
      nodeMappings: [{
        id: 'external', staticRows: [{ _id: 'external-1', Description: 'External', city: 'Moscow' }],
        fields: { id: '_id', label: 'Description' },
        endpointProfiles: [{ id: 'external-city', roleId: 'external', stageId: 'external', field: 'city', operators: ['equals'] }],
        importRole: { roleId: 'external', key: 'external', semantic: 'object', elementKey: 'root.external', structureItemId: 'external-item', parentStructureItemId: 'root-item' }
      }],
      groupMappings: [{
        id: 'scope', staticRows: [],
        fields: { id: '_id', label: 'Description' },
        endpointProfiles: [{ id: 'scope-city', roleId: 'scope', stageId: 'scope', field: 'city', operators: ['equals'] }],
        importRole: { roleId: 'scope', key: 'scope', semantic: 'group', elementKey: 'root.scope', structureItemId: 'scope-item', parentStructureItemId: 'root-item' }
      }],
      edgeMappings: [{
        id: 'city-link', type: 'attributeEndpoints', staticRows: [{ _id: 'edge-1', source: 'Moscow', target: 'Tver', Description: 'City link' }],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', operator: 'equals', directionPolicy: 'template' },
        importRole: {
          key: 'city-link', elementKey: '(root.external -> root.scope)[0]', sourceElementKey: 'root.external', targetElementKey: 'root.scope',
          sourceKey: 'external', targetKey: 'scope', directionPolicy: 'template'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.groups.some((group) => group.fakeEndpoint), false);
  assert.equal(diagram.nodes.some((node) => node.fakeEndpoint), false);
  assert.equal(diagram.edges.length, 0);
  assert.deepEqual(diagram.execution.connections[0].skipped, {
    sourceUnresolved: 0,
    targetUnresolved: 1,
    bothUnresolved: 0,
    incompatible: 0
  });
});

test('D2-imported network mappings without selected profiles remain previewable without implicit arrows', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'profile-required-network-topology',
      nodeMappings: [
        {
          id: 'source',
          staticRows: [{ _id: 'source-1', Description: 'External', range: '10.20.0.0/24' }],
          fields: { id: '_id', label: 'Description' },
          endpointFields: ['range'],
          importRole: { key: 'external_system' }
        },
        {
          id: 'target',
          staticRows: [{ _id: 'target-1', Description: 'Service', ipaddress: '10.20.0.8' }],
          fields: { id: '_id', label: 'Description' },
          endpointFields: ['ipaddress'],
          importRole: { key: 'application' }
        }
      ],
      edgeMappings: [{
        id: 'acl-external',
        type: 'networkEndpoints',
        staticRows: [{ _id: 'acl-1', ipaddress: '10.20.0.3', dipaddress: '10.20.0.8', Description: 'ACL' }],
        fields: { source: 'ipaddress', target: 'dipaddress', label: 'Description' },
        endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'dataFields', requiresProfiles: true },
        importRole: { key: 'acl_external', edgeClassKey: 'acl_external', sourceKey: 'external_system', targetKey: 'application' }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 0);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
  assert.match(diagram.warnings.join('\n'), /source and target D2 object profiles must be selected/);
});

test('network endpoint profiles keep every real placement pair and deduplicate repeated ACL rows', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'network-endpoint-pairs',
      nodeMappings: [
        {
          id: 'external',
          staticRows: [
            { _id: 'external-1', Description: 'External A', ipaddress: '10.30.0.10' },
            { _id: 'external-2', Description: 'External B', ipaddress: '10.30.0.10' }
          ],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'external-ip', roleId: 'external', field: 'ipaddress', valueKind: 'ipv4' }],
          importRole: { key: 'external' }
        },
        {
          id: 'service',
          staticRows: [
            { _id: 'service-1', Description: 'Service A', ipaddress: '10.40.0.10' },
            { _id: 'service-2', Description: 'Service B', ipaddress: '10.40.0.10' }
          ],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'service-ip', roleId: 'service', field: 'ipaddress', valueKind: 'ipv4' }],
          importRole: { key: 'service' }
        }
      ],
      edgeMappings: [{
        id: 'acl-external',
        type: 'networkEndpoints',
        staticRows: [
          { _id: 'acl-1', source: '10.30.0.10', target: '10.40.0.10', Description: 'Allow' },
          { _id: 'acl-1', source: '10.30.0.10', target: '10.40.0.10', Description: 'Allow' }
        ],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'dataFields', requiresProfiles: true },
        importRole: {
          key: 'acl_external', edgeClassKey: 'acl_external', sourceKey: 'external', targetKey: 'service',
          sourceProfileId: 'external-ip', targetProfileId: 'service-ip', directionPolicy: 'dataFields'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 4);
  assert.equal(diagram.nodes.some((node) => node.fakeEndpoint), false);
  assert.deepEqual(diagram.execution.connections, [{
    relation: { key: 'acl_external', label: 'acl_external' },
    source: { stageLabel: '', alias: '' },
    inputRows: 2,
    uniqueCards: 1,
    duplicateInputRows: 1,
    unidentifiedRows: 0,
    candidatePairs: 8,
    emittedPairs: 4,
    duplicatePairs: 4,
    skipped: { sourceUnresolved: 0, targetUnresolved: 0, bothUnresolved: 0, incompatible: 0 }
  }]);
});

test('parallel runtime ACL edges receive distinct D2 connection selectors', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'parallel-runtime-acl-edges',
      nodeMappings: [
        {
          id: 'source',
          staticRows: [{ _id: 'source-1', Description: 'PGSQL', ipaddress: '10.30.0.10' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'source-ip', roleId: 'application', field: 'ipaddress', valueKind: 'ipv4' }],
          importRole: { key: 'application' }
        },
        {
          id: 'target',
          staticRows: [{ _id: 'target-1', Description: 'AD', ipaddress: '10.40.0.10' }],
          fields: { id: '_id', label: 'Description' },
          endpointProfiles: [{ id: 'target-ip', roleId: 'internal_system', field: 'ipaddress', valueKind: 'ipv4' }],
          importRole: { key: 'internal_system' }
        }
      ],
      edgeMappings: [{
        id: 'acl-internal',
        type: 'networkEndpoints',
        staticRows: [
          { _id: 'acl-139', source: '10.30.0.10', target: '10.40.0.10', Description: 'UDP 139' },
          { _id: 'acl-443', source: '10.30.0.10', target: '10.40.0.10', Description: 'TCP 443' }
        ],
        fields: { source: 'source', target: 'target', label: 'Description' },
        endpointResolution: { strategy: 'ipv4ObjectThenRange', directionPolicy: 'dataFields', requiresProfiles: true },
        importRole: {
          key: 'acl_internal', edgeClassKey: 'acl_internal', sourceKey: 'application', targetKey: 'internal_system',
          sourceProfileId: 'source-ip', targetProfileId: 'target-ip', directionPolicy: 'dataFields'
        }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 2);
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sourceId = diagram.nodes.find((node) => node.label === 'PGSQL').d2Id;
  const targetId = diagram.nodes.find((node) => node.label === 'AD').d2Id;
  const selectorPattern = new RegExp(`\\(${escapeRegExp(sourceId)} -> ${escapeRegExp(targetId)}\\)\\[(\\d+)\\]`, 'g');
  const selectors = Array.from(diagram.d2.source.matchAll(selectorPattern), (match) => Number(match[1])).sort((left, right) => left - right);
  const directConnection = `${sourceId} -> ${targetId}`;
  const directConnections = diagram.d2.source.split('\n').filter((line) => line === directConnection);

  assert.equal(directConnections.length, 2, 'Each ACL row must declare its own D2 connection before selectors configure it.');
  assert.deepEqual(selectors, [0, 1]);
  assert.ok(
    diagram.d2.source.indexOf(directConnection) < diagram.d2.source.indexOf(`(${directConnection})[0]`),
    'D2 selectors must decorate a declared connection rather than attempting to create one.'
  );
  assert.match(diagram.d2.source, /label: "UDP 139"/);
  assert.match(diagram.d2.source, /label: "TCP 443"/);
});

test('attribute endpoint mappings without configured comparison rules remain previewable without placeholders', () => {
  const diagram = buildResultDiagrams({
    result: { diagrams: [{
      name: 'comparison-rule-required',
      nodeMappings: [
        { id: 'source', staticRows: [{ _id: 'source-1', Description: 'External', range: '10.20.0.0/24' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'external_system' } },
        { id: 'target', staticRows: [{ _id: 'target-1', Description: 'Service', ipaddress: '10.20.0.8' }], fields: { id: '_id', label: 'Description' }, importRole: { key: 'application' } }
      ],
      edgeMappings: [{
        id: 'acl-external', type: 'attributeEndpoints',
        staticRows: [{ _id: 'acl-1', ipaddress: '10.20.0.3', dipaddress: '10.20.0.8', Description: 'ACL' }],
        fields: { source: 'ipaddress', target: 'dipaddress', label: 'Description' },
        endpointResolution: { strategy: 'comparisonRules', operator: 'ipv4InCidr', directionPolicy: 'dataFields' },
        importRole: { key: 'acl_external', edgeClassKey: 'acl_external', sourceKey: 'external_system', targetKey: 'application', directionPolicy: 'dataFields' }
      }]
    }] }
  }, {}, {}, { maxRows: 20 })[0];

  assert.equal(diagram.edges.length, 0);
  assert.equal(diagram.nodes.filter((node) => node.fakeEndpoint).length, 0);
  assert.match(diagram.warnings.join('\n'), /D2 attribute connection acl_external: source and target side has no materialized compatible comparison rule/);
});

test('strict D2 grammar omits a connection whose endpoint is absent', () => {
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
  assert.equal(diagram.nodes.every((node) => node.importRole.key === 'child-role'), true);
  assert.equal(diagram.nodes[0].label, 'Known');
  assert.equal(diagram.nodes.some((node) => node.label === 'Child'), false);
  assert.equal(diagram.nodes.some((node) => node.fakeEndpoint), false);
  assert.equal(diagram.edges.length, 0);
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

test('bounded MCP payload remains valid JSON and exposes resumable truncation evidence', () => {
  const source = {
    classes: Array.from({ length: 200 }, (_, index) => ({
      name: `Class${index}`,
      description: `Class ${index} ${'x'.repeat(200)}`,
      attributes: Array.from({ length: 12 }, (__, attributeIndex) => ({ name: `Field${attributeIndex}`, help: 'y'.repeat(120) }))
    }))
  };
  const bounded = boundedMcpText(source, 4096);
  const parsed = JSON.parse(bounded.text);

  assert.ok(Buffer.byteLength(bounded.text) <= 4096);
  assert.equal(parsed.complete, false);
  assert.match(parsed.nextCursor, /^bounded:/);
  assert.match(parsed.catalogRevision, /^[a-f0-9]{64}$/);
  assert.equal(parsed.evidence.originalBytes, bounded.bytes);
  assert.equal(parsed.evidence.returnedBytes, bounded.returnedBytes);
  assert.equal(bounded.truncated, true);
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
  assert.equal(defaultConfig.assistant.prompt.version, 4);
  assert.match(defaultConfig.assistant.prompt.diagramSemantics, /D2 class/);
  assert.match(defaultConfig.assistant.prompt.diagramBindingIntent, /business/i);
  assert.match(defaultConfig.assistant.prompt.diagramPlacement, /structureItemId/);
  assert.match(defaultConfig.assistant.prompt.diagramConnections, /connection classes/);
  assert.match(defaultConfig.assistant.prompt.diagramCritique, /BusinessBlockManifest/);
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

  const ignoredLegacy = normalizeAssistantPromptContract({
    diagramInterpretation: 'Legacy semantics.',
    diagramMapping: 'Legacy mapping.'
  }, defaultConfig.assistant.prompt);
  assert.equal(ignoredLegacy.version, 4);
  assert.equal(ignoredLegacy.diagramSemantics, defaultConfig.assistant.prompt.diagramSemantics);
  assert.equal(ignoredLegacy.diagramPlacement, defaultConfig.assistant.prompt.diagramPlacement);
  assert.equal(ignoredLegacy.diagramConnections, defaultConfig.assistant.prompt.diagramConnections);
});

test('DataSemanticModel preserves canonical rightExpression values and expression kinds', () => {
  const model = assistantDataSemanticModel([{
    id: 'selection:systems', alias: 'systems', kind: 'selection', className: 'IS', columns: ['_id', 'Active', 'Code', 'Location'],
    rules: [
      { action: 'include', path: 'Active', op: 'equals', rightExpression: true },
      { action: 'exclude', path: 'Active', op: 'equals', rightExpression: false },
      { action: 'include', path: 'Code', op: 'equals', rightExpression: '${param.systemCode}' },
      { action: 'include', path: 'Location', op: 'equals', rightExpression: '${previous.Location}' }
    ]
  }]);

  assert.equal(model.kind, 'DataSemanticModel');
  assert.equal(model.version, 3);
  assert.deepEqual(model.stages[0].rules.map((rule) => ({
    rightExpression: rule.rightExpression,
    expressionKind: rule.expressionKind
  })), [
    { rightExpression: 'true', expressionKind: 'literal' },
    { rightExpression: 'false', expressionKind: 'literal' },
    { rightExpression: '${param.systemCode}', expressionKind: 'parameter' },
    { rightExpression: '${previous.Location}', expressionKind: 'previous' }
  ]);
  assert.equal(model.stages[0].rules.some((rule) => Object.hasOwn(rule, 'value') || Object.hasOwn(rule, 'valueParam') || Object.hasOwn(rule, 'valueColumn')), false);
});

test('D2 Assistant exchanges versioned semantic, structural, binding, and coverage models', () => {
  const stages = [{
    id: 'selection:systems', label: 'Systems', alias: 'systems', kind: 'selection', className: 'IS',
    columns: ['_id', 'Description'], lineageLabels: ['Systems'],
    rules: [{ action: 'include', path: 'isExt', op: 'equals', rightExpression: 'false' }],
    cardSources: [{ id: 'current', label: 'IS', className: 'IS', classColumn: '_type', idColumn: '_id' }]
  }];
  const roles = [{ id: 'role-system', displayName: 'System', kind: 'node', notes: 'One system card.', visualKind: 'node', labelTemplate: '${Description}' }];
  const placements = [{
    structureItemId: 'placement-system', roleId: 'role-system', displayName: 'System', templateElementKey: 'systems.sample',
    parentStructureItemId: '', placementNotes: 'Place in the systems branch.', allowedMaterialization: ['stage']
  }];
  const connections = [{ d2ElementKey: 'connection-example', d2ClassKey: 'depends_on', connectionNotes: 'Dependency.', directionPolicy: 'dataFields' }];

  const data = assistantDataSemanticModel(stages);
  const structure = assistantD2StructuralModel(roles, placements, connections);
  const semantics = assistantD2SemanticModel(roles);
  const binding = assistantD2BindingModel([{
    structureItemId: 'placement-system', roleId: 'role-system', source: { stageId: 'selection:systems', className: 'IS' },
    mapping: { materialization: { kind: 'stage', stageId: 'selection:systems' } }
  }]);
  const coverage = assistantCoverageModel({ status: 'complete', requiredRoles: 1, mappedRoles: 1, requiredConnections: 0, mappedConnections: 0, unresolved: [] });

  assert.deepEqual([data.kind, structure.kind, semantics.kind, binding.kind, coverage.kind], [
    'DataSemanticModel', 'D2StructuralModel', 'D2SemanticModel', 'D2BindingModel', 'CoverageModel'
  ]);
  assert.deepEqual([data.version, structure.version, semantics.version, binding.version, coverage.version], [3, 1, 1, 1, 2]);
  assert.ok([data, structure, semantics, binding, coverage].every((model) => /^[a-f0-9]{64}$/.test(model.modelHash)));
  assert.equal(structure.roles[0].roleNotes, 'One system card.');
  assert.equal(structure.placements[0].placementNotes, 'Place in the systems branch.');
  assert.equal(structure.placements[0].materializationHint, '');
  assert.equal(structure.connections[0].connectionNotes, 'Dependency.');
  assert.equal(binding.placements[0].stageId, 'selection:systems');
  assert.equal(coverage.status, 'complete');
  assert.deepEqual(data.stages[0].rules, [{
    action: 'include', negate: false, operator: 'equals', path: 'isExt', rightExpression: 'false', expressionKind: 'literal', leftColumn: '', rightColumn: ''
  }]);
});

test('D2 business intent exposes only terminal block results and deterministic obligations reject semantic substitutions', () => {
  const stages = [{
    id: 'selection:external-source', alias: 'external_source', label: 'External source', className: 'IS',
    columns: ['_id', 'Description', 'isExt'], assistantBlockIds: ['block-external'], stageRole: 'helper', outputKind: 'sourceCards', rowGrain: 'card'
  }, {
    id: 'match:external-terminal', alias: 'external_terminal', label: 'Внешние ИС', className: 'IS',
    columns: ['_id', 'Description', 'isExt'], assistantBlockIds: ['block-external'], stageRole: 'terminal', outputKind: 'sourceCards', rowGrain: 'card'
  }, {
    id: 'match:acl-helper', alias: 'acl_helper', label: 'ACL helper', className: 'ACL',
    columns: ['_id', 'ipaddress', 'dipaddress'], assistantBlockIds: ['block-acl'], stageRole: 'helper', outputKind: 'sourceCards', rowGrain: 'card'
  }, {
    id: 'match:acl-terminal', alias: 'acl_terminal', label: 'ACL внешних ИС', className: 'ACL',
    columns: ['_id', 'ipaddress', 'dipaddress'], assistantBlockIds: ['block-acl'], stageRole: 'terminal', outputKind: 'sourceCards', rowGrain: 'card'
  }];
  const manifest = assistantObjectFlowBusinessBlockManifest({
    authoring: { version: 1, assistant: { objectFlowIntent: { context: '', blocks: [
      { id: 'block-external', name: 'Внешние ИС', entities: 'IS', algorithm: 'Only external systems.', expectedResult: 'IS cards.' },
      { id: 'block-acl', name: 'ACL внешних ИС', entities: 'ACL', algorithm: 'Selected ACL cards.', expectedResult: 'ACL cards.' }
    ] } } }
  }, stages);
  assert.equal(manifest.blocks.find((block) => block.id === 'block-external').terminalStageId, 'match:external-terminal');
  assert.deepEqual(manifest.blocks.find((block) => block.id === 'block-external').helperStageIds, ['selection:external-source']);

  const placements = [{
    structureItemId: 'placement-external', roleId: 'role-external', displayName: 'external_system', visualKind: 'node',
    allowedMaterialization: ['stage'], directives: {
      'binding-result': 'Внешние ИС',
      'stage-policy': 'terminal-only',
      'required-condition': ['isExt equals true'],
      'endpoint-field': ['{ISZabbixMonitoringDomain:ipRange}.range'],
      'endpoint-operator': ['ipv4InCidr']
    }
  }];
  const relationRules = [{
    d2ClassKey: 'acl_external', d2ElementKey: 'edge-external',
    d2Notes: 'binding-result: ACL внешних ИС\nstage-policy: terminal-only\nrow-grain: card\nendpoint-mode: attributeEndpoints\nsource-field: ipaddress\nsource-operator: ipv4InCidr\ntarget-field: dipaddress\ntarget-operator: equals'
  }];
  const intentDraft = assistantDiagramBindingIntentDraftFromResponse({
    placements,
    relationRules,
    businessBlockManifest: manifest
  }, {
    placementBindings: [{ structureItemId: 'placement-external', materializationIntent: 'stage', businessBlockId: 'block-external' }],
    connectionBindings: [{ d2ClassKey: 'acl_external', businessBlockId: 'block-acl' }],
    unresolved: []
  });
  assert.equal(intentDraft.success, true, JSON.stringify(intentDraft.errors));
  const deterministicSeed = assistantDiagramBindingIntentSeed({
    placements,
    relationRules,
    businessBlockManifest: manifest
  });
  assert.deepEqual(deterministicSeed.pendingPlacementIds, []);
  assert.deepEqual(deterministicSeed.pendingConnectionKeys, []);
  assert.deepEqual(deterministicSeed.placementBindings, [{
    structureItemId: 'placement-external', materializationIntent: 'stage', businessBlockId: 'block-external'
  }]);
  assert.deepEqual(deterministicSeed.connectionBindings, [{
    d2ClassKey: 'acl_external', businessBlockId: 'block-acl'
  }]);
  const cardlessSeed = assistantDiagramBindingIntentSeed({
    placements: [{
      structureItemId: 'placement-group', roleId: 'role-group', displayName: 'group_external', visualKind: 'container',
      materializationHint: 'structural', allowedMaterialization: ['structural'], directives: {}
    }, {
      structureItemId: 'placement-child', roleId: 'role-child', displayName: 'server', visualKind: 'node',
      materializationHint: 'parentCard', allowedMaterialization: ['parentCard'], directives: {}
    }],
    relationRules: [],
    businessBlockManifest: manifest
  });
  assert.deepEqual(cardlessSeed.pendingPlacementIds, []);
  assert.deepEqual(cardlessSeed.placementBindings, [{
    structureItemId: 'placement-group', materializationIntent: 'structural'
  }, {
    structureItemId: 'placement-child', materializationIntent: 'parentCard'
  }]);
  const bindingIntent = intentDraft.intent;
  assert.equal(assistantD2BindingIntentModel(bindingIntent).placements[0].businessBlockId, 'block-external');
  assert.deepEqual(bindingIntent.placements[0].endpointFields, ['{ISZabbixMonitoringDomain:ipRange}.range']);
  assert.equal(bindingIntent.connections[0].sourceOperator, 'ipv4InCidr');
  assert.equal(bindingIntent.connections[0].targetOperator, 'equals');

  const topology = assistantDiagramTopologyWithBindingIntent([{
    d2ElementKey: 'edge-external', d2ClassKey: 'acl_external',
    networkEndpointStages: stages.slice(2).map((stage) => ({
      candidateId: `candidate:${stage.id}`, sourceStageId: stage.id, sourceField: 'ipaddress', targetField: 'dipaddress',
      stageRole: stage.stageRole, businessBlockIds: stage.assistantBlockIds, outputKind: stage.outputKind, rowGrain: stage.rowGrain
    })),
    relationCardStages: [], deterministicEndpointStages: []
  }], bindingIntent);
  assert.deepEqual(topology[0].networkEndpointStages.map((candidate) => candidate.sourceStageId), ['match:acl-terminal']);

  const badDraft = {
    items: [{
      structureItemId: 'placement-external', roleId: 'role-external', source: { stageId: 'selection:external-source' },
      mapping: { materialization: { kind: 'stage', stageId: 'selection:external-source' }, conditions: { rules: [] }, hierarchyConditions: { rules: [] } }
    }],
    relationRules: [{ d2ClassKey: 'acl_external', sourceStageId: 'match:acl-helper', mode: 'attributeEndpoints', sourceField: 'ipaddress', targetField: 'dipaddress' }]
  };
  const badMatrix = assistantDiagramSemanticObligations({ placements, stages, bindingIntent }, badDraft);
  assert.ok(badMatrix.obligations.some((item) => item.family === 'placementBusinessResult' && item.status === 'unsatisfied'));
  assert.ok(badMatrix.obligations.some((item) => item.family === 'placementCondition' && item.status === 'unsatisfied'));
  assert.ok(badMatrix.obligations.some((item) => item.family === 'connectionBusinessResult' && item.status === 'unsatisfied'));

  const goodDraft = {
    items: [{
      structureItemId: 'placement-external', roleId: 'role-external', source: { stageId: 'match:external-terminal' },
      mapping: {
        materialization: { kind: 'stage', stageId: 'match:external-terminal' },
        primary: {
          className: 'IS',
          cardSource: { id: 'current', label: 'Карточка результата', className: 'IS', classColumn: 'Class', idColumn: '_id' }
        },
        conditions: { rules: [{ operator: 'equals', left: { column: 'isExt' }, right: { kind: 'literal', value: true } }] },
        hierarchyConditions: { rules: [] }
      }
    }],
    relationRules: [{
      d2ClassKey: 'acl_external', sourceStageId: 'match:acl-terminal', mode: 'attributeEndpoints',
      sourceField: 'ipaddress', sourceOperator: 'ipv4InCidr', targetField: 'dipaddress', targetOperator: 'equals'
    }]
  };
  goodDraft.endpointProfiles = assistantDiagramEndpointProfilesFromBindings({ placements }, goodDraft.items);
  assert.equal(goodDraft.endpointProfiles.length, 1);
  assert.equal(goodDraft.endpointProfiles[0].field, '{ISZabbixMonitoringDomain:ipRange}.range');
  assert.deepEqual(goodDraft.endpointProfiles[0].operators, ['ipv4InCidr']);
  assert.equal(goodDraft.endpointProfiles[0].source.className, 'IS');
  const goodMatrix = assistantDiagramSemanticObligations({ placements, stages, bindingIntent }, goodDraft);
  assert.ok(goodMatrix.obligations.length > 0);
  assert.ok(goodMatrix.obligations.every((item) => item.status === 'satisfied'), JSON.stringify(goodMatrix.obligations));
  assert.equal(assistantSemanticObligationModel(goodMatrix).status, 'satisfied');
  assert.equal(assistantD2CritiqueModel({ approved: true, violations: [] }).approved, true);
});

test('BusinessBlockManifest v2 never selects one of several terminal results implicitly', () => {
  const manifest = assistantObjectFlowBusinessBlockManifest({
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: {
          context: 'Network inventory.',
          blocks: [{
            id: 'block-systems',
            name: 'Внутренние ИС',
            description: 'Выбрать внутренние информационные системы.',
            resultKind: 'sourceCards',
            dependsOn: []
          }]
        }
      }
    }
  }, [{
    id: 'selection:systems-a', alias: 'systems_a', className: 'IS', stageRole: 'terminal',
    outputKind: 'sourceCards', assistantBlockIds: ['block-systems']
  }, {
    id: 'selection:systems-b', alias: 'systems_b', className: 'IS', stageRole: 'terminal',
    outputKind: 'sourceCards', assistantBlockIds: ['block-systems']
  }]);

  assert.equal(manifest.version, 2);
  assert.equal(manifest.blocks[0].status, 'ambiguous');
  assert.equal(manifest.blocks[0].terminalStageId, '');
  assert.equal(manifest.blocks[0].terminalAlias, '');
  assert.equal(manifest.blocks[0].terminalContract, null);
  assert.deepEqual(manifest.blocks[0].terminalCandidateStageIds.sort(), ['selection:systems-a', 'selection:systems-b']);
  assert.deepEqual(manifest.blocks[0].helperStageIds, []);
});

test('legacy Assistant output ownership recovers one terminal per block from the dependency graph', () => {
  const spec = {
    visualModels: [{
      mode: 'objectMatching',
      assistantOutputManifest: { version: 1, blocks: [{ id: 'block-systems', name: 'Внутренние ИС', order: 1 }] },
      selections: [{ id: 'selection:source', alias: 'systems_source', className: 'IS', columns: ['_id', 'Description'] }],
      operations: [{
        id: 'relation:systems', type: 'relation', from: 'systems_source', as: 'systems',
        domain: 'SystemRelation', targetClass: 'IS', direction: 'source', columns: ['_id', 'Description']
      }],
      outputs: [{
        alias: 'systems_source', label: 'Внутренние ИС: Выборка 1', kind: 'selection', assistantManaged: true,
        assistantBlockId: 'block-systems', assistantBlockIds: ['block-systems']
      }, {
        alias: 'systems', label: 'Внутренние ИС: Соединение 1', kind: 'relation', assistantManaged: true,
        assistantBlockId: 'block-systems', assistantBlockIds: ['block-systems']
      }]
    }],
    authoring: { version: 1, assistant: { objectFlowIntent: { context: '', blocks: [{ id: 'block-systems', name: 'Внутренние ИС', description: 'Внутренние системы.', resultKind: 'sourceCards', uses: [] }] } } }
  };
  const stages = assistantObjectFlowDiagramStages(spec);
  assert.equal(stages.find((stage) => stage.alias === 'systems_source').stageRole, 'helper');
  assert.equal(stages.find((stage) => stage.alias === 'systems').stageRole, 'terminal');
});

test('explicit Assistant helper ownership never falls back to a terminal', () => {
  const spec = {
    visualModels: [{
      mode: 'objectMatching',
      assistantOutputManifest: { version: 1, blocks: [{ id: 'block-systems', name: 'Внутренние ИС', order: 1 }] },
      selections: [{ id: 'selection:systems', alias: 'systems', className: 'IS', columns: ['_id'] }],
      outputs: [{
        alias: 'systems', label: 'Внутренние ИС', kind: 'selection', assistantManaged: true,
        assistantBlockId: 'block-systems', assistantBlockIds: ['block-systems'], assistantStageRole: 'helper'
      }]
    }],
    authoring: { version: 1, assistant: { objectFlowIntent: { context: '', blocks: [{ id: 'block-systems', name: 'Внутренние ИС', description: 'Внутренние системы.', resultKind: 'sourceCards', uses: [] }] } } }
  };
  const stages = assistantObjectFlowDiagramStages(spec);
  const manifest = assistantObjectFlowBusinessBlockManifest(spec, stages);
  assert.equal(stages[0].stageRole, 'helper');
  assert.equal(manifest.blocks[0].status, 'missing');
  assert.deepEqual(manifest.blocks[0].terminalCandidateStageIds, []);
});

test('legacy Assistant terminal is selected by graph sink rather than a matching upstream label', () => {
  const spec = {
    visualModels: [{
      mode: 'objectMatching',
      assistantOutputManifest: { version: 1, blocks: [{ id: 'block-systems', name: 'Внутренние ИС', order: 1 }] },
      selections: [{ id: 'selection:source', alias: 'systems_source', className: 'IS', columns: ['_id'] }],
      operations: [{
        id: 'relation:systems', type: 'relation', from: 'systems_source', as: 'systems',
        domain: 'SystemRelation', targetClass: 'IS', direction: 'source', columns: ['_id']
      }],
      outputs: [{
        alias: 'systems_source', label: 'Внутренние ИС', kind: 'selection', assistantManaged: true,
        assistantBlockId: 'block-systems', assistantBlockIds: ['block-systems']
      }, {
        alias: 'systems', label: 'Внутренние ИС: Соединение 1', kind: 'relation', assistantManaged: true,
        assistantBlockId: 'block-systems', assistantBlockIds: ['block-systems']
      }]
    }],
    authoring: { version: 1, assistant: { objectFlowIntent: { context: '', blocks: [{ id: 'block-systems', name: 'Внутренние ИС', description: 'Внутренние системы.', resultKind: 'sourceCards', uses: [] }] } } }
  };
  const stages = assistantObjectFlowDiagramStages(spec);
  assert.equal(stages.find((stage) => stage.alias === 'systems_source').stageRole, 'helper');
  assert.equal(stages.find((stage) => stage.alias === 'systems').stageRole, 'terminal');
});

test('legacy Assistant terminal remains terminal when a later business block consumes it', () => {
  const spec = {
    visualModels: [{
      mode: 'objectMatching',
      assistantOutputManifest: {
        version: 1,
        blocks: [
          { id: 'block-systems', name: 'Внутренние ИС', order: 1 },
          { id: 'block-ranges', name: 'Сети внутренних ИС', order: 2 }
        ]
      },
      selections: [{ id: 'selection:systems', alias: 'systems', className: 'IS', columns: ['_id', 'Description'] }],
      operations: [{
        id: 'relation:ranges', type: 'relation', from: 'systems', as: 'ranges',
        domain: 'SystemRange', targetClass: 'ipRange', direction: 'source', columns: ['_id', 'range']
      }],
      outputs: [{
        alias: 'systems', label: 'Внутренние ИС', kind: 'selection', assistantManaged: true,
        assistantBlockId: 'block-systems', assistantBlockIds: ['block-systems']
      }, {
        alias: 'ranges', label: 'Сети внутренних ИС', kind: 'relation', assistantManaged: true,
        assistantBlockId: 'block-ranges', assistantBlockIds: ['block-ranges']
      }]
    }],
    authoring: {
      version: 1,
      assistant: {
        objectFlowIntent: {
          context: '',
          blocks: [
            { id: 'block-systems', name: 'Внутренние ИС', description: 'Внутренние системы.', resultKind: 'sourceCards', uses: [] },
            { id: 'block-ranges', name: 'Сети внутренних ИС', description: 'Связанные сети.', resultKind: 'relatedCards', uses: ['block-systems'] }
          ]
        }
      }
    }
  };
  const stages = assistantObjectFlowDiagramStages(spec);
  assert.equal(stages.find((stage) => stage.alias === 'systems').stageRole, 'terminal');
  assert.equal(stages.find((stage) => stage.alias === 'ranges').stageRole, 'terminal');
});

test('binding-intent adapter enforces deterministic Notes constraints and removes exact duplicates', () => {
  const manifest = assistantObjectFlowBusinessBlockManifest({
    authoring: { version: 1, assistant: { objectFlowIntent: { context: '', blocks: [{ id: 'block-external', name: 'Внешние ИС', description: 'Внешние системы.', resultKind: 'sourceCards', uses: [] }] } } }
  }, [{
    id: 'match:external', alias: 'external', className: 'IS', stageRole: 'terminal', outputKind: 'sourceCards',
    assistantBlockIds: ['block-external']
  }]);
  const input = {
    businessBlockManifest: manifest,
    placements: [{
      structureItemId: 'placement-group', displayName: 'group_external', templateStatic: false,
      materializationHint: 'structural', allowedMaterialization: ['structural'], directives: {}, notes: 'Статическая рамка.'
    }],
    relationRules: [{ d2ClassKey: 'acl_external', d2Notes: 'binding-result: Внешние ИС\nstage-policy: terminal-only' }]
  };
  const normalized = normalizeAssistantDiagramBindingIntentResponse(input, {
    placementBindings: [{ structureItemId: 'placement-group', materializationIntent: 'stage', businessBlockId: 'block-external' }, {
      structureItemId: 'placement-group', materializationIntent: 'stage', businessBlockId: 'block-external'
    }],
    connectionBindings: [{ d2ClassKey: 'acl_external', businessBlockId: 'invented' }],
    unresolved: [], warnings: []
  });
  assert.deepEqual(normalized.placementBindings, [{
    structureItemId: 'placement-group',
    materializationIntent: 'structural',
    membership: 'structural',
    requiredConditions: [],
    requiredMembership: [],
    endpointFields: [],
    endpointOperators: []
  }]);
  assert.equal(normalized.connectionBindings[0].businessBlockId, 'block-external');
  assert.match(normalized.warnings[0], /exact duplicate/);
});

test('binding-intent seed keeps deterministic Notes bindings while requesting natural-language enrichment', () => {
  const businessBlockManifest = assistantObjectFlowBusinessBlockManifest({
    authoring: { version: 1, assistant: { objectFlowIntent: { context: '', blocks: [{ id: 'block-vlan', name: 'VLAN', description: 'VLAN cards.', resultKind: 'sourceCards', uses: [] }] } } }
  }, [{
    id: 'selection:vlan', alias: 'vlan', className: 'vlan', stageRole: 'terminal', outputKind: 'sourceCards',
    assistantBlockIds: ['block-vlan']
  }]);
  const seed = assistantDiagramBindingIntentSeed({
    businessBlockManifest,
    placements: [{
      structureItemId: 'scope-vlan', templateStatic: false, materializationHint: 'stage', allowedMaterialization: ['stage'],
      directives: { 'binding-result': 'VLAN', 'stage-policy': 'terminal-only', 'required-condition': ['isNAT equals true'] },
      notes: 'binding-result: VLAN\nrequired-condition: isNAT equals true\nПовторить контейнер для каждой VLAN.'
    }],
    relationRules: []
  });
  assert.deepEqual(seed.placementBindings, [{
    structureItemId: 'scope-vlan', materializationIntent: 'stage', businessBlockId: 'block-vlan'
  }]);
  assert.deepEqual(seed.pendingPlacementIds, ['scope-vlan']);
});

test('placement adapter compiles fixed binding intent and typed conditions without repeating LLM choices', () => {
  const input = {
    placements: [{
      structureItemId: 'group', roleId: 'role-group', displayName: 'group', visualKind: 'container', templateStatic: false,
      allowedMaterialization: ['structural'], currentMapping: {}
    }, {
      structureItemId: 'scope-vlan', roleId: 'role-vlan', displayName: 'scope_vlan', visualKind: 'container', templateStatic: false,
      allowedMaterialization: ['stage'], currentMapping: {}
    }],
    stages: [{
      id: 'selection:vlan', alias: 'vlan', kind: 'selection', className: 'vlan', columns: ['_id', 'isNAT'],
      assistantBlockIds: ['block-vlan'], stageRole: 'terminal', cardSources: [{ id: 'current', className: 'vlan', classColumn: 'Class', idColumn: '_id' }]
    }],
    bindingIntent: {
      placements: [{ structureItemId: 'group', materializationIntent: 'structural', membership: 'structural' }, {
        structureItemId: 'scope-vlan', materializationIntent: 'stage', businessBlockId: 'block-vlan', stagePolicy: 'terminal-only',
        requiredConditions: ['isNAT equals true', 'isNAT equals ${param.isNat}']
      }]
    }
  };
  const draft = assistantDiagramPlacementDraftFromResponse(input, {
    mappings: [{ structureItemId: 'group', materialization: 'stage', stageId: 'invented' }, {
      structureItemId: 'scope-vlan', materialization: 'stage', stageId: 'invented'
    }],
    unresolved: []
  });
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.equal(draft.items.find((item) => item.structureItemId === 'group').mapping.materialization.kind, 'structural');
  const vlan = draft.items.find((item) => item.structureItemId === 'scope-vlan');
  assert.equal(vlan.mapping.materialization.stageId, 'selection:vlan');
  assert.equal(vlan.mapping.conditions.rules.length, 2);
  assert.equal(vlan.mapping.conditions.rules[0].right.kind, 'literal');
  assert.equal(vlan.mapping.conditions.rules[1].right.kind, 'param');
  assert.equal(vlan.mapping.conditions.rules[1].right.name, 'isNat');
});

test('natural D2 Notes require typed binding interpretation while machine-only directives remain deterministic', () => {
  assert.equal(assistantDiagramNotesHasNaturalLanguage([
    'binding-result: Внешние ИС',
    'stage-policy: terminal-only',
    'endpoint-field: ipRange.range',
    'endpoint-operator: ipv4InCidr'
  ].join('\n')), false);
  assert.equal(assistantDiagramNotesHasNaturalLanguage([
    'binding-result: Внешние ИС',
    'Размещать только системы, адреса которых входят в сети выбранного результата.'
  ].join('\n')), true);
});

test('D2 mapping coverage stays partial until mapped attribute connections have executable endpoint profiles', () => {
  const input = {
    roles: [{ id: 'role-application', visualKind: 'node' }],
    placements: [{ structureItemId: 'application-a', roleId: 'role-application', visualKind: 'node', templateStatic: false }],
    topology: [{ d2ElementKey: 'edge-acl', d2ClassKey: 'acl_internal', label: 'ACL internal' }]
  };
  const items = [{ structureItemId: 'application-a', roleId: 'role-application' }];
  const relationRules = [{
    d2ElementKey: 'edge-acl', d2ClassKey: 'acl_internal', mode: 'attributeEndpoints', directionPolicy: 'dataFields',
    sourceStageId: 'selection:acl', sourceField: 'ipaddress', sourceOperator: 'equals',
    targetField: 'dipaddress', targetOperator: 'equals'
  }];
  const partial = assistantDiagramMappingCoverage(input, items, [], relationRules, [], []);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.mappedConnections, 0);
  assert.match(partial.unresolved[0].message, /endpoint comparison rules are incomplete/);

  const complete = assistantDiagramMappingCoverage(input, items, [], relationRules, [], [{
    id: 'application-address', structureItemId: 'application-a', roleId: 'role-application', field: 'ipaddress.ipAddr', operators: ['equals']
  }]);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.mappedConnections, 1);
  assert.deepEqual(complete.unresolved, []);
});

test('D2 placement materialization hints narrow role defaults and allow placement overrides', () => {
  const { proposal } = d2StructureTreeFixture();
  const scopeRole = proposal.roles.find((role) => role.key === 'scope-vlan');
  const vlanRole = proposal.roles.find((role) => role.key === 'vlan');
  assert.ok(scopeRole && vlanRole);

  scopeRole.notes = 'materialization: stage\nDynamic frame.';
  vlanRole.notes = 'materialization: stage\nDynamic node.';
  const vlanItem = proposal.structureTree.items.find((item) => String(item.roleId) === String(vlanRole.id));
  assert.ok(vlanItem);
  const vlanElement = proposal.structure.nodes.find((item) => String(item.key) === String(vlanItem.templateElementKey));
  assert.ok(vlanElement);
  vlanElement.notes = 'materialization: parentCard\nUse the nearest materialized ancestor.';

  const targets = assistantDiagramPlacementTargets(proposal, [], { classes: [] });
  const scopeTarget = targets.find((target) => String(target.roleId) === String(scopeRole.id));
  const vlanTarget = targets.find((target) => String(target.structureItemId) === String(vlanItem.id));
  assert.deepEqual(scopeTarget.allowedMaterialization, ['stage']);
  assert.equal(scopeTarget.materializationHint, 'stage');
  assert.deepEqual(vlanTarget.allowedMaterialization, ['parentCard']);
  assert.equal(vlanTarget.materializationHint, 'parentCard');

  const structuralModel = assistantD2StructuralModel(proposal.roles, targets, proposal.relationRules);
  const modeledVlan = structuralModel.placements.find((placement) => placement.structureItemId === vlanTarget.structureItemId);
  assert.equal(modeledVlan.materializationHint, 'parentCard');
  assert.deepEqual(modeledVlan.allowedMaterialization, ['parentCard']);
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
