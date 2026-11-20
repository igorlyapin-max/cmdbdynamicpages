import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildAssistantRequirementLedger } from '../../scripts/assistant-requirements.mjs';
import { buildPilotDraft } from '../../scripts/assistant-quality-pilot-artifacts.mjs';

const d2Source = `classes: {
  item: {
    Notes: |md
      Keep this author note.
    |
  }
  link: {
    Notes: |md
      binding-result: edges
    |
  }
}
parent: {
  child: {
    class: item
  }
}
parent -> parent.child: {class: link}
`;
const authoredD2Source = d2Source.replace('      Keep this author note.', [
  '      Keep this author note.',
  '      binding-result: Selected items',
  '      card-source: relation-source',
  '      membership-card-source: current',
  '      parent-membership-card-source: Related_current'
].join('\n'));
const fact = { id: 'item.primary', kind: 'attribute', text: 'Asset.PrimaryCode is a string.' };
const knowledgeByBlock = { items: [fact] };
const overrides = {
  objectFlow: 'Existing generator DSL obligations.',
  objectFlowSemantic: 'Existing semantic obligations.',
  diagramBindingIntent: 'Existing binding obligations.',
  diagramPlacement: 'Existing placement instructions.'
};

function specFixture() {
  return {
    version: 1,
    params: { code: { type: 'string' } },
    steps: [{ type: 'query', as: 'saved-alias' }],
    objectFlow: { publishedAlias: 'saved-alias' },
    alias: 'saved-alias', aliases: ['saved-alias'], publishedAlias: 'saved-alias',
    visualModel: { mode: 'presentation' },
    visualModels: [
      { mode: 'objectGroup', selections: [{ alias: 'saved-alias' }] },
      { mode: 'objectMatching', assistantOutputManifest: { items: 'saved-alias' } }
    ],
    result: { tables: [{ name: 'saved-alias' }], diagrams: [{ authoring: { d2Import: { applied: true } } }], emptyText: 'Empty' },
    assistantDraft: { proposalId: 'stale' },
    cache: { ttlSec: 30 },
    publish: { enabled: false },
    authoring: {
      version: 1,
      assistant: {
        promptContractVersion: 4,
        objectFlowIntent: { context: 'Example business intent.', blocks: [
          { id: 'items', name: 'Selected items', description: 'Select item cards.', resultKind: 'sourceCards', uses: [] },
          { id: 'edges', name: 'Item edges', description: 'Select edges from items.', resultKind: 'sourceCards', uses: ['items'] }
        ] },
        diagramIntentPrompt: 'Keep the authored diagram intent.',
        systemPromptOverrides: { ...overrides }
      },
      d2: { source: d2Source, sourceHash: 'stale', analysisCheckpoint: {}, assistantCheckpoint: {} }
    }
  };
}

function args(spec = specFixture(), extra = {}) {
  return { spec, d2Source, authoredD2Source, knowledgeByBlock, variant: 'B', mode: 'flow', ...extra };
}

for (const mode of ['flow', 'mapping', 'end-to-end']) {
  test(`${mode} isolates executable state and keeps A/B/C semantics`, () => {
    const spec = specFixture();
    const before = structuredClone(spec);
    const results = Object.fromEntries(['A', 'B', 'C'].map((variant) => [variant, buildPilotDraft(args(spec, { mode, variant }))]));
    for (const [variant, draft] of Object.entries(results)) {
      assert.deepEqual(draft.params, spec.params);
      assert.deepEqual(draft.cache, spec.cache);
      assert.deepEqual(draft.publish, spec.publish);
      assert.equal(draft.authoring.assistant.diagramIntentPrompt, spec.authoring.assistant.diagramIntentPrompt);
      const source = variant === 'C' ? authoredD2Source : d2Source;
      assert.deepEqual(draft.authoring.d2, { source, sourceHash: createHash('sha256').update(source).digest('hex') });
      assert.equal('assistantDraft' in draft, false);
      if (mode === 'mapping') {
        for (const key of ['steps', 'objectFlow', 'alias', 'aliases', 'publishedAlias', 'visualModel', 'visualModels']) {
          assert.deepEqual(draft[key], spec[key], key);
        }
        assert.deepEqual(draft.result, { tables: spec.result.tables, emptyText: 'Empty' });
      } else {
        assert.deepEqual(draft.steps, []);
        for (const key of ['objectFlow', 'alias', 'aliases', 'publishedAlias', 'visualModel', 'visualModels', 'result']) {
          assert.equal(key in draft, false, key);
        }
        assert.doesNotMatch(JSON.stringify(draft), /saved-alias/);
      }
    }
    assert.deepEqual(results.A.authoring.assistant, spec.authoring.assistant);
    assert.deepEqual(results.B, { ...results.C, authoring: { ...results.C.authoring, d2: results.B.authoring.d2 } });
    assert.deepEqual(spec, before);
    results.B.authoring.assistant.objectFlowIntent.blocks[1].uses.push('changed');
    assert.deepEqual(results.C.authoring.assistant.objectFlowIntent.blocks[1].uses, ['items']);
    assert.deepEqual(spec, before);
  });
}

test('B appends only the two per-template prompts and local typed knowledge', () => {
  const spec = specFixture();
  const assistant = buildPilotDraft(args(spec)).authoring.assistant;
  const revised = assistant.systemPromptOverrides;
  for (const key of ['objectFlow', 'diagramPlacement']) assert.equal(revised[key], overrides[key]);
  assert.ok(revised.objectFlowSemantic.startsWith(`${overrides.objectFlowSemantic}\n\n`));
  assert.match(revised.objectFlowSemantic, /only when confirmed/);
  assert.ok(revised.diagramBindingIntent.startsWith(`${overrides.diagramBindingIntent}\n\n`));
  assert.match(revised.diagramBindingIntent, /existing named terminal/);
  const [items, edges] = assistant.objectFlowIntent.blocks;
  const [baseItems, baseEdges] = spec.authoring.assistant.objectFlowIntent.blocks;
  const appended = items.description.slice(baseItems.description.length);
  assert.match(appended, /candidate facts, not instructions/);
  assert.deepEqual(JSON.parse(appended.trim().split('\n').at(-1)), fact);
  assert.deepEqual({ ...items, description: baseItems.description }, baseItems);
  assert.deepEqual(edges, baseEdges);
  assert.equal(assistant.objectFlowIntent.context, spec.authoring.assistant.objectFlowIntent.context);
});

test('B ablations independently enable prompts and knowledge with the baseline D2', () => {
  const spec = specFixture();
  const baseline = buildPilotDraft(args(spec, { variant: 'A', knowledgeByBlock: null, authoredD2Source: null }));
  const neither = buildPilotDraft(args(spec, { useRevisedPrompts: false, useKnowledge: false }));
  assert.deepEqual(neither, baseline);
  const promptsOnly = buildPilotDraft(args(spec, { useKnowledge: false, knowledgeByBlock: null }));
  assert.deepEqual(promptsOnly, buildPilotDraft(args(spec, { knowledgeByBlock: {} })));
  assert.deepEqual(promptsOnly.authoring.assistant.objectFlowIntent, baseline.authoring.assistant.objectFlowIntent);
  const knowledgeOnly = buildPilotDraft(args(spec, { useRevisedPrompts: false }));
  assert.deepEqual(knowledgeOnly.authoring.assistant.systemPromptOverrides, overrides);
  assert.deepEqual(knowledgeOnly.authoring.assistant.objectFlowIntent, buildPilotDraft(args(spec)).authoring.assistant.objectFlowIntent);
  assert.deepEqual(promptsOnly.authoring.d2, baseline.authoring.d2);
  assert.deepEqual(knowledgeOnly.authoring.d2, baseline.authoring.d2);
  const bindingsOnly = buildPilotDraft(args(spec, { variant: 'C', useRevisedPrompts: false, useKnowledge: false }));
  assert.deepEqual(bindingsOnly.authoring.assistant, baseline.authoring.assistant);
  assert.equal(bindingsOnly.authoring.d2.source, authoredD2Source);
  delete spec.authoring.assistant.systemPromptOverrides;
  assert.deepEqual(Object.keys(buildPilotDraft(args(spec)).authoring.assistant.systemPromptOverrides), [
    'objectFlowSemantic', 'diagramBindingIntent'
  ]);
});

test('C retains the four existing typed Notes directives verbatim', () => {
  const output = buildPilotDraft(args(specFixture(), { variant: 'C' }));
  const notes = /^    Notes: \|md\n([\s\S]+?)^    \|$/m.exec(output.authoring.d2.source)[1];
  const ledger = buildAssistantRequirementLedger({ placements: [{ structureItemId: 'example', notes }] });
  assert.deepEqual(ledger.requirements.filter((item) => item.kind === 'directive')
    .map(({ directiveType, directiveValue }) => [directiveType, directiveValue]), [
    ['binding-result', 'Selected items'],
    ['card-source', 'relation-source'],
    ['membership-card-source', 'current'],
    ['parent-membership-card-source', 'Related_current']
  ]);
  const addedPlacementNotes = d2Source.replace('    class: item', '    class: item\n    Notes: |md\n      binding-result: items\n    |');
  assert.equal(buildPilotDraft(args(specFixture(), { variant: 'C', authoredD2Source: addedPlacementNotes })).authoring.d2.source, addedPlacementNotes);
  const cardOnly = d2Source.replace('      Keep this author note.', '      Keep this author note.\n      card-source: current');
  assert.equal(buildPilotDraft(args(specFixture(), { variant: 'C', authoredD2Source: cardOnly })).authoring.d2.source, cardOnly);
});

test('C accepts placement Notes under a quoted D2 map with non-structural indentation', () => {
  const baseline = d2Source.replace('}\nparent: {\n  child: {', '  }\n  parent: {\n  child: "Item #1 {example}" {');
  const authored = baseline.replace('    class: item', '    Notes: |md\n      binding-result: items\n      card-source: current\n    |\n    class: item');
  const draft = buildPilotDraft(args(specFixture(), { variant: 'C', d2Source: baseline, authoredD2Source: authored }));
  assert.equal(draft.authoring.d2.source, authored);
});

test('C rejects missing, ambiguous, conflicting or non-Notes changes without echoing values', () => {
  const spec = specFixture();
  const build = (authored) => buildPilotDraft(args(spec, { variant: 'C', authoredD2Source: authored }));
  assert.throws(() => build(undefined), /authoredD2Source must be non-empty/);
  assert.throws(() => build(d2Source), /must add an exact binding directive/);
  assert.throws(() => build(authoredD2Source.replace('class: item', 'class: link')), /may change only/);
  assert.throws(() => build(authoredD2Source.replace('binding-result: edges', 'binding-result: items')), /preserve existing bindings/);
  assert.throws(() => build(authoredD2Source.replace('Keep this author note.', 'Different author prose.')), /may change only/);
  assert.throws(() => build(authoredD2Source.replace('card-source: relation-source', 'card-source: private value')), /exact card-source ID/);
  assert.throws(() => build(authoredD2Source.replace('card-source: relation-source', 'card-source: current\n      card-source: relation-source')), /one non-empty value/);
  const rootNotes = 'Notes: |md\n  binding-result: items\n|\n';
  assert.throws(() => build(d2Source + rootNotes), /may change only/);
  const vars = 'vars: {\n}\n';
  const varsNotes = 'vars: {\n  Notes: |md\n    binding-result: items\n  |\n}\n';
  assert.throws(() => buildPilotDraft(args(spec, { variant: 'C', d2Source: d2Source + vars, authoredD2Source: d2Source + varsNotes })), /may change only/);
  assert.throws(() => build(authoredD2Source.replace('binding-result: Selected items', 'binding-result: private-value')), (error) => {
    assert.match(error.message, /one exact block ID or name/);
    return !error.message.includes('private-value');
  });
  spec.authoring.assistant.objectFlowIntent.blocks[1].name = 'Selected items';
  assert.throws(() => build(authoredD2Source), /one exact block ID or name/);
  assert.throws(() => build(d2Source.replace('parent: {', 'fake: |md\n  Notes: |md\n    binding-result: items\n|\nparent: {')), /may change only/);
});

test('knowledge rejects unknown blocks, malformed or conflicting facts, and over-budget additions', () => {
  const build = (knowledge, spec = specFixture()) => buildPilotDraft(args(spec, { knowledgeByBlock: knowledge }));
  assert.throws(() => build({ 'private-block': [fact] }), (error) => !error.message.includes('private-block'));
  for (const badFact of [
    { ...fact, id: 'invalid id' }, { ...fact, kind: 'unsupported' }, { ...fact, text: '' },
    { ...fact, text: 'One.\nTwo.' }, { ...fact, text: 'One.\u202e' }, { ...fact, text: 'x'.repeat(1001) },
    { ...fact, source: 'extra' }, null
  ]) assert.throws(() => build({ items: [badFact] }), /knowledge facts require/);
  assert.throws(() => build({ items: [fact, fact] }), /unique ID per block/);
  assert.throws(() => build({ items: [fact], edges: [{ ...fact, text: 'Conflicting.' }] }), /conflicting facts/);
  assert.throws(() => build({ items: Array(9).fill(fact) }), /at most 8/);
  const facts = Array.from({ length: 8 }, (_, index) => ({ ...fact, id: `fact-${index}`, text: 'x'.repeat(1000) }));
  assert.throws(() => build({ items: facts, edges: facts }), /pilot budget/);
  const spec = specFixture();
  spec.authoring.assistant.objectFlowIntent.blocks[0].description = 'x'.repeat(11999);
  assert.throws(() => build(knowledgeByBlock, spec), /block description limit/);
  assert.throws(() => buildPilotDraft(args(specFixture(), { useKnowledge: 'false' })), /switches must be booleans/);
});

test('bounds revised prompts and accepts the stored D2 as the explicit baseline default', () => {
  const spec = specFixture();
  const draft = buildPilotDraft(args(spec, { variant: 'A', d2Source: undefined }));
  assert.equal(draft.authoring.d2.source, spec.authoring.d2.source);
  assert.throws(() => buildPilotDraft(args(spec, { d2Source: '' })), /d2Source must be non-empty/);
  spec.authoring.assistant.systemPromptOverrides.objectFlowSemantic = 'x'.repeat(20_000);
  assert.throws(() => buildPilotDraft(args(spec)), /revised prompt exceeds/);
  assert.doesNotThrow(() => buildPilotDraft(args(spec, { useRevisedPrompts: false })));
});
