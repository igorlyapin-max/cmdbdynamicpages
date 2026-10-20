import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import dgram from 'node:dgram';

// Contract fixtures must never call CMDBuild, Redis, a renderer or an LLM.
const offline = () => { throw new Error('Network access forbidden in AA contract fixtures'); };
net.Socket.prototype.connect = offline;
dgram.Socket.prototype.send = offline;
globalThis.fetch = offline;
syncBuiltinESMExports();

const {
  assistantDataSemanticModel,
  assistantD2BindingModel,
  assistantDiagramModelBundle
} = await import('../../scripts/dev-proxy-server.mjs');

const catalog = {
  classes: [
    { name: 'Server', attributes: [
      { name: '_id', type: 'long' },
      { name: 'Code', type: 'string', description: 'Server code', help: 'Readable code' },
      { name: 'Application', type: 'reference', targetClass: 'Application', domain: 'Runs', direction: 'direct' },
      { name: 'Hidden', type: 'string', permissions: { _can_read: false } }
    ] },
    { name: 'Application', attributes: [
      { name: '_id', type: 'long' },
      { name: 'Description', type: 'string', description: 'Application description' }
    ] }
  ],
  domains: [{ name: 'Runs', source: 'Server', destination: 'Application', cardinality: 'N:N' }]
};
const stages = [
  {
    id: 'selection:servers', alias: 'servers', label: 'Servers', kind: 'selection',
    className: 'Server', stageRole: 'terminal', outputKind: 'sourceCards', rowGrain: 'card',
    columns: ['_id', 'Code'], assistantBlockIds: ['servers'],
    lineageAliases: ['servers'], lineageLabels: ['Servers'],
    rules: [{ path: 'Code', operator: 'equals', rightExpression: '${param.code}' }],
    cardSources: [{ id: 'current', label: 'Server', className: 'Server', classColumn: 'Class', idColumn: '_id' }]
  },
  {
    id: 'relation:applications', alias: 'applications', label: 'Applications', kind: 'connection',
    className: 'Application', from: 'servers', with: 'applications', operation: 'connect',
    stageRole: 'helper', outputKind: 'relationPairs', rowGrain: 'pair',
    domain: 'Runs', direction: 'direct', targetClass: 'Application',
    columns: ['SourceId', 'TargetId'],
    rules: [{ path: 'Description', operator: 'equals', rightExpression: '${servers.Code}', negate: true }],
    relationSource: { className: 'Server', domain: 'Runs', direction: 'direct', structuredFields: ['Code'] },
    connection: { fromClass: 'Server', withClass: 'Application', sourceField: 'SourceId', targetField: 'TargetId' },
    cardSources: [
      { id: 'source', label: 'Server', className: 'Server', classColumn: 'SourceClass', idColumn: 'SourceId' },
      { id: 'target', label: 'Application', className: 'Application', classColumn: 'TargetClass', idColumn: 'TargetId' }
    ]
  }
];
const roles = [
  { id: 'frame', displayName: 'Frame', kind: 'container', visualKind: 'container', isContainer: true, elementKeys: ['frame'] },
  { id: 'server', displayName: 'Server', kind: 'node', visualKind: 'node', elementKeys: ['frame.server'], labelTemplate: '${Code}' }
];
const placements = [
  { structureItemId: 'frame', roleId: 'frame', visualKind: 'container',
    roleNotes: 'materialization: stage', placementNotes: 'materialization: structural',
    notes: 'materialization: stage\n\nmaterialization: structural', allowedMaterialization: ['structural'] },
  { structureItemId: 'server', roleId: 'server', visualKind: 'node', parentStructureItemId: 'frame',
    placementNotes: 'Only selected servers.', notes: 'Only selected servers.', allowedMaterialization: ['stage'] },
  { structureItemId: 'missing', roleId: 'server', visualKind: 'node', notes: 'An unresolved placement.' },
  { structureItemId: 'conflict', roleId: 'server', visualKind: 'node', notes: 'materialization: stage\nmaterialization: structural' }
];
const condition = (right) => ({
  ruleJoin: 'all',
  rules: [{ action: 'include', negate: false, operator: 'equals', left: { column: 'Code' }, right }]
});
const items = [
  { structureItemId: 'frame', roleId: 'frame', mapping: { materialization: { kind: 'structural' } } },
  { structureItemId: 'server', roleId: 'server',
    source: { stageId: 'selection:servers', className: 'Server' },
    mapping: {
      materialization: { kind: 'stage', stageId: 'selection:servers' },
      primary: { cardSource: { id: 'current' }, labelTemplate: '${Code}' },
      conditions: condition({ kind: 'param', name: 'code' }),
      hierarchyConditions: condition({ kind: 'stage', stageId: 'selection:servers', column: 'Code' })
    } }
];
const relationRules = [{
  d2ElementKey: 'frame.server -> frame.application', d2ClassKey: 'runs',
  sourceStageId: 'relation:applications', mode: 'attributeEndpoints',
  sourceField: 'SourceId', targetField: 'TargetId', sourceOperator: 'equals', targetOperator: 'in',
  labelTemplate: '${Description}', endpointScopeStructureItemId: 'frame',
  d2Notes: 'endpoint-scope: frame', directionPolicy: 'direct', supportedModes: ['attributeEndpoints'], exampleLabels: ['Runs']
}];
const data = assistantDataSemanticModel(stages, catalog, { depth: 2 });
const input = {
  kind: 'mapping', stages, roles, placements, relationRules, dataSemanticModel: data,
  businessBlockManifest: { blocks: [{ id: 'servers', status: 'ready', description: 'Select servers.' }] }
};
const draft = { items, relationRules };
const mapping = {
  status: 'partial', requiredRoles: 3, mappedRoles: 1, requiredContainers: 1,
  mappedContainers: 1, staticPlacements: 0, requiredConnections: 1, mappedConnections: 1,
  unresolved: [{ code: 'unresolved', structureItemId: 'missing', message: 'No mapping' }]
};

process.stdout.write(JSON.stringify({
  data,
  binding: assistantD2BindingModel(items, relationRules),
  truncatedData: assistantDataSemanticModel(stages, catalog, { depth: 2, maxBytes: 1 }),
  missingClassData: assistantDataSemanticModel([{ id: 'missing', className: 'Unavailable' }], catalog),
  mapping: assistantDiagramModelBundle(input, draft, mapping),
  interpretation: assistantDiagramModelBundle({ ...input, kind: 'interpretation' }, { items: [{ roleId: 'server', visualKind: 'node', labelTemplate: '${Code}', reason: 'Server label' }] }),
  emptyMapping: assistantDiagramModelBundle({ kind: 'mapping' }),
  emptyInterpretation: assistantDiagramModelBundle({ kind: 'interpretation' })
}));
