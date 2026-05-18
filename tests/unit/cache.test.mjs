import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TEMPLATE_CACHE_TTL_SEC,
  defaultRuntimeConfig,
  dependencyMapWithHash,
  normalizeRuntimeCacheConfig,
  normalizeTemplateCacheConfig,
  publicSnapshotParamsFromUrl,
  runtimeCacheKeyParts,
  runtimeCacheMeta
} from '../../scripts/dev-proxy-server.mjs';

const executionOptions = {
  maxRows: 25,
  maxClasses: 10,
  maxDomains: 10,
  maxRestCalls: 50,
  maxTraversalDepth: 1
};

const baseSpec = {
  version: 1,
  steps: [
    {
      type: 'selectCards',
      className: 'Router',
      as: 'Selection1',
      filters: [{ attribute: 'City', op: 'equals', valueParam: 'city' }],
      columns: ['Code', 'Description', 'City']
    }
  ],
  result: {
    tables: [{ name: 'Selection1', columns: ['Code', 'Description', 'City'] }]
  }
};

test('template cache defaults are endpoint-scoped and keep the 8 hour ttl default', () => {
  const runtimeCache = normalizeRuntimeCacheConfig(defaultRuntimeConfig());
  const config = normalizeTemplateCacheConfig({}, runtimeCache);

  if (!process.env.CMDBDYNAMIC_TEMPLATE_CACHE_TTL_HOURS) {
    assert.equal(DEFAULT_TEMPLATE_CACHE_TTL_SEC, 8 * 60 * 60);
  }
  assert.equal(config.enabled, true);
  assert.equal(config.scopeMode, 'permissionOnly');
  assert.equal(config.probeMode, 'usedFieldsOnly');
  assert.equal(config.shareMode, 'endpoint');
  assert.equal(config.ttlSeconds, DEFAULT_TEMPLATE_CACHE_TTL_SEC);
  assert.equal(config.allowManualRefresh, true);
});

test('privateUser cache mode is separated by current CMDBuild user', () => {
  const runtimeCache = normalizeRuntimeCacheConfig(defaultRuntimeConfig());
  const dependencyMap = dependencyMapWithHash(baseSpec);
  const template = { code: 'CacheProbe', active: true, spec: baseSpec };
  const config = normalizeTemplateCacheConfig({ cache: { scopeMode: 'privateUser' } }, runtimeCache);

  const alice = runtimeCacheKeyParts('Cst_QueryTool', template, { city: 'city49' }, { username: 'alice' }, executionOptions, runtimeCache, config, dependencyMap, {});
  const bob = runtimeCacheKeyParts('Cst_QueryTool', template, { city: 'city49' }, { username: 'bob' }, executionOptions, runtimeCache, config, dependencyMap, {});

  assert.equal(alice.cacheScope, 'per-user');
  assert.equal(bob.cacheScope, 'per-user');
  assert.notEqual(alice.key, bob.key);
});

test('permissionOnly cache mode shares a key across users after successful access probing', () => {
  const runtimeCache = normalizeRuntimeCacheConfig(defaultRuntimeConfig());
  const dependencyMap = dependencyMapWithHash(baseSpec);
  const template = { code: 'CacheProbe', active: true, spec: baseSpec };
  const config = normalizeTemplateCacheConfig({ cache: { scopeMode: 'permissionOnly' } }, runtimeCache);

  const alice = runtimeCacheKeyParts('Cst_QueryTool', template, { city: 'city49' }, { username: 'alice' }, executionOptions, runtimeCache, config, dependencyMap, {});
  const bob = runtimeCacheKeyParts('Cst_QueryTool', template, { city: 'city49' }, { username: 'bob' }, executionOptions, runtimeCache, config, dependencyMap, {});

  assert.equal(alice.cacheScope, 'endpoint');
  assert.equal(bob.cacheScope, 'endpoint');
  assert.equal(alice.key, bob.key);
  assert.equal(Object.prototype.hasOwnProperty.call(alice.keyPayload, 'userScopeHash'), false);
});

test('cache metadata exposes refresh cooldown and refresh permission', () => {
  const entry = {
    keyShort: 'abcdef1234567890',
    contentHash: 'content-hash',
    cacheScope: 'endpoint',
    scopeMode: 'permissionOnly',
    createdAt: 1_000,
    lastServedAt: 2_000,
    expiresAt: 61_000,
    refreshCooldownMs: 180_000,
    userScopeHash: 'user-scope',
    dependencyMapHash: 'dependency-map'
  };

  const cooling = runtimeCacheMeta(entry, 'hit', 3_000);
  assert.equal(cooling.refreshAllowed, false);
  assert.equal(cooling.nextRefreshAllowedAt, new Date(182_000).toISOString());
  assert.equal(cooling.sharedAcrossUsers, true);
  assert.equal(cooling.status, 'hit');

  const ready = runtimeCacheMeta(entry, 'refresh', 182_000);
  assert.equal(ready.refreshAllowed, true);
});

test('public snapshot URL params exclude runtime cache control switches', () => {
  const url = new URL('http://127.0.0.1:8093/cmdbuild/custom-api/public-snapshots/test/run?city=city49&lang=ru&refresh=1&noCache=1&forceRefresh=1&bypassRefreshCooldown=1');

  assert.deepEqual(publicSnapshotParamsFromUrl(url), { city: 'city49' });
});
