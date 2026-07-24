import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const compose = fs.readFileSync('dev/cmdbuild42/docker-compose.yml', 'utf8');
const dockerfile = fs.readFileSync('dev/cmdbuild42/Dockerfile', 'utf8');
const entrypoint = fs.readFileSync('dev/cmdbuild42/entrypoint.sh', 'utf8');
const backendLauncher = fs.readFileSync('scripts/run-cmdbuild42-backend.sh', 'utf8');
const downloader = fs.readFileSync('scripts/download-cmdbuild42-war.sh', 'utf8');

test('CMDBuild 4.2 compatibility harness is isolated from delivery runtime', () => {
  assert.match(compose, /postgres:17\.4-alpine/);
  assert.match(compose, /127\.0\.0\.1:\$\{CMDBUILD42_HOST_PORT\}:8080/);
  assert.doesNotMatch(compose, /network_mode:\s*host/);
  assert.doesNotMatch(compose, /cmdbdynamicpages-backend/);
  assert.match(compose, /cmdbuild42-postgres/);
  assert.match(compose, /cmdbuild42-runtime/);
  assert.match(compose, /POSTGRES_DB: postgres/);
});

test('CMDBuild 4.2 image accepts only a verified vendor WAR', () => {
  assert.match(dockerfile, /tomcat:10\.1-jdk17-temurin/);
  assert.match(dockerfile, /CMDBUILD_WAR_SHA256/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /postgresql\.org\/media\/keys\/ACCC4CF8\.asc/);
  assert.match(dockerfile, /noble-pgdg/);
  assert.match(dockerfile, /postgresql-client-17/);
  assert.match(dockerfile, /useradd --system --uid 10001/);
  assert.match(dockerfile, /USER cmdbuild/);
  assert.match(dockerfile, /jar xf \/tmp\/cmdbuild\.war/);
  assert.match(dockerfile, /chmod 0755 cmdbuild\.sh/);
  assert.match(downloader, /sourceforge\.net\/projects\/cmdbuild\/files\/4\.2\.0\/cmdbuild-4\.2\.0\.war\/download/);
  assert.match(downloader, /curl --http1\.1/);
  assert.match(downloader, /wc -c/);
  assert.match(downloader, /jar tf/);
  assert.match(downloader, /unzip -tq/);
});

test('CMDBuild 4.2 initialization is demo-only and idempotent', () => {
  assert.match(entrypoint, /database\.conf_example/);
  assert.match(entrypoint, /dbconfig create demo/);
  assert.match(entrypoint, /demo-db-initialized/);
  assert.match(entrypoint, /jdbc:postgresql:\/\/cmdbuild42-db:5432/);
  assert.doesNotMatch(entrypoint, /dbconfig drop/);
  assert.ok(
    entrypoint.indexOf('cp "$webapp/WEB-INF/conf/database.conf_example" "$config_file"')
      < entrypoint.indexOf('if [ ! -f "$init_marker" ]; then'),
    'database.conf must be rebuilt even when the persistent demo marker exists',
  );
});

test('comparison backend uses a separate local origin and does not require Redis', () => {
  assert.match(backendLauncher, /CMDP_CMDBUILD42_PROXY_PORT:=8095/);
  assert.match(backendLauncher, /CMDBUILD_ORIGIN="http:\/\/127\.0\.0\.1:\$\{CMDBUILD42_HOST_PORT\}"/);
  assert.match(backendLauncher, /CMDBDYNAMIC_REDIS_REQUIRED=false/);
  assert.match(backendLauncher, /CMDP_DIAGNOSTIC_MODE=basic/);
  assert.match(backendLauncher, /CMDP_D2_RENDER_ENABLED=false/);
  assert.match(backendLauncher, /d2-import-stub\.mjs/);
});
