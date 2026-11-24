import test from 'node:test';
import assert from 'node:assert/strict';
import { stableJson } from '../../scripts/assistant-quality-lab.mjs';
import { validateProductionSnapshot } from '../../scripts/assistant-quality-comparison.mjs';
import {
  PILOT_HOLDOUT_CASE_IDS, PILOT_HOLDOUT_MODES, PILOT_HOLDOUT_PROVENANCE,
  compilePilotHoldoutSpec, createPilotHoldoutCase, createPilotHoldoutScenario,
  executePilotHoldoutSpec, pilotHoldoutInput, pilotHoldoutRead,
} from '../fixtures/assistant-quality-pilot-holdout.mjs';

const [base, changed, noHelp] = PILOT_HOLDOUT_CASE_IDS;
const multiset = (items) => items.map(stableJson).sort();

for (const id of [base, changed]) {
  for (const mode of PILOT_HOLDOUT_MODES) {
    test(`${id} / ${mode}: real compiled Spec executes to the independent oracle`, async () => {
      const { oracle } = createPilotHoldoutCase(id, mode);
      const actual = await executePilotHoldoutSpec(id, mode, compilePilotHoldoutSpec(id, mode));
      assert.equal(actual.outcome, oracle.outcome);
      assert.equal(validateProductionSnapshot({ rows: actual.rows, ...actual.graph }), true);
      assert.deepEqual(multiset(actual.rows), multiset(oracle.rows));
      for (const field of Object.keys(oracle.graph)) {
        assert.deepEqual(multiset(actual.graph[field]), multiset(oracle.graph[field]), field);
      }
    });
  }
}

test('registered-office substitution changes full rows and moves both buildings and their edges', async () => {
  const mode = 'end-to-end';
  const spec = compilePilotHoldoutSpec(base, mode);
  const { oracle } = createPilotHoldoutCase(base, mode);
  spec.steps.find((step) => step.as === 'buildings').filters[0].path = 'refA';
  const [diagram] = spec.result.diagrams;
  diagram.nodeMappings[0].importRole.parentCorrelations[0].childColumn = 'refA';
  diagram.edgeMappings[0].fields.target = 'refA';
  const actual = await executePilotHoldoutSpec(base, mode, spec);
  assert.deepEqual(multiset(actual.graph.displayedCards), multiset(oracle.graph.displayedCards));
  assert.deepEqual(actual.rows.filter(({ blockId }) => blockId === 'buildings').map(({ values }) =>
    [values._id, values.Source__id]).sort(), [[31, 22], [32, 21]]);
  assert.deepEqual(actual.graph.hierarchy.filter(({ child }) => child.startsWith('building:')).sort((a, b) =>
    a.child.localeCompare(b.child)), [
    { parent: 'street:22', child: 'building:31' }, { parent: 'street:21', child: 'building:32' },
  ]);
  assert.deepEqual(actual.graph.edges.map(({ from, to }) => [from, to]).sort(),
    [['building:31', 'street:22'], ['building:32', 'street:21']]);
  assert.notDeepEqual(multiset(actual.rows), multiset(oracle.rows));
  assert.notDeepEqual(multiset(actual.graph.labels), multiset(oracle.graph.labels));
});

test('changed data keep the raw null and distinguish duplicate street labels by identity', async () => {
  const mode = 'end-to-end';
  const actual = await executePilotHoldoutSpec(changed, mode, compilePilotHoldoutSpec(changed, mode));
  const buildings = actual.rows.filter(({ blockId }) => blockId === 'buildings');
  assert.deepEqual(buildings.map(({ values }) => [values._id, values.refA, values.Source__id]), [[32, null, 22]]);
  assert.deepEqual(actual.graph.labels.filter(({ text }) => text === 'Main Street'), [
    { targetId: 'street:21', text: 'Main Street' }, { targetId: 'street:22', text: 'Main Street' },
  ]);
  assert.deepEqual(actual.graph.edges, [{
    id: 'postal-link:building:32:street:22', from: 'building:32', to: 'street:22', direction: 'forward', label: 'Postal address',
  }]);
  assert.deepEqual(actual.graph.hierarchy.find(({ child }) => child === 'building:32'),
    { parent: 'street:22', child: 'building:32' });
});

test('provider export has no oracle or reference solution; removing Help leaves symmetric candidates', async () => {
  for (const mode of PILOT_HOLDOUT_MODES) {
    const known = createPilotHoldoutCase(base, mode);
    const unknown = createPilotHoldoutCase(noHelp, mode);
    assert.equal(known.provenance, PILOT_HOLDOUT_PROVENANCE);
    assert.equal(unknown.oracle.outcome, 'unresolved');
    assert.equal(compilePilotHoldoutSpec(noHelp, mode), null);
    assert.deepEqual(unknown.oracle.rows, []);
    assert.ok(Object.values(unknown.oracle.graph).every((items) => items.length === 0));
    const { help, ...inputWithoutHelp } = known.input;
    assert.match(help.join(' '), /refA as the registered-office Street and Building.refB as the postal Street/);
    const exported = JSON.parse(JSON.stringify(pilotHoldoutInput(noHelp, mode)));
    assert.deepEqual(exported, inputWithoutHelp);
    assert.doesNotMatch(JSON.stringify(exported), /oracle|outcome|displayedCards|Northport/);
    const candidates = exported.schema.classes.find(({ name }) => name === 'Building').attributes;
    assert.deepEqual(candidates, [
      { name: 'refA', type: 'reference', targetClass: 'Street' }, { name: 'refB', type: 'reference', targetClass: 'Street' },
    ]);
    if (mode === 'mapping') assert.deepEqual(exported.currentSpec.steps.find((step) => step.as === 'buildings').filters.map(({ path }) => path), ['Code']);
  }
  const path = '/cmdbuild/services/rest/v3/classes/Building/cards';
  assert.deepEqual(await pilotHoldoutRead(noHelp)(path), await pilotHoldoutRead(base)(path));
});

test('synthetic read transport rejects operations outside its catalog and card-list paths', async () => {
  const read = pilotHoldoutRead(base);
  await assert.rejects(read('/cmdbuild/services/rest/v3/classes/Building/cards/31'), /Unsupported holdout read/);
  await assert.rejects(read('http://example.invalid/cmdbuild/services/rest/v3/classes'), /Unsupported holdout read/);
  assert.throws(() => pilotHoldoutInput(base, 'unknown'), /Unknown pilot holdout mode/);
});

test('pilot plan envelope keeps typed Help and authored bindings separate from oracle and expected data', () => {
  const known = createPilotHoldoutScenario(base);
  const unknown = createPilotHoldoutScenario(noHelp);
  assert.deepEqual(known.modes, PILOT_HOLDOUT_MODES);
  assert.equal(known.split, 'holdout');
  assert.equal(known.dataKind, 'synthetic');
  assert.deepEqual(known.oracle, createPilotHoldoutCase(base, 'end-to-end').oracle);
  assert.deepEqual(unknown.oracle, { ...createPilotHoldoutCase(noHelp, 'end-to-end').oracle,
    expectedStage: { flow: 'flow', mapping: 'mapping', 'end-to-end': 'flow' } });
  assert.deepEqual(unknown.input.knowledgeByBlock, {});
  assert.deepEqual({ ...known.input, knowledgeByBlock: {} }, unknown.input);
  assert.doesNotMatch(JSON.stringify(unknown.input), /oracle|outcome|refA|refB|Northport/);
  assert.doesNotMatch(known.input.d2Source, /binding-result:/);
  assert.match(known.input.authoredD2Source, /binding-result: Buildings/);
});
