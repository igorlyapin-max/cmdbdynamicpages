import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../scripts/nginx-dev.sh', import.meta.url));

test('nginx launcher refuses to remove a container owned by another Compose project', () => {
  const fixture = createDockerFixture('other-project');
  try {
    const result = runLauncher(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /belongs to Compose project other-project/);
    assert.doesNotMatch(readLog(fixture), /rm --force/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('nginx launcher removes only an unlabelled legacy container before Compose starts', () => {
  const fixture = createDockerFixture('<no value>');
  try {
    const result = runLauncher(fixture);
    assert.equal(result.status, 0, result.stderr);
    const calls = readLog(fixture);
    assert.match(calls, /rm --force cmdbdynamicpages-nginx/);
    assert.match(calls, /compose -f docker-compose\.nginx\.yml up -d --force-recreate --no-deps nginx/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createDockerFixture(project) {
  const directory = mkdtempSync(join(tmpdir(), 'cmdbdynamicpages-nginx-launcher-'));
  const docker = join(directory, 'docker');
  const log = join(directory, 'docker.log');
  writeFileSync(docker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) exit 0 ;;
  container) exit 0 ;;
  inspect) printf '%s\\n' "$DOCKER_TEST_PROJECT"; exit 0 ;;
  rm) exit 0 ;;
  *) exit 64 ;;
esac
`);
  chmodSync(docker, 0o755);
  return { directory, log, project };
}

function runLauncher(fixture) {
  return spawnSync('bash', [launcher], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.directory}:${process.env.PATH}`,
      DOCKER_LOG: fixture.log,
      DOCKER_TEST_PROJECT: fixture.project
    }
  });
}

function readLog(fixture) {
  return readFileSync(fixture.log, 'utf8');
}
