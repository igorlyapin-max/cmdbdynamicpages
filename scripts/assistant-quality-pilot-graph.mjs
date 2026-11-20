import { hashInput } from './assistant-quality-lab.mjs';

function sourceMetadata(diagram) {
  const matches = [...String(diagram.svg?.content || '').matchAll(/<metadata\b[^>]*\bid=["']cmdp-diagram-data["'][^>]*>([\s\S]*?)<\/metadata\s*>/g)];
  if (!matches.length) return {};
  if (matches.length !== 1) throw new Error('pilot_duplicate_svg_metadata');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const text = matches[0][1].replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) =>
    entities[entity] ?? (entity.startsWith('#') ? String.fromCodePoint(Number(entity.replace(/^#x/i, '0x').replace(/^#/, ''))) : match));
  const metadata = JSON.parse(text);
  if (metadata.format !== 'cmdbcustompages.d2' || metadata.version !== 1 || !metadata.objects) throw new Error('pilot_svg_metadata_contract');
  return metadata.objects;
}

// Runtime IDs depend on compilation. Benchmark identity is authored placement plus card plus parent occurrence.
export function pilotGraphSnapshot(diagram, { ignoredStaticRoles = [] } = {}) {
  const metadata = sourceMetadata(diagram);
  const role = (item) => item.importRole?.key || '';
  const ignored = (item) => item.importRole?.templateStatic === true && ignoredStaticRoles.includes(role(item));
  const placements = [], displayedCards = [], labels = [], hierarchy = [], edges = [];
  const items = [...diagram.groups, ...diagram.nodes];
  const byId = new Map(items.map((item) => [item.id, item]));
  const ids = new Map(), occurrences = new Set();
  if (byId.size !== items.length || byId.has(undefined) || byId.has('')) throw new Error('pilot_duplicate_graph_identity');
  const source = (item) => {
    const embedded = metadata[item.d2Path || item.d2Id];
    if (embedded && (String(embedded.id) !== String(item.id) || embedded.label !== item.label)) throw new Error('pilot_svg_graph_mismatch');
    const inline = item.data?.sourceRef, ref = embedded?.sourceRef || inline;
    if (embedded?.sourceRef && inline && hashInput(embedded.sourceRef) !== hashInput(inline)) throw new Error('pilot_source_ref_mismatch');
    if (!ref || item.importRole?.templateStatic === true || (!ref.className && !ref.id)) return null;
    if (ref.id === undefined || ref.id === '' || !ref.className) throw new Error('pilot_invalid_source_ref');
    return { className: String(ref.className), id: String(ref.id) };
  };
  const find = (item, ancestors = new Set()) => {
    if (!item || ignored(item) || ancestors.has(item.id)) throw new Error('pilot_missing_or_cyclic_graph_parent');
    if (ids.has(item.id)) return ids.get(item.id);
    const parent = item.parent || item.group;
    const parentId = parent ? find(byId.get(parent), new Set([...ancestors, item.id])) : '';
    const ref = source(item);
    const structure = item.importRole?.structureItemId || item.importRole?.elementKey || item.blueprintKey;
    if (!structure || (item.importRole?.materialization?.kind === 'stage' && !ref)) throw new Error('pilot_missing_graph_provenance');
    const structureItemId = hashInput(structure);
    const id = hashInput([structureItemId, ref, parentId]);
    if (occurrences.has(id)) throw new Error('pilot_duplicate_graph_occurrence');
    occurrences.add(id);
    ids.set(item.id, id);
    // The graph API does not always return the authoring card-source ID; this is observed card identity only.
    placements.push({ id, structureItemId, card: ref, cardSourceId: ref ? 'observed-card' : null });
    if (ref) displayedCards.push(ref);
    if (parentId) hierarchy.push({ parent: parentId, child: id });
    labels.push({ targetId: id, text: String(item.label ?? '') });
    return id;
  };
  for (const item of items) if (!ignored(item)) find(item);
  for (const edge of diagram.edges) {
    const left = byId.get(edge.source), right = byId.get(edge.target);
    if (left && right && ignored(left) && ignored(right)) continue;
    const from = find(left), to = find(right);
    const ref = source(edge);
    const type = edge.importRole?.edgeClassKey || edge.blueprintKey || role(edge);
    const direction = String(edge.direction ?? '');
    const label = String(edge.label ?? '');
    const id = hashInput([type, ref, from, to, direction]);
    edges.push({ id, from, to, direction: direction === '<-' || direction === 'reverse' ? 'reverse' : 'forward', label });
    labels.push({ targetId: id, text: label });
  }
  return { displayedCards, placements, hierarchy, edges, labels };
}
