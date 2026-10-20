import { createHash } from 'node:crypto';
import { runtimeRowIdentity } from './runtime-row-semantics.mjs';

const DEFAULTS = { enabled: false, groupBy: [], format: 'compact', duplicates: 'distinct', maxLabelChars: 2000 };
const MISSING_LABEL = '\u041d\u0435 \u0437\u0430\u0434\u0430\u043d\u043e';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const collator = new Intl.Collator('en', { numeric: true });
const compareLabel = (left, right) => collator.compare(left, right) || compareText(left, right);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const missing = (value) => value === undefined || value === null || typeof value === 'string' && !value.trim();

class DiagramEdgeAggregationError extends Error {
  constructor(errors) {
    super('Invalid diagram edge aggregation configuration.');
    this.name = 'DiagramEdgeAggregationError';
    this.code = 'diagram_edge_aggregation_invalid';
    this.statusCode = 422;
    this.status = 422;
    this.details = errors;
  }
}

export function validateEdgeAggregation(value, { path = '$', availableFields } = {}) {
  if (value === undefined) return [];
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return [{ path, message: 'Edge aggregation must be an object.' }];
  }
  const errors = [];
  const add = (key, message) => errors.push({ path: `${path}.${key}`, message });
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULTS, key)) add(key, 'Unknown edge aggregation option.');
  }
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') add('enabled', 'enabled must be a boolean.');
  if (Object.hasOwn(value, 'groupBy')) {
    if (!Array.isArray(value.groupBy)) add('groupBy', 'groupBy must be an array of field names.');
    else {
      if (value.groupBy.length > 32) add('groupBy', 'groupBy supports at most 32 fields.');
      const fields = availableFields === undefined ? null : new Set(availableFields);
      for (let index = 0; index < value.groupBy.length; index += 1) {
        const field = value.groupBy[index];
        if (typeof field !== 'string' || !field.trim()) add(`groupBy[${index}]`, 'Group field must be a nonempty string.');
        else if (fields && !fields.has(field)) add(`groupBy[${index}]`, 'Group field is not available in the source.');
      }
    }
  }
  if (Object.hasOwn(value, 'format') && !['compact', 'tree'].includes(value.format)) add('format', 'format must be compact or tree.');
  if (Object.hasOwn(value, 'duplicates') && !['distinct', 'preserve'].includes(value.duplicates)) add('duplicates', 'duplicates must be distinct or preserve.');
  if (Object.hasOwn(value, 'maxLabelChars') && (!Number.isInteger(value.maxLabelChars) || value.maxLabelChars < 64 || value.maxLabelChars > 20000)) {
    add('maxLabelChars', 'maxLabelChars must be an integer between 64 and 20000.');
  }
  return errors;
}

export function normalizeEdgeAggregation(value) {
  const errors = validateEdgeAggregation(value);
  if (errors.length) throw new DiagramEdgeAggregationError(errors);
  if (value === undefined) return undefined;
  return { ...DEFAULTS, ...value, groupBy: [...(value.groupBy || [])] };
}

// Type tags keep numeric, string, lookup and missing identities independent of display text.
function typed(value) {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', value.map(typed)];
  if (typeof value === 'object') return ['object', Object.keys(value).sort(compareText).map((key) => [key, typed(value[key])])];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  return [typeof value, String(value)];
}

const canonical = (value) => JSON.stringify(typed(value));
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function defaultReadField(row, field) {
  if (record(row) && Object.hasOwn(row, field)) return row[field];
  return field.split('.').reduce((value, part) => record(value) && Object.hasOwn(value, part) ? value[part] : undefined, row);
}

function defaultDisplayValue(value) {
  if (missing(value)) return '';
  if (Array.isArray(value)) return `[${value.map(defaultDisplayValue).join(', ')}]`;
  if (record(value)) {
    for (const field of ['_description', 'description', 'Description', 'label', 'name', 'code', '_id', 'id', 'value']) {
      if (!missing(value[field])) return defaultDisplayValue(value[field]);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function labelText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

function groupValue(value, displayValue) {
  if (missing(value)) return { key: '["missing"]', label: MISSING_LABEL, missing: true, type: 'missing', order: undefined };
  let identity = value;
  if (record(value)) {
    const field = ['_id', 'id', 'code', 'value'].find((key) => Object.hasOwn(value, key) && !missing(value[key]));
    if (field) identity = value[field];
  }
  const type = Array.isArray(value) ? 'array' : record(value) ? 'object' : typeof value;
  return { key: canonical([type, identity]), label: labelText(displayValue(value)), missing: false, type, order: identity };
}

function compareGroup(left, right) {
  if (left.missing !== right.missing) return left.missing ? -1 : 1;
  if (left.type !== right.type) return compareText(left.type, right.type);
  if (typeof left.order !== typeof right.order) return compareText(typeof left.order, typeof right.order);
  if (typeof left.order === 'number' && typeof right.order === 'number' && Number.isFinite(left.order) && Number.isFinite(right.order)) {
    return left.order - right.order || compareText(left.key, right.key);
  }
  return compareLabel(left.label, right.label) || compareText(left.key, right.key);
}

function isBusinessEdge(edge, mapping) {
  const roles = [edge.importRole, mapping.importRole].filter(record);
  if ([edge.mappingType, edge.type, mapping.type, mapping.mappingType].some((type) => type === 'hierarchy' || type === 'static')) return false;
  if (roles.some((role) => role.templateStatic === true || role.semantic === 'static' || role.key === 'static' || String(role.key || '').startsWith('static:'))) return false;
  return !String(edge.blueprintKey || '').startsWith('static:') && edge.blueprint?.static !== true;
}

function baseGroup(edge, mapping) {
  const role = { ...mapping.importRole, ...edge.importRole };
  const direction = edge.direction ?? mapping.direction ?? '->';
  const undirected = direction === '--' || direction === 'undirected' || role.directionPolicy === 'undirected' || mapping.endpointResolution?.directionPolicy === 'undirected';
  const swap = undirected && compareText(String(edge.source), String(edge.target)) > 0;
  const source = swap ? edge.target : edge.source;
  const target = swap ? edge.source : edge.target;
  const key = canonical({
    mappingId: mapping.id,
    type: [mapping.type, mapping.mappingType, edge.type, edge.mappingType, edge.kind],
    class: [edge.class, edge.className, mapping.class, mapping.className, role.edgeClassKey],
    source, target, direction, undirected,
    blueprintKey: edge.blueprintKey,
    style: [edge.styleHints ?? role.styleHints, edge.style, mapping.style]
  });
  return { key, source, target, swap, direction };
}

function sourceRecord(edge) {
  const row = edge.runtimeRow;
  if (!record(row)) return canonical(['edge', edge.id]);
  return runtimeRowIdentity(row);
}

function buildGroups(records, config) {
  const root = { children: new Map(), leaves: [] };
  for (const entry of records) {
    let node = root;
    for (let depth = 0; depth < config.groupBy.length; depth += 1) {
      const value = entry.values[depth];
      if (!node.children.has(value.key)) node.children.set(value.key, { ...value, field: config.groupBy[depth], children: new Map(), leaves: [] });
      node = node.children.get(value.key);
      if (compareLabel(value.label, node.label) < 0) node.label = value.label;
    }
    node.leaves.push(entry);
  }
  let valueCount = 0;
  function visit(node) {
    let leaves = node.leaves.slice().sort((left, right) => {
      if (typeof left.edge.label === 'number' && typeof right.edge.label === 'number') return left.edge.label - right.edge.label || compareText(left.recordKey, right.recordKey);
      return compareLabel(left.label, right.label) || compareText(left.recordKey, right.recordKey);
    });
    if (config.duplicates === 'distinct') leaves = leaves.filter((entry, index) => index === 0 || entry.label !== leaves[index - 1].label);
    const values = leaves.map((entry) => ({ label: entry.label, ordinal: valueCount++ }));
    const children = [...node.children.values()].sort(compareGroup).map(visit);
    return { ...(node.field === undefined ? {} : { field: node.field, label: node.label, missing: node.missing, type: node.type }), groups: children, values };
  }
  return { root: visit(root), get valueCount() { return valueCount; } };
}

function renderGroups(root, format, visibleCount) {
  const visibleValues = (node) => node.values.filter((value) => value.ordinal < visibleCount).map((value) => value.label);
  function compact(node) {
    const children = node.groups.flatMap(compact);
    const values = visibleValues(node);
    if (!children.length && !values.length) return [];
    if (node.field === undefined) return [...values, ...children];
    const suffix = [...values, ...children];
    return [`${node.label} [${suffix.join(', ')}]`];
  }
  function tree(node, depth) {
    const children = node.groups.flatMap((child) => tree(child, node.field === undefined ? depth : depth + 1));
    const values = visibleValues(node).map((label) => `${'  '.repeat(node.field === undefined ? depth : depth + 1)}${label}`);
    if (!children.length && !values.length) return [];
    return [...(node.field === undefined ? [] : [`${'  '.repeat(depth)}${node.label}`]), ...values, ...children];
  }
  return (format === 'tree' ? tree(root, 0) : compact(root)).join('\n');
}

function boundedLabel(hierarchy, config) {
  const total = hierarchy.valueCount;
  const full = renderGroups(hierarchy.root, config.format, total);
  if (full.length <= config.maxLabelChars) return { label: full, labelTruncated: false, hiddenValues: 0 };
  let low = 0;
  let high = Math.max(0, total - 1);
  const render = (count) => {
    const prefix = renderGroups(hierarchy.root, config.format, count);
    return `${prefix ? `${prefix}\n` : ''}... (+${total - count} hidden values)`;
  };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(middle).length <= config.maxLabelChars) low = middle;
    else high = middle - 1;
  }
  return { label: render(low), labelTruncated: true, hiddenValues: total - low };
}

function aggregateGroup(group, hash) {
  const entries = group.entries.sort((left, right) => compareText(left.memberKey, right.memberKey));
  const base = entries[0].base;
  const records = [...new Map(entries.map((entry) => [entry.recordKey, entry])).values()];
  const hierarchy = buildGroups(records, group.config);
  const bounded = boundedLabel(hierarchy, group.config);
  const members = entries.map(({ edge }) => ({ id: edge.id, label: edge.label, data: clone(edge.data) }));
  const id = `edge_aggregation_${hash(canonical({ group: group.base.key, config: group.config, members: entries.map((entry) => [entry.edge.id, entry.label, entry.recordKey, entry.values.map((value) => value.key)]) }))}`;
  const sample = entries[0].edge;
  const edge = {};
  for (const field of ['kind', 'type', 'mappingType', 'class', 'className', 'importRole', 'blueprintKey', 'styleHints', 'style']) {
    if (Object.hasOwn(sample, field)) edge[field] = clone(sample[field]);
  }
  const { swap, source, target, direction } = base;
  const sourcePlaceholder = entries.some((entry) => Boolean(entry.edge[entry.base.swap ? 'targetPlaceholder' : 'sourcePlaceholder']));
  const targetPlaceholder = entries.some((entry) => Boolean(entry.edge[entry.base.swap ? 'sourcePlaceholder' : 'targetPlaceholder']));
  return Object.assign(edge, {
    id, d2Id: id, source, target, direction, label: bounded.label,
    sourceD2Id: sample[swap ? 'targetD2Id' : 'sourceD2Id'],
    targetD2Id: sample[swap ? 'sourceD2Id' : 'targetD2Id'],
    sourcePlaceholder, targetPlaceholder,
    data: {
      kind: 'edge', id, label: bounded.label, source, target, sourcePlaceholder, targetPlaceholder,
      aggregation: {
        memberCount: records.length, connectionCount: records.length,
        groups: group.config.groupBy.length ? hierarchy.root.groups : [{ groups: [], values: hierarchy.root.values }],
        members, labelTruncated: bounded.labelTruncated, hiddenValues: bounded.hiddenValues
      }
    }
  });
}

export function aggregateDiagramEdges(edges, { readField = defaultReadField, displayValue = defaultDisplayValue, hash = digest } = {}) {
  const groups = new Map();
  const rules = new Map();
  const untouched = [];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const mapping = edge?.runtimeMapping || {};
    const raw = mapping.aggregation;
    const errors = validateEdgeAggregation(raw, { path: `$.edges[${index}].runtimeMapping.aggregation` });
    if (errors.length) throw new DiagramEdgeAggregationError(errors);
    const config = normalizeEdgeAggregation(raw);
    if (!config?.enabled || !isBusinessEdge(edge, mapping)) {
      untouched.push(edge);
      continue;
    }
    const base = baseGroup(edge, mapping);
    const key = canonical([base.key, config]);
    const ruleKey = canonical([mapping.id, mapping.type, mapping.importRole?.edgeClassKey]);
    if (!rules.has(ruleKey)) rules.set(ruleKey, {
      label: labelText(mapping.importRole?.label || mapping.label || 'Connection').slice(0, 2000),
      inputEdges: 0, outputEdges: 0, records: new Set(), truncatedLabels: 0
    });
    const rule = rules.get(ruleKey);
    const recordKey = sourceRecord(edge);
    rule.inputEdges += 1;
    rule.records.add(recordKey);
    const label = labelText(edge.label);
    const values = config.groupBy.map((field) => groupValue(readField(edge.runtimeRow, field), (value) => displayValue(value, edge.runtimeRow, field)));
    const entry = { edge, base, label, values, recordKey, memberKey: canonical([edge.id, label, values.map((value) => [value.key, value.label]), edge.data]) };
    if (!groups.has(key)) groups.set(key, { base, config, rule, entries: [] });
    groups.get(key).entries.push(entry);
  }
  if (!groups.size) return { edges, diagnostics: [], warnings: [] };
  const warnings = [];
  for (const [, group] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
    const edge = aggregateGroup(group, hash);
    untouched.push(edge);
    group.rule.outputEdges += 1;
    if (edge.data.aggregation.labelTruncated) group.rule.truncatedLabels += 1;
  }
  const diagnostics = [...rules.entries()].sort(([left], [right]) => compareText(left, right)).map(([, rule]) => ({
    label: rule.label, inputEdges: rule.inputEdges, outputEdges: rule.outputEdges,
    uniqueRecords: rule.records.size, truncatedLabels: rule.truncatedLabels
  }));
  const truncated = diagnostics.reduce((sum, rule) => sum + rule.truncatedLabels, 0);
  if (truncated) warnings.push(`Aggregation shortened ${truncated} connection label(s); hidden values remain available in connection details.`);
  return { edges: untouched.sort((left, right) => compareText(String(left?.id || ''), String(right?.id || ''))), diagnostics, warnings };
}
