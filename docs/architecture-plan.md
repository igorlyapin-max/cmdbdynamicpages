# cmdbdynamicpages Architecture Plan

## Goal

Build CMDBuild dynamic custom pages with two scenarios:

- template designer: users prepare complex query templates and store them as JSON in CMDBuild technical classes;
- template runtime: users open a custom page URL with a template code and parameters, and the system renders one or more result tables if the current CMDBuild user has enough permissions.

## Runtime Architecture

```text
CMDBuild UI custom page
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

The browser never sends URL fragments to the server. Runtime template URLs can use hash routing for the UI:

```text
/cmdbuild/ui/#custompages/CmdbDynamicPages/<templateCode>?param=value
```

The custom page must parse the hash client-side and call a real backend path:

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

CSRF strategy:

- `GET /cmdbuild/custom-api/csrf` returns a token derived server-side from the current CMDBuild session token and backend secret;
- the custom page sends this token in `X-CMDBDynamicPages-CSRF` for non-GET backend calls;
- state-changing backend calls require both same-origin `Origin`/`Referer` and a valid CSRF token;
- the CSRF token is not the CMDBuild token and cannot be used as CMDBuild REST authorization.

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
Cst_QueryExecutionLog
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

QueryExecutionLog
  Template
  StartedAt
  FinishedAt
  Username
  ExecutionStatus
  RowsCount
  ErrorMessage
```

Implemented local technical classes use the `Cst_` prefix under `Cst_QueryTool`:

```text
Cst_QueryTool
Cst_QueryToolConfig
Cst_QueryTemplate
Cst_QueryTemplateVersion
Cst_QueryExecutionLog
```

`Cst_QueryTemplateVersion` and `Cst_QueryExecutionLog` currently keep `TemplateCode` as a string. A CMDBuild reference/domain can be added later if the designer needs navigable relations between template cards, versions, and logs.

CMDBuild `json` card attributes are written through REST as JSON strings and parsed back to JSON objects by the backend response layer.

Implemented runtime config:

- `GET /cmdbuild/custom-api/config` reads the `Cst_QueryToolConfig` card for the current technical root;
- `PUT /cmdbuild/custom-api/config` upserts that card through the current user's CMDBuild permissions;
- Designer shows and saves `RuntimeConfigJson`;
- `preview/run` use `RuntimeConfigJson.executionLimits` for default and capped executor limits.

Current `RuntimeConfigJson` shape:

```json
{
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
- role `Helpdesk` has write grant on `Cst_QueryExecutionLog` so audit cards can be written as the current CMDBuild user;
- role `Helpdesk` has read grant on custom page `CmdbDynamicPages` (`1662627`);
- user `mdavis` can read templates and run runtime URLs, but cannot create templates through the backend with these grants.

## Designer UI

Designer route:

```text
/cmdbuild/ui/#custompages/CmdbDynamicPages/designer
```

Designer responsibilities:

- list templates;
- create and edit templates;
- show available CMDBuild classes, attributes, and domains according to the current user's permissions;
- validate DSL JSON;
- preview results;
- save templates into `QueryTemplate`;
- show template versions.

The designer must not limit available business classes by the technical `/root`.

Implemented Designer MVP:

- lists templates from `Cst_QueryTemplate`;
- creates and edits templates through JSON text areas;
- provides a simple visual builder that generates DSL JSON for the implemented operation families;
- validates and previews templates through backend endpoints;
- saves templates into CMDBuild cards;
- shows saved template versions and can load a version spec back into the editor;
- shows schema readiness and can call schema bootstrap for the configured technical root;
- shows selectable CMDBuild classes, attributes for the selected class, and detailed domain metadata visible to the current user.

## Query DSL

Templates should store declarative JSON, not arbitrary JavaScript, SQL, or CQL.

The first DSL version should cover:

- finding classes by attribute type;
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
GET  /cmdbuild/custom-api/model/classes/:className/attributes
GET  /cmdbuild/custom-api/model/domains
GET  /cmdbuild/custom-api/model/domains/:domainName
GET  /cmdbuild/custom-api/auth/capabilities
GET  /cmdbuild/custom-api/csrf
GET  /cmdbuild/custom-api/schema
POST /cmdbuild/custom-api/schema/bootstrap
GET  /cmdbuild/custom-api/config
PUT  /cmdbuild/custom-api/config
GET  /cmdbuild/custom-api/execution-logs

GET  /cmdbuild/custom-api/templates
GET  /cmdbuild/custom-api/templates/:code
GET  /cmdbuild/custom-api/templates/:code/versions
POST /cmdbuild/custom-api/templates
PUT  /cmdbuild/custom-api/templates/:code

POST /cmdbuild/custom-api/templates/:code/validate
POST /cmdbuild/custom-api/templates/:code/preview
POST /cmdbuild/custom-api/templates/:code/run
```

Backend responsibilities:

- read the current CMDBuild session cookie;
- validate the session;
- read and write technical CMDBuild classes;
- validate DSL and parameters;
- execute DSL through CMDBuild REST as the current user;
- enforce execution limits for rows, class/domain scans, domain traversal depth, REST calls, and individual CMDBuild REST timeouts;
- return table-oriented JSON to the custom page.

Implemented foundation routes:

- `GET /cmdbuild/custom-api/session`: returns a sanitized current session and selected role privilege flags;
- `GET /cmdbuild/custom-api/model/classes`: returns sanitized CMDBuild class metadata according to current user permissions;
- `GET /cmdbuild/custom-api/model/classes/:className/attributes`: returns sanitized attribute metadata for one visible class;
- `GET /cmdbuild/custom-api/model/domains`: returns sanitized domain metadata, with optional `details=true` expansion for source/destination/cardinality fields;
- `GET /cmdbuild/custom-api/model/domains/:domainName`: returns sanitized detailed metadata for one visible domain;
- `GET /cmdbuild/custom-api/auth/capabilities`: returns role/user/groups endpoint probe results and confirms the `cmdbuild-class-crud` editor permission strategy.
- `GET /cmdbuild/custom-api/csrf`: returns a session-bound custom API CSRF token for non-GET backend calls;
- `GET /cmdbuild/custom-api/schema`: checks technical root/classes/attributes under the configured root;
- `POST /cmdbuild/custom-api/schema/bootstrap`: creates missing technical classes/attributes, guarded by same-origin headers and `admin_classes_modify`;
- `GET/PUT /cmdbuild/custom-api/config`: reads and writes `Cst_QueryToolConfig.RuntimeConfigJson`;
- `GET /cmdbuild/custom-api/execution-logs`: returns sanitized execution audit cards visible to the current user;
- `GET /cmdbuild/custom-api/templates/:code/versions`: returns sanitized version cards visible to the current user;
- `GET/POST/PUT /cmdbuild/custom-api/templates...`: stores and reads template JSON from `Cst_QueryTemplate` cards;
- `POST /validate`, `/preview`, `/run`: validates or executes DSL v1 templates under the current user's CMDBuild permissions.

Executor limits:

- `maxRows`: defaults to `500` for run and `25` for preview;
- `maxClasses`: defaults to `100`, capped at `500`;
- `maxDomains`: defaults to `100`, capped at `500`;
- `maxRestCalls`: defaults to `250`, capped at `1000`;
- `maxTraversalDepth`: defaults to `1`, capped at `5`;
- `CMDBUILD_REQUEST_TIMEOUT_MS`: defaults to `10000` ms for each CMDBuild REST call.

Execution audit:

- `preview` and `run` write best-effort cards to `Cst_QueryExecutionLog`;
- audit cards store template code, started/finished timestamps, username, execution status, row count, and error message;
- request parameters and CMDBuild cookies/tokens are not stored in audit cards;
- audit failures are returned as `auditLog.success=false` but do not hide a successful execution result.

Template versioning:

- `create` and `update` write best-effort snapshots to `Cst_QueryTemplateVersion`;
- version cards store template code, version number, spec JSON, changed-by, changed-at, and change comment;
- version reads use the current user's CMDBuild grants on `Cst_QueryTemplateVersion`.

Implemented DSL v1 operations:

- `findClassesByAttributeType`;
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

## Runtime Flow

User opens:

```text
/cmdbuild/ui/#custompages/CmdbDynamicPages/<templateCode>?param=value
```

Custom page:

- parses the hash route;
- extracts template code and params;
- calls `/cmdbuild/custom-api/templates/<templateCode>/run`;
- renders result tables or permission/validation errors.

Implemented Runtime MVP:

- parses `/cmdbuild/ui/#custompages/CmdbDynamicPages/<templateCode>?param=value`;
- calls `/cmdbuild/custom-api/templates/<templateCode>/run`;
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
- audit log.

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
