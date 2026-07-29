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
const nginxCompose = fs.readFileSync('docker-compose.nginx.yml', 'utf8');
const nginxAvailable = await canReach(`${nginxOrigin}/health/live`);
const skipWhenUnavailable = nginxAvailable ? false : `nginx same-origin front did not return healthy /health/live at ${nginxOrigin}`;

test('nginx config exposes only cmdbdynamicpages routes on the same origin', () => {
  const config = fs.readFileSync('nginx/cmdbdynamicpages.conf', 'utf8');

  assert.match(config, /listen\s+8088;/);
  assert.match(config, /limit_req_zone\s+\$binary_remote_addr\s+zone=cmdp_api:/);
  assert.match(config, /limit_req_status\s+429;/);
  assert.match(config, /location\s+\/cmdbuild\/custom-api\/\s*\{/);
  assert.match(config, /limit_req\s+zone=cmdp_api\s+burst=30\s+nodelay;/);
  assert.match(config, /location\s+\/cmdbuild\/dynamicpages\/\s*\{/);
  assert.match(config, /limit_req\s+zone=cmdp_dynamicpages\s+burst=60\s+nodelay;/);
  assert.match(config, /location\s+\/cmdbuild\/\s*\{/);
  assert.match(config, /limit_req\s+zone=cmdp_cmdbuild\s+burst=120\s+nodelay;/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8093\/cmdbuild\/;/);
  assert.match(config, /location\s+\/health\/\s*\{/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8093\/health\/;/);
  assert.match(config, /location\s+\/\s*\{/);
  assert.match(config, /return\s+404;/);
  assert.equal((config.match(/proxy_set_header Host \$\{CMDP_NGINX_PUBLIC_HOST\};/g) || []).length, 6);
  assert.equal((config.match(/proxy_set_header X-Forwarded-Host \$\{CMDP_NGINX_PUBLIC_HOST\};/g) || []).length, 6);
  assert.equal((config.match(/proxy_set_header X-Forwarded-Proto \$\{CMDP_NGINX_PUBLIC_PROTO\};/g) || []).length, 6);
  assert.doesNotMatch(config, /\$http_host/);
  assert.doesNotMatch(config, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.doesNotMatch(config, /3000|13000|13001|18080/);
});

test('nginx compose pins public forwarding defaults and probes only nginx itself', () => {
  assert.match(nginxCompose, /CMDP_NGINX_PUBLIC_HOST: "\$\{CMDP_NGINX_PUBLIC_HOST:-localhost:8088\}"/);
  assert.match(nginxCompose, /CMDP_NGINX_PUBLIC_PROTO: "\$\{CMDP_NGINX_PUBLIC_PROTO:-http\}"/);
  assert.match(nginxCompose, /nginx -t && test -s \/var\/run\/nginx\.pid && kill -0 \$\$\(cat \/var\/run\/nginx\.pid\)/);
  assert.doesNotMatch(nginxCompose, /\bwget\b/);
  assert.doesNotMatch(nginxCompose, /\/health\/live/);
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

test('nginx root does not proxy an external portal', { skip: skipWhenUnavailable }, async () => {
  const result = await request('GET', `${nginxOrigin}/`);
  assert.equal(result.statusCode, 404);
});

async function canReach(url) {
  try {
    const result = await request('GET', url, undefined, {}, 1500);
    return result.statusCode === 200;
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
