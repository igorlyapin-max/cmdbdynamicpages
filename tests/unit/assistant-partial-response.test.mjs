import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedLiteLlmResponse } from '../../scripts/dev-proxy-server.mjs';

test('bounded response capture retains a limited prefix when the response exceeds its budget', async () => {
  let captured;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial-provider-body')); controller.close(); } }));
  await assert.rejects(readBoundedLiteLlmResponse(response, 7, (text, metadata) => { captured = { text, metadata }; }), { code: 'litellm_response_too_large' });
  assert.equal(captured.text, 'partial');
  assert.equal(captured.metadata.partial, true);
  assert.equal(captured.metadata.readBytes, 21);
});

test('transport failure retains received text without replacing the transport error', async () => {
  const failure = new Error('transport-interrupted');
  let index = 0;
  let captured;
  const response = new Response(new ReadableStream({ pull(controller) { if (index++ === 0) controller.enqueue(new TextEncoder().encode('received prefix')); else controller.error(failure); } }));
  await assert.rejects(readBoundedLiteLlmResponse(response, 1024, (text) => { captured = text; throw new Error('capture-failed'); }), (error) => error === failure);
  assert.equal(captured, 'received prefix');
});

test('complete responses do not invoke partial capture', async () => {
  let called = false;
  assert.equal(await readBoundedLiteLlmResponse(new Response('complete'), 1024, () => { called = true; }), 'complete');
  assert.equal(called, false);
});
