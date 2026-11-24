import assert from 'node:assert/strict';

function functionSource(source, name) {
  const start = source.indexOf('\nfunction ' + name + '(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start + 1, end + 2);
}

export function bindViewLargeExecutionHelpers(proxySource) {
  const helpers = [
    'normalizeStringList', 'normalizePathColumnSpecs', 'normalizeComposeColumns', 'composeRightAlias',
    'buildMatchRowsColumnMapping', 'buildRightColumnMapping', 'normalizeRowOperationKeys', 'renderViewLargeExecutionHelpers'
  ];
  return Function(helpers.map((name) => functionSource(proxySource, name)).join('\n') + '\nreturn renderViewLargeExecutionHelpers;')();
}
