# cmdbdynamicpages Architecture Plan

## Goal

Build CMDBuild dynamic custom pages with two scenarios:

- template designer: users prepare complex query templates and store them as JSON in CMDBuild technical classes;
- template runtime: users open a custom page URL with a template code and parameters, and the system renders one or more result tables if the current CMDBuild user has enough permissions.

## Runtime Architecture

```text
CMDBuild UI custom page launcher
  |
  | redirect
  v
/cmdbuild/dynamicpages/ui/*
  |
  | fetch(..., { credentials: 'include' })
  v
/cmdbuild/custom-api/*
  |
  | receives CMDBuild HttpOnly cookie
  v
cmdbdynamicpages backend
  |
  | server-side CMDBuild-Authorization header
  v
CMDBuild REST API
```

The backend must execute user template runs with the current user's CMDBuild session. It must not use a service account for business-data reads, because that would bypass CMDBuild's permission model.

## Reverse Proxy Layout

Production should expose one origin:

```text
/cmdbuild/*             -> CMDBuild
/cmdbuild/custom-api/*  -> cmdbdynamicpages backend
```

Production should also expose project UI routes on the same origin:

```text
/cmdbuild/dynamicpages/ui/designer             -> cmdbdynamicpages backend
/cmdbuild/dynamicpages/ui/run/<templateCode>  -> cmdbdynamicpages backend
```

The preferred runtime link is now a backend-owned UI route:

```text
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

The browser never sends URL fragments to the server. CMDBuild 4.1 may normalize extra path segments after a custom page name, so launcher-based runtime links should keep the custom page hash stable and put dynamic page routing in query parameters before `#`:

```text
/cmdbuild/ui/?cmdpTemplate=<templateCode>&param=value#custompages/CmdbDynamicPages
```

The custom page must only parse the URL and redirect to a project-owned UI path. The backend UI calls real backend API paths:

```text
/cmdbuild/custom-api/templates/<templateCode>/run
```

## CMDBuild Session Safety

The integration must not break normal CMDBuild behavior.

Requirements:

- do not change CMDBuild cookies;
- do not overwrite `CMDBuild-Authorization`;
- do not change `Path=/cmdbuild`, `HttpOnly`, or `SameSite` semantics;
- do not perform logout or session refresh from the backend unless explicitly designed;
- do not return cookie or token values to JavaScript;
- do not log cookies or tokens;
- do not expose a generic open proxy to CMDBuild REST;
- expose only allowlisted backend operations;
- protect state-changing backend operations with `Origin`/`Referer` checks and `X-CMDBDynamicPages-CSRF`;
- verify that the normal CMDBuild UI still works through the reverse proxy.

CMDBuild/Tomcat owns the user session lifetime. The current test stand uses a 30-minute idle timeout; `cmdbdynamicpages` does not refresh or extend CMDBuild sessions. The relevant Tomcat `web.xml` block is approximately:

```xml
<session-config>
    <session-timeout>30</session-timeout>
</session-config>
```

The value is in minutes and requires a CMDBuild/Tomcat restart when changed. This timeout is not the template runtime cache TTL. If the browser still sends a cookie but `/sessions/current` rejects it, the backend treats the session as expired and sends the user through the login flow.

CSRF strategy:

- `GET /cmdbuild/custom-api/csrf` returns a token derived server-side from the current CMDBuild session token and backend secret;
- the backend-served UI sends this token in `X-CMDBDynamicPages-CSRF` for non-GET backend calls;
- state-changing backend calls require both same-origin `Origin`/`Referer` and a valid CSRF token;
- runtime iframe execution uses read-only `GET /cmdbuild/custom-api/templates/:code/run?param=value` and does not require a CSRF token;
- the CSRF token is not the CMDBuild token and cannot be used as CMDBuild REST authorization.

## Runtime Result Cache

Runtime template results may be expensive because templates can scan cards and resolve reference/domain paths through CMDBuild REST. Runtime cache storage uses Redis when available, with backend in-memory fallback for local dev. Cache behavior is controlled per template in `spec.cache`:

- `permissionOnly` is the default. The cache is shared inside the same endpoint/template/params after the viewer passes a lightweight probe over the classes and attributes actually used by that template. This mode assumes row-level CMDBuild scope is not different between users;
- `visibilityHash` adds a hash of visible card ids to the cache key before sharing a result, and is intended for templates where row-level scope can differ;
- `privateUser` keeps the result cache isolated by CMDBuild user/session scope;
- `disabled` turns result caching off for the template.

Cache keys include template code, spec hash, runtime params, executor limits, template cache policy, dependency-map hash, and either the endpoint visibility hash or the per-user scope hash depending on mode. Template `ttlSeconds` controls how long this template result is kept in cache; the Designer edits this value in hours and defaults new templates to 8 hours. System `RuntimeConfigJson.runtimeCache.refreshCooldownSec` controls how long users must wait before requesting a manual cache rebuild. The runtime page keeps the visible UI compact: the table header places the title on the left and right-aligns search plus a `⟳` refresh icon on the same line; the icon exposes cache status, generated time, expiry, refresh countdown, backend, and scope details in a hover/focus tooltip.

Designer draft preview is intentionally cache-free: `Visualize in editor` calls `/cmdbuild/custom-api/draft/preview` and executes the current unsaved draft. For saved endpoint testing the Designer Run page exposes a forced cache refresh action that calls `POST /cmdbuild/custom-api/templates/:code/run` with `forceRefresh=true`. Forced refresh ignores the user cooldown but is only accepted on CSRF-protected POST; read-only Runtime iframe `GET run` keeps the cooldown behavior.

The executor builds a used-field dependency map from filters, matching rules, final data, and visualization settings. `selectCards` materializes only the base card identifiers plus the fields that are actually used downstream; unrelated attributes are not added to result rows and are not part of the cache probe.

## BAA Verification Exchange

The neighboring `cmdbaa` integration uses the same runtime executor and authorization model:

```text
POST /cmdbuild/custom-api/templates/<templateCode>/baa-verify
```

The endpoint accepts a BAA request body, validates the minimal `endpoint.params` and `plan.objects` structure, executes the saved template under the current CMDBuild user session, and returns a BAA envelope. `endpoint.params` become template input parameters. `plan.objects` are exposed through the `baaPlanObjects` DSL step, which materializes them as an internal table without writing runtime data to CMDBuild.

BAA templates are not HTTP views. `GET/POST /cmdbuild/custom-api/templates/:code/run`, `/cmdbuild/dynamicpages/ui/run/:code`, runtime iframe links, and static snapshot publication are rejected/disabled for `endpoint.kind=baaVerification`. Designer keeps the configuration and verification path available through `BAA endpoint`, `Extraction`, `Caching`, and `Run -> BAA verify`, while runtime-only presentation sections are shown as disabled.

External BAA contracts are not created by the `cmdbdynamicpages` bootstrap. They live in the existing CMDBuild BAA technical branch under the path configured in `RuntimeConfigJson.baaTechnical.superclassPath`. Default class names are:

```text
BAAConversionContract
BAAConversionContractVersion
BAAVerificationInputContract
BAAVerificationOutputContract
BAAVerificationEndpoint
```

`GET /cmdbuild/custom-api/baa/contracts?type=input` reads `BAAVerificationInputContract` with the current user's permissions and supplies saved input contracts to Designer. If the current user cannot read these classes, Designer still works, but the BAA contract can be described manually inside the template.

Permissions are not bypassed: the backend calls CMDBuild REST with the current session's `CMDBuild-Authorization`. If CMDBuild denies a class or attribute actually used by the template, the endpoint returns a permission-denied envelope and does not return partial results from the remaining selections. If no data is found inside the user's visibility, the endpoint returns a successful envelope with empty tables.

Caching uses the same template `spec.cache` settings. The normalized BAA body is added to the runtime cache key as `cacheContext`, so different input plans do not share one result. There is no separate BAA runtime storage: results are either returned immediately or kept temporarily in Redis runtime cache according to the template TTL.

## Domain-aware Paths And Runtime Links

The catalog cache stores path metadata in addition to class and attribute names: domain, domain description, cardinality, direction, source class, and target class. The Designer uses this metadata in Object group path pickers so editors can filter attributes/paths by relationship type when the same attribute name is reachable through multiple references/domains. This is only a picker aid over the current user's visible catalog; it does not expand CMDBuild permissions.

Runtime final tables carry lightweight per-cell `cellMeta`: source selection (`SelectionX`/`ВыборкаX`), source class, source card id, attribute name, and domain path when available. The backend also derives ready-made internal card URLs for row participants, for example `${mysource.sourceURLВыборка1}`, `${mysource.sourceURLВыборка2}`, `${mysource.sourceURLSelection1}`, and similar variables from detected selection prefixes. Visualization link templates can use `${mysource.value}`, `${mysource.source}`, `${mysource.sourceClass}`, `${mysource.sourceId}`, `${mysource.attribute}`, `${mysource.domainPath}`, `${row.<column>}`, and `${param.<name>}`.

Both backend and client reject unsafe link schemes: `javascript:`, `data:`, and `vbscript:`. Empty or unsafe rendered URLs fall back to plain text.

Published static snapshots are separate from the runtime result cache. `spec.publish.mode = "staticSnapshot"` requires `warningAccepted = true`; publication executes the template once under the editor's CMDBuild session and stores the result in Redis without TTL. Runtime then reads only Redis data and can serve the page without checking viewer permissions on source CMDBuild objects. If the snapshot is missing, runtime renders `Страница отсутствует для загрузки`. Redis dev mode uses RDB snapshots, so absent snapshots are restored by republishing.

Production Redis is a password-protected dependency. The backend accepts credentials from `CMDBDYNAMIC_REDIS_PASSWORD_FILE`, `CMDBDYNAMIC_REDIS_PASSWORD`, or the password component of `CMDBDYNAMIC_REDIS_URL`; file-based secret injection is preferred. Redis credentials must not be committed to git. Health/status endpoints mask Redis credentials in returned URLs.

Runtime table sorting and text filtering are intentionally browser-local. They operate only on rows already returned by the authorized template execution and do not perform another `/run` call. Runtime text filtering is enabled by default unless Visualization explicitly disables it. Row grouping disables sorting and filtering for that table because merged cells depend on stable row order; split subtables keep sorting inside each subtable.

Shared endpoint result caching is explicit template behavior. The default `permissionOnly` mode is fast and administrator-controlled, but it intentionally does not prove identical row-level visibility. Use `visibilityHash` or `privateUser` when row-level scope matters.

Permission-scope probe:

- `GET /cmdbuild/custom-api/auth/permission-scope` returns endpoint statuses for session, roles, current role, users, groups, classes, and domains;
- it returns sampled readable classes/attributes and visible domains for the current user;
- it returns a diagnostic `visibleModelHash` and `userScopeHash`.

## Production Health Checks

Health endpoints are unauthenticated and have both root and backend-prefixed forms:

```text
/health/live
/health/ready
/health/redis
/cmdbuild/custom-api/health/live
/cmdbuild/custom-api/health/ready
/cmdbuild/custom-api/health/redis
```

`/health/live` only proves that the Node process answers HTTP. `/health/redis` performs a strict Redis `PING` and returns `503` when Redis is disabled or unavailable. `/health/ready` checks the process, Redis, and CMDBuild upstream reachability; it returns `503` when Redis is required and unavailable or CMDBuild cannot be reached. `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=false` can relax readiness for local development, but production should leave Redis required when Redis-backed runtime cache or static snapshots are expected.

`/cmdbuild/custom-api/cache/status` remains a diagnostics endpoint. It reports Redis visibility and in-memory fallback counters, but it returns `200` even during fallback and therefore must not be used as strict production readiness.

## Logging And ELK

Runtime logging is structured and transport-neutral. The backend emits JSON events by default to `stdout`, which is the recommended Docker/Kubernetes mode. ELK integration is expected to be provided by the platform collector path:

```text
cmdbdynamicpages stdout -> Docker logging/Filebeat/Fluent Bit/Logstash -> Elasticsearch
```

For VM/bare-metal or SIEM-oriented deployments the backend can send the same event payload to syslog:

```text
CMDP_LOG_TARGET=syslog
CMDP_SYSLOG_HOST=<syslog-host>
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp|tcp
CMDP_SYSLOG_FACILITY=local0
```

`CMDP_LOG_TARGET=stdout,syslog` duplicates events to both transports. Direct Elasticsearch output is intentionally not implemented in the application to avoid coupling runtime availability to the observability backend. `/cmdbuild/custom-api/logging/status` reports the active logging configuration without secrets and is a diagnostics endpoint, not readiness.

Logged events cover HTTP request completion, Redis availability, CMDBuild upstream failures, CSRF/same-origin rejections, runtime cache hit/miss/refresh, static snapshot publish/hit/miss, and template create/update/delete. Headers and query parameters configured in `CMDP_LOG_REDACT_HEADERS` and `CMDP_LOG_REDACT_QUERY` are redacted; cookies, authorization headers, CSRF tokens, runtime table rows, and raw CMDBuild card payloads must not appear in operational logs.

## Technical Root

The `/root` value is only for the project's technical classes in CMDBuild. It is not a restriction on business-data queries.

Example:

```text
root = Cst_QueryTool
```

Technical classes under that root can include:

```text
Cst_QueryToolConfig
Cst_QueryTemplate
Cst_QueryTemplateVersion
```

User queries run against the existing CMDBuild model according to the current user's normal CMDBuild rights.

## Settings Storage

All project settings should be stored in CMDBuild classes where technically possible.

Initial class model:

```text
QueryToolConfig
  Code
  Description
  RootCode
  Active
  RuntimeConfigJson

QueryTemplate
  Code
  Description
  Active
  SpecJson
  ParamsSchemaJson
  ResultSchemaJson
  Owner
  UpdatedAt

QueryTemplateVersion
  Template
  Version
  SpecJson
  ChangedBy
  ChangedAt
  ChangeComment
```

Implemented local technical classes use the `Cst_` prefix under `Cst_QueryTool`:

```text
Cst_QueryTool
Cst_QueryToolConfig
Cst_QueryTemplate
Cst_QueryTemplateVersion
```

`Cst_QueryTemplateVersion` currently keeps `TemplateCode` as a string. A CMDBuild reference/domain can be added later if the designer needs navigable relations between template cards and versions.

CMDBuild `json` card attributes are written through REST as JSON strings and parsed back to JSON objects by the backend response layer.

Implemented runtime config:

- `GET /cmdbuild/custom-api/config` reads the `Cst_QueryToolConfig` card for the current technical root;
- `PUT /cmdbuild/custom-api/config` upserts that card through the current user's CMDBuild permissions;
- Designer shows `RuntimeConfigJson` as described form fields and saves the JSON object internally; the raw JSON textarea is not exposed;
- Designer General settings expose `runtimeCache.refreshCooldownSec` as the system-wide manual refresh cooldown;
- `preview/run` use `RuntimeConfigJson.executionLimits` for default and capped executor limits;
- `run` uses template `spec.cache.ttlSeconds` for result TTL and `RuntimeConfigJson.runtimeCache.refreshCooldownSec` for manual refresh cooldown.

Current `RuntimeConfigJson` shape:

```json
{
  "runtimeCache": {
    "refreshCooldownSec": 180
  },
  "executionLimits": {
    "maxRowsDefault": 300,
    "maxRowsPreviewDefault": 20,
    "maxRowsMax": 1200,
    "maxClassesDefault": 60,
    "maxClassesMax": 120,
    "maxDomainsDefault": 70,
    "maxDomainsMax": 140,
    "maxRestCallsDefault": 180,
    "maxRestCallsMax": 220,
    "maxTraversalDepthDefault": 1,
    "maxTraversalDepthMax": 2
  }
}
```

## Special CMDBuild Model View Template

The neighboring `../cmdbuild` project is integrated as a special template kind instead of a separate service:

```json
{
  "version": 1,
  "kind": "cmdbBuildView",
  "protected": true,
  "cmdbBuildView": {
    "language": "auto",
    "showSystemAttributes": false,
    "sections": ["classes", "domains", "lookups"],
    "rootClass": "",
    "lookupScope": "used"
  }
}
```

This kind does not use the normal selection/matching DSL. The backend collects CMDBuild model metadata with the current server-side CMDBuild authorization: classes, attributes, domains, lookup types, and lookup values. The standalone `../cmdbuild` login flow and cookies are intentionally not reused.

Execution modes are the same as for ordinary templates:

- `dynamicUser` builds the HTML view under the current viewer's CMDBuild permissions;
- `staticSnapshot` publishes a Redis snapshot under the editor's permissions and serves the stored page without source permission checks.

The `CmdbBuildView` template is treated as protected/system: the Designer hides deletion and the backend rejects `DELETE` for that special template kind. A stale `protected` flag on ordinary DSL/BAA templates is ignored and removed during save. Settings are edited in the Designer `CMDBuild model view` section, and the runtime appearance is rendered with the project's compact/minimal visual style instead of the heavier standalone UI from `../cmdbuild`.

## Editor Permissions

We should avoid maintaining a separate editor list if CMDBuild can provide the required authorization signal.

Technical checks:

- inspect `sessions/current` fields: `role`, `availableRoles`, and `rolePrivileges`;
- verify whether roles/groups/users endpoints are available to the current user or admin users;
- determine whether CMDBuild class CRUD rights on `QueryTemplate` are sufficient to decide who can edit templates.

Local CMDBuild 4.1 findings:

- `/cmdbuild/services/rest/v3/roles` is available and returns the role catalog for an admin user;
- `/cmdbuild/services/rest/v3/roles/{id}` and `/roles/{name}` return detailed role privileges as `_rp_*` fields;
- `/cmdbuild/services/rest/v3/users/{id}` returns assigned roles in `userGroups`;
- `/cmdbuild/services/rest/v3/groups` is not available in this instance;
- `/sessions/current` is enough to determine the current role, available roles, and relevant admin privileges for the active session.

Preferred approach:

- if a user can create/update `QueryTemplate` cards in CMDBuild, they can edit templates;
- if they only have read access, they can run templates but not edit them;
- avoid duplicating CMDBuild ACLs in backend configuration.

Grant-management findings:

- `GET /cmdbuild/services/rest/v3/roles/{roleName}/grants` returns existing role grants;
- `GET /cmdbuild/services/rest/v3/roles/{roleName}/grants?includeObjectDescription=true&includeRecordsWithoutGrant=true&ext=true` returns grant rows for available objects even when the role has `mode=none`;
- `POST /cmdbuild/services/rest/v3/roles/{roleName}/grants/_ANY` upserts one or more grants from a JSON array.

Local limited-user setup:

- role `Helpdesk` has read grants on `Cst_QueryTool`, `Cst_QueryToolConfig`, `Cst_QueryTemplate`, and `Cst_QueryTemplateVersion`;
- role `Helpdesk` has read grant on custom page `CmdbDynamicPages` (`1662627`);
- user `mdavis` can read templates and run runtime URLs, but cannot create templates through the backend with these grants.

## Designer UI

Designer route:

```text
/cmdbuild/dynamicpages/ui/designer
/cmdbuild/dynamicpages/ui/designer/<section>
```

CMDBuild launcher route:

```text
/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages
```

Designer responsibilities:

- list templates;
- create and edit templates;
- check a class by entered name and show its attributes according to the current user's permissions;
- validate DSL JSON;
- preview results;
- save templates into `QueryTemplate`;
- show template versions.

The designer must not limit available business classes by the technical `/root`.

Language behavior:

- Designer and Runtime support `en` and `ru`;
- explicit `cmdpLang` or `lang` query parameter wins;
- the UI persists manual selection in browser `localStorage`;
- if CMDBuild exposes language in session/storage, the UI can use it before falling back to browser language;
- local CMDBuild 4.1 `/sessions/current` currently does not expose a language field.

Implemented Designer MVP:

- lists templates from `Cst_QueryTemplate`;
- keeps page-level Designer actions in a sticky contextual action bar at the top of each route;
- creates templates through a minimal code/description form and edits query logic through focused Designer sections;
- caches the CMDBuild class/attribute/domain catalog in the browser and shows a header freshness lamp with a sync control; the lamp turns stale/yellow after 24 hours from the last sync;
- edits object-group templates visually as one or more named selections and compiles each include/exclude scope rule set into a separate `selectCards` result;
- edits object-matching templates visually and compiles them into `selectCards` + `expandRelations`;
- lets the extraction preview display either a named selection result or the final object-matching result;
- no longer exposes standalone relation-chain, value-search, group-comparison, or composition sections in the Designer UI; existing saved DSL steps remain supported by the backend executor;
- edits the final runtime view visually and writes `result.tables` with selected columns, column labels, display mode, empty-state text, and permission-denied text;
- limits Visualization column selectors for sorting, subtables, and grouping to the columns actually present in Final data;
- defaults split-subtable titles to the selected split-column token, for example `${Выборка2.city}`;
- renders runtime sorting and text filters client-side only, with both controls disabled when row grouping is enabled;
- edits `spec.params` through a structured table with name, type, required flag, default, example, and description;
- can fill test runtime parameters from `spec.params.*.example` and falls back to `spec.params.*.default` when input is omitted;
- rejects optional `spec.params` entries that do not define `default` or `defaultValue`;
- renders CMDBuild class selectors as an inheritance tree using cached catalog `parent` metadata and class descriptions;
- executes superclass selections by expanding `selectCards` and relation target filters to readable non-prototype descendants of the selected class;
- adds and previews `extractVariables` regexp steps for internal variable extraction;
- provides a simple visual builder that generates DSL JSON for the implemented operation families;
- validates and previews templates through backend endpoints;
- saves templates into CMDBuild cards;
- shows saved template versions and can load a version spec back into the editor;
- uses a two-level navigation menu and keeps technical schema/bootstrap and class probe details out of the main Designer screen;
- stores optional `SpecJson.defaults.className` fallback for templates that can run without a `className` URL parameter.

## Query DSL

Templates should store declarative JSON, not arbitrary JavaScript, SQL, or CQL.

The first DSL version should cover:

- finding classes by attribute type;
- extracting variables from input parameters with regular expressions;
- selecting CMDBuild cards by class and bounded filters;
- composing final output tables from intermediate results;
- filtering by attributes;
- comparing attribute values;
- traversing domains;
- joining/intersecting intermediate sets;
- rendering named result tables.

Example shape:

```json
{
  "version": 1,
  "params": {
    "attrType": { "type": "string", "required": true }
  },
  "steps": [
    {
      "type": "findClassesByAttributeType",
      "attributeTypeParam": "attrType",
      "as": "classes"
    },
    {
      "type": "traverseDomains",
      "from": "classes",
      "direction": "both",
      "as": "related"
    }
  ],
  "result": {
    "tables": [
      {
        "name": "classes",
        "columns": ["Class", "Description"]
      }
    ]
  }
}
```

## Backend API

Initial API:

```text
GET  /cmdbuild/custom-api/session
GET  /cmdbuild/custom-api/model/classes
GET  /cmdbuild/custom-api/model/classes/:className
GET  /cmdbuild/custom-api/model/classes/:className/attributes
GET  /cmdbuild/custom-api/model/domains
GET  /cmdbuild/custom-api/model/domains/:domainName
GET  /cmdbuild/custom-api/auth/capabilities
GET  /cmdbuild/custom-api/auth/permission-scope
GET  /cmdbuild/custom-api/csrf
GET  /cmdbuild/custom-api/schema
POST /cmdbuild/custom-api/schema/bootstrap
GET  /cmdbuild/custom-api/config
PUT  /cmdbuild/custom-api/config

GET  /cmdbuild/custom-api/templates
GET  /cmdbuild/custom-api/templates/:code
GET  /cmdbuild/custom-api/templates/:code/versions
POST /cmdbuild/custom-api/templates
PUT  /cmdbuild/custom-api/templates/:code
DELETE /cmdbuild/custom-api/templates/:code

POST /cmdbuild/custom-api/templates/:code/validate
POST /cmdbuild/custom-api/templates/:code/preview
GET  /cmdbuild/custom-api/templates/:code/run
POST /cmdbuild/custom-api/templates/:code/run
POST /cmdbuild/custom-api/draft/validate
POST /cmdbuild/custom-api/draft/preview
```

Backend responsibilities:

- read the current CMDBuild session cookie;
- validate the session;
- read and write technical CMDBuild classes;
- validate DSL and parameters;
- execute DSL through CMDBuild REST as the current user;
- enforce execution limits for rows, class/domain scans, domain traversal depth, REST calls, and individual CMDBuild REST timeouts;
- return table-oriented JSON to the backend-served UI.

Implemented foundation routes:

- `GET /cmdbuild/custom-api/session`: returns a sanitized current session and selected role privilege flags;
- `GET /cmdbuild/custom-api/model/classes`: returns sanitized CMDBuild class metadata according to current user permissions for diagnostic/advanced use;
- `GET /cmdbuild/custom-api/model/classes/:className`: checks one class by name and returns sanitized metadata;
- `GET /cmdbuild/custom-api/model/classes/:className/attributes`: returns sanitized attribute metadata for one visible class;
- `GET /cmdbuild/custom-api/model/domains`: returns sanitized domain metadata, with optional `details=true` expansion for source/destination/cardinality fields;
- `GET /cmdbuild/custom-api/model/domains/:domainName`: returns sanitized detailed metadata for one visible domain;
- `GET /cmdbuild/custom-api/auth/capabilities`: returns role/user/groups endpoint probe results and confirms the `cmdbuild-class-crud` editor permission strategy.
- `GET /cmdbuild/custom-api/auth/permission-scope`: returns visible-model permission-scope diagnostics for the current user; runtime result sharing is controlled by template `spec.cache.scopeMode`;
- `GET /cmdbuild/custom-api/csrf`: returns a session-bound custom API CSRF token for non-GET backend calls;
- `GET /cmdbuild/custom-api/schema`: checks technical root/classes/attributes under the configured root;
- `POST /cmdbuild/custom-api/schema/bootstrap`: creates missing technical classes/attributes, guarded by same-origin headers and `admin_classes_modify`;
- `GET/PUT /cmdbuild/custom-api/config`: reads and writes `Cst_QueryToolConfig.RuntimeConfigJson`;
- `GET /cmdbuild/custom-api/templates/:code/versions`: returns sanitized version cards visible to the current user;
- `GET/POST/PUT/DELETE /cmdbuild/custom-api/templates...`: stores, reads, updates, and deletes template JSON in `Cst_QueryTemplate` cards;
- `POST /validate`, `/preview`, `/run`: validates or executes DSL v1 templates under the current user's CMDBuild permissions.
- `POST /cmdbuild/custom-api/draft/validate` and `/draft/preview`: validate or execute the Designer's current unsaved JSON draft under the current user's CMDBuild permissions.

Executor limits:

- `maxRows`: defaults to `500` for run and `25` for preview;
- `maxClasses`: defaults to `100`, capped at `500`;
- `maxDomains`: defaults to `100`, capped at `500`;
- `maxRestCalls`: defaults to `250`, capped at `1000`;
- `maxTraversalDepth`: defaults to `1`, capped at `5`;
- `CMDBUILD_REQUEST_TIMEOUT_MS`: defaults to `10000` ms for each CMDBuild REST call.

Runtime logging:

- preview, direct `POST run`, iframe `GET run`, cache hits/misses, permission failures, and execution failures are written only to standard backend logging paths;
- no runtime execution cards are stored in CMDBuild technical classes;
- request parameters and CMDBuild cookies/tokens are redacted according to backend logging settings.

Template versioning:

- `create` and `update` write best-effort snapshots to `Cst_QueryTemplateVersion`;
- version cards store template code, version number, spec JSON, changed-by, changed-at, and change comment;
- version reads use the current user's CMDBuild grants on `Cst_QueryTemplateVersion`.

Implemented DSL v1 operations:

- `findClassesByAttributeType`;
- `extractVariables`;
- `selectCards`;
- `expandRelations`;
- `composeRows`;
- `listDomains`;
- `filterRows`;
- `intersectRows` for set intersections between intermediate table results;
- `joinRows` for bounded table joins between intermediate table results;
- `traverseDomains` with `depth` or `depthParam`, capped by runtime config;
- `compareClassAttributes`.

Sample template:

- `ProbeReferenceDomainTraversal`: finds classes by reference attribute type, filters rows by class name, and returns domains related to the filtered class set with configurable traversal depth.
- `ProbeAttributeComparison`: finds classes by attribute type and compares class attribute sets by selected metadata fields such as `name` and `type`.
- `ProbeClassSetOperations`: finds class sets by two attribute types, intersects them by class code, and joins the intersected set to the second attribute set.

`selectCards` is the first business-data selection operation. It is intentionally not a generic REST proxy: the template declares a class source, filters, a result alias, and a limit. The backend then reads `/classes/:className/cards` with the current user's CMDBuild session, applies fixed/parameter/source-row filters, and returns a table result. Object-group scope filters can use `scope: include|exclude`, catalog `path`, `negate`, `op`, and `regex`/`value`; regex and value text may include `${param.name}` placeholders resolved from template input parameters. `exists`, `isIpv4`, and `isIpv4Network` do not use a right-side value.

`expandRelations` is the first card-level relation operation. It takes rows from a previous step, resolves source class/id columns, reads `/classes/:className/cards/:id/relations`, optionally filters by domain, target class, and direct/inverse direction, and reads related cards through `/classes/:relatedClass/cards/:relatedId` when related-card attributes are requested. It remains allowlisted DSL behavior, not a generic CMDBuild REST proxy.

The Designer stores relation templates with `spec.visualModel.mode = "relationExpansion"`. This visual model is non-executable metadata: the backend executes only the compiled DSL steps. It lets the Designer refill source selection, relation filters, and related-card columns when an existing template is selected.

`composeRows` prepares the table that users normally see in runtime views. It can project/rename columns from one intermediate result, add fixed or parameter values, or join two intermediate results by declared keys and then project the joined row into a named output table.

Visualization is stored in `result.tables`, not as executable JavaScript. Each visible table references a result alias and may define a title, display mode (`table`, `compact`, `keyValue`), explicit columns, and empty-state text. `result.permissionDeniedText` defaults to `Вам не хватает прав увидеть данные или интерфейс дизайнера` and is returned for technical-class read denial or CMDBuild 401/403 during template execution. The runtime renderer only formats the tables returned by the executor and does not gain any additional CMDBuild access.

Publication is stored in `spec.publish`. `dynamicUser` keeps the normal current-user execution path. `staticSnapshot` serves an explicitly published Redis snapshot; the Designer shows a warning and requires confirmation before the template can be saved/published in that mode.

## Runtime Flow

User opens:

```text
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

CMDBuild launcher alternative:

```text
/cmdbuild/ui/?cmdpTemplate=<templateCode>&param=value#custompages/CmdbDynamicPages
```

Runtime UI:

- reads the template code from `/run/<templateCode>`;
- extracts template code and params;
- calls `GET /cmdbuild/custom-api/templates/<templateCode>/run?param=value`;
- renders result tables or permission/validation errors.
- when the reserved query parameter `json=true` is present, the backend-owned runtime route returns the same authorized final tables as `application/json`; `json` is excluded from business template params and does not alter permissions or cache policy.
- runtime JSON treats an empty authorized result as HTTP `200` with empty rows and treats explicit CMDBuild `401/403` on a used class/attribute as HTTP `403` with `permissionDenied=true`; the executor does not return a partial multi-selection result when one required selection is denied.
- known boundary: if CMDBuild masks a denied class/attribute as `404`, the current implementation may classify it as a generic execution error; if a superclass resolves to only readable descendants, the runtime can return the readable descendant subset.

Implemented Runtime MVP:

- serves `/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value`;
- custom page launcher redirects legacy launcher URLs to the direct runtime UI route;
- calls `GET /cmdbuild/custom-api/templates/<templateCode>/run?param=value`;
- renders result tables returned by the backend.

Backend:

- reads the user cookie;
- validates `/sessions/current`;
- reads `QueryTemplate`;
- validates params;
- executes DSL under current user's permissions;
- returns tables.

## Runtime Limits

Add defensive limits before exposing broad template execution:

- max classes scanned;
- max domains traversed;
- max REST calls per run;
- max rows per table;
- max traversal depth;
- timeout;
- cancellation;
- standard backend logging.

## Implementation Order

1. Freeze reverse proxy layout.
2. Verify CMDBuild roles/groups/users endpoints.
3. Design technical class schema under the chosen root.
4. Implement root/bootstrap checks.
5. Implement template CRUD.
6. Implement DSL v1 validation.
7. Implement DSL v1 execution.
8. Implement designer MVP.
9. Implement runtime URL route and result tables.
10. Add versioning, execution log, limits, and hardening.
