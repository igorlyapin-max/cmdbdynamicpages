import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APPLICATION_VERSION_FALLBACK = '0.0.0.0';
const APPLICATION_VERSION_PRE_HANDOFF_SENTINEL = '00.00.00.00';
const APPLICATION_VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_SOURCE_MANIFEST_SCHEMA_VERSION = 1;
const RUNTIME_SOURCE_MANIFEST_INCLUDES = Object.freeze([
  'src/**',
  'scripts/**',
  'cmd/cmdp-d2-import/**',
  'go.mod',
  'go.sum',
  'package.json',
  'VERSION'
]);
const RUNTIME_SOURCE_DIRECTORIES = Object.freeze([
  'src',
  'scripts',
  'cmd/cmdp-d2-import'
]);
const RUNTIME_SOURCE_FILES = Object.freeze([
  'go.mod',
  'go.sum',
  'package.json',
  'VERSION'
]);

const DEFAULT_RUNTIME_SOURCE_ROOT_URL = new URL('../', import.meta.url);
const DEFAULT_VERSION_FILE_URL = new URL('../VERSION', import.meta.url);
const DEFAULT_BUILD_INFO_FILE_URL = new URL('../BUILD_INFO.json', import.meta.url);
const DEFAULT_RUNTIME_SOURCE_MANIFEST_FILE_URL = new URL('../RUNTIME_SOURCE_MANIFEST.json', import.meta.url);
const DEFAULT_EDITOR_SOURCE_FILE_URL = new URL('./dev-proxy-server.mjs', import.meta.url);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rootPath(value = DEFAULT_RUNTIME_SOURCE_ROOT_URL) {
  if (value instanceof URL) return fileURLToPath(value);
  return path.resolve(String(value));
}

function collectRuntimeDirectoryFiles(workspaceRoot, relativeDirectory, result) {
  const absoluteDirectory = path.join(workspaceRoot, ...relativeDirectory.split('/'));
  const directoryStats = fs.lstatSync(absoluteDirectory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`Runtime source path ${relativeDirectory} must be a directory, not a symbolic link.`);
  }

  const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
    .sort((left, right) => compareAscii(left.name, right.name));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectRuntimeDirectoryFiles(workspaceRoot, relativePath, result);
    } else if (entry.isFile()) {
      result.push(relativePath);
    } else {
      throw new Error(`Runtime source path ${relativePath} must be a regular file or directory.`);
    }
  }
}

function createRuntimeSourceManifest(workspaceRoot = DEFAULT_RUNTIME_SOURCE_ROOT_URL) {
  const absoluteRoot = rootPath(workspaceRoot);
  const relativePaths = [];
  for (const directory of RUNTIME_SOURCE_DIRECTORIES) {
    collectRuntimeDirectoryFiles(absoluteRoot, directory, relativePaths);
  }
  for (const file of RUNTIME_SOURCE_FILES) {
    const stats = fs.lstatSync(path.join(absoluteRoot, file));
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Runtime source path ${file} must be a regular file, not a symbolic link.`);
    }
    relativePaths.push(file);
  }

  relativePaths.sort(compareAscii);
  const files = relativePaths.map((relativePath) => {
    const content = fs.readFileSync(path.join(absoluteRoot, ...relativePath.split('/')));
    return {
      path: relativePath,
      size: content.length,
      sha256: sha256(content)
    };
  });
  return {
    schemaVersion: RUNTIME_SOURCE_MANIFEST_SCHEMA_VERSION,
    algorithm: 'sha256',
    includes: [...RUNTIME_SOURCE_MANIFEST_INCLUDES],
    files
  };
}

function normalizeRuntimeSourceManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RUNTIME_SOURCE_MANIFEST.json must contain a JSON object.');
  }
  if (value.schemaVersion !== RUNTIME_SOURCE_MANIFEST_SCHEMA_VERSION || value.algorithm !== 'sha256') {
    throw new Error('RUNTIME_SOURCE_MANIFEST.json schema or algorithm is unsupported.');
  }
  if (!Array.isArray(value.includes)
      || value.includes.length !== RUNTIME_SOURCE_MANIFEST_INCLUDES.length
      || value.includes.some((entry, index) => entry !== RUNTIME_SOURCE_MANIFEST_INCLUDES[index])) {
    throw new Error('RUNTIME_SOURCE_MANIFEST.json includes do not match the runtime source contract.');
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error('RUNTIME_SOURCE_MANIFEST.json files must be a non-empty array.');
  }

  let previousPath = '';
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('RUNTIME_SOURCE_MANIFEST.json file entries must be objects.');
    }
    const relativePath = String(entry.path || '');
    const pathSegments = relativePath.split('/');
    if (!relativePath
        || relativePath.includes('\\')
        || path.isAbsolute(relativePath)
        || pathSegments.includes('..')
        || pathSegments.includes('.')
        || path.posix.normalize(relativePath) !== relativePath) {
      throw new Error(`RUNTIME_SOURCE_MANIFEST.json contains an unsafe path: ${relativePath || '(empty)'}.`);
    }
    if (previousPath && compareAscii(previousPath, relativePath) >= 0) {
      throw new Error('RUNTIME_SOURCE_MANIFEST.json file paths must be sorted and unique.');
    }
    previousPath = relativePath;

    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`RUNTIME_SOURCE_MANIFEST.json size is invalid for ${relativePath}.`);
    }
    const digest = String(entry.sha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(digest)) {
      throw new Error(`RUNTIME_SOURCE_MANIFEST.json SHA-256 is invalid for ${relativePath}.`);
    }
    return { path: relativePath, size: entry.size, sha256: digest };
  });

  return {
    schemaVersion: RUNTIME_SOURCE_MANIFEST_SCHEMA_VERSION,
    algorithm: 'sha256',
    includes: [...RUNTIME_SOURCE_MANIFEST_INCLUDES],
    files
  };
}

function serializeRuntimeSourceManifest(value) {
  return `${JSON.stringify(normalizeRuntimeSourceManifest(value))}\n`;
}

function runtimeSourceManifestSha256(value) {
  const content = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : serializeRuntimeSourceManifest(value);
  return sha256(content);
}

function createRuntimeSourceManifestArtifact(workspaceRoot = DEFAULT_RUNTIME_SOURCE_ROOT_URL) {
  const manifest = createRuntimeSourceManifest(workspaceRoot);
  const text = serializeRuntimeSourceManifest(manifest);
  return {
    manifest,
    text,
    sha256: runtimeSourceManifestSha256(text)
  };
}

function readRuntimeSourceManifest(fileUrl = DEFAULT_RUNTIME_SOURCE_MANIFEST_FILE_URL) {
  const text = fs.readFileSync(fileUrl, 'utf8');
  const manifest = normalizeRuntimeSourceManifest(JSON.parse(text));
  if (text !== serializeRuntimeSourceManifest(manifest)) {
    throw new Error('RUNTIME_SOURCE_MANIFEST.json must use canonical single-line JSON with a trailing newline.');
  }
  return {
    manifest,
    text,
    sha256: runtimeSourceManifestSha256(text)
  };
}

function normalizeApplicationVersion(value) {
  if (value === undefined || value === null) return APPLICATION_VERSION_FALLBACK;
  const raw = String(value);
  if (!/^\d{2}\.\d{2}\.\d{2}\.\d{2}\n$/.test(raw)) {
    throw new Error('VERSION must contain exactly XX.YY.ZZ.NN followed by a newline.');
  }
  const version = raw.slice(0, -1);
  return version === APPLICATION_VERSION_PRE_HANDOFF_SENTINEL ? APPLICATION_VERSION_FALLBACK : version;
}

function normalizeApplicationBuildInfo(value, applicationVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BUILD_INFO.json must contain a JSON object.');
  }

  const version = String(value.version || '').trim();
  const revision = String(value.revision || '').trim().toLowerCase();
  const provenance = String(value.provenance || '').trim();
  const dirty = value.dirty === true || value.dirty === false ? value.dirty : null;
  const runtimeManifestSha256 = String(value.runtimeManifestSha256 || '').trim().toLowerCase();

  if (!APPLICATION_VERSION_PATTERN.test(version) || version === APPLICATION_VERSION_PRE_HANDOFF_SENTINEL) {
    throw new Error('BUILD_INFO.json version must contain a non-sentinel XX.YY.ZZ.NN value.');
  }
  if (version !== applicationVersion) {
    throw new Error(`BUILD_INFO.json version ${version} does not match VERSION ${applicationVersion}.`);
  }
  if (revision !== 'unknown' && !GIT_REVISION_PATTERN.test(revision)) {
    throw new Error('BUILD_INFO.json revision must be unknown or a 40-character lowercase Git SHA.');
  }
  if (!['verified', 'unverified-local'].includes(provenance)) {
    throw new Error('BUILD_INFO.json provenance must be verified or unverified-local.');
  }
  if (value.dirty !== null && value.dirty !== undefined && dirty === null) {
    throw new Error('BUILD_INFO.json dirty must be true, false, or null.');
  }
  if (!SHA256_PATTERN.test(runtimeManifestSha256)) {
    throw new Error('BUILD_INFO.json runtimeManifestSha256 must be a lowercase SHA-256 digest.');
  }
  if (provenance === 'verified' && (revision === 'unknown' || dirty !== false)) {
    throw new Error('Verified BUILD_INFO.json requires a Git revision and dirty=false.');
  }

  return { version, revision, dirty, provenance, runtimeManifestSha256 };
}

function editorSourceSha256(fileUrl = DEFAULT_EDITOR_SOURCE_FILE_URL) {
  const digest = sha256(fs.readFileSync(fileUrl));
  if (!SHA256_PATTERN.test(digest)) throw new Error('Editor source SHA-256 could not be calculated.');
  return digest;
}

function readApplicationBuildIdentity(options = {}) {
  const versionFileUrl = options.versionFileUrl || DEFAULT_VERSION_FILE_URL;
  const buildInfoFileUrl = options.buildInfoFileUrl || DEFAULT_BUILD_INFO_FILE_URL;
  const runtimeSourceManifestFileUrl = options.runtimeSourceManifestFileUrl || DEFAULT_RUNTIME_SOURCE_MANIFEST_FILE_URL;
  const editorSourceFileUrl = options.editorSourceFileUrl || DEFAULT_EDITOR_SOURCE_FILE_URL;
  let version = APPLICATION_VERSION_FALLBACK;
  let versionError = '';
  let buildInfoError = '';
  let editorSha256 = '';

  try {
    version = normalizeApplicationVersion(fs.readFileSync(versionFileUrl, 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      versionError = error && error.message ? String(error.message) : 'VERSION is invalid.';
    }
  }

  let manifestArtifact = null;
  try {
    manifestArtifact = readRuntimeSourceManifest(runtimeSourceManifestFileUrl);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      buildInfoError = error && error.message ? String(error.message) : 'RUNTIME_SOURCE_MANIFEST.json is invalid.';
    }
  }

  let build = {
    version,
    revision: 'unknown',
    dirty: null,
    provenance: 'unverified-local',
    runtimeManifestSha256: manifestArtifact ? manifestArtifact.sha256 : ''
  };
  try {
    const candidate = normalizeApplicationBuildInfo(JSON.parse(fs.readFileSync(buildInfoFileUrl, 'utf8')), version);
    if (!manifestArtifact) {
      throw new Error('BUILD_INFO.json requires RUNTIME_SOURCE_MANIFEST.json.');
    }
    if (candidate.runtimeManifestSha256 !== manifestArtifact.sha256) {
      throw new Error('BUILD_INFO.json runtimeManifestSha256 does not match RUNTIME_SOURCE_MANIFEST.json.');
    }
    build = candidate;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      buildInfoError = buildInfoError || (error && error.message ? String(error.message) : 'BUILD_INFO.json is invalid.');
    }
  }

  try {
    editorSha256 = editorSourceSha256(editorSourceFileUrl);
  } catch (error) {
    buildInfoError = buildInfoError || (error && error.message ? String(error.message) : 'Editor source SHA-256 is unavailable.');
  }

  return {
    ...build,
    editorSha256,
    versionError,
    buildInfoError
  };
}

function publicApplicationBuildIdentity(identity) {
  const source = identity && typeof identity === 'object' ? identity : {};
  return {
    version: String(source.version || APPLICATION_VERSION_FALLBACK),
    revision: String(source.revision || 'unknown'),
    dirty: source.dirty === true || source.dirty === false ? source.dirty : null,
    provenance: String(source.provenance || 'unverified-local'),
    runtimeManifestSha256: SHA256_PATTERN.test(String(source.runtimeManifestSha256 || ''))
      ? String(source.runtimeManifestSha256)
      : '',
    editorSha256: String(source.editorSha256 || '')
  };
}

function parseManifestCommandOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (['--root', '--output', '--expect-sha256'].includes(value)) {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`);
      options[value.slice(2).replace('-sha256', 'Sha256')] = next;
      index += 1;
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return options;
}

function manifestUsage() {
  return 'Usage: node scripts/build-identity.mjs manifest --root <checkout> --output <file> [--expect-sha256 <digest>]';
}

function runManifestCommand(args) {
  const options = parseManifestCommandOptions(args);
  if (options.help) {
    console.log(manifestUsage());
    return null;
  }
  if (!options.output) throw new Error('manifest requires --output <file>.');
  const artifact = createRuntimeSourceManifestArtifact(options.root || DEFAULT_RUNTIME_SOURCE_ROOT_URL);
  if (options.expectSha256) {
    const expected = String(options.expectSha256).trim().toLowerCase();
    if (!SHA256_PATTERN.test(expected)) throw new Error('--expect-sha256 must be a lowercase SHA-256 digest.');
    if (artifact.sha256 !== expected) {
      throw new Error(`Runtime source manifest SHA-256 ${artifact.sha256} does not match expected ${expected}.`);
    }
  }
  const outputPath = path.resolve(options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, artifact.text);
  console.log(artifact.sha256);
  return artifact;
}

function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h') {
    console.log(manifestUsage());
    return;
  }
  if (action !== 'manifest') throw new Error(`Unknown action: ${action}`);
  runManifestCommand(rest);
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
  APPLICATION_VERSION_FALLBACK,
  APPLICATION_VERSION_PRE_HANDOFF_SENTINEL,
  RUNTIME_SOURCE_MANIFEST_INCLUDES,
  createRuntimeSourceManifest,
  createRuntimeSourceManifestArtifact,
  editorSourceSha256,
  normalizeApplicationBuildInfo,
  normalizeApplicationVersion,
  normalizeRuntimeSourceManifest,
  publicApplicationBuildIdentity,
  readApplicationBuildIdentity,
  readRuntimeSourceManifest,
  runManifestCommand,
  runtimeSourceManifestSha256,
  serializeRuntimeSourceManifest
};
