import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const mode of ['off', 'Basic', 'Verbose']) {
  test(`dynamic UI failure in ${mode} exposes only a correlated safe summary`, () => {
    const script = `
      import { handleDynamicUiFailure } from './scripts/dev-proxy-server.mjs';
      process.stderr.write = process.stdout.write.bind(process.stdout);
      const error = new TypeError('private-token-marker user@example.invalid https://example.invalid/?password=private-password-marker');
      error.stack = error.message + '\\n    at private-customer-frame';
      const response = { writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { process.stdout.write('RESPONSE:' + JSON.stringify({status:this.status, headers:this.headers, body}) + '\\n'); } };
      handleDynamicUiFailure({cmdpRequestId:'safe-request-id'}, response,
        new URL('http://localhost/cmdbuild/dynamicpages/ui/designer?token=private-query-marker'), error);
    `;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', CMDP_LOG_TARGET: 'stdout', CMDP_LOG_LEVEL: 'debug', CMDP_DIAGNOSTIC_MODE: mode }
    });
    const responseLine = result.split('\n').find((line) => line.startsWith('RESPONSE:'));
    const response = JSON.parse(responseLine.slice('RESPONSE:'.length));
    assert.equal(response.status, 500);
    assert.match(response.body, /safe-request-id/);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.doesNotMatch(result, /private-|user@example\.invalid|password=/);
    const diagnosticLines = result.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    const operational = diagnosticLines.find((line) => line.event === 'dynamic_ui.render_failed');
    assert.ok(operational);
    assert.equal(operational.errorType, 'TypeError');
    assert.equal(operational.message, undefined);
    assert.equal(operational.stack, undefined);
    assert.equal(diagnosticLines.some((line) => line.event === 'diagnostic.dynamic_ui.render_failed'), mode === 'Verbose');
    if (mode === 'Verbose') {
      const diagnostic = diagnosticLines.find((line) => line.event === 'diagnostic.dynamic_ui.render_failed');
      assert.equal(diagnostic.errorType, 'TypeError');
      assert.equal(diagnostic.hasStack, true);
      assert.equal(diagnostic.requestId, 'safe-request-id');
      assert.equal(diagnostic.message, undefined);
      assert.equal(diagnostic.stack, undefined);
    }
  });
}

test('failure handler logs no raw exception fields to the operational stream', () => {
  const script = `
    import { handleDynamicUiFailure } from './scripts/dev-proxy-server.mjs';
    const error = {name:'private-error-name', message:'private-token', stack:'private-stack'};
    handleDynamicUiFailure({cmdpRequestId:'safe-request-id'}, {writeHead(){}, end(){}},
      new URL('http://localhost/cmdbuild/dynamicpages/ui/designer'), error);
  `;
  // The child forwards its structured error stream to stdout for assertions only.
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    "process.stderr.write = process.stdout.write.bind(process.stdout);\n" + script], {
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', CMDP_LOG_TARGET: 'stdout', CMDP_LOG_LEVEL: 'debug', CMDP_DIAGNOSTIC_MODE: 'off' }
  });
  const event = result.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.event === 'dynamic_ui.render_failed');
  assert.ok(event);
  assert.equal(event.code, 'dynamic_ui_render_failed');
  assert.equal(event.errorType, 'Error');
  assert.equal(event.requestId, 'safe-request-id');
  assert.equal(event.stack, undefined);
  assert.equal(event.message, undefined);
  assert.doesNotMatch(result, /private-/);
});
