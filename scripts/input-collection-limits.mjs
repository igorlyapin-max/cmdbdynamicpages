export const INPUT_COLLECTION_DEFAULT_LIMITS = Object.freeze({
  maxCollectionItems: 5_000,
  maxTotalItems: 50_000,
  d2MaxElements: 5_000
});

export const INPUT_COLLECTION_ABSOLUTE_LIMITS = Object.freeze({
  maxCollectionItems: 50_000,
  maxTotalItems: 500_000,
  d2MaxElements: 50_000
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize numeric configuration (including env strings), without reading env or logging. */
export function normalizeInputCollectionLimits(options = {}) {
  const source = isRecord(options) ? options : {};
  const effective = {};
  const meta = {};
  for (const [key, fallback] of Object.entries(INPUT_COLLECTION_DEFAULT_LIMITS)) {
    const raw = source[key];
    const absent = raw === undefined || raw === '';
    const requested = absent ? fallback
      : typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    const valid = Number.isFinite(requested) && Number.isInteger(requested) && requested > 0;
    const absolute = INPUT_COLLECTION_ABSOLUTE_LIMITS[key];
    effective[key] = valid ? Math.min(requested, absolute) : fallback;
    meta[key] = {
      requested: Number.isFinite(requested) ? requested : null,
      effective: effective[key],
      absolute,
      clampedBy: !valid ? 'default' : requested > absolute ? 'absolute' : null
    };
  }
  return { effective, meta };
}

// Edges name schema fields, not arbitrary payload keys. Arrays use [item kind, optional limit].
// Literal operands, params/defaults, rows/staticRows, catalog/Help, prompts and model output
// deliberately have no edges. Extend this graph when the authoring contract changes.
const SPEC_FIELDS = {
  steps: ['step'], visualModel: 'flow', visualModels: ['flow'],
  result: 'result', authoring: 'authoring'
};
const D2_FIELDS = {
  roles: ['role', 'd2MaxElements'], relationRules: ['mapping', 'd2MaxElements'],
  endpointProfiles: ['mapping', 'd2MaxElements'], structureTree: 'structureTree'
};
const FLOW_FIELDS = {
  selections: ['step'], operations: ['step'], blocks: ['step'], setOperations: ['step'],
  outputs: ['output'], assistantOutputManifest: 'manifest'
};
const SCHEMAS = {
  request: {
    currentSpec: 'editorSpec', spec: 'spec', SpecJson: 'spec', template: 'template',
    editorDelta: 'editorDelta', intent: 'intent', flow: 'flow', stages: ['step'],
    semanticPlan: 'semanticPlan', assistantOutputBindings: ['output'], assistantObjectFlowIntent: 'intent',
    ...D2_FIELDS, proposal: 'proposal', checkpoint: 'checkpoint',
    analysisCheckpoint: 'checkpoint', assistantCheckpoint: 'checkpoint'
  },
  template: { spec: 'spec', SpecJson: 'spec' },
  editorDelta: { spec: 'editorSpec' },
  spec: SPEC_FIELDS,
  editorSpec: SPEC_FIELDS,
  result: { tables: ['table'], diagrams: ['diagram'] },
  table: { columns: ['column'] },
  column: { columns: ['column'] },
  authoring: { assistant: 'assistant', d2: 'd2Authoring', d2Import: 'proposal' },
  assistant: { objectFlowIntent: 'intent' },
  d2Authoring: { analysisCheckpoint: 'checkpoint', assistantCheckpoint: 'checkpoint' },
  intent: { blocks: ['intentBlock', 32] },
  intentBlock: { uses: ['leaf', 31] },
  semanticPlan: { blocks: ['semanticBlock'] },
  semanticBlock: {
    dependencies: ['leaf'], resolvedEntities: ['leaf'], relationPaths: ['leaf'], resultContract: 'resultContract'
  },
  resultContract: {
    predicates: ['predicate'], dependencyPaths: ['predicate'], relationPredicates: ['predicate'], attributePredicates: ['predicate'],
    referencePathPredicates: ['predicate'], candidateFilter: 'predicate', pair: 'pair'
  },
  pair: { rules: ['leaf'] },
  predicate: {
    predicates: ['predicate'], sourceFields: ['leaf'], comparisonFields: ['leaf'],
    sourcePath: ['leaf'], hops: ['predicate'], sourceEndpoint: ['leaf'], targetEndpoint: ['leaf'],
    comparisonSource: 'predicate'
  },
  flow: FLOW_FIELDS,
  manifest: { blocks: ['output'] },
  output: { assistantBlockIds: ['leaf'] },
  step: {
    rules: ['condition'], filters: ['condition'], where: ['condition'], on: ['leaf'],
    columns: ['column'], fields: ['column'], cardColumns: ['column'], outputColumns: ['column'],
    column: ['leaf'], compareBy: ['leaf'], connection: 'mapping'
  },
  condition: {
    rules: ['condition'], filters: ['condition'], conditions: 'condition',
    // right.value and left.value are literal payload, even if they look like authoring JSON.
    and: ['condition'], or: ['condition'], not: 'condition'
  },
  proposal: {
    ...D2_FIELDS, structure: 'elements', ir: 'ir'
  },
  checkpoint: { ...D2_FIELDS, interpretation: 'interpretation', mapping: 'checkpointMapping' },
  interpretation: { decisions: ['role'] },
  checkpointMapping: { result: 'checkpointResult' },
  checkpointResult: {
    ...D2_FIELDS, spec: 'spec', flow: 'flow', mapping: 'checkpointResult',
    placements: ['mapping'], mappings: ['mapping'], items: ['mapping']
  },
  ir: { elements: 'elements' },
  structureTree: { items: ['structureItem', 'd2MaxElements'] },
  structureItem: { templateElementKeys: ['leaf'], mapping: 'mapping' },
  role: {
    templateElementKeys: ['leaf'], elementKeys: ['leaf'], classKeys: ['leaf'], containerKeys: ['leaf'],
    visualKindOptions: ['leaf'],
    mapping: 'mapping', mappings: ['mapping'], parentCorrelations: ['condition']
  },
  mapping: {
    rules: ['condition'], filters: ['condition'], columns: ['column'], structuredFields: ['leaf'],
    related: ['mapping'], primary: 'mapping', mapping: 'mapping', mappings: ['mapping'], path: ['mapping'],
    conditions: 'condition', hierarchyConditions: 'condition',
    endpointProfiles: ['mapping', 'd2MaxElements'], endpointResolution: 'mapping',
    labelFields: ['leaf'], dataProfile: 'dataProfile', d2Template: 'elements',
    templateElementKeys: ['leaf']
  },
  dataProfile: { fields: ['leaf'] },
  diagram: {
    nodeMappings: ['mapping'], edgeMappings: ['mapping'], groupMappings: ['mapping'], hierarchyMappings: ['mapping'],
    structureTree: 'structureTree', templateGrammar: 'grammar', authoring: 'authoring'
  },
  grammar: { elements: ['element'], roles: ['role', 'd2MaxElements'], edges: ['element'], contexts: ['element'] },
  elements: { nodes: ['element'], groups: ['element'], edges: ['element'], hierarchies: ['element'] },
  element: {
    childrenKeys: ['leaf'], groupKeys: ['leaf'], classKeys: ['leaf'], elementKeys: ['leaf'],
    pathSegments: ['leaf'], sourcePathSegments: ['leaf'], targetPathSegments: ['leaf'],
    parentPathSegments: ['leaf'], childPathSegments: ['leaf']
  },
  leaf: {}
};

const ARRAY_ROOTS = {
  roles: ['role', 'd2MaxElements'], relationRules: ['mapping', 'd2MaxElements'],
  endpointProfiles: ['mapping', 'd2MaxElements'], assistantOutputBindings: ['output', 'maxCollectionItems']
};

function collectionLimitError(path, actualCount, limit) {
  const error = new Error('Authoring input exceeds a structural collection limit.');
  error.statusCode = 413;
  error.code = 'input_collection_limit';
  error.details = { path, actualCount, limit };
  return error;
}

/**
 * Inspect only supported authoring envelopes. No normalization, deduplication or truncation.
 * limits accepts either raw options or normalizeInputCollectionLimits(options).
 * Invalid JSON/spec shapes remain the caller's validation responsibility.
 */
export function assertInputCollections(input, limits = {}, { rootKind = 'request' } = {}) {
  if (!Object.hasOwn(SCHEMAS, rootKind) && !Object.hasOwn(ARRAY_ROOTS, rootKind)) {
    throw new TypeError('Unsupported input collection rootKind.');
  }
  const effective = normalizeInputCollectionLimits(isRecord(limits) && isRecord(limits.effective) ? limits.effective : limits).effective;
  const arrayRoot = ARRAY_ROOTS[rootKind];
  const root = Object.hasOwn(ARRAY_ROOTS, rootKind)
    ? { value: input, kind: arrayRoot[0], path: '$', limit: effective[arrayRoot[1]] }
    : { value: input, kind: rootKind, path: '$' };
  const stack = [root];
  const ancestors = new WeakSet();
  let totalCount = 0;
  let collectionCount = 0;

  while (stack.length) {
    const frame = stack.pop();
    let { value } = frame;
    const { kind, path } = frame;
    if (frame.exit) {
      ancestors.delete(value);
      continue;
    }
    if (kind === 'spec' && typeof value === 'string') {
      try { value = JSON.parse(value); } catch { continue; }
    }
    if (value === null || typeof value !== 'object' || ancestors.has(value)) continue;
    if (Array.isArray(value) && frame.limit === undefined) continue;
    ancestors.add(value);
    stack.push({ value, exit: true });

    if (Array.isArray(value)) {
      const limit = frame.limit ?? effective.maxCollectionItems;
      if (value.length > limit) throw collectionLimitError(path, value.length, limit);
      totalCount += value.length;
      collectionCount += 1;
      if (totalCount > effective.maxTotalItems) {
        throw collectionLimitError(path, totalCount, effective.maxTotalItems);
      }
      // Keep raw occurrences: only active ancestors are skipped, not previously visited objects.
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const child = value[index];
        if (child !== null && typeof child === 'object') {
          stack.push({ value: child, kind, path: `${path}[${index}]`, limit: effective.maxCollectionItems });
        }
      }
      continue;
    }

    const schema = kind === 'request' && (Object.hasOwn(value, 'steps') || Object.hasOwn(value, 'version'))
      ? { ...SCHEMAS.request, ...SPEC_FIELDS }
      : SCHEMAS[kind];
    const fields = Object.entries(schema);
    for (let index = fields.length - 1; index >= 0; index -= 1) {
      const [key, edge] = fields[index];
      if (!Object.hasOwn(value, key)) continue;
      const child = value[key];
      if (Array.isArray(edge)) {
        const [itemKind, bound = 'maxCollectionItems'] = edge;
        const limit = typeof bound === 'number' ? bound : effective[bound];
        // Mapping lists and condition groups also support a singleton object.
        stack.push({ value: child, kind: itemKind, path: `${path}.${key}`, limit });
      } else if (!Array.isArray(child)) {
        stack.push({ value: child, kind: edge, path: `${path}.${key}` });
      }
    }
  }
  return { collectionCount, totalCount };
}
