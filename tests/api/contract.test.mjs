import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { validateOpenapiText } from '../../scripts/validate-openapi.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const openapiPath = path.join(repositoryRoot, 'aa/openapi.yaml');

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const cmdbuildOrigin = process.env.CMDBUILD_LOGIN_ORIGIN || process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090';
const loginUsername = process.env.CMDBUILD_USERNAME || '';
const loginPassword = process.env.CMDBUILD_PASSWORD || '';
const loginRole = process.env.CMDBUILD_ROLE || '';
const loginScope = process.env.CMDBUILD_SCOPE || 'ui';
const configuredCookieHeader = String(process.env.CMDBUILD_COOKIE_HEADER || '').trim();
const proxyAvailable = await canReach(`${proxyOrigin}/health/live`);
const skipWhenUnavailable = proxyAvailable ? false : `proxy is not reachable at ${proxyOrigin}`;
const authenticatedSession = proxyAvailable ? await resolveAuthenticatedSession() : {
  cookie: '',
  skip: skipWhenUnavailable
};

test('OpenAPI Diagram Assistant contract passes the dependency-free validator', () => {
  const result = validateOpenapiText(fs.readFileSync(openapiPath, 'utf8'));

  assert.deepEqual(result.errors, []);
  assert.ok(result.pathCount > 0);
  assert.ok(result.refCount > 0);
});

test('OpenAPI validator rejects Diagram Assistant field, status, and component drift', async (t) => {
  const source = fs.readFileSync(openapiPath, 'utf8');
  const mutations = [
    {
      name: 'request field',
      expectedError: /semanticsPrompt/,
      mutate: (value) => value.replace('\n        semanticsPrompt:\n', '\n        semanticsPromptDrift:\n')
    },
    {
      name: 'response status',
      expectedError: /response status drift/,
      mutate: (value) => mutateOpenapiPath(value, '/cmdbuild/custom-api/assistant/diagram-import/map-selections', (block) => (
        block.replace('        "504":', '        "599":')
      ))
    },
    {
      name: 'typed component',
      expectedError: /AssistantDiagramModels/,
      mutate: (value) => value.replace('\n    AssistantDiagramModels:\n', '\n    AssistantDiagramModelsDrift:\n')
    },
    {
      name: 'invalid nullable oneOf',
      expectedError: /nullable cannot be applied to a oneOf schema/,
      mutate: (value) => value.replace('        id:\n          oneOf:\n', '        id:\n          nullable: true\n          oneOf:\n')
    }
  ];

  for (const [index, mutation] of mutations.entries()) {
    await t.test(mutation.name, () => {
      const mutated = mutation.mutate(source);
      assert.notEqual(mutated, source, `mutation ${mutation.name} did not change the contract`);
      const result = validateOpenapiText(mutated);
      assert.ok(result.errors.length > 0, `mutation ${index} was not rejected`);
      assert.match(result.errors.join('\n'), mutation.expectedError);
    });
  }
});

test('health live endpoint is public and reports process liveness', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/health/live`);

  assert.equal(result.statusCode, 200);
  const json = JSON.parse(result.body);
  assert.equal(json.service, 'cmdbdynamicpages');
  assert.equal(json.live, true);
  assert.match(json.build.version, /^(?:0\.0\.0\.0|\d{2}\.\d{2}\.\d{2}\.\d{2})$/);
  assert.match(json.build.revision, /^(?:unknown|[0-9a-f]{40})$/);
  assert.ok(['verified', 'unverified-local'].includes(json.build.provenance));
  assert.ok(json.build.dirty === null || typeof json.build.dirty === 'boolean');
  assert.match(json.build.editorSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.headers['x-cmdp-version'], json.build.version);
  assert.equal(result.headers['x-cmdp-revision'], json.build.revision);
  assert.equal(result.headers['x-cmdp-provenance'], json.build.provenance);
  assert.equal(result.headers['x-cmdp-editor-sha256'], json.build.editorSha256);
});

test('health ready endpoint returns a production readiness payload', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/health/ready`);

  assert.ok([200, 503].includes(result.statusCode), `unexpected HTTP ${result.statusCode}`);
  const json = JSON.parse(result.body);
  assert.equal(json.service, 'cmdbdynamicpages');
  assert.equal(typeof json.ready, 'boolean');
  assert.ok(json.checks && typeof json.checks === 'object');
  assert.ok(json.checks.redis);
  assert.ok(json.checks.cmdbuild);
  assert.ok(json.checks.d2);
  assert.ok(json.checks.d2Import);
});

test('metrics endpoint exposes aggregate Prometheus text only', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/metrics`);

  assert.equal(result.statusCode, 200);
  assert.match(String(result.headers['content-type'] || ''), /^text\/plain/);
  assert.match(result.body, /# TYPE cmdp_health_ready gauge/);
  assert.match(result.body, /cmdp_health_ready [01]/);
  assert.doesNotMatch(result.body, /cookie|authorization|csrf|secret|CMDBuild-Authorization/i);
});

test('cache status endpoint is public and does not expose Redis credentials', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/cache/status`);

  assert.equal(result.statusCode, 200);
  const json = JSON.parse(result.body);
  assert.equal(json.success, true);
  assert.equal(typeof json.redis, 'object');
  assert.equal(typeof json.redis.transportSecurity, 'object');
  assert.doesNotMatch(result.body, /CMDBuild-Authorization|cookie|csrf|password=/i);
});

test('logging status is protected by CMDBuild authentication', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/logging/status`);

  assert.equal(result.statusCode, 401);
});

test('schema parent list is protected by CMDBuild authentication', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/schema/parents`);

  assert.equal(result.statusCode, 401);
});

test('state-changing custom API call without CSRF/session is rejected', { skip: skipWhenUnavailable }, async () => {
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: { code: 'NoCsrf', spec: { version: 1, steps: [], result: { tables: [] } } },
    params: {}
  }, { origin: proxyOrigin });

  assert.ok([401, 403].includes(result.statusCode), `unexpected HTTP ${result.statusCode}`);
});

test('state-changing custom API rejects a cross-origin request before CSRF validation', { skip: skipWhenUnavailable }, async () => {
  const cookie = 'CMDBuild-Authorization=fake-cross-origin-token';
  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: { code: 'CrossOrigin', spec: { version: 1, steps: [], result: { tables: [] } } },
    params: {}
  }, {
    cookie,
    origin: 'https://cross-origin.example'
  });

  assert.equal(result.statusCode, 403);
  assert.equal(JSON.parse(result.body).message, 'State-changing custom API calls require a same-origin Origin or Referer header.');
});

test('CSRF endpoint rejects an invalid CMDBuild session', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/csrf`, undefined, {
    cookie: 'CMDBuild-Authorization=invalid-contract-test-token'
  });

  assert.equal(result.statusCode, 401);
  assert.equal(JSON.parse(result.body).reason, 'cmdbuild_session_invalid');
});

test('state-changing custom API rejects non-JSON content type after valid session and CSRF validation', {
  skip: authenticatedSession.skip
}, async () => {
  const cookie = authenticatedSession.cookie;
  const csrfResult = await request('GET', `${proxyOrigin}/cmdbuild/custom-api/csrf`, undefined, { cookie });
  assert.equal(csrfResult.statusCode, 200);
  const csrfToken = JSON.parse(csrfResult.body).token;

  const result = await request('POST', `${proxyOrigin}/cmdbuild/custom-api/draft/validate`, {
    template: { code: 'WrongContentType', spec: { version: 1, steps: [], result: { tables: [] } } },
    params: {}
  }, {
    cookie,
    origin: proxyOrigin,
    'x-cmdbdynamicpages-csrf': csrfToken,
    'content-type': 'text/plain'
  });

  assert.equal(result.statusCode, 415);
});

test('CMDBuild proxy fallback rejects paths outside the allowlist', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/cmdbuild/manager/html`);

  assert.equal(result.statusCode, 403);
});

async function resolveAuthenticatedSession() {
  if (configuredCookieHeader) return { cookie: configuredCookieHeader, skip: false };
  if (!loginUsername || !loginPassword) {
    return {
      cookie: '',
      skip: 'set CMDBUILD_COOKIE_HEADER or CMDBUILD_USERNAME/CMDBUILD_PASSWORD to run authenticated API contract checks'
    };
  }
  try {
    const payload = { username: loginUsername, password: loginPassword, scope: loginScope };
    if (loginRole) payload.role = loginRole;
    const result = await request('POST', `${cmdbuildOrigin.replace(/\/+$/, '')}/cmdbuild/services/rest/v3/sessions/?ext=true`, payload, {
      origin: cmdbuildOrigin
    }, 10_000);
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return { cookie: '', skip: `CMDBuild login returned HTTP ${result.statusCode}` };
    }
    const cookie = cmdbuildAuthorizationCookie(result.headers['set-cookie']);
    return cookie
      ? { cookie, skip: false }
      : { cookie: '', skip: 'CMDBuild login did not return CMDBuild-Authorization cookie' };
  } catch (error) {
    return {
      cookie: '',
      skip: `CMDBuild login failed: ${error && error.message ? error.message : String(error)}`
    };
  }
}

function cmdbuildAuthorizationCookie(setCookie) {
  const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const cookie of cookies) {
    const token = String(cookie || '').split(';')[0] || '';
    if (token.startsWith('CMDBuild-Authorization=')) return token;
  }
  return '';
}

async function canReach(url) {
  try {
    const result = await request('GET', url, undefined, {}, 1500);
    return result.statusCode > 0;
  } catch {
    return false;
  }
}

function request(method, url, body, extraHeaders = {}, timeoutMs = 5000) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      accept: 'application/json,text/html,*/*',
      ...extraHeaders
    };
    if (payload !== null) {
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = transport.request({
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs
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

function hasHeader(headers, name) {
  const normalized = String(name || '').toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function mutateOpenapiPath(source, apiPath, mutate) {
  const header = `  ${apiPath}:`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `OpenAPI path is missing: ${apiPath}`);
  const nextPath = source.indexOf('\n  /', start + header.length);
  const components = source.indexOf('\ncomponents:', start + header.length);
  const endCandidates = [nextPath, components].filter((value) => value >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : source.length;
  const block = source.slice(start, end);
  const mutatedBlock = mutate(block);
  assert.notEqual(mutatedBlock, block, `OpenAPI path mutation did not change ${apiPath}`);
  return `${source.slice(0, start)}${mutatedBlock}${source.slice(end)}`;
}
