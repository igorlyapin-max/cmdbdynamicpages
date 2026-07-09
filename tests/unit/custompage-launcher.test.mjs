import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcherSource = fs.readFileSync('src/CmdbDynamicPages.js', 'utf8');
const proxySource = fs.readFileSync('scripts/dev-proxy-server.mjs', 'utf8');

test('CMDBuild custom page launcher redirects without relying only on afterrender', () => {
  assert.match(launcherSource, /CMDBuildUI\.view\.custompages\.CmdbDynamicPages\.CmdbDynamicPages/);
  assert.match(launcherSource, /function cmdbDynamicPagesScheduleOpenExternalUi/);
  assert.match(launcherSource, /cmdbDynamicPagesScheduleOpenExternalUi\('initComponent'\)/);
  assert.match(launcherSource, /cmdbDynamicPagesScheduleOpenExternalUi\('afterrender'\)/);
  assert.match(launcherSource, /window\.addEventListener\('hashchange'/);
  assert.match(launcherSource, /launcher-redirect/);
});

test('CMDBuild UI proxy injection tracks launcher hash changes', () => {
  assert.match(proxySource, /function rewriteCmdbuildUiHtml/);
  assert.match(proxySource, /function tryPending\(\)/);
  assert.match(proxySource, /window\.addEventListener\("hashchange",tryPending\)/);
  assert.match(proxySource, /cmdbdynamicpages\.pendingTarget/);
  assert.match(proxySource, /\/cmdbuild\/dynamicpages\/ui\/designer/);
});
