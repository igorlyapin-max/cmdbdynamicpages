# cmdbdynamicpages Runbook

## Purpose

Use this runbook for production deployment checks, rollback, diagnostics, and common incident triage. Do not place live cookies, Redis passwords, CMDBuild tokens, or raw secret values in tickets, logs, docs, or test fixtures.

## Deployment Checks

Before deploy:

```bash
npm run ci
```

Runtime package check:

```bash
npm run build:zip
unzip -t dist/cmdbdynamicpages-custompage.zip
```

Required production configuration:

```text
NODE_ENV=production
CMDP_PUBLIC_ORIGIN=https://custom.example.local
CMDP_NGINX_PUBLIC_HOST=custom.example.local
CMDP_NGINX_PUBLIC_PROTO=https
CMDBDYNAMIC_REDIS_URL=rediss://redis.example.local:6380/0
CMDP_TLS_CA_FILE=
CMDP_TLS_CA_FILE_HOST=
CMDBDYNAMICPAGES_CSRF_SECRET=<external stable secret>
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDP_LOG_TARGET=stdout
CMDP_DIAGNOSTIC_MODE=off
```

Post-deploy checks:

```text
GET /health/live
GET /health/redis
GET /health/ready
GET /metrics
GET /cmdbuild/custom-api/logging/status
```

Expected result: `/health/live` is `200`; `/health/ready` is `200` only when Redis and CMDBuild upstream are reachable; `/metrics` returns Prometheus text without cookies, tokens, user names, runtime rows, or raw CMDBuild payloads.

`docker compose ... logs` proves local stdout only. Verify the platform-managed route with a platform-owned collector query that exits `0` only when it finds the emitted probe ID:

```bash
bash scripts/verify-platform-log-route.sh https://custom.example.local/health/live -- \
  sh -c 'platform-log-query --contains "$CMDP_LOG_PROBE_ID"'
```

For direct syslog only, set `CMDP_SYSLOG_HOST` and start with `-f docker-compose.syslog.yml`; that overlay sets `CMDP_LOG_TARGET=stdout,syslog` and requires the syslog endpoint.

## Public Origin Behind Reverse Proxy

`CMDP_PUBLIC_ORIGIN` is the single browser-facing origin for CMDBuild UI, the custom page, and `/cmdbuild/custom-api/*`. Production requires a bare `http(s)` origin such as `https://custom.example.local`, with no path, query, fragment, or credentials.

`CMDBUILD_ORIGIN` is an internal upstream URL reachable only by the backend, for example `https://vr2.internal.example`. It may differ from `CMDP_PUBLIC_ORIGIN`, but it must not appear in browser URLs, `Origin`, `Referer`, redirect `Location`, or cookie domain values.

Use `rediss://` for production Redis. Set `CMDP_TLS_CA_FILE_HOST` together with `CMDP_TLS_CA_FILE=/run/certs/cmdbdynamicpages-ca.pem` when CMDBuild, Redis, or LiteLLM needs a private-CA PEM bundle; compose mounts it read-only and Node uses it for HTTPS trust. Plaintext `redis://` remains supported for local and existing deployments but reports `redis_plaintext_transport` at production runtime.

Set `CMDP_NGINX_PUBLIC_HOST` to the `host[:port]` of `CMDP_PUBLIC_ORIGIN` and `CMDP_NGINX_PUBLIC_PROTO` to its protocol. Bundled nginx forwards only those configured values, not client-supplied `Host`, `X-Forwarded-Host`, or `X-Forwarded-Proto`. Publish only the public hostname to users; firewall or ingress rules must close direct user access to the backend, bundled nginx, and internal CMDBuild upstream. Browser JavaScript uses relative `/cmdbuild/...` URLs and never calls `PROXY_PORT` or `CMDBUILD_ORIGIN` directly.

After deployment, verify through the public hostname:

```text
GET https://custom.example.local/cmdbuild/ui/config.js
GET https://custom.example.local/cmdbuild/custom-api/logging/status
```

`config.js`, redirects, and the CMDBuild session cookie must remain on `custom.example.local`; `vr2.internal.example` must not be visible in browser traffic.

## Rollback

Rollback order:

1. Restore the previous backend image or process bundle.
2. Restore the previous CMDBuild custom page ZIP if launcher behavior changed.
3. Keep Redis data unless the incident is specifically caused by corrupt static snapshots or cache entries.
4. Re-run `/health/live`, `/health/ready`, and one known runtime URL.

No destructive CMDBuild schema rollback is expected for ordinary runtime releases. Schema bootstrap is non-destructive and must not delete or move existing CMDBuild classes.

## Diagnostics

Use `CMDP_DIAGNOSTIC_MODE=Basic` for safe incident diagnostics. Use `Verbose` only temporarily and only when sanitized request/upstream details are needed.

### Local nginx restart loop

The local ports are a contract: do not change `8088`, `8093`, `8090`, or `6379` to work around a failure. First inspect the rendered configuration and the container environment:

```bash
docker compose -f docker-compose.nginx.yml config --quiet
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' cmdbdynamicpages-nginx
```

The `/etc/nginx/templates/default.conf.template` requires `CMDP_NGINX_PUBLIC_HOST`, `CMDP_NGINX_PUBLIC_PROTO`, and `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT`. `unknown "cmdp_nginx_public_host" variable` means nginx was not created through the supported Compose entrypoint or was created without its complete environment. Restore only nginx with `npm run nginx:dev`; it recreates that container with the same `network_mode: host` and port `8088`, without touching the backend, Redis, or CMDBuild. Then check `GET http://localhost:8088/health/live`, `GET http://localhost:8088/health/ready`, and `GET http://localhost:8088/cmdbuild/ui/`.

Useful endpoints:

```text
GET /health/ready
GET /health/redis
GET /metrics
GET /cmdbuild/custom-api/cache/status
GET /cmdbuild/custom-api/logging/status
GET /cmdbuild/custom-api/auth/permission-scope
```

Diagnostic interpretation:

- Redis unavailable: `/health/redis` returns `503`, `/health/ready` returns `503` when Redis is required, and logs include `redis.unavailable`.
- CMDBuild unavailable: `/health/ready` returns `503` with `checks.cmdbuild.ok=false`, and logs include `cmdbuild.request_error` or `cmdbuild.request_failed`.
- Template execution errors: check `cmdp_template_run_errors_total`, `template.execution_failed`, and `runtime.cache_result`.
- Cache behavior: compare `/cmdbuild/custom-api/cache/status`, runtime response `cache.status`, and `cmdp_runtime_cache_*` metrics.
- Same-origin rejection: correlate the browser response `x-request-id` with `security.same_origin_rejected`. Inspect `expectedOrigin`, `headerSource`, and `reason`; cookies and CSRF tokens are not logged. With external TLS, the expected origin must be `https://...`, never the internal CMDBuild URL.

## SLI And Alert Inputs

Candidate SLIs:

- readiness success rate from `/health/ready`;
- CMDBuild upstream latency and error rate from readiness and `cmdp_cmdbuild_rest_*`;
- Redis availability from `/health/redis` and `cmdp_redis_errors_total`;
- HTTP error rate from `cmdp_http_requests_total`;
- runtime cache hit/miss/build duration from `cmdp_runtime_cache_*`;
- template execution error rate from `cmdp_template_run_errors_total`;
- execution throttling from `cmdp_execution_throttled_total`.

Suggested alerts:

- `/health/ready` stays non-ready for two consecutive scrape intervals.
- Redis required mode is enabled and `/health/redis` returns `503`.
- CMDBuild upstream readiness fails or latency sharply increases.
- Template execution errors rise above the normal baseline.
- Execution throttling persists, indicating overloaded or looping runtime usage.

## Common Incidents

### Production startup fails with `app.config_invalid`

Check `NODE_ENV=production`, `CMDBDYNAMICPAGES_CSRF_SECRET`, and `CMDP_PUBLIC_ORIGIN`. Production requires a stable external CSRF secret and an explicit public browser origin; internal `CMDBUILD_ORIGIN` does not replace it.

### Runtime iframe shows login or no data

Verify same-origin access through nginx/ingress, the CMDBuild session cookie, template read grants, and business-data read permissions. Dynamic runtime pages require the current CMDBuild session cookie. Static snapshots require Redis snapshot presence.

### Static snapshot is missing

If runtime shows `Страница отсутствует для загрузки`, republish the static snapshot from an editor/admin session. Confirm Redis persistence and `CMDBDYNAMIC_REDIS_REQUIRED=true` for production.

### Cache does not refresh

Check template cache settings, `RuntimeConfigJson.runtimeCache.refreshCooldownSec`, runtime response `cache.refreshAllowedAt`, and whether the request used read-only `GET run` or CSRF-protected `POST run` with `forceRefresh=true`.

### Designer cannot save templates

Check CMDBuild CRUD grants on the technical classes, same-origin headers, `X-CMDBDynamicPages-CSRF`, and `Content-Type: application/json`.

If the response is `State-changing custom API calls require a same-origin Origin or Referer header.`, inspect browser Network and confirm that `Origin` and `Referer` use `CMDP_PUBLIC_ORIGIN`, not the internal upstream hostname. Once same-origin passes, the next expected guard is a valid `X-CMDBDynamicPages-CSRF` token.
