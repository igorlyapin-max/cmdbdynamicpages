import test from 'node:test';
import assert from 'node:assert/strict';
import { compileObjectFlowToSpec } from '../../scripts/assistant-object-flow.mjs';
import { compileAssistantPlacementIntent } from '../../scripts/assistant-placement-compiler.mjs';
import {
  assistantDataSemanticModel, assistantObjectFlowBusinessBlockManifest,
  assistantDiagramBindingIntentSeed, assistantDiagramBindingIntentDraftFromResponse,
  assistantDiagramPlacementTargets, assistantDiagramPlacementDraftFromResponse,
  assistantDiagramSemanticObligations, assistantDiagramPlacementExecutionValidation,
  assistantObjectFlowDiagramStages, normalizeDiagramImportIr, createDiagramImportProposal,
  applyDiagramImportProposal, executeFilterRows, executeDifferenceRows, buildResultDiagrams
} from '../../scripts/dev-proxy-server.mjs';

function fixture({ condition = '', selfReference = false } = {}) {
  const alias = selfReference ? 'people' : 'assets';
  const className = selfReference ? 'Person' : 'Asset';
  const columns = ['Code', 'Description', ...(selfReference ? ['manager'] : [])];
  const currentSpec = compileObjectFlowToSpec({
    version: 1, steps: [], result: { tables: [] },
    authoring: { version: 1, assistant: { objectFlowIntent: {
      blocks: [{ id: alias, name: className, description: `Selected ${className} cards`, uses: [] }]
    } } }
  }, {
    version: 1,
    selections: [{ id: `selection:${alias}`, alias, className, columns,
      rules: [{ action: 'include', path: 'Code', op: 'matches', regex: '.*' }] }]
  }, {
    outputMetadata: [{ alias, label: className, assistantBlockId: alias, assistantStageRole: 'terminal' }],
    assistantOutputManifest: { version: 1, blocks: [{ id: alias, name: className, order: 1 }] }
  });
  const source = `card: ${className}`;
  const notes = `materialization: stage\nbinding-result: ${alias}` + (condition ? `\nrequired-condition: ${condition}` : '');
  const proposal = createDiagramImportProposal(currentSpec, normalizeDiagramImportIr({
    version: 4,
    elements: { groups: [], nodes: [{ id: 'card', label: className, classKeys: ['card'], pathSegments: ['card'] }] },
    classes: [{ key: 'card', usageKeys: ['card'], notes }]
  }, source), { sourceText: source });
  const stages = assistantObjectFlowDiagramStages(currentSpec);
  const placements = assistantDiagramPlacementTargets(proposal, stages);
  const dataSemanticModel = assistantDataSemanticModel(stages, { classes: [{ name: className, attributes: [
    { name: 'Code', type: 'string' }, { name: 'Description', type: 'string' },
    ...(selfReference ? [{ name: 'manager', type: 'reference', targetClass: className }] : [])
  ] }] }, { depth: 1, maxBytes: 12000, queries: [notes] });
  const businessBlockManifest = assistantObjectFlowBusinessBlockManifest(currentSpec, stages, dataSemanticModel);
  const input = { currentSpec, stages, placements, relationRules: [],
    structure: proposal.structure, structureTree: proposal.structureTree,
    validationRoles: proposal.roles, dataSemanticModel, businessBlockManifest };
  assert.equal(stages.length, 1);
  assert.equal(stages[0].id, `selection:${alias}`);
  assert.ok(stages[0].columns.includes('Code'));
  assert.equal(placements.length, 1);
  assert.equal(businessBlockManifest.blocks[0].id, alias);
  assert.equal(businessBlockManifest.blocks[0].status, 'ready');
  assert.equal(businessBlockManifest.blocks[0].terminalStageId, stages[0].id);
  assert.equal(dataSemanticModel.fieldContextDiagnostics.truncated, false);
  return { input, proposal, alias, className };
}

function conditionRule(operator, { negate = false, key = 'operator' } = {}) {
  return { id: 'response-condition', action: 'include', negate, origin: 'assistant', [key]: operator,
    left: { column: 'Code' }, right: { kind: 'literal', value: 'A' } };
}

function draftFromNotes(local, edit = () => {}) {
  const seed = assistantDiagramBindingIntentSeed(local.input);
  assert.deepEqual(seed.pendingPlacementIds, []);
  const bound = assistantDiagramBindingIntentDraftFromResponse(local.input, seed);
  if (!bound.success) return { input: local.input, draft: bound };
  const input = { ...local.input, bindingIntent: bound.intent };
  const response = compileAssistantPlacementIntent(input);
  assert.ok(response, 'confirmed intent must be compilable');
  edit(response.mappings[0]);
  return { input, draft: assistantDiagramPlacementDraftFromResponse(input, response) };
}

function assertUnsupportedOperator(action, operator) {
  let draft, failure;
  try { draft = action(); } catch (error) { failure = error; }
  let issues;
  if (failure) {
    assert.equal(failure.statusCode, 422, failure.stack);
    assert.ok(failure.code, 'a thrown rejection must be typed');
    issues = [failure];
  } else {
    const operators = draft.items?.flatMap((item) => item.mapping.conditions.rules.map((rule) => rule.operator));
    assert.equal(draft.success, false,
      `${operator} must be rejected before normalization; success=${draft.success}, operators=${JSON.stringify(operators)}, errors=${JSON.stringify(draft.errors)}`);
    assert.ok(draft.errors?.length, 'rejected drafts must explain the unsupported operator');
    issues = draft.errors;
  }
  const evidence = issues.map((issue) => `${issue.message || ''} ${JSON.stringify(issue)}`).join('\n');
  assert.ok(evidence.includes(operator), `diagnostics must retain the original operator: ${evidence}`);
  assert.match(evidence, /operator|condition/i);
  return issues;
}

function assertExecutable(input, draft) {
  assert.equal(draft.success, true, JSON.stringify(draft.errors));
  assert.deepEqual(draft.unresolved, []);
  const validation = assistantDiagramPlacementExecutionValidation(input, draft.items);
  assert.equal(validation.checked, true);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.invalidItemIds, []);
  const matrix = assistantDiagramSemanticObligations(input, draft);
  assert.ok(matrix.obligations.length > 0);
  assert.ok(matrix.obligations.every((item) => item.status === 'satisfied'), JSON.stringify(matrix));
}

function visibleIds(local, draft) {
  const mappingById = new Map(draft.items.map((item) => [item.structureItemId, item.mapping]));
  const applied = applyDiagramImportProposal(local.input.currentSpec, local.proposal, [], [], {
    ...local.proposal.structureTree,
    items: local.proposal.structureTree.items.map((item) => ({ ...item, mapping: mappingById.get(item.id) }))
  });
  const context = { [local.alias]: { rows: ['ABC', 'A', 'B'].map((Code) => ({
    _id: Code, Class: local.className, Code, Description: Code
  })) } };
  const filters = applied.steps.filter((step) => step.managedBy === 'd2ImportV3' && step.type === 'filterRows');
  assert.equal(filters.length, 1);
  for (const step of applied.steps.filter((item) => item.managedBy === 'd2ImportV3')) {
    if (step.type === 'filterRows') context[step.as] = executeFilterRows(step, {}, context, { maxRows: 100 });
    else if (step.type === 'differenceRows') context[step.as] = executeDifferenceRows(step, context, { maxRows: 100 });
    else assert.fail(`Unexpected condition execution step: ${step.type}`);
  }
  const diagrams = buildResultDiagrams(applied, context, {}, { maxRows: 100 });
  assert.equal(diagrams.length, 1);
  return diagrams[0].nodes.map((node) => node.businessId);
}

for (const supplyEquals of [false, true]) {
  test(`Notes startsWith is rejected through intent -> compiler${supplyEquals ? ' even with an equals response' : ''}`, () => {
    const local = fixture({ condition: 'Code startsWith A' });
    assert.deepEqual(local.input.placements[0].directives['required-condition'], ['Code startsWith A']);
    const before = structuredClone(local.input);
    const issues = assertUnsupportedOperator(() => draftFromNotes(local, (candidate) => {
      if (supplyEquals) candidate.conditions = { ruleJoin: 'all', rules: [conditionRule('equals')] };
    }).draft, 'startsWith');
    const issue = issues.find((item) => item.code === 'diagram_condition_operator_unsupported');
    assert.ok(issue, JSON.stringify(issues));
    assert.ok(issue.message.includes(local.input.placements[0].displayName));
    assert.ok(issue.message.includes(local.input.businessBlockManifest.blocks[0].name));
    assert.match(issue.message, /Code startsWith A/);
    assert.match(issue.message, /equals.*contains.*notEquals/);
    assert.deepEqual(local.input, before);
  });
}

for (const operator of ['startsWith', 'unsupportedoperator']) {
  for (const key of ['operator', 'op']) {
    test(`response candidate rejects unsupported ${key}=${operator} on a known stage and field`, () => {
      const local = fixture();
      const before = structuredClone(local.input);
      assertUnsupportedOperator(() => draftFromNotes(local, (candidate) => {
        candidate.conditions = { ruleJoin: 'all', rules: [conditionRule(operator, { key })] };
      }).draft, operator);
      assert.deepEqual(local.input, before);
    });
  }
}

for (const [operator, normalized, negate, expected, value = 'A'] of [
  ['equals', 'equals', false, ['A']],
  ['contains', 'contains', false, ['ABC', 'A']],
  ['regexMatch', 'regexMatch', false, ['ABC'], '^A.+$'],
  ['notEquals', 'equals', true, ['ABC', 'B']]
]) {
  test(`Notes ${operator} remains executable and filters the final diagram correctly`, () => {
    const local = fixture({ condition: `Code ${operator} ${value}` });
    const { input, draft } = draftFromNotes(local);
    assert.deepEqual(input.bindingIntent.placements[0].requiredConditions, [`Code ${operator} ${value}`]);
    assertExecutable(input, draft);
    const rules = draft.items[0].mapping.conditions.rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].operator, normalized);
    assert.equal(rules[0].negate, negate);
    assert.equal(rules[0].right.value, value);
    assert.deepEqual(visibleIds(local, draft), expected);
  });
}

for (const [operator, negate, expected] of [
  ['equals', false, ['A']],
  ['equals', true, ['ABC', 'B']],
  ['contains', false, ['ABC', 'A']],
  ['contains', true, ['B']],
  ['notEquals', false, ['ABC', 'B']]
]) {
  test(`response ${operator} negate=${negate} remains valid without changing its meaning`, () => {
    const local = fixture();
    const { input, draft } = draftFromNotes(local, (candidate) => {
      candidate.conditions = { ruleJoin: 'all', rules: [conditionRule(operator, { negate })] };
    });
    assertExecutable(input, draft);
    const rules = draft.items[0].mapping.conditions.rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].operator, operator === 'notEquals' ? 'equals' : operator);
    assert.equal(rules[0].negate, negate || operator === 'notEquals');
    assert.deepEqual(visibleIds(local, draft), expected);
  });
}

test('depth-1 self-reference context survives Notes -> intent -> placement execution validation', () => {
  const path = 'manager.Description';
  const local = fixture({ condition: `${path} equals Alice`, selfReference: true });
  const semanticStage = local.input.dataSemanticModel.stages[0];
  const field = semanticStage.typedFields.find((item) => item.path === path);
  assert.ok(field, path);
  assert.equal(field.cardSourceId, 'current');
  assert.equal(field.rootClass, local.className);
  const definition = local.input.dataSemanticModel.fieldCatalog.find((item) => item.id === field.id);
  assert.ok(definition);
  assert.equal(definition.className, local.className);
  assert.equal(definition.cardinality, 'one');
  assert.deepEqual(definition.hops.map((hop) => [hop.kind, hop.name, hop.sourceClass, hop.targetClass]),
    [['reference', 'manager', local.className, local.className]]);
  assert.ok(semanticStage.readableFields.includes(path));
  assert.ok(local.input.businessBlockManifest.blocks[0].terminalFields.includes(path));
  const { input, draft } = draftFromNotes(local);
  assertExecutable(input, draft);
  const rules = draft.items[0].mapping.conditions.rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].left.column, path);
  assert.equal(rules[0].left.source.id, 'current');
  assert.equal(rules[0].left.source.className, local.className);
  assert.equal(rules[0].operator, 'equals');
  assert.equal(rules[0].right.value, 'Alice');
});
