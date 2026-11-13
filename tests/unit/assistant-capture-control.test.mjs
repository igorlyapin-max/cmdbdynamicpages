import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAssistantCaptureController, DEFAULT_ASSISTANT_DIAGNOSTICS } from '../../scripts/assistant-diagnostics.mjs';

const status = (mode = 'Verbose', storageEpoch = 0) => ({ mode, storageEpoch,
  captureGeneration: mode === 'Off' ? null : randomUUID(),
  activeUntil: mode === 'Off' ? null : new Date(100000).toISOString(),
  policy: DEFAULT_ASSISTANT_DIAGNOSTICS, recordCount: 0, storedBytes: 0, evictedCount: 0 });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test('startup discovery, fresh Off, synchronous snapshots, expiry and stale fail closed', async () => {
  let time = 1000;
  const active = status();
  const controller = createAssistantCaptureController({ now: () => time,
    store: { activeCaptures: async () => [{ root: 'r', ...active }] } });
  assert.equal(controller.snapshot('r'), null);
  await controller.start();
  assert.equal(controller.snapshot('r').captureGeneration, active.captureGeneration);
  assert.deepEqual(controller.snapshot('unknown'), { mode: 'Off' });
  const snapshot = controller.snapshot('r');
  snapshot.policy.retentionSec = 1;
  assert.equal(controller.snapshot('r').policy.retentionSec, 86400);
  time += 2000;
  assert.equal(controller.snapshot('r'), null);
  assert.equal(controller.snapshot('unknown'), null);
  controller.apply('r', status('Off', 2));
  assert.equal(controller.snapshot('r').mode, 'Off');
  assert.equal(controller.snapshot('r').storageEpoch, 2);
  controller.apply('r', { ...active, activeUntil: new Date(time + 10).toISOString() });
  time += 11;
  assert.equal(controller.snapshot('r').mode, 'Off');
  controller.stop();
  assert.equal(controller.snapshot('r'), null);
});

test('poll cannot overwrite activate, stop or clear ACK even with identical clock timestamps', async () => {
  for (const ack of [status('Basic'), status('Off'), status('Verbose', 2)]) {
    const pending = deferred();
    const controller = createAssistantCaptureController({ now: () => 1000,
      store: { activeCaptures: () => pending.promise } });
    const refresh = controller.refresh();
    controller.apply('r', ack);
    pending.resolve([{ root: 'r', ...status() }]);
    await refresh;
    assert.equal(controller.snapshot('r').mode, ack.mode);
    assert.equal(controller.snapshot('r').storageEpoch, ack.storageEpoch);
    assert.equal(controller.snapshot('r').captureGeneration, ack.captureGeneration);
    controller.stop();
  }
});

test('overlapping refreshes share one poll, slow-poll freshness and controller-stop generation guard', async () => {
  let time = 1000;
  const first = deferred();
  const second = deferred();
  let count = 0;
  const controller = createAssistantCaptureController({ now: () => time,
    store: { activeCaptures: () => (++count === 1 ? first.promise : second.promise) } });
  const a = controller.refresh();
  const b = controller.refresh();
  assert.equal(a, b);
  assert.equal(count, 1);
  first.resolve([{ root: 'r', ...status() }]);
  await a;
  const next = controller.refresh();
  assert.equal(count, 2);
  const newest = status('Basic', 5);
  second.resolve([{ root: 'r', ...newest }]);
  await next;
  assert.equal(controller.snapshot('r').storageEpoch, 5);
  controller.stop();
  const slow = deferred();
  const delayed = createAssistantCaptureController({ now: () => time, store: { activeCaptures: () => slow.promise } });
  const pending = delayed.refresh();
  time += 2001;
  slow.resolve([{ root: 'r', ...status() }]);
  await pending;
  assert.equal(delayed.snapshot('r'), null);
  delayed.stop();
  const stopped = deferred();
  const guard = createAssistantCaptureController({ now: () => time, store: { activeCaptures: () => stopped.promise } });
  const stoppedRefresh = guard.start();
  guard.stop();
  stopped.resolve([{ root: 'r', ...status() }]);
  await stoppedRefresh;
  assert.equal(guard.snapshot('r'), null);
});

test('default background polling runs every second without accumulating slow requests', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let time = 1000;
  let calls = 0;
  let pending = deferred();
  const controller = createAssistantCaptureController({ now: () => time,
    store: { activeCaptures: () => { calls++; return pending.promise; } } });
  t.after(() => controller.stop());
  const startup = controller.start();
  const active = status();
  pending.resolve([{ root: 'r', ...active }]);
  await startup;
  pending = deferred();
  t.mock.timers.tick(999);
  assert.equal(calls, 1);
  time += 1000;
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  for (let i = 0; i < 10; i++) {
    time += 1000;
    t.mock.timers.tick(1000);
  }
  assert.equal(calls, 2);
  assert.equal(controller.snapshot('r'), null);
  const refresh = controller.refresh();
  pending.resolve([{ root: 'r', ...active }]);
  await refresh;
  assert.equal(controller.snapshot('r'), null);
  pending = deferred();
  t.mock.timers.tick(1000);
  assert.equal(calls, 3);
  const recovery = controller.refresh();
  pending.resolve([{ root: 'r', ...active }]);
  await recovery;
  assert.equal(controller.snapshot('r').captureGeneration, active.captureGeneration);
  controller.stop();
  t.mock.timers.tick(10000);
  assert.equal(calls, 3);
});

test('unavailable transition warns once, clears old data, preserves later ACK and recovers', async () => {
  let fail = true;
  const warnings = [];
  const controller = createAssistantCaptureController({ now: () => 1000,
    store: { activeCaptures: async () => { if (fail) throw new Error('secret-bearing backend error'); return []; } },
    onWarning: (warning) => warnings.push(warning) });
  controller.apply('r', status());
  await controller.refresh();
  await controller.refresh();
  assert.equal(controller.snapshot('r'), null);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes('secret-bearing'));
  fail = false;
  await controller.refresh();
  assert.deepEqual(controller.snapshot('r'), { mode: 'Off' });
  fail = true;
  await controller.refresh();
  assert.equal(warnings.length, 2);
  const pending = deferred();
  const later = createAssistantCaptureController({ now: () => 1000, store: { activeCaptures: () => pending.promise } });
  const refresh = later.refresh();
  later.apply('r', status('Off', 3));
  pending.reject(new Error('offline'));
  await refresh;
  assert.equal(later.snapshot('r').storageEpoch, 3);
  later.apply('bad', { mode: 'Verbose', storageEpoch: 'invalid' });
  assert.equal(later.snapshot('bad'), null);
  controller.stop();
  later.stop();
});
