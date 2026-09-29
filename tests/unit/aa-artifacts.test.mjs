import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAa } from '../../scripts/validate-aa-links.mjs';
import { validateOpenapiText } from '../../scripts/validate-openapi.mjs';

const validatorUrl = new URL('../../scripts/validate-aa-links.mjs', import.meta.url);
const artifacts = [
  'README.md', 'business-processes.md', 'information-model.md', 'deployment.md',
  'openapi.yaml', 'openapi/cmdbuild-consumed.openapi.yaml', 'openapi/litellm-consumed.openapi.yaml',
  'healthcheck-map.md', 'metrics-map.md', 'event-logging-map.md', 'secrets-map.md',
  'file-access-map.md', 'logging-flow.md', 'asyncapi-applicability.md', 'kafka-access-map.md',
  'cmdbdynamicpages-environment-architecture.svg',
  'xlsx/healthcheck-map.xlsx', 'xlsx/metrics-map.xlsx',
  'xlsx/event-logging-map.xlsx', 'xlsx/secrets-rotation-map.xlsx'
];
const flowIds = ['OAPI0', 'OAPI7', 'AAPI4', 'IF0', 'IF12', 'H0', 'M3', 'L8'];
const newRequiredPaths = [
  '/cmdbuild/custom-api/draft/diagram-import/restore',
  '/cmdbuild/custom-api/draft/diagram-import/refresh',
  '/cmdbuild/custom-api/auth/permission-scope',
  '/cmdbuild/custom-api/auth/capabilities',
  '/cmdbuild/custom-api/client-log',
  '/cmdbuild/custom-api/proxy-log'
];

function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdp-aa-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createFixture(t) {
  const root = createRoot(t);
  for (const artifact of artifacts) {
    // This validator checks inventory only; Python owns XLSX contents validation.
    write(root, `aa/${artifact}`, artifact.endsWith('.xlsx') ? Buffer.from('inventory fixture') : '');
  }
  write(root, 'aa/README.md', artifacts.filter((file) => file !== 'README.md')
    .map((file) => `[${file}](${file})`).join('\n'));
  write(root, 'aa/information-model.md', [
    '# Information model',
    '| ID | Source | Target |',
    '| --- | --- | --- |',
    ...flowIds.map((id) => `| ${id} | Source | Target |`)
  ].join('\n'));
  for (const artifact of artifacts.filter((file) => file.endsWith('.yaml'))) {
    write(root, `aa/${artifact}`, 'openapi: 3.0.3\npaths:\n  /example:\n    get:\n      x-flow-id: OAPI0\n      responses: {}\n');
  }
  write(root, 'aa/cmdbdynamicpages-environment-architecture.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M295 0 H200 L300 0"/><text>IF12 OAPI7</text></svg>');
  assert.deepEqual(validateAa(root), [], 'The independent AA fixture must be valid before mutation.');
  return root;
}

test('AA accepts an unpadded, noncontiguous first-column registry without mutating process state', (t) => {
  const root = createFixture(t);
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const first = validateAa(root);
  first.push('caller mutation');
  assert.deepEqual(validateAa(root), []);
  assert.equal(process.cwd(), cwd);
  assert.equal(process.exitCode, exitCode);
});

test('AA reports a missing directory without throwing', (t) => {
  assert.deepEqual(validateAa(createRoot(t)), ['Required AA directory is missing: aa']);
});

for (const artifact of artifacts) {
  test(`AA requires the inventory artifact ${artifact}`, (t) => {
    const root = createFixture(t);
    fs.unlinkSync(path.join(root, 'aa', artifact));
    assert.ok(validateAa(root).includes(`Required AA artifact is missing: aa/${artifact}`));
  });
}

test('AA does not count a directory as an XLSX artifact', (t) => {
  const root = createFixture(t);
  const file = path.join(root, 'aa/xlsx/metrics-map.xlsx');
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.ok(validateAa(root).includes('Required AA artifact is missing: aa/xlsx/metrics-map.xlsx'));
});

for (const artifact of artifacts.filter((file) => file !== 'README.md')) {
  test(`AA index must link the selected artifact ${artifact}`, (t) => {
    const root = createFixture(t);
    const index = path.join(root, 'aa/README.md');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(`[${artifact}](${artifact})`, artifact));
    assert.deepEqual(validateAa(root), [`aa/README.md must link to selected artifact: ${artifact}`]);
  });
}

test('AA validates nested links including XLSX, SVG, YAML refs and reference-style Markdown', (t) => {
  const root = createFixture(t);
  write(root, 'aa/nested/deep/links.md', [
    '[Workbook](../../xlsx/metrics-map.xlsx#sheet)',
    '![Diagram](../../cmdbdynamicpages-environment-architecture.svg "Architecture")',
    '[Model][model]',
    '[model]: ../../information-model.md#flows',
    '[Spaces](<file with spaces.json>)',
    '[Encoded](file%20with%20spaces.json?download=1#schema)',
    '[Root](/aa/README.md)',
    '[Anchor](#section)',
    '[Web](https://example.invalid/missing.xlsx)',
    '[CDN](//example.invalid/missing.svg)',
    '[Email](mailto:ops@example.invalid)'
  ].join('\n'));
  write(root, 'aa/nested/deep/file with spaces.json', '{}');
  write(root, 'aa/nested/deep/refs.yml', '$ref: "../../openapi.yaml#/paths"\n');
  write(root, 'aa/nested/deep/image.svg', '<svg><a href="../../information-model.md#flows"><text>IF12</text></a></svg>');
  assert.deepEqual(validateAa(root), []);
});

for (const [name, contents, target] of [
  ['links.md', '[Missing](missing.xlsx)', 'missing.xlsx'],
  ['image.md', '![Missing](missing.svg)', 'missing.svg'],
  ['refs.md', '[Missing][ref]\n[ref]: missing.yaml', 'missing.yaml'],
  ['refs.yml', '$ref: "missing.yaml#/paths"', 'missing.yaml#/paths'],
  ['image.svg', '<svg><image xlink:href="missing.svg"/></svg>', 'missing.svg']
]) {
  test(`AA rejects a broken nested link in ${name}`, (t) => {
    const root = createFixture(t);
    write(root, `aa/nested/deep/${name}`, contents);
    assert.deepEqual(validateAa(root), [`aa/nested/deep/${name} has broken link: ${target}`]);
  });
}

test('AA reports malformed URL encoding instead of throwing', (t) => {
  const root = createFixture(t);
  write(root, 'aa/nested/links.md', '[Bad](bad%GG.xlsx)');
  assert.deepEqual(validateAa(root), ['aa/nested/links.md has invalid link: bad%GG.xlsx']);
});

for (const extension of ['md', 'yaml', 'yml', 'svg']) {
  test(`AA rejects unknown references in nested ${extension}`, (t) => {
    const root = createFixture(t);
    write(root, `aa/nested/deep/reference.${extension}`, extension === 'svg'
      ? '<svg><text>OAPI99</text></svg>' : 'Flow: OAPI99');
    assert.deepEqual(validateAa(root), [`aa/nested/deep/reference.${extension}:1 has unknown flow ID: OAPI99`]);
  });
  test(`AA rejects legacy and padded references in nested ${extension}`, (t) => {
    const root = createFixture(t);
    const invalidIds = ['IF-001', 'IF-XXX', 'IF00', 'OAPI01', 'AAPI04', 'H00', 'M03', 'L08'];
    write(root, `aa/nested/deep/reference.${extension}`, invalidIds.join(' '));
    const errors = validateAa(root);
    for (const id of invalidIds) assert.ok(errors.some((error) => error.endsWith(`legacy or padded flow ID: ${id}`)), id);
    assert.equal(errors.length, invalidIds.length);
  });
}

test('AA only registers the first column, not prose or other columns', (t) => {
  const root = createFixture(t);
  fs.appendFileSync(path.join(root, 'aa/information-model.md'), '\nMention OAPI99\n| Note | OAPI99 | Target |\n');
  const errors = validateAa(root);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.includes('unknown flow ID: OAPI99')));
});

test('AA rejects an absent first-column registry even when IDs occur in prose', (t) => {
  const root = createFixture(t);
  write(root, 'aa/information-model.md', flowIds.join(' '));
  assert.ok(validateAa(root).some((error) => error.includes('must define a typed flow ID registry')));
});

test('AA rejects duplicate definitions including backtick-formatted IDs', (t) => {
  const root = createFixture(t);
  fs.appendFileSync(path.join(root, 'aa/information-model.md'), '\n| `OAPI0` | Other | Target |\n');
  const errors = validateAa(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate flow ID definition: OAPI0/);
});

for (const id of ['IF-001', 'IF-XXX', 'OAPI00', 'AAPI01', 'IF01', 'H00', 'M03', 'L08', 'OTHER0', 'OAPI0suffix', 'OAPIx']) {
  test(`AA rejects malformed registry definition ${id}`, (t) => {
    const root = createFixture(t);
    fs.appendFileSync(path.join(root, 'aa/information-model.md'), `\n| ${id} | Source | Target |\n`);
    assert.ok(validateAa(root).some((error) => error.includes(`invalid flow ID definition: ${id}`)));
  });
}

for (const artifact of artifacts.filter((file) => file.endsWith('.yaml'))) {
  test(`AA requires an operation-level x-flow-id in ${artifact}`, (t) => {
    const root = createFixture(t);
    write(root, `aa/${artifact}`, 'openapi: 3.0.3\nx-flow-id: OAPI0\npaths:\n  /example:\n    x-flow-id: OAPI0\n    get:\n      responses: {}\n');
    assert.deepEqual(validateAa(root), [`aa/${artifact}:6 GET /example must define exactly one x-flow-id.`]);
  });
}

test('AA validates every operation, not just the first method', (t) => {
  const root = createFixture(t);
  fs.appendFileSync(path.join(root, 'aa/openapi.yaml'), '    post:\n      responses: {}\n');
  assert.deepEqual(validateAa(root), ['aa/openapi.yaml:7 POST /example must define exactly one x-flow-id.']);
});

for (const id of ['OAPI99', 'OAPI01', 'untyped', '']) {
  test(`AA rejects invalid operation x-flow-id ${JSON.stringify(id)}`, (t) => {
    const root = createFixture(t);
    write(root, 'aa/openapi.yaml', `openapi: 3.0.3\npaths:\n  /example:\n    get:\n      x-flow-id: "${id}"\n`);
    assert.ok(validateAa(root).some((error) => error.includes('GET /example') && /invalid x-flow-id|unknown flow ID/.test(error)));
  });
}

test('AA rejects duplicate operation extensions', (t) => {
  const root = createFixture(t);
  fs.appendFileSync(path.join(root, 'aa/openapi.yaml'), '      x-flow-id: OAPI7\n');
  assert.deepEqual(validateAa(root), ['aa/openapi.yaml:4 GET /example must define exactly one x-flow-id.']);
});

test('AA CLI defaults to cwd and accepts an explicit root with meaningful exit codes', (t) => {
  const root = createFixture(t);
  const elsewhere = createRoot(t);
  for (const [args, cwd] of [[[], root], [[root], elsewhere]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(validatorUrl), ...args], { cwd, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /artifacts, recursive links and flow IDs checked/);
    assert.equal(result.stderr, '');
  }
  fs.unlinkSync(path.join(root, 'aa/xlsx/healthcheck-map.xlsx'));
  const failed = spawnSync(process.execPath, [fileURLToPath(validatorUrl)], { cwd: root, encoding: 'utf8' });
  assert.ifError(failed.error);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Required AA artifact is missing: aa\/xlsx\/healthcheck-map.xlsx/);
});

test('AA module import does not run the CLI or inspect cwd', (t) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(validatorUrl.href)})`], {
    cwd: createRoot(t), encoding: 'utf8'
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('OpenAPI required paths include restore, refresh, auth capabilities and logs without relaxing old checks', () => {
  const base = 'openapi: 3.0.3\npaths:\n';
  const before = validateOpenapiText(base).errors;
  for (const route of newRequiredPaths) assert.ok(before.includes(`Required OpenAPI path is missing: ${route}`));
  const after = validateOpenapiText(base + newRequiredPaths.map((route) => `  ${route}:\n    get:\n      responses: {}\n`).join('')).errors;
  assert.deepEqual(after, before.filter((error) => !newRequiredPaths.some((route) => error === `Required OpenAPI path is missing: ${route}`)));
  assert.ok(after.includes('Required OpenAPI path is missing: /health/live'));
  assert.ok(after.some((error) => error.includes('DiagramImportAnalyzeRequest')));
});
