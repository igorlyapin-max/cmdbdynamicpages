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

Check same-origin access through nginx/ingress and the `?root=<technicalRoot>` in the viewer URL. Add `json=true` to the viewer URL to inspect the result using the same selection as HTML and D2. A matching published snapshot is served without contacting CMDBuild even if the cookie is absent or expired. Only a miss reaches the protected path: `401 cmdbuild_session_invalid` means re-authenticate, `403 technical_schema_access_denied` means check read grants on the selected technical schema, and `403 data_access_denied` means check read grants on the business data. A protected `403` does not trigger another snapshot lookup. Use the `X-Request-ID` response header to find the corresponding structured logs.

### Static snapshot is missing or unavailable

**Reload snapshot** is read-only and available without signing in. A signed-in reader who can run the saved template can request a recalculation under their own CMDBuild session, without permission to edit the template. The template's publication settings control the outcome: **Personal result** (default) displays fresh data only in the open tab; **Shared snapshot** requires explicit template consent and a viewer confirmation, and replaces the existing public snapshot. Card-level visibility under the initiating session can change the public set in shared mode. Never enable that mode for a report whose visible results are not safe for public distribution under every eligible reader's access context.

Both modes use the parameters stored in the opened snapshot, including `ignore` mode. For a conflict, reload the snapshot before retrying. An explicit access denial or an incomplete run must leave the public snapshot unchanged. Use `X-Request-ID` to correlate `snapshot.refresh_*` structured events. A transport or storage failure may be ambiguous; reread the stored snapshot before retrying a shared update.

Check `GET /cmdbuild/custom-api/public-snapshots/<code>/run` with the same `root`, code, and parameter query as the viewer URL. Exact links use `snapshotParams`, a URL-encoded JSON array of typed name/value pairs, e.g. `[["enabled",false],["site",42]]`. Copy the URL from Designer; do not convert these values to strings. The public API returns `snapshotFound=false` when no published snapshot matches.

Version 3 keys use the resolved technical template class, Code, and a generation check. Old snapshots are not migrated: republish approved reports explicitly. Use one writing BFF per contour and configure Redis durability for acknowledged writes (AOF with `appendfsync always` or equivalent), without stale replica reads. After restoring an older Redis backup, set a fresh `CMDBDYNAMIC_REDIS_KEY_PREFIX` before reopening public routes and republish only the required reports. Keep public routes closed on rollback unless older snapshot keys have been removed from that deployment's namespace.

`503 snapshot_revocation_unavailable` means the BFF did not start the CMDB write. A lost Redis `MSET` acknowledgment can still leave pending markers. `409 snapshot_revocation_pending` on Publish means a marker is blocking publication. `snapshotRevocationPending: true` on a mutation response means revocation could not be confirmed or finalized; `200` still confirms the CMDB write, while `502` may hide a committed write. Do not retry a mutation with an unknown outcome.

1. Find `snapshot.revocation_attempted` by the original mutation's `X-Request-ID` and `snapshotRevocationOperationId`. If you only have a Publish `409`, search for the earlier mutation by affected root and code. The attempt records `requestId`, `operationId`, and all `stateKeys` before `MSET`. `snapshot.revocation_started` follows a confirmed write of the markers. Correlate `snapshot.revocation_unavailable`, `snapshot.revocation_pending`, or `snapshot.revocation_finished` by the same IDs. If the unavailable event shows `previous_revocation_pending`, trace the earlier `blockingOperationIds` instead. Missing outcome logs alone do not prove the write was never sent.
2. Pause writes and publishing for all affected codes and ensure in-flight CMDB writes have settled. Verify the actual saved card and version under an editor/admin session; check both codes for a rename and verify absence for a deletion. If the CMDB outcome cannot be established, leave the markers untouched.
3. On the configured Redis primary and database, `WATCH` all logged keys, then `GET` them on the same connection. Proceed only if every key holds exactly `pending:<operationId>`. In `MULTI`/`EXEC`, replace all of them with `ready:<operationId>` atomically. If a key differs or `EXEC` aborts or is unconfirmed, stop and inspect current state and newer operations. Never manually restore a previous generation or copy cached payloads.
4. Resume writes after reconciliation. Explicitly republish only the verified saved version, if still applicable, and verify it via the public snapshot API.

If the viewer URL or public snapshot API returns HTTP `503` with `reason=snapshot_storage_unavailable`, check `/health/redis` and structured logs using `X-Request-ID`. A lookup error is not a miss and does not invoke the protected path. If the snapshot is found but `d2=true` returns `403`, check whether the snapshot was published with `publish.publicD2Source=true`.

### Large table

Enable pagination on the intended table in Result Data. Under By selected object, use Filter by column to list the distinct non-empty values of one field from the table source, even if that field is not visible in the table. Use Advanced settings for a separate option source, a different label or matching field, or to pass the key to an existing parameter in the dynamic selection. The `(?)` beside each setting explains what to choose. Grouping preserves key columns; other columns can show unique values, counts, or linked fields. Original records open as separate pages.

The browser receives 50 records by default and at most 100 per request. The separate total source-row budget per paged table is `CMDP_LARGE_TABLE_MAX_ROWS` (default `10000`). A result with exactly that many rows is complete only if the end is confirmed. CMDBuild, relation, and deadline limits apply independently. See [Report row limits](deployment-guide.md#report-row-limits) before raising the budget.

Publish and both refresh modes return HTTP `422` with `reason=code=table_result_incomplete` when a report is incomplete or exceeds a limit, including the REST budget. This applies to ordinary, mixed, and paged results. Index errors keep their `large_table_*_limit` or `table_view_too_large` code. A `snapshot_refresh_incomplete` response without limit diagnostics means the template or candidate snapshot was not ready; check validation and publication settings rather than raising a limit.

Read `diagnostics.limits` for the output `table`, `phase`, and, when present, the Object Flow step, limit name, configuration source and key, and effective limit. The phases are `selector` (options), `rows` (report calculation or paged table rows), `index` (table index), and `commit` (lock wait, final recheck, Redis deadline check, or personal view creation). Use this evidence to narrow the report, review settings, or check upstream pagination. Up to 16 flat entries are returned; `diagnostics.omittedCount`, when positive, counts entries left out. Sensitive labels are masked in both the API and structured logs. Correlate them using `X-Request-ID`.

Compare counts only within the reported `unit`. For example, a 10,000-card scan with upstream total 10,001 reports `maxSelectionScanRows`, `observed=10000`, and `total=10001`; it does not prove a 10,001st output row. A relation read with one item returned and a confirmed total of two at limit one reports `limit_exceeded`, `observed=1`, and `total=2`. Without a confirmed end, the same full page instead reports `completeness_unconfirmed` and omits `total` when unknown. `maxRestCalls` counts logical reads issued by the executor, excluding both network retries of a read and a read rejected before dispatch.

An expired deadline takes precedence over limit evidence when no write was sent or Redis confirms it refused the write. This returns HTTP `504`: `draft_preview_timeout` for Publish and `snapshot_refresh_timeout` for Refresh. Redis checks its own clock and the applicable generation and revision before changing the index or snapshot. The `executionTimeoutMs` / `deadline_exceeded` entry is kept even when the diagnostic list fills up. A `commit` timeout has `table: ""` and no step fields. Neither `422` nor `504` replaces the public snapshot or creates a personal view. Verify the prior revision and its data through the public API.

HTTP `503` with `reason=code=snapshot_commit_outcome_unknown` means Publish or shared Refresh sent the Redis write but did not receive a conclusive reply. The backend neither retries the write nor starts the general Redis cooldown for an inconclusive write receipt. In the UI, select **Check current snapshot**: it reads the public snapshot for the original root, template and parameters. Compare the displayed revision and data. A failed check leaves retry disabled; a confirmed read enables a new manual action without writing anything automatically. A changed revision does not identify who wrote it. For API clients, perform the same read and compare `cache.snapshotRevision` before deciding whether to send another mutation. If the read also fails, check `/health/redis` and correlate logs using `X-Request-ID`.

Designer reads the starting revision (or confirms that no snapshot exists) before sending a publication request. If this read fails, no publication request is sent. A CMDBuild data-read failure before the write (`502 snapshot_refresh_data_unavailable`) or an explicit Redis ACL rejection of the `EVAL` command (`503 snapshot_storage_unavailable`) is definitive. A script error after Redis starts executing `EVAL` may still leave the result unknown.

If Redis uses a restricted ACL, the backend account needs `TIME` in addition to its existing snapshot commands. Publication uses it both before dispatch and inside the atomic `EVAL` to enforce the write deadline.

Public options, rows and group details are available only for the report's visible result table. Neither refresh mode returns a calculation for a stale snapshot revision. On `409`, reload the snapshot or reopen the table. Correlate `report.table_prepared` and `report.table_page_failed` using `X-Request-ID`.

### Cache does not refresh

Check template cache settings, `RuntimeConfigJson.runtimeCache.refreshCooldownSec`, runtime response `cache.refreshAllowedAt`, and whether the request used read-only `GET run` or CSRF-protected `POST run` with `forceRefresh=true`.

Successful `cache.status=bypass` with `cache.reason=access_probe_unconfirmed` means the access probe did not confirm cache eligibility. The result was read under the current session with the same limits, without reading or populating the result cache. Forced refresh does not override this decision.

Runtime reports that read relations use `cache.scopeMode=privateUser` even when the template configures a shared cache. A hit can reuse a result only for the same user and access context, and it does not extend the expiration time. CMDBuild relation permission changes may become visible only at expiration or forced refresh. On a rebuild, an explicit CMDBuild data access denial fails the request instead of returning the previous result.

An explicit denial also revokes the private entry so a rebuild started before revocation cannot restore it. With `visibilityHash`, the first card page is not proof of shared visibility. If the probe cannot confirm visibility of the whole set that execution may read, the result cache is private.

### Designer cannot save templates

On `409 template_version_conflict`, the stored revision no longer matches the
editor's base revision. Another tab, a prior save, or another editor may have
changed it. Designer keeps the draft and does not retry the write or publish
it. Compare with the latest saved template before saving again. Use the request
ID, write phase, and the two revision hashes from technical diagnostics to
correlate concurrent requests. A publish conflict never writes an older snapshot.

Check CMDBuild CRUD grants on the technical classes, same-origin headers, `X-CMDBDynamicPages-CSRF`, and `Content-Type: application/json`.

If the response is `State-changing custom API calls require a same-origin Origin or Referer header.`, inspect browser Network and confirm that `Origin` and `Referer` use `CMDP_PUBLIC_ORIGIN`, not the internal upstream hostname. Once same-origin passes, the next expected guard is a valid `X-CMDBDynamicPages-CSRF` token.
