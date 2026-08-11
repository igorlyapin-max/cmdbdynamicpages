import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createRuntimeSourceManifestArtifact,
  normalizeApplicationBuildInfo,
  normalizeRuntimeSourceManifest,
  runtimeSourceManifestSha256,
  serializeRuntimeSourceManifest
} from './build-identity.mjs';

const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_CONTAINER = 'cmdbdynamicpages-backend';
const DEFAULT_WORKSPACE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUNTIME_MANIFEST_LABEL = 'io.gkm.cmdbdynamicpages.runtime-source-manifest-sha256';
const SUPPORTED_BUILD_TARGETS = new Set(['runtime-canonical', 'gkm-runtime']);

const READ_IMAGE_FILES_SCRIPT = [
  "const crypto=require('node:crypto');",
  "const fs=require('node:fs');",
  "const runtimeManifestText=fs.readFileSync('/app/RUNTIME_SOURCE_MANIFEST.json','utf8');",
  'const result={',
  "version:fs.readFileSync('/app/VERSION','utf8').trim(),",
  "buildInfo:JSON.parse(fs.readFileSync('/app/BUILD_INFO.json','utf8')),",
  'runtimeManifestText,',
  'runtimeManifest:JSON.parse(runtimeManifestText),',
  "runtimeManifestSha256:crypto.createHash('sha256').update(runtimeManifestText).digest('hex'),",
  "editorSha256:crypto.createHash('sha256').update(fs.readFileSync('/app/scripts/dev-proxy-server.mjs')).digest('hex')",
  '};',
  'process.stdout.write(JSON.stringify(result));'
].join('');

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${commandName} ${args.join(' ')} failed with exit code ${result.status}${details ? `: ${details}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function parseOptions(args) {
  const options = {
    noCache: false,
    requireClean: false,
    container: '',
    target: 'runtime-canonical',
    nodeBaseImage: '',
    goBaseImage: ''
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--no-cache') options.noCache = true;
    else if (value === '--require-clean') options.requireClean = true;
    else if (value === '--tag' || value === '--image' || value === '--container' || value === '--target' || value === '--node-base-image' || value === '--go-base-image') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function validateBuildTargetOptions(options = {}) {
  const target = String(options.target || 'runtime-canonical').trim();
  if (!SUPPORTED_BUILD_TARGETS.has(target)) {
    throw new Error(`Unsupported build target: ${target}.`);
  }
  const nodeBaseImage = String(options.nodeBaseImage || '').trim();
  const goBaseImage = String(options.goBaseImage || '').trim();
  if (target === 'gkm-runtime') {
    if (!options.requireClean) throw new Error('gkm-runtime requires --require-clean.');
    if (!nodeBaseImage || !goBaseImage) {
      throw new Error('gkm-runtime requires both --node-base-image and --go-base-image.');
    }
  } else if (nodeBaseImage || goBaseImage) {
    throw new Error('--node-base-image and --go-base-image are supported only with --target gkm-runtime.');
  }
  return { target, nodeBaseImage, goBaseImage };
}

function readWorkspaceMetadata(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
  const rawVersion = fs.readFileSync(path.join(workspaceRoot, 'VERSION'), 'utf8');
  if (!/^\d{2}\.\d{2}\.\d{2}\.\d{2}\n$/.test(rawVersion) || rawVersion === '00.00.00.00\n') {
    throw new Error('VERSION must contain a non-sentinel XX.YY.ZZ.NN value followed by a newline.');
  }
  const revision = command('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot }).toLowerCase();
  if (!REVISION_PATTERN.test(revision)) throw new Error('Git HEAD is not a 40-character lowercase SHA.');
  const dirty = command('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workspaceRoot }) !== '';
  const runtimeManifest = createRuntimeSourceManifestArtifact(workspaceRoot);
  const editorEntry = runtimeManifest.manifest.files.find((entry) => entry.path === 'scripts/dev-proxy-server.mjs');
  if (!editorEntry) throw new Error('Runtime source manifest does not contain scripts/dev-proxy-server.mjs.');

  return {
    version: rawVersion.trim(),
    revision,
    dirty,
    provenance: 'unverified-local',
    editorSha256: editorEntry.sha256,
    runtimeManifest: runtimeManifest.manifest,
    runtimeManifestText: runtimeManifest.text,
    runtimeManifestSha256: runtimeManifest.sha256
  };
}

function buildMetadataForOptions(workspace, options = {}) {
  if (options.requireClean && workspace.dirty) {
    throw new Error('The Git worktree is dirty; a verified build requires a clean checkout.');
  }
  return {
    ...workspace,
    provenance: options.requireClean ? 'verified' : 'unverified-local'
  };
}

function canonicalDockerBuildArguments(metadata, options = {}) {
  const targetOptions = validateBuildTargetOptions(options);
  const args = ['build'];
  if (options.noCache) args.push('--no-cache');
  args.push(
    '--target', targetOptions.target,
    '--build-arg', `APP_VERSION=${metadata.version}`,
    '--build-arg', `VCS_REF=${metadata.revision}`,
    '--build-arg', `SOURCE_DIRTY=${metadata.dirty}`,
    '--build-arg', `BUILD_PROVENANCE=${metadata.provenance}`,
    '--build-arg', `RUNTIME_MANIFEST_SHA256=${metadata.runtimeManifestSha256}`
  );
  if (targetOptions.target === 'gkm-runtime') {
    args.push(
      '--build-arg', `GKM_NODE_BASE_IMAGE=${targetOptions.nodeBaseImage}`,
      '--build-arg', `GKM_GO_BASE_IMAGE=${targetOptions.goBaseImage}`
    );
  }
  args.push('-t', options.tag, '.');
  return args;
}

function imageInspect(image) {
  const inspected = JSON.parse(command('docker', ['image', 'inspect', image]));
  if (!Array.isArray(inspected) || !inspected[0]) throw new Error(`Docker image ${image} was not found.`);
  return inspected[0];
}

function readImageFiles(image, container = '') {
  const args = container
    ? ['exec', container, 'node', '-e', READ_IMAGE_FILES_SCRIPT]
    : ['run', '--rm', '--entrypoint', 'node', image, '-e', READ_IMAGE_FILES_SCRIPT];
  return JSON.parse(command('docker', args));
}

function compareRuntimeSourceManifests(workspace, embedded) {
  const errors = [];
  let embeddedDigest = '';
  try {
    const normalized = normalizeRuntimeSourceManifest(embedded.runtimeManifest);
    if (embedded.runtimeManifestText !== serializeRuntimeSourceManifest(normalized)) {
      errors.push('embedded runtime source manifest is not canonical');
    }
    embeddedDigest = runtimeSourceManifestSha256(embedded.runtimeManifestText);
  } catch (error) {
    errors.push(error && error.message ? String(error.message) : 'embedded runtime source manifest is invalid');
  }

  if (embedded.runtimeManifestSha256 !== embeddedDigest) {
    errors.push('embedded runtime source manifest digest does not match its content');
  }
  if (workspace.runtimeManifestText !== embedded.runtimeManifestText) {
    errors.push('image runtime source manifest does not match the current checkout');
  }
  if (workspace.runtimeManifestSha256 !== embeddedDigest) {
    errors.push('image runtime source manifest digest does not match the current checkout');
  }
  return errors;
}

function requireCleanVerificationErrors(workspace, buildInfo) {
  const errors = [];
  if (workspace.dirty !== false) errors.push('a clean verification requires a clean Git checkout');
  if (buildInfo.dirty !== false) errors.push('a clean verification requires image dirty=false');
  if (buildInfo.provenance !== 'verified') errors.push('a clean verification requires verified image provenance');
  return errors;
}

function summarizeWorkspace(workspace) {
  return {
    version: workspace.version,
    revision: workspace.revision,
    dirty: workspace.dirty,
    provenance: workspace.provenance,
    editorSha256: workspace.editorSha256,
    runtimeManifestSha256: workspace.runtimeManifestSha256,
    runtimeManifestFileCount: workspace.runtimeManifest.files.length
  };
}

function summarizeImageFiles(files) {
  return {
    version: files.version,
    buildInfo: files.buildInfo,
    editorSha256: files.editorSha256,
    runtimeManifestSha256: files.runtimeManifestSha256,
    runtimeManifestFileCount: Array.isArray(files.runtimeManifest && files.runtimeManifest.files)
      ? files.runtimeManifest.files.length
      : 0
  };
}

function assertImageIdentity({ image, container = '', requireClean = false }) {
  const workspace = readWorkspaceMetadata();
  const inspected = imageInspect(image);
  const labels = inspected.Config && inspected.Config.Labels || {};
  const embedded = readImageFiles(image);
  const errors = compareRuntimeSourceManifests(workspace, embedded);

  let buildInfo = embedded.buildInfo;
  try {
    buildInfo = normalizeApplicationBuildInfo(embedded.buildInfo, embedded.version);
  } catch (error) {
    errors.push(error && error.message ? String(error.message) : 'BUILD_INFO.json is invalid');
    buildInfo = embedded.buildInfo && typeof embedded.buildInfo === 'object' && !Array.isArray(embedded.buildInfo)
      ? embedded.buildInfo
      : {};
  }

  if (embedded.version !== workspace.version) errors.push(`embedded VERSION ${embedded.version || '(empty)'} does not match workspace ${workspace.version}`);
  if (buildInfo.version !== workspace.version) errors.push('BUILD_INFO.json version does not match workspace VERSION');
  if (embedded.editorSha256 !== workspace.editorSha256) errors.push('image editor SHA-256 does not match the current checkout');
  if (buildInfo.runtimeManifestSha256 !== embedded.runtimeManifestSha256) errors.push('BUILD_INFO.json runtime manifest digest does not match the embedded manifest');
  if (labels[RUNTIME_MANIFEST_LABEL] !== embedded.runtimeManifestSha256) errors.push('OCI runtime manifest digest label does not match the embedded manifest');
  if (labels['io.gkm.cmdbdynamicpages.provenance'] !== buildInfo.provenance) errors.push('OCI provenance label does not match BUILD_INFO.json');
  if (labels['org.opencontainers.image.revision'] !== buildInfo.revision) errors.push('OCI revision label does not match BUILD_INFO.json');
  if (labels['org.opencontainers.image.version'] !== workspace.version) errors.push('OCI version label does not match VERSION');
  if (buildInfo.revision !== workspace.revision) errors.push('image revision does not match Git HEAD');
  const expectedDirtyLabel = buildInfo.dirty === null ? 'unknown' : String(buildInfo.dirty);
  if (labels['io.gkm.cmdbdynamicpages.source-dirty'] !== expectedDirtyLabel) errors.push('OCI dirty label does not match BUILD_INFO.json');
  if (buildInfo.provenance === 'verified' && buildInfo.dirty !== false) errors.push('verified image must have dirty=false');
  if (requireClean) errors.push(...requireCleanVerificationErrors(workspace, buildInfo));

  let running = null;
  if (container) {
    const containerInspect = JSON.parse(command('docker', ['container', 'inspect', container]));
    if (!Array.isArray(containerInspect) || !containerInspect[0]) throw new Error(`Container ${container} was not found.`);
    const runningFiles = readImageFiles('', container);
    running = {
      configuredImage: containerInspect[0].Config && containerInspect[0].Config.Image || '',
      imageId: containerInspect[0].Image || '',
      files: summarizeImageFiles(runningFiles)
    };
    if (running.imageId !== inspected.Id) errors.push(`running container image ${running.imageId} does not match selected image ${inspected.Id}`);
    if (runningFiles.version !== embedded.version
        || JSON.stringify(runningFiles.buildInfo) !== JSON.stringify(embedded.buildInfo)
        || runningFiles.runtimeManifestText !== embedded.runtimeManifestText
        || runningFiles.editorSha256 !== embedded.editorSha256) {
      errors.push('running container files do not match the selected image');
    }
  }

  const summary = {
    success: errors.length === 0,
    image,
    imageId: inspected.Id,
    workspace: summarizeWorkspace(workspace),
    embedded: summarizeImageFiles(embedded),
    labels: {
      version: labels['org.opencontainers.image.version'] || '',
      revision: labels['org.opencontainers.image.revision'] || '',
      provenance: labels['io.gkm.cmdbdynamicpages.provenance'] || '',
      dirty: labels['io.gkm.cmdbdynamicpages.source-dirty'] || '',
      runtimeManifestSha256: labels[RUNTIME_MANIFEST_LABEL] || ''
    },
    running,
    errors
  };
  if (errors.length) throw new Error(`Container image identity verification failed:\n- ${errors.join('\n- ')}`);
  return summary;
}

function buildImage(options) {
  const tag = String(options.tag || '').trim();
  if (!tag) throw new Error('build requires --tag <image>.');
  const metadata = buildMetadataForOptions(readWorkspaceMetadata(), options);
  const args = canonicalDockerBuildArguments(metadata, { ...options, tag });
  command('docker', args, { cwd: DEFAULT_WORKSPACE_ROOT, stdio: 'inherit' });
  return assertImageIdentity({ image: tag, requireClean: options.requireClean });
}

function usage() {
  return [
    'Usage:',
    '  node scripts/container-image.mjs build --tag <image> [--target runtime-canonical] [--no-cache] [--require-clean]',
    '  node scripts/container-image.mjs build --target gkm-runtime --node-base-image <image> --go-base-image <image> --tag <image> --require-clean [--no-cache]',
    `  node scripts/container-image.mjs verify --image <image> [--container ${DEFAULT_CONTAINER}] [--require-clean]`
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  const options = parseOptions(rest);
  if (options.help || !action) {
    console.log(usage());
    return;
  }
  let summary;
  if (action === 'build') summary = buildImage(options);
  else if (action === 'verify') {
    const image = String(options.image || '').trim();
    if (!image) throw new Error('verify requires --image <image>.');
    summary = assertImageIdentity({ image, container: options.container, requireClean: options.requireClean });
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

export {
  assertImageIdentity,
  buildMetadataForOptions,
  buildImage,
  canonicalDockerBuildArguments,
  compareRuntimeSourceManifests,
  parseOptions,
  readWorkspaceMetadata,
  validateBuildTargetOptions,
  requireCleanVerificationErrors
};
