# cmdbdynamicpages Roadmap

This file tracks the high-level plan so implementation does not drift from the agreed architecture.

Legend:

- `[x]` done
- `[ ]` not done

## Current Status Summary

Done:

- `CmdbDynamicPages` is registered as a CMDBuild custom page.
- CMDBuild can be opened through the same-origin dev proxy.
- Backend routes under `/cmdbuild/custom-api/*` receive the CMDBuild `HttpOnly` cookie.
- Backend can call CMDBuild REST as the current user by forwarding the cookie value as a server-side `CMDBuild-Authorization` header.
- Stable foundation backend endpoints are implemented for session, classes, domains, and auth capabilities.
- The custom page was updated to probe the stable backend endpoints.
- Session safety constraints are documented.
- Regular non-admin user `mdavis` was checked.
- Technical root/classes were created under `Cst_QueryTool`.
- Template CRUD endpoints store data in CMDBuild cards.
- Minimal DSL v1 validation and execution are implemented for the first runnable operations.
- Designer UI MVP is implemented in the custom page.
- Designer UI has a simple visual builder that generates JSON specs for implemented DSL operation families.
- Designer UI shows template versions and can load a saved version spec into the editor.
- Designer UI shows selectable classes, attributes of the selected class, and detailed domains visible to the current user.
- Runtime UI MVP is implemented for template URLs.
- Helpdesk limited-user grants were configured for runtime read access to the custom page and technical classes.
- Runtime end-to-end was verified with limited user `mdavis`.
- DSL v1 now supports row filters, model-level domain traversal, class attribute comparison, joins, and intersections.
- Template executor enforces per-run REST call limits and per-request CMDBuild REST timeout.
- Template `preview/run` writes execution audit cards to `Cst_QueryExecutionLog`.
- State-changing backend calls require same-origin headers and `X-CMDBDynamicPages-CSRF`.
- Project runtime settings are stored in `Cst_QueryToolConfig` and applied to executor limits.
- Domain traversal supports configurable depth with backend caps from CMDBuild runtime settings.

Not done:

- No agreed MVP items remain open.

## 1. CMDBuild Roles/Groups Check

- [x] Find REST endpoints for groups/roles/users.
  - `/cmdbuild/services/rest/v3/roles` works for admin.
  - `/cmdbuild/services/rest/v3/roles/{id}` works for admin.
  - `/cmdbuild/services/rest/v3/roles/{name}` works for admin.
  - `/cmdbuild/services/rest/v3/users` works for admin.
  - `/cmdbuild/services/rest/v3/users/{id}` works for admin and returns assigned roles in `userGroups`.
  - `/cmdbuild/services/rest/v3/groups` is not available in this instance and returns `404`.
- [x] Check what is available to a regular user and to an admin.
  - [x] Admin user checked.
  - [x] Regular non-admin user checked with `mdavis` / role `Helpdesk`.
  - Admin sees `/roles`, `/users`, detailed role privileges, classes, domains, and technical schema.
  - `Helpdesk` sees `/roles` only for its own role, cannot access `/users`, and does not currently see technical classes.
- [x] Decide whether to use roles/groups directly or CRUD rights on `QueryTemplate`.
  - Decision: use CMDBuild CRUD rights on the technical `QueryTemplate` class for editor authorization.
  - Roles/users endpoints are supporting metadata only; they should not become a separate editor ACL unless CRUD rights are insufficient.

## 2. Technical Root/Bootstrap

- [x] Design exact classes under a root such as `Cst_QueryTool`.
- [x] Verify whether CMDBuild classes can be created through REST in this environment.
- [x] Implement an endpoint to check/create the technical schema.
  - [x] `GET /cmdbuild/custom-api/schema`
  - [x] `POST /cmdbuild/custom-api/schema/bootstrap`
- [x] Make the UI propose technical schema creation under the configured root.
- [x] Keep `/root` strictly scoped to technical project classes, not business-data filtering.

## 3. CMDBuild Storage Classes

- [x] `Cst_QueryToolConfig`
- [x] `Cst_QueryTemplate`
- [x] `Cst_QueryTemplateVersion`
- [x] `Cst_QueryExecutionLog`
- [x] Configure CMDBuild grants for limited users on technical classes.
  - `Helpdesk` has read grants on `Cst_QueryTool`, `Cst_QueryToolConfig`, `Cst_QueryTemplate`, and `Cst_QueryTemplateVersion`.
  - `Helpdesk` has read grant on custom page `CmdbDynamicPages` (`1662627`).
  - `Helpdesk` has write grant on `Cst_QueryExecutionLog` so runtime audit can be written as the current user.
  - Create template under `mdavis` is rejected by CMDBuild with the read-only grants.
- [x] Store actual project settings cards in CMDBuild classes where technically possible.
  - `GET /cmdbuild/custom-api/config`
  - `PUT /cmdbuild/custom-api/config`
  - Runtime config currently controls executor defaults/caps for rows, classes, domains, REST calls, and traversal depth.
- [x] Store query templates as JSON in CMDBuild, not local files.

## 4. Backend API

- [x] `GET /cmdbuild/custom-api/session`
- [x] `GET /cmdbuild/custom-api/model/classes`
- [x] `GET /cmdbuild/custom-api/model/classes/:className/attributes`
- [x] `GET /cmdbuild/custom-api/model/domains`
- [x] `GET /cmdbuild/custom-api/model/domains/:domainName`
- [x] `GET /cmdbuild/custom-api/auth/capabilities`
- [x] `GET /cmdbuild/custom-api/csrf`
- [x] Technical schema endpoints:
  - [x] `GET /cmdbuild/custom-api/schema`
  - [x] `POST /cmdbuild/custom-api/schema/bootstrap`
- [x] CRUD for templates:
  - [x] `GET /cmdbuild/custom-api/templates`
  - [x] `GET /cmdbuild/custom-api/templates/:code`
  - [x] `GET /cmdbuild/custom-api/templates/:code/versions`
  - [x] `POST /cmdbuild/custom-api/templates`
  - [x] `PUT /cmdbuild/custom-api/templates/:code`
- [x] Validate/preview/run endpoints:
  - [x] `POST /cmdbuild/custom-api/templates/:code/validate`
  - [x] `POST /cmdbuild/custom-api/templates/:code/preview`
  - [x] `POST /cmdbuild/custom-api/templates/:code/run`
- [x] Execution logs:
  - [x] `GET /cmdbuild/custom-api/execution-logs`
- [x] Config:
  - [x] `GET /cmdbuild/custom-api/config`
  - [x] `PUT /cmdbuild/custom-api/config`

## 5. DSL v1

- [x] Basic JSON schema rules for template specs.
- [x] Validation.
- [x] Minimal executor.
- [x] First operations:
  - [x] classes by attribute type;
  - [x] filters;
  - [x] domain listing;
  - [x] domain traversal;
  - [x] result tables.
  - [x] attribute comparison.
  - [x] joins/intersections.

## 6. Designer UI

- [x] Template list.
- [x] Template creation/editing.
- [x] JSON editor.
- [x] Preview.
- [x] Save templates to CMDBuild.
- [x] Simple visual builder.
- [x] Template version UI.
- [x] Show available CMDBuild classes, attributes, and domains according to current user permissions.
  - [x] Show current visible class/domain counts.
  - [x] Show detailed selectable classes, attributes, and domains.

## 7. Runtime UI

- [x] Parse URLs like:

```text
/cmdbuild/ui/#custompages/CmdbDynamicPages/<templateCode>?param=value
```

- [x] Call:

```text
/cmdbuild/custom-api/templates/<templateCode>/run
```

- [x] Render result tables.
- [x] Show validation and permission errors.

## 8. Hardening

- [x] CSRF protection for state-changing backend calls.
- [x] Origin/Referer checks for state-changing custom API calls.
- [x] Execution limits:
  - [x] max rows;
  - [x] max REST calls;
  - [x] max traversal depth;
  - [x] max classes/domains scanned.
- [x] Timeouts for individual CMDBuild REST calls.
- [x] Audit log.
- [x] Avoid generic REST proxy behavior for custom API.
- [x] Do not return cookies/tokens to JavaScript.
- [x] Confirm cookies/tokens are never logged in backend error paths.
- [x] Verify normal CMDBuild UI behavior through the reverse proxy after each hardening step.

## 9. End-to-End Test

- [x] Create root schema.
- [x] Create a template.
- [x] Run the template by URL.
- [x] Verify result under a user with limited CMDBuild rights.
- [x] Verify normal CMDBuild UI behavior through the proxy.

## Current Verified Endpoints

Project backend through proxy:

```text
GET /cmdbuild/custom-api/session
GET /cmdbuild/custom-api/model/classes
GET /cmdbuild/custom-api/model/classes/:className/attributes
GET /cmdbuild/custom-api/model/domains
GET /cmdbuild/custom-api/model/domains/:domainName
GET /cmdbuild/custom-api/auth/capabilities
GET /cmdbuild/custom-api/csrf
GET /cmdbuild/custom-api/schema
POST /cmdbuild/custom-api/schema/bootstrap
GET /cmdbuild/custom-api/config
PUT /cmdbuild/custom-api/config
GET /cmdbuild/custom-api/execution-logs
GET /cmdbuild/custom-api/templates
GET /cmdbuild/custom-api/templates/:code
GET /cmdbuild/custom-api/templates/:code/versions
POST /cmdbuild/custom-api/templates
PUT /cmdbuild/custom-api/templates/:code
POST /cmdbuild/custom-api/templates/:code/validate
POST /cmdbuild/custom-api/templates/:code/preview
POST /cmdbuild/custom-api/templates/:code/run
```

CMDBuild REST findings:

```text
GET /cmdbuild/services/rest/v3/sessions/current
GET /cmdbuild/services/rest/v3/classes
GET /cmdbuild/services/rest/v3/classes/{className}/attributes
GET /cmdbuild/services/rest/v3/domains
GET /cmdbuild/services/rest/v3/domains/{domainName}
GET /cmdbuild/services/rest/v3/roles
GET /cmdbuild/services/rest/v3/roles/{id}
GET /cmdbuild/services/rest/v3/roles/{name}
GET /cmdbuild/services/rest/v3/roles/{roleName}/grants
GET /cmdbuild/services/rest/v3/roles/{roleName}/grants?includeObjectDescription=true&includeRecordsWithoutGrant=true&ext=true
POST /cmdbuild/services/rest/v3/roles/{roleName}/grants/_ANY
GET /cmdbuild/services/rest/v3/users
GET /cmdbuild/services/rest/v3/users/{id}
```

Unavailable in this instance:

```text
GET /cmdbuild/services/rest/v3/groups
```
