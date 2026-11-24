import { createHash } from 'node:crypto';
import { normalizeLargeTablePresentation } from './report-table-pages.mjs';

const FORMAT = 'cmdbdynamicpages.template';
const TEMPLATE_KEYS = ['code', 'description', 'spec', 'paramsSchema', 'resultSchema'];
const SPEC_KEYS = ['version', 'kind', 'protected', 'params', 'steps', 'objectFlow', 'visualModel', 'visualModels', 'result', 'authoring', 'cache', 'publish', 'endpoint', 'cmdbBuildView', 'defaults', 'paramDefaults', 'classNameFallback'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CHECKPOINT_TRANSIENT = ['proposalId', 'deterministicSpecHash', 'source', 'sourceSignature', 'signature', 'resumeId', 'resume', 'expiresAt'];
const CONFIG_KEYS = new Set(['runtime', 'runtimeConfig', 'credentials', 'llm', 'mcp', 'apiKey', 'authorization', 'headers', 'accessToken', 'password']);

function fail(message) {
  const error = new Error(message);
  error.code = 'template_transfer_invalid';
  throw error;
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Expected object at ${path}.`);
}

function keys(value, allowed, path, required = allowed) {
  object(value, path);
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    fail(`Unexpected or missing fields at ${path}.`);
  }
}

function child(path, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

// Only JSON data is accepted. HTTP/file byte budgets remain the caller's responsibility.
function cloneJson(input) {
  const ancestors = new Set();
  const root = { value: undefined };
  const stack = [{ value: input, parent: root, key: 'value' }];
  while (stack.length) {
    const task = stack.pop();
    const { value, parent, key } = task;
    if (task.exit) { ancestors.delete(value); continue; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      parent[key] = value;
      continue;
    }
    if (typeof value !== 'object' || !value) fail('Only finite JSON data is supported.');
    if (ancestors.has(value)) fail('Circular JSON input.');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Non-JSON object prototype.');
    ancestors.add(value);
    const result = array ? [] : {};
    parent[key] = result;
    const ownKeys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
    if (array && ownKeys.length !== value.length) fail('Sparse or extended JSON array.');
    stack.push({ value, exit: true });
    for (const key of ownKeys.reverse()) {
      if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) fail('Unsafe JSON key.');
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) fail('Extended JSON array.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Non-data JSON property.');
      stack.push({ value: descriptor.value, parent: result, key });
    }
  }
  return root.value;
}

function canonical(value) {
  const output = [];
  const stack = [{ value }];
  while (stack.length) {
    const task = stack.pop();
    if (Object.hasOwn(task, 'text')) { output.push(task.text); continue; }
    const item = task.value;
    if (!item || typeof item !== 'object') { output.push(JSON.stringify(item)); continue; }
    const array = Array.isArray(item);
    const names = array ? Object.keys(item) : Object.keys(item).sort();
    output.push(array ? '[' : '{');
    stack.push({ text: array ? ']' : '}' });
    for (let index = names.length - 1; index >= 0; index--) {
      if (index < names.length - 1) stack.push({ text: ',' });
      stack.push({ value: item[names[index]] });
      if (!array) stack.push({ text: `${JSON.stringify(names[index])}:` });
    }
  }
  return output.join('');
}

function checksum(payload) {
  return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
}

export function templateTransferTargetRevision(root, card) {
  return checksum([root, ...['_id', 'Code', 'Description', 'Active', 'Owner', 'UpdatedAt',
    'SpecJson', 'ParamsSchemaJson', 'ResultSchemaJson'].map((key) => card[key] ?? null)]);
}

export function templateTransferReferenceEntries(reference) {
  const { path, value } = reference;
  return Array.isArray(value)
    ? value.map((item, index) => ({ ...reference, path: `${path}[${index}]`, value: item }))
    : [reference];
}

export function isTemplateTransferReferenceId(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value));
}

function portableSpec(spec) {
  keys(spec, SPEC_KEYS, '$.template.spec', ['version']);
  if (spec.version !== 1) fail('Unsupported template DSL version.');
  if (spec.protected !== undefined && typeof spec.protected !== 'boolean') fail('Invalid protected template flag.');
  if (spec.protected === true) fail('Protected templates are not portable.');
  const authoring = spec.authoring;
  if (authoring !== undefined) {
    keys(authoring, ['version', 'assistant', 'd2'], '$.template.spec.authoring', []);
    if (authoring.assistant !== undefined) {
      keys(authoring.assistant, ['objectFlowIntent', 'promptContractVersion', 'diagramIntentPrompt', 'systemPromptOverrides'], '$.template.spec.authoring.assistant', []);
    }
    if (authoring.d2 !== undefined) {
      const d2 = authoring.d2;
      keys(d2, ['source', 'sourceHash', 'analysisCheckpoint', 'assistantCheckpoint'], '$.template.spec.authoring.d2', []);
      delete d2.sourceHash;
      for (const name of ['analysisCheckpoint', 'assistantCheckpoint']) {
        if (d2[name] === undefined || d2[name] === null) continue;
        object(d2[name], `$.template.spec.authoring.d2.${name}`);
        // Strip trust wrappers here only, never inside reviewed roles, rules or mapping literals.
        for (const key of CHECKPOINT_TRANSIENT) delete d2[name][key];
      }
    }
  }
  function checkConfig(value, path) {
    if (!value || typeof value !== 'object') return;
    if (Object.keys(value).some((key) => CONFIG_KEYS.has(key))) fail(`Runtime configuration is not portable at ${path}.`);
  }
  if (Array.isArray(spec.steps)) spec.steps.forEach((step, index) => checkConfig(step, `$.template.spec.steps[${index}]`));
  for (const name of ['analysisCheckpoint', 'assistantCheckpoint']) checkConfig(authoring?.d2?.[name], `$.template.spec.authoring.d2.${name}`);
  for (const diagram of Array.isArray(spec.result?.diagrams) ? spec.result.diagrams : []) {
    const imported = diagram?.authoring?.d2Import;
    if (imported === undefined) continue;
    object(imported, '$.template.spec.result.diagrams[].authoring.d2Import');
    for (const key of ['mappingValidation', 'proposalId', 'importedAt', 'signature', 'sourceSignature', 'resumeId', 'resume']) delete imported[key];
  }
  return spec;
}

function portableTemplate(input, strict = false) {
  const template = cloneJson(input);
  object(template, '$.template');
  if (strict) keys(template, TEMPLATE_KEYS, '$.template');
  const original = strict ? canonical(template) : '';
  const result = {};
  for (const key of TEMPLATE_KEYS) {
    result[key] = Object.hasOwn(template, key) ? template[key] : key === 'description' ? '' : {};
  }
  if (typeof result.code !== 'string' || result.code.length > 256) fail('Invalid template code.');
  if (typeof result.description !== 'string') fail('Invalid template description.');
  if (result.paramsSchema !== null) object(result.paramsSchema, '$.template.paramsSchema');
  if (result.resultSchema !== null) object(result.resultSchema, '$.template.resultSchema');
  portableSpec(result.spec);
  if (strict && original !== canonical(result)) fail('Non-portable trust or transient fields.');
  return result;
}

export function templateTransferTableSelectorBindings(spec) {
  const tables = Array.isArray(spec.result?.tables) ? spec.result.tables : [];
  return tables.flatMap((table, index) => {
    const config = normalizeLargeTablePresentation(table?.presentation?.largeTable);
    if (config?.mode !== 'key') return [];
    const { kind, source, idField, labelField, matchField } = config.selector;
    const path = `$.spec.result.tables[${index}].presentation.largeTable.selector`;
    const options = kind === 'class' ? { className: source } : { alias: source };
    return [{ path, kind, source, fields: [
      { ...options, field: idField, path: `${path}.idField` },
      { ...options, field: labelField, path: `${path}.labelField` },
      { alias: table.name, field: matchField, path: `${path}.matchField` }
    ] }];
  });
}

// Resolve simple projections in the portable manifest. Target validation checks
// the full raw DSL with the destination catalog instead of trusting this hint.
function selectorFieldOrigin(steps, alias, field) {
  const seen = new Set();
  while (steps.has(alias) && !seen.has(alias)) {
    seen.add(alias);
    const step = steps.get(alias);
    if (['selectCards', 'expandRelations', 'enrichRows'].includes(step.type)) {
      const columns = step.columns || (step.type === 'enrichRows' ? step.fields : step.cardColumns || step.outputColumns);
      const projected = Array.isArray(columns) && columns.find((item) => {
        if (typeof item === 'string') return item.trim() === field;
        const path = item?.path || item?.field || item?.column || item?.name || '';
        return typeof item === 'object' && item && String(item.as || item.name || item.label || path).trim() === field;
      });
      if (projected && typeof projected === 'object') field = String(projected.path || projected.field || projected.column || projected.name || '').trim();
      if (step.type !== 'enrichRows') {
        const className = step.type === 'selectCards' ? step.className : step.targetClass;
        if (!className || !field || step.from && field.startsWith(step.sourcePrefix ?? 'Source_') ||
          step.type === 'expandRelations' && /^(Source(Class|Id|Code|Description)|Related(Class|Id|ReadStatus)|Domain|Relation(Id|Direction|SourceSide))$/.test(field)) return null;
        return { className, field };
      }
    } else if (!['filterRows', 'semiJoinRows', 'intersectRows', 'differenceRows'].includes(step.type)) return null;
    alias = step.from;
  }
  return null;
}

function manifest(input) {
  const spec = cloneJson(input);
  object(spec, '$.spec');
  const result = { classes: [], directFields: [], domains: [], environmentReferences: [], inspection: [] };
  const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const aliases = new Map();
  const stagePaths = new Set();
  for (const name of ['steps']) if (spec[name] !== undefined && !Array.isArray(spec[name])) fail(`Expected array at $.spec.${name}.`);
  const flows = [{ flow: spec.objectFlow, path: '$.spec.objectFlow' }];
  const models = Array.isArray(spec.visualModels) ? spec.visualModels.map((flow, index) => ({ flow, path: `$.spec.visualModels[${index}]` })) : [];
  models.push({ flow: spec.visualModel, path: '$.spec.visualModel' });
  for (const model of models) {
    if (['objectGroup', 'objectMatching'].includes(model.flow?.mode)) flows.push(model);
    if (model.flow?.objectFlow) flows.push({ flow: model.flow.objectFlow, path: `${model.path}.objectFlow` });
  }
  const collectStages = (nodes, path) => {
    if (nodes === undefined) return;
    if (!Array.isArray(nodes)) fail(`Expected array at ${path}.`);
    nodes.forEach((node, index) => {
      stagePaths.add(`${path}[${index}]`);
      if (node && (node.as || node.alias) && (node.className || node.targetClass)) aliases.set(node.as || node.alias, node.className || node.targetClass);
    });
  };
  collectStages(spec.steps, '$.spec.steps');
  for (const { flow, path } of flows) {
    for (const name of ['selections', 'operations']) collectStages(flow?.[name], `${path}.${name}`);
  }
  const stack = [{ value: spec, path: '$.spec', context: {} }];
  const directField = (name) => namePattern.test(name) && !/^_|^(Source|Related)(Id|Class|Description|Code)$|^Class$/.test(name);
  while (stack.length) {
    const { value, path, context } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => stack.push({ value: item, path: `${path}[${index}]`, context }));
      continue;
    }
    const className = value.className || value.targetClass || aliases.get(value.from) || context.className;
    const rightClassName = aliases.get(value.with) || context.rightClassName;
    const stage = stagePaths.has(path);
    const direct = stage ? Boolean(value.className || value.targetClass) && ['selectCards', 'select', 'expandRelations', 'relation', 'existsRelated', 'existsRelatedRows', undefined].includes(value.type) : context.direct;
    const lookupType = value.lookupType || context.lookupType;
    for (const [key, item] of Object.entries(value)) {
      const location = child(path, key);
      if (['source', 'sourceText', 'systemPromptOverrides', 'objectFlowIntent', 'diagramIntentPrompt', 'description', 'explanation', 'notes', 'labelTemplate', 'regex', 'regexExpression', 'valueExpression', 'rightExpression'].includes(key)) continue;
      if (['className', 'sourceClass', 'targetClass', 'fromClass', 'withClass', 'classNameFallback'].includes(key) && typeof item === 'string') {
        result.classes.push({ name: item, path: location });
      }
      if (['domain', 'domainName', 'domainCode'].includes(key) && typeof item === 'string') result.domains.push({ name: item, path: location });
      if (['attribute', 'field', 'path', 'column', 'leftColumn', 'rightColumn'].includes(key) && typeof item === 'string') {
        const owner = ['leftColumn', 'rightColumn'].includes(key) ? undefined : className;
        if (direct && owner && directField(item)) result.directFields.push({ className: owner, field: item, path: location });
        else result.inspection.push({ path: location, reason: 'Field class or direct-field provenance requires inspection.' });
      }
      if (['columns', 'attributes'].includes(key) && Array.isArray(item)) {
        item.forEach((column, index) => {
          if (typeof column !== 'string') return;
          if (direct && className && directField(column)) result.directFields.push({ className, field: column, path: `${location}[${index}]` });
          else result.inspection.push({ path: `${location}[${index}]`, reason: 'Column provenance requires inspection.' });
        });
      }
      if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
        result.environmentReferences.push({ kind: 'url', value: item, path: location });
      }
      const typedLiteral = ['default', 'defaultValue', 'value', 'values', 'const'].includes(key);
      if (['cardId', 'lookupId'].includes(key) || typedLiteral) {
        const kind = key === 'lookupId' || value.type === 'lookup' || value.referenceType === 'lookup' ? 'lookup'
          : key === 'cardId' || ['card', 'reference'].includes(value.type) || value.referenceType === 'card' ? 'card' : '';
        const target = kind === 'lookup' ? lookupType : value.targetClass || value.targetType || value.className || (key === 'cardId' ? className : undefined);
        for (const entry of templateTransferReferenceEntries({ path: location, value: item })) {
          if (!isTemplateTransferReferenceId(entry.value)) continue;
          if (kind && target) {
            result.environmentReferences.push({ ...entry, kind, [kind === 'lookup' ? 'lookupType' : 'className']: target });
          } else if (kind || ['default', 'value', 'const'].includes(key) && !Array.isArray(item)) {
            result.inspection.push({ path: entry.path, reason: 'Literal reference type/target requires schema inspection.' });
          }
        }
      }
      // Prompts, D2 text and business literals are not parsed or rewritten.
      if (!['default', 'defaultValue', 'value', 'values', 'const', 'enum'].includes(key)) {
        stack.push({ value: item, path: location, context: { className: key === 'right' ? rightClassName : className, rightClassName, lookupType, direct: ['left', 'right'].includes(key) ? false : direct } });
      }
    }
  }
  const selectors = templateTransferTableSelectorBindings(spec);
  if (selectors.length) {
    const steps = new Map((spec.steps || []).filter(Boolean).map((step) => [step.as, step]));
    for (const selector of selectors) {
      if (selector.kind === 'class') result.classes.push({ name: selector.source, path: `${selector.path}.source` });
      else if (!steps.has(selector.source)) result.inspection.push({ path: `${selector.path}.source`, reason: 'Selector result is not available in source steps.' });
      for (const binding of selector.fields) {
        const origin = binding.className ? { className: binding.className, field: binding.field }
          : selectorFieldOrigin(steps, binding.alias, binding.field);
        if (origin) result.directFields.push({ ...origin, path: binding.path });
        else result.inspection.push({ path: binding.path, reason: 'Selector field provenance requires target inspection.' });
      }
    }
  }
  for (const entries of Object.values(result)) entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return result;
}

/** Dependency paths are rooted at $.spec; unresolved provenance is explicit. */
export function templateTransferDependencies(spec) {
  return manifest(spec);
}

export function templateTransferEnvironmentReferences(spec) {
  return manifest(spec).environmentReferences;
}

/** Serialize the returned object as a single <code>.cmdp-template.json file. */
export function createTemplateTransferPackage(template, { producerVersion } = {}) {
  if (typeof producerVersion !== 'string' || !producerVersion.trim() || producerVersion.length > 128) fail('Invalid producerVersion.');
  const portable = portableTemplate(template);
  const payload = { format: FORMAT, formatVersion: 1, producerVersion, template: portable, dependencies: manifest(portable.spec) };
  return { ...payload, checksum: checksum(payload) };
}

/** Accept parsed JSON or JSON text; return authoring data, never a trusted target attestation. */
export function readTemplateTransferPackage(input) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { fail('Invalid transfer JSON.'); }
  }
  const pkg = cloneJson(parsed);
  keys(pkg, ['format', 'formatVersion', 'producerVersion', 'template', 'dependencies', 'checksum'], '$');
  if (pkg.format !== FORMAT || pkg.formatVersion !== 1) fail('Unsupported template transfer format/version.');
  if (typeof pkg.producerVersion !== 'string' || !pkg.producerVersion.trim() || pkg.producerVersion.length > 128) fail('Invalid producerVersion.');
  const { checksum: supplied, ...payload } = pkg;
  if (typeof supplied !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(supplied) || checksum(payload) !== supplied) fail('Template transfer checksum mismatch.');
  const template = portableTemplate(pkg.template, true);
  if (canonical(pkg.dependencies) !== canonical(manifest(template.spec))) fail('Dependency manifest mismatch.');
  return template;
}

/** Explicit complete reference mappings only; never rename graph IDs or rewrite string fragments. */
export function applyTemplateTransferOverrides(input, inputOverrides = {}) {
  const template = portableTemplate(input);
  const overrides = cloneJson(Array.isArray(inputOverrides) ? { references: inputOverrides } : inputOverrides);
  keys(overrides, ['code', 'description', 'references'], '$.overrides', []);
  for (const key of ['code', 'description']) if (Object.hasOwn(overrides, key)) template[key] = overrides[key];
  if (Object.hasOwn(overrides, 'references')) {
    if (!Array.isArray(overrides.references)) fail('Reference overrides must be an array.');
    if (!overrides.references.length) return portableTemplate(template, true);
    const references = manifest(template.spec).environmentReferences;
    const byPath = new Map();
    for (const override of overrides.references) {
      keys(override, ['path', 'value'], '$.overrides.references[]');
      if (typeof override.path !== 'string' || byPath.has(override.path)) fail('Invalid or duplicate override path.');
      byPath.set(override.path, override.value);
    }
    if (byPath.size !== references.length || references.some((ref) => !byPath.has(ref.path))) fail('Incomplete or unknown reference mapping.');
    const replacements = new Map();
    for (const ref of references) {
      const value = byPath.get(ref.path);
      if (ref.kind === 'url' ? typeof value !== 'string' || !/^https?:\/\//i.test(value)
        : !isTemplateTransferReferenceId(value)) fail('Invalid reference override value.');
      replacements.set(ref.path, value);
    }
    const pending = [{ value: template.spec, path: '$.spec' }];
    while (pending.length) {
      const { value, path } = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const key of Object.keys(value)) {
        const location = Array.isArray(value) ? `${path}[${key}]` : child(path, key);
        if (replacements.has(location)) value[key] = replacements.get(location);
        else pending.push({ value: value[key], path: location });
      }
    }
  }
  return portableTemplate(template, true);
}
