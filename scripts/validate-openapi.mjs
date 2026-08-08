import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredPaths = [
  '/health/live',
  '/health/ready',
  '/health/redis',
  '/cmdbuild/custom-api/cache/status',
  '/cmdbuild/custom-api/logging/status',
  '/cmdbuild/custom-api/schema/parents',
  '/cmdbuild/custom-api/schema/preview',
  '/cmdbuild/custom-api/templates/{code}/run',
  '/cmdbuild/custom-api/assistant/object-flow/semantic-plan',
  '/cmdbuild/custom-api/assistant/object-flow/plan',
  '/cmdbuild/custom-api/draft/diagram-import/analyze',
  '/cmdbuild/custom-api/draft/diagram-import/apply',
  '/cmdbuild/custom-api/assistant/diagram-import/interpret',
  '/cmdbuild/custom-api/assistant/diagram-import/map-selections'
];

const diagramAssistantPathContracts = [
  {
    path: '/cmdbuild/custom-api/draft/diagram-import/analyze',
    requestSchema: 'DiagramImportAnalyzeRequest',
    statuses: ['200', '400', '401', '403', '413', '415', '422', '429', '502'],
    successSchemas: { '200': 'DiagramImportAnalyzeResponse' },
    errorSchema: 'DiagramImportErrorResponse'
  },
  {
    path: '/cmdbuild/custom-api/draft/diagram-import/apply',
    requestSchema: 'DiagramImportApplyRequest',
    statuses: ['200', '400', '401', '403', '409', '413', '415', '422', '429', '502'],
    successSchemas: { '200': 'DiagramImportApplyResponse' },
    errorSchema: 'DiagramImportErrorResponse'
  },
  {
    path: '/cmdbuild/custom-api/assistant/diagram-import/interpret',
    requestSchema: 'AssistantDiagramImportInterpretRequest',
    statuses: ['200', '400', '401', '403', '409', '413', '415', '422', '429', '502', '503', '504'],
    successSchemas: { '200': 'AssistantDiagramImportInterpretResponse' },
    errorSchema: 'AssistantDiagramErrorResponse'
  },
  {
    path: '/cmdbuild/custom-api/assistant/diagram-import/map-selections',
    requestSchema: 'AssistantDiagramImportMapSelectionsRequest',
    statuses: ['200', '202', '400', '401', '403', '409', '413', '415', '422', '429', '502', '503', '504'],
    successSchemas: {
      '200': 'AssistantDiagramImportMapSelectionsResponse',
      '202': 'AssistantDiagramImportMapCheckpointResponse'
    },
    errorSchema: 'AssistantDiagramErrorResponse'
  }
];

const diagramAssistantSchemaContracts = [
  {
    name: 'DiagramImportAnalyzeRequest',
    properties: ['templateCode', 'baseSpecHash', 'currentSpec', 'd2Source'],
    required: ['templateCode', 'baseSpecHash', 'currentSpec', 'd2Source']
  },
  {
    name: 'DiagramImportApplyRequest',
    properties: ['templateCode', 'baseSpecHash', 'currentSpec', 'd2Source', 'proposal', 'roles', 'relationRules', 'structureTree', 'endpointProfiles'],
    required: ['templateCode', 'baseSpecHash', 'currentSpec', 'd2Source', 'proposal', 'roles', 'structureTree']
  },
  {
    name: 'AssistantDiagramImportInterpretRequest',
    properties: ['templateRef', 'editorDelta', 'proposal', 'prompt', 'roles', 'relationRules', 'structureTree'],
    required: ['templateRef', 'editorDelta', 'proposal', 'roles', 'structureTree', 'prompt']
  },
  {
    name: 'AssistantDiagramImportMapSelectionsRequest',
    properties: ['templateRef', 'editorDelta', 'proposal', 'prompt', 'roles', 'relationRules', 'structureTree', 'traversalDepth', 'stage', 'resumeId', 'stages'],
    required: ['templateRef', 'editorDelta', 'proposal', 'roles', 'structureTree', 'prompt', 'traversalDepth', 'stage', 'resumeId']
  },
  {
    name: 'AssistantTemplateRef',
    properties: ['root', 'templateCode', 'baseSpecHash'],
    required: ['root', 'templateCode', 'baseSpecHash']
  },
  {
    name: 'AssistantEditorDelta',
    properties: ['version', 'hash', 'spec'],
    required: ['version', 'spec']
  },
  {
    name: 'AssistantObjectFlowSemanticPlanRequest',
    properties: ['templateRef', 'editorDelta', 'intent', 'stage', 'resumeId'],
    required: ['templateRef', 'editorDelta', 'intent', 'stage', 'resumeId']
  },
  {
    name: 'AssistantObjectFlowPlanRequest',
    properties: ['templateRef', 'editorDelta', 'intent', 'semanticPlan', 'resumeId'],
    required: ['templateRef', 'editorDelta', 'intent', 'semanticPlan', 'resumeId']
  },
  {
    name: 'AssistantDiagramModels',
    properties: ['dataSemanticModel', 'd2StructuralModel', 'd2SemanticModel', 'd2BindingModel', 'coverageModel'],
    required: ['dataSemanticModel', 'd2StructuralModel', 'd2SemanticModel']
  },
  {
    name: 'AssistantDataSemanticRule',
    properties: ['action', 'negate', 'operator', 'path', 'rightExpression', 'expressionKind', 'leftColumn', 'rightColumn'],
    required: ['action', 'negate', 'operator', 'path', 'rightExpression', 'expressionKind', 'leftColumn', 'rightColumn']
  },
  {
    name: 'AssistantDiagramMappingCheckpoint',
    properties: ['resumeId', 'stage', 'nextStage', 'rolesReused', 'attempt', 'transientAttempt', 'correctionAttempt', 'automaticRetriesRemaining', 'correctionRetriesRemaining', 'checkpointTtlSec', 'expiresAt'],
    required: ['resumeId', 'stage', 'nextStage', 'rolesReused', 'attempt', 'transientAttempt', 'correctionAttempt', 'automaticRetriesRemaining', 'correctionRetriesRemaining', 'checkpointTtlSec', 'expiresAt']
  },
  {
    name: 'AssistantDiagramMappingCoverage',
    properties: ['status', 'requiredRoles', 'mappedRoles', 'requiredContainers', 'mappedContainers', 'requiredConnections', 'mappedConnections', 'objectCoverage', 'containerCoverage', 'connectionCoverage', 'unresolved', 'missingMappings', 'missingConnectionMappings']
  },
  {
    name: 'AssistantDiagramImportMapSelectionsResponse',
    properties: ['mappings', 'relationRules', 'connectionUnresolved', 'structureTree', 'mapping', 'models', 'resume']
  },
  {
    name: 'AssistantDiagramImportMapCheckpointResponse',
    properties: ['checkpoint', 'mapping', 'models', 'diagnostics']
  },
  {
    name: 'AssistantDiagramErrorResponse',
    properties: ['retryable', 'retryKind', 'resume', 'mapping', 'models', 'diagnostics']
  },
  {
    name: 'DiagramImportStructureTree',
    properties: ['version', 'items'],
    required: ['version', 'items']
  },
  {
    name: 'DiagramSelectionMapping',
    properties: ['structureItemId', 'roleId', 'source', 'mapping', 'confidence', 'reason'],
    required: ['structureItemId', 'roleId', 'source', 'mapping', 'confidence', 'reason']
  }
];

let text = '';
let errors = [];

export function validateOpenapiText(source) {
  text = String(source || '');
  errors = [];

  if (!text.startsWith('openapi: 3.0.3')) {
    errors.push('OpenAPI version header must be "openapi: 3.0.3".');
  }
  if (text.includes('\t')) {
    errors.push('aa/openapi.yaml contains tab characters.');
  }
  if (/nullable:\s*true\s*\n\s*oneOf:/m.test(text)) {
    errors.push('OpenAPI 3.0 nullable cannot be applied to a oneOf schema without its own type.');
  }

  const paths = collectTopLevelKeysUnder('paths');
  for (const requiredPath of requiredPaths) {
    if (!paths.has(requiredPath)) {
      errors.push(`Required OpenAPI path is missing: ${requiredPath}`);
    }
  }

  const componentNames = new Map([
    ['schemas', collectComponentKeys('schemas')],
    ['headers', collectComponentKeys('headers')],
    ['parameters', collectComponentKeys('parameters')],
    ['requestBodies', collectComponentKeys('requestBodies')],
    ['securitySchemes', collectComponentKeys('securitySchemes')]
  ]);

  const refs = Array.from(text.matchAll(/"#\/components\/(schemas|headers|parameters|requestBodies|securitySchemes)\/([^"]+)"/g));
  for (const [, group, name] of refs) {
    if (!componentNames.get(group).has(name)) {
      errors.push(`Unresolved OpenAPI component reference: #/components/${group}/${name}`);
    }
  }

  for (const schemaName of ['BuildIdentity', 'HealthBase', 'LiveHealth', 'RedisHealth', 'ReadyHealth']) {
    if (!componentNames.get('schemas').has(schemaName)) {
      errors.push(`Required OpenAPI schema is missing: ${schemaName}`);
    }
  }
  for (const headerName of ['CmdpVersion', 'CmdpRevision', 'CmdpProvenance', 'CmdpEditorSha256']) {
    if (!componentNames.get('headers').has(headerName)) {
      errors.push(`Required OpenAPI header is missing: ${headerName}`);
    }
  }

  for (const contract of diagramAssistantPathContracts) {
    validateDiagramAssistantPath(contract);
  }

  for (const contract of diagramAssistantSchemaContracts) {
    validateSchemaContract(contract);
  }

  assertPropertyContains('AssistantDiagramImportMapSelectionsRequest', 'stage', 'enum: [roles, topology]');
  assertPropertyContains('AssistantDiagramImportMapSelectionsRequest', 'traversalDepth', 'minimum: 1');
  assertPropertyContains('AssistantDiagramImportMapSelectionsRequest', 'traversalDepth', 'maximum: 5');
  assertPropertyContains('AssistantDiagramImportMapSelectionsRequest', 'resumeId', 'pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$"');
  assertPropertyContains('DiagramImportStructureTree', 'version', 'enum: [5]');
  assertSchemaContainsRef('AssistantDiagramMappingResume', 'AssistantDiagramMappingCheckpoint');
  assertSchemaContainsRef('AssistantDiagramImportMapSelectionsResponse', 'AssistantDiagramModels');
  assertSchemaContainsRef('AssistantDiagramImportMapSelectionsResponse', 'AssistantDiagramMappingCoverage');
  assertSchemaContainsRef('AssistantDiagramImportMapCheckpointResponse', 'AssistantDiagramMappingCheckpoint');
  assertSchemaContainsRef('AssistantDiagramImportMapCheckpointResponse', 'AssistantDiagramMappingCoverage');

  for (const [schemaName, retiredProperty] of [
    ['DiagramImportApplyRequest', 'placementRules'],
    ['AssistantDiagramImportInterpretRequest', 'placementRules'],
    ['AssistantDiagramImportMapSelectionsRequest', 'placementRules'],
    ['DiagramImportRoleOverride', 'selectedSemantic']
  ]) {
    const properties = collectDirectSchemaProperties(extractSchemaBlock(schemaName));
    if (properties.has(retiredProperty)) {
      errors.push(`Retired Diagram Assistant property is present: ${schemaName}.${retiredProperty}`);
    }
  }

  return { errors: [...errors], pathCount: paths.size, refCount: refs.length };
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const openapiPath = path.resolve(process.argv[2] || 'aa/openapi.yaml');
  const result = validateOpenapiText(fs.readFileSync(openapiPath, 'utf8'));
  if (result.errors.length) {
    for (const error of result.errors) console.error(`ERR ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`OK ${openapiPath}: paths=${result.pathCount} refs=${result.refCount}`);
  }
}

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

function validateDiagramAssistantPath(contract) {
  const block = extractPathBlock(contract.path);
  if (!block) return;
  const requestBoundary = block.indexOf('\n      requestBody:');
  const responseBoundary = block.indexOf('\n      responses:');
  const requestBlock = requestBoundary >= 0 && responseBoundary > requestBoundary
    ? block.slice(requestBoundary, responseBoundary)
    : '';
  const expectedRequestRef = `#/components/schemas/${contract.requestSchema}`;
  if (!requestBlock.includes(`$ref: "${expectedRequestRef}"`)) {
    errors.push(`Diagram Assistant request schema drift at ${contract.path}: expected ${expectedRequestRef}`);
  }

  const statusMatches = Array.from(block.matchAll(/^        "(\d{3})":\s*$/gm), (match) => match[1]);
  const actualStatuses = new Set(statusMatches);
  if (statusMatches.length !== actualStatuses.size) {
    errors.push(`Duplicate Diagram Assistant response status at ${contract.path}`);
  }
  assertExactSet(
    actualStatuses,
    new Set(contract.statuses),
    `Diagram Assistant response status drift at ${contract.path}`
  );

  for (const status of contract.statuses) {
    const statusBlock = extractIndentedBlock(block, `        "${status}":`, 8);
    const expectedSchema = contract.successSchemas[status] || contract.errorSchema;
    if (!statusBlock.includes(`$ref: "#/components/schemas/${expectedSchema}"`)) {
      errors.push(`Diagram Assistant response schema drift at ${contract.path} HTTP ${status}: expected ${expectedSchema}`);
    }
  }
}

function validateSchemaContract(contract) {
  const block = extractSchemaBlock(contract.name);
  if (!block) {
    errors.push(`Required Diagram Assistant schema is missing: ${contract.name}`);
    return;
  }
  const properties = collectDirectSchemaProperties(block);
  for (const property of contract.properties || []) {
    if (!properties.has(property)) {
      errors.push(`Diagram Assistant schema property drift: ${contract.name}.${property} is missing`);
    }
  }
  if (contract.required) {
    assertExactSet(
      collectInlineRequired(block),
      new Set(contract.required),
      `Diagram Assistant required-field drift in ${contract.name}`
    );
  }
}

function assertPropertyContains(schemaName, propertyName, expectedText) {
  const schemaBlock = extractSchemaBlock(schemaName);
  const propertyBlock = extractIndentedBlock(schemaBlock, `        ${propertyName}:`, 8);
  if (!propertyBlock.includes(expectedText)) {
    errors.push(`Diagram Assistant property contract drift: ${schemaName}.${propertyName} must contain ${expectedText}`);
  }
}

function assertSchemaContainsRef(schemaName, referencedSchema) {
  const schemaBlock = extractSchemaBlock(schemaName);
  if (!schemaBlock.includes(`$ref: "#/components/schemas/${referencedSchema}"`)) {
    errors.push(`Diagram Assistant schema reference drift: ${schemaName} must reference ${referencedSchema}`);
  }
}

function assertExactSet(actual, expected, message) {
  const missing = Array.from(expected).filter((value) => !actual.has(value));
  const unexpected = Array.from(actual).filter((value) => !expected.has(value));
  if (missing.length || unexpected.length) {
    errors.push(`${message}: missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`);
  }
}

function extractPathBlock(pathName) {
  return extractIndentedBlock(text, `  ${pathName}:`, 2);
}

function extractSchemaBlock(schemaName) {
  return extractIndentedBlock(text, `    ${schemaName}:`, 4);
}

function extractIndentedBlock(source, header, indent) {
  if (!source) return '';
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === header);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && leadingSpaces(line) <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

function collectDirectSchemaProperties(schemaBlock) {
  const lines = schemaBlock.split(/\r?\n/);
  const properties = new Set();
  const start = lines.findIndex((line) => line === '      properties:');
  if (start < 0) return properties;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && leadingSpaces(line) <= 6) break;
    const match = line.match(/^        ([A-Za-z][A-Za-z0-9_]*):\s*$/);
    if (match) properties.add(match[1]);
  }
  return properties;
}

function collectInlineRequired(schemaBlock) {
  const match = schemaBlock.match(/^      required: \[([^\]]*)\]\s*$/m);
  if (!match) return new Set();
  return new Set(match[1].split(',').map((value) => value.trim()).filter(Boolean));
}

function leadingSpaces(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}
