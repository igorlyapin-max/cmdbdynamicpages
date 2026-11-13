import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const names = [
  'buildAssistantMcpContext', 'assistantObjectFlowMcpPayload', 'assistantMcpResult',
  'assistantObjectFlowSemanticMessages', 'assistantObjectFlowSemanticReferenceContext', 'assistantIntentText', 'assistantSearchTermsFromText',
  'assistantClassMentionsFromText', 'assistantTrimClassMentionText', 'assistantExactDescriptionFiltersFromText',
  'normalizedAssistantLookupText', 'assistantClassMetadataReadable', 'isCmdbuildIdentifierText',
  'assistantClassExactScore', 'assistantExactClassMatches', 'assistantClassTextScore',
  'assistantCandidateClassesFromSummary', 'assistantExactClassCandidatesFromSummary',
  'assistantClassMentionAlternatives', 'boundedMcpText', 'mcpResultEnvelope', 'compactMcpValue',
  'plainTextFromHtml', 'decodeHtmlEntities', 'assistantRelationRequirementsWithDependencyPaths'
];

function harness(classes = [], fields = {}, overrides = {}) {
  const calls = [];
  const globals = {
    Buffer, Date, Set, Map,
    normalizeAssistantRuntimeConfig: (config) => config,
    cloneJsonValueServer: (value, fallback) => structuredClone(value || fallback),
    uniqueStrings: (values) => [...new Set(values)],
    normalizeStringList: (values) => Array.isArray(values) ? values : [],
    truncateText: (value, limit) => String(value).slice(0, limit),
    classNamesFromTemplateSpec: (spec) => spec.classNames || [],
    mcpTimeoutMs: () => 10000,
    withMcpTimeout: async (promise) => promise,
    mcpReadModelSummary: async () => ({ classes, domains: [], classCatalog: { complete: true } }),
    callMcpTool: async (token, tool, args) => {
      calls.push({ token, tool, args });
      if (tool === 'cmdbuild_class_fields') {
        if (fields[args.className] instanceof Error) throw fields[args.className];
        return { className: args.className, attributes: fields[args.className] || [] };
      }
      return {};
    },
    collectAssistantLimitDiagnostics: () => [],
    addAssistantLimitDiagnostics: (target, values) => target.push(...values),
    assistantLimitDiagnostic: (value) => ({ ...value, limitHit: true }),
    assistantLimitWarningsFromDiagnostics: () => [],
    assistantObjectFlowInputParameters: (spec) => spec.parameters || [],
    hashJson: () => 'revision',
    ASSISTANT_CMDBUILD_CLASS_IDENTIFIER_PATTERN: /^[A-Za-z][A-Za-z0-9_]*$/,
    ASSISTANT_CMDBUILD_IDENTIFIER_PATTERN: /^[A-Za-z_][A-Za-z0-9_]*$/,
    ASSISTANT_MCP_MAX_CLASSES_ABSOLUTE: 10000,
    ASSISTANT_MCP_MAX_CONTEXT_BYTES_ABSOLUTE: 1000000,
    DEFAULT_ASSISTANT_MCP_MAX_CONTEXT_BYTES: 100000,
    ...overrides
  };
  vm.createContext(globals);
  for (const name of names) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(match, name);
    const end = source.indexOf('\n}\n', match.index);
    vm.runInContext(source.slice(match.index, end + 3), globals, { filename: name });
  }
  return { globals, calls };
}

const config = () => ({
  mcp: {
    enabled: true, allowedTools: ['cmdbuild_model_summary', 'cmdbuild_class_fields'],
    maxClasses: 20, maxCandidateClasses: 8, maxContextBytes: 100000, timeoutMs: 10000
  },
  semanticPlan: { maxReferencePathDepth: 1 },
  prompt: { system: 'Saved system override', objectFlowSemantic: 'Saved semantic override' }
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const body = (prompt) => ({
  prompt, assistantContextIntent: { blocks: [{ description: prompt }] }, mcpContextScope: 'objectFlow', currentSpec: {}
});
const fieldClasses = (calls) => calls.filter((call) => call.tool === 'cmdbuild_class_fields').map((call) => call.args.className);

test('semantic messages send structured reference data before the complete final task', () => {
  const { globals: h } = harness();
  const help = `Read <b>all</b> &amp; keep &#x41; ${'semantic detail '.repeat(600)}TAIL`;
  const payload = {
    classes: [{ name: 'Asset', help }],
    classFields: [{ className: 'Asset', attributes: [{ name: 'Owner', help: '<p>Readable <em>owner</em></p>' }] }]
  };
  const context = { enabled: true, tools: ['cmdbuild_class_fields'], text: JSON.stringify(payload), diagnostics: {} };
  const original = structuredClone(context);
  const intent = { blocks: [{ id: 'b1', description: 'business '.repeat(1000), expectedResult: 'TAIL' }] };
  const bindings = [{ blockId: 'b1', className: 'Asset', expectedOutput: true }];
  const contracts = [{ blockId: 'b1', sourcePath: ['Owner', 'Email'] }];
  const messages = h.assistantObjectFlowSemanticMessages(intent, { parameters: [{ name: 'query' }] }, context, config(), bindings, contracts);
  const users = messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 2);
  const reference = JSON.parse(users[0].content).mcpContext;
  const task = JSON.parse(users[1].content);
  assert.equal(typeof reference.data, 'object');
  assert.equal(reference.data.classes[0].help, `Read all & keep A ${'semantic detail '.repeat(600)}TAIL`);
  assert.equal(reference.data.classFields[0].attributes[0].help, 'Readable owner');
  assert.equal(reference.contextAssembly.beforeClasses, 1);
  assert.equal(reference.contextAssembly.afterClasses, 1);
  assert.ok(reference.contextAssembly.afterBytes < reference.contextAssembly.beforeBytes);
  assert.deepEqual(task.intent, intent);
  assert.deepEqual(task.confirmedClassBindings, bindings);
  assert.deepEqual(task.confirmedReferencePathContracts, contracts);
  assert.deepEqual(task.availableParameters, [{ name: 'query' }]);
  assert.match(task.instruction, /Perform the supplied intent.*Return only the JSON semantic-plan contract/);
  assert.match(messages.find((message) => message.content.startsWith('Confirmed class bindings')).content, /technical CMDBuild class Name \(metadata.name\), not the card Code attribute/);
  assert.equal('mcpContext' in task, false);
  assert.equal(messages.at(-1), users[1]);
  assert.equal(messages[0].content, 'Saved system override');
  assert.equal(messages[1].content, 'Saved semantic override');
  assert.deepEqual(context, original);
});

test('disabled, bounded and invalid MCP contexts are explicit, not silently repaired', () => {
  const { globals: h } = harness();
  const disabled = h.assistantObjectFlowSemanticMessages({}, {}, { enabled: false }, config());
  assert.deepEqual(JSON.parse(disabled.at(-2).content), { mcpContext: { enabled: false } });
  const bounded = h.assistantObjectFlowSemanticMessages({}, {}, {
    enabled: true, truncated: true, text: '{"complete":false}', warnings: ['Limited'], diagnostics: { limits: [{ limitHit: true }] }
  }, config());
  const reference = JSON.parse(bounded.at(-2).content).mcpContext;
  assert.equal(reference.truncated, true);
  assert.equal(reference.data.complete, false);
  assert.deepEqual(reference.warnings, ['Limited']);
  assert.deepEqual(reference.limits, [{ limitHit: true }]);
  assert.throws(() => h.assistantObjectFlowSemanticMessages({}, {}, { enabled: true, text: '{broken' }, config()), /JSON/);
});

test('exact explicit class binding excludes unrelated fallback but retains reference closure', async () => {
  const { globals: h, calls } = harness([
    { name: 'Asset', description: 'Equipment' },
    { name: 'Other', description: 'Unrelated algorithm matching helper', help: 'equipment' },
    { name: 'Owner', description: 'Responsible party' },
    { name: 'Secret', description: 'Equipment', _can_read: false }
  ], {
    Asset: [{ name: 'Owner', type: 'reference', targetClass: 'Owner' }],
    Owner: [{ name: 'Site', type: 'reference', targetClass: 'Site' }]
  });
  const result = await h.buildAssistantMcpContext('session', body('класс "Equipment"; algorithm matching'), config());
  assert.deepEqual(fieldClasses(calls), ['Asset', 'Owner']);
  assert.deepEqual(plain(result.diagnostics.confirmedClassNames), ['Asset']);
  assert.deepEqual(plain(result.diagnostics.candidateClasses.map((item) => item.name)), ['Asset']);
  assert.ok(result.diagnostics.limits.some((limit) => limit.limitName === 'maxReferencePathDepth'));
  assert.deepEqual(JSON.parse(result.text).classes.map((item) => item.name), ['Asset', 'Owner']);
  assert.equal(result.diagnostics.contextAssembly.beforeClasses, 4);
  assert.equal(result.diagnostics.contextAssembly.afterClasses, 2);
  assert.equal(result.diagnostics.contextAssembly.afterBytes, Buffer.byteLength(JSON.stringify(h.assistantObjectFlowSemanticReferenceContext(result).data)));
  assert.ok(result.diagnostics.contextAssembly.beforeBytes > 0);
  assert.ok(calls.every((call) => call.token === 'session'));
});

test('ambiguous, unresolved and incomplete explicit terms retain discovery candidates without exposing denied classes', async () => {
  const classes = [
    { name: 'AssetA', description: 'Equipment' },
    { name: 'AssetB', description: 'Equipment' },
    { name: 'Related', description: 'matching' },
    { name: 'Denied', description: 'matching', permissions: { _can_read: false } }
  ];
  for (const prompt of ['класс "Equipment"; matching', 'класс "Unknown"; matching']) {
    const { globals: h, calls } = harness(classes);
    await h.buildAssistantMcpContext('session', body(prompt), config());
    assert.ok(fieldClasses(calls).includes('Related'));
    assert.equal(fieldClasses(calls).includes('Denied'), false);
  }
  const { globals: h, calls } = harness(classes.slice(0, 1).concat(classes.slice(2)), {}, {
    mcpReadModelSummary: async () => ({ classes: classes.slice(0, 1).concat(classes.slice(2)), classCatalog: { complete: false } })
  });
  await h.buildAssistantMcpContext('session', body('класс "Equipment"; matching'), config());
  assert.ok(fieldClasses(calls).includes('Related'));
});

test('all explicit terms must resolve before fallback is suppressed; compound mentions resolve individually', async () => {
  const classes = [{ name: 'Asset', description: 'Equipment' }, { name: 'Owner' }, { name: 'Other', description: 'matching helper' }];
  for (const [prompt, fallback] of [
    ['класс "Asset"; класс "Missing"; matching', true],
    ['класс "Asset и Owner"; matching', false]
  ]) {
    const { globals: h, calls } = harness(classes);
    await h.buildAssistantMcpContext('session', body(prompt), config());
    assert.equal(fieldClasses(calls).includes('Other'), fallback);
    assert.ok(fieldClasses(calls).includes('Asset'));
  }
});

test('structured intent excludes UI fields without trimming business text after 6000 bytes', async () => {
  const { globals: h } = harness([{ name: 'Asset' }, { name: 'Scaffold', description: 'редакторе' }]);
  const result = await h.buildAssistantMcpContext('session', {
    ...body('Позиция в редакторе: 1\nОписание результата и алгоритма: scaffold'),
    assistantContextIntent: { context: 'business context', blocks: [{
      name: 'UI title', resultKind: 'sourceCards', uses: ['b2'],
      description: `${'x'.repeat(7000)}; класс "Asset"`, entities: 'equipment',
      algorithm: 'read attributes', expectedResult: 'complete rows'
    }] }
  }, config());
  const terms = result.diagnostics.intentTerms.join(' ');
  assert.doesNotMatch(terms, /редакторе|scaffold|title|sourcecards|b2/);
  assert.match(terms, /business/);
  assert.deepEqual(plain(result.diagnostics.confirmedClassNames), ['Asset']);
  assert.match(terms, /equipment|attributes|complete/);
});

test('user-authored scaffold-like text is untouched in generic and structured input', async () => {
  const { globals: h } = harness();
  const text = 'Позиция в редакторе: 1\nОписание результата и алгоритма: business\nНазвание результата: user-authored';
  const expected = plain(h.assistantSearchTermsFromText(text));
  for (const input of [{ prompt: text, mcpContextScope: 'objectFlow' }, { ...body('ignored'), assistantContextIntent: { blocks: [{ description: text }] } }]) {
    const result = await h.buildAssistantMcpContext('session', input, config());
    assert.deepEqual(plain(result.diagnostics.intentTerms), expected);
  }
});

test('unquoted Cyrillic descriptions with slash and backslash bind exactly without plural inference', async () => {
  for (const separator of ['/', '\\']) {
    const description = `Сервис${separator}компонент`;
    const { globals: h, calls } = harness([
      { name: 'Asset', description }, { name: 'Other', description: 'matching helper' }
    ]);
    const result = await h.buildAssistantMcpContext('session', {
      ...body('ignored'), assistantContextIntent: { blocks: [{ description: `возьми все карточки класса ${description}; matching` }] }
    }, config());
    assert.deepEqual(plain(result.diagnostics.classMentions), [description.toLowerCase()]);
    assert.deepEqual(plain(result.diagnostics.confirmedClassNames), ['Asset']);
    assert.deepEqual(fieldClasses(calls), ['Asset']);
  }
  const { globals: h, calls } = harness([
    { name: 'First', description: 'системы A' }, { name: 'Second', description: 'системы B' }
  ]);
  const result = await h.buildAssistantMcpContext('session', {
    ...body('ignored'), assistantContextIntent: { blocks: [{ description: 'список систем; системы' }] }
  }, config());
  assert.deepEqual(plain(result.diagnostics.confirmedClassNames), []);
  assert.equal(fieldClasses(calls).length, 2);
});

test('tool allowlist, denied fields and class-count limits remain enforced', async () => {
  const classes = [{ name: 'Asset' }, { name: 'Owner' }];
  const { globals: h, calls } = harness(classes, { Asset: new Error('permission denied') });
  const limited = config();
  limited.mcp.maxClasses = 1;
  const result = await h.buildAssistantMcpContext('session', body('класс "Asset"; класс "Owner"'), limited);
  assert.deepEqual(fieldClasses(calls), ['Asset']);
  assert.match(result.diagnostics.classFields[0].error, /permission denied/);
  assert.ok(result.diagnostics.limits.some((limit) => limit.limitName === 'maxClasses'));
  const disabled = config();
  disabled.mcp.allowedTools = ['cmdbuild_model_summary'];
  calls.length = 0;
  await h.buildAssistantMcpContext('session', body('класс "Asset"'), disabled);
  assert.deepEqual(calls, []);
});

test('unquoted class descriptions bind independently across block and line boundaries', async () => {
  const { globals: h, calls } = harness([
    { name: 'Asset', description: 'Сервис\\компонент' }, { name: 'Owner', description: 'Ответственный/владелец' }
  ]);
  const result = await h.buildAssistantMcpContext('session', {
    ...body('ignored'), assistantContextIntent: { blocks: [
      { description: 'возьми все карточки класса Сервис\\компонент', algorithm: 'read attributes' },
      { description: 'возьми все карточки класса Ответственный/владелец', expectedResult: 'complete rows' }
    ] }
  }, config());
  assert.deepEqual(plain(result.diagnostics.classMentions), ['сервис\\компонент', 'ответственный/владелец']);
  assert.deepEqual(plain(result.diagnostics.confirmedClassNames), ['Asset', 'Owner']);
  assert.deepEqual(fieldClasses(calls), ['Asset', 'Owner']);
});

test('one explicit block cannot prune discovery for another block without an exact class mention', async () => {
  const { globals: h, calls } = harness([
    { name: 'Asset' }, { name: 'Server', description: 'серверов' }, { name: 'ServerAlternative', description: 'серверов' }
  ]);
  const result = await h.buildAssistantMcpContext('session', {
    ...body('ignored'), assistantContextIntent: { blocks: [
      { description: 'Карточки класса Asset.' }, { description: 'список серверов' }
    ] }
  }, config());
  assert.deepEqual(plain(result.diagnostics.confirmedClassNames), ['Asset']);
  assert.ok(fieldClasses(calls).includes('Server'));
  assert.ok(fieldClasses(calls).includes('ServerAlternative'));
});

test('exact additional classes in scenario context remain available despite complete explicit block bindings', async () => {
  const { globals: h, calls } = harness([{ name: 'Asset' }, { name: 'ContextClass' }]);
  await h.buildAssistantMcpContext('session', {
    ...body('ignored'), assistantContextIntent: { context: 'ContextClass', blocks: [{ description: 'класс Asset.' }] }
  }, config());
  assert.deepEqual(fieldClasses(calls), ['Asset', 'ContextClass']);
});

test('explicit class candidates beyond the first 40 generic terms retain field metadata consumers', async () => {
  const { globals: h } = harness([{ name: 'Asset' }, { name: 'Later' }]);
  const result = await h.buildAssistantMcpContext('session', {
    ...body('ignored'), assistantContextIntent: { blocks: [
      { description: `класс Asset; ${Array.from({ length: 60 }, (_, index) => `padding${index}`).join(' ')}` },
      { description: 'класс Later.' }
    ] }
  }, config());
  assert.equal(result.diagnostics.intentTerms.includes('later'), false);
  assert.ok(result.diagnostics.candidateClasses.some((item) => item.name === 'Later'));
});

test('relevance pruning is object-flow scoped and preserves explicitly requested context classes', async () => {
  const classes = [{ name: 'Asset' }, { name: 'Other', description: 'matching helper' }, { name: 'Requested' }];
  const { globals: h, calls } = harness(classes);
  await h.buildAssistantMcpContext('session', { prompt: 'класс "Asset"; matching' }, config());
  assert.ok(fieldClasses(calls).includes('Other'));
  calls.length = 0;
  await h.buildAssistantMcpContext('session', {
    ...body('класс "Asset"; matching'), assistantContextClassNames: ['Requested']
  }, config());
  assert.deepEqual(fieldClasses(calls), ['Requested', 'Asset']);
});

test('semantic reference metadata reports selection counts and serialization sizes without mutating context', async () => {
  const { globals: h } = harness([{ name: 'Asset' }, { name: 'Other', description: 'matching helper' }], {
    Asset: [{ name: 'Description', help: '<p>A &amp; B</p>' }]
  });
  const context = await h.buildAssistantMcpContext('session', body('класс "Asset"; matching'), config());
  const original = plain(context);
  const reference = JSON.parse(h.assistantObjectFlowSemanticMessages({}, {}, context, config()).at(-2).content).mcpContext;
  assert.equal(reference.contextAssembly.beforeClasses, 2);
  assert.equal(reference.contextAssembly.afterClasses, 1);
  assert.deepEqual(reference.contextAssembly.classNames, ['Asset']);
  assert.equal(reference.contextAssembly.beforeBytes, Buffer.byteLength(JSON.stringify(context.text)));
  assert.equal(reference.contextAssembly.afterBytes, Buffer.byteLength(JSON.stringify(reference.data)));
  assert.ok(reference.contextAssembly.afterBytes < reference.contextAssembly.beforeBytes);
  assert.equal(reference.data.classFields[0].attributes[0].help, 'A & B');
  assert.match(context.text, /<p>/);
  assert.deepEqual(plain(context.diagnostics.contextAssembly), reference.contextAssembly);
  assert.deepEqual(plain(context), original);
});

test('semantic default delegates IPv4 predicates to deterministic compilation', () => {
  const start = source.indexOf('const DEFAULT_ASSISTANT_OBJECT_FLOW_SEMANTIC_PROMPT =');
  assert.ok(start >= 0);
  const end = source.indexOf("].join('\\n\\n');", start);
  const semanticDefault = source.slice(start, end);
  assert.match(semanticDefault, /детерминированный Object Flow compiler/);
  assert.match(semanticDefault, /Правила о заполнении predicates выше к IPv4 не применяются/);
  assert.doesNotMatch(semanticDefault, /Если IP-поля карточек outputClass сравниваются.*используй attributePredicate/);
});

test('relation requirements preserve inferred anchor hops and order confirmed upstream dependencies first', () => {
  const { globals: h } = harness();
  const hop = (sourceClass, targetClass) => ({ sourceClass, targetClass, domain: `${sourceClass}To${targetClass}`, direction: 'source' });
  const anchor = hop('Anchor', 'Range');
  const terminal = hop('Range', 'Target');
  const full = { kind: 'relationRequirements', chains: [{ operations: [anchor, terminal] }] };
  assert.deepEqual(plain(h.assistantRelationRequirementsWithDependencyPaths(full, [{ dependencyPaths: [terminal] }])), full);
  const partial = { kind: 'relationRequirements', chains: [{ operations: [terminal] }] };
  const result = h.assistantRelationRequirementsWithDependencyPaths(partial, [{ dependencyPaths: [anchor, terminal] }]);
  assert.deepEqual(plain(result.chains), [{ operations: [anchor] }, { operations: [terminal] }]);
  assert.deepEqual(partial.chains, [{ operations: [terminal] }]);
  const cycle = { kind: 'relationRequirements', chains: [
    { operations: [hop('First', 'Second')] }, { operations: [hop('Second', 'First')] }
  ] };
  assert.deepEqual(plain(h.assistantRelationRequirementsWithDependencyPaths(cycle, [])), cycle);
});
