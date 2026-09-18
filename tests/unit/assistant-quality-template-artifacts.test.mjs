import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { buildTesttemplate4Artifacts } from '../../scripts/assistant-quality-template-artifacts.mjs';
import {
  assistantDiagramBindingIntentMessages,
  assistantDiagramBindingIntentSeed,
  assistantDiagramPlacementTargets,
  assistantObjectFlowBusinessBlockManifest,
  d2SourceForCompiler,
  diagramImportDeterministicSpecHash,
  normalizeAssistantDiagramBindingIntentResponse,
  normalizeTemplateAssistantPromptOverrides,
  templateAssistantRuntimeConfig,
  validateTemplateSpecForStorage,
} from '../../scripts/dev-proxy-server.mjs';

const names = [
  'Сети целевой ИС', 'VLAN целевой ИС', 'Все ACL', 'Приложения целевой ИС',
  'Физические серверы целевой ИС', 'Виртуальные серверы целевой ИС', 'Внешние ИС',
  'Внутренние ИС', 'ACL внешних ИС', 'ACL внутренних ИС', 'ACL внутри целевой ИС',
  'Приложения физических серверов', 'Приложения виртуальных серверов',
];
const roles = [
  'group_external', 'group_internal', 'group_target', 'group_dmz', 'scope_vlan',
  'scope_server', 'applications_group', 'external_system', 'internal_system',
  'vlan', 'server', 'application', 'acl_external', 'acl_internal', 'acl_intrasystem',
];
const overrideKeys = ['diagramSemantics', 'diagramBindingIntent', 'diagramPlacement', 'diagramConnections', 'diagramCritique'];
const baselineUrl = new URL('../../.omk/runs/2026-09-05-testtemplate4/testtemplate3-before.json', import.meta.url);

function fixture(newline = '\n') {
  const source = `vars: {
  data: { cmdp: { import: {
    static: { legend: true }
    connections: { acl_external: { directionPolicy: dataFields } }
  } } }
}
classes: {
${roles.map((role) => `    ${role}: {
      style.stroke: "#123456"
      Notes: |md
        Original meaning of ${role}.
      |
    }`).join('\n\n')}
}
target: {
  class: group_target
  subnet: { class: scope_vlan; host: { class: server } }
}
outside: { class: external_system }
outside -> target.subnet.host: "exemplar only" { class: acl_external }
legend: {
  Notes: |md
    Original legend. Preserve verbatim.
  |
  a -> b: "example" { class: acl_external }
}
`.replaceAll('\n', newline);
  return {
    version: 1, cache: { ttlSec: 73 }, params: { isName: { default: 'fixture-param' } },
    steps: [{ type: 'select', as: 'opaque-selection', className: 'Fixture', filter: { condition: 'unchanged' } }],
    result: { tables: [{ source: 'opaque-selection' }], diagrams: [] }, publish: { enabled: false },
    visualModel: { untouched: ['items'] }, visualModels: [{ untouched: true }],
    authoring: {
      version: 1,
      assistant: {
        promptContractVersion: 4, diagramIntentPrompt: 'old mapping',
        objectFlowIntent: { context: 'old context', blocks: names.map((name, i) => ({
          id: `opaque-${names.length - i}`, name, description: `old ${name}`,
          uses: i ? ['opaque-13'] : [], resultKind: i > 10 ? 'relationPairs' : 'auto',
        })) },
      },
      d2: { source, sourceHash: createHash('sha256').update(source).digest('hex'),
        analysisCheckpoint: { source: { hash: 'stale' } }, assistantCheckpoint: { source: { hash: 'stale' } } },
    },
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function withoutAllowedChanges(spec) {
  const copy = structuredClone(spec);
  const { assistant, d2 } = copy.authoring;
  delete assistant.diagramIntentPrompt;
  delete assistant.systemPromptOverrides;
  delete assistant.objectFlowIntent.context;
  assistant.objectFlowIntent.blocks.forEach((block) => { delete block.description; });
  for (const key of ['source', 'sourceHash', 'analysisCheckpoint', 'assistantCheckpoint']) delete d2[key];
  return copy;
}

function noteBodies(source) {
  return [...source.matchAll(/^[ \t]*Notes: \|md\r?\n([\s\S]*?)^[ \t]*\|[ \t]*\r?$/gm)].map((match) => match[1]);
}

function withoutNoteBodies(source) {
  return source.replace(/(^[ \t]*Notes: \|md\r?\n)[\s\S]*?(^[ \t]*\|[ \t]*\r?$)/gm, '$1$2');
}

function bindingFixture(spec) {
  const bodies = noteBodies(spec.authoring.d2.source);
  const placementRoles = roles.slice(0, 12).map((key, index) => ({
    id: `opaque-role-${index}`, key, visualKind: index < 7 ? 'container' : 'node', notes: bodies[index],
  }));
  const parentIndexes = [-1, -1, -1, 2, 3, 4, 5, 0, 1, 4, 5, 6];
  const proposal = {
    roles: placementRoles,
    structureTree: { version: 1, items: placementRoles.map((role, index) => ({
      id: `opaque-item-${index}`, roleId: role.id,
      parentId: parentIndexes[index] < 0 ? '' : `opaque-item-${parentIndexes[index]}`,
    })) },
  };
  const stages = spec.authoring.assistant.objectFlowIntent.blocks.map((block, index) => ({
    id: `opaque-stage-${index}`, alias: `opaque-alias-${index}`, className: 'Fixture',
    stageRole: 'terminal', outputKind: block.resultKind === 'relationPairs' ? 'relationPairs' : 'sourceCards',
    assistantBlockIds: [block.id],
  }));
  return {
    placements: assistantDiagramPlacementTargets(proposal),
    businessBlockManifest: assistantObjectFlowBusinessBlockManifest(spec, stages),
    relationRules: [],
  };
}

function verifyRevision(input) {
  const before = JSON.stringify(input);
  const next = buildTesttemplate4Artifacts(freeze(input));
  assert.notEqual(next, input);
  assert.notEqual(next.authoring, input.authoring);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(withoutAllowedChanges(next), withoutAllowedChanges(input));
  assert.equal(diagramImportDeterministicSpecHash(next), diagramImportDeterministicSpecHash(input));
  assert.notEqual(next.authoring.d2.source, input.authoring.d2.source);
  assert.equal(next.authoring.d2.sourceHash, createHash('sha256').update(next.authoring.d2.source, 'utf8').digest('hex'));
  assert.equal(Object.hasOwn(next.authoring.d2, 'analysisCheckpoint'), false);
  assert.equal(Object.hasOwn(next.authoring.d2, 'assistantCheckpoint'), false);
  assert.equal(withoutNoteBodies(next.authoring.d2.source), withoutNoteBodies(input.authoring.d2.source));
  const compilerText = (source) => d2SourceForCompiler(source).split(/\r?\n/).filter((line) => line.trim()).join('\n');
  assert.equal(compilerText(next.authoring.d2.source), compilerText(input.authoring.d2.source));
  assert.deepEqual(buildTesttemplate4Artifacts(next), next);
  assert.deepEqual(validateTemplateSpecForStorage(next), []);
  return next;
}

test('revision clones only allowed authoring subtrees and preserves executable identity', () => {
  const input = fixture();
  const next = verifyRevision(input);
  next.steps[0].filter.condition = 'independent clone';
  assert.equal(input.steps[0].filter.condition, 'unchanged');
});

test('every role Notes changes meaningfully while legend and D2 grammar stay byte-identical', () => {
  const input = fixture('\r\n');
  const next = verifyRevision(input);
  const oldNotes = noteBodies(input.authoring.d2.source);
  const newNotes = noteBodies(next.authoring.d2.source);
  assert.equal(newNotes.length, roles.length + 1);
  roles.forEach((role, index) => {
    assert.notEqual(newNotes[index], oldNotes[index], role);
    assert.ok(newNotes[index].trim().length > 100, role);
  });
  assert.equal(newNotes.at(-1), oldNotes.at(-1));
  assert.doesNotMatch(next.authoring.d2.source, /(?<!\r)\n/);
  const byRole = Object.fromEntries(roles.map((role, i) => [role, newNotes[i]]));
  assert.match(byRole.scope_vlan, /для каждой карточки/);
  assert.match(byRole.scope_server, /положительному условию принадлежности/);
  assert.match(byRole.applications_group, /внутри каждого экземпляра/);
  assert.match(byRole.application, /current является сервером, relation-source является приложением/);
  assert.match(byRole.application, /Dependency\/lineage не является доказательством/);
  assert.match(byRole.vlan, /Это VLAN, не информационная система/);
  assert.match(byRole.server, /IP-адресу самого сервера/);
  assert.match(byRole.acl_intrasystem, /кандидатами, отобранными по источнику ИЛИ назначению/);
  assert.match(byRole.acl_intrasystem, /оба отображаемых конца/);
  assert.match(byRole.acl_intrasystem, /остаются строками результата; отбор по ИЛИ не менять/);
  assert.doesNotMatch(byRole.acl_intrasystem, /сообщить о противоречии|оставить связь неподтвержденной/);
});

test('natural block descriptions retain names, grain, ids, uses and unresolved business ambiguities', () => {
  const input = fixture();
  const next = buildTesttemplate4Artifacts(input);
  const blocks = next.authoring.assistant.objectFlowIntent.blocks;
  const byName = Object.fromEntries(blocks.map((block) => [block.name, block.description]));
  assert.deepEqual(blocks.map(({ description, ...rest }) => rest), input.authoring.assistant.objectFlowIntent.blocks.map(({ description, ...rest }) => rest));
  for (const name of names) {
    assert.notEqual(byName[name], `old ${name}`);
    assert.match(byName[name], /Результат:/);
    assert.doesNotMatch(byName[name], /Результат \d|stageId|businessBlockId|endpointMode|hierarchyConditions/);
  }
  assert.match(byName['VLAN целевой ИС'], /Путь между VLAN и ipRange требует подтверждения/);
  assert.doesNotMatch(byName['VLAN целевой ИС'], /ISZabbixMonitoringDomain/);
  assert.match(byName['Все ACL'], /Source ipaddress ИЛИ Destination ipaddress/);
  assert.match(byName['ACL внутри целевой ИС'], /Name, равному параметру isName/);
  assert.match(byName['ACL внутри целевой ИС'], /Source ipaddress ИЛИ Destination ipaddress/);
  assert.match(byName['ACL внутри целевой ИС'], /более широкий вход, не готовый набор стрелок/);
  assert.match(byName['ACL внутри целевой ИС'], /оба отображаемых конца/);
  assert.doesNotMatch(byName['ACL внутри целевой ИС'], /Description|до согласования|сообщить о противоречии/);
  const prose = [next.authoring.assistant.objectFlowIntent.context, ...Object.values(byName), next.authoring.assistant.diagramIntentPrompt, ...noteBodies(next.authoring.d2.source)].join('\n');
  for (const [, name] of prose.matchAll(/«([^»]+)»/g)) assert.ok(names.includes(name), `Unknown block ${name}`);
  assert.doesNotMatch(prose, /\b(?:\d{1,3}\.){3}\d{1,3}\b|diagramTest|ISZabbixMonitoringDomain:ipRange/);
});

test('overrides survive backend normalization and touch only the five diagram phases', () => {
  const next = buildTesttemplate4Artifacts(fixture());
  const overrides = next.authoring.assistant.systemPromptOverrides;
  assert.deepEqual(Object.keys(overrides), overrideKeys);
  assert.deepEqual(normalizeTemplateAssistantPromptOverrides(overrides), overrides);
  assert.ok(next.authoring.assistant.diagramIntentPrompt.length < 4000);
  assert.match(next.authoring.assistant.diagramIntentPrompt, /При интерпретации/);
  assert.match(next.authoring.assistant.diagramIntentPrompt, /При сопоставлении/);
  for (const value of Object.values(overrides)) assert.ok(value.length > 100 && value.length <= 20_000);
  const runtime = freeze({ assistant: { prompt: { system: 'unchanged system', objectFlow: 'unchanged flow', objectFlowSemantic: 'unchanged semantic' }, llm: { enabled: false } } });
  const effective = templateAssistantRuntimeConfig(runtime, next);
  assert.deepEqual(effective.assistant.prompt, { ...runtime.assistant.prompt, ...overrides });
  assert.deepEqual(effective.assistant.llm, runtime.assistant.llm);
  const binding = overrides.diagramBindingIntent;
  assert.match(binding, /endpointMode \(attributeEndpoints\|relationCard\|deterministicEndpoints\)/);
  assert.match(binding, /dataFields является directionPolicy в D2 source, а не endpointMode/);
  assert.match(binding, /sourceField и targetField выбираются по явному предметному смыслу в Notes/);
  assert.match(binding, /Используй equals, не знак =/);
  assert.match(binding, /нет ключа выбора стороны пары/);
  assert.match(overrides.diagramConnections, /В этом ответе нет отдельного поля unresolved/);
  assert.match(overrides.diagramCritique, /approved=false без violations не принимается/);
});

test('business fields and confirmed domains stay explicit in local descriptions and Notes', () => {
  const next = buildTesttemplate4Artifacts(fixture());
  const byName = Object.fromEntries(next.authoring.assistant.objectFlowIntent.blocks.map((block) => [block.name, block.description]));
  for (const name of ['Приложения целевой ИС', 'Физические серверы целевой ИС', 'Виртуальные серверы целевой ИС']) {
    assert.match(byName[name], /ipaddress\.IP address value/);
    assert.match(byName[name], /не адрес управления/);
  }
  assert.match(byName['Приложения физических серверов'], /CMDB domain phs/);
  assert.match(byName['Приложения виртуальных серверов'], /CMDB domain vs/);
  const bodies = noteBodies(next.authoring.d2.source);
  for (const role of ['server', 'application']) assert.match(bodies[roles.indexOf(role)], /ipaddress\.IP address value/);
  for (const role of ['acl_external', 'acl_internal', 'acl_intrasystem']) {
    assert.match(bodies[roles.indexOf(role)], /Адрес источника ACL ipaddress/);
    assert.match(bodies[roles.indexOf(role)], /адрес назначения ACL dipaddress/);
  }
  assert.match(next.authoring.assistant.diagramIntentPrompt, /Source ipaddress \(ipaddress\) и Destination ipaddress \(dipaddress\)/);
  assert.doesNotMatch(JSON.stringify(next), /\bs(?:ipaddress)\b/);
});

test('all five system overrides are domain-neutral and distinguish candidate rows from final edges', () => {
  const overrides = buildTesttemplate4Artifacts(fixture()).authoring.assistant.systemPromptOverrides;
  for (const prompt of Object.values(overrides)) {
    assert.doesNotMatch(prompt, /ACL|ipaddress|dipaddress|isNAT|isName|scope_vlan|scope_server|applications_group|VLAN|DMZ|phServer|vServer|Application|\bphs\b|\bvs\b|current|relation-source|сервер|приложени|ИС|Name\/Description/);
    for (const role of roles) assert.equal(new RegExp(`\\b${role}\\b`).test(prompt), false, role);
    for (const name of names) assert.equal(prompt.includes(name), false, name);
  }
  assert.match(overrides.diagramBindingIntent, /сторону проверки родителя определяют Notes и terminalCardSources/);
  assert.match(overrides.diagramBindingIntent, /набор строк-кандидатов и более узкие условия отображения ребер совместимы/);
  assert.match(overrides.diagramConnections, /исходный набор строк не меняется/);
  assert.match(overrides.diagramConnections, /Одинаковые значения сравнения не объединяют разные карточки/);
  assert.match(overrides.diagramConnections, /все подтвержденные совпадения, не только первое/);
  assert.match(overrides.diagramCritique, /само различие не является нарушением/);
});

test('multiline Notes carry exact labels and preserve indentation, line endings and idempotence', () => {
  const labels = {
    group_external: '"Внешние системы"', group_internal: '"Внутренние системы"',
    group_target: '${param.isName}', group_dmz: '"DMZ"', applications_group: '"Приложения и среды"',
    scope_vlan: '${Description}', scope_server: '${Description}',
  };
  for (const newline of ['\n', '\r\n']) {
    const next = verifyRevision(fixture(newline));
    const bodies = noteBodies(next.authoring.d2.source);
    for (const [role, label] of Object.entries(labels)) {
      const body = bodies[roles.indexOf(role)];
      assert.ok(body.includes(`Подпись рамки: ${label}`), role);
      assert.match(body, /не технический ключ роли/);
      const lines = body.replace(/\r?\n$/, '').split(/\r?\n/);
      assert.ok(lines.length >= 3, role);
      assert.ok(lines.every((line) => line.startsWith('      ')), role);
    }
    for (const role of ['scope_vlan', 'scope_server']) {
      assert.match(bodies[roles.indexOf(role)], /из собственной primary-карточки/);
    }
    for (const role of ['scope_server', 'application']) {
      assert.doesNotMatch(bodies[roles.indexOf(role)], /^\s*binding-result:/m);
    }
  }
});

test('existing backend normalization enforces Notes materialization despite a structural model answer', () => {
  const spec = buildTesttemplate4Artifacts(fixture());
  const input = bindingFixture(spec);
  const expected = ['structural', 'structural', 'structural', 'structural', 'stage', 'stage', 'structural', 'stage', 'stage', 'parentCard', 'parentCard', 'stage'];
  assert.equal(input.placements.length, expected.length);
  const normalized = normalizeAssistantDiagramBindingIntentResponse(input, {
    placementBindings: input.placements.map((placement) => ({
      structureItemId: placement.structureItemId, materializationIntent: 'structural',
    })), explanation: 'Рамки повторяемые.',
  });
  input.placements.forEach((placement, index) => {
    assert.deepEqual(placement.allowedMaterialization, [expected[index]], roles[index]);
    assert.equal(placement.materializationHint, expected[index], roles[index]);
    assert.equal(placement.materializationError, null, roles[index]);
    assert.equal(normalized.placementBindings[index].materializationIntent, expected[index], roles[index]);
    if (expected[index] === 'parentCard') {
      assert.equal(placement.parentCardContract.requiresAncestorStage, true);
      const parent = input.placements.find((item) => item.structureItemId === placement.parentStructureItemId);
      assert.deepEqual(parent.allowedMaterialization, ['stage']);
      assert.equal(Object.hasOwn(normalized.placementBindings[index], 'businessBlockId'), false);
    }
  });
  const payload = JSON.parse(assistantDiagramBindingIntentMessages(input, templateAssistantRuntimeConfig({}, spec)).at(-1).content);
  assert.deepEqual(payload.placements.map((placement) => placement.fixedMaterializationIntent), expected);
  assert.deepEqual(input.placements.map((placement) => placement.directives['binding-result'] || ''), [
    '', '', '', '', 'VLAN целевой ИС', '', '', 'Внешние ИС', 'Внутренние ИС', '', '', '',
  ]);
});

test('binding seed fixes exact blocks without inventing role-wide blocks or accepting missing obligations', () => {
  const spec = buildTesttemplate4Artifacts(fixture());
  const input = bindingFixture(spec);
  const before = structuredClone(input);
  const seed = assistantDiagramBindingIntentSeed(input);
  assert.deepEqual(input, before);
  assert.equal(seed.placementBindings.length, 10);
  assert.deepEqual(seed.pendingPlacementIds, input.placements.map((placement) => placement.structureItemId));
  const payload = JSON.parse(assistantDiagramBindingIntentMessages(input, {}).at(-1).content);
  for (const [index, name] of [[4, 'VLAN целевой ИС'], [7, 'Внешние ИС'], [8, 'Внутренние ИС']]) {
    const block = input.businessBlockManifest.blocks.find((item) => item.name === name);
    const structureItemId = input.placements[index].structureItemId;
    assert.deepEqual(seed.placementBindings.find((item) => item.structureItemId === structureItemId), {
      structureItemId, materializationIntent: 'stage', businessBlockId: block.id,
    });
    assert.equal(payload.placements[index].requiredBusinessBlockId, block.id);
  }
  for (const index of [5, 11]) {
    assert.equal(seed.placementBindings.some((item) => item.structureItemId === input.placements[index].structureItemId), false);
    assert.equal(Object.hasOwn(payload.placements[index], 'requiredBusinessBlockId'), false);
    assert.equal(payload.placements[index].fixedMaterializationIntent, 'stage');
  }
  for (const binding of seed.placementBindings.filter((item) => item.materializationIntent !== 'stage')) {
    assert.equal(Object.hasOwn(binding, 'businessBlockId'), false);
  }
  for (const block of input.businessBlockManifest.blocks) block.terminalStageId = '';
  const incomplete = assistantDiagramBindingIntentSeed(input);
  assert.equal(incomplete.placementBindings.filter((item) => item.materializationIntent === 'stage').length, 0);
  assert.deepEqual(incomplete.pendingPlacementIds, seed.pendingPlacementIds);
});

test('documented binding keys and enum vocabulary agree with the actual backend message contract', () => {
  const backend = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
  const contractText = backend.match(/function assistantDiagramBindingIntentMessages\([^]*?const contract = '([^\n]+)';/)[1];
  const contract = JSON.parse(contractText);
  assert.deepEqual(Object.keys(contract.placementBindings[0]), ['structureItemId', 'materializationIntent', 'businessBlockId', 'membership', 'requiredConditions', 'requiredMembership', 'endpointFields', 'endpointOperators']);
  assert.deepEqual(Object.keys(contract.connectionBindings[0]), ['d2ClassKey', 'businessBlockId', 'rowGrain', 'endpointMode', 'sourceField', 'sourceOperator', 'targetField', 'targetOperator']);
  assert.equal(contract.connectionBindings[0].endpointMode, 'attributeEndpoints|relationCard|deterministicEndpoints');
  const prompt = buildTesttemplate4Artifacts(fixture()).authoring.assistant.systemPromptOverrides.diagramBindingIntent;
  for (const shape of [contract.placementBindings[0], contract.connectionBindings[0], contract.unresolved[0]]) {
    for (const key of Object.keys(shape)) assert.ok(prompt.includes(key), key);
  }
});

test('canonical input guards fail without mutation and never guess an unrelated template shape', () => {
  for (const input of [null, [], {}, { authoring: {} }]) assert.throws(() => buildTesttemplate4Artifacts(input));
  const mutations = [
    (s) => { s.authoring.version = 2; },
    (s) => { s.authoring.assistant.objectFlowIntent.blocks.pop(); },
    (s) => { s.authoring.assistant.objectFlowIntent.blocks.push(s.authoring.assistant.objectFlowIntent.blocks[0]); },
    (s) => { s.authoring.d2.source = ''; },
    (s) => { s.authoring.d2.source = s.authoring.d2.source.replace('    scope_vlan:', '    unknown:'); },
    (s) => { s.authoring.d2.source = s.authoring.d2.source.replace('      |\n', ''); },
    (s) => { s.authoring.assistant.systemPromptOverrides = { diagramMapping: 'legacy' }; },
    (s) => { s.authoring.assistant.systemPromptOverrides = { objectFlow: 'out of scope' }; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    const before = JSON.stringify(input);
    assert.throws(() => buildTesttemplate4Artifacts(input));
    assert.equal(JSON.stringify(input), before);
  }
});

test('unrelated business blocks and already-current checkpoints are preserved', () => {
  const input = fixture();
  const extra = { name: 'Unrelated block', id: 'unrelated', description: 'Keep this', uses: [] };
  input.authoring.assistant.objectFlowIntent.blocks.reverse();
  input.authoring.assistant.objectFlowIntent.blocks.push(extra);
  const next = buildTesttemplate4Artifacts(input);
  assert.deepEqual(next.authoring.assistant.objectFlowIntent.blocks.at(-1), extra);
  const checkpoint = { source: { hash: next.authoring.d2.sourceHash }, marker: 'keep current' };
  next.authoring.d2.analysisCheckpoint = checkpoint;
  assert.deepEqual(buildTesttemplate4Artifacts(next).authoring.d2.analysisCheckpoint, checkpoint);
});

test('fresh private baseline satisfies the same offline evidence contract', { skip: !existsSync(baselineUrl) }, () => {
  const bytes = readFileSync(baselineUrl, 'utf8');
  const spec = JSON.parse(bytes).template.spec;
  for (const [domain, targetClass] of [['phs', 'phServer'], ['vs', 'vServer']]) {
    assert.ok(spec.steps.some((step) => step.type === 'expandRelations' && step.domain === domain && step.targetClass === targetClass));
  }
  verifyRevision(spec);
  assert.equal(readFileSync(baselineUrl, 'utf8'), bytes);
});
