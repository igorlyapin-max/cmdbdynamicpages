const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && value.trim().length > 0;
const emptyScope = (value) => value === undefined || value === null || value === '';

function scopeError(code, message) {
  return { structureItemId: '', error: { code, message } };
}

/**
 * @param {unknown} value
 * @param {unknown} tree
 * @param {Array<{id: string, visualKind?: string, isContainer?: boolean}>} roles
 * @returns {{structureItemId: string, error: null | {code: string, message: string}}}
 */
export function resolveDiagramEndpointScope(value, tree, roles = []) {
  if (emptyScope(value)) return { structureItemId: '', error: null };
  if (!identifier(value)) return scopeError('diagram_endpoint_scope_invalid', 'Endpoint scope must be an exact structure item id or template element key.');
  const items = record(tree) && Array.isArray(tree.items) ? tree.items.filter(record) : [];
  const matches = items.filter((item) => item.id === value || item.templateElementKey === value);
  if (!matches.length) return scopeError('diagram_endpoint_scope_not_found', 'Endpoint scope does not identify a structure item.');
  if (matches.length !== 1) return scopeError('diagram_endpoint_scope_ambiguous', 'Endpoint scope identifies more than one structure item.');
  const item = matches[0];
  if (!identifier(item.id)) return scopeError('diagram_endpoint_scope_invalid', 'Endpoint scope structure item must have a nonempty id.');
  if (items.filter((candidate) => candidate.id === item.id).length !== 1) return scopeError('diagram_endpoint_scope_ambiguous', 'Endpoint scope structure item id is not unique.');
  const matchingRoles = Array.isArray(roles) && identifier(item.roleId)
    ? roles.filter((role) => record(role) && role.id === item.roleId)
    : [];
  if (matchingRoles.length > 1) return scopeError('diagram_endpoint_scope_ambiguous', 'Endpoint scope structure role is not unique.');
  const role = matchingRoles[0];
  const container = role && (role.visualKind === 'container'
    ? role.isContainer !== false
    : (role.visualKind === undefined || role.visualKind === '') && role.isContainer === true);
  if (!container) return scopeError('diagram_endpoint_scope_not_container', 'Endpoint scope must identify a structure item with a known container role.');
  return { structureItemId: item.id, error: null };
}

/**
 * @template T
 * @param {T[]} objects
 * @param {unknown} scopeStructureItemId
 * @returns {T[]}
 */
export function diagramObjectsWithinScope(objects, scopeStructureItemId) {
  if (!Array.isArray(objects)) return [];
  if (emptyScope(scopeStructureItemId)) return objects;
  if (!identifier(scopeStructureItemId)) return [];
  const byId = new Map();
  const duplicates = new Set();
  for (const object of objects) {
    if (!record(object) || !identifier(object.id)) continue;
    if (byId.has(object.id)) duplicates.add(object.id);
    else byId.set(object.id, object);
  }
  return objects.filter((object) => {
    const visited = new Set();
    let current = object;
    let matched = false;
    // Do not return on a scope match: the remaining ancestry must also be valid.
    while (current) {
      if (!record(current) || !identifier(current.id) || duplicates.has(current.id) || visited.has(current.id)) return false;
      visited.add(current.id);
      if (current.importRole !== undefined && !record(current.importRole)) return false;
      const placementId = current.importRole?.structureItemId;
      if (placementId !== undefined && typeof placementId !== 'string') return false;
      if (placementId === scopeStructureItemId) matched = true;
      const parent = Object.hasOwn(current, 'group') ? current.group : current.parent;
      if (parent === undefined || parent === '') return matched;
      if (!identifier(parent) || !byId.has(parent)) return false;
      current = byId.get(parent);
    }
    return false;
  });
}
