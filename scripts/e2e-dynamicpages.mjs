import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const cmdbuildOrigin = process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090';
const cookieJar = process.env.CMDBUILD_COOKIE_JAR || '/tmp/cmdbuild-ui-cookie.txt';
const root = process.env.CMDBDYNAMIC_ROOT || 'Cst_QueryTool';
const runtimeTemplate = process.env.CMDBDYNAMIC_E2E_TEMPLATE || 'ProbeClassesByAttributeType';
const writeTemplate = process.env.CMDBDYNAMIC_E2E_WRITE_TEMPLATE || 'CmdpE2eSmoke';
const runtimeAttrType = process.env.CMDBDYNAMIC_E2E_ATTR_TYPE || 'reference';
const relationSourceClass = process.env.CMDBDYNAMIC_E2E_RELATION_CLASS || 'IpAddress';
const relationSourceCode = process.env.CMDBDYNAMIC_E2E_RELATION_CODE || 'ctest-ip-if1';
const relationTargetClass = process.env.CMDBDYNAMIC_E2E_RELATION_TARGET || 'serveri';
const loginUsername = process.env.CMDBUILD_USERNAME || '';
const loginPassword = process.env.CMDBUILD_PASSWORD || '';
const loginRole = process.env.CMDBUILD_ROLE || '';
const loginScope = process.env.CMDBUILD_SCOPE || 'ui';
const writeMode = process.argv.includes('--write') || process.env.CMDBDYNAMIC_E2E_WRITE === '1';
const expectReadonly = process.env.CMDBDYNAMIC_EXPECT_READONLY === '1';
const sameOriginHeaders = { origin: proxyOrigin };
let cookieHeader = process.env.CMDBUILD_COOKIE_HEADER || '';
let cookieSource = cookieHeader ? 'CMDBUILD_COOKIE_HEADER' : cookieJar;

if (!cookieHeader && loginUsername && loginPassword) {
  try {
    cookieHeader = await loginCmdbuild(loginUsername, loginPassword, loginRole, loginScope);
    cookieSource = `login:${loginUsername}${loginRole ? `/${loginRole}` : ''}`;
  } catch (error) {
    console.log(`ERR login failed: ${error.message}`);
    process.exit(1);
  }
}
if (!cookieHeader) {
  cookieHeader = readCookieJar(cookieJar);
}

if (writeMode && expectReadonly) {
  console.log('ERR CMDBDYNAMIC_E2E_WRITE=1 cannot be combined with CMDBDYNAMIC_EXPECT_READONLY=1.');
  process.exit(1);
}

const draftTemplate = buildProbeTemplate('DraftProbe', 'Draft probe');
const objectGroupTemplate = buildObjectGroupTemplate();
const relationTemplate = buildRelationTemplate();
const relationChainTemplate = buildRelationChainTemplate();
const valueSearchTemplate = buildValueSearchTemplate();
const groupCompareTemplate = buildGroupCompareTemplate();
const finalViewTemplate = buildFinalViewTemplate();

function buildProbeTemplate(code, description) {
  return {
    code,
    description,
    active: true,
    spec: {
      version: 1,
      params: {
        attrType: {
          type: 'string',
          required: true,
          example: runtimeAttrType,
          description: 'CMDBuild attribute type'
        }
      },
      steps: [
        {
          type: 'findClassesByAttributeType',
          attributeTypeParam: 'attrType',
          as: 'classes'
        }
      ],
      result: {
        tables: [
          {
            name: 'classes',
            title: 'Classes by attribute type',
            mode: 'table',
            columns: ['Class', 'Description', 'Attribute', 'AttributeType']
          }
        ]
      }
    }
  };
}

function buildObjectGroupTemplate() {
  return {
    code: 'DraftObjectGroup',
    description: 'Draft object group',
    active: true,
    spec: {
      version: 1,
      params: {
        templateCode: {
          type: 'string',
          required: true,
          example: runtimeTemplate,
          description: 'Template code'
        }
      },
      visualModel: {
        version: 1,
        mode: 'objectGroup',
        params: [{ name: 'templateCode', type: 'string', required: true, example: runtimeTemplate }],
        source: {
          className: 'Cst_QueryTemplate',
          match: [{ field: 'Code', op: 'equals', param: 'templateCode' }],
          limit: 5
        },
        output: {
          alias: 'templates',
          title: 'Templates',
          columns: [
            { field: 'Code', title: 'Code' },
            { field: 'Description', title: 'Description' },
            { field: 'Active', title: 'Active' }
          ]
        }
      },
      steps: [
        {
          type: 'selectCards',
          className: 'Cst_QueryTemplate',
          filters: [{ attribute: 'Code', op: 'equals', valueParam: 'templateCode' }],
          limit: 5,
          as: 'templates'
        }
      ],
      result: {
        tables: [
          {
            name: 'templates',
            title: 'Templates',
            columns: ['Code', 'Description', 'Active']
          }
        ]
      }
    }
  };
}

function buildRelationTemplate() {
  return {
    code: 'DraftRelationExpansion',
    description: 'Draft relation expansion',
    active: true,
    spec: {
      version: 1,
      params: {
        sourceCode: {
          type: 'string',
          required: true,
          example: relationSourceCode,
          description: 'Source card code'
        }
      },
      visualModel: {
        version: 1,
        mode: 'relationExpansion',
        params: [{ name: 'sourceCode', type: 'string', required: true, example: relationSourceCode }],
        source: {
          className: relationSourceClass,
          alias: 'sourceCards',
          match: [{ field: 'Code', op: 'equals', param: 'sourceCode' }],
          limit: 1
        },
        relation: {
          from: 'sourceCards',
          targetClass: relationTargetClass,
          direction: 'both',
          limit: 20
        },
        output: {
          alias: 'relatedCards',
          title: 'Related cards',
          columns: [
            { field: 'Code', title: 'Code' },
            { field: 'Description', title: 'Description' },
            { field: 'hostname', title: 'Hostname' }
          ]
        }
      },
      steps: [
        {
          type: 'selectCards',
          className: relationSourceClass,
          filters: [{ attribute: 'Code', op: 'equals', valueParam: 'sourceCode' }],
          limit: 1,
          as: 'sourceCards'
        },
        {
          type: 'expandRelations',
          from: 'sourceCards',
          targetClass: relationTargetClass,
          direction: 'both',
          columns: ['Code', 'Description', 'hostname'],
          limit: 20,
          as: 'relatedCards'
        }
      ],
      result: {
        tables: [
          {
            name: 'relatedCards',
            title: 'Related cards',
            columns: ['SourceCode', 'Domain', 'RelationDirection', 'RelatedClass', 'Code', 'Description', 'hostname']
          }
        ]
      }
    }
  };
}

function buildRelationChainTemplate() {
  return {
    code: 'DraftRelationChain',
    description: 'Draft relation chain',
    active: true,
    spec: {
      version: 1,
      params: {
        sourceCode: {
          type: 'string',
          required: true,
          example: relationSourceCode,
          description: 'Source card code'
        }
      },
      visualModels: [
        {
          version: 1,
          mode: 'relationChain',
          source: {
            alias: 'sourceCards'
          },
          hops: [
            {
              alias: 'chainServers',
              targetClass: relationTargetClass,
              direction: 'both',
              limit: 3,
              columns: ['Code', 'Description', 'hostname']
            },
            {
              alias: 'chainIps',
              targetClass: relationSourceClass,
              direction: 'both',
              limit: 30,
              columns: ['Code', 'Description']
            }
          ],
          output: {
            alias: 'chainIps',
            title: 'Chained IPs',
            columns: ['SourceClass', 'SourceCode', 'Domain', 'RelationDirection', 'RelatedClass', 'Code', 'Description']
          }
        }
      ],
      steps: [
        {
          type: 'selectCards',
          className: relationSourceClass,
          filters: [{ attribute: 'Code', op: 'equals', valueParam: 'sourceCode' }],
          limit: 1,
          as: 'sourceCards'
        },
        {
          type: 'expandRelations',
          from: 'sourceCards',
          targetClass: relationTargetClass,
          direction: 'both',
          columns: ['Code', 'Description', 'hostname'],
          limit: 3,
          as: 'chainServers'
        },
        {
          type: 'expandRelations',
          from: 'chainServers',
          targetClass: relationSourceClass,
          direction: 'both',
          columns: ['Code', 'Description'],
          limit: 30,
          as: 'chainIps'
        }
      ],
      result: {
        tables: [
          {
            name: 'chainIps',
            title: 'Chained IPs',
            columns: ['SourceClass', 'SourceCode', 'Domain', 'RelationDirection', 'RelatedClass', 'Code', 'Description']
          }
        ]
      }
    }
  };
}

function buildValueSearchTemplate() {
  const template = JSON.parse(JSON.stringify(relationTemplate));
  template.code = 'DraftValueSearch';
  template.description = 'Draft value search';
  template.spec.visualModels = [
    template.spec.visualModel,
    {
      version: 1,
      mode: 'valueSearch',
      source: {
        alias: 'relatedCards',
        column: 'Code'
      },
      target: {
        className: relationTargetClass,
        match: {
          field: 'Code',
          op: 'equals'
        },
        limit: 100
      },
      output: {
        alias: 'matchedServers',
        title: 'Matched servers',
        columns: [
          { field: 'Code', title: 'Code' },
          { field: 'Description', title: 'Description' },
          { field: 'hostname', title: 'Hostname' }
        ]
      }
    }
  ];
  template.spec.steps.push({
    type: 'selectCards',
    from: 'relatedCards',
    className: relationTargetClass,
    filters: [{ attribute: 'Code', op: 'equals', valueColumn: 'Code' }],
    limit: 100,
    as: 'matchedServers'
  });
  template.spec.result.tables.push({
    name: 'matchedServers',
    title: 'Matched servers',
    columns: ['Source_Code', 'Code', 'Description', 'hostname'],
    columnLabels: { Source_Code: 'Code' }
  });
  return template;
}

function buildGroupCompareTemplate() {
  const template = JSON.parse(JSON.stringify(valueSearchTemplate));
  template.code = 'DraftGroupCompare';
  template.description = 'Draft group compare';
  template.spec.visualModels.push({
    version: 1,
    mode: 'groupCompare',
    operation: 'intersect',
    left: {
      alias: 'relatedCards',
      key: 'Code'
    },
    right: {
      alias: 'matchedServers',
      key: 'Code'
    },
    distinct: true,
    caseSensitive: true,
    output: {
      alias: 'matchedIntersection',
      title: 'Matched intersection',
      columns: ['SourceCode', 'Domain', 'RelationDirection', 'RelatedClass', 'Code', 'Description', 'hostname']
    }
  });
  template.spec.steps.push({
    type: 'intersectRows',
    from: 'relatedCards',
    with: 'matchedServers',
    on: [{ left: 'Code', right: 'Code' }],
    distinct: true,
    as: 'matchedIntersection'
  });
  template.spec.result.tables.push({
    name: 'matchedIntersection',
    title: 'Matched intersection',
    columns: ['SourceCode', 'Domain', 'RelationDirection', 'RelatedClass', 'Code', 'Description', 'hostname']
  });
  return template;
}

function buildFinalViewTemplate() {
  const template = JSON.parse(JSON.stringify(groupCompareTemplate));
  template.code = 'DraftFinalView';
  template.description = 'Draft final view';
  template.spec.visualModels.push({
    version: 1,
    mode: 'viewComposer',
    source: {
      alias: 'matchedIntersection'
    },
    output: {
      alias: 'matchedIntersection',
      title: 'Final matched objects',
      mode: 'compact',
      emptyText: 'No matches',
      showOnly: true,
      columns: [
        { field: 'Code', title: 'Object code' },
        { field: 'Description', title: 'Object description' },
        { field: 'RelatedClass', title: 'Related class' }
      ]
    }
  });
  template.spec.result.tables = [
    {
      name: 'matchedIntersection',
      title: 'Final matched objects',
      mode: 'compact',
      emptyText: 'No matches',
      columns: ['Code', 'Description', 'RelatedClass'],
      columnLabels: {
        Code: 'Object code',
        Description: 'Object description',
        RelatedClass: 'Related class'
      }
    }
  ];
  return template;
}

const tests = [];
let failed = false;

console.log(`proxy: ${proxyOrigin}`);
console.log(`cmdbuild: ${cmdbuildOrigin}`);
console.log(`cookie: ${cookieSource} (${cookieHeader ? 'loaded' : 'empty'})`);
console.log(`root: ${root}`);
console.log(`runtime template: ${runtimeTemplate}`);
console.log(`relation fixture: ${relationSourceClass}/${relationSourceCode} -> ${relationTargetClass}`);
console.log(`write mode: ${writeMode ? `yes (${writeTemplate})` : 'no'}`);
console.log(`expect readonly: ${expectReadonly ? 'yes' : 'no'}`);
console.log('');

if (!cookieHeader) {
  console.log('ERR cookie header is empty; log in through CMDBuild proxy or set CMDBUILD_COOKIE_HEADER.');
  process.exit(1);
}

const csrf = await test('csrf token', async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/csrf`);
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true && typeof json.token === 'string' && json.token.length > 20, 'CSRF token is missing.');
  return json.token;
});

await test('session', async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/session`);
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Session endpoint returned success=false.');
  return `user=${json.session && json.session.username ? json.session.username : ''} role=${json.session && json.session.role ? json.session.role : ''}`;
});

await test('logging status', async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/logging/status`);
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Logging status returned success=false.');
  assert(json.logging && Array.isArray(json.logging.targets), 'Logging targets are missing.');
  assert(json.logging.redactHeaders && json.logging.redactHeaders.includes('cookie'), 'Logging header redaction does not include cookie.');
  assert(json.logging.redactQuery && json.logging.redactQuery.includes('token'), 'Logging query redaction does not include token.');
  return `targets=${json.logging.targets.join(',')}`;
});

await test('model catalog', async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/model/catalog?maxClasses=5&maxDomains=5&includeAttributes=true`);
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Catalog endpoint returned success=false.');
  assert(json.catalog && Array.isArray(json.catalog.classes), 'Catalog classes are missing.');
  assert(json.catalog.counts && Number.isInteger(json.catalog.counts.classes), 'Catalog counts are missing.');
  return `classes=${json.catalog.counts.classes} attributes=${json.catalog.counts.attributes} domains=${json.catalog.counts.domains}`;
});

await test('technical schema ready', async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/schema?root=${encodeURIComponent(root)}`);
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.schema && json.schema.ready === true, 'Technical schema is not ready.');
  return `status=${json.schema.status}`;
});

if (expectReadonly) {
  await test('template create rejected for read-only user', async () => {
    const code = `ReadonlyProbe${Date.now()}`;
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/templates?root=${encodeURIComponent(root)}`, {
      ...buildProbeTemplate(code, 'Read-only probe'),
      changeComment: 'readonly e2e probe'
    }, withCsrf(csrf));
    assert(result.statusCode < 200 || result.statusCode >= 300, `Create unexpectedly succeeded with HTTP ${result.statusCode}.`);
    const json = getJson(result);
    return `http=${result.statusCode} cmdbuild=${json.cmdbuildStatus || ''}`;
  });
}

await test('generic REST proxy is absent', async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/cmdbuild/services/rest/v3/classes`);
  assertStatus(result, 404);
});

await test('draft validate rejects missing CSRF', async () => {
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: draftTemplate,
    params: { attrType: runtimeAttrType }
  }, sameOriginHeaders);
  assertStatus(result, 403);
});

await test('draft validate', async () => {
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: draftTemplate,
    params: { attrType: runtimeAttrType }
  }, withCsrf(csrf));
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Draft validation failed.');
  assert(Array.isArray(json.errors) && json.errors.length === 0, 'Draft validation returned errors.');
});

await test('draft preview', async () => {
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=2`, {
    template: draftTemplate,
    params: { attrType: runtimeAttrType }
  }, withCsrf(csrf));
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Draft preview failed.');
  assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 1, 'Draft preview did not return one result table.');
  assert(Array.isArray(json.result.trace) && json.result.trace.length === 1, 'Draft preview did not return execution trace.');
  assert(json.cache === undefined || json.cache === null, 'Draft preview unexpectedly returned runtime cache metadata.');
  return resultSummary(json.result);
});

await test('object group draft preview', async () => {
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=2`, {
    template: objectGroupTemplate,
    params: { templateCode: runtimeTemplate }
  }, withCsrf(csrf));
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Object group draft preview failed.');
  assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 1, 'Object group preview did not return one table.');
  assert(json.result.tables[0].rows.length >= 1, 'Object group preview returned no rows.');
  return resultSummary(json.result);
});

if (!expectReadonly) {
  await test('card relation draft preview', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=10&maxRestCalls=80`, {
      template: relationTemplate,
      params: { sourceCode: relationSourceCode }
    }, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Card relation draft preview failed.');
    assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 1, 'Relation preview did not return one table.');
    assert(Array.isArray(json.result.trace) && json.result.trace.length === 2, 'Relation preview did not execute both steps.');
    assert(json.result.tables[0].rows.length >= 1, 'Relation preview returned no related rows.');
    return resultSummary(json.result);
  });

  await test('relation chain draft preview', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=50&maxRestCalls=150`, {
      template: relationChainTemplate,
      params: { sourceCode: relationSourceCode }
    }, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Relation chain draft preview failed.');
    assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 1, 'Relation chain preview did not return one table.');
    assert(Array.isArray(json.result.trace) && json.result.trace.length === 3, 'Relation chain preview did not execute three steps.');
    assert(json.result.tables[0].rows.length >= 1, 'Relation chain preview returned no chained rows.');
    return resultSummary(json.result);
  });

  await test('value search draft preview', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=100&maxRestCalls=100`, {
      template: valueSearchTemplate,
      params: { sourceCode: relationSourceCode }
    }, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Value search draft preview failed.');
    assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 2, 'Value search preview did not return both tables.');
    assert(Array.isArray(json.result.trace) && json.result.trace.length === 3, 'Value search preview did not execute three steps.');
    const matched = json.result.tables.find((table) => table.name === 'matchedServers');
    assert(matched && matched.rows.length >= 1, 'Value search preview returned no matched rows.');
    return resultSummary(json.result);
  });

  await test('group compare draft preview', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=100&maxRestCalls=100`, {
      template: groupCompareTemplate,
      params: { sourceCode: relationSourceCode }
    }, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Group compare draft preview failed.');
    assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 3, 'Group compare preview did not return three tables.');
    assert(Array.isArray(json.result.trace) && json.result.trace.length === 4, 'Group compare preview did not execute four steps.');
    const matched = json.result.tables.find((table) => table.name === 'matchedIntersection');
    assert(matched && matched.rows.length >= 1, 'Group compare preview returned no intersection rows.');
    return resultSummary(json.result);
  });

  await test('final view draft preview', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/preview?maxRows=100&maxRestCalls=100`, {
      template: finalViewTemplate,
      params: { sourceCode: relationSourceCode }
    }, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Final view draft preview failed.');
    assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length === 1, 'Final view preview did not return exactly one table.');
    const table = json.result.tables[0];
    assert(table.name === 'matchedIntersection', 'Final view returned an unexpected table.');
    assert(table.title === 'Final matched objects', 'Final view title was not applied.');
    assert(table.mode === 'compact', 'Final view mode was not applied.');
    assert(table.columnLabels && table.columnLabels.Code === 'Object code', 'Final view column labels were not applied.');
    assert(Array.isArray(table.columns) && table.columns.join(',') === 'Code,Description,RelatedClass', 'Final view columns were not applied.');
    assert(table.rows.length >= 1, 'Final view returned no rows.');
    return resultSummary(json.result);
  });
}

if (writeMode) {
  const smokeTemplate = buildProbeTemplate(writeTemplate, `E2E smoke ${new Date().toISOString()}`);

  await test('write template create/update', async () => {
    const existing = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}?root=${encodeURIComponent(root)}`);
    const method = existing.statusCode === 200 ? 'PUT' : 'POST';
    const path = method === 'PUT'
      ? `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}?root=${encodeURIComponent(root)}`
      : `${proxyOrigin}/cmdbuild/custom-api/templates?root=${encodeURIComponent(root)}`;
    const result = await request(method, path, {
      ...smokeTemplate,
      changeComment: 'write e2e smoke'
    }, withCsrf(csrf));
    assertStatus(result, method === 'POST' ? 201 : 200);
    const json = getJson(result);
    assert(json.success === true && json.template && json.template.code === writeTemplate, 'Template write response is invalid.');
    return method;
  });

  await test('write template versions', async () => {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}/versions?root=${encodeURIComponent(root)}&limit=5`);
    assertStatus(result, 200);
    const json = getJson(result);
    assert(Array.isArray(json.data) && json.data.length >= 1, 'Template versions are missing.');
    return `versions=${json.data.length}`;
  });

  await test('write template expectedSpecHash conflict', async () => {
    const current = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}?root=${encodeURIComponent(root)}`);
    assertStatus(current, 200);
    const currentJson = getJson(current);
    const currentTemplate = currentJson.template || {};
    assert(currentTemplate.specHash && /^[a-f0-9]{64}$/.test(currentTemplate.specHash), 'Current template specHash is missing.');
    const staleHash = currentTemplate.specHash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const result = await request('PUT', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}?root=${encodeURIComponent(root)}`, {
      code: currentTemplate.code || writeTemplate,
      description: currentTemplate.description || writeTemplate,
      active: currentTemplate.active !== false,
      spec: currentTemplate.spec,
      expectedSpecHash: staleHash,
      changeComment: 'write e2e conflict probe'
    }, withCsrf(csrf));
    assertStatus(result, 409);
    const json = getJson(result);
    assert(json.reason === 'template_version_conflict', 'Conflict response reason is invalid.');
    assert(json.currentSpecHash === currentTemplate.specHash, 'Conflict response did not return current spec hash.');
    return `current=${json.currentSpecHash.slice(0, 12)} expected=${json.expectedSpecHash.slice(0, 12)}`;
  });

  await test('write template validate', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}/validate?root=${encodeURIComponent(root)}`, {}, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Written template validation failed.');
  });

  await test('write template preview', async () => {
    const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(writeTemplate)}/preview?root=${encodeURIComponent(root)}&maxRows=2`, {
      params: { attrType: runtimeAttrType }
    }, withCsrf(csrf));
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'Written template preview failed.');
    return resultSummary(json.result);
  });

  await checkRuntimeShell(writeTemplate, 'write runtime shell');
  await runSavedTemplate(writeTemplate, 'write template run');
  await runSavedTemplateCacheChecks(writeTemplate);
} else {
  await checkRuntimeShell(runtimeTemplate, 'runtime shell');
  await runSavedTemplate(runtimeTemplate, 'saved template run');
  await runSavedTemplateCacheChecks(runtimeTemplate);
}

console.log('');
for (const row of tests) {
  console.log(`${row.ok ? 'OK ' : 'ERR'} ${row.name}${row.detail ? ` ${row.detail}` : ''}`);
}

process.exitCode = failed ? 1 : 0;

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    tests.push({ ok: true, name, detail: formatDetail(detail, Date.now() - started) });
    return detail;
  } catch (error) {
    failed = true;
    tests.push({ ok: false, name, detail: formatDetail(error.message, Date.now() - started) });
    return null;
  }
}

async function checkRuntimeShell(templateCode, name) {
  await test(name, async () => {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/dynamicpages/ui/run/${encodeURIComponent(templateCode)}?attrType=${encodeURIComponent(runtimeAttrType)}`);
    assertStatus(result, 200);
    assert(result.body.includes('window.CMDP_BOOT'), 'Runtime shell boot payload is missing.');
    assert(result.body.includes(templateCode), 'Runtime shell does not contain template code.');
  });
}

async function runSavedTemplate(templateCode, name) {
  await test(name, async () => {
    const json = await postTemplateRun(templateCode);
    return `${resultSummary(json.result)} cache=${cacheStatus(json)}`;
  });
}

async function runSavedTemplateCacheChecks(templateCode) {
  await test('saved template cache hit', async () => {
    const json = await postTemplateRun(templateCode);
    if (!json.cache || json.cache.enabled === false) return `cache=${cacheStatus(json)}`;
    assert(json.cache.status === 'hit', `Expected cache hit, got ${json.cache.status}.`);
    return `cache=${cacheStatus(json)} key=${json.cache.key || ''}`;
  });

  await test('saved template force refresh bypasses cooldown', async () => {
    const json = await postTemplateRun(templateCode, { forceRefresh: true });
    if (!json.cache || json.cache.enabled === false) return `cache=${cacheStatus(json)}`;
    assert(json.cache.status === 'force-refresh', `Expected force-refresh, got ${json.cache.status}.`);
    assert(json.cache.refreshAllowed === false || json.cache.refreshAllowed === true, 'Force refresh cache metadata is incomplete.');
    return `cache=${cacheStatus(json)} key=${json.cache.key || ''}`;
  });

  await test('GET runtime cannot force refresh', async () => {
    const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(templateCode)}/run?attrType=${encodeURIComponent(runtimeAttrType)}&forceRefresh=1`);
    assertStatus(result, 200);
    const json = getJson(result);
    assert(json.success === true, 'GET runtime failed.');
    if (json.cache) {
      assert(json.cache.status !== 'force-refresh', 'GET runtime unexpectedly forced cache refresh.');
    }
    return `cache=${cacheStatus(json)}`;
  });
}

async function postTemplateRun(templateCode, options = {}) {
  const query = new URLSearchParams({
    root,
    maxRows: '2'
  });
  if (options.forceRefresh) query.set('forceRefresh', '1');
  if (options.noCache) query.set('noCache', '1');
  const body = {
    params: { attrType: runtimeAttrType }
  };
  if (options.forceRefresh) {
    body.refresh = true;
    body.forceRefresh = true;
  }
  if (options.noCache) body.noCache = true;
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/templates/${encodeURIComponent(templateCode)}/run?${query}`, body, withCsrf(csrf));
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'Saved template run failed.');
  assert(json.result && Array.isArray(json.result.tables) && json.result.tables.length >= 1, 'Saved template run did not return tables.');
  assert(Array.isArray(json.result.trace) && json.result.trace.length >= 1, 'Saved template run did not return trace.');
  return json;
}

function cacheStatus(json) {
  if (!json || !json.cache) return 'none';
  return `${json.cache.scopeMode || json.cache.scope || 'cache'}:${json.cache.status || 'unknown'}`;
}

function withCsrf(token) {
  return {
    ...sameOriginHeaders,
    'x-cmdbdynamicpages-csrf': token
  };
}

function resultSummary(result) {
  const tables = Array.isArray(result && result.tables) ? result.tables : [];
  const rows = tables.reduce((count, table) => count + (Array.isArray(table.rows) ? table.rows.length : 0), 0);
  const trace = Array.isArray(result && result.trace) ? result.trace : [];
  const restCalls = result && result.limits ? result.limits.restCalls : '';
  return `tables=${tables.length} rows=${rows} trace=${trace.length} restCalls=${restCalls}`;
}

function formatDetail(detail, elapsedMs) {
  const text = detail ? String(detail) : '';
  return `${text ? `${text} ` : ''}${elapsedMs}ms`;
}

function assertStatus(result, expectedStatus) {
  assert(result.statusCode === expectedStatus, `Expected HTTP ${expectedStatus}, got HTTP ${result.statusCode}: ${result.body.slice(0, 500)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getJson(result) {
  try {
    return JSON.parse(result.body || '{}');
  } catch {
    throw new Error(`Response is not JSON: ${result.body.slice(0, 500)}`);
  }
}

async function loginCmdbuild(username, password, role, scope) {
  const payload = { username, password, scope };
  if (role) payload.role = role;
  const result = await request('POST', `${cmdbuildOrigin}/cmdbuild/services/rest/v3/sessions/?ext=true`, payload, {
    origin: cmdbuildOrigin
  });
  assertStatus(result, 200);
  const json = getJson(result);
  assert(json.success === true, 'CMDBuild login returned success=false.');
  const setCookie = result.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = cookies
    .map((item) => String(item).split(';')[0])
    .filter(Boolean)
    .join('; ');
  assert(header.includes('CMDBuild-Authorization='), 'CMDBuild login did not return CMDBuild-Authorization cookie.');
  return header;
}

function request(method, url, body, extraHeaders = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      accept: 'application/json,text/html,*/*',
      cookie: cookieHeader,
      ...extraHeaders
    };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = transport.request({
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function readCookieJar(path) {
  if (!fs.existsSync(path)) return '';
  const cookies = [];
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (let line of lines) {
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) {
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\t/);
    if (parts.length >= 7) {
      cookies.push(`${parts[5]}=${parts.slice(6).join('\t')}`);
    }
  }
  return cookies.join('; ');
}
