// @ts-check

/** @typedef {'include' | 'exclude'} ObjectFlowRuleAction */
/**
 * @typedef {object} ObjectFlowSelectionRule
 * @property {ObjectFlowRuleAction | string} action
 * @property {string} path
 * @property {boolean} negate
 * @property {string} op
 * @property {string} rightExpression
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
 * @property {{mode: 'domain' | 'match', fromClass: string, withClass: string, sourceField: string, targetField: string, domain: string, direction: string}=} connection
 */
/**
 * @typedef {object} ObjectFlowSemiJoinOperation
 * @property {string} id
 * @property {'semiJoin'} type
 * @property {string} from
 * @property {string} with
 * @property {string} as
 * @property {'any' | 'all'} ruleJoin
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
 * @typedef {(ObjectFlowMatchBlock & {type: 'match'}) | ObjectFlowSemiJoinOperation | ObjectFlowSetOperation | ObjectFlowRelationOperation | ObjectFlowExistsRelatedOperation} ObjectFlowOperation
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
 * @property {'selection' | 'match' | 'semiJoin' | 'set' | 'relation' | 'existsRelated'} kind
 * @property {string} alias
 * @property {string=} className
 * @property {string[]} columns
 */
/**
 * @typedef {object} ObjectFlowResultOutput
 * @property {string} alias
 * @property {string} label
 * @property {'selection' | 'match' | 'semiJoin' | 'set' | 'relation' | 'existsRelated'} kind
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
const FILTER_JOINS = new Set(['all', 'any']);
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SELECTION_ID_PATTERN = /^selection:[A-Za-z_][A-Za-z0-9_]*$/;
const MATCH_ID_PATTERN = /^match:[A-Za-z_][A-Za-z0-9_]*$/;
const SEMI_JOIN_ID_PATTERN = /^semiJoin:[A-Za-z_][A-Za-z0-9_]*$/;
const SET_OPERATION_ID_PATTERN = /^set:[A-Za-z_][A-Za-z0-9_]*$/;
const RELATION_OPERATION_ID_PATTERN = /^relation:[A-Za-z_][A-Za-z0-9_]*$/;
const EXISTS_RELATED_OPERATION_ID_PATTERN = /^existsRelated:[A-Za-z_][A-Za-z0-9_]*$/;
const SET_OPERATION_TYPES = new Set(['union', 'difference', 'intersect']);
const RELATION_DIRECTIONS = new Set(['both', 'source', 'destination', 'direct', 'inverse']);
const RIGHT_EXPRESSION_TOKEN = /\$\{(param|previous)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

/**
 * Object Flow exposes one expression for the right side of a selection rule.
 * The executor resolves only explicit template parameters and fields from the
 * selection's declared source; it never evaluates arbitrary expressions.
 *
 * @param {string} expression
 * @returns {Array<{kind: 'param' | 'previous', name: string}>}
 */
function rightExpressionTokens(expression) {
  const tokens = [];
  const source = String(expression || '');
  for (const match of source.matchAll(RIGHT_EXPRESSION_TOKEN)) {
    tokens.push({ kind: /** @type {'param' | 'previous'} */ (match[1]), name: match[2] });
  }
  return tokens;
}

/**
 * @param {unknown} rule
 * @param {string} operator
 * @returns {string}
 */
function normalizeRightExpression(rule, operator) {
  if (!isRecord(rule)) return '';
  if (typeof rule.rightExpression === 'string') return rule.rightExpression;
  // Older persisted templates are read into the new editor representation.
  // New Object Flow writes only rightExpression.
  if (text(rule.valueParam)) return `\${param.${text(rule.valueParam)}}`;
  if (text(rule.valueColumn || rule.sourceColumn || rule.fromColumn)) {
    return `\${previous.${text(rule.valueColumn || rule.sourceColumn || rule.fromColumn)}}`;
  }
  if (REGEX_SELECTION_OPERATORS.has(operator)) return text(rule.regex || rule.value);
  return text(rule.value || rule.regex);
}

/**
 * The deterministic executors retain source-row provenance for source-driven
 * selections and relation expansions. Keep the public stage summary aligned
 * with those runtime rows so Diagram conditions can use the same fields.
 *
 * @param {string[]} columns
 * @param {{includeBase?: boolean}=} options
 * @returns {string[]}
 */
function sourceProvenanceColumns(columns, options = {}) {
  const includeBase = options.includeBase !== false;
  return uniqueStrings((columns || [])
    .filter((column) => includeBase || !BASE_RESULT_COLUMNS.includes(column))
    .map((column) => `Source_${column}`));
}

/**
 * A deterministic stage can retain cards from earlier steps as provenance.
 * Keep their class and identity columns alongside the stage's current card so
 * consumers can safely resolve a CMDBuild path against the intended card.
 *
 * @param {unknown[]} values
 * @returns {Array<{id: string, className: string, classColumn: string, idColumn: string, label: string}>}
 */
function uniqueStageCardSources(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const candidate = isRecord(value) ? value : {};
    const className = text(candidate.className);
    const classColumn = text(candidate.classColumn);
    const idColumn = text(candidate.idColumn);
    if (!className || !classColumn || !idColumn) continue;
    const item = {
      id: text(candidate.id) || `${classColumn}:${idColumn}`,
      className,
      classColumn,
      idColumn,
      label: text(candidate.label) || className
    };
    const key = [item.className, item.classColumn, item.idColumn].join(':').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * @param {string} className
 * @param {string=} label
 * @returns {{id: string, className: string, classColumn: string, idColumn: string, label: string}}
 */
function currentStageCardSource(className, label = 'Result card') {
  return { id: 'current', className: text(className), classColumn: 'Class', idColumn: '_id', label };
}

/**
 * @param {{id: string, className: string, classColumn: string, idColumn: string, label: string}} source
 * @param {string} prefix
 * @param {string} labelPrefix
 * @returns {{id: string, className: string, classColumn: string, idColumn: string, label: string}}
 */
function prefixedStageCardSource(source, prefix, labelPrefix) {
  return {
    id: `${prefix}${source.id}`,
    className: source.className,
    classColumn: `${prefix}${source.classColumn}`,
    idColumn: `${prefix}${source.idColumn}`,
    label: `${labelPrefix}${source.label}`
  };
}

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
  const operator = text(rule.op) || (Object.prototype.hasOwnProperty.call(rule, 'regex') ? 'matches' : 'equals');
  return {
    action: text(rule.action) || 'include',
    path: text(rule.path),
    negate: normalizeBoolean(rule.negate),
    op: operator,
    rightExpression: normalizeRightExpression(rule, operator)
  };
}

function inferredSelectionFilterJoin(rules) {
  const includeRules = rules.filter((rule) => rule.action === 'include');
  const valueColumns = new Set(includeRules.map((rule) => rightExpressionTokens(rule.rightExpression)
    .filter((token) => token.kind === 'previous')
    .map((token) => token.name).join('\u0000')).filter(Boolean));
  const operators = new Set(includeRules.map((rule) => rule.op).filter(Boolean));
  const paths = new Set(includeRules.map((rule) => rule.path).filter(Boolean));
  return includeRules.length > 1 && valueColumns.size === 1 && operators.size === 1 && paths.size > 1 ? 'any' : 'all';
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
  const requestedFilterJoin = text(selection.filterJoin);
  return {
    id: text(selection.id) || `selection:${alias}`,
    name: text(selection.name) || `Selection ${index + 1}`,
    alias,
    className: text(selection.className),
    from: text(selection.from),
    limit: requestedLimit,
    columns: normalizeColumns(selection.columns),
    filterJoin: requestedFilterJoin || inferredSelectionFilterJoin(rules),
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
  const rawConnection = isRecord(block.connection) ? block.connection : null;
  const connectionMode = text(rawConnection && rawConnection.mode);
  const connection = rawConnection && ['domain', 'match'].includes(connectionMode)
    ? {
        mode: /** @type {'domain' | 'match'} */ (connectionMode),
        fromClass: text(rawConnection.fromClass),
        withClass: text(rawConnection.withClass),
        sourceField: text(rawConnection.sourceField),
        targetField: text(rawConnection.targetField),
        domain: text(rawConnection.domain),
        direction: text(rawConnection.direction)
      }
    : null;
  return {
    id: text(block.id) || `match:${outputAlias}`,
    from: text(block.from),
    with: rightAlias,
    as: outputAlias,
    rightPrefix: text(block.rightPrefix) || `${rightAlias}_`,
    rules: Array.isArray(block.rules) ? block.rules.map(normalizeMatchRule) : [],
    ...(connection && connection.fromClass && connection.withClass && connection.sourceField && connection.targetField
      ? { connection }
      : {})
  };
}

/**
 * @param {unknown} value
 * @returns {ObjectFlowSemiJoinOperation}
 */
function normalizeSemiJoinOperation(value) {
  const operation = isRecord(value) ? value : {};
  const as = text(operation.as);
  return {
    id: text(operation.id) || `semiJoin:${as}`,
    type: 'semiJoin',
    from: text(operation.from),
    with: text(operation.with),
    as,
    ruleJoin: /** @type {ObjectFlowSemiJoinOperation['ruleJoin']} */ (text(operation.ruleJoin) || 'all'),
    rules: Array.isArray(operation.rules) ? operation.rules.map(normalizeMatchRule) : []
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
  if (type === 'semijoin') return normalizeSemiJoinOperation(operation);
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
 * Resolve the canonical executable contract for an Object Flow. Consumers
 * must use this result instead of deriving aliases independently from visual
 * models, result tables, or partially ordered operations.
 *
 * @param {unknown} flow
 * @returns {{flow: ObjectFlow, errors: ObjectFlowValidationError[], stages: ObjectFlowStage[], aliases: string[]}}
 */
export function resolveObjectFlowContract(flow) {
  const normalized = normalizeObjectFlow(flow);
  const errors = validateObjectFlow(normalized);
  const order = orderedObjectFlowStages(normalized);
  return {
    flow: normalized,
    errors,
    stages: errors.length ? [] : order.ordered,
    aliases: errors.length ? [] : order.ordered.map((stage) => stage.alias).filter(Boolean)
  };
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
    ].concat(BASE_RESULT_COLUMNS, operation.columns.filter(isTechnicalObjectFlowColumn)));
  }
  if (operation.type === 'match') {
    return uniqueStrings(leftColumns.concat(rightColumns.map((column) => `${operation.rightPrefix}${column}`)));
  }
  if (operation.type === 'semiJoin' || operation.type === 'existsRelated') return leftColumns.slice();
  return operation.type === 'union' ? uniqueStrings(leftColumns.concat(rightColumns)) : leftColumns.slice();
}

/**
 * Direct CMDBuild card attributes are materialized by the runtime for every
 * selected or related card. Only a nested reference/relation path needs an
 * explicit technical projection in a generated step.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isTechnicalObjectFlowColumn(value) {
  return text(value).includes('.');
}

/**
 * @param {string[] | undefined} columns
 * @param {unknown} column
 * @returns {boolean}
 */
function isRuntimeMaterializedObjectFlowColumn(columns, column) {
  const normalized = text(column);
  return Boolean(normalized) && (
    !isTechnicalObjectFlowColumn(normalized)
    || Boolean(columns && columns.includes(normalized))
  );
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
    if (!FILTER_JOINS.has(selection.filterJoin)) {
      addError(errors, `${path}.filterJoin`, 'Selection filterJoin must be all or any.');
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
      if (!VALUELESS_SELECTION_OPERATORS.has(rule.op) && !rule.rightExpression) {
        addError(errors, `${rulePath}.rightExpression`, 'Selection rule requires a right expression.');
      }
      const malformedTokens = String(rule.rightExpression || '').match(/\$\{[^}]*\}/g) || [];
      malformedTokens.forEach((token) => {
        if (!/^\$\{(?:param|previous)\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}$/.test(token)) {
          addError(errors, `${rulePath}.rightExpression`, `Unsupported expression token ${token}. Use \${param.<name>} or \${previous.<field>}.`);
        }
      });
      if (rightExpressionTokens(rule.rightExpression).some((token) => token.kind === 'previous') && !selection.from) {
        addError(errors, `${rulePath}.rightExpression`, 'Previous-result fields require a selection source.');
      }
    });
  });

  normalized.operations.forEach((operation, index) => {
    const path = `$.operations[${index}]`;
    const isMatch = operation.type === 'match';
    const isSemiJoin = operation.type === 'semiJoin';
    const isRelation = operation.type === 'relation';
    const isExistsRelated = operation.type === 'existsRelated';
    const idPattern = isMatch ? MATCH_ID_PATTERN : isSemiJoin ? SEMI_JOIN_ID_PATTERN : isRelation ? RELATION_OPERATION_ID_PATTERN : isExistsRelated ? EXISTS_RELATED_OPERATION_ID_PATTERN : SET_OPERATION_ID_PATTERN;
    if (!idPattern.test(operation.id)) {
      addError(errors, `${path}.id`, isMatch
        ? 'Match id must be a stable match:<identifier> value.'
        : isSemiJoin
          ? 'Semi-join id must be a stable semiJoin:<identifier> value.'
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
      addError(errors, `${path}.as`, `${isMatch ? 'Match' : isSemiJoin ? 'Semi-join' : isRelation ? 'Relation' : isExistsRelated ? 'Related-existence' : 'Set operation'} output alias must be a non-empty identifier.`);
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
    } else if (isMatch || isSemiJoin || isExistsRelated) {
      if (!operation.rules.length) {
        addError(errors, `${path}.rules`, isExistsRelated
          ? 'Related-existence operation requires a non-empty rules array.'
          : isSemiJoin
            ? 'Semi-join operation requires a non-empty rules array.'
            : 'Match block requires a non-empty rules array.');
      }
      operation.rules.forEach((rule, ruleIndex) => {
        const rulePath = `${path}.rules[${ruleIndex}]`;
        if (!ACTIONS.includes(rule.action)) addError(errors, `${rulePath}.action`, 'Match rule action must be include or exclude.');
        if (!MATCH_OPERATORS.includes(rule.operator)) addError(errors, `${rulePath}.operator`, `Match rule operator must be one of: ${MATCH_OPERATORS.join(', ')}.`);
        if (!rule.leftColumn) addError(errors, `${rulePath}.leftColumn`, 'Match rule requires leftColumn.');
        if (!rule.rightColumn) addError(errors, `${rulePath}.rightColumn`, 'Match rule requires rightColumn.');
      });
      if (isSemiJoin && !FILTER_JOINS.has(operation.ruleJoin)) {
        addError(errors, `${path}.ruleJoin`, 'Semi-join ruleJoin must be all or any.');
      } else if (isExistsRelated) {
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
        for (const token of rightExpressionTokens(rule.rightExpression)) {
          if (token.kind === 'previous' && sourceColumns && !isRuntimeMaterializedObjectFlowColumn(sourceColumns, token.name)) {
            addError(errors, `${stage.path}.rules[${ruleIndex}].rightExpression`, `Previous-result field ${token.name} is not materialized by source ${selection.from}.`);
          }
        }
      }
      materializedColumns.set(selection.alias, uniqueStrings(
        BASE_RESULT_COLUMNS.concat(selection.columns, matchingColumns.get(selection.alias) || [])
      ));
      continue;
    }

    const operation = /** @type {ObjectFlowOperation} */ (stage.item);
    const isMatch = operation.type === 'match';
    const isSemiJoin = operation.type === 'semiJoin';
    const isExistsRelated = operation.type === 'existsRelated';
    const leftColumns = materializedColumns.get(operation.from);
    const rightColumns = materializedColumns.get(operation.with);
    const path = stage.path;
    if (isMatch || isSemiJoin || isExistsRelated) {
      operation.rules.forEach((rule, ruleIndex) => {
        const rulePath = `${path}.rules[${ruleIndex}]`;
        const ruleLeftColumns = isExistsRelated ? rightColumns : leftColumns;
        const ruleRightColumns = isExistsRelated
          ? uniqueStrings(BASE_RESULT_COLUMNS.concat(operation.columns))
          : rightColumns;
        if (rule.leftColumn && ruleLeftColumns && !isRuntimeMaterializedObjectFlowColumn(ruleLeftColumns, rule.leftColumn)) {
          addError(errors, `${rulePath}.leftColumn`, `${isExistsRelated ? 'Related-existence' : isSemiJoin ? 'Semi-join' : 'Match'} rule column ${rule.leftColumn} is not materialized by source ${isExistsRelated ? operation.with : operation.from}.`);
        }
        if (rule.rightColumn && ruleRightColumns && !isRuntimeMaterializedObjectFlowColumn(ruleRightColumns, rule.rightColumn)) {
          addError(errors, `${rulePath}.rightColumn`, `${isExistsRelated ? 'Related-existence' : isSemiJoin ? 'Semi-join' : 'Match'} rule column ${rule.rightColumn} is not materialized by ${isExistsRelated ? 'related class' : `source ${operation.with}`}.`);
        }
      });
    } else if (operation.type !== 'relation') {
      operation.on.forEach((key, keyIndex) => {
        if (leftColumns && !isRuntimeMaterializedObjectFlowColumn(leftColumns, key.left)) {
          addError(errors, `${path}.on[${keyIndex}].left`, `Set operation key ${key.left} is not materialized by source ${operation.from}.`);
        }
        if (rightColumns && !isRuntimeMaterializedObjectFlowColumn(rightColumns, key.right)) {
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
    if (!normalizedAlias || !normalizedColumn || !isTechnicalObjectFlowColumn(normalizedColumn)) return;
    const columns = columnsByAlias.get(normalizedAlias) || [];
    if (!columns.includes(normalizedColumn)) columns.push(normalizedColumn);
    columnsByAlias.set(normalizedAlias, columns);
  };

  for (const selection of flow.selections) {
    if (!selection.from) continue;
    for (const rule of selection.rules) {
      for (const token of rightExpressionTokens(rule.rightExpression)) {
        if (token.kind === 'previous') add(selection.from, token.name);
      }
    }
  }

  for (const operation of flow.operations) {
    if (operation.type !== 'match' && operation.type !== 'semiJoin' && operation.type !== 'existsRelated') continue;
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
    filter.regexExpression = rule.rightExpression || '.*';
  } else if (!VALUELESS_SELECTION_OPERATORS.has(rule.op)) {
    filter.valueExpression = rule.rightExpression;
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
      filterJoin: selection.filterJoin,
      limit: selection.limit,
      as: selection.alias
    };
    if (selection.from) step.from = selection.from;
    const requiredColumns = matchingColumns.get(selection.alias) || [];
    const technicalColumns = uniqueStrings(selection.columns
      .filter(isTechnicalObjectFlowColumn)
      .concat(requiredColumns));
    if (technicalColumns.length) {
      step.columns = buildSelectionColumnSpecs(technicalColumns);
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
    if (operation.type === 'semiJoin') {
      return {
        type: 'semiJoinRows',
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
        ruleJoin: operation.ruleJoin,
        caseSensitive: false,
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
        columns: operation.columns.filter(isTechnicalObjectFlowColumn),
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
        columns: uniqueStrings(operation.columns
          .concat(operation.rules.map((rule) => rule.rightColumn))
          .filter(isTechnicalObjectFlowColumn)),
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
    filterJoin: selection.filterJoin,
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
function normalizeAssistantOutputManifest(value, outputs, publishedAlias = '') {
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
  const referencedBlockIds = new Set(outputs.flatMap((output) => output.assistantBlockIds || []));
  if (blocks.some((block) => !referencedBlockIds.has(block.id))) {
    throw contractError('Every Assistant ownership manifest block must resolve to a materialized result.', 'assistant_output_manifest_invalid', 422);
  }
  if (outputs.some((output) => !['terminal', 'helper'].includes(output.assistantStageRole))) {
    throw contractError('Every Assistant-owned result must declare terminal or helper stage semantics.', 'assistant_output_manifest_invalid', 422);
  }
  for (const block of blocks) {
    const terminalOutputs = outputs.filter((output) => output.assistantStageRole === 'terminal' && output.assistantBlockIds.includes(block.id));
    if (terminalOutputs.length !== 1 || terminalOutputs[0].assistantBlockIds.length !== 1) {
      throw contractError('Every Assistant ownership manifest block must own exactly one unshared terminal result.', 'assistant_output_manifest_invalid', 422);
    }
  }
  const publishedOutput = outputs.find((output) => output.alias === text(publishedAlias));
  if (publishedOutput && publishedOutput.assistantStageRole !== 'terminal') {
    throw contractError('An Assistant helper result cannot be selected as the published result.', 'assistant_output_manifest_invalid', 422);
  }
  return {
    version: 1,
    blocks
  };
}

function objectFlowVisualModels(flow, outputs, assistantOutputManifest = null) {
  const groupSelections = flow.selections.map(visualSelection);
  const terminalOutput = outputs.find((output) => output.alias === flow.publishedAlias);
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
        title: terminalOutput?.label || 'Final result'
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
    title: text(existingByName.get(selection.alias)?.title) || outputByAlias.get(selection.alias)?.label || selection.name,
    columns: Array.isArray(existingByName.get(selection.alias)?.columns)
      ? cloneJsonValue(existingByName.get(selection.alias).columns)
      : []
  }));
  const stages = objectFlowStageSummaries(flow);
  for (const stage of stages.filter((item) => item.kind !== 'selection')) {
    const existing = existingByName.get(stage.alias) || {};
    tables.push({
      ...existing,
      name: stage.alias,
      title: text(existing.title) || outputByAlias.get(stage.alias)?.label || stage.alias,
      columns: Array.isArray(existing.columns) ? cloneJsonValue(existing.columns) : [],
      ...(stage.kind === 'match' || stage.kind === 'semiJoin' ? { columnLabels: resultColumnLabels(stage.columns) } : {})
    });
  }
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
  const contract = resolveObjectFlowContract(flow);
  if (contract.errors.length) {
    throw contractError(
      `Object flow is invalid: ${contract.errors[0].path}: ${contract.errors[0].message}`,
      'object_flow_invalid',
      422,
      contract.errors
    );
  }
  const normalized = contract.flow;
  const materializedAliases = new Set(contract.aliases);
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
    const assistantStageRole = text(raw.assistantStageRole);
    if (!alias || !materializedAliases.has(alias) || !label || metadataByAlias.has(alias)) {
      throw contractError('Object-flow output metadata must define one non-empty label for each known alias.', 'object_flow_output_metadata_invalid', 422);
    }
    if (assistantStageRole && !['terminal', 'helper'].includes(assistantStageRole)) {
      throw contractError('Object-flow output metadata assistantStageRole must be terminal or helper.', 'object_flow_output_metadata_invalid', 422);
    }
    metadataByAlias.set(alias, {
      label,
      assistantBlockId: assistantBlockId || assistantBlockIds[0] || '',
      assistantBlockIds,
      assistantStageRole
    });
  }
  if (metadataByAlias.size && (metadataByAlias.size !== materializedAliases.size
    || Array.from(materializedAliases).some((alias) => !metadataByAlias.has(alias))
    || Array.from(metadataByAlias.values()).some((metadata) => !metadata.assistantBlockIds.length))) {
    throw contractError('Assistant output metadata must own every materialized alias exactly once.', 'object_flow_output_metadata_invalid', 422);
  }
  const outputs = [];
  let matchIndex = 0;
  let semiJoinIndex = 0;
  let relationIndex = 0;
  let existsRelatedIndex = 0;
  let setIndex = 0;
  for (const stage of contract.stages) {
    const alias = stage.kind === 'selection' ? stage.item.alias : stage.item.as;
    if (!alias) continue;
    let label = alias;
    if (stage.kind === 'selection') {
      label = text(stage.item.name) || alias;
    } else if (stage.item.type === 'match') {
      matchIndex += 1;
      label = `Сопоставление ${matchIndex}`;
    } else if (stage.item.type === 'semiJoin') {
      semiJoinIndex += 1;
      label = `Полусоединение ${semiJoinIndex}`;
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
      kind: stage.kind === 'selection' ? 'selection' : stage.item.type === 'relation' ? 'relation' : stage.item.type === 'existsRelated' ? 'existsRelated' : stage.item.type === 'match' ? 'match' : stage.item.type === 'semiJoin' ? 'semiJoin' : 'set',
      ...(metadata ? {
        assistantManaged: true,
        ...(metadata.assistantBlockId ? { assistantBlockId: metadata.assistantBlockId } : {}),
        ...(metadata.assistantBlockIds.length ? { assistantBlockIds: metadata.assistantBlockIds } : {}),
        ...(metadata.assistantStageRole ? { assistantStageRole: metadata.assistantStageRole } : {})
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
  const models = Array.isArray(spec.visualModels) ? spec.visualModels : [];
  const canonical = models.find((model) => isRecord(model) && text(model.mode) === 'objectGroup');
  const stored = canonical || (isRecord(spec.visualModel) && text(spec.visualModel.mode) === 'objectGroup' ? spec.visualModel : null);
  const aliases = new Set();
  if (isRecord(stored) && Array.isArray(stored.selections)) {
    for (const selection of stored.selections) {
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
  const models = Array.isArray(spec.visualModels) ? spec.visualModels : [];
  const canonical = models.find((model) => isRecord(model) && text(model.mode) === 'objectMatching');
  const stored = canonical || (isRecord(spec.visualModel) && text(spec.visualModel.mode) === 'objectMatching' ? spec.visualModel : null);
  const aliases = new Set();
  if (isRecord(stored) && Array.isArray(stored.outputs)) {
    for (const output of stored.outputs) {
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
  const assistantOutputManifest = normalizeAssistantOutputManifest(options.assistantOutputManifest, outputs, executableFlow.publishedAlias);
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
  const generatedAliases = new Set(generatedTables.map((table) => text(table && table.name)).filter(Boolean));
  const previouslyManagedAliases = new Set(oldManagedAliases);
  result.tables = result.tables.map((table) => {
    const name = isRecord(table) ? text(table.name) : '';
    if (!isRecord(table) || generatedAliases.has(name) || !previouslyManagedAliases.has(name)) return table;
    const next = { ...table };
    delete next.published;
    return next;
  });
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
  const cardSourcesByAlias = new Map();
  const sourcesFor = (alias) => cardSourcesByAlias.get(alias) || [];
  const setSources = (alias, sources) => cardSourcesByAlias.set(alias, uniqueStageCardSources(sources));
  for (const stage of orderedObjectFlowStages(normalized).ordered) {
    if (stage.kind === 'selection') {
      const selection = /** @type {ObjectFlowSelection} */ (stage.item);
      const sourceColumns = selection.from ? columnsByAlias.get(selection.from) || [] : [];
      const inheritedSources = selection.from
        ? sourcesFor(selection.from).map((source) => prefixedStageCardSource(source, 'Source_', 'Source: '))
        : [];
      const cardSources = uniqueStageCardSources([
        currentStageCardSource(selection.className, 'Result card'),
        ...inheritedSources
      ]);
      const summary = {
        id: selection.id,
        kind: /** @type {'selection'} */ ('selection'),
        alias: selection.alias,
        label: selection.name,
        className: selection.className,
        from: selection.from,
        rules: selection.rules.map((rule) => ({
          path: rule.path,
          op: rule.op,
          rightExpression: rule.rightExpression,
          action: rule.action,
          negate: rule.negate
        })),
        columns: uniqueStrings(BASE_RESULT_COLUMNS.concat(selection.columns, sourceProvenanceColumns(sourceColumns))),
        cardSources
      };
      summaries.push(summary);
      columnsByAlias.set(selection.alias, summary.columns);
      setSources(selection.alias, cardSources);
      continue;
    }
    const operation = /** @type {ObjectFlowOperation} */ (stage.item);
    const leftColumns = columnsByAlias.get(operation.from) || [];
    const rightColumns = columnsByAlias.get(operation.with) || [];
    const leftSources = sourcesFor(operation.from);
    const rightSources = sourcesFor(operation.with);
    let columns;
    let kind;
    let cardSources;
    if (operation.type === 'relation') {
      kind = 'relation';
      columns = uniqueStrings([
        'SourceClass', 'SourceId', 'SourceCode', 'SourceDescription',
        'Domain', 'RelationId', 'RelationDirection', 'RelationSourceSide',
        'RelatedClass', 'RelatedId'
      ].concat(BASE_RESULT_COLUMNS, operation.columns, sourceProvenanceColumns(leftColumns, { includeBase: false })));
      const sourceClass = String((leftSources.find((source) => source.id === 'current') || {}).className || '');
      cardSources = uniqueStageCardSources([
        currentStageCardSource(operation.targetClass, 'Related card'),
        { id: 'relation-source', className: sourceClass, classColumn: 'SourceClass', idColumn: 'SourceId', label: 'Relation source card' },
        ...leftSources.filter((source) => source.id !== 'current').map((source) => prefixedStageCardSource(source, 'Source_', 'Source: '))
      ]);
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
      cardSources = uniqueStageCardSources(leftSources.concat(
        rightSources.map((source) => prefixedStageCardSource(source, operation.rightPrefix, 'Compared: '))
      ));
    } else if (operation.type === 'semiJoin') {
      kind = 'semiJoin';
      columns = leftColumns.slice();
      cardSources = leftSources;
    } else if (operation.type === 'existsRelated') {
      kind = 'existsRelated';
      columns = leftColumns.slice();
      cardSources = leftSources;
    } else {
      kind = 'set';
      columns = operation.type === 'union' ? uniqueStrings(leftColumns.concat(rightColumns)) : leftColumns.slice();
      cardSources = operation.type === 'union' ? leftSources.concat(rightSources) : leftSources;
    }
    const summary = {
      id: operation.id,
      kind,
      alias: operation.as,
      columns,
      cardSources: uniqueStageCardSources(cardSources || [])
    };
    if (operation.type === 'relation') {
      summary.className = operation.targetClass;
      summary.from = operation.from;
      summary.domain = operation.domain;
      summary.direction = operation.direction;
    } else if (operation.type === 'existsRelated') {
      // The stage returns the left rows, but retains the relation needed to
      // materialize structured fields from the matching related cards later.
      summary.from = operation.from;
      summary.with = operation.with;
      summary.domain = operation.domain;
      summary.targetClass = operation.targetClass;
      summary.direction = operation.direction;
      summary.relatedColumns = uniqueStrings(operation.columns.concat(operation.rules.map((rule) => rule.rightColumn)));
      summary.rules = operation.rules.map((rule) => ({
        leftColumn: rule.leftColumn,
        rightColumn: rule.rightColumn,
        operator: rule.operator,
        action: rule.action,
        negate: rule.negate
      }));
    } else if (operation.type === 'match' || operation.type === 'semiJoin') {
      summary.from = operation.from;
      summary.with = operation.with;
      if (operation.type === 'match') summary.rightPrefix = operation.rightPrefix;
      if (operation.type === 'semiJoin') summary.ruleJoin = operation.ruleJoin;
      if (operation.connection) summary.connection = cloneJsonValue(operation.connection);
      summary.rules = operation.rules.map((rule) => ({
        leftColumn: rule.leftColumn,
        rightColumn: rule.rightColumn,
        operator: rule.operator,
        action: rule.action,
        negate: rule.negate
      }));
    }
    summaries.push(summary);
    columnsByAlias.set(operation.as, columns);
    setSources(operation.as, summary.cardSources);
  }
  const byAlias = new Map(summaries.map((summary) => [String(summary.alias || ''), summary]));
  const classNameFor = (summary) => String(summary && (summary.className || summary.targetClass) || '').trim();
  const bindings = [];
  const addBinding = (owner, source, comparison, operator, evidence, relation = null) => {
    if (!owner || !source.alias || !source.className || !source.field || !comparison.alias || !comparison.className || !comparison.field || !operator) return;
    const binding = {
      id: `comparison:${owner.id}:${bindings.length + 1}`,
      source,
      comparison,
      operator,
      evidence
    };
    if (relation && relation.domain && relation.targetClass) binding.relation = relation;
    bindings.push({ owner, binding });
  };
  for (const summary of summaries) {
    if (summary.kind === 'selection') {
      const comparisonStage = byAlias.get(String(summary.from || ''));
      for (const rule of Array.isArray(summary.rules) ? summary.rules : []) {
        if (!comparisonStage) continue;
        for (const token of rightExpressionTokens(rule.rightExpression)) {
          if (token.kind !== 'previous') continue;
          addBinding(summary,
            { alias: summary.alias, className: classNameFor(summary), field: String(rule.path || '') },
            { alias: comparisonStage.alias, className: classNameFor(comparisonStage), field: token.name },
            String(rule.op || ''),
            'selectionRightExpression',
            comparisonStage.kind === 'relation' ? {
              alias: comparisonStage.alias,
              fromAlias: String(comparisonStage.from || ''),
              domain: String(comparisonStage.domain || ''),
              targetClass: classNameFor(comparisonStage),
              direction: String(comparisonStage.direction || 'both')
            } : null);
        }
      }
    } else if (summary.kind === 'match' || summary.kind === 'semiJoin') {
      const left = byAlias.get(String(summary.from || ''));
      const right = byAlias.get(String(summary.with || ''));
      for (const rule of Array.isArray(summary.rules) ? summary.rules : []) {
        addBinding(summary,
          { alias: left && left.alias, className: classNameFor(left), field: String(rule.leftColumn || '') },
          { alias: right && right.alias, className: classNameFor(right), field: String(rule.rightColumn || '') },
          String(rule.operator || ''),
          summary.kind === 'semiJoin' ? 'semiJoinRows' : 'matchRows');
      }
    } else if (summary.kind === 'existsRelated') {
      const comparison = byAlias.get(String(summary.with || ''));
      for (const rule of Array.isArray(summary.rules) ? summary.rules : []) {
        addBinding(summary,
          { alias: comparison && comparison.alias, className: classNameFor(comparison), field: String(rule.leftColumn || '') },
          { alias: summary.alias, className: String(summary.targetClass || ''), field: String(rule.rightColumn || '') },
          String(rule.operator || ''),
          'existsRelatedRows', {
            alias: summary.alias,
            fromAlias: String(summary.from || ''),
            domain: String(summary.domain || ''),
            targetClass: String(summary.targetClass || ''),
            direction: String(summary.direction || 'both')
          });
      }
    }
  }
  for (const { owner, binding } of bindings) {
    if (!Array.isArray(owner.comparisonBindings)) owner.comparisonBindings = [];
    owner.comparisonBindings.push(binding);
  }
  return summaries;
}
