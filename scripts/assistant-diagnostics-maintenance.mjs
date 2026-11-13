import { createHash } from 'node:crypto';

export async function purgeAssistantDiagnostics(redisCommand, keyPrefix, { confirmed = false, writersStopped = false } = {}) {
  if (!confirmed || !writersStopped) throw new Error('Confirm diagnostic-history deletion and stop all diagnostic writers first.');
  const prefix = createHash('sha256').update(String(keyPrefix)).digest('hex').slice(0, 16) + ':assistant-diagnostics:';
  const records = new Set();
  const epochs = new Set();
  let cursor = '0';
  do {
    const reply = await redisCommand(['SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', 200]);
    if (!Array.isArray(reply) || !/^\d+$/.test(String(reply[0])) || !Array.isArray(reply[1])) throw new Error('Invalid Redis scan response.');
    cursor = String(reply[0]);
    for (const key of reply[1]) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      if (key.endsWith(':epoch')) epochs.add(key); else records.add(key);
    }
  } while (cursor !== '0');
  let deletedKeys = 0;
  const keys = [...records];
  for (let offset = 0; offset < keys.length; offset += 200) deletedKeys += Number(await redisCommand(['UNLINK', ...keys.slice(offset, offset + 200)]));
  return { scope: 'assistantDiagnostics', deletedKeys, preservedEpochKeys: epochs.size, namespacePrefix: prefix };
}
