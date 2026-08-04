import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildMetadataForOptions,
  canonicalDockerBuildArguments,
  compareRuntimeSourceManifests,
  requireCleanVerificationErrors,
  parseOptions
} from '../../scripts/container-image.mjs';
import {
  RUNTIME_SOURCE_MANIFEST_INCLUDES,
  runtimeSourceManifestSha256,
  serializeRuntimeSourceManifest
} from '../../scripts/build-identity.mjs';

const cleanWorkspace = {
  version: '00.00.00.02',
  revision: 'a'.repeat(40),
  dirty: false,
  provenance: 'unverified-local',
  editorSha256: 'b'.repeat(64),
  runtimeManifestSha256: 'c'.repeat(64)
};

test('local container builds remain unverified unless strict provenance is requested', () => {
  assert.equal(buildMetadataForOptions(cleanWorkspace).provenance, 'unverified-local');
  assert.equal(buildMetadataForOptions(cleanWorkspace, { requireClean: true }).provenance, 'verified');
});

test('strict verified build rejects a dirty checkout', () => {
  assert.throws(
    () => buildMetadataForOptions({ ...cleanWorkspace, dirty: true }, { requireClean: true }),
    /verified build requires a clean checkout/
  );
});

test('canonical image helper always selects the runtime-canonical target', () => {
  assert.deepEqual(canonicalDockerBuildArguments(cleanWorkspace, {
    tag: 'example:test',
    noCache: true
  }), [
    'build',
    '--no-cache',
    '--target', 'runtime-canonical',
    '--build-arg', 'APP_VERSION=00.00.00.02',
    '--build-arg', `VCS_REF=${'a'.repeat(40)}`,
    '--build-arg', 'SOURCE_DIRTY=false',
    '--build-arg', 'BUILD_PROVENANCE=unverified-local',
    '--build-arg', `RUNTIME_MANIFEST_SHA256=${'c'.repeat(64)}`,
    '-t', 'example:test',
    '.'
  ]);
});

test('Dockerfile keeps manual default identity separate from canonical labels and digest input', () => {
  const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const stages = [...dockerfile.matchAll(/^FROM .+ AS ([^\s]+)$/gm)].map((match) => match[1]);
  assert.equal(stages.at(-1), 'runtime-manual');

  const manualManifestStart = dockerfile.indexOf('FROM runtime-source AS runtime-source-manifest-manual');
  const canonicalManifestStart = dockerfile.indexOf('FROM runtime-source AS runtime-source-manifest-canonical');
  const canonicalRuntimeStart = dockerfile.indexOf('FROM runtime-base AS runtime-canonical');
  const manualRuntimeStart = dockerfile.indexOf('FROM runtime-base AS runtime-manual');
  assert.ok(manualManifestStart > 0);
  assert.ok(canonicalManifestStart > manualManifestStart);
  assert.ok(manualRuntimeStart > canonicalRuntimeStart);

  const manualManifestStage = dockerfile.slice(manualManifestStart, canonicalManifestStart);
  const canonicalManifestStage = dockerfile.slice(canonicalManifestStart, dockerfile.indexOf('FROM node:', canonicalManifestStart));
  const canonicalRuntimeStage = dockerfile.slice(canonicalRuntimeStart, manualRuntimeStart);
  const manualRuntimeStage = dockerfile.slice(manualRuntimeStart);
  assert.doesNotMatch(manualManifestStage, /--expect-sha256/);
  assert.match(canonicalManifestStage, /--expect-sha256 "\$RUNTIME_MANIFEST_SHA256"/);
  assert.match(canonicalRuntimeStage, /org\.opencontainers\.image\.version/);
  assert.match(canonicalRuntimeStage, /org\.opencontainers\.image\.revision/);
  assert.match(canonicalRuntimeStage, /io\.gkm\.cmdbdynamicpages\.runtime-source-manifest-sha256/);
  assert.match(manualRuntimeStage, /io\.gkm\.cmdbdynamicpages\.provenance="unverified-local"/);
  assert.doesNotMatch(manualRuntimeStage, /org\.opencontainers\.image\.version/);
  assert.doesNotMatch(manualRuntimeStage, /org\.opencontainers\.image\.revision/);
  assert.doesNotMatch(manualRuntimeStage, /io\.gkm\.cmdbdynamicpages\.runtime-source-manifest-sha256/);
  assert.match(manualRuntimeStage, /"revision":"unknown","dirty":null,"provenance":"unverified-local"/);
});

test('strict verification requires both a clean checkout and image dirty=false', () => {
  assert.deepEqual(requireCleanVerificationErrors(
    { dirty: false },
    { dirty: false, provenance: 'verified' }
  ), []);
  assert.deepEqual(requireCleanVerificationErrors(
    { dirty: true },
    { dirty: true, provenance: 'unverified-local' }
  ), [
    'a clean verification requires a clean Git checkout',
    'a clean verification requires image dirty=false',
    'a clean verification requires verified image provenance'
  ]);
});

test('image verification compares the complete canonical runtime source manifest', () => {
  const manifest = {
    schemaVersion: 1,
    algorithm: 'sha256',
    includes: [...RUNTIME_SOURCE_MANIFEST_INCLUDES],
    files: [{ path: 'VERSION', size: 12, sha256: 'a'.repeat(64) }]
  };
  const runtimeManifestText = serializeRuntimeSourceManifest(manifest);
  const runtimeManifestSha256 = runtimeSourceManifestSha256(runtimeManifestText);
  const workspace = { runtimeManifestText, runtimeManifestSha256 };
  const embedded = {
    runtimeManifest: manifest,
    runtimeManifestText,
    runtimeManifestSha256
  };
  assert.deepEqual(compareRuntimeSourceManifests(workspace, embedded), []);

  const changedManifest = {
    ...manifest,
    files: [{ path: 'VERSION', size: 12, sha256: 'b'.repeat(64) }]
  };
  const changedText = serializeRuntimeSourceManifest(changedManifest);
  const changed = {
    runtimeManifest: changedManifest,
    runtimeManifestText: changedText,
    runtimeManifestSha256: runtimeSourceManifestSha256(changedText)
  };
  assert.deepEqual(compareRuntimeSourceManifests(workspace, changed), [
    'image runtime source manifest does not match the current checkout',
    'image runtime source manifest digest does not match the current checkout'
  ]);
});

test('container image CLI parses explicit verification options', () => {
  assert.deepEqual(parseOptions(['--image', 'example:test', '--container', 'backend', '--require-clean']), {
    noCache: false,
    requireClean: true,
    container: 'backend',
    image: 'example:test'
  });
});
