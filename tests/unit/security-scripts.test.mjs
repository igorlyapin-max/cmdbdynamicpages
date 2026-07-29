import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const secretScanScript = path.join(projectRoot, 'scripts/secret-scan.mjs');
const diagnoseScript = fs.readFileSync(path.join(projectRoot, 'scripts/diagnose-custompage.mjs'), 'utf8');

test('secret scanner ignores symlinks that point outside the repository root', (t) => {
  const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdp-secret-scan-'));
  const externalFile = path.join(os.tmpdir(), `cmdp-external-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(path.join(scanRoot, 'safe.txt'), 'safe content\n');
    fs.writeFileSync(externalFile, `${['api', 'key'].join('_')}=${'x'.repeat(36)}\n`);
    fs.symlinkSync(externalFile, path.join(scanRoot, 'external-secret.txt'));

    const result = spawnSync(process.execPath, [secretScanScript], {
      cwd: scanRoot,
      encoding: 'utf8'
    });
    if (result.error && result.error.code === 'EPERM') {
      t.skip('Child Node processes are not permitted by this execution sandbox.');
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No high-confidence secrets found/);
  } finally {
    fs.rmSync(scanRoot, { recursive: true, force: true });
    fs.rmSync(externalFile, { force: true });
  }
});

test('diagnostic CLI does not print CMDBuild identity or raw diagnostic payloads', () => {
  assert.match(diagnoseScript, /authenticated=\$\{Boolean\(session\.username \|\| session\.role\)\}/);
  assert.doesNotMatch(diagnoseScript, /user=\$\{session\.username/);
  assert.doesNotMatch(diagnoseScript, /role=\$\{session\.role/);
  assert.doesNotMatch(diagnoseScript, /\$\{item\.message \|\| ''\}/);
  assert.doesNotMatch(diagnoseScript, /\$\{item\.path \|\| ''\}/);
});
