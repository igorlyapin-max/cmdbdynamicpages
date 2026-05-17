import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const cmdbuildOrigin = process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090';
const cookieJar = process.env.CMDBUILD_COOKIE_JAR || '/tmp/cmdbuild-ui-cookie.txt';
const cookieHeader = process.env.CMDBUILD_COOKIE_HEADER || readCookieJar(cookieJar);
const customPageId = process.env.CMDBDYNAMIC_CUSTOMPAGE_ID || '1662627';

const checks = [
  {
    name: 'proxy ui entry',
    url: `${proxyOrigin}/cmdbuild/ui/?cmdpMode=designer`,
    expect: (result) => result.statusCode >= 200 && result.statusCode < 400
  },
  {
    name: 'custom page js through proxy',
    url: `${proxyOrigin}/cmdbuild/ui/app/view/custompages/CmdbDynamicPages/CmdbDynamicPages.js`,
    expect: (result) => result.statusCode === 200 &&
      result.body.includes('CMDBuildUI.view.custompages.CmdbDynamicPages.CmdbDynamicPages') &&
      result.body.includes('launcher-redirect')
  },
  {
    name: 'dynamic designer ui',
    url: `${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`,
    expect: (result) => result.statusCode === 200 &&
      result.body.includes('window.CMDP_BOOT') &&
      result.body.includes('cmdp-language') &&
      result.body.includes('cmdp-catalog-header') &&
      result.body.includes('cmdp-catalog-lamp') &&
      result.body.includes('cmdp-designer-menu') &&
      result.body.includes('cmdp-runtime-settings') &&
      result.body.includes('cmdp-template-list') &&
      result.body.includes('cmdp-template-editor') &&
      result.body.includes('cmdp-object-group-editor') &&
      result.body.includes('cmdp-object-class') &&
      result.body.includes('add-object-selection') &&
      result.body.includes('Выборка{number}') &&
      result.body.includes('cmdp-relation-expansion-editor') &&
      result.body.includes('data-matching-block') &&
      result.body.includes('add-matching-rule-row') &&
      result.body.includes('matchRows') &&
      result.body.includes('Object matching') &&
      result.body.includes('cmdp-extraction-source') &&
      result.body.includes('cmdp-param-rows') &&
      result.body.includes('cmdp-extract-regex') &&
      result.body.includes('cmdp-select-class-name') &&
      result.body.includes('cmdp-view-composer-editor') &&
      result.body.includes('cmdp-view-source') &&
      result.body.includes('cmdp-view-column-rows') &&
      result.body.includes('cmdp-visualization-rows') &&
      result.body.includes('cmdp-test-workflow') &&
      result.body.includes('cmdp-max-depth') &&
      result.body.includes('CMDB Dynamic Pages') &&
      !result.body.includes('cmdp-relation-chain-editor') &&
      !result.body.includes('cmdp-value-search-editor') &&
      !result.body.includes('cmdp-group-compare-editor') &&
      !result.body.includes('cmdp-compose-as')
  },
  {
    name: 'dynamic designer section route',
    url: `${proxyOrigin}/cmdbuild/dynamicpages/ui/designer/object-group`,
    expect: (result) => result.statusCode === 200 &&
      result.body.includes('window.CMDP_BOOT') &&
      result.body.includes('"designerSection":"object-group"') &&
      result.body.includes('cmdp-object-group-editor')
  },
  {
    name: 'dynamic designer general settings route',
    url: `${proxyOrigin}/cmdbuild/dynamicpages/ui/designer/general-settings`,
    expect: (result) => result.statusCode === 200 &&
      result.body.includes('window.CMDP_BOOT') &&
      result.body.includes('"designerSection":"general-settings"') &&
      result.body.includes('cmdp-general-settings') &&
      result.body.includes('cmdp-max-depth')
  },
  {
    name: 'dynamic runtime ui',
    url: `${proxyOrigin}/cmdbuild/dynamicpages/ui/run/ProbeClassesByAttributeType?attrType=reference`,
    expect: (result) => result.statusCode === 200 &&
      result.body.includes('window.CMDP_BOOT') &&
      result.body.includes('ProbeClassesByAttributeType')
  },
  {
    name: 'custom page registration',
    url: `${cmdbuildOrigin}/cmdbuild/services/rest/v3/custompages/${customPageId}`,
    expect: (result) => result.statusCode === 200 && getJson(result).data && getJson(result).data.active === true
  },
  {
    name: 'backend session',
    url: `${proxyOrigin}/cmdbuild/custom-api/session`,
    expect: (result) => result.statusCode === 200 && getJson(result).success === true
  },
  {
    name: 'model catalog',
    url: `${proxyOrigin}/cmdbuild/custom-api/model/catalog?maxClasses=5&maxDomains=5&includeAttributes=true`,
    expect: (result) => result.statusCode === 200 &&
      getJson(result).success === true &&
      getJson(result).catalog &&
      Array.isArray(getJson(result).catalog.classes)
  },
  {
    name: 'class name check',
    url: `${proxyOrigin}/cmdbuild/custom-api/model/classes/Cst_QueryTemplate`,
    expect: (result) => result.statusCode === 200 && getJson(result).success === true && getJson(result).class
  },
  {
    name: 'technical schema',
    url: `${proxyOrigin}/cmdbuild/custom-api/schema?root=Cst_QueryTool`,
    expect: (result) => result.statusCode === 200 && getJson(result).schema && getJson(result).schema.ready === true
  },
  {
    name: 'templates',
    url: `${proxyOrigin}/cmdbuild/custom-api/templates?limit=5`,
    expect: (result) => result.statusCode === 200 && Array.isArray(getJson(result).data)
  },
  {
    name: 'client log',
    url: `${proxyOrigin}/cmdbuild/custom-api/client-log`,
    expect: (result) => result.statusCode === 200 && Array.isArray(getJson(result).data)
  },
  {
    name: 'proxy log',
    url: `${proxyOrigin}/cmdbuild/custom-api/proxy-log`,
    expect: (result) => result.statusCode === 200 && Array.isArray(getJson(result).data)
  }
];

let failed = false;
console.log(`proxy: ${proxyOrigin}`);
console.log(`cmdbuild: ${cmdbuildOrigin}`);
console.log(`cookie jar: ${cookieJar} (${cookieHeader ? 'loaded' : 'empty'})`);
console.log('');

for (const check of checks) {
  const started = Date.now();
  try {
    const result = await request(check.url);
    const ok = check.expect(result);
    failed = failed || !ok;
    const elapsed = Date.now() - started;
    console.log(`${ok ? 'OK ' : 'ERR'} ${check.name} HTTP ${result.statusCode} ${elapsed}ms`);
    printDetail(check.name, result);
  } catch (error) {
    failed = true;
    console.log(`ERR ${check.name} ${error.message}`);
  }
}

console.log('');
console.log('Open designer directly:');
console.log(`${proxyOrigin}/cmdbuild/dynamicpages/ui/designer`);
console.log('');
console.log('Open through CMDBuild custom page launcher:');
console.log(`${proxyOrigin}/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages`);
console.log('');
console.log('Open runtime directly:');
console.log(`${proxyOrigin}/cmdbuild/dynamicpages/ui/run/ProbeClassesByAttributeType?attrType=reference`);
console.log('');
console.log('After browser reload, inspect client log:');
console.log(`${proxyOrigin}/cmdbuild/custom-api/client-log`);

process.exitCode = failed ? 1 : 0;

function request(url) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      method: 'GET',
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        accept: 'application/json,text/javascript,text/html,*/*',
        cookie: cookieHeader
      },
      timeout: 10000
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
    req.end();
  });
}

function getJson(result) {
  try {
    return JSON.parse(result.body || '{}');
  } catch {
    return {};
  }
}

function printDetail(name, result) {
  if (name === 'custom page js through proxy') {
    console.log(`    content-type=${result.headers['content-type'] || ''} length=${result.body.length}`);
  }
  if (name === 'dynamic designer ui' || name === 'dynamic runtime ui') {
    console.log(`    content-type=${result.headers['content-type'] || ''} length=${result.body.length}`);
  }
  if (name === 'custom page registration') {
    const data = getJson(result).data || {};
    console.log(`    active=${data.active} componentId=${data.componentId || ''}`);
  }
  if (name === 'backend session') {
    const session = getJson(result).session || {};
    console.log(`    user=${session.username || ''} role=${session.role || ''}`);
  }
  if (name === 'model catalog') {
    const counts = getJson(result).catalog && getJson(result).catalog.counts ? getJson(result).catalog.counts : {};
    console.log(`    classes=${counts.classes || 0} attributes=${counts.attributes || 0} domains=${counts.domains || 0}`);
  }
  if (name === 'class name check') {
    const checkedClass = getJson(result).class || {};
    console.log(`    class=${checkedClass.name || ''} description=${checkedClass.description || ''}`);
  }
  if (name === 'templates') {
    const data = getJson(result).data || [];
    console.log(`    templates=${data.map((item) => item.code).join(', ')}`);
  }
  if (name === 'client log') {
    const data = getJson(result).data || [];
    const last = data.slice(-5);
    console.log(`    entries=${data.length}`);
    last.forEach((item) => {
      console.log(`    ${item.time || ''} ${item.stage || ''} ${item.message || ''}`);
    });
  }
  if (name === 'proxy log') {
    const data = getJson(result).data || [];
    const last = data.slice(-5);
    console.log(`    entries=${data.length}`);
    last.forEach((item) => {
      console.log(`    ${item.time || ''} ${item.method || ''} ${item.path || ''}`);
    });
  }
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
