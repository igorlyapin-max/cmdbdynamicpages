import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionAdapter } from '../../scripts/assistant-quality-openai.mjs';

const env = { LITELLM_BASE_URL: 'https://model.example/v1', LITELLM_API_KEY: 'unit-test-only' };
const request = { model: 'proxy-alias', messages: [{ role: 'user', content: 'fixture' }],
  maxOutputTokens: 100, signal: new AbortController().signal };

test('quality adapter uses explicit bounds and reports provider usage without secrets', async () => {
  const complete = createCompletionAdapter({ env, fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://model.example/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, request.signal);
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 100);
    assert.equal(body.temperature, 0.1);
    return Response.json({ model: 'revision-123', usage: { prompt_tokens: 20, completion_tokens: 8 },
      choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
  } });
  assert.deepEqual(await complete(request), { content: '{}', providerModel: 'revision-123',
    usage: { inputTokens: 20, outputTokens: 8 } });
});

test('quality adapter redacts HTTP failures and rejects redirects and unsafe endpoints', async () => {
  assert.throws(() => createCompletionAdapter({ env: { ...env, LITELLM_BASE_URL: 'http://remote.example/v1' } }),
    /insecure_provider_configuration/);
  assert.throws(() => createCompletionAdapter({ env: { ...env, LITELLM_BASE_URL: 'https://u:p@remote.example/v1' } }),
    /invalid_provider_configuration/);
  const complete = createCompletionAdapter({ env, fetchImpl: async () => new Response('sensitive diagnostic', { status: 403 }) });
  await assert.rejects(complete(request), (error) => error.message === 'provider_http_error');
});

test('quality adapter rejects oversized and truncated responses', async () => {
  const oversized = createCompletionAdapter({ env, fetchImpl: async () => new Response('x'.repeat(262145)) });
  await assert.rejects(oversized(request), /response_limit/);
  const truncated = createCompletionAdapter({ env, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length' }] }) });
  await assert.rejects(truncated(request), /output_truncated/);
});
