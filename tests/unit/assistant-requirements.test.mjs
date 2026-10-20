import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssistantRequirementLedger,
  validateAssistantRequirementCoverage
} from '../../scripts/assistant-requirements.mjs';

const placementLedger = (notes, extra = {}) => buildAssistantRequirementLedger({
  placements: [{ structureItemId: 'node-a', notes, ...extra }]
});
const compiled = (requirement) => ({
  id: requirement.id,
  status: 'compiled',
  evidenceRefs: [{ family: 'mapping', ref: '$.placements.node-a.conditions' }]
});
const codes = (errors) => errors.map((error) => error.code);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('empty inputs produce a deterministic empty ledger and accept empty coverage', () => {
  const ledger = buildAssistantRequirementLedger({});
  assert.deepEqual(ledger.requirements, []);
  assert.deepEqual(ledger.warnings, []);
  assert.equal(ledger.version, 1);
  assert.match(ledger.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(ledger, buildAssistantRequirementLedger());
  assert.deepEqual(validateAssistantRequirementCoverage(ledger, []), []);
});

test('requirements point to exact paragraphs in actual source fields, including CRLF and UTF-16', () => {
  const notes = '  First paragraph\r\nwith another line.  \r\n \r\n  Second paragraph.\r\n';
  const description = 'Block description.\n\nOther requirement.';
  const d2Notes = 'Connect the named results.';
  const input = freeze({
    businessBlockManifest: { blocks: [{ id: 'block-a', description }] },
    placements: [{ structureItemId: 'node-a', notes }],
    relationRules: [{ d2ClassKey: 'link-a', d2Notes }]
  });
  const ledger = buildAssistantRequirementLedger(input);
  assert.equal(ledger.requirements.length, 5);
  const originals = { businessBlock: description, placement: notes, connection: d2Notes };
  for (const requirement of ledger.requirements) {
    assert.equal(requirement.kind, 'paragraph');
    assert.equal(requirement.sourceText, originals[requirement.targetType].slice(requirement.start, requirement.end));
    assert.match(requirement.id, /^req_[a-f0-9]{64}$/);
  }
  const paragraphs = ledger.requirements.filter((item) => item.targetType === 'placement');
  assert.deepEqual(paragraphs.map((item) => item.sourceText), [
    'First paragraph\r\nwith another line.', 'Second paragraph.'
  ]);
  assert.equal(paragraphs[0].start, 2);
  assert.equal(paragraphs[1].start, notes.indexOf('Second'));
  assert.equal(ledger.requirements.find((item) => item.targetType === 'businessBlock').sourceKind, 'description');
  assert.equal(ledger.requirements.find((item) => item.targetType === 'connection').sourceKind, 'd2Notes');
  const unicode = 'A\u{1f600}\n\n\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443.';
  const unicodeLedger = placementLedger(unicode);
  assert.equal(unicodeLedger.requirements[1].start, 5);
  assert.equal(unicodeLedger.requirements[1].sourceText, unicode.slice(5));
});

test('line endings and indentation never change the recorded source span', () => {
  const notes = '\n\tAlpha.\r\nBeta.\t\r\n\t\r\n Gamma.\r Delta.  \n';
  const ledger = placementLedger(notes);
  assert.deepEqual(ledger.requirements.map((item) => item.sourceText), ['Alpha.\r\nBeta.', 'Gamma.\r Delta.']);
  for (const item of ledger.requirements) assert.equal(notes.slice(item.start, item.end), item.sourceText);
});

test('label directive has exact provenance and conflicting labels cannot silently replace each other', () => {
  const notes = 'label-template: ${Description}\nlabel-template: Other';
  const ledger = placementLedger(notes);
  assert.equal(ledger.requirements.length, 2);
  assert.equal(ledger.warnings[0].directiveType, 'label-template');
  for (const requirement of ledger.requirements) assert.equal(notes.slice(requirement.start, requirement.end), requirement.sourceText);
});

test('known machine directives stay separate from prose without inferring natural-language meaning', () => {
  const notes = 'materialization: stage\nShow only approved cards.\nrequired-condition: approved equals true\nKeep the original label.\ncustom-condition: not a known directive';
  const ledger = placementLedger(notes);
  assert.deepEqual(ledger.requirements.map((item) => item.kind), ['directive', 'paragraph', 'directive', 'paragraph']);
  assert.deepEqual(ledger.requirements.filter((item) => item.kind === 'directive').map((item) => [item.directiveType, item.directiveValue]), [
    ['materialization', 'stage'], ['required-condition', 'approved equals true']
  ]);
  assert.equal(ledger.requirements[3].sourceText, 'Keep the original label.\ncustom-condition: not a known directive');
  assert.equal(Object.hasOwn(ledger.requirements[1], 'operator'), false);
  assert.equal(Object.hasOwn(ledger.requirements[1], 'inferredMeaning'), false);
});

test('blank known directives remain visible instead of disappearing', () => {
  const ledger = placementLedger('  BINDING-RESULT:  \nmaterialization: stage');
  assert.equal(ledger.requirements[0].directiveType, 'binding-result');
  assert.equal(ledger.requirements[0].directiveValue, '');
  assert.equal(ledger.requirements[0].sourceText, 'BINDING-RESULT:');
});

test('card source directives retain exact spans, singleton conflicts and explicit placement overrides', () => {
  for (const type of ['card-source', 'membership-card-source', 'parent-membership-card-source']) {
    const roleNotes = `${type}: current`;
    const placementNotes = `${type}: relation-source\nKeep the original card.`;
    const notes = `${roleNotes}\n\n${placementNotes}`;
    const ledger = placementLedger(notes, { roleNotes, placementNotes });
    const directives = ledger.requirements.filter((item) => item.kind === 'directive');
    assert.deepEqual(directives.map((item) => [item.directiveType, item.directiveValue]), [
      [type, 'current'], [type, 'relation-source']
    ]);
    for (const requirement of ledger.requirements) {
      assert.equal(requirement.sourceText, notes.slice(requirement.start, requirement.end));
    }
    assert.deepEqual(directives[0].overriddenBy, [directives[1].id]);
    assert.deepEqual(ledger.warnings, []);
    assert.equal(ledger.requirements[2].kind, 'paragraph');
    const conflict = placementLedger(`${type}: current\n${type}: relation-source`);
    assert.equal(conflict.warnings.length, 1);
    assert.equal(conflict.warnings[0].directiveType, type);
    assert.equal(conflict.warnings[0].code, 'assistant_requirement_directive_conflict');
  }
});

test('ids and ledger hash are stable across input ordering and unrelated metadata', () => {
  const input = {
    businessBlockManifest: { blocks: [{ id: 'b', description: 'Block intent.' }] },
    placements: [{ structureItemId: 'z', notes: 'Second.' }, { structureItemId: 'a', notes: 'First.' }],
    relationRules: [{ d2ClassKey: 'z', d2Notes: 'Second link.' }, { d2ClassKey: 'a', d2Notes: 'First link.' }]
  };
  const first = buildAssistantRequirementLedger(input);
  const reordered = buildAssistantRequirementLedger({
    relationRules: input.relationRules.toReversed(),
    placements: input.placements.toReversed().map((item) => ({ ignored: true, ...item })),
    businessBlockManifest: { ignored: 'metadata', ...input.businessBlockManifest }
  });
  assert.deepEqual(first, reordered);
  const changed = placementLedger('Changed.');
  assert.notEqual(placementLedger('Original.').hash, changed.hash);
  assert.notEqual(placementLedger('Original.').requirements[0].id, changed.requirements[0].id);
  const extended = buildAssistantRequirementLedger({ placements: input.placements.concat({ structureItemId: 'new', notes: 'New.' }) });
  for (const requirement of first.requirements.filter((item) => item.targetType === 'placement')) {
    assert.ok(extended.requirements.some((item) => item.id === requirement.id));
  }
});

test('equal text in separate paragraphs or targets has distinct provenance ids', () => {
  const ledger = buildAssistantRequirementLedger({
    placements: [{ structureItemId: 'a', notes: 'Same.\n\nSame.' }, { structureItemId: 'b', notes: 'Same.' }]
  });
  assert.equal(new Set(ledger.requirements.map((item) => item.id)).size, 3);
});

test('long source text is not silently truncated', () => {
  const notes = 'long paragraph '.repeat(2000) + '\n\nFinal requirement.';
  const ledger = placementLedger(notes);
  assert.equal(ledger.requirements[0].sourceText.length, 'long paragraph '.repeat(2000).trim().length);
  assert.equal(ledger.requirements[1].sourceText, 'Final requirement.');
  assert.equal(ledger.requirements[1].end, notes.length);
  assert.deepEqual(ledger, placementLedger(notes));
});

test('different singleton directives in the same scope warn with ids, never source text or values', () => {
  for (const key of ['materialization', 'binding-result']) {
    const notes = `${key}: private-a\n${key}: private-b`;
    const ledger = placementLedger(notes);
    assert.equal(ledger.warnings.length, 1);
    assert.equal(ledger.warnings[0].code, 'assistant_requirement_directive_conflict');
    assert.equal(ledger.warnings[0].directiveType, key);
    assert.deepEqual(ledger.warnings[0].requirementIds, ledger.requirements.map((item) => item.id));
    assert.equal(JSON.stringify(ledger.warnings).includes('private-'), false);
  }
});

test('repeated equal singletons and multi-valued directives do not conflict', () => {
  const ledger = placementLedger('materialization: stage\nmaterialization: STAGE\nrequired-condition: a equals true\nrequired-condition: b equals true\nendpoint-field: x\nendpoint-field: y');
  assert.deepEqual(ledger.warnings, []);
  assert.equal(ledger.requirements.length, 6);
});

test('placement Notes override role singletons only with exact source provenance', () => {
  const roleNotes = 'materialization: structural\nbinding-result: role-block\nRole prose.';
  const placementNotes = 'materialization: stage\nbinding-result: placement-block\nPlacement prose.';
  const notes = `${roleNotes}\n\n${placementNotes}`;
  const ledger = placementLedger(notes, { roleNotes, placementNotes });
  assert.deepEqual(ledger.warnings, []);
  const roleDirectives = ledger.requirements.filter((item) => item.kind === 'directive' && item.start < roleNotes.length);
  for (const requirement of roleDirectives) {
    const override = ledger.requirements.find((item) => item.directiveType === requirement.directiveType && item.start > roleNotes.length);
    assert.deepEqual(requirement.overriddenBy, [override.id]);
  }
  assert.equal(ledger.requirements.length, 6);
  const withoutProvenance = placementLedger(notes, { directives: { materialization: 'stage', 'binding-result': 'placement-block' } });
  assert.equal(withoutProvenance.warnings.length, 2);
  const inventedProvenance = placementLedger(notes, { roleNotes: 'Different role text.', placementNotes });
  assert.equal(inventedProvenance.warnings.length, 2);
});

test('conflicts within placement override remain visible and repeated obligations are not overridden', () => {
  const roleNotes = 'required-condition: a equals true\nmaterialization: structural';
  const placementNotes = 'required-condition: b equals true\nmaterialization: stage\nmaterialization: parentCard';
  const ledger = placementLedger(`${roleNotes}\n\n${placementNotes}`, { roleNotes, placementNotes });
  assert.equal(ledger.warnings.length, 1);
  assert.equal(ledger.warnings[0].requirementIds.length, 2);
  assert.ok(ledger.requirements.filter((item) => item.directiveType === 'required-condition').every((item) => !item.overriddenBy));
});

test('missing actual Notes never synthesizes requirements from role metadata or parsed directives', () => {
  const ledger = placementLedger('', { roleNotes: 'Role source.', placementNotes: 'Placement source.', directives: { membership: 'compare' } });
  assert.deepEqual(ledger.requirements, []);
});

test('connection Notes use d2Notes before notes and preserve each source kind', () => {
  const ledger = buildAssistantRequirementLedger({ relationRules: [
    { d2ClassKey: 'a', d2Notes: 'Actual.', notes: 'Do not merge.' },
    { d2ElementKey: 'b', notes: 'Connection source.' },
    { d2ClassKey: 'empty', d2Notes: '', notes: 'Do not resurrect.' }
  ] });
  assert.deepEqual(ledger.requirements.map((item) => [item.targetId, item.sourceKind, item.sourceText]), [
    ['a', 'd2Notes', 'Actual.'], ['b', 'notes', 'Connection source.']
  ]);
});

test('malformed source collections, text or duplicate target ids fail without echoing input', () => {
  for (const input of [null, [], { placements: {} }, { businessBlockManifest: { blocks: {} } },
    { placements: [{ notes: 'Private.' }] }, { placements: [{ structureItemId: 'a', notes: {} }] },
    { placements: [{ structureItemId: 'a', notes: 'Private.' }, { structureItemId: 'a', notes: 'Other.' }] }]) {
    assert.throws(() => buildAssistantRequirementLedger(input), (error) => error.code === 'assistant_requirement_input_invalid' && !error.message.includes('Private'));
  }
});

test('compiled coverage needs structured evidence; unresolved and conflict entries stay untouched', () => {
  const ledger = placementLedger('A.\n\nB.\n\nC.');
  const coverage = freeze([
    compiled(ledger.requirements[0]),
    { id: ledger.requirements[1].id, status: 'unresolved', reason: 'No confirmed field.' },
    { id: ledger.requirements[2].id, status: 'conflict', reason: 'Needs author decision.' }
  ]);
  const before = JSON.stringify(coverage);
  assert.deepEqual(validateAssistantRequirementCoverage(freeze(ledger), coverage), []);
  assert.equal(JSON.stringify(coverage), before);
  // This gate checks shape only. It deliberately does not attest the reference.
  assert.deepEqual(validateAssistantRequirementCoverage(placementLedger('A.'), [compiled(ledger.requirements[0])]), []);
});

test('coverage reports unknown, duplicate, missing ids and invalid statuses without quoting source', () => {
  const ledger = placementLedger('Private A.\n\nPrivate B.');
  const errors = validateAssistantRequirementCoverage(ledger, [
    { id: ledger.requirements[0].id, status: 'accepted' },
    compiled(ledger.requirements[0]),
    { id: 'private-unknown-source', status: 'unresolved' },
    { status: 'unresolved' }
  ]);
  for (const code of ['assistant_requirement_status_invalid', 'assistant_requirement_duplicate_id',
    'assistant_requirement_unknown_id', 'assistant_requirement_id_required', 'assistant_requirement_missing_id']) {
    assert.ok(codes(errors).includes(code), code);
  }
  const serialized = JSON.stringify(errors);
  assert.equal(serialized.includes('Private'), false);
  assert.equal(serialized.includes('private-unknown-source'), false);
});

test('every compiled evidence reference needs nonempty family and ref; semantic validation stays external', () => {
  const ledger = placementLedger('A.');
  for (const evidenceRefs of [undefined, [], Array(1), '', [null], [{}], ['raw prose'], [{ family: 'mapping' }],
    [{ family: '', ref: '$.x' }], [{ family: 'mapping', ref: ' ' }], [{ family: 'mapping', ref: '$.x' }, null]]) {
    const errors = validateAssistantRequirementCoverage(ledger, [{ id: ledger.requirements[0].id, status: 'compiled', evidenceRefs }]);
    assert.ok(codes(errors).includes('assistant_requirement_evidence_required'));
  }
  const externallyChecked = [{ id: ledger.requirements[0].id, status: 'compiled', evidenceRefs: [{ family: 'unknown-family', ref: 'unverified-reference' }] }];
  assert.deepEqual(validateAssistantRequirementCoverage(ledger, externallyChecked), []);
});

test('coverage never defaults omitted or misspelled statuses to success', () => {
  const ledger = placementLedger('A.');
  for (const status of [undefined, null, '', 'Compiled', 'ignored', 'accepted', 'compiled ']) {
    assert.ok(codes(validateAssistantRequirementCoverage(ledger, [{ id: ledger.requirements[0].id, status }])).includes('assistant_requirement_status_invalid'));
  }
  assert.ok(codes(validateAssistantRequirementCoverage(ledger, [])).includes('assistant_requirement_missing_id'));
  assert.ok(codes(validateAssistantRequirementCoverage(ledger, {})).includes('assistant_requirement_coverage_invalid'));
  assert.ok(codes(validateAssistantRequirementCoverage(ledger, [null])).includes('assistant_requirement_coverage_invalid'));
  assert.ok(codes(validateAssistantRequirementCoverage({}, [])).includes('assistant_requirement_ledger_invalid'));
  assert.ok(codes(validateAssistantRequirementCoverage({ requirements: Array(1) }, [])).includes('assistant_requirement_ledger_invalid'));
  assert.ok(codes(validateAssistantRequirementCoverage({ requirements: [ledger.requirements[0], ledger.requirements[0]] }, [])).includes('assistant_requirement_ledger_invalid'));
});
