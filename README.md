# cmdbdynamicpages

`cmdbdynamicpages` is a CMDBuild custom page and backend integration project for dynamic, parameterized data pages.

The project has two target scenarios:

- a designer UI for preparing and storing query templates as JSON in CMDBuild technical classes;
- a runtime UI that opens a template from the CMDBuild custom page URL and renders the result as tables, using the current user's CMDBuild permissions.

Step-by-step deployment guide: [docs/deployment-guide.md](docs/deployment-guide.md).

## Current Architecture

The current implementation keeps CMDBuild custom page code intentionally small:

- the custom page is a launcher that redirects to project-owned UI routes;
- Designer and Runtime are rendered by the local backend under `/cmdbuild/dynamicpages/ui/*`;
- browser JavaScript uses `fetch(..., { credentials: 'include' })` only against allowlisted project backend routes;
- JavaScript does not read or send `CMDBuild-Authorization`;
- the backend receives the CMDBuild `HttpOnly` cookie on same-origin routes;
- the backend forwards the cookie value to CMDBuild REST as a server-side `CMDBuild-Authorization` header.

The CMDBuild/Tomcat deployment owns the user session lifetime; `cmdbdynamicpages` does not extend it. On the current test stand the server-side idle timeout is 30 minutes. The relevant Tomcat `web.xml` block is approximately:

```xml
<session-config>
    <session-timeout>30</session-timeout>
</session-config>
```

The value is in minutes. This is separate from template runtime cache TTL: the browser may still hold a cookie, but the backend validates `/sessions/current` and treats the user as unauthenticated after CMDBuild expires the session.

## Custom Page

The project custom page is registered as:

- `name`: `CmdbDynamicPages`
- `description`: `CMDB Dynamic Pages`
- `componentId`: `view.custompages.CmdbDynamicPages.CmdbDynamicPages`
- `alias`: `widget.cmdb-dynamic-pages`

Build the ZIP:

```bash
npm run build:zip
```

Upload payload target:

```text
/cmdbuild/services/rest/v3/custompages
```

with a JSON field named `data` and a ZIP field named `file`.

Local upload example:

```bash
curl -b /tmp/cmdbuild-ui-cookie.txt \
  -F 'data={"name":"CmdbDynamicPages","description":"CMDB Dynamic Pages","alias":"widget.cmdb-dynamic-pages","componentId":"view.custompages.CmdbDynamicPages.CmdbDynamicPages","active":true};type=application/json' \
  -F 'file=@dist/cmdbdynamicpages-custompage.zip;type=application/zip' \
  'http://127.0.0.1:8090/cmdbuild/services/rest/v3/custompages'
```

## Dev Proxy

Run the local same-origin proxy/backend:

```bash
npm run proxy:dev
```

Run self-diagnostics:

```bash
npm run diag
```

Run local non-CMDBuild checks:

```bash
npm test
npm run test:static
npm run test:unit
npm run test:ui
```

`test:static` validates required OpenAPI paths, local component `$ref` references, and links between architecture artifacts in `aa/`. `test:unit` uses the built-in Node.js test runner and covers cache key behavior, refresh metadata, parameter defaults, IPv4 matching, dependency maps, and log redaction. `test:ui` is a skip-safe Playwright browser smoke; it runs only when Playwright is installed and a valid CMDBuild session cookie is available.

Run the backend smoke/e2e check against the local proxy:

```bash
npm run e2e
```

The e2e check verifies session, logging diagnostics, technical schema readiness, CSRF rejection, draft validate/preview without runtime cache, relation expansion, multi-hop relation chains, value search, group comparison, Runtime shell loading, saved-template `run`, cache hit, POST `forceRefresh`, and that read-only GET runtime cannot force refresh. Runtime execution events are written only through the standard backend logging paths; no runtime execution cards are stored in CMDBuild.

Optional API contract smoke tests can run against a started proxy:

```bash
npm run test:api
```

Run same-origin nginx/wiki iframe checks after starting nginx:

```bash
npm run test:nginx
```

Run the write workflow e2e check:

```bash
npm run e2e:write
```

This creates or updates the stable `CmdpE2eSmoke` template in CMDBuild, verifies version creation, validates/previews it, opens the Runtime shell, and runs it.

Run the limited-user e2e check for the local `mdavis` / `Helpdesk` user:

```bash
npm run e2e:limited
```

This verifies that the limited user can run draft/runtime flows but cannot create templates with the configured read-only grants.

Watch browser-side custom page lifecycle logs after reloading the page:

```bash
npm run diag:watch
```

Clear diagnostic logs before a browser reload:

```bash
curl -b /tmp/cmdbuild-ui-cookie.txt 'http://127.0.0.1:8093/cmdbuild/custom-api/client-log?clear=1'
curl -b /tmp/cmdbuild-ui-cookie.txt 'http://127.0.0.1:8093/cmdbuild/custom-api/proxy-log?clear=1'
```

Diagnostics use `CMDBDYNAMIC_PROXY` (`http://127.0.0.1:8093` by default), `CMDBUILD_ORIGIN` (`http://127.0.0.1:8090` by default), and `CMDBUILD_COOKIE_JAR` (`/tmp/cmdbuild-ui-cookie.txt` by default). The e2e script also accepts `CMDBDYNAMIC_ROOT`, `CMDBDYNAMIC_E2E_TEMPLATE`, `CMDBDYNAMIC_E2E_ATTR_TYPE`, `CMDBDYNAMIC_E2E_WRITE_TEMPLATE`, `CMDBUILD_USERNAME`, `CMDBUILD_PASSWORD`, `CMDBUILD_ROLE`, and `CMDBUILD_COOKIE_HEADER`.

Open Designer directly through the same-origin proxy:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer
```

Designer menu sections are separate UI routes, not in-page anchors. Examples:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer/object-group
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer/final-view
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer/cache
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer/general-settings
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer/settings
```

The visible menu has no standalone JSON editor item. `New` opens a small creation form with template code, description, and an optional source-template selector for copying an existing template draft; after selecting an existing template, the header shows which template is being modified.
Designer opens the template list without auto-selecting the first template.
If a new Designer browser session opens a template-editing subsection directly, it falls back to the template list first so the user explicitly chooses what to modify.

Open Designer through the CMDBuild custom page launcher:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages
```

Designer includes JSON editing plus a simple visual builder that generates specs for classes by attribute, domain traversal, attribute comparison, and set operations. It also has a CMDBuild catalog cache indicator in the header next to the language selector: the lamp turns yellow after 24 hours from the last sync, hover shows the last sync time, and clicking the indicator refreshes class, attribute, domain, and lookup metadata for the current user context.
Class selectors are shown as an inheritance tree and include both CMDBuild class name and description, for example `routerG - Маршрутизатор`. Selecting a superclass in a `selectCards`-based template expands execution to the readable non-prototype descendants of that class.

The first visual mode is `Object group`: configure one or more selections. The first selection is shown as `Выборка 1` / `Selection 1` and keeps the legacy `objects` alias; additional selections use `objects2`, `objects3`, and so on. Each selection has its own starting CMDBuild class plus include/exclude scope rules. A rule selects a class attribute/path, including reference/domain/lookup paths expanded from the cached catalog up to the configured depth, and a regular expression. Regex fields can reference input variables as `${param.name}`. Applying it generates executable `selectCards` DSL plus `spec.visualModel`.

Object group path pickers can be filtered by domain, cardinality, and relation direction. Use this when the same attribute name is reachable through several references/domains and the template must keep paths from a specific relationship type. A collapsed help block in the section shows examples.

The second visual mode is `Object matching`: compare object selections with one or more `matchRows` blocks. Each rule is edited as left object, operator, and right object. The operator has an explicit negation selector, so `!` + `equals` replaces the older standalone `notEquals` form. IPv4 operators cover IP in CIDR, IP in range, CIDR overlap, and CIDR contains; the UI shows examples with expected true/false results.

DSL step `expandRelations` expands selected cards through CMDBuild card relations with the current user's session. It reads only allowlisted CMDBuild paths for relations and related cards, supports domain/target-class/direction filters, and returns table rows with source card, relation, and related-card columns.

The visible Designer does not expose standalone relation-chain, search-by-values, group-comparison, or composition constructors. Existing saved templates that already use the underlying DSL steps still run through the backend executor, but new templates are prepared through Object group, Object matching, Final data, Visualization, and Run sections. The Extraction section can display a chosen result table: a specific selection or the final Object matching result when a matching step exists; after object matching is configured, the final matching result is selected by default.

The `Final view` block is the focused runtime layout composer. It chooses the visible result alias, table title, display mode, empty-state text, visible columns, and column labels, then writes ordinary `result.tables` metadata. It can replace the runtime output with one final table while keeping the full DSL steps available for preview/debug.

Visualization can render a final-data column as a link. URL and text templates support `${mysource.value}`, `${mysource.source}`, `${mysource.sourceClass}`, `${mysource.sourceId}`, `${mysource.attribute}`, `${mysource.domainPath}`, `${row.<column>}`, and `${param.<name>}`. Internal links to cards that participated in the result can use ready-made variables such as `${mysource.sourceURLВыборка1}`, `${mysource.sourceURLВыборка2}`, `${mysource.sourceURLSelection1}`, and so on. Examples: `${mysource.sourceURLВыборка2}`, `/cmdbuild/ui/#classes/${mysource.sourceClass}/cards/${mysource.sourceId}` or `/wiki/${param.city}/${mysource.value}`. Unsafe `javascript:`, `data:`, and `vbscript:` URLs are blocked and fall back to plain text.

Minimal relation expansion draft:

```json
{
  "version": 1,
  "params": {
    "sourceCode": { "type": "string", "required": true, "example": "ctest-ip-if1" }
  },
  "steps": [
    {
      "type": "selectCards",
      "className": "IpAddress",
      "filters": [{ "attribute": "Code", "op": "equals", "valueParam": "sourceCode" }],
      "limit": 1,
      "as": "sourceCards"
    },
    {
      "type": "expandRelations",
      "from": "sourceCards",
      "targetClass": "serveri",
      "columns": ["Code", "Description", "hostname"],
      "limit": 20,
      "as": "relatedCards"
    }
  ],
  "result": {
    "tables": [
      {
        "name": "relatedCards",
        "columns": ["SourceCode", "Domain", "RelationDirection", "RelatedClass", "Code", "Description", "hostname"]
      }
    ]
  }
}
```

The UI supports English and Russian. Language selection order:

1. `cmdpLang` or `lang` query parameter.
2. Saved `localStorage` value from the UI language selector.
3. CMDBuild session/storage language if CMDBuild exposes one.
4. Browser language.
5. English fallback.

CMDBuild 4.1 local `/sessions/current` does not currently expose a language field, so the practical default is browser language unless the user selects a language.

Runtime route example, direct backend UI:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/ProbeClassesByAttributeType?attrType=reference
```

The direct runtime page renders only the final result tables, without Designer chrome or diagnostic parameters.
Use the same URL as a normal link or as an iframe source. Dynamic templates require a valid CMDBuild session cookie through the proxy. Published static snapshots can be served without that cookie because the runtime reads only Redis snapshot data and does not execute CMDBuild business-data requests.
Add the reserved system parameter `json=true` to the same runtime URL to receive the final tables as `application/json` instead of HTML:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/ProbeClassesByAttributeType?attrType=reference&json=true
```

`json` is not a template input variable and cannot be declared in `spec.params`. Permissions, cache keys, static snapshots, and refresh cooldown behavior stay the same as for the HTML runtime view.
If the requested template has no matching data under the current user's CMDBuild permissions, JSON runtime returns HTTP `200`, `success: true`, empty `tables[].rows`, and the configured `emptyText`. If a class or attribute that is actually used by the template fails with CMDBuild `401/403`, JSON runtime returns HTTP `403`, `success: false`, `permissionDenied: true`, and the configured `permissionDeniedText`; it does not return a partial result from the other selections. Current behavior depends on CMDBuild exposing the denial as `401/403`: if CMDBuild masks a missing permission as `404`, the response may be a generic execution error, and superclass selections with only a subset of readable descendants may be returned as the readable subset.
Runtime template execution uses a Redis-backed cache with in-memory fallback when Redis is unavailable in dev. Cache behavior is controlled by each template in `spec.cache`; the default mode is `permissionOnly`, which shares a result inside the same endpoint/template/params after the viewer passes a lightweight probe for the classes and attributes actually used by the template. This default assumes row-level CMDBuild scope is not different between users. Use `visibilityHash` when row-level scope can differ, or `privateUser` when the cache must stay isolated by CMDBuild user/session scope. The executor builds a used-field dependency map and avoids materializing unrelated card attributes in `selectCards`.
Cache TTL is a template setting. Manual refresh cooldown is a system Runtime setting stored in `Cst_QueryToolConfig.RuntimeConfigJson.runtimeCache.refreshCooldownSec`. The runtime page keeps cache controls compact: the table header shows the title on the left and search plus a `⟳` refresh icon on the right; the icon tooltip contains cache age/expiry, refresh countdown, backend, and scope details.
Designer preview is separate from the saved runtime cache: `Visualize in editor` runs `/draft/preview` against the current draft and does not read the final runtime result cache. The Run page also has `Refresh cache and show`, which calls saved-template `POST run` with `forceRefresh=true`; this rebuilds the runtime cache without the user refresh cooldown and requires CSRF, so iframe/read-only `GET run` cannot bypass the timer.
For cross-origin iframe experiments, the dev reverse proxy can rewrite CMDBuild `Set-Cookie` headers with `CMDBDYNAMIC_PROXY_COOKIE_SAMESITE=None` and `CMDBDYNAMIC_PROXY_COOKIE_SECURE=true`. The recommended local iframe setup is the nginx same-origin proxy below, so this rewrite is normally not needed.

### BAA verification exchange

The `cmdbaa` integration uses the same saved template runtime through a dedicated endpoint:

```text
POST /cmdbuild/custom-api/templates/<templateCode>/baa-verify
```

Authorization is the same as other state-changing project API routes: the caller must use the same reverse-proxy origin, send the current CMDBuild session cookie, pass same-origin `Origin`/`Referer` checks, and include `X-CMDBDynamicPages-CSRF`. The backend still reads CMDBuild business data with the current user's session. If the user has rights, data is returned; if a required class or attribute is denied, the response is a permission-denied BAA envelope.

The request body provides `contractParams`, `variables`, `variableSources`, `endpoint.params`, and `plan.objects`. `contractParams` describes contract-version parameters (`contractparam.*`), while runtime values are sent in `endpoint.params`. `variables` contains computed BAA request variables; values can be scalars or arrays and are available in rules as `${var.name}` and `${param.name}`. `variableSources` is diagnostic and is included in the runtime cache key. `plan.objects` are exposed to the DSL through:

```json
{
  "type": "baaPlanObjects",
  "as": "baaObjects",
  "payloadPrefix": "Payload."
}
```

The Designer `BAA endpoint` section describes the input contract before real POST calls arrive: code/version, expected candidate classes, payload fields, and contract params. This lets the editor select BAA candidate fields while building matching rules. The step materializes BAA plan objects as a table with `PlanIndex`, `Kind`, `ClassName`, `PageShapeKey`, `MappingKey`, `RelationBindingStatus`, `Payload.<field>`, and `BAA.<alias>.<field>` columns. Existing selection, matching, final data, and visualization steps can then process that table. The endpoint adapts runtime result tables to the BAA envelope shape: `success`, `status`, `summary`, `tables`, `items`, and `data`.

Saved BAA contracts are read from the existing CMDBuild BAA technical branch. The path to `BAA technical superclass` from the project root and class names are edited in General settings and stored in `Cst_QueryToolConfig.RuntimeConfigJson.baaTechnical`:

```text
BAAConversionContract
BAAConversionContractVersion
BAAVerificationInputContract
BAAVerificationOutputContract
BAAVerificationEndpoint
```

Designer uses `BAAVerificationInputContract` as the saved input-contract catalog for the `BAA endpoint` section. `SchemaJson.classes[]` is mapped to “Incoming BAA objects”: `classes[].name` becomes `className`, and `classes[].attributes[]` become available `payload` fields for matching.

Caching follows the template cache policy. Because BAA request bodies are small, no separate cache policy is introduced: the normalized BAA request body is added to the runtime cache key, while TTL and sharing mode come from `spec.cache`.

Redis dev helper:

```bash
docker compose -f docker-compose.nginx.yml up -d redis
```

The dev Redis container uses RDB snapshots (`--save 60 1`) and volume `cmdbdynamicpages-redis-data`. RDB is a pragmatic published-cache store, not strict durable storage: if a static snapshot is absent after a Redis loss, the runtime page shows `Страница отсутствует для загрузки` until an administrator/editor publishes it again.

Production Redis must require a password. Do not store that password in git. Configure the backend with a secret supplied by the deployment platform:

```text
CMDBDYNAMIC_REDIS_URL=redis://127.0.0.1:6379/0
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
```

`CMDBDYNAMIC_REDIS_PASSWORD` and URL form `redis://:password@host:6379/0` are also supported for non-production/dev use, but the file-based secret is preferred. Health/status responses mask Redis credentials before returning the URL.

### Local same-origin nginx for wiki iframes

The wiki can stay on `http://localhost:3000/`, CMDBuild/DynamicPages can stay on `http://127.0.0.1:8093/`, and nginx provides one browser-facing origin:

```bash
npm run nginx:dev
```

Open the wiki through nginx:

```text
http://localhost:8088/
```

Log in to CMDBuild through the same nginx origin:

```text
http://localhost:8088/cmdbuild/ui/
```

Use a relative iframe URL in wiki content:

```html
<iframe src="/cmdbuild/dynamicpages/ui/run/testtemplate?city=city49&routername=router047"></iframe>
```

The old wiki URL `http://localhost:3000/` still works as a direct wiki entry point, but iframe authentication is only reliable when the wiki page and `/cmdbuild/...` runtime are opened through the same browser-facing origin. A relative `/cmdbuild/...` iframe on the old `3000` URL resolves to `http://localhost:3000/cmdbuild/...` and will not hit nginx.

Runtime route example, through the custom page launcher:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpTemplate=ProbeClassesByAttributeType&attrType=reference#custompages/CmdbDynamicPages
```

Domain traversal sample:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/ProbeReferenceDomainTraversal?attrType=reference&className=ARM&depth=2
```

Attribute comparison sample:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/ProbeAttributeComparison?attrType=reference&referenceClass=ARM
```

Join/intersection sample:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/ProbeClassSetOperations?leftType=reference&rightType=string
```

The proxy forwards ordinary `/cmdbuild/...` requests to CMDBuild on `8090`.
It handles backend routes under:

```text
/cmdbuild/dynamicpages/ui/designer
/cmdbuild/dynamicpages/ui/designer/<section>
/cmdbuild/dynamicpages/ui/run/<templateCode>
/cmdbuild/custom-api/session
/cmdbuild/custom-api/model/catalog
/cmdbuild/custom-api/model/classes
/cmdbuild/custom-api/model/classes/<className>
/cmdbuild/custom-api/model/classes/<className>/attributes
/cmdbuild/custom-api/model/domains
/cmdbuild/custom-api/model/domains/<domainName>
/cmdbuild/custom-api/auth/capabilities
/cmdbuild/custom-api/auth/permission-scope
/cmdbuild/custom-api/csrf
/cmdbuild/custom-api/schema
/cmdbuild/custom-api/schema/bootstrap
/cmdbuild/custom-api/config
/cmdbuild/custom-api/templates
/cmdbuild/custom-api/templates/<code>
DELETE /cmdbuild/custom-api/templates/<code>
/cmdbuild/custom-api/templates/<code>/versions
/cmdbuild/custom-api/templates/<code>/validate
/cmdbuild/custom-api/templates/<code>/preview
/cmdbuild/custom-api/templates/<code>/run
/cmdbuild/custom-api/draft/validate
/cmdbuild/custom-api/draft/preview
/cmdbuild/custom-api/client-log
/cmdbuild/custom-api/proxy-log
/cmdbuild/custom-api/cache/status
/cmdbuild/custom-api/health/live
/cmdbuild/custom-api/health/ready
/cmdbuild/custom-api/health/redis
```

Because these UI and backend routes are also under `/cmdbuild`, the browser sends the CMDBuild `HttpOnly` cookie automatically.

The legacy PoC routes `/cmdbuild/custom-api/session-probe` and `/cmdbuild/custom-api/classes-probe` are still available for compatibility, but new work should use the stable routes above.

State-changing custom API routes require a same-origin `Origin` or `Referer` header and `X-CMDBDynamicPages-CSRF`. The backend-served UI obtains the token from `/cmdbuild/custom-api/csrf` and attaches it automatically. Schema bootstrap also requires the current CMDBuild role to have `admin_classes_modify`.

`GET /cmdbuild/custom-api/auth/permission-scope` probes what permission-scope metadata is visible to the current CMDBuild session. It returns session role data, endpoint statuses for roles/users/groups/classes/domains, sampled readable classes/attributes, and a visible-model hash. That hash is diagnostic only; runtime result sharing is controlled explicitly by each template's `spec.cache.scopeMode`.

Runtime iframe pages call `GET /cmdbuild/custom-api/templates/<code>/run?param=value`. This endpoint still requires the CMDBuild session cookie for dynamic templates, but it is read-only from CMDBuild's perspective and does not require `X-CMDBDynamicPages-CSRF`. `POST /cmdbuild/custom-api/templates/<code>/run` remains available for API/Designer checks and keeps CSRF protection. Both GET and POST runtime executions use standard backend logging only.

Production health/readiness endpoints are unauthenticated and are also available at root aliases `/health/live`, `/health/ready`, and `/health/redis`.

- `GET /health/live` returns `200` when the Node process can answer HTTP.
- `GET /health/redis` performs a strict Redis `PING` and returns `503` when Redis is disabled or unavailable.
- `GET /health/ready` checks process, Redis, and the CMDBuild upstream. It returns `503` if Redis is required and unavailable, or if CMDBuild is not reachable.
- `GET /cmdbuild/custom-api/cache/status` remains a diagnostic endpoint: it reports Redis visibility and memory fallback counters, but it intentionally returns `200` even when the app has fallen back to memory.
- `GET /cmdbuild/custom-api/logging/status` returns the active log level, target and redaction settings without secrets.

Readiness configuration:

```text
CMDBDYNAMIC_HEALTH_TIMEOUT_MS=2000
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
```

`CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=false` can be used for local/dev operation without Redis. Production should keep Redis required when runtime cache and static snapshots are part of the service contract.

## Logging

The backend writes structured operational logs. Docker deployments should keep the default `stdout` target and let Docker, Filebeat, Fluent Bit or Logstash forward the stream to ELK. The application does not write directly to Elasticsearch.

```text
CMDP_LOG_LEVEL=info
CMDP_LOG_FORMAT=json
CMDP_LOG_TARGET=stdout
CMDP_LOG_REDACT_HEADERS=cookie,authorization,cmdbuild-authorization,x-csrf-token,x-cmdbdynamicpages-csrf,set-cookie
CMDP_LOG_REDACT_QUERY=password,passwd,pwd,token,secret,authorization,auth,csrf,x-cmdbdynamicpages-csrf
```

Syslog output is optional for VM/bare-metal deployments or SIEM integration:

```text
CMDP_LOG_TARGET=syslog
CMDP_SYSLOG_HOST=127.0.0.1
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp
CMDP_SYSLOG_FACILITY=local0
```

`CMDP_LOG_TARGET=stdout,syslog` can be used when both outputs are required. Logged events include request completion, CSRF/same-origin rejection, Redis availability changes, CMDBuild upstream errors, runtime cache status, static snapshot publish/hit/miss, and template create/update/delete. Cookies, authorization headers, CSRF tokens and configured secret-like query parameters are redacted; runtime result rows and CMDBuild card payloads are not logged.

Important: URL routes after `#` are client-side only. CMDBuild may also normalize extra path segments after the custom page name. The preferred entry points are the direct `/cmdbuild/dynamicpages/ui/*` URLs. Use `cmdpMode` and `cmdpTemplate` query parameters before `#` only when entering through the CMDBuild custom page launcher.

Run/preview endpoints support bounded execution query parameters:

```text
maxRows
maxClasses
maxDomains
maxRestCalls
maxTraversalDepth
```

Each CMDBuild REST request also uses `CMDBUILD_REQUEST_TIMEOUT_MS`, default `10000`.

Runtime executor defaults/caps are stored in `Cst_QueryToolConfig.RuntimeConfigJson`. Designer edits them as individual described fields in `Runtime-настройки`; the raw JSON is not shown in the UI. The stored shape is:

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

## Template And View Workflow

A template is a CMDBuild card in `Cst_QueryTemplate`.

Important fields:

```text
Code              stable template identifier used in runtime URLs
Description       human-readable description
SpecJson          executable DSL document
ParamsSchemaJson  optional metadata for template parameters
ResultSchemaJson  optional metadata for result rendering
```

`SpecJson` has three main parts:

```json
{
  "params": {
    "attrType": { "type": "string", "required": true }
  },
  "steps": [
    { "type": "findClassesByAttributeType", "attributeTypeParam": "attrType", "as": "classes" }
  ],
  "result": {
    "tables": [
      { "name": "classes", "columns": ["Class", "Description", "Attribute", "AttributeType"] }
    ]
  }
}
```

The first constructor block is `Input variables`. It declares the variables expected at template input and writes them into `spec.params`. Each row defines:

```text
name
type
required
default
example
description
```

The test screen renders its input form from this declared list. If a value is not entered, `default` is used. `Fill examples` copies example values into that test input list, falling back to `default` when no example is set.
Every non-required input variable must define `default`; validation rejects optional variables without it.

Designer also has an extraction block for internal variables. It generates an `extractVariables` step:

```json
{
  "type": "extractVariables",
  "sourceParam": "namePattern",
  "regex": "srv-(?<site>[a-z]+)-(?<num>\\d+)",
  "flags": "i",
  "all": true,
  "as": "extracted"
}
```

Named regexp groups become result columns. The step returns a table-like result, so it can be rendered through `result.tables` or used by later table operations.

Designer also has a data-selection block. It generates a bounded `selectCards` step that reads CMDBuild cards as the current user:

```json
{
  "type": "selectCards",
  "from": "extracted",
  "classNameParam": "className",
  "filters": [
    { "attribute": "Code", "op": "equals", "valueColumn": "code" }
  ],
  "limit": 50,
  "as": "cards"
}
```

`from` is optional. When it points to a previous table, for example `extracted`, the step runs filters for every source row. Filter values can come from fixed `value`, input `valueParam`, or source-row `valueColumn`. The executor fetches cards through CMDBuild REST with the current user's permissions and applies the template filters inside the bounded backend executor.

The visualization block edits `SpecJson.result.tables`. It controls what runtime pages render:

```json
{
  "result": {
    "tables": [
      {
        "name": "view",
        "title": "Inventory view",
        "mode": "table",
        "columns": ["Code", "Name", "Site", "RuntimeClass"],
        "emptyText": "В результате вашего запроса объекты не найдены"
      }
    ],
    "permissionDeniedText": "Вам не хватает прав увидеть данные или интерфейс дизайнера"
  }
}
```

Supported modes are `table`, `compact`, and `keyValue`. Visualization does not grant extra access; it only formats result aliases already produced by the DSL executor.
The default empty-result text is `В результате вашего запроса объекты не найдены`. The default permission text is `Вам не хватает прав увидеть данные или интерфейс дизайнера`; the backend returns it when the current user cannot read the technical classes needed to load templates/settings, or when template execution hits a CMDBuild 401/403.
For multi-selection templates, a `401/403` on any used selection class/attribute makes the whole runtime result a permission error. The runtime does not synthesize a partial table from the selections that did succeed, because that would change the meaning of the template.
Table titles can be runtime templates such as `Маршрутизаторы города ${param.city}`. The value comes from the template input parameters, and visualization settings also control title alignment.
Visualization can also group rows by one or more visible columns from Final data. Adjacent rows with the same selected group values are rendered with merged cells, while the remaining columns stay attached as detail rows.
When a table is split into subtables, the subtable title defaults to the selected split-column token, for example `${Выборка2.city}`. Static text can be added around that token.
Runtime sorting and text filtering are client-side only: they work on the rows already returned to the browser and do not call the backend again. The runtime text filter is enabled by default and can be disabled in Visualization. When row grouping is enabled, sorting and filters are disabled for that table because merged cells require the original row order; when subtables are enabled, sorting is applied inside each subtable.
Column selectors in Visualization use only the columns actually present in Final data and show selection-aware labels such as `Выборка1.Code` when result data contains repeated attribute names from different selections.

Templates can also define publication mode:

```json
{
  "publish": {
    "mode": "dynamicUser",
    "paramsMode": "exact",
    "warningAccepted": false
  }
}
```

`dynamicUser` is the normal mode: execution runs under the current viewer permissions. `staticSnapshot` is an explicit publication mode: an editor accepts the warning, publishes a Redis snapshot, and runtime serves that stored result without checking viewer permissions on the original CMDBuild objects. Snapshot lookup uses the exact parameter set by default; `paramsMode: "ignore"` publishes one snapshot for all runtime parameters.

Templates can also define runtime-cache behavior:

```json
{
  "cache": {
    "enabled": true,
    "scopeMode": "permissionOnly",
    "probeMode": "usedFieldsOnly",
    "shareMode": "endpoint",
    "ttlSeconds": 28800,
    "allowManualRefresh": true
  }
}
```

`ttlSeconds` defines how long this template result is kept in cache; the Designer edits it in hours and defaults new templates to 8 hours. Refresh cooldown is not stored in the template; it is the system setting `runtimeCache.refreshCooldownSec`. `permissionOnly` is the default endpoint-shared mode. It probes only the CMDBuild classes and attributes that the template actually uses in filters, matching, final data, and visualization. `visibilityHash` additionally hashes visible card ids before sharing a cached result. `privateUser` keeps the cache per CMDBuild user/session. `disabled` turns result caching off for the template.

Designer uses a two-level navigation menu for templates, visual design, checks, settings, and help. The top of each Designer route has a sticky contextual action bar: page-level buttons such as apply, save, run, publish, diagnostics, and settings actions stay at the top instead of at the bottom of long forms. It does not show the CMDBuild session block, technical-schema bootstrap block, inline guide, or class-name probe on the main screen. If runtime URL parameters do not provide `className`, advanced JSON users can still store a fallback value in:

```json
{
  "defaults": {
    "className": "Computer"
  }
}
```

Runtime views are formed from saved templates by URL:

```text
/cmdbuild/dynamicpages/ui/run/<TemplateCode>?param=value
```

The backend loads the template, validates parameters, executes `steps` through CMDBuild REST as the current user, then renders every entry from `result.tables` as a table. The technical root only stores project classes and does not restrict business data reads.
Designer shows the generated absolute runtime URL next to the run buttons so it can be copied into a link or iframe.

## Limited User Grants

For runtime access, the CMDBuild role needs read grants on the custom page and on the technical classes that store templates.

The local `Helpdesk` role was configured with read grants on:

```text
CmdbDynamicPages custom page id 1662627
Cst_QueryTool
Cst_QueryToolConfig
Cst_QueryTemplate
Cst_QueryTemplateVersion
```

With these grants, `mdavis` can read and run templates but cannot create templates through the backend.

## Runtime Logging

Runtime executions are not stored in CMDBuild technical classes. Preview, direct `POST run`, iframe `GET run`, cache hits/misses, permission failures, and execution failures are emitted through the standard backend logging paths (`stdout`, syslog, or the configured platform collector).

Designer can also validate and preview the current unsaved draft through `/cmdbuild/custom-api/draft/validate` and `/cmdbuild/custom-api/draft/preview`. Draft preview executes with the current user's CMDBuild permissions and shows an execution trace, but does not save templates or create versions.

Template `create` and `update` write best-effort version snapshots into `Cst_QueryTemplateVersion`, and Designer shows the latest versions for the selected template.

## CMDBuild Upload Constraints

CMDBuild 4.1 validates uploaded JS with strict markers:

- the main class must look like `CMDBuildUI.view.custompages.<Name>.<Class>`;
- `alias` must be written without whitespace before the string, for example `alias:'widget.cmdb-dynamic-pages'`;
- the page must include `mixins:['CMDBuildUI.mixins.CustomPage']`.

## Documentation

- [Architecture and implementation plan](docs/architecture-plan.md)
- [Roadmap and current task state](docs/roadmap.md)
- [Russian README](README.ru.md)
- [Russian architecture plan](docs/architecture-plan.ru.md)
- [Russian roadmap](docs/roadmap.ru.md)
- [Architecture artifacts](aa/README.md)
