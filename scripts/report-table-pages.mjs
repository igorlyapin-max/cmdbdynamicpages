import { createHash } from 'node:crypto';

export const LARGE_TABLE_ROW_BUDGET = 10_000;
export const LARGE_TABLE_DEFAULT_PAGE_SIZE = 50;
export const LARGE_TABLE_MAX_PAGE_SIZE = 100;
export const LARGE_TABLE_MAX_MEMBERSHIPS = 100_000;
export const LARGE_TABLE_MAX_AGGREGATE_CELL_LENGTH = 4096;
const MAX_AGGREGATE_TEXT_BYTES = 16 * 1024 * 1024;

const MODES = ['all', 'key'];
const SOURCES = ['class', 'result'];
const REDUCTIONS = ['unique', 'count', 'tuples'];
const OPERATIONS = ['options', 'rows', 'details'];
const RESERVED_FIELDS = new Set(['__proto__', 'prototype', 'constructor', '__cmdpRowIndex']);
const TABLE_TEXT_FIELDS = ['name', 'title', 'titleParam', 'label', 'mode', 'view', 'emptyText'];
const PRESENTATION_FIELDS = [
  'title', 'titleAlign', 'density', 'fontSize', 'zebra', 'sortable', 'filters', 'sortColumn', 'sortDirection',
  'groupBy', 'groupTitleColumnLabel', 'groupTitleTemplate', 'splitSubtables'
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, name) {
  return value != null && Object.hasOwn(value, name) ? value[name] : undefined;
}

function identifier(value) {
  return typeof value === 'string' && value.trim() !== '' && !RESERVED_FIELDS.has(value.trim());
}

function fieldSet(fields) {
  return Array.isArray(fields) || fields instanceof Set ? new Set(fields) : null;
}

export function validateLargeTablePresentation(value, { fields, optionFields, visibleFields = fields } = {}) {
  if (value == null) return [];
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!record(value)) {
    add('', 'Large table presentation must be an object.');
    return errors;
  }

  const knownFields = fieldSet(fields);
  const knownVisible = fieldSet(visibleFields);
  const knownOptions = fieldSet(optionFields);
  function checkField(field, path, known) {
    if (!identifier(field)) add(path, 'Expected a non-empty field name.');
    else if (known && !known.has(field.trim())) add(path, 'Field is not available.');
  }
  function checkFields(list, path, known) {
    if (!Array.isArray(list)) {
      add(path, 'Expected an array of field names.');
      return;
    }
    const seen = new Set();
    for (const [index, field] of list.entries()) {
      const itemPath = `${path}[${index}]`;
      checkField(field, itemPath, known);
      if (identifier(field)) {
        if (seen.has(field.trim())) add(itemPath, 'Field must not be repeated.');
        seen.add(field.trim());
      }
    }
  }

  if (!MODES.includes(value.mode)) add('mode', 'Expected all or key.');
  if (value.mode === 'key') {
    const selector = value.selector;
    if (!record(selector)) add('selector', 'Key mode requires a selector.');
    else {
      if (!SOURCES.includes(selector.kind)) add('selector.kind', 'Expected class or result.');
      checkField(selector.source, 'selector.source');
      checkField(selector.idField, 'selector.idField', knownOptions);
      checkField(selector.labelField, 'selector.labelField', knownOptions);
      checkField(selector.matchField, 'selector.matchField', knownFields);
      if (selector.parameter !== undefined) checkField(selector.parameter, 'selector.parameter');
    }
  } else if (value.selector !== undefined) {
    add('selector', 'A selector is only valid in key mode.');
  }

  const groupKeys = value.groupKeys === undefined ? [] : value.groupKeys;
  const reductions = value.reductions === undefined ? [] : value.reductions;
  checkFields(groupKeys, 'groupKeys', knownVisible);
  if (!Array.isArray(reductions)) add('reductions', 'Expected an array of reductions.');
  else {
    if (reductions.length && Array.isArray(groupKeys) && !groupKeys.length) {
      add('reductions', 'Reductions require at least one grouping key.');
    }
    const groupFields = new Set(Array.isArray(groupKeys) ? groupKeys.filter(identifier).map((key) => key.trim()) : []);
    const targets = new Set();
    for (const [index, item] of reductions.entries()) {
      const path = `reductions[${index}]`;
      if (!record(item)) {
        add(path, 'Expected a reduction object.');
        continue;
      }
      checkField(item.column, `${path}.column`, knownVisible);
      if (identifier(item.column)) {
        const column = item.column.trim();
        if (groupFields.has(column)) add(`${path}.column`, 'Grouping keys cannot be reduced.');
        if (targets.has(column)) add(`${path}.column`, 'Column already has a reduction.');
        targets.add(column);
      }
      if (!REDUCTIONS.includes(item.kind)) add(`${path}.kind`, 'Expected unique, count or tuples.');
      if (item.kind === 'tuples') {
        checkFields(item.fields, `${path}.fields`, knownVisible);
        if (Array.isArray(item.fields) && !item.fields.length) add(`${path}.fields`, 'A tuple needs at least one field.');
      } else if (item.fields !== undefined) add(`${path}.fields`, 'Only tuples accept fields.');
      if (item.separator !== undefined && (item.kind === 'count' || typeof item.separator !== 'string' || item.separator.length > 64)) {
        add(`${path}.separator`, 'Expected a separator of at most 64 characters for unique or tuples.');
      }
    }
  }
  return errors;
}

export function normalizeLargeTablePresentation(value) {
  if (value == null || validateLargeTablePresentation(value).length) return null;
  const result = { mode: value.mode, groupKeys: (value.groupKeys || []).map((key) => key.trim()), reductions: [] };
  if (value.mode === 'key') {
    const { kind, source, idField, labelField, matchField, parameter } = value.selector;
    result.selector = { kind, source: source.trim(), idField: idField.trim(), labelField: labelField.trim(), matchField: matchField.trim() };
    if (parameter !== undefined) result.selector.parameter = parameter.trim();
  }
  result.reductions = (value.reductions || []).map(({ column, kind, fields, separator }) => ({
    column: column.trim(),
    kind,
    ...(fields === undefined ? {} : { fields: fields.map((field) => field.trim()) }),
    ...(separator === undefined ? {} : { separator })
  }));
  return result;
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
}

function keyValue(value) {
  if (scalar(value) && value !== '') return value;
  if (!record(value)) return null;
  const className = own(value, 'className') ?? own(value, 'class') ?? own(value, 'Class') ?? own(value, '_class') ?? own(value, '_type');
  const id = own(value, 'id') ?? own(value, '_id') ?? own(value, 'Id');
  return typeof className === 'string' && className.trim() && scalar(id) && id !== ''
    ? { className: className.trim(), id } : null;
}

function opaqueId(prefix, value) {
  return prefix + createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

// Wire keys are opaque. Compare or resolve them; do not parse them as CMDB ids.
export function encodeLargeTableKey(value) {
  const identity = keyValue(value);
  return identity === null ? null : opaqueId('k_', identity);
}

function projectCell(value) {
  if (scalar(value)) return value;
  if (Array.isArray(value)) return value.map(projectCell);
  if (record(value)) {
    for (const field of ['_description_translation', '_description', 'description', 'Description', 'label', 'name', 'Code', 'code']) {
      const label = own(value, field);
      if (scalar(label) && label !== '') return label;
    }
    const identity = keyValue(value);
    if (identity !== null) return identity.id;
  }
  return null;
}

function groupValue(value) {
  if (Array.isArray(value)) return value.map(groupValue);
  return keyValue(value) ?? projectCell(value);
}

function cellText(value) {
  if (Array.isArray(value)) return value.map(cellText).join(', ');
  return value === null ? '' : String(value);
}

function freezeTree(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function safeRowMeta(table, columns, rowIndex) {
  const source = own(table.cellMeta, rowIndex);
  const entries = [];
  for (const column of columns) {
    const meta = own(source, column);
    if (!record(meta)) continue;
    const safe = {};
    for (const field of ['attribute', 'attributePath', 'attributeType']) {
      if (typeof own(meta, field) === 'string') safe[field] = meta[field];
    }
    const autoHref = own(meta, 'autoHref');
    if (typeof autoHref === 'string' && /^(?:https?:\/\/|mailto:)/iu.test(autoHref)) safe.autoHref = autoHref;
    if (Object.keys(safe).length) entries.push([column, safe]);
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

function tableHeader(table, columns, config) {
  const result = {};
  for (const field of TABLE_TEXT_FIELDS) {
    if (typeof own(table, field) === 'string') result[field] = table[field];
  }
  for (const field of ['published', 'truncated']) {
    if (typeof own(table, field) === 'boolean') result[field] = table[field];
  }
  result.columns = columns;
  result.columnLabels = Object.fromEntries(columns.flatMap((column) => {
    const value = own(table.columnLabels, column);
    return typeof value === 'string' ? [[column, value]] : [];
  }));
  const presentation = { largeTable: config };
  for (const field of PRESENTATION_FIELDS) {
    const value = own(table.presentation, field);
    if (typeof value === 'string' || typeof value === 'boolean') presentation[field] = value;
  }
  for (const field of ['sortColumn', 'groupBy']) {
    if (!columns.includes(presentation[field])) delete presentation[field];
  }
  const rowGroupBy = own(table.presentation, 'rowGroupBy');
  if (Array.isArray(rowGroupBy)) presentation.rowGroupBy = rowGroupBy.filter((field) => columns.includes(field));
  const links = own(table.presentation, 'columnLinks');
  const columnLinks = columns.flatMap((column) => {
    const link = own(links, column);
    if (!record(link)) return [];
    const fields = ['mode', 'urlTemplate', 'textTemplate', 'target'].filter((field) => typeof own(link, field) === 'string');
    return fields.length ? [[column, Object.fromEntries(fields.map((field) => [field, link[field]]))]] : [];
  });
  if (columnLinks.length) presentation.columnLinks = Object.fromEntries(columnLinks);
  result.presentation = presentation;
  return result;
}

function contractError(code, message, indexBudget) {
  if (indexBudget) return Object.assign(new RangeError(message), { code, reason: code, statusCode: 422, indexBudget });
  return Object.assign(new TypeError(message), { code });
}

// matchValues and groupValues are private, row-aligned values from before projection.
export function buildLargeTableIndex(table, optionRows = [], { matchValues, groupValues } = {}) {
  const rawConfig = table?.presentation?.largeTable;
  if (rawConfig == null) return null;
  const columns = Array.isArray(table.columns) ? [...new Set(table.columns.filter(identifier))] : [];
  const errors = validateLargeTablePresentation(rawConfig, { visibleFields: columns });
  if (errors.length) {
    throw Object.assign(contractError('invalid_large_table_presentation', 'Invalid large table presentation.'), { errors });
  }
  const config = normalizeLargeTablePresentation(rawConfig);
  const rows = table.rows ?? [];
  if (!Array.isArray(rows)) throw contractError('invalid_large_table_rows', 'Large table rows must be an array.');
  if (rows.length > LARGE_TABLE_ROW_BUDGET) {
    throw contractError('large_table_row_limit', `Large table row budget of ${LARGE_TABLE_ROW_BUDGET} exceeded.`,
      ['maxRows', LARGE_TABLE_ROW_BUDGET, rows.length, 'rows']);
  }
  for (const values of [matchValues, groupValues]) {
    if (values !== undefined && (!Array.isArray(values) || values.length !== rows.length)) {
      throw contractError('invalid_large_table_rows', 'Private values must be aligned with large table rows.');
    }
  }
  if (groupValues && Array.from(groupValues).some((values) => !Array.isArray(values) || values.length !== config.groupKeys.length)) {
    throw contractError('invalid_large_table_rows', 'Private group values must match the configured group keys.');
  }
  if (config.selector && !Array.isArray(optionRows)) {
    throw contractError('invalid_large_table_options', 'Large table options must be an array.');
  }

  const options = new Map();
  const byKey = {};
  const selector = config.selector;
  if (selector) {
    for (const row of optionRows) {
      const value = keyValue(own(row, selector.idField));
      if (value === null) continue;
      const key = encodeLargeTableKey(value);
      const label = cellText(projectCell(own(row, selector.labelField)));
      if (!options.has(key) || (!options.get(key).label && label)) options.set(key, { key, label, value });
      byKey[key] ??= [];
    }
  }
  for (const option of options.values()) {
    if (!option.label) option.label = cellText(record(option.value) ? option.value.id : option.value);
  }

  let memberships = 0;
  const indexedRows = Array.from(rows, (row, index) => {
    if (selector) {
      const value = matchValues === undefined ? own(row, selector.matchField) : matchValues[index];
      const matches = Array.isArray(value) ? value : value == null ? [] : [value];
      memberships += matches.length;
      if (memberships > LARGE_TABLE_MAX_MEMBERSHIPS) {
        throw contractError('large_table_membership_limit', 'Large table membership budget exceeded.',
          ['maxIndexMemberships', LARGE_TABLE_MAX_MEMBERSHIPS, memberships, 'memberships']);
      }
      const keys = new Set(matches.map(encodeLargeTableKey));
      for (const key of keys) {
        if (options.has(key)) byKey[key].push(index);
      }
    }
    const visible = Object.fromEntries(columns.map((column) => [column, projectCell(own(row, column))]));
    const group = config.groupKeys.length ? opaqueId('g_', (
      groupValues === undefined ? config.groupKeys.map((field) => own(row, field)) : groupValues[index]
    ).map(groupValue)) : null;
    return { visible, group, meta: safeRowMeta(table, columns, index) };
  });

  const groupsByScope = {};
  if (config.groupKeys.length) {
    let aggregateTextBytes = 0;
    const accountReduction = (value) => {
      if (typeof value === 'string') aggregateTextBytes += Buffer.byteLength(value);
      if (aggregateTextBytes > MAX_AGGREGATE_TEXT_BYTES) {
        throw contractError('large_table_aggregate_limit', 'Large table aggregate text budget exceeded.',
          ['maxIndexAggregateBytes', MAX_AGGREGATE_TEXT_BYTES, aggregateTextBytes, 'bytes']);
      }
      return value;
    };
    const scopes = selector ? Object.entries(byKey) : [['all', indexedRows.map((_, index) => index)]];
    for (const [key, indexes] of scopes) {
      if (indexes.length) groupsByScope[key] = buildGroups(indexedRows, indexes, columns, config, accountReduction);
    }
  }

  return freezeTree({
    version: 1,
    table: tableHeader(table, columns, config),
    options: [...options.values()].sort((a, b) => compare(a.label, b.label) || compare(a.key, b.key)),
    byKey,
    groupsByScope,
    rows: indexedRows
  });
}

export function resolveLargeTableKey(index, key) {
  if (typeof key !== 'string') return null;
  const entry = index?.options.find((option) => option.key === key);
  return entry ? (record(entry.value) ? { ...entry.value } : entry.value) : null;
}

function compare(left, right) {
  if (left === right) return 0;
  const rank = (value) => value === null ? 4 : Array.isArray(value) ? 3
    : typeof value === 'boolean' ? 0 : typeof value === 'number' ? 1 : 2;
  const typeOrder = rank(left) - rank(right);
  if (typeOrder) return typeOrder;
  if (Array.isArray(left)) {
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
      const difference = compare(left[i], right[i]);
      if (difference) return difference;
    }
    return left.length - right.length;
  }
  return left < right ? -1 : 1;
}

function distinctSorted(values) {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()].sort(compare);
}

function boundedText(parts) {
  let text = '';
  for (const part of parts) {
    const remaining = LARGE_TABLE_MAX_AGGREGATE_CELL_LENGTH - text.length;
    if (part.length > remaining) {
      const prefix = (text + part.slice(0, remaining)).slice(0, -3).replace(/[\uD800-\uDBFF]$/u, '');
      return prefix + '...';
    }
    text += part;
  }
  return text;
}

function* joinedText(values, separator, format = cellText) {
  let first = true;
  for (const value of values) {
    if (!first) yield separator;
    first = false;
    yield format(value);
  }
}

function* tupleText(buckets, separator) {
  let first = true;
  for (const { head, values } of buckets.values()) {
    if (!first) yield separator;
    first = false;
    yield cellText(head);
    yield ' [';
    for (const [index, fields] of values.entries()) {
      if (index) yield ', ';
      yield* joinedText(fields, ' / ');
    }
    yield ']';
  }
}

function reduceValues(rows, { kind, column, fields, separator }) {
  if (kind === 'count') return rows.length;
  if (kind === 'tuples') {
    const tuples = distinctSorted(rows.map(({ visible }) => fields.map((field) => visible[field])));
    const buckets = new Map();
    for (const [head, ...tail] of tuples) {
      const key = JSON.stringify(head);
      if (!buckets.has(key)) buckets.set(key, { head, values: [] });
      buckets.get(key).values.push(tail);
    }
    return boundedText(tupleText(buckets, separator ?? '; '));
  }
  const values = distinctSorted(rows.map(({ visible }) => visible[column])).filter((value) => value !== '' && value !== null);
  return boundedText(joinedText(values, separator ?? ', '));
}

function buildGroups(rows, indexes, columns, config, accountReduction) {
  const membersByGroup = {};
  for (const index of indexes) {
    const group = rows[index].group;
    (membersByGroup[group] ??= []).push(index);
  }
  const keys = new Set(config.groupKeys);
  const reductions = new Map(config.reductions.map((item) => [item.column, item]));
  const summaries = Object.entries(membersByGroup).map(([group, members]) => {
    const source = members.map((index) => rows[index]);
    return {
      group,
      visible: Object.fromEntries(columns.map((column) => [
        column,
        keys.has(column) ? source[0].visible[column]
          : accountReduction(reduceValues(source, reductions.get(column) ?? { kind: 'unique', column }))
      ]))
    };
  });
  return { summaries, membersByGroup };
}

function readPageQuery(query) {
  const invalid = (field) => { throw contractError('invalid_large_table_query', `Invalid large table query: ${field}.`); };
  const pick = (field) => {
    if (!(query instanceof URLSearchParams)) return own(query, field);
    const values = query.getAll(field);
    if (values.length > 1) invalid(field);
    return values[0];
  };
  const string = (field, max) => {
    const value = pick(field);
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) invalid(field);
    return value;
  };
  const integer = (field, fallback, minimum) => {
    const raw = pick(field);
    if (raw == null || raw === '') return fallback;
    const value = typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(value) || value < minimum) invalid(field);
    return value;
  };
  const op = string('op', 16) || 'rows';
  const direction = string('direction', 4);
  const key = string('key', 45);
  const group = string('group', 45);
  if (!OPERATIONS.includes(op)) invalid('op');
  if (direction && direction !== 'asc' && direction !== 'desc') invalid('direction');
  if (key && !/^k_[A-Za-z0-9_-]{43}$/u.test(key)) invalid('key');
  if (group && !/^g_[A-Za-z0-9_-]{43}$/u.test(group)) invalid('group');
  return {
    op, key, group, direction, search: searchText(string('search', 256).trim()), sort: string('sort', 512),
    offset: integer('offset', 0, 0),
    limit: Math.min(integer('limit', LARGE_TABLE_DEFAULT_PAGE_SIZE, 1), LARGE_TABLE_MAX_PAGE_SIZE)
  };
}

function searchText(value) {
  return value.normalize('NFKC').toLowerCase();
}

export function queryLargeTablePage(index, query = {}) {
  if (index == null) return null;
  const { op, key, group, search, sort, direction, offset, limit } = readPageQuery(query);
  const incomplete = Boolean(index.table.truncated);
  if (op === 'options') {
    const items = search ? index.options.filter(({ label }) => searchText(label).includes(search)) : index.options;
    return { items: items.slice(offset, offset + limit).map(({ key: itemKey, label }) => ({ key: itemKey, label })), total: items.length, offset, limit, incomplete };
  }
  const { columns, presentation } = index.table;
  const config = presentation.largeTable;
  if (sort && !columns.includes(sort)) throw contractError('invalid_large_table_query', 'Sort column is not visible.');
  const scopeGroups = own(index.groupsByScope, config.mode === 'all' ? 'all' : key);
  const summary = op === 'rows' && config.groupKeys.length > 0;
  let rows;
  if (summary) rows = scopeGroups?.summaries ?? [];
  else if (op === 'details') rows = (own(scopeGroups?.membersByGroup, group) ?? []).map((rowIndex) => index.rows[rowIndex]);
  else rows = config.mode === 'all' ? index.rows : (own(index.byKey, key) ?? []).map((rowIndex) => index.rows[rowIndex]);
  if (search) rows = rows.filter((row) => columns.some((column) => searchText(cellText(row.visible[column])).includes(search)));
  const order = sort || presentation.sortColumn;
  if (order) {
    const sign = (direction || presentation.sortDirection) === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b) => sign * compare(a.visible[order], b.visible[order]));
  }
  const selected = rows.slice(offset, offset + limit);
  // Metadata indexes are relative to the returned page, never to the source rows.
  const cellMeta = Object.fromEntries(selected.flatMap(({ meta }, position) => meta ? [[position, meta]] : []));
  const table = { ...index.table, rows: selected.map(({ visible }) => visible), cellMeta };
  return { table, total: rows.length, offset, limit, incomplete, ...(summary ? { groupIds: selected.map(({ group: id }) => id) } : {}) };
}
