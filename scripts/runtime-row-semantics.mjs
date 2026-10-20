import { createHash } from 'node:crypto';

const rows = new WeakMap();
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = (value) => value !== undefined && value !== null && value !== '';

function typed(value) {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', value.map(typed)];
  if (record(value)) return ['object', Object.keys(value).sort().map((key) => [key, typed(value[key])])];
  return [typeof value, String(value)];
}

export const runtimeSemanticKey = (value) => JSON.stringify(typed(value));
const identityKey = (value) => createHash('sha256').update(runtimeSemanticKey(value)).digest('hex');

export function runtimeRowIdentity(row) {
  if (record(row) && rows.has(row)) return rows.get(row).identity;
  if (record(row) && present(row.Class) && present(row._id ?? row.Id ?? row.id)) {
    return identityKey(['card', row.Class, row._id ?? row.Id ?? row.id]);
  }
  return identityKey(['row', row]);
}

export function setRuntimeRowSemantics(row, identity, rawFields = row) {
  if (!record(row)) return row;
  rows.set(row, {
    identity: identityKey(identity),
    fields: rawFields instanceof Map ? new Map(rawFields) : new Map(Object.entries(rawFields || {}))
  });
  return row;
}

export function runtimeRowValue(row, field, read = (value, key) => value && value[key]) {
  const fields = record(row) && rows.get(row)?.fields;
  return fields?.has(field) ? fields.get(field) : read(row, field);
}

export function setRuntimeRowValue(row, field, value) {
  if (!record(row)) return row;
  if (!rows.has(row)) rows.set(row, { identity: runtimeRowIdentity(row), fields: new Map() });
  rows.get(row).fields.set(field, value);
  return row;
}

export function inheritRuntimeRowSemantics(target, source, additions = {}) {
  if (!record(target)) return target;
  const fields = new Map();
  for (const field of Object.keys(target)) {
    if (record(source) && Object.hasOwn(source, field)) fields.set(field, runtimeRowValue(source, field));
    else fields.set(field, target[field]);
  }
  for (const [field, value] of Object.entries(additions)) fields.set(field, value);
  rows.set(target, { identity: runtimeRowIdentity(source), fields });
  return target;
}

export function mergeRuntimeRowSemantics(target, left, right, leftColumns, rightMapping) {
  const fields = new Map();
  for (const field of leftColumns) fields.set(field, left ? runtimeRowValue(left, field) : target[field]);
  for (const entry of rightMapping) fields.set(entry.target, right ? runtimeRowValue(right, entry.source) : target[entry.target]);
  rows.set(target, {
    identity: identityKey(['pair', left ? runtimeRowIdentity(left) : null, right ? runtimeRowIdentity(right) : null]),
    fields
  });
  return target;
}

export function deriveRuntimeRowSemantics(target, source, discriminator, additions = {}) {
  inheritRuntimeRowSemantics(target, source, additions);
  rows.get(target).identity = identityKey(['derived', runtimeRowIdentity(source), discriminator]);
  return target;
}
