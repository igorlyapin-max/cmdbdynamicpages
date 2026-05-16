import http from 'node:http';
import { URL } from 'node:url';

const LISTEN_HOST = process.env.PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PROXY_PORT || 8091);
const CMDBUILD_ORIGIN = process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090';
const BACKEND_PREFIX = '/cmdbuild/custom-api';

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

function cmdbuildRequest(path, authToken) {
  const target = new URL(path, CMDBUILD_ORIGIN);
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: {
        accept: 'application/json',
        'CMDBuild-Authorization': authToken
      }
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
    req.end();
  });
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

  if (requestUrl.pathname === `${BACKEND_PREFIX}/session-probe`) {
    const session = await cmdbuildRequest('/cmdbuild/services/rest/v3/sessions/current', authToken);
    sendJson(res, session.ok ? 200 : 502, {
      success: session.ok,
      receivedCmdbuildCookie: true,
      forwardedAs: 'CMDBuild-Authorization header',
      cmdbuildStatus: session.statusCode,
      session: session.json && session.json.data ? {
        username: session.json.data.username,
        role: session.json.data.role,
        sessionType: session.json.data.sessionType,
        userDescription: session.json.data.userDescription
      } : null
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/classes-probe`) {
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
  console.log(`CMDBuild PoC proxy listening at http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Proxy target: ${CMDBUILD_ORIGIN}`);
  console.log(`Backend prefix: ${BACKEND_PREFIX}`);
});
