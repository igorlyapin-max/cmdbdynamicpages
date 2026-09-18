import { createHash } from 'node:crypto';

// Synthetic data only. Oracles are handwritten, never part of model input.
const eq = (field, value) => ({ op: 'eq', field, value });
const and = (...args) => ({ op: 'and', args });
const or = (...args) => ({ op: 'or', args });
const not = (arg) => ({ op: 'not', arg });
const row = (id, label, attrs = {}, refs = {}) => ({ id, label, attrs, refs });
const node = (id, label, refs = {}) => ({ id, label, refs });
const edge = (id, domain, from, to) => ({ id, domain, from, to });
const plan = (id, filter, changes = {}) => ({
  id, filter, parents: [], copiesFrom: null, identity: 'record',
  edgeDomain: null, edgeScope: 'both', direction: 'forward', ...changes,
});
const result = (rows, hierarchy = [], edges = [], identities = rows.map((id) => ({ id, rowId: id }))) => ({
  rows, hierarchy, edges, identities,
});
const visibleEdge = (id, from, to, direction = 'forward') => ({ id, from, to, direction });
const obligations = (changes = {}) => ({
  identity: 'record', copiesFrom: null, hierarchyDepth: 0,
  edgeDomain: null, edgeScope: 'both', direction: 'forward', ...changes,
});
function scenario(id, split, request, rows, candidates, expected, options = {}) {
  const opaqueId = (value) => `c-${createHash('sha256').update(`${id}:${value}`).digest('hex').slice(0, 16)}`;
  return {
    id, split, synthetic: true,
    input: {
      request, rows, nodes: options.nodes || [], edges: options.edges || [],
      candidates: candidates.map((candidate) => ({ ...candidate, id: opaqueId(candidate.id) })),
      schemaKnowledge: options.knowledge || ['IDs are stable identity; labels are not unique.', 'eq uses exact typed equality; AND/OR/NOT retain their Boolean meaning.'],
      obligations: obligations(options.obligations),
    },
    oracle: { candidateId: opaqueId(options.correct || 'p-good'), result: expected,
      knowledgeRequired: options.knowledgeRequired || false },
  };
}

const cases = [
  scenario('dev-and-not', 'development', 'Select active printers in West that are NOT retired.', [
    row('p1', 'Print', { active: true, zone: 'West', retired: false }),
    row('p2', 'Print', { active: true, zone: 'East', retired: false }),
    row('p3', 'Print', { active: true, zone: 'West', retired: true }),
  ], [
    plan('p-good', and(eq('active', true), eq('zone', 'West'), not(eq('retired', true)))),
    plan('p-or', or(eq('active', true), eq('zone', 'West'))),
    plan('p-retired', and(eq('active', true), eq('zone', 'West'))),
  ], result(['p1'])),
  scenario('dev-or-grouping', 'development', 'Select enabled sensors of kind heat OR smoke; disabled sensors are excluded.', [
    row('s1', 'Heat', { enabled: true, kind: 'heat' }),
    row('s2', 'Smoke', { enabled: true, kind: 'smoke' }),
    row('s3', 'Smoke', { enabled: false, kind: 'smoke' }),
    row('s4', 'Door', { enabled: true, kind: 'door' }),
  ], [
    plan('p-leak', or(and(eq('enabled', true), eq('kind', 'heat')), eq('kind', 'smoke'))),
    plan('p-good', and(eq('enabled', true), or(eq('kind', 'heat'), eq('kind', 'smoke')))),
    plan('p-and', and(eq('enabled', true), eq('kind', 'heat'), eq('kind', 'smoke'))),
  ], result(['s1', 's2'])),
  scenario('dev-reference-choice', 'development', 'Show all instruments under their physical room, not their owning team.', [
    row('i1', 'Meter', {}, { rA: 'ref1', rB: 'ref3' }),
    row('i2', 'Meter', {}, { rA: 'ref2', rB: 'ref3' }),
  ], [
    plan('p-owner', null, { parents: ['rB'] }),
    plan('p-good', null, { parents: ['rA'] }),
    plan('p-flat', null),
  ], result(['i1', 'i2'], [['ref1', 'i1'], ['ref2', 'i2']]), {
    nodes: [node('ref1', 'Group'), node('ref2', 'Group'), node('ref3', 'Group')],
    obligations: { hierarchyDepth: 1 },
    knowledgeRequired: true,
    knowledge: ['Authoritative schema Help: rA is the physical room reference; rB is the administrative team reference.'],
  }),
  scenario('dev-many-to-many', 'development', 'Show all members and every membership edge from member to team. Keep distinct memberships.', [
    row('m1', 'Alex'), row('m2', 'Sam'),
  ], [
    plan('p-good', null, { edgeDomain: 'membership', edgeScope: 'either' }),
    plan('p-reverse', null, { edgeDomain: 'membership', edgeScope: 'either', direction: 'reverse' }),
    plan('p-both', null, { edgeDomain: 'membership' }),
  ], result(['m1', 'm2'], [], [visibleEdge('e1', 'm1', 't1'), visibleEdge('e2', 'm1', 't2'), visibleEdge('e3', 'm2', 't1')]), {
    nodes: [node('t1', 'Ops'), node('t2', 'Lab')],
    edges: [edge('e1', 'membership', 'm1', 't1'), edge('e2', 'membership', 'm1', 't2'), edge('e3', 'membership', 'm2', 't1')],
    obligations: { edgeDomain: 'membership', edgeScope: 'either' },
    knowledge: ['membership is N:N, source Member -> target Team; do not collapse rows or edges by label.'],
  }),
  scenario('dev-same-labels', 'development', 'Show both active pumps named Shared, each under its site. Labels do not merge objects.', [
    row('a1', 'Shared', { active: true }, { site: 'site1' }),
    row('a2', 'Shared', { active: true }, { site: 'site2' }),
    row('a3', 'Other', { active: false }, { site: 'site1' }),
  ], [
    plan('p-good', eq('active', true), { parents: ['site'] }),
    plan('p-inactive', null, { parents: ['site'] }),
    plan('p-flat', eq('active', true)),
  ], result(['a1', 'a2'], [['site1', 'a1'], ['site2', 'a2']]), {
    nodes: [node('site1', 'Shared'), node('site2', 'Shared')], obligations: { hierarchyDepth: 1 },
  }),
  scenario('dev-dynamic-copies', 'development', 'Show one task occurrence per assigned board. Task q1 belongs to two boards; preserve copies.', [
    row('q1', 'Inspect', {}, { boards: ['b1', 'b2'] }), row('q2', 'Inspect', {}, { boards: ['b2'] }),
  ], [
    plan('p-collapse', null, { copiesFrom: 'boards' }),
    plan('p-good', null, { copiesFrom: 'boards', identity: 'copy' }),
    plan('p-flat', null),
  ], result(['q1', 'q1', 'q2'], [['b1', 'q1@b1'], ['b2', 'q1@b2'], ['b2', 'q2@b2']], [], [
    { id: 'q1@b1', rowId: 'q1' }, { id: 'q1@b2', rowId: 'q1' }, { id: 'q2@b2', rowId: 'q2' },
  ]), {
    nodes: [node('b1', 'Today'), node('b2', 'Next')],
    obligations: { identity: 'copy', copiesFrom: 'boards' },
  }),
  scenario('holdout-city-street-building', 'holdout', 'Show occupied buildings below street below city. Streets with the same name in different cities remain distinct.', [
    row('h1', '10', { occupied: true }, { street: 'st1' }),
    row('h2', '10', { occupied: true }, { street: 'st2' }),
    row('h3', '20', { occupied: false }, { street: 'st1' }),
  ], [
    plan('p-flat', eq('occupied', true)),
    plan('p-street', eq('occupied', true), { parents: ['street'] }),
    plan('p-good', eq('occupied', true), { parents: ['street', 'city'] }),
  ], result(['h1', 'h2'], [['st1', 'h1'], ['city1', 'st1'], ['st2', 'h2'], ['city2', 'st2']]), {
    nodes: [node('st1', 'Main', { city: 'city1' }), node('st2', 'Main', { city: 'city2' }), node('city1', 'North'), node('city2', 'South')],
    obligations: { hierarchyDepth: 2 },
    knowledge: ['Building.street -> Street; Street.city -> City. A street name is not a global identity.'],
  }),
  scenario('holdout-not-or', 'holdout', 'Select open deliveries that are NOT (cancelled OR returned).', [
    row('d1', 'Box', { open: true, cancelled: false, returned: false }),
    row('d2', 'Box', { open: true, cancelled: true, returned: false }),
    row('d3', 'Box', { open: true, cancelled: false, returned: true }),
    row('d4', 'Box', { open: false, cancelled: false, returned: false }),
  ], [
    plan('p-wrong-not', and(eq('open', true), or(not(eq('cancelled', true)), not(eq('returned', true))))),
    plan('p-good', and(eq('open', true), not(or(eq('cancelled', true), eq('returned', true))))),
    plan('p-open', eq('open', true)),
  ], result(['d1'])),
  scenario('holdout-reference-direction', 'holdout', 'Show all devices and supply edges in reverse display direction: from device to supplier. Exclude support edges.', [
    row('v1', 'Display'), row('v2', 'Display'),
  ], [
    plan('p-support', null, { edgeDomain: 'support', edgeScope: 'either', direction: 'reverse' }),
    plan('p-forward', null, { edgeDomain: 'supply', edgeScope: 'either' }),
    plan('p-good', null, { edgeDomain: 'supply', edgeScope: 'either', direction: 'reverse' }),
  ], result(['v1', 'v2'], [], [visibleEdge('z1', 'v1', 'vendor1', 'reverse'), visibleEdge('z2', 'v2', 'vendor1', 'reverse')]), {
    nodes: [node('vendor1', 'Vendor')],
    edges: [edge('z1', 'supply', 'vendor1', 'v1'), edge('z2', 'supply', 'vendor1', 'v2'), edge('z3', 'support', 'vendor1', 'v1')],
    obligations: { edgeDomain: 'supply', edgeScope: 'either', direction: 'reverse' },
    knowledge: ['supply has stored direction Supplier -> Device. Display direction reverse swaps endpoints but retains edge ID.'],
  }),
  scenario('holdout-parallel-edges', 'holdout', 'Show active stations and all directed route edges between them, including parallel routes. Exclude inactive endpoints.', [
    row('n1', 'Stop', { active: true }), row('n2', 'Stop', { active: true }), row('n3', 'Stop', { active: false }),
  ], [
    plan('p-good', eq('active', true), { edgeDomain: 'route' }),
    plan('p-touching', eq('active', true), { edgeDomain: 'route', edgeScope: 'either' }),
    plan('p-reverse', eq('active', true), { edgeDomain: 'route', direction: 'reverse' }),
  ], result(['n1', 'n2'], [], [visibleEdge('r1', 'n1', 'n2'), visibleEdge('r2', 'n1', 'n2'), visibleEdge('r3', 'n2', 'n1')]), {
    edges: [edge('r1', 'route', 'n1', 'n2'), edge('r2', 'route', 'n1', 'n2'), edge('r3', 'route', 'n2', 'n1'), edge('r4', 'route', 'n1', 'n3')],
    obligations: { edgeDomain: 'route' },
  }),
  scenario('holdout-copies-reordered', 'holdout', 'Show enabled reports once per subscribed desk; preserve distinct reports with the same label. Unsubscribed reports have no occurrence.', [
    row('u1', 'Daily', { enabled: true }, { desks: ['desk2', 'desk1'] }),
    row('u2', 'Daily', { enabled: true }, { desks: ['desk1'] }),
    row('u3', 'Daily', { enabled: true }, { desks: [] }),
    row('u4', 'Daily', { enabled: false }, { desks: ['desk2'] }),
  ], [
    plan('p-all', null, { copiesFrom: 'desks', identity: 'copy' }),
    plan('p-collapse', eq('enabled', true), { copiesFrom: 'desks' }),
    plan('p-good', eq('enabled', true), { copiesFrom: 'desks', identity: 'copy' }),
  ], result(['u1', 'u1', 'u2'], [['desk2', 'u1@desk2'], ['desk1', 'u1@desk1'], ['desk1', 'u2@desk1']], [], [
    { id: 'u1@desk2', rowId: 'u1' }, { id: 'u1@desk1', rowId: 'u1' }, { id: 'u2@desk1', rowId: 'u2' },
  ]), {
    nodes: [node('desk1', 'Desk'), node('desk2', 'Desk')],
    obligations: { identity: 'copy', copiesFrom: 'desks' },
  }),
  scenario('holdout-empty-intersection', 'holdout', 'Select books that are simultaneously checked out AND available. Do not invent a result when the intersection is empty.', [
    row('bk1', 'Manual', { out: true, available: false }),
    row('bk2', 'Manual', { out: false, available: true }),
  ], [
    plan('p-or', or(eq('out', true), eq('available', true))),
    plan('p-good', and(eq('out', true), eq('available', true))),
    plan('p-all', null),
  ], result([])),
];

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const assistantQualityCases = freeze(cases);
