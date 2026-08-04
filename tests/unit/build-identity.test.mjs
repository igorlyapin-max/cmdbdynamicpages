import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RUNTIME_SOURCE_MANIFEST_INCLUDES,
  createRuntimeSourceManifestArtifact,
  normalizeApplicationBuildInfo,
  normalizeApplicationVersion,
  readApplicationBuildIdentity
} from '../../scripts/build-identity.mjs';

function fixture(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdp-build-identity-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(directory, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return {
    directory,
    url(name) {
      return pathToFileURL(path.join(directory, name));
    }
  };
}

function runtimeSourceFixture() {
  return fixture({
    'src/z-last.mjs': 'export const z = 1;\n',
    'src/nested/a-first.mjs': 'export const a = 1;\n',
    'scripts/build-identity.mjs': 'export const buildIdentity = true;\n',
    'scripts/dev-proxy-server.mjs': 'export const editor = true;\n',
    'cmd/cmdp-d2-import/main.go': 'package main\n',
    'go.mod': 'module example.invalid/test\n',
    'go.sum': '',
    'package.json': '{"type":"module"}\n',
    'VERSION': '00.00.00.02\n'
  });
}

test('application version preserves the pre-handoff fallback contract', () => {
  assert.equal(normalizeApplicationVersion(undefined), '0.0.0.0');
  assert.equal(normalizeApplicationVersion('00.00.00.00\n'), '0.0.0.0');
  assert.equal(normalizeApplicationVersion('00.00.00.02\n'), '00.00.00.02');
  assert.throws(() => normalizeApplicationVersion('0.0.0.0\n'), /VERSION must contain exactly/);
});

test('verified build info requires the exact version, revision, and clean source', () => {
  const revision = 'a'.repeat(40);
  const runtimeManifestSha256 = 'b'.repeat(64);
  assert.deepEqual(normalizeApplicationBuildInfo({
    version: '00.00.00.02',
    revision,
    dirty: false,
    provenance: 'verified',
    runtimeManifestSha256
  }, '00.00.00.02'), {
    version: '00.00.00.02',
    revision,
    dirty: false,
    provenance: 'verified',
    runtimeManifestSha256
  });
  assert.throws(() => normalizeApplicationBuildInfo({
    version: '00.00.00.01',
    revision,
    dirty: false,
    provenance: 'verified',
    runtimeManifestSha256
  }, '00.00.00.02'), /does not match VERSION/);
  assert.throws(() => normalizeApplicationBuildInfo({
    version: '00.00.00.02',
    revision: 'unknown',
    dirty: false,
    provenance: 'verified',
    runtimeManifestSha256
  }, '00.00.00.02'), /requires a Git revision/);
  assert.throws(() => normalizeApplicationBuildInfo({
    version: '00.00.00.02',
    revision,
    dirty: true,
    provenance: 'verified',
    runtimeManifestSha256
  }, '00.00.00.02'), /requires a Git revision and dirty=false/);
  assert.throws(() => normalizeApplicationBuildInfo({
    version: '00.00.00.02',
    revision,
    dirty: false,
    provenance: 'verified'
  }, '00.00.00.02'), /runtimeManifestSha256/);
});

test('runtime source manifest is deterministic and covers every declared source group', (context) => {
  const files = runtimeSourceFixture();
  context.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));

  const first = createRuntimeSourceManifestArtifact(files.directory);
  const second = createRuntimeSourceManifestArtifact(files.directory);
  assert.deepEqual(first, second);
  assert.deepEqual(first.manifest.includes, [...RUNTIME_SOURCE_MANIFEST_INCLUDES]);
  assert.deepEqual(first.manifest.files.map((entry) => entry.path), [
    'VERSION',
    'cmd/cmdp-d2-import/main.go',
    'go.mod',
    'go.sum',
    'package.json',
    'scripts/build-identity.mjs',
    'scripts/dev-proxy-server.mjs',
    'src/nested/a-first.mjs',
    'src/z-last.mjs'
  ]);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.ok(first.text.endsWith('\n'));

  fs.writeFileSync(path.join(files.directory, 'src/nested/a-first.mjs'), 'export const a = 2;\n');
  const changed = createRuntimeSourceManifestArtifact(files.directory);
  assert.notEqual(changed.sha256, first.sha256);
  assert.notEqual(changed.text, first.text);
});

test('missing build info produces an explicit unverified local identity', (context) => {
  const files = fixture({ VERSION: '00.00.00.02\n', 'editor.mjs': 'export const value = 1;\n' });
  context.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const identity = readApplicationBuildIdentity({
    versionFileUrl: files.url('VERSION'),
    buildInfoFileUrl: files.url('missing.json'),
    editorSourceFileUrl: files.url('editor.mjs')
  });

  assert.equal(identity.version, '00.00.00.02');
  assert.equal(identity.revision, 'unknown');
  assert.equal(identity.dirty, null);
  assert.equal(identity.provenance, 'unverified-local');
  assert.equal(identity.runtimeManifestSha256, '');
  assert.match(identity.editorSha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.buildInfoError, '');
});

test('runtime identity accepts only build info bound to the embedded manifest', (context) => {
  const files = runtimeSourceFixture();
  context.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const artifact = createRuntimeSourceManifestArtifact(files.directory);
  fs.writeFileSync(path.join(files.directory, 'RUNTIME_SOURCE_MANIFEST.json'), artifact.text);
  fs.writeFileSync(path.join(files.directory, 'BUILD_INFO.json'), `${JSON.stringify({
    version: '00.00.00.02',
    revision: 'c'.repeat(40),
    dirty: false,
    provenance: 'verified',
    runtimeManifestSha256: artifact.sha256
  })}\n`);

  const options = {
    versionFileUrl: files.url('VERSION'),
    buildInfoFileUrl: files.url('BUILD_INFO.json'),
    runtimeSourceManifestFileUrl: files.url('RUNTIME_SOURCE_MANIFEST.json'),
    editorSourceFileUrl: files.url('scripts/dev-proxy-server.mjs')
  };
  const identity = readApplicationBuildIdentity(options);
  assert.equal(identity.runtimeManifestSha256, artifact.sha256);
  assert.equal(identity.provenance, 'verified');
  assert.equal(identity.buildInfoError, '');

  fs.writeFileSync(path.join(files.directory, 'BUILD_INFO.json'), `${JSON.stringify({
    version: '00.00.00.02',
    revision: 'c'.repeat(40),
    dirty: false,
    provenance: 'verified',
    runtimeManifestSha256: 'd'.repeat(64)
  })}\n`);
  const mismatched = readApplicationBuildIdentity(options);
  assert.equal(mismatched.provenance, 'unverified-local');
  assert.match(mismatched.buildInfoError, /does not match RUNTIME_SOURCE_MANIFEST/);
});

test('invalid build info is reported without hiding the executable source hash', (context) => {
  const files = fixture({
    VERSION: '00.00.00.02\n',
    'BUILD_INFO.json': JSON.stringify({
      version: '00.00.00.01',
      revision: 'b'.repeat(40),
      dirty: false,
      provenance: 'verified',
      runtimeManifestSha256: 'c'.repeat(64)
    }),
    'editor.mjs': 'export const value = 2;\n'
  });
  context.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const identity = readApplicationBuildIdentity({
    versionFileUrl: files.url('VERSION'),
    buildInfoFileUrl: files.url('BUILD_INFO.json'),
    editorSourceFileUrl: files.url('editor.mjs')
  });

  assert.equal(identity.provenance, 'unverified-local');
  assert.match(identity.buildInfoError, /does not match VERSION/);
  assert.match(identity.editorSha256, /^[0-9a-f]{64}$/);
});
