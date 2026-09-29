import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredArtifacts = [
  'README.md',
  'business-processes.md',
  'information-model.md',
  'deployment.md',
  'openapi.yaml',
  'openapi/cmdbuild-consumed.openapi.yaml',
  'openapi/litellm-consumed.openapi.yaml',
  'healthcheck-map.md',
  'metrics-map.md',
  'event-logging-map.md',
  'secrets-map.md',
  'file-access-map.md',
  'logging-flow.md',
  'asyncapi-applicability.md',
  'kafka-access-map.md',
  'cmdbdynamicpages-environment-architecture.svg',
  'xlsx/healthcheck-map.xlsx',
  'xlsx/metrics-map.xlsx',
  'xlsx/event-logging-map.xlsx',
  'xlsx/secrets-rotation-map.xlsx'
];
const flowIdPattern = /^(?:OAPI|AAPI|IF|H|M|L)(?:0|[1-9]\d*)$/;
const flowReferencePattern = /\b(?:OAPI|AAPI|IF|H|M|L)-?(?:\d+|X+)\b/g;

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(file);
    return entry.isFile() ? [file] : [];
  });
}

function collectLinks(source, extension) {
  const links = [];
  if (extension === '.md') {
    for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^\s()]*\)[^\s()]*)*))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
      links.push(match[1] || match[2]);
    }
    for (const match of source.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) {
      links.push(match[1] || match[2]);
    }
  }
  if (extension === '.md' || extension === '.svg') {
    for (const match of source.matchAll(/\b(?:href|xlink:href|src)\s*=\s*(["'])(.*?)\1/g)) links.push(match[2]);
  }
  if (extension === '.yaml' || extension === '.yml') {
    for (const match of source.matchAll(/^\s*\$ref:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gm)) {
      links.push(match[1] || match[2] || match[3]);
    }
  }
  return links;
}

function resolveLink(root, file, link) {
  if (!link || link.startsWith('#') || link.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(link)) return null;
  const target = decodeURIComponent(link.split(/[?#]/)[0]);
  if (!target) return null;
  return target.startsWith('/') ? path.resolve(root, `.${target}`) : path.resolve(path.dirname(file), target);
}

function validateOperationFlows(source, file, definitions, errors) {
  // Follow the block-style paths used by the AA contracts, not schema properties named get/post.
  const lines = source.split(/\r?\n/);
  let inPaths = false;
  let route = '';
  let routeIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^paths:\s*(?:#.*)?$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith('#')) inPaths = false;
    if (!inPaths) continue;
    const routeMatch = line.match(/^( +)["']?(\/[^\s"']*)["']?:\s*(?:#.*)?$/);
    if (routeMatch) {
      route = routeMatch[2];
      routeIndent = routeMatch[1].length;
      continue;
    }
    const operation = line.match(/^( +)(get|put|post|delete|options|head|patch|trace):\s*(?:#.*)?$/);
    if (!route || !operation || operation[1].length !== routeIndent + 2) continue;
    const indent = operation[1].length;
    const flowIds = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].trim() || lines[next].trimStart().startsWith('#')) continue;
      const childIndent = lines[next].match(/^ */)[0].length;
      if (childIndent <= indent) break;
      if (childIndent !== indent + 2) continue;
      const flow = lines[next].trim().match(/^x-flow-id:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))\s*(?:#.*)?$/);
      if (flow) flowIds.push(flow[1] ?? flow[2] ?? flow[3]);
    }
    const location = `${file}:${index + 1} ${operation[2].toUpperCase()} ${route}`;
    if (flowIds.length !== 1) {
      errors.push(`${location} must define exactly one x-flow-id.`);
    } else if (!flowIdPattern.test(flowIds[0])) {
      errors.push(`${location} has invalid x-flow-id: ${flowIds[0]}`);
    } else if (!definitions.has(flowIds[0])) {
      errors.push(`${location} has unknown flow ID: ${flowIds[0]}`);
    }
  }
}

export function validateAa(root) {
  root = path.resolve(root);
  const aaDir = path.join(root, 'aa');
  const errors = [];
  if (!fs.existsSync(aaDir) || !fs.statSync(aaDir).isDirectory()) return ['Required AA directory is missing: aa'];

  const files = collectFiles(aaDir);
  const fileSet = new Set(files);
  for (const artifact of requiredArtifacts) {
    if (!fileSet.has(path.join(aaDir, artifact))) errors.push(`Required AA artifact is missing: aa/${artifact}`);
  }

  const sources = new Map(files.filter((file) => /\.(md|ya?ml|svg)$/i.test(file))
    .map((file) => [file, fs.readFileSync(file, 'utf8')]));
  const definitions = new Map();
  const model = sources.get(path.join(aaDir, 'information-model.md')) || '';
  let inRegistry = false;
  for (const [index, line] of model.split(/\r?\n/).entries()) {
    const cell = line.match(/^\s*\|\s*([^|]+?)\s*\|/);
    if (!cell) {
      inRegistry = false;
      continue;
    }
    const id = cell[1].trim().replace(/^`([^`]+)`$/, '$1');
    if (/^ID$/i.test(id)) {
      inRegistry = true;
      continue;
    }
    if (/^:?-+:?$/.test(id)) continue;
    if (!inRegistry && !/^(?:OAPI|AAPI|IF|H|M|L)-?(?:\d+|X+)$/.test(id)) continue;
    const location = `aa/information-model.md:${index + 1}`;
    if (!flowIdPattern.test(id)) {
      errors.push(`${location} has invalid flow ID definition: ${id}`);
    } else if (definitions.has(id)) {
      errors.push(`${location} has duplicate flow ID definition: ${id} (first at ${definitions.get(id)})`);
    } else {
      definitions.set(id, location);
    }
  }
  if (!definitions.size) errors.push('aa/information-model.md must define a typed flow ID registry in the first table column.');

  const indexTargets = new Set();
  for (const [file, source] of sources) {
    const relativeFile = path.relative(root, file);
    const extension = path.extname(file).toLowerCase();
    for (const link of collectLinks(source, extension)) {
      let target;
      try {
        target = resolveLink(root, file, link);
      } catch {
        errors.push(`${relativeFile} has invalid link: ${link}`);
        continue;
      }
      if (!target) continue;
      if (file === path.join(aaDir, 'README.md')) indexTargets.add(target);
      if (!fs.existsSync(target)) errors.push(`${relativeFile} has broken link: ${link}`);
    }

    // SVG drawing commands (M0, H10, L20, ...) are coordinates, not flow references.
    const referenceSource = extension === '.svg' ? source.replace(/\sd\s*=\s*(["'])[\s\S]*?\1/g, '') : source;
    for (const [index, line] of referenceSource.split(/\r?\n/).entries()) {
      for (const id of new Set(Array.from(line.matchAll(flowReferencePattern), (match) => match[0]))) {
        if (!flowIdPattern.test(id)) {
          errors.push(`${relativeFile}:${index + 1} has legacy or padded flow ID: ${id}`);
        } else if (!definitions.has(id)) {
          errors.push(`${relativeFile}:${index + 1} has unknown flow ID: ${id}`);
        }
      }
    }
    if (/\.ya?ml$/i.test(file) && /^openapi:/m.test(source)) validateOperationFlows(source, relativeFile, definitions, errors);
  }

  for (const artifact of requiredArtifacts) {
    if (artifact !== 'README.md' && !indexTargets.has(path.join(aaDir, artifact))) {
      errors.push(`aa/README.md must link to selected artifact: ${artifact}`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const errors = validateAa(root);
  if (errors.length) {
    for (const error of errors) console.error(`ERR ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`OK ${path.join(root, 'aa')}: artifacts, recursive links and flow IDs checked`);
  }
}
