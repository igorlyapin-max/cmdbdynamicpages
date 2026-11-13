import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_ASSISTANT_DIAGNOSTICS = Object.freeze({
  captureDurationSec: 900,
  retentionSec: 86400,
  maxBodyBytes: 8388608,
  maxTraceBytes: 33554432,
  maxStoredBytes: 268435456
});

function positive(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function normalizeAssistantDiagnosticsPolicy(input = {}, caps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const limits = caps && typeof caps === 'object' ? caps : {};
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_ASSISTANT_DIAGNOSTICS)) {
    const defaultCap = key === 'captureDurationSec' ? 3600 : key === 'retentionSec' ? 604800 : fallback;
    result[key] = Math.min(positive(source[key], fallback), positive(limits[key], defaultCap));
  }
  result.maxTraceBytes = Math.min(result.maxTraceBytes, result.maxStoredBytes);
  result.maxBodyBytes = Math.min(result.maxBodyBytes, result.maxTraceBytes);
  return result;
}

const MASK = '[REDACTED]';
const OMITTED = '[OMITTED]';
const sensitiveKey = /^(?:.*authorization|cookie|setcookie|.*password.*|.*passwd.*|.*credential.*|.*secret.*|.*privatekey.*|.*apikey.*|.*token.*|.*csrf.*|.*xsrf.*|.*resumeid|.*sessionid|.*sessionkey)$/i;
const compactKey = (key) => key.replace(/[^a-z0-9]/gi, '');
const usageTokenKey = /^(?:token|tokens|max(?:completion)?tokens|prompttokens|completiontokens|totaltokens|inputtokens|outputtokens|cachedtokens|reasoningtokens)$/i;
const usageContext = /^(?:usage|usageMetadata|tokenUsage|prompt_tokens_details|completion_tokens_details|input_tokens_details|output_tokens_details)$/i;
export const isAssistantCredentialKey = (key) => sensitiveKey.test(compactKey(String(key)));

// Scan field boundaries without requiring a complete JSON document. A broken secret
// value consumes the remainder rather than exposing its unclosed tail.
function redactMalformedFields(input) {
  const field = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[a-zA-Z_][a-zA-Z0-9_.-]*)\s*[:=,]\s*/g;
  const descriptor = /["']?name["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi;
  let hasCredentialDescriptor = false;
  for (const match of input.matchAll(descriptor)) {
    let name = match[1].slice(1, -1);
    try { if (match[1].startsWith('"')) name = JSON.parse(match[1]); } catch { /* The field scanner still handles other credentials. */ }
    hasCredentialDescriptor ||= isAssistantCredentialKey(name);
  }
  let result = '';
  let cursor = 0;
  let match;
  while ((match = field.exec(input))) {
    const raw = match[0].replace(/\s*[:=,]\s*$/, '');
    let key = raw;
    try { key = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'|'$/g, ''); } catch { /* Treat undecodable key conservatively below. */ }
    const credential = isAssistantCredentialKey(key) || (hasCredentialDescriptor && compactKey(key) === 'value');
    const start = field.lastIndex;
    let end = start;
    const quote = input[start];
    if (quote === '"' || quote === "'") {
      end++;
      while (end < input.length) {
        if (input[end] === '\\') { end += 2; continue; }
        if (input[end++] === quote) break;
      }
    } else if (quote === '{' || quote === '[') {
      if (!credential) continue;
      // Invalid nested credential values are not useful diagnostic content.
      end = input.length;
    } else {
      while (end < input.length && !/[\s&,;}\]<>]/.test(input[end])) end++;
    }
    // Do not interpret a quoted descriptor value as the next field's key.
    if (!credential) { field.lastIndex = Math.min(end, input.length); continue; }
    result += input.slice(cursor, start) + JSON.stringify(MASK);
    cursor = Math.min(end, input.length);
    field.lastIndex = cursor;
  }
  return result + input.slice(cursor);
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const isTraceId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function redactAssistantDiagnosticValue(value, { secretValues = [], maxBytes = 8388608 } = {}) {
  const secrets = (Array.isArray(secretValues) ? secretValues : []).filter((item) => typeof item === 'string' && item.length > 0).sort((a, b) => b.length - a.length);
  const seen = new WeakSet();
  let redacted = false;
  let actualBytes = 0;
  const cleanString = (input) => {
    let output = redactMalformedFields(input);
    for (const secret of secrets) output = output.split(secret).join(MASK);
    output = output
      .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, MASK)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.%~:-]+/gi, MASK)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MASK)
      .replace(/\b(?:sk-|sk_live_|sk_test_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/g, MASK)
      .replace(/(\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|resume[_-]?id|(?:x[_-]?)?(?:csrf|xsrf)(?:[_-]?(?:token|key))?|token)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;<>]+)/gi, `$1${MASK}`)
      .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]+/gi, `$1${MASK}`)
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`);
    if (output !== input) redacted = true;
    return output;
  };
  const visit = (item, depth = 0, path = []) => {
    if (depth > 64) { redacted = true; return '[DEPTH OMITTED]'; }
    if (typeof item === 'string') {
      // JSON response text still needs field-aware redaction; invalid/plain text is preserved.
      try {
        const parsed = JSON.parse(item);
        if (parsed && typeof parsed === 'object') return JSON.stringify(visit(parsed, depth + 1, path));
      } catch { /* Plain provider output is intentionally retained. */ }
      return cleanString(item);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (!item || typeof item !== 'object') return String(item ?? '');
    if (seen.has(item)) return '[CIRCULAR]';
    seen.add(item);
    let output;
    if (Array.isArray(item)) {
      output = item.length === 2 && typeof item[0] === 'string' && sensitiveKey.test(compactKey(item[0]))
        ? [cleanString(item[0]), MASK] : item.map((entry) => visit(entry, depth + 1, path));
      if (output[1] === MASK) redacted = true;
    } else {
      output = Object.create(null);
      const headerDescriptor = typeof item.name === 'string' && sensitiveKey.test(compactKey(item.name));
      for (const [key, entry] of Object.entries(item)) {
        const safeKey = cleanString(key);
        // This credential-shaped setting contains numeric evidence, not free-form metadata.
        if (key === 'maxTokens' && path.at(-1) === 'limits' && (path.length === 1 || path.at(-2) === 'metadata') &&
            entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const detail = Object.create(null);
          for (const field of ['rawConfigured', 'configuredLimit', 'effectiveLimit', 'requested', 'limit', 'absoluteCap']) {
            if (Object.hasOwn(entry, field) && typeof entry[field] === 'number' && Number.isFinite(entry[field])) detail[field] = entry[field];
          }
          if (typeof entry.clamped === 'boolean') detail.clamped = entry.clamped;
          if (entry.clampedBy === '' || entry.clampedBy === 'CMDP_ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE') detail.clampedBy = entry.clampedBy;
          output[safeKey] = detail;
          redacted ||= Object.keys(detail).length !== Object.keys(entry).length;
          continue;
        }
        const numericUsage = typeof entry === 'number' && Number.isFinite(entry) && usageTokenKey.test(compactKey(key)) &&
          (usageContext.test(path.at(-1) ?? '') || (/^max(?:completion)?tokens$/i.test(compactKey(key)) &&
            (path.length === 0 || /^(?:request|parameters|metadata|generation|generationSettings)$/i.test(path.at(-1)))));
        if ((headerDescriptor && key === 'value') || (isAssistantCredentialKey(key) && !numericUsage)) { output[safeKey] = MASK; redacted = true; }
        else output[safeKey] = visit(entry, depth + 1, [...path, key]);
      }
    }
    seen.delete(item);
    return output;
  };
  try { actualBytes = bytes(value); } catch { actualBytes = 0; }
  let safe = visit(value);
  const limit = positive(maxBytes, DEFAULT_ASSISTANT_DIAGNOSTICS.maxBodyBytes);
  const truncated = bytes(safe) > limit;
  if (truncated) {
    if (typeof safe === 'string') {
      // Binary search keeps valid Unicode and includes JSON escaping in the byte budget.
      let low = 0;
      let high = Math.min(safe.length, limit);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (bytes(safe.slice(0, mid)) <= limit) low = mid; else high = mid - 1;
      }
      safe = safe.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
      if (limit < 2) safe = 0;
    } else safe = limit >= bytes(OMITTED) ? OMITTED : 0;
  }
  return { value: safe, actualBytes, storedBytes: bytes(safe), truncated, redacted };
}

// Redis serializes control changes and trace writes, including every lifecycle check.
const STORAGE_LUA = `
local op = ARGV[1]
local now = tonumber(ARGV[2])
local epoch = redis.call('GET', KEYS[4]) or '0'
local raw = redis.call('GET', KEYS[3])
local capture = nil
if raw then
  local ok, value = pcall(cjson.decode, raw)
  if ok and type(value) == 'table' then capture = value end
end
local active = capture and (capture.mode == 'Basic' or capture.mode == 'Verbose')
  and type(capture.activeUntilMs) == 'number' and capture.activeUntilMs > now
  and type(capture.captureGeneration) == 'string'
if op == 'activate' then
  capture = cjson.decode(ARGV[4])
  redis.call('SET', KEYS[3], ARGV[4], 'PX', math.ceil(capture.activeUntilMs - now))
  redis.call('ZADD', KEYS[5], capture.activeUntilMs, ARGV[3])
elseif op == 'stop' then
  redis.call('DEL', KEYS[3])
  redis.call('ZREM', KEYS[5], ARGV[3])
end
local records = redis.call('ZRANGE', KEYS[1], 0, -1)
local total = 0
local live = {}
for _, key in ipairs(records) do
  local size = redis.call('STRLEN', key)
  if size > 0 then total = total + size; table.insert(live, {key, size})
  else redis.call('ZREM', KEYS[1], key) end
end
if op == 'clear' then
  epoch = tostring(redis.call('INCR', KEYS[4]))
  for _, entry in ipairs(live) do redis.call('DEL', entry[1]) end
  redis.call('DEL', KEYS[1], KEYS[2])
  return {#live, epoch}
end
if op == 'status' or op == 'activate' or op == 'stop' then
  return {#live, total, redis.call('GET', KEYS[2]) or (#live == 0 and '0' or false),
    redis.call('GET', KEYS[3]) or false, epoch}
end
if op == 'begin' or op == 'save' then
  local document = cjson.decode(ARGV[4])
  local trace = document.trace
  local started = tonumber(ARGV[8])
  local expires = tonumber(ARGV[9])
  local function reject(reason) return {0, 0, total, 0, reason} end
  if tostring(trace.storageEpoch) ~= epoch then return reject('storage_epoch') end
  if not started or not expires or expires <= now or started > now or expires <= started
    or expires > started + tonumber(ARGV[7]) * 1000 then return reject('deadline') end
  local previous = redis.call('GET', KEYS[6])
  if op == 'begin' then
    if not active or capture.captureGeneration ~= trace.captureGeneration then return reject('capture_inactive') end
    if previous then return reject('already_registered') end
  else
    if not previous or redis.call('PTTL', KEYS[6]) <= 0 then return reject('missing') end
    local ok, prior = pcall(cjson.decode, previous)
    if not ok or not prior.trace or prior.trace.captureGeneration ~= trace.captureGeneration
      or prior.trace.storageEpoch ~= trace.storageEpoch or prior.trace.startedAt ~= trace.startedAt
      or prior.trace.expiresAt ~= trace.expiresAt then return reject('registration_mismatch') end
  end
  local size = string.len(ARGV[4])
  local maximum = tonumber(ARGV[5])
  if size > maximum or size > tonumber(ARGV[6]) then return reject('quota') end
  local priorSize = previous and string.len(previous) or 0
  total = total - priorSize
  local evicted = 0
  for _, entry in ipairs(live) do
    if total + size <= maximum then break end
    if entry[1] ~= KEYS[6] then
      redis.call('DEL', entry[1]); redis.call('ZREM', KEYS[1], entry[1])
      total = total - entry[2]; evicted = evicted + 1
    end
  end
  if op == 'save' then redis.call('SET', KEYS[6], ARGV[4], 'XX', 'KEEPTTL')
  else
    redis.call('SET', KEYS[6], ARGV[4], 'NX', 'PX', math.ceil(expires - now))
    local tail = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    redis.call('ZADD', KEYS[1], #tail > 0 and tonumber(tail[2]) + 1 or 1, KEYS[6])
  end
  local ttl = redis.call('PTTL', KEYS[6])
  if redis.call('PTTL', KEYS[1]) < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
  local counter = redis.call('GET', KEYS[2])
  if counter or #live == 0 then
    if not counter then redis.call('SET', KEYS[2], '0') end
    if evicted > 0 then redis.call('INCRBY', KEYS[2], evicted) end
    redis.call('PEXPIRE', KEYS[2], redis.call('PTTL', KEYS[1]))
  end
  return {1, evicted, total + size, previous and 1 or 0, 'stored'}
end
if op == 'list' then
  local result = {}
  for i = #live, 1, -1 do
    local document = cjson.decode(redis.call('GET', live[i][1]))
    local summary = document.summary
    if (ARGV[3] == '' or summary.requestId == ARGV[3]) and (ARGV[4] == '' or summary.templateCode == ARGV[4]) then
      table.insert(result, cjson.encode(summary))
      if #result >= tonumber(ARGV[5]) then break end
    end
  end
  return result
end
`;

export function createAssistantDiagnosticsStore({ redisCommand, keyPrefix = 'cmdp', now = Date.now, onEvent = () => {} } = {}) {
  if (typeof redisCommand !== 'function') throw new TypeError('redisCommand is required');
  const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
  const namespace = (root) => `${hash(keyPrefix).slice(0, 16)}:assistant-diagnostics:{${hash(root)}}`;
  const registry = `${hash(keyPrefix).slice(0, 16)}:assistant-diagnostics:active`;
  const keys = (root, id = '') => {
    const base = namespace(root);
    return [`${base}:index`, `${base}:evictions`, `${base}:capture`, `${base}:epoch`, registry, `${base}:trace:${id}`];
  };
  const evaluate = (root, op, args = [], id) => redisCommand(['EVAL', STORAGE_LUA, 6, ...keys(root, id), op, now(), ...args]);
  const emit = async (event, details = {}) => {
    // Audit contains only opaque UUIDs and numeric/enum metadata, never root/actor/payload.
    try { await onEvent({ event: `assistant_diagnostics_${event}`, ...details }); } catch { /* Audit failure must not alter a committed operation. */ }
  };
  const numericPolicy = (input) => normalizeAssistantDiagnosticsPolicy(input, {
    maxBodyBytes: input?.maxBodyBytes,
    maxTraceBytes: input?.maxTraceBytes,
    maxStoredBytes: input?.maxStoredBytes
  });
  const decodeStatus = (stats) => {
    const raw = stats[3];
    let saved;
    try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
    const active = saved && ['Basic', 'Verbose'].includes(saved.mode) && Number.isFinite(saved.activeUntilMs) &&
      saved.activeUntilMs > now() && isTraceId(saved.captureGeneration);
    return { mode: active ? saved.mode : 'Off', activeUntil: active ? new Date(saved.activeUntilMs).toISOString() : null,
      policy: saved ? numericPolicy(saved.policy) : { ...DEFAULT_ASSISTANT_DIAGNOSTICS },
      recordCount: Number(stats[0]), storedBytes: Number(stats[1]),
      evictedCount: stats[2] == null ? null : Number(stats[2]),
      captureGeneration: active ? saved.captureGeneration : null, storageEpoch: Number(stats[4]) };
  };
  const status = async (root) => decodeStatus(await evaluate(root, 'status'));
  return {
    status,
    async activeCaptures() {
      await redisCommand(['ZREMRANGEBYSCORE', registry, '-inf', now()]);
      const roots = await redisCommand(['ZRANGE', registry, 0, -1]);
      const result = [];
      for (const root of roots) {
        const metadata = await status(root);
        if (metadata.mode !== 'Off') result.push({ root, ...metadata });
      }
      return result;
    },
    async activate(root, { mode, durationSec, policy, actor: _actor } = {}) {
      if (mode === 'Off') return this.stop(root);
      if (mode !== 'Basic' && mode !== 'Verbose') throw new TypeError('mode must be Off, Basic or Verbose');
      const effective = numericPolicy(policy);
      const duration = Math.min(positive(durationSec, effective.captureDurationSec), effective.captureDurationSec, 3600);
      const activeUntilMs = now() + duration * 1000;
      const result = decodeStatus(await evaluate(root, 'activate', [root,
        JSON.stringify({ mode, activeUntilMs, policy: effective, captureGeneration: randomUUID() })]));
      await emit('activated', { mode, durationSec: duration });
      return result;
    },
    async stop(root) {
      const result = decodeStatus(await evaluate(root, 'stop', [root]));
      await emit('stopped');
      return result;
    },
    begin(root, trace, policy = {}) { return this.write(root, trace, policy, 'begin'); },
    save(root, trace, policy = {}) { return this.write(root, trace, policy, 'save'); },
    async write(root, trace, policy = {}, operation) {
      const effective = numericPolicy(policy);
      const id = isTraceId(trace?.id) ? trace.id.toLowerCase() : null;
      const date = (value) => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
      const startedAt = date(trace?.startedAt);
      const expiresAt = date(trace?.expiresAt);
      if (!id || !isTraceId(trace?.captureGeneration) || !Number.isSafeInteger(trace?.storageEpoch) || trace.storageEpoch < 0 ||
        !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(expiresAt)) return { stored: false, reason: 'invalid_metadata' };
      const secretValues = [...(Array.isArray(policy.secretValues) ? policy.secretValues : []), ...(Array.isArray(trace?.secretValues) ? trace.secretValues : [])];
      const source = { ...trace };
      delete source.secretValues;
      // Redact before clipping or issuing any write; even metadata and unknown trace fields are untrusted.
      const cleaned = redactAssistantDiagnosticValue(source, { secretValues, maxBytes: Number.MAX_SAFE_INTEGER });
      let safe = cleaned.value;
      if (!safe || typeof safe !== 'object' || Array.isArray(safe)) safe = {};
      safe.id = id;
      safe.traceId = id;
      const bodySizes = [];
      if (Array.isArray(safe.spans)) {
        for (const [index, span] of safe.spans.entries()) {
          if (!span || typeof span !== 'object') continue;
          for (const field of ['request', 'response']) {
            if (!(field in span)) continue;
            const previous = source.spans?.[index]?.[field] ?? span[field];
            const isEnvelope = previous && typeof previous === 'object' && 'value' in previous &&
              typeof previous.actualBytes === 'number' && typeof previous.truncated === 'boolean' && typeof previous.redacted === 'boolean';
            const envelope = redactAssistantDiagnosticValue(isEnvelope ? previous.value : previous, { secretValues, maxBytes: effective.maxBodyBytes });
            if (isEnvelope) {
              envelope.actualBytes = Math.max(envelope.actualBytes, previous.actualBytes);
              envelope.truncated ||= previous.truncated;
              envelope.redacted ||= previous.redacted;
            }
            span[field] = envelope;
            bodySizes.push(envelope);
          }
        }
      }
      safe.diagnostics = { actualBytes: cleaned.actualBytes, redacted: cleaned.redacted || bodySizes.some((body) => body.redacted),
        truncated: bodySizes.some((body) => body.truncated), omitted: false };
      const summary = { id, traceId: id };
      for (const field of ['requestId', 'templateCode', 'action', 'mode', 'startedAt', 'finishedAt', 'statusCode', 'status']) {
        const value = safe[field];
        if (typeof value === 'string') summary[field] = value.slice(0, 256);
        else if (typeof value === 'number' && Number.isFinite(value)) summary[field] = value;
      }
      let serialized = JSON.stringify({ trace: safe, summary });
      if (Buffer.byteLength(serialized) > effective.maxTraceBytes) {
        safe = { ...summary, captureGeneration: trace.captureGeneration, storageEpoch: trace.storageEpoch,
          startedAt: trace.startedAt, expiresAt: trace.expiresAt,
          diagnostics: { ...safe.diagnostics, truncated: true, omitted: true, reason: 'maxTraceBytes' } };
        serialized = JSON.stringify({ trace: safe, summary });
      }
      const storedBytes = Buffer.byteLength(serialized);
      if (storedBytes > effective.maxTraceBytes || storedBytes > effective.maxStoredBytes) {
        await emit('rejected', { id, storedBytes });
        return { stored: false, id, traceId: id, storedBytes: 0, evictedCount: 0, reason: 'quota' };
      }
      const result = await evaluate(root, operation, ['', serialized, effective.maxStoredBytes, effective.maxTraceBytes,
        effective.retentionSec, startedAt, expiresAt], id);
      const stored = Number(result[0]) === 1;
      const evictedCount = Number(result[1]);
      await emit(stored ? 'saved' : 'rejected', { id, storedBytes: stored ? storedBytes : 0, evictedCount });
      return { stored, reason: result[4], id, traceId: id, storedBytes: stored ? storedBytes : 0, evictedCount, totalStoredBytes: Number(result[2]), updated: Number(result[3]) === 1, truncated: safe.diagnostics.truncated, omitted: safe.diagnostics.omitted };
    },
    async list(root, { requestId, templateCode, limit = 20 } = {}) {
      const records = await evaluate(root, 'list', [String(requestId ?? ''), String(templateCode ?? ''), Math.min(positive(limit, 20), 100)]);
      return records.map((record) => JSON.parse(record));
    },
    async get(root, id) {
      if (!isTraceId(id)) return null;
      const raw = await redisCommand(['GET', `${namespace(root)}:trace:${id.toLowerCase()}`]);
      return raw ? JSON.parse(raw).trace : null;
    },
    async clear(root) {
      const result = await evaluate(root, 'clear');
      const clearedCount = Number(result[0]);
      await emit('cleared', { clearedCount });
      return { ...await status(root), clearedCount };
    }
  };
}

export function createAssistantCaptureController({ store, now = Date.now, pollIntervalMs = 1000,
  maxFreshnessMs = 2000, onWarning = () => {} } = {}) {
  if (!store || typeof store.activeCaptures !== 'function') throw new TypeError('store.activeCaptures is required');
  const cache = new Map();
  const revisions = new Map();
  let sequence = 0;
  let latestPoll = 0;
  let lifecycle = 0;
  let timer = null;
  let unavailable = false;
  let registryObservedAt = null;
  let inFlight = null;
  const metadata = (status) => {
    if (!status || !['Off', 'Basic', 'Verbose'].includes(status.mode) ||
      !Number.isSafeInteger(status.storageEpoch) || status.storageEpoch < 0) return null;
    const until = Date.parse(status.activeUntil);
    if (status.mode !== 'Off' && (!isTraceId(status.captureGeneration) || !Number.isFinite(until) || until <= now())) return null;
    return { mode: status.mode, activeUntil: status.activeUntil, policy: normalizeAssistantDiagnosticsPolicy(status.policy, status.policy),
      recordCount: status.recordCount, storedBytes: status.storedBytes, evictedCount: status.evictedCount,
      captureGeneration: status.captureGeneration, storageEpoch: status.storageEpoch };
  };
  const apply = (root, status) => {
    revisions.set(root, ++sequence);
    const value = metadata(status);
    if (value) cache.set(root, { value, observedAt: now() }); else cache.delete(root);
  };
  const poll = async () => {
    const poll = ++sequence;
    latestPoll = poll;
    const started = now();
    const generation = lifecycle;
    try {
      const entries = await store.activeCaptures();
      if (generation !== lifecycle || poll !== latestPoll) return;
      const discovered = new Set();
      for (const { root, ...status } of entries) {
        discovered.add(root);
        if ((revisions.get(root) ?? 0) > poll) continue;
        const value = metadata(status);
        if (value) cache.set(root, { value, observedAt: started }); else cache.delete(root);
      }
      for (const root of cache.keys()) {
        if (!discovered.has(root) && (revisions.get(root) ?? 0) <= poll) cache.delete(root);
      }
      unavailable = false;
      registryObservedAt = started;
    } catch {
      if (generation !== lifecycle || poll !== latestPoll) return;
      registryObservedAt = null;
      for (const root of cache.keys()) if ((revisions.get(root) ?? 0) <= poll) cache.delete(root);
      if (!unavailable) {
        unavailable = true;
        try { onWarning({ code: 'assistant_capture_control_unavailable' }); } catch { /* Warning callbacks cannot break polling. */ }
      }
    }
  };
  const refresh = () => {
    if (inFlight) return inFlight;
    const pending = poll();
    inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = null; });
    return pending;
  };
  return {
    apply, refresh,
    snapshot(root) {
      const entry = cache.get(root);
      const age = entry ? now() - entry.observedAt : Infinity;
      if (!entry) return registryObservedAt !== null && now() >= registryObservedAt &&
        now() - registryObservedAt < positive(maxFreshnessMs, 2000) ? { mode: 'Off' } : null;
      if (age < 0 || age >= positive(maxFreshnessMs, 2000)) return null;
      if (entry.value.mode !== 'Off' && Date.parse(entry.value.activeUntil) <= now()) return { ...entry.value, mode: 'Off', activeUntil: null, captureGeneration: null, policy: { ...entry.value.policy } };
      return { ...entry.value, policy: { ...entry.value.policy } };
    },
    start() {
      if (timer) return Promise.resolve();
      timer = setInterval(() => { void refresh(); }, positive(pollIntervalMs, 1000));
      timer.unref?.();
      return refresh();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      lifecycle++;
      cache.clear();
      registryObservedAt = null;
      revisions.clear();
    }
  };
}
