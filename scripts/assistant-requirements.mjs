import { createHash } from 'node:crypto';

const DIRECTIVES = new Set([
  'materialization', 'binding-result', 'stage-policy', 'row-grain', 'membership',
  'required-condition', 'required-membership', 'endpoint-mode', 'endpoint-field',
  'endpoint-operator', 'source-field', 'source-operator', 'target-field',
  'target-operator', 'exemplars', 'card-source', 'membership-card-source',
  'parent-membership-card-source', 'label-template', 'endpoint-scope'
]);
const REPEATED_DIRECTIVES = new Set([
  'required-condition', 'required-membership', 'endpoint-field', 'endpoint-operator'
]);
const STATUSES = new Set(['compiled', 'unresolved', 'conflict']);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function invalidInput() {
  return Object.assign(new TypeError('Invalid assistant requirement input.'), {
    code: 'assistant_requirement_input_invalid'
  });
}

function sourceArray(owner, key) {
  if (owner[key] === undefined) return [];
  if (!Array.isArray(owner[key])) throw invalidInput();
  return owner[key];
}

function sourceText(owner, key) {
  if (owner[key] === undefined) return '';
  if (typeof owner[key] !== 'string') throw invalidInput();
  return owner[key];
}

function placementScopes(placement, text) {
  const role = sourceText(placement, 'roleNotes').trim();
  const local = sourceText(placement, 'placementNotes').trim();
  const parts = role ? [{ scope: 'role', text: role }] : [];
  if (local === role && local) parts[0].scope = 'placement';
  else if (local) parts.push({ scope: 'placement', text: local });
  // Only the existing builder's exact composition proves a placement override.
  // Parsed directives or guesses about paragraph order are not provenance.
  if (text.trim() !== parts.map((part) => part.text).join('\n\n')) return [];
  let cursor = text.indexOf(text.trim());
  return parts.map((part) => {
    const range = { scope: part.scope, start: cursor, end: cursor + part.text.length };
    cursor = range.end + 2;
    return range;
  });
}

function ledgerSources(input) {
  if (!plain(input)) throw invalidInput();
  const manifest = input.businessBlockManifest ?? {};
  if (!plain(manifest)) throw invalidInput();
  const sources = [];
  const seen = new Set();
  const collect = (items, targetType, idOf, kindOf) => {
    for (const item of items) {
      if (!plain(item)) throw invalidInput();
      const id = idOf(item);
      if (typeof id !== 'string' || !id.trim()) throw invalidInput();
      const targetId = id.trim();
      const key = JSON.stringify([targetType, targetId]);
      if (seen.has(key)) throw invalidInput();
      seen.add(key);
      const sourceKind = kindOf(item);
      const text = sourceText(item, sourceKind);
      sources.push({
        targetType, targetId, sourceKind, text,
        scopes: targetType === 'placement' ? placementScopes(item, text) : []
      });
    }
  };
  collect(sourceArray(manifest, 'blocks'), 'businessBlock', (item) => item.id, () => 'description');
  collect(sourceArray(input, 'placements'), 'placement', (item) => item.structureItemId, () => 'notes');
  collect(sourceArray(input, 'relationRules'), 'connection', (item) => item.d2ClassKey || item.d2ElementKey,
    (item) => item.d2Notes !== undefined ? 'd2Notes' : 'notes');
  return sources;
}

function sourceRequirements(source) {
  const requirements = [];
  let paragraph = null;
  const add = (start, end, directive = null) => {
    const text = source.text.slice(start, end);
    const identity = [source.targetType, source.targetId, source.sourceKind, start, end, text];
    requirements.push({
      id: `req_${hash(identity)}`,
      targetType: source.targetType,
      targetId: source.targetId,
      sourceKind: source.sourceKind,
      sourceText: text,
      start,
      end,
      kind: directive ? 'directive' : 'paragraph',
      ...(directive ? { directiveType: directive.type, directiveValue: directive.value } : {})
    });
  };
  const flush = () => {
    if (paragraph) add(paragraph.start, paragraph.end);
    paragraph = null;
  };
  for (const match of source.text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/(?:\r\n|\r|\n)$/, '');
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const start = match.index + line.indexOf(trimmed);
    const end = start + trimmed.length;
    const directive = /^([a-z][a-z-]*)[ \t]*:[ \t]*(.*)$/i.exec(trimmed);
    const type = directive && directive[1].toLowerCase();
    if (DIRECTIVES.has(type)) {
      flush();
      add(start, end, { type, value: directive[2].trim() });
    } else if (paragraph) paragraph.end = end;
    else paragraph = { start, end };
  }
  flush();
  return requirements;
}

function directiveWarnings(requirements, scopes) {
  const groups = new Map();
  for (const requirement of requirements) {
    if (requirement.kind !== 'directive' || REPEATED_DIRECTIVES.has(requirement.directiveType)) continue;
    const key = JSON.stringify([requirement.targetType, requirement.targetId, requirement.sourceKind, requirement.directiveType]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(requirement);
  }
  const warnings = [];
  for (const group of groups.values()) {
    const overrides = group.filter((item) => scopes.get(item.id) === 'placement');
    for (const requirement of group) {
      if (overrides.length && scopes.get(requirement.id) === 'role') {
        requirement.overriddenBy = overrides.map((item) => item.id);
      }
    }
    const active = group.filter((item) => !item.overriddenBy);
    const values = new Set(active.map((item) => item.directiveType === 'materialization'
      ? item.directiveValue.toLowerCase() : item.directiveValue));
    if (values.size < 2) continue;
    warnings.push({
      code: 'assistant_requirement_directive_conflict',
      targetType: active[0].targetType,
      targetId: active[0].targetId,
      directiveType: active[0].directiveType,
      requirementIds: active.map((item) => item.id)
    });
  }
  return warnings;
}

/**
 * Build source coverage units, not an interpretation of arbitrary prose.
 * sourceText === originalField.slice(start, end); offsets are UTF-16, end-exclusive.
 * A paragraph can contain several obligations: acknowledging it does not prove
 * semantic completeness. Known directives are separate coverage units. Legal
 * role overrides retain both units, with overriddenBy linking the role unit.
 * No text is truncated, logged, or synthesized from parsed directive metadata.
 * The ledger contains private source text and must not be logged wholesale.
 * @param {object} input BusinessBlockManifest, placement targets and relation rules.
 * @returns {{version: number, hash: string, requirements: object[], warnings: object[]}}
 */
export function buildAssistantRequirementLedger(input = {}) {
  const requirements = [];
  const scopes = new Map();
  for (const source of ledgerSources(input)) {
    for (const requirement of sourceRequirements(source)) {
      const scope = source.scopes.find((range) => requirement.start >= range.start && requirement.end <= range.end);
      scopes.set(requirement.id, scope?.scope || 'target');
      requirements.push(requirement);
    }
  }
  requirements.sort((left, right) => compare(left.targetType, right.targetType)
    || compare(left.targetId, right.targetId) || compare(left.sourceKind, right.sourceKind)
    || left.start - right.start || left.end - right.end);
  const warnings = directiveWarnings(requirements, scopes);
  const payload = { version: 1, requirements, warnings };
  return { version: 1, hash: hash(payload), requirements, warnings };
}

/**
 * Check coverage shape only; no references are resolved and no source is logged.
 * Every ledger id (including directives) needs exactly one entry:
 * { id, status: compiled|unresolved|conflict, evidenceRefs?: [{ family, ref }] }.
 * Compiled entries require nonempty string family/ref pairs. Main must validate
 * the reference families, targets, fields and actual compilation separately.
 * Unresolved/conflict entries need no evidence and are never rewritten.
 * @returns {{code: string, path: string, requirementId?: string}[]} Structural errors.
 */
export function validateAssistantRequirementCoverage(ledger, responseCoverage) {
  if (!plain(ledger) || !Array.isArray(ledger.requirements)
    || Array.from(ledger.requirements).some((item) => !plain(item) || typeof item.id !== 'string' || !/^req_[a-f0-9]{64}$/.test(item.id))
    || new Set(ledger.requirements.map((item) => item.id)).size !== ledger.requirements.length) {
    return [{ code: 'assistant_requirement_ledger_invalid', path: '$.ledger.requirements' }];
  }
  if (!Array.isArray(responseCoverage)) {
    return [{ code: 'assistant_requirement_coverage_invalid', path: '$.coverage' }];
  }
  const known = new Set(ledger.requirements.map((item) => item.id));
  const seen = new Set();
  const errors = [];
  for (const [index, entry] of responseCoverage.entries()) {
    const path = `$.coverage[${index}]`;
    if (!plain(entry)) {
      errors.push({ code: 'assistant_requirement_coverage_invalid', path });
      continue;
    }
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      errors.push({ code: 'assistant_requirement_id_required', path: `${path}.id` });
    } else {
      if (!known.has(entry.id)) errors.push({ code: 'assistant_requirement_unknown_id', path: `${path}.id` });
      if (seen.has(entry.id)) errors.push({ code: 'assistant_requirement_duplicate_id', path: `${path}.id` });
      seen.add(entry.id);
    }
    if (!STATUSES.has(entry.status)) {
      errors.push({ code: 'assistant_requirement_status_invalid', path: `${path}.status` });
    }
    if (entry.status === 'compiled' && (!Array.isArray(entry.evidenceRefs) || !entry.evidenceRefs.length
      || !Array.from(entry.evidenceRefs).every((ref) => plain(ref) && typeof ref.family === 'string' && ref.family.trim()
        && typeof ref.ref === 'string' && ref.ref.trim()))) {
      errors.push({ code: 'assistant_requirement_evidence_required', path: `${path}.evidenceRefs` });
    }
  }
  for (const id of known) {
    if (!seen.has(id)) errors.push({ code: 'assistant_requirement_missing_id', path: '$.coverage', requirementId: id });
  }
  return errors;
}
