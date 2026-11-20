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

### Assistant Capture

Assistant capture is independent of `CMDP_DIAGNOSTIC_MODE`: `Off` by default,
`Basic` for metadata, `Verbose` for bounded redacted request/response bodies too.
Deterministic Apply is metadata-only in both modes: Verbose adds counts, not
the draft, prompts, filter values, parameters or raw errors. If Apply was
captured under Verbose before this change, stop capture and clear retained
traces for the affected root to remove its stored copies. Clearing applies to
all traces for that root; handle any previously downloaded exports separately.
Redis-backed capture applies to **all users of the selected technical root**.
Treat traces/exports as sensitive even after redaction; do not publish raw exports.

In Designer, open **Runtime settings → Assistant diagnostics**, select Verbose,
apply the mode and confirm capture. After reproducing the issue, expand Assistant
requests and responses below the result, or search by Request ID in settings.
Bodies load only when a span opens; copy and JSON export are available. Each HTTP
stage has its own trace: resumable operations can record MCP context and LLM generation
separately. An interrupted response retains its already-read prefix with a partial
marker; diagnostic storage does not replace the original error.

Trace writes are asynchronous: `diagnostics.assistantTrace.storageStatus` is `pending`, `stored`,
`discarded` (lifecycle/quota rejection), or `unavailable` (storage/control failure).
A reference is not proof of persistence. On expansion, UI retries a known `pending`
reference for at most 5 seconds; it does not poll arbitrary missing traces.

1. Use an admin session with `admin_classes_modify` and read access to the root's configuration.
2. Read `GET /cmdbuild/custom-api/assistant/diagnostics/status?root=<Root>`.
   Activate `POST .../diagnostics/capture?root=<Root>` with JSON
   `{"mode":"Verbose","durationSec":900,"confirmed":true}` and normal same-origin CSRF protection.
   Use `Basic` for metadata-only capture; `DELETE .../diagnostics/capture` stops capture.
3. Reproduce one intended Assistant operation. Read `GET .../diagnostics/traces`
   with `root` and optional `requestId`, `templateCode`, `limit`. Read a trace via
   `GET .../diagnostics/traces/<id>` (metadata only, no bodies), a span via
   `GET .../diagnostics/traces/<id>/spans/<spanId>`, or JSON via
   `GET .../diagnostics/traces/<id>/export`. Pass `root` on every request.
4. Compare effective `max_tokens`, `finish_reason`, detailed token usage and provider
   response. Verbose retains invalid JSON text after redaction; a parse failure
   does not mean no text was returned. Check truncation/omission markers first.
5. Stop capture explicitly; `DELETE .../diagnostics/traces?root=<Root>` clears retained
   traces and invalidates pending/in-flight trace writes through a storage epoch.
   All mutations require CSRF. Stop does not clear traces and permits already
   Redis-admitted traces to finish; it rejects new admission. Clear does not stop capture.

All endpoints are admin-only with `Cache-Control: no-store`. Redaction happens before
Redis writes. Bodies never go to stdout/stderr or external log sinks; operational
metadata uses the main structured logging pipeline. Redis failure must not change
the underlying Assistant result; no in-memory storage fallback is provided.
Capture control is polled from Redis in the background every 1 second; memory caches
control metadata only, not a payload storage fallback. Missing/unavailable control
or control older than 2 seconds skips tracing with a warning, without waiting for
Redis on the Assistant path. Trace begin/update are atomic; updates use `XX` with
the original expiry and epoch checks. Expired, evicted or cleared traces cannot be resurrected.
Redaction covers credentials in malformed JSON too; do not rely on old history being safe.

Saved `assistant.diagnostics` policy: `captureDurationSec=900` (max `3600`),
`retentionSec=86400` (max `604800`), `maxBodyBytes=8388608`, `maxTraceBytes=33554432`,
`maxStoredBytes=268435456`. Byte quotas bound each body, each trace and total retained
trace storage per root. Old traces may be evicted; oversized detail may be omitted.
Capture expires automatically. Backend restart and policy saves do not enable capture
or extend its deadline or existing trace retention. RuntimeConfig stores no active mode.
Diagnostics deployment ceilings are listed in the [admin guide](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md#budget-генерации-и-временный-capture).
Capture byte quotas do not increase the LLM request/response byte limits.

`assistant.llm.maxTokens` defaults to `16384`; every Assistant LiteLLM request sends
its effective value as `max_tokens`, bounded by deployment ceiling
`CMDP_ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE=131072`. Recreate the backend after env changes.

`GET`/`PUT /cmdbuild/custom-api/config` preserve requested RAW `assistant.llm.maxTokens`
and numeric `assistant.diagnostics` policy values; execution uses effective caps.
Responses expose `diagnostics.limits` (`requested`, `effectiveLimit`, `clampedBy`),
`warnings`, and `effectiveAssistantDiagnostics`. Invalid numbers (including numeric
strings, zero, negative, fractional or unsafe integers) return HTTP `422`, code
`runtime_config_invalid`, before any CMDBuild write. Correct the request; do not
replace the saved RAW value with an effective ceiling to hide a warning.

#### Response Format And Lost Task Instructions

Runtime setting `assistant.llm.responseFormat` accepts `json_object` (default,
sends `response_format: {"type":"json_object"}`) or `prompt` (JSON instructions
without that parameter). The operator selects `prompt` when the provider lacks
JSON mode. There is no automatic downgrade. Both modes retain deterministic
proposal validation before any explicit apply action.

- `assistant_invalid_json`: text or malformed JSON from the provider; a manual
  retry can reuse the valid MCP checkpoint, without an automatic provider retry.
- `assistant_empty_response`: no assistant content was returned.
- `assistant_output_truncated`: `finish_reason=length`; the proposal is rejected.
- `assistant_response_format_unsupported`: explicit provider rejection; fix the
  format setting or provider configuration instead of increasing timeouts.

Compare provider HTTP status, BFF status and `finish_reason` in the trace. If a
catalog summary replaces the task, inspect the LiteLLM-to-model request for all
system messages, the final task, the effective context window, chat template and
input truncation policy. Compare short and full tasks on the same route. A token
count near 16K alone does not prove truncation. The BFF trace proves what was sent
to LiteLLM, not what the model received. Keep Verbose temporary and redact traces
before sharing them.

#### Security Rollout

The user approved deleting **all existing diagnostic history**, across roots but
only inside this project's diagnostics namespace. Stop all old backend writers,
run the reviewed offline purge CLI supplied by the rollout owner, verify that old
diagnostic keys are gone, then start the new backend. Do not start it before purge
completes. No public purge endpoint is planned; the root-scoped clear API is not
a replacement. Never use `FLUSHDB`/`FLUSHALL` or delete unrelated project keys.
Keep front/backend ports `8088`/`8093`; templates, prompts and business data are
unchanged. Legacy diagnostic history is not supported. Use the exact offline
commands in [Security Purge](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md#assistant-diagnostics-security-purge).
The helper imports without starting HTTP, preserves epoch keys and covers old/new
history across all roots, including orphan keys and active capture control.
Before startup, repeat purge with writers still stopped and require `deletedKeys: 0`.
Root executes this during final rollout; purge has not been performed by this docs task.
Do not raise limits automatically on `finish_reason=length`: inspect model/provider
context/output limits, timeouts, response byte budget and cost before an operator change.

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
