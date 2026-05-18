import fs from 'node:fs';
import path from 'node:path';

const openapiPath = path.resolve('aa/openapi.yaml');
const text = fs.readFileSync(openapiPath, 'utf8');

const requiredPaths = [
  '/health/live',
  '/health/ready',
  '/health/redis',
  '/cmdbuild/custom-api/cache/status',
  '/cmdbuild/custom-api/logging/status',
  '/cmdbuild/custom-api/schema/parents',
  '/cmdbuild/custom-api/schema/preview',
  '/cmdbuild/custom-api/templates/{code}/run'
];

const errors = [];

if (!text.startsWith('openapi: 3.0.3')) {
  errors.push('OpenAPI version header must be "openapi: 3.0.3".');
}
if (text.includes('\t')) {
  errors.push('aa/openapi.yaml contains tab characters.');
}

const paths = collectTopLevelKeysUnder('paths');
for (const requiredPath of requiredPaths) {
  if (!paths.has(requiredPath)) {
    errors.push(`Required OpenAPI path is missing: ${requiredPath}`);
  }
}

const componentNames = new Map([
  ['schemas', collectComponentKeys('schemas')],
  ['parameters', collectComponentKeys('parameters')],
  ['requestBodies', collectComponentKeys('requestBodies')],
  ['securitySchemes', collectComponentKeys('securitySchemes')]
]);

const refs = Array.from(text.matchAll(/"#\/components\/(schemas|parameters|requestBodies|securitySchemes)\/([^"]+)"/g));
for (const [, group, name] of refs) {
  if (!componentNames.get(group).has(name)) {
    errors.push(`Unresolved OpenAPI component reference: #/components/${group}/${name}`);
  }
}

if (errors.length) {
  for (const error of errors) {
    console.error(`ERR ${error}`);
  }
  process.exit(1);
}

console.log(`OK ${openapiPath}: paths=${paths.size} refs=${refs.length}`);

function collectTopLevelKeysUnder(sectionName) {
  const lines = text.split(/\r?\n/);
  const result = new Set();
  let inSection = false;
  for (const line of lines) {
    if (line === `${sectionName}:`) {
      inSection = true;
      continue;
    }
    if (inSection && /^[A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    if (!inSection) continue;
    const match = line.match(/^  (\/[^:]+):\s*$/);
    if (match) result.add(match[1]);
  }
  return result;
}

function collectComponentKeys(groupName) {
  const lines = text.split(/\r?\n/);
  const result = new Set();
  let inComponents = false;
  let inGroup = false;
  for (const line of lines) {
    if (line === 'components:') {
      inComponents = true;
      continue;
    }
    if (!inComponents) continue;
    if (line === `  ${groupName}:`) {
      inGroup = true;
      continue;
    }
    if (inGroup && /^  [A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    if (!inGroup) continue;
    const match = line.match(/^    ([A-Za-z][A-Za-z0-9_]*):\s*$/);
    if (match) result.add(match[1]);
  }
  return result;
}
