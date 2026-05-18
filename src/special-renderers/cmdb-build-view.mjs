export const CMDB_BUILD_VIEW_KIND = 'cmdbBuildView';
export const DEFAULT_CMDB_BUILD_VIEW_CODE = 'CmdbBuildView';

const SYSTEM_ATTRIBUTE_NAMES = new Set(['Id', 'IdClass', 'IdTenant']);
const ANCHOR_SAFE_RE = /[^A-Za-z0-9_-]+/g;
const ALLOWED_SECTIONS = new Set(['classes', 'domains', 'lookups']);

export function defaultCmdbBuildViewSpec() {
  return {
    version: 1,
    kind: CMDB_BUILD_VIEW_KIND,
    protected: true,
    params: {},
    publish: { mode: 'dynamicUser', paramsMode: 'ignore', warningAccepted: false },
    cache: {
      enabled: true,
      scopeMode: 'permissionOnly',
      probeMode: 'usedFieldsOnly',
      shareMode: 'endpoint',
      ttlSeconds: 8 * 60 * 60,
      allowManualRefresh: true
    },
    cmdbBuildView: {
      language: 'auto',
      showSystemAttributes: false,
      sections: ['classes', 'domains', 'lookups'],
      rootClass: '',
      lookupScope: 'used'
    }
  };
}

export function isCmdbBuildViewSpec(spec) {
  return Boolean(spec && spec.kind === CMDB_BUILD_VIEW_KIND);
}

export function normalizeCmdbBuildViewConfig(spec = {}, params = {}) {
  const source = spec.cmdbBuildView && typeof spec.cmdbBuildView === 'object' && !Array.isArray(spec.cmdbBuildView)
    ? spec.cmdbBuildView
    : {};
  const defaultConfig = defaultCmdbBuildViewSpec().cmdbBuildView;
  const sections = Array.isArray(source.sections)
    ? source.sections.filter((section, index, list) => ALLOWED_SECTIONS.has(section) && list.indexOf(section) === index)
    : defaultConfig.sections.slice();
  const language = String(params.lang || params.cmdpLang || source.language || defaultConfig.language || 'auto').trim() || 'auto';
  return {
    language,
    showSystemAttributes: Boolean(source.showSystemAttributes),
    sections: sections.length ? sections : defaultConfig.sections.slice(),
    rootClass: String(params.rootClass || source.rootClass || '').trim(),
    lookupScope: source.lookupScope === 'all' ? 'all' : 'used'
  };
}

export function validateCmdbBuildViewSpec(spec) {
  const errors = [];
  if (!isCmdbBuildViewSpec(spec)) return errors;
  const config = spec.cmdbBuildView;
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
    errors.push({ path: '$.cmdbBuildView', message: 'cmdbBuildView settings must be an object.' });
    return errors;
  }
  const normalized = normalizeCmdbBuildViewConfig(spec, {});
  if (config && Array.isArray(config.sections)) {
    config.sections.forEach((section, index) => {
      if (!ALLOWED_SECTIONS.has(section)) {
        errors.push({ path: `$.cmdbBuildView.sections[${index}]`, message: 'Section must be classes, domains, or lookups.' });
      }
    });
  }
  if (normalized.rootClass && !/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized.rootClass)) {
    errors.push({ path: '$.cmdbBuildView.rootClass', message: 'Root class must be a CMDBuild identifier.' });
  }
  if (config && config.lookupScope !== undefined && !['used', 'all'].includes(config.lookupScope)) {
    errors.push({ path: '$.cmdbBuildView.lookupScope', message: 'lookupScope must be used or all.' });
  }
  return errors;
}

export async function executeCmdbBuildViewSpec(cmdbuildExecRequest, spec, params = {}, options = {}) {
  const limits = options.limits || {};
  const config = normalizeCmdbBuildViewConfig(spec, params);
  const trace = [];
  const startedAt = Date.now();
  const restBefore = cmdbuildExecRequest.getRestCalls ? cmdbuildExecRequest.getRestCalls() : 0;
  const model = await loadCmdbBuildModel(cmdbuildExecRequest, config, limits);
  const html = renderCmdbBuildView(model, config);
  trace.push({
    index: 0,
    type: CMDB_BUILD_VIEW_KIND,
    as: 'cmdbBuildView',
    status: 'ok',
    rows: model.classes.length + model.domains.length + model.lookupTables.length,
    columns: 0,
    truncated: Boolean(model.truncated),
    elapsedMs: Date.now() - startedAt,
    restCalls: (cmdbuildExecRequest.getRestCalls ? cmdbuildExecRequest.getRestCalls() : 0) - restBefore
  });

  return {
    kind: 'html',
    htmlTrusted: true,
    html,
    emptyText: 'В результате вашего запроса объекты не найдены',
    permissionDeniedText: 'Вам не хватает прав увидеть данные или интерфейс дизайнера',
    meta: {
      renderer: CMDB_BUILD_VIEW_KIND,
      classes: model.classes.length,
      domains: model.domains.length,
      lookups: model.lookupTables.length,
      generatedAt: new Date().toISOString()
    },
    limits: {
      ...limits,
      restCalls: cmdbuildExecRequest.getRestCalls ? cmdbuildExecRequest.getRestCalls() : 0
    },
    tables: [],
    trace
  };
}

async function loadCmdbBuildModel(cmdbuildExecRequest, config, limits) {
  const translations = await loadTranslationMap(cmdbuildExecRequest);
  const rawClasses = await readCmdbData(
    cmdbuildExecRequest,
    `/cmdbuild/services/rest/v3/classes?limit=${positiveLimit(limits.maxClasses, 500)}&detailed=true`
  );
  const orderedClasses = sortClassesByInheritance(rawClasses || []);
  const includedNames = includedClassNames(orderedClasses, config.rootClass);
  const classAnchors = {};
  const classLabels = {};
  const lookupIndex = {};
  const classes = [];

  for (const rawClass of orderedClasses) {
    const className = rawClass.name || '';
    if (!className || !includedNames.has(className)) continue;
    classAnchors[className] = makeAnchor('cmdp-build-class', className);
  }

  for (const rawClass of orderedClasses) {
    const className = rawClass.name || '';
    if (!className || !includedNames.has(className)) continue;
    const classItem = normalizeClass(rawClass, translations, classAnchors);
    classLabels[className] = classItem.displayName;
    try {
      const attributes = await loadClassAttributes(cmdbuildExecRequest, className, translations, config.showSystemAttributes);
      classItem.attributes = attributes;
      for (const attribute of attributes) {
        registerLookupUsage(lookupIndex, classItem, attribute);
      }
    } catch (error) {
      classItem.error = errorMessage(error);
    }
    classes.push(classItem);
  }

  const domains = config.sections.includes('domains')
    ? await loadDomains(cmdbuildExecRequest, includedNames, classAnchors, classLabels, translations, config.showSystemAttributes, limits)
    : [];
  attachDomainsToClasses(classes, domains);

  const lookupTables = config.sections.includes('lookups')
    ? await loadLookupTables(cmdbuildExecRequest, lookupIndex, translations, config.lookupScope)
    : [];

  return {
    classes,
    domains,
    lookupTables,
    truncated: rawClasses.length > classes.length && Boolean(config.rootClass)
  };
}

async function readCmdbData(cmdbuildExecRequest, path) {
  const response = await cmdbuildExecRequest(path);
  if (!response.ok) {
    throw new Error(`CMDBuild returned HTTP ${response.statusCode || 0} for ${path}`);
  }
  if (response.json && response.json.success === false) {
    throw new Error(cmdbMessage(response.json) || `CMDBuild rejected ${path}`);
  }
  return Array.isArray(response.json && response.json.data) ? response.json.data : [];
}

async function readCmdbItem(cmdbuildExecRequest, path) {
  const response = await cmdbuildExecRequest(path);
  if (!response.ok) {
    throw new Error(`CMDBuild returned HTTP ${response.statusCode || 0} for ${path}`);
  }
  if (response.json && response.json.success === false) {
    throw new Error(cmdbMessage(response.json) || `CMDBuild rejected ${path}`);
  }
  return response.json && response.json.data ? response.json.data : null;
}

async function tryReadCmdbData(cmdbuildExecRequest, path) {
  try {
    return await readCmdbData(cmdbuildExecRequest, path);
  } catch {
    return [];
  }
}

async function loadTranslationMap(cmdbuildExecRequest) {
  const translations = {};
  const rows = await tryReadCmdbData(cmdbuildExecRequest, '/cmdbuild/services/rest/v3/translations?scope=service&limit=100000');
  for (const item of rows) {
    if (item && item.code && item.value) translations[item.code] = item.value;
  }
  return translations;
}

async function loadClassAttributes(cmdbuildExecRequest, className, translations, showSystemAttributes) {
  const rows = await readCmdbData(
    cmdbuildExecRequest,
    `/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/attributes?scope=service&limit=1000`
  );
  return rows
    .filter((attribute) => showSystemAttributes || !isSystemAttribute(attribute))
    .map((attribute) => normalizeAttribute(attribute, translations, className));
}

async function loadDomains(cmdbuildExecRequest, includedNames, classAnchors, classLabels, translations, showSystemAttributes, limits) {
  const rows = await readCmdbData(
    cmdbuildExecRequest,
    `/cmdbuild/services/rest/v3/domains?limit=${positiveLimit(limits.maxDomains, 500)}`
  );
  const domains = [];
  for (const row of rows) {
    const domainName = row.name || row._id;
    if (!domainName) continue;
    let detail = row;
    try {
      detail = await readCmdbItem(cmdbuildExecRequest, `/cmdbuild/services/rest/v3/domains/${encodeURIComponent(domainName)}`) || row;
    } catch {
      detail = row;
    }
    const sourceNames = detail.sources || (detail.source ? [detail.source] : []);
    const destinationNames = detail.destinations || (detail.destination ? [detail.destination] : []);
    if (![...sourceNames, ...destinationNames].some((name) => includedNames.has(name))) continue;
    let attributes = [];
    let attributesError = '';
    try {
      attributes = (await readCmdbData(cmdbuildExecRequest, `/cmdbuild/services/rest/v3/domains/${encodeURIComponent(domainName)}/attributes?scope=service&limit=1000`))
        .filter((attribute) => showSystemAttributes || !isSystemAttribute(attribute))
        .map((attribute) => normalizeAttribute(attribute, translations, domainName));
    } catch (error) {
      attributesError = errorMessage(error);
    }
    domains.push({
      name: domainName,
      displayName: translatedDescription(detail, translations, [`domain.${domainName}.description`], domainName),
      anchor: makeAnchor('cmdp-build-domain', domainName),
      attributesAnchor: `${makeAnchor('cmdp-build-domain', domainName)}-attributes`,
      sourceNames,
      destinationNames,
      sourceLinks: classLinks(sourceNames, classAnchors, classLabels),
      destinationLinks: classLinks(destinationNames, classAnchors, classLabels),
      cardinality: detail.cardinality || '',
      direct: translatedValue(translations, `domain.${domainName}.descriptionDirect`, `domain.${domainName}.direct`) || detail.descriptionDirect || '',
      inverse: translatedValue(translations, `domain.${domainName}.descriptionInverse`, `domain.${domainName}.inverse`) || detail.descriptionInverse || '',
      active: detail.active,
      attributes,
      attributesError
    });
  }
  domains.sort((left, right) => sortLabel(left.displayName || left.name).localeCompare(sortLabel(right.displayName || right.name)));
  return domains;
}

async function loadLookupTables(cmdbuildExecRequest, lookupIndex, translations, lookupScope) {
  const typeRows = await tryReadCmdbData(cmdbuildExecRequest, '/cmdbuild/services/rest/v3/lookup_types?limit=1000');
  if (lookupScope === 'all') {
    for (const row of typeRows) {
      const lookupName = row.name || row._id;
      if (!lookupName) continue;
      lookupIndex[lookupName] ||= { name: lookupName, anchor: makeAnchor('cmdp-build-lookup', lookupName), usages: [] };
    }
  }
  for (const row of typeRows) {
    const lookupName = row.name || row._id;
    if (!lookupName || !lookupIndex[lookupName]) continue;
    lookupIndex[lookupName].description = row.description || '';
    lookupIndex[lookupName].parent = row.parent || '';
    lookupIndex[lookupName].speciality = row.speciality || '';
  }
  const lookupTables = [];
  for (const lookupName of Object.keys(lookupIndex).sort((left, right) => sortLabel(left).localeCompare(sortLabel(right)))) {
    const lookup = lookupIndex[lookupName];
    let values = [];
    let valuesError = '';
    try {
      values = buildLookupHierarchy(
        await readCmdbData(cmdbuildExecRequest, `/cmdbuild/services/rest/v3/lookup_types/${encodeURIComponent(lookupName)}/values?scope=service&limit=1000`),
        lookupName,
        translations
      );
    } catch (error) {
      valuesError = errorMessage(error);
    }
    lookupTables.push({
      name: lookupName,
      displayName: translatedValue(translations, `lookup.${lookupName}.description`) || lookup.description || lookupName,
      anchor: lookup.anchor,
      parent: lookup.parent || '',
      speciality: lookup.speciality || '',
      usages: lookup.usages || [],
      values,
      valuesError
    });
  }
  return lookupTables;
}

function renderCmdbBuildView(model, config) {
  return [
    '<section class="cmdp-build-view">',
    '<div class="cmdp-build-toolbar">',
    '<div class="cmdp-build-toolbar-main">',
    '<div class="cmdp-build-summary">',
    summaryPill('Classes', model.classes.length),
    summaryPill('Domains', model.domains.length),
    summaryPill('Lookups', model.lookupTables.length),
    config.rootClass ? `<span class="pill">Root ${htmlEscape(config.rootClass)}</span>` : '',
    '</div>',
    '<nav class="cmdp-build-nav">',
    config.sections.includes('classes') ? '<a href="#cmdp-build-classes">Classes</a>' : '',
    config.sections.includes('domains') ? '<a href="#cmdp-build-domains">Domains</a>' : '',
    config.sections.includes('lookups') ? '<a href="#cmdp-build-lookups">Lookups</a>' : '',
    '</nav>',
    '</div>',
    '<input class="result-table-filter cmdp-build-search" data-result-filter placeholder="Search in CMDBuild model">',
    '</div>',
    config.sections.includes('classes') ? renderClasses(model.classes) : '',
    config.sections.includes('domains') ? renderDomains(model.domains) : '',
    config.sections.includes('lookups') ? renderLookups(model.lookupTables) : '',
    '</section>'
  ].filter(Boolean).join('');
}

function renderClasses(classes) {
  if (!classes.length) return '<section id="cmdp-build-classes"><h2>Classes</h2><div class="notice">No classes found.</div></section>';
  return [
    '<section id="cmdp-build-classes" class="cmdp-build-section"><h2>Classes</h2>',
    classes.map(renderClassPanel).join(''),
    '</section>'
  ].join('');
}

function renderClassPanel(classItem) {
  const attributes = classItem.attributes || [];
  const filterText = [
    classItem.hierarchyPath,
    classItem.displayName,
    classItem.name,
    classItem.parentDisplayName,
    classItem.parent,
    classItem.prototype ? 'Superclass' : '',
    attributes.map((attribute) => [attribute.displayName, attribute.name, attribute.type, attribute.lookupType, attribute.helpText].join(' ')).join(' '),
    (classItem.relatedDomains || []).map((domain) => [domain.displayName, domain.name].join(' ')).join(' ')
  ].join(' ');
  const level = Math.max(0, Number(classItem.hierarchyLevel || 0));
  return [
    `<details id="${attr(classItem.anchor)}" class="cmdp-build-panel" data-result-row data-filter-text="${attr(filterTextValue(filterText))}" style="margin-left:${Math.min(level, 8) * 14}px" open>`,
    '<summary>',
    classItem.hierarchyPath ? `<span class="pill">${htmlEscape(classItem.hierarchyPath)}</span>` : '',
    `<span class="cmdp-build-title">${htmlEscape(classItem.displayName)}</span>`,
    `<code>${htmlEscape(classItem.name)}</code>`,
    classItem.prototype ? '<span class="pill">Superclass</span>' : '',
    classItem.parent ? `<span class="muted">Parent: ${htmlEscape(classItem.parentDisplayName || classItem.parent)}</span>` : '',
    '</summary>',
    classItem.error ? `<div class="notice error">${htmlEscape(classItem.error)}</div>` : '',
    attributes.length ? renderAttributeTable(attributes) : '<div class="muted">No attributes.</div>',
    classItem.relatedDomains && classItem.relatedDomains.length ? renderClassDomainList(classItem.relatedDomains) : '',
    '</details>'
  ].join('');
}

function renderAttributeTable(attributes) {
  const rows = attributes.map((attribute) => [
    `<code>${htmlEscape(attribute.displayName || attribute.name)}</code>${attribute.inherited ? ' <span class="pill">inherited</span>' : ''}${attribute.system ? ' <span class="pill">system</span>' : ''}`,
    htmlEscape(attribute.type || ''),
    htmlEscape(attribute.lookupType || ''),
    htmlEscape(attribute.helpText || '')
  ]);
  return renderTable(['Name', 'Type', 'Lookup', 'Help'], rows);
}

function renderClassDomainList(domains) {
  return '<div class="cmdp-build-related"><strong>Related domains</strong>' +
    domains.map((domain) => `<a href="#${attr(domain.anchor)}">${htmlEscape(domain.displayName || domain.name)}</a>`).join('') +
    '</div>';
}

function renderDomains(domains) {
  if (!domains.length) return '<section id="cmdp-build-domains"><h2>Domains</h2><div class="notice">No domains found.</div></section>';
  const rows = domains.map((domain) => [
    `<a href="#${attr(domain.anchor)}"><code>${htmlEscape(domain.displayName)}</code></a><span class="muted">${htmlEscape(domain.name)}</span>`,
    renderClassLinks(domain.sourceLinks),
    renderClassLinks(domain.destinationLinks),
    htmlEscape(domain.cardinality || ''),
    htmlEscape(domain.direct || ''),
    htmlEscape(domain.inverse || '')
  ]);
  const detailRows = domains.map((domain) => {
    if (domain.attributesError) return `<div class="notice error">${htmlEscape(domain.attributesError)}</div>`;
    if (!domain.attributes || !domain.attributes.length) return '';
    const filterText = [
      domain.displayName,
      domain.name,
      domain.cardinality,
      domain.direct,
      domain.inverse,
      domain.attributes.map((attribute) => [attribute.displayName, attribute.name, attribute.type, attribute.lookupType, attribute.helpText].join(' ')).join(' ')
    ].join(' ');
    return `<details id="${attr(domain.attributesAnchor)}" class="cmdp-build-panel" data-result-row data-filter-text="${attr(filterTextValue(filterText))}"><summary><span class="cmdp-build-title">${htmlEscape(domain.displayName)}</span><span class="muted">domain attributes</span></summary>${renderAttributeTable(domain.attributes)}</details>`;
  }).join('');
  return '<section id="cmdp-build-domains" class="cmdp-build-section"><h2>Domains</h2>' +
    renderTable(['Domain', 'Source', 'Destination', 'Cardinality', 'Direct', 'Inverse'], rows) + detailRows + '</section>';
}

function renderLookups(lookupTables) {
  if (!lookupTables.length) return '<section id="cmdp-build-lookups"><h2>Lookups</h2><div class="notice">No lookups found.</div></section>';
  return '<section id="cmdp-build-lookups" class="cmdp-build-section"><h2>Lookups</h2>' +
    lookupTables.map((lookup) => {
      const usage = lookup.usages && lookup.usages.length
        ? `<div class="cmdp-build-related">${lookup.usages.map((item) => `<a href="#${attr(item.classAnchor)}">${htmlEscape(item.classDisplayName)}.${htmlEscape(item.attributeDisplayName)}</a>`).join('')}</div>`
        : '<div class="muted">No class usage in this view.</div>';
      const values = lookup.valuesError
        ? `<div class="notice error">${htmlEscape(lookup.valuesError)}</div>`
        : lookup.values.length
          ? renderTable(['Value', 'Code', 'Active'], lookup.values.map((value) => [
            `<span style="padding-left:${value.level * 16}px">${htmlEscape(value.description)}</span>`,
            `<code>${htmlEscape(value.code || '')}</code>`,
            value.active === true ? 'Yes' : value.active === false ? 'No' : ''
          ]))
          : '<div class="muted">No values.</div>';
      const filterText = [
        lookup.displayName,
        lookup.name,
        lookup.parent,
        lookup.speciality,
        (lookup.usages || []).map((item) => [item.classDisplayName, item.className, item.attributeDisplayName, item.attributeName].join(' ')).join(' '),
        (lookup.values || []).map((value) => [value.description, value.code].join(' ')).join(' ')
      ].join(' ');
      return `<details id="${attr(lookup.anchor)}" class="cmdp-build-panel" data-result-row data-filter-text="${attr(filterTextValue(filterText))}"><summary><span class="cmdp-build-title">${htmlEscape(lookup.displayName)}</span><code>${htmlEscape(lookup.name)}</code></summary>${usage}${values}</details>`;
    }).join('') +
    '</section>';
}

function renderTable(headers, rows) {
  return '<div class="table-wrap"><table class="compact cmdp-build-table"><thead><tr>' +
    headers.map((header) => `<th>${htmlEscape(header)}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows.map((row) => `<tr data-result-row data-filter-text="${attr(filterTextValue(row.join(' ')))}">${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('') +
    '</tbody></table></div>';
}

function renderClassLinks(items) {
  return `<div class="cmdp-build-links">${(items || []).map((item) => item.anchor
    ? `<a href="#${attr(item.anchor)}">${htmlEscape(item.displayName)}</a>`
    : `<span>${htmlEscape(item.displayName || item.name)}</span>`).join('')}</div>`;
}

function summaryPill(label, value) {
  return `<span class="pill">${htmlEscape(label)}: ${htmlEscape(value)}</span>`;
}

function normalizeClass(rawClass, translations, classAnchors) {
  const className = rawClass.name || '';
  return {
    name: className,
    displayName: translatedDescription(rawClass, translations, className ? [`class.${className}.description`] : [], className),
    description: rawClass.description || '',
    parent: rawClass.parent || '',
    parentAnchor: classAnchors[rawClass.parent] || '',
    parentDisplayName: rawClass.parent || '',
    prototype: Boolean(rawClass.prototype),
    active: rawClass.active,
    hierarchyLevel: rawClass.hierarchyLevel || 0,
    hierarchyPath: rawClass.hierarchyPath || '',
    anchor: classAnchors[className] || makeAnchor('cmdp-build-class', className),
    attributes: [],
    relatedDomains: []
  };
}

function normalizeAttribute(attribute, translations, ownerName = '') {
  const name = attribute.name || '';
  const lookupType = attribute.lookupType || '';
  const displayName = translatedDescription(attribute, translations, [
    `attribute.${ownerName}.${name}.description`,
    `class.${ownerName}.attribute.${name}.description`,
    `domain.${ownerName}.attribute.${name}.description`
  ], name);
  return {
    name,
    displayName,
    type: attribute.type || '',
    helpText: attribute.help || '',
    inherited: Boolean(attribute.inherited),
    system: isSystemAttribute(attribute),
    lookupType,
    lookupAnchor: lookupType ? makeAnchor('cmdp-build-lookup', lookupType) : ''
  };
}

function registerLookupUsage(lookupIndex, classItem, attribute) {
  const lookupType = attribute.lookupType;
  if (!lookupType || !classItem.name) return;
  lookupIndex[lookupType] ||= {
    name: lookupType,
    anchor: makeAnchor('cmdp-build-lookup', lookupType),
    usages: []
  };
  lookupIndex[lookupType].usages.push({
    className: classItem.name,
    classDisplayName: classItem.displayName || classItem.name,
    classAnchor: classItem.anchor,
    attributeName: attribute.name,
    attributeDisplayName: attribute.displayName || attribute.name
  });
}

function attachDomainsToClasses(classes, domains) {
  const byName = Object.fromEntries(classes.map((classItem) => [classItem.name, classItem]));
  for (const domain of domains) {
    const related = new Set([...(domain.sourceNames || []), ...(domain.destinationNames || [])]);
    for (const className of related) {
      if (byName[className]) {
        byName[className].relatedDomains.push({
          name: domain.name,
          displayName: domain.displayName,
          anchor: domain.anchor
        });
      }
    }
  }
}

function includedClassNames(classes, rootClass) {
  const byName = Object.fromEntries(classes.filter((item) => item.name).map((item) => [item.name, item]));
  if (!rootClass || !byName[rootClass]) return new Set(classes.map((item) => item.name).filter(Boolean));
  return new Set(classes.filter((item) => {
    let current = item.name;
    const seen = new Set();
    while (current && byName[current] && !seen.has(current)) {
      if (current === rootClass) return true;
      seen.add(current);
      current = byName[current].parent;
    }
    return false;
  }).map((item) => item.name));
}

function sortClassesByInheritance(classes) {
  const byName = Object.fromEntries(classes.filter((item) => item.name).map((item) => [item.name, item]));
  const childrenByParent = {};
  for (const classItem of classes) {
    let parent = classItem.parent;
    if (!byName[parent]) parent = '';
    childrenByParent[parent] ||= [];
    childrenByParent[parent].push(classItem);
  }
  for (const children of Object.values(childrenByParent)) {
    children.sort((left, right) => sortLabel(left.description || left.name).localeCompare(sortLabel(right.description || right.name)));
  }
  const ordered = [];
  const visited = new Set();
  const visit = (classItem, level, path) => {
    if (!classItem || !classItem.name || visited.has(classItem.name)) return;
    visited.add(classItem.name);
    classItem.hierarchyLevel = level;
    classItem.hierarchyPath = path;
    ordered.push(classItem);
    (childrenByParent[classItem.name] || []).forEach((child, index) => {
      visit(child, level + 1, `${path}.${index + 1}`);
    });
  };
  (childrenByParent[''] || []).forEach((root, index) => visit(root, 0, String(index + 1)));
  for (const classItem of classes) {
    if (classItem.name && !visited.has(classItem.name)) visit(classItem, 0, String(ordered.length + 1));
  }
  return ordered;
}

function buildLookupHierarchy(rawValues, lookupName, translations) {
  const values = [];
  const byId = {};
  const childrenByParent = {};
  for (const rawValue of rawValues || []) {
    const id = lookupValueId(rawValue);
    const code = rawValue.code || '';
    const value = {
      id,
      code,
      description: translatedDescription(rawValue, translations, [`lookup.${lookupName}.${code}.description`], code || id),
      parentId: lookupParentId(rawValue),
      active: rawValue.active,
      level: 0
    };
    values.push(value);
    byId[id] = value;
  }
  for (const value of values) {
    const parentId = byId[value.parentId] ? value.parentId : '';
    childrenByParent[parentId] ||= [];
    childrenByParent[parentId].push(value);
  }
  for (const children of Object.values(childrenByParent)) {
    children.sort((left, right) => sortLabel(left.description || left.code).localeCompare(sortLabel(right.description || right.code)));
  }
  const ordered = [];
  const visited = new Set();
  const visit = (value, level) => {
    if (!value || visited.has(value.id)) return;
    visited.add(value.id);
    value.level = level;
    ordered.push(value);
    for (const child of childrenByParent[value.id] || []) visit(child, level + 1);
  };
  for (const root of childrenByParent[''] || []) visit(root, 0);
  for (const value of values) {
    if (!visited.has(value.id)) visit(value, 0);
  }
  return ordered;
}

function classLinks(names, anchors, labels) {
  return (names || []).filter(Boolean).map((name) => ({
    name,
    displayName: labels[name] || name,
    anchor: anchors[name] || ''
  }));
}

function translatedValue(translations, ...codes) {
  for (const code of codes) {
    if (code && translations[code]) return translations[code];
  }
  return '';
}

function translatedDescription(item, translations, codes, fallbackName = '') {
  return translatedValue(translations, ...codes)
    || item?._description_translation
    || item?.description
    || fallbackName;
}

function isSystemAttribute(attribute) {
  return SYSTEM_ATTRIBUTE_NAMES.has(attribute?.name) || attribute?.mode === 'syshidden' || attribute?.mode === 'sysreadonly';
}

function lookupValueId(value) {
  return String(value._id ?? value.id ?? value.code ?? '');
}

function lookupParentId(value) {
  let parent = value.parent;
  if (parent && typeof parent === 'object') parent = parent._id ?? parent.id;
  if (parent === undefined || parent === null) parent = value.parent_id;
  return parent === undefined || parent === null ? '' : String(parent);
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function makeAnchor(prefix, value) {
  const slug = String(value || '').trim().replace(ANCHOR_SAFE_RE, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${slug || 'item'}`;
}

function sortLabel(value) {
  return String(value || '').toLowerCase();
}

function filterTextValue(value) {
  return stripHtml(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function cmdbMessage(payload) {
  return Array.isArray(payload && payload.messages) && payload.messages[0] && payload.messages[0].message
    ? payload.messages[0].message
    : '';
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function attr(value) {
  return htmlEscape(value);
}
