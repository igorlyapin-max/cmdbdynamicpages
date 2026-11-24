import { createHash } from 'node:crypto';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';
import { buildResultDiagrams, executeSelectCards, validateTemplateSpec } from '../../scripts/dev-proxy-server.mjs';
import { runtimeRowValue } from '../../scripts/runtime-row-semantics.mjs';

export const PILOT_HOLDOUT_MODES = Object.freeze(['flow', 'mapping', 'end-to-end']);
export const PILOT_HOLDOUT_CASE_IDS = Object.freeze(['postal-address', 'postal-address-changed', 'postal-address-no-help']);
export const PILOT_HOLDOUT_PROVENANCE = 'simulated-local-runtime';

const [baseId, changedId, noHelpId] = PILOT_HOLDOUT_CASE_IDS;
const limits = { maxRows: 20, maxClasses: 20, maxSelectionScanRows: 20 };
const emptySpec = { version: 1, steps: [], result: { tables: [] } };
const emptyGraph = () => ({ displayedCards: [], placements: [], hierarchy: [], edges: [], labels: [] });
const reference = (name, targetClass) => ({ name, type: 'reference', targetClass });
const classes = [
  { name: 'City', attributes: [] },
  { name: 'Street', attributes: [reference('cityRef', 'City')] },
  { name: 'Building', attributes: [reference('refA', 'Street'), reference('refB', 'Street')] },
];
const places = [
  { id: 'city', className: 'City', blockId: 'cities', parentId: '', kind: 'container' },
  { id: 'street', className: 'Street', blockId: 'streets', parentId: 'city', kind: 'container' },
  { id: 'building', className: 'Building', blockId: 'buildings', parentId: 'street', kind: 'node' },
];
const flowRequest = 'Return cities, streets and one building/street row per postal address. Match the postal street by card ID, never by name or registered office. Exclude buildings without a postal street; retain all row fields and the matched street fields.';
const mappingRequest = 'Show each city and street as a container, with buildings under their postal street. A building without a postal street has no placement or edge. Draw a directed building-to-postal-street edge labeled Postal address. Use Description for card labels and IDs for placement and joins. Do not use the registered office as a fallback.';
const help = [
  'The address registry defines Street.cityRef as the owning City.',
  'The address registry defines Building.refA as the registered-office Street and Building.refB as the postal Street. Both can be null independently.',
];
const d2Source = `classes: {
  postal-link: {
    Notes: |md
      Connect a building to its postal street.
    |
  }
}
vars.data.cmdp.import.connections.postal-link.directionPolicy: dataFields
city: "City" {
  street: "Street" {
    building: "Building"
  }
}
city.street.building -> city.street: "Postal address" {class: postal-link}
`;

function checkCase(caseId, mode) {
  if (!PILOT_HOLDOUT_CASE_IDS.includes(caseId)) throw new RangeError(`Unknown pilot holdout case: ${caseId}`);
  if (!PILOT_HOLDOUT_MODES.includes(mode)) throw new RangeError(`Unknown pilot holdout mode: ${mode}`);
}

function card(_id, Code, Description, attributes = {}) {
  return { _id, Code, Description, ...attributes };
}

function cardsFor(caseId) {
  const changed = caseId === changedId;
  return {
    City: [card(11, 'CP', 'Northport'), card(12, 'CV', 'Westhaven')],
    Street: [card(21, 'S1', 'Main Street', { cityRef: 11 }), card(22, 'S2', changed ? 'Main Street' : 'Quay Road', { cityRef: 12 })],
    Building: [card(31, 'B1', 'Depot', { refA: 22, refB: changed ? null : 21 }),
      card(32, 'B2', 'Annex', { refA: changed ? null : 21, refB: 22 })],
  };
}

/** In-process CMDB read transport. There is deliberately no write or HTTP path. */
export function pilotHoldoutRead(caseId) {
  checkCase(caseId, 'flow');
  const cards = cardsFor(caseId);
  return async (path) => {
    const url = new URL(path, 'http://synthetic.invalid');
    const root = '/cmdbuild/services/rest/v3/classes';
    const match = url.pathname.match(/^\/cmdbuild\/services\/rest\/v3\/classes\/([A-Za-z]+)\/cards$/);
    const data = url.origin !== 'http://synthetic.invalid' ? null
      : url.pathname === root ? classes.map(({ name }) => ({ name, active: true }))
        : match && Object.hasOwn(cards, match[1]) ? cards[match[1]] : null;
    if (!data) throw new Error(`Unsupported holdout read: ${url.pathname}`);
    const offset = Number(url.searchParams.get('start') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? data.length);
    return { ok: true, statusCode: 200, json: { data: structuredClone(data.slice(offset, offset + limit)), meta: { total: data.length } } };
  };
}

function flowFor(postalField) {
  return {
    version: 1,
    selections: places.map(({ blockId, className }) => ({
      id: `selection:${blockId}`, name: blockId, alias: blockId, className, limit: limits.maxRows,
      ...(className === 'Building' && postalField
        ? { from: 'streets', rules: [{ action: 'include', path: postalField, op: 'equals', valueColumn: '_id' }] }
        : { rules: [{ action: 'include', path: 'Code', op: 'exists' }] }),
    })),
    operations: [],
    publishedAlias: 'buildings',
  };
}

function mappingFor(postalField) {
  const paths = ['city', 'city.street', 'city.street.building'];
  const placements = places.map(({ id, blockId, parentId, kind }) => ({
    id, from: blockId, fields: { id: '_id', label: 'Description' }, disableImplicitGroup: true,
    endpointProfiles: [{ id: `${id}-id`, structureItemId: id, field: '_id', operators: ['equals'] }],
    importRole: { key: id, structureItemId: id, visualKind: kind, materialization: 'stage',
      ...(parentId ? { parentStructureItemId: parentId, parentCorrelations: [{
        parentStructureItemId: parentId, childColumn: id === 'street' ? 'cityRef' : postalField,
        parentColumn: '_id', operator: 'equals',
      }] } : {}),
    },
  }));
  return {
    name: 'postal-directory',
    structureTree: { version: 5, items: places.map(({ id, parentId, blockId }, index) => ({
      id, roleId: id, parentId, templateContextKey: paths[index], templateElementKey: paths[index],
      templateElementKeys: [paths[index]], mapping: { materialization: { kind: 'stage', stageId: `selection:${blockId}` } },
    })) },
    groupMappings: placements.slice(0, 2),
    nodeMappings: placements.slice(2),
    edgeMappings: [{
      id: 'postal-link', type: 'attributeEndpoints', from: 'buildings',
      fields: { source: '_id', target: postalField },
      label: 'Postal address',
      endpointResolution: { strategy: 'comparisonRules', operator: 'equals', directionPolicy: 'dataFields' },
      importRole: { key: 'postal-link' },
    }],
  };
}

/** Reference implementation for offline checks only; never send it to a provider. */
export function compilePilotHoldoutSpec(caseId, mode) {
  checkCase(caseId, mode);
  if (caseId === noHelpId) return null;
  const spec = compileObjectFlowToSpec(emptySpec, flowFor(mode === 'mapping' ? null : 'refB'));
  if (mode !== 'flow') spec.result.diagrams = [mappingFor('refB')];
  return spec;
}

/** Export only this object as provider input. Mapping receives a neutral source Spec. */
export function pilotHoldoutInput(caseId, mode) {
  checkCase(caseId, mode);
  const request = mode === 'flow' ? flowRequest : mode === 'mapping' ? mappingRequest : `${flowRequest} ${mappingRequest}`;
  return structuredClone({
    request: `${request} Report unresolved if the postal street field cannot be established.`,
    blockIds: places.map(({ blockId }) => blockId),
    schema: { classes },
    ...(caseId !== noHelpId && { help }),
    ...(mode !== 'flow' && { diagram: { placements: places, connectionId: 'postal-link' } }),
    ...(mode === 'mapping' && { currentSpec: compileObjectFlowToSpec(emptySpec, flowFor(null)) }),
  });
}

/** Execute candidate Specs with production selection/diagram helpers, without the oracle. */
export async function executePilotHoldoutSpec(caseId, mode, spec) {
  checkCase(caseId, mode);
  const [error] = validateTemplateSpec(spec);
  if (error) throw new Error(`Invalid holdout Spec: ${error.path}: ${error.message}`);
  const read = pilotHoldoutRead(caseId);
  const context = Object.create(null);
  for (const step of spec.steps) {
    if (step.type !== 'selectCards') throw new Error(`Unsupported holdout step: ${step.type}`);
    const result = await executeSelectCards(read, step, {}, context, limits);
    if (result.truncated) throw new Error(`Truncated holdout step: ${step.as}`);
    context[step.as] = result;
  }
  const rows = mode === 'mapping' ? [] : spec.result.tables.flatMap(({ name }) =>
    context[name].rows.map((row) => ({ blockId: name,
      values: Object.fromEntries(Object.keys(row).map((key) => [key, runtimeRowValue(row, key)])),
    })));
  const graph = emptyGraph();
  if (mode !== 'flow') {
    const diagrams = buildResultDiagrams(spec, context, {}, limits);
    if (diagrams.length !== 1) throw new Error('Holdout requires one diagram.');
    const diagram = diagrams[0];
    if (diagram.truncated) throw new Error('Truncated holdout diagram.');
    for (const item of [...diagram.groups, ...diagram.nodes]) {
      const { id, importRole, data, label } = item;
      const card = data.sourceRef.id ? { className: data.sourceRef.className, id: data.sourceRef.id } : null;
      graph.placements.push({ id, structureItemId: importRole.structureItemId, card, cardSourceId: card ? 'current' : null });
      if (card) graph.displayedCards.push(card);
      const parent = item.parent || item.group;
      if (parent) graph.hierarchy.push({ parent, child: id });
      graph.labels.push({ targetId: id, text: label });
    }
    for (const edge of diagram.edges) {
      // Edge IDs here are pilot identities, not renderer hashes tied to row provenance.
      const id = `${edge.importRole.key}:${edge.source}:${edge.target}`;
      graph.edges.push({ id, from: edge.source, to: edge.target, direction: edge.direction || 'forward', label: edge.label });
      graph.labels.push({ targetId: id, text: edge.label });
    }
  }
  return { outcome: 'accepted', rows, graph };
}

// Hand-authored from the address-register facts and card IDs, not from execution.
export function pilotHoldoutOracle(caseId, mode) {
  checkCase(caseId, mode);
  if (caseId === noHelpId) return { outcome: 'unresolved', expectedStage: mode === 'mapping' ? 'mapping' : 'flow', rows: [], graph: emptyGraph() };
  const changed = caseId === changedId;
  const city1 = { Class: 'City', _id: 11, Code: 'CP', Description: 'Northport' };
  const city2 = { Class: 'City', _id: 12, Code: 'CV', Description: 'Westhaven' };
  const street1 = { Class: 'Street', _id: 21, Code: 'S1', Description: 'Main Street', cityRef: 11 };
  const street2 = { Class: 'Street', _id: 22, Code: 'S2', Description: changed ? 'Main Street' : 'Quay Road', cityRef: 12 };
  const depot = { Class: 'Building', _id: 31, Code: 'B1', Description: 'Depot', refA: 22, refB: 21 };
  const annex = { Class: 'Building', _id: 32, Code: 'B2', Description: 'Annex', refA: changed ? null : 21, refB: 22 };
  const buildingRow = (building, street) => ({ blockId: 'buildings', values: { ...building,
    Source_Class: street.Class, Source__id: street._id, Source_Code: street.Code, Source_Description: street.Description, Source_cityRef: street.cityRef,
  } });
  const rows = mode === 'mapping' ? [] : [
    { blockId: 'cities', values: city1 }, { blockId: 'cities', values: city2 },
    { blockId: 'streets', values: street1 }, { blockId: 'streets', values: street2 },
    ...(!changed ? [buildingRow(depot, street1)] : []), buildingRow(annex, street2),
  ];
  const graph = emptyGraph();
  if (mode !== 'flow') {
    const entries = [
      ['city:11', 'city', city1, ''], ['city:12', 'city', city2, ''],
      ['street:21', 'street', street1, 'city:11'], ['street:22', 'street', street2, 'city:12'],
      ...(!changed ? [['building:31', 'building', depot, 'street:21']] : []),
      ['building:32', 'building', annex, 'street:22'],
    ];
    for (const [id, structureItemId, row, parent] of entries) {
      const card = { className: row.Class, id: String(row._id) };
      graph.displayedCards.push(card);
      graph.placements.push({ id, structureItemId, card, cardSourceId: 'current' });
      graph.labels.push({ targetId: id, text: row.Description });
      if (parent) graph.hierarchy.push({ parent, child: id });
      if (structureItemId === 'building') {
        const edgeId = `postal-link:${id}:${parent}`;
        graph.edges.push({ id: edgeId, from: id, to: parent, direction: 'forward', label: 'Postal address' });
        graph.labels.push({ targetId: edgeId, text: 'Postal address' });
      }
    }
  }
  return { outcome: 'accepted', rows, graph };
}

export function createPilotHoldoutCase(caseId = baseId, mode = 'end-to-end') {
  return { id: caseId, mode, provenance: PILOT_HOLDOUT_PROVENANCE,
    input: pilotHoldoutInput(caseId, mode), oracle: pilotHoldoutOracle(caseId, mode) };
}

/** Scenario envelope for createPilotPlan; use only with offline-simulation evidence. */
export function createPilotHoldoutScenario(caseId = baseId) {
  checkCase(caseId, 'end-to-end');
  const spec = compileObjectFlowToSpec(emptySpec, flowFor(null));
  spec.authoring = {
    version: 1,
    assistant: {
      promptContractVersion: 4,
      objectFlowIntent: {
        context: 'Build a postal address directory. Report unresolved if the catalog does not establish the postal street field.',
        blocks: [
          { id: 'cities', name: 'Cities', description: 'Select City cards.', resultKind: 'sourceCards', uses: [] },
          { id: 'streets', name: 'Streets', description: 'Select Street cards.', resultKind: 'sourceCards', uses: [] },
          { id: 'buildings', name: 'Buildings', resultKind: 'sourceCards', uses: ['streets'],
            description: 'Select one Building card per known postal address using the Streets result. Join by card ID, not name or registered office. Exclude null postal streets and retain matched Street fields as source provenance.' },
        ],
      },
      diagramIntentPrompt: mappingRequest,
    },
    d2: { source: d2Source, sourceHash: createHash('sha256').update(d2Source).digest('hex') },
  };
  const knowledgeByBlock = caseId === noHelpId ? {} : {
    streets: [{ id: 'street.city', kind: 'referencePath', text: help[0] }],
    buildings: [{ id: 'building.street', kind: 'referencePath', text: help[1] }],
  };
  const authoredD2Source = d2Source.replace('      Connect a building to its postal street.',
    '      Connect a building to its postal street.\n      binding-result: Buildings');
  return {
    id: caseId, split: 'holdout', dataKind: 'synthetic', modes: [...PILOT_HOLDOUT_MODES],
    input: { spec, d2Source, authoredD2Source, knowledgeByBlock },
    oracle: caseId === noHelpId ? { ...pilotHoldoutOracle(caseId, 'end-to-end'),
      expectedStage: { flow: 'flow', mapping: 'mapping', 'end-to-end': 'flow' } } : pilotHoldoutOracle(caseId, 'end-to-end'),
  };
}
