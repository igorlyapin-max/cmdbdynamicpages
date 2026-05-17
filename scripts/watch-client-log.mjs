import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const proxyOrigin = process.env.CMDBDYNAMIC_PROXY || 'http://127.0.0.1:8093';
const cookieJar = process.env.CMDBUILD_COOKIE_JAR || '/tmp/cmdbuild-ui-cookie.txt';
const cookieHeader = process.env.CMDBUILD_COOKIE_HEADER || readCookieJar(cookieJar);
const intervalMs = Number(process.env.CMDBDYNAMIC_LOG_INTERVAL_MS || 1500);
let printedClient = 0;
let printedProxy = 0;

console.log(`watching ${proxyOrigin}/cmdbuild/custom-api/client-log`);
console.log(`watching ${proxyOrigin}/cmdbuild/custom-api/proxy-log`);
console.log('reload the custom page in browser; press Ctrl+C to stop');

await poll();
setInterval(poll, intervalMs);

async function poll() {
  try {
    const clientRows = await fetchRows(`${proxyOrigin}/cmdbuild/custom-api/client-log`);
    clientRows.slice(printedClient).forEach((row, index) => {
      const number = printedClient + index + 1;
      console.log(`client ${number}. ${row.time || ''} ${row.stage || ''} ${row.message || ''}`);
      if (row.href) console.log(`   ${row.href}`);
    });
    printedClient = clientRows.length;

    const proxyRows = await fetchRows(`${proxyOrigin}/cmdbuild/custom-api/proxy-log`);
    proxyRows.slice(printedProxy).forEach((row, index) => {
      const number = printedProxy + index + 1;
      console.log(`proxy  ${number}. ${row.time || ''} ${row.method || ''} ${row.path || ''}`);
      if (row.referer) console.log(`   ${row.referer}`);
    });
    printedProxy = proxyRows.length;
  } catch (error) {
    console.log(`ERR ${error.message}`);
  }
}

async function fetchRows(url) {
  const result = await request(url);
  const payload = JSON.parse(result.body || '{}');
  return Array.isArray(payload.data) ? payload.data : [];
}

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
        accept: 'application/json',
        cookie: cookieHeader
      },
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
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
