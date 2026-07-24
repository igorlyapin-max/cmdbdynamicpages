import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTechnicalSchema,
  cmdbuildAdministrationViewHeaders,
  schemaParentFromInput,
  technicalSchemaBootstrapInput,
  technicalSchemaBootstrapFailure,
  technicalSchemaBootstrapInvalidInput,
  technicalSchemaBootstrapHttpStatus,
  technicalSchemaDefinition,
  technicalSchemaRootCause
} from '../../scripts/dev-proxy-server.mjs';

test('technical schema mutations use the CMDBuild administration view', () => {
  assert.deepEqual(cmdbuildAdministrationViewHeaders(), { 'CMDBuild-View': 'admin' });
});

test('technical schema plan derives all project classes from the selected root', () => {
  const schema = buildTechnicalSchema('Acme_QueryTool', {
    parent: 'Acme_TechnicalRoot',
    description: 'ACME dynamic pages'
  });

  assert.equal(schema.root, 'Acme_QueryTool');
  assert.equal(schema.rootParent, 'Acme_TechnicalRoot');
  assert.equal(schema.rootDescription, 'ACME dynamic pages');
  assert.deepEqual(schema.classNames, {
    root: 'Acme_QueryTool',
    config: 'Acme_QueryToolConfig',
    template: 'Acme_QueryTemplate',
    version: 'Acme_QueryTemplateVersion'
  });
  assert.equal(schema.classes[0].parent, 'Acme_TechnicalRoot');
  assert.equal(schema.classes[0].role, 'root');
  assert.equal(schema.classes[0].description, 'ACME dynamic pages');
  assert.equal(schema.classes[1].parent, 'Acme_QueryTool');
  assert.equal(schema.classes[1].role, 'config');
  assert.equal(schema.classes[1].description, 'Acme_QueryToolConfig');
  assert.ok(schema.classes.find((item) => item.name === 'Acme_QueryTemplate').attributes.find((item) => item.name === 'SpecJson'));
});

test('technical schema accepts the legacy default root and Class parent', () => {
  const schema = buildTechnicalSchema();

  assert.equal(schema.root, 'Cst_QueryTool');
  assert.equal(schema.rootParent, 'Class');
  assert.equal(schema.rootDescription, 'Cst_QueryTool');
  assert.equal(schema.classNames.template, 'Cst_QueryTemplate');
  assert.deepEqual(
    schema.classes.map((item) => item.description),
    [
      'Cst_QueryTool',
      'Cst_QueryToolConfig',
      'Cst_QueryTemplate',
      'Cst_QueryTemplateVersion'
    ]
  );
});

test('technical schema defines descriptions for every custom attribute', () => {
  const schema = buildTechnicalSchema();
  const attributes = schema.classes.flatMap((classDefinition) =>
    (classDefinition.attributes || []).map((attribute) => ({
      className: classDefinition.name,
      name: attribute.name,
      description: attribute.description
    }))
  );

  assert.ok(attributes.length > 0);
  assert.deepEqual(
    attributes.filter((attribute) => !String(attribute.description || '').trim()),
    []
  );
});

test('technical schema accepts per-class name and description overrides', () => {
  const schema = buildTechnicalSchema('Acme_QueryTool', {
    parent: 'Class',
    classes: [
      { role: 'root', name: 'AcmeRoot', description: 'Acme root' },
      { role: 'config', name: 'AcmeConfig', description: 'Acme config' },
      { role: 'template', name: 'AcmeTemplate', description: 'Acme template' },
      { role: 'version', name: 'AcmeTemplateVersion', description: 'Acme template version' }
    ]
  });

  assert.equal(schema.root, 'AcmeRoot');
  assert.deepEqual(schema.classNames, {
    root: 'AcmeRoot',
    config: 'AcmeConfig',
    template: 'AcmeTemplate',
    version: 'AcmeTemplateVersion'
  });
  assert.equal(schema.classes[1].parent, 'AcmeRoot');
  assert.equal(schema.classes[1].description, 'Acme config');
});

test('schema parent can be supplied with compatible field names', () => {
  assert.equal(schemaParentFromInput({ parent: 'ParentA' }), 'ParentA');
  assert.equal(schemaParentFromInput({ rootParent: 'ParentB' }), 'ParentB');
  assert.equal(schemaParentFromInput({ superclass: 'ParentC' }), 'ParentC');
  assert.equal(schemaParentFromInput({}, 'Class'), 'Class');
});

test('schema identifiers reject values that cannot be CMDBuild class names', () => {
  assert.throws(() => buildTechnicalSchema('bad-root'), /root must start/);
  assert.throws(() => buildTechnicalSchema('GoodRoot', { parent: 'bad-parent' }), /schema parent must start/);
});

test('technical schema execution uses the same class overrides as preview and bootstrap', () => {
  const schema = technicalSchemaDefinition('Acme_QueryTool', {
    parent: 'Acme_TechnicalRoot',
    description: 'ACME dynamic pages',
    classes: [
      { role: 'root', name: 'AcmeRoot', description: 'Acme root' },
      { role: 'config', name: 'AcmeConfig', description: 'Acme config' },
      { role: 'template', name: 'AcmeTemplate', description: 'Acme template' },
      { role: 'version', name: 'AcmeVersion', description: 'Acme version' }
    ]
  });

  assert.equal(schema.root, 'AcmeRoot');
  assert.equal(schema.rootParent, 'Acme_TechnicalRoot');
  assert.equal(schema.classNames.template, 'AcmeTemplate');
});

test('technical schema bootstrap exposes a safe actionable root cause and status', () => {
  const inaccessible = {
    ready: false,
    status: 'inaccessible',
    inaccessible: [{ type: 'attribute', className: 'AcmeTemplate', name: 'SpecJson', cmdbuildStatus: 403 }],
    conflicts: [],
    errors: [],
    missing: []
  };
  assert.deepEqual(technicalSchemaRootCause(inaccessible), {
    kind: 'access_denied',
    targetType: 'attribute',
    className: 'AcmeTemplate',
    attributeName: 'SpecJson',
    cmdbuildStatus: 403,
    reason: ''
  });
  assert.equal(technicalSchemaBootstrapHttpStatus(inaccessible), 403);
  assert.equal(technicalSchemaBootstrapHttpStatus({ ready: false, status: 'conflict' }), 409);
  assert.equal(technicalSchemaBootstrapHttpStatus({ ready: false, status: 'error' }), 502);

  const failure = technicalSchemaBootstrapFailure('AcmeRoot', Object.assign(new Error('upstream unavailable'), { code: 'ECONNRESET' }));
  assert.equal(failure.reason, 'technical_schema_bootstrap_unavailable');
  assert.equal(failure.rootCause.kind, 'upstream_error');
  assert.equal(failure.rootCause.reason, 'ECONNRESET');
});

test('technical schema bootstrap normalizes valid input and rejects invalid input before CMDBuild calls', () => {
  const input = technicalSchemaBootstrapInput({
    root: 'Acme_QueryTool',
    parent: 'Acme_TechnicalRoot',
    description: 'ACME dynamic pages',
    classes: [{ role: 'template', name: 'AcmeTemplate', description: 'ACME template' }]
  });

  assert.deepEqual(input, {
    root: 'Acme_QueryTool',
    parent: 'Acme_TechnicalRoot',
    description: 'ACME dynamic pages',
    classes: [{ role: 'template', name: 'AcmeTemplate', description: 'ACME template' }]
  });
  assert.throws(() => technicalSchemaBootstrapInput({ root: 'bad-root' }), /root must start/);
  assert.throws(() => technicalSchemaBootstrapInput({ root: 'GoodRoot', classes: {} }), /overrides must be an array/);
  const failure = technicalSchemaBootstrapInvalidInput('bad-root', Object.assign(new Error('invalid'), { code: 'invalid_schema_input' }));
  assert.equal(failure.reason, 'technical_schema_bootstrap_invalid_input');
  assert.equal(failure.rootCause.kind, 'invalid_input');
  assert.equal(failure.rootCause.cmdbuildStatus, 0);
});
