import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const proxyAvailable = await canReach(`${proxyOrigin}/health/live`);
const skipWhenUnavailable = proxyAvailable ? false : `proxy is not reachable at ${proxyOrigin}`;

test('health live endpoint is public and reports process liveness', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/health/live`);

  assert.equal(result.statusCode, 200);
  const json = JSON.parse(result.body);
  assert.equal(json.service, 'cmdbdynamicpages');
  assert.equal(json.live, true);
});

test('health ready endpoint returns a production readiness payload', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${proxyOrigin}/health/ready`);

  assert.ok([200, 503].includes(result.statusCode), `unexpected HTTP ${result.statusCode}`);
  const json = JSON.parse(result.body);
  assert.equal(json.service, 'cmdbdynamicpages');
  assert.equal(typeof json.ready, 'boolean');
  assert.ok(json.redis);
  assert.ok(json.cmdbuild);
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
