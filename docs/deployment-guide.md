# Deployment Guide

English branch. Russian branch: [deployment-guide.ru.md](deployment-guide.ru.md).

## 1. Prerequisites

- CMDBuild is reachable, locally `http://127.0.0.1:8090/cmdbuild`.
- `cmdbdynamicpages` backend/proxy runs on `http://127.0.0.1:8093`.
- Redis is reachable at `redis://127.0.0.1:6379/0`; production Redis must require a password.
- Wiki/iframe scenarios use the same-origin nginx front `http://localhost:8088`.
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
CMDBUILD_ORIGIN=http://127.0.0.1:8090
CMDBDYNAMIC_REDIS_URL=redis://127.0.0.1:6379/0
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDP_LOG_TARGET=stdout
CMDP_LOG_FORMAT=json
```

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

Production Redis must be password-protected. Prefer `CMDBDYNAMIC_REDIS_PASSWORD_FILE`; if string delivery is used, set `CMDBDYNAMIC_REDIS_PASSWORD` or a password inside `CMDBDYNAMIC_REDIS_URL` only through platform secret/env. Do not store the secret in git or in the repository compose file.

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

The `cmdbaa` integration through `POST /cmdbuild/custom-api/templates/<templateCode>/baa-verify` uses the same CMDBuild runtime permissions. Configure an absolute URL to the `cmdbdynamicpages` reverse proxy, for example `http://127.0.0.1:8093/cmdbuild/custom-api/templates/netverify/baa-verify`; a relative path in `cmdbaa` is resolved against its `CMDBUILD_ORIGIN`. Browser calls use the CMDBuild session cookie and `X-CMDBDynamicPages-CSRF`; server-to-server `cmdbaa` calls may pass the current `CMDBuild-Authorization` header.

## 7. Nginx same-origin front

Local run:

```bash
npm run nginx:dev
```

Key routes:

```text
http://localhost:8088/cmdbuild/ -> http://127.0.0.1:8093/cmdbuild/
http://localhost:8088/health/  -> http://127.0.0.1:8093/health/
http://localhost:8088/         -> http://127.0.0.1:3000/
```

This puts the wiki and runtime iframe on one origin, `localhost:8088`.

## 8. Post-deployment checks

```bash
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
```

In production, `/health/ready` must see Redis and CMDBuild upstream.

## 9. Production notes

- Do not enable a generic REST proxy.
- Do not log `cookie`, `authorization`, `CMDBuild-Authorization`, CSRF tokens, or Redis password.
- State-changing API calls must pass same-origin + CSRF checks.
- Redis RDB snapshot is required for static snapshot pages.
- If a static snapshot is absent in Redis, runtime returns `Страница отсутствует для загрузки`; an administrator must republish the snapshot.
