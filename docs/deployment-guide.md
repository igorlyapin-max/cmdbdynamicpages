# Deployment Guide

English branch. Russian branch: [deployment-guide.ru.md](deployment-guide.ru.md).

## 1. Prerequisites

- CMDBuild is reachable, locally `http://127.0.0.1:8090/cmdbuild`.
- `cmdbdynamicpages` backend/proxy runs on `http://127.0.0.1:8093`.
- Redis is reachable at `redis://127.0.0.1:6379/0`; production Redis must require a password.
- The project-only nginx front is available at `http://localhost:8088`; it exposes only `/cmdbuild/*` and `/health/*`.
- First technical schema creation requires a CMDBuild role with `admin_classes_modify` and access to the metadata/classes API.
- Designer access is access to the project's technical schema: a user who can edit technical classes can create and change runtime endpoint templates.

## 2. Backend/proxy

Local run:

```bash
npm run proxy:dev
```

Do not change the port: project URLs and checks expect `8093`.

Minimum production env:

```text
PROXY_HOST=127.0.0.1
PROXY_PORT=8093
CMDP_PUBLIC_ORIGIN=https://cmdb.example.local
CMDP_NGINX_PUBLIC_HOST=cmdb.example.local
CMDP_NGINX_PUBLIC_PROTO=https
CMDBUILD_ORIGIN=http://127.0.0.1:8090
CMDBDYNAMIC_REDIS_URL=rediss://redis.example.local:6380/0
CMDBDYNAMIC_REDIS_TLS_CA_FILE=
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
CMDBDYNAMICPAGES_CSRF_SECRET=<stable external secret>
CMDP_LOG_TARGET=stdout,syslog
CMDP_LOG_FORMAT=json
CMDP_SYSLOG_HOST=syslog.example.local
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp
CMDP_SYSLOG_FACILITY=local0
CMDP_DIAGNOSTIC_MODE=off
```

The repository includes a backend `Dockerfile` for container deployment. The image runs as the `node` user, listens on `8093`, and uses `/health/live` only as the container liveness healthcheck. Configure `CMDP_SYSLOG_HOST`, `CMDP_SYSLOG_PORT`, `CMDP_SYSLOG_PROTOCOL`, and `CMDP_SYSLOG_FACILITY` for the approved production collector; `CMDP_LOG_TARGET=stdout,syslog` keeps stdout/stderr as the local operational output.
Production startup fails closed when `CMDBDYNAMICPAGES_CSRF_SECRET` or `CMDP_PUBLIC_ORIGIN` is missing. `CMDP_PUBLIC_ORIGIN` is the public browser origin; `CMDBUILD_ORIGIN` is the internal backend upstream and they may differ. `CMDP_NGINX_PUBLIC_HOST` and `CMDP_NGINX_PUBLIC_PROTO` must match the host[:port] and protocol of `CMDP_PUBLIC_ORIGIN`; bundled nginx uses these configured values instead of request-supplied forwarding headers. Enable `CMDP_DIAGNOSTIC_MODE=Verbose` only temporarily during incident diagnostics.
Admin-facing container handoff is documented in [CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md).

If the platform can pass the Redis secret only as a string, these variants are supported:

```text
CMDBDYNAMIC_REDIS_PASSWORD=<secret>
CMDBDYNAMIC_REDIS_URL=redis://:password@redis-host:6379/0
```

In every case the value must come from deployment secret/env, not from git. Precedence is `CMDBDYNAMIC_REDIS_PASSWORD_FILE`, then `CMDBDYNAMIC_REDIS_PASSWORD`, then the password embedded in `CMDBDYNAMIC_REDIS_URL`.

## 3. Redis

For dev:

```bash
docker compose -f docker-compose.nginx.yml up -d redis
```

Production Redis must be password-protected and should use `rediss://`. `CMDBDYNAMIC_REDIS_TLS_CA_FILE` is optional: set it to a CA PEM path already mounted in the backend container only when private Redis PKI is not covered by system trust. Prefer `CMDBDYNAMIC_REDIS_PASSWORD_FILE`; if string delivery is used, set `CMDBDYNAMIC_REDIS_PASSWORD` or a password inside `CMDBDYNAMIC_REDIS_URL` only through platform secret/env. Plaintext `redis://` remains supported for local and existing deployments, but production emits the `redis_plaintext_transport` runtime warning. Do not store secrets or CA material in git or in the repository compose file.

LiteLLM Assistant is optional. Leave `LITELLM_API_KEY_FILE_HOST` empty when Assistant is unused so compose mounts `/dev/null`. When enabled, the host path must exist before `docker compose up` and must be a readable regular file; otherwise Docker may create a directory in place of the secret file. Verify without printing the key:

```bash
test -f "$LITELLM_API_KEY_FILE_HOST" && test -r "$LITELLM_API_KEY_FILE_HOST"
docker compose -f docker-compose.runtime.yml exec cmdbdynamicpages sh -c 'test -f /run/secrets/cmdbdynamicpages_litellm_api_key && test -r /run/secrets/cmdbdynamicpages_litellm_api_key'
```

## 4. Register the custom page

Build the zip:

```bash
npm run build:zip
```

Upload `dist/cmdbdynamicpages-custompage.zip` to CMDBuild custom pages with:

```text
name: CmdbDynamicPages
description: CMDB Dynamic Pages
alias: widget.cmdb-dynamic-pages
componentId: view.custompages.CmdbDynamicPages.CmdbDynamicPages
active: true
```

Launcher check URL:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages
```

Direct Designer URL:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer
```

## 5. Create the technical schema

1. Log in to CMDBuild through proxy `8093` with an administrator role that has `admin_classes_modify`.
2. Open Designer.
3. Go to `Schema and settings` -> `Schema`.
4. Set:
   - technical root, for example `Cst_QueryTool`;
   - root description;
   - parent superclass under which the root class will be created.
5. Click `Check schema`.
6. Make sure there are no conflicts.
7. Confirm non-destructive bootstrap.
8. Click `Create missing schema`.

Bootstrap creates only missing classes and attributes. It does not delete, move, or change the type of existing CMDBuild objects.

The bootstrap administrator must be allowed to modify the CMDBuild class model: create classes under the selected parent superclass, create attributes, read metadata classes/attributes, and inspect the existing schema. After bootstrap, normal template editors do not need this administrative role.

## 5.1 Verify schema deployment

`npm run e2e` is a state-changing deployment gate for the configured technical schema. With an administrative CMDBuild session it calls `POST /cmdbuild/custom-api/schema/bootstrap`, then verifies the same schema with `GET /cmdbuild/custom-api/schema`.

Set the deployment schema explicitly when it does not use the default root and parent:

```bash
CMDBDYNAMIC_ROOT=Acme_QueryTool \
CMDBDYNAMIC_SCHEMA_PARENT=Acme_TechnicalRoot \
CMDBDYNAMIC_SCHEMA_DESCRIPTION='ACME dynamic pages' \
CMDBUILD_USERNAME='<admin-user>' \
CMDBUILD_PASSWORD='<admin-password>' \
npm run e2e
```

The check is non-destructive: it creates only missing classes and attributes. A failed bootstrap reports the first failed CMDBuild operation in the API response and structured backend log `schema.bootstrap_failed`.

For a deliberately read-only role use `CMDBDYNAMIC_EXPECT_READONLY=1`; this mode does not call bootstrap and checks the schema without modifying it.

## 6. CMDBuild permissions

Template editors need read/create/update on the technical classes:

```text
<Root>QueryTemplate
<Root>QueryTemplateVersion
<Root>QueryToolConfig
```

This is the primary Designer access control. If a user can open Designer and write `QueryTemplate`/`QueryToolConfig`, that user can change runtime endpoint behavior. Grant editor access through the same CMDBuild permission process used for the technical classes.

Runtime users need:

```text
read on <Root>QueryTemplate
read on <Root>QueryTemplateVersion
read on custom page CmdbDynamicPages
```

Business data is always read using the current CMDBuild user's permissions.

The optional LiteLLM assistant does not participate in runtime page rendering. Enable it only for Designer draft generation with `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.enabled`, `LITELLM_BASE_URL`, `CMDP_LITELLM_ALLOWED_BASE_URLS`, `LITELLM_MODEL`, and `LITELLM_API_KEY_FILE` or `LITELLM_API_KEY`. Keep the API key outside git and route it through the deployment secret mechanism. RuntimeConfig base URLs outside the server-side allowlist are rejected before the API key is used. `CMDP_ASSISTANT_ENABLED` is deprecated and no longer gates assistant calls. Assistant MCP settings are stored in `Cst_QueryToolConfig.RuntimeConfigJson.assistant.mcp`; `assistant.mcp.timeoutMs` (1000-60000 ms) bounds the complete MCP-context collection phase and one LiteLLM attempt. On a context deadline, the backend returns partial context with an explicit warning and stops starting new MCP reads. D2 interpretation allows up to two attempts. D2 mapping runs resumable `roles` and `topology` stages with one LiteLLM call per HTTP request; the browser automatically retries a recoverable stage once using the same session-bound TTL checkpoint. After `roles` succeeds, its validated output is reused by `topology`, so retrying connections does not query roles again. The browser timeout covers one LiteLLM attempt plus transport grace and stays below the default nginx custom API timeout. Browser cancellation aborts the active LiteLLM request and releases its execution slot. `CMDP_ASSISTANT_TIMEOUT_MS` is unsupported. `/cmdbuild/custom-api/mcp` is read-only, current-user scoped, and should stay unavailable to unauthenticated callers through the normal CMDBuild cookie boundary.

Set `CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE=2097152` and `CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE=4194304` as the deployment ceilings. `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.maxRequestBytes` (default `524288`) and `assistant.llm.maxResponseBytes` (default `1048576`) may select lower per-config limits but are clamped to those absolute caps. Authoring literals from Assistant prompts, filters, D2 Notes, templates, and mapping rules may be sent to LiteLLM. Runtime rows, resolved parameter values, CMDBuild cards, and raw D2 source are not sent automatically; they are included only when a user explicitly places them in authoring text.

## 7. Nginx same-origin front

Local run:

```bash
npm run nginx:dev
```

Key routes:

```text
http://localhost:8088/cmdbuild/ -> http://127.0.0.1:8093/cmdbuild/
http://localhost:8088/health/  -> http://127.0.0.1:8093/health/
http://localhost:8088/         -> 404
```

This nginx instance exposes only routes owned by `cmdbdynamicpages`. External portals are deployed and proxied independently.

With an external TLS reverse proxy, the browser must open CMDBuild UI, the custom page, and `/cmdbuild/custom-api/*` through one `CMDP_PUBLIC_ORIGIN`, for example `https://custom.example.local`. Set `CMDP_NGINX_PUBLIC_HOST=custom.example.local` and `CMDP_NGINX_PUBLIC_PROTO=https`; bundled nginx forwards those configured values and does not trust client-supplied `Host` or forwarding headers. An internal `CMDBUILD_ORIGIN`, for example `https://vr2.internal.example`, is never user-facing. Confirm that `/cmdbuild/ui/config.js`, redirects, and the CMDBuild session cookie use the public hostname rather than the internal upstream.

## 8. Post-deployment checks

```bash
npm run ci
npm run container:check
npm test
npm run test:api
npm run test:nginx
```

With a valid CMDBuild cookie:

```bash
npm run e2e
```

Health endpoints:

```text
http://127.0.0.1:8093/health/live
http://127.0.0.1:8093/health/ready
http://127.0.0.1:8093/health/redis
http://127.0.0.1:8093/metrics
```

`/health/live` is liveness only: it proves that the Node process answers HTTP and is used by the Docker healthcheck. `/health/ready` is readiness: in production it must see Redis and the CMDBuild upstream before rollout or traffic routing. `/metrics` returns aggregate Prometheus counters/gauges and must not be used as a readiness gate.

## 9. Production notes

- Do not enable a generic REST proxy.
- Do not log `cookie`, `authorization`, `CMDBuild-Authorization`, CSRF tokens, or Redis password.
- Keep `CMDP_DIAGNOSTIC_MODE=off` by default; use `Basic` or temporary `Verbose` diagnostics only through deployment configuration.
- State-changing API calls must pass same-origin + CSRF checks and send `Content-Type: application/json` when they carry a JSON body.
- Keep `CMDP_PROXY_ALLOWLIST_STRICT=true` unless a controlled deployment explicitly needs to proxy additional CMDBuild paths.
- Apply reverse-proxy rate limiting equivalent to the bundled nginx `limit_req` rules for `/cmdbuild/custom-api/`, `/cmdbuild/dynamicpages/`, and general `/cmdbuild/` traffic.
- Set `CMDBDYNAMICPAGES_CSRF_SECRET` from an external stable secret; the random fallback is for local/dev only.
- Set `CMDBDYNAMIC_REDIS_REQUIRED=true` for production scale-out or when static snapshots are part of the service contract.
- Redis RDB snapshot is required for static snapshot pages.
- If a static snapshot is absent in Redis, runtime returns `Страница отсутствует для загрузки`; an administrator must republish the snapshot.
