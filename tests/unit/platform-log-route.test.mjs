import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/verify-platform-log-route.sh', import.meta.url));

test('platform log route probe forwards a unique request identifier to the collector query', async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-request-id'], 'probe-from-test');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"live":true}');
  });
  try {
    await listen(server);
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('TCP sockets are not permitted by this execution sandbox.');
      return;
    }
    throw error;
  }
  try {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const result = await run('sh', [
      script,
      `http://127.0.0.1:${port}/health/live`,
      '--',
      'sh', '-c', 'test "$CMDP_LOG_PROBE_ID" = probe-from-test'
    ], { CMDP_LOG_PROBE_ID: 'probe-from-test' });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('platform log route probe rejects an implicit collector command', async () => {
  const result = await run('sh', [script, 'http://127.0.0.1:1/health/live']);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /Usage:/);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function run(command, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}
