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
- The custom page is a launcher that redirects users to backend-owned UI routes.
- Session safety constraints are documented.
- Regular non-admin user `mdavis` was checked.
- Technical root/classes were created under `Cst_QueryTool`.
- Template CRUD endpoints store data in CMDBuild cards.
- Minimal DSL v1 validation and execution are implemented for the first runnable operations.
- Designer UI MVP is implemented as a backend-served standalone UI.
- Designer UI has a simple visual builder that generates JSON specs for implemented DSL operation families.
- Designer UI shows template versions and can load a saved version spec into the editor.
- Designer UI uses a two-level navigation menu and no longer shows the session, technical-schema, inline guide, or class-name probe blocks on the main screen.
- Designer UI has a Schema section for first-run setup: root, description, parent superclass, preview, and non-destructive bootstrap.
- Runtime UI MVP is implemented as a backend-served standalone UI for template URLs.
- Runtime template execution has a Redis-backed cache with per-template sharing modes, in-memory dev fallback, and a refresh countdown.
- Helpdesk limited-user grants were configured for runtime read access to the custom page and technical classes.
- Runtime end-to-end was verified with limited user `mdavis`.
- DSL v1 now supports row filters, model-level domain traversal, class attribute comparison, joins, and intersections.
- Template executor enforces per-run REST call limits and per-request CMDBuild REST timeout.
- Template `preview`, direct `POST run`, and runtime iframe `GET run` write execution events only to standard backend logs; no runtime execution cards are stored in CMDBuild.
- State-changing backend calls require same-origin headers and `X-CMDBDynamicPages-CSRF`.
- Project runtime settings are stored in `Cst_QueryToolConfig` and applied to executor limits.
- Project runtime settings expose the system manual refresh cooldown in Designer.
- Runtime settings are edited as described form fields instead of raw JSON.
- Designer General settings show refresh cooldown as a system-wide setting; result cache TTL is configured per template.
- Domain traversal supports configurable depth with backend caps from CMDBuild runtime settings.
- CMDBuild custom page is now only a thin launcher.
- Designer and Runtime UI are served by backend-owned same-origin routes under `/cmdbuild/dynamicpages/ui/*`.
- Designer and Runtime UI support Russian/English language selection with browser/CMDBuild storage fallback detection.
- Designer validates and previews the current unsaved draft before save and shows an execution trace.
- `npm test` runs syntax checks, static OpenAPI/architecture-link validation, and unit tests.
- `npm run test:unit` covers runtime cache keys, cache metadata, parameter defaults, IPv4 matching, dependency maps, and log redaction.
- `npm run test:api` provides a skip-safe API contract smoke against a running proxy.
- `npm run test:ui` provides a skip-safe Playwright smoke for Designer and Runtime shell behavior.
- `npm run test:nginx` validates nginx config and same-origin wiki/dynamicpages routes through `localhost:8088`.
- `npm run e2e` verifies session, logging diagnostics, schema readiness, CSRF rejection, draft preview without runtime cache, Runtime shell loading, saved-template run, cache hit, POST `forceRefresh`, and that GET runtime cannot force refresh.
- `npm run e2e:write` creates or updates a stable smoke template and verifies save/version/runtime flow.
- `npm run e2e:write` verifies `expectedSpecHash` conflict handling for stale template updates.
- `npm run e2e:limited` logs in as local `mdavis` / `Helpdesk`, verifies runtime access, and verifies template create is rejected.
- Designer caches the CMDBuild model catalog client-side and shows a header freshness lamp with manual sync; stale/yellow starts after 24 hours.
- Designer has the first object-group visual mode for one or more named selections (`Выборка 1`, `Выборка 2`, ...), each compiled to its own `selectCards` result.
- DSL v1 can expand selected cards through CMDBuild card relations with `expandRelations`.
- Designer has the second object-matching visual mode that compiles source-card selection plus single-hop relation expansion into `selectCards` + `expandRelations`.
- Standalone relation-chain, value-search, group-comparison, and composition Designer sections were removed from the visible UI and client editor code; existing saved DSL steps remain executable in the backend executor.
- Designer has a final-view visual composer that writes `result.tables` with selected columns, column labels, display mode, empty-state text, permission-denied text, and optional single-table runtime output.
- Visualization column selectors for sorting, subtables, and grouping are limited to the actual Final data columns.
- Visualization split-subtable titles default to the selected split column token, for example `${Выборка2.city}`.
- Runtime table sorting and text filtering are client-side only; text filtering is enabled by default, both controls are disabled when row grouping is enabled, and subtable sorting stays inside each subtable.
- Extraction preview can display a chosen selection result or the final object-matching result.
- Runtime result caching is now controlled per template: `permissionOnly` shares endpoint results after a used-field permission probe, `visibilityHash` adds visible-id hashing for row-level scope, `privateUser` isolates by user/session, and `disabled` turns cache off.
- The executor builds a used-field dependency map so `selectCards` materializes only attributes used by filters, matching, final data, or visualization.
- Templates can be published as Redis static snapshots; runtime serves published snapshots without source-object permission checks and shows `Страница отсутствует для загрузки` when the snapshot is absent.
- BAA verification endpoint `POST /cmdbuild/custom-api/templates/<templateCode>/baa-verify` is implemented for `cmdbaa` exchange through the same reverse proxy and CMDBuild permission model.
- DSL step `baaPlanObjects` materializes BAA `plan.objects` as a temporary table without runtime writes to CMDBuild.
- Production health/readiness endpoints are implemented with strict Redis visibility checks and CMDBuild upstream reachability checks.
- Redis password support is implemented through deployment secrets (`CMDBDYNAMIC_REDIS_PASSWORD_FILE` preferred) and Redis credentials are masked in health/status responses.
- Docker runtime packaging, minimal GitHub Actions/GitLab CI, retry/backoff, execution throttling, graceful shutdown, keep-alive CMDBuild agents, security headers, nginx rate limiting, strict CMDBuild proxy allowlist, JSON mutation `Content-Type` checks, Prometheus `/metrics`, Redis strict mode, regex guard, and template `specHash` conflict guard are implemented as audit hardening.
- `PROJECT_DOCUMENTATION.md`, audit remediation notes, and initial ADRs document the current documentation map and deferred architecture decisions.
- `docs/runbook.md` documents deploy checks, rollback, diagnostics, incidents, SLI candidates, and alert inputs.
- Russian documentation is maintained in parallel with the English documentation.
- Architecture artifacts are maintained under `aa/`.

Not done:

- No remaining core implementation items in the current plan.
- Example templates are tracked separately from the implementation plan.
- Deeper Playwright Runtime table checks are implemented as skip-safe tests and depend on available live template fixtures for full coverage.
- Browser-level iframe rendering inside a real wiki page is implemented as an optional smoke through `CMDBDYNAMIC_WIKI_IFRAME_URL`.
- Browser/API smoke for a live `cmdbaa` exchange will be added separately after the external scenario stabilizes.
- A stable local wiki page still needs to be maintained so the optional iframe smoke can run regularly.

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
  - `mdavis` / `Helpdesk` sees `/roles`, current role, classes, and domains; `/users` returns `401`; `/groups` returns `404`.
  - Permission-scope probe returns a diagnostic visible-model hash, but not a proof for shared result caching.
- [x] Decide whether to use roles/groups directly or CRUD rights on `QueryTemplate`.
  - Decision: use CMDBuild CRUD rights on the technical `QueryTemplate` class for editor authorization.
  - Roles/users endpoints are supporting metadata only; they should not become a separate editor ACL unless CRUD rights are insufficient.

## 2. Technical Root/Bootstrap

- [x] Design exact classes under a root such as `Cst_QueryTool`.
- [x] Verify whether CMDBuild classes can be created through REST in this environment.
- [x] Implement an endpoint to check/create the technical schema.
  - [x] `GET /cmdbuild/custom-api/schema`
  - [x] `POST /cmdbuild/custom-api/schema/bootstrap`
- [x] Keep schema bootstrap available in the backend; the current Designer screen no longer exposes the technical-schema block.
- [x] Keep `/root` strictly scoped to technical project classes, not business-data filtering.

## 3. CMDBuild Storage Classes

- [x] `Cst_QueryToolConfig`
- [x] `Cst_QueryTemplate`
- [x] `Cst_QueryTemplateVersion`
- [x] Configure CMDBuild grants for limited users on technical classes.
  - `Helpdesk` has read grants on `Cst_QueryTool`, `Cst_QueryToolConfig`, `Cst_QueryTemplate`, and `Cst_QueryTemplateVersion`.
  - `Helpdesk` has read grant on custom page `CmdbDynamicPages` (`1662627`).
  - Create template under `mdavis` is rejected by CMDBuild with the read-only grants.
- [x] Store actual project settings cards in CMDBuild classes where technically possible.
  - `GET /cmdbuild/custom-api/config`
  - `PUT /cmdbuild/custom-api/config`
  - Runtime config currently controls executor defaults/caps for rows, classes, domains, REST calls, and traversal depth.
  - Runtime config provides Redis runtime refresh cooldown; result cache TTL is configured per template.
- [x] Store query templates as JSON in CMDBuild, not local files.

## 4. Backend API

- [x] `GET /cmdbuild/custom-api/session`
- [x] `GET /cmdbuild/custom-api/model/classes`
- [x] `GET /cmdbuild/custom-api/model/classes/:className`
- [x] `GET /cmdbuild/custom-api/model/classes/:className/attributes`
- [x] `GET /cmdbuild/custom-api/model/domains`
- [x] `GET /cmdbuild/custom-api/model/domains/:domainName`
- [x] `GET /cmdbuild/custom-api/auth/capabilities`
- [x] `GET /cmdbuild/custom-api/auth/permission-scope`
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
  - [x] `DELETE /cmdbuild/custom-api/templates/:code`
- [x] Validate/preview/run endpoints:
  - [x] `POST /cmdbuild/custom-api/templates/:code/validate`
  - [x] `POST /cmdbuild/custom-api/templates/:code/preview`
  - [x] `GET /cmdbuild/custom-api/templates/:code/run`
  - [x] `POST /cmdbuild/custom-api/templates/:code/run`
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
  - [x] regexp variable extraction.
  - [x] card selection from CMDBuild classes with bounded filters.
  - [x] result composition/projection with optional joins in the backend executor.
  - [x] card-level relation expansion through CMDBuild `/cards/{id}/relations`.

## 6. Designer UI

- [x] Serve Designer as standalone backend UI at `/cmdbuild/dynamicpages/ui/designer`.
- [x] Split Designer menu items into separate section routes under `/cmdbuild/dynamicpages/ui/designer/<section>`.
- [x] Move catalog path-hint depth into `Schema and settings -> General settings`.
- [x] Remove the standalone Editor menu item; template creation now shows only code and description, and selected templates are shown in a top "Modifying" banner.
- [x] Template list.
- [x] Template creation/editing.
- [x] Focused Designer sections replace the standalone JSON editor in the visible menu.
- [x] Preview.
- [x] Save templates to CMDBuild.
- [x] Simple visual builder.
- [x] Template version UI.
- [x] Russian/English language selector.
- [x] Remove the inline workflow guide from the active Designer UI.
- [x] Remove the direct class-name check panel from the active Designer UI.
- [x] Support `SpecJson.defaults.className` as a fallback when runtime params omit `className`.
- [x] Add first constructor block `Input variables` (`name/type/required/default/example/description`).
- [x] Build the test input form from declared input variables and use default values when input is omitted.
- [x] Require a default value for every non-required input variable.
- [x] Render class selectors as an inheritance tree with class descriptions and expand superclass selections to readable descendants during execution.
- [x] Add regex extraction editor for internal variables.
- [x] Add data-selection editor for `selectCards` steps using params or extracted variables.
- [x] Replace the old composition editor with the focused Final data composer.
- [x] Add visualization editor for `result.tables` title/mode/columns/empty text.
- [x] Add focused final-view composer for selected columns and column labels.
- [x] Add test workflow with emulated input, draft validate, draft preview, execution trace, and save-after-preview.
- [x] Check one CMDBuild class by entered name and show attributes according to current user permissions.
- [x] Cache class/attribute/domain/lookup metadata in the browser and show freshness/sync status.
- [x] Add first visual mode: object group scope selection by include/exclude regex rules, with `${param.name}` substitutions.
- [x] Add second visual mode: select related objects through one CMDBuild relation hop and compile it to `selectCards` + `expandRelations`.
- [x] Add array search/intersection visual mode: use values from one result to find and compare another related object set.
- [x] Add multi-hop path visual mode: configure chained domain expansion hops using catalog class/domain selectors.

## 7. Runtime UI

- [x] Serve Runtime as standalone backend UI at:

```text
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

- [x] Keep launcher compatibility for URLs like:

```text
/cmdbuild/ui/?cmdpTemplate=<templateCode>&param=value#custompages/CmdbDynamicPages
```

- [x] Call:

```text
/cmdbuild/custom-api/templates/<templateCode>/run
```

- [x] Render result tables.
- [x] Render table, compact table, and key-value result modes.
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
- [x] Add repeatable backend smoke/e2e script for draft and runtime flows.
- [x] Add repeatable write smoke/e2e script for template save/version/runtime.
- [x] Add repeatable limited-user smoke/e2e script for read-only grants.

## Current Verified Endpoints

Project backend through proxy:

```text
GET /cmdbuild/dynamicpages/ui/designer
GET /cmdbuild/dynamicpages/ui/run/<templateCode>
GET /cmdbuild/custom-api/session
GET /cmdbuild/custom-api/model/classes
GET /cmdbuild/custom-api/model/classes/:className
GET /cmdbuild/custom-api/model/classes/:className/attributes
GET /cmdbuild/custom-api/model/domains
GET /cmdbuild/custom-api/model/domains/:domainName
GET /cmdbuild/custom-api/auth/capabilities
GET /cmdbuild/custom-api/auth/permission-scope
GET /cmdbuild/custom-api/csrf
GET /cmdbuild/custom-api/schema
POST /cmdbuild/custom-api/schema/bootstrap
GET /cmdbuild/custom-api/config
PUT /cmdbuild/custom-api/config
GET /cmdbuild/custom-api/templates
GET /cmdbuild/custom-api/templates/:code
GET /cmdbuild/custom-api/templates/:code/versions
POST /cmdbuild/custom-api/templates
PUT /cmdbuild/custom-api/templates/:code
DELETE /cmdbuild/custom-api/templates/:code
POST /cmdbuild/custom-api/templates/:code/validate
POST /cmdbuild/custom-api/templates/:code/preview
GET /cmdbuild/custom-api/templates/:code/run
POST /cmdbuild/custom-api/templates/:code/run
POST /cmdbuild/custom-api/draft/validate
POST /cmdbuild/custom-api/draft/preview
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
