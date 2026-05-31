import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { URL, pathToFileURL } from 'node:url';
import {
  CMDB_BUILD_VIEW_KIND,
  DEFAULT_CMDB_BUILD_VIEW_CODE,
  defaultCmdbBuildViewSpec,
  executeCmdbBuildViewSpec,
  isCmdbBuildViewSpec,
  normalizeCmdbBuildViewConfig,
  validateCmdbBuildViewSpec
} from '../src/special-renderers/cmdb-build-view.mjs';

const syslogFacilityCodes = {
  kern: 0,
  user: 1,
  mail: 2,
  daemon: 3,
  auth: 4,
  syslog: 5,
  lpr: 6,
  news: 7,
  uucp: 8,
  cron: 9,
  authpriv: 10,
  ftp: 11,
  local0: 16,
  local1: 17,
  local2: 18,
  local3: 19,
  local4: 20,
  local5: 21,
  local6: 22,
  local7: 23
};
const logLevelWeights = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

const LISTEN_HOST = process.env.PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PROXY_PORT || 8093);
const CMDBUILD_ORIGIN = process.env.CMDBUILD_ORIGIN || 'http://127.0.0.1:8090';
const BACKEND_PREFIX = '/cmdbuild/custom-api';
const DYNAMIC_UI_PREFIX = '/cmdbuild/dynamicpages/ui';
const DEFAULT_TECHNICAL_ROOT = process.env.CMDBDYNAMICPAGES_ROOT || 'Cst_QueryTool';
const CMDBUILD_REQUEST_TIMEOUT_MS = Number(process.env.CMDBUILD_REQUEST_TIMEOUT_MS || 10000);
const CMDBUILD_RETRY_ENABLED = process.env.CMDBUILD_RETRY_ENABLED !== 'false';
const CMDBUILD_RETRY_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.CMDBUILD_RETRY_MAX_ATTEMPTS || 3) || 3));
const CMDBUILD_RETRY_BASE_DELAY_MS = Math.max(10, Number(process.env.CMDBUILD_RETRY_BASE_DELAY_MS || 120) || 120);
const CMDBUILD_RETRY_MAX_DELAY_MS = Math.max(CMDBUILD_RETRY_BASE_DELAY_MS, Number(process.env.CMDBUILD_RETRY_MAX_DELAY_MS || 1200) || 1200);
const CMDBUILD_AGENT_MAX_SOCKETS = Math.max(1, Number(process.env.CMDBUILD_AGENT_MAX_SOCKETS || 50) || 50);
const CMDBUILD_AGENT_MAX_FREE_SOCKETS = Math.max(1, Number(process.env.CMDBUILD_AGENT_MAX_FREE_SOCKETS || 10) || 10);
const CSRF_SECRET = process.env.CMDBDYNAMICPAGES_CSRF_SECRET || crypto.randomBytes(32).toString('hex');
const DEV_CACHE_BUSTER = String(Date.now());
const PROXY_COOKIE_SAMESITE = process.env.CMDBDYNAMIC_PROXY_COOKIE_SAMESITE || '';
const PROXY_COOKIE_SECURE = process.env.CMDBDYNAMIC_PROXY_COOKIE_SECURE || 'false';
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Math.max(1000, Number(process.env.CMDBDYNAMIC_SHUTDOWN_TIMEOUT_MS || 10000) || 10000);
const SECURITY_HEADERS_ENABLED = process.env.CMDBDYNAMIC_SECURITY_HEADERS_ENABLED !== 'false';
const SECURITY_CSP_FRAME_ANCESTORS = String(process.env.CMDBDYNAMIC_CSP_FRAME_ANCESTORS || "'self'").replace(/[\r\n]/g, ' ').trim();
const SECURITY_HSTS_ENABLED = process.env.CMDBDYNAMIC_HSTS_ENABLED === 'true';
const SECURITY_X_FRAME_OPTIONS = String(process.env.CMDBDYNAMIC_X_FRAME_OPTIONS || '').replace(/[\r\n]/g, ' ').trim();
const DEFAULT_TEMPLATE_CACHE_TTL_HOURS = Math.min(24, Math.max(1, Number(process.env.CMDBDYNAMIC_TEMPLATE_CACHE_TTL_HOURS || 8) || 8));
const DEFAULT_TEMPLATE_CACHE_TTL_SEC = Math.round(DEFAULT_TEMPLATE_CACHE_TTL_HOURS * 60 * 60);
const RUNTIME_REFRESH_COOLDOWN_MS = Math.max(10_000, Number(process.env.CMDBDYNAMIC_REFRESH_COOLDOWN_MS || 3 * 60 * 1000) || 3 * 60 * 1000);
const RUNTIME_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.CMDBDYNAMIC_RUNTIME_CACHE_MAX_ENTRIES || 100) || 100);
const EXECUTION_THROTTLE_ENABLED = process.env.CMDBDYNAMIC_EXECUTION_THROTTLE_ENABLED !== 'false';
const EXECUTION_THROTTLE_MAX_PER_SCOPE = Math.max(1, Number(process.env.CMDBDYNAMIC_EXECUTION_THROTTLE_MAX_PER_SCOPE || 2) || 2);
const EXECUTION_THROTTLE_MAX_GLOBAL = Math.max(EXECUTION_THROTTLE_MAX_PER_SCOPE, Number(process.env.CMDBDYNAMIC_EXECUTION_THROTTLE_MAX_GLOBAL || 20) || 20);
const EXECUTION_THROTTLE_RETRY_AFTER_SEC = Math.max(1, Number(process.env.CMDBDYNAMIC_EXECUTION_THROTTLE_RETRY_AFTER_SEC || 5) || 5);
const HEALTH_TIMEOUT_MS = Math.max(500, Number(process.env.CMDBDYNAMIC_HEALTH_TIMEOUT_MS || 2000) || 2000);
const REDIS_REQUIRED = process.env.CMDBDYNAMIC_REDIS_REQUIRED === 'true';
const HEALTH_REDIS_REQUIRED = REDIS_REQUIRED || process.env.CMDBDYNAMIC_HEALTH_REDIS_REQUIRED !== 'false';
const LOG_LEVEL = normalizeLogLevel(process.env.CMDP_LOG_LEVEL || 'info');
const LOG_FORMAT = normalizeLogFormat(process.env.CMDP_LOG_FORMAT || 'json');
const LOG_TARGETS = normalizeLogTargets(process.env.CMDP_LOG_TARGET || 'stdout');
const LOG_REDACT_HEADERS = parseNameSet(process.env.CMDP_LOG_REDACT_HEADERS || 'cookie,authorization,cmdbuild-authorization,x-csrf-token,x-cmdbdynamicpages-csrf,set-cookie');
const LOG_REDACT_QUERY = parseNameSet(process.env.CMDP_LOG_REDACT_QUERY || 'password,passwd,pwd,token,secret,authorization,auth,csrf,x-cmdbdynamicpages-csrf');
const SYSLOG_HOST = process.env.CMDP_SYSLOG_HOST || '127.0.0.1';
const SYSLOG_PORT = Number(process.env.CMDP_SYSLOG_PORT || 514);
const SYSLOG_PROTOCOL = normalizeSyslogProtocol(process.env.CMDP_SYSLOG_PROTOCOL || 'udp');
const SYSLOG_FACILITY = normalizeSyslogFacility(process.env.CMDP_SYSLOG_FACILITY || 'local0');
const REDIS_URL = process.env.CMDBDYNAMIC_REDIS_URL || 'redis://127.0.0.1:6379/0';
const REDIS_PASSWORD = readSecretValue(process.env.CMDBDYNAMIC_REDIS_PASSWORD, process.env.CMDBDYNAMIC_REDIS_PASSWORD_FILE);
const REDIS_ENABLED = process.env.CMDBDYNAMIC_REDIS_ENABLED !== 'false';
const REDIS_KEY_PREFIX = process.env.CMDBDYNAMIC_REDIS_KEY_PREFIX || 'cmdp';
const REDIS_TIMEOUT_MS = Math.max(100, Number(process.env.CMDBDYNAMIC_REDIS_TIMEOUT_MS || 500) || 500);
const REDIS_RETRY_AFTER_MS = Math.max(1000, Number(process.env.CMDBDYNAMIC_REDIS_RETRY_AFTER_MS || 30000) || 30000);
const REGEX_MAX_PATTERN_LENGTH = Math.max(16, Number(process.env.CMDBDYNAMIC_REGEX_MAX_PATTERN_LENGTH || 500) || 500);
const REGEX_MAX_INPUT_LENGTH = Math.max(1024, Number(process.env.CMDBDYNAMIC_REGEX_MAX_INPUT_LENGTH || 100000) || 100000);
const DEFAULT_EMPTY_RESULT_TEXT = 'В результате вашего запроса объекты не найдены';
const DEFAULT_PERMISSION_DENIED_TEXT = 'Вам не хватает прав увидеть данные или интерфейс дизайнера';
const SNAPSHOT_MISSING_TEXT = 'Страница отсутствует для загрузки';
const BAA_POST_ONLY_TEXT = 'BAA templates are POST-only verification endpoints. Use /cmdbuild/custom-api/templates/<code>/baa-verify with a JSON request body.';
const RUNTIME_SYSTEM_PARAMS = new Set(['json']);
const STARTED_AT = new Date();
const ABSOLUTE_EXECUTION_LIMITS = {
  maxRows: 2000,
  maxClasses: 500,
  maxDomains: 500,
  maxRestCalls: 1000,
  maxTraversalDepth: 5
};
const clientLogs = [];
const proxyLogs = [];
const runtimeResultCache = new Map();
const runtimeResultInFlight = new Map();
const staticSnapshotCache = new Map();
const requestContext = new AsyncLocalStorage();
const cmdbuildHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: CMDBUILD_AGENT_MAX_SOCKETS,
  maxFreeSockets: CMDBUILD_AGENT_MAX_FREE_SOCKETS
});
const cmdbuildHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: CMDBUILD_AGENT_MAX_SOCKETS,
  maxFreeSockets: CMDBUILD_AGENT_MAX_FREE_SOCKETS
});
const executionThrottleState = {
  global: 0,
  scopes: new Map()
};
const metricsState = {
  counters: new Map(),
  gauges: new Map()
};
let shuttingDown = false;
const redisState = {
  available: null,
  lastError: '',
  lastCheckedAt: null,
  disabledUntil: 0
};

function normalizeLogLevel(value) {
  const text = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(logLevelWeights, text) ? text : 'info';
}

function normalizeLogFormat(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'text' ? 'text' : 'json';
}

function normalizeLogTargets(value) {
  const targets = String(value || 'stdout')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => item === 'stdout' || item === 'syslog');
  return targets.length ? Array.from(new Set(targets)) : ['stdout'];
}

function parseNameSet(value) {
  return new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function normalizeSyslogProtocol(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'tcp' ? 'tcp' : 'udp';
}

function normalizeSyslogFacility(value) {
  const text = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(syslogFacilityCodes, text) ? text : 'local0';
}

function logLevelEnabled(level) {
  return (logLevelWeights[level] || logLevelWeights.info) >= (logLevelWeights[LOG_LEVEL] || logLevelWeights.info);
}

function redactByName(name, value, redactSet) {
  return redactSet.has(String(name || '').toLowerCase()) ? '[REDACTED]' : value;
}

function sanitizeHeaders(headers) {
  const result = {};
  Object.entries(headers || {}).forEach(([name, value]) => {
    const normalized = String(name || '').toLowerCase();
    if (LOG_REDACT_HEADERS.has(normalized)) {
      result[name] = '[REDACTED]';
      return;
    }
    if (Array.isArray(value)) {
      result[name] = value.map((item) => truncateText(item, 300));
      return;
    }
    result[name] = truncateText(value, 300);
  });
  return result;
}

function sanitizeRequestPath(requestUrl) {
  const params = new URLSearchParams();
  requestUrl.searchParams.forEach((value, name) => {
    params.append(name, truncateText(redactByName(name, value, LOG_REDACT_QUERY), 200));
  });
  const query = params.toString();
  return truncateText(`${requestUrl.pathname}${query ? `?${query}` : ''}`, 1000);
}

function sanitizeReqUrl(req) {
  try {
    return sanitizeRequestPath(new URL(req.url || '/', `http://${req.headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`}`));
  } catch {
    return truncateText(req.url || '', 1000);
  }
}

function sessionHashFromCookie(cookieHeader) {
  const token = getCookieValue(cookieHeader, 'CMDBuild-Authorization');
  return token ? sha256Hex(token).slice(0, 16) : '';
}

function routeKind(pathname) {
  if (isHealthPath(pathname)) return 'health';
  if (isMetricsPath(pathname)) return 'metrics';
  if (pathname.startsWith(`${BACKEND_PREFIX}/`)) return 'backend';
  if (pathname === DYNAMIC_UI_PREFIX || pathname.startsWith(`${DYNAMIC_UI_PREFIX}/`)) return 'dynamic-ui';
  return 'cmdbuild-proxy';
}

function currentRequestId() {
  const store = requestContext.getStore();
  return store && store.requestId ? String(store.requestId) : '';
}

function httpTransportForTarget(target) {
  return target.protocol === 'https:' ? https : http;
}

function cmdbuildAgentForTarget(target) {
  return target.protocol === 'https:' ? cmdbuildHttpsAgent : cmdbuildHttpAgent;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cmdbuildRequestCanRetry(method, retryOption) {
  if (!CMDBUILD_RETRY_ENABLED || retryOption === false) return false;
  if (retryOption === true) return true;
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function shouldRetryCmdbuildResult(result) {
  const statusCode = Number(result && result.statusCode || 0);
  return statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504;
}

function cmdbuildRetryDelayMs(attempt, baseDelayMs = CMDBUILD_RETRY_BASE_DELAY_MS, maxDelayMs = CMDBUILD_RETRY_MAX_DELAY_MS, jitterRatio = 0.2) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, Number(attempt || 1) - 1)));
  const jitter = jitterRatio > 0 ? Math.floor(exponential * jitterRatio * Math.random()) : 0;
  return Math.min(maxDelayMs, exponential + jitter);
}

function shouldStructuredLogRequest(pathname) {
  return isHealthPath(pathname) ||
    isMetricsPath(pathname) ||
    pathname.startsWith(`${BACKEND_PREFIX}/`) ||
    pathname === DYNAMIC_UI_PREFIX ||
    pathname.startsWith(`${DYNAMIC_UI_PREFIX}/`) ||
    shouldLogProxyRequest(pathname);
}

function syslogSeverity(level) {
  if (level === 'error') return 3;
  if (level === 'warn') return 4;
  if (level === 'debug') return 7;
  return 6;
}

function sendSyslog(payload) {
  const pri = (syslogFacilityCodes[SYSLOG_FACILITY] * 8) + syslogSeverity(payload.level);
  const message = `<${pri}>1 ${payload.time} ${os.hostname()} cmdbdynamicpages ${process.pid} ${payload.event || '-'} - ${JSON.stringify(payload)}`;
  if (SYSLOG_PROTOCOL === 'tcp') {
    const socket = net.createConnection({ host: SYSLOG_HOST, port: SYSLOG_PORT }, () => {
      socket.end(`${message}\n`);
    });
    socket.setTimeout(1000, () => socket.destroy());
    socket.on('error', (error) => {
      process.stderr.write(JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        event: 'logging.syslog_failed',
        error: error.message || String(error)
      }) + '\n');
    });
    return;
  }
  const socket = dgram.createSocket('udp4');
  socket.send(Buffer.from(message), SYSLOG_PORT, SYSLOG_HOST, (error) => {
    socket.close();
    if (error) {
      process.stderr.write(JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        event: 'logging.syslog_failed',
        error: error.message || String(error)
      }) + '\n');
    }
  });
}

function writeStructuredLog(level, event, fields = {}) {
  const normalizedLevel = normalizeLogLevel(level);
  if (!logLevelEnabled(normalizedLevel)) return;
  const payload = {
    time: new Date().toISOString(),
    level: normalizedLevel,
    service: 'cmdbdynamicpages',
    event,
    ...fields
  };
  if (LOG_TARGETS.includes('stdout')) {
    const line = LOG_FORMAT === 'text'
      ? `${payload.time} ${payload.level.toUpperCase()} ${payload.event} ${JSON.stringify(fields)}`
      : JSON.stringify(payload);
    const stream = normalizedLevel === 'error' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }
  if (LOG_TARGETS.includes('syslog')) sendSyslog(payload);
}

function logDebug(event, fields) {
  writeStructuredLog('debug', event, fields);
}

function logInfo(event, fields) {
  writeStructuredLog('info', event, fields);
}

function logWarn(event, fields) {
  writeStructuredLog('warn', event, fields);
}

function logError(event, fields) {
  writeStructuredLog('error', event, fields);
}

function loggingStatus() {
  return {
    level: LOG_LEVEL,
    format: LOG_FORMAT,
    targets: LOG_TARGETS,
    redactHeaders: Array.from(LOG_REDACT_HEADERS).sort(),
    redactQuery: Array.from(LOG_REDACT_QUERY).sort(),
    syslog: LOG_TARGETS.includes('syslog') ? {
      host: SYSLOG_HOST,
      port: SYSLOG_PORT,
      protocol: SYSLOG_PROTOCOL,
      facility: SYSLOG_FACILITY
    } : null,
    elk: {
      directOutput: false,
      recommendedPipeline: 'stdout/syslog -> collector -> Elasticsearch'
    }
  };
}

const metricDefinitions = {
  cmdp_http_requests_total: { type: 'counter', help: 'HTTP requests by route, method, and status class.' },
  cmdp_http_request_duration_seconds_count: { type: 'counter', help: 'HTTP request duration observation count.' },
  cmdp_http_request_duration_seconds_sum: { type: 'counter', help: 'HTTP request duration sum in seconds.' },
  cmdp_cmdbuild_rest_requests_total: { type: 'counter', help: 'CMDBuild REST requests by method and status class.' },
  cmdp_cmdbuild_rest_errors_total: { type: 'counter', help: 'CMDBuild REST errors by method and status class.' },
  cmdp_cmdbuild_rest_retries_total: { type: 'counter', help: 'CMDBuild REST retry attempts.' },
  cmdp_redis_errors_total: { type: 'counter', help: 'Redis command errors by reason.' },
  cmdp_runtime_cache_hits_total: { type: 'counter', help: 'Runtime cache hits by backend.' },
  cmdp_runtime_cache_misses_total: { type: 'counter', help: 'Runtime cache misses by backend.' },
  cmdp_runtime_cache_build_seconds_count: { type: 'counter', help: 'Runtime cache build duration observation count.' },
  cmdp_runtime_cache_build_seconds_sum: { type: 'counter', help: 'Runtime cache build duration sum in seconds.' },
  cmdp_template_run_errors_total: { type: 'counter', help: 'Template execution failures by action and reason.' },
  cmdp_execution_throttled_total: { type: 'counter', help: 'Template execution requests rejected by throttling.' },
  cmdp_health_ready: { type: 'gauge', help: 'Readiness status: 1 ready, 0 not ready.' }
};

function metricLabelsKey(labels = {}) {
  return Object.keys(labels)
    .sort()
    .map((name) => [name, String(labels[name])]);
}

function metricKey(name, labels = {}) {
  return `${name}|${JSON.stringify(metricLabelsKey(labels))}`;
}

function incMetric(name, labels = {}, amount = 1) {
  const key = metricKey(name, labels);
  const current = metricsState.counters.get(key) || { name, labels: Object.fromEntries(metricLabelsKey(labels)), value: 0 };
  current.value += Number(amount) || 0;
  metricsState.counters.set(key, current);
  return current.value;
}

function setMetricGauge(name, labels = {}, value = 0) {
  const key = metricKey(name, labels);
  metricsState.gauges.set(key, {
    name,
    labels: Object.fromEntries(metricLabelsKey(labels)),
    value: Number(value) || 0
  });
}

function observeMetricSeconds(name, labels = {}, seconds = 0) {
  incMetric(`${name}_count`, labels, 1);
  incMetric(`${name}_sum`, labels, Math.max(0, Number(seconds) || 0));
}

function statusClass(statusCode) {
  const status = Number(statusCode) || 0;
  if (status <= 0) return 'network';
  return `${Math.floor(status / 100)}xx`;
}

function prometheusEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function prometheusSample(sample) {
  const labels = Object.entries(sample.labels || {});
  const suffix = labels.length
    ? `{${labels.map(([name, value]) => `${name}="${prometheusEscape(value)}"`).join(',')}}`
    : '';
  return `${sample.name}${suffix} ${sample.value}`;
}

function renderPrometheusMetrics() {
  const samples = [...metricsState.counters.values(), ...metricsState.gauges.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)));
  const names = Array.from(new Set(samples.map((sample) => sample.name))).sort();
  const lines = [];
  for (const name of names) {
    const definition = metricDefinitions[name] || { type: 'untyped', help: name };
    lines.push(`# HELP ${name} ${definition.help}`);
    lines.push(`# TYPE ${name} ${definition.type}`);
    samples.filter((sample) => sample.name === name).forEach((sample) => lines.push(prometheusSample(sample)));
  }
  return `${lines.join('\n')}\n`;
}

async function metricsPayload() {
  try {
    const readiness = await readinessPayload();
    setMetricGauge('cmdp_health_ready', {}, readiness.ready ? 1 : 0);
  } catch {
    setMetricGauge('cmdp_health_ready', {}, 0);
  }
  return renderPrometheusMetrics();
}

function attachHttpRequestLogging(req, res, requestUrl) {
  if (!shouldStructuredLogRequest(requestUrl.pathname)) return;
  const requestId = truncateText(req.headers['x-request-id'] || crypto.randomUUID(), 120);
  req.cmdpRequestId = requestId;
  const startedAt = Date.now();
  if (!res.headersSent) res.setHeader('x-request-id', requestId);
  const common = {
    requestId,
    method: req.method || '',
    path: sanitizeRequestPath(requestUrl),
    route: routeKind(requestUrl.pathname),
    hasCmdbuildCookie: Boolean(getCookieValue(req.headers.cookie, 'CMDBuild-Authorization')),
    sessionHash: sessionHashFromCookie(req.headers.cookie),
    userAgent: truncateText(req.headers['user-agent'] || '', 200),
    referer: truncateText(req.headers.referer || '', 500)
  };
  logDebug('http.request.start', common);
  res.on('finish', () => {
    const statusCode = res.statusCode || 0;
    const fields = {
      ...common,
      statusCode,
      durationMs: Date.now() - startedAt
    };
    incMetric('cmdp_http_requests_total', {
      route: common.route,
      method: common.method,
      status: statusClass(statusCode)
    });
    observeMetricSeconds('cmdp_http_request_duration_seconds', {
      route: common.route,
      method: common.method
    }, fields.durationMs / 1000);
    if (statusCode >= 500) logError('http.request.finish', fields);
    else if (statusCode >= 400) logWarn('http.request.finish', fields);
    else logInfo('http.request.finish', fields);
  });
}

function appendBoundedLog(target, item, maxItems = 100) {
  target.push(item);
  while (target.length > maxItems) target.shift();
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function hashJson(value) {
  return sha256Hex(stableJsonStringify(value));
}

function readSecretValue(value, filePath) {
  if (filePath) return fs.readFileSync(filePath, 'utf8').trim();
  return String(value || '');
}

function parseRedisUrl(value) {
  const parsed = new URL(value || 'redis://127.0.0.1:6379/0');
  const dbText = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.slice(1) : '0';
  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || 6379),
    password: REDIS_PASSWORD || (parsed.password ? decodeURIComponent(parsed.password) : ''),
    db: Number.isInteger(Number(dbText)) ? Number(dbText) : 0
  };
}

function sanitizeRedisUrl(value) {
  try {
    const parsed = new URL(value || 'redis://127.0.0.1:6379/0');
    if (parsed.password || REDIS_PASSWORD) parsed.password = '***';
    return parsed.toString();
  } catch {
    return REDIS_PASSWORD ? 'redis://:***@invalid-url' : String(value || '');
  }
}

function encodeRedisCommand(parts) {
  const chunks = [`*${parts.length}\r\n`];
  for (const part of parts) {
    const value = Buffer.from(String(part === undefined || part === null ? '' : part));
    chunks.push(`$${value.length}\r\n`, value, '\r\n');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
}

function redisLineEnd(buffer, offset) {
  for (let index = offset; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
  }
  return -1;
}

function parseRedisReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = redisLineEnd(buffer, offset + 1);
  if (lineEnd === -1) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const nextOffset = lineEnd + 2;
  if (type === '+') return { value: line, offset: nextOffset };
  if (type === '-') {
    const error = new Error(`Redis error: ${line}`);
    error.redisError = true;
    throw error;
  }
  if (type === ':') return { value: Number(line), offset: nextOffset };
  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: nextOffset };
    const end = nextOffset + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString('utf8', nextOffset, end), offset: end + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, offset: nextOffset };
    const values = [];
    let currentOffset = nextOffset;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRedisReply(buffer, currentOffset);
      if (!parsed) return null;
      values.push(parsed.value);
      currentOffset = parsed.offset;
    }
    return { value: values, offset: currentOffset };
  }
  throw new Error(`Unsupported Redis reply type: ${type}`);
}

async function redisCommand(parts, options = {}) {
  if (!REDIS_ENABLED) {
    incMetric('cmdp_redis_errors_total', { reason: 'disabled' });
    throw new Error('Redis is disabled.');
  }
  const now = Date.now();
  if (!options.force && redisState.disabledUntil && redisState.disabledUntil > now) {
    incMetric('cmdp_redis_errors_total', { reason: 'temporarily_unavailable' });
    throw new Error(redisState.lastError || 'Redis is temporarily unavailable.');
  }
  const config = parseRedisUrl(REDIS_URL);
  const commands = [];
  if (config.password) commands.push(['AUTH', config.password]);
  if (config.db) commands.push(['SELECT', config.db]);
  commands.push(parts);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = net.createConnection({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(`Redis command timed out after ${REDIS_TIMEOUT_MS}ms.`));
    }, REDIS_TIMEOUT_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        incMetric('cmdp_redis_errors_total', { reason: 'command_failed' });
        const previousAvailable = redisState.available;
        const previousError = redisState.lastError;
        redisState.available = false;
        redisState.lastError = error.message || String(error);
        redisState.lastCheckedAt = new Date().toISOString();
        redisState.disabledUntil = Date.now() + REDIS_RETRY_AFTER_MS;
        if (previousAvailable !== false || previousError !== redisState.lastError) {
          logWarn('redis.unavailable', {
            backend: 'memory',
            url: sanitizeRedisUrl(REDIS_URL),
            retryAfterMs: REDIS_RETRY_AFTER_MS,
            error: redisState.lastError
          });
        }
        reject(error);
      } else {
        const wasUnavailable = redisState.available === false;
        redisState.available = true;
        redisState.lastError = '';
        redisState.lastCheckedAt = new Date().toISOString();
        redisState.disabledUntil = 0;
        if (wasUnavailable) {
          logInfo('redis.available', {
            backend: 'redis',
            url: sanitizeRedisUrl(REDIS_URL)
          });
        }
        resolve(value);
      }
    }
    socket.on('connect', () => {
      commands.forEach((command) => socket.write(encodeRedisCommand(command)));
    });
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        let offset = 0;
        const replies = [];
        while (replies.length < commands.length) {
          const parsed = parseRedisReply(buffer, offset);
          if (!parsed) return;
          replies.push(parsed.value);
          offset = parsed.offset;
        }
        finish(null, replies[replies.length - 1]);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', finish);
  });
}

function cacheKey(namespace, key) {
  return `${REDIS_KEY_PREFIX}:${namespace}:${key}`;
}

function redisRequiredError(error, operation, namespace) {
  const message = error && error.message ? error.message : String(error || 'Redis is unavailable.');
  const next = new Error(`Redis is required for ${namespace} cache ${operation}, but Redis is unavailable: ${message}`);
  next.statusCode = 503;
  next.redisRequired = true;
  return next;
}

function memoryGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return cloneJsonValueServer(entry.value, null);
}

function memorySet(map, key, value, ttlMs) {
  map.set(key, {
    value: cloneJsonValueServer(value, null),
    expiresAt: ttlMs ? Date.now() + ttlMs : 0
  });
  while (map.size > RUNTIME_CACHE_MAX_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (!firstKey) break;
    map.delete(firstKey);
  }
}

async function cacheGetJson(namespace, key, memoryMap) {
  if (REDIS_ENABLED) {
    try {
      const value = await redisCommand(['GET', cacheKey(namespace, key)]);
      if (value) {
        if (namespace === 'runtime') incMetric('cmdp_runtime_cache_hits_total', { backend: 'redis' });
        return { backend: 'redis', value: JSON.parse(value) };
      }
      if (namespace === 'runtime') incMetric('cmdp_runtime_cache_misses_total', { backend: 'redis' });
      return { backend: 'redis', value: null };
    } catch (error) {
      if (REDIS_REQUIRED) throw redisRequiredError(error, 'read', namespace);
      // Redis fallback is expected in local dev when Redis is not started.
    }
  } else if (REDIS_REQUIRED) {
    throw redisRequiredError(new Error('Redis is disabled.'), 'read', namespace);
  }
  const value = memoryGet(memoryMap, key);
  if (namespace === 'runtime') {
    incMetric(value ? 'cmdp_runtime_cache_hits_total' : 'cmdp_runtime_cache_misses_total', { backend: 'memory' });
  }
  return { backend: 'memory', value };
}

async function cacheSetJson(namespace, key, value, ttlMs, memoryMap) {
  if (REDIS_ENABLED) {
    try {
      const args = ['SET', cacheKey(namespace, key), JSON.stringify(value)];
      if (ttlMs) args.push('PX', Math.max(1, Math.floor(ttlMs)));
      await redisCommand(args);
      return 'redis';
    } catch (error) {
      if (REDIS_REQUIRED) throw redisRequiredError(error, 'write', namespace);
      // Fall through to in-memory fallback.
    }
  } else if (REDIS_REQUIRED) {
    throw redisRequiredError(new Error('Redis is disabled.'), 'write', namespace);
  }
  memorySet(memoryMap, key, value, ttlMs);
  return 'memory';
}

async function cacheDelete(namespace, key, memoryMap) {
  if (REDIS_ENABLED) {
    try {
      await redisCommand(['DEL', cacheKey(namespace, key)]);
    } catch (error) {
      if (REDIS_REQUIRED) throw redisRequiredError(error, 'delete', namespace);
      // Ignore Redis delete failures; memory fallback is still cleared.
    }
  } else if (REDIS_REQUIRED) {
    throw redisRequiredError(new Error('Redis is disabled.'), 'delete', namespace);
  }
  memoryMap.delete(key);
}

async function redisStatus(options = {}) {
  if (!REDIS_ENABLED) {
    return {
      enabled: false,
      required: REDIS_REQUIRED,
      backend: 'memory',
      available: false,
      url: sanitizeRedisUrl(REDIS_URL),
      keyPrefix: REDIS_KEY_PREFIX,
      message: 'Redis is disabled by CMDBDYNAMIC_REDIS_ENABLED=false.'
    };
  }
  try {
    const pong = await redisCommand(['PING'], options);
    return {
      enabled: true,
      required: REDIS_REQUIRED,
      backend: 'redis',
      available: pong === 'PONG',
      url: sanitizeRedisUrl(REDIS_URL),
      keyPrefix: REDIS_KEY_PREFIX,
      lastCheckedAt: redisState.lastCheckedAt
    };
  } catch (error) {
    return {
      enabled: true,
      required: REDIS_REQUIRED,
      backend: 'memory',
      available: false,
      url: sanitizeRedisUrl(REDIS_URL),
      keyPrefix: REDIS_KEY_PREFIX,
      lastCheckedAt: redisState.lastCheckedAt,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function baseHealthPayload() {
  return {
    service: 'cmdbdynamicpages',
    timestamp: new Date().toISOString(),
    startedAt: STARTED_AT.toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid
  };
}

function isHealthPath(pathname) {
  return [
    '/health/live',
    '/health/ready',
    '/health/redis',
    `${BACKEND_PREFIX}/health/live`,
    `${BACKEND_PREFIX}/health/ready`,
    `${BACKEND_PREFIX}/health/redis`
  ].includes(pathname);
}

function isMetricsPath(pathname) {
  return pathname === '/metrics';
}

function healthKindFromPath(pathname) {
  if (pathname.endsWith('/live')) return 'live';
  if (pathname.endsWith('/redis')) return 'redis';
  return 'ready';
}

function checkCmdbuildUpstream() {
  const target = new URL('/cmdbuild/services/rest/v3/sessions/current', CMDBUILD_ORIGIN);
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({
        url: `${target.origin}${target.pathname}`,
        latencyMs: Date.now() - started,
        ...payload
      });
    };
    const transport = httpTransportForTarget(target);
    const probeReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: { accept: 'application/json' },
      agent: cmdbuildAgentForTarget(target)
    }, (probeRes) => {
      probeRes.resume();
      probeRes.on('end', () => {
        const statusCode = probeRes.statusCode || 0;
        finish({
          ok: statusCode >= 200 && statusCode < 500,
          statusCode
        });
      });
    });
    probeReq.on('error', (error) => {
      finish({
        ok: false,
        statusCode: 0,
        error: error && error.message ? error.message : String(error)
      });
    });
    probeReq.setTimeout(HEALTH_TIMEOUT_MS, () => {
      probeReq.destroy(new Error(`CMDBuild health probe timed out after ${HEALTH_TIMEOUT_MS}ms.`));
    });
    probeReq.end();
  });
}

function redisHealthCheck(redis) {
  const ok = Boolean(REDIS_ENABLED && redis && redis.available);
  return {
    required: HEALTH_REDIS_REQUIRED,
    ok,
    status: ok ? 'ok' : REDIS_ENABLED ? 'unavailable' : 'disabled',
    ...redis
  };
}

async function readinessPayload() {
  const [redis, cmdbuild] = await Promise.all([
    redisStatus({ force: true }),
    checkCmdbuildUpstream()
  ]);
  const checks = {
    process: {
      ok: true,
      status: 'ok'
    },
    redis: redisHealthCheck(redis),
    cmdbuild: {
      required: true,
      ok: Boolean(cmdbuild.ok),
      status: cmdbuild.ok ? 'ok' : 'unavailable',
      ...cmdbuild
    }
  };
  const ready = checks.cmdbuild.ok && (!HEALTH_REDIS_REQUIRED || checks.redis.ok);
  return {
    ...baseHealthPayload(),
    status: ready ? 'ready' : 'not_ready',
    ready,
    checks
  };
}

async function handleHealth(req, res, requestUrl) {
  if (!methodAllowed(req, res, 'GET')) return;
  const kind = healthKindFromPath(requestUrl.pathname);
  if (kind === 'live') {
    sendJson(res, 200, {
      ...baseHealthPayload(),
      status: 'live',
      live: true
    });
    return;
  }
  if (kind === 'redis') {
    const payload = {
      ...baseHealthPayload(),
      redis: redisHealthCheck(await redisStatus({ force: true }))
    };
    const ok = payload.redis.ok;
    payload.status = ok ? 'ok' : 'not_ready';
    sendJson(res, ok ? 200 : 503, payload);
    return;
  }
  const payload = await readinessPayload();
  sendJson(res, payload.ready ? 200 : 503, payload);
}

function cloneJsonValueServer(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? fallback : value));
  } catch {
    return fallback;
  }
}

function isBaaVerificationSpec(spec) {
  return Boolean(spec && spec.endpoint && spec.endpoint.kind === 'baaVerification');
}

function addUniqueString(list, value) {
  const text = String(value || '').trim();
  if (text && !list.includes(text)) list.push(text);
}

function collectBaaSourceAliasesForMissingInputs(spec) {
  const steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
  const produced = new Set(steps.map((step) => step && step.as).filter(Boolean));
  const aliases = [];
  steps.forEach((step) => {
    if (!step || typeof step !== 'object') return;
    if (step.type === 'enrichRows' && step.from && !produced.has(step.from)) addUniqueString(aliases, step.from);
    if (step.type === 'matchRows') {
      if (step.from && !produced.has(step.from)) addUniqueString(aliases, step.from);
      if (step.with && !produced.has(step.with)) addUniqueString(aliases, step.with);
    }
  });

  const visualModels = [];
  if (spec && spec.visualModel && typeof spec.visualModel === 'object' && !Array.isArray(spec.visualModel)) {
    visualModels.push(spec.visualModel);
  }
  if (spec && Array.isArray(spec.visualModels)) {
    spec.visualModels.forEach((model) => {
      if (model && typeof model === 'object' && !Array.isArray(model)) visualModels.push(model);
    });
  }
  visualModels.forEach((model) => {
    if (model.mode !== 'viewComposer') return;
    const alias = model.sourceAlias || model.source && model.source.alias || '';
    if (alias && !produced.has(alias)) addUniqueString(aliases, alias);
  });

  if (!steps.length && !steps.some((step) => step && step.type === 'baaPlanObjects') && !aliases.length) aliases.push('baaObjects');
  return aliases;
}

function ensureBaaPlanObjectSourceSteps(spec) {
  if (!isBaaVerificationSpec(spec)) return spec;
  const next = cloneJsonValueServer(spec, spec);
  const steps = Array.isArray(next.steps) ? next.steps.slice() : [];
  const existing = new Set(steps.filter((step) => step && step.type === 'baaPlanObjects').map((step) => step.as).filter(Boolean));
  const missingAliases = collectBaaSourceAliasesForMissingInputs({ ...next, steps }).filter((alias) => !existing.has(alias));
  missingAliases.reverse().forEach((alias) => {
    steps.unshift({ type: 'baaPlanObjects', as: alias, payloadPrefix: 'Payload.' });
  });
  next.steps = steps;
  return next;
}

function shouldLogProxyRequest(pathname) {
  return pathname === '/cmdbuild/ui' ||
    pathname === '/cmdbuild/ui/' ||
    pathname === '/cmdbuild/ui/config.js' ||
    pathname === '/cmdbuild/ui/cmdbuild/app.js' ||
    pathname === '/cmdbuild/ui/hda/app.js' ||
    pathname.endsWith('/cmdbuild.json') ||
    pathname.endsWith('/hda.json') ||
    pathname.includes('/custompages/CmdbDynamicPages') ||
    pathname.includes('/view/custompages/CmdbDynamicPages/');
}

function isCmdbDynamicPagesScript(pathname) {
  return pathname.endsWith('/view/custompages/CmdbDynamicPages/CmdbDynamicPages.js');
}

function isCmdbuildUiEntry(pathname) {
  return pathname === '/cmdbuild/ui' || pathname === '/cmdbuild/ui/';
}

function isCmdbuildUiManifest(pathname) {
  return pathname === '/cmdbuild/ui/cmdbuild.json' || pathname === '/cmdbuild/ui/hda.json';
}

function isCmdbuildUiCacheSensitive(pathname) {
  return isCmdbuildUiEntry(pathname) ||
    isCmdbuildUiManifest(pathname) ||
    pathname === '/cmdbuild/ui/config.js' ||
    pathname === '/cmdbuild/ui/cmdbuild/app.js' ||
    pathname === '/cmdbuild/ui/hda/app.js' ||
    isCmdbDynamicPagesScript(pathname);
}

function logProxyRequest(req, requestUrl) {
  if (!shouldLogProxyRequest(requestUrl.pathname)) return;
  appendBoundedLog(proxyLogs, {
    time: new Date().toISOString(),
    method: req.method || '',
    path: truncateText(`${requestUrl.pathname}${requestUrl.search}`, 500),
    referer: truncateText(req.headers.referer || '', 500),
    userAgent: truncateText(req.headers['user-agent'] || '', 200)
  });
}

function withNoStoreHeaders(headers) {
  const responseHeaders = { ...headers };
  responseHeaders['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
  responseHeaders.pragma = 'no-cache';
  responseHeaders.expires = '0';
  delete responseHeaders.etag;
  delete responseHeaders['content-length'];
  delete responseHeaders['transfer-encoding'];
  return responseHeaders;
}

function normalizeSameSiteValue(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'lax') return 'Lax';
  if (text === 'strict') return 'Strict';
  if (text === 'none') return 'None';
  return '';
}

function shouldMarkProxyCookieSecure() {
  const value = String(PROXY_COOKIE_SECURE || '').trim().toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'no';
}

function rewriteProxySetCookieHeader(header) {
  if (!header) return header;
  const sameSite = normalizeSameSiteValue(PROXY_COOKIE_SAMESITE);
  const secure = shouldMarkProxyCookieSecure();
  function rewriteOne(cookie) {
    const parts = String(cookie || '').split(';').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return cookie;
    const rewritten = [parts[0]];
    let hasSecure = false;
    for (const part of parts.slice(1)) {
      if (/^samesite=/i.test(part)) continue;
      if (/^secure$/i.test(part)) {
        hasSecure = true;
        rewritten.push('Secure');
        continue;
      }
      rewritten.push(part);
    }
    if (sameSite) rewritten.push(`SameSite=${sameSite}`);
    if (secure && !hasSecure) rewritten.push('Secure');
    return rewritten.join('; ');
  }
  return Array.isArray(header) ? header.map(rewriteOne) : rewriteOne(header);
}

function rewriteProxyResponseHeaders(headers) {
  const responseHeaders = { ...headers };
  if (responseHeaders['set-cookie']) {
    responseHeaders['set-cookie'] = rewriteProxySetCookieHeader(responseHeaders['set-cookie']);
  }
  return responseHeaders;
}

function rewriteCmdbuildUiHtml(body) {
  const injection = [
    '<script type="text/javascript">',
    '(function(){try{',
    'var p="_ext:"+window.location.pathname;',
    'if(window.localStorage){',
    'for(var i=window.localStorage.length-1;i>=0;i--){',
    'var k=window.localStorage.key(i);',
    'if(k&&(k.indexOf(p)===0||k.indexOf("_ext:/cmdbuild/ui/")===0)){window.localStorage.removeItem(k);}',
    '}',
    '}',
    'document.cookie="ext-cache=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";',
    'if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(x){x.unregister();});});}',
    'var pendingKey="cmdbdynamicpages.pendingTarget";',
    'function parseQuery(q){var r={};String(q||"").replace(/^\\?/,"").split("&").forEach(function(part){if(!part)return;var i=part.indexOf("=");var k=i===-1?part:part.slice(0,i);var v=i===-1?"":part.slice(i+1);k=decodeURIComponent(k.replace(/\\+/g," "));if(k)r[k]=decodeURIComponent(v.replace(/\\+/g," "));});return r;}',
    'function buildQuery(params){var pairs=[];Object.keys(params||{}).forEach(function(k){if(params[k]===undefined||params[k]===null)return;pairs.push(encodeURIComponent(k)+"="+encodeURIComponent(String(params[k])));});return pairs.join("&");}',
    'function readHashRoute(){var h=window.location.hash||"";var marker="custompages/CmdbDynamicPages";var at=h.indexOf(marker);if(at===-1)return{path:[],params:{}};var suffix=h.slice(at+marker.length).replace(/^\\/+/, "");var query="";var qi=suffix.indexOf("?");if(qi!==-1){query=suffix.slice(qi+1);suffix=suffix.slice(0,qi);}return{path:suffix.split("/").filter(Boolean).map(decodeURIComponent),params:parseQuery(query)};}',
    'function dynamicTarget(){var query=parseQuery(window.location.search||"");var route=readHashRoute();var params={};Object.keys(route.params||{}).forEach(function(k){params[k]=route.params[k];});Object.keys(query||{}).forEach(function(k){params[k]=query[k];});var mode=params.cmdpMode||"";var code=params.cmdpTemplate||"";delete params.cmdpMode;delete params.cmdpTemplate;if(!code&&route.path&&route.path.length){if(route.path[0]==="designer"){mode="designer";}else{code=route.path[0];}}if(!(mode||code||(window.location.hash||"").indexOf("custompages/CmdbDynamicPages")!==-1))return"";var q=buildQuery(params);if(mode==="designer"||!code)return"/cmdbuild/dynamicpages/ui/designer"+(q?"?"+q:"");return"/cmdbuild/dynamicpages/ui/run/"+encodeURIComponent(code)+(q?"?"+q:"");}',
    'var target=dynamicTarget();',
    'if(target&&window.sessionStorage){window.sessionStorage.setItem(pendingKey,target);}',
    'var pending=window.sessionStorage&&window.sessionStorage.getItem(pendingKey)||"";',
    'function clearPending(){try{if(window.sessionStorage)window.sessionStorage.removeItem(pendingKey);}catch(e){}}',
    'function showPendingLink(){if(!pending||document.getElementById("cmdp-login-fallback-link")||!document.body)return;var a=document.createElement("a");a.id="cmdp-login-fallback-link";a.href=pending;a.textContent="Open CMDB Dynamic Pages";a.style.cssText="position:fixed;right:14px;bottom:14px;z-index:2147483647;background:#236c91;color:#fff;padding:9px 12px;border-radius:4px;text-decoration:none;font:600 13px Arial,sans-serif;box-shadow:0 6px 16px rgba(15,23,42,.18)";document.body.appendChild(a);}',
    'if(pending){if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",showPendingLink);}else{showPendingLink();}fetch("/cmdbuild/custom-api/session",{credentials:"include",headers:{Accept:"application/json"}}).then(function(r){if(r.ok){clearPending();window.location.replace(pending);}}).catch(function(){});}',
    '}catch(e){}})();',
    '</script>'
  ].join('');
  if (body.indexOf('cmdbdynamicpages-dev-cache-reset') !== -1) return body;
  return body.replace('<head>', '<head>\n<meta name="cmdbdynamicpages-dev-cache-reset" content="' + DEV_CACHE_BUSTER + '">\n' + injection);
}

function rewriteCmdbuildManifest(body) {
  try {
    const manifest = JSON.parse(body);
    manifest.cache = manifest.cache || {};
    manifest.cache.enable = false;
    manifest.appCacheEnabled = false;
    manifest.loader = manifest.loader || {};
    manifest.loader.cache = DEV_CACHE_BUSTER;
    manifest.hash = `${manifest.hash || 'dev'}-${DEV_CACHE_BUSTER}`;
    return JSON.stringify(manifest);
  } catch {
    return body;
  }
}

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

function securityHeaders(extra = {}) {
  const headers = {};
  if (SECURITY_HEADERS_ENABLED) {
    headers['x-content-type-options'] = 'nosniff';
    headers['referrer-policy'] = 'same-origin';
    headers['permissions-policy'] = 'camera=(), microphone=(), geolocation=()';
    if (SECURITY_CSP_FRAME_ANCESTORS && SECURITY_CSP_FRAME_ANCESTORS !== 'false') {
      headers['content-security-policy'] = `frame-ancestors ${SECURITY_CSP_FRAME_ANCESTORS}; base-uri 'self'; object-src 'none'`;
    }
    if (SECURITY_HSTS_ENABLED) {
      headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
    }
    if (SECURITY_X_FRAME_OPTIONS) {
      headers['x-frame-options'] = SECURITY_X_FRAME_OPTIONS;
    }
  }
  return {
    ...headers,
    ...extra
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  }));
  res.end(body);
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, securityHeaders({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, securityHeaders({
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function isPermissionDeniedStatus(statusCode) {
  const status = Number(statusCode);
  return status === 401 || status === 403;
}

function sendTechnicalSchemaAccessDenied(res, details = {}) {
  sendJson(res, 403, {
    success: false,
    reason: 'technical_schema_access_denied',
    message: DEFAULT_PERMISSION_DENIED_TEXT,
    permissionDeniedText: DEFAULT_PERMISSION_DENIED_TEXT,
    cmdbuildStatus: details.cmdbuildStatus || details.statusCode || 403,
    root: details.root || DEFAULT_TECHNICAL_ROOT,
    className: details.className || ''
  });
}

function sendTechnicalSchemaAccessDeniedIfNeeded(res, details = {}) {
  const status = details.cmdbuildStatus || details.statusCode;
  if (!isPermissionDeniedStatus(status)) return false;
  sendTechnicalSchemaAccessDenied(res, details);
  return true;
}

function redirect(res, location) {
  res.writeHead(302, securityHeaders({
    location,
    'cache-control': 'no-store'
  }));
  res.end();
}

function htmlEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractDesignerSection(pathname, requestUrl) {
  const designerPrefix = `${DYNAMIC_UI_PREFIX}/designer/`;
  const fromQuery = requestUrl.searchParams.get('section') || requestUrl.searchParams.get('cmdpSection') || '';
  const raw = fromQuery || (pathname.startsWith(designerPrefix) ? pathname.slice(designerPrefix.length).split('/')[0] : '');
  const section = decodeURIComponent(raw || '').trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(section) ? section : '';
}

function renderDynamicPagesShell({ mode, session, templateCode = '', designerSection = '', publicRuntime = false }) {
  const boot = JSON.stringify({
    mode,
    session,
    templateCode,
    designerSection,
    publicRuntime,
    apiPrefix: BACKEND_PREFIX
  });
  const headerHtml = mode === 'runtime' ? '' : `
  <header>
    <h1 id="cmdp-title">CMDB Dynamic Pages</h1>
    <div class="header-side">
      <label class="language-field"><span id="cmdp-language-label">Language</span><select id="cmdp-language"><option value="en">English</option><option value="ru">Русский</option></select></label>
      <button class="catalog-header-button" id="cmdp-catalog-header" data-action="sync-catalog" type="button"><span class="lamp" id="cmdp-catalog-lamp"></span><span id="cmdp-catalog-label">Catalog</span></button>
      <div class="muted" id="cmdp-session-label">${htmlEscape(session.username || '')} / ${htmlEscape(session.role || '')}</div>
    </div>
  </header>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CMDB Dynamic Pages</title>
  <style>
    :root{color-scheme:light;--bg:#f6f8fa;--panel:#fff;--line:#d8dee6;--text:#1f2933;--muted:#66788a;--accent:#0b6b6f;--danger:#b42318;--warn:#a56b00;--ok:#257a45}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:13px/1.4 Arial,sans-serif}
    header{min-height:48px;display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--line);background:#fff;gap:12px}
    .header-side{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}.language-field{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.language-field select{min-width:116px;padding:4px 6px}.catalog-header-button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;color:var(--text);padding:4px 7px;border-radius:4px;font-size:12px}
    h1{font-size:18px;margin:0} h2{font-size:15px;margin:0 0 10px} h3{font-size:13px;margin:12px 0 6px;color:#334e68}
    p{margin:0 0 8px}.guide-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.guide-card{border:1px solid var(--line);padding:10px;background:#fbfdff}.guide-card h3{margin-top:0}.steps{margin:8px 0 0;padding-left:20px}.steps li{margin:4px 0}.code-inline{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f8fafc;border:1px solid var(--line);padding:1px 4px;border-radius:3px}
    main{padding:14px 16px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
    .runtime-page{background:#fff}.runtime-page main{padding:8px}.runtime-page .result-table-wrap:first-child{margin-top:0}.runtime-page .notice{margin:0}.run-launch-url{display:flex;align-items:center;gap:6px;min-width:260px;max-width:100%;flex:1 1 420px}.run-launch-url span,.run-launch-params span{color:var(--muted);font-size:12px;white-space:nowrap}.run-launch-url a{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--accent);overflow-wrap:anywhere}.run-launch-params{display:flex;align-items:center;gap:6px;min-width:260px;max-width:100%;flex:1 1 100%;font-size:12px}.run-launch-params code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#334e68;background:#f8fafc;border:1px solid var(--line);padding:2px 4px;overflow-wrap:anywhere;white-space:normal}
    .designer-menu{position:fixed;left:16px;top:64px;bottom:14px;width:246px;overflow:auto;border:1px solid var(--line);background:#fff;padding:10px;display:grid;gap:10px;z-index:10}.designer-main{margin-left:266px}.designer-actionbar{position:sticky;top:0;z-index:30;border:1px solid var(--line);background:rgba(255,255,255,.96);box-shadow:0 6px 16px rgba(15,23,42,.08);padding:8px 10px;margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.designer-actionbar-title{font-weight:bold;color:#334e68;white-space:nowrap}.designer-actionbar-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0;flex:1 1 auto}.designer-actionbar-context{display:flex;align-items:center;gap:8px;min-width:240px;max-width:100%;flex:1 1 420px}.designer-actionbar-context .run-launch-url{min-width:0;flex:1 1 auto}.menu-groups{display:grid;grid-template-columns:1fr;gap:10px}.menu-group strong{display:block;font-size:12px;color:#334e68;margin-bottom:6px}.menu-links{display:grid;grid-template-columns:1fr;gap:5px}.menu-links a{border:1px solid var(--line);background:#f8fafc;color:var(--text);padding:5px 7px;border-radius:4px;text-decoration:none;font-size:12px}.menu-links a.active{background:#e6f4f1;border-color:#86b7b3;color:#07575b;font-weight:bold}.menu-links a.disabled{background:#f4f6f8;color:#9aa5b1;border-color:#e4e7eb;cursor:not-allowed}.template-context{border:1px solid #b7d8d4;background:#f2faf8;padding:8px 10px;margin-bottom:12px}.template-context strong{margin-right:6px}.template-context .code-inline{font-weight:bold}
    button,a.button{border:1px solid #9fb3c8;background:#fff;color:var(--text);padding:6px 10px;border-radius:4px;cursor:pointer;text-decoration:none;display:inline-block}
    button.primary,a.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
    button.danger,a.button.danger{border-color:#f0b8b0;color:var(--danger);background:#fff7f5}
    button.link{border:0;background:transparent;color:var(--accent);padding:0;text-align:left}
    .lamp{width:13px;height:13px;border-radius:50%;display:inline-block;border:1px solid rgba(0,0,0,.2);background:#9aa5b1;box-shadow:0 0 0 2px rgba(0,0,0,.03)}
    .lamp.ok{background:var(--ok)}.lamp.warn{background:#d99a21}.lamp.error{background:var(--danger)}.lamp.loading{background:#3b82f6}
    .layout{display:grid;grid-template-columns:minmax(280px,1fr) minmax(460px,2fr);gap:14px}.panel{background:var(--panel);border:1px solid var(--line);padding:12px}
    .section{background:var(--panel);border:1px solid var(--line);padding:12px;margin-bottom:12px}.section-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:10px 0 6px}.section-title-row h3,.section-title-row h4{margin:0}
    .object-selection{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}
    .matching-block{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}
    .matching-rule-list{display:grid;gap:10px;margin-top:8px}
    .matching-rule-card{border:1px solid var(--line);background:#fbfdff;padding:10px;display:grid;gap:8px}
    .matching-rule-head{display:flex;gap:8px;align-items:end;justify-content:space-between;flex-wrap:wrap}
    .matching-rule-head label,.matching-rule-part label,.matching-rule-operator label{display:grid;gap:4px;color:var(--muted);font-size:12px}
    .matching-rule-part,.matching-rule-operator{border:1px solid #e4e9f0;background:#fff;padding:8px;display:grid;gap:8px}
    .matching-rule-part strong,.matching-rule-operator strong{font-size:12px;color:#334e68}
    .matching-rule-fields{display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,1fr);gap:8px}
    .matching-rule-operator .matching-rule-fields{grid-template-columns:minmax(120px,160px) minmax(220px,1fr)}
    .matching-ipv4-examples{margin-top:8px}
    .row{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.form{display:grid;gap:8px}.form label,.row label{display:grid;gap:4px;color:var(--muted);font-size:12px}
    input,textarea,select{box-sizing:border-box;max-width:100%;border:1px solid #bcccdc;border-radius:4px;padding:6px;font:13px Arial,sans-serif;color:var(--text);background:#fff}
    textarea{min-height:96px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.tall{min-height:180px}.checkbox{display:flex!important;gap:6px;align-items:center;color:var(--text)!important}
    table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:#f0f4f8}.compact th,.compact td{font-size:12px;padding:4px 6px}.compact tr.selected td{background:#eef8f6}
    .notice{padding:8px 10px;border:1px solid var(--line);background:#f8fafc;margin:8px 0}.notice.error{border-color:#f0b8b0;color:var(--danger);background:#fff7f5}.notice.ok{border-color:#a7d8b5;color:var(--ok);background:#f4fbf6}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.kpi{border:1px solid var(--line);padding:8px}.kpi span{display:block;color:var(--muted);font-size:12px}.kpi strong{display:block;font-size:14px}
    .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:12px}.pill.ok{border-color:#82c995;color:var(--ok)}.pill.error{border-color:#f0b8b0;color:var(--danger)}
    .model{display:grid;gap:10px;max-height:520px;overflow:auto}.muted{color:var(--muted)}pre{white-space:pre-wrap;background:#f8fafc;border:1px solid var(--line);padding:8px;overflow:auto}
    .visual-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.visual-grid label{min-width:0}.visual-grid input,.visual-grid select{width:100%}.visualization-table{table-layout:fixed}.visualization-table th,.visualization-table td{overflow-wrap:anywhere}.visualization-table th:nth-child(1){width:30%}.visualization-table th:nth-child(2){width:14%}.visualization-table th:nth-child(3){width:15%}.visualization-table th:nth-child(4){width:26%}.visualization-table th:nth-child(5){width:15%}.visualization-table input,.visualization-table select{width:100%;min-width:0}.visualization-link-table{table-layout:fixed}.visualization-link-table th,.visualization-link-table td{overflow-wrap:anywhere}.visualization-link-table input,.visualization-link-table select{width:100%;min-width:0}.visual-row-groups{margin-top:10px;display:grid;gap:6px}.visual-row-group{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.visual-row-group label{flex:1 1 240px;min-width:0}.visual-row-group select{width:100%;min-width:0}.result-table-wrap{margin-top:8px}.result-table-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-height:30px;margin:0 0 2px}.result-table-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 4px;min-height:30px}.result-table-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:0 0 auto;flex-wrap:wrap}.result-table-filter{width:240px;max-width:min(52vw,320px);height:30px;padding:4px 7px}.runtime-cache-control{position:relative;display:inline-flex;align-items:center}.runtime-cache-button{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:18px;line-height:1}.runtime-cache-button[data-disabled="true"]{opacity:.55;cursor:default}.runtime-cache-button.refreshing{animation:cmdp-spin 1s linear infinite}.runtime-cache-tooltip{display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:50;min-width:250px;max-width:min(86vw,420px);padding:8px 10px;border:1px solid var(--line);background:#1f2933;color:#fff;box-shadow:0 8px 22px rgba(15,23,42,.18);font-size:12px;line-height:1.35;text-align:left}.runtime-cache-tooltip span{display:block;white-space:nowrap}.runtime-cache-control:hover .runtime-cache-tooltip,.runtime-cache-control:focus-within .runtime-cache-tooltip{display:block}.result-table-title{display:flex;align-items:center;gap:8px;flex:1 1 auto;flex-wrap:wrap;min-width:0;margin:0}.result-table-title h3{margin:0;font-size:13px}.result-subtitle{font-size:12px;color:var(--muted);margin:10px 0 4px}.table-sort{border:0;background:transparent;padding:0;color:inherit;font:inherit;text-align:left}.table-sort:after{content:" ↕";font-size:10px;color:var(--muted)}.cmdp-density-compact th,.cmdp-density-compact td{padding:4px 6px}.cmdp-font-small{font-size:12px}.cmdp-font-normal{font-size:13px}.cmdp-font-large{font-size:15px}.cmdp-zebra tbody tr:nth-child(even) td{background:#fbfdff}.cmdp-row-group-cell{background:#f8fafc;font-weight:600;vertical-align:top}@keyframes cmdp-spin{to{transform:rotate(360deg)}}
    .cmdp-html-result{display:block}.cmdp-build-view{display:grid;gap:10px}.cmdp-build-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding-bottom:6px}.cmdp-build-toolbar-main{display:grid;gap:5px;min-width:0}.cmdp-build-summary,.cmdp-build-nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.cmdp-build-nav a{color:var(--accent);text-decoration:none;font-size:12px}.cmdp-build-search{flex:0 0 260px;max-width:min(42vw,320px)}.cmdp-build-section{display:grid;gap:8px}.cmdp-build-section h2{font-size:15px;margin:8px 0 0}.cmdp-build-panel{border:1px solid var(--line);background:#fff;margin:0 0 8px}.cmdp-build-panel>summary{cursor:pointer;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;background:#fbfdff}.cmdp-build-title{font-weight:700}.cmdp-build-panel .table-wrap{border:0;border-top:1px solid var(--line)}.cmdp-build-table{width:100%;table-layout:auto}.cmdp-build-table th,.cmdp-build-table td{vertical-align:top}.cmdp-build-related,.cmdp-build-links{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 10px}.cmdp-build-related a,.cmdp-build-links a{color:var(--accent);text-decoration:none}
    .settings-block{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.settings-block:first-of-type{border-top:0;margin-top:0;padding-top:0}.settings-block h3{margin:0 0 8px}.settings-block h4{margin:0 0 7px;font-size:12px;color:#334e68}.settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}.settings-grid label{display:grid;gap:4px;color:var(--muted);font-size:12px;min-width:0}.settings-grid input,.settings-grid select{width:100%;min-width:0}.checkbox-list{display:grid;gap:8px}.checkbox-stacked{align-items:flex-start!important}.checkbox-stacked>span{display:grid;gap:2px}.checkbox-stacked strong{font-size:12px;color:var(--text)}.visual-table-list{display:grid;gap:12px}.visual-table-panel{border:1px solid var(--line);background:#fbfdff;padding:10px}.visual-table-heading{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.visual-table-heading h3{margin:0}.visual-table-subblock{border-top:1px solid #e4e9f0;padding-top:9px;margin-top:9px}.run-param-list{display:grid;gap:8px}.run-param-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1.4fr);gap:10px;align-items:start;border:1px solid var(--line);background:#fbfdff;padding:8px}.run-param-main{display:grid;gap:3px;min-width:0}.run-param-main strong{font-size:13px}.run-param-meta{font-size:12px;color:var(--muted)}.run-param-value label{display:grid;gap:4px;color:var(--muted);font-size:12px}.run-param-value input,.run-param-value select{width:100%}.run-action-grid{display:grid;grid-template-columns:minmax(220px,max-content) minmax(280px,1fr);gap:10px;align-items:start}.run-action-buttons{display:flex;gap:8px;flex-wrap:wrap}
    .baa-contract-summary{display:grid;gap:10px}.baa-contract-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.baa-contract-meta div{border:1px solid var(--line);background:#fbfdff;padding:8px;min-width:0}.baa-contract-meta span{display:block;color:var(--muted);font-size:11px;margin-bottom:3px}.baa-contract-meta strong{display:block;font-size:13px;overflow-wrap:anywhere}.baa-contract-table{width:100%;border-collapse:collapse;table-layout:fixed}.baa-contract-table th,.baa-contract-table td{border:1px solid var(--line);padding:6px;text-align:left;vertical-align:top;font-size:12px}.baa-contract-table th{background:#f0f4f8;color:#334e68}.baa-usage-note{border:1px solid #d9e2ec;background:#fbfdff;padding:8px;color:#334e68;font-size:12px;line-height:1.45}
    @media(max-width:1100px){.designer-menu{position:static;width:auto;overflow:visible;margin-bottom:12px}.designer-main{margin-left:0}.menu-groups{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.menu-links{display:flex;flex-wrap:wrap}}
    @media(max-width:900px){.layout{grid-template-columns:1fr}main{padding:10px}header{height:auto;align-items:flex-start;gap:8px;flex-direction:column;padding:10px}.header-side{justify-content:flex-start}.designer-actionbar{align-items:flex-start}.designer-actionbar-actions{justify-content:flex-start}.designer-actionbar-context{flex-basis:100%}}
  </style>
</head>
<body${mode === 'runtime' ? ' class="runtime-page"' : ''}>
${headerHtml}
  <main id="app"><div class="notice">Loading...</div></main>
  <script>window.CMDP_BOOT=${boot};</script>
  <script>${dynamicPagesClientScript()}</script>
</body>
</html>`;
}

function dynamicPagesClientScript() {
  return `
(function () {
  'use strict';
  var boot = window.CMDP_BOOT || {};
  var apiPrefix = boot.apiPrefix || '/cmdbuild/custom-api';
  var app = document.getElementById('app');
  var DEFAULT_EMPTY_RESULT_TEXT = ${JSON.stringify(DEFAULT_EMPTY_RESULT_TEXT)};
  var DEFAULT_PERMISSION_DENIED_TEXT = ${JSON.stringify(DEFAULT_PERMISSION_DENIED_TEXT)};
  var DEFAULT_TEMPLATE_CACHE_TTL_SEC = ${JSON.stringify(DEFAULT_TEMPLATE_CACHE_TTL_SEC)};
  function clientLog(stage, message) {
    try {
      var img = new Image();
      img.src = apiPrefix + '/client-log?stage=' + encodeURIComponent(stage || '') + '&href=' + encodeURIComponent(window.location.href || '') + '&message=' + encodeURIComponent(message || '');
    } catch (error) {
    }
  }
  window.addEventListener('error', function (event) {
    clientLog('window-error', event && (event.message || event.error && event.error.message) || 'unknown error');
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    clientLog('unhandled-rejection', reason && reason.message ? reason.message : String(reason || 'unknown rejection'));
  });
  clientLog('script-loaded', '');
  var I18N = {
    en: {
      appTitle: 'CMDB Dynamic Pages',
      language: 'Language',
      cmdbuild: 'CMDBuild',
      designer: 'Designer',
      refresh: 'Refresh',
      newTemplate: 'New',
      save: 'Save',
      validate: 'Validate',
      preview: 'Preview',
      session: 'Session',
      user: 'User',
      role: 'Role',
      schema: 'Schema',
      ready: 'Ready',
      notReady: 'Not ready',
      schemaMissing: 'Schema is not created',
      schemaInaccessible: 'No access to schema metadata',
      schemaError: 'Schema check error',
      schemaConflict: 'Schema conflict',
      schemaReadyHelp: 'Technical classes are present and metadata is readable.',
      schemaMissingHelp: 'Technical classes or attributes are missing. Use Bootstrap from a role with CMDBuild admin_classes_modify privilege.',
      schemaInaccessibleHelp: 'Current CMDBuild role cannot inspect technical class metadata. The schema may already exist, but bootstrap/check requires admin metadata access.',
      schemaErrorHelp: 'CMDBuild returned an unexpected error while checking technical schema.',
      schemaConflictHelp: 'Existing CMDBuild classes or attributes differ from the requested schema. The tool will not change them destructively.',
      bootstrapRequiresAdmin: 'Bootstrap requires CMDBuild admin_classes_modify privilege. Log in with an administrator role or ask an administrator to create the schema.',
      schemaRootName: 'Technical root class',
      schemaRootDescription: 'Root description',
      schemaParent: 'Parent superclass',
      schemaParentHelp: 'Technical project classes will be created under this superclass. Existing classes are never moved automatically.',
      schemaRootHelp: 'Use a customer-specific prefix, for example Cst_QueryTool. The root defines names for all technical classes.',
      schemaPreview: 'Check schema',
      schemaCreateMissing: 'Create missing schema',
      schemaConfirmBootstrap: 'I understand: create only missing classes/attributes, never delete or move existing CMDBuild objects',
      schemaConfirmRequired: 'Confirm non-destructive schema creation before bootstrap.',
      schemaPreviewReady: 'Schema check completed.',
      schemaBootstrapDone: 'Schema bootstrap completed.',
      schemaPlan: 'Schema plan',
      schemaObjects: 'Technical objects',
      schemaConflicts: 'Conflicts',
      schemaNoConflicts: 'No conflicts.',
      schemaActionCreate: 'will be created',
      schemaActionCreated: 'created',
      schemaActionNone: 'exists',
      schemaNoParents: 'Parent list is unavailable; type a CMDBuild class name manually.',
      menuTemplates: 'Templates',
      menuDesigner: 'Designer',
      menuRun: 'Run',
      menuSettings: 'Schema and settings',
      menuHelp: 'Help',
      menuAbout: 'About',
      menuTemplateList: 'List',
      menuVersions: 'Versions',
      menuParams: 'Input variables',
      menuExtraction: 'Extraction',
      menuSelection: 'Selection',
      menuTemplateRun: 'Run',
      menuBaaEndpoint: 'BAA endpoint',
      menuObjectGroup: 'Object group',
      menuRelations: 'Object matching',
      menuFinalView: 'Final data',
      menuPublication: 'Publication',
      menuSchema: 'Schema',
      menuGeneralSettings: 'General settings',
      menuRuntimeSettings: 'Runtime settings',
      menuDiagnostics: 'Diagnostics',
      aboutText: 'Designed and implemented by Igor Lyapin email:igor.lyapin@gmail.com 2026\\n\\nLicensed under GNU GPLv3.',
      generalSettings: 'General settings',
      maxDepthHelp: 'Controls how many relation hops the Designer uses for catalog path hints. It does not change CMDBuild permissions.',
      runtimeSettings: 'Runtime settings',
      templates: 'Templates',
      technicalSchema: 'Technical schema',
      root: 'Root',
      bootstrap: 'Bootstrap',
      saveConfig: 'Save config',
      configCard: 'Config card',
      defaultConfig: 'Default config',
      runtimeCacheSettings: 'Runtime cache',
      baaTechnicalSettings: 'BAA technical contracts',
      baaTechnicalSuperclassPath: 'BAA technical superclass path from root',
      baaTechnicalSuperclassPathHelp: 'Path/name of the superclass branch where BAA contract classes are stored. It is used only to find external contracts, not as a business-data permission boundary.',
      baaConversionContractClass: 'Conversion contract class',
      baaConversionContractVersionClass: 'Conversion contract version class',
      baaVerificationInputContractClass: 'Verification input contract class',
      baaVerificationOutputContractClass: 'Verification output contract class',
      baaVerificationEndpointClass: 'Verification endpoint class',
      runtimeRefreshCooldownSec: 'Refresh cooldown, seconds',
      runtimeRefreshCooldownHelp: 'Minimum delay before a runtime result can be rebuilt manually.',
      runtimeExecutionLimits: 'Execution limits',
      runtimeMaxRowsDefault: 'Default runtime rows',
      runtimeMaxRowsDefaultHelp: 'Default row limit for normal template runs.',
      runtimeMaxRowsPreviewDefault: 'Default preview rows',
      runtimeMaxRowsPreviewDefaultHelp: 'Default row limit for draft preview and test runs.',
      runtimeMaxRowsMax: 'Maximum rows',
      runtimeMaxRowsMaxHelp: 'Upper cap for rows returned by one execution.',
      runtimeMaxClassesDefault: 'Default classes',
      runtimeMaxClassesDefaultHelp: 'Default number of CMDBuild classes read by model-scanning operations.',
      runtimeMaxClassesMax: 'Maximum classes',
      runtimeMaxClassesMaxHelp: 'Upper cap for classes read by one execution.',
      runtimeMaxDomainsDefault: 'Default domains',
      runtimeMaxDomainsDefaultHelp: 'Default number of CMDBuild domains read by relation/domain operations.',
      runtimeMaxDomainsMax: 'Maximum domains',
      runtimeMaxDomainsMaxHelp: 'Upper cap for domains read by one execution.',
      runtimeMaxRestCallsDefault: 'Default REST calls',
      runtimeMaxRestCallsDefaultHelp: 'Default budget for CMDBuild REST calls during one template execution.',
      runtimeMaxRestCallsMax: 'Maximum REST calls',
      runtimeMaxRestCallsMaxHelp: 'Upper cap for CMDBuild REST calls during one template execution.',
      runtimeMaxTraversalDepthDefault: 'Default traversal depth',
      runtimeMaxTraversalDepthDefaultHelp: 'Default depth for relation/path traversal when a template does not override it.',
      runtimeMaxTraversalDepthMax: 'Maximum traversal depth',
      runtimeMaxTraversalDepthMaxHelp: 'Upper cap for relation/path traversal depth.',
      code: 'Code',
      description: 'Description',
      active: 'Active',
      editingTemplate: 'Modifying',
      creatingTemplate: 'Creating a new template',
      templateCreateHelp: 'Set the template code and description, then save it. Query logic is configured in the constructor sections.',
      templateKind: 'Template type',
      templateKindDsl: 'Dynamic data template',
      templateKindCmdbBuildView: 'CMDBuild model view',
      templateKindHelp: 'CMDBuild model view uses a built-in renderer and does not use the ordinary selection/matching DSL.',
      menuCmdbBuildView: 'CMDBuild model view',
      cmdbBuildViewEditor: 'CMDBuild model view',
      cmdbBuildViewHelp: 'Special template that renders CMDBuild classes, attributes, domains, and lookups with the current user rights or as a published snapshot.',
      cmdbBuildViewLanguage: 'Language',
      cmdbBuildViewLanguageAuto: 'Auto',
      cmdbBuildViewRootClass: 'Root class filter',
      cmdbBuildViewRootClassHelp: 'Optional CMDBuild superclass/class name. If set, the view shows this class and its descendants.',
      cmdbBuildViewSections: 'Sections',
      cmdbBuildViewClasses: 'Classes',
      cmdbBuildViewDomains: 'Domains',
      cmdbBuildViewLookups: 'Lookups',
      cmdbBuildViewSystemAttributes: 'Show system attributes',
      cmdbBuildViewLookupScope: 'Lookup scope',
      cmdbBuildViewLookupUsed: 'Used lookups only',
      cmdbBuildViewLookupAll: 'All lookup types',
      cmdbBuildViewApplied: 'CMDBuild model view settings applied to Spec JSON.',
      protectedTemplate: 'Protected',
      protectedTemplateHelp: 'System template: deletion is blocked by the backend.',
      copyFromTemplate: 'Copy from template',
      doNotCopy: 'Do not copy',
      noTemplateToCopy: 'No saved templates to copy.',
      copyFromTemplateHelp: 'Copies the constructor, input variables, final data and visualization settings. Code and description stay as entered for the new template.',
      templateCopyApplied: 'Template {code} copied into the new template draft.',
      yes: 'yes',
      no: 'no',
      noData: 'No data.',
      run: 'Run',
      visualizeInEditor: 'Visualize in editor',
      visualizeExternal: 'Visualize in separate page',
      forceRefreshInEditor: 'Refresh cache and show',
      baaVerifyPreview: 'BAA verify',
      baaEndpointEditor: 'BAA endpoint',
      baaEndpointHelp: 'Describe the BAA input contract before building rules. plan.objects are incoming CMDB-like candidates, not CMDBuild cards.',
      baaVerifyEndpointUrl: 'BAA verification URL',
      baaVerifyEndpointUrlHelp: 'Use this absolute POST URL in cmdbaa. Runtime/designer URLs return HTML and must not be used as BAA verification endpoints. Browser calls use CMDBuild session cookie plus CSRF; server-to-server cmdbaa calls may send CMDBuild-Authorization header.',
      baaContractCode: 'Contract code',
      baaContractVersion: 'Contract version',
      baaContractDescription: 'Contract description',
      baaContractSource: 'Saved input contract',
      baaContractSourceManual: 'Manual contract in template',
      baaContractObjects: 'Incoming BAA objects',
      baaContractObjectsHelp: 'These are not CMDBuild classes. They describe objects expected in POST plan.objects. Saved BAA input contracts are mapped from classes[] to this list.',
      baaContractUsage: 'How to use this contract',
      baaContractUsageHelp: 'In matching rules choose BAA candidates as a selection. Payload fields are available as Payload.<field> and BAA.<className>.<field>. After matching, use the final result in Final data and Visualization.',
      baaContractNoObjects: 'The selected contract has no readable classes/attributes.',
      baaContractVariables: 'BAA variables',
      baaContractParams: 'Contract parameters',
      baaContractParamsHelp: 'Contract parameters are defined by the input contract as contractparam.*. BAA sends their runtime values in endpoint.params.',
      baaRequestVariables: 'Request variables',
      baaRequestVariablesHelp: 'BAA computes these top-level variables before POST. They arrive in request.variables, can be scalar or array values, and are available as $' + '{var.name} and $' + '{param.name}.',
      baaObjectAlias: 'Alias',
      baaObjectClassName: 'Incoming class',
      baaPayloadFields: 'Payload fields',
      baaPayloadFieldsHelp: 'Fields expected in object Payload. Supported types include string, number, boolean, ipv4, ipv4-cidr.',
      baaVariablesHelp: 'Variables from POST body are available as $' + '{var.name} and $' + '{param.name}.',
      addBaaVariable: 'Add variable',
      addBaaPayloadField: 'Add payload field',
      addBaaObject: 'Add candidate type',
      applyBaaEndpoint: 'Apply without saving',
      baaEndpointApplied: 'BAA endpoint contract applied.',
      baaContractValidationFailed: 'BAA contract validation failed.',
      baaRequestEditor: 'BAA verification request',
      baaRequestHelp: 'POST body for BAA verification exchange. endpoint.params are passed as template parameters; plan.objects are available through the baaPlanObjects DSL step.',
      baaVerifyCompleted: 'BAA verification endpoint completed.',
      baaVerifyRefreshPreview: 'Refresh BAA cache and verify',
      baaPostOnlyMode: 'POST-only',
      baaPostOnlyNotice: 'BAA templates are POST-only verification endpoints. They do not render HTML runtime pages or publish static view snapshots.',
      baaSectionDisabled: 'This section is disabled for BAA templates. Use BAA endpoint, extraction, caching, and BAA verify preview.',
      baaRunPostOnlyHelp: 'Use the BAA verification URL and a POST body. Runtime page links and iframe URLs are not available for this template type.',
      runLaunchUrl: 'Template launch URL',
      runLaunchJsonUrl: 'JSON URL',
      runLaunchParams: 'Parameter variants',
      runLaunchParamsHelp: 'Query string used by the run links. The JSON variant adds the system parameter json=true; this parameter is not passed to the template as input.',
      runLaunchNoParams: 'without input parameters',
      runLaunchUrlHelp: 'Direct runtime URL for a link or iframe. Generated from declared input variables; missing defaults are replaced with test values. Add json=true to receive the same result as application/json.',
      visualizationRunCompleted: 'Visualization completed.',
      forceRefreshRunCompleted: 'Cache refreshed and result rendered.',
      publicationEditor: 'Publication',
      publicationHelp: 'Static snapshots are served from Redis without checking the viewer permissions for source CMDBuild objects.',
      publicationMode: 'Runtime mode',
      publicationDynamic: 'Dynamic under viewer permissions',
      publicationStatic: 'Static snapshot from publisher',
      publicationParamsMode: 'Snapshot parameters',
      publicationParamsExact: 'Exact parameter set',
      publicationParamsIgnore: 'Ignore runtime parameters',
      publicationParamsModeHelp: 'Exact parameter set publishes the snapshot only for the current run parameters, for example city=city49. Ignore runtime parameters publishes one page for the template code; URL parameters are ignored and every viewer sees the same published result.',
      publicationWarning: 'Warning: users will see the published result without read permissions on the source CMDBuild objects.',
      publicationWarningAccepted: 'I understand and accept this publication mode',
      applyPublication: 'Apply publication settings',
      publishSnapshot: 'Publish/update snapshot',
      publicationApplied: 'Publication settings applied to Spec JSON.',
      snapshotPublished: 'Snapshot published.',
      cacheEditor: 'Caching',
      cacheHelp: 'Controls result sharing and retention for this template endpoint. User refresh wait is a system Runtime setting.',
      cacheEnabled: 'Enable runtime cache',
      cacheScopeMode: 'Access mode',
      cachePermissionOnly: 'Permission only, endpoint shared',
      cacheVisibilityHash: 'Visibility hash, endpoint shared',
      cachePrivateUser: 'Private per user',
      cacheDisabled: 'Disabled',
      cacheTtlHours: 'Template cache TTL, hours',
      cacheAllowManualRefresh: 'Allow manual refresh',
      cacheApply: 'Apply cache settings',
      cacheApplied: 'Cache settings applied to Spec JSON.',
      cachePermissionOnlyHelp: 'Fast default: a user can reuse the endpoint cache after a lightweight probe of the classes and attributes used by the template.',
      cacheVisibilityHashHelp: 'Stricter: also hashes visible card ids before sharing a result.',
      cachePrivateUserHelp: 'Safest: result cache is isolated by CMDBuild user/session scope.',
      deleteTemplate: 'Delete',
      deleteTemplateConfirm: 'Delete template {code}?',
      templateDeleted: 'Template deleted.',
      noTemplates: 'No templates.',
      runParamsJson: 'Run params JSON',
      runInputValues: 'Input values',
      runInputValuesHelp: 'Test input is built from the variables declared in Input variables.',
      runParamValue: 'Value',
      noInputVariables: 'No input variables are declared yet.',
      specJson: 'Spec JSON',
      paramsSchemaJson: 'Params schema JSON',
      resultSchemaJson: 'Result schema JSON',
      paramsEditor: 'Input variables',
      paramsEditorHelp: 'Declare the variables expected at template input. The table updates spec.params and fills the test input list from examples.',
      paramName: 'Name',
      paramType: 'Type',
      paramRequired: 'Required',
      paramDefault: 'Default',
      paramExample: 'Example',
      paramDescription: 'Description',
      addParam: 'Add parameter',
      applyParams: 'Apply parameters',
      fillExamples: 'Fill examples',
      clear: 'Clear',
      paramsApplied: 'Input parameters applied to Spec JSON.',
      examplesFilled: 'Run params were filled from examples.',
      invalidParamName: 'Parameter name must start with a Latin letter or underscore and contain only Latin letters, digits, and underscores.',
      reservedParamName: 'Parameter {name} is reserved for runtime output mode.',
      optionalParamNeedsDefault: 'Optional parameter {name} must have a default value.',
      invalidParamValue: 'Invalid value for {name}.',
      extractionEditor: 'Extraction',
      extractionEditorHelp: 'Use a regular expression to extract internal variables from an input parameter. Named groups become columns in the result.',
      extractByTemplate: 'Extract by template',
      extractionSourceParam: 'Source parameter',
      extractionRegex: 'Regular expression',
      extractionFlags: 'Flags',
      extractionAlias: 'Result alias',
      extractionAllMatches: 'All matches',
      extractionResultSource: 'Show result',
      extractionFinalResult: 'Final result',
      applyExtraction: 'Apply extraction',
      previewExtraction: 'Preview extraction',
      extractionApplied: 'Extraction step applied to Spec JSON.',
      extractionPreviewReady: 'Extraction preview is ready.',
      extractionCompleted: 'Template extraction completed.',
      extractionNeedsSource: 'Extraction source parameter is required.',
      extractionNeedsRegex: 'Extraction regular expression is required.',
      extractionNeedsAlias: 'Extraction result alias is required.',
      extractionInvalidRegex: 'Extraction regular expression is invalid.',
      extractionNoRows: 'No objects found.',
      match: 'Match',
      dataSelectionEditor: 'Data selection',
      dataSelectionEditorHelp: 'Select CMDBuild cards from a class. Class and filter values can come from fixed values, input parameters, or rows produced by extraction.',
      dataSelectionAlias: 'Result alias',
      dataSelectionSource: 'Source rows',
      dataSelectionNoSource: 'No source rows',
      dataSelectionClassName: 'Fixed class',
      dataSelectionClassParam: 'Class parameter',
      dataSelectionClassColumn: 'Class column',
      dataSelectionLimit: 'Limit',
      dataSelectionFilters: 'Filters',
      filterAttribute: 'Attribute',
      filterOperator: 'Operator',
      filterValue: 'Fixed value',
      filterParam: 'Parameter',
      filterColumn: 'Source column',
      filter: 'Filter',
      addFilter: 'Add filter',
      applySelection: 'Apply selection',
      selectionApplied: 'Data selection step applied to Spec JSON.',
      selectionNeedsClass: 'Data selection requires fixed class, class parameter, or class column.',
      selectionNeedsAlias: 'Data selection result alias is required.',
      selectionInvalidLimit: 'Data selection limit must be a positive integer.',
      visualizationEditor: 'Visualization',
      visualizationEditorHelp: 'Configure visual presentation for the data tables prepared in Final data: empty text, table titles, grouping, sorting, filters, and base style.',
      visualizationGlobal: 'Global presentation',
      visualizationTables: 'Table presentation',
      visualizationMessages: 'Messages',
      visualizationBaseStyle: 'Base style',
      visualizationRuntimeBehavior: 'Runtime behavior',
      visualizationTableHeader: 'Table header',
      visualizationSorting: 'Sorting',
      visualizationSubtables: 'Subtables',
      visualizationRowGrouping: 'Row grouping',
      visualizationSource: 'Table',
      visualizationTitle: 'Table title',
      visualizationTitleHelp: 'You can use runtime parameters inside the title as $' + '{param.city}, for example Routers in $' + '{param.city}.',
      visualizationTitleAlign: 'Title alignment',
      visualizationAlignLeft: 'Left',
      visualizationAlignCenter: 'Center',
      visualizationAlignRight: 'Right',
      visualizationMode: 'Mode',
      visualizationEmptyText: 'Text if no objects are found',
      visualizationPermissionDeniedText: 'Text if permissions are missing',
      visualizationFontSize: 'Font size',
      visualizationFontSmall: 'Small',
      visualizationFontNormal: 'Normal',
      visualizationFontLarge: 'Large',
      visualizationDensity: 'Density',
      visualizationDensityCompact: 'Compact',
      visualizationDensityNormal: 'Normal',
      visualizationZebra: 'Zebra rows',
      visualizationRuntimeFilters: 'Runtime filters',
      visualizationRuntimeFiltersHelp: 'Shows a browser-side search field above the runtime table. It searches only rows already returned to the page.',
      visualizationSortable: 'Sortable columns',
      visualizationSplitSubtables: 'Split into subtables',
      visualizationGroupBy: 'Split by column',
      visualizationGroupTitle: 'Subtable title',
      visualizationGroupTitleHelp: 'Defaults to the selected split column token, for example $' + '{Selection2.city}; add static text around it if needed.',
      visualizationRowGroupBy: 'Group by',
      visualizationRowGroupNextBy: 'Then by',
      visualizationAddRowGroup: '+',
      visualizationRowGroupHelp: 'Repeated adjacent values in selected columns are rendered as one merged cell.',
      visualizationLinkColumns: 'Column links',
      visualizationLinkColumnsHelp: 'Turn a final data cell into a safe runtime link. URL and text templates can use current cell, row, and input parameter tokens.',
      visualizationLinkModeText: 'Text',
      visualizationLinkModeLink: 'Link',
      visualizationLinkTargetSelf: 'Current tab',
      visualizationLinkTargetBlank: 'New tab',
      visualizationLinkColumn: 'Column',
      visualizationLinkMode: 'Mode',
      visualizationLinkUrlTemplate: 'URL template',
      visualizationLinkTextTemplate: 'Text template',
      visualizationLinkTarget: 'Target',
      visualizationLinkExamples: 'Link examples',
      visualizationLinkExamplesHelp: 'Supported tokens: $' + '{mysource.value}, $' + '{mysource.source}, $' + '{mysource.sourceClass}, $' + '{mysource.sourceId}, $' + '{mysource.attribute}, $' + '{mysource.domainPath}, $' + '{mysource.sourceURLSelection1}, $' + '{mysource.sourceURLВыборка1}, $' + '{row.ColumnName}, $' + '{param.name}. javascript:, data:, and vbscript: links are blocked.',
      visualizationNoColumns: 'No final data columns.',
      visualizationSortColumn: 'Initial sort',
      visualizationSortDirection: 'Direction',
      visualizationSortAsc: 'Ascending',
      visualizationSortDesc: 'Descending',
      applyVisualization: 'Apply visualization',
      visualizationApplied: 'Visualization applied to Spec JSON.',
      visualizationNoTables: 'Configure Final data first: visualization works with prepared data tables.',
      visualizationTable: 'table',
      visualizationCompact: 'compact',
      visualizationKeyValue: 'key-value',
      viewComposerEditor: 'Final data',
      viewComposerHelp: 'Prepare the data table for visualization: choose the source, visible columns, and user-facing column titles. Columns include direct attributes and reference/domain paths up to the catalog depth.',
      viewComposerSource: 'Data source',
      viewComposerSourceHelp: 'The source is an internal builder result. It is used only to prepare final data and is hidden from the visualization screen.',
      viewComposerObjectsAlias: 'Object group result',
      viewComposerTitle: 'Table title',
      viewComposerMode: 'Display mode',
      viewComposerOnlyThis: 'Show only this table',
      viewComposerColumns: 'Visible columns',
      columnsCount: 'columns',
      viewComposerColumnField: 'Field',
      viewComposerColumnTitle: 'Column title',
      viewComposerMultiMode: 'Multiple values',
      viewComposerMultiJoin: 'One cell',
      viewComposerMultiRows: 'Rows per value',
      viewComposerSeparator: 'Separator',
      viewComposerEmptyRow: 'Row if empty',
      addViewColumn: 'Add column',
      applyViewComposer: 'Apply final data',
      viewComposerApplied: 'Final data applied to Spec JSON.',
      viewComposerNeedsSource: 'Final data requires a result source.',
      viewComposerNeedsColumn: 'Final data requires at least one visible column.',
      testWorkflow: 'Test run',
      testWorkflowHelp: 'Fill input values from declared variables, then validate and preview the current draft before saving it as a template.',
      emulateInput: 'Emulate input',
      validateDraft: 'Validate draft',
      previewDraft: 'Preview draft',
      saveAfterTest: 'Save after test',
      draftValidateCompleted: 'Draft validation completed.',
      draftPreviewCompleted: 'Draft preview completed.',
      saveNeedsPreview: 'Run a successful draft preview before saving from this button.',
      executionTrace: 'Execution trace',
      traceStep: 'Step',
      traceAlias: 'Alias',
      traceRows: 'Rows',
      traceMs: 'ms',
      traceRest: 'REST',
      traceStatus: 'Status',
      builder: 'Builder',
      preset: 'Preset',
      classesByAttribute: 'Classes by attribute',
      domainTraversal: 'Domain traversal',
      attributeComparison: 'Attribute comparison',
      setOperations: 'Set operations',
      attributeType: 'Attribute type',
      className: 'Class',
      classNameProbe: 'Class name check',
      classNameProbeHelp: 'Enter a class name directly. The editor no longer loads the full class catalog on the main screen.',
      classNameInput: 'Class name',
      classNameFallback: 'Fallback className',
      classNameFallbackHelp: 'Stored in Spec JSON as defaults.className and used when runtime parameters do not include className.',
      checkClass: 'Check class',
      applyClassFallback: 'Apply fallback',
      classFound: 'Class is available.',
      classNotFound: 'Class not found or not visible.',
      classAccessDenied: 'Current user cannot read this class metadata.',
      classFallbackApplied: 'Fallback className applied to Spec JSON.',
      checkedClass: 'Checked class',
      depth: 'Depth',
      referenceClass: 'Reference class',
      rightType: 'Right type',
      apply: 'Apply',
      versions: 'Versions',
      version: 'Version',
      changedAt: 'Changed at',
      changedBy: 'Changed by',
      comment: 'Comment',
      load: 'Load',
      noVersions: 'No versions.',
      catalog: 'Catalog',
      catalogReady: 'catalog ready',
      catalogStale: 'catalog stale',
      catalogMissing: 'catalog missing',
      catalogSyncing: 'syncing catalog',
      catalogSync: 'Sync catalog',
      catalogUpdatedAt: 'updated',
      catalogAge: 'age',
      catalogCounts: 'classes {classes}, attributes {attributes}, domains {domains}, lookups {lookups}',
      catalogError: 'Catalog sync error',
      maxDepth: 'Max depth',
      pathHints: 'Path hints',
      pathKind: 'Kind',
      pathValue: 'Path',
      pathTarget: 'Target',
      pathDetails: 'Details',
      noPathHints: 'Sync catalog and select a class to see path hints.',
      selectFromCatalog: 'Select from catalog',
      catalogClassApplied: 'Class selected from cached catalog.',
      objectGroupEditor: 'Object group',
      objectGroupHelp: 'Build the object scope from a starting CMDBuild class and include/exclude rules.',
      baaObjectGroupSource: 'BAA input source',
      baaObjectGroupSourceHelp: 'Objects from POST plan.objects are available in the starting class list as BAA payload sources. Choose one of them when the selection must start from incoming data.',
      objectSelectionTitle: 'Selection name',
      objectSelectionDefault: 'Selection{number}',
      addObjectSelection: 'Add selection',
      objectGroupSourceClass: 'Source class',
      objectGroupScopeRules: 'Object scope rules',
      objectGroupScopeAction: 'Action',
      objectGroupNegation: '!',
      objectGroupInclude: 'Include in scope',
      objectGroupExclude: 'Exclude from scope',
      objectGroupPath: 'Class attribute/path',
      objectGroupDomainFilter: 'Domain',
      objectGroupCardinalityFilter: 'Cardinality',
      objectGroupDirectionFilter: 'Direction',
      objectGroupDomainExamples: 'Domain path examples',
      objectGroupDomainExamplesHelp: 'Use these filters when the same attribute name can be reached through different references or domains and the template must keep only paths from a specific relationship type.',
      objectGroupDomainExample1: 'Domain = NetworkACL keeps paths that came through that CMDBuild domain.',
      objectGroupDomainExample2: 'Cardinality = N:N leaves only paths that can return several related cards.',
      objectGroupDomainExample3: 'Direction = inverse helps distinguish attributes reached from the opposite side of the domain.',
      objectGroupOperator: 'Operator',
      objectGroupValue: 'Value / regular expression',
      objectGroupValueHelp: 'Parameter is not used for exists, is IP, and is IP net. For matches it is a regular expression; for IPv4 comparisons it is CIDR/range/network on the right side.',
      objectGroupRegex: 'Value / regular expression',
      objectGroupRegexExamples: 'Regular expression examples',
      objectGroupRegexExample: 'Example',
      objectGroupRegexMeaning: 'Use case',
      addObjectGroupRule: 'Add rule',
      applyObjectGroup: 'Apply object group',
      objectGroupApplied: 'Object group spec applied.',
      objectGroupNeedsClass: 'Object group requires a source class.',
      objectGroupNeedsPath: 'Object scope rule requires an attribute/path.',
      objectGroupNeedsRegex: 'Object scope rule requires a value or regular expression.',
      objectGroupInvalidRegex: 'Object scope rule regular expression is invalid.',
      objectGroupOperatorMatches: 'matches regex',
      objectGroupOperatorEquals: 'equals',
      objectGroupOperatorContains: 'contains',
      objectGroupOperatorStartsWith: 'starts with',
      objectGroupOperatorEndsWith: 'ends with',
      objectGroupOperatorExists: 'exists',
      objectGroupOperatorIsIpv4: 'is IP',
      objectGroupOperatorIsIpv4Network: 'is IP net',
      relationEditor: 'Object matching',
      relationHelp: 'Match object selections to each other. The first block compares two selections; each next block compares the previous result with another selection.',
      relationSourceClass: 'Source class',
      relationParam: 'Input parameter',
      relationParamExample: 'Example',
      relationMatchAttribute: 'Match attribute',
      relationMatchOperator: 'Operator',
      relationSourceAlias: 'Source alias',
      relationResultAlias: 'Result alias',
      relationDomain: 'Domain',
      relationAnyDomain: 'Any domain',
      relationTargetClass: 'Target class',
      relationDirection: 'Direction',
      relationSourceLimit: 'Source limit',
      relationLimit: 'Relation limit',
      relationTableTitle: 'Table title',
      relationColumns: 'Related-card columns',
      relationColumnField: 'Field',
      relationColumnTitle: 'Title',
      addRelationColumn: 'Add column',
      applyRelation: 'Apply object matching',
      relationApplied: 'Object matching spec applied.',
      relationNeedsSourceClass: 'Object matching requires a source class.',
      relationNeedsParam: 'Object matching requires an input parameter.',
      relationNeedsMatchAttribute: 'Object matching requires a match attribute.',
      relationNeedsAlias: 'Object matching requires a result alias.',
      relationNeedsColumn: 'Object matching requires at least one related-card column.',
      matchingNeedsSelections: 'Add at least two object selections first.',
      matchingBlock: 'Matching block {number}',
      matchingFirstPair: 'First pair of selections',
      matchingPreviousResult: 'Previous result',
      matchingLeftSelection: 'Left selection',
      matchingRightSelection: 'Right selection',
      matchingRules: 'Rules',
      matchingRuleAction: 'Action',
      matchingLeftAttribute: 'Left attribute',
      matchingLeftRegex: 'Left extraction regex',
      matchingOperator: 'Operator',
      matchingNegation: 'Negation',
      matchingNoNegation: '() not negated',
      matchingNegated: '! negated',
      matchingLeftObject: 'Left object',
      matchingRightObject: 'Right object',
      matchingOperatorEquals: 'equals',
      matchingOperatorNotEquals: 'not equals',
      matchingOperatorContains: 'contains',
      matchingOperatorRegexMatch: 'matches regex',
      matchingOperatorIpv4InCidr: 'IPv4 is in CIDR',
      matchingOperatorIpv4InRange: 'IPv4 is in range',
      matchingOperatorIpv4CidrOverlaps: 'IPv4 CIDR overlaps',
      matchingOperatorIpv4CidrContains: 'IPv4 CIDR contains',
      matchingRightAttribute: 'Right attribute',
      matchingRightRegex: 'Right extraction regex',
      matchingRegexHelp: 'Empty regex compares the full value. If a regex has a named group "value", it is used; otherwise group 1 is used; without groups the full match is used.',
      matchingIpv4Help: 'IPv4 checks only. Supported network values: 10.10.2.0/24, 10.10.2.1-10.10.2.254, or 10.10.2.0 255.255.255.0.',
      matchingIpv4ExamplesTitle: 'IPv4 operator examples',
      matchingExampleFunction: 'Function',
      matchingExampleInput: 'Example',
      matchingExampleResult: 'Result',
      addMatchingRule: 'Add rule',
      matchingNeedsRule: 'Object matching requires at least one rule in every block.',
      matchingNeedsColumn: 'Object matching rule requires both attributes.',
      matchingInvalidRegex: 'Object matching extraction regex is invalid.',
      model: 'Model',
      classes: 'Classes',
      class: 'Class',
      crud: 'CRUD',
      noVisibleClasses: 'No visible classes.',
      attributes: 'Attributes',
      attribute: 'Attribute',
      type: 'Type',
      domains: 'Domains',
      domain: 'Domain',
      source: 'Source',
      destination: 'Destination',
      cardinality: 'Cardinality',
      selectClass: 'Select a class.',
      noVisibleDomains: 'No visible domains.',
      permissionRead: 'read',
      permissionCreate: 'create',
      permissionUpdate: 'update',
      result: 'Result',
      noRows: 'No rows.',
      permissionDeniedDefault: DEFAULT_PERMISSION_DENIED_TEXT,
      noResult: 'No validation or preview result yet.',
      diagnosticsHelp: 'Quick links for checking browser-side and proxy-side diagnostics.',
      clientLog: 'Client log',
      proxyLog: 'Proxy log',
      customPageLauncher: 'Custom page launcher',
      truncated: 'truncated',
      loadingDesigner: 'Loading designer...',
      runningTemplate: 'Running template...',
      runtimeCacheBuilt: 'Built now',
      runtimeCacheHit: 'Cached result',
      runtimeCacheJoined: 'Waiting for the current build',
      runtimeSnapshotHit: 'Published snapshot',
      runtimeSnapshotMiss: 'Published page is missing',
      runtimeSnapshotPublished: 'Snapshot published',
      runtimeCacheRefreshWait: 'Refresh is available in {time}',
      runtimeCacheRefreshReady: 'Refresh is available',
      runtimeCacheGeneratedAt: 'Generated',
      runtimeCacheExpiresIn: 'Cache expires in {time}',
      runtimeCacheBackend: 'Backend',
      runtimeCacheScope: 'Scope',
      runtimeCacheKey: 'Cache key',
      runtimeCacheManualDisabled: 'Manual refresh is disabled',
      runtimeTableControlsDisabledByGrouping: 'Sorting and filters are disabled because row grouping is enabled.',
      runtimeFilterPlaceholder: 'Search in visible rows',
      runtimeRefresh: 'Refresh',
      runtimeRefreshing: 'Refreshing...',
      requestFailed: 'Request failed.',
      httpStatus: 'HTTP {status}',
      invalidJson: '{id} must contain valid JSON.',
      fieldRequired: '{label} is required.',
      templateCodeRequired: 'Template code is required.',
      saved: 'Saved.',
      validateCompleted: 'Validation completed.',
      previewCompleted: 'Preview completed.',
      schemaReadyMessage: 'Schema is ready.',
      configSaved: 'Config saved.',
      versionLoaded: 'Version loaded into editor.',
      builderApplied: 'Builder applied.',
      builderClassesDescription: 'Classes by attribute type template',
      builderDomainDescription: 'Domain traversal template',
      builderComparisonDescription: 'Attribute comparison template',
      builderSetDescription: 'Class set operations template',
      runtimeParams: 'Runtime parameters',
      guideTitle: 'How templates become views',
      guideTemplateTitle: 'Template',
      guideTemplateText: 'A template is a CMDBuild card with Code, Description and Spec JSON. It is stored in the technical class Cst_QueryTemplate.',
      guideSpecTitle: 'Spec JSON',
      guideSpecText: 'The spec declares params, ordered steps and result.tables. Steps read CMDBuild model/data through REST as the current user.',
      guideViewTitle: 'Runtime view',
      guideViewText: 'A view is just a URL that runs a saved template with query parameters and renders every result table.',
      guideStepsTitle: 'Typical workflow',
      guideStep1: 'Pick a preset in Builder or edit Spec JSON manually.',
      guideStep2: 'Fill Run params JSON with sample values and click Preview.',
      guideStep3: 'Save the template after validation.',
      guideStep4: 'Open the runtime URL and pass real parameters in the query string.',
      guideUrlTitle: 'Runtime URL format',
      guideUrlText: 'Each table listed in result.tables is rendered as a separate table in the runtime page.',
      directRuntimeUrl: '/cmdbuild/dynamicpages/ui/run/<TemplateCode>?param=value',
      permissionNote: 'All reads use the current CMDBuild user permissions; the technical root only stores project classes.'
    },
    ru: {
      appTitle: 'CMDB Dynamic Pages',
      language: 'Язык',
      cmdbuild: 'CMDBuild',
      designer: 'Дизайнер',
      refresh: 'Обновить',
      newTemplate: 'Новый',
      save: 'Сохранить',
      validate: 'Проверить',
      preview: 'Предпросмотр',
      session: 'Сессия',
      user: 'Пользователь',
      role: 'Роль',
      schema: 'Схема',
      ready: 'Готова',
      notReady: 'Не готова',
      schemaMissing: 'Схема не создана',
      schemaInaccessible: 'Нет доступа к метаданным схемы',
      schemaError: 'Ошибка проверки схемы',
      schemaConflict: 'Конфликт схемы',
      schemaReadyHelp: 'Технические классы есть, метаданные доступны.',
      schemaMissingHelp: 'Не хватает технических классов или атрибутов. Нажмите Создать схему из роли с правом CMDBuild admin_classes_modify.',
      schemaInaccessibleHelp: 'Текущая роль CMDBuild не может читать метаданные технических классов. Схема может уже существовать, но проверка/bootstrap требуют доступа к метаданным администратора.',
      schemaErrorHelp: 'CMDBuild вернул неожиданную ошибку при проверке технической схемы.',
      schemaConflictHelp: 'Существующие классы или атрибуты CMDBuild отличаются от требуемой схемы. Инструмент не будет менять их разрушительно.',
      bootstrapRequiresAdmin: 'Создание схемы требует права CMDBuild admin_classes_modify. Войдите под администраторской ролью или попросите администратора создать схему.',
      schemaRootName: 'Технический root-класс',
      schemaRootDescription: 'Описание root',
      schemaParent: 'Родительский суперкласс',
      schemaParentHelp: 'Под этим суперклассом будут созданы технические классы проекта. Существующие классы автоматически не переносятся.',
      schemaRootHelp: 'Используйте customer-specific префикс, например Cst_QueryTool. Root определяет имена всех технических классов.',
      schemaPreview: 'Проверить схему',
      schemaCreateMissing: 'Создать недостающее',
      schemaConfirmBootstrap: 'Я понимаю: создавать только недостающие классы/атрибуты, не удалять и не переносить существующие объекты CMDBuild',
      schemaConfirmRequired: 'Подтвердите non-destructive создание схемы перед bootstrap.',
      schemaPreviewReady: 'Проверка схемы выполнена.',
      schemaBootstrapDone: 'Bootstrap схемы выполнен.',
      schemaPlan: 'План схемы',
      schemaObjects: 'Технические объекты',
      schemaConflicts: 'Конфликты',
      schemaNoConflicts: 'Конфликтов нет.',
      schemaActionCreate: 'будет создано',
      schemaActionCreated: 'создано',
      schemaActionNone: 'существует',
      schemaNoParents: 'Список родителей недоступен; введите имя класса CMDBuild вручную.',
      menuTemplates: 'Шаблоны',
      menuDesigner: 'Конструктор',
      menuRun: 'Запуск',
      menuSettings: 'Управление схемой и настройками',
      menuHelp: 'Помощь',
      menuAbout: 'О программе',
      menuTemplateList: 'Список',
      menuVersions: 'Версии',
      menuParams: 'Входные переменные',
      menuExtraction: 'Извлечение',
      menuSelection: 'Выборка',
      menuTemplateRun: 'Прогон',
      menuBaaEndpoint: 'BAA endpoint',
      menuObjectGroup: 'Группа объектов',
      menuRelations: 'Сопоставление с объектами',
      menuFinalView: 'Итоговые данные',
      menuPublication: 'Публикация',
      menuSchema: 'Схема',
      menuGeneralSettings: 'Общие настройки',
      menuRuntimeSettings: 'Runtime-настройки',
      menuDiagnostics: 'Диагностика',
      aboutText: 'Спроектировано и овеществлено Игорем Ляпиным email:igor.lyapin@gmail.com 2026\\n\\nПод лицензией GNU GPLv3.',
      generalSettings: 'Общие настройки',
      maxDepthHelp: 'Определяет, сколько шагов связей Designer использует для подсказок путей по каталогу. Права CMDBuild эта настройка не меняет.',
      runtimeSettings: 'Runtime-настройки',
      templates: 'Шаблоны',
      technicalSchema: 'Техническая схема',
      root: 'Root',
      bootstrap: 'Создать схему',
      saveConfig: 'Сохранить настройки',
      configCard: 'Карточка настроек',
      defaultConfig: 'Настройки по умолчанию',
      runtimeCacheSettings: 'Runtime-кэш',
      baaTechnicalSettings: 'BAA technical contracts',
      baaTechnicalSuperclassPath: 'Путь к BAA technical superclass от root',
      baaTechnicalSuperclassPathHelp: 'Путь/имя ветки суперкласса, где лежат классы BAA-контрактов. Используется только для поиска внешних контрактов, не ограничивает права на business data.',
      baaConversionContractClass: 'Класс conversion contract',
      baaConversionContractVersionClass: 'Класс версий conversion contract',
      baaVerificationInputContractClass: 'Класс verification input contract',
      baaVerificationOutputContractClass: 'Класс verification output contract',
      baaVerificationEndpointClass: 'Класс verification endpoint',
      runtimeRefreshCooldownSec: 'Пауза refresh, секунд',
      runtimeRefreshCooldownHelp: 'Минимальная пауза перед ручной перестройкой результата runtime-страницы.',
      runtimeExecutionLimits: 'Лимиты выполнения',
      runtimeMaxRowsDefault: 'Строк по умолчанию',
      runtimeMaxRowsDefaultHelp: 'Лимит строк для обычного запуска шаблона, если URL не передал maxRows.',
      runtimeMaxRowsPreviewDefault: 'Строк предпросмотра',
      runtimeMaxRowsPreviewDefaultHelp: 'Лимит строк для предпросмотра черновика и тестового прогона.',
      runtimeMaxRowsMax: 'Максимум строк',
      runtimeMaxRowsMaxHelp: 'Верхний предел строк, которые может вернуть одно выполнение.',
      runtimeMaxClassesDefault: 'Классов по умолчанию',
      runtimeMaxClassesDefaultHelp: 'Сколько классов CMDBuild читают операции сканирования модели по умолчанию.',
      runtimeMaxClassesMax: 'Максимум классов',
      runtimeMaxClassesMaxHelp: 'Верхний предел классов, читаемых за одно выполнение.',
      runtimeMaxDomainsDefault: 'Доменов по умолчанию',
      runtimeMaxDomainsDefaultHelp: 'Сколько доменов CMDBuild читают операции по связям/доменам по умолчанию.',
      runtimeMaxDomainsMax: 'Максимум доменов',
      runtimeMaxDomainsMaxHelp: 'Верхний предел доменов, читаемых за одно выполнение.',
      runtimeMaxRestCallsDefault: 'REST-вызовов по умолчанию',
      runtimeMaxRestCallsDefaultHelp: 'Бюджет REST-вызовов к CMDBuild для одного выполнения шаблона по умолчанию.',
      runtimeMaxRestCallsMax: 'Максимум REST-вызовов',
      runtimeMaxRestCallsMaxHelp: 'Верхний предел REST-вызовов к CMDBuild за одно выполнение.',
      runtimeMaxTraversalDepthDefault: 'Глубина раскрытия по умолчанию',
      runtimeMaxTraversalDepthDefaultHelp: 'Глубина обхода связей/путей, если шаблон не задал ее сам.',
      runtimeMaxTraversalDepthMax: 'Максимальная глубина раскрытия',
      runtimeMaxTraversalDepthMaxHelp: 'Верхний предел глубины обхода связей/путей.',
      code: 'Код',
      description: 'Описание',
      active: 'Активен',
      editingTemplate: 'Модифицируем',
      creatingTemplate: 'Создаем новый шаблон',
      templateCreateHelp: 'Укажите код и описание шаблона, затем сохраните. Логика запроса настраивается в разделах конструктора.',
      templateKind: 'Тип шаблона',
      templateKindDsl: 'Динамический шаблон данных',
      templateKindCmdbBuildView: 'CMDBuild model view',
      templateKindHelp: 'CMDBuild model view использует встроенный renderer и не проходит через обычный DSL выборок/сопоставлений.',
      menuCmdbBuildView: 'CMDBuild model view',
      cmdbBuildViewEditor: 'CMDBuild model view',
      cmdbBuildViewHelp: 'Специальный шаблон, который показывает классы, атрибуты, домены и lookup CMDBuild по правам текущего пользователя либо как опубликованный снимок.',
      cmdbBuildViewLanguage: 'Язык',
      cmdbBuildViewLanguageAuto: 'Авто',
      cmdbBuildViewRootClass: 'Root-класс для фильтра',
      cmdbBuildViewRootClassHelp: 'Необязательное имя класса/суперкласса CMDBuild. Если задано, показывается этот класс и его наследники.',
      cmdbBuildViewSections: 'Разделы',
      cmdbBuildViewClasses: 'Классы',
      cmdbBuildViewDomains: 'Домены',
      cmdbBuildViewLookups: 'Lookup',
      cmdbBuildViewSystemAttributes: 'Показывать системные атрибуты',
      cmdbBuildViewLookupScope: 'Объем lookup',
      cmdbBuildViewLookupUsed: 'Только используемые lookup',
      cmdbBuildViewLookupAll: 'Все lookup-типы',
      cmdbBuildViewApplied: 'Настройки CMDBuild model view применены к Spec JSON.',
      protectedTemplate: 'Защищен',
      protectedTemplateHelp: 'Системный шаблон: удаление блокируется backend.',
      copyFromTemplate: 'Скопировать с шаблона',
      doNotCopy: 'Не копировать',
      noTemplateToCopy: 'Нет сохраненных шаблонов для копирования.',
      copyFromTemplateHelp: 'Копируются конструктор, входные переменные, итоговые данные и визуализация. Код и описание нового шаблона сохраняются как введены.',
      templateCopyApplied: 'Шаблон {code} скопирован в черновик нового шаблона.',
      yes: 'да',
      no: 'нет',
      noData: 'Нет данных.',
      run: 'Запустить',
      visualizeInEditor: 'Визуализировать в редакторе',
      visualizeExternal: 'Визуализировать в отдельной странице',
      forceRefreshInEditor: 'Обновить кэш и показать',
      baaVerifyPreview: 'BAA verify',
      baaEndpointEditor: 'BAA endpoint',
      baaEndpointHelp: 'Опишите входной BAA-контракт до настройки правил. plan.objects - это входящие CMDB-like кандидаты, а не карточки CMDBuild.',
      baaVerifyEndpointUrl: 'URL BAA verification',
      baaVerifyEndpointUrlHelp: 'В cmdbaa нужно использовать этот абсолютный POST URL. Runtime/designer URL возвращают HTML и не подходят как BAA verification endpoint. Browser-вызовы используют CMDBuild session cookie и CSRF; server-to-server вызовы cmdbaa могут передавать CMDBuild-Authorization header.',
      baaContractCode: 'Код контракта',
      baaContractVersion: 'Версия контракта',
      baaContractDescription: 'Описание контракта',
      baaContractSource: 'Сохраненный input contract',
      baaContractSourceManual: 'Ручной контракт в шаблоне',
      baaContractObjects: 'Входящие объекты BAA',
      baaContractObjectsHelp: 'Это не CMDBuild-классы. Здесь описаны объекты, ожидаемые в POST plan.objects. Сохраненные BAA input contracts преобразуются из classes[] в этот список.',
      baaContractUsage: 'Как использовать этот контракт',
      baaContractUsageHelp: 'В правилах сопоставления выберите BAA candidates как выборку. Payload-поля доступны как Payload.<поле> и BAA.<className>.<поле>. После сопоставления используйте конечный результат в Итоговых данных и Визуализации.',
      baaContractNoObjects: 'В выбранном контракте нет читаемых classes/attributes.',
      baaContractVariables: 'BAA variables',
      baaContractParams: 'Параметры контракта',
      baaContractParamsHelp: 'Параметры контракта описаны в input contract как contractparam.*. BAA передает runtime-значения в endpoint.params.',
      baaRequestVariables: 'Переменные отправки',
      baaRequestVariablesHelp: 'BAA вычисляет эти переменные верхнего уровня перед POST. Они приходят в request.variables, могут быть скаляром или массивом и доступны как $' + '{var.name} и $' + '{param.name}.',
      baaObjectAlias: 'Alias',
      baaObjectClassName: 'Входящий класс',
      baaPayloadFields: 'Payload-поля',
      baaPayloadFieldsHelp: 'Поля, ожидаемые в Payload объекта. Типы: string, number, boolean, ipv4, ipv4-cidr.',
      baaVariablesHelp: 'Variables из POST body доступны как $' + '{var.name} и $' + '{param.name}.',
      addBaaVariable: 'Добавить variable',
      addBaaPayloadField: 'Добавить payload-поле',
      addBaaObject: 'Добавить тип кандидата',
      applyBaaEndpoint: 'Применить без сохранения',
      baaEndpointApplied: 'BAA endpoint contract применен.',
      baaContractValidationFailed: 'BAA contract validation failed.',
      baaRequestEditor: 'BAA verification request',
      baaRequestHelp: 'POST body для BAA verification exchange. endpoint.params передаются как параметры шаблона; plan.objects доступны через DSL step baaPlanObjects.',
      baaVerifyCompleted: 'BAA verification endpoint выполнен.',
      baaVerifyRefreshPreview: 'Обновить BAA-кэш и проверить',
      baaPostOnlyMode: 'POST-only',
      baaPostOnlyNotice: 'BAA-шаблоны являются POST-only verification endpoint. Они не выводят HTML runtime-страницы и не публикуют статические view-снимки.',
      baaSectionDisabled: 'Этот раздел отключен для BAA-шаблонов. Используйте BAA endpoint, извлечение, кэширование и BAA verify preview.',
      baaRunPostOnlyHelp: 'Используйте URL BAA verification и POST body. Runtime page links и iframe URL недоступны для этого типа шаблона.',
      runLaunchUrl: 'URL запуска шаблона',
      runLaunchJsonUrl: 'JSON URL',
      runLaunchParams: 'Варианты параметров',
      runLaunchParamsHelp: 'Query-строка, с которой будут построены ссылки запуска. Для JSON добавляется системный параметр json=true; он не передается в шаблон как входная переменная.',
      runLaunchNoParams: 'без входных параметров',
      runLaunchUrlHelp: 'Прямой runtime URL для ссылки или iframe. Строится из объявленных входных переменных; если default не задан, подставляется тестовое значение. Добавьте json=true, чтобы получить тот же результат как application/json.',
      visualizationRunCompleted: 'Визуализация выполнена.',
      forceRefreshRunCompleted: 'Кэш обновлен, результат показан.',
      publicationEditor: 'Публикация',
      publicationHelp: 'Статические снимки отдаются из Redis без проверки прав зрителя на исходные CMDBuild-объекты.',
      publicationMode: 'Режим выполнения',
      publicationDynamic: 'Динамически в правах зрителя',
      publicationStatic: 'Статический снимок от публикующего',
      publicationParamsMode: 'Параметры снимка',
      publicationParamsExact: 'Точный набор параметров',
      publicationParamsIgnore: 'Игнорировать runtime-параметры',
      publicationParamsModeHelp: 'Точный набор параметров публикует снимок только для текущих параметров запуска, например city=city49. Если runtime-параметры игнорируются, публикуется одна страница на код шаблона: параметры URL не учитываются, и все зрители видят один опубликованный результат.',
      publicationWarning: 'Внимание: пользователи увидят опубликованный результат без прав чтения на исходные CMDBuild-объекты.',
      publicationWarningAccepted: 'Я понимаю и принимаю этот режим публикации',
      applyPublication: 'Применить настройки публикации',
      publishSnapshot: 'Опубликовать/обновить снимок',
      publicationApplied: 'Настройки публикации применены к Spec JSON.',
      snapshotPublished: 'Снимок опубликован.',
      cacheEditor: 'Кэширование',
      cacheHelp: 'Управляет шарингом и временем хранения результата для этого endpoint шаблона. Ожидание перед refresh задается в системных Runtime-настройках.',
      cacheEnabled: 'Включить runtime-кэш',
      cacheScopeMode: 'Режим доступа',
      cachePermissionOnly: 'Только проверка прав, общий endpoint',
      cacheVisibilityHash: 'Visibility hash, общий endpoint',
      cachePrivateUser: 'Персонально на пользователя',
      cacheDisabled: 'Отключено',
      cacheTtlHours: 'Время кэша шаблона, часов',
      cacheAllowManualRefresh: 'Разрешить ручное обновление',
      cacheApply: 'Применить настройки кэша',
      cacheApplied: 'Настройки кэша применены к Spec JSON.',
      cachePermissionOnlyHelp: 'Быстрый режим по умолчанию: пользователь получает endpoint-cache после легкого probe по классам и атрибутам, которые реально использует шаблон.',
      cacheVisibilityHashHelp: 'Более строгий режим: перед шарингом дополнительно считается hash видимых id карточек.',
      cachePrivateUserHelp: 'Самый безопасный режим: кэш результата изолирован по пользователю/сессии CMDBuild.',
      deleteTemplate: 'Удалить',
      deleteTemplateConfirm: 'Удалить шаблон {code}?',
      templateDeleted: 'Шаблон удален.',
      noTemplates: 'Шаблонов нет.',
      runParamsJson: 'Параметры запуска JSON',
      runInputValues: 'Значения входных переменных',
      runInputValuesHelp: 'Тестовый ввод строится из переменных, объявленных в разделе Входные переменные.',
      runParamValue: 'Значение',
      noInputVariables: 'Входные переменные пока не объявлены.',
      specJson: 'Спецификация JSON',
      paramsSchemaJson: 'Схема параметров JSON',
      resultSchemaJson: 'Схема результата JSON',
      paramsEditor: 'Входные переменные',
      paramsEditorHelp: 'Объявите переменные, которые шаблон ожидает на вход. Таблица обновляет spec.params и заполняет тестовый ввод из примеров.',
      paramName: 'Имя',
      paramType: 'Тип',
      paramRequired: 'Обязательный',
      paramDefault: 'Значение по умолчанию',
      paramExample: 'Пример',
      paramDescription: 'Описание',
      addParam: 'Добавить параметр',
      applyParams: 'Применить параметры',
      fillExamples: 'Заполнить примеры',
      clear: 'Очистить',
      paramsApplied: 'Входные параметры применены к Spec JSON.',
      examplesFilled: 'Параметры запуска заполнены из примеров.',
      invalidParamName: 'Имя параметра должно начинаться с латинской буквы или подчеркивания и содержать только латинские буквы, цифры и подчеркивания.',
      reservedParamName: 'Параметр {name} зарезервирован для режима вывода runtime.',
      optionalParamNeedsDefault: 'Необязательный параметр {name} должен иметь значение по умолчанию.',
      invalidParamValue: 'Некорректное значение для {name}.',
      extractionEditor: 'Извлечение',
      extractionEditorHelp: 'Используйте регулярное выражение, чтобы извлечь внутренние переменные из входного параметра. Named groups становятся колонками результата.',
      extractByTemplate: 'Извлечь по шаблону',
      extractionSourceParam: 'Параметр-источник',
      extractionRegex: 'Регулярное выражение',
      extractionFlags: 'Флаги',
      extractionAlias: 'Алиас результата',
      extractionAllMatches: 'Все совпадения',
      extractionResultSource: 'Показать результат',
      extractionFinalResult: 'Конечный результат',
      applyExtraction: 'Применить извлечение',
      previewExtraction: 'Предпросмотр извлечения',
      extractionApplied: 'Шаг извлечения применен к Spec JSON.',
      extractionPreviewReady: 'Предпросмотр извлечения готов.',
      extractionCompleted: 'Извлечение по шаблону выполнено.',
      extractionNeedsSource: 'Параметр-источник обязателен.',
      extractionNeedsRegex: 'Регулярное выражение извлечения обязательно.',
      extractionNeedsAlias: 'Алиас результата извлечения обязателен.',
      extractionInvalidRegex: 'Регулярное выражение извлечения некорректно.',
      extractionNoRows: 'Объекты не найдены.',
      match: 'Совпадение',
      dataSelectionEditor: 'Выбор данных',
      dataSelectionEditorHelp: 'Выбирает карточки CMDBuild из класса. Класс и значения фильтров могут приходить из фиксированных значений, входных параметров или строк после извлечения.',
      dataSelectionAlias: 'Алиас результата',
      dataSelectionSource: 'Строки-источник',
      dataSelectionNoSource: 'Без строк-источника',
      dataSelectionClassName: 'Фиксированный класс',
      dataSelectionClassParam: 'Параметр класса',
      dataSelectionClassColumn: 'Колонка класса',
      dataSelectionLimit: 'Лимит',
      dataSelectionFilters: 'Фильтры',
      filterAttribute: 'Атрибут',
      filterOperator: 'Оператор',
      filterValue: 'Фиксированное значение',
      filterParam: 'Параметр',
      filterColumn: 'Колонка источника',
      filter: 'Фильтр',
      addFilter: 'Добавить фильтр',
      applySelection: 'Применить выборку',
      selectionApplied: 'Шаг выбора данных применен к Spec JSON.',
      selectionNeedsClass: 'Для выбора данных нужен фиксированный класс, параметр класса или колонка класса.',
      selectionNeedsAlias: 'Алиас результата выбора данных обязателен.',
      selectionInvalidLimit: 'Лимит выбора данных должен быть положительным целым числом.',
      visualizationEditor: 'Визуализация',
      visualizationEditorHelp: 'Настройте визуальное представление таблиц, подготовленных в Итоговых данных: пустой результат, заголовки, группировка, сортировка, фильтры и базовый стиль.',
      visualizationGlobal: 'Общее представление',
      visualizationTables: 'Представление таблиц',
      visualizationMessages: 'Сообщения',
      visualizationBaseStyle: 'Базовый стиль',
      visualizationRuntimeBehavior: 'Поведение runtime',
      visualizationTableHeader: 'Заголовок таблицы',
      visualizationSorting: 'Сортировка',
      visualizationSubtables: 'Подтаблицы',
      visualizationRowGrouping: 'Группировка строк',
      visualizationSource: 'Таблица',
      visualizationTitle: 'Заголовок таблицы',
      visualizationTitleHelp: 'Можно использовать входные параметры внутри заголовка: $' + '{param.city}, например Маршрутизаторы города $' + '{param.city}.',
      visualizationTitleAlign: 'Выравнивание заголовка',
      visualizationAlignLeft: 'Слева',
      visualizationAlignCenter: 'По центру',
      visualizationAlignRight: 'Справа',
      visualizationMode: 'Режим',
      visualizationEmptyText: 'Текст, если объекты не найдены',
      visualizationPermissionDeniedText: 'Текст если не хватает прав',
      visualizationFontSize: 'Размер шрифта',
      visualizationFontSmall: 'Мелкий',
      visualizationFontNormal: 'Обычный',
      visualizationFontLarge: 'Крупный',
      visualizationDensity: 'Плотность',
      visualizationDensityCompact: 'Компактная',
      visualizationDensityNormal: 'Обычная',
      visualizationZebra: 'Чередовать строки',
      visualizationRuntimeFilters: 'Фильтры в runtime',
      visualizationRuntimeFiltersHelp: 'Показывает над runtime-таблицей поиск в браузере. Он ищет только по строкам, уже полученным на страницу.',
      visualizationSortable: 'Сортировка по столбцам',
      visualizationSplitSubtables: 'Разбивать на подтаблицы',
      visualizationGroupBy: 'Разбить по колонке',
      visualizationGroupTitle: 'Заголовок подтаблицы',
      visualizationGroupTitleHelp: 'По умолчанию используется токен выбранной колонки, например $' + '{Выборка2.city}; при необходимости добавьте вокруг него статический текст.',
      visualizationRowGroupBy: 'Группировать по',
      visualizationRowGroupNextBy: 'Далее по',
      visualizationAddRowGroup: '+',
      visualizationRowGroupHelp: 'Повторяющиеся соседние значения в выбранных колонках выводятся одной объединенной ячейкой.',
      visualizationLinkColumns: 'Ссылки из колонок',
      visualizationLinkColumnsHelp: 'Превращает ячейку итоговых данных в безопасную runtime-ссылку. В шаблонах URL и текста можно использовать текущую ячейку, строку и входные параметры.',
      visualizationLinkModeText: 'Текст',
      visualizationLinkModeLink: 'Ссылка',
      visualizationLinkTargetSelf: 'Текущая вкладка',
      visualizationLinkTargetBlank: 'Новая вкладка',
      visualizationLinkColumn: 'Колонка',
      visualizationLinkMode: 'Режим',
      visualizationLinkUrlTemplate: 'Шаблон URL',
      visualizationLinkTextTemplate: 'Шаблон текста',
      visualizationLinkTarget: 'Куда открывать',
      visualizationLinkExamples: 'Примеры ссылок',
      visualizationLinkExamplesHelp: 'Доступны токены: $' + '{mysource.value}, $' + '{mysource.source}, $' + '{mysource.sourceClass}, $' + '{mysource.sourceId}, $' + '{mysource.attribute}, $' + '{mysource.domainPath}, $' + '{mysource.sourceURLSelection1}, $' + '{mysource.sourceURLВыборка1}, $' + '{row.ColumnName}, $' + '{param.name}. Ссылки javascript:, data: и vbscript: блокируются.',
      visualizationNoColumns: 'Нет колонок итоговых данных.',
      visualizationSortColumn: 'Начальная сортировка',
      visualizationSortDirection: 'Направление',
      visualizationSortAsc: 'По возрастанию',
      visualizationSortDesc: 'По убыванию',
      applyVisualization: 'Применить визуализацию',
      visualizationApplied: 'Визуализация применена к Spec JSON.',
      visualizationNoTables: 'Сначала настройте Итоговые данные: визуализация работает с подготовленными таблицами данных.',
      visualizationTable: 'таблица',
      visualizationCompact: 'компактно',
      visualizationKeyValue: 'ключ-значение',
      viewComposerEditor: 'Итоговые данные',
      viewComposerHelp: 'Подготовьте таблицу данных для визуализации: выберите источник, видимые колонки и пользовательские заголовки колонок. Колонки включают прямые атрибуты и пути через reference/domain до глубины каталога.',
      viewComposerSource: 'Источник данных',
      viewComposerSourceHelp: 'Источник - это внутренний результат конструктора. Он нужен только для подготовки итоговых данных и скрывается на экране визуализации.',
      viewComposerObjectsAlias: 'Результат группы объектов',
      viewComposerTitle: 'Заголовок таблицы',
      viewComposerMode: 'Режим отображения',
      viewComposerOnlyThis: 'Показывать только эту таблицу',
      viewComposerColumns: 'Видимые колонки',
      columnsCount: 'колонок',
      viewComposerColumnField: 'Поле',
      viewComposerColumnTitle: 'Заголовок колонки',
      viewComposerMultiMode: 'Несколько значений',
      viewComposerMultiJoin: 'В одной ячейке',
      viewComposerMultiRows: 'Строки по значениям',
      viewComposerSeparator: 'Разделитель',
      viewComposerEmptyRow: 'Строка при пустом',
      addViewColumn: 'Добавить колонку',
      applyViewComposer: 'Применить итоговые данные',
      viewComposerApplied: 'Итоговые данные применены к Spec JSON.',
      viewComposerNeedsSource: 'Для итоговых данных нужен источник результата.',
      viewComposerNeedsColumn: 'Для итоговых данных нужна хотя бы одна видимая колонка.',
      testWorkflow: 'Проверка',
      testWorkflowHelp: 'Заполните значения объявленных входных переменных, затем проверьте черновик и выполните preview перед сохранением в шаблон.',
      emulateInput: 'Эмулировать ввод',
      validateDraft: 'Проверить черновик',
      previewDraft: 'Предпросмотр черновика',
      saveAfterTest: 'Сохранить после проверки',
      draftValidateCompleted: 'Проверка черновика выполнена.',
      draftPreviewCompleted: 'Предпросмотр черновика выполнен.',
      saveNeedsPreview: 'Перед сохранением этой кнопкой выполните успешный предпросмотр черновика.',
      executionTrace: 'Trace выполнения',
      traceStep: 'Шаг',
      traceAlias: 'Алиас',
      traceRows: 'Строк',
      traceMs: 'мс',
      traceRest: 'REST',
      traceStatus: 'Статус',
      builder: 'Конструктор',
      preset: 'Заготовка',
      classesByAttribute: 'Классы по атрибуту',
      domainTraversal: 'Обход доменов',
      attributeComparison: 'Сравнение атрибутов',
      setOperations: 'Операции над наборами',
      attributeType: 'Тип атрибута',
      className: 'Класс',
      classNameProbe: 'Проверка класса по имени',
      classNameProbeHelp: 'Введите имя класса напрямую. Редактор больше не загружает полный каталог классов на главный экран.',
      classNameInput: 'Имя класса',
      classNameFallback: 'Fallback className',
      classNameFallbackHelp: 'Сохраняется в Spec JSON как defaults.className и используется, если runtime-параметры не содержат className.',
      checkClass: 'Проверить класс',
      applyClassFallback: 'Применить fallback',
      classFound: 'Класс доступен.',
      classNotFound: 'Класс не найден или не виден.',
      classAccessDenied: 'Текущий пользователь не может читать метаданные этого класса.',
      classFallbackApplied: 'Fallback className применен к Spec JSON.',
      checkedClass: 'Проверенный класс',
      depth: 'Глубина',
      referenceClass: 'Эталонный класс',
      rightType: 'Правый тип',
      apply: 'Применить',
      versions: 'Версии',
      version: 'Версия',
      changedAt: 'Когда изменено',
      changedBy: 'Кем изменено',
      comment: 'Комментарий',
      load: 'Загрузить',
      noVersions: 'Версий нет.',
      catalog: 'Каталог',
      catalogReady: 'каталог готов',
      catalogStale: 'каталог устарел',
      catalogMissing: 'каталога нет',
      catalogSyncing: 'синхронизация каталога',
      catalogSync: 'Синхронизировать каталог',
      catalogUpdatedAt: 'обновлен',
      catalogAge: 'возраст',
      catalogCounts: 'классы {classes}, атрибуты {attributes}, домены {domains}, lookup {lookups}',
      catalogError: 'Ошибка синхронизации каталога',
      maxDepth: 'Глубина',
      pathHints: 'Подсказки путей',
      pathKind: 'Тип',
      pathValue: 'Путь',
      pathTarget: 'Цель',
      pathDetails: 'Детали',
      noPathHints: 'Синхронизируйте каталог и выберите класс, чтобы увидеть подсказки путей.',
      selectFromCatalog: 'Выбрать из каталога',
      catalogClassApplied: 'Класс выбран из кэшированного каталога.',
      objectGroupEditor: 'Группа объектов',
      objectGroupHelp: 'Соберите scope объектов из стартового класса CMDBuild и правил включения/исключения.',
      baaObjectGroupSource: 'BAA-вход',
      baaObjectGroupSourceHelp: 'Объекты из POST plan.objects доступны в списке стартового класса как BAA payload-источники. Выберите их, если выборка должна начинаться с входящих данных.',
      objectSelectionTitle: 'Название выборки',
      objectSelectionDefault: 'Выборка{number}',
      addObjectSelection: 'Добавить выборку',
      objectGroupSourceClass: 'Стартовый класс',
      objectGroupScopeRules: 'Правила scope объектов',
      objectGroupScopeAction: 'Действие',
      objectGroupNegation: '!',
      objectGroupInclude: 'Включить в scope',
      objectGroupExclude: 'Исключить из scope',
      objectGroupPath: 'Атрибут/путь класса',
      objectGroupDomainFilter: 'Домен',
      objectGroupCardinalityFilter: 'Кардинальность',
      objectGroupDirectionFilter: 'Направление',
      objectGroupDomainExamples: 'Примеры путей через домены',
      objectGroupDomainExamplesHelp: 'Используйте эти фильтры, когда одно и то же имя атрибута доступно через разные reference/domain и в шаблоне нужно оставить только пути от конкретного типа связи.',
      objectGroupDomainExample1: 'Домен = NetworkACL оставляет пути, пришедшие через этот домен CMDBuild.',
      objectGroupDomainExample2: 'Кардинальность = N:N оставляет только пути, которые могут вернуть несколько связанных карточек.',
      objectGroupDomainExample3: 'Направление = inverse помогает отличать атрибуты, пришедшие с обратной стороны домена.',
      objectGroupOperator: 'Оператор',
      objectGroupValue: 'Значение / регулярное выражение',
      objectGroupValueHelp: 'Параметр не используется для exists, is IP и is IP net. Для matches это регулярное выражение; для IPv4-сравнений это CIDR/range/network справа.',
      objectGroupRegex: 'Значение / регулярное выражение',
      objectGroupRegexExamples: 'Примеры регулярных выражений',
      objectGroupRegexExample: 'Пример',
      objectGroupRegexMeaning: 'Назначение',
      addObjectGroupRule: 'Добавить правило',
      applyObjectGroup: 'Применить группу объектов',
      objectGroupApplied: 'Спецификация группы объектов применена.',
      objectGroupNeedsClass: 'Для группы объектов нужен стартовый класс.',
      objectGroupNeedsPath: 'В правиле scope объектов нужен атрибут/путь.',
      objectGroupNeedsRegex: 'В правиле scope объектов нужно значение или регулярное выражение.',
      objectGroupInvalidRegex: 'Регулярное выражение правила scope объектов некорректно.',
      objectGroupOperatorMatches: 'соответствует regex',
      objectGroupOperatorEquals: 'равно',
      objectGroupOperatorContains: 'содержит',
      objectGroupOperatorStartsWith: 'начинается с',
      objectGroupOperatorEndsWith: 'заканчивается на',
      objectGroupOperatorExists: 'заполнено',
      objectGroupOperatorIsIpv4: 'is IP',
      objectGroupOperatorIsIpv4Network: 'is IP net',
      relationEditor: 'Сопоставление с объектами',
      relationHelp: 'Сопоставьте выборки объектов между собой. Первый блок сравнивает две выборки, каждый следующий блок сравнивает предыдущий результат с очередной выборкой.',
      relationSourceClass: 'Исходный класс',
      relationParam: 'Входной параметр',
      relationParamExample: 'Пример',
      relationMatchAttribute: 'Атрибут поиска',
      relationMatchOperator: 'Оператор',
      relationSourceAlias: 'Алиас исходных карточек',
      relationResultAlias: 'Алиас результата',
      relationDomain: 'Домен',
      relationAnyDomain: 'Любой домен',
      relationTargetClass: 'Целевой класс',
      relationDirection: 'Направление',
      relationSourceLimit: 'Лимит исходных',
      relationLimit: 'Лимит связей',
      relationTableTitle: 'Заголовок таблицы',
      relationColumns: 'Колонки связанных карточек',
      relationColumnField: 'Поле',
      relationColumnTitle: 'Заголовок',
      addRelationColumn: 'Добавить колонку',
      applyRelation: 'Применить сопоставление',
      relationApplied: 'Спецификация сопоставления с объектами применена.',
      relationNeedsSourceClass: 'Для сопоставления с объектами нужен исходный класс.',
      relationNeedsParam: 'Для сопоставления с объектами нужен входной параметр.',
      relationNeedsMatchAttribute: 'Для сопоставления с объектами нужен атрибут поиска.',
      relationNeedsAlias: 'Для сопоставления с объектами нужен алиас результата.',
      relationNeedsColumn: 'Для сопоставления с объектами нужна хотя бы одна колонка связанной карточки.',
      matchingNeedsSelections: 'Сначала добавьте минимум две выборки объектов.',
      matchingBlock: 'Блок сопоставления {number}',
      matchingFirstPair: 'Первая пара выборок',
      matchingPreviousResult: 'Предыдущий результат',
      matchingLeftSelection: 'Левая выборка',
      matchingRightSelection: 'Правая выборка',
      matchingRules: 'Правила',
      matchingRuleAction: 'Действие',
      matchingLeftAttribute: 'Левый атрибут',
      matchingLeftRegex: 'Regex вырезки слева',
      matchingOperator: 'Оператор',
      matchingNegation: 'Отрицание',
      matchingNoNegation: '() не отрицая',
      matchingNegated: '! отрицая',
      matchingLeftObject: 'Левый объект',
      matchingRightObject: 'Правый объект',
      matchingOperatorEquals: 'равно',
      matchingOperatorNotEquals: 'не равно',
      matchingOperatorContains: 'содержит',
      matchingOperatorRegexMatch: 'соответствует regex',
      matchingOperatorIpv4InCidr: 'IPv4 входит в CIDR',
      matchingOperatorIpv4InRange: 'IPv4 входит в диапазон',
      matchingOperatorIpv4CidrOverlaps: 'IPv4 CIDR пересекается',
      matchingOperatorIpv4CidrContains: 'IPv4 CIDR содержит',
      matchingRightAttribute: 'Правый атрибут',
      matchingRightRegex: 'Regex вырезки справа',
      matchingRegexHelp: 'Пустой regex сравнивает значение целиком. Если в regex есть named group "value", используется она; иначе группа 1; без групп используется все совпадение.',
      matchingIpv4Help: 'IPv4 проверки. Поддерживаемые значения сети: 10.10.2.0/24, 10.10.2.1-10.10.2.254 или 10.10.2.0 255.255.255.0.',
      matchingIpv4ExamplesTitle: 'Примеры IPv4 операторов',
      matchingExampleFunction: 'Функция',
      matchingExampleInput: 'Пример',
      matchingExampleResult: 'Результат',
      addMatchingRule: 'Добавить правило',
      matchingNeedsRule: 'В каждом блоке сопоставления нужно хотя бы одно правило.',
      matchingNeedsColumn: 'В правиле сопоставления нужны оба атрибута.',
      matchingInvalidRegex: 'Regex вырезки в сопоставлении некорректен.',
      model: 'Модель',
      classes: 'Классы',
      class: 'Класс',
      crud: 'CRUD',
      noVisibleClasses: 'Нет видимых классов.',
      attributes: 'Атрибуты',
      attribute: 'Атрибут',
      type: 'Тип',
      domains: 'Домены',
      domain: 'Домен',
      source: 'Источник',
      destination: 'Назначение',
      cardinality: 'Кардинальность',
      selectClass: 'Выберите класс.',
      noVisibleDomains: 'Нет видимых доменов.',
      permissionRead: 'чтение',
      permissionCreate: 'создание',
      permissionUpdate: 'изменение',
      result: 'Результат',
      noRows: 'Строк нет.',
      permissionDeniedDefault: DEFAULT_PERMISSION_DENIED_TEXT,
      noResult: 'Результата проверки или preview еще нет.',
      diagnosticsHelp: 'Быстрые ссылки для проверки клиентских и proxy-логов.',
      clientLog: 'Клиентский лог',
      proxyLog: 'Proxy-лог',
      customPageLauncher: 'Запуск через custom page',
      truncated: 'обрезано',
      loadingDesigner: 'Загрузка дизайнера...',
      runningTemplate: 'Выполняется шаблон...',
      runtimeCacheBuilt: 'Построено сейчас',
      runtimeCacheHit: 'Результат из кэша',
      runtimeCacheJoined: 'Ожидание текущего построения',
      runtimeSnapshotHit: 'Опубликованный снимок',
      runtimeSnapshotMiss: 'Опубликованная страница отсутствует',
      runtimeSnapshotPublished: 'Снимок опубликован',
      runtimeCacheRefreshWait: 'Обновление доступно через {time}',
      runtimeCacheRefreshReady: 'Обновление доступно',
      runtimeCacheGeneratedAt: 'Построено',
      runtimeCacheExpiresIn: 'Кэш истекает через {time}',
      runtimeCacheBackend: 'Backend',
      runtimeCacheScope: 'Scope',
      runtimeCacheKey: 'Ключ кэша',
      runtimeCacheManualDisabled: 'Ручное обновление отключено',
      runtimeTableControlsDisabledByGrouping: 'Сортировка и фильтры отключены, потому что включена группировка строк.',
      runtimeFilterPlaceholder: 'Поиск по видимым строкам',
      runtimeRefresh: 'Обновить',
      runtimeRefreshing: 'Обновляется...',
      requestFailed: 'Запрос не выполнен.',
      httpStatus: 'HTTP {status}',
      invalidJson: '{id} должен содержать корректный JSON.',
      fieldRequired: '{label} обязательно.',
      templateCodeRequired: 'Код шаблона обязателен.',
      saved: 'Сохранено.',
      validateCompleted: 'Проверка выполнена.',
      previewCompleted: 'Предпросмотр выполнен.',
      schemaReadyMessage: 'Схема готова.',
      configSaved: 'Настройки сохранены.',
      versionLoaded: 'Версия загружена в редактор.',
      builderApplied: 'Заготовка применена.',
      builderClassesDescription: 'Шаблон поиска классов по типу атрибута',
      builderDomainDescription: 'Шаблон обхода доменов',
      builderComparisonDescription: 'Шаблон сравнения атрибутов',
      builderSetDescription: 'Шаблон операций над наборами классов',
      runtimeParams: 'Параметры запуска',
      guideTitle: 'Как шаблоны превращаются во view',
      guideTemplateTitle: 'Шаблон',
      guideTemplateText: 'Шаблон это карточка CMDBuild с Code, Description и Spec JSON. Он хранится в техническом классе Cst_QueryTemplate.',
      guideSpecTitle: 'Spec JSON',
      guideSpecText: 'Спецификация описывает params, последовательность steps и result.tables. Шаги читают модель и данные CMDBuild через REST от имени текущего пользователя.',
      guideViewTitle: 'Runtime view',
      guideViewText: 'View это URL, который запускает сохраненный шаблон с query-параметрами и рисует каждую таблицу результата.',
      guideStepsTitle: 'Обычный порядок работы',
      guideStep1: 'Выберите заготовку в Конструкторе или отредактируйте Spec JSON вручную.',
      guideStep2: 'Заполните Параметры запуска JSON тестовыми значениями и нажмите Предпросмотр.',
      guideStep3: 'После проверки сохраните шаблон.',
      guideStep4: 'Откройте runtime URL и передайте реальные параметры в query string.',
      guideUrlTitle: 'Формат runtime URL',
      guideUrlText: 'Каждая таблица из result.tables отображается отдельной таблицей на runtime-странице.',
      directRuntimeUrl: '/cmdbuild/dynamicpages/ui/run/<TemplateCode>?param=value',
      permissionNote: 'Все чтения выполняются в правах текущего пользователя CMDBuild; технический root только хранит классы проекта.'
    }
  };
  var activeLanguage = detectLanguage();
  var csrfToken = null;
  var CATALOG_CACHE_DB = 'cmdbdynamicpages';
  var CATALOG_CACHE_STORE = 'catalogCache';
  var CATALOG_CACHE_VERSION = 1;
  var CATALOG_FRESH_MS = 24 * 60 * 60 * 1000;
  var CMDB_BUILD_VIEW_KIND = 'cmdbBuildView';
  var DEFAULT_CMDB_BUILD_VIEW_CODE = 'CmdbBuildView';
  var state = {
    language: activeLanguage,
    root: 'Cst_QueryTool',
    session: boot.session || {},
    schema: null,
    schemaParents: [],
    schemaPlan: null,
    schemaRootDraft: '',
    schemaDescriptionDraft: '',
    schemaParentDraft: '',
    schemaClassDrafts: {},
    config: null,
    catalog: null,
    catalogStatus: { state: 'missing', updatedAt: null, error: '' },
    catalogSyncing: false,
    baaInputContracts: [],
    maxTraversalDepth: Math.max(1, Math.min(5, Number(readStorageValue('cmdbdynamicpages.maxTraversalDepth') || 2))),
    designerSection: normalizeDesignerSection(boot.designerSection || readDesignerSectionFromLocation()),
    templates: [],
    templateVersions: [],
    selectedTemplate: null,
    selectedClass: '',
    checkedClass: null,
    classCheckResult: null,
    classAttributes: [],
    objectGroupDraft: null,
    baaContractDraft: null,
    relationDraft: null,
    viewComposerDraft: null,
    paramRowsDraft: null,
    extractionPreview: null,
    extractionSource: '',
    lastDraftPreviewOk: false,
    builderKind: 'classes',
    runParams: {},
    message: null,
    result: null,
    runtimeRefreshInProgress: false,
    runtimeCountdownTimer: null,
    technicalSchemaAccessDenied: false,
    accessDeniedText: DEFAULT_PERMISSION_DENIED_TEXT
  };

  function normalizeDesignerSection(value) {
    var section = String(value || '').trim().toLowerCase();
    var allowed = [
      'templates',
      'template',
      'versions',
      'baa-endpoint',
      'object-group',
      'relations',
      'final-view',
      'cmdb-build-view',
      'params',
      'extraction',
      'run',
      'cache',
      'publication',
      'selection',
      'visualization',
      'schema',
      'general-settings',
      'settings',
      'diagnostics',
      'about'
    ];
    return allowed.indexOf(section) === -1 ? 'templates' : section;
  }

  function readDesignerSectionFromLocation() {
    var pathPrefix = '/cmdbuild/dynamicpages/ui/designer/';
    var pathname = window.location && window.location.pathname ? window.location.pathname : '';
    if (pathname.indexOf(pathPrefix) === 0) return decodeURIComponent(pathname.slice(pathPrefix.length).split('/')[0] || '');
    var params = new URLSearchParams(window.location.search || '');
    return params.get('section') || params.get('cmdpSection') || '';
  }

  function designerSectionUrl(section) {
    var normalized = normalizeDesignerSection(section);
    return '/cmdbuild/dynamicpages/ui/designer' + (normalized === 'templates' ? '' : '/' + encodeURIComponent(normalized));
  }

  function sectionNeedsSelectedTemplate(section) {
    return [
      'versions',
      'baa-endpoint',
      'object-group',
      'relations',
      'final-view',
      'cmdb-build-view',
      'params',
      'extraction',
      'run',
      'publication',
      'selection',
      'visualization'
    ].indexOf(normalizeDesignerSection(section)) !== -1;
  }

  function ensureTemplateListOnNewDesignerSession() {
    if (state.selectedTemplate || !sectionNeedsSelectedTemplate(state.designerSection)) return false;
    state.designerSection = 'templates';
    if (window.history && window.history.replaceState) {
      window.history.replaceState({ designerSection: 'templates' }, '', designerSectionUrl('templates'));
    }
    return true;
  }

  function setDesignerSection(section, replace) {
    if (!captureVisibleDesignerState()) return;
    var normalized = normalizeDesignerSection(section);
    if (!state.selectedTemplate && sectionNeedsSelectedTemplate(normalized)) normalized = 'templates';
    state.designerSection = normalized;
    var url = designerSectionUrl(normalized);
    if (window.history && window.history.pushState) {
      if (replace) window.history.replaceState({ designerSection: normalized }, '', url);
      else window.history.pushState({ designerSection: normalized }, '', url);
    }
    renderDesigner();
  }

  function normalizeLanguage(value) {
    var text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (text.indexOf('ru') === 0 || text.indexOf('russian') !== -1 || text.indexOf('рус') !== -1) return 'ru';
    if (text.indexOf('en') === 0 || text.indexOf('english') !== -1 || text.indexOf('анг') !== -1) return 'en';
    return '';
  }

  function readStorageValue(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : '';
    } catch (error) {
      return '';
    }
  }

  function writeStorageValue(key, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(key, value);
    } catch (error) {
    }
  }

  function catalogCacheKey() {
    var session = state.session || {};
    return [
      'catalog.v1',
      window.location.origin || 'origin',
      session.username || 'anonymous',
      session.role || 'role'
    ].join(':');
  }

  function openCatalogDb() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      var request = window.indexedDB.open(CATALOG_CACHE_DB, CATALOG_CACHE_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(CATALOG_CACHE_STORE)) {
          db.createObjectStore(CATALOG_CACHE_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
    });
  }

  function readCatalogCache() {
    var key = catalogCacheKey();
    return openCatalogDb().then(function (db) {
      if (!db) {
        var fallback = readStorageValue('cmdbdynamicpages.' + key);
        if (!fallback) return null;
        try { return JSON.parse(fallback); } catch (error) { return null; }
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(CATALOG_CACHE_STORE, 'readonly');
        var store = tx.objectStore(CATALOG_CACHE_STORE);
        var request = store.get(key);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      });
    });
  }

  function writeCatalogCache(catalog) {
    var record = {
      key: catalogCacheKey(),
      updatedAt: catalog && catalog.generatedAt ? catalog.generatedAt : new Date().toISOString(),
      catalog: catalog
    };
    return openCatalogDb().then(function (db) {
      if (!db) {
        try {
          writeStorageValue('cmdbdynamicpages.' + record.key, JSON.stringify(record));
        } catch (error) {
        }
        return record;
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(CATALOG_CACHE_STORE, 'readwrite');
        var store = tx.objectStore(CATALOG_CACHE_STORE);
        store.put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { resolve(record); };
      });
    });
  }

  function catalogAgeMs() {
    var updatedAt = state.catalogStatus && state.catalogStatus.updatedAt;
    if (!updatedAt) return null;
    var time = Date.parse(updatedAt);
    if (!Number.isFinite(time)) return null;
    return Math.max(0, Date.now() - time);
  }

  function formatAge(ms) {
    if (ms === null || ms === undefined) return '';
    var minutes = Math.floor(ms / 60000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return String(minutes) + 'm';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return String(hours) + 'h ' + String(minutes % 60) + 'm';
    return String(Math.floor(hours / 24)) + 'd ' + String(hours % 24) + 'h';
  }

  function applyCatalogCache(record) {
    var catalog = record && record.catalog ? record.catalog : null;
    state.catalog = catalog;
    if (!catalog) {
      state.catalogStatus = { state: 'missing', updatedAt: null, error: '' };
      return;
    }
    var updatedAt = record.updatedAt || catalog.generatedAt || null;
    var age = updatedAt ? Math.max(0, Date.now() - Date.parse(updatedAt)) : null;
    state.catalogStatus = {
      state: age !== null && age <= CATALOG_FRESH_MS ? 'ready' : 'stale',
      updatedAt: updatedAt,
      error: ''
    };
    if (state.selectedClass && !state.classAttributes.length) {
      var selected = catalogClassByName(state.selectedClass);
      if (selected) state.classAttributes = selected.attributes || [];
    }
  }

  function loadCatalogCache() {
    return readCatalogCache().then(function (record) {
      applyCatalogCache(record);
    });
  }

  function extractLanguageFromValue(value) {
    var normalized = normalizeLanguage(value);
    if (normalized) return normalized;
    if (!value || typeof value !== 'string') return '';
    try {
      var parsed = JSON.parse(value);
      var keys = ['language', 'lang', 'locale', 'uiLanguage', 'preferredLanguage'];
      for (var index = 0; index < keys.length; index += 1) {
        normalized = normalizeLanguage(parsed && parsed[keys[index]]);
        if (normalized) return normalized;
      }
    } catch (error) {
    }
    return '';
  }

  function detectCmdbuildStoredLanguage() {
    var exactKeys = [
      'cmdbdynamicpages.language',
      'cmdbuild.language',
      'cmdbuild.locale',
      'CMDBuild.language',
      'CMDBuild.locale',
      'language',
      'locale'
    ];
    var stores = [];
    try { if (window.localStorage) stores.push(window.localStorage); } catch (error) {}
    try { if (window.sessionStorage) stores.push(window.sessionStorage); } catch (error) {}
    for (var storeIndex = 0; storeIndex < stores.length; storeIndex += 1) {
      var store = stores[storeIndex];
      for (var keyIndex = 0; keyIndex < exactKeys.length; keyIndex += 1) {
        var direct = extractLanguageFromValue(store.getItem(exactKeys[keyIndex]));
        if (direct) return direct;
      }
      try {
        for (var index = 0; index < store.length; index += 1) {
          var key = store.key(index) || '';
          var lowered = key.toLowerCase();
          if (lowered.indexOf('language') === -1 && lowered.indexOf('locale') === -1) continue;
          var found = extractLanguageFromValue(store.getItem(key));
          if (found) return found;
        }
      } catch (error) {
      }
    }
    return '';
  }

  function detectLanguage() {
    var params = new URLSearchParams(window.location.search || '');
    var fromUrl = normalizeLanguage(params.get('cmdpLang') || params.get('lang'));
    if (fromUrl) return fromUrl;
    var saved = normalizeLanguage(readStorageValue('cmdbdynamicpages.language'));
    if (saved) return saved;
    var fromSession = normalizeLanguage(boot.session && (boot.session.language || boot.session.locale));
    if (fromSession) return fromSession;
    var fromCmdbuild = detectCmdbuildStoredLanguage();
    if (fromCmdbuild) return fromCmdbuild;
    var fromBrowser = normalizeLanguage(navigator.language || (navigator.languages && navigator.languages[0]));
    return fromBrowser || 'en';
  }

  function t(key, vars) {
    var lang = state && state.language ? state.language : activeLanguage;
    var dictionary = I18N[lang] || I18N.en;
    var text = dictionary[key] || I18N.en[key] || key;
    Object.keys(vars || {}).forEach(function (name) {
      text = text.split('{' + name + '}').join(String(vars[name]));
    });
    return text;
  }

  function updateChrome() {
    document.documentElement.lang = state.language;
    document.title = t('appTitle');
    var title = document.getElementById('cmdp-title');
    if (title) title.textContent = t('appTitle');
    var languageLabel = document.getElementById('cmdp-language-label');
    if (languageLabel) languageLabel.textContent = t('language');
    var languageSelect = document.getElementById('cmdp-language');
    if (languageSelect) languageSelect.value = state.language;
    updateCatalogHeader();
    var sessionLabel = document.getElementById('cmdp-session-label');
    if (sessionLabel) sessionLabel.textContent = (state.session.username || '') + ' / ' + (state.session.role || '');
  }

  function setupLanguageSelector() {
    var languageSelect = document.getElementById('cmdp-language');
    if (!languageSelect) return;
    languageSelect.value = state.language;
    languageSelect.addEventListener('change', function () {
      state.language = normalizeLanguage(languageSelect.value) || 'en';
      writeStorageValue('cmdbdynamicpages.language', state.language);
      updateChrome();
      if (boot.mode === 'runtime') loadRuntime();
      else {
        if (!captureVisibleDesignerState()) return;
        renderDesigner();
      }
    });
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pretty(value) {
    return JSON.stringify(value === undefined ? {} : value, null, 2);
  }

  function parseResponse(response) {
    return response.text().then(function (body) {
      var json = null;
      try { json = body ? JSON.parse(body) : null; } catch (error) { json = null; }
      return { ok: response.ok, status: response.status, json: json, body: body };
    });
  }

  function errorText(result) {
    if (!result) return t('requestFailed');
    if (result.json && result.json.errors) {
      return (result.json.message ? result.json.message + ': ' : '') + JSON.stringify(result.json.errors);
    }
    if (result.json && result.json.message) return result.json.message;
    return t('httpStatus', { status: result.status });
  }

  function resultIsPermissionDenied(result) {
    if (!result || result.ok) return false;
    var cmdbuildStatus = result.json && Number(result.json.cmdbuildStatus || 0);
    return result.status === 401 || result.status === 403 || cmdbuildStatus === 401 || cmdbuildStatus === 403 || Boolean(result.json && result.json.reason === 'technical_schema_access_denied');
  }

  function accessDeniedTextFromResult(result) {
    return result && result.json && (result.json.permissionDeniedText || result.json.message) || DEFAULT_PERMISSION_DENIED_TEXT;
  }

  function renderAccessDenied(text) {
    return '<section class="section"><div class="notice error">' + escapeHtml(text || DEFAULT_PERMISSION_DENIED_TEXT) + '</div>' +
      '<div class="toolbar"><a class="button" href="/cmdbuild/ui/#management">' + escapeHtml(t('cmdbuild')) + '</a><button data-action="refresh">' + escapeHtml(t('refresh')) + '</button></div></section>';
  }

  function request(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));
    var controller = window.AbortController ? new AbortController() : null;
    var timeoutId = null;
    var fetchOptions = {
      method: method,
      credentials: 'include',
      headers: { Accept: 'application/json' }
    };
    if (controller) fetchOptions.signal = controller.signal;
    if (options.body !== undefined) {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(options.body);
    }
    var execute = function () {
      timeoutId = window.setTimeout(function () {
        if (controller) controller.abort();
      }, timeoutMs);
      return fetch(path, fetchOptions).then(parseResponse).then(function (result) {
        window.clearTimeout(timeoutId);
        return result;
      }).catch(function (error) {
        window.clearTimeout(timeoutId);
        if (error && error.name === 'AbortError') throw new Error('Request timeout: ' + path);
        throw error;
      });
    };
    if (method === 'GET') return execute();
    return getCsrfToken().then(function (token) {
      fetchOptions.headers['X-CMDBDynamicPages-CSRF'] = token;
      return execute();
    });
  }

  function publicSnapshotRunPath(templateCode, params) {
    var query = new URLSearchParams(params || {}).toString();
    return apiPrefix + '/public-snapshots/' + encodeURIComponent(templateCode) + '/run' + (query ? '?' + query : '');
  }

  function runtimeRunPath(templateCode, params, refresh, forceRefresh) {
    var queryParams = new URLSearchParams(params || {});
    if (refresh) queryParams.set('refresh', '1');
    if (forceRefresh) queryParams.set('forceRefresh', '1');
    var query = queryParams.toString();
    return apiPrefix + '/templates/' + encodeURIComponent(templateCode) + '/run' + (query ? '?' + query : '');
  }

  function getCsrfToken() {
    if (csrfToken) return Promise.resolve(csrfToken);
    return fetch(apiPrefix + '/csrf', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' }
    }).then(parseResponse).then(function (result) {
      if (!result.ok || !result.json || !result.json.token) throw new Error(errorText(result));
      csrfToken = result.json.token;
      return csrfToken;
    });
  }

  function readValue(id) {
    var field = document.getElementById(id);
    return field ? field.value : '';
  }

  function readChecked(id) {
    var field = document.getElementById(id);
    return field ? Boolean(field.checked) : false;
  }

  function readJson(id, fallback) {
    var value = readValue(id);
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (error) { throw new Error(t('invalidJson', { id: id })); }
  }

  function hasField(id) {
    return Boolean(document.getElementById(id));
  }

  function readTemplateCode(selected) {
    selected = selected || state.selectedTemplate || {};
    return String(hasField('cmdp-code') ? readValue('cmdp-code') : (selected.code || '')).trim();
  }

  function readTemplateDescription(selected, code) {
    selected = selected || state.selectedTemplate || {};
    if (hasField('cmdp-description')) return readValue('cmdp-description');
    return selected.description || code || selected.code || '';
  }

  function readTemplateActive(selected) {
    selected = selected || state.selectedTemplate || {};
    if (hasField('cmdp-active')) return readChecked('cmdp-active');
    return selected.active !== false;
  }

  function readCurrentSpec(fallback) {
    var selected = state.selectedTemplate || {};
    return readJson('cmdp-spec', fallback || selected.spec || defaultSpec());
  }

  function readCurrentParamsSchema(fallback) {
    var selected = state.selectedTemplate || {};
    return readJson('cmdp-params-schema', fallback || selected.paramsSchema || {});
  }

  function readCurrentResultSchema(fallback) {
    var selected = state.selectedTemplate || {};
    return readJson('cmdp-result-schema', fallback || selected.resultSchema || {});
  }

  function readRunParams() {
    var fields = Array.prototype.slice.call(document.querySelectorAll('[data-run-param-field]'));
    if (fields.length) {
      var params = {};
      fields.forEach(function (field) {
        var name = field.getAttribute('data-run-param-field') || '';
        var type = field.getAttribute('data-run-param-type') || 'string';
        var required = field.getAttribute('data-run-param-required') === 'true';
        var defaultValue = field.getAttribute('data-run-param-default');
        if (!name) return;
        var value = coerceRunParamValue(name, type, field.value, required, defaultValue);
        if (value !== undefined) params[name] = value;
      });
      return params;
    }
    return readJson('cmdp-params', state.runParams || {});
  }

  function coerceRunParamValue(name, type, value, required, defaultValue) {
    var text = String(value === undefined || value === null ? '' : value);
    if (text === '' && defaultValue !== undefined && defaultValue !== '') text = String(defaultValue);
    if (text === '' && !required) return undefined;
    if ((type === 'integer' || type === 'number' || type === 'boolean') && text === '') {
      throw new Error(t('fieldRequired', { label: name }));
    }
    if (type === 'integer') {
      if (!/^-?\d+$/.test(text)) throw new Error(t('invalidParamValue', { name: name }));
      return Number(text);
    }
    if (type === 'number') {
      var number = Number(text);
      if (!Number.isFinite(number)) throw new Error(t('invalidParamValue', { name: name }));
      return number;
    }
    if (type === 'boolean') {
      var normalized = text.toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'да') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'нет') return false;
      throw new Error(t('invalidParamValue', { name: name }));
    }
    return text;
  }

  function emptyTemplate() {
    return { code: '', description: '', active: true, spec: defaultSpec(), paramsSchema: {}, resultSchema: {} };
  }

  function captureVisibleDesignerState() {
    var selected = state.selectedTemplate || emptyTemplate();
    try {
      if (hasField('cmdp-code') || hasField('cmdp-description') || hasField('cmdp-active') || hasField('cmdp-template-kind') || hasField('cmdp-spec') || hasField('cmdp-params-schema') || hasField('cmdp-result-schema')) {
        var code = readTemplateCode(selected);
        var capturedSpec = applyTemplateKindFromEditor(readCurrentSpec(selected.spec || defaultSpec()));
        state.selectedTemplate = Object.assign({}, selected, {
          code: code || selected.code || '',
          description: readTemplateDescription(selected, code) || selected.description || '',
          active: readTemplateActive(selected),
          spec: capturedSpec,
          paramsSchema: readCurrentParamsSchema(selected.paramsSchema || {}),
          resultSchema: readCurrentResultSchema(selected.resultSchema || {})
        });
      }
      if (document.querySelectorAll('[data-param-row]').length) {
        var specData = readSpecWithParamEditor();
        updateSelectedFromEditor(specData.spec);
        state.runParams = Object.assign({}, specData.examples || {}, state.runParams || {});
      }
      if (hasBaaEndpointEditorFields()) {
        updateSelectedFromEditor(applyBaaEndpointToSpec(state.selectedTemplate.spec || defaultSpec(), false));
      }
      if (document.querySelectorAll('[data-view-column-row]').length) {
        state.viewComposerDraft = captureViewComposerDraftFromDom();
      }
      if (hasField('cmdp-publish-mode')) {
        updateSelectedFromEditor(applyPublicationToSpec(state.selectedTemplate.spec || defaultSpec(), false));
      }
      if (hasField('cmdp-cache-enabled')) {
        updateSelectedFromEditor(applyCacheToSpec(state.selectedTemplate.spec || defaultSpec(), false));
      }
      if (hasField('cmdp-cmdb-build-language')) {
        updateSelectedFromEditor(applyCmdbBuildViewToSpec(state.selectedTemplate.spec || defaultCmdbBuildViewSpecClient(), false));
      }
      if (hasField('cmdp-root')) state.schemaRootDraft = readValue('cmdp-root') || state.root;
      if (hasField('cmdp-schema-description')) state.schemaDescriptionDraft = readValue('cmdp-schema-description');
      if (hasField('cmdp-schema-parent')) state.schemaParentDraft = readValue('cmdp-schema-parent') || 'Class';
      if (document.querySelectorAll('[data-schema-class-role]').length) state.schemaClassDrafts = readSchemaClassDraftsFromDom();
      if (hasField('cmdp-params') || document.querySelectorAll('[data-run-param-field]').length) state.runParams = readRunParams();
      return true;
    } catch (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
      return false;
    }
  }

  function defaultSpec() {
    return {
      version: 1,
      params: { attrType: { type: 'string', required: true } },
      publish: { mode: 'dynamicUser', paramsMode: 'exact', warningAccepted: false },
      cache: {
        enabled: true,
        scopeMode: 'permissionOnly',
        probeMode: 'usedFieldsOnly',
        shareMode: 'endpoint',
        ttlSeconds: DEFAULT_TEMPLATE_CACHE_TTL_SEC,
        allowManualRefresh: true
      },
      steps: [{ type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' }],
      result: {
        emptyText: DEFAULT_EMPTY_RESULT_TEXT,
        permissionDeniedText: DEFAULT_PERMISSION_DENIED_TEXT,
        tables: [{ name: 'classes', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] }]
      }
    };
  }

  function defaultCmdbBuildViewSpecClient() {
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
        ttlSeconds: DEFAULT_TEMPLATE_CACHE_TTL_SEC,
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

  function templateKindForSpec(spec) {
    return spec && spec.kind === CMDB_BUILD_VIEW_KIND ? CMDB_BUILD_VIEW_KIND : 'dsl';
  }

  function normalizeTemplateProtection(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
    if (templateKindForSpec(spec) === CMDB_BUILD_VIEW_KIND) return spec;
    var next = cloneJsonValue(spec, spec);
    delete next.protected;
    if (next.system && typeof next.system === 'object' && !Array.isArray(next.system)) {
      var system = Object.assign({}, next.system);
      delete system.protected;
      if (Object.keys(system).length) next.system = system;
      else delete next.system;
    }
    return next;
  }

  function publishModelForSpec(spec) {
    var publish = spec && spec.publish && typeof spec.publish === 'object' && !Array.isArray(spec.publish) ? spec.publish : {};
    return {
      mode: publish.mode === 'staticSnapshot' ? 'staticSnapshot' : 'dynamicUser',
      warningAccepted: Boolean(publish.warningAccepted),
      paramsMode: publish.paramsMode === 'ignore' ? 'ignore' : 'exact'
    };
  }

  function applyPublicationToSpec(spec, required) {
    if (!hasField('cmdp-publish-mode') && !required) return spec;
    spec = cloneJsonValue(spec || defaultSpec(), defaultSpec());
    var mode = String(readValue('cmdp-publish-mode') || 'dynamicUser') === 'staticSnapshot' ? 'staticSnapshot' : 'dynamicUser';
    var paramsMode = String(readValue('cmdp-publish-params-mode') || 'exact') === 'ignore' ? 'ignore' : 'exact';
    var warningAccepted = readChecked('cmdp-publish-warning-accepted');
    if (mode === 'staticSnapshot' && !warningAccepted) throw new Error(t('publicationWarning'));
    spec.publish = {
      mode: mode,
      paramsMode: paramsMode,
      warningAccepted: warningAccepted
    };
    return spec;
  }

  function cacheModelForSpec(spec) {
    var cache = spec && spec.cache && typeof spec.cache === 'object' && !Array.isArray(spec.cache) ? spec.cache : {};
    var scopeMode = cache.scopeMode || (cache.enabled === false ? 'disabled' : 'permissionOnly');
    if (['permissionOnly', 'visibilityHash', 'privateUser', 'disabled'].indexOf(scopeMode) === -1) scopeMode = 'permissionOnly';
    return {
      enabled: cache.enabled !== false && scopeMode !== 'disabled',
      scopeMode: scopeMode,
      ttlSeconds: Number(cache.ttlSeconds || DEFAULT_TEMPLATE_CACHE_TTL_SEC),
      allowManualRefresh: cache.allowManualRefresh !== false
    };
  }

  function cacheTtlHoursForInput(cache) {
    var seconds = Number((cache && cache.ttlSeconds) || DEFAULT_TEMPLATE_CACHE_TTL_SEC);
    var hours = seconds > 0 ? seconds / 3600 : DEFAULT_TEMPLATE_CACHE_TTL_SEC / 3600;
    var rounded = Math.round(hours * 100) / 100;
    return String(rounded);
  }

  function readPositiveNumberField(id, label, fallback) {
    var text = String(readValue(id) || '').trim();
    if (!text) return fallback;
    var number = Number(text.replace(',', '.'));
    if (!Number.isFinite(number) || number <= 0) throw new Error(t('invalidParamValue', { name: label || id }));
    return number;
  }

  function applyCacheToSpec(spec, required) {
    if (!hasField('cmdp-cache-enabled') && !required) return spec;
    spec = cloneJsonValue(spec || defaultSpec(), defaultSpec());
    var enabled = readChecked('cmdp-cache-enabled');
    var scopeMode = String(readValue('cmdp-cache-scope-mode') || 'permissionOnly');
    if (scopeMode === 'disabled') enabled = false;
    if (['permissionOnly', 'visibilityHash', 'privateUser', 'disabled'].indexOf(scopeMode) === -1) scopeMode = 'permissionOnly';
    var ttlHours = readPositiveNumberField('cmdp-cache-ttl-hours', t('cacheTtlHours'), DEFAULT_TEMPLATE_CACHE_TTL_SEC / 3600);
    var ttlSeconds = Math.max(1, Math.round(ttlHours * 60 * 60));
    spec.cache = {
      enabled: enabled,
      scopeMode: enabled ? scopeMode : 'disabled',
      probeMode: 'usedFieldsOnly',
      shareMode: enabled && scopeMode !== 'privateUser' ? 'endpoint' : 'user',
      ttlSeconds: ttlSeconds,
      allowManualRefresh: readChecked('cmdp-cache-allow-manual-refresh')
    };
    return spec;
  }

  function defaultRuntimeConfig() {
    return {
      runtimeCache: {
        refreshCooldownSec: 180
      },
      baaTechnical: {
        superclassPath: 'BAA technical superclass',
        conversionContractClass: 'BAAConversionContract',
        conversionContractVersionClass: 'BAAConversionContractVersion',
        verificationInputContractClass: 'BAAVerificationInputContract',
        verificationOutputContractClass: 'BAAVerificationOutputContract',
        verificationEndpointClass: 'BAAVerificationEndpoint'
      },
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

  function normalizeRuntimeConfigForEditor(runtimeConfig) {
    var defaults = defaultRuntimeConfig();
    var source = runtimeConfig && typeof runtimeConfig === 'object' && !Array.isArray(runtimeConfig) ? runtimeConfig : {};
    return Object.assign({}, defaults, source, {
      runtimeCache: Object.assign({}, defaults.runtimeCache, source.runtimeCache || {}),
      baaTechnical: Object.assign({}, defaults.baaTechnical, source.baaTechnical || {}),
      executionLimits: Object.assign({}, defaults.executionLimits, source.executionLimits || {})
    });
  }

  function readPositiveIntField(id, label, fallback) {
    var text = String(readValue(id) || '').trim();
    if (!text) return fallback;
    var number = Number(text);
    if (!Number.isInteger(number) || number <= 0) throw new Error(t('invalidParamValue', { name: label || id }));
    return number;
  }

  function getParamDefaultValue(spec, name, fallback) {
    var params = spec && spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {};
    var definition = params[name];
    if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
      if (definition.default !== undefined) return definition.default;
      if (definition.defaultValue !== undefined) return definition.defaultValue;
      if (definition.example !== undefined) return definition.example;
    }
    var defaults = spec && spec.defaults && typeof spec.defaults === 'object' && !Array.isArray(spec.defaults) ? spec.defaults : {};
    if (defaults[name] !== undefined) return defaults[name];
    return fallback;
  }

  function getRunParamsFromSpec(spec) {
    var params = spec && spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {};
    var result = {};
    var builder = inferBuilderStateFromSpec(spec);
    var inferred = {
      attrType: builder.attrType,
      leftType: builder.attrType,
      rightType: builder.rightType,
      className: builder.className,
      referenceClass: builder.referenceClass,
      depth: builder.depth
    };
    Object.keys(params).forEach(function (name) {
      var value = getParamDefaultValue(spec, name, undefined);
      if (value === undefined && inferred[name] !== undefined && inferred[name] !== '') value = inferred[name];
      if (value !== undefined) result[name] = value;
    });
    var defaults = spec && spec.defaults && typeof spec.defaults === 'object' && !Array.isArray(spec.defaults) ? spec.defaults : {};
    Object.keys(defaults).forEach(function (name) {
      if (result[name] === undefined) result[name] = defaults[name];
    });
    return result;
  }

  function findStep(spec, predicate) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    return steps.find(predicate) || null;
  }

  function getAttributeTypeForBuilder(step, spec, fallback) {
    if (!step) return fallback;
    if (step.attributeType !== undefined) return step.attributeType;
    if (step.attributeTypeParam) return getParamDefaultValue(spec, step.attributeTypeParam, fallback);
    return fallback;
  }

  function getFilterValueForBuilder(step, paramName, columnName, spec, fallback) {
    var filters = step && Array.isArray(step.filters || step.where) ? (step.filters || step.where) : [];
    var filter = filters.find(function (item) {
      return item && (item.valueParam === paramName || item.column === columnName || item.attribute === columnName);
    }) || null;
    if (!filter) return fallback;
    if (filter.value !== undefined) return filter.value;
    if (filter.valueParam) return getParamDefaultValue(spec, filter.valueParam, fallback);
    return fallback;
  }

  function inferBuilderStateFromSpec(spec) {
    spec = spec || defaultSpec();
    var findSteps = (spec.steps || []).filter(function (step) { return step && step.type === 'findClassesByAttributeType'; });
    var firstFind = findSteps[0] || null;
    var traversal = findStep(spec, function (step) { return step && step.type === 'traverseDomains'; });
    var comparison = findStep(spec, function (step) { return step && step.type === 'compareClassAttributes'; });
    var intersection = findStep(spec, function (step) { return step && step.type === 'intersectRows'; });
    var join = findStep(spec, function (step) { return step && step.type === 'joinRows'; });
    var filterRows = findStep(spec, function (step) { return step && step.type === 'filterRows'; });
    var className = getParamDefaultValue(spec, 'className', '');
    var referenceClass = getParamDefaultValue(spec, 'referenceClass', className || '');
    var kind = 'classes';

    if (traversal) {
      kind = 'domainTraversal';
      className = className || getFilterValueForBuilder(filterRows, 'className', 'Class', spec, '');
    } else if (comparison) {
      kind = 'attributeComparison';
      referenceClass = comparison.referenceClass || (comparison.referenceClassParam ? getParamDefaultValue(spec, comparison.referenceClassParam, comparison.referenceClassParam) : referenceClass);
    } else if (intersection || join || findSteps.length > 1) {
      kind = 'setOperations';
    }

    return {
      kind: kind,
      attrType: getAttributeTypeForBuilder(firstFind, spec, getParamDefaultValue(spec, 'attrType', getParamDefaultValue(spec, 'leftType', 'reference'))),
      className: className,
      depth: traversal && traversal.depth !== undefined
        ? traversal.depth
        : traversal && traversal.depthParam
          ? getParamDefaultValue(spec, traversal.depthParam, '1')
          : getParamDefaultValue(spec, 'depth', '1'),
      referenceClass: referenceClass,
      rightType: getAttributeTypeForBuilder(findSteps[1] || null, spec, getParamDefaultValue(spec, 'rightType', 'string'))
    };
  }

  function hydrateDesignerStateFromTemplate(options) {
    options = options || {};
    var selected = state.selectedTemplate;
    var spec = selected && selected.spec ? selected.spec : defaultSpec();
    var builder = inferBuilderStateFromSpec(spec);
    var relation = getRelationExpansionStep(spec);
    var selection = getDataSelectionStep(spec);
    state.builderKind = builder.kind;
    state.selectedClass = getSpecClassFallback(spec) || builder.className || builder.referenceClass || relation.targetClass || selection.className || state.selectedClass || '';
    if (options.replaceRunParams || !state.runParams || Object.keys(state.runParams).length === 0) {
      state.runParams = getRunParamsFromSpec(spec);
    }
    state.extractionPreview = null;
    state.lastDraftPreviewOk = false;
  }

  function renderNotice(message) {
    if (!message || !message.text) return '';
    return '<div class="notice ' + escapeHtml(message.type || '') + '">' + escapeHtml(message.text) + '</div>';
  }

  function renderKpi(label, value) {
    return '<div class="kpi"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
  }

  function renderPermissionFlags(permissions) {
    var names = ['_can_read', '_can_create', '_can_update'];
    var labels = { _can_read: 'R', _can_create: 'C', _can_update: 'U' };
    var titles = { _can_read: t('permissionRead'), _can_create: t('permissionCreate'), _can_update: t('permissionUpdate') };
    return names.map(function (name) {
      var active = Boolean(permissions && permissions[name]);
      return '<span class="pill ' + (active ? 'ok' : '') + '" title="' + escapeHtml(titles[name]) + '">' + labels[name] + '</span>';
    }).join(' ');
  }

  function canBootstrapSchema() {
    return Boolean(state.session && state.session.rolePrivileges && state.session.rolePrivileges.admin_classes_modify);
  }

  function schemaStatusLabel(schema) {
    if (!schema) return t('notReady');
    if (schema.ready) return t('ready');
    if (schema.status === 'inaccessible') return t('schemaInaccessible');
    if (schema.status === 'missing') return t('schemaMissing');
    if (schema.status === 'conflict') return t('schemaConflict');
    if (schema.status === 'error') return t('schemaError');
    return t('notReady');
  }

  function schemaStatusHelp(schema) {
    if (!schema) return t('schemaErrorHelp');
    if (schema.ready) return t('schemaReadyHelp');
    if (schema.status === 'inaccessible') return t('schemaInaccessibleHelp');
    if (schema.status === 'missing') return t('schemaMissingHelp');
    if (schema.status === 'conflict') return t('schemaConflictHelp');
    if (schema.status === 'error') return t('schemaErrorHelp');
    return t('schemaErrorHelp');
  }

  function renderSchemaStatus(schema) {
    var details = [];
    if (schema && Array.isArray(schema.missing) && schema.missing.length) details.push('missing: ' + schema.missing.length);
    if (schema && Array.isArray(schema.inaccessible) && schema.inaccessible.length) details.push('inaccessible: ' + schema.inaccessible.length);
    if (schema && Array.isArray(schema.conflicts) && schema.conflicts.length) details.push('conflicts: ' + schema.conflicts.length);
    if (schema && Array.isArray(schema.errors) && schema.errors.length) details.push('errors: ' + schema.errors.length);
    return [
      '<div class="notice ' + (schema && schema.ready ? 'ok' : 'error') + '">',
      '<strong>' + schemaStatusLabel(schema) + '</strong>',
      '<p>' + schemaStatusHelp(schema) + '</p>',
      details.length ? '<p class="muted">' + escapeHtml(details.join(', ')) + '</p>' : '',
      '</div>'
    ].join('');
  }

  function catalogCounts() {
    var catalog = state.catalog || {};
    var counts = catalog.counts || {};
    return {
      classes: counts.classes || (Array.isArray(catalog.classes) ? catalog.classes.length : 0),
      attributes: counts.attributes || 0,
      domains: counts.domains || (Array.isArray(catalog.domains) ? catalog.domains.length : 0),
      lookups: counts.lookupTypes || (Array.isArray(catalog.lookupTypes) ? catalog.lookupTypes.length : 0)
    };
  }

  function catalogStatusText() {
    if (state.catalogSyncing) return t('catalogSyncing');
    var status = state.catalogStatus || {};
    if (status.state === 'ready') return t('catalogReady');
    if (status.state === 'stale') return t('catalogStale');
    if (status.state === 'error') return t('catalogError');
    return t('catalogMissing');
  }

  function catalogStatusClass() {
    if (state.catalogSyncing) return 'loading';
    var status = state.catalogStatus || {};
    if (status.state === 'ready') return 'ok';
    if (status.state === 'stale') return 'warn';
    return 'error';
  }

  function catalogSyncTitle() {
    var status = state.catalogStatus || {};
    if (status.updatedAt) return t('catalogUpdatedAt') + ': ' + status.updatedAt;
    return t('catalogMissing');
  }

  function updateCatalogHeader() {
    var button = document.getElementById('cmdp-catalog-header');
    if (!button) return;
    if (boot.mode === 'runtime') {
      button.style.display = 'none';
      return;
    }
    button.style.display = '';
    button.title = catalogSyncTitle();
    button.setAttribute('aria-label', catalogSyncTitle());
    var label = document.getElementById('cmdp-catalog-label');
    if (label) label.textContent = t('catalog');
    var lamp = document.getElementById('cmdp-catalog-lamp');
    if (lamp) lamp.className = 'lamp ' + catalogStatusClass();
  }

  function catalogClasses() {
    return state.catalog && Array.isArray(state.catalog.classes) ? state.catalog.classes : [];
  }

  function catalogDomains() {
    return state.catalog && Array.isArray(state.catalog.domains) ? state.catalog.domains : [];
  }

  function catalogClassByName(name) {
    var target = String(name || '').toLowerCase();
    if (!target) return null;
    return catalogClasses().find(function (item) {
      return String(item.name || '').toLowerCase() === target;
    }) || null;
  }

  function catalogClassLabel(item) {
    var name = String(item && item.name || '').trim();
    var description = String(item && item.description || '').trim();
    if (description && description !== name) return name + ' - ' + description;
    return name;
  }

  function catalogClassSortText(item) {
    return (String(item && item.description || '') + ' ' + String(item && item.name || '')).toLowerCase();
  }

  function catalogClassOptionRows(selectedName) {
    var classes = catalogClasses().slice();
    var byName = {};
    classes.forEach(function (item) {
      if (item && item.name) byName[String(item.name).toLowerCase()] = item;
    });
    if (selectedName && !byName[String(selectedName).toLowerCase()]) {
      var missing = { name: selectedName, description: '' };
      classes.unshift(missing);
      byName[String(selectedName).toLowerCase()] = missing;
    }

    var childrenByParent = {};
    var roots = [];
    classes.forEach(function (item) {
      var parent = String(item && item.parent || '').toLowerCase();
      if (parent && byName[parent]) {
        if (!childrenByParent[parent]) childrenByParent[parent] = [];
        childrenByParent[parent].push(item);
      } else {
        roots.push(item);
      }
    });

    function sortItems(items) {
      return items.sort(function (left, right) {
        return catalogClassSortText(left).localeCompare(catalogClassSortText(right));
      });
    }

    var rows = [];
    var visited = {};
    function visit(item, depth) {
      if (!item || !item.name) return;
      var key = String(item.name).toLowerCase();
      if (visited[key]) return;
      visited[key] = true;
      rows.push({
        name: item.name,
        label: (depth ? new Array(depth + 1).join('--') + ' ' : '') + catalogClassLabel(item)
      });
      sortItems(childrenByParent[key] || []).forEach(function (child) {
        visit(child, depth + 1);
      });
    }

    sortItems(roots).forEach(function (item) { visit(item, 0); });
    sortItems(classes.filter(function (item) { return item && item.name && !visited[String(item.name).toLowerCase()]; })).forEach(function (item) {
      visit(item, 0);
    });
    return rows;
  }

  function uniqueCatalogStrings(values) {
    var result = [];
    (values || []).forEach(function (value) {
      var text = String(value || '').trim();
      if (text && result.indexOf(text) === -1) result.push(text);
    });
    return result;
  }

  function domainSources(domain) {
    return uniqueCatalogStrings([domain.source].concat(domain.sources || []));
  }

  function domainDestinations(domain) {
    return uniqueCatalogStrings([domain.destination].concat(domain.destinations || []));
  }

  function domainRelatedClasses(domain, className) {
    var sources = domainSources(domain);
    var destinations = domainDestinations(domain);
    var related = [];
    if (sources.indexOf(className) !== -1) related = related.concat(destinations);
    if (destinations.indexOf(className) !== -1) related = related.concat(sources);
    return uniqueCatalogStrings(related).filter(function (name) { return name !== className; });
  }

  function isReferenceAttribute(attribute) {
    return attribute && (attribute.type === 'reference' || attribute.targetClass || attribute.domain);
  }

  function buildCatalogPathHints(className, maxDepth) {
    var root = catalogClassByName(className);
    if (!root) return [];
    var hints = [];
    var limit = 120;

    function add(kind, path, target, details) {
      if (hints.length >= limit) return;
      hints.push({ kind: kind, path: path, target: target || '', details: details || '' });
    }

    function directAttributes(owner, prefix) {
      (owner.attributes || []).forEach(function (attribute) {
        if (!attribute || attribute.active === false || attribute.permissions && attribute.permissions._can_read === false) return;
        if (attribute.lookupType) add('lookup', prefix + attribute.name, owner.name, attribute.lookupType);
        else if (!isReferenceAttribute(attribute)) add('attribute', prefix + attribute.name, owner.name, attribute.type || '');
      });
    }

    directAttributes(root, '');

    (root.attributes || []).forEach(function (attribute) {
      if (!isReferenceAttribute(attribute)) return;
      var targetClass = attribute.targetClass || attribute.targetType || '';
      add('reference', attribute.name, targetClass, attribute.domain || attribute.type || '');
      if (maxDepth <= 1 || !targetClass) return;
      var target = catalogClassByName(targetClass);
      if (!target) return;
      directAttributes(target, attribute.name + '.');
    });

    catalogDomains().forEach(function (domain) {
      domainRelatedClasses(domain, root.name).forEach(function (relatedClass) {
        var basePath = '{' + domain.name + ':' + relatedClass + '}';
        add('domain', basePath, relatedClass, domain.cardinality || '');
        if (maxDepth <= 1) return;
        var target = catalogClassByName(relatedClass);
        if (!target) return;
        directAttributes(target, basePath + '.');
      });
    });

    return hints;
  }

  function renderCatalogClassSelector(className) {
    var classes = catalogClassOptionRows(className);
    if (!classes.length) return '';
    return [
      '<div class="row" style="margin-top:8px">',
      '<label>' + t('selectFromCatalog') + '<select id="cmdp-catalog-class">',
      '<option value=""></option>',
      classes.map(function (item) {
        var selected = item.name === className ? ' selected' : '';
        return '<option value="' + escapeHtml(item.name || '') + '"' + selected + '>' + escapeHtml(item.label || item.name || '') + '</option>';
      }).join(''),
      '</select></label>',
      '</div>'
    ].join('');
  }

  function renderCatalogPathHints(className) {
    var hints = buildCatalogPathHints(className, Number(state.maxTraversalDepth) || 1);
    var rows = hints.map(function (hint) {
      return '<tr><td>' + escapeHtml(hint.kind) + '</td><td><span class="code-inline">' + escapeHtml(hint.path) + '</span></td><td>' + escapeHtml(hint.target) + '</td><td>' + escapeHtml(hint.details) + '</td></tr>';
    }).join('');
    return [
      '<div style="margin-top:10px"><h3>' + t('pathHints') + '</h3>',
      '<table class="compact"><thead><tr><th>' + t('pathKind') + '</th><th>' + t('pathValue') + '</th><th>' + t('pathTarget') + '</th><th>' + t('pathDetails') + '</th></tr></thead><tbody>',
      rows || '<tr><td colspan="4">' + t('noPathHints') + '</td></tr>',
      '</tbody></table></div>'
    ].join('');
  }

  function catalogAttributeOptions(className) {
    var owner = catalogClassByName(className);
    var base = [
      { name: 'Code', description: 'Code', type: 'string' },
      { name: 'Description', description: 'Description', type: 'string' },
      { name: '_id', description: 'Id', type: 'integer' }
    ];
    var seen = base.map(function (item) { return item.name; });
    var attributes = owner && Array.isArray(owner.attributes) ? owner.attributes : [];
    attributes.forEach(function (attribute) {
      if (!attribute || !attribute.name || seen.indexOf(attribute.name) !== -1) return;
      seen.push(attribute.name);
      base.push(attribute);
    });
    return base;
  }

  function catalogScopePathOptions(className) {
    var result = [];
    var seen = {};
    var maxDepth = Math.max(1, Math.min(5, Number(state.maxTraversalDepth) || 1));

    function add(value, label, type, relation) {
      var text = String(value || '').trim();
      if (!text || seen[text]) return;
      seen[text] = true;
      relation = relation || {};
      result.push({
        value: text,
        label: label || text,
        type: type || '',
        domain: relation.domain || '',
        domainDescription: relation.domainDescription || '',
        cardinality: relation.cardinality || '',
        direction: relation.direction || '',
        sourceClass: relation.sourceClass || '',
        targetClass: relation.targetClass || '',
        relationPath: relation.relationPath || ''
      });
    }

    function addDirectAttributes(owner, prefix, depth, relation) {
      if (!owner || depth > maxDepth) return;
      catalogAttributeOptions(owner.name).forEach(function (attribute) {
        if (!attribute || !attribute.name) return;
        var path = prefix + attribute.name;
        var label = path + (attribute.type ? ' : ' + attribute.type : '');
        if (attribute.description && attribute.description !== attribute.name) label += ' - ' + attribute.description;
        if (relation && relation.domain) {
          label += ' [' + relation.domain + (relation.cardinality ? ' ' + relation.cardinality : '') + (relation.direction ? ' ' + relation.direction : '') + ']';
        }
        add(path, label, attribute.type || '', relation);
      });
    }

    function domainDirectionForClass(domain, ownerName) {
      var sources = domainSources(domain);
      var destinations = domainDestinations(domain);
      if (sources.indexOf(ownerName) !== -1) return 'direct';
      if (destinations.indexOf(ownerName) !== -1) return 'inverse';
      return '';
    }

    function visit(owner, prefix, depth, visited, relation) {
      if (!owner || depth > maxDepth) return;
      var ownerKey = String(owner.name || '').toLowerCase();
      var nextVisited = Object.assign({}, visited || {});
      if (nextVisited[ownerKey]) return;
      nextVisited[ownerKey] = true;
      addDirectAttributes(owner, prefix, depth, relation);
      if (depth >= maxDepth) return;

      (owner.attributes || []).forEach(function (attribute) {
        if (!isReferenceAttribute(attribute)) return;
        var targetClass = attribute.targetClass || attribute.targetType || '';
        var target = catalogClassByName(targetClass);
        if (!target) return;
        visit(target, prefix + attribute.name + '.', depth + 1, nextVisited, relation);
      });

      catalogDomains().forEach(function (domain) {
        domainRelatedClasses(domain, owner.name).forEach(function (relatedClass) {
          var target = catalogClassByName(relatedClass);
          if (!target) return;
          var direction = domainDirectionForClass(domain, owner.name);
          var relationInfo = {
            domain: domain.name || '',
            domainDescription: domain.description || '',
            cardinality: domain.cardinality || '',
            direction: direction,
            sourceClass: owner.name || '',
            targetClass: relatedClass,
            relationPath: prefix + '{' + domain.name + ':' + relatedClass + '}'
          };
          visit(target, prefix + '{' + domain.name + ':' + relatedClass + '}.', depth + 1, nextVisited, relationInfo);
        });
      });
    }

    visit(catalogClassByName(className), '', 0, {}, null);
    return result;
  }

  function renderScopePathOptions(className, selectedName) {
    var options = isBaaSourceClassName(className)
      ? baaScopePathOptionsForSource(readCurrentSpec(), className)
      : catalogScopePathOptions(className);
    if (selectedName && !options.some(function (item) { return item.value === selectedName; })) {
      options.unshift({ value: selectedName, label: selectedName, type: '' });
    }
    return '<option value=""></option>' + options.filter(Boolean).map(function (item) {
      return '<option value="' + escapeHtml(item.value || '') + '"' +
        ' data-domain="' + escapeHtml(item.domain || '') + '"' +
        ' data-cardinality="' + escapeHtml(item.cardinality || '') + '"' +
        ' data-direction="' + escapeHtml(item.direction || '') + '"' +
        ' data-source-class="' + escapeHtml(item.sourceClass || '') + '"' +
        ' data-target-class="' + escapeHtml(item.targetClass || '') + '"' +
        (item.value === selectedName ? ' selected' : '') + '>' + escapeHtml(item.label || item.value || '') + '</option>';
    }).join('');
  }

  function renderAttributeOptions(className, selectedName) {
    var options = catalogAttributeOptions(className);
    if (selectedName && !options.some(function (item) { return item.name === selectedName; })) {
      options.unshift({ name: selectedName, description: '', type: '' });
    }
    return '<option value=""></option>' + options.map(function (item) {
      var label = item.name + (item.type ? ' : ' + item.type : '');
      return '<option value="' + escapeHtml(item.name || '') + '"' + (item.name === selectedName ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
  }

  function renderClassOptions(selectedName) {
    var classes = catalogClassOptionRows(selectedName);
    return '<option value=""></option>' + classes.map(function (item) {
      return '<option value="' + escapeHtml(item.name || '') + '"' + (item.name === selectedName ? ' selected' : '') + '>' + escapeHtml(item.label || item.name || '') + '</option>';
    }).join('');
  }

  function baaSourceClassName(alias) {
    var text = String(alias || '').trim();
    return text ? '__baa__:' + text : '';
  }

  function isBaaSourceClassName(value) {
    return String(value || '').indexOf('__baa__:') === 0;
  }

  function baaAliasFromSourceClassName(value) {
    var text = String(value || '').trim();
    return isBaaSourceClassName(text) ? text.slice('__baa__:'.length) : '';
  }

  function baaObjectDisplayName(object) {
    object = object || {};
    return object.className || object.alias || 'candidate';
  }

  function baaSourceOptionRows(spec) {
    var contract = baaContractForSpec(spec || defaultSpec());
    return (contract.objects || []).map(function (object, index) {
      var alias = object.alias || object.className || ('candidate' + String(index + 1));
      return {
        value: baaSourceClassName(alias),
        label: 'BAA: ' + baaObjectDisplayName(object),
        alias: alias,
        object: object
      };
    });
  }

  function renderObjectGroupSourceClassOptions(selectedName) {
    var options = renderClassOptions(selectedName);
    var baaOptions = baaSourceOptionRows(readCurrentSpec()).map(function (item) {
      return '<option value="' + escapeHtml(item.value || '') + '"' + (item.value === selectedName ? ' selected' : '') + '>' + escapeHtml(item.label || item.value || '') + '</option>';
    }).join('');
    if (isBaaSourceClassName(selectedName) && baaOptions.indexOf('value="' + escapeHtml(selectedName) + '"') === -1) {
      baaOptions = '<option value="' + escapeHtml(selectedName) + '" selected>BAA: ' + escapeHtml(baaAliasFromSourceClassName(selectedName)) + '</option>' + baaOptions;
    }
    return options + (baaOptions ? '<optgroup label="BAA payload">' + baaOptions + '</optgroup>' : '');
  }

  function baaScopePathOptionsForSource(spec, sourceClassName) {
    var alias = baaAliasFromSourceClassName(sourceClassName);
    var contract = baaContractForSpec(spec || defaultSpec());
    var object = (contract.objects || []).find(function (item) {
      return item && (item.alias === alias || item.className === alias);
    }) || {};
    var result = [];
    function add(value, label, type) {
      if (!value || result.some(function (item) { return item.value === value; })) return;
      result.push({ value: value, label: label || value, type: type || '' });
    }
    ['PlanIndex', 'Kind', 'ClassName', 'PageShapeKey', 'MappingKey', 'RelationBindingStatus'].forEach(function (column) {
      add(column, 'BAA.' + column, 'string');
    });
    (object.payload || []).forEach(function (field) {
      field = normalizeBaaFieldDefinition(field);
      if (!field.name) return;
      if (alias) add('BAA.' + alias + '.' + field.name, 'BAA.' + alias + '.' + field.name, field.type || '');
      if (object.className) add('BAA.' + object.className + '.' + field.name, 'BAA.' + object.className + '.' + field.name, field.type || '');
    });
    return result;
  }

  function renderDomainOptions(selectedName) {
    var domains = catalogDomains().slice().sort(function (left, right) {
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
    if (selectedName && !domains.some(function (item) { return item.name === selectedName; })) {
      domains.unshift({ name: selectedName });
    }
    return '<option value="">' + t('relationAnyDomain') + '</option>' + domains.map(function (item) {
      return '<option value="' + escapeHtml(item.name || '') + '"' + (item.name === selectedName ? ' selected' : '') + '>' + escapeHtml(item.name || '') + '</option>';
    }).join('');
  }

  function renderRelationDirectionOptions(selected) {
    var values = ['both', 'direct', 'inverse', 'source', 'destination'];
    return values.map(function (value) {
      return '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + value + '</option>';
    }).join('');
  }

  function firstResultTable(spec, alias) {
    var tables = spec && spec.result && Array.isArray(spec.result.tables) ? spec.result.tables : [];
    if (alias) {
      var byAlias = tables.find(function (table) { return table && table.name === alias; });
      if (byAlias) return byAlias;
    }
    return tables[0] || {};
  }

  function isRelationExpansionStep(step) {
    return step && step.type === 'expandRelations';
  }

  function getRelationExpansionStep(spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    return steps.find(isRelationExpansionStep) || {};
  }

  function isObjectMatchingStep(step) {
    return step && step.type === 'matchRows';
  }

  function getObjectMatchingSteps(spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    return steps.filter(isObjectMatchingStep);
  }

  function getObjectMatchingFinalStep(spec) {
    var steps = getObjectMatchingSteps(spec);
    return steps.length ? steps[steps.length - 1] : {};
  }

  function getStoredVisualModel(spec, mode) {
    if (!spec || !mode) return null;
    if (spec.visualModel && spec.visualModel.mode === mode) return spec.visualModel;
    var models = Array.isArray(spec.visualModels) ? spec.visualModels : [];
    return models.find(function (model) { return model && model.mode === mode; }) || null;
  }

  function upsertStoredVisualModel(spec, visualModel) {
    if (!visualModel || !visualModel.mode) return spec;
    var models = Array.isArray(spec.visualModels) ? spec.visualModels.slice() : [];
    var index = models.findIndex(function (model) { return model && model.mode === visualModel.mode; });
    if (index === -1) models.push(visualModel);
    else models[index] = visualModel;
    spec.visualModels = models;
    if (!spec.visualModel || spec.visualModel.mode === visualModel.mode) {
      spec.visualModel = visualModel;
    }
    return spec;
  }

  function matchingOperatorOptions() {
    return [
      { value: 'equals', label: t('matchingOperatorEquals') },
      { value: 'contains', label: t('matchingOperatorContains') },
      { value: 'regexMatch', label: t('matchingOperatorRegexMatch') },
      { value: 'ipv4InCidr', label: t('matchingOperatorIpv4InCidr') },
      { value: 'ipv4InRange', label: t('matchingOperatorIpv4InRange') },
      { value: 'ipv4CidrOverlaps', label: t('matchingOperatorIpv4CidrOverlaps') },
      { value: 'ipv4CidrContains', label: t('matchingOperatorIpv4CidrContains') }
    ];
  }

  function normalizeMatchingOperator(value) {
    var operator = String(value || 'equals').trim();
    if (operator === 'notEquals') return 'equals';
    return matchingOperatorOptions().some(function (item) { return item.value === operator; }) ? operator : 'equals';
  }

  function normalizeMatchingNegate(value, operator) {
    if (operator === 'notEquals') return true;
    if (value === true) return true;
    var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return text === 'true' || text === '1' || text === 'yes' || text === '!';
  }

  function renderMatchingOperatorOptions(selected) {
    selected = normalizeMatchingOperator(selected);
    return matchingOperatorOptions().map(function (item) {
      return '<option value="' + escapeHtml(item.value) + '"' + (item.value === selected ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>';
    }).join('');
  }

  function objectGroupOperatorOptions() {
    return [
      { value: 'exists', label: t('objectGroupOperatorExists') },
      { value: 'matches', label: t('objectGroupOperatorMatches') },
      { value: 'equals', label: t('objectGroupOperatorEquals') },
      { value: 'contains', label: t('objectGroupOperatorContains') },
      { value: 'startsWith', label: t('objectGroupOperatorStartsWith') },
      { value: 'endsWith', label: t('objectGroupOperatorEndsWith') },
      { value: 'isIpv4', label: t('objectGroupOperatorIsIpv4') },
      { value: 'isIpv4Network', label: t('objectGroupOperatorIsIpv4Network') },
      { value: 'ipv4InCidr', label: t('matchingOperatorIpv4InCidr') },
      { value: 'ipv4InRange', label: t('matchingOperatorIpv4InRange') },
      { value: 'ipv4CidrOverlaps', label: t('matchingOperatorIpv4CidrOverlaps') },
      { value: 'ipv4CidrContains', label: t('matchingOperatorIpv4CidrContains') }
    ];
  }

  function normalizeObjectGroupOperator(value) {
    var operator = String(value || 'matches').trim();
    if (operator === 'regexMatch') return 'matches';
    if (operator === 'notMatches') return 'matches';
    if (operator === 'notEquals') return 'equals';
    if (operator === 'notExists') return 'exists';
    return objectGroupOperatorOptions().some(function (item) { return item.value === operator; }) ? operator : 'matches';
  }

  function normalizeObjectGroupNegate(value, operator) {
    var rawOperator = String(operator || '').trim();
    if (rawOperator === 'notMatches' || rawOperator === 'notEquals' || rawOperator === 'notExists') return true;
    if (value === true) return true;
    var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return text === 'true' || text === '1' || text === 'yes' || text === '!';
  }

  function renderObjectGroupNegationOptions(selected, operator) {
    var isNegated = normalizeObjectGroupNegate(selected, operator);
    return [
      '<option value="false"' + (!isNegated ? ' selected' : '') + '>' + t('matchingNoNegation') + '</option>',
      '<option value="true"' + (isNegated ? ' selected' : '') + '>' + t('matchingNegated') + '</option>'
    ].join('');
  }

  function objectGroupOperatorUsesValue(operator) {
    var op = normalizeObjectGroupOperator(operator);
    return op !== 'exists' && op !== 'isIpv4' && op !== 'isIpv4Network';
  }

  function renderObjectGroupOperatorOptions(selected) {
    selected = normalizeObjectGroupOperator(selected);
    return objectGroupOperatorOptions().map(function (item) {
      return '<option value="' + escapeHtml(item.value) + '"' + (item.value === selected ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>';
    }).join('');
  }

  function renderMatchingNegationOptions(selected) {
    var isNegated = normalizeMatchingNegate(selected);
    return [
      '<option value="false"' + (!isNegated ? ' selected' : '') + '>' + t('matchingNoNegation') + '</option>',
      '<option value="true"' + (isNegated ? ' selected' : '') + '>' + t('matchingNegated') + '</option>'
    ].join('');
  }

  function normalizeMatchingRule(rule) {
    rule = rule || {};
    var left = rule.left && typeof rule.left === 'object' && !Array.isArray(rule.left) ? rule.left : {};
    var right = rule.right && typeof rule.right === 'object' && !Array.isArray(rule.right) ? rule.right : {};
    var rawOperator = rule.operator || rule.op || 'equals';
    return {
      action: rule.action === 'exclude' || rule.scope === 'exclude' ? 'exclude' : 'include',
      negate: normalizeMatchingNegate(rule.negate !== undefined ? rule.negate : rule.not, rawOperator),
      operator: normalizeMatchingOperator(rawOperator),
      leftColumn: String(rule.leftColumn || rule.leftField || left.column || left.field || left.path || '').trim(),
      leftRegex: String(rule.leftRegex !== undefined ? rule.leftRegex : (left.regex !== undefined ? left.regex : '')).trim(),
      rightColumn: String(rule.rightColumn || rule.rightField || right.column || right.field || right.path || '').trim(),
      rightRegex: String(rule.rightRegex !== undefined ? rule.rightRegex : (right.regex !== undefined ? right.regex : '')).trim()
    };
  }

  function defaultMatchingRule() {
    return {
      action: 'include',
      negate: false,
      operator: 'equals',
      leftColumn: 'Code',
      leftRegex: '',
      rightColumn: 'Code',
      rightRegex: ''
    };
  }

  function normalizeMatchingBlock(block, index, selections, previousAlias) {
    block = block || {};
    selections = Array.isArray(selections) ? selections : [];
    var baaSelection = selections.find(function (selection) { return selection && selection.alias === 'baaObjects'; }) || null;
    var firstCmdbSelection = selections.find(function (selection) { return selection && selection.alias !== 'baaObjects'; }) || null;
    var fallbackLeft = index === 0
      ? (baaSelection && baaSelection.alias || selections[0] && selections[0].alias || objectSelectionAlias(0))
      : previousAlias;
    var fallbackRight = index === 0 && fallbackLeft === 'baaObjects'
      ? (firstCmdbSelection && firstCmdbSelection.alias || objectSelectionAlias(0))
      : (selections[index + 1] && selections[index + 1].alias || selections[1] && selections[1].alias || objectSelectionAlias(index + 1));
    var alias = String(block.as || block.alias || block.outputAlias || ('matchedObjects' + String(index + 2))).trim();
    var rawRules = Array.isArray(block.rules || block.where) ? (block.rules || block.where) : [];
    var rules = rawRules.map(normalizeMatchingRule).filter(function (rule) {
      return rule.leftColumn || rule.rightColumn || rule.leftRegex || rule.rightRegex;
    });
    if (!rules.length) rules = [defaultMatchingRule()];
    return {
      from: String(block.from || block.leftAlias || fallbackLeft || '').trim(),
      with: String(block.with || block.rightAlias || fallbackRight || '').trim(),
      as: alias || ('matchedObjects' + String(index + 2)),
      rightPrefix: String(block.rightPrefix || objectSelectionOutputPrefixFromList(selections, String(block.with || block.rightAlias || fallbackRight || ''))).trim(),
      rules: rules
    };
  }

  function normalizeObjectMatchingModel(model, spec) {
    spec = spec || defaultSpec();
    var selections = matchingSelectionsForSpec(spec);
    if (selections.some(function (selection) { return selection && selection.alias === 'baaObjects'; })) {
      selections = selections.filter(function (selection) { return selection && selection.alias === 'baaObjects'; })
        .concat(selections.filter(function (selection) { return !selection || selection.alias !== 'baaObjects'; }));
    }
    var expectedBlocks = Math.max(0, selections.length - 1);
    var sourceBlocks = model && Array.isArray(model.blocks) ? model.blocks.slice() : [];
    var previousAlias = '';
    var blocks = [];
    for (var index = 0; index < expectedBlocks; index += 1) {
      var block = normalizeMatchingBlock(sourceBlocks[index], index, selections, previousAlias);
      if (index > 0) block.from = previousAlias;
      if (!block.rightPrefix) block.rightPrefix = objectSelectionOutputPrefixFromList(selections, block.with);
      blocks.push(block);
      previousAlias = block.as;
    }
    return {
      version: 1,
      mode: 'objectMatching',
      selections: selections,
      blocks: blocks,
      output: {
        alias: blocks.length ? blocks[blocks.length - 1].as : '',
        title: t('extractionFinalResult')
      }
    };
  }

  function inferRelationExpansionModel(spec) {
    if (state.relationDraft) return state.relationDraft;
    spec = spec || defaultSpec();
    var objectMatching = getStoredVisualModel(spec, 'objectMatching');
    if (objectMatching) return normalizeObjectMatchingModel(objectMatching, spec);

    var matchSteps = getObjectMatchingSteps(spec);
    if (matchSteps.length) {
      return normalizeObjectMatchingModel({
        blocks: matchSteps.map(function (step) {
          return {
            from: step.from,
            with: step.with,
            as: step.as,
            rightPrefix: step.rightPrefix,
            rules: step.rules
          };
        })
      }, spec);
    }

    var visual = spec.visualModel && spec.visualModel.mode === 'relationExpansion' ? spec.visualModel : null;
    if (visual) {
      return normalizeObjectMatchingModel(null, spec);
    }

    return normalizeObjectMatchingModel(null, spec);
  }

  function defaultObjectSelectionName(index) {
    return t('objectSelectionDefault', { number: index + 1 });
  }

  function objectSelectionAlias(index) {
    return index === 0 ? 'objects' : 'objects' + String(index + 1);
  }

  function objectSelectionIndexFromAlias(alias) {
    var text = String(alias || '').trim();
    if (text === 'objects') return 0;
    var match = /^objects(\d+)$/.exec(text);
    if (!match) return -1;
    var number = Number(match[1]);
    return Number.isFinite(number) && number > 0 ? number - 1 : -1;
  }

  function objectSelectionIndexFromList(selections, alias) {
    var text = String(alias || '').trim();
    var cmdbSelections = (Array.isArray(selections) ? selections : []).filter(function (selection) {
      return selection && selection.alias !== 'baaObjects' && selection.sourceType !== 'baa';
    });
    var index = cmdbSelections.findIndex(function (selection, itemIndex) {
      var selectionAlias = selection && (selection.alias || selection.as) || objectSelectionAlias(itemIndex);
      return selectionAlias === text;
    });
    if (index !== -1) return index;
    return objectSelectionIndexFromAlias(text);
  }

  function objectSelectionDisplayName(index) {
    return defaultObjectSelectionName(index < 0 ? 0 : index);
  }

  function objectSelectionDisplayNameForAlias(spec, alias) {
    var selections = objectSelectionsFromModel(inferObjectGroupModel(spec || defaultSpec()));
    var index = objectSelectionIndexFromList(selections, alias);
    return objectSelectionDisplayName(index);
  }

  function objectSelectionDisplayNameFromList(selections, alias) {
    return objectSelectionDisplayName(objectSelectionIndexFromList(selections, alias));
  }

  function objectSelectionOutputPrefix(spec, alias) {
    return objectSelectionDisplayNameForAlias(spec, alias) + '.';
  }

  function objectSelectionOutputPrefixFromList(selections, alias) {
    return objectSelectionDisplayNameFromList(selections, alias) + '.';
  }

  function formatObjectSelectionColumnLabel(spec, alias, field) {
    var text = String(field || '').trim();
    if (String(alias || '') === 'baaObjects') return 'BAA.' + (text || 'candidate');
    var prefix = objectSelectionDisplayNameForAlias(spec || defaultSpec(), alias);
    return prefix + (text ? '.' + text : '');
  }

  function baaCandidateSelection(spec) {
    if (!hasBaaInputSpec(spec || {})) return null;
    return {
      alias: 'baaObjects',
      name: 'BAA candidates',
      className: 'BAA',
      sourceType: 'baa',
      rules: []
    };
  }

  function matchingSelectionsForSpec(spec) {
    var selections = objectSelectionsFromModel(inferObjectGroupModel(spec || defaultSpec())).map(function (selection, index) {
      return normalizeObjectSelection(selection, index);
    });
    var baa = baaCandidateSelection(spec || {});
    if (baa && !selections.some(function (selection) { return selection.alias === baa.alias || selection.sourceType === 'baa'; })) selections.push(baa);
    return selections;
  }

  function stripKnownSelectionPrefix(spec, alias, field) {
    var text = String(field || '').trim();
    var selectionIndex = objectSelectionIndexFromAlias(alias);
    var selectionNumber = selectionIndex >= 0 ? selectionIndex + 1 : '';
    var prefixes = [
      String(alias || '') + '_',
      objectSelectionOutputPrefix(spec || defaultSpec(), alias),
      selectionNumber ? 'Выборка' + selectionNumber + '.' : '',
      selectionNumber ? 'Selection' + selectionNumber + '.' : ''
    ].filter(Boolean);
    for (var index = 0; index < prefixes.length; index += 1) {
      if (text.indexOf(prefixes[index]) === 0) return text.slice(prefixes[index].length);
    }
    return text;
  }

  function defaultObjectSelection(index, className) {
    return {
      name: defaultObjectSelectionName(index),
      alias: objectSelectionAlias(index),
      className: className || state.selectedClass || '',
      rules: [{ action: 'include', path: 'Code', regex: '.*' }]
    };
  }

  function normalizeObjectSelection(selection, index) {
    selection = selection || {};
    var rules = Array.isArray(selection.rules || selection.scopeRules) ? (selection.rules || selection.scopeRules) : [];
    var className = String(selection.className || selection.source && selection.source.className || '').trim();
    var baaObjectAlias = String(selection.baaObjectAlias || selection.source && selection.source.baaObjectAlias || baaAliasFromSourceClassName(className) || '').trim();
    var sourceType = selection.sourceType === 'baa' || selection.source && selection.source.type === 'baa' || isBaaSourceClassName(className) ? 'baa' : 'cmdb';
    if (sourceType === 'baa' && !className && baaObjectAlias) className = baaSourceClassName(baaObjectAlias);
    return {
      name: defaultObjectSelectionName(index),
      alias: String(selection.alias || selection.as || objectSelectionAlias(index)).trim() || objectSelectionAlias(index),
      className: className,
      sourceType: sourceType,
      baaObjectAlias: baaObjectAlias,
      rules: rules.length ? rules.map(function (rule) {
        return {
          action: rule && (rule.action === 'exclude' || rule.scope === 'exclude') ? 'exclude' : 'include',
          path: rule && (rule.path || rule.field || rule.attribute || rule.column) || '',
          negate: normalizeObjectGroupNegate(rule && (rule.negate !== undefined ? rule.negate : rule.not), rule && (rule.op || rule.operator)),
          op: normalizeObjectGroupOperator(rule && (rule.op || rule.operator || (rule.regex !== undefined ? 'matches' : 'matches'))),
          regex: rule && (rule.regex !== undefined ? rule.regex : (rule.value !== undefined ? rule.value : '.*')) || '.*'
        };
      }) : [{ action: 'include', path: 'Code', regex: '.*' }]
    };
  }

  function objectSelectionsFromModel(model) {
    var selections = model && Array.isArray(model.selections) ? model.selections : [];
    if (!selections.length && model) {
      selections = [{
        name: model.name || model.title || defaultObjectSelectionName(0),
        alias: model.alias || 'objects',
        className: model.className || '',
        rules: model.rules || model.scopeRules || []
      }];
    }
    if (!selections.length) selections = [defaultObjectSelection(0, '')];
    return selections.map(normalizeObjectSelection);
  }

  function inferObjectGroupModel(spec) {
    if (state.objectGroupDraft) return state.objectGroupDraft;
    spec = spec || defaultSpec();
    var visual = spec.visualModel && spec.visualModel.mode === 'objectGroup' ? spec.visualModel : null;
    if (visual) {
      if (Array.isArray(visual.selections) && visual.selections.length) {
        var visualSelections = visual.selections.map(function (selection, index) {
          return normalizeObjectSelection({
            name: selection.name || selection.title,
            alias: selection.alias || selection.as,
            className: selection.className || selection.source && selection.source.className,
            sourceType: selection.sourceType || selection.source && selection.source.type,
            baaObjectAlias: selection.baaObjectAlias || selection.source && selection.source.baaObjectAlias,
            rules: selection.scopeRules || selection.rules
          }, index);
        });
        return {
          selections: visualSelections,
          className: visualSelections[0] && visualSelections[0].className || '',
          rules: visualSelections[0] && visualSelections[0].rules || []
        };
      }
      var visualRules = Array.isArray(visual.scopeRules) ? visual.scopeRules : [];
      if (!visualRules.length && visual.source && Array.isArray(visual.source.match)) {
        visualRules = visual.source.match.map(function (item) {
          return {
            action: 'include',
            path: item.field || item.attribute || '',
            regex: item.param ? '$' + '{param.' + item.param + '}' : (item.regex || '.*')
          };
        });
      }
      return {
        selections: [normalizeObjectSelection({
          name: visual.output && visual.output.title || defaultObjectSelectionName(0),
          alias: visual.output && visual.output.alias || 'objects',
          className: visual.source && visual.source.className || '',
          rules: visualRules.length ? visualRules : [{ action: 'include', path: 'Code', regex: '.*' }]
        }, 0)],
        className: visual.source && visual.source.className || '',
        rules: visualRules.length ? visualRules : [{ action: 'include', path: 'Code', regex: '.*' }]
      };
    }

    var selection = getDataSelectionStep(spec);
    var filters = Array.isArray(selection.filters || selection.where) ? (selection.filters || selection.where) : [];
    var rules = filters.filter(function (filter) {
      return filter && (filter.regex !== undefined || filter.path);
    }).map(function (filter) {
      return {
        action: filter.scope === 'exclude' ? 'exclude' : 'include',
        path: filter.path || filter.attribute || filter.column || filter.field || '',
        negate: normalizeObjectGroupNegate(filter.negate !== undefined ? filter.negate : filter.not, filter.op),
        op: normalizeObjectGroupOperator(filter.op || (filter.regex !== undefined ? 'matches' : 'equals')),
        regex: filter.regex || '.*'
      };
    });
    var model = {
      className: selection.className || getSpecClassFallback(spec) || state.selectedClass || '',
      rules: rules.length ? rules : [{ action: 'include', path: 'Code', regex: '.*' }]
    };
    model.selections = [normalizeObjectSelection({
      name: defaultObjectSelectionName(0),
      alias: selection.as || 'objects',
      className: model.className,
      rules: model.rules
    }, 0)];
    return model;
  }

  function tableColumnsForAlias(spec, alias) {
    if (!alias) return [];
    var tables = spec && spec.result && Array.isArray(spec.result.tables) ? spec.result.tables : [];
    var table = tables.find(function (item) { return item && item.name === alias; }) || {};
    return Array.isArray(table && table.columns) ? table.columns.slice() : [];
  }

  function uniqueList(values) {
    var result = [];
    (values || []).forEach(function (value) {
      var text = String(value || '').trim();
      if (text && result.indexOf(text) === -1) result.push(text);
    });
    return result;
  }

  function objectSelectionLabel(selection, index) {
    if (selection && selection.sourceType === 'baa') return selection.name || ('BAA: ' + (selection.baaObjectAlias || baaAliasFromSourceClassName(selection.className) || 'candidates'));
    return objectSelectionDisplayName(index || 0);
  }

  function selectionOptionRows(spec, selectedName) {
    var selections = objectSelectionsFromModel(inferObjectGroupModel(spec || defaultSpec()));
    var baa = baaCandidateSelection(spec || {});
    if (baa && !selections.some(function (selection) { return selection.alias === baa.alias || selection.sourceType === 'baa'; })) selections.push(baa);
    if (selectedName && !selections.some(function (selection) { return selection.alias === selectedName; })) {
      selections.unshift({ alias: selectedName, name: selectedName, className: sourceClassForAlias(spec || {}, selectedName), rules: [] });
    }
    return selections.map(function (selection, index) {
      var alias = selection.alias || objectSelectionAlias(index);
      return {
        alias: alias,
        label: objectSelectionLabel(selection, index),
        className: selection.className || sourceClassForAlias(spec || {}, alias)
      };
    });
  }

  function renderSelectionAliasOptions(spec, selectedName) {
    return selectionOptionRows(spec, selectedName).map(function (item) {
      return '<option value="' + escapeHtml(item.alias || '') + '"' + (item.alias === selectedName ? ' selected' : '') + '>' + escapeHtml(item.label || item.alias || '') + '</option>';
    }).join('');
  }

  function matchingColumnOptionRowsForSelection(spec, alias, prefixed, outputPrefix) {
    if (String(alias || '') === 'baaObjects') {
      var baaItems = baaColumnOptionRows(spec || defaultSpec());
      var baaPrefix = prefixed ? (outputPrefix === undefined ? 'BAA.' : outputPrefix) : '';
      return baaItems.map(function (item) {
        return {
          value: baaPrefix + item.value,
          label: item.label
        };
      });
    }
    var rows = selectionOptionRows(spec, alias);
    var selection = rows.find(function (item) { return item.alias === alias; }) || {};
    var prefix = prefixed ? (outputPrefix === undefined ? objectSelectionOutputPrefix(spec || defaultSpec(), alias) : outputPrefix) : '';
    var items = [];
    var seen = {};
    function add(value, label) {
      var text = String(value || '').trim();
      if (!text) return;
      var effectiveValue = prefix + text;
      if (seen[effectiveValue]) return;
      seen[effectiveValue] = true;
      items.push({
        value: effectiveValue,
        label: formatObjectSelectionColumnLabel(spec || defaultSpec(), alias, label || text)
      });
    }
    ['Class', '_id', 'Code', 'Description'].forEach(function (column) { add(column, column); });
    tableColumnsForAlias(spec || {}, alias).forEach(function (column) { add(column, column); });
    catalogScopePathOptions(selection.className || sourceClassForAlias(spec || {}, alias)).filter(Boolean).forEach(function (item) {
      add(item.value, item.label || item.value);
    });
    return items;
  }

  function baaColumnOptionRows(spec) {
    var contract = baaContractForSpec(spec || {});
    var items = [];
    var seen = {};
    function add(value, label) {
      var text = String(value || '').trim();
      if (!text || seen[text]) return;
      seen[text] = true;
      items.push({ value: text, label: label || text });
    }
    ['PlanIndex', 'Kind', 'ClassName', 'PageShapeKey', 'MappingKey', 'RelationBindingStatus'].forEach(function (column) {
      add(column, 'BAA.' + column);
    });
    contract.objects.forEach(function (object) {
      var alias = object.alias || object.className || 'candidate';
      (object.payload || []).forEach(function (field) {
        var name = field && field.name || '';
        if (!name) return;
        add('BAA.' + alias + '.' + name, 'BAA.' + alias + '.' + name);
        if (object.className) add('BAA.' + object.className + '.' + name, 'BAA.' + object.className + '.' + name);
      });
    });
    return items;
  }

  function matchingColumnOptionRowsForOutput(spec, alias, seenAliases) {
    seenAliases = seenAliases || {};
    var name = String(alias || '').trim();
    if (!name || seenAliases[name]) return [];
    seenAliases[name] = true;
    var matchStep = getObjectMatchingSteps(spec || {}).find(function (step) {
      return step && step.as === name;
    });
    if (!matchStep) return matchingColumnOptionRowsForSelection(spec, name, false);
    var result = matchingColumnOptionRowsForOutput(spec, matchStep.from, seenAliases);
    var rightPrefix = matchStep.rightPrefix || objectSelectionOutputPrefix(spec || defaultSpec(), matchStep.with);
    matchingColumnOptionRowsForSelection(spec, matchStep.with, true, rightPrefix).filter(Boolean).forEach(function (item) {
      if (!result.some(function (existing) { return existing.value === item.value; })) result.push(item);
    });
    (Array.isArray(matchStep.rules || matchStep.where) ? (matchStep.rules || matchStep.where) : []).forEach(function (rule) {
      var normalized = normalizeMatchingRule(rule);
      [
        { value: normalized.leftColumn, label: normalized.leftColumn },
        { value: rightPrefix + normalized.rightColumn, label: formatObjectSelectionColumnLabel(spec || defaultSpec(), matchStep.with, normalized.rightColumn) }
      ].forEach(function (item) {
        if (item.value && !result.some(function (existing) { return existing.value === item.value; })) result.push(item);
      });
    });
    return result;
  }

  function renderMatchingColumnOptions(options, selectedName) {
    var items = Array.isArray(options) ? options.slice().filter(Boolean) : [];
    if (selectedName && !items.some(function (item) { return item.value === selectedName; })) {
      items.unshift({ value: selectedName, label: selectedName });
    }
    return '<option value=""></option>' + items.map(function (item) {
      return '<option value="' + escapeHtml(item.value || '') + '"' + (item.value === selectedName ? ' selected' : '') + '>' + escapeHtml(item.label || item.value || '') + '</option>';
    }).join('');
  }

  function matchingLeftColumnOptions(spec, model, blockIndex, block) {
    if (blockIndex === 0) return matchingColumnOptionRowsForSelection(spec, block.from, false);
    var blocks = model && Array.isArray(model.blocks) ? model.blocks : [];
    if (!blocks.length) return matchingColumnOptionRowsForOutput(spec, block.from);
    var first = blocks[0] || {};
    var result = matchingColumnOptionRowsForSelection(spec, first.from, false);
    for (var index = 0; index < blockIndex; index += 1) {
      var previousBlock = blocks[index] || {};
      var rightPrefix = previousBlock.rightPrefix || objectSelectionOutputPrefix(spec || defaultSpec(), previousBlock.with);
      matchingColumnOptionRowsForSelection(spec, previousBlock.with, true, rightPrefix).filter(Boolean).forEach(function (item) {
        if (!result.some(function (existing) { return existing.value === item.value; })) result.push(item);
      });
    }
    return result;
  }

  function matchingRightColumnOptions(spec, block) {
    return matchingColumnOptionRowsForSelection(spec, block.with, false);
  }

  function renderObjectGroupScopeRuleRow(rule, className) {
    rule = rule || {};
    var action = rule.action === 'exclude' ? 'exclude' : 'include';
    var operator = normalizeObjectGroupOperator(rule.op || rule.operator || (rule.regex !== undefined ? 'matches' : 'matches'));
    var negate = normalizeObjectGroupNegate(rule.negate !== undefined ? rule.negate : rule.not, rule.op || rule.operator);
    var valueDisabled = objectGroupOperatorUsesValue(operator) ? '' : ' disabled';
    return [
      '<tr data-object-scope-row>',
      '<td><select data-object-scope-field="action">',
      '<option value="include"' + (action === 'include' ? ' selected' : '') + '>' + t('objectGroupInclude') + '</option>',
      '<option value="exclude"' + (action === 'exclude' ? ' selected' : '') + '>' + t('objectGroupExclude') + '</option>',
      '</select></td>',
      '<td><select data-object-scope-field="path">' + renderScopePathOptions(className, rule.path || '') + '</select></td>',
      '<td><select data-object-scope-field="negate">' + renderObjectGroupNegationOptions(negate, operator) + '</select></td>',
      '<td><select data-object-scope-field="op">' + renderObjectGroupOperatorOptions(operator) + '</select></td>',
      '<td><input data-object-scope-field="regex" value="' + escapeHtml(rule.regex || '') + '" placeholder="' + escapeHtml('$' + '{param.name}') + '"' + valueDisabled + '></td>',
      '<td><button data-action="clear-object-scope-row">' + t('clear') + '</button></td>',
      '</tr>'
    ].join('');
  }

  function objectGroupDomainFilterOptions(className, selected, field) {
    var values = [];
    catalogScopePathOptions(className).forEach(function (item) {
      var value = String(item && item[field] || '').trim();
      if (value && values.indexOf(value) === -1) values.push(value);
    });
    values.sort();
    if (selected && values.indexOf(selected) === -1) values.unshift(selected);
    return '<option value=""></option>' + values.map(function (value) {
      return '<option value="' + escapeHtml(value) + '"' + (value === selected ? ' selected' : '') + '>' + escapeHtml(value) + '</option>';
    }).join('');
  }

  function renderObjectGroupDomainFilters(selection) {
    selection = selection || {};
    var className = selection.className || '';
    return [
      '<div class="settings-grid" data-object-path-filter style="margin:8px 0">',
      '<label>' + t('objectGroupDomainFilter') + '<select data-object-path-filter-field="domain">' + objectGroupDomainFilterOptions(className, selection.domainFilter || '', 'domain') + '</select></label>',
      '<label>' + t('objectGroupCardinalityFilter') + '<select data-object-path-filter-field="cardinality">' + objectGroupDomainFilterOptions(className, selection.cardinalityFilter || '', 'cardinality') + '</select></label>',
      '<label>' + t('objectGroupDirectionFilter') + '<select data-object-path-filter-field="direction">' + objectGroupDomainFilterOptions(className, selection.directionFilter || '', 'direction') + '</select></label>',
      '</div>'
    ].join('');
  }

  function renderObjectGroupDomainExamples() {
    return [
      '<details style="margin-top:12px;border-top:1px solid var(--line);padding-top:8px">',
      '<summary>' + t('objectGroupDomainExamples') + '</summary>',
      '<div class="muted" style="margin-top:8px">' + escapeHtml(t('objectGroupDomainExamplesHelp')) + '</div>',
      '<ul class="steps">',
      '<li>' + escapeHtml(t('objectGroupDomainExample1')) + '</li>',
      '<li>' + escapeHtml(t('objectGroupDomainExample2')) + '</li>',
      '<li>' + escapeHtml(t('objectGroupDomainExample3')) + '</li>',
      '</ul>',
      '</details>'
    ].join('');
  }

  function objectGroupRegexExamples() {
    var paramPrefix = '$' + '{param.prefix}';
    var paramSuffix = '$' + '{param.suffix}';
    if (state.language === 'ru') {
      return [
        { regex: '.*', meaning: 'Любое непустое значение.' },
        { regex: '^srv-', meaning: 'Значение начинается с srv-.' },
        { regex: '-prod$', meaning: 'Значение заканчивается на -prod.' },
        { regex: '[Rr]outer|[Ss]witch', meaning: 'Маршрутизатор или коммутатор в разных регистрах.' },
        { regex: '^\\d{1,3}(\\.\\d{1,3}){3}$', meaning: 'IPv4-похожее значение.' },
        { regex: '^10\\.20\\.', meaning: 'Адрес из сети 10.20.*.*.' },
        { regex: 'operator: is IP', meaning: 'Проверяет, что значение является одиночным IPv4, например 10.10.2.15.' },
        { regex: 'operator: is IP net', meaning: 'Проверяет CIDR/range/network, например 10.10.2.0/24 или 10.10.2.1-10.10.2.254.' },
        { regex: '!: exists', meaning: 'Отрицание оператора exists означает "не заполнено"; параметр не нужен.' },
        { regex: '^(dev|test|stage)-', meaning: 'Один из нескольких разрешенных префиксов.' },
        { regex: '\\b[A-Z]{2,4}-\\d{3,6}\\b', meaning: 'Инвентарный или сервисный код вида ABC-12345.' },
        { regex: '^(?!.*deprecated).*$', meaning: 'Значение без слова deprecated.' },
        { regex: '^' + paramPrefix + '.*' + paramSuffix + '$', meaning: 'Использование входных переменных в regex.' }
      ];
    }
    return [
      { regex: '.*', meaning: 'Any non-empty value.' },
      { regex: '^srv-', meaning: 'Value starts with srv-.' },
      { regex: '-prod$', meaning: 'Value ends with -prod.' },
      { regex: '[Rr]outer|[Ss]witch', meaning: 'Router or switch with simple case variants.' },
      { regex: '^\\d{1,3}(\\.\\d{1,3}){3}$', meaning: 'IPv4-like value.' },
      { regex: '^10\\.20\\.', meaning: 'Address from 10.20.*.*.' },
      { regex: 'operator: is IP', meaning: 'Checks that the value is a single IPv4 address, for example 10.10.2.15.' },
      { regex: 'operator: is IP net', meaning: 'Checks CIDR/range/network values, for example 10.10.2.0/24 or 10.10.2.1-10.10.2.254.' },
      { regex: '!: exists', meaning: 'Negating exists means "not filled"; no parameter is needed.' },
      { regex: '^(dev|test|stage)-', meaning: 'One of several allowed prefixes.' },
      { regex: '\\b[A-Z]{2,4}-\\d{3,6}\\b', meaning: 'Inventory or service code like ABC-12345.' },
      { regex: '^(?!.*deprecated).*$', meaning: 'Value without the word deprecated.' },
      { regex: '^' + paramPrefix + '.*' + paramSuffix + '$', meaning: 'Using input variables in regex.' }
    ];
  }

  function renderObjectGroupRegexExamples() {
    var rows = objectGroupRegexExamples().map(function (item) {
      return '<tr><td><span class="code-inline">' + escapeHtml(item.regex) + '</span></td><td>' + escapeHtml(item.meaning) + '</td></tr>';
    }).join('');
    return [
      '<details style="margin-top:12px;border-top:1px solid var(--line);padding-top:8px">',
      '<summary>' + t('objectGroupRegexExamples') + '</summary>',
      '<table class="compact" style="margin-top:8px"><thead><tr><th>' + t('objectGroupRegexExample') + '</th><th>' + t('objectGroupRegexMeaning') + '</th></tr></thead><tbody>',
      rows,
      '</tbody></table>',
      '</details>'
    ].join('');
  }

  function renderObjectGroupSelection(selection, index) {
    selection = normalizeObjectSelection(selection, index);
    var rules = selection.rules && selection.rules.length ? selection.rules : [{ action: 'include', path: 'Code', regex: '.*' }];
    var ruleRows = rules.map(function (rule) {
      return renderObjectGroupScopeRuleRow(rule, selection.className);
    }).join('');
    var classId = index === 0 ? ' id="cmdp-object-class"' : '';
    var rowsId = index === 0 ? ' id="cmdp-object-scope-rows"' : '';
    return [
      '<div class="object-selection" data-object-selection data-object-selection-index="' + index + '">',
      '<div class="row">',
      '<label>' + t('objectSelectionTitle') + '<input data-object-selection-field="name" value="' + escapeHtml(selection.name || defaultObjectSelectionName(index)) + '"></label>',
      '<label>' + t('objectGroupSourceClass') + '<select' + classId + ' data-object-selection-field="className">' + renderObjectGroupSourceClassOptions(selection.className) + '</select></label>',
      '</div>',
      '<div class="section-title-row"><h3>' + escapeHtml(selection.name || defaultObjectSelectionName(index)) + '</h3>',
      '<button data-action="add-object-scope-row">' + t('addObjectGroupRule') + '</button></div>',
      selection.sourceType === 'baa' ? '' : renderObjectGroupDomainFilters(selection),
      '<table class="compact"><thead><tr><th>' + t('objectGroupScopeAction') + '</th><th>' + t('objectGroupPath') + '</th><th>' + t('objectGroupNegation') + '</th><th>' + t('objectGroupOperator') + '</th><th>' + t('objectGroupValue') + '</th><th></th></tr></thead>',
      '<tbody' + rowsId + '>',
      ruleRows,
      '</tbody></table>',
      '<p class="muted">' + escapeHtml(t('objectGroupValueHelp')) + '</p>',
      '</div>'
    ].join('');
  }

  function renderBaaObjectGroupSource(spec) {
    if (!hasBaaInputSpec(spec || {})) return '';
    var contract = baaContractForSpec(spec || {});
    var objects = contract.objects || [];
    var rows = objects.map(function (object) {
      var fields = (object.payload || []).map(function (field) { return field && field.name || ''; }).filter(Boolean).join(', ');
      return '<tr><td><strong>' + escapeHtml(object.className || object.alias || '') + '</strong></td><td>' + escapeHtml(fields || '-') + '</td></tr>';
    }).join('');
    return [
      '<div class="object-selection">',
      '<div class="section-title-row"><h3>' + escapeHtml(t('baaObjectGroupSource')) + '</h3><span class="muted">BAA candidates / baaObjects</span></div>',
      '<p class="muted">' + escapeHtml(t('baaObjectGroupSourceHelp')) + '</p>',
      objects.length
        ? '<table class="compact"><thead><tr><th>' + escapeHtml(t('baaObjectClassName')) + '</th><th>' + escapeHtml(t('baaPayloadFields')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="notice">' + escapeHtml(t('baaContractNoObjects')) + '</div>',
      '</div>'
    ].join('');
  }

  function renderObjectGroupEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var model = inferObjectGroupModel(spec);
    var selections = objectSelectionsFromModel(model);
    return [
      '<section class="section" id="cmdp-object-group-editor"><h2>' + t('objectGroupEditor') + '</h2>',
      '<p class="muted">' + t('objectGroupHelp') + '</p>',
      renderBaaObjectGroupSource(spec),
      selections.map(renderObjectGroupSelection).join(''),
      renderObjectGroupDomainExamples(),
      renderObjectGroupRegexExamples(),
      '</section>'
    ].join('');
  }

  function renderMatchingIpv4Examples() {
    var rows = [
      ['ipv4InCidr(leftIp, rightCidr)', '10.10.2.15, 10.10.2.0/24', 'true'],
      ['ipv4InCidr(leftIp, rightCidr)', '10.10.3.15, 10.10.2.0/24', 'false'],
      ['ipv4InRange(leftIp, rightRange)', '10.10.2.15, 10.10.2.1-10.10.2.254', 'true'],
      ['ipv4InRange(leftIp, rightRange)', '10.10.2.255, 10.10.2.1-10.10.2.254', 'false'],
      ['ipv4CidrOverlaps(leftCidr, rightCidr)', '10.10.2.0/25, 10.10.2.64/26', 'true'],
      ['ipv4CidrOverlaps(leftCidr, rightCidr)', '10.10.2.0/25, 10.10.3.0/24', 'false'],
      ['ipv4CidrContains(leftCidr, rightCidr)', '10.10.2.0/24, 10.10.2.128/25', 'true'],
      ['ipv4CidrContains(leftCidr, rightCidr)', '10.10.2.0/24, 10.10.3.0/24', 'false']
    ];
    return [
      '<details class="matching-ipv4-examples">',
      '<summary>' + t('matchingIpv4ExamplesTitle') + '</summary>',
      '<table class="compact" style="margin-top:8px"><thead><tr><th>' + t('matchingExampleFunction') + '</th><th>' + t('matchingExampleInput') + '</th><th>' + t('matchingExampleResult') + '</th></tr></thead><tbody>',
      rows.map(function (row) {
        return '<tr><td><span class="code-inline">' + escapeHtml(row[0]) + '</span></td><td><span class="code-inline">' + escapeHtml(row[1]) + '</span></td><td><span class="code-inline">' + escapeHtml(row[2]) + '</span></td></tr>';
      }).join(''),
      '</tbody></table>',
      '</details>'
    ].join('');
  }

  function renderMatchingRuleRow(rule, leftOptions, rightOptions) {
    rule = normalizeMatchingRule(rule);
    var action = rule.action === 'exclude' ? 'exclude' : 'include';
    return [
      '<div class="matching-rule-card" data-matching-rule-row>',
      '<div class="matching-rule-head">',
      '<label>' + t('matchingRuleAction') + '<select data-matching-rule-field="action">',
      '<option value="include"' + (action === 'include' ? ' selected' : '') + '>' + t('objectGroupInclude') + '</option>',
      '<option value="exclude"' + (action === 'exclude' ? ' selected' : '') + '>' + t('objectGroupExclude') + '</option>',
      '</select></label>',
      '<button data-action="clear-matching-rule-row" type="button">' + t('clear') + '</button>',
      '</div>',
      '<div class="matching-rule-part">',
      '<strong>' + t('matchingLeftObject') + '</strong>',
      '<div class="matching-rule-fields">',
      '<label>' + t('matchingLeftAttribute') + '<select data-matching-rule-field="leftColumn">' + renderMatchingColumnOptions(leftOptions, rule.leftColumn) + '</select></label>',
      '<label>' + t('matchingLeftRegex') + '<input data-matching-rule-field="leftRegex" value="' + escapeHtml(rule.leftRegex || '') + '" placeholder="^(.*)$"></label>',
      '</div>',
      '</div>',
      '<div class="matching-rule-operator">',
      '<strong>' + t('matchingOperator') + '</strong>',
      '<div class="matching-rule-fields">',
      '<label>' + t('matchingNegation') + '<select data-matching-rule-field="negate">' + renderMatchingNegationOptions(rule.negate) + '</select></label>',
      '<label>' + t('matchingOperator') + '<select data-matching-rule-field="operator">' + renderMatchingOperatorOptions(rule.operator || 'equals') + '</select></label>',
      '</div>',
      '</div>',
      '<div class="matching-rule-part">',
      '<strong>' + t('matchingRightObject') + '</strong>',
      '<div class="matching-rule-fields">',
      '<label>' + t('matchingRightAttribute') + '<select data-matching-rule-field="rightColumn">' + renderMatchingColumnOptions(rightOptions, rule.rightColumn) + '</select></label>',
      '<label>' + t('matchingRightRegex') + '<input data-matching-rule-field="rightRegex" value="' + escapeHtml(rule.rightRegex || '') + '" placeholder="^(.*)$"></label>',
      '</div>',
      '</div>',
      '</div>'
    ].join('');
  }

  function renderObjectMatchingBlock(block, index, model, spec) {
    block = normalizeMatchingBlock(block, index, model.selections, index > 0 && model.blocks[index - 1] ? model.blocks[index - 1].as : '');
    var leftOptions = matchingLeftColumnOptions(spec, model, index, block);
    var rightOptions = matchingRightColumnOptions(spec, block);
    var rows = (block.rules && block.rules.length ? block.rules : [defaultMatchingRule()]).map(function (rule) {
      return renderMatchingRuleRow(rule, leftOptions, rightOptions);
    }).join('');
    var leftControl = index === 0
      ? '<label>' + t('matchingLeftSelection') + '<select data-matching-block-field="from">' + renderSelectionAliasOptions(spec, block.from) + '</select></label>'
      : '<label>' + t('matchingPreviousResult') + '<input data-matching-block-field="from" value="' + escapeHtml(block.from || '') + '" readonly></label>';
    return [
      '<div class="matching-block" data-matching-block data-matching-block-index="' + index + '">',
      '<div class="section-title-row"><h3>' + t('matchingBlock', { number: index + 1 }) + '</h3>',
      '<button data-action="add-matching-rule-row">' + t('addMatchingRule') + '</button></div>',
      '<div class="row">',
      leftControl,
      '<label>' + t('matchingRightSelection') + '<select data-matching-block-field="with">' + renderSelectionAliasOptions(spec, block.with) + '</select></label>',
      '<input type="hidden" data-matching-block-field="as" value="' + escapeHtml(block.as || ('matchedObjects' + String(index + 2))) + '">',
      '</div>',
      '<div class="matching-rule-list" data-matching-rule-list>',
      rows,
      '</div>',
      '<p class="muted">' + t('matchingRegexHelp') + '</p>',
      '<p class="muted">' + t('matchingIpv4Help') + '</p>',
      renderMatchingIpv4Examples(),
      '</div>'
    ].join('');
  }

  function renderRelationExpansionEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var model = inferRelationExpansionModel(spec);
    if (!model.selections || model.selections.length < 2) {
      return [
        '<section class="section" id="cmdp-relation-expansion-editor"><h2>' + t('relationEditor') + '</h2>',
        '<p class="muted">' + t('relationHelp') + '</p>',
        '<div class="notice">' + t('matchingNeedsSelections') + '</div>',
        '</section>'
      ].join('');
    }
    return [
      '<section class="section" id="cmdp-relation-expansion-editor"><h2>' + t('relationEditor') + '</h2>',
      '<p class="muted">' + t('relationHelp') + '</p>',
      model.blocks.map(function (block, index) { return renderObjectMatchingBlock(block, index, model, spec); }).join(''),
      '</section>'
    ].join('');
  }

  function renderDesignerMenu() {
    function group(title, links) {
      return '<div class="menu-group"><strong>' + escapeHtml(title) + '</strong><div class="menu-links">' +
        links.map(function (link) {
          var section = normalizeDesignerSection(link.section);
          var disabled = sectionDisabledForBaa(section);
          var classes = [];
          if (state.designerSection === section) classes.push('active');
          if (disabled) classes.push('disabled');
          var classAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
          var disabledAttrs = disabled ? ' aria-disabled="true" data-disabled="true" title="' + escapeHtml(t('baaSectionDisabled')) + '"' : '';
          return '<a' + classAttr + disabledAttrs + ' href="' + escapeHtml(designerSectionUrl(section)) + '" data-designer-section="' + escapeHtml(section) + '">' + escapeHtml(link.label) + '</a>';
        }).join('') + '</div></div>';
    }
    return [
      '<nav class="designer-menu" id="cmdp-designer-menu">',
      '<div class="menu-groups">',
      group(t('menuTemplates'), [
        { section: 'templates', label: t('menuTemplateList') },
        { section: 'versions', label: t('menuVersions') }
      ]),
      group(t('menuDesigner'), [
        { section: 'baa-endpoint', label: t('menuBaaEndpoint') },
        { section: 'params', label: t('menuParams') },
        { section: 'object-group', label: t('menuObjectGroup') },
        { section: 'relations', label: t('menuRelations') },
        { section: 'final-view', label: t('menuFinalView') },
        { section: 'cmdb-build-view', label: t('menuCmdbBuildView') }
      ]),
      group(t('menuRun'), [
        { section: 'extraction', label: t('menuExtraction') },
        { section: 'visualization', label: t('visualizationEditor') },
        { section: 'cache', label: t('cacheEditor') },
        { section: 'publication', label: t('menuPublication') },
        { section: 'run', label: t('menuTemplateRun') }
      ]),
      group(t('menuSettings'), [
        { section: 'schema', label: t('menuSchema') },
        { section: 'general-settings', label: t('menuGeneralSettings') },
        { section: 'settings', label: t('menuRuntimeSettings') }
      ]),
      group(t('menuHelp'), [
        { section: 'diagnostics', label: t('menuDiagnostics') }
      ]),
      group(t('menuAbout'), [
        { section: 'about', label: t('menuAbout') }
      ]),
      '</div></nav>'
    ].join('');
  }

  function renderNumberSetting(id, labelKey, helpKey, value, options) {
    options = options || {};
    var attrs = [
      'id="' + escapeHtml(id) + '"',
      'type="number"',
      'min="' + escapeHtml(options.min || 1) + '"',
      'step="' + escapeHtml(options.step || 1) + '"',
      'value="' + escapeHtml(value) + '"'
    ];
    if (options.max) attrs.push('max="' + escapeHtml(options.max) + '"');
    return '<label>' + t(labelKey) + '<input ' + attrs.join(' ') + '><span class="muted">' + escapeHtml(t(helpKey)) + '</span></label>';
  }

  function renderRuntimeCacheFields(runtimeCache) {
  return [
    '<div class="visual-grid">',
    renderNumberSetting('cmdp-runtime-refresh-cooldown-sec', 'runtimeRefreshCooldownSec', 'runtimeRefreshCooldownHelp', runtimeCache.refreshCooldownSec),
    '</div>'
  ].join('');
  }

  function renderBaaTechnicalFields(baaTechnical) {
    var defaults = defaultRuntimeConfig().baaTechnical;
    var cfg = Object.assign({}, defaults, baaTechnical || {});
    return [
      '<div class="settings-grid">',
      '<label>' + t('baaTechnicalSuperclassPath') + '<input id="cmdp-baa-superclass-path" value="' + escapeHtml(cfg.superclassPath || '') + '"><span class="muted">' + escapeHtml(t('baaTechnicalSuperclassPathHelp')) + '</span></label>',
      '<label>' + t('baaConversionContractClass') + '<input id="cmdp-baa-conversion-contract-class" value="' + escapeHtml(cfg.conversionContractClass || '') + '"></label>',
      '<label>' + t('baaConversionContractVersionClass') + '<input id="cmdp-baa-conversion-contract-version-class" value="' + escapeHtml(cfg.conversionContractVersionClass || '') + '"></label>',
      '<label>' + t('baaVerificationInputContractClass') + '<input id="cmdp-baa-verification-input-contract-class" value="' + escapeHtml(cfg.verificationInputContractClass || '') + '"></label>',
      '<label>' + t('baaVerificationOutputContractClass') + '<input id="cmdp-baa-verification-output-contract-class" value="' + escapeHtml(cfg.verificationOutputContractClass || '') + '"></label>',
      '<label>' + t('baaVerificationEndpointClass') + '<input id="cmdp-baa-verification-endpoint-class" value="' + escapeHtml(cfg.verificationEndpointClass || '') + '"></label>',
      '</div>'
    ].join('');
  }

  function renderExecutionLimitFields(executionLimits) {
    return [
      '<div class="visual-grid">',
      renderNumberSetting('cmdp-runtime-max-rows-default', 'runtimeMaxRowsDefault', 'runtimeMaxRowsDefaultHelp', executionLimits.maxRowsDefault, { max: 2000 }),
      renderNumberSetting('cmdp-runtime-max-rows-preview-default', 'runtimeMaxRowsPreviewDefault', 'runtimeMaxRowsPreviewDefaultHelp', executionLimits.maxRowsPreviewDefault, { max: 2000 }),
      renderNumberSetting('cmdp-runtime-max-rows-max', 'runtimeMaxRowsMax', 'runtimeMaxRowsMaxHelp', executionLimits.maxRowsMax, { max: 2000 }),
      renderNumberSetting('cmdp-runtime-max-classes-default', 'runtimeMaxClassesDefault', 'runtimeMaxClassesDefaultHelp', executionLimits.maxClassesDefault, { max: 500 }),
      renderNumberSetting('cmdp-runtime-max-classes-max', 'runtimeMaxClassesMax', 'runtimeMaxClassesMaxHelp', executionLimits.maxClassesMax, { max: 500 }),
      renderNumberSetting('cmdp-runtime-max-domains-default', 'runtimeMaxDomainsDefault', 'runtimeMaxDomainsDefaultHelp', executionLimits.maxDomainsDefault, { max: 500 }),
      renderNumberSetting('cmdp-runtime-max-domains-max', 'runtimeMaxDomainsMax', 'runtimeMaxDomainsMaxHelp', executionLimits.maxDomainsMax, { max: 500 }),
      renderNumberSetting('cmdp-runtime-max-rest-calls-default', 'runtimeMaxRestCallsDefault', 'runtimeMaxRestCallsDefaultHelp', executionLimits.maxRestCallsDefault, { max: 1000 }),
      renderNumberSetting('cmdp-runtime-max-rest-calls-max', 'runtimeMaxRestCallsMax', 'runtimeMaxRestCallsMaxHelp', executionLimits.maxRestCallsMax, { max: 1000 }),
      renderNumberSetting('cmdp-runtime-max-traversal-depth-default', 'runtimeMaxTraversalDepthDefault', 'runtimeMaxTraversalDepthDefaultHelp', executionLimits.maxTraversalDepthDefault, { max: 5 }),
      renderNumberSetting('cmdp-runtime-max-traversal-depth-max', 'runtimeMaxTraversalDepthMax', 'runtimeMaxTraversalDepthMaxHelp', executionLimits.maxTraversalDepthMax, { max: 5 }),
      '</div>'
    ].join('');
  }

  function schemaFieldValue(name, fallback) {
    if (hasField(name)) return readValue(name);
    return fallback;
  }

  function currentSchemaRoot() {
    return String(state.schemaRootDraft || state.root || (state.schema && state.schema.root) || 'Cst_QueryTool').trim() || 'Cst_QueryTool';
  }

  function currentSchemaDescription() {
    return String(state.schemaDescriptionDraft || (state.schema && state.schema.rootDescription) || 'CMDB Dynamic Pages technical root').trim();
  }

  function currentSchemaParent() {
    return String(state.schemaParentDraft || (state.schema && state.schema.rootParent) || 'Class').trim() || 'Class';
  }

  function readSchemaClassDraftsFromDom() {
    var drafts = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-schema-class-role]'), function (row) {
      var role = row.getAttribute('data-schema-class-role') || '';
      if (!role) return;
      var nameField = row.querySelector('[data-schema-class-name]');
      var descriptionField = row.querySelector('[data-schema-class-description]');
      drafts[role] = {
        name: nameField ? nameField.value.trim() : '',
        description: descriptionField ? descriptionField.value.trim() : ''
      };
    });
    return drafts;
  }

  function schemaClassDraftsFromPlan(schema) {
    var drafts = {};
    (Array.isArray(schema && schema.classes) ? schema.classes : []).forEach(function (item) {
      var role = item.role || item.schemaRole || '';
      if (!role) return;
      drafts[role] = {
        name: item.name || '',
        description: item.description || item.name || ''
      };
    });
    return drafts;
  }

  function currentSchemaClassDrafts(schema) {
    var defaults = schemaClassDraftsFromPlan(schema);
    var drafts = state.schemaClassDrafts || {};
    Object.keys(drafts).forEach(function (role) {
      defaults[role] = {
        name: drafts[role] && drafts[role].name || defaults[role] && defaults[role].name || '',
        description: drafts[role] && drafts[role].description || defaults[role] && defaults[role].description || drafts[role] && drafts[role].name || ''
      };
    });
    return defaults;
  }

  function schemaClassOverridesPayload(schema) {
    var drafts = currentSchemaClassDrafts(schema);
    return Object.keys(drafts).map(function (role) {
      return {
        role: role,
        name: drafts[role].name,
        description: drafts[role].description || drafts[role].name
      };
    });
  }

  function parentOptionsHtml(selected) {
    var parents = Array.isArray(state.schemaParents) ? state.schemaParents : [];
    var names = ['Class'].concat(parents.map(function (item) { return item && item.name; }).filter(Boolean));
    var unique = [];
    names.forEach(function (name) {
      if (unique.indexOf(name) === -1) unique.push(name);
    });
    return unique.map(function (name) {
      return '<option value="' + escapeHtml(name) + '"' + (name === selected ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
    }).join('');
  }

  function renderSchemaActionStatus(item) {
    if (!item) return '';
    if (item.created || item.action === 'created') return t('schemaActionCreated');
    if (item.exists) return t('schemaActionNone');
    return t('schemaActionCreate');
  }

  function renderSchemaClassRows(schema) {
    var rows = Array.isArray(schema && schema.classes) ? schema.classes : [];
    if (!rows.length) return '<tr><td colspan="5">' + t('noData') + '</td></tr>';
    var drafts = currentSchemaClassDrafts(schema);
    return rows.map(function (item) {
      var role = item.role || item.schemaRole || '';
      var draft = drafts[role] || { name: item.name || '', description: item.description || item.name || '' };
      return [
        '<tr data-schema-class-role="' + escapeHtml(role) + '">',
        '<td><input data-schema-class-name value="' + escapeHtml(draft.name || '') + '"></td>',
        '<td><input data-schema-class-description value="' + escapeHtml(draft.description || draft.name || '') + '"></td>',
        '<td>' + escapeHtml(item.parent || '') + '</td>',
        '<td>' + escapeHtml(item.prototype ? 'prototype' : 'standard') + '</td>',
        '<td>' + escapeHtml(renderSchemaActionStatus(item)) + '</td>',
        '</tr>'
      ].join('');
    }).join('');
  }

  function renderSchemaAttributeRows(schema) {
    var rows = [];
    (Array.isArray(schema && schema.classes) ? schema.classes : []).forEach(function (classItem) {
      (Array.isArray(classItem.attributes) ? classItem.attributes : []).forEach(function (attribute) {
        rows.push({ className: classItem.name, attribute: attribute });
      });
    });
    if (!rows.length) return '<tr><td colspan="4">' + t('noData') + '</td></tr>';
    return rows.map(function (item) {
      return '<tr><td>' + escapeHtml(item.className) + '</td><td>' + escapeHtml(item.attribute.name) + '</td><td>' + escapeHtml(item.attribute.type || '') + '</td><td>' + escapeHtml(renderSchemaActionStatus(item.attribute)) + '</td></tr>';
    }).join('');
  }

  function renderSchemaConflicts(schema) {
    var conflicts = Array.isArray(schema && schema.conflicts) ? schema.conflicts : [];
    if (!conflicts.length) return '<div class="notice ok">' + t('schemaNoConflicts') + '</div>';
    return [
      '<table class="compact"><thead><tr><th>' + t('schemaObjects') + '</th><th>Field</th><th>Expected</th><th>Actual</th><th>Reason</th></tr></thead><tbody>',
      conflicts.map(function (item) {
        var objectName = item.type === 'attribute' ? item.className + '.' + item.name : item.name;
        return '<tr><td>' + escapeHtml(objectName || '') + '</td><td>' + escapeHtml(item.field || '') + '</td><td>' + escapeHtml(item.expected) + '</td><td>' + escapeHtml(item.actual) + '</td><td>' + escapeHtml(item.reason || '') + '</td></tr>';
      }).join(''),
      '</tbody></table>'
    ].join('');
  }

  function renderSchemaPlanSummary(schema) {
    var summary = schema && schema.summary || {};
    return [
      '<div class="kpis">',
      '<div class="kpi"><span>Classes</span><strong>' + escapeHtml(summary.classCount || 0) + '</strong></div>',
      '<div class="kpi"><span>Attributes</span><strong>' + escapeHtml(summary.attributeCount || 0) + '</strong></div>',
      '<div class="kpi"><span>Creates</span><strong>' + escapeHtml(summary.plannedCreates || 0) + '</strong></div>',
      '<div class="kpi"><span>Conflicts</span><strong>' + escapeHtml(summary.conflicts || 0) + '</strong></div>',
      '</div>'
    ].join('');
  }

  function renderSchemaManager() {
    var schema = state.schemaPlan || state.schema || {};
    var root = currentSchemaRoot();
    var description = currentSchemaDescription();
    var parent = currentSchemaParent();
    var needsBootstrap = !(schema && schema.ready);
    return [
      '<section class="section" id="cmdp-schema-manager"><h2>' + t('menuSchema') + '</h2>',
      '<p class="muted">' + t('schemaRootHelp') + '</p>',
      renderSchemaStatus(schema),
      '<div class="form">',
      '<div class="visual-grid">',
      '<label>' + t('schemaRootName') + '<input id="cmdp-root" value="' + escapeHtml(root) + '"><span class="muted">' + t('schemaRootHelp') + '</span></label>',
      '<label>' + t('schemaRootDescription') + '<input id="cmdp-schema-description" value="' + escapeHtml(description) + '"></label>',
      '<label>' + t('schemaParent') + '<input id="cmdp-schema-parent" list="cmdp-schema-parent-list" value="' + escapeHtml(parent) + '"><datalist id="cmdp-schema-parent-list">' + parentOptionsHtml(parent) + '</datalist><span class="muted">' + t('schemaParentHelp') + '</span></label>',
      '</div>',
      state.schemaParents.length ? '' : '<p class="muted">' + t('schemaNoParents') + '</p>',
      needsBootstrap ? '<label class="checkbox checkbox-stacked"><input type="checkbox" id="cmdp-schema-confirm"><span><strong>' + t('schemaConfirmBootstrap') + '</strong><span class="muted">' + t('schemaConflictHelp') + '</span></span></label>' : '',
      '</div>',
      '<h3>' + t('schemaPlan') + '</h3>',
      renderSchemaPlanSummary(schema),
      '<h3>' + t('schemaObjects') + '</h3>',
      '<table class="compact"><thead><tr><th>' + t('code') + '</th><th>' + t('description') + '</th><th>' + t('schemaParent') + '</th><th>Type</th><th>Status</th></tr></thead><tbody>',
      renderSchemaClassRows(schema),
      '</tbody></table>',
      '<h3>Attributes</h3>',
      '<table class="compact"><thead><tr><th>Class</th><th>' + t('code') + '</th><th>Type</th><th>Status</th></tr></thead><tbody>',
      renderSchemaAttributeRows(schema),
      '</tbody></table>',
      '<h3>' + t('schemaConflicts') + '</h3>',
      renderSchemaConflicts(schema),
      '</section>'
    ].join('');
  }

  function renderRuntimeSettings(config) {
    config = config || { runtimeConfig: defaultRuntimeConfig(), exists: false };
    var runtimeConfig = normalizeRuntimeConfigForEditor(config.runtimeConfig || defaultRuntimeConfig());
    var runtimeCache = runtimeConfig.runtimeCache || defaultRuntimeConfig().runtimeCache;
    var baaTechnical = runtimeConfig.baaTechnical || defaultRuntimeConfig().baaTechnical;
    var executionLimits = runtimeConfig.executionLimits || defaultRuntimeConfig().executionLimits;
    return [
      '<section class="section" id="cmdp-runtime-settings"><h2>' + t('runtimeSettings') + '</h2>',
      '<span class="pill ' + (config.exists ? 'ok' : '') + '">' + (config.exists ? t('configCard') : t('defaultConfig')) + '</span>',
      '<div class="form">',
      '<h3>' + t('runtimeCacheSettings') + '</h3>',
      renderRuntimeCacheFields(runtimeCache),
      '<h3>' + t('runtimeExecutionLimits') + '</h3>',
      renderExecutionLimitFields(executionLimits),
      '</div>',
      '</section>'
    ].join('');
  }

  function renderGeneralSettings() {
    var config = state.config || { runtimeConfig: defaultRuntimeConfig(), exists: false };
    var runtimeConfig = normalizeRuntimeConfigForEditor(config.runtimeConfig || defaultRuntimeConfig());
    var runtimeCache = runtimeConfig.runtimeCache || defaultRuntimeConfig().runtimeCache;
    return [
      '<section class="section" id="cmdp-general-settings"><h2>' + t('generalSettings') + '</h2>',
      '<p class="muted">' + t('maxDepthHelp') + '</p>',
      '<div class="form">',
      '<label>' + t('maxDepth') + '<select id="cmdp-max-depth">',
      [1, 2, 3, 4, 5].map(function (value) {
        return '<option value="' + value + '"' + (Number(state.maxTraversalDepth) === value ? ' selected' : '') + '>' + value + '</option>';
      }).join(''),
      '</select></label>',
      '<h3>' + t('runtimeCacheSettings') + '</h3>',
      renderRuntimeCacheFields(runtimeCache),
      '<h3>' + t('baaTechnicalSettings') + '</h3>',
      renderBaaTechnicalFields(baaTechnical),
      '</div>',
      '</section>'
    ].join('');
  }

  function renderTemplateList(templateRows) {
    return [
      '<section class="section" id="cmdp-template-list"><h2>' + t('templates') + '</h2>',
      '<table class="compact"><thead><tr><th>' + t('code') + '</th><th>' + t('description') + '</th><th>' + t('active') + '</th><th></th></tr></thead><tbody>',
      templateRows || '<tr><td colspan="4">' + t('noTemplates') + '</td></tr>',
      '</tbody></table>',
      '</section>'
    ].join('');
  }

  function renderTemplateCopySelector(selected) {
    if (selected && selected.id) return '';
    var copySourceCode = selected && selected.copySourceCode ? selected.copySourceCode : '';
    var options = state.templates.map(function (template) {
      var label = template.code + (template.description ? ' - ' + template.description : '');
      return '<option value="' + escapeHtml(template.code) + '"' + (copySourceCode === template.code ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
    var disabled = options ? '' : ' disabled';
    return [
      '<label>' + t('copyFromTemplate') + '<select id="cmdp-copy-template-source"' + disabled + '>',
      '<option value="">' + t(options ? 'doNotCopy' : 'noTemplateToCopy') + '</option>',
      options,
      '</select></label>',
      '<p class="muted">' + t('copyFromTemplateHelp') + '</p>'
    ].join('');
  }

  function renderTemplateEditor(selected) {
    var kind = templateKindForSpec((selected && selected.spec) || defaultSpec());
    var protectedHelp = selected && selected.protected ? '<p class="muted">' + escapeHtml(t('protectedTemplateHelp')) + '</p>' : '';
    return [
      '<section class="section" id="cmdp-template-editor"><h2>' + t('creatingTemplate') + '</h2>',
      '<p class="muted">' + t('templateCreateHelp') + '</p>',
      '<div class="form">',
      renderTemplateCopySelector(selected),
      '<label>' + t('templateKind') + '<select id="cmdp-template-kind">',
      '<option value="dsl"' + (kind === 'dsl' ? ' selected' : '') + '>' + t('templateKindDsl') + '</option>',
      '<option value="' + CMDB_BUILD_VIEW_KIND + '"' + (kind === CMDB_BUILD_VIEW_KIND ? ' selected' : '') + '>' + t('templateKindCmdbBuildView') + '</option>',
      '</select><span class="muted">' + escapeHtml(t('templateKindHelp')) + '</span></label>',
      '<label>' + t('code') + '<input id="cmdp-code" value="' + escapeHtml(selected.code || '') + '"' + (selected.id ? ' readonly' : '') + '></label>',
      '<label>' + t('description') + '<input id="cmdp-description" value="' + escapeHtml(selected.description || '') + '"></label>',
      selected && selected.protected ? '<span class="pill">' + escapeHtml(t('protectedTemplate')) + '</span>' : '',
      protectedHelp,
      '</div>',
      '</section>'
    ].join('');
  }

  function cmdbBuildViewModelForSpec(spec) {
    var source = spec && spec.cmdbBuildView && typeof spec.cmdbBuildView === 'object' && !Array.isArray(spec.cmdbBuildView)
      ? spec.cmdbBuildView
      : {};
    var sections = Array.isArray(source.sections) && source.sections.length ? source.sections : ['classes', 'domains', 'lookups'];
    return {
      language: source.language || 'auto',
      showSystemAttributes: Boolean(source.showSystemAttributes),
      rootClass: source.rootClass || '',
      lookupScope: source.lookupScope === 'all' ? 'all' : 'used',
      sections: sections
    };
  }

  function renderCmdbBuildViewEditor(selected) {
    var spec = (selected && selected.spec) || defaultCmdbBuildViewSpecClient();
    var model = cmdbBuildViewModelForSpec(spec);
    function checked(section) {
      return model.sections.indexOf(section) !== -1 ? ' checked' : '';
    }
    return [
      '<section class="section" id="cmdp-cmdb-build-view-editor"><h2>' + t('cmdbBuildViewEditor') + '</h2>',
      '<p class="muted">' + t('cmdbBuildViewHelp') + '</p>',
      '<div class="settings-block"><h3>' + t('cmdbBuildViewSections') + '</h3>',
      '<div class="checkbox-list">',
      '<label class="checkbox"><input data-cmdb-build-section="classes" type="checkbox"' + checked('classes') + '> ' + t('cmdbBuildViewClasses') + '</label>',
      '<label class="checkbox"><input data-cmdb-build-section="domains" type="checkbox"' + checked('domains') + '> ' + t('cmdbBuildViewDomains') + '</label>',
      '<label class="checkbox"><input data-cmdb-build-section="lookups" type="checkbox"' + checked('lookups') + '> ' + t('cmdbBuildViewLookups') + '</label>',
      '</div></div>',
      '<div class="settings-block"><h3>' + t('generalSettings') + '</h3>',
      '<div class="settings-grid">',
      '<label>' + t('cmdbBuildViewLanguage') + '<select id="cmdp-cmdb-build-language">',
      '<option value="auto"' + (model.language === 'auto' ? ' selected' : '') + '>' + t('cmdbBuildViewLanguageAuto') + '</option>',
      '<option value="ru"' + (model.language === 'ru' ? ' selected' : '') + '>ru</option>',
      '<option value="en"' + (model.language === 'en' ? ' selected' : '') + '>en</option>',
      '</select></label>',
      '<label>' + t('cmdbBuildViewRootClass') + '<input id="cmdp-cmdb-build-root-class" value="' + escapeHtml(model.rootClass || '') + '"><span class="muted">' + escapeHtml(t('cmdbBuildViewRootClassHelp')) + '</span></label>',
      '<label>' + t('cmdbBuildViewLookupScope') + '<select id="cmdp-cmdb-build-lookup-scope">',
      '<option value="used"' + (model.lookupScope === 'used' ? ' selected' : '') + '>' + t('cmdbBuildViewLookupUsed') + '</option>',
      '<option value="all"' + (model.lookupScope === 'all' ? ' selected' : '') + '>' + t('cmdbBuildViewLookupAll') + '</option>',
      '</select></label>',
      '<label class="checkbox"><input id="cmdp-cmdb-build-system-attributes" type="checkbox" ' + (model.showSystemAttributes ? 'checked' : '') + '> ' + t('cmdbBuildViewSystemAttributes') + '</label>',
      '</div></div>',
      '</section>'
    ].join('');
  }

  function renderTemplateContext(selected) {
    if (!selected || (!selected.code && state.designerSection !== 'template')) return '';
    if (state.designerSection === 'template' && !selected.id && !selected.code) {
      return '<div class="template-context" id="cmdp-template-context"><strong>' + t('creatingTemplate') + '</strong></div>';
    }
    var description = selected.description ? ' - ' + selected.description : '';
    return '<div class="template-context" id="cmdp-template-context"><strong>' + t('editingTemplate') + '</strong><span class="code-inline">' + escapeHtml(selected.code || '') + '</span>' + escapeHtml(description) + '</div>';
  }

  function isBaaVerificationSpec(spec) {
    return Boolean(spec && spec.endpoint && spec.endpoint.kind === 'baaVerification');
  }

  function selectedTemplateIsBaa(selected) {
    var template = selected || state.selectedTemplate || {};
    return isBaaVerificationSpec(template.spec || {});
  }

  function sectionDisabledForBaa(section, selected) {
    if (!selectedTemplateIsBaa(selected)) return false;
    return ['visualization', 'publication'].indexOf(normalizeDesignerSection(section)) !== -1;
  }

  function renderBaaDisabledSection() {
    return '<section class="section"><div class="notice">' + escapeHtml(t('baaSectionDisabled')) + '</div></section>';
  }

  function hasBaaInputSpec(spec) {
    if (isBaaVerificationSpec(spec || {})) return true;
    var contract = spec && spec.baaContract && typeof spec.baaContract === 'object' && !Array.isArray(spec.baaContract) ? spec.baaContract : null;
    if (!contract) return false;
    return Boolean(contract.sourceCode || contract.code || (Array.isArray(contract.objects) && contract.objects.length) || (Array.isArray(contract.classes) && contract.classes.length));
  }

  function addUniqueString(list, value) {
    var text = String(value || '').trim();
    if (text && list.indexOf(text) === -1) list.push(text);
  }

  function collectBaaSourceAliasesForMissingInputs(spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    var produced = {};
    steps.forEach(function (step) {
      if (step && step.as) produced[step.as] = true;
    });
    var aliases = [];
    steps.forEach(function (step) {
      if (!step || typeof step !== 'object') return;
      if (step.type === 'enrichRows' && step.from && !produced[step.from]) addUniqueString(aliases, step.from);
      if (step.type === 'matchRows') {
        if (step.from && !produced[step.from]) addUniqueString(aliases, step.from);
        if (step.with && !produced[step.with]) addUniqueString(aliases, step.with);
      }
    });
    var visual = getStoredVisualModel(spec || {}, 'viewComposer');
    var sourceAlias = visual && (visual.sourceAlias || visual.source && visual.source.alias) || '';
    if (sourceAlias && !produced[sourceAlias]) addUniqueString(aliases, sourceAlias);
    if (!steps.length && !steps.some(function (step) { return step && step.type === 'baaPlanObjects'; }) && !aliases.length) aliases.push('baaObjects');
    return aliases;
  }

  function ensureBaaPlanObjectSourceSteps(spec) {
    if (!isBaaVerificationSpec(spec || {})) return spec;
    var next = cloneJsonValue(spec || defaultSpec(), defaultSpec());
    var steps = Array.isArray(next.steps) ? next.steps.slice() : [];
    var existing = {};
    steps.forEach(function (step) {
      if (step && step.type === 'baaPlanObjects' && step.as) existing[step.as] = true;
    });
    collectBaaSourceAliasesForMissingInputs(Object.assign({}, next, { steps: steps })).filter(function (alias) {
      return !existing[alias];
    }).reverse().forEach(function (alias) {
      steps.unshift({ type: 'baaPlanObjects', as: alias, payloadPrefix: 'Payload.' });
    });
    next.steps = steps;
    return next;
  }

  function baaContractForSpec(spec) {
    var contract = spec && spec.baaContract && typeof spec.baaContract === 'object' && !Array.isArray(spec.baaContract) ? spec.baaContract : {};
    var variables = Array.isArray(contract.contractParams)
      ? contract.contractParams
      : (Array.isArray(contract.variables) ? contract.variables : []);
    var requestVariables = Array.isArray(contract.requestVariables) ? contract.requestVariables : [];
    var objects = Array.isArray(contract.objects)
      ? contract.objects
      : (Array.isArray(contract.candidates) ? contract.candidates : (Array.isArray(contract.classes) ? contract.classes : []));
    return {
      code: String(contract.code || '').trim(),
      version: String(contract.version || '').trim(),
      description: String(contract.description || '').trim(),
      variables: variables.map(normalizeBaaFieldDefinition).filter(function (field) { return field.name; }),
      contractParams: variables.map(normalizeBaaFieldDefinition).filter(function (field) { return field.name; }),
      requestVariables: requestVariables.map(normalizeBaaFieldDefinition).filter(function (field) { return field.name; }),
      objects: objects.map(function (object, index) {
        var payload = Array.isArray(object && object.payload)
          ? object.payload
          : (Array.isArray(object && object.fields) ? object.fields : (Array.isArray(object && object.attributes) ? object.attributes : []));
        var className = String(object && (object.className || object.class || object.name) || '').trim();
        return {
          alias: String(object && object.alias || object && object.as || className || ('candidate' + String(index + 1))).trim(),
          className: className,
          description: String(object && object.description || '').trim(),
          payload: payload.map(normalizeBaaFieldDefinition).filter(function (field) { return field.name; })
        };
      }).filter(function (object) { return object.alias || object.className || object.payload.length; })
    };
  }

  function normalizeBaaFieldDefinition(field) {
    field = field && typeof field === 'object' && !Array.isArray(field) ? field : {};
    return {
      name: String(field.name || field.field || '').trim(),
      type: String(field.type || 'string').trim() || 'string',
      required: Boolean(field.required || field.mandatory),
      defaultValue: field.default !== undefined ? field.default : (field.defaultValue !== undefined ? field.defaultValue : ''),
      example: field.example !== undefined ? field.example : '',
      description: String(field.description || field.help || '').trim(),
      listMode: String(field.listMode || 'none').trim() || 'none',
      values: Array.isArray(field.values) ? field.values : []
    };
  }

  function baaFieldLines(fields, includeDefault) {
    return (Array.isArray(fields) ? fields : []).map(function (field) {
      field = normalizeBaaFieldDefinition(field);
      if (!field.name) return '';
      var parts = [
        field.name,
        field.type || 'string',
        field.required ? 'required' : 'optional'
      ];
      if (includeDefault) parts.push(field.defaultValue == null ? '' : String(field.defaultValue));
      parts.push(field.example == null ? '' : String(field.example));
      parts.push(field.description || '');
      return parts.join(':');
    }).filter(Boolean).join('\\n');
  }

  function parseBaaFieldLines(text, includeDefault) {
    return String(text || '').split(/\\r?\\n/).map(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return null;
      var parts = trimmed.split(':');
      var name = String(parts.shift() || '').trim();
      var type = String(parts.shift() || 'string').trim() || 'string';
      var requiredText = String(parts.shift() || '').trim().toLowerCase();
      var required = ['required', 'true', '1', 'yes', 'да', 'обязательный'].indexOf(requiredText) !== -1;
      var defaultValue = '';
      if (includeDefault) defaultValue = parts.shift() || '';
      var example = parts.shift() || '';
      var description = parts.join(':').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(t('invalidParamName') + ': ' + name);
      return {
        name: name,
        type: type,
        required: required,
        default: defaultValue,
        example: example,
        description: description
      };
    }).filter(Boolean);
  }

  function renderBaaFieldEditorRow(field, includeDefault, readOnly) {
    field = normalizeBaaFieldDefinition(field);
    var disabled = readOnly ? ' readonly' : '';
    var buttonDisabled = readOnly ? ' disabled' : '';
    var requiredValue = field.required ? 'true' : 'false';
    var cells = [
      '<td><input data-baa-field="name" value="' + escapeHtml(field.name || '') + '"' + disabled + '></td>',
      '<td><input data-baa-field="type" value="' + escapeHtml(field.type || 'string') + '"' + disabled + '></td>',
      '<td><select data-baa-field="required"' + (readOnly ? ' disabled' : '') + '><option value="false"' + (requiredValue === 'false' ? ' selected' : '') + '>' + escapeHtml(t('no')) + '</option><option value="true"' + (requiredValue === 'true' ? ' selected' : '') + '>' + escapeHtml(t('yes')) + '</option></select></td>'
    ];
    if (includeDefault) cells.push('<td><input data-baa-field="defaultValue" value="' + escapeHtml(field.defaultValue == null ? '' : String(field.defaultValue)) + '"' + disabled + '></td>');
    cells.push(
      '<td><input data-baa-field="example" value="' + escapeHtml(field.example == null ? '' : String(field.example)) + '"' + disabled + '></td>',
      '<td><textarea rows="2" data-baa-field="description"' + disabled + '>' + escapeHtml(field.description || '') + '</textarea></td>',
      '<td><button data-action="clear-baa-field-row" type="button"' + buttonDisabled + '>' + escapeHtml(t('clear')) + '</button></td>'
    );
    return '<tr data-baa-field-row>' + cells.join('') + '</tr>';
  }

  function renderBaaFieldEditorTable(fields, includeDefault, options) {
    options = options || {};
    var rows = (Array.isArray(fields) ? fields : []).map(function (field) {
      return renderBaaFieldEditorRow(field, includeDefault, Boolean(options.readOnly));
    }).join('');
    if (!rows && !options.readOnly) rows = renderBaaFieldEditorRow({}, includeDefault, false);
    var headers = [
      t('paramName'),
      t('type'),
      t('paramRequired')
    ];
    if (includeDefault) headers.push(t('paramDefault'));
    headers.push(t('paramExample'), t('description'), '');
    return [
      '<div class="table-wrap">',
      '<table class="baa-contract-table baa-field-table" data-baa-field-table data-include-default="' + (includeDefault ? 'true' : 'false') + '">',
      '<thead><tr>' + headers.map(function (header) { return '<th>' + escapeHtml(header) + '</th>'; }).join('') + '</tr></thead>',
      '<tbody>' + rows + '</tbody>',
      '</table>',
      '</div>',
      options.readOnly ? '' : '<button data-action="' + escapeHtml(options.addAction || 'add-baa-field-row') + '" type="button">' + escapeHtml(options.addLabel || t('add')) + '</button>'
    ].join('');
  }

  function readBaaFieldEditorRows(container, includeDefault) {
    return Array.prototype.slice.call((container || document).querySelectorAll('[data-baa-field-row]')).map(function (row) {
      var name = String((row.querySelector('[data-baa-field="name"]') || {}).value || '').trim();
      var type = String((row.querySelector('[data-baa-field="type"]') || {}).value || 'string').trim() || 'string';
      var required = String((row.querySelector('[data-baa-field="required"]') || {}).value || '').trim() === 'true';
      var defaultValueField = row.querySelector('[data-baa-field="defaultValue"]');
      var defaultValue = includeDefault && defaultValueField ? defaultValueField.value : '';
      var example = String((row.querySelector('[data-baa-field="example"]') || {}).value || '');
      var description = String((row.querySelector('[data-baa-field="description"]') || {}).value || '').trim();
      if (!name && !type && !defaultValue && !example && !description) return null;
      if (!name) return null;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(t('invalidParamName') + ': ' + name);
      return {
        name: name,
        type: type,
        required: required,
        default: defaultValue,
        defaultValue: defaultValue,
        example: example,
        description: description
      };
    }).filter(Boolean);
  }

  function renderBaaContractSourceOptions(contract) {
    var sourceCode = contract && contract.sourceCode || '';
    var options = (state.baaInputContracts || []).map(function (item) {
      var label = item.code + (item.description ? ' - ' + item.description : '') + (item.version ? ' v' + item.version : '');
      return '<option value="' + escapeHtml(item.code || '') + '"' + (sourceCode === item.code || (!sourceCode && contract && contract.code === item.code) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
    return '<option value="">' + escapeHtml(t('baaContractSourceManual')) + '</option>' + options;
  }

  function renderBaaContractObjectRow(object, index, readOnly) {
    object = object || {};
    var disabled = readOnly ? ' readonly' : '';
    var buttonDisabled = readOnly ? ' disabled' : '';
    return [
      '<div class="settings-block" data-baa-object-row>',
      '<div class="row">',
      '<label>' + t('baaObjectAlias') + '<input data-baa-object-field="alias" value="' + escapeHtml(object.alias || ('candidate' + String(index + 1))) + '"' + disabled + '></label>',
      '<label>' + t('baaObjectClassName') + '<input data-baa-object-field="className" value="' + escapeHtml(object.className || '') + '"' + disabled + '></label>',
      '</div>',
      '<label>' + t('description') + '<input data-baa-object-field="description" value="' + escapeHtml(object.description || '') + '"' + disabled + '></label>',
      '<div data-baa-object-field="payload"><h4>' + escapeHtml(t('baaPayloadFields')) + '</h4><p class="muted">' + escapeHtml(t('baaPayloadFieldsHelp')) + '</p>' +
        renderBaaFieldEditorTable(object.payload || [], false, { readOnly: readOnly, addAction: 'add-baa-payload-field', addLabel: t('addBaaPayloadField') }) + '</div>',
      '<button data-action="clear-baa-object" type="button"' + buttonDisabled + '>' + t('clear') + '</button>',
      '</div>'
    ].join('');
  }

  function renderBaaExternalContractSummary(contract) {
    contract = contract || {};
    var objects = Array.isArray(contract.objects) ? contract.objects : [];
    var params = Array.isArray(contract.contractParams)
      ? contract.contractParams
      : (Array.isArray(contract.variables) ? contract.variables : []);
    var requestVariables = Array.isArray(contract.requestVariables) ? contract.requestVariables : [];
    var rows = objects.map(function (object) {
      var fields = (object.payload || []).map(function (field) {
        var required = field.required ? '*' : '';
        return (field.name || '') + required + (field.type ? ':' + field.type : '');
      }).filter(Boolean).join(', ');
      return '<tr><td><strong>' + escapeHtml(object.className || '') + '</strong></td><td>' + escapeHtml(object.alias || '') + '</td><td>' + escapeHtml(fields || '-') + '</td><td>' + escapeHtml(object.description || '') + '</td></tr>';
    }).join('');
    var paramRows = params.map(function (param) {
      param = normalizeBaaFieldDefinition(param);
      var listText = param.listMode && param.listMode !== 'none'
        ? param.listMode + (param.values && param.values.length ? ': ' + param.values.join(', ') : '')
        : '';
      return '<tr><td><strong>' + escapeHtml(param.name || '') + '</strong></td><td>' + escapeHtml(param.description || '') + '</td><td>' + escapeHtml(param.type || '') + '</td><td>' + escapeHtml(param.required ? 'yes' : 'no') + '</td><td>' + escapeHtml(param.defaultValue || '') + '</td><td>' + escapeHtml(listText) + '</td></tr>';
    }).join('');
    var variableRows = requestVariables.map(function (variable) {
      variable = normalizeBaaFieldDefinition(variable);
      return '<tr><td><strong>' + escapeHtml(variable.name || '') + '</strong></td><td>' + escapeHtml(variable.description || '') + '</td><td>' + escapeHtml(variable.type || '') + '</td><td>' + escapeHtml(variable.required ? 'yes' : 'no') + '</td><td>' + escapeHtml(variable.defaultValue || '') + '</td></tr>';
    }).join('');
    return [
      '<div class="baa-contract-summary">',
      '<div class="baa-contract-meta">',
      '<div><span>' + escapeHtml(t('baaContractCode')) + '</span><strong>' + escapeHtml(contract.code || '') + '</strong></div>',
      '<div><span>' + escapeHtml(t('baaContractVersion')) + '</span><strong>' + escapeHtml(contract.version || '') + '</strong></div>',
      '<div><span>' + escapeHtml(t('baaContractDescription')) + '</span><strong>' + escapeHtml(contract.description || '') + '</strong></div>',
      '</div>',
      '<div class="baa-usage-note"><strong>' + escapeHtml(t('baaContractUsage')) + '</strong><br>' + escapeHtml(t('baaContractUsageHelp')) + '</div>',
      params.length
        ? '<div><h4>' + escapeHtml(t('baaContractParams')) + '</h4><p class="muted">' + escapeHtml(t('baaContractParamsHelp')) + '</p><div class="table-wrap"><table class="baa-contract-table"><thead><tr><th>' + escapeHtml(t('paramName')) + '</th><th>' + escapeHtml(t('description')) + '</th><th>' + escapeHtml(t('type')) + '</th><th>' + escapeHtml(t('paramRequired')) + '</th><th>' + escapeHtml(t('paramDefault')) + '</th><th>List</th></tr></thead><tbody>' + paramRows + '</tbody></table></div></div>'
        : '',
      requestVariables.length
        ? '<div><h4>' + escapeHtml(t('baaRequestVariables')) + '</h4><p class="muted">' + escapeHtml(t('baaRequestVariablesHelp')) + '</p><div class="table-wrap"><table class="baa-contract-table"><thead><tr><th>' + escapeHtml(t('paramName')) + '</th><th>' + escapeHtml(t('description')) + '</th><th>' + escapeHtml(t('type')) + '</th><th>' + escapeHtml(t('paramRequired')) + '</th><th>' + escapeHtml(t('paramDefault')) + '</th></tr></thead><tbody>' + variableRows + '</tbody></table></div></div>'
        : '',
      objects.length
        ? '<div class="table-wrap"><table class="baa-contract-table"><thead><tr><th>' + escapeHtml(t('baaObjectClassName')) + '</th><th>' + escapeHtml(t('baaObjectAlias')) + '</th><th>' + escapeHtml(t('baaPayloadFields')) + '</th><th>' + escapeHtml(t('description')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="notice">' + escapeHtml(t('baaContractNoObjects')) + '</div>',
      '</div>'
    ].join('');
  }

  function renderBaaEndpointEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var contract = state.baaContractDraft || baaContractForSpec(spec);
    var externalContract = Boolean(contract.sourceCode);
    var templateCode = readTemplateCode(selected);
    var verifyUrl = templateCode ? absoluteBaaVerifyUrl(templateCode) : '';
    if (!contract.objects.length && !contract.sourceCode) {
      contract.objects = [{
        alias: 'candidate1',
        className: 'Router',
        description: '',
        payload: [
          { name: 'Code', type: 'string', required: false, example: 'router047', description: 'Candidate code' },
          { name: 'ipAddress', type: 'ipv4', required: false, example: '10.10.2.15', description: 'Candidate IPv4 address' }
        ]
      }];
    }
    return [
      '<section class="section" id="cmdp-baa-endpoint-editor"><h2>' + escapeHtml(t('baaEndpointEditor')) + '</h2>',
      '<p class="muted">' + escapeHtml(t('baaEndpointHelp')) + '</p>',
      verifyUrl ? '<div class="run-launch-url" title="' + escapeHtml(t('baaVerifyEndpointUrlHelp')) + '"><span>' + escapeHtml(t('baaVerifyEndpointUrl')) + '</span><code>' + escapeHtml(verifyUrl) + '</code></div>' : '',
      '<p class="muted">' + escapeHtml(t('baaVerifyEndpointUrlHelp')) + '</p>',
      '<div class="settings-block">',
      '<div class="settings-grid">',
      '<label>' + t('baaContractSource') + '<select id="cmdp-baa-contract-source">' + renderBaaContractSourceOptions(contract) + '</select></label>',
      '<label>' + t('baaContractCode') + '<input id="cmdp-baa-contract-code" value="' + escapeHtml(contract.code || '') + '" readonly></label>',
      '<label>' + t('baaContractVersion') + '<input id="cmdp-baa-contract-version" value="' + escapeHtml(contract.version || '1') + '" readonly></label>',
      '</div>',
      '<label>' + t('baaContractDescription') + '<input id="cmdp-baa-contract-description" value="' + escapeHtml(contract.description || '') + '" readonly></label>',
      '</div>',
      externalContract ? '' : '<div class="settings-block" id="cmdp-baa-contract-variables"><h3>' + escapeHtml(t('baaContractVariables')) + '</h3>' +
        '<p class="muted">' + escapeHtml(t('baaVariablesHelp')) + '</p>' +
        renderBaaFieldEditorTable(contract.contractParams || contract.variables || [], true, { addAction: 'add-baa-variable-row', addLabel: t('addBaaVariable') }) +
        '</div>',
      '<div class="settings-block"><h3>' + escapeHtml(t('baaContractObjects')) + '</h3>',
      '<p class="muted">' + escapeHtml(t('baaContractObjectsHelp')) + '</p>',
      externalContract
        ? renderBaaExternalContractSummary(contract)
        : '<div id="cmdp-baa-object-rows">' + contract.objects.map(function (object, index) { return renderBaaContractObjectRow(object, index, false); }).join('') + '</div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function runParamValueForRow(row) {
    var params = state.runParams || {};
    if (Object.prototype.hasOwnProperty.call(params, row.name)) return params[row.name];
    if (row.defaultValue !== undefined && row.defaultValue !== null && row.defaultValue !== '') return row.defaultValue;
    if (row.example !== undefined && row.example !== null) return row.example;
    return '';
  }

  function renderRunParamValueControl(row) {
    var value = runParamValueForRow(row);
    var base = ' data-run-param-field="' + escapeHtml(row.name || '') + '" data-run-param-type="' + escapeHtml(row.type || 'string') + '" data-run-param-required="' + (row.required ? 'true' : 'false') + '" data-run-param-default="' + escapeHtml(row.defaultValue == null ? '' : String(row.defaultValue)) + '"';
    if (row.type === 'boolean') {
      var normalized = String(value === undefined || value === null ? '' : value).toLowerCase();
      return '<select' + base + '>' +
        '<option value=""' + (normalized === '' ? ' selected' : '') + '></option>' +
        '<option value="true"' + (normalized === 'true' ? ' selected' : '') + '>true</option>' +
        '<option value="false"' + (normalized === 'false' ? ' selected' : '') + '>false</option>' +
        '</select>';
    }
    var inputType = row.type === 'integer' || row.type === 'number' ? 'number' : 'text';
    return '<input type="' + inputType + '"' + base + ' value="' + escapeHtml(value == null ? '' : String(value)) + '">';
  }

  function renderRunParamRow(row) {
    var meta = [
      t('paramType') + ': ' + (row.type || 'string'),
      t('paramRequired') + ': ' + (row.required ? t('yes') : t('no')),
      t('paramDefault') + ': ' + (row.defaultValue == null ? '' : String(row.defaultValue))
    ].join(' / ');
    return '<div class="run-param-row">' +
      '<div class="run-param-main"><strong>' + escapeHtml(row.name || '') + '</strong>' +
      '<span class="run-param-meta">' + escapeHtml(meta) + '</span>' +
      (row.description ? '<span class="muted">' + escapeHtml(row.description) + '</span>' : '') +
      '</div>' +
      '<div class="run-param-value"><label>' + t('runParamValue') + renderRunParamValueControl(row) + '</label></div>' +
      '</div>';
  }

  function renderRunParamsEditor(selected) {
    var rows = getParamRows((selected && selected.spec) || defaultSpec()).filter(function (row) { return row.name; });
    return [
      '<section class="section" id="cmdp-run-params-editor"><h2>' + t('runInputValues') + '</h2>',
      '<p class="muted">' + t('runInputValuesHelp') + '</p>',
      rows.length ? '<div class="run-param-list">' + rows.map(renderRunParamRow).join('') + '</div>' : '<div class="notice">' + t('noInputVariables') + '</div>',
      '</section>'
    ].join('');
  }

  function sampleRunParamValue(row) {
    var type = row && row.type ? row.type : 'string';
    if (type === 'integer') return 1;
    if (type === 'number') return 1;
    if (type === 'boolean') return true;
    if (type === 'ipv4') return '10.10.2.15';
    if (type === 'ipv4-cidr') return '10.10.2.0/24';
    if (type === 'date') return '2026-01-01';
    if (type === 'dateTime') return '2026-01-01T00:00:00Z';
    return 'test';
  }

  function runUrlParamsForTemplate(selected, includeDomValues) {
    var spec = (selected && selected.spec) || defaultSpec();
    var rows = getParamRows(spec).filter(function (row) { return row.name; });
    var current = state.runParams || {};
    var fieldsByName = {};
    if (includeDomValues) {
      Array.prototype.slice.call(document.querySelectorAll('[data-run-param-field]')).forEach(function (field) {
        fieldsByName[field.getAttribute('data-run-param-field') || ''] = field;
      });
    }
    var params = {};
    rows.forEach(function (row) {
      var field = fieldsByName[row.name];
      if (field && field.value !== '') {
        params[row.name] = field.value;
      } else if (Object.prototype.hasOwnProperty.call(current, row.name) && current[row.name] !== undefined && current[row.name] !== null && current[row.name] !== '') {
        params[row.name] = current[row.name];
      } else if (row.defaultValue !== undefined && row.defaultValue !== null && row.defaultValue !== '') {
        params[row.name] = row.defaultValue;
      } else if (row.example !== undefined && row.example !== null && row.example !== '') {
        params[row.name] = row.example;
      } else {
        params[row.name] = sampleRunParamValue(row);
      }
    });
    return params;
  }

  function runParamVariantsText(params) {
    var query = new URLSearchParams(params || {}).toString();
    var htmlQuery = query || t('runLaunchNoParams');
    var jsonQuery = new URLSearchParams(Object.assign({}, params || {}, { json: 'true' })).toString();
    return 'HTML: ' + htmlQuery + ' | JSON: ' + jsonQuery;
  }

  function renderTemplateLaunchUrl(selected) {
    var code = readTemplateCode(selected);
    if (!code) return '<div class="notice error">' + escapeHtml(t('templateCodeRequired')) + '</div>';
    if (selectedTemplateIsBaa(selected)) {
      var verifyUrl = absoluteBaaVerifyUrl(code);
      return [
        '<div class="run-launch-url" title="' + escapeHtml(t('baaVerifyEndpointUrlHelp')) + '"><span>' + escapeHtml(t('baaVerifyEndpointUrl')) + '</span><code>' + escapeHtml(verifyUrl) + '</code></div>',
        '<div class="run-launch-params" title="' + escapeHtml(t('baaRunPostOnlyHelp')) + '"><span>' + escapeHtml(t('runLaunchParams')) + '</span><code>' + escapeHtml(t('baaPostOnlyNotice')) + '</code></div>'
      ].join('');
    }
    var params = runUrlParamsForTemplate(selected, false);
    var url = absoluteRuntimeTemplateUrl(code, params);
    var jsonParams = Object.assign({}, params, { json: 'true' });
    var jsonUrl = absoluteRuntimeTemplateUrl(code, jsonParams);
    return [
      '<div class="run-launch-url" title="' + escapeHtml(t('runLaunchUrlHelp')) + '"><span>' + escapeHtml(t('runLaunchUrl')) + '</span><a id="cmdp-run-launch-url" data-template-code="' + escapeHtml(code) + '" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">' + escapeHtml(url) + '</a></div>',
      '<div class="run-launch-url" title="' + escapeHtml(t('runLaunchUrlHelp')) + '"><span>' + escapeHtml(t('runLaunchJsonUrl')) + '</span><a id="cmdp-run-launch-json-url" data-template-code="' + escapeHtml(code) + '" href="' + escapeHtml(jsonUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(jsonUrl) + '</a></div>',
      '<div class="run-launch-params" title="' + escapeHtml(t('runLaunchParamsHelp')) + '"><span>' + escapeHtml(t('runLaunchParams')) + '</span><code id="cmdp-run-launch-params">' + escapeHtml(runParamVariantsText(params)) + '</code></div>'
    ].join('');
  }

  function renderResultSection() {
    return renderActionResult(state.result) || '<section class="section" id="cmdp-result-section"><h2>' + t('result') + '</h2><p class="muted">' + t('noResult') + '</p></section>';
  }

  function renderEditorVisualizationResult(result) {
    if (!result) return '';
    if (result.json && (result.json.status === 'completed' || result.json.status === 'error') && Array.isArray(result.json.tables) && Array.isArray(result.json.items)) {
      return renderBaaVerificationResult(result);
    }
    return '<section class="section" id="cmdp-result-section"><h2>' + t('result') + '</h2>' + renderRuntimeResult(result) + '</section>';
  }

  function defaultBaaRequest(selected) {
    var spec = selected && selected.spec || defaultSpec();
    var contract = baaContractForSpec(spec);
    var contractParams = (contract.contractParams || contract.variables || []).map(normalizeBaaFieldDefinition).filter(function (field) { return field.name; });
    var requestVariables = (contract.requestVariables || []).map(normalizeBaaFieldDefinition).filter(function (field) { return field.name; });
    var endpointParams = runUrlParamsForTemplate(selected || {}, true);
    contractParams.forEach(function (field) {
      if (endpointParams[field.name] !== undefined && endpointParams[field.name] !== null && endpointParams[field.name] !== '') return;
      endpointParams[field.name] = field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== ''
        ? field.defaultValue
        : (field.example !== undefined && field.example !== null && field.example !== '' ? field.example : sampleRunParamValue(field));
    });
    var variables = {};
    var variableSources = [];
    requestVariables.forEach(function (field) {
      var value = field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== ''
        ? field.defaultValue
        : (field.example !== undefined && field.example !== null && field.example !== '' ? field.example : sampleRunParamValue(field));
      variables[field.name] = value;
      variableSources.push({
        name: field.name,
        sourceKind: field.sourceKind || 'constant',
        sourceExpression: field.sourceExpression || '',
        valuePresent: value !== undefined && value !== null && value !== ''
      });
    });
    var objects = (contract.objects && contract.objects.length ? contract.objects : [{
      alias: 'candidate1',
      className: 'ACL',
      payload: [
        { name: 'Code', type: 'string', example: 'ACL-001' },
        { name: 'destinationAddress', type: 'ipv4-cidr', example: '10.0.0.0/24' }
      ]
    }]).map(function (object, index) {
      var payload = {};
      (object.payload || []).forEach(function (field) {
        payload[field.name] = field.example !== undefined && field.example !== null && field.example !== '' ? field.example : sampleRunParamValue(field);
      });
      return {
        planIndex: index,
        kind: object.alias || 'candidate',
        className: object.className || object.alias || 'Candidate',
        pageShapeKey: 'visio/pages/page1.xml:' + String(index + 1),
        mappingKey: object.alias || object.className || 'candidate',
        relationBindingStatus: 'candidate',
        endpoints: {},
        payload: payload,
        attributeSources: []
      };
    });
    return {
      source: 'CMDB BAA',
      inputContract: {
        code: contract.code || 'contract-verification-input-v1',
        version: contract.version || '1',
        checksum: 'sha256...'
      },
      endpoint: {
        code: readTemplateCode(selected) || 'verification-endpoint',
        params: endpointParams
      },
      contractParams: contractParams,
      variables: variables,
      variableSources: variableSources,
      plan: {
        objects: objects,
        missingAttributes: [],
        skipped: []
      }
    };
  }

  function renderBaaRequestEditor(selected) {
    var value = state.baaRequestDraft || pretty(defaultBaaRequest(selected));
    return [
      '<section class="section" id="cmdp-baa-request-editor"><h2>' + escapeHtml(t('baaRequestEditor')) + '</h2>',
      '<p class="muted">' + escapeHtml(t('baaRequestHelp')) + '</p>',
      '<textarea id="cmdp-baa-request" rows="16" spellcheck="false">' + escapeHtml(value) + '</textarea>',
      '</section>'
    ].join('');
  }

  function baaResultTableToRuntimeTable(table) {
    var columns = Array.isArray(table && table.columns) ? table.columns : [];
    var columnNames = columns.map(function (column) { return column && (column.name || column.key); }).filter(Boolean);
    var labels = {};
    columns.forEach(function (column) {
      var name = column && (column.name || column.key);
      if (name) labels[name] = column.title || column.label || name;
    });
    return {
      name: table && table.code || '',
      title: table && table.title || table && table.code || '',
      columns: columnNames,
      columnLabels: labels,
      rows: Array.isArray(table && table.rows) ? table.rows : [],
      emptyText: DEFAULT_EMPTY_RESULT_TEXT
    };
  }

  function renderBaaVerificationResult(result) {
    var body = result.json || {};
    var html = '<section class="section" id="cmdp-result-section"><h2>' + t('result') + '</h2>';
    html += renderNotice({ type: result.ok && body.success ? 'ok' : 'error', text: body.message || body.status || '' });
    if (Array.isArray(body.items) && body.items.length) {
      html += '<div class="settings-block"><h3>Items</h3><pre>' + escapeHtml(pretty(body.items)) + '</pre></div>';
    }
    var tables = Array.isArray(body.tables) ? body.tables.map(baaResultTableToRuntimeTable) : [];
    if (tables.length) html += tables.map(renderResultTable).join('');
    else html += '<pre>' + escapeHtml(pretty(body)) + '</pre>';
    html += '</section>';
    return html;
  }

  function renderTemplateRunSection(selected) {
    if (selectedTemplateIsBaa(selected)) {
      return [
        '<section class="section"><div class="notice">' + escapeHtml(t('baaPostOnlyNotice')) + '</div>',
        renderTemplateLaunchUrl(selected),
        '</section>',
        renderRunParamsEditor(selected),
        renderBaaRequestEditor(selected),
        state.result ? renderEditorVisualizationResult(state.result) : ''
      ].join('');
    }
    return [
      renderRunParamsEditor(selected),
      state.result ? renderEditorVisualizationResult(state.result) : ''
    ].join('');
  }

  function renderPublicationEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var publish = publishModelForSpec(spec);
    return [
      renderRunParamsEditor(selected),
      '<section class="section" id="cmdp-publication-editor"><h2>' + t('publicationEditor') + '</h2>',
      '<p class="muted">' + t('publicationHelp') + '</p>',
      '<div class="notice error">' + escapeHtml(t('publicationWarning')) + '</div>',
      '<div class="form">',
      '<label>' + t('publicationMode') + '<select id="cmdp-publish-mode">',
      '<option value="dynamicUser"' + (publish.mode === 'dynamicUser' ? ' selected' : '') + '>' + t('publicationDynamic') + '</option>',
      '<option value="staticSnapshot"' + (publish.mode === 'staticSnapshot' ? ' selected' : '') + '>' + t('publicationStatic') + '</option>',
      '</select></label>',
      '<label>' + t('publicationParamsMode') + '<select id="cmdp-publish-params-mode">',
      '<option value="exact"' + (publish.paramsMode === 'exact' ? ' selected' : '') + '>' + t('publicationParamsExact') + '</option>',
      '<option value="ignore"' + (publish.paramsMode === 'ignore' ? ' selected' : '') + '>' + t('publicationParamsIgnore') + '</option>',
      '</select><span class="muted">' + escapeHtml(t('publicationParamsModeHelp')) + '</span></label>',
      '<label class="checkbox"><input id="cmdp-publish-warning-accepted" type="checkbox" ' + (publish.warningAccepted ? 'checked' : '') + '> ' + t('publicationWarningAccepted') + '</label>',
      '</div>',
      '</section>'
    ].join('');
  }

  function renderCacheScopeOptions(selected) {
    return [
      { value: 'permissionOnly', label: t('cachePermissionOnly') },
      { value: 'visibilityHash', label: t('cacheVisibilityHash') },
      { value: 'privateUser', label: t('cachePrivateUser') },
      { value: 'disabled', label: t('cacheDisabled') }
    ].map(function (option) {
      return '<option value="' + option.value + '"' + (option.value === selected ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>';
    }).join('');
  }

  function renderCacheEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var cache = cacheModelForSpec(spec);
    return [
      '<section class="section" id="cmdp-cache-editor"><h2>' + t('cacheEditor') + '</h2>',
      '<p class="muted">' + t('cacheHelp') + '</p>',
      '<div class="form">',
      '<label class="checkbox"><input id="cmdp-cache-enabled" type="checkbox" ' + (cache.enabled ? 'checked' : '') + '> ' + t('cacheEnabled') + '</label>',
      '<label>' + t('cacheScopeMode') + '<select id="cmdp-cache-scope-mode">' + renderCacheScopeOptions(cache.scopeMode) + '</select></label>',
      '<div class="notice">' + escapeHtml(t('cachePermissionOnlyHelp')) + '<br>' + escapeHtml(t('cacheVisibilityHashHelp')) + '<br>' + escapeHtml(t('cachePrivateUserHelp')) + '</div>',
      '<div class="row">',
      '<label>' + t('cacheTtlHours') + '<input id="cmdp-cache-ttl-hours" type="number" min="0.01" max="24" step="0.01" value="' + escapeHtml(cacheTtlHoursForInput(cache)) + '"></label>',
      '<label class="checkbox"><input id="cmdp-cache-allow-manual-refresh" type="checkbox" ' + (cache.allowManualRefresh ? 'checked' : '') + '> ' + t('cacheAllowManualRefresh') + '</label>',
      '</div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function renderDiagnostics() {
    return [
      '<section class="section" id="cmdp-diagnostics"><h2>' + t('menuDiagnostics') + '</h2>',
      '<p class="muted">' + t('diagnosticsHelp') + '</p>',
      '</section>'
    ].join('');
  }

  function renderAbout() {
    return [
      '<section class="section" id="cmdp-about"><h2>' + t('menuAbout') + '</h2>',
      '<p>' + escapeHtml(t('aboutText')).replace(/\\n/g, '<br>') + '</p>',
      '</section>'
    ].join('');
  }

  function renderDesignerSection(selected, config, templateRows) {
    var section = normalizeDesignerSection(state.designerSection);
    if (sectionDisabledForBaa(section, selected)) return renderBaaDisabledSection();
    if (section === 'template') return renderTemplateEditor(selected);
    if (section === 'schema') return renderSchemaManager();
    if (section === 'versions') return renderVersions();
    if (section === 'baa-endpoint') return renderBaaEndpointEditor(selected);
    if (section === 'object-group') return renderObjectGroupEditor(selected);
    if (section === 'relations') return renderRelationExpansionEditor(selected);
    if (section === 'final-view') return renderViewComposerEditor(selected);
    if (section === 'cmdb-build-view') return renderCmdbBuildViewEditor(selected);
    if (section === 'params') return renderParamsEditor(selected);
    if (section === 'extraction') return renderExtractionEditor(selected);
    if (section === 'run') return renderTemplateRunSection(selected);
    if (section === 'publication') return renderPublicationEditor(selected);
    if (section === 'cache') return renderCacheEditor(selected);
    if (section === 'selection') return renderDataSelectionEditor(selected);
    if (section === 'visualization') return renderVisualizationEditor(selected);
    if (section === 'builder') return renderBuilder();
    if (section === 'test') return renderRunParamsEditor(selected) + renderTestWorkflow();
    if (section === 'result') return renderResultSection();
    if (section === 'general-settings') return renderGeneralSettings();
    if (section === 'settings') return renderRuntimeSettings(config);
    if (section === 'diagnostics') return renderDiagnostics();
    if (section === 'about') return renderAbout();
    return renderTemplateList(templateRows);
  }

  function designerSectionTitle(section) {
    section = normalizeDesignerSection(section);
    if (section === 'template') return t('creatingTemplate');
    if (section === 'schema') return t('menuSchema');
    if (section === 'versions') return t('menuVersions');
    if (section === 'baa-endpoint') return t('menuBaaEndpoint');
    if (section === 'params') return t('menuParams');
    if (section === 'object-group') return t('menuObjectGroup');
    if (section === 'relations') return t('menuRelations');
    if (section === 'final-view') return t('menuFinalView');
    if (section === 'cmdb-build-view') return t('menuCmdbBuildView');
    if (section === 'extraction') return t('menuExtraction');
    if (section === 'run') return t('menuTemplateRun');
    if (section === 'publication') return t('menuPublication');
    if (section === 'cache') return t('cacheEditor');
    if (section === 'selection') return t('menuSelection');
    if (section === 'visualization') return t('visualizationEditor');
    if (section === 'general-settings') return t('menuGeneralSettings');
    if (section === 'settings') return t('menuRuntimeSettings');
    if (section === 'diagnostics') return t('menuDiagnostics');
    if (section === 'about') return t('menuAbout');
    return t('menuTemplateList');
  }

  function renderActionButton(action, label, options) {
    options = options || {};
    var classes = [];
    if (options.primary) classes.push('primary');
    if (options.danger) classes.push('danger');
    var classAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
    var typeAttr = options.type ? ' type="' + escapeHtml(options.type) + '"' : '';
    var disabledAttr = options.disabled ? ' disabled aria-disabled="true"' : '';
    var titleAttr = options.title ? ' title="' + escapeHtml(options.title) + '"' : '';
    return '<button' + classAttr + typeAttr + disabledAttr + titleAttr + ' data-action="' + escapeHtml(action) + '">' + escapeHtml(label) + '</button>';
  }

  function renderActionLink(href, label, options) {
    options = options || {};
    var classes = ['button'];
    if (options.primary) classes.push('primary');
    return '<a class="' + classes.join(' ') + '" href="' + escapeHtml(href) + '"' + (options.blank ? ' target="_blank" rel="noreferrer"' : '') + '>' + escapeHtml(label) + '</a>';
  }

  function sectionPersistsTemplate(section) {
    return [
      'template',
      'baa-endpoint',
      'params',
      'object-group',
      'relations',
      'final-view',
      'cmdb-build-view',
      'selection',
      'visualization',
      'cache',
      'publication'
    ].indexOf(normalizeDesignerSection(section)) !== -1;
  }

  function renderDesignerActionBar(selected) {
    var section = normalizeDesignerSection(state.designerSection);
    var actions = [
      renderActionLink('/cmdbuild/ui/#management', t('cmdbuild')),
      renderActionButton('refresh', t('refresh'))
    ];
    var context = '';

    if (sectionDisabledForBaa(section, selected)) {
      actions.push(renderActionButton('baa-disabled', t('baaPostOnlyMode'), { disabled: true, title: t('baaSectionDisabled') }));
    } else if (section === 'templates') {
      actions.push(renderActionButton('new-template', t('newTemplate'), { primary: true }));
      actions.push(renderActionButton('new-cmdb-build-view', t('templateKindCmdbBuildView')));
    } else if (section === 'template') {
      actions.push(renderActionButton('save-template', t('save'), { primary: true }));
    } else if (section === 'baa-endpoint') {
      actions.push(renderActionButton('add-baa-object', t('addBaaObject')));
      actions.push(renderActionButton('apply-baa-endpoint', t('applyBaaEndpoint')));
    } else if (section === 'params') {
      actions.push(renderActionButton('add-param-row', t('addParam')));
      actions.push(renderActionButton('apply-params', t('applyParams'), { primary: true }));
      actions.push(renderActionButton('fill-param-examples', t('fillExamples')));
    } else if (section === 'object-group') {
      actions.push(renderActionButton('add-object-selection', t('addObjectSelection')));
      actions.push(renderActionButton('apply-object-group', t('applyObjectGroup'), { primary: true }));
    } else if (section === 'relations') {
      actions.push(renderActionButton('apply-relation-expansion', t('applyRelation'), { primary: true }));
    } else if (section === 'final-view') {
      actions.push(renderActionButton('add-view-column-row', t('addViewColumn')));
      actions.push(renderActionButton('apply-view-composer', t('applyViewComposer'), { primary: true }));
    } else if (section === 'cmdb-build-view') {
      actions.push(renderActionButton('apply-cmdb-build-view', t('apply'), { primary: true }));
    } else if (section === 'extraction') {
      actions.push(renderActionButton('extract-template', t('extractByTemplate'), { primary: true }));
    } else if (section === 'visualization') {
      actions.push(renderActionButton('apply-visualization', t('applyVisualization'), { primary: true }));
    } else if (section === 'cache') {
      actions.push(renderActionButton('apply-cache', t('cacheApply'), { primary: true }));
      if (readTemplateCode(selected)) context = renderTemplateLaunchUrl(selected);
    } else if (section === 'publication') {
      actions.push(renderActionButton('apply-publication', t('applyPublication')));
      actions.push(renderActionButton('publish-snapshot', t('publishSnapshot'), { primary: true }));
      if (readTemplateCode(selected)) context = renderTemplateLaunchUrl(selected);
    } else if (section === 'run') {
      if (selectedTemplateIsBaa(selected)) {
        actions.push(renderActionButton('visualize-editor', t('visualizeInEditor'), { disabled: true, title: t('baaRunPostOnlyHelp') }));
        actions.push(renderActionButton('force-refresh-editor', t('forceRefreshInEditor'), { disabled: true, title: t('baaRunPostOnlyHelp') }));
        actions.push(renderActionButton('visualize-external', t('visualizeExternal'), { disabled: true, title: t('baaRunPostOnlyHelp') }));
        actions.push(renderActionButton('baa-verify-preview', t('baaVerifyPreview'), { primary: true }));
        actions.push(renderActionButton('baa-verify-refresh-preview', t('baaVerifyRefreshPreview')));
      } else {
        actions.push(renderActionButton('visualize-editor', t('visualizeInEditor'), { primary: true }));
        actions.push(renderActionButton('force-refresh-editor', t('forceRefreshInEditor')));
        actions.push(renderActionButton('visualize-external', t('visualizeExternal')));
      }
      if (readTemplateCode(selected)) context = renderTemplateLaunchUrl(selected);
    } else if (section === 'selection') {
      actions.push(renderActionButton('add-selection-filter-row', t('addFilter')));
      actions.push(renderActionButton('apply-selection', t('applySelection'), { primary: true }));
    } else if (section === 'schema') {
      var schemaReady = Boolean((state.schemaPlan || state.schema || {}).ready);
      actions.push(renderActionButton('schema-preview', t('schemaPreview')));
      if (!schemaReady) actions.push(renderActionButton('bootstrap-schema', t('schemaCreateMissing'), { primary: true }));
    } else if (section === 'general-settings') {
      actions.push(renderActionButton('save-general-settings', t('saveConfig'), { primary: true }));
    } else if (section === 'settings') {
      actions.push(renderActionButton('save-config', t('saveConfig'), { primary: true }));
    } else if (section === 'diagnostics') {
      actions.push(renderActionLink('/cmdbuild/custom-api/client-log', t('clientLog'), { blank: true }));
      actions.push(renderActionLink('/cmdbuild/custom-api/proxy-log', t('proxyLog'), { blank: true }));
      actions.push(renderActionLink('/cmdbuild/custom-api/cache/status', 'Redis/cache', { blank: true }));
      actions.push(renderActionLink('/cmdbuild/custom-api/logging/status', 'Logging', { blank: true }));
      actions.push(renderActionLink('/health/ready', 'Readiness', { blank: true }));
      actions.push(renderActionLink('/health/redis', 'Redis health', { blank: true }));
      actions.push(renderActionLink('/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages', t('customPageLauncher')));
    }

    if (sectionPersistsTemplate(section) && section !== 'template' && !sectionDisabledForBaa(section, selected)) {
      actions.push(renderActionButton('save-template', t('save')));
      actions.push(renderActionButton('validate-template', t('validate')));
      actions.push(renderActionButton('preview-template', t('preview'), selectedTemplateIsBaa(selected) ? { disabled: true, title: t('baaRunPostOnlyHelp') } : {}));
    }

    return [
      '<div class="designer-actionbar">',
      '<div class="designer-actionbar-title">' + escapeHtml(designerSectionTitle(section)) + '</div>',
      '<div class="designer-actionbar-actions">',
      actions.join(''),
      context ? '<div class="designer-actionbar-context">' + context + '</div>' : '',
      '</div>',
      '</div>'
    ].join('');
  }

  function renderDesigner() {
    updateChrome();
    if (state.technicalSchemaAccessDenied) {
      app.innerHTML = renderAccessDenied(state.accessDeniedText);
      return;
    }
    var config = state.config || { runtimeConfig: defaultRuntimeConfig(), exists: false };
    var selected = state.selectedTemplate || {
      code: '',
      description: '',
      active: true,
      spec: defaultSpec(),
      paramsSchema: {},
      resultSchema: {}
    };
    var templateRows = state.templates.map(function (template) {
      var selectedRow = state.selectedTemplate && state.selectedTemplate.code === template.code ? ' class="selected"' : '';
      var description = escapeHtml(template.description || '') + (template.protected ? ' <span class="pill">' + escapeHtml(t('protectedTemplate')) + '</span>' : '');
      var deleteAction = template.protected
        ? '<span class="muted">' + escapeHtml(t('protectedTemplate')) + '</span>'
        : '<button class="danger" data-action="delete-template" data-code="' + escapeHtml(template.code) + '">' + t('deleteTemplate') + '</button>';
      return '<tr' + selectedRow + '><td><button class="link" data-action="select-template" data-code="' + escapeHtml(template.code) + '">' + escapeHtml(template.code) + '</button></td>' +
        '<td>' + description + '</td><td>' + escapeHtml(template.active ? t('yes') : t('no')) + '</td>' +
        '<td>' + deleteAction + '</td></tr>';
    }).join('');

    state.designerSection = normalizeDesignerSection(state.designerSection);
    app.innerHTML = [
      renderDesignerMenu(),
      '<div class="designer-main">',
      renderDesignerActionBar(selected),
      renderNotice(state.message),
      renderTemplateContext(selected),
      renderDesignerSection(selected, config, templateRows),
      '</div>'
    ].join('');
    hydrateVisualizationRowGroupOptions(app);
    applyObjectPathFilter(app);
  }

  function hydrateVisualizationRowGroupOptions(container) {
    Array.prototype.slice.call((container || document).querySelectorAll('[data-visualization-row-groups]')).forEach(function (groupContainer) {
      var options = visualizationColumnOptionsHtmlForRowGroup(groupContainer);
      Array.prototype.slice.call(groupContainer.querySelectorAll('[data-visualization-field="rowGroupBy"]')).forEach(function (select) {
        var selected = select.value;
        if (select.options && select.options.length > 1) return;
        select.innerHTML = options;
        select.value = selected;
      });
    });
  }

  function renderGuide() {
    return [
      '<section class="section">',
      '<h2>' + t('guideTitle') + '</h2>',
      '<div class="guide-grid">',
      '<div class="guide-card"><h3>' + t('guideTemplateTitle') + '</h3><p>' + t('guideTemplateText') + '</p></div>',
      '<div class="guide-card"><h3>' + t('guideSpecTitle') + '</h3><p>' + t('guideSpecText') + '</p></div>',
      '<div class="guide-card"><h3>' + t('guideViewTitle') + '</h3><p>' + t('guideViewText') + '</p></div>',
      '</div>',
      '<h3>' + t('guideStepsTitle') + '</h3>',
      '<ol class="steps"><li>' + t('guideStep1') + '</li><li>' + t('guideStep2') + '</li><li>' + t('guideStep3') + '</li><li>' + t('guideStep4') + '</li></ol>',
      '<h3>' + t('guideUrlTitle') + '</h3>',
      '<p><span class="code-inline">' + escapeHtml(t('directRuntimeUrl')) + '</span></p>',
      '<p class="muted">' + t('guideUrlText') + ' ' + t('permissionNote') + '</p>',
      '</section>'
    ].join('');
  }

  function renderBuilder() {
    var spec = state.selectedTemplate && state.selectedTemplate.spec ? state.selectedTemplate.spec : defaultSpec();
    var values = inferBuilderStateFromSpec(spec);
    var selectedClass = state.selectedClass || values.className || values.referenceClass || '';
    var kind = state.builderKind || values.kind || 'classes';
    return [
      '<section class="section" id="cmdp-builder"><h2>' + t('builder') + '</h2><div class="row">',
      '<label>' + t('preset') + '<select id="cmdp-builder-kind">',
      '<option value="classes"' + (kind === 'classes' ? ' selected' : '') + '>' + t('classesByAttribute') + '</option>',
      '<option value="domainTraversal"' + (kind === 'domainTraversal' ? ' selected' : '') + '>' + t('domainTraversal') + '</option>',
      '<option value="attributeComparison"' + (kind === 'attributeComparison' ? ' selected' : '') + '>' + t('attributeComparison') + '</option>',
      '<option value="setOperations"' + (kind === 'setOperations' ? ' selected' : '') + '>' + t('setOperations') + '</option>',
      '</select></label>',
      '<label>' + t('attributeType') + '<input id="cmdp-builder-attr-type" value="' + escapeHtml(values.attrType || 'reference') + '"></label>',
      '<label>' + t('className') + '<input id="cmdp-builder-class-name" value="' + escapeHtml(selectedClass) + '"></label>',
      '<label>' + t('depth') + '<input id="cmdp-builder-depth" value="' + escapeHtml(values.depth || '1') + '"></label>',
      '<label>' + t('referenceClass') + '<input id="cmdp-builder-reference-class" value="' + escapeHtml(values.referenceClass || selectedClass) + '"></label>',
      '<label>' + t('rightType') + '<input id="cmdp-builder-right-type" value="' + escapeHtml(values.rightType || 'string') + '"></label>',
      '<button data-action="apply-builder">' + t('apply') + '</button>',
      '</div></section>'
    ].join('');
  }

  function normalizeParamRow(name, definition) {
    var param = definition && typeof definition === 'object' && !Array.isArray(definition)
      ? definition
      : { type: definition || 'string' };
    return {
      name: name,
      type: param.type || 'string',
      required: Boolean(param.required),
      defaultValue: param.default !== undefined ? param.default : (param.defaultValue !== undefined ? param.defaultValue : ''),
      example: param.example !== undefined ? param.example : '',
      description: param.description || ''
    };
  }

  function getParamRows(spec) {
    var params = spec && spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {};
    return Object.keys(params).sort().map(function (name) {
      return normalizeParamRow(name, params[name]);
    });
  }

  function renderParamTypeOptions(type) {
    var types = ['string', 'integer', 'number', 'boolean', 'date', 'dateTime'];
    return types.map(function (item) {
      return '<option value="' + item + '"' + (item === type ? ' selected' : '') + '>' + item + '</option>';
    }).join('');
  }

  function renderParamEditorRow(row) {
    row = row || {};
    return [
      '<tr data-param-row>',
      '<td><input data-param-field="name" value="' + escapeHtml(row.name || '') + '"></td>',
      '<td><select data-param-field="type">' + renderParamTypeOptions(row.type || 'string') + '</select></td>',
      '<td><input data-param-field="required" type="checkbox" ' + (row.required ? 'checked' : '') + '></td>',
      '<td><input data-param-field="default" value="' + escapeHtml(row.defaultValue == null ? '' : String(row.defaultValue)) + '"></td>',
      '<td><input data-param-field="example" value="' + escapeHtml(row.example == null ? '' : String(row.example)) + '"></td>',
      '<td><input data-param-field="description" value="' + escapeHtml(row.description || '') + '"></td>',
      '<td><button data-action="clear-param-row">' + t('clear') + '</button></td>',
      '</tr>'
    ].join('');
  }

  function paramRowHasValue(row) {
    return Boolean(row && (
      String(row.name || '').trim() ||
      String(row.defaultValue === undefined || row.defaultValue === null ? '' : row.defaultValue).trim() ||
      String(row.example === undefined || row.example === null ? '' : row.example).trim() ||
      String(row.description || '').trim() ||
      row.required
    ));
  }

  function getParamRowsForEditor(selected) {
    var rows = Array.isArray(state.paramRowsDraft)
      ? state.paramRowsDraft.slice()
      : getParamRows((selected && selected.spec) || defaultSpec());
    if (!rows.length || paramRowHasValue(rows[rows.length - 1])) rows.push({});
    return rows;
  }

  function renderParamsEditor(selected) {
    var rows = getParamRowsForEditor(selected).map(renderParamEditorRow).join('');
    return [
      '<section class="section" id="cmdp-params-editor"><h2>' + t('paramsEditor') + '</h2>',
      '<p class="muted">' + t('paramsEditorHelp') + '</p>',
      '<table class="compact"><thead><tr>',
      '<th>' + t('paramName') + '</th>',
      '<th>' + t('paramType') + '</th>',
      '<th>' + t('paramRequired') + '</th>',
      '<th>' + t('paramDefault') + '</th>',
      '<th>' + t('paramExample') + '</th>',
      '<th>' + t('paramDescription') + '</th>',
      '<th></th>',
      '</tr></thead><tbody id="cmdp-param-rows">',
      rows,
      '</tbody></table>',
      '</section>'
    ].join('');
  }

  function isExtractionStep(step) {
    return step && (step.type === 'extractVariables' || step.type === 'extract');
  }

  function getExtractionStep(spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    return steps.find(isExtractionStep) || {};
  }

  function isDataSelectionStep(step) {
    return step && step.type === 'selectCards';
  }

  function getDataSelectionStep(spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    return steps.find(isDataSelectionStep) || {};
  }

  function renderParamOptions(selectedName, spec) {
    var rows = getParamRows(spec || {});
    var names = rows.map(function (row) { return row.name; }).filter(Boolean);
    if (selectedName && names.indexOf(selectedName) === -1) names.unshift(selectedName);
    return names.map(function (name) {
      return '<option value="' + escapeHtml(name) + '"' + (name === selectedName ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
    }).join('');
  }

  function viewComposerGeneratedAliases(spec) {
    var visual = getStoredVisualModel(spec || {}, 'viewComposer');
    var outputAlias = visual && visual.output && visual.output.alias;
    return outputAlias ? [outputAlias] : [];
  }

  function aliasDisplayLabel(alias, spec) {
    var name = String(alias || '');
    if (!name) return '';
    var visual = getStoredVisualModel(spec || {}, 'objectGroup');
    var selections = visual && Array.isArray(visual.selections) ? visual.selections : [];
    var selection = selections.find(function (item) {
      return item && (item.alias === name || item.as === name || item.output && item.output.alias === name);
    });
    if (selection) return selection.name || selection.title || selection.output && selection.output.title || name;
    var objectAliasMatch = /^objects(\d+)?$/.exec(name);
    if (objectAliasMatch) {
      var number = objectAliasMatch[1] ? Number(objectAliasMatch[1]) : 1;
      return defaultObjectSelectionName(Number.isFinite(number) && number > 0 ? number - 1 : 0);
    }
    var outputAlias = visual && visual.output && visual.output.alias;
    if (outputAlias && outputAlias === name) return t('viewComposerObjectsAlias') + ' (' + name + ')';
    var objectMatching = getStoredVisualModel(spec || {}, 'objectMatching');
    if (objectMatching && objectMatching.output && objectMatching.output.alias === name) {
      return t('extractionFinalResult') + ' (' + name + ')';
    }
    var matchingFinalStep = getObjectMatchingFinalStep(spec || {});
    if (matchingFinalStep && matchingFinalStep.as === name) {
      return t('extractionFinalResult') + ' (' + name + ')';
    }
    var relationVisual = getStoredVisualModel(spec || {}, 'relationExpansion');
    if (relationVisual && relationVisual.output && relationVisual.output.alias === name) {
      return t('extractionFinalResult') + ' (' + name + ')';
    }
    var relationStep = getRelationExpansionStep(spec || {});
    if (relationStep && relationStep.as === name) {
      return t('extractionFinalResult') + ' (' + name + ')';
    }
    return name;
  }

  function displayTitleForResult(name, title) {
    var resultName = String(name || '');
    var resultTitle = String(title || '');
    if (resultName === 'objects' && (!resultTitle || /^objects?$/i.test(resultTitle))) {
      return t('viewComposerObjectsAlias');
    }
    return resultTitle || resultName;
  }

  function isRawObjectGroupTableName(name) {
    return /^objects(\d+)?$/.test(String(name || ''));
  }

  function resultTablesForSpec(spec) {
    var result = spec && spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    return Array.isArray(result.tables) ? result.tables : [];
  }

  function findResultTableByName(spec, name) {
    var resultName = String(name || '').trim();
    if (!resultName) return null;
    return resultTablesForSpec(spec).find(function (table) {
      return table && table.name === resultName;
    }) || null;
  }

  function getViewComposerOutputAlias(spec) {
    var visual = getStoredVisualModel(spec || {}, 'viewComposer');
    return visual && visual.output && visual.output.alias || '';
  }

  function getObjectMatchingOutputAlias(spec) {
    var matchingStep = getObjectMatchingFinalStep(spec || {});
    if (matchingStep && matchingStep.as) return matchingStep.as;
    var objectMatching = getStoredVisualModel(spec || {}, 'objectMatching');
    return objectMatching && objectMatching.output && objectMatching.output.alias || '';
  }

  function getRelationOutputAlias(spec) {
    var relationStep = getRelationExpansionStep(spec || {});
    if (relationStep && relationStep.as) return relationStep.as;
    var relationVisual = getStoredVisualModel(spec || {}, 'relationExpansion');
    return relationVisual && relationVisual.output && relationVisual.output.alias || '';
  }

  function finalExtractionAliases(spec) {
    spec = spec || defaultSpec();
    var aliases = [];
    function add(alias) {
      var text = String(alias || '').trim();
      if (text && aliases.indexOf(text) === -1) aliases.push(text);
    }
    add(getObjectMatchingOutputAlias(spec));
    add(getRelationOutputAlias(spec));
    add(getViewComposerOutputAlias(spec));
    if (aliases.length) {
      add(finalBaseResultAlias(spec));
      add(finalPresentationResultAlias(spec));
    }
    return aliases;
  }

  function finalBaseResultAlias(spec) {
    spec = spec || defaultSpec();
    var matchingAlias = getObjectMatchingOutputAlias(spec);
    if (matchingAlias) return matchingAlias;
    var relationAlias = getRelationOutputAlias(spec);
    if (relationAlias) return relationAlias;

    var viewAlias = getViewComposerOutputAlias(spec);
    var prepared = resultTablesForSpec(spec).filter(function (table) {
      return table && table.name && !isRawObjectGroupTableName(table.name) && table.name !== viewAlias;
    });
    if (prepared.length) return prepared[prepared.length - 1].name;

    var raw = resultTablesForSpec(spec).filter(function (table) { return table && table.name; });
    return raw.length ? raw[raw.length - 1].name : '';
  }

  function finalPresentationResultAlias(spec) {
    var viewAlias = getViewComposerOutputAlias(spec || {});
    if (viewAlias && findResultTableByName(spec, viewAlias)) return viewAlias;
    return finalBaseResultAlias(spec);
  }

  function finalResultTableForSpec(spec, presentationResult) {
    var alias = presentationResult ? finalPresentationResultAlias(spec) : finalBaseResultAlias(spec);
    return findResultTableByName(spec, alias);
  }

  function visibleResultTables(tables) {
    var source = Array.isArray(tables) ? tables : [];
    var prepared = source.filter(function (table) {
      return table && table.name && !isRawObjectGroupTableName(table.name);
    });
    if (prepared.length) return [prepared[prepared.length - 1]];
    return source.length ? [source[source.length - 1]] : [];
  }

  function visualizationTablesForSpec(spec) {
    var table = finalResultTableForSpec(spec || defaultSpec(), true);
    return table ? [table] : [];
  }

  function groupTitleToken(name) {
    var token = String(name || '').trim();
    return token ? '$' + '{' + token + '}' : '';
  }

  function columnOptionLabel(columns, selected) {
    var value = String(selected || '').trim();
    if (!value) return '';
    var options = (Array.isArray(columns) ? columns : []).map(normalizeColumnOption).filter(function (item) { return item.value; });
    var option = options.find(function (item) { return item.value === value; });
    return option && option.label || value;
  }

  function defaultGroupTitleTemplate(column, columns) {
    return groupTitleToken(columnOptionLabel(columns, column) || column || '');
  }

  function getPresentationModel(spec) {
    var result = spec && spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    var stored = getStoredVisualModel(spec || {}, 'presentation') || {};
    var presentation = result.presentation && typeof result.presentation === 'object' && !Array.isArray(result.presentation)
      ? result.presentation
      : (stored.presentation && typeof stored.presentation === 'object' && !Array.isArray(stored.presentation) ? stored.presentation : stored);
    var tableSettings = {};
    var storedTables = Array.isArray(presentation.tables) ? presentation.tables : [];
    storedTables.forEach(function (item) {
      if (item && item.name) tableSettings[item.name] = item;
    });
    var resultTables = Array.isArray(result.tables) ? result.tables : [];
    resultTables.forEach(function (table) {
      if (!table || !table.name) return;
      var existing = tableSettings[table.name] || {};
      var title = table.title || table.label || existing.title || '';
      var legacyTitleParam = table.titleParam || existing.titleParam || '';
      if (!title && legacyTitleParam) title = '$' + '{param.' + legacyTitleParam + '}';
      tableSettings[table.name] = Object.assign({}, existing, table.presentation || {}, {
        name: table.name,
        title: title,
        titleParam: table.titleParam || existing.titleParam || '',
        titleAlign: (table.presentation && table.presentation.titleAlign) || table.titleAlign || existing.titleAlign || 'left',
        mode: table.mode || table.view || existing.mode || 'table'
      });
    });
    var firstTableEmptyText = '';
    resultTables.some(function (table) {
      firstTableEmptyText = table && table.emptyText ? table.emptyText : '';
      return Boolean(firstTableEmptyText);
    });
    return {
      emptyText: result.emptyText || presentation.emptyText || firstTableEmptyText || DEFAULT_EMPTY_RESULT_TEXT,
      permissionDeniedText: result.permissionDeniedText || presentation.permissionDeniedText || DEFAULT_PERMISSION_DENIED_TEXT,
      fontSize: presentation.fontSize || 'normal',
      density: presentation.density || 'normal',
      zebra: presentation.zebra !== false,
      filters: presentation.filters !== false,
      sortable: presentation.sortable !== false,
      tableSettings: tableSettings,
      tables: resultTables.map(function (table) { return tableSettings[table.name] || { name: table.name }; })
    };
  }

  function normalizeColumnOption(option) {
    if (option && typeof option === 'object' && !Array.isArray(option)) {
      var value = String(option.value || option.name || option.field || '').trim();
      return {
        value: value,
        label: String(option.label || option.title || value).trim() || value
      };
    }
    var text = String(option || '').trim();
    return { value: text, label: text };
  }

  function renderColumnSelectOptions(columns, selected, emptyLabel) {
    var options = (Array.isArray(columns) ? columns : []).map(normalizeColumnOption).filter(function (item) { return item.value; });
    if (selected && !options.some(function (item) { return item.value === selected; })) {
      options.unshift({ value: selected, label: selected });
    }
    return '<option value="">' + escapeHtml(emptyLabel || '') + '</option>' + options.filter(Boolean).map(function (item) {
      var tokenLabel = String(item.label || item.value);
      var label = tokenLabel;
      if (label && label !== item.value) label += ' (' + item.value + ')';
      return '<option value="' + escapeHtml(item.value) + '" data-token-label="' + escapeHtml(tokenLabel || item.value) + '"' + (item.value === selected ? ' selected' : '') + '>' + escapeHtml(label || item.value) + '</option>';
    }).join('');
  }

  function splitConfiguredList(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) { return String(item || '').trim(); }).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value.split(',').map(function (item) { return item.trim(); }).filter(Boolean);
    }
    return value === undefined || value === null ? [] : [String(value).trim()].filter(Boolean);
  }

  function sourceClassForAlias(spec, alias) {
    var name = String(alias || '');
    if (!name) return '';
    if (name === 'baaObjects') return 'BAA';
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    var baaStep = steps.find(function (step) {
      return step && step.type === 'baaPlanObjects' && step.as === name;
    });
    if (baaStep && baaStep.objectAlias) return baaSourceClassName(baaStep.objectAlias);
    if (baaStep) return 'BAA';
    var enrichStep = steps.find(function (step) {
      return step && step.type === 'enrichRows' && step.as === name && step.from;
    });
    if (enrichStep) return sourceClassForAlias(spec, enrichStep.from);

    var matchStep = steps.find(function (step) {
      return step && step.type === 'matchRows' && step.as === name && step.from;
    });
    if (matchStep) return sourceClassForAlias(spec, matchStep.from);

    var selection = steps.find(function (step) {
      return step && step.type === 'selectCards' && step.as === name;
    });
    if (selection && selection.className && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(selection.className))) {
      return selection.className;
    }

    var relation = steps.find(function (step) {
      return step && step.type === 'expandRelations' && step.as === name;
    });
    var relationTargets = relation ? splitConfiguredList(relation.targetClass) : [];
    if (relationTargets.length === 1) return relationTargets[0];

    var objectVisual = getStoredVisualModel(spec || {}, 'objectGroup');
    var objectSelections = objectVisual && Array.isArray(objectVisual.selections) ? objectVisual.selections : [];
    var objectSelection = objectSelections.find(function (item) {
      return item && (item.alias === name || item.as === name || item.output && item.output.alias === name);
    });
    if (objectSelection) return objectSelection.className || objectSelection.source && objectSelection.source.className || '';
    if (objectVisual && objectVisual.output && objectVisual.output.alias === name && objectVisual.source) {
      return objectVisual.source.className || '';
    }
    if (name === 'objects' && objectVisual && objectVisual.source) return objectVisual.source.className || '';

    var relationVisual = getStoredVisualModel(spec || {}, 'relationExpansion');
    if (relationVisual && relationVisual.output && relationVisual.output.alias === name && relationVisual.relation) {
      return relationVisual.relation.targetClass || '';
    }

    return '';
  }

  function renderSourceAliasOptions(selectedName, spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    var aliases = steps.map(function (step) { return step && !isDataSelectionStep(step) ? step.as : ''; }).filter(Boolean);
    if (selectedName && aliases.indexOf(selectedName) === -1) aliases.unshift(selectedName);
    return '<option value="">' + t('dataSelectionNoSource') + '</option>' + aliases.map(function (name) {
      return '<option value="' + escapeHtml(name) + '"' + (name === selectedName ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
    }).join('');
  }

  function renderAnyAliasOptions(selectedName, spec) {
    var aliases = [];
    var generatedAliases = viewComposerGeneratedAliases(spec);
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    steps.forEach(function (step) {
      if (step && step.purpose === 'viewComposer') return;
      if (step && step.as && aliases.indexOf(step.as) === -1) aliases.push(step.as);
    });
    var tables = spec && spec.result && Array.isArray(spec.result.tables) ? spec.result.tables : [];
    tables.forEach(function (table) {
      if (table && generatedAliases.indexOf(table.name) !== -1) return;
      if (table && table.name && aliases.indexOf(table.name) === -1) aliases.push(table.name);
    });
    if (selectedName && aliases.indexOf(selectedName) === -1) aliases.unshift(selectedName);
    return '<option value=""></option>' + aliases.map(function (name) {
      return '<option value="' + escapeHtml(name) + '"' + (name === selectedName ? ' selected' : '') + '>' + escapeHtml(aliasDisplayLabel(name, spec)) + '</option>';
    }).join('');
  }

  function tableColumnsFromRows(rows) {
    var columns = [];
    (rows || []).forEach(function (row) {
      Object.keys(row || {}).forEach(function (column) {
        if (columns.indexOf(column) === -1) columns.push(column);
      });
    });
    return columns;
  }

  function renderPlainDataTable(table) {
    table = table || {};
    var rows = Array.isArray(table.rows) ? table.rows : [];
    var columns = Array.isArray(table.columns) && table.columns.length ? table.columns : tableColumnsFromRows(rows);
    if (!columns.length) columns = tableColumnsFromRows(rows);
    var head = columns.map(function (column) {
      return '<th>' + escapeHtml(column) + '</th>';
    }).join('');
    var body = rows.map(function (row) {
      return '<tr>' + columns.map(function (column) {
        var value = row && row[column] !== undefined && row[column] !== null ? row[column] : '';
        return '<td>' + escapeHtml(String(value)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<table class="compact"><thead><tr>' + head + '</tr></thead><tbody>' + (body || '<tr><td colspan="' + Math.max(columns.length, 1) + '">' + escapeHtml(table.emptyText || t('noRows')) + '</td></tr>') + '</tbody></table>';
  }

  function extractionResultOptions(spec, tables) {
    var result = [];
    var seen = {};
    function add(name, label) {
      var text = String(name || '').trim();
      if (!text || seen[text]) return;
      seen[text] = true;
      result.push({ name: text, label: label || aliasDisplayLabel(text, spec) || text });
    }
    var relation = getStoredVisualModel(spec || {}, 'relationExpansion');
    var relationStep = getRelationExpansionStep(spec || {});
    var objectMatching = getStoredVisualModel(spec || {}, 'objectMatching');
    var matchingFinalStep = getObjectMatchingFinalStep(spec || {});
    finalExtractionAliases(spec).forEach(function (alias) {
      add(alias, t('extractionFinalResult') + ' (' + alias + ')');
    });
    if (hasBaaInputSpec(spec || {})) {
      add('baaObjects', 'BAA candidates');
    }
    (Array.isArray(tables) ? tables : []).forEach(function (table) {
      if (!table || !table.name) return;
      var isFinalRelation = relation && relation.output && relation.output.alias === table.name || relationStep && relationStep.as === table.name;
      var isFinalMatching = objectMatching && objectMatching.output && objectMatching.output.alias === table.name || matchingFinalStep && matchingFinalStep.as === table.name;
      add(table.name, isFinalRelation || isFinalMatching ? t('extractionFinalResult') + ' (' + table.name + ')' : (table.title || table.label || aliasDisplayLabel(table.name, spec)));
    });
    if (objectMatching && objectMatching.output && objectMatching.output.alias) {
      add(objectMatching.output.alias, t('extractionFinalResult') + ' (' + objectMatching.output.alias + ')');
    }
    if (matchingFinalStep && matchingFinalStep.as) {
      add(matchingFinalStep.as, t('extractionFinalResult') + ' (' + matchingFinalStep.as + ')');
    }
    if (relation && relation.output && relation.output.alias) {
      add(relation.output.alias, t('extractionFinalResult') + ' (' + relation.output.alias + ')');
    }
    if (relationStep && relationStep.as) {
      add(relationStep.as, t('extractionFinalResult') + ' (' + relationStep.as + ')');
    }
    var objectVisual = getStoredVisualModel(spec || {}, 'objectGroup');
    var selections = objectVisual && Array.isArray(objectVisual.selections) ? objectVisual.selections : [];
    selections.forEach(function (selection, index) {
      var alias = selection.alias || selection.as || objectSelectionAlias(index);
      add(alias, selection.name || selection.title || defaultObjectSelectionName(index));
    });
    return result;
  }

  function preferredExtractionResultName(spec, tables, selectedName, options) {
    var resultOptions = options || extractionResultOptions(spec, tables);
    var selected = String(selectedName || '').trim();
    if (selected && resultOptions.some(function (item) { return item.name === selected; })) return selected;
    var finalAliases = finalExtractionAliases(spec);
    for (var index = 0; index < finalAliases.length; index += 1) {
      var alias = finalAliases[index];
      if (resultOptions.some(function (item) { return item.name === alias; })) return alias;
    }
    return resultOptions.length ? resultOptions[0].name : '';
  }

  function renderExtractionResultOptions(selectedName, spec, tables) {
    var options = extractionResultOptions(spec, tables);
    selectedName = preferredExtractionResultName(spec, tables, selectedName, options);
    return options.map(function (item) {
      return '<option value="' + escapeHtml(item.name) + '"' + (item.name === selectedName ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>';
    }).join('');
  }

  function renderExtractionPreview(spec) {
    var result = state.extractionPreview;
    if (!result) return '';
    if (!result.ok) return '<div class="notice error">' + escapeHtml(errorText(result)) + '</div>';
    var tables = result.json && result.json.result && Array.isArray(result.json.result.tables) ? result.json.result.tables : [];
    if (!tables.length || !tables.some(function (table) { return table && Array.isArray(table.rows) && table.rows.length; })) {
      return '<div class="notice">' + t('extractionNoRows') + '</div>';
    }
    var selectedName = preferredExtractionResultName(spec, tables, state.extractionSource);
    var table = tables.find(function (item) { return item && item.name === selectedName; }) || tables[0];
    return table ? renderPlainDataTable(table) : '';
  }

  function renderExtractionEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var previewTables = state.extractionPreview && state.extractionPreview.json && state.extractionPreview.json.result && Array.isArray(state.extractionPreview.json.result.tables)
      ? state.extractionPreview.json.result.tables
      : [];
    var specTables = spec && spec.result && Array.isArray(spec.result.tables) ? spec.result.tables : [];
    var optionTables = previewTables.length ? previewTables : specTables;
    var options = renderExtractionResultOptions(state.extractionSource, spec, optionTables);
    return [
      '<section class="section" id="cmdp-extraction-editor"><h2>' + t('extractionEditor') + '</h2>',
      '<div class="row">',
      options ? '<label>' + t('extractionResultSource') + '<select id="cmdp-extraction-source">' + options + '</select></label>' : '',
      '</div>',
      renderExtractionPreview(spec),
      '</section>'
    ].join('');
  }

  function ensureExtractionPreviewTable(spec, alias) {
    var name = String(alias || '').trim();
    if (!name) return spec;
    spec.result = spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    spec.result.tables = Array.isArray(spec.result.tables) ? spec.result.tables.slice() : [];
    if (!spec.result.tables.some(function (table) { return table && table.name === name; })) {
      spec.result.tables.push({ name: name });
    }
    return spec;
  }

  function renderFilterOperatorOptions(selected) {
    var operators = ['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'in', 'exists', 'notExists'];
    return operators.map(function (operator) {
      return '<option value="' + operator + '"' + (operator === selected ? ' selected' : '') + '>' + operator + '</option>';
    }).join('');
  }

  function renderSelectionFilterRow(filter) {
    filter = filter || {};
    return [
      '<tr data-selection-filter-row>',
      '<td><input data-selection-filter-field="attribute" value="' + escapeHtml(filter.attribute || filter.column || '') + '"></td>',
      '<td><select data-selection-filter-field="op">' + renderFilterOperatorOptions(filter.op || 'equals') + '</select></td>',
      '<td><input data-selection-filter-field="value" value="' + escapeHtml(filter.value == null ? '' : String(filter.value)) + '"></td>',
      '<td><input data-selection-filter-field="valueParam" value="' + escapeHtml(filter.valueParam || filter.valuesParam || '') + '"></td>',
      '<td><input data-selection-filter-field="valueColumn" value="' + escapeHtml(filter.valueColumn || filter.sourceColumn || filter.fromColumn || '') + '"></td>',
      '<td><button data-action="clear-selection-filter-row">' + t('clear') + '</button></td>',
      '</tr>'
    ].join('');
  }

  function renderDataSelectionEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var step = getDataSelectionStep(spec);
    var filters = Array.isArray(step.filters || step.where) ? (step.filters || step.where) : [];
    var filterRows = filters.map(renderSelectionFilterRow).join('');
    return [
      '<section class="section" id="cmdp-data-selection-editor"><h2>' + t('dataSelectionEditor') + '</h2>',
      '<p class="muted">' + t('dataSelectionEditorHelp') + '</p>',
      '<div class="row">',
      '<label>' + t('dataSelectionAlias') + '<input id="cmdp-select-as" value="' + escapeHtml(step.as || 'cards') + '"></label>',
      '<label>' + t('dataSelectionSource') + '<select id="cmdp-select-from">' + renderSourceAliasOptions(step.from || '', spec) + '</select></label>',
      '<label>' + t('dataSelectionClassName') + '<input id="cmdp-select-class-name" value="' + escapeHtml(step.className || '') + '"></label>',
      '<label>' + t('dataSelectionClassParam') + '<input id="cmdp-select-class-param" value="' + escapeHtml(step.classNameParam || '') + '" placeholder="className"></label>',
      '<label>' + t('dataSelectionClassColumn') + '<input id="cmdp-select-class-column" value="' + escapeHtml(step.classColumn || '') + '"></label>',
      '<label>' + t('dataSelectionLimit') + '<input id="cmdp-select-limit" value="' + escapeHtml(step.limit == null ? '' : String(step.limit)) + '"></label>',
      '</div>',
      '<h3>' + t('dataSelectionFilters') + '</h3>',
      '<table class="compact"><thead><tr>',
      '<th>' + t('filterAttribute') + '</th>',
      '<th>' + t('filterOperator') + '</th>',
      '<th>' + t('filterValue') + '</th>',
      '<th>' + t('filterParam') + '</th>',
      '<th>' + t('filterColumn') + '</th>',
      '<th></th>',
      '</tr></thead><tbody id="cmdp-selection-filter-rows">',
      filterRows,
      renderSelectionFilterRow({}),
      '</tbody></table>',
      '</section>'
    ].join('');
  }

  function renderVisualizationModeOptions(selected) {
    var modes = [
      { value: 'table', label: t('visualizationTable') },
      { value: 'compact', label: t('visualizationCompact') },
      { value: 'keyValue', label: t('visualizationKeyValue') }
    ];
    return modes.map(function (mode) {
      return '<option value="' + mode.value + '"' + (mode.value === selected ? ' selected' : '') + '>' + escapeHtml(mode.label) + '</option>';
    }).join('');
  }

  function normalizeTitleAlign(value) {
    var align = String(value || 'left').trim();
    return ['left', 'center', 'right'].indexOf(align) === -1 ? 'left' : align;
  }

  function renderTitleAlignOptions(selected) {
    selected = normalizeTitleAlign(selected);
    var options = [
      { value: 'left', label: t('visualizationAlignLeft') },
      { value: 'center', label: t('visualizationAlignCenter') },
      { value: 'right', label: t('visualizationAlignRight') }
    ];
    return options.map(function (item) {
      return '<option value="' + item.value + '"' + (item.value === selected ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>';
    }).join('');
  }

  function normalizeVisualizationRowGroupBy(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) { return String(item || '').trim(); }).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value.split(',').map(function (item) { return item.trim(); }).filter(Boolean);
    }
    return [];
  }

  function renderVisualizationRowGroupRow(columns, selected, index) {
    var label = index > 0 ? t('visualizationRowGroupNextBy') : t('visualizationRowGroupBy');
    return '<div class="visual-row-group" data-visualization-row-group>' +
      '<label><span data-row-group-label>' + label + '</span><select data-visualization-field="rowGroupBy">' + renderColumnSelectOptions(columns, selected || '', '') + '</select></label>' +
      '<button data-action="clear-visual-row-group" type="button">' + t('clear') + '</button>' +
      '</div>';
  }

  function renderVisualizationRowGroupRows(columns, settings) {
    var rowGroups = normalizeVisualizationRowGroupBy(settings && settings.rowGroupBy);
    if (!rowGroups.length) rowGroups = [''];
    return rowGroups.map(function (column, index) {
      return renderVisualizationRowGroupRow(columns, column, index);
    }).join('');
  }

  function normalizeColumnLinks(value) {
    var result = {};
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    Object.keys(source).forEach(function (column) {
      var item = source[column] || {};
      var textTemplate = String(item.textTemplate || item.labelTemplate || '$' + '{mysource.value}').trim() || '$' + '{mysource.value}';
      var target = item.target === 'blank' || item.target === '_blank' ? 'blank' : 'self';
      if (item.mode !== 'link' && !item.urlTemplate && textTemplate === '$' + '{mysource.value}' && target === 'self') return;
      result[column] = {
        mode: item.mode === 'link' ? 'link' : 'text',
        urlTemplate: String(item.urlTemplate || item.url || '').trim(),
        textTemplate: textTemplate,
        target: target
      };
    });
    return result;
  }

  function renderVisualizationLinkModeOptions(selected) {
    return '<option value="text"' + (selected !== 'link' ? ' selected' : '') + '>' + t('visualizationLinkModeText') + '</option>' +
      '<option value="link"' + (selected === 'link' ? ' selected' : '') + '>' + t('visualizationLinkModeLink') + '</option>';
  }

  function renderVisualizationLinkTargetOptions(selected) {
    return '<option value="self"' + (selected !== 'blank' ? ' selected' : '') + '>' + t('visualizationLinkTargetSelf') + '</option>' +
      '<option value="blank"' + (selected === 'blank' ? ' selected' : '') + '>' + t('visualizationLinkTargetBlank') + '</option>';
  }

  function renderVisualizationColumnLinks(columns, settings) {
    var links = normalizeColumnLinks(settings && (settings.columnLinks || settings.links));
    var rows = (Array.isArray(columns) ? columns : []).map(normalizeColumnOption).filter(function (item) { return item.value; }).map(function (column) {
      var link = links[column.value] || {};
      return '<tr data-visualization-link-row data-column="' + escapeHtml(column.value) + '">' +
        '<td>' + escapeHtml(column.label || column.value) + '<input type="hidden" data-visualization-link-field="column" value="' + escapeHtml(column.value) + '"></td>' +
        '<td><select data-visualization-link-field="mode">' + renderVisualizationLinkModeOptions(link.mode || 'text') + '</select></td>' +
        '<td><input data-visualization-link-field="urlTemplate" value="' + escapeHtml(link.urlTemplate || '') + '" placeholder="/cmdbuild/ui/#classes/$' + '{mysource.sourceClass}/cards/$' + '{mysource.sourceId}"></td>' +
        '<td><input data-visualization-link-field="textTemplate" value="' + escapeHtml(link.textTemplate || '$' + '{mysource.value}') + '"></td>' +
        '<td><select data-visualization-link-field="target">' + renderVisualizationLinkTargetOptions(link.target || 'self') + '</select></td>' +
        '</tr>';
    }).join('');
    return [
      '<table class="compact visualization-link-table"><thead><tr><th>' + t('visualizationLinkColumn') + '</th><th>' + t('visualizationLinkMode') + '</th><th>' + t('visualizationLinkUrlTemplate') + '</th><th>' + t('visualizationLinkTextTemplate') + '</th><th>' + t('visualizationLinkTarget') + '</th></tr></thead><tbody>',
      rows || '<tr><td colspan="5">' + t('visualizationNoColumns') + '</td></tr>',
      '</tbody></table>'
    ].join('');
  }

  function renderVisualizationLinkExamples() {
    return [
      '<details class="help-details" style="margin-top:8px">',
      '<summary>' + t('visualizationLinkExamples') + '</summary>',
      '<div class="muted" style="margin-top:8px">' + escapeHtml(t('visualizationLinkExamplesHelp')) + '</div>',
      '<ul class="steps">',
      '<li><span class="code-inline">/cmdbuild/ui/#classes/$' + '{mysource.sourceClass}/cards/$' + '{mysource.sourceId}</span></li>',
      '<li><span class="code-inline">$' + '{mysource.sourceURLВыборка1}</span></li>',
      '<li><span class="code-inline">$' + '{mysource.sourceURLSelection2}</span></li>',
      '<li><span class="code-inline">https://monitoring.local/host/$' + '{row.Выборка2.ipaddress}</span></li>',
      '<li><span class="code-inline">$' + '{mysource.value}</span> ' + escapeHtml(t('visualizationLinkTextTemplate')) + '</li>',
      '<li><span class="code-inline">/wiki/$' + '{param.city}/$' + '{mysource.value}</span></li>',
      '</ul>',
      '</details>'
    ].join('');
  }

  function objectSelectionPrefixForAlias(spec, alias) {
    var visual = getStoredVisualModel(spec || {}, 'objectGroup');
    var selections = visual && Array.isArray(visual.selections) ? visual.selections : [];
    var found = selections.find(function (selection, index) {
      var selectionAlias = selection && (selection.alias || selection.as || selection.output && selection.output.alias) || objectSelectionAlias(index);
      return selectionAlias === alias;
    });
    if (found) return objectSelectionDisplayNameForAlias(spec || defaultSpec(), alias);
    if (alias && /^objects(\d+)?$/.test(String(alias))) return objectSelectionDisplayNameForAlias(spec || defaultSpec(), alias);
    return '';
  }

  function objectSelectionPrefixForColumn(spec, columnName) {
    var name = String(columnName || '');
    var visual = getStoredVisualModel(spec || {}, 'objectGroup');
    var selections = visual && Array.isArray(visual.selections) ? visual.selections : [];
    for (var index = 0; index < selections.length; index += 1) {
      var selection = selections[index] || {};
      var alias = selection.alias || selection.as || selection.output && selection.output.alias || objectSelectionAlias(index);
      if (!alias) continue;
      var prefix = objectSelectionDisplayName(index);
      var displayPrefix = prefix + '.';
      if (name.indexOf(displayPrefix) === 0) return { prefix: prefix, field: name.slice(displayPrefix.length) };
      var ruPrefix = 'Выборка' + String(index + 1) + '.';
      if (name.indexOf(ruPrefix) === 0) return { prefix: 'Выборка' + String(index + 1), field: name.slice(ruPrefix.length) };
      var enPrefix = 'Selection' + String(index + 1) + '.';
      if (name.indexOf(enPrefix) === 0) return { prefix: 'Selection' + String(index + 1), field: name.slice(enPrefix.length) };
      if (name.indexOf(alias + '.') === 0) return { prefix: prefix, field: name.slice(alias.length + 1) };
      if (name.indexOf(alias + '_') === 0) return { prefix: prefix, field: name.slice(alias.length + 1) };
    }
    return null;
  }

  function viewComposerOutputAliasFromModel(model) {
    model = model || {};
    var explicitAlias = model.output && model.output.alias || '';
    if (explicitAlias) return explicitAlias;
    var sourceAlias = model.sourceAlias || model.source && model.source.alias || '';
    if (!sourceAlias) return '';
    var alias = sourceAlias + 'View';
    return alias === sourceAlias ? sourceAlias + '_view' : alias;
  }

  function viewComposerSourceAliasForTable(spec, tableName) {
    var name = String(tableName || '').trim();
    if (!name) return '';
    var visual = getStoredVisualModel(spec || {}, 'viewComposer');
    if (visual && viewComposerOutputAliasFromModel(visual) === name) {
      return visual.source && visual.source.alias || visual.sourceAlias || '';
    }
    if (state.viewComposerDraft && viewComposerOutputAliasFromModel(state.viewComposerDraft) === name) {
      return state.viewComposerDraft.sourceAlias || state.viewComposerDraft.source && state.viewComposerDraft.source.alias || '';
    }
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    var step = steps.find(function (item) {
      return item && item.type === 'enrichRows' && item.purpose === 'viewComposer' && item.as === name;
    });
    return step && step.from || '';
  }

  function canonicalColumnLabelsForVisualization(table, spec) {
    var labels = {};
    var sourceAlias = viewComposerSourceAliasForTable(spec || {}, table && table.name || '') || table && table.name || '';
    matchingColumnOptionRowsForOutput(spec || {}, sourceAlias).forEach(function (item) {
      if (item.value && item.label) labels[item.value] = item.label;
    });
    return labels;
  }

  function addViewComposerColumnsForVisualization(table, spec, addColumn, setLabel) {
    var tableName = table && table.name || '';
    function addModel(model) {
      if (!model || viewComposerOutputAliasFromModel(model) !== tableName) return;
      var output = model.output || model;
      (Array.isArray(output.columns) ? output.columns : []).forEach(function (column) {
        var field = typeof column === 'string'
          ? column.trim()
          : String(column && (column.field || column.path || column.as) || '').trim();
        if (!field) return;
        addColumn(field);
        var title = typeof column === 'string' ? '' : String(column.title || column.label || '').trim();
        if (title) setLabel(field, title, { fallback: true });
      });
    }
    addModel(getStoredVisualModel(spec || {}, 'viewComposer'));
    addModel(state.viewComposerDraft);
  }

  function visualizationColumnOptions(table, spec) {
    table = table || {};
    var storedLabels = table.columnLabels && typeof table.columnLabels === 'object' && !Array.isArray(table.columnLabels) ? table.columnLabels : {};
    var labels = Object.assign({}, storedLabels, canonicalColumnLabelsForVisualization(table, spec));
    var columns = [];
    var seen = {};
    function add(value) {
      var text = String(value || '').trim();
      if (!text || seen[text]) return;
      seen[text] = true;
      columns.push(text);
    }
    (Array.isArray(table.columns) ? table.columns : []).forEach(add);
    addViewComposerColumnsForVisualization(table, spec, add, function (field, label, options) {
      if (options && options.fallback && labels[field]) return;
      labels[field] = label;
    });

    var tablePrefix = objectSelectionPrefixForAlias(spec, table.name || '');
    var viewVisual = getStoredVisualModel(spec || {}, 'viewComposer');
    if (!tablePrefix && viewVisual && viewVisual.output && viewVisual.output.alias === table.name && viewVisual.source) {
      tablePrefix = objectSelectionPrefixForAlias(spec, viewVisual.source.alias || '');
    }

    var baseCounts = {};
    columns.forEach(function (column) {
      var prefixed = objectSelectionPrefixForColumn(spec, column);
      var base = labels[column] || (prefixed ? prefixed.field : column);
      baseCounts[base] = (baseCounts[base] || 0) + 1;
    });

    return columns.map(function (column) {
      var prefixed = objectSelectionPrefixForColumn(spec, column);
      var labelBase = labels[column] || (prefixed ? prefixed.field : column);
      var prefix = prefixed ? prefixed.prefix : tablePrefix;
      var duplicate = baseCounts[labelBase] > 1;
      var label = prefix && (duplicate || /^objects(\d+)?$/.test(String(table.name || '')) || prefixed)
        ? prefix + '.' + labelBase
        : labelBase;
      if (duplicate && !prefix) label += ' (' + column + ')';
      return { value: column, label: label };
    });
  }

  function normalizeViewComposerColumn(column) {
    column = column || {};
    var mode = column.multiMode || column.displayMode || column.mode || 'join';
    if (mode !== 'rows') mode = 'join';
    var separator = column.separator === undefined || column.separator === null ? ', ' : String(column.separator);
    return {
      field: column.field || column.path || '',
      title: column.title || column.label || column.field || column.path || '',
      multiMode: mode,
      separator: separator,
      emptyRow: column.emptyRow !== false
    };
  }

  function renderViewComposerMultiModeOptions(selected) {
    var modes = [
      { value: 'join', label: t('viewComposerMultiJoin') },
      { value: 'rows', label: t('viewComposerMultiRows') }
    ];
    return modes.map(function (mode) {
      return '<option value="' + mode.value + '"' + (mode.value === selected ? ' selected' : '') + '>' + escapeHtml(mode.label) + '</option>';
    }).join('');
  }

  function viewComposerColumnOptions(spec, sourceAlias, selectedField) {
    var common = ['Class', '_id', 'Code', 'Description', 'SourceCode', 'Domain', 'RelationDirection', 'RelatedClass'];
    var items = [];
    var seen = {};
    function add(value, label) {
      var text = String(value || '').trim();
      if (!text || seen[text]) return;
      seen[text] = true;
      items.push({ value: text, label: label || text });
    }
    matchingColumnOptionRowsForOutput(spec, sourceAlias).filter(Boolean).forEach(function (item) {
      add(item.value, item.label || item.value);
    });
    tableColumnsForAlias(spec, sourceAlias).forEach(function (column) { add(column, column); });
    common.forEach(function (column) { add(column, column); });
    catalogScopePathOptions(sourceClassForAlias(spec, sourceAlias)).filter(Boolean).forEach(function (item) {
      add(item.value, item.label || item.value);
    });
    if (selectedField && !seen[selectedField]) items.unshift({ value: selectedField, label: selectedField });
    return '<option value=""></option>' + items.map(function (item) {
      return '<option value="' + escapeHtml(item.value) + '"' + (item.value === selectedField ? ' selected' : '') + '>' + escapeHtml(item.label || item.value) + '</option>';
    }).join('');
  }

  function inferViewComposerModel(spec) {
    if (state.viewComposerDraft) return state.viewComposerDraft;
    spec = spec || defaultSpec();
    var finalSourceAlias = finalBaseResultAlias(spec);
    var visual = getStoredVisualModel(spec, 'viewComposer');
    if (visual) {
      return {
        sourceAlias: finalSourceAlias || visual.source && visual.source.alias || '',
        title: visual.output && visual.output.title || '',
        mode: visual.output && visual.output.mode || 'table',
        showOnly: true,
        columns: visual.output && Array.isArray(visual.output.columns) ? visual.output.columns : []
      };
    }

    var table = finalResultTableForSpec(spec, false) || firstResultTable(spec);
    var labels = table.columnLabels && typeof table.columnLabels === 'object' && !Array.isArray(table.columnLabels) ? table.columnLabels : {};
    var columns = Array.isArray(table.columns) ? table.columns.map(function (field) {
      return { field: field, title: labels[field] || field };
    }) : [];
    return {
      sourceAlias: finalSourceAlias || table.name || '',
      title: table.title || table.label || '',
      mode: table.mode || table.view || 'table',
      showOnly: true,
      columns: columns
    };
  }

  function renderViewComposerColumnRow(column, spec, sourceAlias) {
    column = normalizeViewComposerColumn(column);
    return [
      '<tr data-view-column-row>',
      '<td><select data-view-column-field="field">' + viewComposerColumnOptions(spec, sourceAlias, column.field || '') + '</select></td>',
      '<td><input data-view-column-field="title" value="' + escapeHtml(column.title || column.field || '') + '"></td>',
      '<td><select data-view-column-field="multiMode">' + renderViewComposerMultiModeOptions(column.multiMode || 'join') + '</select></td>',
      '<td><input data-view-column-field="separator" value="' + escapeHtml(column.separator === undefined ? ', ' : column.separator) + '"></td>',
      '<td><label class="checkbox"><input data-view-column-field="emptyRow" type="checkbox" ' + (column.emptyRow !== false ? 'checked' : '') + '> ' + t('yes') + '</label></td>',
      '<td><button data-action="clear-view-column-row">' + t('clear') + '</button></td>',
      '</tr>'
    ].join('');
  }

  function renderViewComposerEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var model = inferViewComposerModel(spec);
    model.sourceAlias = finalBaseResultAlias(spec) || model.sourceAlias || '';
    var columns = model.columns && model.columns.length ? model.columns : tableColumnsForAlias(spec, model.sourceAlias).slice(0, 6).map(function (field) {
      return { field: field, title: field };
    });
    if (!columns.length) columns = [{ field: 'Code', title: 'Code' }, { field: 'Description', title: 'Description' }];
    var rows = columns.map(function (column) {
      return renderViewComposerColumnRow(column, spec, model.sourceAlias);
    }).join('');
    return [
      '<section class="section" id="cmdp-view-composer-editor"><h2>' + t('viewComposerEditor') + '</h2>',
      '<p class="muted">' + t('viewComposerHelp') + '</p>',
      '<input type="hidden" id="cmdp-view-source" value="' + escapeHtml(model.sourceAlias || '') + '">',
      '<div class="row">',
      '<label>' + t('viewComposerTitle') + '<input id="cmdp-view-title" value="' + escapeHtml(model.title || '') + '"></label>',
      '<label>' + t('viewComposerMode') + '<select id="cmdp-view-mode">' + renderVisualizationModeOptions(model.mode || 'table') + '</select></label>',
      '</div>',
      '<h3>' + t('viewComposerColumns') + '</h3>',
      '<table class="compact"><thead><tr><th>' + t('viewComposerColumnField') + '</th><th>' + t('viewComposerColumnTitle') + '</th><th>' + t('viewComposerMultiMode') + '</th><th>' + t('viewComposerSeparator') + '</th><th>' + t('viewComposerEmptyRow') + '</th><th></th></tr></thead>',
      '<tbody id="cmdp-view-column-rows">',
      rows,
      renderViewComposerColumnRow({}, spec, model.sourceAlias),
      '</tbody></table>',
      '</section>'
    ].join('');
  }

  function renderVisualizationTableRow(table, settings, spec) {
    table = table || {};
    settings = settings || {};
    var name = table.name || settings.name || '';
    var columns = Array.isArray(table.columns) ? table.columns : [];
    var columnOptions = visualizationColumnOptions(table, spec);
    var title = displayTitleForResult(name, settings.title || table.title || table.label || '');
    var titleAlign = normalizeTitleAlign(settings.titleAlign || (table.presentation && table.presentation.titleAlign) || table.titleAlign || 'left');
    var sortDirection = settings.sortDirection === 'desc' ? 'desc' : 'asc';
    var splitSubtables = Boolean(settings.splitSubtables || settings.groupBy);
    var defaultGroupTitle = defaultGroupTitleTemplate(settings.groupBy || '', columnOptions);
    var savedGroupTitle = String(settings.groupTitleTemplate || '').trim();
    if (savedGroupTitle === groupTitleToken('value')) savedGroupTitle = '';
    var groupTitleTemplate = savedGroupTitle || defaultGroupTitle;
    return [
      '<div class="visual-table-panel" data-visualization-row data-visualization-row-detail>',
      '<div class="visual-table-heading"><h3>' + escapeHtml(name || t('visualizationSource')) + '</h3><span class="muted">' + escapeHtml(String(columns.length)) + ' ' + escapeHtml(t('columnsCount')) + '</span></div>',
      '<input type="hidden" data-visualization-field="name" value="' + escapeHtml(name) + '">',
      '<div class="visual-table-subblock">',
      '<h4>' + t('visualizationTableHeader') + '</h4>',
      '<div class="settings-grid">',
      '<label>' + t('visualizationTitle') + '<input data-visualization-field="title" value="' + escapeHtml(title) + '"><span class="muted">' + escapeHtml(t('visualizationTitleHelp')) + '</span></label>',
      '<label>' + t('visualizationTitleAlign') + '<select data-visualization-field="titleAlign">' + renderTitleAlignOptions(titleAlign) + '</select></label>',
      '<label>' + t('visualizationMode') + '<select data-visualization-field="mode">' + renderVisualizationModeOptions(settings.mode || table.mode || table.view || 'table') + '</select></label>',
      '</div></div>',
      '<div class="visual-table-subblock">',
      '<h4>' + t('visualizationSorting') + '</h4>',
      '<div class="settings-grid">',
      '<label>' + t('visualizationSortColumn') + '<select data-visualization-field="sortColumn">' + renderColumnSelectOptions(columnOptions, settings.sortColumn || '', '') + '</select></label>',
      '<label>' + t('visualizationSortDirection') + '<select data-visualization-field="sortDirection"><option value="asc"' + (sortDirection === 'asc' ? ' selected' : '') + '>' + t('visualizationSortAsc') + '</option><option value="desc"' + (sortDirection === 'desc' ? ' selected' : '') + '>' + t('visualizationSortDesc') + '</option></select></label>',
      '</div></div>',
      '<div class="visual-table-subblock">',
      '<h4>' + t('visualizationLinkColumns') + '</h4>',
      '<div class="muted">' + escapeHtml(t('visualizationLinkColumnsHelp')) + '</div>',
      renderVisualizationColumnLinks(columnOptions, settings),
      renderVisualizationLinkExamples(),
      '</div>',
      '<div class="visual-table-subblock">',
      '<h4>' + t('visualizationSubtables') + '</h4>',
      '<div class="settings-grid">',
      '<label class="checkbox checkbox-stacked"><input data-visualization-field="splitSubtables" type="checkbox" ' + (splitSubtables ? 'checked' : '') + '> <span><strong>' + t('visualizationSplitSubtables') + '</strong></span></label>',
      '<label>' + t('visualizationGroupBy') + '<select data-visualization-field="groupBy">' + renderColumnSelectOptions(columnOptions, settings.groupBy || '', '') + '</select></label>',
      '<label>' + t('visualizationGroupTitle') + '<input data-visualization-field="groupTitleTemplate" data-default-group-title-template="' + escapeHtml(defaultGroupTitle) + '" value="' + escapeHtml(groupTitleTemplate) + '"><span class="muted">' + escapeHtml(t('visualizationGroupTitleHelp')) + '</span></label>',
      '</div></div>',
      '<div class="visual-table-subblock">',
      '<select data-visualization-column-options hidden>' + renderColumnSelectOptions(columnOptions, '', '') + '</select>',
      '<div class="visual-row-groups" data-visualization-row-groups>',
      '<div class="section-title-row"><h4>' + t('visualizationRowGrouping') + '</h4>',
      '<button data-action="add-visual-row-group" type="button">' + t('visualizationAddRowGroup') + '</button></div>',
      '<div class="muted">' + escapeHtml(t('visualizationRowGroupHelp')) + '</div>',
      renderVisualizationRowGroupRows(columnOptions, settings),
      '<div data-visualization-row-group-insert></div>',
      '</div>',
      '</div>',
      '</div>'
    ].join('');
  }

  function renderVisualizationEditor(selected) {
    var spec = (selected && selected.spec) || defaultSpec();
    var tables = visualizationTablesForSpec(spec);
    var presentation = getPresentationModel(spec);
    var rows = tables.map(function (table) {
      return renderVisualizationTableRow(table, presentation.tableSettings[table.name] || {}, spec);
    }).join('');
    return [
      '<section class="section" id="cmdp-visualization-editor"><h2>' + t('visualizationEditor') + '</h2>',
      '<p class="muted">' + t('visualizationEditorHelp') + '</p>',
      '<div class="settings-block">',
      '<h3>' + t('visualizationMessages') + '</h3>',
      '<div class="settings-grid">',
      '<label>' + t('visualizationEmptyText') + '<input id="cmdp-visual-empty-text" value="' + escapeHtml(presentation.emptyText) + '"></label>',
      '<label>' + t('visualizationPermissionDeniedText') + '<input id="cmdp-visual-permission-denied-text" value="' + escapeHtml(presentation.permissionDeniedText) + '"></label>',
      '</div></div>',
      '<div class="settings-block">',
      '<h3>' + t('visualizationBaseStyle') + '</h3>',
      '<div class="settings-grid">',
      '<label>' + t('visualizationFontSize') + '<select id="cmdp-visual-font-size"><option value="small"' + (presentation.fontSize === 'small' ? ' selected' : '') + '>' + t('visualizationFontSmall') + '</option><option value="normal"' + (presentation.fontSize === 'normal' ? ' selected' : '') + '>' + t('visualizationFontNormal') + '</option><option value="large"' + (presentation.fontSize === 'large' ? ' selected' : '') + '>' + t('visualizationFontLarge') + '</option></select></label>',
      '<label>' + t('visualizationDensity') + '<select id="cmdp-visual-density"><option value="normal"' + (presentation.density === 'normal' ? ' selected' : '') + '>' + t('visualizationDensityNormal') + '</option><option value="compact"' + (presentation.density === 'compact' ? ' selected' : '') + '>' + t('visualizationDensityCompact') + '</option></select></label>',
      '</div>',
      '<div class="checkbox-list" style="margin-top:8px">',
      '<label class="checkbox checkbox-stacked"><input id="cmdp-visual-zebra" type="checkbox" ' + (presentation.zebra ? 'checked' : '') + '> <span><strong>' + t('visualizationZebra') + '</strong></span></label>',
      '</div></div>',
      '<div class="settings-block">',
      '<h3>' + t('visualizationRuntimeBehavior') + '</h3>',
      '<div class="checkbox-list">',
      '<label class="checkbox checkbox-stacked"><input id="cmdp-visual-filters" type="checkbox" ' + (presentation.filters ? 'checked' : '') + '> <span><strong>' + t('visualizationRuntimeFilters') + '</strong><span class="muted">' + escapeHtml(t('visualizationRuntimeFiltersHelp')) + '</span></span></label>',
      '<label class="checkbox checkbox-stacked"><input id="cmdp-visual-sortable" type="checkbox" ' + (presentation.sortable ? 'checked' : '') + '> <span><strong>' + t('visualizationSortable') + '</strong></span></label>',
      '</div></div>',
      '<div class="settings-block">',
      '<h3>' + t('visualizationTables') + '</h3>',
      tables.length ? '<div class="visual-table-list" id="cmdp-visualization-rows">' + rows + '</div>' : '<div class="notice">' + t('visualizationNoTables') + '</div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function renderTestWorkflow() {
    return [
      '<section class="section" id="cmdp-test-workflow"><h2>' + t('testWorkflow') + '</h2>',
      '<p class="muted">' + t('testWorkflowHelp') + '</p>',
      '<div class="toolbar">',
      '<button data-action="fill-param-examples">' + t('emulateInput') + '</button>',
      '<button data-action="draft-validate">' + t('validateDraft') + '</button>',
      '<button data-action="draft-preview">' + t('previewDraft') + '</button>',
      '<button class="primary" data-action="save-after-test">' + t('saveAfterTest') + '</button>',
      '</div></section>'
    ].join('');
  }

  function renderVersions() {
    var rows = state.templateVersions.map(function (version) {
      return '<tr><td>' + escapeHtml(version.version == null ? '' : String(version.version)) + '</td><td>' +
        escapeHtml(version.changedAt || '') + '</td><td>' + escapeHtml(version.changedBy || '') + '</td><td>' +
        escapeHtml(version.changeComment || '') + '</td><td><button data-action="load-version" data-version="' + escapeHtml(version.id) + '">' + t('load') + '</button></td></tr>';
    }).join('');
    return '<section class="section" id="cmdp-template-versions"><h2>' + t('versions') + '</h2><table class="compact"><thead><tr><th>' + t('version') + '</th><th>' + t('changedAt') + '</th><th>' + t('changedBy') + '</th><th>' + t('comment') + '</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5">' + t('noVersions') + '</td></tr>') + '</tbody></table></section>';
  }

  function getSpecClassFallback(spec) {
    if (!spec || typeof spec !== 'object') return '';
    if (spec.defaults && spec.defaults.className) return String(spec.defaults.className);
    if (spec.paramDefaults && spec.paramDefaults.className) return String(spec.paramDefaults.className);
    if (spec.classNameFallback) return String(spec.classNameFallback);
    return '';
  }

  function renderClassCheckResult() {
    if (!state.classCheckResult) return '';
    var result = state.classCheckResult;
    if (!result.ok) {
      var text = result.status === 401 || result.status === 403 ? t('classAccessDenied') : t('classNotFound');
      return '<div class="notice error">' + escapeHtml(text) + '</div>';
    }
    var checked = state.checkedClass || {};
    return [
      '<div class="notice ok">',
      '<strong>' + t('classFound') + '</strong>',
      '<p>' + t('checkedClass') + ': <span class="code-inline">' + escapeHtml(checked.name || '') + '</span></p>',
      '<p class="muted">' + escapeHtml(checked.description || '') + '</p>',
      renderPermissionFlags(checked.permissions),
      '</div>'
    ].join('');
  }

  function renderClassProbe(selected) {
    var fallback = getSpecClassFallback(selected && selected.spec);
    var className = state.selectedClass || state.runParams.className || fallback || '';
    var catalogClass = catalogClassByName(className);
    var visibleAttributes = state.classAttributes.length ? state.classAttributes : catalogClass && Array.isArray(catalogClass.attributes) ? catalogClass.attributes : [];
    var attrRows = visibleAttributes.map(function (item) {
      return '<tr><td>' + escapeHtml(item.name || '') + '</td><td>' + escapeHtml(item.type || '') + '</td><td>' + escapeHtml(item.description || '') + '</td></tr>';
    }).join('');
    return [
      '<section class="section" style="margin-top:14px"><h2>' + t('classNameProbe') + '</h2>',
      '<p class="muted">' + t('classNameProbeHelp') + '</p>',
      '<div class="row">',
      '<label>' + t('classNameInput') + '<input id="cmdp-class-check" value="' + escapeHtml(className) + '"></label>',
      '<button data-action="check-class">' + t('checkClass') + '</button>',
      '</div>',
      renderCatalogClassSelector(className),
      '<div class="row" style="margin-top:8px">',
      '<label>' + t('classNameFallback') + '<input id="cmdp-class-fallback" value="' + escapeHtml(fallback) + '"></label>',
      '<button data-action="apply-class-fallback">' + t('applyClassFallback') + '</button>',
      '</div>',
      '<p class="muted">' + t('classNameFallbackHelp') + '</p>',
      renderClassCheckResult(),
      '<div><h3>' + t('attributes') + ' ' + escapeHtml(state.selectedClass || '') + '</h3><table class="compact"><thead><tr><th>' + t('attribute') + '</th><th>' + t('type') + '</th><th>' + t('description') + '</th></tr></thead><tbody>',
      attrRows || '<tr><td colspan="3">' + t('selectClass') + '</td></tr>',
      '</tbody></table></div>',
      renderCatalogPathHints(className),
      '</section>'
    ].join('');
  }

  function renderActionResult(result) {
    if (!result) return '';
    var tables = visibleResultTables(result.json && result.json.result ? (result.json.result.tables || []) : []);
    var trace = result.json && result.json.result ? (result.json.result.trace || []) : [];
    if (!result.ok) {
      var errorHtml = '<section class="section" id="cmdp-result-section">' + renderNotice({ type: 'error', text: errorText(result) });
      if (trace.length) errorHtml += renderExecutionTrace(trace);
      return errorHtml + '</section>';
    }
    var html = '<section class="section" id="cmdp-result-section"><h2>' + t('result') + '</h2>';
    if (tables.length) {
      html += tables.map(renderResultTable).join('');
    } else {
      html += '<pre>' + escapeHtml(pretty(result.json || {})) + '</pre>';
    }
    if (trace.length) html += renderExecutionTrace(trace);
    return html + '</section>';
  }

  function formatRuntimeDuration(ms) {
    var total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    if (minutes > 0) return String(minutes) + ':' + String(seconds).padStart(2, '0');
    return String(seconds) + 's';
  }

  function runtimeCacheStatusLabel(cache) {
    if (!cache) return '';
    if (cache.status === 'hit') return t('runtimeCacheHit');
    if (cache.status === 'joined') return t('runtimeCacheJoined');
    if (cache.status === 'snapshot-hit') return t('runtimeSnapshotHit');
    if (cache.status === 'snapshot-miss') return t('runtimeSnapshotMiss');
    if (cache.status === 'snapshot-published') return t('runtimeSnapshotPublished');
    return t('runtimeCacheBuilt');
  }

  function runtimeCacheTooltipHtml(cache, refreshText, expiresText) {
    var html = [
      '<span>' + escapeHtml(runtimeCacheStatusLabel(cache)) + '</span>',
      '<span>' + escapeHtml(t('runtimeCacheGeneratedAt')) + ': ' + escapeHtml(cache.generatedAt || cache.publishedAt || '') + '</span>'
    ];
    if (expiresText) html.push('<span data-runtime-cache-live-expires>' + escapeHtml(expiresText) + '</span>');
    if (refreshText) html.push('<span data-runtime-cache-live-wait>' + escapeHtml(refreshText) + '</span>');
    if (cache.backend) html.push('<span>' + escapeHtml(t('runtimeCacheBackend')) + ': ' + escapeHtml(cache.backend) + '</span>');
    if (cache.scope || cache.scopeMode) html.push('<span>' + escapeHtml(t('runtimeCacheScope')) + ': ' + escapeHtml([cache.scope, cache.scopeMode].filter(Boolean).join(' / ')) + '</span>');
    if (cache.key) html.push('<span>' + escapeHtml(t('runtimeCacheKey')) + ': ' + escapeHtml(cache.key) + '</span>');
    if (cache.message) html.push('<span>' + escapeHtml(cache.message) + '</span>');
    if (cache.allowManualRefresh === false) html.push('<span>' + escapeHtml(t('runtimeCacheManualDisabled')) + '</span>');
    return html.join('');
  }

  function renderRuntimeCacheControl(result) {
    var cache = result && result.json ? result.json.cache : null;
    if (!cache || !cache.enabled) return '';
    var now = Date.now();
    var nextRefreshMs = Date.parse(cache.nextRefreshAllowedAt || '');
    var expiresMs = Date.parse(cache.expiresAt || '');
    var waitMs = Number.isFinite(nextRefreshMs) ? nextRefreshMs - now : 0;
    var refreshText = waitMs > 0
      ? t('runtimeCacheRefreshWait', { time: formatRuntimeDuration(waitMs) })
      : t('runtimeCacheRefreshReady');
    var expiresText = Number.isFinite(expiresMs)
      ? t('runtimeCacheExpiresIn', { time: formatRuntimeDuration(expiresMs - now) })
      : '';
    var disabled = waitMs > 0 || state.runtimeRefreshInProgress || cache.allowManualRefresh === false;
    var buttonLabel = state.runtimeRefreshInProgress ? t('runtimeRefreshing') : t('runtimeRefresh');
    return [
      '<span class="runtime-cache-control" data-runtime-cache',
      ' data-next-refresh="' + escapeHtml(cache.nextRefreshAllowedAt || '') + '"',
      ' data-expires="' + escapeHtml(cache.expiresAt || '') + '">',
      '<button class="runtime-cache-button' + (state.runtimeRefreshInProgress ? ' refreshing' : '') + '" data-action="runtime-refresh" data-manual-disabled="' + (cache.allowManualRefresh === false ? 'true' : 'false') + '" data-disabled="' + (disabled ? 'true' : 'false') + '" aria-disabled="' + (disabled ? 'true' : 'false') + '" aria-label="' + escapeHtml(buttonLabel) + '">&#8635;</button>',
      '<span class="runtime-cache-tooltip" role="tooltip" data-runtime-cache-tooltip>',
      runtimeCacheTooltipHtml(cache, refreshText, expiresText),
      '</span>',
      '</span>'
    ].join('');
  }

  function refreshRuntimeCountdown() {
    var bar = document.querySelector('[data-runtime-cache]');
    if (!bar) return;
    var now = Date.now();
    var nextRefreshMs = Date.parse(bar.getAttribute('data-next-refresh') || '');
    var expiresMs = Date.parse(bar.getAttribute('data-expires') || '');
    var button = bar.querySelector('[data-action="runtime-refresh"]');
    var tooltip = bar.querySelector('[data-runtime-cache-tooltip]');
    var waitMs = Number.isFinite(nextRefreshMs) ? nextRefreshMs - now : 0;
    var refreshText = waitMs > 0
      ? t('runtimeCacheRefreshWait', { time: formatRuntimeDuration(waitMs) })
      : t('runtimeCacheRefreshReady');
    var expiresText = Number.isFinite(expiresMs)
      ? t('runtimeCacheExpiresIn', { time: formatRuntimeDuration(expiresMs - now) })
      : '';
    if (button) {
      var disabled = waitMs > 0 || state.runtimeRefreshInProgress || button.getAttribute('data-manual-disabled') === 'true';
      if (state.runtimeRefreshInProgress) button.classList.add('refreshing');
      else button.classList.remove('refreshing');
      button.setAttribute('data-disabled', disabled ? 'true' : 'false');
      button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      button.setAttribute('aria-label', state.runtimeRefreshInProgress ? t('runtimeRefreshing') : t('runtimeRefresh'));
    }
    if (tooltip) {
      var waitNode = tooltip.querySelector('[data-runtime-cache-live-wait]');
      var expiresNode = tooltip.querySelector('[data-runtime-cache-live-expires]');
      if (waitNode) waitNode.textContent = refreshText;
      if (expiresNode) expiresNode.textContent = expiresText;
    }
  }

  function startRuntimeCountdown() {
    if (state.runtimeCountdownTimer) window.clearInterval(state.runtimeCountdownTimer);
    refreshRuntimeCountdown();
    state.runtimeCountdownTimer = window.setInterval(refreshRuntimeCountdown, 1000);
  }

  function renderRuntimeResult(result) {
    if (!result) return '';
    var resultBody = result.json && result.json.result ? result.json.result : null;
    var tables = visibleResultTables(resultBody ? (resultBody.tables || []) : []);
    var cacheHtml = renderRuntimeCacheControl(result);
    if (!result.ok) {
      return (cacheHtml ? '<div class="result-table-toolbar"><div class="result-table-actions">' + cacheHtml + '</div></div>' : '') + '<div class="notice error">' + escapeHtml(result.json && result.json.permissionDeniedText || errorText(result)) + '</div>';
    }
    if (resultBody && resultBody.kind === 'html' && resultBody.htmlTrusted && resultBody.html) {
      return '<div class="result-table-wrap" data-result-table>' +
        '<div class="result-table-header"><div class="result-table-title"><h3>' + escapeHtml(result.json && result.json.template && result.json.template.description || result.json && result.json.template && result.json.template.code || t('templateKindCmdbBuildView')) + '</h3></div>' +
        (cacheHtml ? '<div class="result-table-actions">' + cacheHtml + '</div>' : '') + '</div>' +
        '<div class="cmdp-html-result">' + resultBody.html + '</div></div>';
    }
    if (tables.length) return tables.map(function (table, index) {
      return renderResultTable(table, index === 0 ? cacheHtml : '');
    }).join('');
    return (cacheHtml ? '<div class="result-table-toolbar"><div class="result-table-actions">' + cacheHtml + '</div></div>' : '') + '<div class="notice">' + escapeHtml(resultBody && resultBody.emptyText || DEFAULT_EMPTY_RESULT_TEXT) + '</div>';
  }

  function renderExecutionTrace(trace) {
    var rows = trace.map(function (item) {
      return '<tr><td>' + escapeHtml(item.index == null ? '' : String(item.index + 1)) + '</td>' +
        '<td>' + escapeHtml(item.type || '') + '</td>' +
        '<td>' + escapeHtml(item.as || '') + '</td>' +
        '<td>' + escapeHtml(item.status || '') + '</td>' +
        '<td>' + escapeHtml(item.rows == null ? '' : String(item.rows)) + '</td>' +
        '<td>' + escapeHtml(item.elapsedMs == null ? '' : String(item.elapsedMs)) + '</td>' +
        '<td>' + escapeHtml(item.restCalls == null ? '' : String(item.restCalls)) + '</td></tr>';
    }).join('');
    return '<h3>' + t('executionTrace') + '</h3><table class="compact"><thead><tr><th>' + t('traceStep') + '</th><th>' +
      t('type') + '</th><th>' + t('traceAlias') + '</th><th>' + t('traceStatus') + '</th><th>' +
      t('traceRows') + '</th><th>' + t('traceMs') + '</th><th>' + t('traceRest') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function renderKeyValueTable(table, compact) {
    var columns = table.columns || [];
    var columnLabels = table.columnLabels && typeof table.columnLabels === 'object' ? table.columnLabels : {};
    var rows = table.rows || [];
    if (!rows.length) {
      return '<table class="' + (compact ? 'compact' : '') + '"><tbody><tr><td>' + escapeHtml(table.emptyText || DEFAULT_EMPTY_RESULT_TEXT) + '</td></tr></tbody></table>';
    }
    return rows.map(function (row, rowIndex) {
      var body = columns.map(function (column) {
        return '<tr><th>' + escapeHtml(columnLabels[column] || column) + '</th><td>' + escapeHtml(row[column] == null ? '' : String(row[column])) + '</td></tr>';
      }).join('');
      return (rows.length > 1 ? '<h3>#' + String(rowIndex + 1) + '</h3>' : '') + '<table class="' + (compact ? 'compact' : '') + '"><tbody>' + body + '</tbody></table>';
    }).join('');
  }

  function presentationClassNames(presentation, compact) {
    var classes = ['cmdp-result-table'];
    if (compact || presentation.density === 'compact') classes.push('compact', 'cmdp-density-compact');
    classes.push('cmdp-font-' + (['small', 'normal', 'large'].indexOf(presentation.fontSize) === -1 ? 'normal' : presentation.fontSize));
    if (presentation.zebra) classes.push('cmdp-zebra');
    return classes.join(' ');
  }

  function titleAlignStyle(presentation, flex) {
    var align = normalizeTitleAlign(presentation && presentation.titleAlign);
    var justify = align === 'right' ? 'flex-end' : (align === 'center' ? 'center' : 'flex-start');
    return ' style="text-align:' + align + (flex ? ';justify-content:' + justify : '') + '"';
  }

  function rowColumnText(row, column) {
    return String(row && row[column] !== undefined && row[column] !== null ? row[column] : '');
  }

  function presentationRowGroupColumns(presentation, columns) {
    var configured = normalizeVisualizationRowGroupBy(presentation && presentation.rowGroupBy);
    return configured.filter(function (column, index) {
      return column && columns.indexOf(column) !== -1 && configured.indexOf(column) === index;
    });
  }

  function sameRowGroupPrefix(rows, leftIndex, rightIndex, groupColumns, groupIndex) {
    if (leftIndex < 0 || rightIndex < 0 || leftIndex >= rows.length || rightIndex >= rows.length) return false;
    for (var index = 0; index <= groupIndex; index += 1) {
      if (rowColumnText(rows[leftIndex], groupColumns[index]) !== rowColumnText(rows[rightIndex], groupColumns[index])) return false;
    }
    return true;
  }

  function rowGroupSpan(rows, rowIndex, groupColumns, groupIndex) {
    var span = 1;
    while (rowIndex + span < rows.length && sameRowGroupPrefix(rows, rowIndex, rowIndex + span, groupColumns, groupIndex)) {
      span += 1;
    }
    return span;
  }

  function sortRowsForPresentation(rows, presentation) {
    var sortColumn = presentation.sortColumn || '';
    if (!sortColumn) return rows.slice();
    var direction = presentation.sortDirection === 'desc' ? -1 : 1;
    return rows.slice().sort(function (left, right) {
      var leftText = rowColumnText(left, sortColumn);
      var rightText = rowColumnText(right, sortColumn);
      var leftNumber = Number(leftText);
      var rightNumber = Number(rightText);
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && leftText !== '' && rightText !== '') {
        return (leftNumber - rightNumber) * direction;
      }
      return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' }) * direction;
    });
  }

  function groupRowsForPresentation(rows, presentation) {
    var groupBy = presentation.splitSubtables ? (presentation.groupBy || '') : '';
    if (!groupBy) return [{ key: '', rows: rows }];
    var groups = [];
    var byKey = {};
    rows.forEach(function (row) {
      var key = rowColumnText(row, groupBy) || t('noRows');
      if (!byKey[key]) {
        byKey[key] = { key: key, rows: [] };
        groups.push(byKey[key]);
      }
      byKey[key].rows.push(row);
    });
    return groups;
  }

  function replaceGroupTitleToken(text, token, value) {
    if (!token) return text;
    return String(text || '').split(groupTitleToken(token)).join(String(value || ''));
  }

  function renderGroupTitle(template, column, value, columnLabel) {
    var label = String(columnLabel || column || '').trim();
    var text = template || defaultGroupTitleTemplate(label || column);
    text = replaceGroupTitleToken(text, label || '', value || '');
    text = replaceGroupTitleToken(text, column || '', value || '');
    return text;
  }

  function renderCellTemplateClient(template, context) {
    var source = context && context.mysource ? context.mysource : {};
    var row = context && context.row ? context.row : {};
    var params = context && context.params ? context.params : {};
    return String(template || '').replace(/\\$\\{([^{}]+)\\}/g, function (match, token) {
      var text = String(token || '').trim();
      if (!text) return '';
      if (text === 'mysource.value') return rowColumnText(source, 'value');
      if (text === 'mysource.column') return rowColumnText(source, 'column');
      if (text === 'mysource.source') return rowColumnText(source, 'source');
      if (text === 'mysource.sourceClass') return rowColumnText(source, 'sourceClass');
      if (text === 'mysource.sourceId') return rowColumnText(source, 'sourceId');
      if (text === 'mysource.attribute') return rowColumnText(source, 'attribute');
      if (text === 'mysource.domainPath') return rowColumnText(source, 'domainPath');
      if (text.indexOf('mysource.') === 0 && Object.prototype.hasOwnProperty.call(source, text.slice(9))) return rowColumnText(source, text.slice(9));
      if (Object.prototype.hasOwnProperty.call(source, text)) return rowColumnText(source, text);
      if (text.indexOf('row.') === 0) return rowColumnText(row, text.slice(4));
      if (text.indexOf('param.') === 0) return rowColumnText(params, text.slice(6));
      if (text.indexOf('params.') === 0) return rowColumnText(params, text.slice(7));
      return '';
    });
  }

  function isSafeRuntimeLinkUrlClient(value) {
    var text = String(value || '').trim();
    if (!text) return false;
    var lower = text.toLowerCase().split('').filter(function (ch) {
      return ch.charCodeAt(0) > 31 && !/\\s/.test(ch);
    }).join('');
    if (lower.indexOf('javascript:') === 0 || lower.indexOf('data:') === 0 || lower.indexOf('vbscript:') === 0) return false;
    if (/^[a-z][a-z0-9+.\\-]*:/i.test(text)) return /^https?:/i.test(text) || /^mailto:/i.test(text);
    return true;
  }

  function renderResultCell(row, column, table, rowGroupColumns) {
    var value = rowColumnText(row, column);
    var rowIndex = row && row.__cmdpRowIndex !== undefined ? String(row.__cmdpRowIndex) : '';
    var meta = table && table.cellMeta && table.cellMeta[rowIndex] && table.cellMeta[rowIndex][column] || {};
    var linkConfig = table && table.presentation && table.presentation.columnLinks && table.presentation.columnLinks[column] || {};
    var content = escapeHtml(value);
    if (linkConfig && linkConfig.mode === 'link' && linkConfig.urlTemplate) {
      var thisContext = Object.assign({}, meta, {
        value: value,
        column: column,
        attribute: meta.attribute || column
      });
      var href = renderCellTemplateClient(linkConfig.urlTemplate, {
        mysource: thisContext,
        row: row,
        params: state.runParams || {}
      });
      if (isSafeRuntimeLinkUrlClient(href)) {
        var text = renderCellTemplateClient(linkConfig.textTemplate || '$' + '{mysource.value}', {
          mysource: thisContext,
          row: row,
          params: state.runParams || {}
        }) || value;
        var target = linkConfig.target === 'blank' ? ' target="_blank" rel="noreferrer"' : '';
        content = '<a href="' + escapeHtml(href) + '"' + target + '>' + escapeHtml(text) + '</a>';
      }
    }
    var groupIndex = rowGroupColumns.indexOf(column);
    return { value: value, html: content, groupIndex: groupIndex };
  }

  function renderResultTable(table, cacheControlHtml) {
    var columns = table.columns || [];
    var columnLabels = table.columnLabels && typeof table.columnLabels === 'object' ? table.columnLabels : {};
    var title = displayTitleForResult(table.name, table.title || table.label || '');
    var mode = table.mode || table.view || 'table';
    var presentation = table.presentation && typeof table.presentation === 'object' ? table.presentation : {};
    var compact = mode === 'compact';
    if (mode === 'keyValue') {
      return '<div class="result-table-wrap" data-result-table>' +
        '<div class="result-table-header">' +
        '<div class="result-table-title"' + titleAlignStyle(presentation, true) + '><h3>' + escapeHtml(title) + '</h3>' +
        (table.truncated ? ' <span class="pill">' + t('truncated') + '</span>' : '') + '</div>' +
        (cacheControlHtml ? '<div class="result-table-actions">' + cacheControlHtml + '</div>' : '') +
        '</div>' +
        renderKeyValueTable(table, compact) + '</div>';
    }
    var rows = (table.rows || []).map(function (row, index) {
      return Object.assign({ __cmdpRowIndex: index }, row || {});
    });
    var tableClass = presentationClassNames(presentation, compact);
    var rowGroupColumns = presentationRowGroupColumns(presentation, columns);
    var controlsDisabledByRowGrouping = rowGroupColumns.length > 0;
    var sortable = Boolean(presentation.sortable !== false && !controlsDisabledByRowGrouping);
    var filtersEnabled = Boolean(presentation.filters !== false && !controlsDisabledByRowGrouping);
    var groups = groupRowsForPresentation(rows, presentation).map(function (group) {
      return {
        key: group.key,
        rows: controlsDisabledByRowGrouping ? group.rows : sortRowsForPresentation(group.rows || [], presentation)
      };
    });
    var head = columns.map(function (column, index) {
      var label = escapeHtml(columnLabels[column] || column);
      if (!sortable) return '<th>' + label + '</th>';
      return '<th><button class="table-sort" data-result-sort="' + escapeHtml(column) + '" data-column-index="' + index + '" data-sort-direction="asc">' + label + '</button></th>';
    }).join('');
    function renderRows(groupRows) {
      return groupRows.map(function (row, rowIndex) {
        var filterText = columns.map(function (column) { return rowColumnText(row, column); }).join(' ');
        return '<tr data-result-row data-filter-text="' + escapeHtml(filterText.toLowerCase()) + '">' + columns.map(function (column) {
          var cell = renderResultCell(row, column, table, rowGroupColumns);
          if (cell.groupIndex !== -1) {
            if (rowIndex > 0 && sameRowGroupPrefix(groupRows, rowIndex, rowIndex - 1, rowGroupColumns, cell.groupIndex)) return '';
            return '<td class="cmdp-row-group-cell" rowspan="' + rowGroupSpan(groupRows, rowIndex, rowGroupColumns, cell.groupIndex) + '" data-cell-value="' + escapeHtml(cell.value) + '">' + cell.html + '</td>';
          }
          return '<td data-cell-value="' + escapeHtml(cell.value) + '">' + cell.html + '</td>';
        }).join('') + '</tr>';
      }).join('');
    }
    var disabledNotice = controlsDisabledByRowGrouping && (presentation.sortable !== false || presentation.filters !== false)
      ? '<div class="muted result-table-note">' + escapeHtml(t('runtimeTableControlsDisabledByGrouping')) + '</div>'
      : '';
    var tableHtml = rows.length ? groups.map(function (group) {
      var groupTitleColumnLabel = presentation.groupTitleColumnLabel || columnLabels[presentation.groupBy] || presentation.groupBy;
      var subtitle = presentation.splitSubtables && presentation.groupBy ? '<div class="result-subtitle">' + escapeHtml(renderGroupTitle(presentation.groupTitleTemplate, presentation.groupBy, group.key, groupTitleColumnLabel)) + '</div>' : '';
      return '<div data-result-group>' + subtitle + '<table class="' + tableClass + '"><thead><tr>' + head + '</tr></thead><tbody>' + renderRows(group.rows) + '</tbody></table></div>';
    }).join('') : '<table class="' + tableClass + '"><tbody><tr><td>' + escapeHtml(table.emptyText || DEFAULT_EMPTY_RESULT_TEXT) + '</td></tr></tbody></table>';
    var actions = [
      filtersEnabled ? '<input class="result-table-filter" data-result-filter placeholder="' + escapeHtml(t('runtimeFilterPlaceholder')) + '">' : '',
      cacheControlHtml || ''
    ].filter(Boolean).join('');
    return '<div class="result-table-wrap" data-result-table>' +
      '<div class="result-table-header">' +
      '<div class="result-table-title"' + titleAlignStyle(presentation, true) + '><h3>' + escapeHtml(title) + '</h3>' +
      (table.truncated ? ' <span class="pill">' + t('truncated') + '</span>' : '') + '</div>' +
      (actions ? '<div class="result-table-actions">' + actions + '</div>' : '') +
      '</div>' +
      disabledNotice +
      tableHtml + '</div>';
  }

  function loadDesigner() {
    updateChrome();
    app.innerHTML = '<div class="notice">' + t('loadingDesigner') + '</div>';
    clientLog('load-designer-start', state.designerSection || '');
    state.technicalSchemaAccessDenied = false;
    state.accessDeniedText = DEFAULT_PERMISSION_DENIED_TEXT;
    function namedRequest(name, path, options) {
      clientLog('load-designer-request', name);
      return request(path, options).then(function (result) {
        clientLog('load-designer-response', name + ' ' + result.status);
        app.innerHTML = '<div class="notice">' + escapeHtml(t('loadingDesigner')) + '<div class="muted">' + escapeHtml(name + ' ' + result.status) + '</div></div>';
        return result;
      });
    }
    return Promise.all([
      namedRequest('session', apiPrefix + '/session'),
      namedRequest('schema', apiPrefix + '/schema?root=' + encodeURIComponent(state.root)),
      namedRequest('schemaParents', apiPrefix + '/schema/parents?limit=500').catch(function (error) {
        clientLog('load-designer-optional-failed', 'schemaParents ' + (error && error.message ? error.message : String(error)));
        return { ok: true, status: 0, json: { parents: [] }, body: '' };
      }),
      namedRequest('config', apiPrefix + '/config?root=' + encodeURIComponent(state.root)),
      namedRequest('templates', apiPrefix + '/templates?limit=100'),
      namedRequest('baaInputContracts', apiPrefix + '/baa/contracts?root=' + encodeURIComponent(state.root) + '&type=input').catch(function (error) {
        clientLog('load-designer-optional-failed', 'baaInputContracts ' + (error && error.message ? error.message : String(error)));
        return { ok: true, status: 0, json: { data: [] }, body: '' };
      })
    ]).then(function (results) {
      clientLog('load-designer-results', results.map(function (item) { return item.status; }).join(','));
      state.session = results[0].json && results[0].json.session ? results[0].json.session : state.session;
      state.schema = results[1].json ? results[1].json.schema : null;
      state.schemaParents = results[2].json && Array.isArray(results[2].json.parents) ? results[2].json.parents : [];
      if (!state.schemaRootDraft && state.schema && state.schema.root) state.schemaRootDraft = state.schema.root;
      if (!state.schemaDescriptionDraft && state.schema && state.schema.rootDescription) state.schemaDescriptionDraft = state.schema.rootDescription;
      if (!state.schemaParentDraft && state.schema && state.schema.rootParent) state.schemaParentDraft = state.schema.rootParent;
      state.config = results[3].json ? results[3].json.config : null;
      state.templates = results[4].json && results[4].json.data ? results[4].json.data : [];
      state.baaInputContracts = results[5].json && Array.isArray(results[5].json.data) ? results[5].json.data : [];
      var accessDenied = [results[3], results[4]].find(resultIsPermissionDenied);
      if (accessDenied) {
        state.technicalSchemaAccessDenied = true;
        state.accessDeniedText = accessDeniedTextFromResult(accessDenied);
        renderDesigner();
        return;
      }
      if (state.selectedTemplate && state.selectedTemplate.code) {
        state.selectedTemplate = state.templates.find(function (item) { return item.code === state.selectedTemplate.code; }) || null;
      }
      if (state.selectedTemplate) hydrateDesignerStateFromTemplate({ replaceRunParams: !state.runParams || Object.keys(state.runParams).length === 0 });
      ensureTemplateListOnNewDesignerSession();
      var failed = results.find(function (item) { return !item.ok; });
      state.message = failed ? { type: 'error', text: errorText(failed) } : null;
      return loadCatalogCache().then(function () {
        clientLog('load-designer-catalog', 'loaded');
        return fetchVersions(state.selectedTemplate && state.selectedTemplate.code).then(renderDesigner);
      });
    }).catch(function (error) {
      clientLog('load-designer-error', error && error.message ? error.message : String(error));
      app.innerHTML = '<div class="notice error">' + escapeHtml(error.message || String(error)) + '</div>';
    });
  }

  function fetchVersions(code) {
    if (!code) {
      state.templateVersions = [];
      return Promise.resolve([]);
    }
    return request(apiPrefix + '/templates/' + encodeURIComponent(code) + '/versions?limit=20').then(function (result) {
      state.templateVersions = result.ok && result.json && result.json.data ? result.json.data : [];
      return state.templateVersions;
    });
  }

  function readEditorPayload() {
    var selected = state.selectedTemplate || {};
    var code = readTemplateCode(selected);
    if (!code) throw new Error(t('templateCodeRequired'));
    var specData = readSpecWithEditorBlocks();
    specData.spec = normalizeTemplateProtection(applyTemplateKindFromEditor(specData.spec));
    var payload = {
      code: code,
      description: readTemplateDescription(selected, code) || code,
      active: readTemplateActive(selected),
      spec: specData.spec,
      paramsSchema: readCurrentParamsSchema(selected.paramsSchema || {}),
      resultSchema: readCurrentResultSchema(selected.resultSchema || {})
    };
    if (selected.specHash) payload.expectedSpecHash = selected.specHash;
    return payload;
  }

  function applyTemplateKindFromEditor(spec) {
    if (!hasField('cmdp-template-kind')) return spec;
    var kind = readValue('cmdp-template-kind') === CMDB_BUILD_VIEW_KIND ? CMDB_BUILD_VIEW_KIND : 'dsl';
    if (kind === CMDB_BUILD_VIEW_KIND && templateKindForSpec(spec) !== CMDB_BUILD_VIEW_KIND) {
      var next = defaultCmdbBuildViewSpecClient();
      next.publish = spec && spec.publish ? spec.publish : next.publish;
      next.cache = spec && spec.cache ? spec.cache : next.cache;
      return next;
    }
    if (kind === 'dsl' && templateKindForSpec(spec) === CMDB_BUILD_VIEW_KIND) {
      return defaultSpec();
    }
    return normalizeTemplateProtection(spec);
  }

  function captureParamRowsDraftFromDom() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-param-row]'));
    return rows.map(function (row) {
      var nameField = row.querySelector('[data-param-field="name"]');
      var typeField = row.querySelector('[data-param-field="type"]');
      var requiredField = row.querySelector('[data-param-field="required"]');
      var defaultField = row.querySelector('[data-param-field="default"]');
      var exampleField = row.querySelector('[data-param-field="example"]');
      var descriptionField = row.querySelector('[data-param-field="description"]');
      return {
        name: nameField ? nameField.value : '',
        type: String(typeField && typeField.value || 'string').trim() || 'string',
        required: Boolean(requiredField && requiredField.checked),
        defaultValue: defaultField ? defaultField.value : '',
        example: exampleField ? exampleField.value : '',
        description: descriptionField ? descriptionField.value : ''
      };
    });
  }

  function readParamEditorRows() {
    var params = {};
    var examples = {};
    var rows = captureParamRowsDraftFromDom();
    state.paramRowsDraft = rows;
    rows.forEach(function (row) {
      var name = String(row.name || '').trim();
      if (!name) return;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(t('invalidParamName'));
      if (name === 'json') throw new Error(t('reservedParamName', { name: name }));
      var type = String(row.type || 'string').trim() || 'string';
      var defaultValue = row.defaultValue === undefined || row.defaultValue === null ? '' : String(row.defaultValue);
      var example = row.example === undefined || row.example === null ? '' : String(row.example);
      var isRequired = Boolean(row.required);
      if (!isRequired && defaultValue.trim() === '') throw new Error(t('optionalParamNeedsDefault', { name: name }));
      var definition = {
        type: type,
        required: isRequired
      };
      if (defaultValue !== '') {
        definition.default = defaultValue;
        examples[name] = defaultValue;
      }
      if (example !== '') {
        definition.example = example;
        examples[name] = example;
      }
      if (row.description) definition.description = row.description;
      params[name] = definition;
    });
    return { params: params, examples: examples };
  }

  function readSpecWithParamEditor() {
    var spec = readCurrentSpec();
    var paramData = readParamEditorRows();
    if (document.querySelectorAll('[data-param-row]').length) spec.params = paramData.params;
    state.paramRowsDraft = null;
    return { spec: spec, examples: paramData.examples };
  }

  function sanitizeRegexFlags(flags, allMatches) {
    var result = '';
    String(flags || '').split('').forEach(function (flag) {
      if ('gimsuy'.indexOf(flag) === -1 || result.indexOf(flag) !== -1) return;
      result += flag;
    });
    if (allMatches && result.indexOf('g') === -1) result += 'g';
    if (!allMatches) result = result.replace(/g/g, '');
    return result;
  }

  function readExtractionStepFields(required) {
    var sourceParam = String(readValue('cmdp-extract-source-param') || '').trim();
    var regex = String(readValue('cmdp-extract-regex') || '').trim();
    var flags = String(readValue('cmdp-extract-flags') || '').trim();
    var alias = String(readValue('cmdp-extract-as') || '').trim() || 'extracted';
    var all = readChecked('cmdp-extract-all');
    if (!sourceParam && !regex && !required) return null;
    if (!sourceParam) throw new Error(t('extractionNeedsSource'));
    if (!regex) throw new Error(t('extractionNeedsRegex'));
    if (!alias) throw new Error(t('extractionNeedsAlias'));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(t('invalidParamName'));
    try {
      new RegExp(regex, sanitizeRegexFlags(flags, all));
    } catch (error) {
      throw new Error(t('extractionInvalidRegex') + ' ' + (error && error.message ? error.message : ''));
    }
    return {
      type: 'extractVariables',
      sourceParam: sourceParam,
      regex: regex,
      flags: flags,
      all: all,
      as: alias
    };
  }

  function upsertExtractionStep(spec, step) {
    spec.steps = Array.isArray(spec.steps) ? spec.steps.slice() : [];
    var index = spec.steps.findIndex(isExtractionStep);
    if (index === -1) spec.steps.unshift(step);
    else spec.steps[index] = step;
    spec.result = spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    spec.result.tables = Array.isArray(spec.result.tables) ? spec.result.tables.slice() : [];
    if (!spec.result.tables.some(function (table) { return table && table.name === step.as; })) {
      spec.result.tables.unshift({ name: step.as });
    }
    return spec;
  }

  function readSelectionFilterRows() {
    var filters = [];
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-selection-filter-row]'));
    rows.forEach(function (row) {
      var attributeField = row.querySelector('[data-selection-filter-field="attribute"]');
      var opField = row.querySelector('[data-selection-filter-field="op"]');
      var valueField = row.querySelector('[data-selection-filter-field="value"]');
      var valueParamField = row.querySelector('[data-selection-filter-field="valueParam"]');
      var valueColumnField = row.querySelector('[data-selection-filter-field="valueColumn"]');
      var attribute = String(attributeField && attributeField.value || '').trim();
      var value = valueField ? valueField.value : '';
      var valueParam = String(valueParamField && valueParamField.value || '').trim();
      var valueColumn = String(valueColumnField && valueColumnField.value || '').trim();
      if (!attribute && !value && !valueParam && !valueColumn) return;
      if (!attribute) throw new Error(t('fieldRequired', { label: t('filterAttribute') }));
      var filter = {
        attribute: attribute,
        op: String(opField && opField.value || 'equals').trim() || 'equals'
      };
      if (value !== '') filter.value = value;
      if (valueParam) filter.valueParam = valueParam;
      if (valueColumn) filter.valueColumn = valueColumn;
      filters.push(filter);
    });
    return filters;
  }

  function readDataSelectionStepFields(required) {
    var alias = String(readValue('cmdp-select-as') || '').trim() || 'cards';
    var from = String(readValue('cmdp-select-from') || '').trim();
    var className = String(readValue('cmdp-select-class-name') || '').trim();
    var classNameParam = String(readValue('cmdp-select-class-param') || '').trim();
    var classColumn = String(readValue('cmdp-select-class-column') || '').trim();
    var limitText = String(readValue('cmdp-select-limit') || '').trim();
    var filters = readSelectionFilterRows();
    if (!from && !className && !classNameParam && !classColumn && !filters.length && !required) return null;
    if (!alias) throw new Error(t('selectionNeedsAlias'));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(t('invalidParamName'));
    if (!className && !classNameParam && !classColumn) throw new Error(t('selectionNeedsClass'));
    var step = {
      type: 'selectCards',
      as: alias,
      filters: filters
    };
    if (from) step.from = from;
    if (className) step.className = className;
    if (classNameParam) step.classNameParam = classNameParam;
    if (classColumn) step.classColumn = classColumn;
    if (limitText) {
      var limit = Number(limitText);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(t('selectionInvalidLimit'));
      step.limit = limit;
    }
    return step;
  }

  function upsertDataSelectionStep(spec, step) {
    spec.steps = Array.isArray(spec.steps) ? spec.steps.slice() : [];
    var index = spec.steps.findIndex(isDataSelectionStep);
    if (index === -1) {
      var extractionIndex = spec.steps.findIndex(isExtractionStep);
      spec.steps.splice(extractionIndex === -1 ? spec.steps.length : extractionIndex + 1, 0, step);
    } else {
      spec.steps[index] = step;
    }
    spec.result = spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    spec.result.tables = Array.isArray(spec.result.tables) ? spec.result.tables.slice() : [];
    if (!spec.result.tables.some(function (table) { return table && table.name === step.as; })) {
      spec.result.tables.push({ name: step.as });
    }
    return spec;
  }

  function readViewComposerColumnRows() {
    var columns = [];
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-view-column-row]'));
    rows.forEach(function (row) {
      var fieldElement = row.querySelector('[data-view-column-field="field"]');
      var titleElement = row.querySelector('[data-view-column-field="title"]');
      var multiModeElement = row.querySelector('[data-view-column-field="multiMode"]');
      var separatorElement = row.querySelector('[data-view-column-field="separator"]');
      var emptyRowElement = row.querySelector('[data-view-column-field="emptyRow"]');
      var field = String(fieldElement && fieldElement.value || '').trim();
      var title = String(titleElement && titleElement.value || '').trim();
      if (!field && !title) return;
      if (!field) throw new Error(t('fieldRequired', { label: t('viewComposerColumnField') }));
      columns.push({
        field: field,
        title: title || field,
        multiMode: String(multiModeElement && multiModeElement.value || 'join') === 'rows' ? 'rows' : 'join',
        separator: separatorElement ? separatorElement.value : ', ',
        emptyRow: emptyRowElement ? Boolean(emptyRowElement.checked) : true
      });
    });
    return columns;
  }

  function readViewComposerFields() {
    var sourceAlias = finalBaseResultAlias(readCurrentSpec()) || String(readValue('cmdp-view-source') || '').trim();
    var title = String(readValue('cmdp-view-title') || '').trim();
    var mode = String(readValue('cmdp-view-mode') || 'table').trim() || 'table';
    var columns = readViewComposerColumnRows();
    if (!sourceAlias) throw new Error(t('viewComposerNeedsSource'));
    if (!columns.length) throw new Error(t('viewComposerNeedsColumn'));
    return {
      sourceAlias: sourceAlias,
      title: title || sourceAlias,
      mode: mode,
      showOnly: true,
      columns: columns
    };
  }

  function buildViewComposerSpec(model, previousSpec) {
    var spec = cloneSpecForEdit(previousSpec);
    spec.version = spec.version || 1;
    spec.steps = Array.isArray(spec.steps) ? spec.steps.slice() : [];
    spec.result = spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    spec.result.tables = Array.isArray(spec.result.tables) ? spec.result.tables.slice() : [];
    model.sourceAlias = finalBaseResultAlias(spec) || model.sourceAlias;
    model.showOnly = true;

    var previousVisual = getStoredVisualModel(spec, 'viewComposer');
    var previousOutputAlias = previousVisual && previousVisual.output && previousVisual.output.alias;
    var outputAlias = model.sourceAlias + 'View';
    if (outputAlias === model.sourceAlias) outputAlias = model.sourceAlias + '_view';
    spec.steps = spec.steps.filter(function (step) {
      return !(step && step.type === 'enrichRows' && step.purpose === 'viewComposer');
    });
    if (previousOutputAlias && previousOutputAlias !== outputAlias) {
      spec.result.tables = spec.result.tables.filter(function (table) {
        return !(table && table.name === previousOutputAlias);
      });
    }

    var viewColumns = model.columns.map(normalizeViewComposerColumn).filter(function (column) {
      return column.field;
    });
    var fields = [];
    var enrichColumns = [];
    var labels = {};
    viewColumns.forEach(function (column) {
      if (fields.indexOf(column.field) === -1) fields.push(column.field);
      if (column.title && column.title !== column.field) labels[column.field] = column.title;
      if (!enrichColumns.some(function (candidate) { return candidate.as === column.field; })) {
        enrichColumns.push({
          path: column.field,
          as: column.field,
          multiMode: column.multiMode || 'join',
          separator: column.separator === undefined ? ', ' : column.separator,
          emptyRow: column.emptyRow !== false
        });
      }
    });
    spec.steps.push({
      type: 'enrichRows',
      from: model.sourceAlias,
      columns: enrichColumns,
      purpose: 'viewComposer',
      as: outputAlias
    });
    var table = {
      name: outputAlias,
      title: model.title,
      columns: fields,
      columnLabels: labels
    };
    if (model.mode && model.mode !== 'table') table.mode = model.mode;
    var existingOutputTable = spec.result.tables.find(function (candidate) {
      return candidate && candidate.name === outputAlias;
    });
    if (existingOutputTable && existingOutputTable.emptyText) table.emptyText = existingOutputTable.emptyText;

    if (model.showOnly) {
      spec.result.tables = [table];
    } else {
      var tableIndex = spec.result.tables.findIndex(function (candidate) {
        return candidate && candidate.name === outputAlias;
      });
      if (tableIndex === -1) spec.result.tables.unshift(table);
      else spec.result.tables[tableIndex] = Object.assign({}, spec.result.tables[tableIndex], table);
    }

    upsertStoredVisualModel(spec, {
      version: 1,
      mode: 'viewComposer',
      source: {
        alias: model.sourceAlias
      },
      output: {
        alias: outputAlias,
        title: model.title,
        mode: model.mode,
        showOnly: model.showOnly,
        columns: viewColumns
      }
    });

    return spec;
  }

  function captureViewComposerDraftFromDom() {
    var columns = [];
    Array.prototype.slice.call(document.querySelectorAll('[data-view-column-row]')).forEach(function (row) {
      var fieldElement = row.querySelector('[data-view-column-field="field"]');
      var titleElement = row.querySelector('[data-view-column-field="title"]');
      var multiModeElement = row.querySelector('[data-view-column-field="multiMode"]');
      var separatorElement = row.querySelector('[data-view-column-field="separator"]');
      var emptyRowElement = row.querySelector('[data-view-column-field="emptyRow"]');
      var field = String(fieldElement && fieldElement.value || '').trim();
      var title = String(titleElement && titleElement.value || '').trim();
      if (!field && !title) return;
      columns.push({
        field: field,
        title: title || field,
        multiMode: String(multiModeElement && multiModeElement.value || 'join') === 'rows' ? 'rows' : 'join',
        separator: separatorElement ? separatorElement.value : ', ',
        emptyRow: emptyRowElement ? Boolean(emptyRowElement.checked) : true
      });
    });
    return {
      sourceAlias: finalBaseResultAlias(readCurrentSpec()) || String(readValue('cmdp-view-source') || '').trim(),
      title: String(readValue('cmdp-view-title') || '').trim(),
      mode: String(readValue('cmdp-view-mode') || 'table').trim() || 'table',
      showOnly: true,
      columns: columns
    };
  }

  function readVisualizationSettings(required) {
    var hasGlobalFields = hasField('cmdp-visual-empty-text') || hasField('cmdp-visual-permission-denied-text') || hasField('cmdp-visual-font-size') || hasField('cmdp-visual-density');
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-visualization-row]'));
    if (!hasGlobalFields && !rows.length && !required) return null;
    var settings = {
      emptyText: String(readValue('cmdp-visual-empty-text') || '').trim() || DEFAULT_EMPTY_RESULT_TEXT,
      permissionDeniedText: String(readValue('cmdp-visual-permission-denied-text') || '').trim() || DEFAULT_PERMISSION_DENIED_TEXT,
      fontSize: String(readValue('cmdp-visual-font-size') || 'normal').trim() || 'normal',
      density: String(readValue('cmdp-visual-density') || 'normal').trim() || 'normal',
      zebra: readChecked('cmdp-visual-zebra'),
      filters: readChecked('cmdp-visual-filters'),
      sortable: readChecked('cmdp-visual-sortable'),
      tables: []
    };
    rows.forEach(function (row) {
      var detailRow = row.nextElementSibling && row.nextElementSibling.hasAttribute('data-visualization-row-detail') ? row.nextElementSibling : row;
      function visualField(field) {
        return row.querySelector('[data-visualization-field="' + field + '"]') || detailRow.querySelector('[data-visualization-field="' + field + '"]');
      }
      var name = String((visualField('name') || {}).value || '').trim();
      if (!name) return;
      var title = String((visualField('title') || {}).value || '').trim();
      var titleAlign = normalizeTitleAlign((visualField('titleAlign') || {}).value || 'left');
      var mode = String((visualField('mode') || {}).value || 'table').trim() || 'table';
      var splitField = visualField('splitSubtables');
      var splitSubtables = Boolean(splitField && splitField.checked);
      var groupByField = visualField('groupBy');
    var groupBy = splitSubtables ? String((groupByField || {}).value || '').trim() : '';
    var groupByOption = groupByField && groupByField.options && groupByField.selectedIndex >= 0 ? groupByField.options[groupByField.selectedIndex] : null;
    var groupTitleColumnLabel = groupByOption ? String(groupByOption.getAttribute('data-token-label') || groupByOption.textContent || '').trim() : groupBy;
      var groupTitleTemplate = splitSubtables ? String((visualField('groupTitleTemplate') || {}).value || '').trim() : '';
      var sortColumn = String((visualField('sortColumn') || {}).value || '').trim();
      var sortDirection = String((visualField('sortDirection') || {}).value || 'asc').trim() === 'desc' ? 'desc' : 'asc';
      var rowGroupBy = [];
      Array.prototype.slice.call(detailRow.querySelectorAll('[data-visualization-field="rowGroupBy"]')).forEach(function (field) {
        var value = String(field.value || '').trim();
        if (value && rowGroupBy.indexOf(value) === -1) rowGroupBy.push(value);
      });
      var columnLinks = {};
      Array.prototype.slice.call(detailRow.querySelectorAll('[data-visualization-link-row]')).forEach(function (linkRow) {
        function linkField(field) {
          return linkRow.querySelector('[data-visualization-link-field="' + field + '"]');
        }
        var column = String((linkField('column') || {}).value || '').trim();
        var modeValue = String((linkField('mode') || {}).value || 'text').trim();
        var urlTemplate = String((linkField('urlTemplate') || {}).value || '').trim();
        var textTemplate = String((linkField('textTemplate') || {}).value || '').trim() || '$' + '{mysource.value}';
        var target = String((linkField('target') || {}).value || 'self').trim() === 'blank' ? 'blank' : 'self';
        var defaultTextTemplate = '$' + '{mysource.value}';
        var hasLinkDraft = modeValue === 'link' || urlTemplate || textTemplate !== defaultTextTemplate || target !== 'self';
        if (column && hasLinkDraft) {
          columnLinks[column] = {
            mode: modeValue === 'link' ? 'link' : 'text',
            urlTemplate: urlTemplate,
            textTemplate: textTemplate,
            target: target
          };
        }
      });
      var table = { name: name, mode: mode, titleAlign: titleAlign };
      if (title) table.title = title;
      if (splitSubtables) table.splitSubtables = true;
      if (groupBy) table.groupBy = groupBy;
      if (groupBy && groupTitleColumnLabel) table.groupTitleColumnLabel = groupTitleColumnLabel;
      if (groupTitleTemplate) table.groupTitleTemplate = groupTitleTemplate;
      if (rowGroupBy.length) table.rowGroupBy = rowGroupBy;
      if (sortColumn) table.sortColumn = sortColumn;
      if (sortColumn) table.sortDirection = sortDirection;
      if (Object.keys(columnLinks).length) table.columnLinks = columnLinks;
      settings.tables.push(table);
    });
    return settings;
  }

  function applyVisualizationToSpec(spec, required) {
    var settings = readVisualizationSettings(required);
    if (!settings) return spec;
    spec.result = spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
    spec.result.emptyText = settings.emptyText || DEFAULT_EMPTY_RESULT_TEXT;
    spec.result.permissionDeniedText = settings.permissionDeniedText || DEFAULT_PERMISSION_DENIED_TEXT;
    spec.result.presentation = {
      emptyText: settings.emptyText || DEFAULT_EMPTY_RESULT_TEXT,
      permissionDeniedText: settings.permissionDeniedText || DEFAULT_PERMISSION_DENIED_TEXT,
      fontSize: ['small', 'normal', 'large'].indexOf(settings.fontSize) === -1 ? 'normal' : settings.fontSize,
      density: settings.density === 'compact' ? 'compact' : 'normal',
      zebra: Boolean(settings.zebra),
      filters: Boolean(settings.filters),
      sortable: Boolean(settings.sortable),
      tables: settings.tables
    };
    var byName = {};
    settings.tables.forEach(function (item) { byName[item.name] = item; });
    spec.result.tables = Array.isArray(spec.result.tables) ? spec.result.tables.map(function (table) {
      if (!table || !table.name || !byName[table.name]) return table;
      var settingsTable = byName[table.name];
      var next = Object.assign({}, table);
      next.mode = settingsTable.mode || next.mode || 'table';
      if (settingsTable.title) next.title = settingsTable.title;
      else delete next.title;
      delete next.titleParam;
      next.emptyText = settings.emptyText || DEFAULT_EMPTY_RESULT_TEXT;
      next.presentation = {
        titleAlign: normalizeTitleAlign(settingsTable.titleAlign),
        splitSubtables: Boolean(settingsTable.splitSubtables),
        groupBy: settingsTable.groupBy || '',
        groupTitleColumnLabel: settingsTable.groupTitleColumnLabel || '',
        groupTitleTemplate: settingsTable.groupTitleTemplate || '',
        rowGroupBy: normalizeVisualizationRowGroupBy(settingsTable.rowGroupBy),
        sortColumn: settingsTable.sortColumn || '',
        sortDirection: settingsTable.sortDirection || 'asc',
        columnLinks: normalizeColumnLinks(settingsTable.columnLinks)
      };
      return next;
    }) : [];
    upsertStoredVisualModel(spec, {
      mode: 'presentation',
      version: 1,
      presentation: spec.result.presentation
    });
    return spec;
  }

  function readObjectGroupScopeRows(container) {
    var rules = [];
    var rows = Array.prototype.slice.call((container || document).querySelectorAll('[data-object-scope-row]'));
    rows.forEach(function (row) {
      var actionElement = row.querySelector('[data-object-scope-field="action"]');
      var pathElement = row.querySelector('[data-object-scope-field="path"]');
      var negateElement = row.querySelector('[data-object-scope-field="negate"]');
      var opElement = row.querySelector('[data-object-scope-field="op"]');
      var regexElement = row.querySelector('[data-object-scope-field="regex"]');
      var action = String(actionElement && actionElement.value || 'include').trim() === 'exclude' ? 'exclude' : 'include';
      var path = String(pathElement && pathElement.value || '').trim();
      var op = normalizeObjectGroupOperator(opElement && opElement.value || 'matches');
      var negate = normalizeObjectGroupNegate(negateElement && negateElement.value, opElement && opElement.value);
      var regex = String(regexElement && regexElement.value || '').trim();
      if (!path && !regex) return;
      if (!path) throw new Error(t('objectGroupNeedsPath'));
      if (objectGroupOperatorUsesValue(op) && !regex) throw new Error(t('objectGroupNeedsRegex'));
      if (op === 'matches') {
        try {
          new RegExp(regex.replace(/\$\{(param|var|contractparam)\.([A-Za-z_][A-Za-z0-9_]*)\}/g, ''));
        } catch (error) {
          throw new Error(t('objectGroupInvalidRegex') + ': ' + (error && error.message ? error.message : String(error)));
        }
      }
      rules.push({
        action: action,
        path: path,
        negate: negate,
        op: op,
        regex: regex
      });
    });
    return rules;
  }

  function readObjectGroupFields() {
    var selectionNodes = Array.prototype.slice.call(document.querySelectorAll('[data-object-selection]'));
    if (!selectionNodes.length && hasField('cmdp-object-class')) {
      var legacyClassName = String(readValue('cmdp-object-class') || '').trim();
      var legacyRules = readObjectGroupScopeRows(document);
      if (!legacyClassName) throw new Error(t('objectGroupNeedsClass'));
      return {
        className: legacyClassName,
        rules: legacyRules.length ? legacyRules : [{ action: 'include', path: 'Code', regex: '.*' }],
        selections: [normalizeObjectSelection({
          name: defaultObjectSelectionName(0),
          alias: 'objects',
          className: legacyClassName,
          rules: legacyRules
        }, 0)]
      };
    }

    var selections = selectionNodes.map(function (node, index) {
      var nameField = node.querySelector('[data-object-selection-field="name"]');
      var classField = node.querySelector('[data-object-selection-field="className"]');
      var className = String(classField && classField.value || '').trim();
      var rules = readObjectGroupScopeRows(node);
      if (!className) throw new Error(t('objectGroupNeedsClass'));
      return normalizeObjectSelection({
        name: String(nameField && nameField.value || '').trim() || defaultObjectSelectionName(index),
        alias: objectSelectionAlias(index),
        className: className,
        sourceType: isBaaSourceClassName(className) ? 'baa' : 'cmdb',
        baaObjectAlias: baaAliasFromSourceClassName(className),
        rules: rules.length ? rules : [{ action: 'include', path: 'Code', regex: '.*' }]
      }, index);
    });
    if (!selections.length) selections = [defaultObjectSelection(0, state.selectedClass || '')];
    return {
      className: selections[0] && selections[0].className || '',
      rules: selections[0] && selections[0].rules || [],
      selections: selections
    };
  }

  function buildObjectGroupSpec(model, previousSpec) {
    var selections = objectSelectionsFromModel(model);
    var params = previousSpec && previousSpec.params && typeof previousSpec.params === 'object' && !Array.isArray(previousSpec.params)
      ? JSON.parse(JSON.stringify(previousSpec.params))
      : {};
    selections.forEach(function (selection) {
      selection.rules.forEach(function (rule) {
        String(rule.regex || '').replace(/\$\{param\.([A-Za-z_][A-Za-z0-9_]*)\}/g, function (_, name) {
          if (!params[name]) params[name] = { type: 'string', required: true };
          return '';
        });
      });
    });
    var hasBaaSelection = selections.some(function (selection) { return selection && (selection.sourceType === 'baa' || isBaaSourceClassName(selection.className)); });
    var steps = selections.map(function (selection, index) {
      var filters = selection.rules.map(function (rule) {
        return {
          scope: rule.action === 'exclude' ? 'exclude' : 'include',
          path: rule.path,
          negate: normalizeObjectGroupNegate(rule.negate !== undefined ? rule.negate : rule.not, rule.op || rule.operator),
          op: normalizeObjectGroupOperator(rule.op || rule.operator || 'matches'),
          regex: rule.regex,
          value: rule.regex
          };
        });
      if (selection.sourceType === 'baa' || isBaaSourceClassName(selection.className)) {
        return {
          type: 'baaPlanObjects',
          objectAlias: selection.baaObjectAlias || baaAliasFromSourceClassName(selection.className),
          payloadPrefix: 'Payload.',
          filters: filters,
          as: objectSelectionAlias(index)
        };
      }
      return {
        type: 'selectCards',
        className: selection.className,
        filters: filters,
        limit: 100,
        as: objectSelectionAlias(index)
      };
    });
    if (hasBaaInputSpec(previousSpec || {}) && !hasBaaSelection) {
      steps.unshift({ type: 'baaPlanObjects', as: 'baaObjects', payloadPrefix: 'Payload.' });
    }
    var tables = selections.map(function (selection, index) {
      if (selection.sourceType === 'baa' || isBaaSourceClassName(selection.className)) {
        return {
          name: objectSelectionAlias(index),
          title: selection.name || defaultObjectSelectionName(index),
          columns: baaScopePathOptionsForSource(previousSpec || {}, selection.className).map(function (item) { return item.value; })
        };
      }
      return {
        name: objectSelectionAlias(index),
        title: selection.name || defaultObjectSelectionName(index),
        columns: ['Class', 'Code', 'Description']
      };
    });
    if (hasBaaInputSpec(previousSpec || {}) && !hasBaaSelection) {
      tables.unshift({
        name: 'baaObjects',
        title: 'BAA candidates',
        columns: baaColumnOptionRows(previousSpec || {}).map(function (item) { return item.value; })
      });
    }
    var first = selections[0] || defaultObjectSelection(0, '');
    var visualSelections = selections.map(function (selection, index) {
      return {
        name: selection.name || defaultObjectSelectionName(index),
        alias: objectSelectionAlias(index),
        className: selection.className,
        sourceType: selection.sourceType,
        baaObjectAlias: selection.baaObjectAlias || baaAliasFromSourceClassName(selection.className),
        scopeRules: selection.rules,
        source: {
          type: selection.sourceType,
          className: selection.className,
          baaObjectAlias: selection.baaObjectAlias || baaAliasFromSourceClassName(selection.className),
          limit: 100
        },
        output: {
          alias: objectSelectionAlias(index),
          title: selection.name || defaultObjectSelectionName(index),
          columns: ['Class', 'Code', 'Description']
        }
      };
    });

    return {
      version: 1,
      params: params,
      visualModel: {
        version: 1,
        mode: 'objectGroup',
        selections: visualSelections,
        scopeRules: first.rules,
        source: {
          className: first.className,
          limit: 100
        },
        output: {
          alias: 'objects',
          title: first.name || defaultObjectSelectionName(0),
          columns: ['Class', 'Code', 'Description']
        },
        catalog: {
          maxTraversalDepth: Number(state.maxTraversalDepth) || 1
        }
      },
      visualModels: [{
        version: 1,
        mode: 'objectGroup',
        selections: visualSelections
      }],
      steps: steps,
      result: {
        tables: tables
      },
      endpoint: previousSpec && previousSpec.endpoint ? previousSpec.endpoint : (hasBaaInputSpec(previousSpec || {}) ? { kind: 'baaVerification' } : undefined),
      baaContract: previousSpec && previousSpec.baaContract ? previousSpec.baaContract : undefined,
      publish: previousSpec && previousSpec.publish ? previousSpec.publish : undefined,
      cache: previousSpec && previousSpec.cache ? previousSpec.cache : undefined,
      defaults: previousSpec && previousSpec.defaults ? previousSpec.defaults : undefined
    };
  }

  function hasObjectMatchingConfig(spec) {
    return Boolean(getStoredVisualModel(spec || {}, 'objectMatching')) || getObjectMatchingSteps(spec || {}).length > 0;
  }

  function hasViewComposerConfig(spec) {
    var steps = spec && Array.isArray(spec.steps) ? spec.steps : [];
    return Boolean(getStoredVisualModel(spec || {}, 'viewComposer')) || steps.some(function (step) {
      return step && step.type === 'enrichRows' && step.purpose === 'viewComposer';
    });
  }

  function objectGroupDraftFromSelections(selections) {
    var normalized = objectSelectionsFromModel({ selections: selections });
    var first = normalized[0] || defaultObjectSelection(0, '');
    return {
      className: first.className,
      rules: first.rules,
      selections: normalized
    };
  }

  function buildObjectGroupSpecPreservingDownstream(model, previousSpec) {
    var previous = previousSpec || defaultSpec();
    var nextDraft = objectGroupDraftFromSelections(objectSelectionsFromModel(model));
    var previousObjectDraft = state.objectGroupDraft;
    var previousMatchingModel = null;
    var previousViewModel = null;

    state.objectGroupDraft = null;
    try {
      if (hasObjectMatchingConfig(previous)) previousMatchingModel = inferRelationExpansionModel(previous);
      if (hasViewComposerConfig(previous)) previousViewModel = inferViewComposerModel(previous);
    } finally {
      state.objectGroupDraft = previousObjectDraft;
    }

    state.objectGroupDraft = nextDraft;
    try {
      var spec = buildObjectGroupSpec(nextDraft, previous);
      var matchingPreserved = false;
      if (previousMatchingModel && nextDraft.selections.length >= 2) {
        previousMatchingModel = Object.assign({}, previousMatchingModel, {
          selections: nextDraft.selections
        });
        spec = buildRelationExpansionSpec(previousMatchingModel, spec);
        matchingPreserved = true;
      }
      if (previousViewModel && Array.isArray(previousViewModel.columns) && previousViewModel.columns.length && (!hasObjectMatchingConfig(previous) || matchingPreserved)) {
        spec = buildViewComposerSpec(previousViewModel, spec);
      }
      return spec;
    } finally {
      state.objectGroupDraft = previousObjectDraft;
    }
  }

  function captureObjectGroupDraftFromDom() {
    function captureRules(container) {
      var rules = [];
      Array.prototype.slice.call((container || document).querySelectorAll('[data-object-scope-row]')).forEach(function (row) {
        var actionElement = row.querySelector('[data-object-scope-field="action"]');
        var pathElement = row.querySelector('[data-object-scope-field="path"]');
        var negateElement = row.querySelector('[data-object-scope-field="negate"]');
        var opElement = row.querySelector('[data-object-scope-field="op"]');
        var regexElement = row.querySelector('[data-object-scope-field="regex"]');
        var path = String(pathElement && pathElement.value || '').trim();
        var regex = String(regexElement && regexElement.value || '').trim();
        if (!path && !regex) return;
        rules.push({
          action: String(actionElement && actionElement.value || 'include').trim() === 'exclude' ? 'exclude' : 'include',
          path: path,
          negate: normalizeObjectGroupNegate(negateElement && negateElement.value, opElement && opElement.value),
          op: normalizeObjectGroupOperator(opElement && opElement.value || 'matches'),
          regex: regex
        });
      });
      return rules;
    }
    var selectionNodes = Array.prototype.slice.call(document.querySelectorAll('[data-object-selection]'));
    var selections = selectionNodes.map(function (node, index) {
      var nameField = node.querySelector('[data-object-selection-field="name"]');
      var classField = node.querySelector('[data-object-selection-field="className"]');
      var rules = captureRules(node);
      return normalizeObjectSelection({
        name: String(nameField && nameField.value || '').trim() || defaultObjectSelectionName(index),
        alias: objectSelectionAlias(index),
        className: String(classField && classField.value || '').trim(),
        sourceType: isBaaSourceClassName(classField && classField.value) ? 'baa' : 'cmdb',
        baaObjectAlias: baaAliasFromSourceClassName(classField && classField.value),
        rules: rules.length ? rules : [{ action: 'include', path: 'Code', regex: '.*' }]
      }, index);
    });
    if (!selections.length) {
      var legacyRules = captureRules(document);
      selections = [normalizeObjectSelection({
        name: defaultObjectSelectionName(0),
        alias: 'objects',
        className: String(readValue('cmdp-object-class') || '').trim(),
        rules: legacyRules.length ? legacyRules : [{ action: 'include', path: 'Code', regex: '.*' }]
      }, 0)];
    }
    var first = selections[0] || defaultObjectSelection(0, '');
    return {
      className: first.className,
      rules: first.rules,
      selections: selections
    };
  }

  function readRelationExpansionFields() {
    var previousSpec = readCurrentSpec();
    var selections = matchingSelectionsForSpec(previousSpec);
    if (selections.length < 2) throw new Error(t('matchingNeedsSelections'));
    var blocks = [];
    Array.prototype.slice.call(document.querySelectorAll('[data-matching-block]')).forEach(function (blockNode, index) {
      var fromField = blockNode.querySelector('[data-matching-block-field="from"]');
      var withField = blockNode.querySelector('[data-matching-block-field="with"]');
      var asField = blockNode.querySelector('[data-matching-block-field="as"]');
      var rules = [];
      Array.prototype.slice.call(blockNode.querySelectorAll('[data-matching-rule-row]')).forEach(function (row) {
        var actionElement = row.querySelector('[data-matching-rule-field="action"]');
        var leftColumnElement = row.querySelector('[data-matching-rule-field="leftColumn"]');
        var leftRegexElement = row.querySelector('[data-matching-rule-field="leftRegex"]');
        var negateElement = row.querySelector('[data-matching-rule-field="negate"]');
        var operatorElement = row.querySelector('[data-matching-rule-field="operator"]');
        var rightColumnElement = row.querySelector('[data-matching-rule-field="rightColumn"]');
        var rightRegexElement = row.querySelector('[data-matching-rule-field="rightRegex"]');
        var leftColumn = String(leftColumnElement && leftColumnElement.value || '').trim();
        var rightColumn = String(rightColumnElement && rightColumnElement.value || '').trim();
        var leftRegex = String(leftRegexElement && leftRegexElement.value || '').trim();
        var rightRegex = String(rightRegexElement && rightRegexElement.value || '').trim();
        if (!leftColumn && !rightColumn && !leftRegex && !rightRegex) return;
        if (!leftColumn || !rightColumn) throw new Error(t('matchingNeedsColumn'));
        [leftRegex, rightRegex].forEach(function (regex) {
          if (!regex) return;
          try {
            new RegExp(regex.replace(/\$\{(param|var|contractparam)\.([A-Za-z_][A-Za-z0-9_]*)\}/g, ''));
          } catch (error) {
            throw new Error(t('matchingInvalidRegex') + ': ' + (error && error.message ? error.message : String(error)));
          }
        });
        rules.push({
          action: String(actionElement && actionElement.value || 'include').trim() === 'exclude' ? 'exclude' : 'include',
          negate: normalizeMatchingNegate(negateElement && negateElement.value),
          operator: normalizeMatchingOperator(operatorElement && operatorElement.value || 'equals'),
          leftColumn: leftColumn,
          leftRegex: leftRegex,
          rightColumn: rightColumn,
          rightRegex: rightRegex
        });
      });
      if (!rules.length) throw new Error(t('matchingNeedsRule'));
      blocks.push(normalizeMatchingBlock({
        from: String(fromField && fromField.value || '').trim(),
        with: String(withField && withField.value || '').trim(),
        as: String(asField && asField.value || '').trim(),
        rules: rules
      }, index, selections, index > 0 && blocks[index - 1] ? blocks[index - 1].as : ''));
    });
    return normalizeObjectMatchingModel({ blocks: blocks }, previousSpec);
  }

  function addSelectionMaterializedColumn(columnsByAlias, alias, column) {
    var sourceAlias = String(alias || '').trim();
    var field = String(column || '').trim();
    if (!sourceAlias || !field) return;
    if (sourceAlias === 'baaObjects') return;
    if (isBaaSourceClassName(sourceClassForAlias(readCurrentSpec(), sourceAlias))) return;
    field = stripKnownSelectionPrefix(readCurrentSpec(), sourceAlias, field);
    if (!columnsByAlias[sourceAlias]) columnsByAlias[sourceAlias] = [];
    if (columnsByAlias[sourceAlias].indexOf(field) === -1) columnsByAlias[sourceAlias].push(field);
  }

  function collectMatchingSelectionColumns(model) {
    var columnsByAlias = {};
    var firstLeftAlias = model.blocks[0] && model.blocks[0].from || model.selections[0] && model.selections[0].alias || 'objects';
    model.blocks.forEach(function (block, index) {
      (block.rules || []).forEach(function (rule) {
        if (index === 0) addSelectionMaterializedColumn(columnsByAlias, block.from, rule.leftColumn);
        else model.selections.forEach(function (selection, selectionIndex) {
          var alias = selection.alias || objectSelectionAlias(selectionIndex);
          var leftColumn = String(rule.leftColumn || '');
          if (alias && (leftColumn.indexOf(alias + '_') === 0 || leftColumn.indexOf(objectSelectionOutputPrefixFromList(model.selections, alias)) === 0)) {
            addSelectionMaterializedColumn(columnsByAlias, alias, rule.leftColumn);
          }
        });
        if (index > 0 && !model.selections.some(function (selection, selectionIndex) {
          var alias = selection.alias || objectSelectionAlias(selectionIndex);
          var leftColumn = String(rule.leftColumn || '');
          return alias && (leftColumn.indexOf(alias + '_') === 0 || leftColumn.indexOf(objectSelectionOutputPrefixFromList(model.selections, alias)) === 0);
        })) addSelectionMaterializedColumn(columnsByAlias, firstLeftAlias, rule.leftColumn);
        addSelectionMaterializedColumn(columnsByAlias, block.with, rule.rightColumn);
      });
    });
    return columnsByAlias;
  }

  function buildSelectionColumnSpecs(columns) {
    return uniqueList(columns || []).map(function (column) {
      return { path: column, as: column, multiMode: 'join', separator: ', ', emptyRow: true };
    });
  }

  function matchingResultColumnNames(model) {
    if (!model.blocks.length) return [];
    var columns = [];
    function add(column) {
      var text = String(column || '').trim();
      if (text && columns.indexOf(text) === -1) columns.push(text);
    }
    ['Class', '_id', 'Code', 'Description'].forEach(add);
    model.blocks.forEach(function (block) {
      (block.rules || []).forEach(function (rule) {
        add(rule.leftColumn);
        add((block.rightPrefix || block.with + '_') + rule.rightColumn);
      });
      ['Class', '_id', 'Code', 'Description'].forEach(function (column) {
        add((block.rightPrefix || block.with + '_') + column);
      });
    });
    return columns;
  }

  function matchingResultColumnLabels(model, spec) {
    var labels = {};
    if (!model.blocks.length) return labels;
    var firstAlias = model.blocks[0] && model.blocks[0].from || model.selections[0] && model.selections[0].alias || 'objects';
    ['Class', '_id', 'Code', 'Description'].forEach(function (column) {
      labels[column] = formatObjectSelectionColumnLabel(spec || defaultSpec(), firstAlias, column);
    });
    model.blocks.forEach(function (block) {
      var prefix = block.rightPrefix || objectSelectionOutputPrefix(spec || defaultSpec(), block.with);
      (block.rules || []).forEach(function (rule) {
        if (rule.leftColumn && !labels[rule.leftColumn]) {
          labels[rule.leftColumn] = rule.leftColumn.indexOf('.') !== -1 ? rule.leftColumn : formatObjectSelectionColumnLabel(spec || defaultSpec(), firstAlias, rule.leftColumn);
        }
        if (rule.rightColumn) {
          labels[prefix + rule.rightColumn] = formatObjectSelectionColumnLabel(spec || defaultSpec(), block.with, rule.rightColumn);
        }
      });
      ['Class', '_id', 'Code', 'Description'].forEach(function (column) {
        labels[prefix + column] = formatObjectSelectionColumnLabel(spec || defaultSpec(), block.with, column);
      });
    });
    return labels;
  }

  function buildRelationExpansionSpec(model, previousSpec) {
    model = normalizeObjectMatchingModel(model, previousSpec || defaultSpec());
    var cmdbSelections = model.selections.filter(function (selection) { return selection && selection.alias !== 'baaObjects'; });
    var objectSpec = buildObjectGroupSpec({
      selections: cmdbSelections
    }, previousSpec || defaultSpec());
    var specForLabels = objectSpec || previousSpec || defaultSpec();
    var columnsByAlias = collectMatchingSelectionColumns(model);
    var steps = (objectSpec.steps || []).map(function (step) {
      var copy = Object.assign({}, step);
      var materializedColumns = columnsByAlias[copy.as] || [];
      if (materializedColumns.length) copy.columns = buildSelectionColumnSpecs(materializedColumns);
      return copy;
    });
    if (hasBaaInputSpec(previousSpec || {}) || model.selections.some(function (selection) { return selection && (selection.sourceType === 'baa' || selection.alias === 'baaObjects'); })) {
      steps.unshift({ type: 'baaPlanObjects', as: 'baaObjects', payloadPrefix: 'Payload.' });
    }
    model.blocks.forEach(function (block, index) {
      steps.push({
        type: 'matchRows',
        purpose: 'objectMatching',
        from: index === 0 ? block.from : model.blocks[index - 1].as,
        with: block.with,
        rules: block.rules.map(function (rule) {
          return {
            action: rule.action === 'exclude' ? 'exclude' : 'include',
            negate: normalizeMatchingNegate(rule.negate),
            operator: normalizeMatchingOperator(rule.operator || 'equals'),
            left: {
              column: rule.leftColumn,
              regex: rule.leftRegex
            },
            right: {
              column: rule.rightColumn,
              regex: rule.rightRegex
            }
          };
        }),
        caseSensitive: false,
        rightPrefix: block.rightPrefix || objectSelectionOutputPrefix(specForLabels, block.with),
        as: block.as
      });
    });
    var finalAlias = model.output && model.output.alias || model.blocks[model.blocks.length - 1] && model.blocks[model.blocks.length - 1].as || '';
    var resultTables = (objectSpec.result && objectSpec.result.tables ? objectSpec.result.tables.slice() : []).concat(finalAlias ? [{
      name: finalAlias,
      title: t('extractionFinalResult'),
      columns: matchingResultColumnNames(model),
      columnLabels: matchingResultColumnLabels(model, specForLabels)
    }] : []);
    var spec = {
      version: 1,
      params: objectSpec.params || {},
      visualModel: objectSpec.visualModel,
      visualModels: objectSpec.visualModels || [],
      steps: steps,
      result: {
        tables: resultTables
      },
      endpoint: previousSpec && previousSpec.endpoint ? previousSpec.endpoint : (hasBaaInputSpec(previousSpec || {}) ? { kind: 'baaVerification' } : undefined),
      baaContract: previousSpec && previousSpec.baaContract ? previousSpec.baaContract : undefined,
      publish: previousSpec && previousSpec.publish ? previousSpec.publish : undefined,
      cache: previousSpec && previousSpec.cache ? previousSpec.cache : undefined,
      defaults: previousSpec && previousSpec.defaults ? previousSpec.defaults : undefined
    };
    if (previousSpec && previousSpec.result && previousSpec.result.presentation) {
      spec.result.presentation = previousSpec.result.presentation;
    }
    return upsertStoredVisualModel(spec, {
      version: 1,
      mode: 'objectMatching',
      selections: model.selections,
      blocks: model.blocks,
      output: {
        alias: finalAlias,
        title: t('extractionFinalResult')
      },
      catalog: {
        maxTraversalDepth: Number(state.maxTraversalDepth) || 1
      }
    });
  }

  function captureRelationDraftFromDom() {
    try {
      return readRelationExpansionFields();
    } catch (error) {
      return state.relationDraft || normalizeObjectMatchingModel(null, readCurrentSpec());
    }
  }

  function cloneSpecForEdit(spec) {
    try {
      return JSON.parse(JSON.stringify(spec || defaultSpec()));
    } catch (error) {
      return defaultSpec();
    }
  }

  function cloneJsonValue(value, fallback) {
    try {
      return JSON.parse(JSON.stringify(value === undefined || value === null ? fallback : value));
    } catch (error) {
      try {
        return JSON.parse(JSON.stringify(fallback));
      } catch (fallbackError) {
        return fallback;
      }
    }
  }

  function readSpecWithEditorBlocks() {
    var specData = readSpecWithParamEditor();
    var extractionStep = readExtractionStepFields(false);
    if (extractionStep) specData.spec = upsertExtractionStep(specData.spec, extractionStep);
    var selectionStep = readDataSelectionStepFields(false);
    if (selectionStep) specData.spec = upsertDataSelectionStep(specData.spec, selectionStep);
    specData.spec = applyBaaEndpointToSpec(specData.spec, false);
    specData.spec = applyVisualizationToSpec(specData.spec, false);
    specData.spec = applyPublicationToSpec(specData.spec, false);
    specData.spec = applyCacheToSpec(specData.spec, false);
    specData.spec = applyCmdbBuildViewToSpec(specData.spec, false);
    return specData;
  }

  function clearDraftExecutionState(options) {
    options = options || {};
    state.result = null;
    state.extractionPreview = null;
    if (options.clearExtractionSource) state.extractionSource = '';
    state.lastDraftPreviewOk = false;
  }

  function updateSelectedFromEditor(spec) {
    var selected = state.selectedTemplate || {};
    var code = readTemplateCode(selected);
    var normalizedSpec = normalizeTemplateProtection(spec);
    state.selectedTemplate = Object.assign({}, selected, {
      code: code || selected.code || '',
      description: readTemplateDescription(selected, code) || selected.description || '',
      active: readTemplateActive(selected),
      spec: normalizedSpec,
      paramsSchema: readCurrentParamsSchema(selected.paramsSchema || {}),
      resultSchema: readCurrentResultSchema(selected.resultSchema || {})
    });
  }

  function applyParamsEditor() {
    try {
      var specData = readSpecWithParamEditor();
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples);
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('paramsApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function hasBaaEndpointEditorFields() {
    return hasField('cmdp-baa-contract-source') || hasField('cmdp-baa-contract-code') || hasField('cmdp-baa-contract-version');
  }

  function readBaaEndpointFields() {
    var sourceCode = String(readValue('cmdp-baa-contract-source') || '').trim();
    var sourceContract = sourceCode ? (state.baaInputContracts || []).find(function (item) { return item.code === sourceCode; }) : null;
    if (sourceContract && sourceContract.contract) {
      return {
        kind: 'baaVerification',
        contract: Object.assign({}, sourceContract.contract, {
          code: sourceContract.code || sourceContract.contract.code || '',
          version: sourceContract.version || sourceContract.contract.version || '',
          description: sourceContract.description || sourceContract.contract.description || '',
          variables: sourceContract.contract.contractParams || sourceContract.contract.variables || [],
          contractParams: sourceContract.contract.contractParams || sourceContract.contract.variables || [],
          requestVariables: sourceContract.contract.requestVariables || [],
          sourceCode: sourceContract.code,
          sourceClassName: sourceContract.className || ''
        })
      };
    }
    var variablesContainer = document.getElementById('cmdp-baa-contract-variables');
    var variables = readBaaFieldEditorRows(variablesContainer, true);
    var objects = Array.prototype.slice.call(document.querySelectorAll('[data-baa-object-row]')).map(function (row, index) {
      var aliasField = row.querySelector('[data-baa-object-field="alias"]');
      var classField = row.querySelector('[data-baa-object-field="className"]');
      var descriptionField = row.querySelector('[data-baa-object-field="description"]');
      var payloadField = row.querySelector('[data-baa-object-field="payload"]');
      var alias = String(aliasField && aliasField.value || ('candidate' + String(index + 1))).trim();
      var className = String(classField && classField.value || '').trim();
      var payload = readBaaFieldEditorRows(payloadField, false);
      if (!alias && !className && !payload.length) return null;
      if (!alias) throw new Error(t('fieldRequired', { label: t('baaObjectAlias') }));
      return {
        alias: alias,
        className: className,
        description: String(descriptionField && descriptionField.value || '').trim(),
        payload: payload
      };
    }).filter(Boolean);
    return {
      kind: 'baaVerification',
      contract: {
        code: String(readValue('cmdp-baa-contract-code') || '').trim(),
        version: String(readValue('cmdp-baa-contract-version') || '1').trim() || '1',
        description: String(readValue('cmdp-baa-contract-description') || '').trim(),
        sourceCode: sourceCode,
        variables: variables,
        contractParams: variables,
        requestVariables: [],
        objects: objects
      }
    };
  }

  function applyBaaContractSourceSelection(sourceCode) {
    var code = String(sourceCode || '').trim();
    var sourceContract = code ? (state.baaInputContracts || []).find(function (item) { return item.code === code; }) : null;
    if (sourceContract && sourceContract.contract) {
      state.baaContractDraft = Object.assign({}, sourceContract.contract, {
        code: sourceContract.code || sourceContract.contract.code || '',
        version: sourceContract.version || sourceContract.contract.version || '',
        description: sourceContract.description || sourceContract.contract.description || '',
        variables: sourceContract.contract.contractParams || sourceContract.contract.variables || [],
        contractParams: sourceContract.contract.contractParams || sourceContract.contract.variables || [],
        requestVariables: sourceContract.contract.requestVariables || [],
        sourceCode: sourceContract.code,
        sourceClassName: sourceContract.className || ''
      });
    } else {
      var current = baaContractForSpec(state.selectedTemplate && state.selectedTemplate.spec || defaultSpec());
      current.sourceCode = '';
      current.sourceClassName = '';
      state.baaContractDraft = current;
    }
    clearDraftExecutionState({ clearExtractionSource: true });
    renderDesigner();
  }

  function applyBaaEndpointToSpec(spec, required) {
    if (!hasBaaEndpointEditorFields() && !required) return spec;
    var next = cloneJsonValue(spec || defaultSpec(), defaultSpec());
    if (templateKindForSpec(next) === CMDB_BUILD_VIEW_KIND) {
      var publish = next.publish;
      var cache = next.cache;
      var params = next.params;
      next = defaultSpec();
      if (publish) next.publish = publish;
      if (cache) next.cache = cache;
      if (params) next.params = params;
    }
    next = normalizeTemplateProtection(next);
    var model = readBaaEndpointFields();
    state.baaContractDraft = model.contract;
    next.endpoint = Object.assign({}, next.endpoint || {}, { kind: 'baaVerification' });
    next.baaContract = model.contract;
    return ensureBaaPlanObjectSourceSteps(next);
  }

  function applyBaaEndpointEditor() {
    try {
      var specData = readSpecWithParamEditor();
      specData.spec = applyBaaEndpointToSpec(specData.spec, true);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples || {}, state.runParams || {});
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('baaEndpointApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function fillParamExamples() {
    try {
      var specData = readSpecWithParamEditor();
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples);
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('examplesFilled') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function clientExtractVariables(step, params) {
    var value = params && params[step.sourceParam] !== undefined ? params[step.sourceParam] : '';
    var text = Array.isArray(value) ? value.join('\\n') : String(value === undefined || value === null ? '' : value);
    var regex = new RegExp(step.regex, sanitizeRegexFlags(step.flags, step.all !== false));
    var columns = ['Source', 'Index', 'Match'];
    var rows = [];
    var match;
    var matchIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      var row = {
        Source: step.sourceParam,
        Index: matchIndex,
        Match: match[0]
      };
      if (match.groups && Object.keys(match.groups).length) {
        Object.keys(match.groups).forEach(function (key) {
          if (columns.indexOf(key) === -1) columns.push(key);
          row[key] = match.groups[key];
        });
      } else {
        for (var index = 1; index < match.length; index += 1) {
          var groupName = 'Group' + index;
          if (columns.indexOf(groupName) === -1) columns.push(groupName);
          row[groupName] = match[index];
        }
      }
      rows.push(row);
      matchIndex += 1;
      if (step.all === false) break;
      if (match[0] === '') regex.lastIndex += 1;
    }
    return {
      name: step.as,
      columns: columns,
      rows: rows,
      truncated: false
    };
  }

  function applyExtractionEditor() {
    try {
      var specData = readSpecWithParamEditor();
      var step = readExtractionStepFields(true);
      specData.spec = upsertExtractionStep(specData.spec, step);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples, state.runParams || {});
      clearDraftExecutionState({ clearExtractionSource: true });
      state.message = { type: 'ok', text: t('extractionApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function previewExtraction() {
    try {
      var specData = readSpecWithParamEditor();
      var step = readExtractionStepFields(true);
      specData.spec = upsertExtractionStep(specData.spec, step);
      updateSelectedFromEditor(specData.spec);
      var runParams = readRunParams();
      var params = Object.assign({}, specData.examples, runParams);
      state.runParams = params;
      state.extractionPreview = clientExtractVariables(step, params);
      state.message = { type: 'ok', text: t('extractionPreviewReady') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function extractByTemplate() {
    var payload;
    var params;
    try {
      payload = readEditorPayload();
      params = readRunParams();
      var specTables = payload.spec && payload.spec.result && Array.isArray(payload.spec.result.tables) ? payload.spec.result.tables : [];
      state.extractionSource = preferredExtractionResultName(payload.spec, specTables, readValue('cmdp-extraction-source') || state.extractionSource || '');
      payload.spec = ensureExtractionPreviewTable(payload.spec, state.extractionSource);
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    state.extractionPreview = null;
    request(apiPrefix + '/draft/preview?maxRows=100', {
      method: 'POST',
      body: { template: payload, params: params }
    }).then(function (result) {
      state.extractionPreview = result;
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('extractionCompleted') : errorText(result) };
      renderDesigner();
    }).catch(function (error) {
      state.extractionPreview = null;
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function applyDataSelectionEditor() {
    try {
      var specData = readSpecWithParamEditor();
      var extractionStep = readExtractionStepFields(false);
      if (extractionStep) specData.spec = upsertExtractionStep(specData.spec, extractionStep);
      var selectionStep = readDataSelectionStepFields(true);
      specData.spec = upsertDataSelectionStep(specData.spec, selectionStep);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples, state.runParams || {});
      clearDraftExecutionState({ clearExtractionSource: true });
      state.message = { type: 'ok', text: t('selectionApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyVisualizationEditor() {
    try {
      var specData = readSpecWithParamEditor();
      var extractionStep = readExtractionStepFields(false);
      if (extractionStep) specData.spec = upsertExtractionStep(specData.spec, extractionStep);
      var selectionStep = readDataSelectionStepFields(false);
      if (selectionStep) specData.spec = upsertDataSelectionStep(specData.spec, selectionStep);
      specData.spec = applyVisualizationToSpec(specData.spec, true);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples, state.runParams || {});
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('visualizationApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyPublicationEditor() {
    try {
      var specData = readSpecWithParamEditor();
      specData.spec = applyPublicationToSpec(specData.spec, true);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples, state.runParams || {});
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('publicationApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyCmdbBuildViewToSpec(spec, required) {
    if (!hasField('cmdp-cmdb-build-language') && !required) return spec;
    var next = cloneJsonValue(spec || defaultCmdbBuildViewSpecClient(), defaultCmdbBuildViewSpecClient());
    if (templateKindForSpec(next) !== CMDB_BUILD_VIEW_KIND) {
      var publish = next.publish;
      var cache = next.cache;
      next = defaultCmdbBuildViewSpecClient();
      if (publish) next.publish = publish;
      if (cache) next.cache = cache;
    }
    var sections = Array.prototype.slice.call(document.querySelectorAll('[data-cmdb-build-section]'))
      .filter(function (field) { return field.checked; })
      .map(function (field) { return field.getAttribute('data-cmdb-build-section'); })
      .filter(Boolean);
    if (!sections.length) sections = ['classes'];
    next.kind = CMDB_BUILD_VIEW_KIND;
    next.protected = true;
    next.params = next.params && typeof next.params === 'object' && !Array.isArray(next.params) ? next.params : {};
    next.cmdbBuildView = {
      language: readValue('cmdp-cmdb-build-language') || 'auto',
      showSystemAttributes: readChecked('cmdp-cmdb-build-system-attributes'),
      sections: sections,
      rootClass: String(readValue('cmdp-cmdb-build-root-class') || '').trim(),
      lookupScope: readValue('cmdp-cmdb-build-lookup-scope') === 'all' ? 'all' : 'used'
    };
    return next;
  }

  function applyCmdbBuildViewEditor() {
    try {
      var specData = readSpecWithParamEditor();
      specData.spec = applyCmdbBuildViewToSpec(specData.spec, true);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples, state.runParams || {});
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('cmdbBuildViewApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyCacheEditor() {
    try {
      var specData = readSpecWithParamEditor();
      specData.spec = applyCacheToSpec(specData.spec, true);
      updateSelectedFromEditor(specData.spec);
      state.runParams = Object.assign({}, specData.examples, state.runParams || {});
      clearDraftExecutionState();
      state.message = { type: 'ok', text: t('cacheApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyViewComposerEditor() {
    try {
      var previousSpec = readCurrentSpec();
      var model = readViewComposerFields();
      var spec = buildViewComposerSpec(model, previousSpec);
      updateSelectedFromEditor(spec);
      state.viewComposerDraft = model;
      clearDraftExecutionState({ clearExtractionSource: true });
      state.message = { type: 'ok', text: t('viewComposerApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyObjectGroupEditor() {
    try {
      var previousSpec = readCurrentSpec();
      var model = readObjectGroupFields();
      var spec = buildObjectGroupSpecPreservingDownstream(model, previousSpec);
      updateSelectedFromEditor(spec);
      state.objectGroupDraft = model;
      state.relationDraft = null;
      state.viewComposerDraft = null;
      state.selectedClass = model.className;
      state.classAttributes = catalogAttributeOptions(model.className).filter(function (item) {
        return !['Code', 'Description', '_id'].includes(item.name);
      });
      clearDraftExecutionState({ clearExtractionSource: true });
      state.message = { type: 'ok', text: t('objectGroupApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function applyRelationExpansionEditor() {
    try {
      var previousSpec = readCurrentSpec();
      var model = readRelationExpansionFields();
      var spec = buildRelationExpansionSpec(model, previousSpec);
      updateSelectedFromEditor(spec);
      state.relationDraft = model;
      state.viewComposerDraft = null;
      var firstSelection = model.selections && model.selections[0] || {};
      state.selectedClass = firstSelection.className || state.selectedClass || '';
      state.classAttributes = catalogAttributeOptions(state.selectedClass).filter(function (item) {
        return !['Code', 'Description', '_id'].includes(item.name);
      });
      state.runParams = Object.assign({}, state.runParams || {});
      clearDraftExecutionState({ clearExtractionSource: true });
      state.message = { type: 'ok', text: t('relationApplied') };
      renderDesigner();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    }
  }

  function addParamRow() {
    var body = document.getElementById('cmdp-param-rows');
    if (body) body.insertAdjacentHTML('beforeend', renderParamEditorRow({}));
  }

  function addBaaObjectRow() {
    var container = document.getElementById('cmdp-baa-object-rows');
    var index = container ? container.querySelectorAll('[data-baa-object-row]').length : 0;
    if (container) container.insertAdjacentHTML('beforeend', renderBaaContractObjectRow({
      alias: 'candidate' + String(index + 1),
      className: '',
      payload: [{ name: 'Code', type: 'string', required: false, example: '', description: '' }]
    }, index));
  }

  function addBaaFieldEditorRow(button, includeDefault) {
    var scope = includeDefault
      ? document.getElementById('cmdp-baa-contract-variables')
      : button && button.closest && button.closest('[data-baa-object-field="payload"]');
    var body = scope && scope.querySelector ? scope.querySelector('[data-baa-field-table] tbody') : null;
    if (body) body.insertAdjacentHTML('beforeend', renderBaaFieldEditorRow({}, includeDefault, false));
  }

  function clearBaaFieldEditorRow(button) {
    var row = button && button.closest ? button.closest('[data-baa-field-row]') : null;
    if (!row) return;
    var body = row.parentElement;
    if (body && body.querySelectorAll('[data-baa-field-row]').length <= 1) {
      row.querySelectorAll('input,textarea').forEach(function (field) { field.value = ''; });
      row.querySelectorAll('select').forEach(function (field) { field.value = 'false'; });
      return;
    }
    row.remove();
  }

  function clearBaaObjectRow(button) {
    var row = button && button.closest ? button.closest('[data-baa-object-row]') : null;
    if (!row) return;
    var container = row.parentElement;
    if (container && container.querySelectorAll('[data-baa-object-row]').length <= 1) {
      row.querySelectorAll('input,textarea').forEach(function (field) { field.value = ''; });
      row.querySelectorAll('select').forEach(function (field) { field.value = 'false'; });
      return;
    }
    row.remove();
  }

  function addObjectGroupScopeRuleRow(button) {
    var selection = button && button.closest ? button.closest('[data-object-selection]') : null;
    var body = selection ? selection.querySelector('tbody') : document.getElementById('cmdp-object-scope-rows');
    var classField = selection ? selection.querySelector('[data-object-selection-field="className"]') : null;
    var className = classField && classField.value || readValue('cmdp-object-class') || (state.objectGroupDraft && state.objectGroupDraft.className) || state.selectedClass || '';
    clearDraftExecutionState({ clearExtractionSource: true });
    if (body) body.insertAdjacentHTML('beforeend', renderObjectGroupScopeRuleRow({ action: 'include', path: 'Code', regex: '.*' }, className));
  }

  function addObjectSelection() {
    var draft = captureObjectGroupDraftFromDom();
    var selections = objectSelectionsFromModel(draft);
    selections.push(defaultObjectSelection(selections.length, selections[0] && selections[0].className || state.selectedClass || ''));
    state.objectGroupDraft = {
      className: selections[0] && selections[0].className || '',
      rules: selections[0] && selections[0].rules || [],
      selections: selections
    };
    state.relationDraft = null;
    state.viewComposerDraft = null;
    clearDraftExecutionState({ clearExtractionSource: true });
    renderDesigner();
  }

  function addMatchingRuleRow(button) {
    var blockNode = button && button.closest ? button.closest('[data-matching-block]') : null;
    if (!blockNode) return;
    var body = blockNode.querySelector('[data-matching-rule-list]') || blockNode.querySelector('tbody');
    var blockIndex = Number(blockNode.getAttribute('data-matching-block-index') || 0);
    var draft = captureRelationDraftFromDom();
    var block = draft.blocks && draft.blocks[blockIndex] || {};
    var spec = readCurrentSpec();
    var leftOptions = matchingLeftColumnOptions(spec, draft, blockIndex, block);
    var rightOptions = matchingRightColumnOptions(spec, block);
    clearDraftExecutionState({ clearExtractionSource: true });
    if (body) body.insertAdjacentHTML('beforeend', renderMatchingRuleRow(defaultMatchingRule(), leftOptions, rightOptions));
  }

  function clearObjectGroupScopeRuleRow(button) {
    var row = button && button.closest ? button.closest('[data-object-scope-row]') : null;
    if (!row) return;
    row.remove();
    clearDraftExecutionState({ clearExtractionSource: true });
  }

  function clearMatchingRuleRow(button) {
    var row = button && button.closest ? button.closest('[data-matching-rule-row]') : null;
    if (!row) return;
    row.querySelectorAll('input').forEach(function (field) {
      field.value = '';
    });
    row.querySelectorAll('select').forEach(function (field) {
      var name = field.getAttribute('data-matching-rule-field') || '';
      if (name === 'action') field.value = 'include';
      else if (name === 'negate') field.value = 'false';
      else if (name === 'operator') field.value = 'equals';
      else field.value = '';
    });
    clearDraftExecutionState({ clearExtractionSource: true });
  }

  function clearParamRow(button) {
    var row = button && button.closest ? button.closest('[data-param-row]') : null;
    if (!row) return;
    row.querySelectorAll('input').forEach(function (field) {
      if (field.type === 'checkbox') field.checked = false;
      else field.value = '';
    });
    var typeField = row.querySelector('[data-param-field="type"]');
    if (typeField) typeField.value = 'string';
  }

  function addSelectionFilterRow() {
    var body = document.getElementById('cmdp-selection-filter-rows');
    if (body) body.insertAdjacentHTML('beforeend', renderSelectionFilterRow({}));
  }

  function clearSelectionFilterRow(button) {
    var row = button && button.closest ? button.closest('[data-selection-filter-row]') : null;
    if (!row) return;
    row.querySelectorAll('input').forEach(function (field) {
      field.value = '';
    });
    var opField = row.querySelector('[data-selection-filter-field="op"]');
    if (opField) opField.value = 'equals';
  }

  function addViewComposerColumnRow() {
    var body = document.getElementById('cmdp-view-column-rows');
    var spec = state.selectedTemplate && state.selectedTemplate.spec ? state.selectedTemplate.spec : defaultSpec();
    var sourceAlias = finalBaseResultAlias(spec) || readValue('cmdp-view-source') || (state.viewComposerDraft && state.viewComposerDraft.sourceAlias) || '';
    if (body) body.insertAdjacentHTML('beforeend', renderViewComposerColumnRow({}, spec, sourceAlias));
  }

  function clearViewComposerColumnRow(button) {
    var row = button && button.closest ? button.closest('[data-view-column-row]') : null;
    if (!row) return;
    row.querySelectorAll('input').forEach(function (field) {
      field.value = '';
    });
    row.querySelectorAll('select').forEach(function (field) {
      field.value = '';
    });
  }

  function refreshVisualizationRowGroupLabels(container) {
    Array.prototype.slice.call((container || document).querySelectorAll('[data-visualization-row-group]')).forEach(function (row, index) {
      var label = row.querySelector('[data-row-group-label]');
      if (label) label.textContent = index > 0 ? t('visualizationRowGroupNextBy') : t('visualizationRowGroupBy');
    });
  }

  function applyObjectPathFilter(container) {
    Array.prototype.slice.call((container || document).querySelectorAll('[data-object-selection]')).forEach(function (selection) {
      var filter = selection.querySelector('[data-object-path-filter]');
      if (!filter) return;
      var domain = String((filter.querySelector('[data-object-path-filter-field="domain"]') || {}).value || '').trim().toLowerCase();
      var cardinality = String((filter.querySelector('[data-object-path-filter-field="cardinality"]') || {}).value || '').trim().toLowerCase();
      var direction = String((filter.querySelector('[data-object-path-filter-field="direction"]') || {}).value || '').trim().toLowerCase();
      Array.prototype.slice.call(selection.querySelectorAll('[data-object-scope-field="path"] option')).forEach(function (option) {
        if (!option.value) {
          option.hidden = false;
          return;
        }
        var matches = true;
        if (domain && String(option.getAttribute('data-domain') || '').toLowerCase() !== domain) matches = false;
        if (cardinality && String(option.getAttribute('data-cardinality') || '').toLowerCase() !== cardinality) matches = false;
        if (direction && String(option.getAttribute('data-direction') || '').toLowerCase() !== direction) matches = false;
        option.hidden = !matches;
      });
    });
  }

  function visualizationColumnOptionsHtmlForRowGroup(container) {
    var detailRow = container && container.closest ? container.closest('[data-visualization-row-detail]') : null;
    var source = detailRow && detailRow.querySelector('[data-visualization-column-options]');
    if (source && source.innerHTML) return source.innerHTML;
    source = detailRow && detailRow.querySelector('[data-visualization-field="groupBy"]');
    if (source && source.innerHTML) return source.innerHTML;
    source = detailRow && detailRow.querySelector('[data-visualization-field="sortColumn"]');
    if (source && source.innerHTML) return source.innerHTML;
    source = container && container.querySelector('[data-visualization-field="rowGroupBy"]');
    return source && source.innerHTML ? source.innerHTML : '<option value=""></option>';
  }

  function addVisualizationRowGroup(button) {
    var container = button && button.closest ? button.closest('[data-visualization-row-groups]') : null;
    if (!container) return;
    var options = visualizationColumnOptionsHtmlForRowGroup(container);
    var insertBefore = container.querySelector('[data-visualization-row-group-insert]') || button.parentElement || container;
    insertBefore.insertAdjacentHTML('beforebegin',
      '<div class="visual-row-group" data-visualization-row-group>' +
      '<label><span data-row-group-label>' + t('visualizationRowGroupNextBy') + '</span><select data-visualization-field="rowGroupBy">' + options + '</select></label>' +
      '<button data-action="clear-visual-row-group" type="button">' + t('clear') + '</button>' +
      '</div>');
    refreshVisualizationRowGroupLabels(container);
  }

  function clearVisualizationRowGroup(button) {
    var row = button && button.closest ? button.closest('[data-visualization-row-group]') : null;
    var container = button && button.closest ? button.closest('[data-visualization-row-groups]') : null;
    if (!row || !container) return;
    var rows = Array.prototype.slice.call(container.querySelectorAll('[data-visualization-row-group]'));
    if (rows.length <= 1) {
      var select = row.querySelector('[data-visualization-field="rowGroupBy"]');
      if (select) select.value = '';
      return;
    }
    row.remove();
    refreshVisualizationRowGroupLabels(container);
  }

  function saveTemplate() {
    var payload;
    try { payload = readEditorPayload(); } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    var exists = Boolean(state.selectedTemplate && state.selectedTemplate.id);
    var path = exists ? apiPrefix + '/templates/' + encodeURIComponent(state.selectedTemplate.code) : apiPrefix + '/templates';
    var wasCreating = state.designerSection === 'template';
    request(path, { method: exists ? 'PUT' : 'POST', body: payload }).then(function (result) {
      if (!result.ok) throw new Error(errorText(result));
      state.selectedTemplate = result.json.template;
      state.message = { type: 'ok', text: t('saved') };
      state.paramRowsDraft = null;
      state.lastDraftPreviewOk = false;
      if (wasCreating) {
        state.designerSection = 'templates';
        if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'templates' }, '', designerSectionUrl('templates'));
      }
      return loadDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    });
  }

  function runDraftAction(action) {
    var code = readTemplateCode();
    if (!code) {
      state.message = { type: 'error', text: t('templateCodeRequired') };
      renderDesigner();
      return;
    }
    var payload;
    var params;
    try {
      payload = readEditorPayload();
      params = readRunParams();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    request(apiPrefix + '/draft/' + action + '?maxRows=25', {
      method: 'POST',
      body: { template: payload, params: params }
    }).then(function (result) {
      state.result = result;
      state.lastDraftPreviewOk = action === 'preview' && result.ok;
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t(action === 'validate' ? 'draftValidateCompleted' : 'draftPreviewCompleted') : errorText(result) };
      state.designerSection = 'run';
      if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'run' }, '', designerSectionUrl('run'));
      renderDesigner();
    }).catch(function (error) {
      state.lastDraftPreviewOk = false;
      state.message = { type: 'error', text: error.message };
      renderDesigner();
    });
  }

  function saveAfterTest() {
    if (!state.lastDraftPreviewOk) {
      state.message = { type: 'error', text: t('saveNeedsPreview') };
      renderDesigner();
      return;
    }
    saveTemplate();
  }

  function bootstrapSchema() {
    var root = readValue('cmdp-root') || state.root;
    var description = readValue('cmdp-schema-description') || currentSchemaDescription();
    var parent = readValue('cmdp-schema-parent') || currentSchemaParent();
    var classes = schemaClassOverridesPayload(state.schemaPlan || state.schema);
    var rootOverride = classes.find(function (item) { return item.role === 'root'; });
    if (rootOverride && rootOverride.name) root = rootOverride.name;
    state.root = root;
    state.schemaRootDraft = root;
    state.schemaDescriptionDraft = description;
    state.schemaParentDraft = parent;
    state.schemaClassDrafts = readSchemaClassDraftsFromDom();
    if (hasField('cmdp-schema-confirm') && !readChecked('cmdp-schema-confirm')) {
      state.message = { type: 'error', text: t('schemaConfirmRequired') };
      renderDesigner();
      return;
    }
    if (!canBootstrapSchema()) {
      state.message = { type: 'error', text: t('bootstrapRequiresAdmin') };
      renderDesigner();
      return;
    }
    request(apiPrefix + '/schema/bootstrap', { method: 'POST', body: { root: root, description: description, parent: parent, classes: classes, confirm: true } }).then(function (result) {
      state.schema = result.json ? result.json.schema : null;
      state.schemaPlan = state.schema;
      state.schemaClassDrafts = schemaClassDraftsFromPlan(state.schemaPlan);
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('schemaBootstrapDone') : errorText(result) };
      renderDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function previewSchema() {
    var root = readValue('cmdp-root') || state.root;
    var description = readValue('cmdp-schema-description') || currentSchemaDescription();
    var parent = readValue('cmdp-schema-parent') || currentSchemaParent();
    var classes = schemaClassOverridesPayload(state.schemaPlan || state.schema);
    var rootOverride = classes.find(function (item) { return item.role === 'root'; });
    if (rootOverride && rootOverride.name) root = rootOverride.name;
    state.root = root;
    state.schemaRootDraft = root;
    state.schemaDescriptionDraft = description;
    state.schemaParentDraft = parent;
    state.schemaClassDrafts = readSchemaClassDraftsFromDom();
    request(apiPrefix + '/schema/preview', { method: 'POST', body: { root: root, description: description, parent: parent, classes: classes } }).then(function (result) {
      state.schemaPlan = result.json ? result.json.schema : null;
      state.schema = state.schemaPlan || state.schema;
      state.schemaClassDrafts = schemaClassDraftsFromPlan(state.schemaPlan);
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('schemaPreviewReady') : errorText(result) };
      renderDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function applyRuntimeCacheFields(runtimeConfig) {
    var next = normalizeRuntimeConfigForEditor(runtimeConfig);
    if (hasField('cmdp-runtime-refresh-cooldown-sec')) {
      next.runtimeCache.refreshCooldownSec = readPositiveIntField('cmdp-runtime-refresh-cooldown-sec', t('runtimeRefreshCooldownSec'), next.runtimeCache.refreshCooldownSec);
    }
    return next;
  }

  function applyRuntimeExecutionLimitFields(runtimeConfig) {
    var next = normalizeRuntimeConfigForEditor(runtimeConfig);
    var fields = [
      ['cmdp-runtime-max-rows-default', 'runtimeMaxRowsDefault', 'maxRowsDefault'],
      ['cmdp-runtime-max-rows-preview-default', 'runtimeMaxRowsPreviewDefault', 'maxRowsPreviewDefault'],
      ['cmdp-runtime-max-rows-max', 'runtimeMaxRowsMax', 'maxRowsMax'],
      ['cmdp-runtime-max-classes-default', 'runtimeMaxClassesDefault', 'maxClassesDefault'],
      ['cmdp-runtime-max-classes-max', 'runtimeMaxClassesMax', 'maxClassesMax'],
      ['cmdp-runtime-max-domains-default', 'runtimeMaxDomainsDefault', 'maxDomainsDefault'],
      ['cmdp-runtime-max-domains-max', 'runtimeMaxDomainsMax', 'maxDomainsMax'],
      ['cmdp-runtime-max-rest-calls-default', 'runtimeMaxRestCallsDefault', 'maxRestCallsDefault'],
      ['cmdp-runtime-max-rest-calls-max', 'runtimeMaxRestCallsMax', 'maxRestCallsMax'],
      ['cmdp-runtime-max-traversal-depth-default', 'runtimeMaxTraversalDepthDefault', 'maxTraversalDepthDefault'],
      ['cmdp-runtime-max-traversal-depth-max', 'runtimeMaxTraversalDepthMax', 'maxTraversalDepthMax']
    ];
    fields.forEach(function (item) {
      if (!hasField(item[0])) return;
      next.executionLimits[item[2]] = readPositiveIntField(item[0], t(item[1]), next.executionLimits[item[2]]);
    });
    return next;
  }

  function applyBaaTechnicalFields(runtimeConfig) {
    var next = normalizeRuntimeConfigForEditor(runtimeConfig);
    var fields = [
      ['cmdp-baa-superclass-path', 'superclassPath'],
      ['cmdp-baa-conversion-contract-class', 'conversionContractClass'],
      ['cmdp-baa-conversion-contract-version-class', 'conversionContractVersionClass'],
      ['cmdp-baa-verification-input-contract-class', 'verificationInputContractClass'],
      ['cmdp-baa-verification-output-contract-class', 'verificationOutputContractClass'],
      ['cmdp-baa-verification-endpoint-class', 'verificationEndpointClass']
    ];
    fields.forEach(function (item) {
      if (!hasField(item[0])) return;
      next.baaTechnical[item[1]] = String(readValue(item[0]) || '').trim() || defaultRuntimeConfig().baaTechnical[item[1]];
    });
    return next;
  }

  function applyRuntimeConfigFields(runtimeConfig) {
    var next = applyRuntimeCacheFields(runtimeConfig);
    next = applyRuntimeExecutionLimitFields(next);
    next = applyBaaTechnicalFields(next);
    return next;
  }

  function persistRuntimeConfig(root, runtimeConfig) {
    request(apiPrefix + '/config?root=' + encodeURIComponent(root), {
      method: 'PUT',
      body: { active: true, runtimeConfig: runtimeConfig }
    }).then(function (result) {
      state.config = result.json ? result.json.config : null;
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('configSaved') : errorText(result) };
      renderDesigner();
    });
  }

  function saveConfig() {
    var root = readValue('cmdp-root') || state.root;
    state.root = root;
    var runtimeConfig = state.config && state.config.runtimeConfig ? state.config.runtimeConfig : defaultRuntimeConfig();
    try {
      runtimeConfig = applyRuntimeConfigFields(runtimeConfig);
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    persistRuntimeConfig(root, runtimeConfig);
  }

  function saveGeneralSettings() {
    var root = readValue('cmdp-root') || state.root;
    var runtimeConfig = state.config && state.config.runtimeConfig ? state.config.runtimeConfig : defaultRuntimeConfig();
    state.root = root;
    try {
      runtimeConfig = applyRuntimeConfigFields(runtimeConfig);
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    persistRuntimeConfig(root, runtimeConfig);
  }

  function refreshDesigner() {
    state.root = readValue('cmdp-root') || state.root;
    loadDesigner();
  }

  function syncCatalog() {
    state.catalogSyncing = true;
    state.catalogStatus = Object.assign({}, state.catalogStatus || {}, { state: 'syncing', error: '' });
    renderDesigner();
    request(apiPrefix + '/model/catalog?maxClasses=500&maxDomains=500&includeAttributes=true').then(function (result) {
      if (!result.ok || !result.json || !result.json.catalog) {
        throw new Error(errorText(result));
      }
      return writeCatalogCache(result.json.catalog).then(function (record) {
        applyCatalogCache(record);
        state.catalogSyncing = false;
        state.message = { type: 'ok', text: t('catalogReady') };
        renderDesigner();
      });
    }).catch(function (error) {
      state.catalogSyncing = false;
      state.catalogStatus = {
        state: 'error',
        updatedAt: state.catalogStatus && state.catalogStatus.updatedAt,
        error: error.message || String(error)
      };
      state.message = { type: 'error', text: t('catalogError') + ': ' + (error.message || String(error)) };
      renderDesigner();
    });
  }

  function selectClassFromCatalog(className) {
    var name = String(className || '').trim();
    var catalogClass = catalogClassByName(name);
    if (!catalogClass) return;
    state.selectedClass = catalogClass.name || name;
    state.classCheckResult = null;
    state.checkedClass = catalogClass;
    state.classAttributes = catalogClass.attributes || [];
    state.message = { type: 'ok', text: t('catalogClassApplied') };
    renderDesigner();
  }

  function selectTemplate(code) {
    state.selectedTemplate = state.templates.find(function (item) { return item.code === code; }) || null;
    state.objectGroupDraft = null;
    state.baaContractDraft = null;
    state.relationDraft = null;
    state.viewComposerDraft = null;
    state.paramRowsDraft = null;
    state.result = null;
    state.extractionPreview = null;
    state.extractionSource = '';
    state.checkedClass = null;
    state.classCheckResult = null;
    state.classAttributes = [];
    hydrateDesignerStateFromTemplate({ replaceRunParams: true });
    state.designerSection = 'templates';
    if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'templates' }, '', designerSectionUrl('templates'));
    fetchVersions(code).then(renderDesigner);
  }

  function loadVersion(versionId) {
    var version = state.templateVersions.find(function (item) { return String(item.id) === String(versionId); });
    if (!version) return;
    var selected = state.selectedTemplate || {};
    state.selectedTemplate = {
      id: selected.id,
      code: selected.code,
      description: selected.description,
      active: selected.active !== false,
      spec: version.spec || selected.spec || defaultSpec(),
      paramsSchema: selected.paramsSchema || {},
      resultSchema: selected.resultSchema || {}
    };
    state.objectGroupDraft = null;
    state.baaContractDraft = null;
    state.relationDraft = null;
    state.viewComposerDraft = null;
    state.paramRowsDraft = null;
    state.extractionPreview = null;
    state.extractionSource = '';
    state.checkedClass = null;
    state.classCheckResult = null;
    state.classAttributes = [];
    hydrateDesignerStateFromTemplate({ replaceRunParams: true });
    state.message = { type: 'ok', text: t('versionLoaded') };
    state.designerSection = 'template';
    if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'template' }, '', designerSectionUrl('template'));
    renderDesigner();
  }

  function checkClassByName(className) {
    var name = String(className || '').trim();
    if (!name) {
      state.message = { type: 'error', text: t('fieldRequired', { label: t('classNameInput') }) };
      renderDesigner();
      return;
    }
    request(apiPrefix + '/model/classes/' + encodeURIComponent(name)).then(function (classResult) {
      state.classCheckResult = classResult;
      state.checkedClass = classResult.ok && classResult.json ? classResult.json.class : null;
      state.selectedClass = name;
      if (!classResult.ok) {
        state.classAttributes = [];
        state.message = { type: 'error', text: errorText(classResult) };
        renderDesigner();
        return null;
      }
      return request(apiPrefix + '/model/classes/' + encodeURIComponent(name) + '/attributes').then(function (attrResult) {
        state.classAttributes = attrResult.ok && attrResult.json && attrResult.json.data ? attrResult.json.data : [];
        state.message = attrResult.ok ? { type: 'ok', text: t('classFound') } : { type: 'error', text: errorText(attrResult) };
        renderDesigner();
        return attrResult;
      });
    }).catch(function (error) {
      state.classCheckResult = { ok: false, status: 0, json: null };
      state.checkedClass = null;
      state.classAttributes = [];
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function applyClassFallback() {
    var fallback = String(readValue('cmdp-class-fallback') || readValue('cmdp-class-check') || '').trim();
    if (!fallback) {
      state.message = { type: 'error', text: t('fieldRequired', { label: t('classNameFallback') }) };
      renderDesigner();
      return;
    }
    var specData;
    var spec;
    var paramsSchema;
    var resultSchema;
    try {
      specData = readSpecWithParamEditor();
      spec = specData.spec;
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    try {
      paramsSchema = readCurrentParamsSchema((state.selectedTemplate && state.selectedTemplate.paramsSchema) || {});
      resultSchema = readCurrentResultSchema((state.selectedTemplate && state.selectedTemplate.resultSchema) || {});
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    spec.defaults = spec.defaults && typeof spec.defaults === 'object' && !Array.isArray(spec.defaults) ? spec.defaults : {};
    spec.defaults.className = fallback;
    spec.params = spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {};
    spec.params.className = Object.assign({}, spec.params.className || {}, {
      type: (spec.params.className && spec.params.className.type) || 'string',
      required: false,
      default: (spec.params.className && spec.params.className.default) || fallback,
      example: (spec.params.className && spec.params.className.example) || fallback
    });
    updateSelectedFromEditor(spec);
    state.selectedTemplate.paramsSchema = paramsSchema;
    state.selectedTemplate.resultSchema = resultSchema;
    state.runParams = Object.assign({}, specData.examples || {}, state.runParams || {});
    if (!state.runParams.className) state.runParams.className = fallback;
    state.selectedClass = fallback;
    clearDraftExecutionState({ clearExtractionSource: true });
    state.message = { type: 'ok', text: t('classFallbackApplied') };
    renderDesigner();
  }

  function buildBuilderTemplate(kind, values) {
    var attrType = values.attrType || 'reference';
    var className = values.className || 'Asset';
    var depth = values.depth || '1';
    var referenceClass = values.referenceClass || className;
    var rightType = values.rightType || 'string';
    if (kind === 'domainTraversal') {
      return {
        code: 'BuilderDomainTraversal',
        description: t('builderDomainDescription'),
        params: { attrType: attrType, className: className, depth: depth },
        spec: { version: 1, params: { attrType: { type: 'string', required: true }, className: { type: 'string', required: true }, depth: { type: 'string', required: false, default: depth } }, steps: [
          { type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' },
          { type: 'filterRows', from: 'classes', filters: [{ column: 'Class', op: 'equals', valueParam: 'className' }], as: 'filteredClasses' },
          { type: 'traverseDomains', from: 'filteredClasses', direction: 'both', depthParam: 'depth', as: 'domains' }
        ], result: { tables: [
          { name: 'filteredClasses', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] },
          { name: 'domains', columns: ['Depth', 'Class', 'Domain', 'Source', 'Destination', 'Direction', 'RelatedClass', 'Cardinality'] }
        ] } }
      };
    }
    if (kind === 'attributeComparison') {
      return {
        code: 'BuilderAttributeComparison',
        description: t('builderComparisonDescription'),
        params: { attrType: attrType, referenceClass: referenceClass },
        spec: { version: 1, params: { attrType: { type: 'string', required: true }, referenceClass: { type: 'string', required: true } }, steps: [
          { type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' },
          { type: 'compareClassAttributes', from: 'classes', referenceClassParam: 'referenceClass', compareBy: ['name', 'type'], as: 'attributeComparison' }
        ], result: { tables: [{ name: 'attributeComparison', columns: ['Class', 'ComparedClass', 'CompareBy', 'CommonCount', 'ClassOnlyCount', 'ComparedClassOnlyCount', 'CommonAttributes'] }] } }
      };
    }
    if (kind === 'setOperations') {
      return {
        code: 'BuilderClassSetOperations',
        description: t('builderSetDescription'),
        params: { leftType: attrType, rightType: rightType },
        spec: { version: 1, params: { leftType: { type: 'string', required: true }, rightType: { type: 'string', required: true } }, steps: [
          { type: 'findClassesByAttributeType', attributeTypeParam: 'leftType', as: 'leftClasses' },
          { type: 'findClassesByAttributeType', attributeTypeParam: 'rightType', as: 'rightClasses' },
          { type: 'intersectRows', from: 'leftClasses', with: 'rightClasses', on: 'Class', distinct: true, as: 'classesWithBoth' },
          { type: 'joinRows', from: 'classesWithBoth', with: 'rightClasses', on: 'Class', mode: 'inner', rightPrefix: 'Right', as: 'joinedAttributes' }
        ], result: { tables: [
          { name: 'classesWithBoth', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] },
          { name: 'joinedAttributes', columns: ['Class', 'Attribute', 'AttributeType', 'RightAttribute', 'RightAttributeType'] }
        ] } }
      };
    }
    return {
      code: 'BuilderClassesByAttribute',
      description: t('builderClassesDescription'),
      params: { attrType: attrType },
      spec: defaultSpec()
    };
  }

  function applyBuilder() {
    var kind = readValue('cmdp-builder-kind') || 'classes';
    var built = buildBuilderTemplate(kind, {
      attrType: readValue('cmdp-builder-attr-type') || 'reference',
      className: readValue('cmdp-builder-class-name') || state.selectedClass || 'Asset',
      depth: readValue('cmdp-builder-depth') || '1',
      referenceClass: readValue('cmdp-builder-reference-class') || state.selectedClass || 'Asset',
      rightType: readValue('cmdp-builder-right-type') || 'string'
    });
    state.selectedTemplate = {
      code: readTemplateCode() || built.code,
      description: built.description,
      active: true,
      spec: built.spec,
      paramsSchema: {},
      resultSchema: {}
    };
    state.builderKind = kind;
    state.runParams = built.params;
    state.selectedClass = built.params.className || built.params.referenceClass || state.selectedClass;
    state.objectGroupDraft = null;
    state.baaContractDraft = null;
    state.relationDraft = null;
    state.viewComposerDraft = null;
    state.paramRowsDraft = null;
    state.checkedClass = null;
    state.classCheckResult = null;
    state.classAttributes = [];
    state.message = { type: 'ok', text: t('builderApplied') };
    renderDesigner();
  }

  function applyTemplateCopySource(code) {
    var sourceCode = String(code || '').trim();
    var selected = state.selectedTemplate || emptyTemplate();
    var currentCode = readTemplateCode(selected);
    var currentDescription = readTemplateDescription(selected, currentCode);
    var currentActive = readTemplateActive(selected);
    if (!sourceCode) {
      state.selectedTemplate = Object.assign({}, selected, {
        code: currentCode || selected.code || '',
        description: currentDescription || selected.description || '',
        active: currentActive,
        copySourceCode: ''
      });
      renderDesigner();
      return;
    }
    var source = state.templates.find(function (item) { return item.code === sourceCode; });
    if (!source) {
      state.message = { type: 'error', text: t('noTemplateToCopy') };
      renderDesigner();
      return;
    }
    state.selectedTemplate = {
      code: currentCode || '',
      description: currentDescription || '',
      active: currentActive,
      spec: cloneJsonValue(source.spec, defaultSpec()),
      paramsSchema: cloneJsonValue(source.paramsSchema, {}),
      resultSchema: cloneJsonValue(source.resultSchema, {}),
      copySourceCode: source.code
    };
    state.templateVersions = [];
    state.runParams = {};
    state.objectGroupDraft = null;
    state.baaContractDraft = null;
    state.relationDraft = null;
    state.viewComposerDraft = null;
    state.paramRowsDraft = null;
    state.extractionPreview = null;
    state.extractionSource = '';
    state.result = null;
    state.checkedClass = null;
    state.classCheckResult = null;
    state.classAttributes = [];
    hydrateDesignerStateFromTemplate({ replaceRunParams: true });
    state.message = { type: 'ok', text: t('templateCopyApplied', { code: source.code }) };
    renderDesigner();
  }

  function newTemplate() {
    state.selectedTemplate = { code: '', description: '', active: true, spec: defaultSpec(), paramsSchema: {}, resultSchema: {} };
    state.templateVersions = [];
    state.runParams = {};
    state.objectGroupDraft = null;
    state.baaContractDraft = null;
    state.relationDraft = null;
    state.viewComposerDraft = null;
    state.paramRowsDraft = null;
    state.extractionPreview = null;
    state.extractionSource = '';
    state.selectedClass = '';
    state.checkedClass = null;
    state.classCheckResult = null;
    state.classAttributes = [];
    state.result = null;
    state.message = null;
    state.designerSection = 'template';
    if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'template' }, '', designerSectionUrl('template'));
    renderDesigner();
  }

  function newCmdbBuildViewTemplate() {
    state.selectedTemplate = {
      code: DEFAULT_CMDB_BUILD_VIEW_CODE,
      description: 'CMDBuild model view',
      active: true,
      protected: true,
      spec: defaultCmdbBuildViewSpecClient(),
      paramsSchema: {},
      resultSchema: {}
    };
    state.templateVersions = [];
    state.runParams = {};
    state.objectGroupDraft = null;
    state.baaContractDraft = null;
    state.relationDraft = null;
    state.viewComposerDraft = null;
    state.paramRowsDraft = null;
    state.extractionPreview = null;
    state.extractionSource = '';
    state.selectedClass = '';
    state.checkedClass = null;
    state.classCheckResult = null;
    state.classAttributes = [];
    state.result = null;
    state.message = null;
    state.designerSection = 'template';
    if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'template' }, '', designerSectionUrl('template'));
    renderDesigner();
  }

  function deleteTemplate(code) {
    var templateCode = String(code || '').trim();
    if (!templateCode) return;
    if (!window.confirm(t('deleteTemplateConfirm', { code: templateCode }))) return;
    request(apiPrefix + '/templates/' + encodeURIComponent(templateCode), { method: 'DELETE' }).then(function (result) {
      if (!result.ok) throw new Error(errorText(result));
      if (state.selectedTemplate && state.selectedTemplate.code === templateCode) {
        state.selectedTemplate = null;
        state.templateVersions = [];
        state.runParams = {};
        state.result = null;
        state.paramRowsDraft = null;
      }
      state.message = { type: 'ok', text: t('templateDeleted') };
      state.designerSection = 'templates';
      if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'templates' }, '', designerSectionUrl('templates'));
      return loadDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function runtimeTemplateUrl(code, params) {
    var query = new URLSearchParams(params || {}).toString();
    return '/cmdbuild/dynamicpages/ui/run/' + encodeURIComponent(code) + (query ? '?' + query : '');
  }

  function absoluteRuntimeTemplateUrl(code, params) {
    var origin = window.location && window.location.origin ? window.location.origin : '';
    return origin + runtimeTemplateUrl(code, params);
  }

  function absoluteBaaVerifyUrl(code) {
    var origin = window.location && window.location.origin ? window.location.origin : '';
    return origin + apiPrefix + '/templates/' + encodeURIComponent(code || '') + '/baa-verify';
  }

  function openRun(code, newTab) {
    var selected = state.selectedTemplate || {};
    var params = runUrlParamsForTemplate(selected, true);
    var url = runtimeTemplateUrl(code, params);
    if (newTab && window.open) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    window.location.href = url;
  }

  function visualizeInEditor() {
    var payload;
    var params;
    try {
      payload = readEditorPayload();
      params = readRunParams();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    request(apiPrefix + '/draft/preview?maxRows=100', {
      method: 'POST',
      body: { template: payload, params: params }
    }).then(function (result) {
      state.result = result;
      state.lastDraftPreviewOk = result.ok;
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('visualizationRunCompleted') : errorText(result) };
      state.designerSection = 'run';
      if (window.history && window.history.pushState) window.history.pushState({ designerSection: 'run' }, '', designerSectionUrl('run'));
      renderDesigner();
    }).catch(function (error) {
      state.lastDraftPreviewOk = false;
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function visualizeExternal() {
    var code = readTemplateCode();
    if (!code) {
      state.message = { type: 'error', text: t('templateCodeRequired') };
      renderDesigner();
      return;
    }
    var url = runtimeTemplateUrl(code, runUrlParamsForTemplate(state.selectedTemplate || {}, true));
    if (window.open) window.open(url, '_blank', 'noopener');
    else window.location.href = url;
  }

  function forceRefreshInEditor() {
    var code = readTemplateCode();
    var params;
    if (!code) {
      state.message = { type: 'error', text: t('templateCodeRequired') };
      renderDesigner();
      return;
    }
    try {
      params = readRunParams();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    request(runtimeRunPath(code, {}, true, true), {
      method: 'POST',
      body: { params: params, refresh: true, forceRefresh: true }
    }).then(function (result) {
      state.result = result;
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('forceRefreshRunCompleted') : errorText(result) };
      state.designerSection = 'run';
      renderDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function readBaaRequestBody() {
    var field = document.getElementById('cmdp-baa-request');
    var text = field ? field.value : pretty(defaultBaaRequest(state.selectedTemplate || {}));
    state.baaRequestDraft = text;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error('BAA request JSON is invalid: ' + (error && error.message ? error.message : String(error)));
    }
  }

  function baaVerifyPreview(forceRefresh) {
    var code = readTemplateCode();
    var body;
    if (!code) {
      state.message = { type: 'error', text: t('templateCodeRequired') };
      renderDesigner();
      return;
    }
    try {
      body = readBaaRequestBody();
      if (forceRefresh) body.forceRefresh = true;
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    request(apiPrefix + '/templates/' + encodeURIComponent(code) + '/baa-verify?maxRows=100', {
      method: 'POST',
      body: body
    }).then(function (result) {
      state.result = result;
      state.message = { type: result.ok && result.json && result.json.success ? 'ok' : 'error', text: result.ok ? t('baaVerifyCompleted') : errorText(result) };
      state.designerSection = 'run';
      renderDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function publishSnapshot() {
    var code = readTemplateCode();
    if (!code) {
      state.message = { type: 'error', text: t('templateCodeRequired') };
      renderDesigner();
      return;
    }
    var params;
    var payload;
    try {
      payload = readEditorPayload();
      payload.spec = applyPublicationToSpec(payload.spec, true);
      params = readRunParams();
    } catch (error) {
      state.message = { type: 'error', text: error.message };
      renderDesigner();
      return;
    }
    var exists = Boolean(state.selectedTemplate && state.selectedTemplate.id);
    var savePath = exists ? apiPrefix + '/templates/' + encodeURIComponent(state.selectedTemplate.code) : apiPrefix + '/templates';
    request(savePath, { method: exists ? 'PUT' : 'POST', body: payload }).then(function (saveResult) {
      if (!saveResult.ok) throw new Error(errorText(saveResult));
      state.selectedTemplate = saveResult.json.template;
      return request(apiPrefix + '/templates/' + encodeURIComponent(payload.code) + '/publish', {
      method: 'POST',
      body: { params: params }
      });
    }).then(function (result) {
      state.result = result;
      state.message = { type: result.ok ? 'ok' : 'error', text: result.ok ? t('snapshotPublished') : errorText(result) };
      renderDesigner();
    }).catch(function (error) {
      state.message = { type: 'error', text: error.message || String(error) };
      renderDesigner();
    });
  }

  function refreshTemplateLaunchUrl() {
    var link = document.getElementById('cmdp-run-launch-url');
    var jsonLink = document.getElementById('cmdp-run-launch-json-url');
    var paramsText = document.getElementById('cmdp-run-launch-params');
    if (!link && !jsonLink && !paramsText) return;
    var code = (link && link.getAttribute('data-template-code')) || (jsonLink && jsonLink.getAttribute('data-template-code')) || readTemplateCode();
    if (!code) return;
    var params = runUrlParamsForTemplate(state.selectedTemplate || {}, true);
    var url = absoluteRuntimeTemplateUrl(code, params);
    if (link) {
      link.href = url;
      link.textContent = url;
    }
    if (jsonLink) {
      var jsonUrl = absoluteRuntimeTemplateUrl(code, Object.assign({}, params, { json: 'true' }));
      jsonLink.href = jsonUrl;
      jsonLink.textContent = jsonUrl;
    }
    if (paramsText) paramsText.textContent = runParamVariantsText(params);
  }

  function loadRuntime(refresh) {
    updateChrome();
    if (state.runtimeCountdownTimer) window.clearInterval(state.runtimeCountdownTimer);
    state.runtimeRefreshInProgress = Boolean(refresh);
    app.innerHTML = '<div class="notice">' + escapeHtml(refresh ? t('runtimeRefreshing') : t('runningTemplate')) + '</div>';
    var templateCode = boot.templateCode || '';
    var params = {};
    new URLSearchParams(window.location.search || '').forEach(function (value, key) {
      if (key === 'lang' || key === 'cmdpLang') return;
      params[key] = value;
    });
    state.runParams = params;
    if (boot.publicRuntime) {
      request(publicSnapshotRunPath(templateCode, params)).then(function (result) {
        state.runtimeRefreshInProgress = false;
        app.innerHTML = renderRuntimeResult(result);
        startRuntimeCountdown();
      }).catch(function (error) {
        state.runtimeRefreshInProgress = false;
        app.innerHTML = '<div class="notice error">' + escapeHtml(error.message || String(error)) + '</div>';
      });
      return;
    }
    request(runtimeRunPath(templateCode, params, Boolean(refresh))).then(function (result) {
      state.runtimeRefreshInProgress = false;
      if (!result.ok && resultIsPermissionDenied(result)) {
        return request(publicSnapshotRunPath(templateCode, params)).then(function (publicResult) {
          app.innerHTML = publicResult.ok && publicResult.json && publicResult.json.snapshotFound ? renderRuntimeResult(publicResult) : renderRuntimeResult(result);
          startRuntimeCountdown();
        });
      }
      app.innerHTML = renderRuntimeResult(result);
      startRuntimeCountdown();
    }).catch(function (error) {
      state.runtimeRefreshInProgress = false;
      app.innerHTML = '<div class="notice error">' + escapeHtml(error.message || String(error)) + '</div>';
    });
  }

  function applyRenderedTableFilter(input) {
    var wrapper = input && input.closest ? input.closest('[data-result-table]') : null;
    if (!wrapper) return;
    var query = String(input.value || '').toLowerCase();
    wrapper.querySelectorAll('[data-result-row]').forEach(function (row) {
      var text = row.getAttribute('data-filter-text') || '';
      row.style.display = !query || text.indexOf(query) !== -1 ? '' : 'none';
    });
    wrapper.querySelectorAll('[data-result-group]').forEach(function (group) {
      var rows = Array.prototype.slice.call(group.querySelectorAll('[data-result-row]'));
      if (!rows.length) return;
      var hasVisibleRows = rows.some(function (row) {
        return row.style.display !== 'none';
      });
      group.style.display = !query || hasVisibleRows ? '' : 'none';
    });
  }

  function sortRenderedTable(button) {
    var wrapper = button && button.closest ? button.closest('[data-result-table]') : null;
    if (!wrapper) return;
    var index = Number(button.getAttribute('data-column-index') || 0);
    var column = button.getAttribute('data-result-sort') || '';
    var direction = button.getAttribute('data-sort-direction') === 'desc' ? 'asc' : 'desc';
    wrapper.querySelectorAll('[data-result-sort]').forEach(function (item) {
      item.setAttribute('data-sort-direction', item.getAttribute('data-result-sort') === column ? direction : 'asc');
    });
    wrapper.querySelectorAll('tbody').forEach(function (body) {
      var rows = Array.prototype.slice.call(body.querySelectorAll('tr[data-result-row]'));
      rows.sort(function (left, right) {
        var leftText = (left.children[index] && left.children[index].textContent || '').trim();
        var rightText = (right.children[index] && right.children[index].textContent || '').trim();
        var leftNumber = Number(leftText);
        var rightNumber = Number(rightText);
        var result = !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && leftText !== '' && rightText !== ''
          ? leftNumber - rightNumber
          : leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
        return direction === 'desc' ? -result : result;
      });
      rows.forEach(function (row) { body.appendChild(row); });
    });
  }

  function defaultGroupTitleTemplateFromSelect(select) {
    if (!select) return '';
    var value = String(select.value || '').trim();
    if (!value) return '';
    var option = select.options && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    var label = option ? String(option.getAttribute('data-token-label') || option.textContent || '').trim() : '';
    return groupTitleToken(label || value);
  }

  function updateVisualizationGroupTitleDefault(field) {
    var detailRow = field && field.closest ? field.closest('[data-visualization-row-detail]') : null;
    if (!detailRow) {
      var row = field && field.closest ? field.closest('[data-visualization-row]') : null;
      detailRow = row && row.nextElementSibling && row.nextElementSibling.hasAttribute('data-visualization-row-detail') ? row.nextElementSibling : null;
    }
    if (!detailRow) return;
    var select = detailRow.querySelector('[data-visualization-field="groupBy"]');
    var input = detailRow.querySelector('[data-visualization-field="groupTitleTemplate"]');
    if (!select || !input) return;
    var nextDefault = defaultGroupTitleTemplateFromSelect(select);
    var previousDefault = input.getAttribute('data-default-group-title-template') || '';
    var current = String(input.value || '').trim();
    if (!current || current === previousDefault) {
      input.value = nextDefault;
    }
    input.setAttribute('data-default-group-title-template', nextDefault);
  }

  document.addEventListener('click', function (event) {
    var sortButton = event.target.closest('[data-result-sort]');
    if (sortButton) {
      event.preventDefault();
      sortRenderedTable(sortButton);
      return;
    }
    var sectionLink = event.target.closest('[data-designer-section]');
    if (sectionLink && boot.mode !== 'runtime') {
      event.preventDefault();
      if (sectionLink.getAttribute('data-disabled') === 'true') {
        state.message = { type: 'error', text: t('baaSectionDisabled') };
        renderDesigner();
        return;
      }
      setDesignerSection(sectionLink.getAttribute('data-designer-section'));
      return;
    }
    var target = event.target.closest('[data-action]');
    if (!target) return;
    event.preventDefault();
    var action = target.getAttribute('data-action');
    if (action === 'runtime-refresh') {
      if (target.getAttribute('data-disabled') === 'true') return;
      loadRuntime(true);
    }
    if (action === 'refresh') refreshDesigner();
    if (action === 'new-template') newTemplate();
    if (action === 'new-cmdb-build-view') newCmdbBuildViewTemplate();
    if (action === 'save-template') saveTemplate();
    if (action === 'validate-template') runDraftAction('validate');
    if (action === 'preview-template') runDraftAction('preview');
    if (action === 'visualize-editor') visualizeInEditor();
    if (action === 'force-refresh-editor') forceRefreshInEditor();
    if (action === 'visualize-external') visualizeExternal();
    if (action === 'baa-verify-preview') baaVerifyPreview();
    if (action === 'baa-verify-refresh-preview') baaVerifyPreview(true);
    if (action === 'select-template') selectTemplate(target.getAttribute('data-code'));
    if (action === 'delete-template') deleteTemplate(target.getAttribute('data-code'));
    if (action === 'apply-object-group') applyObjectGroupEditor();
    if (action === 'apply-baa-endpoint') applyBaaEndpointEditor();
    if (action === 'add-baa-object') addBaaObjectRow();
    if (action === 'add-baa-variable-row') addBaaFieldEditorRow(target, true);
    if (action === 'add-baa-payload-field') addBaaFieldEditorRow(target, false);
    if (action === 'clear-baa-field-row') clearBaaFieldEditorRow(target);
    if (action === 'clear-baa-object') clearBaaObjectRow(target);
    if (action === 'add-object-scope-row') addObjectGroupScopeRuleRow(target);
    if (action === 'add-object-selection') addObjectSelection();
    if (action === 'clear-object-scope-row') clearObjectGroupScopeRuleRow(target);
    if (action === 'apply-relation-expansion') applyRelationExpansionEditor();
    if (action === 'add-matching-rule-row') addMatchingRuleRow(target);
    if (action === 'clear-matching-rule-row') clearMatchingRuleRow(target);
    if (action === 'apply-cmdb-build-view') applyCmdbBuildViewEditor();
    if (action === 'add-param-row') addParamRow();
    if (action === 'apply-params') applyParamsEditor();
    if (action === 'fill-param-examples') fillParamExamples();
    if (action === 'clear-param-row') clearParamRow(target);
    if (action === 'extract-template') extractByTemplate();
    if (action === 'apply-extraction') applyExtractionEditor();
    if (action === 'preview-extraction') previewExtraction();
    if (action === 'add-selection-filter-row') addSelectionFilterRow();
    if (action === 'clear-selection-filter-row') clearSelectionFilterRow(target);
    if (action === 'apply-selection') applyDataSelectionEditor();
    if (action === 'add-view-column-row') addViewComposerColumnRow();
    if (action === 'clear-view-column-row') clearViewComposerColumnRow(target);
    if (action === 'apply-view-composer') applyViewComposerEditor();
    if (action === 'add-visual-row-group') addVisualizationRowGroup(target);
    if (action === 'clear-visual-row-group') clearVisualizationRowGroup(target);
    if (action === 'apply-visualization') applyVisualizationEditor();
    if (action === 'apply-publication') applyPublicationEditor();
    if (action === 'apply-cache') applyCacheEditor();
    if (action === 'publish-snapshot') publishSnapshot();
    if (action === 'draft-validate') runDraftAction('validate');
    if (action === 'draft-preview') runDraftAction('preview');
    if (action === 'save-after-test') saveAfterTest();
    if (action === 'check-class') checkClassByName(readValue('cmdp-class-check'));
    if (action === 'apply-class-fallback') applyClassFallback();
    if (action === 'select-class') checkClassByName(target.getAttribute('data-class'));
    if (action === 'load-version') loadVersion(target.getAttribute('data-version'));
    if (action === 'schema-preview') previewSchema();
    if (action === 'bootstrap-schema') bootstrapSchema();
    if (action === 'save-config') saveConfig();
    if (action === 'save-general-settings') saveGeneralSettings();
    if (action === 'apply-builder') applyBuilder();
    if (action === 'sync-catalog') syncCatalog();
    if (action === 'open-run') openRun(target.getAttribute('data-code') || readValue('cmdp-code'));
  });

  document.addEventListener('input', function (event) {
    if (event.target && event.target.matches && event.target.matches('[data-result-filter]')) {
      applyRenderedTableFilter(event.target);
    }
    if (event.target && event.target.matches && event.target.matches('[data-run-param-field]')) {
      refreshTemplateLaunchUrl();
    }
    if (event.target && event.target.matches && event.target.matches('[data-object-path-filter-field]')) {
      applyObjectPathFilter(event.target.closest('[data-object-selection]') || document);
    }
  });

  document.addEventListener('change', function (event) {
    if (event.target && event.target.matches && event.target.matches('[data-run-param-field]')) {
      refreshTemplateLaunchUrl();
    }
    if (event.target && event.target.matches && event.target.matches('[data-object-path-filter-field]')) {
      applyObjectPathFilter(event.target.closest('[data-object-selection]') || document);
    }
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target) return;
    if (target.matches && target.matches('[data-visualization-field="groupBy"], [data-visualization-field="splitSubtables"]')) {
      updateVisualizationGroupTitleDefault(target);
    }
    if (target.id === 'cmdp-copy-template-source') {
      applyTemplateCopySource(target.value);
      return;
    }
    if (target.id === 'cmdp-baa-contract-source') {
      applyBaaContractSourceSelection(target.value);
      return;
    }
    if (target.id === 'cmdp-max-depth') {
      var value = Math.max(1, Math.min(5, Number(target.value || 2)));
      state.maxTraversalDepth = value;
      writeStorageValue('cmdbdynamicpages.maxTraversalDepth', String(value));
      renderDesigner();
    }
    if (target.id === 'cmdp-catalog-class') {
      selectClassFromCatalog(target.value);
    }
    if (target.id === 'cmdp-extraction-source') {
      state.extractionSource = target.value;
      renderDesigner();
    }
    if (target.matches && target.matches('[data-object-selection-field="className"]')) {
      var draft = captureObjectGroupDraftFromDom();
      var selectionNode = target.closest('[data-object-selection]');
      var selectionIndex = Number(selectionNode && selectionNode.getAttribute('data-object-selection-index') || 0);
      if (draft.selections && draft.selections[selectionIndex]) draft.selections[selectionIndex].className = target.value;
      draft.className = draft.selections && draft.selections[0] ? draft.selections[0].className : target.value;
      state.objectGroupDraft = draft;
      state.relationDraft = null;
      state.viewComposerDraft = null;
      clearDraftExecutionState({ clearExtractionSource: true });
      if (!isBaaSourceClassName(target.value)) state.selectedClass = target.value;
      var catalogClass = isBaaSourceClassName(target.value) ? null : catalogClassByName(target.value);
      state.classAttributes = catalogClass && Array.isArray(catalogClass.attributes) ? catalogClass.attributes : [];
      renderDesigner();
    }
    if (target.matches && target.matches('[data-object-scope-field="op"]')) {
      var row = target.closest('[data-object-scope-row]');
      var valueField = row && row.querySelector('[data-object-scope-field="regex"]');
      if (valueField) {
        valueField.disabled = !objectGroupOperatorUsesValue(target.value);
        if (valueField.disabled) valueField.value = '';
      }
    }
    if (target.matches && target.matches('[data-matching-block-field="from"], [data-matching-block-field="with"]')) {
      var relationDraft = captureRelationDraftFromDom();
      state.relationDraft = relationDraft;
      state.viewComposerDraft = null;
      clearDraftExecutionState({ clearExtractionSource: true });
      renderDesigner();
    }
  });

  window.addEventListener('popstate', function () {
    if (boot.mode === 'runtime') return;
    if (!captureVisibleDesignerState()) return;
    state.designerSection = normalizeDesignerSection(readDesignerSectionFromLocation());
    ensureTemplateListOnNewDesignerSession();
    renderDesigner();
  });

  updateChrome();
  setupLanguageSelector();
  if (boot.mode === 'runtime') loadRuntime();
  else loadDesigner();
})();
`;
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

function executionThrottleScopeKey({ sessionHash = '', authToken = '', remoteAddress = '', action = '', templateCode = '' } = {}) {
  const actorHash = sessionHash ||
    (authToken ? sha256Hex(authToken).slice(0, 16) : '') ||
    sha256Hex(remoteAddress || 'anonymous').slice(0, 16);
  return [
    truncateText(action || 'execution', 80),
    truncateText(templateCode || 'draft', 120),
    actorHash
  ].join('|');
}

function executionThrottleScopeFromRequest(req, details = {}) {
  const rawAuthHeader = req.headers['cmdbuild-authorization'];
  const authToken = Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader;
  return executionThrottleScopeKey({
    sessionHash: sessionHashFromCookie(req.headers.cookie),
    authToken: authToken || '',
    remoteAddress: req.socket && req.socket.remoteAddress || '',
    action: details.action || '',
    templateCode: details.templateCode || ''
  });
}

function acquireExecutionSlot(req, res, details = {}) {
  if (!EXECUTION_THROTTLE_ENABLED) {
    return { release() {} };
  }

  const scopeKey = executionThrottleScopeFromRequest(req, details);
  const scopeCount = executionThrottleState.scopes.get(scopeKey) || 0;
  if (executionThrottleState.global >= EXECUTION_THROTTLE_MAX_GLOBAL || scopeCount >= EXECUTION_THROTTLE_MAX_PER_SCOPE) {
    incMetric('cmdp_execution_throttled_total', {
      action: details.action || 'execution'
    });
    logWarn('execution.throttled', {
      requestId: currentRequestId(),
      action: details.action || '',
      templateCode: details.templateCode || '',
      scopeHash: sha256Hex(scopeKey).slice(0, 16),
      scopeCount,
      globalCount: executionThrottleState.global,
      maxPerScope: EXECUTION_THROTTLE_MAX_PER_SCOPE,
      maxGlobal: EXECUTION_THROTTLE_MAX_GLOBAL
    });
    sendJson(res, 429, {
      success: false,
      reason: 'execution_throttled',
      message: 'Too many template executions are already running for this scope.',
      retryAfterSec: EXECUTION_THROTTLE_RETRY_AFTER_SEC
    }, {
      'retry-after': String(EXECUTION_THROTTLE_RETRY_AFTER_SEC)
    });
    return null;
  }

  executionThrottleState.scopes.set(scopeKey, scopeCount + 1);
  executionThrottleState.global += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const current = executionThrottleState.scopes.get(scopeKey) || 0;
      if (current <= 1) executionThrottleState.scopes.delete(scopeKey);
      else executionThrottleState.scopes.set(scopeKey, current - 1);
      executionThrottleState.global = Math.max(0, executionThrottleState.global - 1);
    }
  };
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

function technicalClassDescription(className, label) {
  const safeName = String(className || '').trim();
  const safeLabel = String(label || '').trim() || safeName;
  return truncateText(safeLabel, 250);
}

function technicalAttributeDescription(attribute) {
  const description = String(attribute && attribute.description || '').trim();
  if (description) return truncateText(description, 250);
  return truncateText(String(attribute && attribute.name || '').trim(), 250);
}

function normalizeTechnicalAttributes(attributes) {
  return (Array.isArray(attributes) ? attributes : []).map((attribute) => ({
    ...attribute,
    description: technicalAttributeDescription(attribute)
  }));
}

function schemaClassOverrideMap(options = {}) {
  const source = Array.isArray(options.classes)
    ? options.classes
    : Array.isArray(options.classOverrides)
      ? options.classOverrides
      : [];
  const map = {};
  source.forEach((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const role = String(item.role || item.schemaRole || '').trim();
    if (!['root', 'config', 'template', 'version'].includes(role)) return;
    const override = {};
    if (item.name !== undefined && String(item.name).trim()) {
      override.name = validateCmdbuildIdentifier(item.name, `${role} class`);
    }
    if (item.description !== undefined && String(item.description).trim()) {
      override.description = truncateText(String(item.description).trim(), 250);
    }
    map[role] = override;
  });
  return map;
}

function baseClassPayload(definition) {
  return {
    name: definition.name,
    description: definition.description || definition.name,
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
  const description = technicalAttributeDescription(attribute);
  const payload = {
    name: attribute.name,
    description,
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

function buildTechnicalSchema(rootValue, options = {}) {
  const overrides = schemaClassOverrideMap(options);
  const root = validateCmdbuildIdentifier((overrides.root && overrides.root.name) || rootValue || DEFAULT_TECHNICAL_ROOT, 'root');
  const rootParent = validateCmdbuildIdentifier(options.parent || options.rootParent || 'Class', 'schema parent');
  const prefix = getTechnicalPrefix(root);
  const classNames = {
    root,
    config: validateCmdbuildIdentifier(overrides.config && overrides.config.name || `${prefix}QueryToolConfig`, 'config class'),
    template: validateCmdbuildIdentifier(overrides.template && overrides.template.name || `${prefix}QueryTemplate`, 'template class'),
    version: validateCmdbuildIdentifier(overrides.version && overrides.version.name || `${prefix}QueryTemplateVersion`, 'template version class')
  };
  const rootDescription = technicalClassDescription(root, overrides.root && overrides.root.description || options.description || options.rootDescription || root);

  const classes = [
    {
      role: 'root',
      name: classNames.root,
      description: rootDescription,
      parent: rootParent,
      prototype: true,
      attributes: []
    },
    {
      role: 'config',
      name: classNames.config,
      description: technicalClassDescription(classNames.config, overrides.config && overrides.config.description || classNames.config),
      parent: classNames.root,
      prototype: false,
      attributes: [
        { name: 'RootCode', description: 'Root code', type: 'string', maxLength: 100, mandatory: true, showInGrid: true },
        { name: 'Active', description: 'Active', type: 'boolean', showInGrid: true },
        { name: 'RuntimeConfigJson', description: 'Runtime config JSON', type: 'json' }
      ]
    },
    {
      role: 'template',
      name: classNames.template,
      description: technicalClassDescription(classNames.template, overrides.template && overrides.template.description || classNames.template),
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
      role: 'version',
      name: classNames.version,
      description: technicalClassDescription(classNames.version, overrides.version && overrides.version.description || classNames.version),
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
    }
  ].map((classDefinition) => ({
    ...classDefinition,
    attributes: normalizeTechnicalAttributes(classDefinition.attributes)
  }));

  return {
    root,
    rootParent,
    rootDescription,
    prefix,
    classNames,
    classes
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
  logWarn('security.same_origin_rejected', {
    requestId: req.cmdpRequestId || '',
    method: req.method || '',
    path: sanitizeReqUrl(req),
    origin: truncateText(req.headers.origin || '', 500),
    referer: truncateText(req.headers.referer || '', 500)
  });
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
  logWarn('security.csrf_rejected', {
    requestId: req.cmdpRequestId || '',
    method: req.method || '',
    path: sanitizeReqUrl(req),
    hasToken: Boolean(provided),
    hasCmdbuildCookie: Boolean(authToken)
  });
  sendJson(res, 403, {
    success: false,
    message: 'State-changing custom API calls require a valid CSRF token.'
  });
  return false;
}

function requireStateChangingRequest(req, res, authToken) {
  return requireSameOriginMutation(req, res) && requireCsrfToken(req, res, authToken);
}

function requireBaaStateChangingRequest(req, res, authToken, authSource = 'cookie') {
  if (authSource === 'cmdbuild-authorization-header') {
    return true;
  }
  if (!hasSameOriginMutationHeaders(req)) {
    logWarn('security.same_origin_rejected', {
      requestId: req.cmdpRequestId || '',
      method: req.method || '',
      path: sanitizeReqUrl(req),
      origin: truncateText(req.headers.origin || '', 500),
      referer: truncateText(req.headers.referer || '', 500)
    });
    sendJson(res, 403, baaErrorResponse('SAME_ORIGIN_REQUIRED', 'BAA verification calls require a same-origin Origin or Referer header.'));
    return false;
  }
  const provided = req.headers['x-cmdbdynamicpages-csrf'];
  if (!provided || !timingSafeEqualString(provided, getCsrfToken(authToken))) {
    logWarn('security.csrf_rejected', {
      requestId: req.cmdpRequestId || '',
      method: req.method || '',
      path: sanitizeReqUrl(req),
      hasToken: Boolean(provided),
      hasCmdbuildCookie: Boolean(authToken)
    });
    sendJson(res, 403, baaErrorResponse('CSRF_REQUIRED', 'BAA verification calls require a valid X-CMDBDynamicPages-CSRF token.'));
    return false;
  }
  return true;
}

function isBaaVerifyBackendPath(pathname) {
  const prefix = `${BACKEND_PREFIX}/templates/`;
  if (!String(pathname || '').startsWith(prefix)) return false;
  const suffix = String(pathname || '').slice(prefix.length);
  const parts = suffix.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  return parts.length === 2 && parts[1] === 'baa-verify';
}

function backendAuthFromRequest(req, requestUrl) {
  const cookieToken = getCookieValue(req.headers.cookie, 'CMDBuild-Authorization');
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  const headerToken = String(req.headers['cmdbuild-authorization'] || '').trim();
  if (headerToken && isBaaVerifyBackendPath(requestUrl.pathname)) {
    return { token: headerToken, source: 'cmdbuild-authorization-header' };
  }
  return { token: '', source: '' };
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
    language: data.language || data.lang || data.locale || data.userLanguage || data.preferredLanguage || '',
    locale: data.locale || data.language || data.lang || '',
    role: data.role || '',
    tenant: data.tenant || data.currentTenant || data.activeTenant || '',
    availableTenants: Array.isArray(data.availableTenants) ? data.availableTenants : [],
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

function sanitizeLookupType(item) {
  if (!item) return null;
  return {
    id: item._id,
    name: item.name || item.code || item.Code || '',
    description: item._description_translation || item.description || item.Description || '',
    parent: item.parent || item.Parent || null,
    active: item.active === undefined ? null : Boolean(item.active)
  };
}

async function mapLimit(items, concurrency, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

async function buildModelCatalog(authToken, requestUrl) {
  const maxClasses = getPositiveInt(requestUrl.searchParams, 'maxClasses', 200, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const maxDomains = getPositiveInt(requestUrl.searchParams, 'maxDomains', 200, ABSOLUTE_EXECUTION_LIMITS.maxDomains);
  const maxLookups = getPositiveInt(requestUrl.searchParams, 'maxLookups', 200, 1000);
  const includeAttributes = getBoolean(requestUrl.searchParams, 'includeAttributes', true);
  const session = await getSessionData(authToken);
  const classesResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes?limit=${maxClasses}&detailed=true`, authToken);
  const rawClasses = Array.isArray(classesResponse.json && classesResponse.json.data) ? classesResponse.json.data : [];
  const classes = rawClasses
    .map(sanitizeClass)
    .filter(Boolean)
    .filter((item) => item.active !== false && (!item.permissions || item.permissions._can_read !== false));
  const attributeErrors = [];
  let attributeCount = 0;

  if (classesResponse.ok && includeAttributes) {
    await mapLimit(classes, 5, async (item) => {
      const attrs = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(item.name)}/attributes`, authToken);
      if (!attrs.ok) {
        item.attributes = [];
        attributeErrors.push({
          className: item.name,
          cmdbuildStatus: attrs.statusCode
        });
        return item;
      }
      item.attributes = Array.isArray(attrs.json && attrs.json.data)
        ? attrs.json.data.map(sanitizeAttribute).filter(Boolean).filter((attribute) => attribute.active !== false && (!attribute.permissions || attribute.permissions._can_read !== false))
        : [];
      attributeCount += item.attributes.length;
      return item;
    });
  } else {
    classes.forEach((item) => {
      item.attributes = [];
    });
  }

  const domainsResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/domains?limit=${maxDomains}&detailed=true`, authToken);
  const domains = Array.isArray(domainsResponse.json && domainsResponse.json.data)
    ? domainsResponse.json.data.map(sanitizeDomain).filter(Boolean).filter((item) => item.active !== false)
    : [];

  const lookupTypesResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/lookup_types?limit=${maxLookups}`, authToken);
  let lookupTypes = Array.isArray(lookupTypesResponse.json && lookupTypesResponse.json.data)
    ? lookupTypesResponse.json.data.map(sanitizeLookupType).filter(Boolean)
    : [];
  const lookupTypeNames = uniqueStrings(classes.flatMap((item) =>
    (item.attributes || []).map((attribute) => attribute.lookupType).filter(Boolean)
  ));
  if (!lookupTypes.length) {
    lookupTypes = lookupTypeNames.map((name) => ({
      id: null,
      name,
      description: '',
      parent: null,
      active: null
    }));
  }

  return {
    success: classesResponse.ok,
    statusCode: classesResponse.ok ? 200 : 502,
    cmdbuildStatus: {
      session: session.response.statusCode,
      classes: classesResponse.statusCode,
      domains: domainsResponse.statusCode,
      lookupTypes: lookupTypesResponse.statusCode
    },
    catalog: {
      generatedAt: new Date().toISOString(),
      session: sanitizeSession(session.data),
      limits: {
        maxClasses,
        maxDomains,
        maxLookups,
        includeAttributes
      },
      counts: {
        classes: classes.length,
        attributes: attributeCount,
        domains: domains.length,
        lookupTypes: lookupTypes.length
      },
      classes,
      domains,
      lookupTypes,
      warnings: {
        domainsUnavailable: !domainsResponse.ok,
        lookupTypesUnavailable: !lookupTypesResponse.ok,
        attributeErrors
      }
    }
  };
}

async function buildPermissionScopeProbe(authToken, requestUrl) {
  const maxClasses = getPositiveInt(requestUrl.searchParams, 'maxClasses', 200, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const maxDomains = getPositiveInt(requestUrl.searchParams, 'maxDomains', 200, ABSOLUTE_EXECUTION_LIMITS.maxDomains);
  const maxAttributeClasses = getPositiveInt(requestUrl.searchParams, 'maxAttributeClasses', 50, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const includeAttributes = getBoolean(requestUrl.searchParams, 'includeAttributes', true);
  const session = await getSessionData(authToken);
  const sessionData = sanitizeSession(session.data);
  const currentRoleName = session.data && session.data.role ? session.data.role : '';

  const roles = await cmdbuildRequest('/cmdbuild/services/rest/v3/roles?limit=100', authToken);
  const currentRole = currentRoleName
    ? await cmdbuildRequest(`/cmdbuild/services/rest/v3/roles/${encodeURIComponent(currentRoleName)}`, authToken)
    : { ok: false, statusCode: 0, json: null };
  const users = await cmdbuildRequest('/cmdbuild/services/rest/v3/users?limit=1', authToken);
  const groups = await cmdbuildRequest('/cmdbuild/services/rest/v3/groups?limit=1', authToken);
  const classesResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes?limit=${maxClasses}&detailed=true`, authToken);
  const rawClasses = Array.isArray(classesResponse.json && classesResponse.json.data) ? classesResponse.json.data : [];
  const classes = rawClasses.map(sanitizeClass).filter(Boolean).filter((item) => item.active !== false);
  const readableClasses = classes.filter((item) => !item.permissions || item.permissions._can_read !== false);
  const attributeErrors = [];

  if (classesResponse.ok && includeAttributes) {
    await mapLimit(readableClasses.slice(0, maxAttributeClasses), 5, async (item) => {
      const attrs = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(item.name)}/attributes`, authToken);
      if (!attrs.ok) {
        item.attributes = [];
        attributeErrors.push({
          className: item.name,
          cmdbuildStatus: attrs.statusCode
        });
        return;
      }
      item.attributes = Array.isArray(attrs.json && attrs.json.data)
        ? attrs.json.data.map(sanitizeAttribute).filter(Boolean).filter((attribute) => attribute.active !== false)
        : [];
    });
  }

  const domainsResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/domains?limit=${maxDomains}&detailed=true`, authToken);
  const domains = Array.isArray(domainsResponse.json && domainsResponse.json.data)
    ? domainsResponse.json.data.map(sanitizeDomain).filter(Boolean).filter((item) => item.active !== false)
    : [];

  const visibleModelSignature = {
    session: runtimeUserCacheScope(session.data),
    classes: readableClasses.map((item) => ({
      name: item.name,
      parent: item.parent,
      permissions: item.permissions,
      attributes: (item.attributes || []).map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
        targetClass: attribute.targetClass,
        targetType: attribute.targetType,
        lookupType: attribute.lookupType,
        permissions: attribute.permissions
      }))
    })),
    domains: domains.map((item) => ({
      name: item.name,
      source: item.source,
      sources: item.sources,
      destination: item.destination,
      destinations: item.destinations,
      cardinality: item.cardinality,
      permissions: item.permissions
    }))
  };

  return {
    success: session.response.ok,
    cmdbuildStatus: {
      session: session.response.statusCode,
      roles: roles.statusCode,
      currentRole: currentRole.statusCode,
      users: users.statusCode,
      groups: groups.statusCode,
      classes: classesResponse.statusCode,
      domains: domainsResponse.statusCode
    },
    generatedAt: new Date().toISOString(),
    session: sessionData,
    permissionScope: {
      scopeHashLevel: 'visible-model-plus-user-role',
      visibleModelHash: hashJson(visibleModelSignature),
      userScopeHash: hashJson(runtimeUserCacheScope(session.data)),
      recommendedResultCacheScope: 'per-user',
      safeForSharedResultCache: false,
      reason: 'The probe can inspect visible model metadata, but it does not prove identical row-level visibility between different users.'
    },
    capabilities: {
      roleCatalogAvailable: roles.ok,
      currentRoleDetailsAvailable: currentRole.ok,
      usersEndpointAvailable: users.ok,
      groupsEndpointAvailable: groups.ok,
      classesCatalogAvailable: classesResponse.ok,
      domainsCatalogAvailable: domainsResponse.ok,
      attributePermissionsSampled: classesResponse.ok && includeAttributes
    },
    counts: {
      classes: classes.length,
      readableClasses: readableClasses.length,
      classesWithAttributesSampled: readableClasses.filter((item) => Array.isArray(item.attributes)).length,
      attributesSampled: readableClasses.reduce((count, item) => count + (Array.isArray(item.attributes) ? item.attributes.length : 0), 0),
      domains: domains.length
    },
    limits: {
      maxClasses,
      maxDomains,
      maxAttributeClasses,
      includeAttributes
    },
    currentRole: currentRole.ok ? sanitizeRole(currentRole.json && currentRole.json.data) : null,
    roles: roles.ok && Array.isArray(roles.json && roles.json.data)
      ? roles.json.data.map(sanitizeRole).filter(Boolean)
      : [],
    readableClasses,
    domains,
    warnings: {
      attributeErrors,
      sharedCacheDisabled: true,
      rowLevelPermissionsNotProven: true
    }
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
  const body = JSON.stringify({
    success: false,
    message: `Method ${req.method} is not allowed for this route.`
  }, null, 2);
  res.writeHead(405, securityHeaders({
    allow: allowed.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  }));
  res.end(body);
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

async function cmdbuildRequest(path, authToken, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const retryable = cmdbuildRequestCanRetry(method, options.retry);
  const maxAttempts = retryable ? CMDBUILD_RETRY_MAX_ATTEMPTS : 1;
  const target = new URL(path, CMDBUILD_ORIGIN);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await cmdbuildRequestOnce(path, authToken, {
        ...options,
        method
      });
      if (attempt < maxAttempts && shouldRetryCmdbuildResult(result)) {
        const retryDelayMs = cmdbuildRetryDelayMs(attempt);
        incMetric('cmdp_cmdbuild_rest_retries_total', {
          method,
          reason: statusClass(result.statusCode)
        });
        logWarn('cmdbuild.request_retry', {
          requestId: options.requestId || currentRequestId(),
          method,
          path: sanitizeRequestPath(target),
          statusCode: result.statusCode,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: retryDelayMs
        });
        await delay(retryDelayMs);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && retryable) {
        const retryDelayMs = cmdbuildRetryDelayMs(attempt);
        incMetric('cmdp_cmdbuild_rest_retries_total', {
          method,
          reason: 'network'
        });
        logWarn('cmdbuild.request_retry', {
          requestId: options.requestId || currentRequestId(),
          method,
          path: sanitizeRequestPath(target),
          error: error && error.message ? error.message : String(error),
          attempt,
          nextAttempt: attempt + 1,
          delayMs: retryDelayMs
        });
        await delay(retryDelayMs);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('CMDBuild request failed.');
}

function cmdbuildRequestOnce(path, authToken, options = {}) {
  const target = new URL(path, CMDBUILD_ORIGIN);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported CMDBuild protocol: ${target.protocol}`));
  }
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const startedAt = Date.now();
  const headers = {
    accept: 'application/json',
    'CMDBuild-Authorization': authToken,
    ...(options.headers || {})
  };
  const requestId = options.requestId || headers['x-request-id'] || headers['X-Request-ID'] || currentRequestId();
  if (requestId) {
    headers['x-request-id'] = truncateText(requestId, 120);
  }
  if (body !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const transport = httpTransportForTarget(target);
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: options.method || 'GET',
      path: `${target.pathname}${target.search}`,
      headers,
      agent: cmdbuildAgentForTarget(target)
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
        const result = {
          statusCode: res.statusCode || 0,
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          json,
          text
        };
        incMetric('cmdp_cmdbuild_rest_requests_total', {
          method: options.method || 'GET',
          status: statusClass(result.statusCode)
        });
        if (!result.ok) {
          incMetric('cmdp_cmdbuild_rest_errors_total', {
            method: options.method || 'GET',
            status: statusClass(result.statusCode)
          });
        }
        if (!result.ok && result.statusCode >= 500) {
          logWarn('cmdbuild.request_failed', {
            requestId,
            method: options.method || 'GET',
            path: sanitizeRequestPath(target),
            statusCode: result.statusCode,
            durationMs: Date.now() - startedAt
          });
        }
        resolve(result);
      });
    });
    req.on('error', (error) => {
      incMetric('cmdp_cmdbuild_rest_errors_total', {
        method: options.method || 'GET',
        status: 'network'
      });
      logError('cmdbuild.request_error', {
        requestId,
        method: options.method || 'GET',
        path: sanitizeRequestPath(target),
        durationMs: Date.now() - startedAt,
        error: error && error.message ? error.message : String(error)
      });
      reject(error);
    });
    req.setTimeout(CMDBUILD_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`CMDBuild request timed out after ${CMDBUILD_REQUEST_TIMEOUT_MS}ms.`));
    });
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function schemaParentFromInput(input, fallback = 'Class') {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return source.parent || source.rootParent || source.superclass || source.superClass || fallback || 'Class';
}

function sanitizeExistingClassForSchema(classResponse) {
  const data = classResponse && classResponse.json && classResponse.json.data ? classResponse.json.data : null;
  if (!data) return null;
  return {
    name: data.name || '',
    description: data._description_translation || data.description || '',
    parent: data.parent || null,
    prototype: data.prototype === undefined ? null : Boolean(data.prototype),
    type: data.type || null,
    active: data.active === undefined ? null : Boolean(data.active)
  };
}

function sanitizeExistingAttributeForSchema(attributeResponse) {
  const data = attributeResponse && attributeResponse.json && attributeResponse.json.data ? attributeResponse.json.data : null;
  if (!data) return null;
  return {
    name: data.name || '',
    description: data._description_translation || data.description || '',
    type: data.type || null,
    active: data.active === undefined ? null : Boolean(data.active),
    inherited: data.inherited === undefined ? null : Boolean(data.inherited),
    mandatory: data.mandatory === undefined ? null : Boolean(data.mandatory)
  };
}

function addSchemaConflict(conflicts, item) {
  conflicts.push({
    severity: 'error',
    destructiveUpdateRequired: true,
    ...item
  });
}

function compareClassDefinition(classDefinition, classResponse, conflicts) {
  const existing = sanitizeExistingClassForSchema(classResponse);
  if (!existing) return existing;
  if (existing.parent && existing.parent !== classDefinition.parent) {
    addSchemaConflict(conflicts, {
      type: 'class',
      name: classDefinition.name,
      field: 'parent',
      expected: classDefinition.parent,
      actual: existing.parent,
      reason: 'existing_class_parent_mismatch'
    });
  }
  if (existing.prototype !== null && existing.prototype !== Boolean(classDefinition.prototype)) {
    addSchemaConflict(conflicts, {
      type: 'class',
      name: classDefinition.name,
      field: 'prototype',
      expected: Boolean(classDefinition.prototype),
      actual: existing.prototype,
      reason: 'existing_class_prototype_mismatch'
    });
  }
  return existing;
}

function compareAttributeDefinition(classDefinition, attribute, attrResponse, conflicts) {
  const existing = sanitizeExistingAttributeForSchema(attrResponse);
  if (!existing) return existing;
  if (existing.type && existing.type !== attribute.type) {
    addSchemaConflict(conflicts, {
      type: 'attribute',
      className: classDefinition.name,
      name: attribute.name,
      field: 'type',
      expected: attribute.type,
      actual: existing.type,
      reason: 'existing_attribute_type_mismatch'
    });
  }
  return existing;
}

function technicalSchemaPlanSummary(schema, actions, conflicts) {
  const creates = actions.filter((item) => item.action === 'create' || item.action === 'created').length;
  const failures = actions.filter((item) => String(item.action || '').endsWith('_failed')).length;
  return {
    classCount: schema.classes.length,
    attributeCount: schema.classes.reduce((count, item) => count + (Array.isArray(item.attributes) ? item.attributes.length : 0), 0),
    plannedCreates: creates,
    conflicts: conflicts.length,
    failures,
    destructiveUpdates: conflicts.filter((item) => item.destructiveUpdateRequired).length
  };
}

async function listTechnicalSchemaParents(authToken, requestUrl) {
  const maxClasses = getPositiveInt(requestUrl.searchParams, 'limit', 200, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const classesResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes?limit=${maxClasses}&detailed=true`, authToken);
  const data = Array.isArray(classesResponse.json && classesResponse.json.data)
    ? classesResponse.json.data.map(sanitizeClass).filter(Boolean).filter((item) => item.active !== false)
    : [];
  const parents = [{ name: 'Class', description: 'CMDBuild root class', parent: null, prototype: true }]
    .concat(data)
    .filter((item, index, arr) => item.name && arr.findIndex((candidate) => candidate.name === item.name) === index)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return {
    success: classesResponse.ok,
    cmdbuildStatus: classesResponse.statusCode,
    parents
  };
}

async function checkOrCreateTechnicalSchema(authToken, root, createMissing, options = {}) {
  if (createMissing) {
    const preview = await checkOrCreateTechnicalSchema(authToken, root, false, options);
    if ((preview.conflicts && preview.conflicts.length) || (preview.inaccessible && preview.inaccessible.length) || (preview.errors && preview.errors.length)) {
      return {
        ...preview,
        createMissing: true,
        mode: 'bootstrap',
        ready: false,
        destructiveUpdatesAllowed: false
      };
    }
  }
  const schema = buildTechnicalSchema(root, {
    parent: schemaParentFromInput(options),
    description: options.description || options.rootDescription || ''
  });
  const actions = [];
  const missing = [];
  const inaccessible = [];
  const errors = [];
  const conflicts = [];
  const classes = [];

  const addSchemaProblem = (target, item) => {
    if (item.cmdbuildStatus === 401 || item.cmdbuildStatus === 403) {
      inaccessible.push({
        ...item,
        reason: 'access_denied'
      });
      return;
    }
    if (item.cmdbuildStatus === 404) {
      missing.push(item);
      return;
    }
    target.push(item);
  };

  for (const classDefinition of schema.classes) {
    const classPath = `/cmdbuild/services/rest/v3/classes/${encodeURIComponent(classDefinition.name)}`;
    let classResponse = await cmdbuildRequest(classPath, authToken);
    let classExists = classResponse.ok;
    let classCreated = false;
    let existingClass = classExists ? compareClassDefinition(classDefinition, classResponse, conflicts) : null;

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
      existingClass = classExists ? sanitizeExistingClassForSchema(createResponse) : null;
    } else if (!classExists && !createMissing && classResponse.statusCode === 404) {
      actions.push({
        type: 'class',
        name: classDefinition.name,
        action: 'create',
        parent: classDefinition.parent
      });
    }

    if (!classExists) {
      addSchemaProblem(errors, {
        type: 'class',
        name: classDefinition.name,
        cmdbuildStatus: classResponse.statusCode
      });
    }

    const classStatus = {
      role: classDefinition.role,
      name: classDefinition.name,
      description: classDefinition.description,
      parent: classDefinition.parent,
      prototype: Boolean(classDefinition.prototype),
      exists: classExists,
      created: classCreated,
      cmdbuildStatus: classResponse.statusCode,
      existing: existingClass,
      attributes: []
    };

    if (classExists) {
      let index = 10;
      for (const attribute of classDefinition.attributes) {
        const attrPath = `/cmdbuild/services/rest/v3/classes/${encodeURIComponent(classDefinition.name)}/attributes/${encodeURIComponent(attribute.name)}`;
        let attrResponse = await cmdbuildRequest(attrPath, authToken);
        let attrExists = attrResponse.ok;
        let attrCreated = false;
        let existingAttribute = attrExists ? compareAttributeDefinition(classDefinition, attribute, attrResponse, conflicts) : null;

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
          existingAttribute = attrExists ? sanitizeExistingAttributeForSchema(createAttrResponse) : null;
        } else if (!attrExists && !createMissing && attrResponse.statusCode === 404) {
          actions.push({
            type: 'attribute',
            className: classDefinition.name,
            name: attribute.name,
            action: 'create'
          });
        }

        if (!attrExists) {
          addSchemaProblem(errors, {
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
          cmdbuildStatus: attrResponse.statusCode,
          existing: existingAttribute
        });
        index += 10;
      }
    }

    classes.push(classStatus);
  }

  return {
    root: schema.root,
    rootParent: schema.rootParent,
    rootDescription: schema.rootDescription,
    prefix: schema.prefix,
    classNames: schema.classNames,
    ready: missing.length === 0 && inaccessible.length === 0 && errors.length === 0 && conflicts.length === 0,
    status: missing.length === 0 && inaccessible.length === 0 && errors.length === 0 && conflicts.length === 0
      ? 'ready'
      : inaccessible.length > 0
        ? 'inaccessible'
        : missing.length > 0
          ? 'missing'
          : conflicts.length > 0
            ? 'conflict'
            : 'error',
    createMissing,
    mode: createMissing ? 'bootstrap' : 'preview',
    destructiveUpdatesAllowed: false,
    missing,
    inaccessible,
    errors,
    conflicts,
    actions,
    summary: technicalSchemaPlanSummary(schema, actions, conflicts),
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

function normalizeTemplateSpecForStorage(spec, code = '') {
  const parsed = safeJsonValue(spec, spec);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return spec;

  let next = cloneJsonValueServer(parsed, parsed);
  const templateCode = String(code || '').trim();
  if (templateCode === DEFAULT_CMDB_BUILD_VIEW_CODE && isCmdbBuildViewSpec(next)) return next;

  if (next.kind === CMDB_BUILD_VIEW_KIND && next.endpoint && next.endpoint.kind === 'baaVerification') {
    delete next.kind;
    delete next.cmdbBuildView;
  }
  delete next.protected;
  if (next.system && typeof next.system === 'object' && !Array.isArray(next.system)) {
    const system = { ...next.system };
    delete system.protected;
    if (Object.keys(system).length) next.system = system;
    else delete next.system;
  }
  next = ensureBaaPlanObjectSourceSteps(next);
  return next;
}

function sanitizeTemplateCard(card) {
  if (!card) return null;
  const spec = safeJsonValue(card.SpecJson, null);
  const code = card.Code || '';
  return {
    id: card._id,
    code,
    description: card.Description || '',
    active: card.Active === undefined ? null : Boolean(card.Active),
    spec,
    specHash: hashJson(spec || {}),
    paramsSchema: safeJsonValue(card.ParamsSchemaJson, null),
    resultSchema: safeJsonValue(card.ResultSchemaJson, null),
    owner: card.Owner || '',
    updatedAt: card.UpdatedAt || null,
    protected: templateIsProtected({ code, spec })
  };
}

function expectedSpecHashFromBody(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return String(source.expectedSpecHash || source.ExpectedSpecHash || '').trim();
}

function templateIsProtected(template) {
  const code = template && (template.code || template.Code) || '';
  return code === DEFAULT_CMDB_BUILD_VIEW_CODE;
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
  const normalizedSpec = normalizeTemplateSpecForStorage(spec, code);

  return {
    Code: code,
    Description: body.description || body.Description || code,
    Active: body.active === undefined ? body.Active !== false : Boolean(body.active),
    SpecJson: cmdbuildJsonAttribute(normalizedSpec),
    ParamsSchemaJson: cmdbuildJsonAttribute(body.paramsSchema !== undefined ? body.paramsSchema : body.ParamsSchemaJson),
    ResultSchemaJson: cmdbuildJsonAttribute(body.resultSchema !== undefined ? body.resultSchema : body.ResultSchemaJson),
    Owner: body.owner || body.Owner || username || '',
    UpdatedAt: new Date().toISOString()
  };
}

function normalizeDraftTemplateBody(body) {
  const container = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const source = container.template && typeof container.template === 'object' && !Array.isArray(container.template)
    ? container.template
    : container;
  const code = validateCmdbuildIdentifier(source.code || source.Code || 'DraftTemplate', 'template code');
  const rawSpec = source.spec !== undefined
    ? source.spec
    : source.SpecJson !== undefined
      ? source.SpecJson
      : container.spec !== undefined
        ? container.spec
        : container.SpecJson;
  const spec = safeJsonValue(rawSpec, null);

  return {
    code,
    description: source.description || source.Description || code,
    active: source.active === undefined ? source.Active !== false : Boolean(source.active),
    spec,
    params: container.params && typeof container.params === 'object' && !Array.isArray(container.params) ? container.params : {}
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
    runtimeCache: {
      refreshCooldownSec: Math.ceil(RUNTIME_REFRESH_COOLDOWN_MS / 1000)
    },
    baaTechnical: {
      superclassPath: 'BAA technical superclass',
      conversionContractClass: 'BAAConversionContract',
      conversionContractVersionClass: 'BAAConversionContractVersion',
      verificationInputContractClass: 'BAAVerificationInputContract',
      verificationOutputContractClass: 'BAAVerificationOutputContract',
      verificationEndpointClass: 'BAAVerificationEndpoint'
    },
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

function resultPresentationFromSpec(spec) {
  const result = spec && spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
  return result.presentation && typeof result.presentation === 'object' && !Array.isArray(result.presentation)
    ? result.presentation
    : {};
}

function emptyResultTextFromSpec(spec) {
  const result = spec && spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
  const presentation = resultPresentationFromSpec(spec);
  return result.emptyText || presentation.emptyText || DEFAULT_EMPTY_RESULT_TEXT;
}

function permissionDeniedTextFromSpec(spec) {
  const result = spec && spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
  const presentation = resultPresentationFromSpec(spec);
  return result.permissionDeniedText || presentation.permissionDeniedText || DEFAULT_PERMISSION_DENIED_TEXT;
}

function errorLooksPermissionDenied(error) {
  const status = error && (error.cmdbuildStatus || error.statusCode);
  if (isPermissionDeniedStatus(status)) return true;
  const message = error && error.message ? String(error.message) : String(error || '');
  return /\bstatus\s+(401|403)\b/i.test(message) || /\b(401|403)\b/.test(message) && /CMDBuild|permission|access/i.test(message);
}

function templateExecutionErrorReason(error) {
  if (error && error.redisRequired) return 'redis_required';
  if (errorLooksPermissionDenied(error)) return 'permission_denied';
  const message = error && error.message ? String(error.message) : String(error || '');
  if (/limit|maximum|maxRows|maxRestCalls|maxClasses|maxDomains/i.test(message)) return 'execution_limit';
  return 'execution_error';
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

function normalizeRuntimeCacheConfig(runtimeConfig) {
  const defaults = defaultRuntimeConfig().runtimeCache;
  const source = runtimeConfig && runtimeConfig.runtimeCache
    ? runtimeConfig.runtimeCache
    : (runtimeConfig && runtimeConfig.refreshCooldownSec !== undefined ? runtimeConfig : {});
  return {
    refreshCooldownSec: toPositiveInt(source.refreshCooldownSec, defaults.refreshCooldownSec, 24 * 60 * 60)
  };
}

function normalizeTemplateCacheConfig(spec, runtimeCacheConfig) {
  const source = spec && spec.cache && typeof spec.cache === 'object' && !Array.isArray(spec.cache) ? spec.cache : {};
  let scopeMode = String(source.scopeMode || source.mode || '').trim();
  if (!scopeMode) scopeMode = source.enabled === false ? 'disabled' : 'permissionOnly';
  if (!['permissionOnly', 'visibilityHash', 'privateUser', 'disabled'].includes(scopeMode)) scopeMode = 'permissionOnly';
  const enabled = source.enabled !== false && scopeMode !== 'disabled';
  const shareMode = scopeMode === 'privateUser'
    ? 'user'
    : String(source.shareMode || 'endpoint').trim() === 'user'
      ? 'user'
      : 'endpoint';
  return {
    enabled,
    scopeMode: enabled ? scopeMode : 'disabled',
    probeMode: 'usedFieldsOnly',
    shareMode,
    ttlSeconds: toPositiveInt(source.ttlSeconds, DEFAULT_TEMPLATE_CACHE_TTL_SEC, 24 * 60 * 60),
    allowManualRefresh: source.allowManualRefresh !== false
  };
}

function mergeRuntimeConfigDefaults(runtimeConfig) {
  const defaults = defaultRuntimeConfig();
  const source = runtimeConfig && typeof runtimeConfig === 'object' && !Array.isArray(runtimeConfig) ? runtimeConfig : {};
  return Object.assign({}, defaults, source, {
    runtimeCache: Object.assign({}, defaults.runtimeCache, source.runtimeCache || {}),
    baaTechnical: Object.assign({}, defaults.baaTechnical, source.baaTechnical || {}),
    executionLimits: Object.assign({}, defaults.executionLimits, source.executionLimits || {})
  });
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
    runtimeConfig: mergeRuntimeConfigDefaults(safeJsonValue(card.RuntimeConfigJson, defaultRuntimeConfig())),
    exists: true
  };
}

function normalizeConfigPayload(body, root) {
  const runtimeConfig = body.runtimeConfig !== undefined ? body.runtimeConfig : body.RuntimeConfigJson;
  const normalizedRuntimeConfig = mergeRuntimeConfigDefaults(runtimeConfig === undefined ? defaultRuntimeConfig() : runtimeConfig);
  return {
    Code: root,
    Description: body.description || body.Description || `CMDB Dynamic Pages config for ${root}`,
    RootCode: root,
    Active: body.active === undefined ? body.Active !== false : Boolean(body.active),
    RuntimeConfigJson: cmdbuildJsonAttribute(normalizedRuntimeConfig)
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

function baaTechnicalConfig(runtimeConfig) {
  return mergeRuntimeConfigDefaults(runtimeConfig || defaultRuntimeConfig()).baaTechnical || defaultRuntimeConfig().baaTechnical;
}

function baaContractClassNameForType(runtimeConfig, type) {
  const cfg = baaTechnicalConfig(runtimeConfig);
  const kind = String(type || 'input').trim();
  if (kind === 'conversion') return cfg.conversionContractClass;
  if (kind === 'conversionVersion') return cfg.conversionContractVersionClass;
  if (kind === 'output') return cfg.verificationOutputContractClass;
  if (kind === 'endpoint') return cfg.verificationEndpointClass;
  return cfg.verificationInputContractClass;
}

function jsonFieldValue(card, names, fallback = null) {
  for (const name of names) {
    if (card && card[name] !== undefined && card[name] !== null && card[name] !== '') {
      return safeJsonValue(card[name], fallback);
    }
  }
  return fallback;
}

function baaFieldListFromObject(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeBaaContractFieldServer(item)).filter((item) => item.name);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, definition]) => normalizeBaaContractFieldServer({
      ...(definition && typeof definition === 'object' && !Array.isArray(definition) ? definition : { type: definition }),
      name
    })).filter((item) => item.name);
  }
  return [];
}

function normalizeBaaVariableSources(value) {
  return Array.isArray(value) ? value.map((item) => {
    const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    return {
      name: String(source.name || '').trim(),
      sourceKind: String(source.sourceKind || '').trim(),
      sourceExpression: String(source.sourceExpression || '').trim(),
      valuePresent: Boolean(source.valuePresent)
    };
  }).filter((item) => item.name) : [];
}

function baaContractObjectsFromRaw(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawObjects = Array.isArray(source.objects)
    ? source.objects
    : (Array.isArray(source.candidates) ? source.candidates : (Array.isArray(source.classes) ? source.classes : []));
  return rawObjects.map((object, index) => {
    const item = object && typeof object === 'object' && !Array.isArray(object) ? object : {};
    const className = String(item.className || item.class || item.name || '').trim();
    return {
      alias: String(item.alias || item.as || className || `candidate${index + 1}`).trim(),
      className,
      description: String(item.description || '').trim(),
      payload: baaFieldListFromObject(item.payload || item.fields || item.attributes || [])
    };
  }).filter((object) => object.alias || object.className || object.payload.length);
}

function baaContractFromCard(card) {
  const raw = jsonFieldValue(card, ['SchemaJson', 'ContractJson', 'SpecJson', 'InputContractJson', 'OutputContractJson', 'DefinitionJson', 'PayloadJson'], {}) || {};
  const variables = baaFieldListFromObject(raw.contractParams || raw.variables || raw.params || raw.endpointParams || []);
  const requestVariables = baaFieldListFromObject(raw.requestVariables || raw.verificationRequestVariables || []);
  const objects = baaContractObjectsFromRaw(raw);
  return {
    code: String(raw.code || card.Code || card.BAAContractVersionCode || '').trim(),
    version: String(raw.version || card.ContractVersion || card.Version || card.MajorVersion || '').trim(),
    description: String(raw.description || card.Description || '').trim(),
    variables,
    contractParams: variables,
    requestVariables,
    objects
  };
}

function sanitizeBaaContractCard(card, className) {
  const contract = baaContractFromCard(card || {});
  return {
    id: card && card._id,
    code: contract.code || String(card && card.Code || '').trim(),
    description: contract.description || String(card && card.Description || '').trim(),
    version: contract.version,
    className,
    contract,
    resultInterpretation: jsonFieldValue(card, ['ResultInterpretationJson'], null)
  };
}

async function listBaaContractCards(authToken, root, type) {
  const runtimeConfig = await getRuntimeConfig(authToken, root);
  const cfg = baaTechnicalConfig(runtimeConfig);
  const className = validateCmdbuildIdentifier(baaContractClassNameForType(runtimeConfig, type), 'BAA contract class');
  const cards = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/cards?limit=1000`, authToken);
  const data = Array.isArray(cards.json && cards.json.data) ? cards.json.data : [];
  return {
    type: String(type || 'input'),
    className,
    superclassPath: cfg.superclassPath || '',
    data: data.map((card) => sanitizeBaaContractCard(card, className))
  };
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

function runtimeUserCacheScope(sessionData) {
  const session = sanitizeSession(sessionData) || {};
  return {
    scope: 'per-user',
    userId: session.userId || null,
    username: session.username || '',
    role: session.role || '',
    tenant: session.tenant || '',
    availableTenants: session.availableTenants || [],
    sessionType: session.sessionType || '',
    availableRoles: session.availableRoles || []
  };
}

const CARD_BUILTIN_FIELDS = new Set(['Class', '_id', 'Id', 'Code', 'Description']);

function directCardFieldFromPath(path) {
  const text = String(path || '').trim();
  if (!text || text.startsWith('{')) return '';
  const dotIndex = text.indexOf('.');
  const field = dotIndex === -1 ? text : text.slice(0, dotIndex);
  if (!field || field.includes('}') || field.includes('/')) return '';
  return field;
}

function addUniqueDependencyField(target, field) {
  const text = String(field || '').trim();
  if (!text || target.includes(text)) return;
  target.push(text);
}

function addColumnDependency(target, column) {
  const text = String(column || '').trim();
  if (!text) return;
  addUniqueDependencyField(target, text);
}

function addFilterDependencyFields(target, filters) {
  for (const filter of Array.isArray(filters) ? filters : []) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) continue;
    addColumnDependency(target, filter.path || filter.attribute || filter.column || filter.field);
  }
}

function addPathColumnDependencies(target, columns) {
  for (const column of normalizePathColumnSpecs(columns)) {
    addColumnDependency(target, column.path);
  }
}

function normalizeResultTableSettings(spec) {
  const result = spec && spec.result && typeof spec.result === 'object' && !Array.isArray(spec.result) ? spec.result : {};
  const presentation = result.presentation && typeof result.presentation === 'object' && !Array.isArray(result.presentation)
    ? result.presentation
    : {};
  const tableSettings = new Map();
  for (const table of Array.isArray(presentation.tables) ? presentation.tables : []) {
    if (!table || typeof table !== 'object' || Array.isArray(table) || !table.name) continue;
    tableSettings.set(String(table.name), table);
  }
  return tableSettings;
}

function buildAliasColumnDependencies(spec) {
  const aliases = new Map();
  const add = (alias, column) => {
    const name = String(alias || '').trim();
    if (!name) return;
    if (!aliases.has(name)) aliases.set(name, []);
    addColumnDependency(aliases.get(name), column);
  };
  const addMany = (alias, columns) => {
    for (const column of normalizeStringList(columns)) add(alias, column);
  };
  const steps = Array.isArray(spec && spec.steps) ? spec.steps : [];
  const tableSettings = normalizeResultTableSettings(spec);

  for (const table of Array.isArray(spec && spec.result && spec.result.tables) ? spec.result.tables : []) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    addMany(table.name, table.columns);
    const settings = tableSettings.get(String(table.name || '')) || {};
    add(table.name, settings.sortColumn);
    add(table.name, settings.groupBy);
    for (const group of Array.isArray(settings.rowGroups) ? settings.rowGroups : []) {
      add(table.name, group && (group.column || group.field || group.name));
    }
  }

  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
    if (step.type === 'selectCards') {
      addPathColumnDependencies(aliases.get(step.as) || aliases.set(step.as, []).get(step.as), step.columns || step.cardColumns || step.outputColumns);
      addFilterDependencyFields(aliases.get(step.as), step.filters || step.where);
      continue;
    }
    if (step.type === 'filterRows') {
      for (const filter of Array.isArray(step.filters || step.where) ? (step.filters || step.where) : []) {
        add(step.from, filter && (filter.column || filter.field || filter.path || filter.attribute));
      }
      continue;
    }
    if (step.type === 'matchRows') {
      for (const rule of Array.isArray(step.rules || step.where) ? (step.rules || step.where) : []) {
        const normalized = normalizeMatchRowsRule(rule);
        add(step.from, normalized.leftColumn);
        add(step.with, normalized.rightColumn);
      }
      continue;
    }
    if (step.type === 'joinRows' || step.type === 'intersectRows') {
      try {
        for (const pair of normalizeRowOperationKeys(step)) {
          add(step.from, pair.left);
          add(step.with, pair.right);
        }
      } catch {
        // Validation reports malformed keys; dependency collection stays best effort.
      }
      continue;
    }
    if (step.type === 'composeRows' || step.type === 'compose') {
      for (const column of normalizeComposeColumns(step)) {
        if (column.source === 'right') add(step.with, column.column);
        else add(step.from, column.column);
      }
      continue;
    }
    if (step.type === 'enrichRows') {
      add(step.from, step.classColumn || 'Class');
      add(step.from, step.idColumn || '_id');
      addPathColumnDependencies(aliases.get(step.from) || aliases.set(step.from, []).get(step.from), step.columns || step.fields);
      continue;
    }
    if (step.type === 'expandRelations') {
      add(step.from, step.sourceClassColumn || step.classColumn || 'Class');
      add(step.from, step.sourceIdColumn || step.idColumn || '_id');
      continue;
    }
    if (step.type === 'traverseDomains' || step.type === 'compareClassAttributes') {
      add(step.from, step.classColumn || 'Class');
    }
  }
  return aliases;
}

function selectionDependencyFieldsForStep(step, aliasDependencies) {
  const fields = [];
  ['Class', '_id', 'Code', 'Description'].forEach((field) => addUniqueDependencyField(fields, field));
  addFilterDependencyFields(fields, step.filters || step.where);
  addPathColumnDependencies(fields, step.columns || step.cardColumns || step.outputColumns);
  for (const column of aliasDependencies.get(step.as) || []) addColumnDependency(fields, column);
  return fields;
}

function buildTemplateDependencyMap(spec) {
  const aliasDependencies = buildAliasColumnDependencies(spec || {});
  const selections = [];
  const classes = [];
  const steps = Array.isArray(spec && spec.steps) ? spec.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step) || step.type !== 'selectCards') continue;
    const fields = selectionDependencyFieldsForStep(step, aliasDependencies);
    const directFields = uniqueStrings(fields.map(directCardFieldFromPath).filter(Boolean));
    const className = step.className || '';
    if (className) addUniqueDependencyField(classes, className);
    selections.push({
      index,
      as: step.as || '',
      className,
      classNameParam: step.classNameParam || '',
      classColumn: step.classColumn || '',
      dynamicClass: Boolean(!step.className && (step.classNameParam || step.classColumn)),
      fields,
      directFields,
      filterFields: uniqueStrings((Array.isArray(step.filters || step.where) ? (step.filters || step.where) : [])
        .map((filter) => directCardFieldFromPath(filter && (filter.path || filter.attribute || filter.column || filter.field)))
        .filter(Boolean))
    });
  }
  return {
    version: 1,
    strategy: 'usedFieldsOnly',
    hash: '',
    classes: uniqueStrings(classes),
    selections,
    aliases: Object.fromEntries(Array.from(aliasDependencies.entries()).map(([alias, fields]) => [alias, uniqueStrings(fields)]))
  };
}

function dependencyMapWithHash(spec) {
  const map = buildTemplateDependencyMap(spec);
  const hash = hashJson(map);
  return Object.assign({}, map, { hash });
}

function runtimeCacheKeyParts(root, template, params, sessionData, executionOptions, runtimeCacheConfig, templateCacheConfig, dependencyMap, accessProbe, cacheContext = {}) {
  const userScope = runtimeUserCacheScope(sessionData);
  const specHash = hashJson(template.spec || {});
  const paramsHash = hashJson(params || {});
  const contextHash = cacheContext && Object.keys(cacheContext).length ? hashJson(cacheContext) : '';
  const limitsHash = hashJson({
    maxRows: executionOptions.maxRows,
    maxClasses: executionOptions.maxClasses,
    maxDomains: executionOptions.maxDomains,
    maxRestCalls: executionOptions.maxRestCalls,
    maxTraversalDepth: executionOptions.maxTraversalDepth
  });
  const userScopeHash = hashJson(userScope);
  const cacheScope = templateCacheConfig && templateCacheConfig.shareMode === 'endpoint' ? 'endpoint' : 'per-user';
  const cachePolicyHash = hashJson({ runtimeCacheConfig: runtimeCacheConfig || {}, templateCacheConfig: templateCacheConfig || {} });
  const keyPayload = {
    root,
    templateCode: template.code,
    active: template.active !== false,
    specHash,
    paramsHash,
    limitsHash,
    cachePolicyHash,
    cacheScope,
    scopeMode: templateCacheConfig && templateCacheConfig.scopeMode || 'privateUser',
    dependencyMapHash: dependencyMap && dependencyMap.hash || hashJson({}),
    visibilityHash: accessProbe && accessProbe.visibilityHash || '',
    contextHash
  };
  if (cacheScope !== 'endpoint') keyPayload.userScopeHash = userScopeHash;
  return {
    key: hashJson(keyPayload),
    keyPayload,
    keyShort: hashJson(keyPayload).slice(0, 16),
    specHash,
    paramsHash,
    limitsHash,
    contextHash,
    cachePolicyHash,
    cacheScope,
    scopeMode: keyPayload.scopeMode,
    dependencyMapHash: keyPayload.dependencyMapHash,
    visibilityHash: keyPayload.visibilityHash,
    userScope,
    userScopeHash
  };
}

function runtimeCacheMeta(entry, status, now = Date.now(), extra = {}) {
  const lastServedAt = entry.lastServedAt || entry.createdAt;
  const refreshCooldownMs = entry.refreshCooldownMs || RUNTIME_REFRESH_COOLDOWN_MS;
  const nextRefreshAtMs = lastServedAt + refreshCooldownMs;
  const cacheScope = entry.cacheScope || 'per-user';
  return {
    enabled: true,
    scope: cacheScope,
    scopeMode: entry.scopeMode || (cacheScope === 'endpoint' ? 'permissionOnly' : 'privateUser'),
    status,
    key: entry.keyShort,
    contentHash: entry.contentHash,
    generatedAt: new Date(entry.createdAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    ageSec: Math.max(0, Math.floor((now - entry.createdAt) / 1000)),
    ttlSec: Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)),
    refreshCooldownSec: Math.ceil(refreshCooldownMs / 1000),
    nextRefreshAllowedAt: new Date(nextRefreshAtMs).toISOString(),
    refreshAllowed: now >= nextRefreshAtMs,
    allowManualRefresh: entry.allowManualRefresh !== false,
    sharedAcrossUsers: cacheScope === 'endpoint',
    userScopeHash: entry.userScopeHash,
    dependencyMapHash: entry.dependencyMapHash || '',
    visibilityHash: entry.visibilityHash || '',
    accessProbe: entry.accessProbe || null,
    ...extra
  };
}

function runtimeAccessError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.cmdbuildStatus = statusCode;
  return error;
}

function attributeReadable(attribute) {
  if (!attribute) return false;
  if (attribute.active === false) return false;
  if (attribute._can_read === false) return false;
  if (attribute.permissions && attribute.permissions._can_read === false) return false;
  return true;
}

async function probeClassUsedFields(cmdbuildExecRequest, className, fields, limits, visibilityIds) {
  validateCmdbuildIdentifier(className, 'cache probe className');
  const attributesResponse = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/attributes`);
  if (!attributesResponse.ok) {
    return {
      ok: false,
      cmdbuildStatus: attributesResponse.statusCode,
      message: `CMDBuild attributes probe for ${className} failed with status ${attributesResponse.statusCode}.`
    };
  }

  const attributes = Array.isArray(attributesResponse.json && attributesResponse.json.data)
    ? attributesResponse.json.data
    : [];
  const byName = new Map(attributes.map((attribute) => [String(attribute.name || '').toLowerCase(), attribute]));
  for (const field of fields || []) {
    const direct = directCardFieldFromPath(field);
    if (!direct || CARD_BUILTIN_FIELDS.has(direct)) continue;
    const attribute = byName.get(direct.toLowerCase());
    if (!attributeReadable(attribute)) {
      return {
        ok: false,
        cmdbuildStatus: 403,
        message: `CMDBuild attribute is not readable for cache probe: ${className}.${direct}`
      };
    }
  }

  const probeLimit = Math.max(1, Math.min(limits.maxRows || 500, 1000));
  const cardsResponse = await requestCardsForSelection(cmdbuildExecRequest, className, probeLimit, ['_id'].concat(fields || []));
  if (!cardsResponse.ok) {
    return {
      ok: false,
      cmdbuildStatus: cardsResponse.statusCode,
      message: `CMDBuild cards probe for ${className} failed with status ${cardsResponse.statusCode}.`
    };
  }
  if (visibilityIds) {
    const rows = Array.isArray(cardsResponse.json && cardsResponse.json.data) ? cardsResponse.json.data : [];
    for (const row of rows) {
      const id = row && (row._id || row.Id || row.id);
      if (id !== undefined && id !== null && id !== '') visibilityIds.push(`${className}:${id}`);
    }
  }
  return { ok: true };
}

async function probeTemplateAccess(authToken, spec, params, executionOptions, dependencyMap, templateCacheConfig) {
  const config = templateCacheConfig || normalizeTemplateCacheConfig(spec, defaultRuntimeConfig());
  if (!config.enabled || config.scopeMode === 'privateUser' || config.scopeMode === 'disabled') {
    return {
      ok: true,
      mode: config.scopeMode,
      visibilityHash: '',
      checkedClasses: [],
      incomplete: false
    };
  }

  const limits = {
    maxClasses: Math.min(executionOptions.maxClasses || 100, executionOptions.maxClassesMax || ABSOLUTE_EXECUTION_LIMITS.maxClasses),
    maxClassesMax: Math.min(executionOptions.maxClassesMax || ABSOLUTE_EXECUTION_LIMITS.maxClasses, ABSOLUTE_EXECUTION_LIMITS.maxClasses),
    maxDomains: Math.min(executionOptions.maxDomains || 100, executionOptions.maxDomainsMax || ABSOLUTE_EXECUTION_LIMITS.maxDomains),
    maxRows: Math.min(executionOptions.maxRows || 500, executionOptions.maxRowsMax || ABSOLUTE_EXECUTION_LIMITS.maxRows),
    maxRestCalls: Math.min(executionOptions.maxRestCalls || 250, executionOptions.maxRestCallsMax || ABSOLUTE_EXECUTION_LIMITS.maxRestCalls),
    maxTraversalDepth: Math.min(executionOptions.maxTraversalDepth || ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth, executionOptions.maxTraversalDepthMax || ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth),
    traversalDepthDefault: Math.min(executionOptions.traversalDepthDefault || 1, executionOptions.maxTraversalDepthMax || ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth)
  };
  const effectiveParams = applyTemplateParamDefaults(spec, params);
  const cmdbuildExecRequest = createExecutionRequest(authToken, limits);
  if (isCmdbBuildViewSpec(spec)) {
    const viewConfig = normalizeCmdbBuildViewConfig(spec, effectiveParams);
    const probes = [
      '/cmdbuild/services/rest/v3/classes?limit=1&detailed=true'
    ];
    if (viewConfig.sections.includes('domains')) probes.push('/cmdbuild/services/rest/v3/domains?limit=1');
    if (viewConfig.sections.includes('lookups')) probes.push('/cmdbuild/services/rest/v3/lookup_types?limit=1');
    for (const probePath of probes) {
      const probe = await cmdbuildExecRequest(probePath);
      if (!probe.ok) {
        return {
          ok: false,
          mode: config.scopeMode,
          cmdbuildStatus: probe.statusCode || 403,
          message: `CMDBuild model view cache probe failed with status ${probe.statusCode || 0}.`,
          checkedClasses: viewConfig.rootClass ? [viewConfig.rootClass] : [],
          incomplete: true
        };
      }
    }
    return {
      ok: true,
      mode: config.scopeMode,
      visibilityHash: '',
      checkedClasses: viewConfig.rootClass ? [viewConfig.rootClass] : [],
      incomplete: false
    };
  }
  const classesCache = { loaded: false, classes: [], ok: false };
  const resolvedClassCache = new Map();
  const visibilityIds = config.scopeMode === 'visibilityHash' ? [] : null;
  const checkedClasses = [];
  let incomplete = false;
  const selections = dependencyMap && Array.isArray(dependencyMap.selections) ? dependencyMap.selections : [];

  if (!selections.length) {
    try {
      await executeTemplateSpec(authToken, spec, effectiveParams, {
        ...executionOptions,
        maxRows: 1,
        maxRestCalls: Math.min(executionOptions.maxRestCalls || 250, 50),
        dependencyMap
      });
    } catch (error) {
      if (errorLooksPermissionDenied(error)) {
        return {
          ok: false,
          mode: config.scopeMode,
          cmdbuildStatus: error.cmdbuildStatus || error.statusCode || 403,
          message: error && error.message ? error.message : 'CMDBuild cache permission probe failed.',
          checkedClasses,
          incomplete: true
        };
      }
      incomplete = true;
    }
  }

  for (const selection of selections) {
    const requested = selection.className || (selection.classNameParam ? effectiveParams[selection.classNameParam] : '');
    if (!requested) {
      incomplete = true;
      continue;
    }
    const classNames = await resolveExecutionClassNames(cmdbuildExecRequest, limits, requested, classesCache, resolvedClassCache);
    for (const className of classNames) {
      if (!className) continue;
      checkedClasses.push(className);
      const probe = await probeClassUsedFields(cmdbuildExecRequest, className, selection.directFields || selection.fields || [], limits, visibilityIds);
      if (!probe.ok) {
        return {
          ok: false,
          mode: config.scopeMode,
          cmdbuildStatus: probe.cmdbuildStatus || 403,
          message: probe.message || 'CMDBuild cache permission probe failed.',
          checkedClasses: uniqueStrings(checkedClasses),
          incomplete
        };
      }
    }
  }

  return {
    ok: true,
    mode: config.scopeMode,
    visibilityHash: visibilityIds ? hashJson(uniqueStrings(visibilityIds).sort()) : '',
    checkedClasses: uniqueStrings(checkedClasses),
    incomplete
  };
}

async function executeTemplateRunWithCache(authToken, root, template, params, sessionData, executionOptions, options = {}) {
  const now = Date.now();
  const runtimeCacheConfig = normalizeRuntimeCacheConfig(options.runtimeCacheConfig || defaultRuntimeConfig());
  const templateCacheConfig = normalizeTemplateCacheConfig(template.spec, runtimeCacheConfig);
  if (!templateCacheConfig.enabled || templateCacheConfig.scopeMode === 'disabled') {
    return {
      result: await executeTemplateSpec(authToken, template.spec, params, {
        ...executionOptions,
        baaRequest: options.baaRequest || null
      }),
      cache: {
        enabled: false,
        scope: 'disabled',
        scopeMode: 'disabled',
        status: 'disabled'
      }
    };
  }
  const dependencyMap = dependencyMapWithHash(template.spec);
  const accessProbe = await probeTemplateAccess(authToken, template.spec, params, executionOptions, dependencyMap, templateCacheConfig);
  if (!accessProbe.ok) {
    throw runtimeAccessError(accessProbe.message || 'CMDBuild cache permission probe failed.', accessProbe.cmdbuildStatus || 403);
  }
  const resultTtlMs = templateCacheConfig.ttlSeconds * 1000;
  const refreshCooldownMs = runtimeCacheConfig.refreshCooldownSec * 1000;
  const keyParts = runtimeCacheKeyParts(root, template, params, sessionData, executionOptions, runtimeCacheConfig, templateCacheConfig, dependencyMap, accessProbe, options.cacheContext || {});
  const refreshRequested = Boolean(options.refreshRequested);
  const forceRefreshRequested = Boolean(options.forceRefreshRequested);
  const cached = await cacheGetJson('runtime', keyParts.key, runtimeResultCache);
  let entry = cached.value;

  if (entry && refreshRequested && !forceRefreshRequested && templateCacheConfig.allowManualRefresh === false && entry.expiresAt > now) {
    entry.lastServedAt = now;
    const remainingTtlMs = Math.max(1, entry.expiresAt - now);
    await cacheSetJson('runtime', keyParts.key, entry, remainingTtlMs, runtimeResultCache);
    return {
      result: cloneJsonValueServer(entry.result, { tables: [] }),
      cache: runtimeCacheMeta(entry, 'hit', now, {
        backend: cached.backend,
        message: 'Manual refresh is disabled for this template cache.'
      })
    };
  }

  if (entry && refreshRequested && !forceRefreshRequested && now < (entry.lastServedAt || entry.createdAt) + refreshCooldownMs) {
    return {
      result: cloneJsonValueServer(entry.result, { tables: [] }),
      cache: runtimeCacheMeta(entry, 'refresh-wait', now, {
        backend: cached.backend,
        message: 'Refresh is not allowed yet for this user cache key.'
      })
    };
  }

  if (entry && !refreshRequested && entry.expiresAt > now) {
    entry.lastServedAt = now;
    const remainingTtlMs = Math.max(1, entry.expiresAt - now);
    await cacheSetJson('runtime', keyParts.key, entry, remainingTtlMs, runtimeResultCache);
    return {
      result: cloneJsonValueServer(entry.result, { tables: [] }),
      cache: runtimeCacheMeta(entry, 'hit', now, { backend: cached.backend })
    };
  }

  if (runtimeResultInFlight.has(keyParts.key)) {
    entry = await runtimeResultInFlight.get(keyParts.key);
    entry.lastServedAt = Date.now();
    return {
      result: cloneJsonValueServer(entry.result, { tables: [] }),
      cache: runtimeCacheMeta(entry, 'joined', Date.now(), { backend: entry.cacheBackend || 'memory' })
    };
  }

  const promise = (async () => {
    const buildStartedAt = Date.now();
    const result = await executeTemplateSpec(authToken, template.spec, params, {
      ...executionOptions,
      dependencyMap,
      baaRequest: options.baaRequest || null
    });
    observeMetricSeconds('cmdp_runtime_cache_build_seconds', {
      scopeMode: templateCacheConfig.scopeMode
    }, (Date.now() - buildStartedAt) / 1000);
    const createdAt = Date.now();
    const newEntry = {
      key: keyParts.key,
      keyShort: keyParts.keyShort,
      specHash: keyParts.specHash,
      paramsHash: keyParts.paramsHash,
      limitsHash: keyParts.limitsHash,
      contextHash: keyParts.contextHash,
      cachePolicyHash: keyParts.cachePolicyHash,
      cacheScope: keyParts.cacheScope,
      scopeMode: keyParts.scopeMode,
      dependencyMapHash: keyParts.dependencyMapHash,
      visibilityHash: keyParts.visibilityHash,
      userScopeHash: keyParts.userScopeHash,
      userScope: keyParts.userScope,
      accessProbe: {
        checkedClasses: accessProbe.checkedClasses || [],
        incomplete: Boolean(accessProbe.incomplete)
      },
      result: cloneJsonValueServer(result, { tables: [] }),
      contentHash: hashJson(result && result.tables ? result.tables : result),
      createdAt,
      lastServedAt: createdAt,
      expiresAt: createdAt + resultTtlMs,
      refreshCooldownMs,
      resultTtlMs,
      allowManualRefresh: templateCacheConfig.allowManualRefresh
    };
    newEntry.cacheBackend = await cacheSetJson('runtime', keyParts.key, newEntry, resultTtlMs, runtimeResultCache);
    return newEntry;
  })();

  runtimeResultInFlight.set(keyParts.key, promise);
  try {
    entry = await promise;
    return {
      result: cloneJsonValueServer(entry.result, { tables: [] }),
      cache: runtimeCacheMeta(entry, forceRefreshRequested ? 'force-refresh' : (refreshRequested ? 'refresh' : 'miss'), Date.now(), { backend: entry.cacheBackend || 'memory' })
    };
  } finally {
    runtimeResultInFlight.delete(keyParts.key);
  }
}

function normalizePublishConfig(spec) {
  const publish = spec && spec.publish && typeof spec.publish === 'object' && !Array.isArray(spec.publish) ? spec.publish : {};
  const mode = publish.mode === 'staticSnapshot' ? 'staticSnapshot' : 'dynamicUser';
  return {
    mode,
    warningAccepted: Boolean(publish.warningAccepted),
    paramsMode: publish.paramsMode === 'ignore' ? 'ignore' : 'exact'
  };
}

function staticSnapshotParamsHash(params, publishConfig) {
  return publishConfig && publishConfig.paramsMode === 'ignore' ? 'any' : hashJson(params || {});
}

function staticSnapshotKey(templateCode, params, publishConfig) {
  const code = validateCmdbuildIdentifier(templateCode, 'template code');
  return `${code}:${staticSnapshotParamsHash(params, publishConfig)}`;
}

function publicSnapshotParamsFromUrl(requestUrl) {
  const params = {};
  requestUrl.searchParams.forEach((value, key) => {
    if (key === 'lang' || key === 'cmdpLang' || key === 'refresh' || key === 'noCache' || key === 'forceRefresh' || key === 'bypassRefreshCooldown' || RUNTIME_SYSTEM_PARAMS.has(key)) return;
    params[key] = value;
  });
  return params;
}

function truthyRuntimeFlag(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function runtimeJsonOutputRequested(requestUrl) {
  return truthyRuntimeFlag(requestUrl && requestUrl.searchParams ? requestUrl.searchParams.get('json') : '');
}

async function readStaticSnapshot(templateCode, params, publishConfig = { paramsMode: 'exact' }) {
  const exactKey = staticSnapshotKey(templateCode, params, { paramsMode: 'exact' });
  let cached = await cacheGetJson('snapshot', exactKey, staticSnapshotCache);
  if (cached.value) return { key: exactKey, backend: cached.backend, snapshot: cached.value };

  if (!publishConfig || publishConfig.paramsMode !== 'exact') {
    const anyKey = staticSnapshotKey(templateCode, {}, { paramsMode: 'ignore' });
    if (anyKey !== exactKey) {
      cached = await cacheGetJson('snapshot', anyKey, staticSnapshotCache);
      if (cached.value) return { key: anyKey, backend: cached.backend, snapshot: cached.value };
    }
  }

  return { key: exactKey, backend: cached.backend, snapshot: null };
}

async function writeStaticSnapshot(root, template, params, result, sessionData, publishConfig) {
  const specHash = hashJson(template.spec || {});
  const paramsHash = staticSnapshotParamsHash(params, publishConfig);
  const key = staticSnapshotKey(template.code, params, publishConfig);
  const now = new Date();
  const session = sanitizeSession(sessionData) || {};
  const snapshot = {
    version: 1,
    root,
    templateCode: template.code,
    description: template.description || '',
    params: cloneJsonValueServer(params || {}, {}),
    paramsHash,
    specHash,
    publish: publishConfig,
    publishedBy: session.username || '',
    publishedRole: session.role || '',
    publishedAt: now.toISOString(),
    result: cloneJsonValueServer(result, { tables: [] })
  };
  const backend = await cacheSetJson('snapshot', key, snapshot, 0, staticSnapshotCache);
  return {
    key,
    backend,
    paramsHash,
    specHash,
    publishedBy: snapshot.publishedBy,
    publishedAt: snapshot.publishedAt,
    result: snapshot.result
  };
}

function staticSnapshotCacheMeta(snapshot, status, backend, key) {
  return {
    enabled: true,
    scope: 'staticSnapshot',
    status,
    key: key ? sha256Hex(key).slice(0, 16) : '',
    backend: backend || 'memory',
    generatedAt: snapshot && snapshot.publishedAt || '',
    publishedAt: snapshot && snapshot.publishedAt || '',
    publishedBy: snapshot && snapshot.publishedBy || '',
    paramsHash: snapshot && snapshot.paramsHash || '',
    specHash: snapshot && snapshot.specHash || '',
    sharedAcrossUsers: true
  };
}

function isRawObjectGroupTableNameServer(name) {
  return /^objects(\d+)?$/.test(String(name || ''));
}

function visibleRuntimeResultTables(tables) {
  const source = Array.isArray(tables) ? tables : [];
  const prepared = source.filter((table) => table && table.name && !isRawObjectGroupTableNameServer(table.name));
  if (prepared.length) return [prepared[prepared.length - 1]];
  return source.length ? [source[source.length - 1]] : [];
}

function runtimeResultTableTitle(table) {
  return String(table && (table.title || table.label || table.name) || '');
}

function runtimeJsonCellLinks(row, rowIndex, columns, table, params) {
  const metaByColumn = table && table.cellMeta && table.cellMeta[String(rowIndex)] || {};
  const links = {};
  const columnLinks = table && table.presentation && table.presentation.columnLinks || {};
  (Array.isArray(columns) ? columns : []).forEach((column) => {
    const linkConfig = columnLinks[column] || {};
    if (!linkConfig || linkConfig.mode !== 'link' || !linkConfig.urlTemplate) return;
    const value = displayCardValue(row && row[column]);
    const meta = metaByColumn[column] || {};
    const mysource = {
      ...meta,
      value,
      column,
      attribute: meta.attribute || column
    };
    const href = renderCellTemplate(linkConfig.urlTemplate, { mysource, row, params });
    if (!isSafeRuntimeLinkUrl(href)) return;
    const text = renderCellTemplate(linkConfig.textTemplate || '${mysource.value}', { mysource, row, params }) || value;
    links[column] = {
      href,
      text,
      value,
      target: linkConfig.target === 'blank' ? 'blank' : 'self'
    };
  });
  return links;
}

function runtimeJsonTables(result, params = {}) {
  const tables = visibleRuntimeResultTables(result && result.tables);
  return tables.map((table) => {
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const labels = table.columnLabels && typeof table.columnLabels === 'object' && !Array.isArray(table.columnLabels) ? table.columnLabels : {};
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const jsonRows = rows.map((row, rowIndex) => {
      const values = {};
      columns.forEach((column) => {
        values[column] = row && row[column] !== undefined ? row[column] : null;
      });
      const links = runtimeJsonCellLinks(row, rowIndex, columns, table, params);
      return Object.keys(links).length ? { values, links } : values;
    });
    return {
      name: table.name || '',
      title: runtimeResultTableTitle(table),
      mode: table.mode || table.view || 'table',
      columns: columns.map((column) => ({ key: column, label: labels[column] || column })),
      rows: jsonRows,
      emptyText: table.emptyText || result && result.emptyText || DEFAULT_EMPTY_RESULT_TEXT,
      truncated: Boolean(table.truncated),
      presentation: table.presentation || undefined
    };
  });
}

function runtimeJsonResponsePayload(payload) {
  const result = payload.result || { tables: [] };
  return {
    success: Boolean(payload.success),
    action: payload.action || 'run',
    snapshotFound: payload.snapshotFound,
    template: payload.template || {},
    params: payload.params || {},
    tables: runtimeJsonTables(result, payload.params || {}),
    emptyText: result.emptyText || DEFAULT_EMPTY_RESULT_TEXT,
    cache: payload.cache || null,
    html: result.kind === 'html' && result.htmlTrusted ? result.html : undefined
  };
}

function inferBaaColumnType(rows, column) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = row && Object.prototype.hasOwnProperty.call(row, column) ? row[column] : undefined;
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return 'string';
  }
  return 'string';
}

function baaTablesFromRuntimeResult(result) {
  return visibleRuntimeResultTables(result && result.tables).map((table) => {
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const labels = table.columnLabels && typeof table.columnLabels === 'object' && !Array.isArray(table.columnLabels) ? table.columnLabels : {};
    const rows = Array.isArray(table.rows) ? table.rows : [];
    return {
      code: table.name || '',
      title: runtimeResultTableTitle(table),
      columns: columns.map((column) => ({
        name: column,
        title: labels[column] || column,
        type: inferBaaColumnType(rows, column)
      })),
      rows: rows.map((row) => {
        const output = {};
        columns.forEach((column) => {
          output[column] = row && row[column] !== undefined ? row[column] : null;
        });
        return output;
      })
    };
  });
}

function baaResponseFromRuntimeResult(result, template) {
  const tables = baaTablesFromRuntimeResult(result);
  return baaEnvelope({
    success: true,
    status: 'completed',
    title: template && (template.description || template.code) || '',
    message: '',
    tables,
    items: [],
    data: {}
  });
}

function baaErrorCodeFromError(error) {
  if (errorLooksPermissionDenied(error)) return 'CMDB_PERMISSION_DENIED';
  const message = error && error.message ? String(error.message) : String(error || '');
  if (/limit|maximum|maxRows|maxRestCalls|maxClasses|maxDomains/i.test(message)) return 'EXECUTION_LIMIT_EXCEEDED';
  return 'EXECUTION_ERROR';
}

function baaErrorResponse(code, message, status = 'error', extraItems = []) {
  return baaEnvelope({
    success: false,
    status,
    message,
    tables: [],
    items: [baaErrorItem(code, message)].concat(extraItems || []),
    data: {}
  });
}

async function sendPublicSnapshotRun(res, requestUrl, templateCode) {
  const params = publicSnapshotParamsFromUrl(requestUrl);
  const jsonOutput = runtimeJsonOutputRequested(requestUrl);
  let lookup;
  try {
    lookup = await readStaticSnapshot(templateCode, params, { paramsMode: 'ignore' });
  } catch (error) {
    sendJson(res, error.statusCode || 400, {
      success: false,
      message: error && error.message ? error.message : String(error)
    });
    return;
  }
  const snapshot = lookup.snapshot;
  if (!snapshot) {
    const payload = {
      success: true,
      snapshotFound: false,
      action: 'run',
      template: { code: templateCode },
      params,
      result: { emptyText: SNAPSHOT_MISSING_TEXT, tables: [] },
      cache: staticSnapshotCacheMeta(null, 'snapshot-miss', lookup.backend, lookup.key)
    };
    sendJson(res, 200, jsonOutput ? runtimeJsonResponsePayload(payload) : payload);
    return;
  }
  const payload = {
    success: true,
    snapshotFound: true,
    action: 'run',
    template: {
      code: snapshot.templateCode || templateCode,
      description: snapshot.description || ''
    },
    params: snapshot.params || params,
    result: snapshot.result || { tables: [] },
    cache: staticSnapshotCacheMeta(snapshot, 'snapshot-hit', lookup.backend, lookup.key)
  };
  sendJson(res, 200, jsonOutput ? runtimeJsonResponsePayload(payload) : payload);
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

function applyTemplateParamDefaults(spec, params) {
  const effective = {};
  const assignDefaults = (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null && effective[key] === undefined) {
        effective[key] = value;
      }
    }
  };
  assignDefaults(spec && spec.defaults);
  assignDefaults(spec && spec.paramDefaults);
  if (spec && spec.classNameFallback && effective.className === undefined) {
    effective.className = spec.classNameFallback;
  }
  if (spec && spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params)) {
    for (const [key, definition] of Object.entries(spec.params)) {
      if (effective[key] !== undefined || !definition || typeof definition !== 'object') continue;
      if (definition.default !== undefined) effective[key] = definition.default;
      else if (definition.defaultValue !== undefined) effective[key] = definition.defaultValue;
    }
  }
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (value === '' && effective[key] !== undefined) continue;
      effective[key] = value;
    }
  }
  return effective;
}

function templateParamHasDefault(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return false;
  if (Object.prototype.hasOwnProperty.call(definition, 'default')) {
    return definition.default !== undefined && definition.default !== null && String(definition.default).trim() !== '';
  }
  if (Object.prototype.hasOwnProperty.call(definition, 'defaultValue')) {
    return definition.defaultValue !== undefined && definition.defaultValue !== null && String(definition.defaultValue).trim() !== '';
  }
  return false;
}

function validateTemplateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ path: '$', message: 'Template spec must be an object.' }];
  }
  if (spec.version !== 1) {
    errors.push({ path: '$.version', message: 'Only DSL version 1 is supported.' });
  }
  if (spec.publish !== undefined) {
    if (!spec.publish || typeof spec.publish !== 'object' || Array.isArray(spec.publish)) {
      errors.push({ path: '$.publish', message: 'Template publish settings must be an object.' });
    } else {
      const publish = normalizePublishConfig(spec);
      if (spec.publish.mode !== undefined && !['dynamicUser', 'staticSnapshot'].includes(spec.publish.mode)) {
        errors.push({ path: '$.publish.mode', message: 'Publish mode must be dynamicUser or staticSnapshot.' });
      }
      if (spec.publish.paramsMode !== undefined && !['exact', 'ignore'].includes(spec.publish.paramsMode)) {
        errors.push({ path: '$.publish.paramsMode', message: 'Publish paramsMode must be exact or ignore.' });
      }
      if (publish.mode === 'staticSnapshot' && !publish.warningAccepted) {
        errors.push({ path: '$.publish.warningAccepted', message: 'Static snapshot publication requires warningAccepted=true.' });
      }
    }
  }
  if (spec.cache !== undefined) {
    if (!spec.cache || typeof spec.cache !== 'object' || Array.isArray(spec.cache)) {
      errors.push({ path: '$.cache', message: 'Template cache settings must be an object.' });
    } else {
      if (spec.cache.enabled !== undefined && typeof spec.cache.enabled !== 'boolean') {
        errors.push({ path: '$.cache.enabled', message: 'Template cache enabled must be boolean.' });
      }
      if (spec.cache.scopeMode !== undefined && !['permissionOnly', 'visibilityHash', 'privateUser', 'disabled'].includes(spec.cache.scopeMode)) {
        errors.push({ path: '$.cache.scopeMode', message: 'Template cache scopeMode must be permissionOnly, visibilityHash, privateUser, or disabled.' });
      }
      if (spec.cache.shareMode !== undefined && !['endpoint', 'user'].includes(spec.cache.shareMode)) {
        errors.push({ path: '$.cache.shareMode', message: 'Template cache shareMode must be endpoint or user.' });
      }
      if (spec.cache.ttlSeconds !== undefined && (!Number.isInteger(Number(spec.cache.ttlSeconds)) || Number(spec.cache.ttlSeconds) <= 0)) {
        errors.push({ path: '$.cache.ttlSeconds', message: 'Template cache ttlSeconds must be a positive integer.' });
      }
      if (spec.cache.allowManualRefresh !== undefined && typeof spec.cache.allowManualRefresh !== 'boolean') {
        errors.push({ path: '$.cache.allowManualRefresh', message: 'Template cache allowManualRefresh must be boolean.' });
      }
    }
  }
  if (spec.params !== undefined) {
    if (!spec.params || typeof spec.params !== 'object' || Array.isArray(spec.params)) {
      errors.push({ path: '$.params', message: 'Template params must be an object.' });
    } else {
      Object.entries(spec.params).forEach(([name, definition]) => {
        const path = `$.params.${name}`;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          errors.push({ path, message: 'Parameter name must start with a Latin letter or underscore and contain only Latin letters, digits, and underscores.' });
        }
        if (RUNTIME_SYSTEM_PARAMS.has(name)) {
          errors.push({ path, message: `Parameter name ${name} is reserved for runtime output mode.` });
        }
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
          errors.push({ path, message: 'Parameter definition must be an object with type, required, and optional default fields.' });
          return;
        }
        if (definition.required !== true && !templateParamHasDefault(definition)) {
          errors.push({ path: `${path}.default`, message: `Optional parameter ${name} must have a default value.` });
        }
      });
    }
  }
  if (spec.kind !== undefined && spec.kind !== CMDB_BUILD_VIEW_KIND && spec.kind !== 'dsl') {
    errors.push({ path: '$.kind', message: `Template kind must be dsl or ${CMDB_BUILD_VIEW_KIND}.` });
  }
  if (spec.endpoint !== undefined) {
    if (!spec.endpoint || typeof spec.endpoint !== 'object' || Array.isArray(spec.endpoint)) {
      errors.push({ path: '$.endpoint', message: 'Template endpoint settings must be an object.' });
    } else if (spec.endpoint.kind !== undefined && !['runtime', 'baaVerification'].includes(spec.endpoint.kind)) {
      errors.push({ path: '$.endpoint.kind', message: 'Endpoint kind must be runtime or baaVerification.' });
    }
  }
  if (spec.baaContract !== undefined) {
    if (!spec.baaContract || typeof spec.baaContract !== 'object' || Array.isArray(spec.baaContract)) {
      errors.push({ path: '$.baaContract', message: 'BAA contract must be an object.' });
    } else {
      const contract = normalizeBaaContractServer(spec);
      contract.variables.forEach((field) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) {
          errors.push({ path: `$.baaContract.variables.${field.name}`, message: 'BAA variable name must be a Latin identifier.' });
        }
      });
      contract.objects.forEach((object) => {
        if (object.alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(object.alias)) {
          errors.push({ path: `$.baaContract.objects.${object.alias}`, message: 'BAA object alias must be a Latin identifier.' });
        }
        object.payload.forEach((field) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) {
            errors.push({ path: `$.baaContract.objects.${object.alias}.payload.${field.name}`, message: 'BAA payload field name must be a Latin identifier.' });
          }
        });
      });
    }
  }
  if (isCmdbBuildViewSpec(spec)) {
    errors.push(...validateCmdbBuildViewSpec(spec));
    return errors;
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
      } else if (step.type === 'baaPlanObjects') {
        if (step.payloadPrefix !== undefined && typeof step.payloadPrefix !== 'string') {
          errors.push({ path: `${path}.payloadPrefix`, message: 'baaPlanObjects payloadPrefix must be a string.' });
        }
        if (step.objectAlias !== undefined && typeof step.objectAlias !== 'string') {
          errors.push({ path: `${path}.objectAlias`, message: 'baaPlanObjects objectAlias must be a string.' });
        }
        const filters = step.filters || step.where || [];
        if (filters !== undefined && !Array.isArray(filters)) {
          errors.push({ path: `${path}.filters`, message: 'baaPlanObjects filters must be an array.' });
        } else {
          const allowedOps = ['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'in', 'exists', 'notExists', 'matches', 'notMatches', 'isIpv4', 'isIpv4Network', 'ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains'];
          filters.forEach((filter, filterIndex) => {
            const filterPath = `${path}.filters[${filterIndex}]`;
            if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
              errors.push({ path: filterPath, message: 'baaPlanObjects filter must be an object.' });
              return;
            }
            if (!filter.attribute && !filter.column && !filter.field && !filter.path) {
              errors.push({ path: `${filterPath}.path`, message: 'baaPlanObjects filter requires path.' });
            }
            if (filter.op !== undefined && !allowedOps.includes(filter.op)) {
              errors.push({ path: `${filterPath}.op`, message: `baaPlanObjects filter op must be one of: ${allowedOps.join(', ')}.` });
            }
            if ((filter.op === 'matches' || filter.op === 'notMatches' || filter.regex !== undefined) && typeof filter.regex !== 'string') {
              errors.push({ path: `${filterPath}.regex`, message: 'baaPlanObjects regex filter requires a regular expression string.' });
            } else if (filter.regex !== undefined) {
              errors.push(...validateRegexPattern(filter.regex, '', `${filterPath}.regex`, false));
            }
            if (filter.negate !== undefined && typeof filter.negate !== 'boolean') {
              errors.push({ path: `${filterPath}.negate`, message: 'baaPlanObjects filter negate must be boolean.' });
            }
          });
        }
      } else if (step.type === 'extractVariables' || step.type === 'extract') {
        if (!step.regex || typeof step.regex !== 'string') {
          errors.push({ path: `${path}.regex`, message: 'extractVariables requires a regular expression string.' });
        } else {
          errors.push(...validateRegexPattern(step.regex, step.flags, `${path}.regex`, step.all !== false));
        }
        if (!step.sourceParam && !step.from && !step.source && step.sourceValue === undefined) {
          errors.push({ path, message: 'extractVariables requires sourceParam, from, source, or sourceValue.' });
        }
      } else if (step.type === 'selectCards') {
        if (!step.className && !step.classNameParam && !step.classColumn) {
          errors.push({ path, message: 'selectCards requires className, classNameParam, or classColumn.' });
        }
        if (step.className && !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(step.className))) {
          errors.push({ path: `${path}.className`, message: 'selectCards className must be a CMDBuild identifier.' });
        }
        if (step.from !== undefined && typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'selectCards from must be a source alias string.' });
        }
        if (step.limit !== undefined && (!Number.isInteger(Number(step.limit)) || Number(step.limit) <= 0)) {
          errors.push({ path: `${path}.limit`, message: 'selectCards limit must be a positive integer.' });
        }
        const filters = step.filters || step.where || [];
        if (!Array.isArray(filters)) {
          errors.push({ path: `${path}.filters`, message: 'selectCards filters must be an array.' });
        } else {
          const allowedOps = ['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'in', 'exists', 'notExists', 'matches', 'notMatches', 'isIpv4', 'isIpv4Network', 'ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains'];
          filters.forEach((filter, filterIndex) => {
            const filterPath = `${path}.filters[${filterIndex}]`;
            if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
              errors.push({ path: filterPath, message: 'selectCards filter must be an object.' });
              return;
            }
            if (!filter.attribute && !filter.column && !filter.field && !filter.path) {
              errors.push({ path: `${filterPath}.attribute`, message: 'selectCards filter requires attribute or path.' });
            }
            if (filter.op !== undefined && !allowedOps.includes(filter.op)) {
              errors.push({ path: `${filterPath}.op`, message: `selectCards filter op must be one of: ${allowedOps.join(', ')}.` });
            }
            if ((filter.op === 'matches' || filter.op === 'notMatches' || filter.regex !== undefined) && typeof filter.regex !== 'string') {
              errors.push({ path: `${filterPath}.regex`, message: 'selectCards regex filter requires a regular expression string.' });
            } else if (filter.regex !== undefined) {
              errors.push(...validateRegexPattern(filter.regex, '', `${filterPath}.regex`, false));
            }
            if (filter.negate !== undefined && typeof filter.negate !== 'boolean') {
              errors.push({ path: `${filterPath}.negate`, message: 'selectCards filter negate must be boolean.' });
            }
            if (filter.scope !== undefined && !['include', 'exclude'].includes(filter.scope)) {
              errors.push({ path: `${filterPath}.scope`, message: 'selectCards scope must be include or exclude.' });
            }
          });
        }
      } else if (step.type === 'composeRows' || step.type === 'compose') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'composeRows requires a left source alias in "from".' });
        }
        if (step.with !== undefined && typeof step.with !== 'string') {
          errors.push({ path: `${path}.with`, message: 'composeRows with must be a right source alias string.' });
        }
        if (step.with) {
          try {
            normalizeRowOperationKeys(step);
          } catch (error) {
            errors.push({ path: `${path}.on`, message: error && error.message ? error.message : String(error) });
          }
          if (step.mode !== undefined && !['inner', 'left', 'right', 'full'].includes(step.mode)) {
            errors.push({ path: `${path}.mode`, message: 'composeRows mode must be one of inner, left, right, full.' });
          }
        }
        const columns = step.columns || step.fields || [];
        if (!Array.isArray(columns) || columns.length === 0) {
          errors.push({ path: `${path}.columns`, message: 'composeRows requires a non-empty columns array.' });
        } else {
          columns.forEach((column, columnIndex) => {
            const columnPath = `${path}.columns[${columnIndex}]`;
            if (!column || typeof column !== 'object' || Array.isArray(column)) {
              errors.push({ path: columnPath, message: 'composeRows column must be an object.' });
              return;
            }
            const name = column.name || column.as || column.label;
            if (!name || typeof name !== 'string') {
              errors.push({ path: `${columnPath}.name`, message: 'composeRows column requires name.' });
            }
            const source = column.source || column.from || 'left';
            const hasLiteralSource = Boolean(column.valueParam || Object.prototype.hasOwnProperty.call(column, 'value') || column.template);
            if (!hasLiteralSource && !['left', 'right'].includes(source)) {
              errors.push({ path: `${columnPath}.source`, message: 'composeRows column source must be left/right, or use valueParam/value/template.' });
            }
            if (!hasLiteralSource && (source === 'left' || source === 'right') && !column.column && !column.field) {
              errors.push({ path: `${columnPath}.column`, message: 'composeRows left/right column requires column.' });
            }
          });
        }
      } else if (step.type === 'enrichRows') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'enrichRows requires a source alias in "from".' });
        }
        const columns = step.columns || step.fields || [];
        if (!Array.isArray(columns) || columns.length === 0) {
          errors.push({ path: `${path}.columns`, message: 'enrichRows requires a non-empty columns array.' });
        } else {
          columns.forEach((column, columnIndex) => {
            const columnPath = `${path}.columns[${columnIndex}]`;
            if (typeof column === 'string') return;
            if (!column || typeof column !== 'object' || Array.isArray(column)) {
              errors.push({ path: columnPath, message: 'enrichRows column must be a string or an object.' });
              return;
            }
            const columnPathValue = column.path || column.field || column.column || column.name;
            if (!columnPathValue || typeof columnPathValue !== 'string') {
              errors.push({ path: `${columnPath}.path`, message: 'enrichRows column requires path or field.' });
            }
            const alias = column.as || column.name || column.label;
            if (alias !== undefined && typeof alias !== 'string') {
              errors.push({ path: `${columnPath}.as`, message: 'enrichRows column alias must be a string.' });
            }
            const multiMode = column.multiMode || column.displayMode || column.mode;
            if (multiMode !== undefined && !['join', 'rows'].includes(multiMode)) {
              errors.push({ path: `${columnPath}.multiMode`, message: 'enrichRows column multiMode must be join or rows.' });
            }
            if (column.separator !== undefined && typeof column.separator !== 'string') {
              errors.push({ path: `${columnPath}.separator`, message: 'enrichRows column separator must be a string.' });
            }
            if (column.emptyRow !== undefined && typeof column.emptyRow !== 'boolean') {
              errors.push({ path: `${columnPath}.emptyRow`, message: 'enrichRows column emptyRow must be a boolean.' });
            }
          });
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
      } else if (step.type === 'matchRows') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'matchRows requires a left source alias in "from".' });
        }
        if (!step.with || typeof step.with !== 'string') {
          errors.push({ path: `${path}.with`, message: 'matchRows requires a right source alias in "with".' });
        }
        const rules = step.rules || step.where;
        if (!Array.isArray(rules) || rules.length === 0) {
          errors.push({ path: `${path}.rules`, message: 'matchRows requires a non-empty rules array.' });
        } else {
          rules.forEach((rule, ruleIndex) => {
            const rulePath = `${path}.rules[${ruleIndex}]`;
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
              errors.push({ path: rulePath, message: 'matchRows rule must be an object.' });
              return;
            }
            const left = rule.left && typeof rule.left === 'object' && !Array.isArray(rule.left) ? rule.left : {};
            const right = rule.right && typeof rule.right === 'object' && !Array.isArray(rule.right) ? rule.right : {};
            const leftColumn = rule.leftColumn || rule.leftField || left.column || left.field || left.path;
            const rightColumn = rule.rightColumn || rule.rightField || right.column || right.field || right.path;
            if (!leftColumn || typeof leftColumn !== 'string') {
              errors.push({ path: `${rulePath}.left.column`, message: 'matchRows rule requires left.column.' });
            }
            if (!rightColumn || typeof rightColumn !== 'string') {
              errors.push({ path: `${rulePath}.right.column`, message: 'matchRows rule requires right.column.' });
            }
            if (rule.action !== undefined && !['include', 'exclude'].includes(rule.action) && !['include', 'exclude'].includes(rule.scope)) {
              errors.push({ path: `${rulePath}.action`, message: 'matchRows rule action must be include or exclude.' });
            }
            const operator = rule.operator || rule.op || 'equals';
            const allowedOperators = ['equals', 'notEquals', 'contains', 'regexMatch', 'ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains'];
            if (!allowedOperators.includes(operator)) {
              errors.push({ path: `${rulePath}.operator`, message: `matchRows rule operator must be one of: ${allowedOperators.join(', ')}.` });
            }
            [
              [rule.leftRegex !== undefined ? rule.leftRegex : left.regex, `${rulePath}.left.regex`],
              [rule.rightRegex !== undefined ? rule.rightRegex : right.regex, `${rulePath}.right.regex`]
            ].forEach(([pattern, regexPath]) => {
              if (pattern !== undefined && pattern !== '') errors.push(...validateRegexPattern(pattern, '', regexPath, false));
            });
          });
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
      } else if (step.type === 'expandRelations') {
        if (!step.from || typeof step.from !== 'string') {
          errors.push({ path: `${path}.from`, message: 'expandRelations requires a source alias in "from".' });
        }
        if (step.sourceClassColumn !== undefined && typeof step.sourceClassColumn !== 'string') {
          errors.push({ path: `${path}.sourceClassColumn`, message: 'expandRelations sourceClassColumn must be a string.' });
        }
        if (step.sourceIdColumn !== undefined && typeof step.sourceIdColumn !== 'string') {
          errors.push({ path: `${path}.sourceIdColumn`, message: 'expandRelations sourceIdColumn must be a string.' });
        }
        if (step.sourceClass && !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(step.sourceClass))) {
          errors.push({ path: `${path}.sourceClass`, message: 'expandRelations sourceClass must be a CMDBuild identifier.' });
        }
        const domains = normalizeStringList(step.domain);
        if (domains.some((domain) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(domain))) {
          errors.push({ path: `${path}.domain`, message: 'expandRelations domain must contain CMDBuild identifiers.' });
        }
        const targetClasses = normalizeStringList(step.targetClass);
        if (targetClasses.some((targetClass) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(targetClass))) {
          errors.push({ path: `${path}.targetClass`, message: 'expandRelations targetClass must contain CMDBuild identifiers.' });
        }
        if (step.direction !== undefined && !['both', 'direct', 'inverse', 'source', 'destination'].includes(step.direction)) {
          errors.push({ path: `${path}.direction`, message: 'expandRelations direction must be one of both, direct, inverse, source, destination.' });
        }
        if (step.limit !== undefined && (!Number.isInteger(Number(step.limit)) || Number(step.limit) <= 0)) {
          errors.push({ path: `${path}.limit`, message: 'expandRelations limit must be a positive integer.' });
        }
        if (step.perCardLimit !== undefined && (!Number.isInteger(Number(step.perCardLimit)) || Number(step.perCardLimit) <= 0)) {
          errors.push({ path: `${path}.perCardLimit`, message: 'expandRelations perCardLimit must be a positive integer.' });
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
    if (spec.result.emptyText !== undefined && typeof spec.result.emptyText !== 'string') {
      errors.push({ path: '$.result.emptyText', message: 'Result emptyText must be a string.' });
    }
    if (spec.result.permissionDeniedText !== undefined && typeof spec.result.permissionDeniedText !== 'string') {
      errors.push({ path: '$.result.permissionDeniedText', message: 'Result permissionDeniedText must be a string.' });
    }
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
      if (table.mode !== undefined && !['table', 'compact', 'keyValue'].includes(table.mode)) {
        errors.push({ path: `${path}.mode`, message: 'Result table mode must be one of: table, compact, keyValue.' });
      }
      if (table.title !== undefined && typeof table.title !== 'string') {
        errors.push({ path: `${path}.title`, message: 'Result table title must be a string.' });
      }
      if (table.emptyText !== undefined && typeof table.emptyText !== 'string') {
        errors.push({ path: `${path}.emptyText`, message: 'Result table emptyText must be a string.' });
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

function runtimeCardUrl(className, id) {
  const classText = displayCardValue(className).trim();
  const idText = displayCardValue(id).trim();
  if (!classText || !idText) return '';
  return `/cmdbuild/ui/#classes/${encodeURIComponent(classText)}/cards/${encodeURIComponent(idText)}`;
}

function sourceUrlKeySuffix(value) {
  return displayCardValue(value).trim().replace(/[._\s]+$/g, '').replace(/^[._\s]+/g, '').replace(/[._\s]+/g, '');
}

function addSourceUrlVar(vars, suffix, className, id) {
  const keySuffix = sourceUrlKeySuffix(suffix);
  const url = runtimeCardUrl(className, id);
  if (!keySuffix || !url) return;
  vars[`sourceURL${keySuffix}`] = url;
}

function firstPresentRowValue(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return '';
}

function prefixedRowKeys(prefix) {
  const cleanPrefix = String(prefix || '');
  return {
    classKeys: [
      `${cleanPrefix}.Class`,
      `${cleanPrefix}.class`,
      `${cleanPrefix}.Type`,
      `${cleanPrefix}._type`,
      `${cleanPrefix}.RelatedClass`,
      `${cleanPrefix}.SourceClass`,
      `${cleanPrefix}_Class`,
      `${cleanPrefix}_class`,
      `${cleanPrefix}_Type`,
      `${cleanPrefix}__type`,
      `${cleanPrefix}_RelatedClass`,
      `${cleanPrefix}_SourceClass`,
      `${cleanPrefix}Class`,
      `${cleanPrefix}RelatedClass`,
      `${cleanPrefix}SourceClass`
    ],
    idKeys: [
      `${cleanPrefix}._id`,
      `${cleanPrefix}.id`,
      `${cleanPrefix}.Id`,
      `${cleanPrefix}.RelatedId`,
      `${cleanPrefix}.SourceId`,
      `${cleanPrefix}__id`,
      `${cleanPrefix}_id`,
      `${cleanPrefix}_Id`,
      `${cleanPrefix}_RelatedId`,
      `${cleanPrefix}_SourceId`,
      `${cleanPrefix}Id`,
      `${cleanPrefix}RelatedId`,
      `${cleanPrefix}SourceId`
    ]
  };
}

function addPrefixedSourceUrlVar(vars, row, prefix) {
  const keys = prefixedRowKeys(prefix);
  addSourceUrlVar(vars, prefix, firstPresentRowValue(row, keys.classKeys), firstPresentRowValue(row, keys.idKeys));
}

function buildRowSourceUrlVars(row) {
  const vars = {};
  if (!row || typeof row !== 'object') return vars;

  const className = row.Class || row.RelatedClass || row.SourceClass;
  const id = row._id || row.RelatedId || row.SourceId;
  const defaultUrl = runtimeCardUrl(className, id);
  if (defaultUrl) {
    vars.sourceURL = defaultUrl;
    addSourceUrlVar(vars, row.__source, className, id);
    addSourceUrlVar(vars, 'Выборка1', className, id);
    addSourceUrlVar(vars, 'Selection1', className, id);
  }

  addSourceUrlVar(vars, 'Source', row.SourceClass, row.SourceId);
  addSourceUrlVar(vars, 'Related', row.RelatedClass, row.RelatedId);

  const prefixes = new Set();
  for (const key of Object.keys(row)) {
    if (key.endsWith('.Class')) {
      const prefix = key.slice(0, -'.Class'.length);
      prefixes.add(prefix);
    } else if (key.endsWith('_Class')) {
      const prefix = key.slice(0, -'_Class'.length);
      prefixes.add(prefix);
    } else if (key.endsWith('.RelatedClass')) {
      const prefix = key.slice(0, -'.RelatedClass'.length);
      prefixes.add(prefix);
      addSourceUrlVar(vars, `${prefix}Related`, row[key], row[`${prefix}.RelatedId`] || row[`${prefix}._id`]);
    } else if (key.endsWith('_RelatedClass')) {
      const prefix = key.slice(0, -'_RelatedClass'.length);
      prefixes.add(prefix);
      addSourceUrlVar(vars, `${prefix}Related`, row[key], row[`${prefix}_RelatedId`] || row[`${prefix}__id`] || row[`${prefix}_id`]);
    } else if (key.endsWith('.class')) {
      prefixes.add(key.slice(0, -'.class'.length));
    } else if (key.endsWith('_class')) {
      prefixes.add(key.slice(0, -'_class'.length));
    } else if (key.endsWith('Class') && key.length > 'Class'.length) {
      prefixes.add(key.slice(0, -'Class'.length));
    } else if (key.endsWith('RelatedClass') && key.length > 'RelatedClass'.length) {
      prefixes.add(key.slice(0, -'RelatedClass'.length));
    }
  }
  prefixes.forEach((prefix) => addPrefixedSourceUrlVar(vars, row, prefix));

  return vars;
}

function sourceCellMetaForRow(row, column) {
  const sourceClass = displayCardValue(row && (row.SourceClass || row.RelatedClass || row.Class));
  const sourceId = displayCardValue(row && (row.SourceId || row.RelatedId || row._id));
  const sourceUrls = buildRowSourceUrlVars(row);
  return {
    source: displayCardValue(row && row.__source),
    sourceClass,
    sourceId,
    attribute: String(column || ''),
    domainPath: displayCardValue(row && row.Domain),
    sourceUrls,
    ...sourceUrls
  };
}

function buildResultCellMeta(rows, columns) {
  const result = {};
  (Array.isArray(rows) ? rows : []).forEach((row, rowIndex) => {
    const rowMeta = {};
    (Array.isArray(columns) ? columns : []).forEach((column) => {
      rowMeta[column] = sourceCellMetaForRow(row, column);
    });
    result[String(rowIndex)] = rowMeta;
  });
  return result;
}

function renderCellTemplate(template, context) {
  const source = context && context.mysource ? context.mysource : {};
  const row = context && context.row ? context.row : {};
  const params = context && context.params ? context.params : {};
  return String(template || '').replace(/\$\{([^{}]+)\}/g, (match, token) => {
    const text = String(token || '').trim();
    if (!text) return '';
    if (text === 'mysource.value') return displayCardValue(source.value);
    if (text === 'mysource.column') return displayCardValue(source.column);
    if (text === 'mysource.source') return displayCardValue(source.source);
    if (text === 'mysource.sourceClass') return displayCardValue(source.sourceClass);
    if (text === 'mysource.sourceId') return displayCardValue(source.sourceId);
    if (text === 'mysource.attribute') return displayCardValue(source.attribute);
    if (text === 'mysource.domainPath') return displayCardValue(source.domainPath);
    if (text.startsWith('mysource.') && Object.prototype.hasOwnProperty.call(source, text.slice(9))) return displayCardValue(source[text.slice(9)]);
    if (Object.prototype.hasOwnProperty.call(source, text)) return displayCardValue(source[text]);
    if (text.startsWith('row.')) return displayCardValue(row[text.slice(4)]);
    if (text.startsWith('param.')) return displayCardValue(params[text.slice(6)]);
    if (text.startsWith('params.')) return displayCardValue(params[text.slice(7)]);
    return '';
  });
}

function isSafeRuntimeLinkUrl(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase().split('').filter((ch) => ch.charCodeAt(0) > 31 && !/\s/.test(ch)).join('');
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return false;
  if (/^[a-z][a-z0-9+\.\-]*:/i.test(text)) return /^https?:/i.test(text) || /^mailto:/i.test(text);
  return true;
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function readableClassItemsFromResponse(response) {
  const rawItems = Array.isArray(response && response.json && response.json.data) ? response.json.data : [];
  return rawItems
    .map(sanitizeClass)
    .filter(Boolean)
    .filter((item) => item.name && item.active !== false && (!item.permissions || item.permissions._can_read !== false));
}

async function getExecutionClasses(cmdbuildExecRequest, limits, cache) {
  if (cache.loaded) return cache.classes;
  cache.loaded = true;
  const maxClasses = Math.max(limits.maxClasses || 100, limits.maxClassesMax || limits.maxClasses || 100);
  const response = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes?limit=${maxClasses}&detailed=true`);
  cache.classes = response.ok ? readableClassItemsFromResponse(response) : [];
  cache.ok = response.ok;
  return cache.classes;
}

function classNamesForSelection(classes, requestedClassName) {
  const requested = String(requestedClassName || '').trim();
  if (!requested) return [];
  const byName = new Map();
  const childrenByParent = new Map();
  classes.forEach((item) => {
    if (!item || !item.name) return;
    byName.set(String(item.name).toLowerCase(), item);
  });
  classes.forEach((item) => {
    if (!item || !item.name || !item.parent) return;
    const parentKey = String(item.parent).toLowerCase();
    if (!byName.has(parentKey)) return;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey).push(item);
  });

  const selected = byName.get(requested.toLowerCase());
  if (!selected) return [requested];

  const visited = new Set();
  const descendants = [];
  function collectDescendants(item) {
    if (!item || !item.name) return;
    const key = String(item.name).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    (childrenByParent.get(key) || []).forEach((child) => {
      descendants.push(child);
      collectDescendants(child);
    });
  }

  collectDescendants(selected);
  const descendantNames = descendants.filter((item) => !item.prototype).map((item) => item.name);
  if (descendantNames.length) return uniqueStrings(descendantNames);
  return uniqueStrings(selected.prototype ? descendants.map((item) => item.name) : [selected.name]);
}

async function resolveExecutionClassNames(cmdbuildExecRequest, limits, requestedClassName, classesCache, resolvedCache) {
  const cacheKey = String(requestedClassName || '').toLowerCase();
  if (resolvedCache.has(cacheKey)) return resolvedCache.get(cacheKey);
  let classNames = [String(requestedClassName || '').trim()].filter(Boolean);
  try {
    const classes = await getExecutionClasses(cmdbuildExecRequest, limits, classesCache);
    if (classes.length) classNames = classNamesForSelection(classes, requestedClassName);
  } catch {
    classNames = [String(requestedClassName || '').trim()].filter(Boolean);
  }
  resolvedCache.set(cacheKey, classNames);
  return classNames;
}

function normalizeRegexFlags(flags, allMatches) {
  let result = '';
  for (const flag of String(flags || '')) {
    if (!'gimsuy'.includes(flag) || result.includes(flag)) continue;
    result += flag;
  }
  if (allMatches && !result.includes('g')) result += 'g';
  if (!allMatches) result = result.replace(/g/g, '');
  return result;
}

function stripRegexParamPlaceholders(pattern) {
  return String(pattern || '').replace(/\$\{(param|var|contractparam)\.([A-Za-z_][A-Za-z0-9_]*)\}/g, '');
}

function regexHasNestedQuantifier(pattern) {
  const text = stripRegexParamPlaceholders(pattern).replace(/\\./g, '');
  return /\([^)]*(?:[*+]|\{\d+(?:,\d*)?\})[^)]*\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/.test(text);
}

function validateRegexPattern(pattern, flags = '', path = '$.regex', allMatches = false) {
  const text = String(pattern || '');
  const errors = [];
  if (text.length > REGEX_MAX_PATTERN_LENGTH) {
    errors.push({ path, message: `Regex pattern exceeds ${REGEX_MAX_PATTERN_LENGTH} characters.` });
  }
  if (regexHasNestedQuantifier(text)) {
    errors.push({ path, message: 'Regex pattern uses nested quantifiers that can cause excessive backtracking.' });
  }
  try {
    new RegExp(stripRegexParamPlaceholders(text), normalizeRegexFlags(flags, allMatches));
  } catch (error) {
    errors.push({ path, message: `Regex is invalid: ${error.message}` });
  }
  return errors;
}

function assertRegexPatternAllowed(pattern, flags = '', path = '$.regex', allMatches = false) {
  const errors = validateRegexPattern(pattern, flags, path, allMatches);
  if (errors.length) {
    const error = new Error(errors.map((item) => `${item.path}: ${item.message}`).join(' '));
    error.statusCode = 400;
    throw error;
  }
}

function assertRegexInputAllowed(value, path = 'regex input') {
  const text = String(value === undefined || value === null ? '' : value);
  if (text.length > REGEX_MAX_INPUT_LENGTH) {
    const error = new Error(`${path} exceeds ${REGEX_MAX_INPUT_LENGTH} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
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

function resolveExtractionSources(step, params, context) {
  if (step.sourceValue !== undefined) {
    return [{ source: 'literal', value: step.sourceValue }];
  }
  if (step.sourceParam) {
    return [{ source: `params.${step.sourceParam}`, value: params[step.sourceParam] }];
  }
  const source = step.from || step.source;
  if (typeof source === 'string' && source.startsWith('params.')) {
    const name = source.slice('params.'.length);
    return [{ source, value: params[name] }];
  }
  if (typeof source === 'string' && context[source]) {
    const table = context[source];
    const column = step.column || step.sourceColumn || step.field;
    return (table.rows || []).map((row, index) => ({
      source: `${source}[${index}]${column ? `.${column}` : ''}`,
      value: column ? row[column] : JSON.stringify(row)
    }));
  }
  return [{ source: String(source || 'unknown'), value: '' }];
}

function executeExtractVariables(step, params, context, limits) {
  assertRegexPatternAllowed(step.regex, step.flags, 'extractVariables.regex', step.all !== false);
  const regex = new RegExp(step.regex, normalizeRegexFlags(step.flags, step.all !== false));
  const columns = ['Source', 'Index', 'Match'];
  const rows = [];
  const sources = resolveExtractionSources(step, params, context);

  for (const item of sources) {
    const values = Array.isArray(item.value) ? item.value : [item.value];
    for (const value of values) {
      const text = assertRegexInputAllowed(value, 'extractVariables source');
      regex.lastIndex = 0;
      let match;
      let matchIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        const row = {
          Source: item.source,
          Index: matchIndex,
          Match: match[0]
        };
        if (match.groups && Object.keys(match.groups).length) {
          for (const [key, groupValue] of Object.entries(match.groups)) {
            if (!columns.includes(key)) columns.push(key);
            row[key] = groupValue;
          }
        } else {
          for (let index = 1; index < match.length; index += 1) {
            const groupName = `Group${index}`;
            if (!columns.includes(groupName)) columns.push(groupName);
            row[groupName] = match[index];
          }
        }
        rows.push(row);
        if (rows.length >= limits.maxRows) {
          return { columns, rows, truncated: true };
        }
        matchIndex += 1;
        if (step.all === false) break;
        if (match[0] === '') regex.lastIndex += 1;
      }
    }
  }

  return {
    columns,
    rows,
    truncated: false
  };
}

function baaErrorItem(code, message, level = 'error') {
  return {
    level,
    code,
    message: truncateText(message || code, 1000)
  };
}

function baaEnvelope({ success, status, title = '', message = '', tables = [], items = [], data = {} }) {
  const rows = (Array.isArray(tables) ? tables : []).reduce((count, table) => count + (Array.isArray(table.rows) ? table.rows.length : 0), 0);
  return {
    success: Boolean(success),
    status: status || (success ? 'completed' : 'error'),
    title: truncateText(title || '', 250),
    message: truncateText(message || '', 2000),
    summary: { rows },
    tables: Array.isArray(tables) ? tables : [],
    items: Array.isArray(items) ? items : [],
    data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  };
}

function normalizeBaaObjectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function normalizeBaaContractFieldServer(field) {
  field = field && typeof field === 'object' && !Array.isArray(field) ? field : {};
  return {
    name: String(field.name || field.field || '').trim(),
    type: String(field.type || 'string').trim() || 'string',
    required: Boolean(field.required),
    default: field.default !== undefined ? field.default : field.defaultValue,
    example: field.example,
    description: String(field.description || '').trim()
  };
}

function normalizeBaaContractServer(spec) {
  const contract = spec && spec.baaContract && typeof spec.baaContract === 'object' && !Array.isArray(spec.baaContract) ? spec.baaContract : {};
  const objects = baaContractObjectsFromRaw(contract);
  const variables = Array.isArray(contract.contractParams)
    ? contract.contractParams
    : (Array.isArray(contract.variables) ? contract.variables : []);
  return {
    code: String(contract.code || '').trim(),
    version: String(contract.version || '').trim(),
    variables: variables.map(normalizeBaaContractFieldServer).filter((field) => field.name),
    contractParams: variables.map(normalizeBaaContractFieldServer).filter((field) => field.name),
    objects
  };
}

function baaContractParamsFromRequest(body) {
  return Array.isArray(body && body.contractParams)
    ? body.contractParams.map(normalizeBaaContractFieldServer).filter((field) => field.name)
    : [];
}

function validateBaaTypedValue(value, type) {
  if (value === undefined || value === null || value === '') return true;
  const text = String(value).trim();
  if (type === 'number') return !Number.isNaN(Number(text));
  if (type === 'integer') return /^-?\d+$/.test(text);
  if (type === 'boolean') return typeof value === 'boolean' || ['true', 'false', '1', '0', 'yes', 'no', 'да', 'нет'].includes(text.toLowerCase());
  if (type === 'ipv4') return ipv4ToInt(text) !== null;
  if (type === 'ipv4-cidr') return parseIpv4Network(text) !== null;
  return true;
}

function validateBaaVerificationRequest(body, spec = null) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      errors: [baaErrorItem('INVALID_REQUEST', 'Request body must be an object.')]
    };
  }
  const plan = body.plan && typeof body.plan === 'object' && !Array.isArray(body.plan) ? body.plan : null;
  if (!plan) {
    errors.push(baaErrorItem('INVALID_REQUEST', 'Request body must contain plan object.'));
  } else if (!Array.isArray(plan.objects)) {
    errors.push(baaErrorItem('INVALID_REQUEST', 'plan.objects must be an array.'));
  } else {
    plan.objects.forEach((object, index) => {
      if (!object || typeof object !== 'object' || Array.isArray(object)) {
        errors.push(baaErrorItem('INVALID_REQUEST', `plan.objects[${index}] must be an object.`));
        return;
      }
      if (object.payload !== undefined && (!object.payload || typeof object.payload !== 'object' || Array.isArray(object.payload))) {
        errors.push(baaErrorItem('INVALID_REQUEST', `plan.objects[${index}].payload must be an object when provided.`));
      }
    });
  }
  const endpoint = body.endpoint && typeof body.endpoint === 'object' && !Array.isArray(body.endpoint) ? body.endpoint : {};
  if (endpoint.params !== undefined && (!endpoint.params || typeof endpoint.params !== 'object' || Array.isArray(endpoint.params))) {
    errors.push(baaErrorItem('INVALID_REQUEST', 'endpoint.params must be an object when provided.'));
  }
  if (body.variables !== undefined && (!body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables))) {
    errors.push(baaErrorItem('INVALID_REQUEST', 'variables must be an object when provided.'));
  }
  if (body.contractParams !== undefined && !Array.isArray(body.contractParams)) {
    errors.push(baaErrorItem('INVALID_REQUEST', 'contractParams must be an array when provided.'));
  }
  const contract = normalizeBaaContractServer(spec || {});
  const requestContractParams = baaContractParamsFromRequest(body);
  const contractParamDefinitions = requestContractParams.length ? requestContractParams : contract.contractParams;
  if (contract.objects.length || contractParamDefinitions.length) {
    const endpointParams = endpoint.params && typeof endpoint.params === 'object' && !Array.isArray(endpoint.params) ? endpoint.params : {};
    contractParamDefinitions.forEach((field) => {
      const value = endpointParams[field.name];
      if (field.required && (value === undefined || value === null || value === '')) {
        errors.push(baaErrorItem('CONTRACT_VALIDATION_FAILED', `endpoint.params.${field.name} is required.`));
      } else if (!validateBaaTypedValue(value, field.type)) {
        errors.push(baaErrorItem('CONTRACT_VALIDATION_FAILED', `endpoint.params.${field.name} must be ${field.type}.`));
      }
    });
    const contractObjects = contract.objects;
    const requestObjects = plan && Array.isArray(plan.objects) ? plan.objects : [];
    requestObjects.forEach((object, index) => {
      const payload = normalizeBaaObjectPayload(object && object.payload);
      const className = String(object && object.className || '').trim();
      const kind = String(object && object.kind || '').trim();
      const mappingKey = String(object && object.mappingKey || '').trim();
      const matchedContract = contractObjects.find((item) => {
        return item.alias === kind || item.alias === mappingKey || item.className === className;
      });
      if (!matchedContract) return;
      matchedContract.payload.forEach((field) => {
        const value = payload[field.name];
        if (field.required && (value === undefined || value === null || value === '')) {
          errors.push(baaErrorItem('CONTRACT_VALIDATION_FAILED', `plan.objects[${index}].payload.${field.name} is required.`));
        } else if (!validateBaaTypedValue(value, field.type)) {
          errors.push(baaErrorItem('CONTRACT_VALIDATION_FAILED', `plan.objects[${index}].payload.${field.name} must be ${field.type}.`));
        }
      });
    });
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

function normalizedBaaRequestForCache(body) {
  const plan = body && body.plan && typeof body.plan === 'object' && !Array.isArray(body.plan) ? body.plan : {};
  const endpoint = body && body.endpoint && typeof body.endpoint === 'object' && !Array.isArray(body.endpoint) ? body.endpoint : {};
  const inputContract = body && body.inputContract && typeof body.inputContract === 'object' && !Array.isArray(body.inputContract) ? body.inputContract : {};
  return {
    inputContract: {
      code: inputContract.code || '',
      version: inputContract.version || '',
      checksum: inputContract.checksum || ''
    },
    endpoint: {
      code: endpoint.code || '',
      params: endpoint.params && typeof endpoint.params === 'object' && !Array.isArray(endpoint.params) ? endpoint.params : {}
    },
    contractParams: baaContractParamsFromRequest(body),
    variables: body && body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : {},
    variableSources: normalizeBaaVariableSources(body && body.variableSources),
    plan: {
      objects: (Array.isArray(plan.objects) ? plan.objects : []).map((object) => ({
        planIndex: object && object.planIndex !== undefined ? object.planIndex : '',
        kind: object && object.kind || '',
        className: object && object.className || '',
        pageShapeKey: object && object.pageShapeKey || '',
        mappingKey: object && object.mappingKey || '',
        relationBindingStatus: object && object.relationBindingStatus || '',
        payload: normalizeBaaObjectPayload(object && object.payload)
      })),
      missingAttributes: Array.isArray(plan.missingAttributes) ? plan.missingAttributes : [],
      skipped: Array.isArray(plan.skipped) ? plan.skipped : []
    }
  };
}

function baaParamsFromRequest(body, spec = null) {
  const endpoint = body && body.endpoint && typeof body.endpoint === 'object' && !Array.isArray(body.endpoint) ? body.endpoint : {};
  const params = endpoint.params && typeof endpoint.params === 'object' && !Array.isArray(endpoint.params) ? { ...endpoint.params } : {};
  const variables = body && body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : {};
  const contract = normalizeBaaContractServer(spec || {});
  const requestContractParams = baaContractParamsFromRequest(body);
  const contractParamDefinitions = requestContractParams.length ? requestContractParams : contract.contractParams;
  for (const field of contractParamDefinitions) {
    if (params[field.name] === undefined && field.default !== undefined && field.default !== '') params[field.name] = field.default;
    if (params[field.name] !== undefined) {
      params[`contractparam.${field.name}`] = params[field.name];
      params[`var.${field.name}`] = params[field.name];
    }
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) params[key] = value;
    params[`var.${key}`] = value;
  }
  return params;
}

function addBaaColumn(columns, column) {
  if (column && !columns.includes(column)) columns.push(column);
}

function baaContractAliasesForObject(object, contract) {
  const result = [];
  const payload = normalizeBaaObjectPayload(object && object.payload);
  const className = String(object && object.className || '').trim();
  const kind = String(object && object.kind || '').trim();
  const mappingKey = String(object && object.mappingKey || '').trim();
  (contract && Array.isArray(contract.objects) ? contract.objects : []).forEach((item) => {
    if (!item) return;
    if (item.alias && (item.alias === kind || item.alias === mappingKey)) result.push(item.alias);
    else if (item.className && item.className === className) result.push(item.alias || item.className);
  });
  if (!result.length) {
    if (kind) result.push(kind);
    if (className) result.push(className);
  }
  return Array.from(new Set(result.filter(Boolean))).filter((alias) => Object.keys(payload).length || alias);
}

function baaObjectMatchesSourceAlias(object, sourceAlias, contract) {
  const alias = String(sourceAlias || '').trim();
  if (!alias) return true;
  const aliases = baaContractAliasesForObject(object, contract);
  const className = String(object && object.className || '').trim();
  const kind = String(object && object.kind || '').trim();
  const mappingKey = String(object && object.mappingKey || '').trim();
  return aliases.includes(alias) || className === alias || kind === alias || mappingKey === alias;
}

function normalizeObjectGroupFilterOperator(filter) {
  const raw = String(filter && filter.op || (filter && filter.regex !== undefined ? 'matches' : 'equals')).trim();
  if (raw === 'regexMatch') return 'matches';
  if (raw === 'notMatches') return 'matches';
  if (raw === 'notEquals') return 'equals';
  if (raw === 'notExists') return 'exists';
  return raw || 'matches';
}

function normalizeObjectGroupFilterNegate(filter) {
  const raw = String(filter && filter.op || '').trim();
  if (raw === 'notMatches' || raw === 'notEquals' || raw === 'notExists') return true;
  if (filter && filter.negate === true) return true;
  const text = String(filter && (filter.negate !== undefined ? filter.negate : filter.not) || '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === '!';
}

function isIpv4NetworkValue(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (!/[\/\-\s]/.test(text)) return false;
  return parseIpv4Network(text) !== null;
}

function baaRowMatchesSelectionFilter(row, filter, params) {
  const path = filter && (filter.path || filter.attribute || filter.column || filter.field);
  if (!path || typeof path !== 'string') {
    throw new Error('baaPlanObjects filter requires path.');
  }
  const op = normalizeObjectGroupFilterOperator(filter);
  const negate = normalizeObjectGroupFilterNegate(filter);
  const caseSensitive = Boolean(filter.caseSensitive);
  const actual = displayCardValue(row[path]);
  let matched = false;
  if (op === 'exists') matched = actual !== '';
  else if (op === 'isIpv4') matched = parseIpv4ToInt(actual) !== null;
  else if (op === 'isIpv4Network') matched = isIpv4NetworkValue(actual);
  else if (op === 'matches') {
    const pattern = substituteRegexParams(filter.regex, params);
    assertRegexPatternAllowed(pattern, '', 'baaPlanObjects.filter.regex', false);
    const regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    matched = regex.test(assertRegexInputAllowed(actual, 'baaPlanObjects filter value'));
  } else {
    const expectedRaw = resolveSelectionExpected(filter, params, row);
    if (['ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains'].includes(op)) {
      matched = ipv4ValueMatches(actual, displayCardValue(expectedRaw), op);
    } else {
      const expected = normalizeSelectionExpected(expectedRaw, caseSensitive);
      const expectedValues = Array.isArray(expected) ? expected : [expected];
      const actualValue = normalizeFilterValue(actual, caseSensitive);
      if (op === 'equals') matched = expectedValues.includes(actualValue);
      else if (op === 'contains') matched = actualValue.includes(expectedValues.join(','));
      else if (op === 'startsWith') matched = actualValue.startsWith(expectedValues[0] || '');
      else if (op === 'endsWith') matched = actualValue.endsWith(expectedValues[0] || '');
      else if (op === 'in') matched = expectedValues.includes(actualValue);
      else throw new Error(`Unsupported baaPlanObjects operator: ${op}`);
    }
  }
  return negate ? !matched : matched;
}

function baaRowPassesSelectionFilters(row, filters, params) {
  const normalized = Array.isArray(filters) ? filters : [];
  const regularFilters = normalized.filter((filter) => !filter.scope);
  const includeFilters = normalized.filter((filter) => filter.scope === 'include');
  const excludeFilters = normalized.filter((filter) => filter.scope === 'exclude');

  for (const filter of regularFilters) {
    if (!baaRowMatchesSelectionFilter(row, filter, params)) return false;
  }
  if (includeFilters.length) {
    let included = false;
    for (const filter of includeFilters) {
      if (baaRowMatchesSelectionFilter(row, filter, params)) {
        included = true;
        break;
      }
    }
    if (!included) return false;
  }
  for (const filter of excludeFilters) {
    if (baaRowMatchesSelectionFilter(row, filter, params)) return false;
  }
  return true;
}

function executeBaaPlanObjects(step, baaRequest, limits, contract = null, params = {}) {
  const plan = baaRequest && baaRequest.plan && typeof baaRequest.plan === 'object' && !Array.isArray(baaRequest.plan) ? baaRequest.plan : {};
  const objects = Array.isArray(plan.objects) ? plan.objects : [];
  const normalizedContract = normalizeBaaContractServer({ baaContract: contract || {} });
  const columns = ['PlanIndex', 'Kind', 'ClassName', 'PageShapeKey', 'MappingKey', 'RelationBindingStatus'];
  const payloadPrefix = step.payloadPrefix === undefined ? 'Payload.' : String(step.payloadPrefix);
  const sourceAlias = step.objectAlias || step.baaObjectAlias || step.kind || '';
  normalizedContract.objects.forEach((object) => {
    const aliases = [object.alias, object.className].filter(Boolean);
    object.payload.forEach((field) => {
      addBaaColumn(columns, `${payloadPrefix}${field.name}`);
      aliases.forEach((alias) => addBaaColumn(columns, `BAA.${alias}.${field.name}`));
    });
  });
  const rows = [];
  for (const [index, object] of objects.entries()) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    if (!baaObjectMatchesSourceAlias(object, sourceAlias, normalizedContract)) continue;
    const row = {
      PlanIndex: object.planIndex === undefined || object.planIndex === null ? index : object.planIndex,
      Kind: displayCardValue(object.kind || ''),
      ClassName: displayCardValue(object.className || ''),
      PageShapeKey: displayCardValue(object.pageShapeKey || ''),
      MappingKey: displayCardValue(object.mappingKey || ''),
      RelationBindingStatus: displayCardValue(object.relationBindingStatus || '')
    };
    const payload = normalizeBaaObjectPayload(object.payload);
    const aliases = baaContractAliasesForObject(object, normalizedContract);
    Object.keys(payload).sort().forEach((key) => {
      const column = `${payloadPrefix}${key}`;
      row[column] = displayCardValue(payload[key]);
      addBaaColumn(columns, column);
      aliases.forEach((alias) => {
        const aliasColumn = `BAA.${alias}.${key}`;
        row[aliasColumn] = displayCardValue(payload[key]);
        addBaaColumn(columns, aliasColumn);
      });
      if (object.className) {
        const classColumn = `BAA.${object.className}.${key}`;
        row[classColumn] = displayCardValue(payload[key]);
        addBaaColumn(columns, classColumn);
      }
    });
    if (!baaRowPassesSelectionFilters(row, step.filters || step.where || [], params)) continue;
    rows.push(row);
    if (rows.length >= limits.maxRows) {
      return { columns, rows, truncated: true };
    }
  }
  return { columns, rows, truncated: false };
}

function resolveSelectionDriverRows(step, context, limits) {
  if (!step.from) return [{ __index: 0, __source: '' }];
  const source = context[step.from];
  if (!source) {
    throw new Error(`selectCards source not found: ${step.from}`);
  }
  const rows = Array.isArray(source.rows) ? source.rows.slice(0, limits.maxRows) : [];
  return rows.map((row, index) => ({
    ...(row && typeof row === 'object' ? row : {}),
    __index: index,
    __source: step.from
  }));
}

function resolveSelectionClassName(step, params, driverRow) {
  const value = step.className !== undefined && step.className !== ''
    ? step.className
    : step.classNameParam
      ? params[step.classNameParam]
      : step.classColumn
        ? driverRow[step.classColumn]
        : '';
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveSelectionExpected(filter, params, driverRow) {
  if (Object.prototype.hasOwnProperty.call(filter, 'valueColumn')) {
    return driverRow[filter.valueColumn];
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'sourceColumn')) {
    return driverRow[filter.sourceColumn];
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'fromColumn')) {
    return driverRow[filter.fromColumn];
  }
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

function displayCardValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value.map(displayCardValue).filter((item) => item !== '').join(', ');
  }
  if (typeof value === 'object') {
    const preferred = value._description_translation || value._description || value.description || value.Description ||
      value.name || value.Code || value.code || value._id;
    if (preferred !== undefined && preferred !== null) return String(preferred);
    return truncateText(JSON.stringify(value), 1000);
  }
  return String(value);
}

function addUniqueDisplayValue(target, value) {
  const text = displayCardValue(value);
  if (!text || target.includes(text)) return;
  target.push(text);
}

function cardAttributeDisplayValues(card, field) {
  if (!card || !Object.prototype.hasOwnProperty.call(card, field)) return [];
  const values = [];
  addUniqueDisplayValue(values, card[`_${field}_description_translation`]);
  addUniqueDisplayValue(values, card[`_${field}_description`]);
  addUniqueDisplayValue(values, card[`_${field}_code`]);
  if (!values.length) addUniqueDisplayValue(values, card[field]);
  return values;
}

function cardAttributeDisplayValue(card, field) {
  const values = cardAttributeDisplayValues(card, field);
  return values.length ? values[0] : '';
}

function uniqueDisplayValues(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = displayCardValue(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizePathColumnSpecs(value) {
  const source = Array.isArray(value) ? value : normalizeStringList(value);
  const columns = [];
  const seen = new Set();
  for (const item of source) {
    let path = '';
    let alias = '';
    let multiMode = 'join';
    let separator = ', ';
    let emptyRow = true;
    if (typeof item === 'string') {
      path = item.trim();
      alias = path;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      path = String(item.path || item.field || item.column || item.name || '').trim();
      alias = String(item.as || item.name || item.label || path).trim();
      multiMode = item.multiMode || item.displayMode || item.mode || 'join';
      separator = item.separator === undefined || item.separator === null ? ', ' : String(item.separator);
      emptyRow = item.emptyRow !== false && item.keepEmpty !== false;
    }
    if (!path || !alias || seen.has(alias)) continue;
    seen.add(alias);
    columns.push({
      path,
      as: alias,
      multiMode: multiMode === 'rows' ? 'rows' : 'join',
      separator,
      emptyRow
    });
  }
  return columns;
}

async function resolveRowPathColumnValues(cmdbuildExecRequest, pathCache, row, className, card, column) {
  if (Object.prototype.hasOwnProperty.call(row, column.path)) {
    return uniqueDisplayValues(Array.isArray(row[column.path]) ? row[column.path] : [row[column.path]]);
  }
  if (Object.prototype.hasOwnProperty.call(row, column.as) && row[column.as] !== undefined && row[column.as] !== null && row[column.as] !== '') {
    return uniqueDisplayValues(Array.isArray(row[column.as]) ? row[column.as] : [row[column.as]]);
  }
  if (column.path === 'Class') return uniqueDisplayValues([className || row.Class || '']);
  if (column.path === '_id') return uniqueDisplayValues([(card && card._id !== undefined ? card._id : row._id) || '']);
  if (!className || !card) return [];
  return uniqueDisplayValues(await resolveCardPathValues(cmdbuildExecRequest, pathCache, className, card, column.path));
}

async function materializeRowPathColumns(cmdbuildExecRequest, pathCache, row, className, card, columnSpecs, outputColumns) {
  const specs = normalizePathColumnSpecs(columnSpecs);
  if (!specs.length) return row;
  let fullCard = card || null;
  for (const column of specs) {
    if (!fullCard && className && (row._id !== undefined && row._id !== null && row._id !== '')) {
      const info = await readRelatedCard(cmdbuildExecRequest, pathCache.cards, className, row._id);
      fullCard = info.card || null;
    }
    const values = await resolveRowPathColumnValues(cmdbuildExecRequest, pathCache, row, className, fullCard, column);
    row[column.as] = values.length ? values.join(column.separator) : '';
    addColumnOnce(outputColumns, column.as);
  }
  return row;
}

function normalizeSelectionExpected(value, caseSensitive) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeFilterValue(displayCardValue(item), caseSensitive));
  }
  const text = displayCardValue(value);
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map((item) => normalizeFilterValue(item.trim(), caseSensitive)).filter(Boolean);
  }
  return normalizeFilterValue(text, caseSensitive);
}

function substituteRegexParams(pattern, params) {
  return String(pattern || '').replace(/\$\{(param|var)\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, scope, name) => {
    if (scope === 'var' && params && Object.prototype.hasOwnProperty.call(params, `var.${name}`)) return String(params[`var.${name}`]);
    return params && params[name] !== undefined && params[name] !== null ? String(params[name]) : '';
  }).replace(/\$\{contractparam\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (params && Object.prototype.hasOwnProperty.call(params, `contractparam.${name}`)) return String(params[`contractparam.${name}`]);
    return params && params[name] !== undefined && params[name] !== null ? String(params[name]) : '';
  });
}

async function getPathClassAttributes(cmdbuildExecRequest, pathCache, className) {
  const key = String(className || '').toLowerCase();
  if (pathCache.attributes.has(key)) return pathCache.attributes.get(key);
  const response = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/attributes`);
  const attributes = response.ok && Array.isArray(response.json && response.json.data)
    ? response.json.data.map(sanitizeAttribute).filter(Boolean)
    : [];
  pathCache.attributes.set(key, attributes);
  return attributes;
}

function referenceValueId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    return String(value._id || value.id || value.Id || value._id_value || value.value || '').trim();
  }
  return String(value).trim();
}

async function readRelationsForPath(cmdbuildExecRequest, pathCache, className, id) {
  const key = `${className}:${id}`;
  if (pathCache.relations.has(key)) return pathCache.relations.get(key);
  const response = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/cards/${encodeURIComponent(id)}/relations?limit=100`);
  const relations = response.ok && Array.isArray(response.json && response.json.data) ? response.json.data : [];
  pathCache.relations.set(key, relations);
  return relations;
}

async function resolveCardPathValues(cmdbuildExecRequest, pathCache, className, card, path) {
  const text = String(path || '').trim();
  if (!text) return [];

  const domainMatch = text.match(/^\{([^:}]+):([^}]+)\}(?:\.(.*))?$/);
  if (domainMatch) {
    const domainName = domainMatch[1];
    const targetClass = domainMatch[2];
    const rest = domainMatch[3] || 'Code';
    const sourceId = card && card._id !== undefined && card._id !== null ? String(card._id) : '';
    if (!sourceId) return [];
    const relations = await readRelationsForPath(cmdbuildExecRequest, pathCache, className, sourceId);
    const values = [];
    for (const relation of relations) {
      if (relationDomainName(relation).toLowerCase() !== domainName.toLowerCase()) continue;
      const chosen = chooseRelatedEndpoint(relation, className, sourceId, 'both');
      if (!chosen || !chosen.relatedEndpoint.className || !chosen.relatedEndpoint.id) continue;
      if (chosen.relatedEndpoint.className.toLowerCase() !== targetClass.toLowerCase()) continue;
      const related = await readRelatedCard(cmdbuildExecRequest, pathCache.cards, chosen.relatedEndpoint.className, chosen.relatedEndpoint.id);
      if (related.card) {
        values.push.apply(values, await resolveCardPathValues(cmdbuildExecRequest, pathCache, chosen.relatedEndpoint.className, related.card, rest));
      } else {
        values.push(displayCardValue(chosen.relatedEndpoint.code || chosen.relatedEndpoint.description || chosen.relatedEndpoint.id));
      }
    }
    return values.filter((value) => value !== '');
  }

  const dotIndex = text.indexOf('.');
  if (dotIndex !== -1) {
    const head = text.slice(0, dotIndex);
    const rest = text.slice(dotIndex + 1);
    const attributes = await getPathClassAttributes(cmdbuildExecRequest, pathCache, className);
    const attribute = attributes.find((item) => item && item.name === head) || {};
    const targetClass = attribute.targetClass || attribute.targetType || '';
    const value = card ? card[head] : undefined;
    const id = referenceValueId(value);
    if (!targetClass || !id) return [];
    const related = await readRelatedCard(cmdbuildExecRequest, pathCache.cards, targetClass, id);
    if (!related.card) return [];
    return resolveCardPathValues(cmdbuildExecRequest, pathCache, targetClass, related.card, rest);
  }

  if (text === 'Class') return [className];
  if (card && Object.prototype.hasOwnProperty.call(card, text)) return cardAttributeDisplayValues(card, text);
  return [];
}

async function cardMatchesSelectionFilter(cmdbuildExecRequest, pathCache, className, card, filter, params, driverRow) {
  const attribute = filter.attribute || filter.column || filter.field;
  const path = filter.path || attribute;
  if (!path || typeof path !== 'string') {
    throw new Error('selectCards filter requires attribute or path.');
  }

  const op = normalizeObjectGroupFilterOperator(filter);
  const negate = normalizeObjectGroupFilterNegate(filter);
  const caseSensitive = Boolean(filter.caseSensitive);
  const pathValues = filter.path
    ? await resolveCardPathValues(cmdbuildExecRequest, pathCache, className, card, path)
    : null;
  const actualRaw = pathValues ? pathValues.join(', ') : card[attribute];
  const actualValues = (pathValues || [actualRaw])
    .map((value) => normalizeFilterValue(displayCardValue(value), caseSensitive))
    .filter((value) => value !== '');

  let matched = false;
  if (op === 'matches') {
    const pattern = substituteRegexParams(filter.regex, params);
    assertRegexPatternAllowed(pattern, '', 'selectCards.filter.regex', false);
    const regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    const values = pathValues || [displayCardValue(actualRaw)];
    matched = values.some((value) => regex.test(assertRegexInputAllowed(value, 'selectCards filter value')));
  } else if (op === 'exists') {
    matched = actualValues.length > 0;
  } else if (op === 'isIpv4') {
    matched = (pathValues || [actualRaw]).some((value) => parseIpv4ToInt(displayCardValue(value)) !== null);
  } else if (op === 'isIpv4Network') {
    matched = (pathValues || [actualRaw]).some((value) => isIpv4NetworkValue(displayCardValue(value)));
  } else {
    const expectedRaw = resolveSelectionExpected(filter, params, driverRow);
    if (['ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains'].includes(op)) {
      matched = (pathValues || [actualRaw]).some((value) => ipv4ValueMatches(displayCardValue(value), displayCardValue(expectedRaw), op));
    } else {
      const expected = normalizeSelectionExpected(expectedRaw, caseSensitive);
      const expectedValues = Array.isArray(expected) ? expected : [expected];
      const hasEqual = actualValues.some((value) => expectedValues.includes(value));
      if (op === 'equals') matched = hasEqual;
      else if (op === 'contains') matched = actualValues.some((value) => value.includes(expectedValues.join(',')));
      else if (op === 'startsWith') matched = actualValues.some((value) => value.startsWith(expectedValues[0] || ''));
      else if (op === 'endsWith') matched = actualValues.some((value) => value.endsWith(expectedValues[0] || ''));
      else if (op === 'in') matched = hasEqual;
      else throw new Error(`Unsupported selectCards operator: ${op}`);
    }
  }
  return negate ? !matched : matched;
}

async function cardPassesSelectionFilters(cmdbuildExecRequest, pathCache, className, card, filters, params, driverRow) {
  const regularFilters = filters.filter((filter) => !filter.scope);
  const includeFilters = filters.filter((filter) => filter.scope === 'include');
  const excludeFilters = filters.filter((filter) => filter.scope === 'exclude');

  for (const filter of regularFilters) {
    if (!await cardMatchesSelectionFilter(cmdbuildExecRequest, pathCache, className, card, filter, params, driverRow)) return false;
  }

  if (includeFilters.length) {
    let included = false;
    for (const filter of includeFilters) {
      if (await cardMatchesSelectionFilter(cmdbuildExecRequest, pathCache, className, card, filter, params, driverRow)) {
        included = true;
        break;
      }
    }
    if (!included) return false;
  }

  for (const filter of excludeFilters) {
    if (await cardMatchesSelectionFilter(cmdbuildExecRequest, pathCache, className, card, filter, params, driverRow)) return false;
  }

  return true;
}

function addColumnOnce(columns, column) {
  if (column && !columns.includes(column)) columns.push(column);
}

function buildSelectionResultRow(className, card, driverRow, columns, step) {
  const row = {
    Class: className,
    _id: card._id === undefined ? null : card._id,
    Code: card.Code || '',
    Description: card.Description || card._description || ''
  };
  addColumnOnce(columns, 'Class');
  addColumnOnce(columns, '_id');
  addColumnOnce(columns, 'Code');
  addColumnOnce(columns, 'Description');

  const includeSource = step.includeSource !== false && driverRow && driverRow.__source;
  const sourcePrefix = step.sourcePrefix === undefined ? 'Source_' : String(step.sourcePrefix);
  if (includeSource) {
    for (const [key, value] of Object.entries(driverRow)) {
      if (key.startsWith('__')) continue;
      const column = `${sourcePrefix}${key}`;
      row[column] = displayCardValue(value);
      addColumnOnce(columns, column);
    }
  }

  return row;
}

function cardListPath(className, limit, fields) {
  const query = new URLSearchParams();
  query.set('limit', String(limit));
  const attributes = uniqueStrings((fields || [])
    .map(directCardFieldFromPath)
    .filter((field) => field && !CARD_BUILTIN_FIELDS.has(field)));
  if (attributes.length) query.set('attributes', attributes.join(','));
  return `/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/cards?${query.toString()}`;
}

async function requestCardsForSelection(cmdbuildExecRequest, className, limit, fields) {
  const response = await cmdbuildExecRequest(cardListPath(className, limit, fields));
  if (response.ok || !fields || !fields.length || isPermissionDeniedStatus(response.statusCode)) return response;
  return cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/cards?limit=${limit}`);
}

function selectionReadFields(step, requestedColumns) {
  const fields = ['Code', 'Description'];
  addFilterDependencyFields(fields, step.filters || step.where);
  for (const column of requestedColumns || []) addColumnDependency(fields, column.path);
  return uniqueStrings(fields.map(directCardFieldFromPath).filter(Boolean));
}

async function executeSelectCards(cmdbuildExecRequest, step, params, context, limits, dependencyMap) {
  const driverRows = resolveSelectionDriverRows(step, context, limits);
  const maxRows = toPositiveInt(step.limit, limits.maxRows, limits.maxRows);
  const filters = Array.isArray(step.filters || step.where) ? (step.filters || step.where) : [];
  const dependency = dependencyMap && Array.isArray(dependencyMap.selections)
    ? dependencyMap.selections.find((item) => item && item.as === step.as)
    : null;
  const requestedColumns = normalizePathColumnSpecs([]
    .concat(step.columns || step.cardColumns || step.outputColumns || [])
    .concat((dependency && dependency.fields || []).map((field) => ({ path: field, as: field }))));
  const readFields = selectionReadFields(step, requestedColumns);
  const columns = [];
  const rows = [];
  const cardsByClass = new Map();
  const classesCache = { loaded: false, classes: [], ok: false };
  const resolvedClassCache = new Map();
  const pathCache = { attributes: new Map(), cards: new Map(), relations: new Map() };

  for (const driverRow of driverRows) {
    const requestedClassName = resolveSelectionClassName(step, params, driverRow);
    if (!requestedClassName) {
      if (step.classColumn) continue;
      throw new Error('selectCards class source resolved to an empty value.');
    }
    validateCmdbuildIdentifier(requestedClassName, 'selectCards className');
    const targetClassNames = await resolveExecutionClassNames(cmdbuildExecRequest, limits, requestedClassName, classesCache, resolvedClassCache);

    for (const className of targetClassNames) {
      validateCmdbuildIdentifier(className, 'selectCards className');
      if (!cardsByClass.has(className)) {
        const cards = await requestCardsForSelection(cmdbuildExecRequest, className, maxRows, readFields);
        if (!cards.ok) {
          throw new Error(`CMDBuild cards request for ${className} failed with status ${cards.statusCode}.`);
        }
        cardsByClass.set(className, Array.isArray(cards.json && cards.json.data) ? cards.json.data : []);
      }

      for (const card of cardsByClass.get(className)) {
        if (!await cardPassesSelectionFilters(cmdbuildExecRequest, pathCache, className, card, filters, params, driverRow)) continue;
        const row = buildSelectionResultRow(className, card, driverRow, columns, step);
        await materializeRowPathColumns(cmdbuildExecRequest, pathCache, row, className, card, requestedColumns, columns);
        rows.push(row);
        if (rows.length >= maxRows) {
          return {
            columns,
            rows,
            truncated: true
          };
        }
      }
    }
  }

  return {
    columns,
    rows,
    truncated: false
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item === undefined || item === null ? '' : item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (value === undefined || value === null) return [];
  return [String(value).trim()].filter(Boolean);
}

function readStepOrParam(step, params, key, paramKey) {
  if (Object.prototype.hasOwnProperty.call(step, key)) return step[key];
  const parameterName = step[paramKey];
  return parameterName ? params[parameterName] : undefined;
}

function resolveRelationDriverRows(step, context, limits) {
  const source = context[step.from];
  if (!source) {
    throw new Error(`expandRelations source not found: ${step.from}`);
  }
  const rows = Array.isArray(source.rows) ? source.rows.slice(0, limits.maxRows) : [];
  return rows.map((row, index) => ({
    ...(row && typeof row === 'object' ? row : {}),
    __index: index,
    __source: step.from
  }));
}

function resolveRelationSourceClass(step, params, row) {
  const configured = readStepOrParam(step, params, 'sourceClass', 'sourceClassParam');
  const column = step.sourceClassColumn || step.classColumn || 'Class';
  const value = configured !== undefined && configured !== '' ? configured : row[column] || row._type;
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveRelationSourceId(step, params, row) {
  const configured = readStepOrParam(step, params, 'sourceId', 'sourceIdParam');
  const column = step.sourceIdColumn || step.idColumn || '_id';
  const value = configured !== undefined && configured !== '' ? configured : row[column];
  return value === undefined || value === null ? '' : String(value).trim();
}

function relationValue(relation, keys) {
  for (const key of keys) {
    if (relation && relation[key] !== undefined && relation[key] !== null && relation[key] !== '') return relation[key];
  }
  return '';
}

function relationDomainName(relation) {
  return String(relationValue(relation, ['domain', 'Domain', 'domainCode', 'DomainCode', '_domain', '_type']) || '').trim();
}

function relationSourceEndpoint(relation) {
  return {
    className: String(relationValue(relation, ['_sourceType', 'sourceType', 'SourceType', 'sourceClass', 'sourceClassName', 'sourceClassCode']) || '').trim(),
    id: String(relationValue(relation, ['_sourceId', 'sourceId', 'SourceId', 'sourceCardId', 'sourceCard']) || '').trim(),
    code: relationValue(relation, ['_sourceCode', 'sourceCode', 'SourceCode']),
    description: relationValue(relation, ['_sourceDescription', 'sourceDescription', 'SourceDescription'])
  };
}

function relationDestinationEndpoint(relation) {
  return {
    className: String(relationValue(relation, ['_destinationType', 'destinationType', 'DestinationType', 'targetType', 'targetClass', 'destinationClass', 'destinationClassName', 'destinationClassCode']) || '').trim(),
    id: String(relationValue(relation, ['_destinationId', 'destinationId', 'DestinationId', 'targetId', 'destinationCardId', 'destinationCard']) || '').trim(),
    code: relationValue(relation, ['_destinationCode', 'destinationCode', 'DestinationCode', 'targetCode']),
    description: relationValue(relation, ['_destinationDescription', 'destinationDescription', 'DestinationDescription', 'targetDescription'])
  };
}

function sameRelationEndpoint(endpoint, className, id) {
  return String(endpoint.className || '').toLowerCase() === String(className || '').toLowerCase() &&
    String(endpoint.id || '') === String(id || '');
}

function relationDirection(relation) {
  const value = String(relationValue(relation, ['_direction', 'direction', 'Direction']) || '').trim();
  if (value) return value;
  if (relation && relation._is_direct === true) return 'direct';
  if (relation && relation._is_direct === false) return 'inverse';
  return '';
}

function relationMatchesDirection(relation, sourceEndpointMatches, destinationEndpointMatches, requestedDirection) {
  const direction = requestedDirection || 'both';
  if (direction === 'both') return true;
  if (direction === 'direct' || direction === 'inverse') {
    const actual = relationDirection(relation).toLowerCase();
    if (actual) return actual === direction;
    if (direction === 'direct') return relation && relation._is_direct === true;
    return relation && relation._is_direct === false;
  }
  if (direction === 'source') return sourceEndpointMatches;
  if (direction === 'destination') return destinationEndpointMatches;
  return false;
}

function chooseRelatedEndpoint(relation, sourceClass, sourceId, requestedDirection) {
  const source = relationSourceEndpoint(relation);
  const destination = relationDestinationEndpoint(relation);
  const sourceMatches = sameRelationEndpoint(source, sourceClass, sourceId);
  const destinationMatches = sameRelationEndpoint(destination, sourceClass, sourceId);

  if (!relationMatchesDirection(relation, sourceMatches, destinationMatches, requestedDirection)) return null;
  if (sourceMatches) {
    return {
      sourceEndpoint: source,
      relatedEndpoint: destination,
      sourceSide: 'source'
    };
  }
  if (destinationMatches) {
    return {
      sourceEndpoint: destination,
      relatedEndpoint: source,
      sourceSide: 'destination'
    };
  }

  return {
    sourceEndpoint: {
      className: sourceClass,
      id: sourceId,
      code: '',
      description: ''
    },
    relatedEndpoint: destination.className && destination.id ? destination : source,
    sourceSide: 'unknown'
  };
}

function cardFieldValue(card, field, fallback) {
  if (card && Object.prototype.hasOwnProperty.call(card, field)) return cardAttributeDisplayValue(card, field);
  if (fallback !== undefined && fallback !== null) return displayCardValue(fallback);
  return '';
}

async function readRelatedCard(cmdbuildExecRequest, cache, className, id) {
  if (!className || !id) return { card: null, statusCode: 0 };
  const key = `${className}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const response = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}/cards/${encodeURIComponent(id)}`);
  const value = {
    card: response.ok && response.json && response.json.data && typeof response.json.data === 'object' ? response.json.data : null,
    statusCode: response.statusCode
  };
  cache.set(key, value);
  return value;
}

async function buildRelationResultRow(cmdbuildExecRequest, pathCache, driverRow, relation, sourceClass, sourceId, sourceSide, relatedEndpoint, relatedCardInfo, columns, step) {
  const relatedCard = relatedCardInfo.card || {};
  const domain = relationDomainName(relation);
  const relatedClass = relatedEndpoint.className || relatedCard._type || '';
  const relatedId = relatedEndpoint.id || relatedCard._id || '';
  const relatedCode = cardFieldValue(relatedCard, 'Code', relatedEndpoint.code);
  const relatedDescription = cardFieldValue(relatedCard, 'Description', relatedEndpoint.description || relatedCard._description);
  const row = {
    SourceClass: sourceClass,
    SourceId: sourceId,
    SourceCode: displayCardValue(driverRow.Code),
    SourceDescription: displayCardValue(driverRow.Description),
    Domain: domain,
    RelationId: relation._id === undefined ? '' : relation._id,
    RelationDirection: relationDirection(relation),
    RelationSourceSide: sourceSide,
    RelatedClass: relatedClass,
    RelatedId: relatedId,
    RelatedReadStatus: relatedCardInfo.statusCode || '',
    Class: relatedClass,
    _id: relatedId,
    Code: relatedCode,
    Description: relatedDescription
  };

  [
    'SourceClass',
    'SourceId',
    'SourceCode',
    'SourceDescription',
    'Domain',
    'RelationId',
    'RelationDirection',
    'RelationSourceSide',
    'RelatedClass',
    'RelatedId',
    'RelatedReadStatus',
    'Class',
    '_id',
    'Code',
    'Description'
  ].forEach((column) => addColumnOnce(columns, column));

  const includeSource = step.includeSource !== false;
  const sourcePrefix = step.sourcePrefix === undefined ? 'Source_' : String(step.sourcePrefix);
  if (includeSource) {
    for (const [key, value] of Object.entries(driverRow || {})) {
      if (key.startsWith('__') || ['Class', '_id', 'Code', 'Description'].includes(key)) continue;
      const column = `${sourcePrefix}${key}`;
      row[column] = displayCardValue(value);
      addColumnOnce(columns, column);
    }
  }

  const requestedColumns = normalizeStringList(step.columns || step.relatedColumns);
  if (requestedColumns.length) {
    await materializeRowPathColumns(cmdbuildExecRequest, pathCache, row, relatedClass, relatedCard, requestedColumns, columns);
  } else {
    for (const [key, value] of Object.entries(relatedCard || {})) {
      if (key.startsWith('_') || key === 'Code' || key === 'Description') continue;
      row[key] = cardAttributeDisplayValue(relatedCard, key);
      addColumnOnce(columns, key);
    }
  }

  return row;
}

async function executeExpandRelations(cmdbuildExecRequest, step, params, context, limits) {
  const driverRows = resolveRelationDriverRows(step, context, limits);
  const maxRows = toPositiveInt(step.limit, limits.maxRows, limits.maxRows);
  const perCardLimit = toPositiveInt(step.perCardLimit, maxRows, maxRows);
  const domainFilter = new Set(normalizeStringList(readStepOrParam(step, params, 'domain', 'domainParam')).map((item) => item.toLowerCase()));
  const targetClassNames = normalizeStringList(readStepOrParam(step, params, 'targetClass', 'targetClassParam'));
  const targetClassFilter = new Set();
  if (targetClassNames.length) {
    const classesCache = { loaded: false, classes: [], ok: false };
    const resolvedClassCache = new Map();
    for (const className of targetClassNames) {
      validateCmdbuildIdentifier(className, 'expandRelations targetClass');
      const resolved = await resolveExecutionClassNames(cmdbuildExecRequest, limits, className, classesCache, resolvedClassCache);
      resolved.forEach((item) => targetClassFilter.add(item.toLowerCase()));
    }
  }
  const requestedDirection = step.direction || 'both';
  const fetchRelated = step.fetchRelated !== false;
  const distinct = Boolean(step.distinct);
  const relatedCardCache = new Map();
  const pathCache = { attributes: new Map(), cards: relatedCardCache, relations: new Map() };
  const seen = new Set();
  const columns = [];
  const rows = [];

  for (const driverRow of driverRows) {
    const sourceClass = resolveRelationSourceClass(step, params, driverRow);
    const sourceId = resolveRelationSourceId(step, params, driverRow);
    if (!sourceClass || !sourceId) {
      if (step.skipMissingSource !== false) continue;
      throw new Error('expandRelations source class or id resolved to an empty value.');
    }
    validateCmdbuildIdentifier(sourceClass, 'expandRelations sourceClass');

    const relations = await cmdbuildExecRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(sourceClass)}/cards/${encodeURIComponent(sourceId)}/relations?limit=${perCardLimit}`);
    if (!relations.ok) {
      throw new Error(`CMDBuild relations request for ${sourceClass}/${sourceId} failed with status ${relations.statusCode}.`);
    }

    const relationItems = Array.isArray(relations.json && relations.json.data) ? relations.json.data : [];
    for (const relation of relationItems) {
      const domain = relationDomainName(relation);
      if (domainFilter.size && !domainFilter.has(domain.toLowerCase())) continue;

      const chosen = chooseRelatedEndpoint(relation, sourceClass, sourceId, requestedDirection);
      if (!chosen || !chosen.relatedEndpoint.className || !chosen.relatedEndpoint.id) continue;
      const relatedClass = chosen.relatedEndpoint.className;
      if (targetClassFilter.size && !targetClassFilter.has(relatedClass.toLowerCase())) continue;
      validateCmdbuildIdentifier(relatedClass, 'expandRelations related class');

      const distinctKey = `${sourceClass}:${sourceId}:${domain}:${relatedClass}:${chosen.relatedEndpoint.id}`;
      if (distinct && seen.has(distinctKey)) continue;
      seen.add(distinctKey);

      const relatedCardInfo = fetchRelated
        ? await readRelatedCard(cmdbuildExecRequest, relatedCardCache, relatedClass, chosen.relatedEndpoint.id)
        : { card: null, statusCode: '' };
      rows.push(await buildRelationResultRow(cmdbuildExecRequest, pathCache, driverRow, relation, sourceClass, sourceId, chosen.sourceSide, chosen.relatedEndpoint, relatedCardInfo, columns, step));
      if (rows.length >= maxRows) {
        return {
          columns,
          rows,
          truncated: true
        };
      }
    }
  }

  return {
    columns,
    rows,
    truncated: false
  };
}

async function executeEnrichRows(cmdbuildExecRequest, step, params, context, limits) {
  const source = context[step.from];
  if (!source) {
    throw new Error(`enrichRows source not found: ${step.from}`);
  }
  const sourceRows = Array.isArray(source.rows) ? source.rows.slice(0, limits.maxRows) : [];
  const columns = inferColumns(source).slice();
  const enrichColumns = normalizePathColumnSpecs(step.columns || step.fields);
  const classColumn = step.classColumn || 'Class';
  const idColumn = step.idColumn || '_id';
  const pathCache = { attributes: new Map(), cards: new Map(), relations: new Map() };
  const rows = [];
  let truncated = Boolean(source.truncated) || (Array.isArray(source.rows) && source.rows.length > sourceRows.length);

  for (const sourceRow of sourceRows) {
    const row = { ...(sourceRow && typeof sourceRow === 'object' ? sourceRow : {}) };
    const className = String(row[classColumn] || row.RelatedClass || '').trim();
    const id = row[idColumn] !== undefined && row[idColumn] !== null && row[idColumn] !== ''
      ? row[idColumn]
      : row.RelatedId;
    let card = null;
    if (className && id !== undefined && id !== null && id !== '') {
      const related = await readRelatedCard(cmdbuildExecRequest, pathCache.cards, className, id);
      card = related.card || null;
      if (card && row._id === undefined) row._id = card._id;
    }
    let variants = [row];
    for (const column of enrichColumns) {
      addColumnOnce(columns, column.as);
      const values = await resolveRowPathColumnValues(cmdbuildExecRequest, pathCache, row, className, card, column);
      if (!values.length && column.emptyRow === false) {
        variants = [];
        break;
      }
      const effectiveValues = values.length ? values : [''];
      if (column.multiMode === 'rows') {
        const expanded = [];
        for (const variant of variants) {
          for (const value of effectiveValues) {
            expanded.push({
              ...variant,
              [column.as]: value
            });
          }
        }
        variants = expanded;
      } else {
        const joined = effectiveValues.join(column.separator);
        variants = variants.map((variant) => ({
          ...variant,
          [column.as]: joined
        }));
      }
    }
    for (const variant of variants) {
      rows.push(variant);
      if (rows.length >= limits.maxRows) {
        truncated = true;
        return {
          columns,
          rows,
          truncated
        };
      }
    }
  }

  return {
    columns,
    rows,
    truncated
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

function normalizeMatchRowsRule(rule) {
  const left = rule && rule.left && typeof rule.left === 'object' && !Array.isArray(rule.left) ? rule.left : {};
  const right = rule && rule.right && typeof rule.right === 'object' && !Array.isArray(rule.right) ? rule.right : {};
  const rawOperator = rule && (rule.operator || rule.op) || 'equals';
  return {
    action: rule && (rule.action === 'exclude' || rule.scope === 'exclude') ? 'exclude' : 'include',
    negate: normalizeMatchRowsNegate(rule && (rule.negate !== undefined ? rule.negate : rule.not), rawOperator),
    operator: normalizeMatchRowsOperator(rawOperator),
    leftColumn: String(rule && (rule.leftColumn || rule.leftField) || left.column || left.field || left.path || '').trim(),
    leftRegex: String(rule && rule.leftRegex !== undefined ? rule.leftRegex : (left.regex !== undefined ? left.regex : '')).trim(),
    rightColumn: String(rule && (rule.rightColumn || rule.rightField) || right.column || right.field || right.path || '').trim(),
    rightRegex: String(rule && rule.rightRegex !== undefined ? rule.rightRegex : (right.regex !== undefined ? right.regex : '')).trim()
  };
}

function normalizeMatchRowsOperator(value) {
  const operator = String(value || 'equals').trim();
  if (operator === 'notEquals') return 'equals';
  const allowed = ['equals', 'contains', 'regexMatch', 'ipv4InCidr', 'ipv4InRange', 'ipv4CidrOverlaps', 'ipv4CidrContains'];
  return allowed.includes(operator) ? operator : 'equals';
}

function normalizeMatchRowsNegate(value, operator) {
  if (operator === 'notEquals') return true;
  if (value === true) return true;
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === '!';
}

function extractMatchComparableValues(value, pattern, params, caseSensitive) {
  const values = Array.isArray(value) ? value : [value];
  const regexPattern = substituteRegexParams(pattern || '', params);
  const result = [];
  if (regexPattern) assertRegexPatternAllowed(regexPattern, '', 'matchRows.regex', false);
  for (const item of values) {
    const text = assertRegexInputAllowed(displayCardValue(item), 'matchRows value').trim();
    if (!regexPattern) {
      result.push(text);
      continue;
    }
    const regex = new RegExp(regexPattern, caseSensitive ? '' : 'i');
    const match = regex.exec(text);
    if (!match) continue;
    if (match.groups && match.groups.value !== undefined) {
      result.push(displayCardValue(match.groups.value).trim());
    } else if (match.length > 1) {
      result.push(displayCardValue(match[1]).trim());
    } else {
      result.push(displayCardValue(match[0]).trim());
    }
  }
  return result.filter((item) => item !== '');
}

function normalizeComparableValue(value, caseSensitive) {
  const text = displayCardValue(value).trim();
  return caseSensitive ? text : text.toLowerCase();
}

function parseIpv4ToInt(value) {
  const text = String(value || '').trim();
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) return null;
    result = ((result << 8) + number) >>> 0;
  }
  return result >>> 0;
}

function normalizeIpv4Range(start, end) {
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function parseIpv4Network(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const rangeMatch = text.match(/^([0-9.]+)\s*-\s*([0-9.]+)$/);
  if (rangeMatch) {
    return normalizeIpv4Range(parseIpv4ToInt(rangeMatch[1]), parseIpv4ToInt(rangeMatch[2]));
  }

  const cidrMatch = text.match(/^([0-9.]+)\s*\/\s*(\d{1,2})$/);
  if (cidrMatch) {
    const ip = parseIpv4ToInt(cidrMatch[1]);
    const prefix = Number(cidrMatch[2]);
    if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const start = (ip & mask) >>> 0;
    const end = (start | (~mask >>> 0)) >>> 0;
    return { start, end };
  }

  const maskMatch = text.match(/^([0-9.]+)\s+([0-9.]+)$/);
  if (maskMatch) {
    const ip = parseIpv4ToInt(maskMatch[1]);
    const mask = parseIpv4ToInt(maskMatch[2]);
    if (ip === null || mask === null) return null;
    const start = (ip & mask) >>> 0;
    const end = (start | (~mask >>> 0)) >>> 0;
    return { start, end };
  }

  const ip = parseIpv4ToInt(text);
  return ip === null ? null : { start: ip, end: ip };
}

function rangesOverlap(left, right) {
  return Boolean(left && right && left.start <= right.end && right.start <= left.end);
}

function rangeContains(left, right) {
  return Boolean(left && right && left.start <= right.start && left.end >= right.end);
}

function ipv4ValueMatches(leftValue, rightValue, operator) {
  const leftRange = parseIpv4Network(leftValue);
  const rightRange = parseIpv4Network(rightValue);
  if (!leftRange || !rightRange) return false;
  if (operator === 'ipv4InCidr' || operator === 'ipv4InRange') {
    return leftRange.start === leftRange.end && rangeContains(rightRange, leftRange);
  }
  if (operator === 'ipv4CidrOverlaps') return rangesOverlap(leftRange, rightRange);
  if (operator === 'ipv4CidrContains') return rangeContains(leftRange, rightRange);
  return false;
}

function scalarMatchRowsValues(leftValue, rightValue, operator, caseSensitive) {
  if (operator === 'equals') return normalizeComparableValue(leftValue, caseSensitive) === normalizeComparableValue(rightValue, caseSensitive);
  if (operator === 'notEquals') return normalizeComparableValue(leftValue, caseSensitive) !== normalizeComparableValue(rightValue, caseSensitive);
  if (operator === 'contains') return normalizeComparableValue(leftValue, caseSensitive).includes(normalizeComparableValue(rightValue, caseSensitive));
  if (operator === 'regexMatch') {
    try {
      const pattern = String(rightValue || '');
      assertRegexPatternAllowed(pattern, '', 'matchRows.regexMatch', false);
      return new RegExp(pattern, caseSensitive ? '' : 'i').test(assertRegexInputAllowed(leftValue, 'matchRows regexMatch value'));
    } catch {
      return false;
    }
  }
  return ipv4ValueMatches(leftValue, rightValue, operator);
}

function matchRowsRuleMatches(leftRow, rightRow, rule, params, stepCaseSensitive) {
  const caseSensitive = rule.caseSensitive === true || stepCaseSensitive === true;
  const operator = normalizeMatchRowsOperator(rule.operator);
  const leftValues = extractMatchComparableValues(leftRow && leftRow[rule.leftColumn], rule.leftRegex, params, caseSensitive);
  const rightValues = extractMatchComparableValues(rightRow && rightRow[rule.rightColumn], rule.rightRegex, params, caseSensitive);
  if (!leftValues.length || !rightValues.length) return false;
  const matched = leftValues.some((leftValue) => rightValues.some((rightValue) => scalarMatchRowsValues(leftValue, rightValue, operator, caseSensitive)));
  return rule.negate ? !matched : matched;
}

function buildMatchRowsColumnMapping(leftColumns, rightColumns, step) {
  const rightPrefix = step.rightPrefix === undefined ? `${step.with}_` : String(step.rightPrefix || `${step.with}_`);
  const columns = leftColumns.slice();
  const mapping = [];
  for (const column of rightColumns) {
    let target = `${rightPrefix}${column}`;
    let suffix = 2;
    while (columns.includes(target)) {
      target = `${rightPrefix}${column}_${suffix}`;
      suffix += 1;
    }
    mapping.push({ source: column, target });
    columns.push(target);
  }
  return { columns, mapping };
}

function mergeMatchRows(leftRow, rightRow, leftColumns, rightMapping) {
  const row = {};
  for (const column of leftColumns) {
    row[column] = leftRow && leftRow[column] !== undefined ? leftRow[column] : null;
  }
  for (const item of rightMapping) {
    row[item.target] = rightRow && rightRow[item.source] !== undefined ? rightRow[item.source] : null;
  }
  return row;
}

function executeMatchRows(step, params, context, limits) {
  const left = context[step.from];
  const right = context[step.with];
  if (!left) throw new Error(`matchRows source not found: ${step.from}`);
  if (!right) throw new Error(`matchRows source not found: ${step.with}`);

  const rawRules = Array.isArray(step.rules || step.where) ? (step.rules || step.where) : [];
  const rules = rawRules.map(normalizeMatchRowsRule).filter((rule) => rule.leftColumn && rule.rightColumn);
  const includeRules = rules.filter((rule) => rule.action !== 'exclude');
  const excludeRules = rules.filter((rule) => rule.action === 'exclude');
  const leftRows = Array.isArray(left.rows) ? left.rows : [];
  const rightRows = Array.isArray(right.rows) ? right.rows : [];
  const leftColumns = inferColumns(left);
  const rightColumns = inferColumns(right);
  const { columns, mapping } = buildMatchRowsColumnMapping(leftColumns, rightColumns, step);
  const rows = [];

  for (const leftRow of leftRows) {
    for (const rightRow of rightRows) {
      const included = includeRules.length
        ? includeRules.some((rule) => matchRowsRuleMatches(leftRow, rightRow, rule, params, step.caseSensitive))
        : true;
      if (!included) continue;
      const excluded = excludeRules.some((rule) => matchRowsRuleMatches(leftRow, rightRow, rule, params, step.caseSensitive));
      if (excluded) continue;
      rows.push(mergeMatchRows(leftRow, rightRow, leftColumns, mapping));
      if (rows.length >= limits.maxRows) {
        return {
          columns,
          rows,
          truncated: true
        };
      }
    }
  }

  return {
    columns,
    rows,
    truncated: Boolean(left.truncated || right.truncated)
  };
}

function normalizeComposeColumns(step) {
  const source = Array.isArray(step.columns || step.fields) ? (step.columns || step.fields) : [];
  return source.map((column) => {
    if (typeof column === 'string') {
      return {
        name: column,
        source: 'left',
        column
      };
    }
    return {
      name: column.name || column.as || column.label,
      source: column.source || column.from || 'left',
      column: column.column || column.field || '',
      valueParam: column.valueParam || '',
      hasValue: Object.prototype.hasOwnProperty.call(column, 'value'),
      value: column.value,
      template: column.template || ''
    };
  }).filter((column) => column.name);
}

function resolveTemplateToken(token, leftRow, rightRow, params) {
  const text = String(token || '').trim();
  if (!text) return '';
  const dotIndex = text.indexOf('.');
  const scope = dotIndex === -1 ? '' : text.slice(0, dotIndex);
  const key = dotIndex === -1 ? text : text.slice(dotIndex + 1);
  if (scope === 'params') return displayCardValue(params[key]);
  if (scope === 'contractparam') return displayCardValue(params && (Object.prototype.hasOwnProperty.call(params, `contractparam.${key}`) ? params[`contractparam.${key}`] : params[key]));
  if (scope === 'left') return displayCardValue(leftRow && leftRow[key]);
  if (scope === 'right') return displayCardValue(rightRow && rightRow[key]);
  if (leftRow && Object.prototype.hasOwnProperty.call(leftRow, text)) return displayCardValue(leftRow[text]);
  if (rightRow && Object.prototype.hasOwnProperty.call(rightRow, text)) return displayCardValue(rightRow[text]);
  if (params && Object.prototype.hasOwnProperty.call(params, text)) return displayCardValue(params[text]);
  return '';
}

function renderComposeTemplate(template, leftRow, rightRow, params) {
  return String(template || '').replace(/\{([^{}]+)\}/g, (match, token) => resolveTemplateToken(token, leftRow, rightRow, params));
}

function renderRuntimeParamTemplate(template, params) {
  return String(template || '')
    .replace(/\$\{params?\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => displayCardValue(params && params[name]))
    .replace(/\$\{contractparam\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => displayCardValue(params && (Object.prototype.hasOwnProperty.call(params, `contractparam.${name}`) ? params[`contractparam.${name}`] : params[name])));
}

function getComposeColumnValue(column, leftRow, rightRow, params) {
  if (column.valueParam) return displayCardValue(params[column.valueParam]);
  if (column.hasValue) return displayCardValue(column.value);
  if (column.template) return renderComposeTemplate(column.template, leftRow, rightRow, params);
  const row = column.source === 'right' ? rightRow : leftRow;
  return displayCardValue(row && row[column.column]);
}

function buildComposeRow(columns, leftRow, rightRow, params) {
  const row = {};
  for (const column of columns) {
    row[column.name] = getComposeColumnValue(column, leftRow, rightRow, params);
  }
  return row;
}

function executeComposeRows(step, params, context, limits) {
  const left = context[step.from];
  if (!left) throw new Error(`composeRows source not found: ${step.from}`);

  const rightName = step.with || step.right || '';
  const right = rightName ? context[rightName] : null;
  if (rightName && !right) throw new Error(`composeRows source not found: ${rightName}`);

  const columns = normalizeComposeColumns(step);
  const outputColumns = columns.map((column) => column.name);
  const rows = [];
  const pushRow = (leftRow, rightRow) => {
    rows.push(buildComposeRow(columns, leftRow, rightRow, params));
    return rows.length >= limits.maxRows;
  };

  if (!rightName) {
    for (const leftRow of Array.isArray(left.rows) ? left.rows : []) {
      if (pushRow(leftRow, null)) {
        return { columns: outputColumns, rows, truncated: true };
      }
    }
    return {
      columns: outputColumns,
      rows,
      truncated: Boolean(left.truncated)
    };
  }

  const mode = step.mode || 'inner';
  const keyPairs = normalizeRowOperationKeys(step);
  const leftKeyColumns = keyPairs.map((pair) => pair.left);
  const rightKeyColumns = keyPairs.map((pair) => pair.right);
  const caseSensitive = step.caseSensitive !== false;
  const leftRows = Array.isArray(left.rows) ? left.rows : [];
  const rightRows = Array.isArray(right.rows) ? right.rows : [];
  const rightIndex = buildRowIndex(rightRows, rightKeyColumns, caseSensitive);
  const matchedRightRows = new Set();

  for (const leftRow of leftRows) {
    const key = buildRowOperationKey(leftRow, leftKeyColumns, caseSensitive);
    const matches = rightIndex.get(key) || [];
    if (matches.length) {
      for (const rightRow of matches) {
        matchedRightRows.add(rightRow);
        if (pushRow(leftRow, rightRow)) {
          return { columns: outputColumns, rows, truncated: true };
        }
      }
    } else if (mode === 'left' || mode === 'full') {
      if (pushRow(leftRow, null)) {
        return { columns: outputColumns, rows, truncated: true };
      }
    }
  }

  if (mode === 'right' || mode === 'full') {
    for (const rightRow of rightRows) {
      if (matchedRightRows.has(rightRow)) continue;
      if (pushRow(null, rightRow)) {
        return { columns: outputColumns, rows, truncated: true };
      }
    }
  }

  return {
    columns: outputColumns,
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
  const effectiveParams = applyTemplateParamDefaults(spec, params);
  const maxRowsMax = Math.min(options.maxRowsMax || ABSOLUTE_EXECUTION_LIMITS.maxRows, ABSOLUTE_EXECUTION_LIMITS.maxRows);
  const maxClassesMax = Math.min(options.maxClassesMax || ABSOLUTE_EXECUTION_LIMITS.maxClasses, ABSOLUTE_EXECUTION_LIMITS.maxClasses);
  const maxDomainsMax = Math.min(options.maxDomainsMax || ABSOLUTE_EXECUTION_LIMITS.maxDomains, ABSOLUTE_EXECUTION_LIMITS.maxDomains);
  const maxRestCallsMax = Math.min(options.maxRestCallsMax || ABSOLUTE_EXECUTION_LIMITS.maxRestCalls, ABSOLUTE_EXECUTION_LIMITS.maxRestCalls);
  const maxTraversalDepthMax = Math.min(options.maxTraversalDepthMax || ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth, ABSOLUTE_EXECUTION_LIMITS.maxTraversalDepth);
  const limits = {
    maxClasses: Math.min(options.maxClasses || 100, maxClassesMax),
    maxClassesMax,
    maxDomains: Math.min(options.maxDomains || 100, maxDomainsMax),
    maxRows: Math.min(options.maxRows || 500, maxRowsMax),
    maxRestCalls: Math.min(options.maxRestCalls || 250, maxRestCallsMax),
    maxTraversalDepth: Math.min(options.maxTraversalDepth || maxTraversalDepthMax, maxTraversalDepthMax),
    traversalDepthDefault: Math.min(options.traversalDepthDefault || 1, maxTraversalDepthMax)
  };
  const context = {};
  const cmdbuildExecRequest = createExecutionRequest(authToken, limits);
  if (isCmdbBuildViewSpec(spec)) {
    return executeCmdbBuildViewSpec(cmdbuildExecRequest, spec, effectiveParams, { limits });
  }
  const dependencyMap = options.dependencyMap || dependencyMapWithHash(spec);
  const trace = [];

  for (const [index, step] of spec.steps.entries()) {
    const startedAt = Date.now();
    const restBefore = cmdbuildExecRequest.getRestCalls();
    try {
      if (step.type === 'findClassesByAttributeType') {
        context[step.as] = await executeFindClassesByAttributeType(cmdbuildExecRequest, step, effectiveParams, limits);
      } else if (step.type === 'baaPlanObjects') {
        context[step.as] = executeBaaPlanObjects(step, options.baaRequest || null, limits, spec.baaContract || null, effectiveParams);
      } else if (step.type === 'extractVariables' || step.type === 'extract') {
        context[step.as] = executeExtractVariables(step, effectiveParams, context, limits);
      } else if (step.type === 'selectCards') {
        context[step.as] = await executeSelectCards(cmdbuildExecRequest, step, effectiveParams, context, limits, dependencyMap);
      } else if (step.type === 'listDomains') {
        context[step.as] = await executeListDomains(cmdbuildExecRequest, limits);
      } else if (step.type === 'filterRows') {
        context[step.as] = executeFilterRows(step, effectiveParams, context, limits);
      } else if (step.type === 'joinRows') {
        context[step.as] = executeJoinRows(step, context, limits);
      } else if (step.type === 'intersectRows') {
        context[step.as] = executeIntersectRows(step, context, limits);
      } else if (step.type === 'matchRows') {
        context[step.as] = executeMatchRows(step, effectiveParams, context, limits);
      } else if (step.type === 'composeRows' || step.type === 'compose') {
        context[step.as] = executeComposeRows(step, effectiveParams, context, limits);
      } else if (step.type === 'enrichRows') {
        context[step.as] = await executeEnrichRows(cmdbuildExecRequest, step, effectiveParams, context, limits);
      } else if (step.type === 'traverseDomains') {
        context[step.as] = await executeTraverseDomains(cmdbuildExecRequest, step, effectiveParams, context, limits);
      } else if (step.type === 'expandRelations') {
        context[step.as] = await executeExpandRelations(cmdbuildExecRequest, step, effectiveParams, context, limits);
      } else if (step.type === 'compareClassAttributes') {
        context[step.as] = await executeCompareClassAttributes(cmdbuildExecRequest, step, effectiveParams, context, limits);
      } else {
        throw new Error(`Unsupported step type: ${step.type}`);
      }
      const output = context[step.as] || {};
      trace.push({
        index,
        type: step.type,
        as: step.as,
        status: 'ok',
        rows: Array.isArray(output.rows) ? output.rows.length : 0,
        columns: Array.isArray(output.columns) ? output.columns.length : 0,
        truncated: Boolean(output.truncated),
        elapsedMs: Date.now() - startedAt,
        restCalls: cmdbuildExecRequest.getRestCalls() - restBefore
      });
    } catch (error) {
      trace.push({
        index,
        type: step.type,
        as: step.as || '',
        status: 'error',
        message: error && error.message ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
        restCalls: cmdbuildExecRequest.getRestCalls() - restBefore
      });
      error.executionTrace = trace;
      throw error;
    }
  }

  const globalPresentation = spec.result && spec.result.presentation && typeof spec.result.presentation === 'object' && !Array.isArray(spec.result.presentation)
    ? spec.result.presentation
    : {};
  const globalTablePresentations = Array.isArray(globalPresentation.tables) ? globalPresentation.tables : [];
  const defaultEmptyText = emptyResultTextFromSpec(spec);
  const defaultPermissionDeniedText = permissionDeniedTextFromSpec(spec);
  const tables = spec.result.tables.map((table) => {
    const source = context[table.name] || { columns: [], rows: [], truncated: false };
    const columns = Array.isArray(table.columns) && table.columns.length ? table.columns : source.columns;
    const sourceRows = Array.isArray(source.rows) ? source.rows : [];
    const namedPresentation = globalTablePresentations.find((item) => item && item.name === table.name) || {};
    const tablePresentation = table.presentation && typeof table.presentation === 'object' && !Array.isArray(table.presentation)
      ? table.presentation
      : {};
    const titleParam = table.titleParam && effectiveParams[table.titleParam] !== undefined && effectiveParams[table.titleParam] !== null
      ? displayCardValue(effectiveParams[table.titleParam])
      : '';
    const titleTemplate = namedPresentation.title || table.title || table.label || '';
    const renderedTitle = renderRuntimeParamTemplate(titleTemplate, effectiveParams);
    const presentation = {
      ...globalPresentation,
      ...namedPresentation,
      ...tablePresentation
    };
    delete presentation.tables;
    return {
      name: table.name,
      title: renderedTitle || titleParam || table.name,
      titleParam: table.titleParam || '',
      mode: namedPresentation.mode || table.mode || table.view || 'table',
      emptyText: table.emptyText || defaultEmptyText,
      columns,
      columnLabels: table.columnLabels && typeof table.columnLabels === 'object' && !Array.isArray(table.columnLabels) ? table.columnLabels : {},
      presentation,
      cellMeta: buildResultCellMeta(sourceRows, columns),
      rows: projectRows(sourceRows, columns),
      truncated: Boolean(source.truncated)
    };
  });

  return {
    emptyText: defaultEmptyText,
    permissionDeniedText: defaultPermissionDeniedText,
    limits: {
      ...limits,
      restCalls: cmdbuildExecRequest.getRestCalls(),
      requestTimeoutMs: CMDBUILD_REQUEST_TIMEOUT_MS
    },
    tables,
    trace
  };
}

async function handleBackend(req, res, requestUrl) {
  const auth = backendAuthFromRequest(req, requestUrl);
  const authToken = auth.token;
  const authSource = auth.source;
  if (isHealthPath(requestUrl.pathname)) {
    await handleHealth(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/public-snapshots/`)) {
    if (!methodAllowed(req, res, 'GET')) return;
    const suffix = requestUrl.pathname.slice(`${BACKEND_PREFIX}/public-snapshots/`.length);
    const parts = suffix.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts.length !== 2 || parts[1] !== 'run') {
      sendJson(res, 404, {
        success: false,
        message: `Unknown public snapshot route: ${requestUrl.pathname}`
      });
      return;
    }
    await sendPublicSnapshotRun(res, requestUrl, parts[0]);
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/cache/status`) {
    if (!methodAllowed(req, res, 'GET')) return;
    sendJson(res, 200, {
      success: true,
      redis: await redisStatus(),
      memory: {
        runtimeEntries: runtimeResultCache.size,
        staticSnapshotEntries: staticSnapshotCache.size,
        inFlightRuntimeBuilds: runtimeResultInFlight.size
      }
    });
    return;
  }

  if (!authToken) {
    if (isBaaVerifyBackendPath(requestUrl.pathname)) {
      sendJson(res, 401, baaErrorResponse('AUTH_REQUIRED', 'BAA verification call did not include CMDBuild session cookie or CMDBuild-Authorization header.'));
      return;
    }
    sendJson(res, 401, {
      success: false,
      receivedCmdbuildCookie: false,
      message: 'CMDBuild-Authorization cookie was not sent to backend route.'
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/client-log`) {
    if (!methodAllowed(req, res, 'GET')) return;
    if (requestUrl.searchParams.get('clear') === '1') {
      clientLogs.length = 0;
    }
    const stage = requestUrl.searchParams.get('stage') || '';
    if (stage) {
      appendBoundedLog(clientLogs, {
        time: new Date().toISOString(),
        stage: truncateText(stage, 120),
        href: truncateText(requestUrl.searchParams.get('href') || '', 500),
        message: truncateText(requestUrl.searchParams.get('message') || '', 500)
      });
    }
    sendJson(res, 200, {
      success: true,
      data: clientLogs
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/proxy-log`) {
    if (!methodAllowed(req, res, 'GET')) return;
    if (requestUrl.searchParams.get('clear') === '1') {
      proxyLogs.length = 0;
    }
    sendJson(res, 200, {
      success: true,
      data: proxyLogs
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/logging/status`) {
    if (!methodAllowed(req, res, 'GET')) return;
    sendJson(res, 200, {
      success: true,
      logging: loggingStatus()
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

  if (requestUrl.pathname === `${BACKEND_PREFIX}/model/catalog`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const catalog = await buildModelCatalog(authToken, requestUrl);
    sendJson(res, catalog.statusCode, {
      success: catalog.success,
      cmdbuildStatus: catalog.cmdbuildStatus,
      catalog: catalog.catalog
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
    if (!className || parts.length > 2 || (parts.length === 2 && action !== 'attributes')) {
      sendJson(res, 404, {
        success: false,
        message: `Unknown model class route: ${requestUrl.pathname}`
      });
      return;
    }

    if (parts.length === 1) {
      const classResponse = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(className)}`, authToken);
      const statusCode = classResponse.ok
        ? 200
        : [401, 403, 404].includes(classResponse.statusCode)
          ? classResponse.statusCode
          : 502;
      sendJson(res, statusCode, {
        success: classResponse.ok,
        cmdbuildStatus: classResponse.statusCode,
        className,
        class: classResponse.ok ? sanitizeClass(classResponse.json && classResponse.json.data) : null
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

  if (requestUrl.pathname === `${BACKEND_PREFIX}/auth/permission-scope`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const probe = await buildPermissionScopeProbe(authToken, requestUrl);
    sendJson(res, probe.success ? 200 : 502, {
      success: probe.success,
      ...probe
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/baa/contracts`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const type = requestUrl.searchParams.get('type') || 'input';
    try {
      const contracts = await listBaaContractCards(authToken, root, type);
      sendJson(res, 200, {
        success: true,
        root,
        ...contracts
      });
    } catch (error) {
      sendJson(res, isPermissionDeniedStatus(error.cmdbuildStatus || error.statusCode) ? 403 : 502, {
        success: false,
        root,
        type,
        message: error.message || String(error),
        cmdbuildStatus: error.cmdbuildStatus || error.statusCode || 0
      });
    }
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
    const session = await getSessionData(authToken);
    if (!session.response.ok) {
      sendJson(res, session.response.statusCode === 401 ? 401 : 502, {
        success: false,
        cmdbuildStatus: session.response.statusCode,
        message: 'CMDBuild session is not valid.'
      });
      return;
    }
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const parent = requestUrl.searchParams.get('parent') || requestUrl.searchParams.get('rootParent') || requestUrl.searchParams.get('superclass') || 'Class';
    const description = requestUrl.searchParams.get('description') || '';
    const schema = await checkOrCreateTechnicalSchema(authToken, root, false, { parent, description });
    sendJson(res, 200, {
      success: true,
      schema
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/schema/parents`) {
    if (!methodAllowed(req, res, 'GET')) return;
    const parents = await listTechnicalSchemaParents(authToken, requestUrl);
    sendJson(res, parents.success ? 200 : 502, parents);
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/schema/preview`) {
    if (!methodAllowed(req, res, 'POST')) return;
    if (!requireStateChangingRequest(req, res, authToken)) return;
    const body = await readJsonBody(req);
    const root = body.root || requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const parent = schemaParentFromInput(body, requestUrl.searchParams.get('parent') || 'Class');
    const description = body.description || body.rootDescription || requestUrl.searchParams.get('description') || '';
    const schema = await checkOrCreateTechnicalSchema(authToken, root, false, { parent, description, classes: body.classes || body.classOverrides });
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
    const parent = schemaParentFromInput(body, requestUrl.searchParams.get('parent') || 'Class');
    const description = body.description || body.rootDescription || requestUrl.searchParams.get('description') || '';
    const schema = await checkOrCreateTechnicalSchema(authToken, root, true, { parent, description, classes: body.classes || body.classOverrides });
    sendJson(res, schema.ready ? 200 : 502, {
      success: schema.ready,
      schema
    });
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/config`) {
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;

    if (req.method === 'GET') {
      const found = await findConfigCard(authToken, root);
      if (!found.response.ok && sendTechnicalSchemaAccessDeniedIfNeeded(res, {
        cmdbuildStatus: found.response.statusCode,
        root: found.schema.root,
        className: found.schema.classNames.config
      })) return;
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
        if (sendTechnicalSchemaAccessDeniedIfNeeded(res, {
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.config
        })) return;
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

  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/draft/`)) {
    const draftAction = requestUrl.pathname.slice(`${BACKEND_PREFIX}/draft/`.length).replace(/\/+$/, '');
    if (!['validate', 'preview'].includes(draftAction)) {
      sendJson(res, 404, {
        success: false,
        message: `Unknown draft action: ${draftAction}`
      });
      return;
    }
    if (!methodAllowed(req, res, 'POST')) return;
    if (!requireStateChangingRequest(req, res, authToken)) return;

    let draft;
    try {
      draft = normalizeDraftTemplateBody(await readJsonBody(req));
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        action: draftAction,
        message: error && error.message ? error.message : String(error)
      });
      return;
    }

    const template = {
      code: draft.code,
      description: draft.description,
      active: draft.active
    };
    const errors = validateTemplateSpec(draft.spec);

    if (draftAction === 'validate') {
      sendJson(res, errors.length ? 400 : 200, {
        success: errors.length === 0,
        action: draftAction,
        template,
        errors
      });
      return;
    }

    if (errors.length) {
      sendJson(res, 400, {
        success: false,
        action: draftAction,
        template,
        errors
      });
      return;
    }

    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const runtimeConfig = await getRuntimeConfig(authToken, root);
    const executionLimits = normalizeExecutionLimitConfig(runtimeConfig);
    const executionSlot = acquireExecutionSlot(req, res, {
      action: 'draft-preview',
      templateCode: template.code
    });
    if (!executionSlot) return;
    try {
      const result = await executeTemplateSpec(authToken, draft.spec, draft.params, {
        maxRows: getPositiveInt(requestUrl.searchParams, 'maxRows', executionLimits.maxRowsPreviewDefault, executionLimits.maxRowsMax),
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
      sendJson(res, 200, {
        success: true,
        action: draftAction,
        template,
        params: draft.params,
        result
      });
    } catch (error) {
      const permissionDenied = errorLooksPermissionDenied(error);
      const permissionDeniedText = permissionDeniedTextFromSpec(draft.spec);
      incMetric('cmdp_template_run_errors_total', {
        action: 'draft-preview',
        reason: templateExecutionErrorReason(error)
      });
      sendJson(res, permissionDenied ? 403 : (error.statusCode || 400), {
        success: false,
        action: draftAction,
        template,
        params: draft.params,
        message: permissionDenied ? permissionDeniedText : (error && error.message ? error.message : String(error)),
        permissionDeniedText: permissionDenied ? permissionDeniedText : undefined,
        result: {
          trace: error && Array.isArray(error.executionTrace) ? error.executionTrace : []
        }
      });
    } finally {
      executionSlot.release();
    }
    return;
  }

  if (requestUrl.pathname === `${BACKEND_PREFIX}/templates`) {
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;

    if (req.method === 'GET') {
      const list = await listTemplateCards(authToken, root, requestUrl);
      if (!list.response.ok && sendTechnicalSchemaAccessDeniedIfNeeded(res, {
        cmdbuildStatus: list.response.statusCode,
        root: list.schema.root,
        className: list.schema.classNames.template
      })) return;
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
      const specErrors = validateTemplateSpec(safeJsonValue(payload.SpecJson, null));
      if (specErrors.length) {
        sendJson(res, 400, {
          success: false,
          message: 'Template spec validation failed.',
          errors: specErrors
        });
        return;
      }
      const existing = await findTemplateCard(authToken, root, payload.Code);
      if (!existing.response.ok && sendTechnicalSchemaAccessDeniedIfNeeded(res, {
        cmdbuildStatus: existing.response.statusCode,
        root: existing.schema.root,
        className: existing.schema.classNames.template
      })) return;
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
      logInfo(created.ok ? 'template.created' : 'template.create_failed', {
        requestId: req.cmdpRequestId || '',
        templateCode: payload.Code,
        username: session.data && session.data.username || '',
        cmdbuildStatus: created.statusCode,
        versionLogged: Boolean(versionLog)
      });
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
        if (!versions.response.ok && sendTechnicalSchemaAccessDeniedIfNeeded(res, {
          cmdbuildStatus: versions.response.statusCode,
          root: versions.schema.root,
          className: versions.schema.classNames.version
        })) return;
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
      if (!['validate', 'preview', 'run', 'publish', 'baa-verify'].includes(templateAction)) {
        sendJson(res, 404, {
          success: false,
          message: `Unknown template action: ${templateAction}`
        });
        return;
      }
      const runtimeReadOnly = templateAction === 'run' && req.method === 'GET';
      if (!methodAllowed(req, res, templateAction === 'run' ? ['GET', 'POST'] : 'POST')) return;
      if (!runtimeReadOnly) {
        if (templateAction === 'baa-verify') {
          if (!requireBaaStateChangingRequest(req, res, authToken, authSource)) return;
        } else if (!requireStateChangingRequest(req, res, authToken)) return;
      }

      const found = await findTemplateCard(authToken, root, templateCode);
      if (!found.response.ok) {
        if (templateAction === 'baa-verify') {
          const permissionDenied = found.response.statusCode === 401 || found.response.statusCode === 403;
          sendJson(res, permissionDenied ? 403 : 502, baaErrorResponse(
            permissionDenied ? 'CMDB_PERMISSION_DENIED' : 'CMDBUILD_ERROR',
            permissionDenied ? DEFAULT_PERMISSION_DENIED_TEXT : `CMDBuild template lookup failed with status ${found.response.statusCode}.`
          ));
          return;
        }
        if (sendTechnicalSchemaAccessDeniedIfNeeded(res, {
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        })) return;
        sendJson(res, 502, {
          success: false,
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        });
        return;
      }
      if (!found.card) {
        if (templateAction === 'baa-verify') {
          sendJson(res, 404, baaErrorResponse('TEMPLATE_NOT_FOUND', `Template not found: ${templateCode}`));
          return;
        }
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
        if (templateAction === 'baa-verify') {
          sendJson(res, 400, baaErrorResponse('EXECUTION_ERROR', 'Template spec validation failed.', 'error', errors.map((error) => baaErrorItem('TEMPLATE_SPEC_INVALID', `${error.path}: ${error.message}`))));
          return;
        }
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

      const body = runtimeReadOnly ? {} : await readJsonBody(req);
      const isBaaVerify = templateAction === 'baa-verify';
      if (isBaaVerificationSpec(template.spec) && !isBaaVerify && ['preview', 'run', 'publish'].includes(templateAction)) {
        sendJson(res, 409, {
          success: false,
          reason: 'baa_post_only',
          message: BAA_POST_ONLY_TEXT,
          template: {
            code: template.code,
            description: template.description,
            active: template.active
          },
          baaVerifyUrl: `${BACKEND_PREFIX}/templates/${encodeURIComponent(template.code)}/baa-verify`
        });
        return;
      }
      if (isBaaVerify) {
        const validation = validateBaaVerificationRequest(body, template.spec);
        if (!validation.ok) {
          sendJson(res, 400, baaEnvelope({
            success: false,
            status: 'error',
            message: 'BAA verification request is invalid.',
            tables: [],
            items: validation.errors,
            data: {}
          }));
          return;
        }
      }
      const params = runtimeReadOnly ? publicSnapshotParamsFromUrl(requestUrl) : isBaaVerify ? baaParamsFromRequest(body, template.spec) : body.params || {};
      const jsonOutput = templateAction === 'run' && runtimeJsonOutputRequested(requestUrl);
      const session = await getSessionData(authToken);
      const username = session.data && session.data.username ? session.data.username : '';
      const runtimeConfig = await getRuntimeConfig(authToken, root);
      const executionLimits = normalizeExecutionLimitConfig(runtimeConfig);
      const runtimeCacheConfig = normalizeRuntimeCacheConfig(runtimeConfig);
      const publishConfig = normalizePublishConfig(template.spec);
      const maxRows = templateAction === 'preview'
        ? getPositiveInt(requestUrl.searchParams, 'maxRows', executionLimits.maxRowsPreviewDefault, executionLimits.maxRowsMax)
        : getPositiveInt(requestUrl.searchParams, 'maxRows', executionLimits.maxRowsDefault, executionLimits.maxRowsMax);
      const executionOptions = {
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
      };
      const cacheDisabled = requestUrl.searchParams.get('noCache') === '1' || body.noCache === true;
      const forceRefreshRequested = !runtimeReadOnly && (
        requestUrl.searchParams.get('forceRefresh') === '1' ||
        body.forceRefresh === true ||
        body.bypassRefreshCooldown === true
      );
      const refreshRequested = forceRefreshRequested || requestUrl.searchParams.get('refresh') === '1' || body.refresh === true;
      let result;
      let cache = null;

      if (templateAction === 'run' && publishConfig.mode === 'staticSnapshot') {
        const lookup = await readStaticSnapshot(template.code, params, publishConfig);
        if (lookup.snapshot) {
          result = cloneJsonValueServer(lookup.snapshot.result, { tables: [] });
          cache = staticSnapshotCacheMeta(lookup.snapshot, 'snapshot-hit', lookup.backend, lookup.key);
        } else {
          result = { emptyText: SNAPSHOT_MISSING_TEXT, tables: [] };
          cache = staticSnapshotCacheMeta(null, 'snapshot-miss', lookup.backend, lookup.key);
        }
        logInfo(lookup.snapshot ? 'snapshot.hit' : 'snapshot.miss', {
          requestId: req.cmdpRequestId || '',
          templateCode: template.code,
          username,
          rowsCount: countResultRows(result),
          backend: lookup.backend,
          key: lookup.key,
          paramsMode: publishConfig.paramsMode || 'exact'
        });
        const payload = {
          success: true,
          snapshotFound: Boolean(lookup.snapshot),
          action: templateAction,
          template: {
            code: template.code,
            description: template.description,
            active: template.active
          },
          params,
          result,
          cache
        };
        sendJson(res, 200, jsonOutput ? runtimeJsonResponsePayload(payload) : payload);
        return;
      }

      if (templateAction === 'publish') {
        if (publishConfig.mode !== 'staticSnapshot' || !publishConfig.warningAccepted) {
          sendJson(res, 400, {
            success: false,
            action: templateAction,
            message: 'Template publish.mode must be staticSnapshot and warningAccepted must be true.'
          });
          return;
        }
        if (found.card && found.card._can_update === false) {
          sendTechnicalSchemaAccessDenied(res, {
            root: found.schema.root,
            className: found.schema.classNames.template,
            cmdbuildStatus: 403
          });
          return;
        }
      }

      const executionSlot = acquireExecutionSlot(req, res, {
        action: templateAction,
        templateCode: template.code
      });
      if (!executionSlot) return;
      try {
        if (templateAction === 'publish') {
          result = await executeTemplateSpec(authToken, template.spec, params, executionOptions);
          const snapshot = await writeStaticSnapshot(root, template, params, result, session.data, publishConfig);
          cache = staticSnapshotCacheMeta({
            publishedAt: snapshot.publishedAt,
            publishedBy: snapshot.publishedBy,
            paramsHash: snapshot.paramsHash,
            specHash: snapshot.specHash
          }, 'snapshot-published', snapshot.backend, snapshot.key);
          logInfo('snapshot.published', {
            requestId: req.cmdpRequestId || '',
            templateCode: template.code,
            username,
            rowsCount: countResultRows(result),
            backend: snapshot.backend,
            key: snapshot.key,
            paramsMode: publishConfig.paramsMode || 'exact'
          });
        } else if (isBaaVerify && !cacheDisabled) {
          const cached = await executeTemplateRunWithCache(authToken, root, template, params, session.data, executionOptions, {
            refreshRequested,
            forceRefreshRequested,
            runtimeCacheConfig,
            baaRequest: body,
            cacheContext: { baa: normalizedBaaRequestForCache(body) }
          });
          result = cached.result;
          cache = cached.cache;
          logInfo('baa.verify.cache_result', {
            requestId: req.cmdpRequestId || '',
            templateCode: template.code,
            username,
            status: cache && cache.status || '',
            scope: cache && cache.scope || '',
            scopeMode: cache && cache.scopeMode || '',
            backend: cache && cache.backend || '',
            rowsCount: countResultRows(result),
            refreshRequested: Boolean(refreshRequested),
            forceRefreshRequested: Boolean(forceRefreshRequested)
          });
        } else if (templateAction === 'run' && !cacheDisabled) {
          const cached = await executeTemplateRunWithCache(authToken, root, template, params, session.data, executionOptions, {
            refreshRequested,
            forceRefreshRequested,
            runtimeCacheConfig
          });
          result = cached.result;
          cache = cached.cache;
          logInfo('runtime.cache_result', {
            requestId: req.cmdpRequestId || '',
            templateCode: template.code,
            username,
            status: cache && cache.status || '',
            scope: cache && cache.scope || '',
            scopeMode: cache && cache.scopeMode || '',
            backend: cache && cache.backend || '',
            rowsCount: countResultRows(result),
            refreshRequested: Boolean(refreshRequested),
            forceRefreshRequested: Boolean(forceRefreshRequested)
          });
        } else {
          result = await executeTemplateSpec(authToken, template.spec, params, {
            ...executionOptions,
            baaRequest: isBaaVerify ? body : null
          });
        }
      } catch (error) {
        const permissionDenied = errorLooksPermissionDenied(error);
        const permissionDeniedText = permissionDeniedTextFromSpec(template.spec);
        incMetric('cmdp_template_run_errors_total', {
          action: templateAction,
          reason: templateExecutionErrorReason(error)
        });
        logWarn('template.execution_failed', {
          requestId: req.cmdpRequestId || '',
          action: templateAction,
          templateCode: template.code,
          username,
          permissionDenied,
          error: error && error.message ? error.message : String(error)
        });
        if (isBaaVerify) {
          const code = baaErrorCodeFromError(error);
          const message = permissionDenied ? permissionDeniedText : (error && error.message ? error.message : String(error));
          sendJson(res, permissionDenied ? 403 : (error.statusCode || 400), baaErrorResponse(code, message));
          return;
        }
        sendJson(res, permissionDenied ? 403 : (error.statusCode || 400), {
          success: false,
          action: templateAction,
          template: {
            code: template.code,
            description: template.description,
            active: template.active
          },
          message: permissionDenied ? permissionDeniedText : (error && error.message ? error.message : String(error)),
          permissionDeniedText: permissionDenied ? permissionDeniedText : undefined
        });
        return;
      } finally {
        executionSlot.release();
      }
      if (templateAction === 'run' || templateAction === 'preview' || isBaaVerify) {
        logInfo('template.executed', {
          requestId: req.cmdpRequestId || '',
          action: templateAction,
          templateCode: template.code,
          username,
          rowsCount: countResultRows(result),
          cacheStatus: cache && cache.status || (cacheDisabled ? 'disabled' : '')
        });
      }
      if (isBaaVerify) {
        sendJson(res, 200, baaResponseFromRuntimeResult(result, template));
        return;
      }
      const payload = {
        success: true,
        action: templateAction,
        template: {
          code: template.code,
          description: template.description,
          active: template.active
        },
        params,
        result,
        cache
      };
      sendJson(res, 200, jsonOutput ? runtimeJsonResponsePayload(payload) : payload);
      return;
    }

    if (req.method === 'DELETE') {
      if (!requireStateChangingRequest(req, res, authToken)) return;
      const found = await findTemplateCard(authToken, root, templateCode);
      if (!found.response.ok) {
        if (sendTechnicalSchemaAccessDeniedIfNeeded(res, {
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        })) return;
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
      const protectedTemplate = sanitizeTemplateCard(found.card);
      if (protectedTemplate && protectedTemplate.protected) {
        sendJson(res, 403, {
          success: false,
          message: `Template ${templateCode} is protected and cannot be deleted.`,
          template: protectedTemplate
        });
        return;
      }
      const cardId = found.card._id || found.card.Id || found.card.id;
      if (!cardId) {
        sendJson(res, 502, {
          success: false,
          message: `Template card id is missing: ${templateCode}`,
          root: found.schema.root,
          className: found.schema.classNames.template
        });
        return;
      }
      const deleted = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(found.schema.classNames.template)}/cards/${encodeURIComponent(cardId)}`, authToken, {
        method: 'DELETE'
      });
      logInfo(deleted.ok ? 'template.deleted' : 'template.delete_failed', {
        requestId: req.cmdpRequestId || '',
        templateCode,
        cmdbuildStatus: deleted.statusCode
      });
      sendJson(res, deleted.ok ? 200 : 502, {
        success: deleted.ok,
        cmdbuildStatus: deleted.statusCode,
        root: found.schema.root,
        className: found.schema.classNames.template,
        template: sanitizeTemplateCard(found.card)
      });
      return;
    }

    if (req.method === 'GET') {
      const found = await findTemplateCard(authToken, root, templateCode);
      if (!found.response.ok) {
        if (sendTechnicalSchemaAccessDeniedIfNeeded(res, {
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        })) return;
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
        if (sendTechnicalSchemaAccessDeniedIfNeeded(res, {
          cmdbuildStatus: found.response.statusCode,
          root: found.schema.root,
          className: found.schema.classNames.template
        })) return;
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
      const expectedSpecHash = expectedSpecHashFromBody(body);
      const currentTemplate = sanitizeTemplateCard(found.card);
      if (expectedSpecHash && currentTemplate && currentTemplate.specHash !== expectedSpecHash) {
        sendJson(res, 409, {
          success: false,
          reason: 'template_version_conflict',
          message: `Template ${templateCode} was changed by another editor. Reload the template before saving.`,
          expectedSpecHash,
          currentSpecHash: currentTemplate.specHash,
          template: currentTemplate
        });
        return;
      }
      const session = await getSessionData(authToken);
      const payload = normalizeTemplatePayload(body, templateCode, session.data && session.data.username);
      const specErrors = validateTemplateSpec(safeJsonValue(payload.SpecJson, null));
      if (specErrors.length) {
        sendJson(res, 400, {
          success: false,
          message: 'Template spec validation failed.',
          errors: specErrors
        });
        return;
      }
      const updated = await cmdbuildRequest(`/cmdbuild/services/rest/v3/classes/${encodeURIComponent(found.schema.classNames.template)}/cards/${encodeURIComponent(found.card._id)}`, authToken, {
        method: 'PUT',
        body: payload
      });
      const versionLog = updated.ok
        ? await writeTemplateVersion(authToken, found.schema.root, payload.Code, safeJsonValue(payload.SpecJson, null), session.data && session.data.username, body.changeComment || 'update')
        : null;
      logInfo(updated.ok ? 'template.updated' : 'template.update_failed', {
        requestId: req.cmdpRequestId || '',
        templateCode: payload.Code,
        username: session.data && session.data.username || '',
        cmdbuildStatus: updated.statusCode,
        versionLogged: Boolean(versionLog)
      });
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

    methodAllowed(req, res, ['GET', 'PUT', 'DELETE']);
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

async function handleDynamicPagesUi(req, res, requestUrl) {
  if (!methodAllowed(req, res, 'GET')) return;

  const pathname = requestUrl.pathname.replace(/\/+$/, '') || DYNAMIC_UI_PREFIX;
  const authToken = getCookieValue(req.headers.cookie, 'CMDBuild-Authorization');
  const jsonOutput = runtimeJsonOutputRequested(requestUrl);
  if (!authToken) {
    if (pathname.startsWith(`${DYNAMIC_UI_PREFIX}/run/`)) {
      const templateCode = decodeURIComponent(pathname.slice(`${DYNAMIC_UI_PREFIX}/run/`.length));
      try {
        validateCmdbuildIdentifier(templateCode, 'template code');
      } catch (error) {
        sendHtml(res, 400, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>Invalid template code</h1><p>${htmlEscape(error.message)}</p></body></html>`);
        return;
      }
      if (jsonOutput) {
        const publicUrl = new URL(requestUrl.href);
        publicUrl.pathname = `${BACKEND_PREFIX}/public-snapshots/${encodeURIComponent(templateCode)}/run`;
        await handleBackend(req, res, publicUrl);
        return;
      }
      sendHtml(res, 200, renderDynamicPagesShell({
        mode: 'runtime',
        session: {},
        templateCode,
        publicRuntime: true
      }));
      return;
    }
    sendHtml(res, 401, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>CMDB Dynamic Pages</h1><p>CMDBuild session cookie was not sent. Open CMDBuild through the proxy and log in first.</p><p><a href="/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages">Open CMDBuild custom page</a></p><p><a href="/cmdbuild/dynamicpages/ui/designer">Open Designer directly</a></p></body></html>`);
    return;
  }

  const session = await getSessionData(authToken);
  if (!session.response.ok || !session.data) {
    sendHtml(res, 401, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>CMDB Dynamic Pages</h1><p>CMDBuild session is not valid.</p><p><a href="/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages">Open CMDBuild custom page</a></p><p><a href="/cmdbuild/dynamicpages/ui/designer">Open Designer directly</a></p></body></html>`);
    return;
  }

  if (pathname === DYNAMIC_UI_PREFIX) {
    redirect(res, `${DYNAMIC_UI_PREFIX}/designer`);
    return;
  }

  if (pathname === `${DYNAMIC_UI_PREFIX}/designer` || pathname.startsWith(`${DYNAMIC_UI_PREFIX}/designer/`)) {
    sendHtml(res, 200, renderDynamicPagesShell({
      mode: 'designer',
      session: sanitizeSession(session.data),
      designerSection: extractDesignerSection(pathname, requestUrl)
    }));
    return;
  }

  if (pathname.startsWith(`${DYNAMIC_UI_PREFIX}/run/`)) {
    const templateCode = decodeURIComponent(pathname.slice(`${DYNAMIC_UI_PREFIX}/run/`.length));
    try {
      validateCmdbuildIdentifier(templateCode, 'template code');
    } catch (error) {
      sendHtml(res, 400, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>Invalid template code</h1><p>${htmlEscape(error.message)}</p></body></html>`);
      return;
    }
    if (jsonOutput) {
      const backendUrl = new URL(requestUrl.href);
      backendUrl.pathname = `${BACKEND_PREFIX}/templates/${encodeURIComponent(templateCode)}/run`;
      await handleBackend(req, res, backendUrl);
      return;
    }
    const root = requestUrl.searchParams.get('root') || DEFAULT_TECHNICAL_ROOT;
    const found = await findTemplateCard(authToken, root, templateCode);
    if (found.response.ok && found.card) {
      const template = sanitizeTemplateCard(found.card);
      if (isBaaVerificationSpec(template.spec)) {
        const verifyUrl = `${requestUrl.origin}${BACKEND_PREFIX}/templates/${encodeURIComponent(templateCode)}/baa-verify`;
        sendHtml(res, 409, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>CMDB Dynamic Pages</h1><p>${htmlEscape(BAA_POST_ONLY_TEXT)}</p><p><strong>BAA verification URL:</strong> <code>${htmlEscape(verifyUrl)}</code></p><p><a href="/cmdbuild/dynamicpages/ui/designer">Open Designer</a></p></body></html>`);
        return;
      }
    }
    sendHtml(res, 200, renderDynamicPagesShell({
      mode: 'runtime',
      session: sanitizeSession(session.data),
      templateCode
    }));
    return;
  }

  sendHtml(res, 404, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>Not found</h1><p>${htmlEscape(requestUrl.pathname)}</p></body></html>`);
}

function proxyToCmdbuild(req, res, requestUrl) {
  logProxyRequest(req, requestUrl);
  const target = new URL(req.url || '/', CMDBUILD_ORIGIN);
  const headers = { ...req.headers };
  headers.host = req.headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`;
  if (currentRequestId()) headers['x-request-id'] = currentRequestId();
  if (isCmdbuildUiCacheSensitive(requestUrl.pathname)) {
    headers['accept-encoding'] = 'identity';
  }

  const transport = httpTransportForTarget(target);
  const proxyReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers,
    agent: cmdbuildAgentForTarget(target)
  }, (proxyRes) => {
    const shouldRewriteHtml = isCmdbuildUiEntry(requestUrl.pathname);
    const shouldRewriteManifest = isCmdbuildUiManifest(requestUrl.pathname);
    const shouldBuffer = shouldRewriteHtml || shouldRewriteManifest || isCmdbuildUiCacheSensitive(requestUrl.pathname);

    if (!shouldBuffer) {
      res.writeHead(proxyRes.statusCode || 502, rewriteProxyResponseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (shouldRewriteHtml) {
        body = rewriteCmdbuildUiHtml(body);
      } else if (shouldRewriteManifest) {
        body = rewriteCmdbuildManifest(body);
      }
      const responseHeaders = withNoStoreHeaders(rewriteProxyResponseHeaders(proxyRes.headers));
      responseHeaders['content-length'] = Buffer.byteLength(body);
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      res.end(body);
    });
  });

  proxyReq.on('error', (error) => {
    sendJson(res, 502, {
      success: false,
      message: `Proxy error: ${error.message}`
    });
  });

  req.pipe(proxyReq);
}

function destroyOutboundAgents() {
  cmdbuildHttpAgent.destroy();
  cmdbuildHttpsAgent.destroy();
}

function installGracefulShutdown(serverInstance) {
  let shutdownStarted = false;
  const shutdown = (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    logWarn('app.shutdown_started', {
      signal,
      timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS
    });

    const forceTimer = setTimeout(() => {
      logError('app.shutdown_forced', {
        signal,
        timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS
      });
      if (typeof serverInstance.closeAllConnections === 'function') {
        serverInstance.closeAllConnections();
      }
      destroyOutboundAgents();
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    serverInstance.close((error) => {
      clearTimeout(forceTimer);
      destroyOutboundAgents();
      if (error) {
        logError('app.shutdown_failed', {
          signal,
          error: error.message || String(error)
        });
        process.exit(1);
      }
      logInfo('app.shutdown_complete', { signal });
      process.exit(0);
    });

    if (typeof serverInstance.closeIdleConnections === 'function') {
      serverInstance.closeIdleConnections();
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`}`);
  attachHttpRequestLogging(req, res, requestUrl);
  requestContext.enterWith({ requestId: req.cmdpRequestId || '' });
  if (shuttingDown && requestUrl.pathname !== '/health/live') {
    sendJson(res, 503, {
      success: false,
      status: 'shutting_down',
      message: 'Server is shutting down.'
    }, {
      connection: 'close'
    });
    return;
  }
  if (isMetricsPath(requestUrl.pathname)) {
    metricsPayload().then((body) => {
      sendText(res, 200, body, 'text/plain; version=0.0.4; charset=utf-8');
    }).catch((error) => {
      sendText(res, 500, `# metrics error: ${prometheusEscape(error && error.message ? error.message : String(error))}\n`);
    });
    return;
  }
  if (isHealthPath(requestUrl.pathname)) {
    handleHealth(req, res, requestUrl).catch((error) => {
      sendJson(res, 503, {
        ...baseHealthPayload(),
        status: 'not_ready',
        ready: false,
        error: error && error.message ? error.message : String(error)
      });
    });
    return;
  }
  if (requestUrl.pathname === DYNAMIC_UI_PREFIX || requestUrl.pathname.startsWith(`${DYNAMIC_UI_PREFIX}/`)) {
    handleDynamicPagesUi(req, res, requestUrl).catch((error) => {
      logError('dynamic_ui.render_failed', {
        requestId: req.cmdpRequestId || '',
        path: requestUrl.pathname,
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : ''
      });
      const details = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
      sendHtml(res, 500, `<!doctype html><html><head><meta charset="utf-8"><title>CMDB Dynamic Pages</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>CMDB Dynamic Pages error</h1><pre>${htmlEscape(details)}</pre></body></html>`);
    });
    return;
  }
  if (requestUrl.pathname.startsWith(`${BACKEND_PREFIX}/`)) {
    handleBackend(req, res, requestUrl).catch((error) => {
      sendJson(res, 500, {
        success: false,
        message: error && error.message ? error.message : String(error)
      });
    });
    return;
  }
  proxyToCmdbuild(req, res, requestUrl);
});

server.on('error', (error) => {
  logError('app.listen_failed', {
    listen: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
    error: error && error.message ? error.message : String(error)
  });
  process.exitCode = 1;
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  installGracefulShutdown(server);
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    logInfo('app.started', {
      listen: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
      cmdbuildOrigin: CMDBUILD_ORIGIN,
      backendPrefix: BACKEND_PREFIX,
      logging: loggingStatus(),
      redis: {
        enabled: REDIS_ENABLED,
        url: sanitizeRedisUrl(REDIS_URL),
        keyPrefix: REDIS_KEY_PREFIX
      }
    });
  });
}

export {
  DEFAULT_TEMPLATE_CACHE_TTL_SEC,
  applyTemplateParamDefaults,
  baaErrorResponse,
  baaResponseFromRuntimeResult,
  buildResultCellMeta,
  buildTechnicalSchema,
  cmdbuildRequestCanRetry,
  cmdbuildRetryDelayMs,
  defaultRuntimeConfig,
  dependencyMapWithHash,
  executionThrottleScopeKey,
  expectedSpecHashFromBody,
  executeBaaPlanObjects,
  incMetric,
  ipv4ValueMatches,
  loggingStatus,
  normalizedBaaRequestForCache,
  normalizeLogFormat,
  normalizeLogLevel,
  normalizeLogTargets,
  normalizeRuntimeCacheConfig,
  normalizeTemplateCacheConfig,
  normalizeTemplateSpecForStorage,
  parseNameSet,
  publicSnapshotParamsFromUrl,
  redactByName,
  renderRuntimeParamTemplate,
  renderCellTemplate,
  renderPrometheusMetrics,
  runtimeCacheKeyParts,
  runtimeCacheMeta,
  runtimeJsonOutputRequested,
  runtimeJsonResponsePayload,
  redisRequiredError,
  sanitizeRequestPath,
  sanitizeTemplateCard,
  schemaParentFromInput,
  securityHeaders,
  setMetricGauge,
  shouldRetryCmdbuildResult,
  templateIsProtected,
  validateRegexPattern,
  validateBaaVerificationRequest,
  isSafeRuntimeLinkUrl
};
