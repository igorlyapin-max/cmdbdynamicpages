// @ts-check

/** @typedef {'include' | 'exclude'} ObjectFlowRuleAction */
/**
 * @typedef {object} ObjectFlowSelectionRule
 * @property {ObjectFlowRuleAction | string} action
 * @property {string} path
 * @property {boolean} negate
 * @property {string} op
 * @property {string} regex
 * @property {string} value
 * @property {string} valueParam
 * @property {string} valueColumn
 */
/**
 * @typedef {object} ObjectFlowSelection
 * @property {string} id
 * @property {string} name
 * @property {string} alias
 * @property {string} className
 * @property {string} from
 * @property {number} limit
 * @property {string[]} columns
 * @property {ObjectFlowSelectionRule[]} rules
 */
/**
 * @typedef {object} ObjectFlowMatchRule
 * @property {ObjectFlowRuleAction | string} action
 * @property {boolean} negate
 * @property {string} operator
 * @property {string} leftColumn
 * @property {string} leftRegex
 * @property {string} rightColumn
 * @property {string} rightRegex
 */
/**
 * @typedef {object} ObjectFlowMatchBlock
 * @property {string} id
 * @property {string} from
 * @property {string} with
 * @property {string} as
 * @property {string} rightPrefix
 * @property {ObjectFlowMatchRule[]} rules
 */
/**
 * @typedef {object} ObjectFlowSetOperation
 * @property {string} id
 * @property {string} type
 * @property {string} from
 * @property {string} with
 * @property {string} as
 * @property {Array<{left: string, right: string}>} on
 * @property {boolean} distinct
 * @property {boolean} caseSensitive
 */
/**
 * @typedef {object} ObjectFlowRelationOperation
 * @property {string} id
 * @property {'relation'} type
 * @property {string} from
 * @property {string} as
 * @property {string} domain
 * @property {string} targetClass
 * @property {'both' | 'source' | 'destination' | 'direct' | 'inverse'} direction
 * @property {string[]} columns
 * @property {number} limit
 * @property {boolean} distinct
 */
/**
 * A relation-aware semi-join. It retains cards from `from` only where at
 * least one related card satisfies a rule against a row from `with`.
 *
 * @typedef {object} ObjectFlowExistsRelatedOperation
 * @property {string} id
 * @property {'existsRelated'} type
 * @property {string} from
 * @property {string} with
 * @property {string} as
 * @property {string} domain
 * @property {string} targetClass
 * @property {'both' | 'source' | 'destination' | 'direct' | 'inverse'} direction
 * @property {string[]} columns
 * @property {number} limit
 * @property {boolean} distinct
 * @property {ObjectFlowMatchRule[]} rules
 */
/**
 * @typedef {(ObjectFlowMatchBlock & {type: 'match'}) | ObjectFlowSetOperation | ObjectFlowRelationOperation | ObjectFlowExistsRelatedOperation} ObjectFlowOperation
 */
/**
 * @typedef {object} ObjectFlow
 * @property {number} version
 * @property {ObjectFlowSelection[]} selections
 * @property {ObjectFlowOperation[]} operations
 * @property {ObjectFlowMatchBlock[]} blocks
 * @property {ObjectFlowSetOperation[]} setOperations
 * @property {string} publishedAlias
 */
/**
 * @typedef {object} ObjectFlowValidationError
 * @property {string} path
 * @property {string} message
 */
/**
 * @typedef {object} ObjectFlowStageSummary
 * @property {string} id
 * @property {'selection' | 'match' | 'set' | 'relation' | 'existsRelated'} kind
 * @property {string} alias
 * @property {string=} className
 * @property {string[]} columns
 */
/**
 * @typedef {object} ObjectFlowResultOutput
 * @property {string} alias
 * @property {string} label
 * @property {'selection' | 'match' | 'set' | 'relation' | 'existsRelated'} kind
 * @property {boolean} published
 * @property {boolean=} assistantManaged
 * @property {string=} assistantBlockId
 * @property {string[]=} assistantBlockIds
 */

/**
 * Persisted ownership catalog for an Assistant-authored Object Flow. Outputs
 * remain in objectMatching.outputs; this catalog makes their owners available
 * after save/reload without depending on the editable prompt draft.
 *
 * @typedef {object} AssistantOutputManifest
 * @property {number} version
 * @property {Array<{id: string, name: string, order: number}>} blocks
 * @property {{blockId: string, alias: string}=} extractionCandidate
 */

/**
 * @typedef {object} ObjectFlowOutputMetadata
 * @property {string} alias
 * @property {string} label
 * @property {string=} assistantBlockId
 * @property {string[]=} assistantBlockIds
 */

const BASE_RESULT_COLUMNS = ['Class', '_id', 'Code', 'Description'];
const ACTIONS = ['include', 'exclude'];
const SELECTION_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'exists',
  'notExists',
  'matches',
  'notMatches',
  'isIpv4',
  'isIpv4Network',
  'ipv4InCidr',
  'ipv4InRange',
  'ipv4CidrOverlaps',
  'ipv4CidrContains'
];
const MATCH_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'regexMatch',
  'ipv4InCidr',
  'ipv4InRange',
  'ipv4CidrOverlaps',
  'ipv4CidrContains'
];
const VALUELESS_SELECTION_OPERATORS = new Set(['exists', 'notExists', 'isIpv4', 'isIpv4Network']);
const REGEX_SELECTION_OPERATORS = new Set(['matches', 'notMatches']);
const MANAGED_PURPOSES = new Set(['objectGroup', 'objectMatching']);
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SELECTION_ID_PATTERN = /^selection:[A-Za-z_][A-Za-z0-9_]*$/;
const MATCH_ID_PATTERN = /^match:[A-Za-z_][A-Za-z0-9_]*$/;
const SET_OPERATION_ID_PATTERN = /^set:[A-Za-z_][A-Za-z0-9_]*$/;
const RELATION_OPERATION_ID_PATTERN = /^relation:[A-Za-z_][A-Za-z0-9_]*$/;
const EXISTS_RELATED_OPERATION_ID_PATTERN = /^existsRelated:[A-Za-z_][A-Za-z0-9_]*$/;
const SET_OPERATION_TYPES = new Set(['union', 'difference', 'intersect']);
const RELATION_DIRECTIONS = new Set(['both', 'source', 'destination', 'direct', 'inverse']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return /** @type {T} */ (value.map((item) => cloneJsonValue(item)));
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneJsonValue(item);
    return /** @type {T} */ (copy);
  }
  return value;
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  /** @type {string[]} */
  const result = [];
  for (const value of values) {
    const item = text(value);
    if (item && !result.includes(item)) result.push(item);
  }
  return result;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeColumns(value) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function normalizeBoolean(value) {
  if (value === true) return true;
  const normalized = text(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === '!';
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowSelectionRule}
 */
function normalizeSelectionRule(value) {
  const rule = isRecord(value) ? value : {};
  const regex = text(rule.regex);
  const valueText = text(rule.value);
  const operator = text(rule.op) || (Object.prototype.hasOwnProperty.call(rule, 'regex') ? 'matches' : 'equals');
  return {
    action: text(rule.action) || 'include',
    path: text(rule.path),
    negate: normalizeBoolean(rule.negate),
    op: operator,
    regex,
    value: valueText,
    valueParam: text(rule.valueParam),
    valueColumn: text(rule.valueColumn)
  };
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {ObjectFlowSelection}
 */
function normalizeSelection(value, index) {
  const selection = isRecord(value) ? value : {};
  const alias = text(selection.alias);
  const requestedLimit = selection.limit === undefined || selection.limit === null || selection.limit === ''
    ? 100
    : Number(selection.limit);
  const rules = Array.isArray(selection.rules) ? selection.rules.map(normalizeSelectionRule) : [];
  return {
    id: text(selection.id) || `selection:${alias}`,
    name: text(selection.name) || `Selection ${index + 1}`,
    alias,
    className: text(selection.className),
    from: text(selection.from),
    limit: requestedLimit,
    columns: normalizeColumns(selection.columns),
    rules
  };
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowMatchRule}
 */
function normalizeMatchRule(value) {
  const rule = isRecord(value) ? value : {};
  return {
    action: text(rule.action) || 'include',
    negate: normalizeBoolean(rule.negate),
    operator: text(rule.operator) || 'equals',
    leftColumn: text(rule.leftColumn),
    leftRegex: text(rule.leftRegex),
    rightColumn: text(rule.rightColumn),
    rightRegex: text(rule.rightRegex)
  };
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowMatchBlock}
 */
function normalizeMatchBlock(value) {
  const block = isRecord(value) ? value : {};
  const outputAlias = text(block.as);
  const rightAlias = text(block.with);
  return {
    id: text(block.id) || `match:${outputAlias}`,
    from: text(block.from),
    with: rightAlias,
    as: outputAlias,
    rightPrefix: text(block.rightPrefix) || `${rightAlias}_`,
    rules: Array.isArray(block.rules) ? block.rules.map(normalizeMatchRule) : []
  };
}

/**
 * @param {unknown} value
 * @returns {Array<{left: string, right: string}>}
 */
function normalizeSetOperationKeys(value) {
  const source = Array.isArray(value) ? value : [value];
  const keys = [];
  for (const item of source) {
    if (typeof item === 'string' && text(item)) {
      keys.push({ left: text(item), right: text(item) });
      continue;
    }
    if (Array.isArray(item) && item.length >= 2) {
      keys.push({ left: text(item[0]), right: text(item[1]) });
      continue;
    }
    if (isRecord(item)) {
      keys.push({ left: text(item.left || item.leftColumn || item.from || item.column), right: text(item.right || item.rightColumn || item.with || item.column) });
    }
  }
  return keys.filter((item) => item.left && item.right);
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowSetOperation}
 */
function normalizeSetOperation(value) {
  const operation = isRecord(value) ? value : {};
  const as = text(operation.as || operation.alias || operation.outputAlias);
  const type = text(operation.type || operation.operation).toLowerCase() || 'union';
  return {
    id: text(operation.id) || `set:${as}`,
    // Keep a supplied unknown type intact so deterministic validation rejects
    // it instead of silently changing the requested set operation to union.
    type,
    from: text(operation.from || operation.leftAlias || operation.leftSource),
    with: text(operation.with || operation.rightAlias || operation.rightSource),
    as,
    on: normalizeSetOperationKeys(operation.on || operation.keys),
    distinct: operation.distinct !== false,
    caseSensitive: normalizeBoolean(operation.caseSensitive)
  };
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowRelationOperation}
 */
function normalizeRelationOperation(value) {
  const operation = isRecord(value) ? value : {};
  const as = text(operation.as || operation.alias || operation.outputAlias);
  const rawLimit = operation.limit === undefined || operation.limit === null || operation.limit === '' ? 100 : Number(operation.limit);
  return {
    id: text(operation.id) || `relation:${as}`,
    type: 'relation',
    from: text(operation.from || operation.sourceAlias || operation.source),
    as,
    domain: text(operation.domain || operation.domainName || operation.domainCode),
    targetClass: text(operation.targetClass || operation.className || operation.target),
    direction: /** @type {ObjectFlowRelationOperation['direction']} */ (text(operation.direction).toLowerCase() || 'both'),
    columns: normalizeColumns(operation.columns || operation.relatedColumns || operation.attributes),
    limit: rawLimit,
    distinct: operation.distinct !== false
  };
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowExistsRelatedOperation}
 */
function normalizeExistsRelatedOperation(value) {
  const operation = isRecord(value) ? value : {};
  const as = text(operation.as || operation.alias || operation.outputAlias);
  const rawLimit = operation.limit === undefined || operation.limit === null || operation.limit === '' ? 100 : Number(operation.limit);
  return {
    id: text(operation.id) || `existsRelated:${as}`,
    type: 'existsRelated',
    from: text(operation.from || operation.sourceAlias || operation.source),
    with: text(operation.with || operation.comparisonAlias || operation.comparisonSource),
    as,
    domain: text(operation.domain || operation.domainName || operation.domainCode),
    targetClass: text(operation.targetClass || operation.className || operation.target),
    direction: /** @type {ObjectFlowExistsRelatedOperation['direction']} */ (text(operation.direction).toLowerCase() || 'both'),
    columns: normalizeColumns(operation.columns || operation.relatedColumns || operation.attributes),
    limit: rawLimit,
    distinct: operation.distinct !== false,
    rules: Array.isArray(operation.rules) ? operation.rules.map(normalizeMatchRule) : []
  };
}

/**
 * Normalize an ordered data-flow operation. Older flows keep their separate
 * blocks/setOperations arrays and are converted by normalizeObjectFlow.
 *
 * @param {unknown} value
 * @returns {ObjectFlowOperation}
 */
function normalizeOperation(value) {
  const operation = isRecord(value) ? value : {};
  const type = text(operation.type || operation.operation).toLowerCase();
  if (type === 'match' || (!type && (Array.isArray(operation.rules) || operation.rightPrefix !== undefined))) {
    return { ...normalizeMatchBlock(operation), type: 'match' };
  }
  if (type === 'relation' || type === 'expandrelation' || type === 'expandrelations') return normalizeRelationOperation(operation);
  if (type === 'existsrelated' || type === 'existsrelatedrows') return normalizeExistsRelatedOperation(operation);
  return normalizeSetOperation(operation);
}

/**
 * Convert JSON object-flow input into the canonical version 1 shape. Existing
 * non-empty ids are retained so validation can report stale or conflicting ids.
 *
 * @param {unknown} flow
 * @returns {ObjectFlow}
 */
export function normalizeObjectFlow(flow) {
  const source = isRecord(flow) ? flow : {};
  const version = source.version === undefined ? 1 : Number(source.version);
  const operations = Array.isArray(source.operations)
    ? source.operations.map(normalizeOperation)
    : [
      ...(Array.isArray(source.blocks) ? source.blocks.map((block) => ({ ...normalizeMatchBlock(block), type: 'match' })) : []),
      ...(Array.isArray(source.setOperations) ? source.setOperations.map(normalizeSetOperation) : [])
    ];
  return {
    version,
    selections: Array.isArray(source.selections)
      ? source.selections.map((selection, index) => normalizeSelection(selection, index))
      : [],
    operations,
    blocks: operations.filter((operation) => operation.type === 'match'),
    setOperations: operations.filter((operation) => SET_OPERATION_TYPES.has(operation.type)),
    publishedAlias: text(source.publishedAlias || source.tableOutputAlias)
  };
}

/**
 * @param {ObjectFlowValidationError[]} errors
 * @param {string} path
 * @param {string} message
 */
function addError(errors, path, message) {
  errors.push({ path, message });
}

/**
 * @typedef {{kind: 'selection' | 'operation', item: ObjectFlowSelection | ObjectFlowOperation, index: number, path: string, alias: string, dependencies: string[]}} ObjectFlowStage
 */

/**
 * Object-flow JSON keeps selections and operations in separate arrays for the
 * editor, while runtime execution must respect the actual data dependencies.
 * A selection may therefore be driven by a relation/match result.
 *
 * @param {ObjectFlow} flow
 * @returns {ObjectFlowStage[]}
 */
function objectFlowStages(flow) {
  return [
    ...flow.selections.map((selection, index) => ({
      kind: /** @type {'selection'} */ ('selection'),
      item: selection,
      index,
      path: `$.selections[${index}]`,
      alias: selection.alias,
      dependencies: selection.from ? [selection.from] : []
    })),
    ...flow.operations.map((operation, index) => ({
      kind: /** @type {'operation'} */ ('operation'),
      item: operation,
      index,
      path: `$.operations[${index}]`,
      alias: operation.as,
      dependencies: uniqueStrings([operation.from, operation.type === 'relation' ? '' : operation.with])
    }))
  ];
}

/**
 * @param {ObjectFlow} flow
 * @returns {{ordered: ObjectFlowStage[], unresolved: ObjectFlowStage[]}}
 */
function orderedObjectFlowStages(flow) {
  const pending = objectFlowStages(flow);
  const materialized = new Set();
  /** @type {ObjectFlowStage[]} */
  const ordered = [];
  while (pending.length) {
    const index = pending.findIndex((stage) => stage.dependencies.every((alias) => materialized.has(alias)));
    if (index < 0) break;
    const [stage] = pending.splice(index, 1);
    ordered.push(stage);
    if (stage.alias) materialized.add(stage.alias);
  }
  return { ordered, unresolved: pending };
}

/**
 * @param {ObjectFlowOperation} operation
 * @param {Map<string, string[]>} materializedColumns
 * @returns {string[]}
 */
function operationOutputColumns(operation, materializedColumns) {
  const leftColumns = materializedColumns.get(operation.from) || [];
  const rightColumns = materializedColumns.get(operation.with) || [];
  if (operation.type === 'relation') {
    return uniqueStrings([
      'SourceClass', 'SourceId', 'SourceCode', 'SourceDescription',
      'Domain', 'RelationId', 'RelationDirection', 'RelationSourceSide',
      'RelatedClass', 'RelatedId'
    ].concat(BASE_RESULT_COLUMNS, operation.columns));
  }
  if (operation.type === 'match') {
    return uniqueStrings(leftColumns.concat(rightColumns.map((column) => `${operation.rightPrefix}${column}`)));
  }
  if (operation.type === 'existsRelated') return leftColumns.slice();
  return operation.type === 'union' ? uniqueStrings(leftColumns.concat(rightColumns)) : leftColumns.slice();
}

/**
 * Validate canonical object-flow topology and rule contracts. Omitted ids are
 * accepted because validation runs after canonical normalization.
 *
 * @param {unknown} flow
 * @returns {ObjectFlowValidationError[]}
 */
export function validateObjectFlow(flow) {
  /** @type {ObjectFlowValidationError[]} */
  const errors = [];
  if (!isRecord(flow)) {
    addError(errors, '$', 'Object flow must be an object.');
    return errors;
  }

  const normalized = normalizeObjectFlow(flow);
  if (normalized.version !== 1) {
    addError(errors, '$.version', 'Object flow version must be 1.');
  }
  if (!normalized.selections.length) {
    addError(errors, '$.selections', 'Object flow requires at least one selection.');
  }

  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @type {Map<string, string>} */
  const aliases = new Map();
  /** @type {Map<string, string>} */
  const declaredAliases = new Map();
  /** @type {Map<string, number>} */
  const selectionAliasIndexes = new Map();
  /** @type {Map<string, number>} */
  const operationAliasIndexes = new Map();
  const matchingColumns = collectMatchingSelectionColumns(normalized);

  normalized.selections.forEach((selection, index) => {
    if (!selection.alias || !IDENTIFIER_PATTERN.test(selection.alias)) return;
    if (!declaredAliases.has(selection.alias)) declaredAliases.set(selection.alias, `$.selections[${index}]`);
    if (!selectionAliasIndexes.has(selection.alias)) selectionAliasIndexes.set(selection.alias, index);
  });
  normalized.operations.forEach((operation, index) => {
    if (!operation.as || !IDENTIFIER_PATTERN.test(operation.as)) return;
    if (!declaredAliases.has(operation.as)) declaredAliases.set(operation.as, `$.operations[${index}]`);
    if (!operationAliasIndexes.has(operation.as)) operationAliasIndexes.set(operation.as, index);
  });

  normalized.selections.forEach((selection, index) => {
    const path = `$.selections[${index}]`;
    if (!SELECTION_ID_PATTERN.test(selection.id)) {
      addError(errors, `${path}.id`, 'Selection id must be a stable selection:<identifier> value.');
    }
    if (ids.has(selection.id)) {
      addError(errors, `${path}.id`, `Object flow id must be unique; already used at ${ids.get(selection.id)}.`);
    } else {
      ids.set(selection.id, `${path}.id`);
    }
    if (!selection.alias || !IDENTIFIER_PATTERN.test(selection.alias)) {
      addError(errors, `${path}.alias`, 'Selection alias must be a non-empty identifier.');
    } else if (aliases.has(selection.alias)) {
      addError(errors, `${path}.alias`, `Object flow alias must be unique; already used at ${aliases.get(selection.alias)}.`);
    } else {
      aliases.set(selection.alias, `${path}.alias`);
    }
    if (selection.from) {
      const sourceSelectionIndex = selectionAliasIndexes.get(selection.from);
      if (sourceSelectionIndex !== undefined && sourceSelectionIndex >= index) {
        addError(errors, `${path}.from`, 'Selection from must reference an earlier selection or an operation output.');
      } else if (sourceSelectionIndex === undefined && !operationAliasIndexes.has(selection.from)) {
        addError(errors, `${path}.from`, 'Selection from must reference a declared materialized alias.');
      }
    }
    if (!selection.className || !CLASS_NAME_PATTERN.test(selection.className)) {
      addError(errors, `${path}.className`, 'Selection className must be a CMDBuild identifier.');
    }
    if (!Number.isInteger(selection.limit) || selection.limit <= 0) {
      addError(errors, `${path}.limit`, 'Selection limit must be a positive integer.');
    }
    if (!selection.rules.length) {
      addError(errors, `${path}.rules`, 'Selection requires a non-empty rules array.');
    }
    selection.rules.forEach((rule, ruleIndex) => {
      const rulePath = `${path}.rules[${ruleIndex}]`;
      if (!ACTIONS.includes(rule.action)) {
        addError(errors, `${rulePath}.action`, 'Selection rule action must be include or exclude.');
      }
      if (!rule.path) {
        addError(errors, `${rulePath}.path`, 'Selection rule requires path.');
      }
      if (!SELECTION_OPERATORS.includes(rule.op)) {
        addError(errors, `${rulePath}.op`, `Selection rule op must be one of: ${SELECTION_OPERATORS.join(', ')}.`);
      }
    });
  });

  normalized.operations.forEach((operation, index) => {
    const path = `$.operations[${index}]`;
    const isMatch = operation.type === 'match';
    const isRelation = operation.type === 'relation';
    const isExistsRelated = operation.type === 'existsRelated';
    const idPattern = isMatch ? MATCH_ID_PATTERN : isRelation ? RELATION_OPERATION_ID_PATTERN : isExistsRelated ? EXISTS_RELATED_OPERATION_ID_PATTERN : SET_OPERATION_ID_PATTERN;
    if (!idPattern.test(operation.id)) {
      addError(errors, `${path}.id`, isMatch
        ? 'Match id must be a stable match:<identifier> value.'
        : isRelation
          ? 'Relation id must be a stable relation:<identifier> value.'
          : isExistsRelated
            ? 'Related-existence id must be a stable existsRelated:<identifier> value.'
          : 'Set operation id must be a stable set:<identifier> value.');
    }
    if (ids.has(operation.id)) {
      addError(errors, `${path}.id`, `Object flow id must be unique; already used at ${ids.get(operation.id)}.`);
    } else {
      ids.set(operation.id, `${path}.id`);
    }
    if (!operation.as || !IDENTIFIER_PATTERN.test(operation.as)) {
      addError(errors, `${path}.as`, `${isMatch ? 'Match' : isRelation ? 'Relation' : isExistsRelated ? 'Related-existence' : 'Set operation'} output alias must be a non-empty identifier.`);
    } else if (aliases.has(operation.as)) {
      addError(errors, `${path}.as`, `Object flow alias must be unique; already used at ${aliases.get(operation.as)}.`);
    }
    const validateOperationSource = (alias, field) => {
      if (!alias || !declaredAliases.has(alias)) {
        addError(errors, `${path}.${field}`, 'Operation ' + field + ' must reference a declared materialized alias.');
        return;
      }
      const sourceOperationIndex = operationAliasIndexes.get(alias);
      if (sourceOperationIndex !== undefined && sourceOperationIndex >= index) {
        addError(errors, `${path}.${field}`, 'Operation ' + field + ' must reference an alias declared earlier in the flow.');
      }
    };
    validateOperationSource(operation.from, 'from');
    if (!isRelation) validateOperationSource(operation.with, 'with');
    if (isRelation) {
      if (!operation.domain || !CLASS_NAME_PATTERN.test(operation.domain)) {
        addError(errors, `${path}.domain`, 'Relation operation domain must be a CMDBuild identifier.');
      }
      if (!operation.targetClass || !CLASS_NAME_PATTERN.test(operation.targetClass)) {
        addError(errors, `${path}.targetClass`, 'Relation operation targetClass must be a CMDBuild identifier.');
      }
      if (!RELATION_DIRECTIONS.has(operation.direction)) {
        addError(errors, `${path}.direction`, 'Relation operation direction must be one of both, source, destination, direct, inverse.');
      }
      if (!Number.isInteger(operation.limit) || operation.limit <= 0) {
        addError(errors, `${path}.limit`, 'Relation operation limit must be a positive integer.');
      }
    } else if (isMatch || isExistsRelated) {
      if (!operation.rules.length) {
        addError(errors, `${path}.rules`, isExistsRelated ? 'Related-existence operation requires a non-empty rules array.' : 'Match block requires a non-empty rules array.');
      }
      operation.rules.forEach((rule, ruleIndex) => {
        const rulePath = `${path}.rules[${ruleIndex}]`;
        if (!ACTIONS.includes(rule.action)) addError(errors, `${rulePath}.action`, 'Match rule action must be include or exclude.');
        if (!MATCH_OPERATORS.includes(rule.operator)) addError(errors, `${rulePath}.operator`, `Match rule operator must be one of: ${MATCH_OPERATORS.join(', ')}.`);
        if (!rule.leftColumn) addError(errors, `${rulePath}.leftColumn`, 'Match rule requires leftColumn.');
        if (!rule.rightColumn) addError(errors, `${rulePath}.rightColumn`, 'Match rule requires rightColumn.');
      });
      if (isExistsRelated) {
        if (!operation.domain || !CLASS_NAME_PATTERN.test(operation.domain)) {
          addError(errors, `${path}.domain`, 'Related-existence operation domain must be a CMDBuild identifier.');
        }
        if (!operation.targetClass || !CLASS_NAME_PATTERN.test(operation.targetClass)) {
          addError(errors, `${path}.targetClass`, 'Related-existence operation targetClass must be a CMDBuild identifier.');
        }
        if (!RELATION_DIRECTIONS.has(operation.direction)) {
          addError(errors, `${path}.direction`, 'Related-existence operation direction must be one of both, source, destination, direct, inverse.');
        }
        if (!Number.isInteger(operation.limit) || operation.limit <= 0) {
          addError(errors, `${path}.limit`, 'Related-existence operation limit must be a positive integer.');
        }
      }
    } else {
      if (!SET_OPERATION_TYPES.has(operation.type)) addError(errors, `${path}.type`, 'Set operation type must be union, difference, or intersect.');
      if (!operation.on.length) addError(errors, `${path}.on`, 'Set operation requires at least one left/right key pair.');
      // Column checks run after all stages have been ordered by their real
      // data dependencies below.
    }
    if (operation.as && IDENTIFIER_PATTERN.test(operation.as) && !aliases.has(operation.as)) aliases.set(operation.as, `${path}.as`);
  });

  const stageOrder = orderedObjectFlowStages(normalized);
  const orderedAliases = new Set(stageOrder.ordered.map((stage) => stage.alias));
  for (const stage of stageOrder.unresolved) {
    const item = stage.item;
    const dependencies = stage.dependencies.filter((alias) => declaredAliases.has(alias) && !orderedAliases.has(alias));
    for (const dependency of dependencies) {
      const field = stage.kind === 'selection' ? 'from' : dependency === item.from ? 'from' : 'with';
      addError(errors, `${stage.path}.${field}`, 'Data-flow dependency is cyclic or cannot be materialized before this stage.');
    }
  }

  /** @type {Map<string, string[]>} */
  const materializedColumns = new Map();
  for (const stage of stageOrder.ordered) {
    if (stage.kind === 'selection') {
      const selection = /** @type {ObjectFlowSelection} */ (stage.item);
      const sourceColumns = selection.from ? materializedColumns.get(selection.from) : undefined;
      for (const [ruleIndex, rule] of selection.rules.entries()) {
        if (rule.valueColumn && sourceColumns && !sourceColumns.includes(rule.valueColumn)) {
          addError(errors, `${stage.path}.rules[${ruleIndex}].valueColumn`, `Selection valueColumn ${rule.valueColumn} is not materialized by source ${selection.from}.`);
        }
      }
      materializedColumns.set(selection.alias, uniqueStrings(
        BASE_RESULT_COLUMNS.concat(selection.columns, matchingColumns.get(selection.alias) || [])
      ));
      continue;
    }

    const operation = /** @type {ObjectFlowOperation} */ (stage.item);
    const isMatch = operation.type === 'match';
    const isExistsRelated = operation.type === 'existsRelated';
    const leftColumns = materializedColumns.get(operation.from);
    const rightColumns = materializedColumns.get(operation.with);
    const path = stage.path;
    if (isMatch || isExistsRelated) {
      operation.rules.forEach((rule, ruleIndex) => {
        const rulePath = `${path}.rules[${ruleIndex}]`;
        const ruleLeftColumns = isExistsRelated ? rightColumns : leftColumns;
        const ruleRightColumns = isExistsRelated
          ? uniqueStrings(BASE_RESULT_COLUMNS.concat(operation.columns))
          : rightColumns;
        if (rule.leftColumn && ruleLeftColumns && !ruleLeftColumns.includes(rule.leftColumn)) {
          addError(errors, `${rulePath}.leftColumn`, `${isExistsRelated ? 'Related-existence' : 'Match'} rule column ${rule.leftColumn} is not materialized by source ${isExistsRelated ? operation.with : operation.from}.`);
        }
        if (rule.rightColumn && ruleRightColumns && !ruleRightColumns.includes(rule.rightColumn)) {
          addError(errors, `${rulePath}.rightColumn`, `${isExistsRelated ? 'Related-existence' : 'Match'} rule column ${rule.rightColumn} is not materialized by ${isExistsRelated ? 'related class' : `source ${operation.with}`}.`);
        }
      });
    } else if (operation.type !== 'relation') {
      operation.on.forEach((key, keyIndex) => {
        if (leftColumns && !leftColumns.includes(key.left)) {
          addError(errors, `${path}.on[${keyIndex}].left`, `Set operation key ${key.left} is not materialized by source ${operation.from}.`);
        }
        if (rightColumns && !rightColumns.includes(key.right)) {
          addError(errors, `${path}.on[${keyIndex}].right`, `Set operation key ${key.right} is not materialized by source ${operation.with}.`);
        }
      });
    }
    materializedColumns.set(operation.as, operationOutputColumns(operation, materializedColumns));
  }

  if (normalized.publishedAlias && !declaredAliases.has(normalized.publishedAlias)) {
    addError(errors, '$.publishedAlias', 'Published table alias must reference an existing materialized alias.');
  }

  return errors;
}

/**
 * @param {string[]} columns
 * @returns {Array<{path: string, as: string, multiMode: 'join', separator: string, emptyRow: true}>}
 */
function buildSelectionColumnSpecs(columns) {
  return uniqueStrings(columns).map((column) => ({
    path: column,
    as: column,
    multiMode: 'join',
    separator: ', ',
    emptyRow: true
  }));
}

/**
 * @param {ObjectFlow} flow
 * @param {string} alias
 * @returns {ObjectFlowSelection | undefined}
 */
function selectionForAlias(flow, alias) {
  return flow.selections.find((selection) => selection.alias === alias);
}

/**
 * @param {ObjectFlow} flow
 * @param {string} alias
 * @param {ObjectFlowMatchBlock[]} priorBlocks
 * @returns {string[]}
 */
function selectionColumnPrefixes(flow, alias, priorBlocks) {
  const selectionIndex = flow.selections.findIndex((selection) => selection.alias === alias);
  const selection = flow.selections[selectionIndex];
  const prefixes = [
    `${alias}_`,
    `${alias}.`,
    selectionIndex >= 0 ? `Selection ${selectionIndex + 1}.` : '',
    selection && selection.name ? `${selection.name}.` : ''
  ];
  for (const block of priorBlocks) {
    if (block.with === alias) prefixes.unshift(block.rightPrefix);
  }
  return uniqueStrings(prefixes).sort((left, right) => right.length - left.length);
}

/**
 * @param {ObjectFlow} flow
 * @param {string} alias
 * @param {string} column
 * @param {ObjectFlowMatchBlock[]} priorBlocks
 * @returns {string}
 */
function stripSelectionColumnPrefix(flow, alias, column, priorBlocks) {
  const normalized = text(column);
  for (const prefix of selectionColumnPrefixes(flow, alias, priorBlocks)) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized;
}

/**
 * @param {ObjectFlow} flow
 * @param {string} column
 * @param {ObjectFlowMatchBlock[]} priorBlocks
 * @returns {{alias: string, column: string}}
 */
function resolveLeftSelectionColumn(flow, column, priorBlocks) {
  for (let index = priorBlocks.length - 1; index >= 0; index -= 1) {
    const block = priorBlocks[index];
    const alias = block.with;
    const stripped = stripSelectionColumnPrefix(flow, alias, column, priorBlocks.slice(0, index + 1));
    if (stripped !== text(column)) return { alias, column: stripped };
  }
  for (const selection of flow.selections) {
    const stripped = stripSelectionColumnPrefix(flow, selection.alias, column, priorBlocks);
    if (stripped !== text(column)) return { alias: selection.alias, column: stripped };
  }
  return { alias: flow.selections[0] ? flow.selections[0].alias : '', column: text(column) };
}

/**
 * @param {ObjectFlow} flow
 * @returns {Map<string, string[]>}
 */
function collectMatchingSelectionColumns(flow) {
  /** @type {Map<string, string[]>} */
  const columnsByAlias = new Map();
  const add = (alias, column) => {
    const normalizedAlias = text(alias);
    const normalizedColumn = text(column);
    if (!normalizedAlias || !normalizedColumn) return;
    const columns = columnsByAlias.get(normalizedAlias) || [];
    if (!columns.includes(normalizedColumn)) columns.push(normalizedColumn);
    columnsByAlias.set(normalizedAlias, columns);
  };

  for (const operation of flow.operations) {
    if (operation.type !== 'match' && operation.type !== 'existsRelated') continue;
    for (const rule of operation.rules) {
      // Only direct selection sources can have their projection amended here.
      // Columns from an earlier match/set result are already explicit output
      // columns of that materialized operation and must not be guessed back to
      // a CMDBuild selection.
      if (operation.type === 'existsRelated') {
        if (selectionForAlias(flow, operation.with)) add(operation.with, rule.leftColumn);
      } else {
        if (selectionForAlias(flow, operation.from)) add(operation.from, rule.leftColumn);
        if (selectionForAlias(flow, operation.with)) add(operation.with, rule.rightColumn);
      }
    }
  }
  return columnsByAlias;
}

/**
 * @param {ObjectFlowSelectionRule} rule
 * @returns {Record<string, unknown>}
 */
function compileSelectionRule(rule) {
  /** @type {Record<string, unknown>} */
  const filter = {
    scope: rule.action,
    path: rule.path,
    negate: rule.negate,
    op: rule.op
  };
  if (REGEX_SELECTION_OPERATORS.has(rule.op)) {
    filter.regex = rule.regex || rule.value || '.*';
  } else if (!VALUELESS_SELECTION_OPERATORS.has(rule.op)) {
    if (rule.valueParam) filter.valueParam = rule.valueParam;
    if (rule.valueColumn) filter.valueColumn = rule.valueColumn;
    if (rule.value) filter.value = rule.value;
    else if (rule.regex) filter.value = rule.regex;
  }
  return filter;
}

/**
 * @param {ObjectFlow} flow
 * @returns {Record<string, unknown>[]}
 */
function compileObjectFlowSteps(flow) {
  const matchingColumns = collectMatchingSelectionColumns(flow);
  const compileSelection = (selection) => {
    const filters = selection.rules.map(compileSelectionRule);
    /** @type {Record<string, unknown>} */
    const step = {
      type: 'selectCards',
      purpose: 'objectGroup',
      className: selection.className,
      filters,
      limit: selection.limit,
      as: selection.alias
    };
    if (selection.from) step.from = selection.from;
    const requiredColumns = matchingColumns.get(selection.alias) || [];
    if (requiredColumns.length) {
      step.columns = buildSelectionColumnSpecs(selection.columns.concat(requiredColumns));
    } else if (selection.columns.length) {
      step.columns = selection.columns.slice();
    }
    return step;
  };
  const compileOperation = (operation) => {
    if (operation.type === 'match') {
      return {
        type: 'matchRows',
        purpose: 'objectMatching',
        from: operation.from,
        with: operation.with,
        rules: operation.rules.map((rule) => ({
          action: rule.action,
          negate: rule.negate,
          operator: rule.operator,
          left: { column: rule.leftColumn, regex: rule.leftRegex },
          right: { column: rule.rightColumn, regex: rule.rightRegex }
        })),
        caseSensitive: false,
        rightPrefix: operation.rightPrefix,
        as: operation.as
      };
    }
    if (operation.type === 'relation') {
      return {
        type: 'expandRelations',
        purpose: 'objectMatching',
        from: operation.from,
        domain: operation.domain,
        targetClass: operation.targetClass,
        direction: operation.direction,
        columns: operation.columns.slice(),
        limit: operation.limit,
        distinct: operation.distinct,
        as: operation.as
      };
    }
    if (operation.type === 'existsRelated') {
      return {
        type: 'existsRelatedRows',
        purpose: 'objectMatching',
        from: operation.from,
        with: operation.with,
        domain: operation.domain,
        targetClass: operation.targetClass,
        direction: operation.direction,
        columns: uniqueStrings(operation.columns.concat(operation.rules.map((rule) => rule.rightColumn))),
        limit: operation.limit,
        distinct: operation.distinct,
        rules: operation.rules.map((rule) => ({
          action: rule.action,
          negate: rule.negate,
          operator: rule.operator,
          left: { column: rule.leftColumn, regex: rule.leftRegex },
          right: { column: rule.rightColumn, regex: rule.rightRegex }
        })),
        caseSensitive: false,
        as: operation.as
      };
    }
    return {
      type: `${operation.type}Rows`,
      purpose: 'objectMatching',
      from: operation.from,
      with: operation.with,
      on: operation.on.map((key) => ({ left: key.left, right: key.right })),
      distinct: operation.distinct,
      caseSensitive: operation.caseSensitive,
      as: operation.as
    };
  };
  return orderedObjectFlowStages(flow).ordered.map((stage) => (
    stage.kind === 'selection'
      ? compileSelection(/** @type {ObjectFlowSelection} */ (stage.item))
      : compileOperation(/** @type {ObjectFlowOperation} */ (stage.item))
  ));
}

/**
 * @param {unknown} step
 * @returns {boolean}
 */
function isManagedObjectFlowStep(step) {
  return isRecord(step) && MANAGED_PURPOSES.has(text(step.purpose));
}

/**
 * The new-template editor starts with one demonstration query. It is not user
 * data flow and must not survive the first explicit object-flow apply.
 *
 * @param {unknown} step
 * @returns {boolean}
 */
function isNewTemplateStarterStep(step) {
  return isRecord(step)
    && step.type === 'findClassesByAttributeType'
    && text(step.attributeTypeParam) === 'attrType'
    && text(step.as) === 'classes';
}

/**
 * @param {unknown} table
 * @returns {boolean}
 */
function isNewTemplateStarterTable(table) {
  return isRecord(table) && text(table.name) === 'classes';
}

/**
 * @param {unknown[]} currentSteps
 * @param {Record<string, unknown>[]} generatedSteps
 * @returns {unknown[]}
 */
function replaceManagedSteps(currentSteps, generatedSteps, migratedObjectGroupAliases = new Set()) {
  /** @type {unknown[]} */
  const result = [];
  let inserted = false;
  for (const step of currentSteps) {
    const alias = isRecord(step) ? text(step.as) : '';
    const storedObjectGroupStep = isRecord(step)
      && step.type === 'selectCards'
      && !isManagedObjectFlowStep(step)
      && migratedObjectGroupAliases.has(alias);
    if (isManagedObjectFlowStep(step) || storedObjectGroupStep) {
      if (!inserted) {
        result.push(...generatedSteps);
        inserted = true;
      }
      continue;
    }
    result.push(step);
  }
  if (!inserted) result.push(...generatedSteps);
  return result;
}

/**
 * @param {ObjectFlow} flow
 * @returns {string[]}
 */
/**
 * @param {string[]} columns
 * @returns {Record<string, string>}
 */
function resultColumnLabels(columns) {
  /** @type {Record<string, string>} */
  const labels = {};
  for (const column of columns) labels[column] = column;
  return labels;
}

/**
 * @param {ObjectFlowSelection} selection
 * @returns {Record<string, unknown>}
 */
function visualSelection(selection) {
  const outputColumns = selection.columns.length ? selection.columns.slice() : BASE_RESULT_COLUMNS.slice();
  return {
    id: selection.id,
    name: selection.name,
    alias: selection.alias,
    className: selection.className,
    from: selection.from,
    limit: selection.limit,
    columns: selection.columns.slice(),
    sourceType: 'cmdb',
    scopeRules: cloneJsonValue(selection.rules),
    source: {
      type: 'cmdb',
      className: selection.className,
      from: selection.from,
      limit: selection.limit,
      columns: selection.columns.slice()
    },
    output: {
      alias: selection.alias,
      title: selection.name,
      columns: outputColumns
    }
  };
}

/**
 * @param {ObjectFlow} flow
 * @returns {{objectGroup: Record<string, unknown>, objectMatching: Record<string, unknown>}}
 */
function normalizeAssistantOutputManifest(value, outputs) {
  if (value === undefined || value === null) {
    if (outputs.some((output) => output.assistantManaged)) {
      throw contractError('Assistant-managed object-flow outputs require a persisted ownership manifest.', 'assistant_output_manifest_invalid', 422);
    }
    return null;
  }
  if (!isRecord(value) || Number(value.version) !== 1 || !Array.isArray(value.blocks) || !value.blocks.length) {
    throw contractError('Assistant ownership manifest must contain version 1 and named blocks.', 'assistant_output_manifest_invalid', 422);
  }
  const seenIds = new Set();
  const seenNames = new Set();
  const blocks = value.blocks.map((raw, index) => {
    if (!isRecord(raw)) {
      throw contractError(`Assistant ownership manifest block ${index + 1} must be an object.`, 'assistant_output_manifest_invalid', 422);
    }
    const id = text(raw.id);
    const name = text(raw.name);
    const normalizedName = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
    if (!id || !normalizedName || seenIds.has(id) || seenNames.has(normalizedName) || Number(raw.order) !== index + 1) {
      throw contractError('Assistant ownership manifest block ids and names must be unique and non-empty.', 'assistant_output_manifest_invalid', 422);
    }
    seenIds.add(id);
    seenNames.add(normalizedName);
    return { id, name: name.trim(), order: index + 1 };
  });
  const knownBlockIds = new Set(blocks.map((block) => block.id));
  if (outputs.some((output) => !output.assistantManaged || !output.assistantBlockIds?.length || output.assistantBlockIds.some((id) => !knownBlockIds.has(id)))) {
    throw contractError('Assistant ownership manifest must own every materialized Assistant result.', 'assistant_output_manifest_invalid', 422);
  }
  const rawCandidate = isRecord(value.extractionCandidate) ? value.extractionCandidate : null;
  const blockId = text(rawCandidate?.blockId);
  const alias = text(rawCandidate?.alias);
  if (Boolean(blockId) !== Boolean(alias) || (blockId && (!knownBlockIds.has(blockId) || !outputs.some((output) => output.alias === alias)))) {
    throw contractError('Assistant ownership manifest extraction candidate must reference a known block and result.', 'assistant_output_manifest_invalid', 422);
  }
  return {
    version: 1,
    blocks,
    ...(blockId ? { extractionCandidate: { blockId, alias } } : {})
  };
}

function objectFlowVisualModels(flow, outputs, assistantOutputManifest = null) {
  const groupSelections = flow.selections.map(visualSelection);
  const publishedOutput = outputs.find((output) => output.published);
  return {
    objectGroup: {
      version: 1,
      mode: 'objectGroup',
      selections: groupSelections
    },
    objectMatching: {
      version: 1,
      mode: 'objectMatching',
      selections: cloneJsonValue(flow.selections),
      operations: cloneJsonValue(flow.operations),
      blocks: cloneJsonValue(flow.blocks),
      setOperations: cloneJsonValue(flow.setOperations),
      outputs,
      ...(assistantOutputManifest ? { assistantOutputManifest: cloneJsonValue(assistantOutputManifest) } : {}),
      output: {
        alias: flow.publishedAlias,
        title: publishedOutput?.label || 'Final result'
      }
    }
  };
}

/**
 * @param {unknown[]} currentModels
 * @param {Record<string, unknown>} objectGroup
 * @param {Record<string, unknown>} objectMatching
 * @returns {unknown[]}
 */
function replaceObjectFlowVisualModels(currentModels, objectGroup, objectMatching) {
  const generated = [objectGroup, objectMatching];
  /** @type {unknown[]} */
  const result = [];
  let inserted = false;
  for (const model of currentModels) {
    const mode = isRecord(model) ? text(model.mode) : '';
    if (mode === 'objectGroup' || mode === 'objectMatching') {
      if (!inserted) {
        result.push(...generated);
        inserted = true;
      }
      continue;
    }
    result.push(model);
  }
  if (!inserted) result.push(...generated);
  return result;
}

/**
 * @param {ObjectFlow} flow
 * @param {Map<string, Record<string, unknown>>} existingByName
 * @returns {Record<string, unknown>[]}
 */
function generatedResultTables(flow, existingByName, outputs) {
  const outputByAlias = new Map(outputs.map((output) => [output.alias, output]));
  const tables = flow.selections.map((selection) => ({
    ...(existingByName.get(selection.alias) || {}),
    name: selection.alias,
    title: outputByAlias.get(selection.alias)?.assistantManaged
      ? outputByAlias.get(selection.alias)?.label
      : text(existingByName.get(selection.alias)?.title) || outputByAlias.get(selection.alias)?.label || selection.name,
    columns: selection.columns.length ? selection.columns.slice() : BASE_RESULT_COLUMNS.slice()
  }));
  const stages = objectFlowStageSummaries(flow);
  for (const stage of stages.filter((item) => item.kind !== 'selection')) {
    const existing = existingByName.get(stage.alias) || {};
    tables.push({
      ...existing,
      name: stage.alias,
      title: outputByAlias.get(stage.alias)?.assistantManaged
        ? outputByAlias.get(stage.alias)?.label
        : text(existing.title) || outputByAlias.get(stage.alias)?.label || stage.alias,
      columns: stage.columns,
      ...(stage.kind === 'match' ? { columnLabels: resultColumnLabels(stage.columns) } : {})
    });
  }
  tables.forEach((table) => {
    delete table.published;
    if (flow.publishedAlias && text(table.name) === flow.publishedAlias) table.published = true;
  });
  return tables;
}

/**
 * Persist the visible, materialized outputs of the Assistant flow. This is
 * intentionally independent from result.tables so unrelated hand-authored
 * tables are never mistaken for Object Flow stages.
 *
 * @param {unknown} flow
 * @returns {ObjectFlowResultOutput[]}
 */
export function objectFlowResultOutputs(flow, outputMetadata = []) {
  const normalized = normalizeObjectFlow(flow);
  const materializedAliases = new Set(orderedObjectFlowStages(normalized).ordered.map((stage) => (
    stage.kind === 'selection' ? stage.item.alias : stage.item.as
  )).filter(Boolean));
  const metadataByAlias = new Map();
  if (!Array.isArray(outputMetadata)) {
    throw contractError('Object-flow output metadata must be an array.', 'object_flow_output_metadata_invalid', 422);
  }
  for (const raw of outputMetadata) {
    if (!isRecord(raw)) {
      throw contractError('Object-flow output metadata entries must be objects.', 'object_flow_output_metadata_invalid', 422);
    }
    const alias = text(raw.alias);
    const label = text(raw.label);
    const assistantBlockId = text(raw.assistantBlockId);
    const assistantBlockIds = uniqueStrings(Array.isArray(raw.assistantBlockIds)
      ? raw.assistantBlockIds.map((item) => text(item))
      : assistantBlockId ? [assistantBlockId] : []);
    if (!alias || !materializedAliases.has(alias) || !label || metadataByAlias.has(alias)) {
      throw contractError('Object-flow output metadata must define one non-empty label for each known alias.', 'object_flow_output_metadata_invalid', 422);
    }
    metadataByAlias.set(alias, {
      label,
      assistantBlockId: assistantBlockId || assistantBlockIds[0] || '',
      assistantBlockIds
    });
  }
  if (metadataByAlias.size && (metadataByAlias.size !== materializedAliases.size
    || Array.from(materializedAliases).some((alias) => !metadataByAlias.has(alias))
    || Array.from(metadataByAlias.values()).some((metadata) => !metadata.assistantBlockIds.length))) {
    throw contractError('Assistant output metadata must own every materialized alias exactly once.', 'object_flow_output_metadata_invalid', 422);
  }
  const outputs = [];
  let matchIndex = 0;
  let relationIndex = 0;
  let existsRelatedIndex = 0;
  let setIndex = 0;
  for (const stage of orderedObjectFlowStages(normalized).ordered) {
    const alias = stage.kind === 'selection' ? stage.item.alias : stage.item.as;
    if (!alias) continue;
    let label = alias;
    if (stage.kind === 'selection') {
      label = text(stage.item.name) || alias;
    } else if (stage.item.type === 'match') {
      matchIndex += 1;
      label = `Сопоставление ${matchIndex}`;
    } else if (stage.item.type === 'relation') {
      relationIndex += 1;
      label = stage.item.domain ? `Связь ${relationIndex}: ${stage.item.domain}` : `Связь ${relationIndex}`;
    } else if (stage.item.type === 'existsRelated') {
      existsRelatedIndex += 1;
      label = `Отбор по связям ${existsRelatedIndex}`;
    } else {
      setIndex += 1;
      label = `Операция множеств ${setIndex}`;
    }
    const metadata = metadataByAlias.get(alias);
    outputs.push({
      alias,
      label: metadata?.label || label,
      kind: stage.kind === 'selection' ? 'selection' : stage.item.type === 'relation' ? 'relation' : stage.item.type === 'existsRelated' ? 'existsRelated' : stage.item.type === 'match' ? 'match' : 'set',
      published: Boolean(normalized.publishedAlias && normalized.publishedAlias === alias),
      ...(metadata ? {
        assistantManaged: true,
        ...(metadata.assistantBlockId ? { assistantBlockId: metadata.assistantBlockId } : {}),
        ...(metadata.assistantBlockIds.length ? { assistantBlockIds: metadata.assistantBlockIds } : {})
      } : {})
    });
  }
  return outputs;
}

/**
 * Return aliases explicitly owned by a stored Object Group visual model. This
 * is the only supported migration hint for replacing older unmarked
 * selectCards steps; arbitrary hand-authored steps are never guessed.
 *
 * @param {Record<string, unknown>} spec
 * @returns {Set<string>}
 */
function storedObjectGroupAliases(spec) {
  const models = [];
  if (Array.isArray(spec.visualModels)) models.push(...spec.visualModels);
  if (isRecord(spec.visualModel)) models.push(spec.visualModel);
  const aliases = new Set();
  for (const model of models) {
    if (!isRecord(model) || text(model.mode) !== 'objectGroup' || !Array.isArray(model.selections)) continue;
    for (const selection of model.selections) {
      if (!isRecord(selection)) continue;
      const alias = text(selection.alias || isRecord(selection.output) && selection.output.alias);
      if (alias) aliases.add(alias);
    }
  }
  return aliases;
}

/**
 * Return result aliases explicitly owned by a prior Object Flow manifest.
 * Unlike unmarked result tables, these aliases are safe to replace on the
 * next Assistant apply.
 *
 * @param {Record<string, unknown>} spec
 * @returns {Set<string>}
 */
function storedObjectFlowOutputAliases(spec) {
  const models = [];
  if (Array.isArray(spec.visualModels)) models.push(...spec.visualModels);
  if (isRecord(spec.visualModel)) models.push(spec.visualModel);
  const aliases = new Set();
  for (const model of models) {
    if (!isRecord(model) || text(model.mode) !== 'objectMatching' || !Array.isArray(model.outputs)) continue;
    for (const output of model.outputs) {
      const alias = isRecord(output) ? text(output.alias) : '';
      if (alias) aliases.add(alias);
    }
  }
  return aliases;
}

/**
 * @param {unknown[]} currentTables
 * @param {Set<string>} relatedNames
 * @param {Record<string, unknown>[]} generatedTables
 * @returns {unknown[]}
 */
function replaceObjectFlowTables(currentTables, relatedNames, generatedTables) {
  /** @type {unknown[]} */
  const result = [];
  let inserted = false;
  for (const table of currentTables) {
    const name = isRecord(table) ? text(table.name) : '';
    if (relatedNames.has(name)) {
      if (!inserted) {
        result.push(...generatedTables);
        inserted = true;
      }
      continue;
    }
    result.push(table);
  }
  if (!inserted) result.push(...generatedTables);
  return result;
}

/**
 * @param {string} message
 * @param {string} code
 * @param {number} statusCode
 * @param {ObjectFlowValidationError[]=} errors
 * @returns {Error & {code: string, statusCode: number, errors?: ObjectFlowValidationError[]}}
 */
function contractError(message, code, statusCode, errors) {
  const error = /** @type {Error & {code: string, statusCode: number, errors?: ObjectFlowValidationError[]}} */ (new Error(message));
  error.code = code;
  error.statusCode = statusCode;
  if (errors) error.errors = errors;
  return error;
}

/**
 * Compile a validated object flow into a cloned Spec version 1. Only steps with
 * purpose objectGroup/objectMatching and visual models with the corresponding
 * modes are replaced. Older unmarked Object Group steps are replaced only when
 * their aliases are recorded in a stored Object Group visual model.
 *
 * @param {unknown} currentSpec
 * @param {unknown} flow
 * @returns {Record<string, unknown>}
 */
export function compileObjectFlowToSpec(currentSpec, flow, options = {}) {
  if (!isRecord(currentSpec) || currentSpec.version !== 1) {
    throw contractError('Object flow compilation requires current Spec version 1.', 'object_flow_spec_version', 409);
  }
  const normalized = normalizeObjectFlow(flow);
  const errors = validateObjectFlow(normalized);
  if (errors.length) {
    throw contractError(
      `Object flow is invalid: ${errors[0].path}: ${errors[0].message}`,
      'object_flow_invalid',
      422,
      errors
    );
  }

  // Source-driven selections must be authored explicitly in the object-group
  // editor. A match operation must not silently rewrite a selection query.
  const executableFlow = normalized;
  const spec = cloneJsonValue(currentSpec);
  const currentSteps = Array.isArray(spec.steps) ? spec.steps : [];
  const replacesNewTemplateStarter = currentSteps.length === 1 && isNewTemplateStarterStep(currentSteps[0]);
  const storedGroupAliases = storedObjectGroupAliases(spec);
  const incomingSelectionAliases = new Set(normalized.selections.map((selection) => selection.alias));
  const unmarkedIncomingSelections = currentSteps.filter((step) => (
    isRecord(step)
    && step.type === 'selectCards'
    && !isManagedObjectFlowStep(step)
    && incomingSelectionAliases.has(text(step.as))
  ));
  if (unmarkedIncomingSelections.length && !storedGroupAliases.size) {
    throw contractError(
      'Object-flow migration requires a stored Object Group visual model for unmarked selectCards steps.',
      'object_flow_migration_required',
      409
    );
  }
  const oldManagedAliases = new Set(
    currentSteps
      .filter(isManagedObjectFlowStep)
      .map((step) => isRecord(step) ? text(step.as) : '')
      .filter(Boolean)
  );
  storedGroupAliases.forEach((alias) => oldManagedAliases.add(alias));
  storedObjectFlowOutputAliases(spec).forEach((alias) => oldManagedAliases.add(alias));
  const generatedSteps = compileObjectFlowSteps(executableFlow);
  spec.steps = replaceManagedSteps(replacesNewTemplateStarter ? [] : currentSteps, generatedSteps, storedGroupAliases);
  if (replacesNewTemplateStarter && isRecord(spec.params) && Object.prototype.hasOwnProperty.call(spec.params, 'attrType')) {
    delete spec.params.attrType;
  }

  const outputs = objectFlowResultOutputs(executableFlow, options.outputMetadata || []);
  const assistantOutputManifest = normalizeAssistantOutputManifest(options.assistantOutputManifest, outputs);
  const models = objectFlowVisualModels(executableFlow, outputs, assistantOutputManifest);
  const currentModels = Array.isArray(spec.visualModels) ? spec.visualModels : [];
  spec.visualModels = replaceObjectFlowVisualModels(currentModels, models.objectGroup, models.objectMatching);
  if (isRecord(spec.visualModel) && spec.visualModel.mode === 'objectGroup') spec.visualModel = models.objectGroup;
  if (isRecord(spec.visualModel) && spec.visualModel.mode === 'objectMatching') spec.visualModel = models.objectMatching;

  const result = isRecord(spec.result) ? spec.result : {};
  const currentTables = (Array.isArray(result.tables) ? result.tables : []).filter((table) => (
    !replacesNewTemplateStarter || !isNewTemplateStarterTable(table)
  ));
  /** @type {Map<string, Record<string, unknown>>} */
  const existingByName = new Map();
  for (const table of currentTables) {
    if (isRecord(table) && text(table.name)) existingByName.set(text(table.name), table);
  }
  const generatedTables = generatedResultTables(executableFlow, existingByName, outputs);
  const relatedTableNames = new Set(oldManagedAliases);
  for (const table of generatedTables) relatedTableNames.add(text(table.name));
  result.tables = replaceObjectFlowTables(currentTables, relatedTableNames, generatedTables);
  if (normalized.publishedAlias) {
    result.tables = result.tables.map((table) => {
      if (!isRecord(table)) return table;
      const next = { ...table };
      if (text(next.name) === normalized.publishedAlias) next.published = true;
      else delete next.published;
      return next;
    });
  }
  spec.result = result;

  return spec;
}

/**
 * Return compact selection and cumulative match stage metadata for assistant
 * and diagram mapping requests.
 *
 * @param {unknown} flow
 * @returns {ObjectFlowStageSummary[]}
 */
export function objectFlowStageSummaries(flow) {
  const normalized = normalizeObjectFlow(flow);
  /** @type {ObjectFlowStageSummary[]} */
  const summaries = [];
  const columnsByAlias = new Map();
  for (const stage of orderedObjectFlowStages(normalized).ordered) {
    if (stage.kind === 'selection') {
      const selection = /** @type {ObjectFlowSelection} */ (stage.item);
      const summary = {
        id: selection.id,
        kind: /** @type {'selection'} */ ('selection'),
        alias: selection.alias,
        className: selection.className,
        columns: uniqueStrings(BASE_RESULT_COLUMNS.concat(selection.columns))
      };
      summaries.push(summary);
      columnsByAlias.set(selection.alias, summary.columns);
      continue;
    }
    const operation = /** @type {ObjectFlowOperation} */ (stage.item);
    const leftColumns = columnsByAlias.get(operation.from) || [];
    const rightColumns = columnsByAlias.get(operation.with) || [];
    let columns;
    let kind;
    if (operation.type === 'relation') {
      kind = 'relation';
      columns = uniqueStrings([
        'SourceClass', 'SourceId', 'SourceCode', 'SourceDescription',
        'Domain', 'RelationId', 'RelationDirection', 'RelationSourceSide',
        'RelatedClass', 'RelatedId'
      ].concat(BASE_RESULT_COLUMNS, operation.columns));
    } else if (operation.type === 'match') {
      kind = 'match';
      columns = leftColumns.slice();
      for (const column of rightColumns) {
        const prefixed = `${operation.rightPrefix}${column}`;
        if (!columns.includes(prefixed)) columns.push(prefixed);
      }
      for (const rule of operation.rules) {
        if (rule.leftColumn && !columns.includes(rule.leftColumn)) columns.push(rule.leftColumn);
        const rightColumn = `${operation.rightPrefix}${rule.rightColumn}`;
        if (rule.rightColumn && !columns.includes(rightColumn)) columns.push(rightColumn);
      }
    } else if (operation.type === 'existsRelated') {
      kind = 'existsRelated';
      columns = leftColumns.slice();
    } else {
      kind = 'set';
      columns = operation.type === 'union' ? uniqueStrings(leftColumns.concat(rightColumns)) : leftColumns.slice();
    }
    const summary = {
      id: operation.id,
      kind,
      alias: operation.as,
      columns
    };
    summaries.push(summary);
    columnsByAlias.set(operation.as, columns);
  }
  return summaries;
}
