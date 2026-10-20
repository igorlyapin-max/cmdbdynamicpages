import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diagramImportBindRelationRulesToStructureItems } from '../../scripts/dev-proxy-server.mjs';

const source = readFileSync(new URL('../../scripts/dev-proxy-server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  function renderDiagramImportEndpointScopeControl(');
const end = source.indexOf('\n  function renderDiagramImportRelationRules(', start);
assert.ok(start >= 0 && end > start);
const render = new Function('escapeHtml', 't', 'diagramImportStructureTreeRoleClient',
  source.slice(start, end) + '\nreturn renderDiagramImportEndpointScopeControl;')(
  (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
  (key) => key,
  (_proposal, item) => ({ key: item.roleId })
);
const roles = [{ id: 'container', visualKind: 'container' }];
const tree = { items: [{ id: 'available', roleId: 'container', templateElementKey: 'root' }] };
const rule = { id: 'edge', kind: 'connection', mode: 'attributeEndpoints', endpointScopeStructureItemId: 'removed' };

function selectedValue(html) {
  const match = html.match(/<option value="([^"]*)" selected>/);
  assert.ok(match);
  return match[1];
}

test('missing scope remains an explicit invalid selection through render, capture, JSON and binding', () => {
  const html = render({}, tree.items, rule.endpointScopeStructureItemId);
  assert.equal(selectedValue(html), 'removed');
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, />removed</);
  const captured = JSON.parse(JSON.stringify({ ...rule, endpointScopeStructureItemId: selectedValue(html) }));
  const rebound = diagramImportBindRelationRulesToStructureItems([captured], tree, [], roles)[0];
  assert.equal(rebound.endpointScopeStructureItemId, 'removed');
  assert.equal(rebound.endpointScopeError.code, 'diagram_endpoint_scope_not_found');
});

test('existing scope is selected and an explicit empty selection alone permits the entire diagram', () => {
  const html = render({}, tree.items, 'available');
  assert.equal(selectedValue(html), 'available');
  assert.doesNotMatch(html, /aria-invalid/);
  const empty = render({}, tree.items, '');
  assert.equal(selectedValue(empty), '');
  assert.doesNotMatch(empty, /aria-invalid/);
  const rebound = diagramImportBindRelationRulesToStructureItems([{ ...rule, endpointScopeStructureItemId: '' }], tree, [], roles)[0];
  assert.equal(rebound.endpointScopeStructureItemId, '');
  assert.equal(rebound.endpointScopeError, undefined);
});

test('invalid scope option escapes markup and never renders internal identifiers as a label', () => {
  const html = render({}, [], 'removed"<script>');
  assert.match(html, /value="removed&quot;&lt;script&gt;" selected/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, />diagramImportEndpointScopeMissing</);
});
