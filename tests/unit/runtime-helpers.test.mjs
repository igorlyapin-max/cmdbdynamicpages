import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplateParamDefaults,
  assistantCandidateClassesFromSummary,
  assistantClassMentionsFromText,
  assistantDiagramSelectionMappings,
  assistantDiagramSemanticDecisions,
  assistantLimitWarningsFromDiagnostics,
  assistantMessages,
  assistantObjectFlowCandidate,
  assistantObjectFlowMessages,
  assistantSearchTermsFromText,
  assertDiagramImportProposal,
  buildResultCellMeta,
  buildResultDiagrams,
  createDiagramImportProposal,
  callLiteLLM,
  cmdbuildClassAttributesPath,
  d2RendererConfigSummary,
  d2CacheContext,
  d2ImportConfigSummary,
  embedDiagramSvgMetadata,
  diagramImportAssistantSpec,
  defaultRuntimeConfig,
  dependencyMapWithHash,
  extractAssistantDraftSpec,
  ipv4ValueMatches,
  isSafeRuntimeLinkUrl,
  mcpToolDefinitions,
  normalizeAssistantDraftSpec,
  normalizeAssistantRuntimeConfig,
  normalizeRuntimeCacheConfig,
  normalizeDiagramImportIr,
  normalizeTemplateCacheConfig,
  normalizeTemplateSpecForStorage,
  parseAssistantJson,
  renderCellTemplate,
  renderRuntimeParamTemplate,
  applyDiagramImportProposal,
  completeDiagramImportV3FromSpec,
  runtimeCacheKeyParts,
  runtimeD2OutputRequested,
  runtimeDisplayResponsePayload,
  runtimeJsonOutputRequested,
  runtimeJsonResponsePayload,
  sanitizeD2Svg,
  stripSensitiveDiagramArtifacts,
  sanitizeVisibleClassAttributes,
  templateIsProtected,
  validateTemplateSpec
} from '../../scripts/dev-proxy-server.mjs';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';

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

  const sanitized = sanitizeD2Svg('<?xml version="1.0"?><svg onclick="alert(1)"><script>alert(1)</script><foreignObject><body>Bad</body></foreignObject><style>@import url(http://evil)</style><animate attributeName="x"></animate><image href="https://evil.local/a.png"></image><a href="javascript:alert(1)"><text>Bad</text></a><a href="ftp://evil.local/a"><text>FTP</text></a><a href="/cmdbuild/ui/#classes/Server/cards/1" style="fill:#111"><text>Good</text></a><text style="background:url(https://evil.local/a.png)">Styled</text></svg>');
  assert.match(sanitized, /^<svg data-cmdp-d2-rendered="true"/);
  assert.doesNotMatch(sanitized, /<script|onclick|javascript:|ftp:\/\/evil|foreignObject|<style|<animate|<image|https:\/\/evil|url\(/i);
  assert.match(sanitized, /href="\/cmdbuild\/ui\/#classes\/Server\/cards\/1"/);
  assert.match(sanitized, /style="fill:#111"/);

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

test('D2 import rejects legacy proposal versions and requires re-analysis', () => {
  assert.throws(
    () => assertDiagramImportProposal({ version: 1 }, 'token'),
    (error) => error.code === 'diagram_import_proposal_version' && error.statusCode === 409
  );
});

test('D2 import maps reusable D2 classes instead of individual exemplar paths', () => {
  const currentSpec = selectionFlowSpec([{ alias: 'objects', className: 'ARM', columns: ['model', 'Location'] }]);
  const source = 'users: { operator: Operator { class: workstation }; administrator: Administrator { class: workstation } }';
  const ir = normalizeDiagramImportIr({
    version: 3,
    template: { title: 'Workplaces' },
    elements: {
      nodes: [
        { id: 'users.operator', label: 'Operator', parent: 'users', classKeys: ['workstation'] },
        { id: 'users.administrator', label: 'Administrator', parent: 'users', classKeys: ['workstation'] }
      ],
      groups: [{
        id: 'users',
        label: 'Users',
        children: ['users.operator', 'users.administrator'],
        style: { fill: '#FAFAFA', 'stroke-dash': '4' }
      }],
      hierarchy: [
        { id: 'users_operator', parent: 'users', child: 'users.operator' },
        { id: 'users_administrator', parent: 'users', child: 'users.administrator' }
      ]
    },
    classes: [{ key: 'workstation', usageKeys: ['users.operator', 'users.administrator'] }]
  }, source);
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: source });
  const workstation = proposal.roles.find((role) => role.key === 'workstation');
  const users = proposal.roles.find((role) => role.key === 'users');

  assert.ok(workstation);
  assert.ok(users);
  assert.equal(proposal.roles.some((role) => role.key === 'users.operator'), false);
  assert.equal(proposal.roles.some((role) => role.key === 'users.administrator'), false);
  assert.deepEqual(workstation.elementKeys, ['users.operator', 'users.administrator']);
  assert.equal(workstation.selectedSemantic, 'object');
  assert.equal(users.kind, 'untypedContainer');
  assert.equal(users.selectedSemantic, 'static');
  assert.deepEqual(proposal.unresolved, [{ id: workstation.id, family: 'roles', fields: ['source.stageId'] }]);
  assert.throws(() => applyDiagramImportProposal(currentSpec, proposal), (error) => error.code === 'diagram_import_unresolved');

  const relatedId = 'workstation_location';
  const roleOverrides = [{
    id: workstation.id,
    selectedSemantic: 'object',
    mapping: {
      source: { stageId: 'selection:objects', alias: 'objects', kind: 'selection', className: 'ARM' },
      primary: {
        className: 'ARM',
        idAttribute: '_id',
        labelTemplate: '${Code} ${Description}',
        structuredFields: ['Code', 'Description', 'model'],
        filters: []
      },
      related: [{
        id: relatedId,
        className: 'Location',
        path: [{ kind: 'reference', name: 'Location', domain: 'Location', targetClass: 'Location', direction: 'both' }],
        structuredFields: ['Code', 'Description']
      }]
    }
  }, {
    id: users.id,
    selectedSemantic: 'static',
    mapping: users.mapping
  }];
  const applied = applyDiagramImportProposal(currentSpec, proposal, roleOverrides, [], [{
    id: 'place_workstations',
    parentRoleId: users.id,
    childRoleId: workstation.id
  }]);
  const diagram = applied.result.diagrams[0];
  assert.equal(diagram.nodeMappings.length, 1);
  assert.equal(diagram.nodeMappings[0].importRole.key, 'workstation');
  assert.deepEqual(diagram.nodeMappings[0].dataProfile.fields, ['Code', 'Description', 'model', `${relatedId}.Code`, `${relatedId}.Description`]);
  assert.equal(diagram.groupMappings.length, 1);
  assert.equal(diagram.groupMappings[0].importRole.key, 'users');
  assert.equal(diagram.groupMappings[0].staticRows.length, 1);
  assert.equal(diagram.edgeMappings.length, 0);
  assert.equal(diagram.hierarchyMappings.length, 0);
  assert.equal(diagram.authoring.d2Import.version, 3);
  assert.deepEqual(diagram.authoring.d2Import.roles.map((role) => role.key).sort(), ['users', 'workstation']);
  assert.equal(diagram.placementRules[0].parentRoleKey, 'users');
  assert.equal(applied.steps.filter((step) => step.managedBy === 'd2ImportV3').length, 1);
  assert.equal(applied.steps.find((step) => step.type === 'selectCards').className, 'ARM');
  assert.equal(applied.steps.find((step) => step.type === 'expandRelations').domain, 'Location');
  assert.deepEqual(validateTemplateSpec(applied), []);

  const primaryAlias = 'objects';
  const relatedAlias = applied.steps.find((step) => step.type === 'expandRelations' && step.managedBy === 'd2ImportV3').as;
  const diagrams = buildResultDiagrams(applied, {
    [primaryAlias]: { rows: [{ _id: 'ARM-1', Code: 'ARM-1', Description: 'Operator', model: 'M1' }] },
    [relatedAlias]: { rows: [{ Root_SourceId: 'ARM-1', Code: 'ROOM-1', Description: 'Room 1' }] }
  }, {}, { maxRows: 100 });
  assert.equal(diagrams[0].nodes.length, 1);
  assert.equal(diagrams[0].groups.length, 1);
  assert.equal(diagrams[0].nodes[0].group, diagrams[0].groups[0].id);
  assert.equal(diagrams[0].nodes[0].data.fields[`${relatedId}.Code`].value, 'ROOM-1');
});

test('D2 class used by multiple containers requires an explicit exemplar', () => {
  const currentSpec = { version: 1, steps: [], result: { tables: [] } };
  const ir = normalizeDiagramImportIr({
    version: 3,
    elements: {
      groups: [
        { id: 'dmz', label: 'DMZ', classKeys: ['network-zone'] },
        { id: 'lan', label: 'LAN', classKeys: ['network-zone'] }
      ]
    },
    classes: [{ key: 'network-zone', usageKeys: ['dmz', 'lan'], containerCount: 2 }]
  }, 'dmz: { class: network-zone }\nlan: { class: network-zone }');
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: 'dmz: { class: network-zone }\nlan: { class: network-zone }' });
  const role = proposal.roles[0];
  assert.equal(role.key, 'network-zone');
  assert.equal(role.exemplarRequired, true);
  assert.equal(role.exemplarKey, '');
  assert.equal(proposal.unresolved.some((item) => item.id === role.id && item.fields.includes('exemplarKey')), true);
});

test('static D2 roles mapped to CMDBuild require a singleton filter', () => {
  const currentSpec = {
    version: 1,
    steps: [],
    result: { tables: [] }
  };
  const ir = normalizeDiagramImportIr({
    version: 3,
    elements: {
      nodes: [{ id: 'internet', label: 'Internet', classKeys: ['external-service'] }]
    },
    classes: [{ key: 'external-service', usageKeys: ['internet'] }]
  }, 'internet: Internet { class: external-service }');
  const proposal = createDiagramImportProposal(currentSpec, ir, { sourceText: 'internet: Internet { class: external-service }' });
  const role = proposal.roles[0];
  const mappedStatic = [{
    id: role.id,
    selectedSemantic: 'static',
    mapping: {
      primary: {
        className: 'ExternalService',
        idAttribute: '_id',
        labelTemplate: '${Description}',
        structuredFields: ['Code', 'Description'],
        filters: []
      }
    }
  }];
  assert.throws(
    () => applyDiagramImportProposal(currentSpec, proposal, mappedStatic),
    (error) => error.code === 'diagram_import_unresolved' && error.details.some((item) => item.fields.includes('primary.filters'))
  );
  mappedStatic[0].mapping.primary.filters = [{ path: 'Code', op: 'equals', value: 'internet' }];
  const applied = applyDiagramImportProposal(currentSpec, proposal, mappedStatic);
  assert.equal(applied.steps[0].limit, 2);
  assert.equal(applied.result.diagrams[0].nodeMappings[0].singleton, true);
});

test('D2 relation rules compile reference hops without domain metadata as source-driven selections', () => {
  const currentSpec = selectionFlowSpec([
    { alias: 'routers', className: 'routerG', columns: ['Location'] },
    { alias: 'rooms', className: 'Location' }
  ], [{
    id: 'match:matchedObjects2',
    from: 'routers',
    with: 'rooms',
    as: 'matchedObjects2',
    rightPrefix: 'Selection 2.',
    rules: [{ action: 'include', negate: false, operator: 'equals', leftColumn: 'Location', leftRegex: '', rightColumn: 'Description', rightRegex: '' }]
  }]);
  const source = 'router: Router { class: router-role }\nroom: Room { class: room-role }\nrouter -> room';
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 3,
    elements: {
      nodes: [
        { id: 'router', label: 'Router', classKeys: ['router-role'] },
        { id: 'room', label: 'Room', classKeys: ['room-role'] }
      ]
    },
    classes: [
      { key: 'router-role', usageCount: 1, sampleElementKeys: ['router'] },
      { key: 'room-role', usageCount: 1, sampleElementKeys: ['room'] }
    ]
  }, source), { sourceText: source });
  const routerRole = proposal.roles.find((role) => role.key === 'router-role');
  const roomRole = proposal.roles.find((role) => role.key === 'room-role');
  const mapping = (role, className, stageId, alias) => ({
    id: role.id,
    selectedSemantic: 'object',
    mapping: {
      source: { stageId, alias, kind: 'selection', className },
      primary: {
        className,
        idAttribute: '_id',
        labelTemplate: '${Description}',
        structuredFields: ['Code', 'Description'],
        filters: []
      },
      related: []
    }
  });
  const applied = applyDiagramImportProposal(currentSpec, proposal, [
    mapping(routerRole, 'routerG', 'selection:routers', 'routers'),
    mapping(roomRole, 'Location', 'selection:rooms', 'rooms')
  ], [{
    id: 'router_location',
    kind: 'connection',
    parentRoleId: routerRole.id,
    childRoleId: roomRole.id,
    path: [{ kind: 'reference', name: 'Location', targetClass: 'Location', direction: 'direct' }]
  }], []);

  const routerStep = applied.steps.find((step) => step.type === 'selectCards' && step.as === 'routers');
  const roomStep = applied.steps.find((step) => step.type === 'selectCards' && step.as === 'rooms');
  const ruleStep = applied.steps.find((step) => step.type === 'selectCards' && step.managedBy === 'd2ImportV3' && step.from === routerStep.as);
  assert.ok(ruleStep);
  assert.equal(routerStep.columns.some((column) => (typeof column === 'string' ? column : column.path) === 'Location'), true);
  assert.deepEqual(ruleStep.filters, [{ path: 'Description', op: 'equals', valueColumn: 'Location' }]);
  assert.deepEqual(applied.result.diagrams[0].edgeMappings[0].fields, { source: 'Root__id', target: '_id', label: 'Domain' });

  const diagrams = buildResultDiagrams(applied, {
    [routerStep.as]: { rows: [{ Class: 'routerG', _id: 'router-1', Code: 'R1', Description: 'Router 1', Location: 'Room 1' }] },
    [roomStep.as]: { rows: [{ Class: 'Location', _id: 'room-1', Code: 'ROOM1', Description: 'Room 1' }] },
    [ruleStep.as]: { rows: [{ Class: 'Location', _id: 'room-1', Code: 'ROOM1', Description: 'Room 1', Root__id: 'router-1' }] }
  }, {}, { maxRows: 100 });
  assert.equal(diagrams[0].nodes.length, 2);
  assert.equal(diagrams[0].edges.length, 1);
  assert.equal(diagrams[0].edges[0].source, diagrams[0].nodes.find((node) => node.businessId === 'router-1').id);
  assert.equal(diagrams[0].edges[0].target, diagrams[0].nodes.find((node) => node.businessId === 'room-1').id);
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

test('D2 v3 assistant context contains stable role-mapping skeleton without raw structure', () => {
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
  assert.equal(imported.roleMappings[0].roleId, proposal.roles[0].id);
  assert.equal(imported.source, undefined);
  assert.equal(imported.structure, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /secret-instance/);
});

test('D2 v3 assistant completion accepts exact role ids and preserves stable mapping ids', () => {
  const currentSpec = selectionFlowSpec([{ alias: 'switches', className: 'Switch' }]);
  const source = 'switch: Switch { class: network-switch }';
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 3,
    elements: { nodes: [{ id: 'switch', label: 'Switch', classKeys: ['network-switch'] }] },
    classes: [{ key: 'network-switch', usageCount: 1, sampleElementKeys: ['switch'] }]
  }, source), { sourceText: source });
  const role = proposal.roles[0];
  const unrelated = completeDiagramImportV3FromSpec(proposal, {
    result: { diagrams: [{ authoring: { d2Import: { version: 3, roleMappings: [{ roleId: 'wrong-role', primary: { className: 'Wrong' } }] } } }] }
  });
  assert.equal(unrelated.unresolved.length, 1);

  const completed = completeDiagramImportV3FromSpec(proposal, {
    steps: [{ type: 'selectCards', as: 'assistant_alias', className: 'Switch' }],
    result: { diagrams: [{ authoring: { d2Import: { version: 3, roleMappings: [{
      id: 'assistant-replaced-id',
      roleId: role.id,
      source: { stageId: 'selection:switches', alias: 'switches', kind: 'selection', className: 'Switch' },
      primary: {
        className: 'Switch',
        idAttribute: '_id',
        labelTemplate: '${Code} ${Description}',
        structuredFields: ['Code', 'Description'],
        filters: []
      },
      related: []
    }] } } }] }
  });
  assert.equal(completed.unresolved.length, 0);
  assert.equal(completed.roles[0].mapping.id, role.mapping.id);
  assert.equal(completed.roles[0].mapping.roleId, role.id);
  assert.equal(completed.roles[0].mapping.primary.className, 'Switch');
  assert.equal(completed.dslSteps, undefined);
});

test('typed D2 assistants keep exact role and object-flow stage ids', () => {
  const role = { id: 'role-workstation', options: ['object', 'static'] };
  const semanticSpec = {
    result: { diagrams: [{ authoring: { d2Import: { roles: [{ id: role.id, selectedSemantic: 'object', confidence: 'high', reason: 'Leaf class role' }] } } }] }
  };
  assert.deepEqual(assistantDiagramSemanticDecisions(semanticSpec, { roles: [role] }), [{
    roleId: role.id,
    semantic: 'object',
    confidence: 'high',
    reason: 'Leaf class role'
  }]);

  const mappingSpec = {
    result: { diagrams: [{ authoring: { d2Import: { roleMappings: [{
      roleId: role.id,
      source: { stageId: 'selection:workstations' },
      primary: { idAttribute: '_id', labelTemplate: '${Description}', structuredFields: ['Code', 'model', 'notAvailable'] }
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
  assert.deepEqual(mappings[0].source, { stageId: 'selection:workstations', alias: 'workstations', kind: 'selection', className: 'ARM' });
  assert.deepEqual(mappings[0].mapping.primary.structuredFields, ['Code', 'model']);
});

test('D2 import v3 compiles managed steps and never executes assistant-provided aliases', () => {
  const currentSpec = selectionFlowSpec([{ alias: 'switches', className: 'Switch' }]);
  const source = 'switch: Switch { class: network-switch }';
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 3,
    elements: { nodes: [{ id: 'switch', label: 'Switch', classKeys: ['network-switch'] }] },
    classes: [{ key: 'network-switch', usageCount: 1, sampleElementKeys: ['switch'] }]
  }, source), { sourceText: source });
  proposal.dslSteps = [
    { type: 'matchRows', as: 'joined', source: { alias: 'leftCards' }, right: 'rightCards', rules: [{ leftColumn: 'Code', rightColumn: 'SwitchCode' }] },
    { type: 'selectCards', as: 'leftCards', className: 'Switch' },
    { type: 'selectCards', as: 'rightCards', className: 'Port' }
  ];
  const role = proposal.roles[0];
  const applied = applyDiagramImportProposal(currentSpec, proposal, [{
    id: role.id,
    selectedSemantic: 'object',
    mapping: {
      source: { stageId: 'selection:switches', alias: 'switches', kind: 'selection', className: 'Switch' },
      primary: {
        className: 'Switch',
        idAttribute: '_id',
        labelTemplate: '${Description}',
        structuredFields: ['Code', 'Description'],
        filters: []
      }
    }
  }]);

  assert.deepEqual(applied.steps.map((step) => step.type), ['selectCards']);
  assert.equal(applied.steps[0].purpose, 'objectGroup');
  assert.equal(applied.steps[0].as, 'switches');
  assert.notEqual(applied.steps[0].as, 'leftCards');
  assert.notEqual(applied.steps[0].as, 'rightCards');
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
      prompt: 'Выборка 1: серверы. Выборка 2: IP. Соединяем по ссылке.',
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
  assert.match(messages[0].content, /"flow"/);
  assert.equal(messages[1].content, 'Custom common CMDB rule.');
  assert.equal(messages[2].content, 'Custom full-flow CMDB rule.');
  assert.match(messages[3].content, /Выборка 1/);
  assert.doesNotMatch(messages[3].content, /Custom full-flow CMDB rule/);
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
    action: 'include', path: 'Location', negate: false, op: 'equals', regex: '', value: '', valueParam: '', valueColumn: 'Location'
  });
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
