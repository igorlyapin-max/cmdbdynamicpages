import { createHash } from 'node:crypto';

const unique = (values) => [...new Set(values.filter(Boolean))];
const readable = (item) => item && item.active !== false && item.permissions?._can_read !== false;
const normalize = (value) => String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function assistantFieldContextWarnings(model) {
  const diagnostics = model?.fieldContextDiagnostics;
  if (!diagnostics?.truncated) return [];
  return ['Каталог полей Assistant ограничен настроенными лимитами. Отсутствие пути в переданном контексте не доказывает отсутствие связи в CMDB; неподтвержденные условия должны оставаться неразрешенными.'];
}

export function compactAssistantDataModel(model, { terminalOnly = false } = {}) {
  if (!model) return model;
  return {
    ...model,
    stages: (model.stages || []).filter((stage) => !terminalOnly || stage.stageRole === 'terminal')
      .map(({ lineageAliases, lineageLabels, rules, columns, typedFields, ...stage }) => stage)
  };
}

export function compactAssistantBusinessManifest(manifest) {
  if (!manifest) return manifest;
  return { ...manifest, blocks: (manifest.blocks || []).map(({ typedFields, terminalContract, helperStageIds, ...block }) => block) };
}

/** Catalog-backed authoring fields; never samples rows or infers business values. */
export function buildAssistantFieldContext(stages, catalog = {}, options = {}) {
  const requestedDepth = Number(options.depth ?? 1);
  const depth = Number.isFinite(requestedDepth) ? Math.max(0, Math.min(5, Math.trunc(requestedDepth))) : 1;
  const maxBytes = Math.max(1, Math.trunc(Number(options.maxBytes) || 200000));
  const maxStates = Math.max(1, Math.min(50000, Math.trunc(Number(options.maxStates) || 5000)));
  const classes = new Map((catalog.classes || []).filter(readable).map((item) => [item.name, item]));
  const domains = (catalog.domains || []).filter(readable);
  const query = normalize((options.queries || []).join('\n'));
  const mentions = (value) => {
    const term = normalize(value);
    return term.length > 2 && (' ' + query + ' ').includes(' ' + term + ' ');
  };
  const diagnostics = { depth, maxBytes, maxStates, scannedStates: 0, returnedFields: 0, bytes: 0, truncated: false, missingClasses: [] };
  const cache = new Map(), fieldCatalog = new Map();
  const sourceClasses = unique((stages || []).flatMap((stage) => stage.cardSources?.length ? stage.cardSources.map((source) => source.className) : [stage.className]));
  const classBudget = Math.max(1, Math.floor(maxBytes / Math.max(1, sourceClasses.length)));
  diagnostics.perClassByteBudget = classBudget;
  const traversable = new Set((stages || []).flatMap((stage) => [stage.className, ...(stage.cardSources || []).map((source) => source.className)]).filter(Boolean));
  for (const item of classes.values()) if (!["class", "superclass"].includes(String(item.name).toLowerCase())
    && [item.name, item.description].some(mentions)) traversable.add(item.name);
  const inherits = (name, endpoint) => {
    const seen = new Set();
    for (let current = name; current && !seen.has(current); current = classes.get(current)?.parent) {
      if (current === endpoint) return true;
      seen.add(current);
    }
    return false;
  };
  const endpoints = (domain, side) => unique([domain[side], ...(domain[`${side}s`] || [])].map((item) => typeof item === 'string' ? item : item?.name));
  const allows = (domain, side, name) => !(domain[`disabled${side[0].toUpperCase()}${side.slice(1)}Descendants`] || []).includes(name)
    && endpoints(domain, side).some((endpoint) => inherits(name, endpoint));
  const attributes = (name) => {
    const chain = [], seen = new Set(), result = new Map();
    for (let current = name; current && !seen.has(current); current = classes.get(current)?.parent) {
      seen.add(current);
      chain.unshift(classes.get(current));
    }
    for (const owner of chain.filter(Boolean)) for (const attribute of owner.attributes || []) {
      if (readable(attribute)) result.set(attribute.name, attribute);
      else result.delete(attribute.name);
    }
    return [...result.values()];
  };
  const generic = (name) => /^(?:(?:source|endpoint)_)*(?:_?id|class|description|code|name|notes)$/i.test(name);
  const relevant = (attribute, owner, prefix) => !query || !prefix && generic(attribute.name)
    || mentions(prefix + attribute.name)
    || !generic(attribute.name) && [attribute.name, attribute.description]
      .some(mentions);
  const attributeOwners = new Map();
  if (query) for (const owner of classes.values()) for (const attribute of attributes(owner.name)) {
    if (generic(attribute.name) || !relevant(attribute, owner, '.')) continue;
    const owners = attributeOwners.get(attribute.name) || new Set();
    owners.add(owner.name);
    attributeOwners.set(attribute.name, owners);
  }
  // An attribute shared by many unrelated classes is not a reason to expand
  // all their superclass-domain paths into this task's context.
  for (const owners of attributeOwners.values()) if (owners.size === 1) traversable.add([...owners][0]);
  const discover = (root) => {
    if (cache.has(root)) return cache.get(root);
    const fields = [], queue = [{ name: root, prefix: '', hops: [] }];
    const queuedPaths = new Set([JSON.stringify([root, '', []])]);
    let discoveredBytes = 0;
    const shortestFields = new Map();
    let cursor = 0;
    while (cursor < queue.length && diagnostics.scannedStates < maxStates) {
      const state = queue[cursor++], owner = classes.get(state.name);
      diagnostics.scannedStates++;
      if (!owner) { diagnostics.missingClasses.push(state.name); continue; }
      for (const attribute of attributes(owner.name)) {
        if (!attribute.name || !relevant(attribute, owner, state.prefix)) continue;
        const fieldKey = owner.name + ':' + attribute.name;
        const exactPath = mentions(state.prefix + attribute.name);
        if (!exactPath && shortestFields.has(fieldKey) && shortestFields.get(fieldKey) < state.hops.length) continue;
        if (!shortestFields.has(fieldKey)) shortestFields.set(fieldKey, state.hops.length);
        const field = {
          path: state.prefix + attribute.name, className: owner.name, attribute: attribute.name,
          description: String(attribute.description || ''), type: String(attribute.type || ''),
          ...(attribute.help ? { help: String(attribute.help) } : {}),
          cardinality: state.hops.some((hop) => hop.many) ? 'many' : 'one',
          hops: state.hops.map(({ many, ...hop }) => hop), evidence: 'readableCatalog'
        };
        discoveredBytes += Buffer.byteLength(JSON.stringify(field));
        if (discoveredBytes > classBudget) { diagnostics.truncated = true; cursor = queue.length; break; }
        fields.push(field);
      }
      if (discoveredBytes > classBudget) break;
      if (state.hops.length >= depth) continue;
      const enqueue = (name, prefix, hop) => {
        if (!classes.has(name)) return;
        const hops = state.hops.concat(hop);
        const pathKey = JSON.stringify([name, prefix, hops]);
        if (queuedPaths.has(pathKey)) return;
        // Revisited classes are distinct paths, bounded by depth and state caps.
        if (queue.length >= maxStates) { diagnostics.truncated = true; return; }
        queuedPaths.add(pathKey);
        queue.push({ name, prefix, hops });
      };
      for (const attribute of attributes(owner.name)) {
        const target = attribute.targetClass || attribute.targetType;
        if (!target || !['reference', 'foreignkey'].includes(String(attribute.type || '').toLowerCase())) continue;
        traversable.add(target);
        enqueue(target, state.prefix + attribute.name + '.', {
          kind: 'reference', name: attribute.name, sourceClass: owner.name, targetClass: target,
          domain: String(attribute.domain || ''), direction: String(attribute.direction || 'direct'), many: false
        });
      }
      for (const domain of domains) for (const [side, opposite, direction] of [['source', 'destination', 'direct'], ['destination', 'source', 'inverse']]) {
        if (!allows(domain, side, owner.name)) continue;
        for (const target of classes.keys()) {
          if (!traversable.has(target) || !allows(domain, opposite, target)) continue;
          const multiplicity = String(domain.cardinality || '').split(':')[opposite === 'destination' ? 1 : 0];
          enqueue(target, state.prefix + '{' + domain.name + ':' + target + '}.', {
            kind: 'domain', name: domain.name, sourceClass: owner.name, targetClass: target, direction,
            cardinality: String(domain.cardinality || ''), many: !['1', '0..1'].includes(multiplicity)
          });
        }
      }
    }
    if (cursor < queue.length) diagnostics.truncated = true;
    cache.set(root, fields);
    return fields;
  };
  const modelStages = (stages || []).map((stage) => {
    const sources = stage.cardSources?.length ? stage.cardSources : [{ id: 'current', className: stage.className, classColumn: 'Class', idColumn: '_id' }];
    const fields = [];
    for (const source of sources) {
      if (!source.className) continue;
      for (const field of discover(source.className)) {
        const descriptor = { ...field, cardSourceId: source.id, rootClass: source.className };
        descriptor.id = 'field_' + createHash('sha256').update(JSON.stringify([source.className, field.path, field.hops])).digest('hex').slice(0, 20);
        if (!fieldCatalog.has(descriptor.id)) {
          const { cardSourceId, ...definition } = descriptor;
          const bytes = Buffer.byteLength(JSON.stringify(definition));
          if (diagnostics.bytes + bytes > maxBytes) { diagnostics.truncated = true; break; }
          diagnostics.bytes += bytes;
          diagnostics.returnedFields++;
          fieldCatalog.set(descriptor.id, definition);
        }
        fields.push(descriptor);
      }
    }
    return { id: stage.id, fields, readableFields: unique([...(stage.columns || []), ...fields.filter((f) => f.cardSourceId === 'current').map((f) => f.path)]) };
  });
  diagnostics.missingClasses = unique(diagnostics.missingClasses);
  return { stages: modelStages, fieldCatalog: [...fieldCatalog.values()], diagnostics };
}
