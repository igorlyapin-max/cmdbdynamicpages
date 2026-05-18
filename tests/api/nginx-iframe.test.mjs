import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const nginxOrigin = process.env.CMDBDYNAMIC_NGINX_ORIGIN || 'http://localhost:8088';
const cookieJar = process.env.CMDBUILD_COOKIE_JAR || '/tmp/cmdbuild-ui-cookie.txt';
const runtimeTemplate = process.env.CMDBDYNAMIC_E2E_TEMPLATE || 'ProbeClassesByAttributeType';
const runtimeAttrType = process.env.CMDBDYNAMIC_E2E_ATTR_TYPE || 'reference';
const cookieHeader = process.env.CMDBUILD_COOKIE_HEADER || readCookieJar(cookieJar);
const nginxAvailable = await canReach(`${nginxOrigin}/health/live`);
const skipWhenUnavailable = nginxAvailable ? false : `nginx same-origin front is not reachable at ${nginxOrigin}`;

test('nginx config keeps wiki and dynamicpages on the same origin', () => {
  const config = fs.readFileSync('nginx/cmdbdynamicpages-dev.conf', 'utf8');

  assert.match(config, /listen\s+8088;/);
  assert.match(config, /location\s+\/cmdbuild\/\s*\{/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8093\/cmdbuild\/;/);
  assert.match(config, /location\s+\/health\/\s*\{/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8093\/health\/;/);
  assert.match(config, /location\s+\/\s*\{/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);
});

test('nginx health route reaches cmdbdynamicpages backend', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${nginxOrigin}/health/live`);

  assert.equal(result.statusCode, 200);
  const json = JSON.parse(result.body || '{}');
  assert.equal(json.service, 'cmdbdynamicpages');
  assert.equal(json.live, true);
});

test('dynamicpages runtime route is iframe-compatible through nginx origin', { skip: skipWhenUnavailable }, async () => {
  const result = await request(
    'GET',
    `${nginxOrigin}/cmdbuild/dynamicpages/ui/run/${encodeURIComponent(runtimeTemplate)}?attrType=${encodeURIComponent(runtimeAttrType)}`,
    undefined,
    cookieHeader ? { cookie: cookieHeader } : {}
  );

  assert.ok([200, 401, 403, 404].includes(result.statusCode), `unexpected HTTP ${result.statusCode}`);
  assert.match(result.body, /CMDB Dynamic Pages/);
  assert.notEqual(String(result.headers['x-frame-options'] || '').toUpperCase(), 'DENY');
  assert.doesNotMatch(String(result.headers['content-security-policy'] || ''), /frame-ancestors\s+'none'/i);
});

test('wiki root is still served by nginx root proxy', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${nginxOrigin}/`);

  assert.ok(result.statusCode < 500, `wiki/root proxy returned HTTP ${result.statusCode}`);
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
