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

In production, `CMDP_PUBLIC_ORIGIN` is the single public browser origin while `CMDBUILD_ORIGIN` remains an internal backend upstream. They may differ behind a TLS-terminated reverse proxy, but the internal URL must not appear in browser traffic.

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

Run project nginx route checks after starting nginx:

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

The first visual mode is `Object group`: configure one or more selections. The first selection is shown as `Выборка 1` / `Selection 1` and keeps the legacy `objects` alias; additional selections use `objects2`, `objects3`, and so on. Each selection starts from a CMDBuild class plus include/exclude scope rules. A rule selects an attribute/path, including reference/domain/lookup paths expanded from the cached catalog up to the configured depth, an explicit negation flag, an operator, and an optional parameter. Operators cover existence, regex match, equality, string contains/starts/ends, IPv4 value checks, and IPv4 CIDR/range comparisons. Regex and parameter fields can reference input variables as `${param.name}`. Applying it generates executable `selectCards` DSL plus `spec.visualModel`.

Object group path pickers can be filtered by domain, cardinality, and relation direction. Use this when the same attribute name is reachable through several references/domains and the template must keep paths from a specific relationship type. A collapsed help block in the section shows examples.

The second visual mode is `Object matching`: compare object selections with one or more `matchRows` blocks. Each rule is edited as left object, operator, and right object. The operator has an explicit negation selector, so `!` + `equals` replaces the older standalone `notEquals` form. IPv4 operators cover IP in CIDR, IP in range, CIDR overlap, and CIDR contains; the UI shows examples with expected true/false results.

DSL step `expandRelations` expands selected cards through CMDBuild card relations with the current user's session. It reads only allowlisted CMDBuild paths for relations and related cards, supports domain/target-class/direction filters, and returns table rows with source card, relation, and related-card columns.

The visible Designer does not expose standalone relation-chain, search-by-values, group-comparison, or composition constructors. Existing saved templates that already use the underlying DSL steps still run through the backend executor, but new templates are prepared through Object group, Object matching, Final data, Visualization, and Run sections. The Extraction section can display a chosen result table: a specific selection or the final Object matching result when a matching step exists; after object matching is configured, the final matching result is selected by default.

The `Final view` block is the focused runtime layout composer. It chooses the visible result alias, table title, display mode, empty-state text, visible columns, and column labels, then writes ordinary `result.tables` metadata. It can replace the runtime output with one final table while keeping the full DSL steps available for preview/debug.

Visualization can render a final-data column as a link. URL and text templates support `${mysource.value}`, `${mysource.source}`, `${mysource.sourceClass}`, `${mysource.sourceId}`, `${mysource.attribute}`, `${mysource.domainPath}`, `${row.<column>}`, and `${param.<name>}`. Internal links to cards that participated in the result can use ready-made variables such as `${mysource.sourceURLВыборка1}`, `${mysource.sourceURLВыборка2}`, `${mysource.sourceURLSelection1}`, and so on. Examples: `${mysource.sourceURLВыборка2}`, `/cmdbuild/ui/#classes/${mysource.sourceClass}/cards/${mysource.sourceId}` or `https://portal.example.local/${param.city}/${mysource.value}`. Unsafe `javascript:`, `data:`, and `vbscript:` URLs are blocked and fall back to plain text.

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
Saving a `dynamicUser` template does not publish data: its launch URL remains an authenticated runtime request. Snapshot publication is available only after `staticSnapshot` has been selected and saved.
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

### Diagrams and assistant

Runtime results can include deterministic static diagrams in `result.diagrams`. The first supported diagram type is `topology`: it reads node and edge rows from existing DSL result aliases and renders the same payload as SVG in HTML runtime and as `diagrams[]` in JSON runtime. Diagram execution uses the same CMDBuild user permissions, runtime cache, static snapshot, and JSON/HTML behavior as table results.

Designer has a `Visualization` output switch: `Tables`, `Diagrams`, or `Both`. The table editor stays unchanged for table-only templates; the diagram editor appears only for diagram-capable output and stores its config in `result.diagrams[]`.

The D2 importer contract uses class-aware IR v3. Every used D2 `class` is one reusable visual role; exemplar object paths are not separate mappings or authoring controls. A selected Object Flow result determines the primary CMDBuild class; the author configures the composite label, optional structured data, and catalog-backed related classes. Additional fields are emitted in per-object structured data and affect the visible label only when referenced by `${...}`. Untyped D2 containers remain structural roles. Grouping, hierarchy, connections, and static placement are explicit role rules; backend-managed DSL aliases and template-element bindings are not exposed in this UI. Legacy D2 import proposals and mappings before IR v3 are unsupported, are not migrated automatically, and are not planned as compatibility modes.

The approved authoring split is explicit: `Assistant` owns D2 import, semantic interpretation, object-flow selection/match proposals, and selection-to-role proposals. `Diagram` owns the accepted deterministic settings in `result.diagrams[]`, including applied node, edge, group, and hierarchy mappings. Object-flow LLM calls receive a sanitized stage-only flow context and return one typed `selection` or `block`, never a complete runtime Spec. Assistant responses never mutate the editor draft before an explicit deterministic apply action. Every selection stage and every intermediate match stage is eligible as a Diagram mapping source.

For an exact non-negated `include equals` match, the deterministic object-flow compiler also drives the right `selectCards` from the left stage and adds a mandatory `valueColumn` filter before the class scan. Correlated right cards are materialized once by CMDBuild class/card id, so repeated left keys do not multiply the later `matchRows` cross-product. The explicit `matchRows` stage remains in the pipeline and remains available as a Diagram source. This prevents a class result limit from discarding the matching cards before the join is evaluated. While a reviewed D2 proposal is pending, Diagram shows its mapping controls only; general deterministic diagram settings become editable after Apply so proposal review cannot silently change the analyzed spec hash.

Typed authoring endpoints under `/cmdbuild/custom-api` are:

- `POST /assistant/object-flow/selection` - propose one selection stage;
- `POST /assistant/object-flow/match` - propose one intermediate match stage;
- `POST /draft/object-flow/apply` - deterministically validate and compile the reviewed object flow into a local draft;
- `POST /assistant/diagram-import/interpret` - propose semantics for imported D2 roles;
- `POST /assistant/diagram-import/map-selections` - propose mappings from selection or intermediate match stages to confirmed D2 roles;
- `POST /draft/diagram-import/apply` - deterministically compile reviewed D2 mapping into a local draft. The UI D2 Update action follows the same local contract.

Каноническое authoring-состояние сохраняется в `SpecJson.authoring`, а не в отдельном draft endpoint:

```json
{
  "authoring": {
    "version": 1,
    "assistant": {
      "objectFlowIntent": "...",
      "diagramInterpretPrompt": "...",
      "diagramMappingPrompt": "..."
    },
    "d2": { "source": "...", "sourceHash": "..." }
  }
}
```

`Применить цепочку`, D2 Apply и D2 Update возвращают только новый локальный draft `spec`: они не выполняют template `PUT`, не создают версию CMDBuild и не инвалидируют runtime cache/static snapshot. Единственная операция записи — глобальный `Сохранить`, выполняющий обычный template `POST`/`PUT`: он сохраняет одновременно executable Spec и `spec.authoring`, создаёт версию шаблона, а cache/static snapshot инвалидирует только при изменении executable-части Spec. Для локальных действий нужны читаемый шаблон и compare-and-swap `baseSpecHash`, но не update grant; обычный template `PUT` требует update grant.

Хранилище допускает незавершённый D2 source/mapping и другие authoring-поля. Runtime, draft preview, extraction и publication выполняют строгую execution-валидацию и блокируются до готового D2 source/mapping. Legacy `assistantDraft` мигрируется только при обычном `Сохранить`; `/templates/<code>/assistant-draft` удалён и возвращает `410`. Generic `POST /assistant/template-draft` и mixed `POST /assistant/diagram-import/complete` удалены из публичного контракта; legacy aliases не поддержаны и не запланированы.

Applied D2 mapping has a signed `mappingInputRevision`: canonical D2 `sourceHash`, hashes of both D2 prompts (`diagramInterpretPrompt` and `diagramMappingPrompt`), and the contract of only the Object Flow stages and fields referenced by that mapping. When all of those inputs and the signature match, the mapping remains usable after reload without Analyze, Interpret, Map, Apply, or an automatic LLM call. A change to the D2 source, either D2 prompt, or a referenced Object Flow stage contract preserves the mapping for inspection/editing but marks it `needsReview`; execution, preview, extraction, runtime, and publication fail closed until the author explicitly reviews and applies a replacement or corrects it in Diagram. Unrelated template changes and unreferenced Object Flow stages must not mark the mapping stale. Exact version-history recovery never restores a different mapping: it accepts the same source, prompts, referenced stage contract and mapping only. A historical `semanticModelRevision=8` / tree `3` valid marker from before a signing-secret rotation is only a migration attestation during normal Save; the backend re-parses, revalidates, recompiles and signs the current mapping before it becomes runtime-valid. It is not a runtime fallback or legacy compatibility. The full saved `specHash` remains the compare-and-swap guard for concurrent template updates.

Assistant authoring calls use the configured LiteLLM-compatible `/v1/chat/completions` endpoint and may include bounded read-only CMDBuild model context through `POST /cmdbuild/custom-api/mcp` tools controlled by `Cst_QueryToolConfig.RuntimeConfigJson.assistant.mcp`. `assistant.mcp.timeoutMs` bounds the complete MCP-context collection phase and each subsequent LiteLLM request; its effective range is 1000-60000 ms. A context deadline returns partial context with an explicit warning instead of silently starting more MCP reads. The browser waits an additional five seconds for each backend phase. The authoring-only `Cst_QueryToolConfig.RuntimeConfigJson.assistant.prompt.system` setting may add deployment-specific naming and relation semantics without hardcoding customer classes in the default contract. Runtime page rendering, runtime cache construction, static snapshot serving, and publication never call LLM or MCP. The assistant is disabled by default and is enabled by `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.enabled`; the LiteLLM API key is supplied only through env or a secret file. `CMDP_ASSISTANT_ENABLED` is kept as a deprecated no-op for older deployment templates. `CMDP_ASSISTANT_TIMEOUT_MS` is unsupported. This section defines the approved API contract and does not claim runtime implementation verification.

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

### Local project nginx front

CMDBuild/DynamicPages stays on `http://127.0.0.1:8093/`; nginx exposes only the browser-facing routes owned by this project:

```bash
npm run nginx:dev
```

Open CMDBuild through nginx:

```text
http://localhost:8088/cmdbuild/ui/
```

The root path `http://localhost:8088/` intentionally returns `404`. Wiki, WikiAI, and other portal services are outside this project's runtime and delivery contract. An external portal may embed the runtime by its own independently configured route; this repository neither starts nor proxies that portal.

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

State-changing custom API routes compare `Origin` or `Referer` with configured `CMDP_PUBLIC_ORIGIN` and require `X-CMDBDynamicPages-CSRF`. The backend-served UI obtains the token from `/cmdbuild/custom-api/csrf` and attaches it automatically. Schema bootstrap also requires the current CMDBuild role to have `admin_classes_modify`.

`GET /cmdbuild/custom-api/auth/permission-scope` probes what permission-scope metadata is visible to the current CMDBuild session. It returns session role data, endpoint statuses for roles/users/groups/classes/domains, sampled readable classes/attributes, and a visible-model hash. That hash is diagnostic only; runtime result sharing is controlled explicitly by each template's `spec.cache.scopeMode`.

Runtime iframe pages call `GET /cmdbuild/custom-api/templates/<code>/run?param=value`. This endpoint still requires the CMDBuild session cookie for dynamic templates, but it is read-only from CMDBuild's perspective and does not require `X-CMDBDynamicPages-CSRF`. `POST /cmdbuild/custom-api/templates/<code>/run` remains available for API/Designer checks and keeps CSRF protection. Both GET and POST runtime executions use standard backend logging only.
For diagram templates, the same runtime endpoint renders generated `.d2` source through the server-side D2 binary and stores the resulting SVG in runtime cache/static snapshots. `GET /cmdbuild/custom-api/templates/<code>/run?d2=true&diagram=<name>&param=value` downloads the generated D2 source as `text/vnd.d2` for an authenticated viewer. Public static snapshots expose raw `.d2` only when the saved template has `publish.publicD2Source=true`.

Production health/readiness endpoints are unauthenticated and are also available at root aliases `/health/live`, `/health/ready`, and `/health/redis`.

- `GET /health/live` returns `200` when the Node process can answer HTTP.
- `GET /health/redis` performs a strict Redis `PING` and returns `503` when Redis is disabled or unavailable.
- `GET /health/ready` checks process, Redis, the CMDBuild upstream, the D2 renderer, and the D2 template import parser. It returns `503` if Redis is required and unavailable, CMDBuild is not reachable, or a required D2 binary cannot run.
- `GET /metrics` returns Prometheus text exposition with aggregate operational counters and gauges only.
- `GET /cmdbuild/custom-api/cache/status` remains a diagnostic endpoint: it reports Redis visibility and memory fallback counters, but it intentionally returns `200` even when the app has fallen back to memory.
- `GET /cmdbuild/custom-api/logging/status` returns the active log level, target and redaction settings without secrets.

Readiness configuration:

```text
CMDBDYNAMIC_REDIS_REQUIRED=false
CMDBDYNAMIC_HEALTH_TIMEOUT_MS=2000
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
CMDP_D2_RENDER_ENABLED=true
CMDP_D2_BINARY=/usr/local/bin/d2
CMDP_D2_TIMEOUT_MS=3000
CMDP_D2_MAX_INPUT_BYTES=2097152
CMDP_D2_MAX_OUTPUT_BYTES=10485760
CMDP_D2_MAX_DIAGRAMS=8
CMDP_D2_CONCURRENCY=2
CMDP_D2_LAYOUT=dagre
CMDP_D2_LAYOUT_ALLOWLIST=dagre,elk
CMDP_D2_IMPORT_BINARY=/usr/local/bin/cmdp-d2-import
CMDP_D2_IMPORT_TIMEOUT_MS=5000
CMDP_D2_IMPORT_MAX_INPUT_BYTES=1048576
CMDP_D2_IMPORT_MAX_OUTPUT_BYTES=4194304
CMDP_D2_IMPORT_MAX_ELEMENTS=5000
CMDP_D2_IMPORT_PROPOSAL_TTL_MS=1800000
CMDP_D2_IMPORT_ASSISTANT_MAX_SPEC_BYTES=262144
CMDP_TEMPLATE_REQUEST_MAX_BYTES=5767168
```

`CMDP_D2_IMPORT_PROPOSAL_TTL_MS` bounds the analyze/review/apply window. Proposals are bound to the CMDBuild session and template version; expired or modified proposals must be analyzed again. `CMDP_D2_IMPORT_ASSISTANT_MAX_SPEC_BYTES` bounds the sanitized current spec sent to LiteLLM; retained raw D2 source, structural IR, template metadata, and composite `d2Template` are removed from that context. `CMDP_TEMPLATE_REQUEST_MAX_BYTES` is the shared request-body limit for draft preview and template create/update, and must be at least large enough for the configured D2 import source plus normalized IR.

`CMDBDYNAMIC_REDIS_REQUIRED=true` disables memory fallback for runtime cache and static snapshots: Redis read/write/delete failures fail the affected request with `503` instead of silently using process memory. It also makes readiness require Redis regardless of `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED`. `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=false` can still be used for local/dev operation without Redis when strict Redis mode is disabled. Production should keep Redis required when runtime cache and static snapshots are part of the service contract.

## Logging

The backend writes structured operational logs. Local development can use `stdout` only. The production Docker Compose contract is `stdout,syslog` with an approved syslog collector; the application does not write directly to Elasticsearch.

```text
CMDP_LOG_LEVEL=info
CMDP_LOG_FORMAT=json
CMDP_LOG_TARGET=stdout,syslog
CMDP_SYSLOG_HOST=syslog.example.local
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp
CMDP_SYSLOG_FACILITY=local0
CMDP_DIAGNOSTIC_MODE=off
CMDP_LOG_REDACT_HEADERS=cookie,authorization,cmdbuild-authorization,x-csrf-token,x-cmdbdynamicpages-csrf,set-cookie
CMDP_LOG_REDACT_QUERY=password,passwd,pwd,token,secret,authorization,auth,csrf,x-cmdbdynamicpages-csrf
```

For local development without a collector, use stdout only:

```text
CMDP_LOG_TARGET=stdout
```

`stdout` always remains enabled. Production must use `CMDP_LOG_TARGET=stdout,syslog` and replace the example collector with an approved syslog endpoint. Logged events include request completion, CSRF/same-origin rejection, Redis availability changes, CMDBuild upstream errors, runtime cache status, static snapshot publish/hit/miss, and template create/update/delete. Cookies, authorization headers, CSRF tokens and configured secret-like query parameters are redacted; runtime result rows and CMDBuild card payloads are not logged. `/metrics` exposes only aggregate counters/gauges and does not include cookies, tokens, user names, runtime rows or raw CMDBuild payloads.

Diagnostic mode is off by default and can be enabled without code changes:

```text
CMDP_DIAGNOSTIC_MODE=Basic
CMDP_DIAGNOSTIC_MODE=Verbose
```

`Basic` emits safe diagnostic events through the same structured logging pipeline. `Verbose` adds sanitized request and CMDBuild upstream diagnostics without request/response bodies, runtime rows, cookies, tokens, Redis password, or raw CMDBuild payloads. Use `Verbose` only temporarily during troubleshooting. `/cmdbuild/custom-api/logging/status` returns the active diagnostic mode and redaction policy without secret values.

Important: URL routes after `#` are client-side only. CMDBuild may also normalize extra path segments after the custom page name. The preferred entry points are the direct `/cmdbuild/dynamicpages/ui/*` URLs. Use `cmdpMode` and `cmdpTemplate` query parameters before `#` only when entering through the CMDBuild custom page launcher.

Run/preview endpoints support bounded execution query parameters:

```text
maxRows
maxClasses
maxDomains
maxRestCalls
maxTraversalDepth
```

Each CMDBuild REST request also uses `CMDBUILD_REQUEST_TIMEOUT_MS`, default `10000`. `CMDP_DRAFT_PREVIEW_TIMEOUT_MS` bounds the complete Designer draft-preview execution, including all selected deterministic stages; it defaults to `60000` ms and is clamped to `1000-300000` ms. When a diagram-only preview fails after one or more stages complete, the response contains a sanitized partial diagram preview and execution trace; the browser also keeps the analyzed source-template preview visible for correction.

Regex-based extraction and matching are bounded by:

```text
CMDBDYNAMIC_REGEX_MAX_PATTERN_LENGTH=500
CMDBDYNAMIC_REGEX_MAX_INPUT_LENGTH=100000
```

Patterns over the configured length, obviously nested quantified groups, and oversized input strings are rejected before execution.

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

`SpecJson` has three executable parts plus optional canonical authoring metadata in `authoring`:

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

`authoring` не исполняется runtime как DSL. Оно хранит промпты Assistant и D2 source, может быть неполным при обычном `Сохранить` и не заменяет строгую execution-валидацию перед preview, extraction, runtime или publication.

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
Diagram results are rendered from deterministic D2 source by the server-side D2 binary, which is enabled by default in the container. If D2 rendering is unavailable, the runtime page shows an explicit warning, falls back to the built-in SVG topology view, and still exposes the `.d2` source download when the current permission/publication policy allows it. Runtime JSON omits raw `.d2`, embedded structured metadata, and raw SVG content; use the dedicated `d2=true` download endpoint for source export.
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

Template `create` and `update` write best-effort version snapshots into `Cst_QueryTemplateVersion`, and Designer shows the latest versions for the selected template. Template list/detail responses include `specHash`; Designer sends it back as `expectedSpecHash` on update. If the stored template changed meanwhile, update returns `409 template_version_conflict` with the current hash/template. API clients that omit `expectedSpecHash` keep the previous last-write-wins behavior.

## CMDBuild Upload Constraints

CMDBuild 4.1 validates uploaded JS with strict markers:

- the main class must look like `CMDBuildUI.view.custompages.<Name>.<Class>`;
- `alias` must be written without whitespace before the string, for example `alias:'widget.cmdb-dynamic-pages'`;
- the page must include `mixins:['CMDBuildUI.mixins.CustomPage']`.

## Documentation

- [Project documentation map](PROJECT_DOCUMENTATION.md)
- [Architecture and implementation plan](docs/architecture-plan.md)
- [Roadmap and current task state](docs/roadmap.md)
- [Audit remediation 2026-05-31](docs/audit-remediation-2026-05-31.md)
- [Architecture decisions](docs/adr/0001-zero-runtime-dependencies.md)
- [Russian README](README.ru.md)
- [Russian architecture plan](docs/architecture-plan.ru.md)
- [Russian roadmap](docs/roadmap.ru.md)
- [Architecture artifacts](aa/README.md)
