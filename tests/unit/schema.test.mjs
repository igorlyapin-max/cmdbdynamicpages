import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTechnicalSchema,
  schemaParentFromInput
} from '../../scripts/dev-proxy-server.mjs';

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
    version: 'Acme_QueryTemplateVersion',
    log: 'Acme_QueryExecutionLog'
  });
  assert.equal(schema.classes[0].parent, 'Acme_TechnicalRoot');
  assert.equal(schema.classes[1].parent, 'Acme_QueryTool');
  assert.ok(schema.classes.find((item) => item.name === 'Acme_QueryTemplate').attributes.find((item) => item.name === 'SpecJson'));
});

test('technical schema accepts the legacy default root and Class parent', () => {
  const schema = buildTechnicalSchema();

  assert.equal(schema.root, 'Cst_QueryTool');
  assert.equal(schema.rootParent, 'Class');
  assert.equal(schema.classNames.template, 'Cst_QueryTemplate');
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
