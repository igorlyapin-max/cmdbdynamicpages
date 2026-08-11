import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../../scripts/container-entrypoint.sh', import.meta.url));

function invokeEntrypoint(environment) {
  const result = spawnSync('sh', [entrypoint, 'sh', '-c', 'printf %s "$NODE_EXTRA_CA_CERTS"'], {
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('container entrypoint preserves prepared-base Node CA trust without a runtime mount', () => {
  assert.equal(invokeEntrypoint({
    NODE_EXTRA_CA_CERTS: '/etc/ssl/customer-base.pem',
    CMDP_TLS_CA_FILE: ''
  }), '/etc/ssl/customer-base.pem');
});

test('container entrypoint makes an explicit runtime CA mount authoritative', () => {
  assert.equal(invokeEntrypoint({
    NODE_EXTRA_CA_CERTS: '/etc/ssl/customer-base.pem',
    CMDP_TLS_CA_FILE: '/run/certs/cmdbdynamicpages-ca.pem'
  }), '/run/certs/cmdbdynamicpages-ca.pem');
});
