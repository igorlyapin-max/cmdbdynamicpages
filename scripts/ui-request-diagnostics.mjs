// Keep every dependency inside this factory: the client embeds its source.
export function createUiRequestDiagnostics() {
  const encoder = new TextEncoder();
  const excerptLimit = 4096;
  const serializedLimit = 16384;
  const reportLimitCount = 16;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const bytes = (value) => encoder.encode(value).length;
  function clip(value, limit) {
    let result = '';
    let size = 0;
    for (const char of value) {
      const count = bytes(char);
      if (size + count > limit) break;
      result += char;
      size += count;
    }
    return result;
  }
  function text(value, limit = 512) {
    if (typeof value !== 'string') return '';
    return clip(value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, '[REDACTED]')
      .replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '[REDACTED]')
      .replace(/<[^>]+>/g, (tag) => tag.replace(/\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, ''))
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+|\/\/[^\s<>"']+/gi, '[URL]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[REDACTED]')
      .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{16,}\b/g, '[REDACTED]')
      .replace(/(?:["']?\b(?:prompt|spec|request[_ -]?body|stack)\b["']?\s*[:=]\s*)[\s\S]*/gi, '[REDACTED]')
      .replace(/(?:["']?\b(?:authorization|proxy-authorization|set-cookie|cookie|[\w-]*(?:csrf|token|secret|password|api[_-]?key)[\w-]*|prompt|spec|request[_ -]?body|stack)\b["']?\s*[:=]\s*)[^\r\n]*/gi, '[REDACTED]')
      .replace(/(?:\/[A-Za-z0-9_%./~-]*)?[?#][^\s<>"']*/g, '[QUERY]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), limit);
  }
  function path(value) {
    if (typeof value !== 'string' || !value) return '/';
    try {
      const url = new URL(value, 'https://diagnostic.invalid');
      // Encoded delimiters can conceal credentials or query values; fail closed.
      if (/%(?:2f|3f|23|40|5c)|[\\@]/i.test(url.pathname)) return '/';
      return clip(url.pathname.startsWith('/') ? url.pathname : '/', 1024);
    } catch { return '/'; }
  }
  const stringFields = [
    'code', 'kind', 'message', 'reason', 'reasonCode', 'stage', 'blockName', 'blockId', 'className', 'limitName', 'settingPath',
    'comparisonBlockId', 'candidateBlockId', 'sourceBlockId', 'targetBlockId',
    'sourceClass', 'comparisonClass', 'relatedClass', 'targetClass', 'outputClass', 'terminalClass',
    'sourceRoot', 'targetRoot', 'domain', 'direction', 'predicateType', 'invalidField',
    'path', 'field', 'fieldName', 'sourceField', 'comparisonField', 'relatedField',
    'operator', 'expectedOperator', 'type', 'expectedType', 'actualType', 'clampedBy', 'source', 'tool',
    'alias', 'as', 'from', 'with', 'expectedAlias', 'publishedAlias', 'sourceAlias', 'targetAlias', 'comparisonAlias',
    'responseFormat', 'finish_reason'
  ];
  const numberFields = [
    'limit', 'effectiveLimit', 'configuredLimit', 'rawConfigured', 'requiredCount', 'actualCount', 'count', 'fetched', 'visible',
    'timeoutMs', 'durationMs', 'elapsedMs', 'maxBytes', 'actualBytes', 'restCalls', 'status', 'statusCode',
    'predicateIndex', 'index', 'min', 'max', 'maximum', 'configured', 'observed',
    'maxLength', 'actualLength', 'maxItems', 'actualItems', 'maxDepth', 'depth', 'requested', 'absoluteCap',
    'upstreamStatus', 'maxTokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'beforeBytes', 'afterBytes', 'beforeClasses', 'afterClasses',
    'rows', 'filterCount', 'returned'
  ];
  const identifierArrays = [
    'classNames', 'sourceFields', 'comparisonFields', 'availableDependencyIds',
    'supportedOperators', 'allowedOperators', 'supportedTypes', 'supported', 'aliases', 'availableAliases',
    'sourceEndpoint', 'targetEndpoint'
  ];
  const booleanFields = ['timeout', 'truncated', 'limitHit', 'exceeded', 'retryable', 'classContextLimited', 'clamped', 'canApply'];
  function fields(input, depth = 0, publication = false) {
    const source = object(input);
    const result = {};
    for (const key of stringFields) if (typeof source[key] === 'string') result[key] = text(source[key]);
    for (const key of ['expectedSpecHash', 'currentSpecHash']) {
      if (typeof source[key] === 'string' && /^[0-9a-f]{64}$/i.test(source[key])) result[key] = source[key];
    }
    for (const key of numberFields) if (finite(source[key])) result[key] = source[key];
    for (const key of booleanFields) if (typeof source[key] === 'boolean') result[key] = source[key];
    for (const key of identifierArrays) {
      if (Array.isArray(source[key])) result[key] = source[key].filter((item) => typeof item === 'string').slice(0, 16).map((item) => text(item));
    }
    if (depth < 2) {
      for (const key of ['limits', 'errors', 'details', 'causes', 'steps']) {
        if (!Array.isArray(source[key])) continue;
        result[key] = publication && key === 'limits'
          ? source[key].slice(0, reportLimitCount).map(reportLimitFields).filter(Boolean)
          : source[key].slice(0, 16).map((item) => fields(item, depth + 1));
      }
      if (publication) {
        const overflow = Array.isArray(source.limits) ? Math.max(0, source.limits.length - reportLimitCount) : 0;
        const count = Number.isSafeInteger(source.omittedCount) && source.omittedCount >= 0 ? source.omittedCount : null;
        if (count !== null || overflow) result.omittedCount = Math.min(Number.MAX_SAFE_INTEGER, (count ?? 0) + overflow);
      }
      for (const key of ['limit', 'catalogCompleteness', 'mcp', 'objectFlow', 'semanticContext', 'rootCause', 'llm', 'usage', 'contextAssembly']) {
        if (source[key] && typeof source[key] === 'object') result[key] = fields(source[key], depth + 1);
      }
      // Schema/reference paths can be identifier lists or bounded relation hops.
      for (const key of ['paths', 'sourcePath', 'comparisonPath', 'dependencyPaths', 'hops']) {
        if (typeof source[key] === 'string') result[key] = text(source[key]);
        else if (Array.isArray(source[key])) result[key] = source[key].slice(0, 16)
          .filter((item) => typeof item === 'string' || item !== null && typeof item === 'object' && !Array.isArray(item))
          .map((item) => typeof item === 'string' ? text(item) : fields(item, depth + 1));
      }
    }
    return result;
  }
  function isPublicationRequest(phase) {
    return phase === 'publish' || phase === 'refresh-snapshot';
  }
  function reportLimitFields(input) {
    const source = object(input);
    if (typeof source.table !== 'string' ||
        !['selector', 'rows', 'index', 'commit'].includes(source.phase) ||
        !['limit_exceeded', 'completeness_unconfirmed', 'deadline_exceeded', 'row_limit_configuration_conflict'].includes(source.reason)) return null;
    const item = { phase: source.phase, reason: source.reason };
    for (const key of ['table', 'stepAlias', 'stepType', 'limitName', 'configKey', 'sourceAlias', 'sourceLabel', 'stepLabel']) {
      if (typeof source[key] !== 'string') continue;
      const max = ['table', 'stepAlias', 'sourceAlias', 'sourceLabel', 'stepLabel'].includes(key) ? 128 : 64;
      const label = text(source[key], max).replace(/\s+/g, ' ').trim();
      // Budget encoded JSON too, so escaped characters cannot crowd out other entries.
      item[key] = bytes(JSON.stringify(label)) <= max + 2 ? label : clip(label, max / 2);
    }
    if (['runtime-settings', 'object-flow-step', 'product', 'upstream'].includes(source.source)) item.source = source.source;
    if (['ordinary', 'paged'].includes(source.rowLimitMode)) item.rowLimitMode = source.rowLimitMode;
    if (Array.isArray(source.rowLimitCauses)) {
      item.rowLimitCauses = ['stepLimit', 'runtimeMaximum', 'ordinaryCeiling', 'pagedCeiling'].filter((cause) => source.rowLimitCauses.includes(cause));
    }
    for (const key of ['canUseLargeTable', 'usedByDiagram']) if (typeof source[key] === 'boolean') item[key] = source[key];
    if (['cards', 'relations', 'calls', 'rows', 'memberships', 'bytes', 'classes', 'domains', 'milliseconds', 'hops', 'checks'].includes(source.unit)) item.unit = source.unit;
    if (Number.isSafeInteger(source.stepIndex) && source.stepIndex >= 0) item.stepIndex = source.stepIndex;
    for (const key of ['requested', 'effectiveLimit', 'observed', 'total', 'elapsedMs']) {
      if (finite(source[key]) && source[key] >= 0) item[key] = source[key];
    }
    for (const key of ['limitHit', 'truncated', 'timeout']) if (typeof source[key] === 'boolean') item[key] = source[key];
    return item;
  }
  function iso(value) {
    if (typeof value !== 'string' && !finite(value)) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  function checkpoint(input) {
    const source = object(input);
    const confirmed = source.confirmed === true;
    return { confirmed, stage: confirmed ? text(source.stage, 128) : '', expiresAt: confirmed ? iso(source.expiresAt) : null };
  }
  function sanitize(input) {
    const source = object(input);
    const owner = object(source.owner);
    const publication = isPublicationRequest(source.phase);
    const result = {
      time: iso(source.time),
      action: text(source.action, 128), phase: text(source.phase, 128), blockName: text(source.blockName),
      path: path(source.path), method: /^[A-Z]{1,16}$/.test(source.method) ? source.method : 'GET',
      status: Number.isInteger(source.status) && source.status >= 100 && source.status <= 599 ? source.status : null,
      durationMs: finite(source.durationMs) ? Math.max(0, source.durationMs) : null,
      clientTimeoutMs: finite(source.clientTimeoutMs) ? Math.max(0, source.clientTimeoutMs) : null,
      attempt: Number.isSafeInteger(source.attempt) && source.attempt > 0 ? source.attempt : 1,
      clientRequestId: text(source.clientRequestId, 128), serverRequestId: text(source.serverRequestId, 128),
      code: text(source.code, 128), message: text(source.message),
      contentType: typeof source.contentType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(source.contentType.split(';')[0].trim())
        ? source.contentType.split(';')[0].trim().toLowerCase() : '',
      responseFormat: ['json', 'html', 'text', 'invalid_json', 'empty', 'none'].includes(source.responseFormat) ? source.responseFormat : 'none',
      responseExcerpt: text(source.responseExcerpt, excerptLimit),
      errors: Array.isArray(source.errors) ? source.errors.slice(0, 16).map((item) => fields(item)) : [],
      diagnostics: fields(source.diagnostics, 0, publication),
      checkpoint: checkpoint(source.checkpoint), retryable: source.retryable === true,
      owner: {
        ...(typeof owner.root === 'string' ? { root: text(owner.root, 128) } : {}),
        ...(Number.isSafeInteger(owner.rootSelectionGeneration) ? { rootSelectionGeneration: owner.rootSelectionGeneration } : {}),
        ...(Number.isSafeInteger(owner.editorInstance) ? { editorInstance: owner.editorInstance } : {}),
        ...(Number.isSafeInteger(owner.sessionInstance) ? { sessionInstance: owner.sessionInstance } : {}),
        templateCode: text(owner.templateCode, 128), section: text(owner.section, 128),
        ...(owner.displaySection ? { displaySection: text(owner.displaySection, 128) } : {}),
        generation: Number.isSafeInteger(owner.generation) ? owner.generation : null,
        revision: finite(owner.revision) ? owner.revision : null
      },
      truncated: source.truncated === true
    };
    const trace = object(source.assistantTrace);
    const limits = object(source.diagnostics).limits;
    if (publication && Array.isArray(limits) && limits.length > reportLimitCount) result.truncated = true;
    if (typeof source.requestSent === 'boolean') result.requestSent = source.requestSent;
    if (typeof trace.traceId === 'string' || typeof trace.warning === 'string') {
      result.assistantTrace = {};
      for (const key of ['traceId', 'requestId', 'status', 'storageStatus', 'warning']) {
        if (typeof trace[key] === 'string') result.assistantTrace[key] = text(trace[key], key === 'warning' ? 512 : 128);
      }
      if (['Basic', 'Verbose'].includes(trace.mode)) result.assistantTrace.mode = trace.mode;
    }
    if (typeof source.responseExcerpt === 'string' && bytes(source.responseExcerpt) > excerptLimit) result.truncated = true;
    return result;
  }
  function base(context) {
    const source = object(context);
    const now = Date.now();
    return {
      path: source.path, requestId: source.requestId, owner: source.owner,
      action: source.action, phase: source.phase, blockName: source.blockName, attempt: source.attempt,
      time: new Date(now).toISOString(),
      method: typeof source.method === 'string' ? source.method.toUpperCase() : 'GET',
      durationMs: finite(source.startedAt) ? Math.max(0, now - source.startedAt) : null,
      clientTimeoutMs: source.timeoutMs, clientRequestId: source.requestId, requestSent: source.requestSent
    };
  }
  function response(result, context) {
    const source = object(result);
    const body = typeof source.body === 'string' ? source.body : '';
    let payload = source.json;
    let format = 'json';
    if (payload === undefined || payload === null) {
      if (!body.trim()) format = 'empty';
      else {
        try { payload = JSON.parse(body); }
        catch {
          format = /html/i.test(source.contentType || '') || /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(body) ? 'html'
            : /json/i.test(source.contentType || '') || /^\s*[{[]/.test(body) ? 'invalid_json' : 'text';
        }
      }
    }
    const data = object(payload);
    const error = object(data.error);
    const resume = object(data.resume);
    const confirmed = typeof resume.resumeId === 'string' && resume.resumeId.length > 0 && typeof resume.stage === 'string' && resume.stage.length > 0 && iso(resume.expiresAt) !== null;
    const diagnostic = {
      ...base(context), status: source.status,
      contentType: source.contentType,
      serverRequestId: isPublicationRequest(context?.phase) ? source.serverRequestId || data.requestId || ''
        : source.serverRequestId !== undefined ? source.serverRequestId : source.requestId || data.requestId,
      code: data.code || error.code || (source.ok ? '' : 'http_error'),
      message: data.message || error.message || (typeof data.error === 'string' ? data.error : '') || (source.ok ? '' : 'Request failed'),
      responseFormat: format,
      errors: data.errors, diagnostics: data.diagnostics,
      assistantTrace: object(data.diagnostics).assistantTrace,
      checkpoint: { confirmed, stage: resume.stage, expiresAt: resume.expiresAt },
      retryable: typeof data.retryable === 'boolean' ? data.retryable : [408, 429, 502, 503, 504].includes(source.status)
    };
    // JSON excerpts contain approved diagnostics only, never the original payload.
    const safe = sanitize(diagnostic);
    const excerptDiagnostics = { ...safe.diagnostics };
    if (isPublicationRequest(safe.phase)) delete excerptDiagnostics.limits;
    const excerpt = format === 'json' ? JSON.stringify({ code: safe.code, message: safe.message, errors: safe.errors, diagnostics: excerptDiagnostics })
      : text(body, excerptLimit + 4);
    safe.responseExcerpt = text(excerpt, excerptLimit);
    safe.truncated ||= bytes(excerpt) > excerptLimit || (format !== 'json' && bytes(body) > excerptLimit);
    return safe;
  }
  function exception(error, context) {
    if (error && error.diagnostic && typeof error.diagnostic === 'object') return sanitize(error.diagnostic);
    const source = object(error);
    const timeout = source.name === 'TimeoutError' || source.code === 'request_timeout';
    const cancelled = !timeout && (source.name === 'AbortError' || source.code === 'request_cancelled');
    return sanitize({
      ...base(context), status: null, responseFormat: 'none',
      code: timeout ? 'request_timeout' : cancelled ? 'request_cancelled' : 'network_error',
      message: timeout ? 'Client request timed out' : cancelled ? 'Request cancelled' : 'Network request failed',
      retryable: !cancelled
    });
  }
  function serialize(diagnostic) {
    const safe = sanitize(diagnostic);
    let serialized = JSON.stringify(safe, null, 2);
    if (bytes(serialized) <= serializedLimit) return serialized;
    safe.truncated = true;
    if (isPublicationRequest(safe.phase) && (safe.diagnostics.limits?.length || safe.diagnostics.omittedCount !== undefined)) {
      safe.responseExcerpt = '';
      safe.errors = [];
      const { limits, omittedCount } = safe.diagnostics;
      safe.diagnostics = { limits, omittedCount };
      serialized = JSON.stringify(safe, null, 2);
      if (bytes(serialized) <= serializedLimit) return serialized;
      serialized = JSON.stringify(safe);
      if (bytes(serialized) <= serializedLimit) return serialized;
      for (const key of ['assistantTrace', 'message', 'contentType', 'blockName', 'owner']) delete safe[key];
      serialized = JSON.stringify(safe);
      if (bytes(serialized) <= serializedLimit) return serialized;
    }
    // Drop optional detail before identity/context, retaining a valid JSON envelope.
    for (const key of ['responseExcerpt', 'diagnostics', 'errors']) {
      safe[key] = key === 'responseExcerpt' ? '' : key === 'errors' ? [] : {};
      serialized = JSON.stringify(safe, null, 2);
      if (bytes(serialized) <= serializedLimit) return serialized;
    }
    return serialized;
  }
  return { response, exception, sanitize, serialize };
}
