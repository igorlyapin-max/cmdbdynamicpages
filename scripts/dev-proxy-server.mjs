import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const LISTEN_HOST = process.env.PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PROXY_PORT || 8093);
const CMDBUILD_ORIGIN = process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090';
const BACKEND_PREFIX = '/cmdbuild/custom-api';
const DEFAULT_TECHNICAL_ROOT = process.env.CMDBDYNAMICPAGES_ROOT || 'Cst_QueryTool';
const CMDBUILD_REQUEST_TIMEOUT_MS = Number(process.env.CMDBUILD_REQUEST_TIMEOUT_MS || 10000);
const CSRF_SECRET = process.env.CMDBDYNAMICPAGES_CSRF_SECRET || crypto.randomBytes(32).toString('hex');
const ABSOLUTE_EXECUTION_LIMITS = {
  maxRows: 2000,
  maxClasses: 500,
  maxDomains: 500,
  maxRestCalls: 1000,
  maxTraversalDepth: 5
};

function getCookieValue(cookieHeader, name) {
  const cookies = String(cookieHeader || '').split(';');
  for (const cookie of cookies) {
    const index = cookie.indexOf('=');
    if (index === -1) continue;
    const key = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();
    if (key === name) return decodeURIComponent(value);
  }
  return '';
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function validateCmdbuildIdentifier(value, label) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(text)) {
    throw new Error(`${label} must start with a letter and contain only letters, digits, and underscores.`);
  }
  return text;
}

function getTechnicalPrefix(root) {
  return root.endsWith('QueryTool') ? root.slice(0, -'QueryTool'.length) : `${root}_`;
}

function baseClassPayload(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parent: definition.parent,
    prototype: Boolean(definition.prototype),
    type: 'standard',
    active: true,
    defaultOrder: [],
    domainOrder: [],
    formTriggers: [],
    contextMenuItems: [],
    widgets: [],
    attributeGroups: [],
    dmsCategories: [],
    attachmentsInline: false,
    attachmentsInlineClosed: true,
    noteInline: false,
    noteInlineClosed: false,
    multitenantMode: 'never',
    uiRouting_mode: 'default',
    uiRouting_target: null,
    uiRouting_custom: {},
    barcodeSearchAttr: null,
    barcodeSearchRegex: null
  };
}

function baseAttributePayload(attribute, index) {
  const payload = {
    name: attribute.name,
    description: attribute.description,
    type: attribute.type,
    mode: 'write',
    active: true,
    mandatory: Boolean(attribute.mandatory),
    unique: Boolean(attribute.unique),
    showInGrid: Boolean(attribute.showInGrid),
    showInReducedGrid: false,
    hidden: false,
    writable: true,
    index,
    metadata: {}
  };

  if (attribute.type === 'string') {
    const maxLength = attribute.maxLength || 100;
    payload.maxLength = maxLength;
    payload.metadata.cm_length = String(maxLength);
    payload.metadata.cm_multiline = 'false';
    payload.password = false;
    payload.showPassword = 'always';
    payload.textContentSecurity = 'plaintext';
  }

  if (attribute.type === 'text') {
    payload.metadata.cm_multiline = 'true';
    payload.textContentSecurity = 'plaintext';
  }

  return payload;
}

function buildTechnicalSchema(rootValue) {
  const root = validateCmdbuildIdentifier(rootValue || DEFAULT_TECHNICAL_ROOT, 'root');
  const prefix = getTechnicalPrefix(root);
  const classNames = {
    root,
    config: validateCmdbuildIdentifier(`${prefix}QueryToolConfig`, 'config class'),
    template: validateCmdbuildIdentifier(`${prefix}QueryTemplate`, 'template class'),
    version: validateCmdbuildIdentifier(`${prefix}QueryTemplateVersion`, 'template version class'),
    log: validateCmdbuildIdentifier(`${prefix}QueryExecutionLog`, 'execution log class')
  };

  return {
    root,
    prefix,
    classNames,
    classes: [
      {
        name: classNames.root,
        description: 'CMDB Dynamic Pages technical root',
        parent: 'Class',
        prototype: true,
        attributes: []
      },
      {
        name: classNames.config,
        description: 'Query Tool Config',
        parent: classNames.root,
        prototype: false,
        attributes: [
          { name: 'RootCode', description: 'Root code', type: 'string', maxLength: 100, mandatory: true, showInGrid: true },
          { name: 'Active', description: 'Active', type: 'boolean', showInGrid: true },
          { name: 'RuntimeConfigJson', description: 'Runtime config JSON', type: 'json' }
        ]
      },
      {
        name: classNames.template,
        description: 'Query Template',
        parent: classNames.root,
        prototype: false,
        attributes: [
          { name: 'Active', description: 'Active', type: 'boolean', showInGrid: true },
          { name: 'SpecJson', description: 'Template spec JSON', type: 'json', mandatory: true },
          { name: 'ParamsSchemaJson', description: 'Parameters schema JSON', type: 'json' },
          { name: 'ResultSchemaJson', description: 'Result schema JSON', type: 'json' },
          { name: 'Owner', description: 'Owner', type: 'string', maxLength: 100, showInGrid: true },
          { name: 'UpdatedAt', description: 'Updated at', type: 'dateTime', showInGrid: true }
        ]
      },
      {
        name: classNames.version,
        description: 'Query Template Version',
        parent: classNames.root,
        prototype: false,
        attributes: [
          { name: 'TemplateCode', description: 'Template code', type: 'string', maxLength: 100, mandatory: true, showInGrid: true },
          { name: 'Version', description: 'Version', type: 'integer', mandatory: true, showInGrid: true },
          { name: 'SpecJson', description: 'Template spec JSON', type: 'json', mandatory: true },
          { name: 'ChangedBy', description: 'Changed by', type: 'string', maxLength: 100, showInGrid: true },
          { name: 'ChangedAt', description: 'Changed at', type: 'dateTime', showInGrid: true },
          { name: 'ChangeComment', description: 'Change comment', type: 'text' }
        ]
      },
      {
        name: classNames.log,
        description: 'Query Execution Log',
        parent: classNames.root,
        prototype: false,
        attributes: [
          { name: 'TemplateCode', description: 'Template code', type: 'string', maxLength: 100, mandatory: true, showInGrid: true },
          { name: 'StartedAt', description: 'Started at', type: 'dateTime', showInGrid: true },
          { name: 'FinishedAt', description: 'Finished at', type: 'dateTime', showInGrid: true },
          { name: 'Username', description: 'Username', type: 'string', maxLength: 100, showInGrid: true },
          { name: 'ExecutionStatus', description: 'Execution status', type: 'string', maxLength: 50, showInGrid: true },
          { name: 'RowsCount', description: 'Rows count', type: 'integer', showInGrid: true },
          { name: 'ErrorMessage', description: 'Error message', type: 'text' }
        ]
      }
    ]
  };
}

function getSameOrigin(req) {
  return `http://${req.headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`}`;
}

function hasSameOriginMutationHeaders(req) {
  const expectedOrigin = getSameOrigin(req);
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

function requireSameOriginMutation(req, res) {
  if (hasSameOriginMutationHeaders(req)) return true;
  sendJson(res, 403, {
    success: false,
    message: 'State-changing custom API calls require a same-origin Origin or Referer header.'
  });
  return false;
}

function getCsrfToken(authToken) {
  return crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(authToken)
    .digest('hex');
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireCsrfToken(req, res, authToken) {
  const provided = req.headers['x-cmdbdynamicpages-csrf'];
  if (provided && timingSafeEqualString(provided, getCsrfToken(authToken))) {
    return true;
  }
  sendJson(res, 403, {
    success: false,
    message: 'State-changing custom API calls require a valid CSRF token.'
  });
  return false;
}

function requireStateChangingRequest(req, res, authToken) {
  return requireSameOriginMutation(req, res) && requireCsrfToken(req, res, authToken);
}

function pickBooleans(source, names) {
  const result = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(source || {}, name)) {
      result[name] = Boolean(source[name]);
    }
  }
  return result;
}

function sanitizeSession(data) {
  if (!data) return null;
  return {
    userId: data.userId || data._userId || data._id || null,
    username: data.username || '',
    userDescription: data.userDescription || data.description || '',
    role: data.role || '',
    availableRoles: Array.isArray(data.availableRoles) ? data.availableRoles : [],
    multigroup: Boolean(data.multigroup || data.multiGroup),
    sessionType: data.sessionType || '',
    rolePrivileges: pickBooleans(data.rolePrivileges || {}, [
      'admin_roles_view',
      'admin_roles_modify',
      'admin_users_view',
      'admin_users_modify',
      'admin_classes_view',
      'admin_classes_modify',
      'admin_domains_view',
      'admin_domains_modify'
    ])
  };
}

function sanitizeRole(role) {
  if (!role) return null;
  return {
    id: role._id,
    name: role.name,
    description: role._description_translation || role.description || '',
    type: role.type || null,
    active: role.active === undefined ? null : Boolean(role.active),
    canReadUsers: role._can_users_read === undefined ? null : Boolean(role._can_users_read),
    canModifyUsers: role._can_users_modify === undefined ? null : Boolean(role._can_users_modify),
    privileges: pickBooleans(role, [
      '_rp_admin_roles_view',
      '_rp_admin_roles_modify',
      '_rp_admin_users_view',
      '_rp_admin_users_modify',
      '_rp_admin_classes_view',
      '_rp_admin_classes_modify',
      '_rp_admin_domains_view',
      '_rp_admin_domains_modify',
      '_rp_custompages_access'
    ])
  };
}

function sanitizeClass(item) {
  if (!item) return null;
  return {
    id: item._id,
    name: item.name,
    description: item._description_translation || item.description || '',
    parent: item.parent || null,
    type: item.type || null,
    active: Boolean(item.active),
    prototype: Boolean(item.prototype),
    permissions: pickBooleans(item, [
      '_can_read',
      '_can_create',
      '_can_update',
      '_can_clone',
      '_can_delete',
      '_can_modify',
      '_can_search'
    ])
  };
}

function sanitizeDomain(item) {
  if (!item) return null;
  return {
    id: item._id,
    name: item.name,
    description: item._description_translation || item.description || '',
    source: item.source || null,
    sources: Array.isArray(item.sources) ? item.sources : [],
    destination: item.destination || null,
    destinations: Array.isArray(item.destinations) ? item.destinations : [],
    cardinality: item.cardinality || null,
    active: item.active === undefined ? null : Boolean(item.active),
    descriptionDirect: item._descriptionDirect_translation || item.descriptionDirect || '',
    descriptionInverse: item._descriptionInverse_translation || item.descriptionInverse || '',
    isMasterDetail: item.isMasterDetail === undefined ? null : Boolean(item.isMasterDetail),
    permissions: pickBooleans(item, [
      '_can_create',
      'sourceEditable',
      'targetEditable'
    ])
  };
}

function sanitizeAttribute(item) {
  if (!item) return null;
  return {
    id: item._id,
    name: item.name,
    description: item._description_translation || item.description || '',
    type: item.type || null,
    active: item.active === undefined ? null : Boolean(item.active),
    inherited: item.inherited === undefined ? null : Boolean(item.inherited),
    mandatory: item.mandatory === undefined ? null : Boolean(item.mandatory),
    unique: item.unique === undefined ? null : Boolean(item.unique),
    mode: item.mode || null,
    showInGrid: item.showInGrid === undefined ? null : Boolean(item.showInGrid),
    domain: item.domain || null,
    direction: item.direction || null,
    targetClass: item.targetClass || null,
    targetType: item.targetType || null,
    lookupType: item.lookupType || null,
    permissions: pickBooleans(item, [
      '_can_read',
      '_can_create',
      '_can_update',
      '_can_modify'
    ])
  };
}

function sanitizeUser(item) {
  if (!item) return null;
  return {
    id: item._id,
    username: item.username,
    description: item.description || '',
    active: Boolean(item.active),
    service: Boolean(item.service),
    groups: Array.isArray(item.userGroups)
      ? item.userGroups.map((group) => ({
        id: group._id,
        name: group.name,
        description: group._description_translation || group.description || ''
      }))
      : []
  };
}

function methodAllowed(req, res, methods) {
  const allowed = Array.isArray(methods) ? methods : [methods];
  if (allowed.includes(req.method)) return true;
  res.writeHead(405, {
    allow: allowed.join(', '),
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify({
    success: false,
    message: `Method ${req.method} is not allowed for this route.`
  }, null, 2));
  return false;
}

function getPositiveInt(searchParams, name, fallback, max) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function getBoolean(searchParams, name, fallback) {
  const raw = searchParams.get(name);
  if (raw === null) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function buildListPath(basePath, requestUrl, defaults = {}) {
  const params = new URLSearchParams();
  const limit = getPositiveInt(requestUrl.searchParams, 'limit', defaults.limit || 100, defaults.maxLimit || 500);
  const start = getPositiveInt(requestUrl.searchParams, 'start', defaults.start || 0, 100000);
  params.set('limit', String(limit));
  if (start) params.set('start', String(start));
  if (getBoolean(requestUrl.searchParams, 'detailed', Boolean(defaults.detailed))) {
    params.set('detailed', 'true');
  }
  return `${basePath}?${params.toString()}`;
}

function cmdbuildRequest(path, authToken, options = {}) {
  const target = new URL(path, CMDBUILD_ORIGIN);
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {
    accept: 'application/json',
    'CMDBuild-Authorization': authToken,
    ...(options.headers || {})
  };
  if (body !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: options.method || 'GET',
      path: `${target.pathname}${target.search}`,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({
          statusCode: res.statusCode || 0,
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          json,
          text
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(CMDBUILD_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`CMDBuild request timed out after ${CMDBUILD_REQUEST_TIMEOUT_MS}ms.`));
    });
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

async function checkOrCreateTechnicalSchema(authToken, root, createMissing) {
  const schema = buildTechnicalSchema(root);
  const actions = [];
  const missing = [];
  const classes = [];

  for (const classDefinition of schema.classes) {
    const classPath = `/cmdbuild/services/rest/v3/classes/${encodeURIComponent(classDefinition.name)}`;
    let classResponse = await cmdbuildRequest(classPath, authToken);
    let classExists = classResponse.ok;
    let classCreated = false;

    if (!classExists && createMissing) {
      const createResponse = await cmdbuildRequest('/cmdbuild/services/rest/v3/classes/', authToken, {
        method: 'POST',
        body: baseClassPayload(classDefinition)
      });
      actions.push({
        type: 'class',
        name: classDefinition.name,
        action: createResponse.ok ? 'created' : 'create_failed',
        cmdbuildStatus: createResponse.statusCode
      });
      classResponse = createResponse;
      classExists = createResponse.ok;
      classCreated = createResponse.ok;
    }

    if (!classExists) {
      missing.push({
        type: 'class',
        name: classDefinition.name,
        cmdbuildStatus: classResponse.statusCode
      });
    }

    const classStatus = {
      name: classDefinition.name,
      description: classDefinition.description,
      parent: classDefinition.parent,
      prototype: Boolean(classDefinition.prototype),
      exists: classExists,
      created: classCreated,
      cmdbuildStatus: classResponse.statusCode,
      attributes: []
    };

    if (classExists) {
      let index = 10;
      for (const attribute of classDefinition.attributes) {
        const attrPath = `/cmdbuild/services/rest/v3/classes/${encodeURIComponent(classDefinition.name)}/attributes/${encodeURIComponent(attribute.name)}`;
        let attrResponse = await cmdbuildRequest(attrPath, authToken);
        let attrExists = attrResponse.ok;
        let attrCreated = false;

        if (!attrExists && createMissing) {
          const createAttrResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(classDefinition.name)}/attributes`, authToken, {
            method: 'POST',
            body: baseAttributePayload(attribute, index)
          });
          actions.push({
            type: 'attribute',
            className: classDefinition.name,
            name: attribute.name,
            action: createAttrResponse.ok ? 'created' : 'create_failed',
            cmdbuildStatus: createAttrResponse.statusCode
          });
          attrResponse = createAttrResponse;
          attrExists = createAttrResponse.ok;
          attrCreated = createAttrResponse.ok;
        }

        if (!attrExists) {
          missing.push({
            type: 'attribute',
            className: classDefinition.name,
            name: attribute.name,
            cmdbuildStatus: attrResponse.statusCode
          });
        }

        classStatus.attributes.push({
          name: attribute.name,
          description: attribute.description,
          type: attribute.type,
          exists: attrExists,
          created: attrCreated,
          cmdbuildStatus: attrResponse.statusCode
        });
        index += 10;
      }
    }

    classes.push(classStatus);
  }

  return {
    root: schema.root,
    prefix: schema.prefix,
    classNames: schema.classNames,
    ready: missing.length === 0,
    createMissing,
    missing,
    actions,
    classes
  };
}

async function getSessionData(authToken) {
  const session = await cmdbuildRequest('/cmdbuild/services/rest/v3/sessions/current', authToken);
  return {
    response: session,
    data: session.json && session.json.data ? session.json.data : null
  };
}

async function requireAdminClassesModify(authToken, res) {
  const session = await getSessionData(authToken);
  const privileges = session.data && session.data.rolePrivileges ? session.data.rolePrivileges : {};
  if (session.response.ok && privileges.admin_classes_modify) {
    return true;
  }
  sendJson(res, 403, {
    success: false,
    cmdbuildStatus: session.response.statusCode,
    message: 'Technical schema bootstrap requires CMDBuild admin_classes_modify privilege.'
  });
  return false;
}

function safeJsonValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function cmdbuildJsonAttribute(value, fallback = {}) {
  if (value === undefined || value === null) {
    return JSON.stringify(fallback);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sanitizeTemplateCard(card) {
  if (!card) return null;
  return {
    id: card._id,
    code: card.Code || '',
    description: card.Description || '',
    active: card.Active === undefined ? null : Boolean(card.Active),
    spec: safeJsonValue(card.SpecJson, null),
    paramsSchema: safeJsonValue(card.ParamsSchemaJson, null),
    resultSchema: safeJsonValue(card.ResultSchemaJson, null),
    owner: card.Owner || '',
    updatedAt: card.UpdatedAt || null
  };
}

function sanitizeTemplateVersionCard(card) {
  if (!card) return null;
  return {
    id: card._id,
    code: card.Code || '',
    description: card.Description || '',
    templateCode: card.TemplateCode || '',
    version: card.Version === undefined || card.Version === null ? null : Number(card.Version),
    spec: safeJsonValue(card.SpecJson, null),
    changedBy: card.ChangedBy || '',
    changedAt: card.ChangedAt || null,
    changeComment: card.ChangeComment || ''
  };
}

function normalizeTemplatePayload(body, fallbackCode, username) {
  const code = validateCmdbuildIdentifier(body.code || body.Code || fallbackCode, 'template code');
  const spec = body.spec !== undefined ? body.spec : body.SpecJson;
  if (spec === undefined || spec === null) {
    throw new Error('Template spec is required.');
  }

  return {
    Code: code,
    Description: body.description || body.Description || code,
    Active: body.active === undefined ? body.Active !== false : Boolean(body.active),
    SpecJson: cmdbuildJsonAttribute(spec),
    ParamsSchemaJson: cmdbuildJsonAttribute(body.paramsSchema !== undefined ? body.paramsSchema : body.ParamsSchemaJson),
    ResultSchemaJson: cmdbuildJsonAttribute(body.resultSchema !== undefined ? body.resultSchema : body.ResultSchemaJson),
    Owner: body.owner || body.Owner || username || '',
    UpdatedAt: new Date().toISOString()
  };
}

async function fetchTemplateVersionCards(authToken, root) {
  const schema = buildTechnicalSchema(root);
  const cards = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(schema.classNames.version)}/cards?limit=1000`, authToken);
  return {
    schema,
    response: cards,
    cards: Array.isArray(cards.json && cards.json.data) ? cards.json.data : []
  };
}

async function listTemplateVersionCards(authToken, root, templateCode, requestUrl) {
  const code = validateCmdbuildIdentifier(templateCode, 'template code');
  const limit = getPositiveInt(requestUrl.searchParams, 'limit', 50, 1000);
  const start = getPositiveInt(requestUrl.searchParams, 'start', 0, 100000);
  const fetched = await fetchTemplateVersionCards(authToken, root);
  const filtered = fetched.cards
    .filter((card) => card.TemplateCode === code)
    .sort((left, right) => Number(right.Version || 0) - Number(left.Version || 0));
  return {
    schema: fetched.schema,
    response: fetched.response,
    cards: filtered.slice(start, start + limit),
    meta: {
      total: filtered.length,
      start,
      limit
    }
  };
}

async function writeTemplateVersion(authToken, root, templateCode, spec, username, comment) {
  const code = validateCmdbuildIdentifier(templateCode, 'template code');
  const fetched = await fetchTemplateVersionCards(authToken, root);
  if (!fetched.response.ok) {
    return {
      success: false,
      cmdbuildStatus: fetched.response.statusCode,
      className: fetched.schema.classNames.version,
      message: 'Cannot read template versions.'
    };
  }

  const maxVersion = fetched.cards
    .filter((card) => card.TemplateCode === code)
    .reduce((max, card) => Math.max(max, Number(card.Version || 0)), 0);
  const version = maxVersion + 1;
  const changedAt = new Date();
  const payload = {
    Code: truncateText(`VER_${code}_${version}`, 90),
    Description: truncateText(`${code} version ${version}`, 250),
    TemplateCode: code,
    Version: version,
    SpecJson: cmdbuildJsonAttribute(spec),
    ChangedBy: truncateText(username || '', 100),
    ChangedAt: changedAt.toISOString(),
    ChangeComment: truncateText(comment || '', 4000)
  };
  const created = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(fetched.schema.classNames.version)}/cards`, authToken, {
    method: 'POST',
    body: payload
  });
  return {
    success: created.ok,
    cmdbuildStatus: created.statusCode,
    className: fetched.schema.classNames.version,
    version: created.ok ? sanitizeTemplateVersionCard(created.json && created.json.data) : null
  };
}

function defaultRuntimeConfig() {
  return {
    executionLimits: {
      maxRowsDefault: 500,
      maxRowsPreviewDefault: 25,
      maxRowsMax: 2000,
      maxClassesDefault: 100,
      maxClassesMax: 500,
      maxDomainsDefault: 100,
      maxDomainsMax: 500,
      maxRestCallsDefault: 250,
      maxRestCallsMax: 1000,
      maxTraversalDepthDefault: 1,
      maxTraversalDepthMax: 5
    }
  };
}

function toPositiveInt(value, fallback, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

function normalizeExecutionLimitConfig(runtimeConfig) {
  const defaults = defaultRuntimeConfig().executionLimits;
  const source = runtimeConfig && runtimeConfig.executionLimits ? runtimeConfig.executionLimits : {};
  const maxRowsMax = toPositiveInt(source.maxRowsMax, defaults.maxRowsMax, ABSOLUTE_EXECUTION_LIMITS.maxRows);
  const maxClassesMax = toPositiveInt(source.maxClassesMax, defaults.maxClassesMax, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const maxDomainsMax = toPositiveInt(source.maxDomainsMax, defaults.maxDomainsMax, ABSOLUTE_EXECUTION_LIMITS.maxDomains);
  const maxRestCallsMax = toPositiveInt(source.maxRestCallsMax, defaults.maxRestCallsMax, ABSOLUTE_EXECUTION_LIMITS.maxRestCalls);
  const maxTraversalDepthMax = toPositiveInt(source.maxTraversalDepthMax, defaults.maxTraversalDepthMax, ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth);

  return {
    maxRowsDefault: toPositiveInt(source.maxRowsDefault, defaults.maxRowsDefault, maxRowsMax),
    maxRowsPreviewDefault: toPositiveInt(source.maxRowsPreviewDefault, defaults.maxRowsPreviewDefault, maxRowsMax),
    maxRowsMax,
    maxClassesDefault: toPositiveInt(source.maxClassesDefault, defaults.maxClassesDefault, maxClassesMax),
    maxClassesMax,
    maxDomainsDefault: toPositiveInt(source.maxDomainsDefault, defaults.maxDomainsDefault, maxDomainsMax),
    maxDomainsMax,
    maxRestCallsDefault: toPositiveInt(source.maxRestCallsDefault, defaults.maxRestCallsDefault, maxRestCallsMax),
    maxRestCallsMax,
    maxTraversalDepthDefault: toPositiveInt(source.maxTraversalDepthDefault, defaults.maxTraversalDepthDefault, maxTraversalDepthMax),
    maxTraversalDepthMax
  };
}

function sanitizeConfigCard(card, root) {
  if (!card) {
    return {
      id: null,
      code: root,
      description: '',
      rootCode: root,
      active: true,
      runtimeConfig: defaultRuntimeConfig(),
      exists: false
    };
  }
  return {
    id: card._id,
    code: card.Code || root,
    description: card.Description || '',
    rootCode: card.RootCode || root,
    active: card.Active === undefined ? null : Boolean(card.Active),
    runtimeConfig: safeJsonValue(card.RuntimeConfigJson, defaultRuntimeConfig()),
    exists: true
  };
}

function normalizeConfigPayload(body, root) {
  const runtimeConfig = body.runtimeConfig !== undefined ? body.runtimeConfig : body.RuntimeConfigJson;
  return {
    Code: root,
    Description: body.description || body.Description || `CMDB Dynamic Pages config for ${root}`,
    RootCode: root,
    Active: body.active === undefined ? body.Active !== false : Boolean(body.active),
    RuntimeConfigJson: cmdbuildJsonAttribute(runtimeConfig === undefined ? defaultRuntimeConfig() : runtimeConfig)
  };
}

async function findConfigCard(authToken, root) {
  const schema = buildTechnicalSchema(root);
  const cards = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(schema.classNames.config)}/cards?limit=1000`, authToken);
  const data = Array.isArray(cards.json && cards.json.data) ? cards.json.data : [];
  return {
    schema,
    response: cards,
    card: data.find((item) => item.RootCode === schema.root || item.Code === schema.root) || null
  };
}

async function getRuntimeConfig(authToken, root) {
  const found = await findConfigCard(authToken, root);
  if (!found.response.ok || !found.card || found.card.Active === false) {
    return defaultRuntimeConfig();
  }
  return sanitizeConfigCard(found.card, found.schema.root).runtimeConfig || defaultRuntimeConfig();
}

function truncateText(value, maxLength) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(maxLength - 3, 0))}...`;
}

function countResultRows(result) {
  const tables = result && Array.isArray(result.tables) ? result.tables : [];
  return tables.reduce((count, table) => count + (Array.isArray(table.rows) ? table.rows.length : 0), 0);
}

function sanitizeExecutionLogCard(card) {
  if (!card) return null;
  return {
    id: card._id,
    code: card.Code || '',
    description: card.Description || '',
    templateCode: card.TemplateCode || '',
    startedAt: card.StartedAt || null,
    finishedAt: card.FinishedAt || null,
    username: card.Username || '',
    executionStatus: card.ExecutionStatus || '',
    rowsCount: card.RowsCount === undefined || card.RowsCount === null ? null : Number(card.RowsCount),
    errorMessage: card.ErrorMessage || ''
  };
}

async function writeExecutionLog(authToken, root, log) {
  const schema = buildTechnicalSchema(root);
  const startedAt = log.startedAt instanceof Date ? log.startedAt : new Date(log.startedAt || Date.now());
  const finishedAt = log.finishedAt instanceof Date ? log.finishedAt : new Date(log.finishedAt || Date.now());
  const action = validateCmdbuildIdentifier(log.action || 'run', 'log action').toUpperCase().slice(0, 8);
  const templateCode = validateCmdbuildIdentifier(log.templateCode, 'template code');
  const compactTime = finishedAt.toISOString().replace(/[-:.]/g, '');
  const code = truncateText(`${action}_${templateCode}_${compactTime}`, 90);
  const payload = {
    Code: code,
    Description: truncateText(`${action.toLowerCase()} ${templateCode} ${log.status || ''}`, 250),
    TemplateCode: templateCode,
    StartedAt: startedAt.toISOString(),
    FinishedAt: finishedAt.toISOString(),
    Username: truncateText(log.username || '', 100),
    ExecutionStatus: truncateText(log.status || 'unknown', 50),
    RowsCount: Number.isFinite(log.rowsCount) ? log.rowsCount : 0,
    ErrorMessage: truncateText(log.errorMessage || '', 4000)
  };

  try {
    const created = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(schema.classNames.log)}/cards`, authToken, {
      method: 'POST',
      body: payload
    });
    return {
      success: created.ok,
      cmdbuildStatus: created.statusCode,
      className: schema.classNames.log,
      log: created.ok ? sanitizeExecutionLogCard(created.json && created.json.data) : null
    };
  } catch (error) {
    return {
      success: false,
      cmdbuildStatus: 0,
      className: schema.classNames.log,
      message: error && error.message ? error.message : String(error)
    };
  }
}

async function listExecutionLogCards(authToken, root, requestUrl) {
  const schema = buildTechnicalSchema(root);
  const limit = getPositiveInt(requestUrl.searchParams, 'limit', 100, 1000);
  const start = getPositiveInt(requestUrl.searchParams, 'start', 0, 100000);
  const cards = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(schema.classNames.log)}/cards?limit=${limit}&start=${start}`, authToken);
  return {
    schema,
    response: cards,
    cards: Array.isArray(cards.json && cards.json.data) ? cards.json.data : [],
    meta: cards.json && cards.json.meta ? cards.json.meta : null
  };
}

async function listTemplateCards(authToken, root, requestUrl) {
  const schema = buildTechnicalSchema(root);
  const limit = getPositiveInt(requestUrl.searchParams, 'limit', 100, 1000);
  const start = getPositiveInt(requestUrl.searchParams, 'start', 0, 100000);
  const cards = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(schema.classNames.template)}/cards?limit=${limit}&start=${start}`, authToken);
  return {
    schema,
    response: cards,
    cards: Array.isArray(cards.json && cards.json.data) ? cards.json.data : [],
    meta: cards.json && cards.json.meta ? cards.json.meta : null
  };
}

async function findTemplateCard(authToken, root, code) {
  const schema = buildTechnicalSchema(root);
  const templateCode = validateCmdbuildIdentifier(code, 'template code');
  const cards = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(schema.classNames.template)}/cards?limit=1000`, authToken);
  const data = Array.isArray(cards.json && cards.json.data) ? cards.json.data : [];
  return {
    schema,
    response: cards,
    card: data.find((item) => item.Code === templateCode) || null
  };
}

function validateTemplateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ path: '$', message: 'Template spec must be an object.' }];
  }
  if (spec.version !== 1) {
    errors.push({ path: '$.version', message: 'Only DSL version 1 is supported.' });
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    errors.push({ path: '$.steps', message: 'Template spec must contain at least one step.' });
  } else {
    spec.steps.forEach((step, index) => {
      const path = `$.steps[${index}]`;
      if (!step || typeof step !== 'object') {
        errors.push({ path, message: 'Step must be an object.' });
        return;
      }
      if (!step.as || typeof step.as !== 'string') {
        errors.push({ path: `${path}.as`, message: 'Step must define a string result alias.' });
      }
      if (step.type === 'findClassesByAttributeType') {
        if (!step.attributeType && !step.attributeTypeParam) {
          errors.push({ path, message: 'findClassesByAttributeType requires attributeType or attributeTypeParam.' });
        }
      } else if (step.type === 'listDomains') {
        // No extra fields are required for this operation.
      } else if (step.type === 'filterRows') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'filterRows requires a source alias in "from".' });
        }
        const filters = step.filters || step.where;
        if (!Array.isArray(filters) || filters.length === 0) {
          errors.push({ path: `${path}.filters`, message: 'filterRows requires a non-empty filters array.' });
        }
      } else if (step.type === 'joinRows' || step.type === 'intersectRows') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: `${step.type} requires a left source alias in "from".` });
        }
        if (!step.with || typeof step.with !== 'string') {
          errors.push({ path: `${path}.with`, message: `${step.type} requires a right source alias in "with".` });
        }
        try {
          normalizeRowOperationKeys(step);
        } catch (error) {
          errors.push({ path: `${path}.on`, message: error && error.message ? error.message : String(error) });
        }
        if (step.type === 'joinRows' && step.mode !== undefined && !['inner', 'left', 'right', 'full'].includes(step.mode)) {
          errors.push({ path: `${path}.mode`, message: 'joinRows mode must be one of inner, left, right, full.' });
        }
      } else if (step.type === 'traverseDomains') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'traverseDomains requires a source alias in "from".' });
        }
        if (step.direction !== undefined && !['both', 'source', 'destination'].includes(step.direction)) {
          errors.push({ path: `${path}.direction`, message: 'traverseDomains direction must be one of both, source, destination.' });
        }
        if (step.depthParam !== undefined && typeof step.depthParam !== 'string') {
          errors.push({ path: `${path}.depthParam`, message: 'traverseDomains depthParam must be a string parameter name.' });
        }
        if (step.depth !== undefined && (!Number.isInteger(Number(step.depth)) || Number(step.depth) <= 0)) {
          errors.push({ path: `${path}.depth`, message: 'traverseDomains depth must be a positive integer.' });
        }
      } else if (step.type === 'compareClassAttributes') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'compareClassAttributes requires a source alias in "from".' });
        }
        if (step.compareBy !== undefined) {
          const allowed = ['name', 'type', 'domain', 'targetClass', 'lookupType', 'mandatory', 'inherited'];
          const invalid = !Array.isArray(step.compareBy) || step.compareBy.some((field) => !allowed.includes(field));
          if (invalid) {
            errors.push({ path: `${path}.compareBy`, message: `compareBy must contain only: ${allowed.join(', ')}.` });
          }
        }
      } else {
        errors.push({ path: `${path}.type`, message: `Unsupported step type: ${step.type}` });
      }
    });
  }

  if (!spec.result || !Array.isArray(spec.result.tables) || spec.result.tables.length === 0) {
    errors.push({ path: '$.result.tables', message: 'Template spec must define at least one result table.' });
  } else {
    spec.result.tables.forEach((table, index) => {
      const path = `$.result.tables[${index}]`;
      if (!table || typeof table !== 'object') {
        errors.push({ path, message: 'Result table must be an object.' });
        return;
      }
      if (!table.name || typeof table.name !== 'string') {
        errors.push({ path: `${path}.name`, message: 'Result table must reference a named step result.' });
      }
      if (table.columns !== undefined && !Array.isArray(table.columns)) {
        errors.push({ path: `${path}.columns`, message: 'Result table columns must be an array.' });
      }
    });
  }

  return errors;
}

function projectRows(rows, columns) {
  if (!Array.isArray(columns) || columns.length === 0) return rows;
  return rows.map((row) => {
    const projected = {};
    columns.forEach((column) => {
      projected[column] = row[column] === undefined ? null : row[column];
    });
    return projected;
  });
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function getFilterExpected(filter, params) {
  if (Object.prototype.hasOwnProperty.call(filter, 'valueParam')) {
    return params[filter.valueParam];
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'valuesParam')) {
    return params[filter.valuesParam];
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'value')) {
    return filter.value;
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'values')) {
    return filter.values;
  }
  return undefined;
}

function normalizeFilterValue(value, caseSensitive) {
  const text = value === null || value === undefined ? '' : String(value);
  return caseSensitive ? text : text.toLowerCase();
}

function rowMatchesFilter(row, filter, params) {
  const column = filter.column || filter.field;
  if (!column || typeof column !== 'string') {
    throw new Error('filterRows filter requires column.');
  }

  const op = filter.op || 'equals';
  const caseSensitive = Boolean(filter.caseSensitive);
  const actualRaw = row[column];
  const actual = normalizeFilterValue(actualRaw, caseSensitive);
  const expectedRaw = getFilterExpected(filter, params);

  if (op === 'exists') {
    return actualRaw !== null && actualRaw !== undefined && actualRaw !== '';
  }
  if (op === 'notExists') {
    return actualRaw === null || actualRaw === undefined || actualRaw === '';
  }

  const expected = Array.isArray(expectedRaw)
    ? expectedRaw.map((value) => normalizeFilterValue(value, caseSensitive))
    : normalizeFilterValue(expectedRaw, caseSensitive);

  if (op === 'equals') return actual === expected;
  if (op === 'notEquals') return actual !== expected;
  if (op === 'contains') return actual.includes(expected);
  if (op === 'startsWith') return actual.startsWith(expected);
  if (op === 'endsWith') return actual.endsWith(expected);
  if (op === 'in') return Array.isArray(expected) && expected.includes(actual);

  throw new Error(`Unsupported filterRows operator: ${op}`);
}

function executeFilterRows(step, params, context, limits) {
  const source = context[step.from];
  if (!source) {
    throw new Error(`filterRows source not found: ${step.from}`);
  }
  const filters = step.filters || step.where || [];
  const rows = [];
  for (const row of source.rows || []) {
    const matched = filters.every((filter) => rowMatchesFilter(row, filter, params));
    if (!matched) continue;
    rows.push(row);
    if (rows.length >= limits.maxRows) {
      return {
        columns: source.columns || [],
        rows,
        truncated: true
      };
    }
  }
  return {
    columns: source.columns || [],
    rows,
    truncated: Boolean(source.truncated)
  };
}

function inferColumns(source) {
  if (source && Array.isArray(source.columns) && source.columns.length) {
    return source.columns;
  }
  const columns = [];
  for (const row of source && Array.isArray(source.rows) ? source.rows : []) {
    Object.keys(row || {}).forEach((column) => {
      if (!columns.includes(column)) columns.push(column);
    });
  }
  return columns;
}

function normalizeRowOperationKeys(step) {
  const pairs = [];
  const source = step.on !== undefined
    ? step.on
    : step.column || step.columns || (step.leftColumn && step.rightColumn ? [{ left: step.leftColumn, right: step.rightColumn }] : undefined);
  const items = Array.isArray(source) ? source : [source];

  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      pairs.push({ left: item.trim(), right: item.trim() });
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const left = item.left || item.leftColumn || item.from || item.column;
      const right = item.right || item.rightColumn || item.with || item.column;
      if (typeof left === 'string' && left.trim() && typeof right === 'string' && right.trim()) {
        pairs.push({ left: left.trim(), right: right.trim() });
      }
    }
  }

  if (!pairs.length) {
    throw new Error('Row operation requires "on" keys, for example "on": "Class" or "on": [{"left":"Class","right":"RelatedClass"}].');
  }
  return pairs;
}

function normalizeRowKeyValue(value, caseSensitive) {
  const text = value === null || value === undefined ? '' : String(value);
  return caseSensitive ? text : text.toLowerCase();
}

function buildRowOperationKey(row, columns, caseSensitive) {
  return JSON.stringify(columns.map((column) => normalizeRowKeyValue(row[column], caseSensitive)));
}

function buildRowIndex(rows, columns, caseSensitive) {
  const index = new Map();
  for (const row of rows) {
    const key = buildRowOperationKey(row, columns, caseSensitive);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  return index;
}

function buildRightColumnMapping(leftColumns, rightColumns, keyPairs, step) {
  const rightPrefix = step.rightPrefix === undefined ? 'Right_' : String(step.rightPrefix || 'Right_');
  const includeRightKeys = Boolean(step.includeRightKeys);
  const leftColumnSet = new Set(leftColumns);
  const rightKeyColumns = new Set(keyPairs.map((pair) => pair.right));
  const columns = leftColumns.slice();
  const mapping = [];

  for (const column of rightColumns) {
    if (!includeRightKeys && rightKeyColumns.has(column)) continue;
    const target = leftColumnSet.has(column) || columns.includes(column) ? `${rightPrefix}${column}` : column;
    mapping.push({ source: column, target });
    if (!columns.includes(target)) columns.push(target);
  }

  return { columns, mapping };
}

function mergeJoinRows(leftRow, rightRow, leftColumns, keyPairs, rightMapping) {
  const row = {};
  for (const column of leftColumns) {
    row[column] = leftRow && leftRow[column] !== undefined ? leftRow[column] : null;
  }
  if (!leftRow && rightRow) {
    for (const pair of keyPairs) {
      if (row[pair.left] === null || row[pair.left] === undefined) {
        row[pair.left] = rightRow[pair.right] === undefined ? null : rightRow[pair.right];
      }
    }
  }
  for (const item of rightMapping) {
    row[item.target] = rightRow && rightRow[item.source] !== undefined ? rightRow[item.source] : null;
  }
  return row;
}

function executeJoinRows(step, context, limits) {
  const left = context[step.from];
  const right = context[step.with];
  if (!left) throw new Error(`joinRows source not found: ${step.from}`);
  if (!right) throw new Error(`joinRows source not found: ${step.with}`);

  const mode = step.mode || 'inner';
  const keyPairs = normalizeRowOperationKeys(step);
  const leftKeyColumns = keyPairs.map((pair) => pair.left);
  const rightKeyColumns = keyPairs.map((pair) => pair.right);
  const caseSensitive = step.caseSensitive !== false;
  const leftRows = Array.isArray(left.rows) ? left.rows : [];
  const rightRows = Array.isArray(right.rows) ? right.rows : [];
  const leftColumns = inferColumns(left);
  const rightColumns = inferColumns(right);
  const rightIndex = buildRowIndex(rightRows, rightKeyColumns, caseSensitive);
  const { columns, mapping } = buildRightColumnMapping(leftColumns, rightColumns, keyPairs, step);
  const rows = [];
  const matchedRightRows = new Set();

  for (const leftRow of leftRows) {
    const key = buildRowOperationKey(leftRow, leftKeyColumns, caseSensitive);
    const matches = rightIndex.get(key) || [];
    if (matches.length) {
      for (const rightRow of matches) {
        matchedRightRows.add(rightRow);
        rows.push(mergeJoinRows(leftRow, rightRow, leftColumns, keyPairs, mapping));
        if (rows.length >= limits.maxRows) return { columns, rows, truncated: true };
      }
    } else if (mode === 'left' || mode === 'full') {
      rows.push(mergeJoinRows(leftRow, null, leftColumns, keyPairs, mapping));
      if (rows.length >= limits.maxRows) return { columns, rows, truncated: true };
    }
  }

  if (mode === 'right' || mode === 'full') {
    for (const rightRow of rightRows) {
      if (matchedRightRows.has(rightRow)) continue;
      rows.push(mergeJoinRows(null, rightRow, leftColumns, keyPairs, mapping));
      if (rows.length >= limits.maxRows) return { columns, rows, truncated: true };
    }
  }

  return {
    columns,
    rows,
    truncated: Boolean(left.truncated || right.truncated)
  };
}

function executeIntersectRows(step, context, limits) {
  const left = context[step.from];
  const right = context[step.with];
  if (!left) throw new Error(`intersectRows source not found: ${step.from}`);
  if (!right) throw new Error(`intersectRows source not found: ${step.with}`);

  const keyPairs = normalizeRowOperationKeys(step);
  const leftKeyColumns = keyPairs.map((pair) => pair.left);
  const rightKeyColumns = keyPairs.map((pair) => pair.right);
  const caseSensitive = step.caseSensitive !== false;
  const distinct = step.distinct !== false;
  const rightRows = Array.isArray(right.rows) ? right.rows : [];
  const rightIndex = buildRowIndex(rightRows, rightKeyColumns, caseSensitive);
  const rows = [];
  const seenKeys = new Set();

  for (const leftRow of Array.isArray(left.rows) ? left.rows : []) {
    const key = buildRowOperationKey(leftRow, leftKeyColumns, caseSensitive);
    if (!rightIndex.has(key)) continue;
    if (distinct && seenKeys.has(key)) continue;
    seenKeys.add(key);
    rows.push(leftRow);
    if (rows.length >= limits.maxRows) {
      return {
        columns: inferColumns(left),
        rows,
        truncated: true
      };
    }
  }

  return {
    columns: inferColumns(left),
    rows,
    truncated: Boolean(left.truncated || right.truncated)
  };
}

function createExecutionRequest(authToken, limits) {
  let restCalls = 0;
  const request = async (path) => {
    restCalls += 1;
    if (restCalls > limits.maxRestCalls) {
      throw new Error(`Template execution exceeded REST call limit (${limits.maxRestCalls}).`);
    }
    return cmdbuildRequest(path, authToken);
  };
  request.getRestCalls = () => restCalls;
  return request;
}

async function executeFindClassesByAttributeType(cmdbuildExecRequest, step, params, limits) {
  const attrType = step.attributeType || params[step.attributeTypeParam];
  if (!attrType) {
    throw new Error(`Missing attribute type parameter: ${step.attributeTypeParam}`);
  }

  const classes = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes?limit=${limits.maxClasses}&detailed=true`);
  if (!classes.ok) {
    throw new Error(`CMDBuild classes request failed with status ${classes.statusCode}.`);
  }

  const rows = [];
  const classItems = Array.isArray(classes.json && classes.json.data) ? classes.json.data : [];
  for (const classItem of classItems.slice(0, limits.maxClasses)) {
    if (classItem._can_read === false) continue;
    const attrs = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(classItem.name)}/attributes`);
    if (!attrs.ok) continue;
    const attrItems = Array.isArray(attrs.json && attrs.json.data) ? attrs.json.data : [];
    for (const attr of attrItems) {
      if (attr.type !== attrType || attr._can_read === false || attr.active === false) continue;
      rows.push({
        Class: classItem.name,
        Description: classItem._description_translation || classItem.description || '',
        Attribute: attr.name,
        AttributeDescription: attr._description_translation || attr.description || '',
        AttributeType: attr.type
      });
      if (rows.length >= limits.maxRows) {
        return {
          columns: ['Class', 'Description', 'Attribute', 'AttributeDescription', 'AttributeType'],
          rows,
          truncated: true
        };
      }
    }
  }

  return {
    columns: ['Class', 'Description', 'Attribute', 'AttributeDescription', 'AttributeType'],
    rows,
    truncated: false
  };
}

async function executeListDomains(cmdbuildExecRequest, limits) {
  const domains = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/domains?limit=${limits.maxDomains}`);
  if (!domains.ok) {
    throw new Error(`CMDBuild domains request failed with status ${domains.statusCode}.`);
  }

  const rows = [];
  const domainItems = Array.isArray(domains.json && domains.json.data) ? domains.json.data : [];
  for (const domain of domainItems.slice(0, limits.maxDomains)) {
    const detail = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/domains/${encodeURIComponent(domain.name)}`);
    const item = detail.ok && detail.json && detail.json.data ? detail.json.data : domain;
    rows.push({
      Domain: item.name,
      Description: item._description_translation || item.description || '',
      Source: item.source || '',
      Destination: item.destination || '',
      Cardinality: item.cardinality || ''
    });
    if (rows.length >= limits.maxRows) {
      return {
        columns: ['Domain', 'Description', 'Source', 'Destination', 'Cardinality'],
        rows,
        truncated: true
      };
    }
  }

  return {
    columns: ['Domain', 'Description', 'Source', 'Destination', 'Cardinality'],
    rows,
    truncated: false
  };
}

async function executeTraverseDomains(cmdbuildExecRequest, step, params, context, limits) {
  const source = context[step.from];
  if (!source) {
    throw new Error(`traverseDomains source not found: ${step.from}`);
  }

  const classColumn = step.classColumn || 'Class';
  const classNames = uniqueStrings((source.rows || []).map((row) => row[classColumn])).slice(0, limits.maxClasses);
  const direction = step.direction || 'both';
  const requestedDepth = step.depthParam ? params[step.depthParam] : step.depth;
  const maxDepth = toPositiveInt(requestedDepth, limits.traversalDepthDefault, limits.maxTraversalDepth);
  const domains = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/domains?limit=${limits.maxDomains}`);
  if (!domains.ok) {
    throw new Error(`CMDBuild domains request failed with status ${domains.statusCode}.`);
  }

  const domainItems = Array.isArray(domains.json && domains.json.data) ? domains.json.data : [];
  const detailedDomains = [];
  for (const domain of domainItems.slice(0, limits.maxDomains)) {
    const detail = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/domains/${encodeURIComponent(domain.name)}`);
    const item = detail.ok && detail.json && detail.json.data ? detail.json.data : domain;
    detailedDomains.push(item);
  }

  const rows = [];
  const seenClasses = new Set(classNames);
  const seenEdges = new Set();
  let frontier = classNames;

  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const nextFrontier = [];

    for (const item of detailedDomains) {
      const sourceName = item.source || '';
      const destinationName = item.destination || '';

      for (const className of frontier) {
        const sourceMatch = className === sourceName;
        const destinationMatch = className === destinationName;
        if (direction === 'source' && !sourceMatch) continue;
        if (direction === 'destination' && !destinationMatch) continue;
        if (direction === 'both' && !sourceMatch && !destinationMatch) continue;
        const relatedClass = sourceMatch ? destinationName : sourceName;
        const edgeKey = `${depth}|${className}|${item.name}|${relatedClass}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        rows.push({
          Depth: depth,
          Class: className,
          Domain: item.name,
          Description: item._description_translation || item.description || '',
          Source: sourceName,
          Destination: destinationName,
          Direction: sourceMatch ? 'source' : 'destination',
          RelatedClass: relatedClass,
          Cardinality: item.cardinality || ''
        });
        if (relatedClass && !seenClasses.has(relatedClass)) {
          seenClasses.add(relatedClass);
          nextFrontier.push(relatedClass);
        }
        if (rows.length >= limits.maxRows) {
          return {
            columns: ['Depth', 'Class', 'Domain', 'Description', 'Source', 'Destination', 'Direction', 'RelatedClass', 'Cardinality'],
            rows,
            truncated: true
          };
        }
      }
    }
    frontier = uniqueStrings(nextFrontier).slice(0, limits.maxClasses);
  }

  return {
    columns: ['Depth', 'Class', 'Domain', 'Description', 'Source', 'Destination', 'Direction', 'RelatedClass', 'Cardinality'],
    rows,
    truncated: false
  };
}

function normalizeAttributeCompareFields(fields) {
  const allowed = ['name', 'type', 'domain', 'targetClass', 'lookupType', 'mandatory', 'inherited'];
  const input = Array.isArray(fields) && fields.length ? fields : ['name', 'type'];
  return input.filter((field, index) => allowed.includes(field) && input.indexOf(field) === index);
}

function getAttributeCompareValue(attribute, field) {
  if (field === 'name') return attribute.name || '';
  if (field === 'type') return attribute.type || '';
  if (field === 'domain') return attribute.domain || '';
  if (field === 'targetClass') return attribute.targetClass || '';
  if (field === 'lookupType') return attribute.lookupType || '';
  if (field === 'mandatory') return attribute.mandatory === undefined ? '' : String(Boolean(attribute.mandatory));
  if (field === 'inherited') return attribute.inherited === undefined ? '' : String(Boolean(attribute.inherited));
  return '';
}

function buildAttributeSignature(attribute, fields) {
  return fields
    .map((field) => `${field}:${String(getAttributeCompareValue(attribute, field)).toLowerCase()}`)
    .join('|');
}

function formatAttributeForCompare(attribute) {
  const name = attribute.name || '';
  const type = attribute.type || '';
  if (!type) return name;
  return `${name}:${type}`;
}

async function readClassAttributeMap(cmdbuildExecRequest, className, compareFields, includeInherited) {
  const attrs = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/attributes`);
  if (!attrs.ok) {
    return {
      className,
      signatures: new Map(),
      readStatus: attrs.statusCode
    };
  }

  const signatures = new Map();
  const attrItems = Array.isArray(attrs.json && attrs.json.data) ? attrs.json.data : [];
  for (const attr of attrItems) {
    if (attr.active === false || attr._can_read === false) continue;
    if (!includeInherited && attr.inherited === true) continue;
    const signature = buildAttributeSignature(attr, compareFields);
    if (!signature) continue;
    if (!signatures.has(signature)) {
      signatures.set(signature, formatAttributeForCompare(attr));
    }
  }

  return {
    className,
    signatures,
    readStatus: attrs.statusCode
  };
}

async function executeCompareClassAttributes(cmdbuildExecRequest, step, params, context, limits) {
  const source = context[step.from];
  if (!source) {
    throw new Error(`compareClassAttributes source not found: ${step.from}`);
  }

  const classColumn = step.classColumn || 'Class';
  const compareFields = normalizeAttributeCompareFields(step.compareBy);
  const includeInherited = Boolean(step.includeInherited);
  const minCommon = toPositiveInt(step.minCommon, 1, 100000);
  const referenceClass = step.referenceClass || params[step.referenceClassParam];
  const classNames = uniqueStrings((source.rows || []).map((row) => row[classColumn]));
  const classesToRead = uniqueStrings(referenceClass ? [referenceClass].concat(classNames) : classNames).slice(0, limits.maxClasses);
  const attributeMaps = new Map();

  for (const className of classesToRead) {
    attributeMaps.set(className, await readClassAttributeMap(cmdbuildExecRequest, className, compareFields, includeInherited));
  }

  const pairs = [];
  if (referenceClass) {
    for (const className of classNames) {
      if (className !== referenceClass) pairs.push([referenceClass, className]);
    }
  } else {
    for (let left = 0; left < classesToRead.length; left += 1) {
      for (let right = left + 1; right < classesToRead.length; right += 1) {
        pairs.push([classesToRead[left], classesToRead[right]]);
      }
    }
  }

  const rows = [];
  for (const pair of pairs) {
    const left = attributeMaps.get(pair[0]);
    const right = attributeMaps.get(pair[1]);
    if (!left || !right) continue;
    const leftKeys = Array.from(left.signatures.keys());
    const rightKeys = Array.from(right.signatures.keys());
    const commonKeys = leftKeys.filter((key) => right.signatures.has(key));
    if (commonKeys.length < minCommon) continue;
    const leftOnlyKeys = leftKeys.filter((key) => !right.signatures.has(key));
    const rightOnlyKeys = rightKeys.filter((key) => !left.signatures.has(key));

    rows.push({
      Class: left.className,
      ComparedClass: right.className,
      CompareBy: compareFields.join(','),
      CommonCount: commonKeys.length,
      ClassOnlyCount: leftOnlyKeys.length,
      ComparedClassOnlyCount: rightOnlyKeys.length,
      CommonAttributes: truncateText(commonKeys.map((key) => left.signatures.get(key)).join(', '), 1000),
      ClassOnlyAttributes: truncateText(leftOnlyKeys.map((key) => left.signatures.get(key)).join(', '), 1000),
      ComparedClassOnlyAttributes: truncateText(rightOnlyKeys.map((key) => right.signatures.get(key)).join(', '), 1000)
    });

    if (rows.length >= limits.maxRows) {
      return {
        columns: ['Class', 'ComparedClass', 'CompareBy', 'CommonCount', 'ClassOnlyCount', 'ComparedClassOnlyCount', 'CommonAttributes', 'ClassOnlyAttributes', 'ComparedClassOnlyAttributes'],
        rows,
        truncated: true
      };
    }
  }

  return {
    columns: ['Class', 'ComparedClass', 'CompareBy', 'CommonCount', 'ClassOnlyCount', 'ComparedClassOnlyCount', 'CommonAttributes', 'ClassOnlyAttributes', 'ComparedClassOnlyAttributes'],
    rows,
    truncated: false
  };
}

async function executeTemplateSpec(authToken, spec, params, options = {}) {
  const maxRowsMax = Math.min(options.maxRowsMax || ABSOLUTE_EXECUTION_LIMITS.maxRows, ABSOLUTE_EXECUTION_LIMITS.maxRows);
  const maxClassesMax = Math.min(options.maxClassesMax || ABSOLUTE_EXECUTION_LIMITS.maxClasses, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const maxDomainsMax = Math.min(options.maxDomainsMax || ABSOLUTE_EXECUTION_LIMITS.maxDomains, ABSOLUTE_EXECUTION_LIMITS.maxDomains);
  const maxRestCallsMax = Math.min(options.maxRestCallsMax || ABSOLUTE_EXECUTION_LIMITS.maxRestCalls, ABSOLUTE_EXECUTION_LIMITS.maxRestCalls);
  const maxTraversalDepthMax = Math.min(options.maxTraversalDepthMax || ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth, ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth);
  const limits = {
    maxClasses: Math.min(options.maxClasses || 100, maxClassesMax),
    maxDomains: Math.min(options.maxDomains || 100, maxDomainsMax),
    maxRows: Math.min(options.maxRows || 500, maxRowsMax),
    maxRestCalls: Math.min(options.maxRestCalls || 250, maxRestCallsMax),
    maxTraversalDepth: Math.min(options.maxTraversalDepth || maxTraversalDepthMax, maxTraversalDepthMax),
    traversalDepthDefault: Math.min(options.traversalDepthDefault || 1, maxTraversalDepthMax)
  };
  const context = {};
  const cmdbuildExecRequest = createExecutionRequest(authToken, limits);

  for (const step of spec.steps) {
    if (step.type === 'findClassesByAttributeType') {
      context[step.as] = await executeFindClassesByAttributeType(cmdbuildExecRequest, step, params, limits);
    } else if (step.type === 'listDomains') {
      context[step.as] = await executeListDomains(cmdbuildExecRequest, limits);
    } else if (step.type === 'filterRows') {
      context[step.as] = executeFilterRows(step, params, context, limits);
    } else if (step.type === 'joinRows') {
      context[step.as] = executeJoinRows(step, context, limits);
    } else if (step.type === 'intersectRows') {
      context[step.as] = executeIntersectRows(step, context, limits);
    } else if (step.type === 'traverseDomains') {
      context[step.as] = await executeTraverseDomains(cmdbuildExecRequest, step, params, context, limits);
    } else if (step.type === 'compareClassAttributes') {
      context[step.as] = await executeCompareClassAttributes(cmdbuildExecRequest, step, params, context, limits);
    } else {
      throw new Error(`Unsupported step type: ${step.type}`);
    }
  }

  const tables = spec.result.tables.map((table) => {
    const source = context[table.name] || { columns: [], rows: [], truncated: false };
    const columns = Array.isArray(table.columns) && table.columns.length ? table.columns : source.columns;
    return {
      name: table.name,
      columns,
      rows: projectRows(source.rows, columns),
      truncated: Boolean(source.truncated)
    };
  });

  return {
    limits: {
      ...limits,
      restCalls: cmdbuildExecRequest.getRestCalls(),
      requestTimeoutMs: CMDBUILD_REQUEST_TIMEOUT_MS
    },
    tables
  };
}

async function handleBackend(req, res, requestUrl) {
  const authToken = getCookieValue(req.headers.cookie, 'CMDBuild-Authorization');
  if (!authToken) {
    sendJson(res, 401, {
      success: false,
      receivedCmdbuildCookie: false,
      message: 'CMDBuild-Authorization cookie was not sent to backend route.'
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/session` || requestUrl.pathname === `${BACKEND_PREFIX}/session-probe`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const session = await cmdbuildRequest('/cmdbuild/services/rest/v3/sessions/current', authToken);
    sendJson(res, session.ok ? 200 : 502, {
      success: session.ok,
      receivedCmdbuildCookie: true,
      forwardedAs: 'CMDBuild-Authorization header',
      cmdbuildStatus: session.statusCode,
      session: sanitizeSession(session.json && session.json.data)
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/csrf`) {
    if (!methodAllowed(req, res, 'GET')) return;
    sendJson(res, 200, {
      success: true,
      token: getCsrfToken(authToken)
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/model/classes`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const classes = await cmdbuildRequest(buildListPath('/cmdbuild/services/rest/v3/classes', requestUrl, {
      limit: 100,
      maxLimit: 500,
      detailed: true
    }), authToken);
    sendJson(res, classes.ok ? 200 : 502, {
      success: classes.ok,
      cmdbuildStatus: classes.statusCode,
      data: Array.isArray(classes.json && classes.json.data)
        ? classes.json.data.map(sanitizeClass)
        : [],
      meta: classes.json && classes.json.meta ? classes.json.meta : null
    });
    return;
  }

  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/model/classes/`)) {
    if (!methodAllowed(req, res, 'GET')) return;
    const suffix = requestUrl.pathname.slice(`${BACKEND_PREFIX}/model/classes/`.length);
    const parts = suffix.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const className = parts[0];
    const action = parts[1];
    if (!className || action !== 'attributes' || parts.length !== 2) {
      sendJson(res, 404, {
        success: false,
        message: `Unknown model class route: ${requestUrl.pathname}`
      });
      return;
    }

    const attributes = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/attributes`, authToken);
    sendJson(res, attributes.ok ? 200 : 502, {
      success: attributes.ok,
      cmdbuildStatus: attributes.statusCode,
      className,
      data: Array.isArray(attributes.json && attributes.json.data)
        ? attributes.json.data.map(sanitizeAttribute)
        : [],
      meta: attributes.json && attributes.json.meta ? attributes.json.meta : null
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/model/domains`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const includeDetails = getBoolean(requestUrl.searchParams, 'details', false);
    const domains = await cmdbuildRequest(buildListPath('/cmdbuild/services/rest/v3/domains', requestUrl, {
      limit: 100,
      maxLimit: 500,
      detailed: false
    }), authToken);
    let data = Array.isArray(domains.json && domains.json.data)
      ? domains.json.data.map(sanitizeDomain)
      : [];

    if (domains.ok && includeDetails) {
      const maxDetails = getPositiveInt(requestUrl.searchParams, 'maxDetails', 50, 200);
      const detailedDomains = await Promise.all(data.slice(0, maxDetails).map(async (domain) => {
        const detail = await cmdbuildRequest(`/cmdbuild/services/rest/v3/domains/${encodeURIComponent(domain.name)}`, authToken);
        return detail.ok ? sanitizeDomain(detail.json && detail.json.data) : {
          ...domain,
          detailErrorStatus: detail.statusCode
        };
      }));
      data = detailedDomains.concat(data.slice(maxDetails));
    }

    sendJson(res, domains.ok ? 200 : 502, {
      success: domains.ok,
      cmdbuildStatus: domains.statusCode,
      detailsIncluded: includeDetails,
      data,
      meta: domains.json && domains.json.meta ? domains.json.meta : null
    });
    return;
  }

  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/model/domains/`)) {
    if (!methodAllowed(req, res, 'GET')) return;
    const domainName = decodeURIComponent(requestUrl.pathname.slice(`${BACKEND_PREFIX}/model/domains/`.length));
    if (!domainName || domainName.includes('/')) {
      sendJson(res, 404, {
        success: false,
        message: `Unknown model domain route: ${requestUrl.pathname}`
      });
      return;
    }
    const domain = await cmdbuildRequest(`/cmdbuild/services/rest/v3/domains/${encodeURIComponent(domainName)}`, authToken);
    sendJson(res, domain.ok ? 200 : 502, {
      success: domain.ok,
      cmdbuildStatus: domain.statusCode,
      domain: domain.ok ? sanitizeDomain(domain.json && domain.json.data) : null
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/auth/capabilities`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const session = await cmdbuildRequest('/cmdbuild/services/rest/v3/sessions/current', authToken);
    const roles = await cmdbuildRequest('/cmdbuild/services/rest/v3/roles?limit=100', authToken);
    const users = await cmdbuildRequest('/cmdbuild/services/rest/v3/users?limit=1', authToken);
    const groups = await cmdbuildRequest('/cmdbuild/services/rest/v3/groups?limit=1', authToken);
    const currentRoleName = session.json && session.json.data ? session.json.data.role : '';
    const currentRole = currentRoleName
      ? await cmdbuildRequest(`/cmdbuild/services/rest/v3/roles/${encodeURIComponent(currentRoleName)}`, authToken)
      : { ok: false, statusCode: 0, json: null };

    sendJson(res, session.ok ? 200 : 502, {
      success: session.ok,
      cmdbuildStatus: session.statusCode,
      session: sanitizeSession(session.json && session.json.data),
      capabilities: {
        roleCatalogAvailable: roles.ok,
        userCatalogAvailable: users.ok,
        groupsEndpointAvailable: groups.ok,
        currentRoleDetailsAvailable: currentRole.ok,
        editorPermissionStrategy: 'cmdbuild-class-crud',
        notes: [
          'CMDBuild exposes roles through /roles.',
          'CMDBuild user details expose assigned roles as userGroups.',
          'No separate editor list is planned before technical class CRUD checks are implemented.'
        ]
      },
      roles: roles.ok && Array.isArray(roles.json && roles.json.data)
        ? roles.json.data.map(sanitizeRole)
        : [],
      currentRole: currentRole.ok ? sanitizeRole(currentRole.json && currentRole.json.data) : null,
      probes: {
        rolesStatus: roles.statusCode,
        usersStatus: users.statusCode,
        groupsStatus: groups.statusCode,
        currentRoleStatus: currentRole.statusCode
      }
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/schema`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const schema = await checkOrCreateTechnicalSchema(authToken, root, false);
    sendJson(res, 200, {
      success: true,
      schema
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/schema/bootstrap`) {
    if (!methodAllowed(req, res, 'POST')) return;
    if (!requireStateChangingRequest(req, res, authToken)) return;
    if (!(await requireAdminClassesModify(authToken, res))) return;
    const body = await readJsonBody(req);
    const root = body.root || requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const schema = await checkOrCreateTechnicalSchema(authToken, root, true);
    sendJson(res, schema.ready ? 200 : 502, {
      success: schema.ready,
      schema
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/execution-logs`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const list = await listExecutionLogCards(authToken, root, requestUrl);
    sendJson(res, list.response.ok ? 200 : 502, {
      success: list.response.ok,
      cmdbuildStatus: list.response.statusCode,
      root: list.schema.root,
      className: list.schema.classNames.log,
      data: list.cards.map(sanitizeExecutionLogCard),
      meta: list.meta
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/config`) {
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;

    if (req.method === 'GET') {
      const found = await findConfigCard(authToken, root);
      sendJson(res, found.response.ok ? 200 : 502, {
        success: found.response.ok,
        cmdbuildStatus: found.response.statusCode,
        root: found.schema.root,
        className: found.schema.classNames.config,
        config: sanitizeConfigCard(found.card, found.schema.root)
      });
      return;
    }

    if (req.method === 'PUT') {
      if (!requireStateChangingRequest(req, res, authToken)) return;
      const body = await readJsonBody(req);
      const found = await findConfigCard(authToken, root);
      if (!found.response.ok) {
        sendJson(res, 502, {
          success: false,
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.config
        });
        return;
      }

      const payload = normalizeConfigPayload(body, found.schema.root);
      const saved = found.card
        ? await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(found.schema.classNames.config)}/cards/${encodeURIComponent(found.card._id)}`, authToken, {
          method: 'PUT',
          body: payload
        })
        : await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(found.schema.classNames.config)}/cards`, authToken, {
          method: 'POST',
          body: payload
        });
      sendJson(res, saved.ok ? 200 : 502, {
        success: saved.ok,
        cmdbuildStatus: saved.statusCode,
        root: found.schema.root,
        className: found.schema.classNames.config,
        config: sanitizeConfigCard(saved.json && saved.json.data, found.schema.root)
      });
      return;
    }

    methodAllowed(req, res, ['GET', 'PUT']);
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/templates`) {
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;

    if (req.method === 'GET') {
      const list = await listTemplateCards(authToken, root, requestUrl);
      sendJson(res, list.response.ok ? 200 : 502, {
        success: list.response.ok,
        cmdbuildStatus: list.response.statusCode,
        root: list.schema.root,
        className: list.schema.classNames.template,
        data: list.cards.map(sanitizeTemplateCard),
        meta: list.meta
      });
      return;
    }

    if (req.method === 'POST') {
      if (!requireStateChangingRequest(req, res, authToken)) return;
      const body = await readJsonBody(req);
      const session = await getSessionData(authToken);
      const payload = normalizeTemplatePayload(body, null, session.data && session.data.username);
      const existing = await findTemplateCard(authToken, root, payload.Code);
      if (existing.response.ok && existing.card) {
        sendJson(res, 409, {
          success: false,
          message: `Template already exists: ${payload.Code}`
        });
        return;
      }

      const created = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(existing.schema.classNames.template)}/cards`, authToken, {
        method: 'POST',
        body: payload
      });
      const versionLog = created.ok
        ? await writeTemplateVersion(authToken, existing.schema.root, payload.Code, safeJsonValue(payload.SpecJson, null), session.data && session.data.username, body.changeComment || 'create')
        : null;
      sendJson(res, created.ok ? 201 : 502, {
        success: created.ok,
        cmdbuildStatus: created.statusCode,
        root: existing.schema.root,
        className: existing.schema.classNames.template,
        template: sanitizeTemplateCard(created.json && created.json.data),
        versionLog
      });
      return;
    }

    methodAllowed(req, res, ['GET', 'POST']);
    return;
  }

  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/templates/`)) {
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const templateSuffix = requestUrl.pathname.slice(`${BACKEND_PREFIX}/templates/`.length);
    const templateParts = templateSuffix.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const templateCode = templateParts[0];
    const templateAction = templateParts[1] || '';

    if (!templateCode || templateParts.length > 2) {
      sendJson(res, 404, {
        success: false,
        message: `Unknown template route: ${requestUrl.pathname}`
      });
      return;
    }

    if (templateAction) {
      if (templateAction === 'versions') {
        if (!methodAllowed(req, res, 'GET')) return;
        const versions = await listTemplateVersionCards(authToken, root, templateCode, requestUrl);
        sendJson(res, versions.response.ok ? 200 : 502, {
          success: versions.response.ok,
          cmdbuildStatus: versions.response.statusCode,
          root: versions.schema.root,
          className: versions.schema.classNames.version,
          templateCode,
          data: versions.cards.map(sanitizeTemplateVersionCard),
          meta: versions.meta
        });
        return;
      }
      if (!['validate', 'preview', 'run'].includes(templateAction)) {
        sendJson(res, 404, {
          success: false,
          message: `Unknown template action: ${templateAction}`
        });
        return;
      }
      if (!methodAllowed(req, res, 'POST')) return;
      if (!requireStateChangingRequest(req, res, authToken)) return;

      const found = await findTemplateCard(authToken, root, templateCode);
      if (!found.response.ok) {
        sendJson(res, 502, {
          success: false,
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        });
        return;
      }
      if (!found.card) {
        sendJson(res, 404, {
          success: false,
          message: `Template not found: ${templateCode}`
        });
        return;
      }

      const template = sanitizeTemplateCard(found.card);
      const errors = validateTemplateSpec(template.spec);
      if (templateAction === 'validate') {
        sendJson(res, errors.length ? 400 : 200, {
          success: errors.length === 0,
          template: {
            code: template.code,
            description: template.description,
            active: template.active
          },
          errors
        });
        return;
      }
      if (errors.length) {
        sendJson(res, 400, {
          success: false,
          template: {
            code: template.code,
            description: template.description,
            active: template.active
          },
          errors
        });
        return;
      }

      const body = await readJsonBody(req);
      const params = body.params || {};
      const startedAt = new Date();
      const session = await getSessionData(authToken);
      const username = session.data && session.data.username ? session.data.username : '';
      const runtimeConfig = await getRuntimeConfig(authToken, root);
      const executionLimits = normalizeExecutionLimitConfig(runtimeConfig);
      const maxRows = templateAction === 'preview'
        ? getPositiveInt(requestUrl.searchParams, 'maxRows', executionLimits.maxRowsPreviewDefault, executionLimits.maxRowsMax)
        : getPositiveInt(requestUrl.searchParams, 'maxRows', executionLimits.maxRowsDefault, executionLimits.maxRowsMax);
      let result;
      let auditLog;
      try {
        result = await executeTemplateSpec(authToken, template.spec, params, {
          maxRows,
          maxRowsMax: executionLimits.maxRowsMax,
          maxClasses: getPositiveInt(requestUrl.searchParams, 'maxClasses', executionLimits.maxClassesDefault, executionLimits.maxClassesMax),
          maxClassesMax: executionLimits.maxClassesMax,
          maxDomains: getPositiveInt(requestUrl.searchParams, 'maxDomains', executionLimits.maxDomainsDefault, executionLimits.maxDomainsMax),
          maxDomainsMax: executionLimits.maxDomainsMax,
          maxRestCalls: getPositiveInt(requestUrl.searchParams, 'maxRestCalls', executionLimits.maxRestCallsDefault, executionLimits.maxRestCallsMax),
          maxRestCallsMax: executionLimits.maxRestCallsMax,
          maxTraversalDepth: getPositiveInt(requestUrl.searchParams, 'maxTraversalDepth', executionLimits.maxTraversalDepthMax, executionLimits.maxTraversalDepthMax),
          traversalDepthDefault: executionLimits.maxTraversalDepthDefault,
          maxTraversalDepthMax: executionLimits.maxTraversalDepthMax
        });
      } catch (error) {
        auditLog = await writeExecutionLog(authToken, root, {
          action: templateAction,
          templateCode: template.code,
          startedAt,
          finishedAt: new Date(),
          username,
          status: 'error',
          rowsCount: 0,
          errorMessage: error && error.message ? error.message : String(error)
        });
        sendJson(res, 400, {
          success: false,
          action: templateAction,
          template: {
            code: template.code,
            description: template.description,
            active: template.active
          },
          message: error && error.message ? error.message : String(error),
          auditLog
        });
        return;
      }
      auditLog = await writeExecutionLog(authToken, root, {
        action: templateAction,
        templateCode: template.code,
        startedAt,
        finishedAt: new Date(),
        username,
        status: 'ok',
        rowsCount: countResultRows(result),
        errorMessage: ''
      });
      sendJson(res, 200, {
        success: true,
        action: templateAction,
        template: {
          code: template.code,
          description: template.description,
          active: template.active
        },
        params,
        result,
        auditLog
      });
      return;
    }

    if (req.method === 'GET') {
      const found = await findTemplateCard(authToken, root, templateCode);
      if (!found.response.ok) {
        sendJson(res, 502, {
          success: false,
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        });
        return;
      }
      if (!found.card) {
        sendJson(res, 404, {
          success: false,
          message: `Template not found: ${templateCode}`
        });
        return;
      }
      sendJson(res, 200, {
        success: true,
        root: found.schema.root,
        className: found.schema.classNames.template,
        template: sanitizeTemplateCard(found.card)
      });
      return;
    }

    if (req.method === 'PUT') {
      if (!requireStateChangingRequest(req, res, authToken)) return;
      const found = await findTemplateCard(authToken, root, templateCode);
      if (!found.response.ok) {
        sendJson(res, 502, {
          success: false,
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        });
        return;
      }
      if (!found.card) {
        sendJson(res, 404, {
          success: false,
          message: `Template not found: ${templateCode}`
        });
        return;
      }

      const body = await readJsonBody(req);
      const session = await getSessionData(authToken);
      const payload = normalizeTemplatePayload(body, templateCode, session.data && session.data.username);
      const updated = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(found.schema.classNames.template)}/cards/${encodeURIComponent(found.card._id)}`, authToken, {
        method: 'PUT',
        body: payload
      });
      const versionLog = updated.ok
        ? await writeTemplateVersion(authToken, found.schema.root, payload.Code, safeJsonValue(payload.SpecJson, null), session.data && session.data.username, body.changeComment || 'update')
        : null;
      sendJson(res, updated.ok ? 200 : 502, {
        success: updated.ok,
        cmdbuildStatus: updated.statusCode,
        root: found.schema.root,
        className: found.schema.classNames.template,
        template: sanitizeTemplateCard(updated.json && updated.json.data),
        versionLog
      });
      return;
    }

    methodAllowed(req, res, ['GET', 'PUT']);
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/classes-probe`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const classes = await cmdbuildRequest('/cmdbuild/services/rest/v3/classes?limit=1', authToken);
    const firstClass = classes.json && Array.isArray(classes.json.data) ? classes.json.data[0] : null;
    sendJson(res, classes.ok ? 200 : 502, {
      success: classes.ok,
      receivedCmdbuildCookie: true,
      forwardedAs: 'CMDBuild-Authorization header',
      cmdbuildStatus: classes.statusCode,
      firstClass: firstClass ? {
        name: firstClass.name,
        description: firstClass._description_translation || firstClass.description,
        canRead: firstClass._can_read,
        canCreate: firstClass._can_create
      } : null
    });
    return;
  }

  sendJson(res, 404, {
    success: false,
    message: `Unknown backend route: ${requestUrl.pathname}`
  });
}

function proxyToCmdbuild(req, res) {
  const target = new URL(req.url || '/', CMDBUILD_ORIGIN);
  const headers = { ...req.headers };
  headers.host = req.headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`;

  const proxyReq = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    sendJson(res, 502, {
      success: false,
      message: `Proxy error: ${error.message}`
    });
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`}`);
  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/`)) {
    handleBackend(req, res, requestUrl).catch((error) => {
      sendJson(res, 500, {
        success: false,
        message: error && error.message ? error.message : String(error)
      });
    });
    return;
  }
  proxyToCmdbuild(req, res);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`cmdbdynamicpages dev proxy listening at http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Proxy target: ${CMDBUILD_ORIGIN}`);
  console.log(`Backend prefix: ${BACKEND_PREFIX}`);
});
