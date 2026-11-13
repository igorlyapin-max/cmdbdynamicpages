import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { purgeAssistantDiagnostics } from '../../scripts/assistant-diagnostics-maintenance.mjs';

test('offline purge requires explicit confirmation before any command', async () => {
  for (const flags of [{}, { confirmed: true }, { writersStopped: true }]) {
    await assert.rejects(purgeAssistantDiagnostics(() => { assert.fail('Unexpected Redis call'); }, 'test', flags), /Confirm/);
  }
});

test('purge deletes diagnostic records only and preserves durable epochs and unrelated cache', async () => {
  const prefix = createHash('sha256').update('test').digest('hex').slice(0, 16) + ':assistant-diagnostics:';
  const commands = [];
  const adapter = async (args) => {
    commands.push(args);
    if (args[0] === 'SCAN') return ['0', [prefix + 'active', prefix + '{root}:trace:id', prefix + '{root}:epoch', 'other:cache:key', prefix + 'active']];
    if (args[0] === 'UNLINK') return args.length - 1;
    assert.fail('Unexpected Redis command');
  };
  const result = await purgeAssistantDiagnostics(adapter, 'test', { confirmed: true, writersStopped: true });
  assert.equal(result.deletedKeys, 2);
  assert.equal(result.preservedEpochKeys, 1);
  assert.deepEqual(commands.find((cmd) => cmd[0] === 'UNLINK'), ['UNLINK', prefix + 'active', prefix + '{root}:trace:id']);
  assert.equal(commands.some((cmd) => /^FLUSH/.test(cmd[0])), false);
});
