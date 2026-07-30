import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileObjectFlowToSpec,
  normalizeObjectFlow,
  objectFlowResultOutputs,
  objectFlowStageSummaries,
  validateObjectFlow
} from '../../scripts/assistant-object-flow.mjs';
import {
  assistantObjectFlowMessages,
  assistantDiagramAttachRelatedNetworkStages,
  assistantObjectFlowCandidate,
  assistantIpv4MatchRequirements,
  assistantMatchRequirementsErrors,
  assistantRelationRequirements,
  assistantRelationRequirementsErrors,
  assistantObjectFlowIncompleteFieldErrors,
  assistantResultContractErrors,
  assistantRestoreObjectFlowSelectionClasses,
  assistantObjectFlowValidationFeedback,
  assistantSemanticPlanValidationFeedback,
  validateTemplateSpec
} from '../../scripts/dev-proxy-server.mjs';

test('result contract validation uses deterministic bindings across relation predicates and candidate filters', () => {
  const intent = {
    context: '',
    blocks: [
      { id: 'all-acl', name: 'Все ACL', entities: 'ACL', algorithm: 'Выбрать ACL.', expectedResult: 'Список ACL.', uses: [] },
      { id: 'external-systems', name: 'Внешние ИС', entities: 'IS, ipRange, ACL', algorithm: 'Оставить IS, чьи связанные ipRange содержат адреса Все ACL.', expectedResult: 'Список IS.', uses: ['all-acl'] },
      { id: 'external-acl', name: 'ACL внешних ИС', entities: 'Все ACL, Внешние ИС', algorithm: 'Из Все ACL оставить адреса в сетях Внешние ИС.', expectedResult: 'Список ACL.', uses: ['all-acl', 'external-systems'] }
    ]
  };
  const relationPredicate = {
    sourceClass: 'IS', relatedClass: 'ipRange', comparisonBlockId: 'all-acl', comparisonClass: 'ACL',
    domain: 'ISZabbixMonitoringDomain', direction: 'source', comparisonFields: ['dipaddress', 'ipaddress'], relatedField: 'range', operator: 'ipv4InCidr'
  };
  const candidateFilter = {
    candidateBlockId: 'all-acl', candidateClass: 'ACL',
    comparisonSource: { kind: 'block', blockId: 'external-systems', className: 'IS', rules: [] },
    comparisonPath: [{ sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', direction: 'source', targetClass: 'ipRange' }],
    comparisonTerminalClass: 'ipRange', ruleJoin: 'any',
    rules: [
      { candidateField: 'dipaddress', comparisonField: 'range', operator: 'ipv4InCidr' },
      { candidateField: 'ipaddress', comparisonField: 'range', operator: 'ipv4InCidr' }
    ]
  };
  const semanticPlan = {
    version: 1,
    blocks: [
      { id: 'all-acl', name: 'Все ACL', expectedResult: 'Список ACL.', resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', candidateFilter: null, dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] } },
      { id: 'external-systems', name: 'Внешние ИС', expectedResult: 'Список IS.', resultContract: { outputKind: 'sourceCards', outputClass: 'IS', candidateFilter: null, dependencyPaths: [], relationPredicates: [relationPredicate], attributePredicates: [], referencePathPredicates: [] } },
      { id: 'external-acl', name: 'ACL внешних ИС', expectedResult: 'Список ACL.', resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', candidateFilter, dependencyPaths: [], relationPredicates: [], attributePredicates: [], referencePathPredicates: [] } }
    ]
  };
  const flow = normalizeObjectFlow({
    version: 1,
    selections: [
      { id: 'selection:allAcl', name: 'Все ACL', alias: 'allAcl', className: 'ACL', columns: ['ipaddress', 'dipaddress'], rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }] },
      { id: 'selection:externalIsSource', name: 'Внешние ИС (source)', alias: 'externalIsSource', className: 'IS', rules: [{ action: 'include', path: 'isExt', op: 'equals', value: 'true' }] }
    ],
    operations: [
      { id: 'existsRelated:externalSystems', type: 'existsRelated', from: 'externalIsSource', with: 'allAcl', as: 'externalSystems', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source', columns: ['range'], rules: [
        { action: 'include', operator: 'ipv4InCidr', leftColumn: 'dipaddress', rightColumn: 'range' },
        { action: 'include', operator: 'ipv4InCidr', leftColumn: 'ipaddress', rightColumn: 'range' }
      ] },
      { id: 'relation:externalRanges', type: 'relation', from: 'externalSystems', as: 'externalRanges', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source', columns: ['range'] },
      { id: 'semiJoin:externalAcl', type: 'semiJoin', from: 'allAcl', with: 'externalRanges', as: 'externalAcl', ruleJoin: 'any', rules: [
        { action: 'include', operator: 'ipv4InCidr', leftColumn: 'dipaddress', rightColumn: 'range' },
        { action: 'include', operator: 'ipv4InCidr', leftColumn: 'ipaddress', rightColumn: 'range' }
      ] }
    ],
    publishedAlias: 'externalAcl'
  });

  assert.deepEqual(assistantResultContractErrors(flow, semanticPlan, intent, [
    { blockId: 'all-acl', alias: 'allAcl' },
    { blockId: 'external-systems', alias: 'externalSystems' },
    { blockId: 'external-acl', alias: 'externalAcl' }
  ]), []);
});

function validFlow() {
  return {
    version: 1,
    selections: [
      {
        alias: 'routers',
        name: 'Routers',
        className: 'Router',
        limit: 50,
        columns: ['Code', 'Location'],
        rules: [
          { action: 'include', path: 'Status', op: 'equals', value: 'active' }
        ]
      },
      {
        alias: 'rooms',
        name: 'Rooms',
        className: 'Room',
        rules: [
          { action: 'include', path: 'Code', op: 'matches', regex: '^DC-' }
        ]
      },
      {
        alias: 'vlans',
        name: 'VLANs',
        className: 'Vlan',
        rules: [
          { action: 'exclude', path: 'Status', op: 'equals', value: 'retired' }
        ]
      }
    ],
    operations: [
      {
        type: 'match',
        from: 'routers',
        with: 'rooms',
        as: 'routerRooms',
        rightPrefix: 'Rooms.',
        rules: [
          {
            action: 'include',
            operator: 'equals',
            leftColumn: 'Location',
            rightColumn: 'Code'
          }
        ]
      },
      {
        type: 'match',
        from: 'routerRooms',
        with: 'vlans',
        as: 'routerRoomVlans',
        rightPrefix: 'Vlans.',
        rules: [
          {
            action: 'exclude',
            negate: true,
            operator: 'ipv4CidrOverlaps',
            leftColumn: 'Rooms.Code',
            leftRegex: '(.+)',
            rightColumn: 'Location',
            rightRegex: '(.+)'
          }
        ]
      }
    ]
  };
}

function semiJoinFlow(ruleJoin) {
  return {
    version: 1,
    selections: [{
      alias: 'assets',
      name: 'Assets',
      className: 'Asset',
      columns: ['Location', 'Owner'],
      rules: [{ action: 'include', path: 'Code', op: 'exists' }]
    }, {
      alias: 'policies',
      name: 'Policies',
      className: 'Policy',
      columns: ['Site', 'Scope'],
      rules: [{ action: 'include', path: 'Code', op: 'exists' }]
    }],
    operations: [{
      type: 'semiJoin',
      from: 'assets',
      with: 'policies',
      as: 'eligibleAssets',
      ruleJoin,
      rules: [
        { action: 'include', operator: 'equals', leftColumn: 'Location', rightColumn: 'Site' },
        { action: 'include', operator: 'contains', leftColumn: 'Owner', rightColumn: 'Scope' }
      ]
    }],
    publishedAlias: 'eligibleAssets'
  };
}

test('normalizeObjectFlow derives stable ids without mutating the input', () => {
  const input = validFlow();
  const normalized = normalizeObjectFlow(input);

  assert.equal(normalized.version, 1);
  assert.deepEqual(normalized.selections.map((selection) => selection.id), [
    'selection:routers',
    'selection:rooms',
    'selection:vlans'
  ]);
  assert.deepEqual(normalized.operations.map((operation) => operation.id), [
    'match:routerRooms',
    'match:routerRoomVlans'
  ]);
  assert.equal(normalized.selections[1].limit, 100);
  assert.equal(input.selections[0].id, undefined);
  assert.equal(input.operations[0].id, undefined);

  const explicit = normalizeObjectFlow({
    version: 1,
    selections: [{
      id: 'selection:kept',
      alias: 'objects',
      className: 'Asset',
      rules: [{ action: 'include', path: 'Code', op: 'exists' }]
    }],
    blocks: []
  });
  assert.equal(explicit.selections[0].id, 'selection:kept');
});

test('validateObjectFlow accepts explicit operations and selection-only flows', () => {
  assert.deepEqual(validateObjectFlow(validFlow()), []);
  assert.deepEqual(validateObjectFlow({
    version: 1,
    selections: [{
      alias: 'objects',
      className: 'Asset',
      rules: [{ action: 'include', path: 'Code', op: 'exists' }]
    }],
    blocks: []
  }), []);
  assert.deepEqual(validateObjectFlow({
    version: 1,
    selections: [{
      id: 'selection:objects',
      alias: 'renamedObjects',
      className: 'Asset',
      rules: [{ action: 'include', path: 'Code', op: 'exists' }]
    }],
    blocks: []
  }), []);
});

test('validateObjectFlow reports ids, aliases, operation references, actions, and operators', () => {
  const flow = normalizeObjectFlow(validFlow());
  flow.selections[1].id = flow.selections[0].id;
  flow.selections[1].alias = flow.selections[0].alias;
  flow.selections[1].rules[0].action = 'maybe';
  flow.selections[1].rules[0].op = 'unsupported';
  flow.operations[0].from = 'wrong';
  flow.operations[0].with = 'wrong';
  flow.operations[0].rules = [];
  flow.operations[1].from = 'wrong';
  flow.operations[1].rules[0].operator = 'unsupported';

  const errors = validateObjectFlow(flow);
  const paths = errors.map((error) => error.path);

  assert.ok(paths.includes('$.selections[1].id'));
  assert.ok(paths.includes('$.selections[1].alias'));
  assert.ok(paths.includes('$.selections[1].rules[0].action'));
  assert.ok(paths.includes('$.selections[1].rules[0].op'));
  assert.ok(paths.includes('$.operations[0].from'));
  assert.ok(paths.includes('$.operations[0].with'));
  assert.ok(paths.includes('$.operations[0].rules'));
  assert.ok(paths.includes('$.operations[1].from'));
  assert.ok(paths.includes('$.operations[1].rules[0].operator'));
});

test('semiJoin normalization preserves canonical operations for any and all rule joins', () => {
  for (const ruleJoin of ['any', 'all']) {
    const normalized = normalizeObjectFlow(semiJoinFlow(ruleJoin));
    const operation = normalized.operations[0];

    assert.equal(operation.id, 'semiJoin:eligibleAssets');
    assert.equal(operation.type, 'semiJoin');
    assert.equal(operation.ruleJoin, ruleJoin);
    assert.equal(operation.rules.length, 2);
    assert.deepEqual(normalized.blocks, []);
    assert.deepEqual(normalized.setOperations, []);
    assert.deepEqual(validateObjectFlow(normalized), []);
  }
});

test('validateObjectFlow enforces the semiJoin id, aliases, rule join, rules, operators, and columns', () => {
  const invalid = semiJoinFlow('some');
  invalid.operations[0].id = 'match:eligibleAssets';
  invalid.operations[0].from = 'missingLeft';
  invalid.operations[0].with = 'missingRight';
  invalid.operations[0].as = 'assets';
  invalid.operations[0].rules = [];

  const invalidPaths = validateObjectFlow(invalid).map((error) => error.path);
  assert.ok(invalidPaths.includes('$.operations[0].id'));
  assert.ok(invalidPaths.includes('$.operations[0].from'));
  assert.ok(invalidPaths.includes('$.operations[0].with'));
  assert.ok(invalidPaths.includes('$.operations[0].as'));
  assert.ok(invalidPaths.includes('$.operations[0].ruleJoin'));
  assert.ok(invalidPaths.includes('$.operations[0].rules'));

  const invalidRule = validFlow();
  invalidRule.operations.push({
    id: 'semiJoin:invalidColumns',
    type: 'semiJoin',
    from: 'routerRooms',
    with: 'routerRoomVlans',
    as: 'invalidColumns',
    ruleJoin: 'all',
    rules: [{ action: 'include', operator: 'unsupported', leftColumn: 'MissingLeft', rightColumn: 'MissingRight' }]
  });
  const invalidRulePaths = validateObjectFlow(invalidRule).map((error) => error.path);
  assert.ok(invalidRulePaths.includes('$.operations[2].rules[0].operator'));
  assert.ok(invalidRulePaths.includes('$.operations[2].rules[0].leftColumn'));
  assert.ok(invalidRulePaths.includes('$.operations[2].rules[0].rightColumn'));
});

test('semiJoin compiles any and all rule joins while preserving exactly the left columns', () => {
  for (const ruleJoin of ['any', 'all']) {
    const flow = semiJoinFlow(ruleJoin);
    const normalized = normalizeObjectFlow(flow);
    const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
    const step = compiled.steps.find((item) => item.as === 'eligibleAssets');
    const leftColumns = objectFlowStageSummaries(normalized).find((item) => item.alias === 'assets').columns;
    const summary = objectFlowStageSummaries(normalized).find((item) => item.alias === 'eligibleAssets');
    const table = compiled.result.tables.find((item) => item.name === 'eligibleAssets');
    const visualOperation = compiled.visualModels
      .find((model) => model.mode === 'objectMatching')
      .operations.find((operation) => operation.as === 'eligibleAssets');

    assert.deepEqual(step, {
      type: 'semiJoinRows',
      purpose: 'objectMatching',
      from: 'assets',
      with: 'policies',
      rules: [{
        action: 'include', negate: false, operator: 'equals',
        left: { column: 'Location', regex: '' }, right: { column: 'Site', regex: '' }
      }, {
        action: 'include', negate: false, operator: 'contains',
        left: { column: 'Owner', regex: '' }, right: { column: 'Scope', regex: '' }
      }],
      ruleJoin,
      caseSensitive: false,
      as: 'eligibleAssets'
    });
    assert.deepEqual(summary.columns, leftColumns);
    assert.equal(summary.kind, 'semiJoin');
    assert.equal(summary.ruleJoin, ruleJoin);
    assert.deepEqual(table.columns, leftColumns);
    assert.equal(table.columns.includes('Site'), false);
    assert.equal(table.columns.includes('Scope'), false);
    assert.equal(visualOperation.type, 'semiJoin');
    assert.equal(visualOperation.ruleJoin, ruleJoin);
    assert.equal(objectFlowResultOutputs(normalized).at(-1).kind, 'semiJoin');
  }
});

test('validateObjectFlow accepts independent selections without a match operation', () => {
  const flow = validFlow();
  flow.operations = [];

  assert.deepEqual(validateObjectFlow(flow), []);
});

test('object flow compiles a typed domain relation without inventing a match attribute', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:informationSystems',
      name: 'Information systems',
      alias: 'informationSystems',
      className: 'IS',
      limit: 1,
      columns: ['Name'],
      rules: [{ action: 'include', path: 'Name', op: 'equals', valueParam: 'isName' }]
    }],
    operations: [{
      id: 'relation:ipRanges',
      type: 'relation',
      from: 'informationSystems',
      as: 'ipRanges',
      domain: 'ISZabbixMonitoringDomain',
      targetClass: 'ipRange',
      direction: 'source',
      columns: ['range'],
      limit: 100,
      distinct: true
    }],
    publishedAlias: 'ipRanges'
  };

  assert.deepEqual(validateObjectFlow(flow), []);
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  const relation = compiled.steps.find((step) => step.type === 'expandRelations');
  assert.deepEqual(relation, {
    type: 'expandRelations',
    purpose: 'objectMatching',
    from: 'informationSystems',
    domain: 'ISZabbixMonitoringDomain',
    targetClass: 'ipRange',
    direction: 'source',
    columns: ['range'],
    limit: 100,
    distinct: true,
    as: 'ipRanges'
  });
  assert.equal(compiled.result.tables.find((table) => table.name === 'ipRanges').published, undefined);
  assert.equal(compiled.result.tables.find((table) => table.name === 'ipRanges').columns.includes('range'), true);
  assert.equal(compiled.steps.some((step) => step.type === 'matchRows'), false);
});

test('object flow schedules a source-driven IPv4 selection after its relation output', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:informationSystems', name: 'Information systems', alias: 'informationSystems', className: 'IS', limit: 1, columns: ['Name'],
      rules: [{ action: 'include', path: 'Name', op: 'equals', valueParam: 'isName' }]
    }, {
      id: 'selection:aclsInRanges', name: 'ACL in selected ranges', alias: 'aclsInRanges', className: 'ACL', from: 'ipRanges', limit: 100,
      columns: ['ipaddress', 'dipaddress'],
      rules: [
        { action: 'include', path: 'ipaddress', op: 'ipv4InCidr', valueColumn: 'range' },
        { action: 'include', path: 'dipaddress', op: 'ipv4InCidr', valueColumn: 'range' }
      ]
    }],
    operations: [{
      id: 'relation:ipRanges', type: 'relation', from: 'informationSystems', as: 'ipRanges', domain: 'ISZabbixMonitoringDomain',
      targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true
    }],
    publishedAlias: 'aclsInRanges'
  };

  assert.deepEqual(validateObjectFlow(flow), []);
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  assert.deepEqual(compiled.steps.map((step) => [step.type, step.as]), [
    ['selectCards', 'informationSystems'],
    ['expandRelations', 'ipRanges'],
    ['selectCards', 'aclsInRanges']
  ]);
  const acls = compiled.steps.at(-1);
  assert.equal(acls.from, 'ipRanges');
  assert.equal(acls.filterJoin, 'any');
  assert.deepEqual(acls.filters.map((filter) => [filter.scope, filter.path, filter.op, filter.valueExpression]), [
    ['include', 'ipaddress', 'ipv4InCidr', '${previous.range}'],
    ['include', 'dipaddress', 'ipv4InCidr', '${previous.range}']
  ]);
});

test('object flow compiles parameter and previous-result expressions as deterministic filters', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:systems', name: 'Systems', alias: 'systems', className: 'IS', limit: 10, columns: [],
      rules: [{ action: 'include', path: 'Name', op: 'equals', rightExpression: '${param.isName}' }]
    }, {
      id: 'selection:servers', name: 'Servers', alias: 'servers', className: 'Server', from: 'systems', limit: 100, columns: ['Code'],
      rules: [{ action: 'include', path: 'Code', op: 'matches', rightExpression: '^${previous.Name}-[0-9]+$' }]
    }],
    operations: [],
    publishedAlias: 'servers'
  };

  assert.deepEqual(validateObjectFlow(flow), []);
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  assert.equal(compiled.steps[0].filters[0].valueExpression, '${param.isName}');
  assert.equal(compiled.steps[1].filters[0].regexExpression, '^${previous.Name}-[0-9]+$');
  assert.ok(compiled.steps[0].columns.some((column) => column.path === 'Name'));
});

test('object flow rejects a previous-result expression without a selected source', () => {
  const flow = validFlow();
  flow.selections[0].rules = [{ action: 'include', path: 'Status', op: 'equals', rightExpression: '${previous.Status}' }];

  assert.ok(validateObjectFlow(flow).some((error) => error.path === '$.selections[0].rules[0].rightExpression'));
});

test('object flow compiles ordinary selection predicates with all semantics', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:internalSystems', name: 'Internal systems', alias: 'internalSystems', className: 'IS', limit: 100,
      columns: ['Name', 'isExt'],
      rules: [
        { action: 'include', path: 'isExt', op: 'equals', value: 'false' },
        { action: 'include', path: 'Name', op: 'notEquals', valueParam: 'isName' }
      ]
    }],
    operations: [],
    publishedAlias: 'internalSystems'
  };

  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  assert.equal(compiled.steps[0].filterJoin, 'all');
});

test('object flow compiles a relation-aware existence match without changing the retained source schema', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:externalSystems', name: 'External systems', alias: 'externalSystems', className: 'IS', limit: 100, columns: ['isExt'],
      rules: [{ action: 'include', path: 'isExt', op: 'equals', value: 'true' }]
    }, {
      id: 'selection:acls', name: 'ACL', alias: 'acls', className: 'ACL', limit: 100, columns: [],
      rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }]
    }],
    operations: [{
      id: 'existsRelated:externalSystemsWithAcl', type: 'existsRelated', from: 'externalSystems', with: 'acls', as: 'externalSystemsWithAcl',
      domain: 'ISIpRange', targetClass: 'ipRange', direction: 'source', columns: ['range'], limit: 100, distinct: true,
      rules: [{ action: 'include', operator: 'ipv4InCidr', leftColumn: 'ipaddress', rightColumn: 'range' }]
    }],
    publishedAlias: 'externalSystemsWithAcl'
  };

  assert.deepEqual(validateObjectFlow(flow), []);
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  const operation = compiled.steps.find((step) => step.type === 'existsRelatedRows');
  assert.deepEqual(operation, {
    type: 'existsRelatedRows',
    purpose: 'objectMatching',
    from: 'externalSystems',
    with: 'acls',
    domain: 'ISIpRange',
    targetClass: 'ipRange',
    direction: 'source',
    columns: ['range'],
    limit: 100,
    distinct: true,
    rules: [{
      action: 'include', negate: false, operator: 'ipv4InCidr',
      left: { column: 'ipaddress', regex: '' }, right: { column: 'range', regex: '' }
    }],
    caseSensitive: false,
    as: 'externalSystemsWithAcl'
  });
  const relationAwareStage = objectFlowStageSummaries(flow).at(-1);
  const { cardSources: relationAwareSources, ...relationAwareSummary } = relationAwareStage;
  assert.deepEqual(relationAwareSummary, {
    id: 'existsRelated:externalSystemsWithAcl', kind: 'existsRelated', alias: 'externalSystemsWithAcl',
    columns: ['Class', '_id', 'Code', 'Description', 'isExt'],
    from: 'externalSystems',
    with: 'acls',
    domain: 'ISIpRange',
    targetClass: 'ipRange',
    direction: 'source',
    relatedColumns: ['range'],
    rules: [{ action: 'include', negate: false, operator: 'ipv4InCidr', leftColumn: 'ipaddress', rightColumn: 'range' }],
    comparisonBindings: [{
      id: 'comparison:existsRelated:externalSystemsWithAcl:1',
      source: { alias: 'acls', className: 'ACL', field: 'ipaddress' },
      comparison: { alias: 'externalSystemsWithAcl', className: 'ipRange', field: 'range' },
      operator: 'ipv4InCidr',
      evidence: 'existsRelatedRows',
      relation: { alias: 'externalSystemsWithAcl', fromAlias: 'externalSystems', domain: 'ISIpRange', targetClass: 'ipRange', direction: 'source' }
    }]
  });
  assert.deepEqual(relationAwareSources, [{
    id: 'current', className: 'IS', classColumn: 'Class', idColumn: '_id', label: 'Result card'
  }]);
});

test('compileObjectFlowToSpec replaces only managed object-flow state', () => {
  const currentSpec = {
    version: 1,
    params: { city: { type: 'string', required: true } },
    steps: [
      { type: 'selectCards', purpose: 'objectGroup', className: 'Old', as: 'oldObjects' },
      { type: 'filterRows', purpose: 'viewComposer', from: 'external', filters: [{ path: 'Code' }], as: 'visible' },
      { type: 'matchRows', purpose: 'objectMatching', from: 'oldObjects', with: 'oldRight', rules: [{}], as: 'oldMatch' },
      { type: 'matchRows', from: 'left', with: 'right', rules: [{ leftColumn: 'Code', rightColumn: 'Code' }], as: 'unrelatedMatch' }
    ],
    visualModel: { version: 1, mode: 'viewComposer', columns: [{ name: 'Code' }] },
    visualModels: [
      { version: 1, mode: 'presentation', marker: 'keep' },
      { version: 1, mode: 'objectGroup', marker: 'old' },
      { version: 1, mode: 'objectMatching', marker: 'old' }
    ],
    result: {
      tables: [
        { name: 'oldObjects', columns: ['Code'] },
        { name: 'oldMatch', columns: ['Code'] },
        { name: 'audit', columns: ['Event'], presentation: { sortColumn: 'Event' } }
      ],
      diagrams: [{ name: 'network', type: 'd2', source: 'nodes: {}' }],
      presentation: { titleAlign: 'left' },
      marker: 'keep'
    },
    cache: { enabled: true, ttlSeconds: 60 },
    publish: { mode: 'dynamicUser' },
    endpoint: { kind: 'runtime', code: 'object-flow' },
    defaults: { city: 'msk' },
    assistantDraft: { flowPrompts: { selections: {} } }
  };
  const inputSnapshot = structuredClone(currentSpec);
  const flow = validFlow();
  const flowSnapshot = structuredClone(flow);

  const compiled = compileObjectFlowToSpec(currentSpec, flow);

  assert.deepEqual(currentSpec, inputSnapshot);
  assert.deepEqual(flow, flowSnapshot);
  assert.deepEqual(compiled.params, currentSpec.params);
  assert.deepEqual(compiled.cache, currentSpec.cache);
  assert.deepEqual(compiled.publish, currentSpec.publish);
  assert.deepEqual(compiled.endpoint, currentSpec.endpoint);
  assert.deepEqual(compiled.defaults, currentSpec.defaults);
  assert.deepEqual(compiled.assistantDraft, currentSpec.assistantDraft);
  assert.deepEqual(compiled.result.diagrams, currentSpec.result.diagrams);
  assert.deepEqual(compiled.result.presentation, currentSpec.result.presentation);
  assert.equal(compiled.result.marker, 'keep');

  assert.equal(compiled.steps.some((step) => step.as === 'oldObjects'), false);
  assert.equal(compiled.steps.some((step) => step.as === 'oldMatch'), false);
  assert.equal(compiled.steps.some((step) => step.as === 'visible'), true);
  assert.equal(compiled.steps.some((step) => step.as === 'unrelatedMatch'), true);
  assert.deepEqual(compiled.steps.filter((step) => step.purpose === 'objectGroup').map((step) => step.as), [
    'routers',
    'rooms',
    'vlans'
  ]);
  assert.deepEqual(compiled.steps.filter((step) => step.purpose === 'objectMatching').map((step) => step.as), [
    'routerRooms',
    'routerRoomVlans'
  ]);
  assert.deepEqual(compiled.steps.map((step) => step.as), [
    'routers',
    'rooms',
    'vlans',
    'routerRooms',
    'routerRoomVlans',
    'visible',
    'unrelatedMatch'
  ]);
  assert.ok(compiled.steps.findIndex((step) => step.as === 'vlans') < compiled.steps.findIndex((step) => step.as === 'routerRooms'));

  const routers = compiled.steps.find((step) => step.as === 'routers');
  const rooms = compiled.steps.find((step) => step.as === 'rooms');
  const vlans = compiled.steps.find((step) => step.as === 'vlans');
  assert.deepEqual(routers.filters, [{
    scope: 'include',
    path: 'Status',
    negate: false,
    op: 'equals',
    valueExpression: 'active'
  }]);
  assert.deepEqual(routers.columns, [
    { path: 'Code', as: 'Code', multiMode: 'join', separator: ', ', emptyRow: true },
    { path: 'Location', as: 'Location', multiMode: 'join', separator: ', ', emptyRow: true }
  ]);
  assert.deepEqual(rooms.columns, [
    { path: 'Code', as: 'Code', multiMode: 'join', separator: ', ', emptyRow: true }
  ]);
  assert.equal(Object.hasOwn(rooms, 'from'), false);
  assert.equal(Object.hasOwn(rooms, 'includeSource'), false);
  assert.equal(Object.hasOwn(rooms, 'deduplicateCards'), false);
  assert.equal(rooms.filters.some((filter) => filter.valueColumn), false);
  assert.deepEqual(vlans.columns, [
    { path: 'Location', as: 'Location', multiMode: 'join', separator: ', ', emptyRow: true }
  ]);

  const firstMatch = compiled.steps.find((step) => step.as === 'routerRooms');
  const secondMatch = compiled.steps.find((step) => step.as === 'routerRoomVlans');
  assert.deepEqual(firstMatch, {
    type: 'matchRows',
    purpose: 'objectMatching',
    from: 'routers',
    with: 'rooms',
    rules: [{
      action: 'include',
      negate: false,
      operator: 'equals',
      left: { column: 'Location', regex: '' },
      right: { column: 'Code', regex: '' }
    }],
    caseSensitive: false,
    rightPrefix: 'Rooms.',
    as: 'routerRooms'
  });
  assert.equal(secondMatch.from, 'routerRooms');
  assert.equal(secondMatch.with, 'vlans');

  assert.deepEqual(compiled.visualModel, currentSpec.visualModel);
  assert.deepEqual(compiled.visualModels.map((model) => model.mode), [
    'presentation',
    'objectGroup',
    'objectMatching'
  ]);
  assert.equal(compiled.visualModels[1].selections[0].id, 'selection:routers');
  assert.equal(compiled.visualModels[1].selections[1].from, '');
  assert.equal(compiled.visualModels[1].selections[1].scopeRules.some((rule) => rule.path === 'Code' && rule.valueColumn === 'Location'), false);
  assert.equal(compiled.visualModels[2].operations[1].id, 'match:routerRoomVlans');

  assert.equal(compiled.result.tables.some((table) => table.name === 'oldObjects'), false);
  assert.equal(compiled.result.tables.some((table) => table.name === 'oldMatch'), false);
  assert.deepEqual(compiled.result.tables.find((table) => table.name === 'audit'), currentSpec.result.tables[2]);
  const finalTable = compiled.result.tables.find((table) => table.name === 'routerRoomVlans');
  assert.ok(finalTable.columns.includes('Rooms.Code'));
  assert.ok(finalTable.columns.includes('Vlans.Location'));
  assert.ok(finalTable.columns.includes('Vlans.Description'));
});

test('compileObjectFlowToSpec rejects invalid flows and unsupported Spec versions', () => {
  const invalidFlow = validFlow();
  invalidFlow.operations[0].with = 'missing';

  assert.throws(
    () => compileObjectFlowToSpec({ version: 1, steps: [] }, invalidFlow),
    (error) => error.code === 'object_flow_invalid' && Array.isArray(error.errors)
  );
  assert.throws(
    () => compileObjectFlowToSpec({ version: 2, steps: [] }, validFlow()),
    (error) => error.code === 'object_flow_spec_version'
  );
});

test('compileObjectFlowToSpec removes only the new-template starter query on first apply', () => {
  const currentSpec = {
    version: 1,
    params: {
      attrType: { type: 'string', required: true },
      city: { type: 'string', required: false }
    },
    steps: [{ type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' }],
    result: {
      emptyText: 'No data',
      tables: [{ name: 'classes', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] }],
      diagrams: [{ name: 'network', type: 'd2' }]
    }
  };

  const compiled = compileObjectFlowToSpec(currentSpec, validFlow());

  assert.equal(compiled.steps.some((step) => step.type === 'findClassesByAttributeType'), false);
  assert.equal(compiled.result.tables.some((table) => table.name === 'classes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(compiled.params, 'attrType'), false);
  assert.deepEqual(compiled.params.city, currentSpec.params.city);
  assert.deepEqual(compiled.result.diagrams, currentSpec.result.diagrams);
  assert.equal(compiled.result.emptyText, 'No data');
});

test('compileObjectFlowToSpec supports a single selection without match steps', () => {
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [] }, {
    version: 1,
    selections: [{
      alias: 'assets',
      name: 'Assets',
      className: 'Asset',
      rules: [{ action: 'include', path: 'Code', op: 'exists' }]
    }],
    blocks: []
  });

  assert.deepEqual(compiled.steps.map((step) => [step.type, step.as]), [['selectCards', 'assets']]);
  assert.equal(compiled.result.tables.some((table) => table.name === 'assets'), true);
  assert.equal(compiled.visualModels.find((model) => model.mode === 'objectMatching').output.alias, '');
  assert.deepEqual(validateTemplateSpec(compiled), []);
});

test('object flow compiles typed set operations without selecting a published table', () => {
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, {
    version: 1,
    selections: [
      { alias: 'blueAssets', className: 'Asset', rules: [{ action: 'include', path: 'Code', op: 'exists' }] },
      { alias: 'redAssets', className: 'Asset', rules: [{ action: 'include', path: 'Code', op: 'exists' }] }
    ],
    blocks: [{
      from: 'blueAssets', with: 'redAssets', as: 'matchedAssets', rightPrefix: 'Red.',
      rules: [{ action: 'include', operator: 'equals', leftColumn: 'Code', rightColumn: 'Code' }]
    }],
    setOperations: [{
      id: 'set:activeAssets', type: 'difference', from: 'blueAssets', with: 'redAssets', as: 'activeAssets',
      on: [{ left: 'Class', right: 'Class' }, { left: '_id', right: '_id' }], distinct: true, caseSensitive: false
    }],
    publishedAlias: 'activeAssets'
  });

  assert.deepEqual(compiled.steps.map((step) => [step.type, step.as]), [
    ['selectCards', 'blueAssets'],
    ['selectCards', 'redAssets'],
    ['matchRows', 'matchedAssets'],
    ['differenceRows', 'activeAssets']
  ]);
  const setStep = compiled.steps.find((step) => step.as === 'activeAssets');
  assert.deepEqual(setStep.on, [{ left: 'Class', right: 'Class' }, { left: '_id', right: '_id' }]);
  assert.equal(compiled.result.tables.find((table) => table.name === 'activeAssets').published, undefined);
  assert.equal(compiled.result.tables.filter((table) => table.published).length, 0);
  assert.ok(compiled.result.tables.find((table) => table.name === 'matchedAssets').columns.includes('Red.Code'));
  assert.deepEqual(validateObjectFlow({
    version: 1,
    selections: [{ alias: 'assets', className: 'Asset', rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
    blocks: [],
    setOperations: [{ id: 'set:bad', type: 'union', from: 'assets', with: 'missing', as: 'allAssets', on: [] }],
    publishedAlias: 'missing'
  }).map((error) => error.path).sort(), ['$.operations[0].on', '$.operations[0].with', '$.publishedAlias']);
});

test('operations run only in declared order and can use an earlier set alias', () => {
  const flow = validFlow();
  flow.operations = [
    {
      id: 'set:allSites',
      type: 'union',
      from: 'routers',
      with: 'rooms',
      as: 'allSites',
      on: [{ left: 'Code', right: 'Code' }],
      distinct: true,
      caseSensitive: false
    },
    {
      id: 'match:siteVlans',
      type: 'match',
      from: 'allSites',
      with: 'vlans',
      as: 'siteVlans',
      rightPrefix: 'Vlans.',
      rules: [{ action: 'include', operator: 'equals', leftColumn: 'Code', rightColumn: 'Location' }]
    }
  ];
  flow.publishedAlias = 'siteVlans';

  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);

  assert.deepEqual(compiled.steps.map((step) => [step.type, step.as]), [
    ['selectCards', 'routers'],
    ['selectCards', 'rooms'],
    ['selectCards', 'vlans'],
    ['unionRows', 'allSites'],
    ['matchRows', 'siteVlans']
  ]);
  assert.equal(compiled.steps[4].from, 'allSites');
  assert.equal(compiled.steps[4].with, 'vlans');
  assert.equal(compiled.result.tables.find((table) => table.name === 'siteVlans').published, undefined);
});

test('operations reject forward references and retain migrated saved operation order', () => {
  const invalid = validFlow();
  invalid.operations = [{
    id: 'match:forward',
    type: 'match',
    from: 'later',
    with: 'routers',
    as: 'first',
    rightPrefix: 'Routers.',
    rules: [{ action: 'include', operator: 'equals', leftColumn: 'Code', rightColumn: 'Code' }]
  }, {
    id: 'set:later',
    type: 'union',
    from: 'rooms',
    with: 'vlans',
    as: 'later',
    on: [{ left: 'Code', right: 'Code' }]
  }];
  assert.ok(validateObjectFlow(invalid).some((error) => error.path === '$.operations[0].from'));

  const migrated = normalizeObjectFlow({
    version: 1,
    selections: validFlow().selections,
    blocks: [{ from: 'routers', with: 'rooms', as: 'routerRooms', rules: [{ leftColumn: 'Code', rightColumn: 'Code' }] }],
    setOperations: [{ type: 'union', from: 'routerRooms', with: 'vlans', as: 'allSites', on: [{ left: 'Code', right: 'Code' }] }]
  });
  assert.deepEqual(migrated.operations.map((operation) => [operation.type, operation.as]), [
    ['match', 'routerRooms'],
    ['union', 'allSites']
  ]);
});

test('objectFlowStageSummaries returns deterministic cumulative columns', () => {
  const summaries = objectFlowStageSummaries(validFlow());
  const publicSummaries = summaries.map(({ cardSources, ...stage }) => stage);

  assert.deepEqual(publicSummaries.slice(0, 3), [
    {
      id: 'selection:routers',
      kind: 'selection',
      alias: 'routers',
      label: 'Routers',
      className: 'Router',
      from: '',
      rules: [{ path: 'Status', op: 'equals', rightExpression: 'active', action: 'include', negate: false }],
      columns: ['Class', '_id', 'Code', 'Description', 'Location']
    },
    {
      id: 'selection:rooms',
      kind: 'selection',
      alias: 'rooms',
      label: 'Rooms',
      className: 'Room',
      from: '',
      rules: [{ path: 'Code', op: 'matches', rightExpression: '^DC-', action: 'include', negate: false }],
      columns: ['Class', '_id', 'Code', 'Description']
    },
    {
      id: 'selection:vlans',
      kind: 'selection',
      alias: 'vlans',
      label: 'VLANs',
      className: 'Vlan',
      from: '',
      rules: [{ path: 'Status', op: 'equals', rightExpression: 'retired', action: 'exclude', negate: false }],
      columns: ['Class', '_id', 'Code', 'Description']
    }
  ]);
  assert.deepEqual(publicSummaries[3], {
    id: 'match:routerRooms',
    kind: 'match',
    alias: 'routerRooms',
    columns: [
      'Class', '_id', 'Code', 'Description',
      'Location',
      'Rooms.Class', 'Rooms._id', 'Rooms.Code', 'Rooms.Description'
    ],
    from: 'routers',
    with: 'rooms',
    rightPrefix: 'Rooms.',
    rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Location', rightColumn: 'Code' }],
    comparisonBindings: [{
      id: 'comparison:match:routerRooms:1',
      source: { alias: 'routers', className: 'Router', field: 'Location' },
      comparison: { alias: 'rooms', className: 'Room', field: 'Code' },
      operator: 'equals',
      evidence: 'matchRows'
    }]
  });
  assert.ok(summaries[4].columns.includes('Rooms.Code'));
  assert.ok(summaries[4].columns.includes('Vlans.Location'));
  assert.deepEqual(summaries[3].cardSources, [
    { id: 'current', className: 'Router', classColumn: 'Class', idColumn: '_id', label: 'Result card' },
    { id: 'Rooms.current', className: 'Room', classColumn: 'Rooms.Class', idColumn: 'Rooms._id', label: 'Compared: Result card' }
  ]);
});

test('objectFlowStageSummaries exposes typed set-operation aliases for diagram mapping', () => {
  const flow = validFlow();
  flow.operations.push({
    id: 'set:allInfrastructure',
    type: 'union',
    from: 'routers',
    with: 'rooms',
    as: 'allInfrastructure',
    on: [{ left: 'Class', right: 'Class' }, { left: '_id', right: '_id' }]
  });
  flow.publishedAlias = 'allInfrastructure';

  const stage = objectFlowStageSummaries(flow).find((item) => item.id === 'set:allInfrastructure');

  const { cardSources, ...publicStage } = stage;
  assert.deepEqual(publicStage, {
    id: 'set:allInfrastructure',
    kind: 'set',
    alias: 'allInfrastructure',
    columns: ['Class', '_id', 'Code', 'Description', 'Location']
  });
  assert.deepEqual(cardSources, [
    { id: 'current', className: 'Router', classColumn: 'Class', idColumn: '_id', label: 'Result card' },
    { id: 'current', className: 'Room', classColumn: 'Class', idColumn: '_id', label: 'Result card' }
  ]);
});

test('objectFlowStageSummaries retains relation provenance for diagram related bindings', () => {
  const flow = validFlow();
  flow.operations.push({
    id: 'relation:routerNetworks',
    type: 'relation',
    from: 'routers',
    as: 'routerNetworks',
    domain: 'RouterNetwork',
    targetClass: 'ipRange',
    direction: 'source',
    columns: ['range'],
    limit: 100,
    distinct: true
  });
  const stage = objectFlowStageSummaries(flow).find((item) => item.id === 'relation:routerNetworks');
  assert.equal(stage.className, 'ipRange');
  assert.equal(stage.from, 'routers');
  assert.equal(stage.domain, 'RouterNetwork');
  assert.equal(stage.direction, 'source');
  assert.ok(stage.columns.includes('range'));
});

test('objectFlowStageSummaries exposes deterministic source provenance for nested diagram conditions', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:ranges', name: 'Ranges', alias: 'ranges', className: 'ipRange', limit: 100,
      columns: ['range'], rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }]
    }, {
      id: 'selection:addresses', name: 'Addresses', alias: 'addresses', className: 'IpAddress', from: 'ranges', limit: 100,
      columns: ['ipAddr'], rules: [{ action: 'include', path: 'ipAddr', op: 'ipv4InCidr', valueColumn: 'range' }]
    }],
    operations: [{
      id: 'relation:servers', type: 'relation', from: 'addresses', as: 'servers', domain: 'ipaddress',
      targetClass: 'vServer', direction: 'source', columns: ['Code'], limit: 100, distinct: true
    }],
    publishedAlias: 'servers'
  };

  const summaries = objectFlowStageSummaries(flow);
  const addresses = summaries.find((item) => item.alias === 'addresses');
  const servers = summaries.find((item) => item.alias === 'servers');

  assert.ok(addresses.columns.includes('Source_range'));
  assert.ok(servers.columns.includes('Source_Source_range'));
  assert.ok(servers.columns.includes('Source_ipAddr'));
  assert.ok(servers.cardSources.some((source) => (
    source.className === 'ipRange' && source.classColumn === 'Source_Source_Class' && source.idColumn === 'Source_Source__id'
  )));
});

test('objectFlowStageSummaries preserves typed relation-pair endpoints for D2 mapping', () => {
  const flow = {
    version: 1,
    selections: [{
      id: 'selection:applications', name: 'Applications', alias: 'applications', className: 'ApplicG', limit: 100,
      columns: ['Code'], rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }]
    }, {
      id: 'selection:servers', name: 'Servers', alias: 'servers', className: 'phServer', limit: 100,
      columns: ['Code'], rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }]
    }],
    operations: [{
      id: 'relation:applicationServersRaw', type: 'relation', from: 'applications', as: 'applicationServersRaw', domain: 'phs',
      targetClass: 'phServer', direction: 'source', columns: ['Code'], limit: 100, distinct: true
    }, {
      id: 'match:applicationServers', type: 'match', from: 'applicationServersRaw', with: 'servers', as: 'applicationServers', rightPrefix: 'Endpoint_',
      rules: [{ action: 'include', operator: 'equals', leftColumn: 'RelatedId', rightColumn: '_id' }],
      connection: { mode: 'domain', fromClass: 'ApplicG', withClass: 'phServer', sourceField: 'SourceId', targetField: 'RelatedId', domain: 'phs', direction: 'source' }
    }],
    publishedAlias: 'applicationServers'
  };

  const normalized = normalizeObjectFlow(flow);
  const stage = objectFlowStageSummaries(normalized).find((item) => item.id === 'match:applicationServers');
  assert.deepEqual(stage.connection, {
    mode: 'domain', fromClass: 'ApplicG', withClass: 'phServer', sourceField: 'SourceId', targetField: 'RelatedId', domain: 'phs', direction: 'source'
  });
  assert.ok(stage.columns.includes('SourceId'));
  assert.ok(stage.columns.includes('RelatedId'));
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, normalized);
  const stored = compiled.visualModels.find((model) => model.mode === 'objectMatching').operations.find((operation) => operation.as === 'applicationServers');
  assert.deepEqual(stored.connection, stage.connection);
  assert.equal(compiled.steps.find((step) => step.as === 'applicationServers').connection, undefined);
});

test('diagram role mapping does not synthesize related data from comparison metadata', () => {
  const roles = [{ id: 'role:site', selectedSemantic: 'object' }];
  const stages = [
    { id: 'selection:site', kind: 'selection', alias: 'site', className: 'Site', from: '', columns: [] },
    {
      id: 'relation:siteNetwork',
      kind: 'relation',
      alias: 'siteNetwork',
      className: 'AddressPool',
      from: 'site',
      domain: 'SiteAddressPool',
      direction: 'source',
      columns: ['cidr']
    },
    {
      id: 'selection:device',
      kind: 'selection',
      alias: 'device',
      className: 'Device',
      from: 'siteNetwork',
      columns: ['address'],
      comparisonBindings: [{
        id: 'comparison:device:1',
        source: { alias: 'device', className: 'Device', field: 'address' },
        comparison: { alias: 'siteNetwork', className: 'AddressPool', field: 'cidr' },
        operator: 'ipv4InCidr',
        evidence: 'selectionValueColumn',
        relation: { alias: 'siteNetwork', fromAlias: 'site', domain: 'SiteAddressPool', targetClass: 'AddressPool', direction: 'source' }
      }]
    }
  ];
  const mapped = assistantDiagramAttachRelatedNetworkStages([{
    roleId: 'role:site',
    source: { alias: 'site', stageId: 'selection:site', kind: 'selection', className: 'Site' },
    mapping: { id: 'mapping:site', roleId: 'role:site', source: { alias: 'site' }, primary: {}, related: [] }
  }], roles, stages);

  assert.deepEqual(mapped[0].mapping.related, []);
});

test('Object Flow persists an ordered output manifest without claiming unrelated tables', () => {
  const flow = validFlow();
  flow.publishedAlias = 'routerRoomVlans';
  const outputs = objectFlowResultOutputs(flow);
  const compiled = compileObjectFlowToSpec({
    version: 1,
    steps: [{ type: 'selectCards', className: 'ARM', as: 'targetARM', filters: [], limit: 100 }],
    result: { tables: [{ name: 'targetARM', title: 'Manual ARM target', published: true }] }
  }, flow);

  assert.deepEqual(outputs.map((output) => [output.alias, output.label, output.kind]), [
    ['routers', 'Routers', 'selection'],
    ['rooms', 'Rooms', 'selection'],
    ['vlans', 'VLANs', 'selection'],
    ['routerRooms', 'Сопоставление 1', 'match'],
    ['routerRoomVlans', 'Сопоставление 2', 'match']
  ]);
  const manifest = compiled.visualModels.find((model) => model.mode === 'objectMatching').outputs;
  assert.deepEqual(manifest, outputs);
  assert.equal(compiled.result.tables.find((table) => table.name === 'targetARM').published, true);
  assert.equal(compiled.result.tables.find((table) => table.name === 'routerRoomVlans').published, undefined);
});

test('Assistant output metadata gives named blocks ownership of visible tables without changing aliases', () => {
  const flow = validFlow();
  flow.publishedAlias = 'routerRoomVlans';
  const outputMetadata = [
    { alias: 'routers', label: 'Маршрутизаторы', assistantBlockId: 'block-1' },
    { alias: 'rooms', label: 'Помещения', assistantBlockId: 'block-2' },
    { alias: 'vlans', label: 'VLAN текущей ИС', assistantBlockId: 'block-3' },
    { alias: 'routerRooms', label: 'VLAN текущей ИС: Сопоставление 1', assistantBlockId: 'block-3', assistantBlockIds: ['block-3'] },
    { alias: 'routerRoomVlans', label: 'Список VLAN', assistantBlockId: 'block-4' }
  ];
  const assistantOutputManifest = {
    version: 1,
    blocks: [
      { id: 'block-1', name: 'Маршрутизаторы', order: 1 },
      { id: 'block-2', name: 'Помещения', order: 2 },
      { id: 'block-3', name: 'VLAN текущей ИС', order: 3 },
      { id: 'block-4', name: 'Список VLAN', order: 4 }
    ]
  };
  const compiled = compileObjectFlowToSpec({
    version: 1,
    steps: [],
    result: { tables: [{ name: 'routerRoomVlans', title: 'Final result', published: true }] }
  }, flow, { outputMetadata, assistantOutputManifest });
  const outputs = objectFlowResultOutputs(flow, outputMetadata);

  assert.deepEqual(outputs.map((output) => output.alias), [
    'routers', 'rooms', 'vlans', 'routerRooms', 'routerRoomVlans'
  ]);
  assert.deepEqual(outputs.map((output) => output.label), [
    'Маршрутизаторы', 'Помещения', 'VLAN текущей ИС', 'VLAN текущей ИС: Сопоставление 1', 'Список VLAN'
  ]);
  assert.equal(outputs.every((output) => output.assistantManaged), true);
  assert.deepEqual(outputs.map((output) => [output.alias, output.assistantBlockId, output.assistantBlockIds]), [
    ['routers', 'block-1', ['block-1']],
    ['rooms', 'block-2', ['block-2']],
    ['vlans', 'block-3', ['block-3']],
    ['routerRooms', 'block-3', ['block-3']],
    ['routerRoomVlans', 'block-4', ['block-4']]
  ]);
  assert.equal(compiled.result.tables.find((table) => table.name === 'routerRooms').title, 'VLAN текущей ИС: Сопоставление 1');
  assert.equal(compiled.result.tables.find((table) => table.name === 'routerRoomVlans').title, 'Список VLAN');
  assert.equal(compiled.visualModels.find((model) => model.mode === 'objectMatching').output.title, 'Список VLAN');
  assert.deepEqual(compiled.visualModels.find((model) => model.mode === 'objectMatching').assistantOutputManifest, assistantOutputManifest);
});

test('Assistant output metadata requires a complete persisted ownership manifest', () => {
  const flow = validFlow();
  flow.publishedAlias = 'routerRoomVlans';
  const completeMetadata = objectFlowResultOutputs(flow).map((output, index) => ({
    alias: output.alias,
    label: `Result ${index + 1}`,
    assistantBlockId: 'block-1'
  }));
  const currentSpec = { version: 1, steps: [], result: { tables: [] } };

  assert.throws(
    () => compileObjectFlowToSpec(currentSpec, flow, { outputMetadata: completeMetadata }),
    { code: 'assistant_output_manifest_invalid' }
  );
  assert.throws(
    () => compileObjectFlowToSpec(currentSpec, flow, {
      outputMetadata: completeMetadata.slice(0, -1),
      assistantOutputManifest: { version: 1, blocks: [{ id: 'block-1', name: 'Result', order: 1 }] }
    }),
    { code: 'object_flow_output_metadata_invalid' }
  );
  assert.throws(
    () => compileObjectFlowToSpec(currentSpec, flow, {
      outputMetadata: completeMetadata,
      assistantOutputManifest: {
        version: 1,
        blocks: [
          { id: 'block-1', name: 'Result', order: 1 },
          { id: 'block-2', name: ' result ', order: 2 }
        ]
      }
    }),
    { code: 'assistant_output_manifest_invalid' }
  );
});

test('match stage summaries retain custom columns from every materialized selection', () => {
  const flow = validFlow();
  flow.selections[0].columns.push('RouterModel');
  flow.selections[1].columns = ['RoomModel'];
  flow.selections[2].columns = ['VlanModel'];

  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  const summaries = objectFlowStageSummaries(flow);
  const firstMatch = summaries.find((stage) => stage.id === 'match:routerRooms');
  const finalMatch = summaries.find((stage) => stage.id === 'match:routerRoomVlans');
  const finalTable = compiled.result.tables.find((table) => table.name === 'routerRoomVlans');

  assert.ok(firstMatch.columns.includes('RouterModel'));
  assert.ok(firstMatch.columns.includes('Rooms.RoomModel'));
  assert.ok(finalMatch.columns.includes('RouterModel'));
  assert.ok(finalMatch.columns.includes('Rooms.RoomModel'));
  assert.ok(finalMatch.columns.includes('Vlans.VlanModel'));
  assert.ok(finalTable.columns.includes('Vlans.VlanModel'));
});

test('object flow rejects unknown set operations and forward selection sources', () => {
  const unknownSet = validFlow();
  unknownSet.operations = [{
    id: 'set:unsupported',
    type: 'merge',
    from: 'routers',
    with: 'rooms',
    as: 'unsupported',
    on: [{ left: 'Code', right: 'Code' }]
  }];
  const normalized = normalizeObjectFlow(unknownSet);

  assert.equal(normalized.operations[0].type, 'merge');
  assert.ok(validateObjectFlow(normalized).some((error) => error.path === '$.operations[0].type'));

  const forwardSelection = validFlow();
  forwardSelection.selections[1].from = 'vlans';
  assert.ok(validateObjectFlow(forwardSelection).some((error) => error.path === '$.selections[1].from'));
});

test('object flow rejects operation columns absent from intermediate materialized stages', () => {
  const flow = validFlow();
  flow.operations[1].rules[0].leftColumn = 'MissingIntermediateColumn';

  const errors = validateObjectFlow(flow);
  assert.ok(errors.some((error) => error.path === '$.operations[1].rules[0].leftColumn'));
});

test('relation requirements preserve confirmed inherited-domain hops without fixing aliases or output', () => {
  const prompt = 'Выборка 1\nДля информационной системы (ИС) имя которой равно параметру отчета isName, выбираем все связанные объекты ipRange\n\nВыборка 2\nДля ipRange из выборки 1 получить все VLAN которые с ними связаны';
  const mcpContext = {
    enabled: true,
    diagnostics: {
      candidateClasses: [
        { name: 'IS', description: 'Информационная система', score: 22, matchedTerms: ['информационной', 'системы'] },
        { name: 'C2M_ServiceComputeCluster', description: 'Сервис ИС', score: 12, matchedTerms: ['информационной'] },
        { name: 'ipRange', description: 'IP range', score: 68, matchedTerms: ['iprange'] },
        { name: 'vlan', description: 'VLAN', score: 42, matchedTerms: ['vlan'] }
      ],
      relationPaths: [
        { domain: 'ISZabbixMonitoringDomain', direction: 'source', sourceClass: 'IS', targetClass: 'ipRange', sourceRoot: 'IS', targetRoot: 'ZabbixMonitoring', sourceEndpoint: ['IS'], targetEndpoint: ['ZabbixMonitoring', 'ipRange'] },
        { domain: 'super2super', direction: 'source', sourceClass: 'IS', targetClass: 'ipRange', sourceRoot: 'super', targetRoot: 'super', sourceEndpoint: ['super', 'IS'], targetEndpoint: ['super', 'ipRange'] },
        { domain: 'Vlan2super', direction: 'destination', sourceClass: 'ipRange', targetClass: 'vlan', sourceRoot: 'ZabbixMonitoring', targetRoot: 'vlan', sourceEndpoint: ['ZabbixMonitoring', 'ipRange'], targetEndpoint: ['vlan'] },
        { domain: 'super2super', direction: 'source', sourceClass: 'ipRange', targetClass: 'vlan', sourceRoot: 'super', targetRoot: 'super', sourceEndpoint: ['super', 'ipRange'], targetEndpoint: ['super', 'vlan'] }
      ]
    },
    tools: [],
    warnings: [],
    text: ''
  };

  const requirements = assistantRelationRequirements(prompt, mcpContext);
  assert.deepEqual(requirements, {
    kind: 'relationRequirements',
    chains: [{ operations: [
      { sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }
    ] }]
  });
  const messages = assistantObjectFlowMessages({ prompt, currentSpec: { version: 1, params: { isName: { type: 'string' } } } }, mcpContext, {}, requirements);
  assert.match(messages.at(-1).content, /"relationRequirements"/);
  assert.match(messages.at(-1).content, /"ipRange"/);
  assert.ok(messages.some((message) => /Binding deterministic requirements/.test(message.content)));
  assert.ok(messages.some((message) => /do not change direction/.test(message.content)));
  const errors = assistantRelationRequirementsErrors({ selections: [{ alias: 'IS_by_isName', className: 'IS' }], operations: [], publishedAlias: '' }, requirements);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].expectedRelationRequirements, requirements);
});

test('relation requirements allow an IPv4 ACL match after confirmed relation hops', () => {
  const prompt = [
    'Выборка 1\nДля информационной системы (ИС) выбираем связанные объекты ipRange.',
    'Выборка 2\nДля ipRange из выборки 1 получить все VLAN которые с ними связаны.',
    'Выборка 3\nПолучить ACL, у которых Source ipaddress или Destination ipaddress входит в сеть range из ipRange.'
  ].join('\n\n');
  const mcpContext = {
    diagnostics: {
      candidateClasses: [
        { name: 'IS', description: 'Информационная система', score: 22, matchedTerms: ['информационной', 'системы'] },
        { name: 'ipRange', description: 'IP range', score: 68, matchedTerms: ['iprange'] },
        { name: 'vlan', description: 'VLAN', score: 42, matchedTerms: ['vlan'] },
        { name: 'ACL', description: 'ACL', score: 42, matchedTerms: ['acl'] },
        { name: 'IpAddress', description: 'IP address', score: 42, matchedTerms: ['ipaddress'] }
      ],
      relationPaths: [
        { domain: 'ISZabbixMonitoringDomain', direction: 'source', sourceClass: 'IS', targetClass: 'ipRange', sourceRoot: 'IS', targetRoot: 'ZabbixMonitoring', sourceEndpoint: ['IS'], targetEndpoint: ['ZabbixMonitoring', 'ipRange'] },
        { domain: 'Vlan2super', direction: 'destination', sourceClass: 'ipRange', targetClass: 'vlan', sourceRoot: 'ZabbixMonitoring', targetRoot: 'vlan', sourceEndpoint: ['ZabbixMonitoring', 'ipRange'], targetEndpoint: ['vlan'] },
        { domain: 'aclLine', direction: 'source', sourceClass: 'vlan', targetClass: 'ACL', sourceRoot: 'ZabbixMonitoring', targetRoot: 'ACL', sourceEndpoint: ['ZabbixMonitoring', 'vlan'], targetEndpoint: ['ACL'] },
        { domain: 'aclLine', direction: 'destination', sourceClass: 'ACL', targetClass: 'IpAddress', sourceRoot: 'ACL', targetRoot: 'ZabbixMonitoring', sourceEndpoint: ['ACL'], targetEndpoint: ['ZabbixMonitoring', 'IpAddress'] }
      ]
    },
    results: [{
      tool: 'cmdbuild_class_fields',
      ok: true,
      result: [
        { className: 'ipRange', attributes: [{ name: 'range', description: 'Range' }] },
        { className: 'ACL', attributes: [
          { name: 'ipaddress', description: 'Source ipaddress' },
          { name: 'dipaddress', description: 'Destination ipaddress' }
        ] }
      ]
    }]
  };
  const requirements = assistantRelationRequirements(prompt, mcpContext);
  assert.deepEqual(requirements, {
    kind: 'relationRequirements',
    chains: [{ operations: [
      { sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { sourceClass: 'ipRange', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }
    ] }]
  });

  const flow = {
    selections: [
      { alias: 'informationSystems', className: 'IS' },
      { alias: 'acls', className: 'ACL' }
    ],
    operations: [
      { type: 'relation', from: 'informationSystems', as: 'ipRanges', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { type: 'relation', from: 'ipRanges', as: 'vlans', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' },
      {
        type: 'match', from: 'acls', with: 'ipRanges', as: 'matchingAcls',
        rules: [
          { action: 'include', operator: 'ipv4InCidr', leftColumn: 'dipaddress', rightColumn: 'range' },
          { action: 'include', operator: 'ipv4InCidr', leftColumn: 'ipaddress', rightColumn: 'range' }
        ]
      }
    ]
  };
  assert.deepEqual(assistantRelationRequirementsErrors(flow, requirements), []);
  const matchRequirements = assistantIpv4MatchRequirements(prompt, mcpContext, requirements);
  assert.deepEqual(matchRequirements, [{
    kind: 'ipv4Membership', selectionClass: 'ACL', relationClass: 'ipRange', sourceFields: ['ipaddress', 'dipaddress'], networkField: 'range', operator: 'ipv4InCidr'
  }]);
  assert.deepEqual(assistantMatchRequirementsErrors(flow, matchRequirements), []);

  const sourceDrivenFlow = {
    selections: [
      { alias: 'informationSystems', className: 'IS' },
      {
        alias: 'aclsInRanges', className: 'ACL', from: 'ipRanges', rules: [
          { action: 'include', path: 'ipaddress', op: 'ipv4InCidr', valueColumn: 'range' },
          { action: 'include', path: 'dipaddress', op: 'ipv4InCidr', valueColumn: 'range' }
        ]
      }
    ],
    operations: [
      { type: 'relation', from: 'informationSystems', as: 'ipRanges', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { type: 'relation', from: 'ipRanges', as: 'vlans', domain: 'Vlan2super', targetClass: 'vlan', direction: 'destination' }
    ]
  };
  assert.deepEqual(assistantMatchRequirementsErrors(sourceDrivenFlow, matchRequirements), []);

  flow.operations.splice(2, 0, {
    type: 'relation', from: 'ipRanges', as: 'aclsByRelation', domain: 'aclLine', targetClass: 'ACL', direction: 'source'
  });
  const errors = assistantRelationRequirementsErrors(flow, requirements);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not confirmed/);
  assert.deepEqual(errors[0].actualRelation, {
    sourceClasses: ['ipRange'],
    domain: 'aclLine',
    targetClass: 'ACL',
    direction: 'source',
    from: 'ipRanges',
    as: 'aclsByRelation'
  });
  const feedback = assistantObjectFlowValidationFeedback(errors);
  assert.match(feedback.summary, /aclLine/);
  assert.match(feedback.action, /сравнение атрибутов/);
  assert.ok(feedback.confirmedRelations.some((path) => path.includes('ISZabbixMonitoringDomain')));
});

test('object-flow rejection reports a missing required field as the root cause and lists dependent stages', () => {
  const flow = {
    version: 1,
    selections: [
      { name: 'Результат 1', alias: 'IS_by_Name', className: '', from: '', rules: [] },
      { name: 'Результат 2', alias: 'ipRange_from_IS', className: '', from: 'IS_by_Name', rules: [] }
    ],
    operations: [
      { type: 'existsRelated', from: 'ipRange_from_IS', with: '', as: 'ACL_with_ip_in_ipRange', domain: 'aclLine', targetClass: 'ACL', rules: [] },
      { type: 'relation', from: 'ACL_with_ip_in_ipRange', as: 'IS_from_ACL_outside_ipRange', domain: 'aclLine', targetClass: 'IS', direction: 'destination' }
    ]
  };
  const errors = assistantObjectFlowIncompleteFieldErrors(flow).concat([{
    path: '$.flow.relationRequirements',
    expectedRelationRequirements: {
      kind: 'relationRequirements',
      chains: [{ operations: [{ sourceClass: 'IS', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' }] }]
    }
  }]);
  const feedback = assistantObjectFlowValidationFeedback(errors, { flow });

  assert.equal(feedback.causes[0].kind, 'missingClass');
  assert.match(feedback.summary, /Результат 1/);
  assert.match(feedback.causes[0].message, /CMDBuild class/);
  assert.deepEqual(feedback.affectedStages.map((stage) => stage.label), [
    'Результат 1',
    'Результат 2',
    'Операция 1 (ACL_with_ip_in_ipRange)',
    'Операция 2 (IS_from_ACL_outside_ipRange)'
  ]);
  assert.ok(feedback.confirmedRelations.some((relation) => relation.includes('ISZabbixMonitoringDomain')));
});

test('source-card result contract explains the missing comparison set without exposing aliases as the instruction', () => {
  const intent = {
    context: '',
    blocks: [
      { id: 'result-3', name: 'Результат 3', entities: 'ACL', algorithm: 'Выбрать ACL.', expectedResult: 'Список ACL.', uses: [] },
      { id: 'external-is', name: 'Внешние ИС', entities: 'ИС и связанные ipRange.', algorithm: 'Оставить ИС по ACL из Результата 3.', expectedResult: 'Список ИС.', uses: ['result-3'] }
    ]
  };
  const semanticPlan = {
    blocks: [{ id: 'result-3', name: 'Результат 3', resultContract: { outputKind: 'sourceCards', outputClass: 'ACL', relationPredicates: [] } }, {
      id: 'external-is', name: 'Внешние ИС', resultContract: {
        outputKind: 'sourceCards', outputClass: 'IS', relationPredicates: [{
          sourceClass: 'IS', relatedClass: 'ipRange', comparisonBlockId: 'result-3', comparisonClass: 'ACL',
          domain: 'ISIpRange', direction: 'source', comparisonFields: ['ipaddress', 'dipaddress'], relatedField: 'range', operator: 'ipv4InCidr'
        }]
      }
    }]
  };
  const flow = {
    selections: [
      { alias: 'result3Acl', className: 'ACL' },
      { alias: 'externalIs', className: 'IS' }
    ],
    operations: [{ type: 'existsRelated', from: 'externalIs', with: '', as: 'externalIsWithAcl', domain: 'ISIpRange', targetClass: 'ipRange', direction: 'source', rules: [] }],
    publishedAlias: 'externalIsWithAcl'
  };

  const errors = assistantResultContractErrors(flow, semanticPlan, intent);
  const feedback = assistantObjectFlowValidationFeedback(errors, { flow });

  assert.equal(errors[0].code, 'assistant_result_contract_missing_with');
  assert.equal(feedback.causes[0].kind, 'resultContractMissingWith');
  assert.match(feedback.summary, /списка IS/);
  assert.match(feedback.causes[0].message, /Сохраняемый набор: IS/);
  assert.match(feedback.action, /Результат 3/);
  assert.doesNotMatch(feedback.action, /externalIsWithAcl/);
});

test('object-flow restores an omitted class only from an exact alias hint in confirmed MCP context', () => {
  const candidate = assistantObjectFlowCandidate({
    selections: [
      { alias: 'IS_by_Name', className: '', rules: [{ path: 'Name', op: 'equals', valueParam: 'isName' }] },
      { alias: 'ipRange_from_IS', className: '', from: 'IS_by_Name', rules: [{ path: 'Code', op: 'matches', regex: '.*' }] }
    ],
    operations: []
  });
  const recovery = assistantRestoreObjectFlowSelectionClasses(candidate.flow, {
    blocks: [{ resolvedEntities: ['IS', 'ipRange', 'ACL'] }]
  }, {
    results: [{
      tool: 'cmdbuild_model_summary',
      ok: true,
      result: { classes: [{ name: 'IS' }, { name: 'ipRange' }, { name: 'ACL' }] }
    }]
  }, {
    kind: 'relationRequirements',
    chains: [{ operations: [{ sourceClass: 'IS', targetClass: 'ipRange' }] }]
  });

  assert.deepEqual(candidate.flow.selections.map((selection) => selection.className), ['IS', 'ipRange']);
  assert.equal(recovery.normalizations.length, 2);
  assert.match(recovery.warnings.join(' '), /exact alias hint/);
});

test('object-flow candidate keeps operation aliases when an LLM duplicates them as selections', () => {
  const candidate = assistantObjectFlowCandidate({
    selections: [
      { alias: 'is', className: 'IS', rules: [{ path: 'Name', op: 'equals', valueParam: 'isName' }] },
      { alias: 'ipRange', className: 'ipRange' },
      { alias: 'acl', className: 'ACL' }
    ],
    operations: [
      { type: 'relation', from: 'is', as: 'ipRange', domain: 'ISZabbixMonitoringDomain', targetClass: 'ipRange', direction: 'source' },
      { type: 'match', from: 'acl', with: 'ipRange', as: 'acl', rules: [{ operator: 'ipv4InCidr', leftColumn: 'ipaddress', rightColumn: 'range' }] }
    ]
  });
  assert.deepEqual(candidate.flow.selections.map((selection) => selection.alias), ['is', 'ipRangeSelection', 'aclSelection']);
  assert.deepEqual(candidate.flow.operations.map((operation) => [operation.from, operation.with, operation.as]), [
    ['is', undefined, 'ipRange'],
    ['aclSelection', 'ipRange', 'acl']
  ]);
  assert.ok(candidate.warnings.some((warning) => /renamed standalone selection alias ipRange/.test(warning)));
  assert.ok(candidate.warnings.some((warning) => /renamed standalone selection alias acl/.test(warning)));
});

test('object flow migrates only Object Group aliases recorded in stored visual models', () => {
  const currentSpec = {
    version: 1,
    steps: [{ type: 'selectCards', className: 'OldAsset', as: 'oldAssets', filters: [], limit: 100 }],
    visualModel: {
      mode: 'objectGroup',
      selections: [{ alias: 'oldAssets', className: 'OldAsset', scopeRules: [{ action: 'include', path: 'Code', op: 'exists' }] }]
    },
    visualModels: [{
      mode: 'objectGroup',
      selections: [{ alias: 'oldAssets', className: 'OldAsset', scopeRules: [{ action: 'include', path: 'Code', op: 'exists' }] }]
    }],
    result: { tables: [{ name: 'oldAssets', columns: ['Code'] }] }
  };
  const nextFlow = {
    version: 1,
    selections: [{ alias: 'assets', className: 'Asset', rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
    operations: []
  };

  const compiled = compileObjectFlowToSpec(currentSpec, nextFlow);
  assert.deepEqual(compiled.steps.map((step) => step.as), ['assets']);
  assert.equal(compiled.result.tables.some((table) => table.name === 'oldAssets'), false);

  assert.throws(
    () => compileObjectFlowToSpec({
      version: 1,
      steps: [{ type: 'selectCards', className: 'OldAsset', as: 'assets', filters: [], limit: 100 }],
      result: { tables: [{ name: 'assets', columns: ['Code'] }] }
    }, nextFlow),
    (error) => error.code === 'object_flow_migration_required'
  );
});

test('object flow preserves a table publication selected in Extraction', () => {
  const compiled = compileObjectFlowToSpec({
    version: 1,
    steps: [],
    result: { tables: [{ name: 'assets', title: 'Assets', columns: ['Code'], published: true }] }
  }, {
    version: 1,
    selections: [{ alias: 'assets', className: 'Asset', rules: [{ action: 'include', path: 'Code', op: 'exists' }] }],
    operations: [],
    publishedAlias: ''
  });

  assert.equal(compiled.result.tables.find((table) => table.name === 'assets').published, true);
});

test('object flow does not publish the final operation when no alias is selected', () => {
  const flow = validFlow();
  const compiled = compileObjectFlowToSpec({ version: 1, steps: [], result: { tables: [] } }, flow);
  const objectMatching = compiled.visualModels.find((model) => model.mode === 'objectMatching');

  assert.equal(objectMatching.output.alias, '');
  assert.ok(objectMatching.outputs.every((output) => output.published === undefined));
  assert.equal(compiled.result.tables.some((table) => table.published), false);
});

test('candidate-filter feedback names the exact user result and explains an ambiguous field join', () => {
  const error = Object.assign(new Error('candidate filter unresolved'), {
    details: [{
      kind: 'deterministicCandidateRulesUnresolved',
      blockId: 'target-acl',
      blockName: 'ACL внутри target системы',
      candidateBlockId: 'all-acl',
      outputClass: 'ACL',
      candidateFields: ['ipaddress', 'dipaddress'],
      reason: 'между полями не указано явное И/ИЛИ'
    }]
  });

  const feedback = assistantSemanticPlanValidationFeedback(error);

  assert.match(feedback.summary, /ACL внутри target системы/);
  assert.match(feedback.summary, /фильтр кандидатов/);
  assert.match(feedback.action, /«или»/);
  assert.match(feedback.causes[0].message, /all-acl/);
  assert.deepEqual(feedback.affectedStages, [{ label: 'ACL внутри target системы', alias: 'target-acl' }]);
});
