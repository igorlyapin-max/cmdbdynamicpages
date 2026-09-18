import { readFileSync, statSync } from 'node:fs';

const providerError = (code) => Object.assign(new Error(code), { code });

export function createCompletionAdapter({ env = process.env, fetchImpl = fetch } = {}) {
  const base = new URL(env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw providerError('invalid_provider_configuration');
  }
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw providerError('insecure_provider_configuration');
  }
  let key = String(env.LITELLM_API_KEY || '').trim();
  if (!key && env.LITELLM_API_KEY_FILE) {
    const info = statSync(env.LITELLM_API_KEY_FILE);
    if (!info.isFile() || info.size > 65536) throw providerError('invalid_secret_file');
    key = readFileSync(env.LITELLM_API_KEY_FILE, 'utf8').trim();
  }
  if (!key) throw providerError('missing_provider_key');
  const endpoint = new URL(base.href.replace(/\/$/, '') + '/chat/completions');
  return async function complete({ model, messages, maxOutputTokens, signal, temperature = 0.1 }) {
    const response = await fetchImpl(endpoint, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw providerError('provider_http_error');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 262144) {
          await reader.cancel();
          throw providerError('response_limit');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw providerError('invalid_json'); }
    if (body.choices?.[0]?.finish_reason === 'length') throw providerError('output_truncated');
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw providerError('invalid_provider_response');
    // The proxy may return the underlying revision instead of its configured alias.
    return { content, providerModel: body.model || null,
      usage: body.usage ? { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens } : null };
  };
}

let adapter;
export async function complete(request) {
  adapter ||= createCompletionAdapter();
  return adapter(request);
}
