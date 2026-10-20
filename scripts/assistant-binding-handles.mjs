const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const referenceKeys = new Set(['structureItemId', 'parentStructureItemId']);
const textKeys = new Set(['explanation', 'message', 'reason', 'warnings']);
const literalKeys = new Set(['value', 'labelTemplate']);
const fallbackDisplayName = '\u044d\u043b\u0435\u043c\u0435\u043d\u0442 \u0434\u0438\u0430\u0433\u0440\u0430\u043c\u043c\u044b';

function invalid(code, message) {
  throw Object.assign(new Error(message), { code });
}

/**
 * @param {Array<{structureItemId: string, visualKind?: string, displayName?: string}>} placements
 * @returns {{encode: (payload: unknown) => unknown, decode: (response: unknown) => unknown}}
 */
export function createAssistantBindingHandles(placements) {
  if (!Array.isArray(placements)) invalid('assistant_binding_handles_invalid_placements', 'Binding handles require a placement array.');
  const ids = new Set();
  for (const placement of placements) {
    if (!record(placement) || typeof placement.structureItemId !== 'string' || !placement.structureItemId.trim()) {
      invalid('assistant_binding_handles_invalid_placements', 'Each binding placement must have a nonempty structure item id.');
    }
    if (ids.has(placement.structureItemId)) invalid('assistant_binding_handles_duplicate_id', 'Binding placement structure item ids must be unique.');
    ids.add(placement.structureItemId);
  }
  const encoded = new Map();
  const decoded = new Map();
  const displayNames = new Map();
  const counts = { container: 0, node: 0, placement: 0 };
  for (const placement of placements) {
    const kind = ['container', 'node'].includes(placement.visualKind) ? placement.visualKind : 'placement';
    const handle = `${kind}_${++counts[kind]}`;
    if (ids.has(handle) || decoded.has(handle)) invalid('assistant_binding_handles_collision', 'Binding handles must not collide with placement ids or other handles.');
    encoded.set(placement.structureItemId, handle);
    decoded.set(handle, placement.structureItemId);
    const name = typeof placement.displayName === 'string' ? placement.displayName.trim() : '';
    displayNames.set(handle, name && name !== placement.structureItemId ? name : fallbackDisplayName);
  }
  const projectText = (value) => value.replace(
    /(?<![\p{L}\p{N}_./:-])(?:container|node|placement)_\d+(?![\p{L}\p{N}_]|[./:-][\p{L}\p{N}_])/gu,
    (handle) => displayNames.get(handle) ?? handle
  );
  const walk = (value, reverse, literal = false, text = false) => {
    if (typeof value === 'string') return reverse && !literal && text ? projectText(value) : value;
    if (Array.isArray(value)) return value.map((item) => walk(item, reverse, literal, text));
    if (!record(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      const reference = referenceKeys.has(name) || name === 'targetId' && value.targetType === 'placement';
      if (!literal && reference && typeof item === 'string') return [name, (reverse ? decoded : encoded).get(item) ?? item];
      const protectedValue = literal || literalKeys.has(name);
      return [name, walk(item, reverse, protectedValue, !protectedValue && textKeys.has(name))];
    }));
  };
  return {
    encode: (payload) => walk(payload, false),
    decode: (response) => walk(response, true)
  };
}
