# cmdbdynamicpages

`cmdbdynamicpages` is a CMDBuild custom page and backend integration project for dynamic, parameterized data pages.

The project has two target scenarios:

- a designer UI for preparing and storing query templates as JSON in CMDBuild technical classes;
- a runtime UI that opens a template from the CMDBuild custom page URL and renders the result as tables, using the current user's CMDBuild permissions.

## Current PoC

The current proof of concept verifies the core session architecture:

- the custom page runs inside CMDBuild UI;
- browser JavaScript uses `fetch(..., { credentials: 'include' })`;
- JavaScript does not read or send `CMDBuild-Authorization`;
- the backend receives the CMDBuild `HttpOnly` cookie on same-origin routes;
- the backend forwards the cookie value to CMDBuild REST as a server-side `CMDBuild-Authorization` header.

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

Open CMDBuild through the proxy:

```text
http://127.0.0.1:8093/cmdbuild/ui/#custompages/CmdbDynamicPages
```

Designer route:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages
```

Designer includes JSON editing plus a simple visual builder that generates specs for classes by attribute, domain traversal, attribute comparison, and set operations.

Runtime route example:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpTemplate=ProbeClassesByAttributeType&attrType=reference#custompages/CmdbDynamicPages
```

Domain traversal sample:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpTemplate=ProbeReferenceDomainTraversal&attrType=reference&className=ARM&depth=2#custompages/CmdbDynamicPages
```

Attribute comparison sample:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpTemplate=ProbeAttributeComparison&attrType=reference&referenceClass=ARM#custompages/CmdbDynamicPages
```

Join/intersection sample:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpTemplate=ProbeClassSetOperations&leftType=reference&rightType=string#custompages/CmdbDynamicPages
```

The proxy forwards ordinary `/cmdbuild/...` requests to CMDBuild on `8090`.
It handles backend routes under:

```text
/cmdbuild/custom-api/session
/cmdbuild/custom-api/model/classes
/cmdbuild/custom-api/model/classes/<className>/attributes
/cmdbuild/custom-api/model/domains
/cmdbuild/custom-api/model/domains/<domainName>
/cmdbuild/custom-api/auth/capabilities
/cmdbuild/custom-api/csrf
/cmdbuild/custom-api/schema
/cmdbuild/custom-api/schema/bootstrap
/cmdbuild/custom-api/config
/cmdbuild/custom-api/execution-logs
/cmdbuild/custom-api/templates
/cmdbuild/custom-api/templates/<code>
/cmdbuild/custom-api/templates/<code>/versions
/cmdbuild/custom-api/templates/<code>/validate
/cmdbuild/custom-api/templates/<code>/preview
/cmdbuild/custom-api/templates/<code>/run
```

Because these backend routes are also under `/cmdbuild`, the browser sends the CMDBuild `HttpOnly` cookie automatically.

The legacy PoC routes `/cmdbuild/custom-api/session-probe` and `/cmdbuild/custom-api/classes-probe` are still available for compatibility, but new work should use the stable routes above.

State-changing custom API routes require a same-origin `Origin` or `Referer` header and `X-CMDBDynamicPages-CSRF`. The custom page obtains the token from `/cmdbuild/custom-api/csrf` and attaches it automatically. Schema bootstrap also requires the current CMDBuild role to have `admin_classes_modify`.

Important: URL routes after `#` are client-side only. CMDBuild may also normalize extra path segments after the custom page name. Use `cmdpMode` and `cmdpTemplate` query parameters before `#` for direct links.

Run/preview endpoints support bounded execution query parameters:

```text
maxRows
maxClasses
maxDomains
maxRestCalls
maxTraversalDepth
```

Each CMDBuild REST request also uses `CMDBUILD_REQUEST_TIMEOUT_MS`, default `10000`.

Runtime executor defaults/caps are stored in `Cst_QueryToolConfig.RuntimeConfigJson` and can be edited from Designer. The local config currently sets:

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

The same role has write grant on `Cst_QueryExecutionLog` so runtime audit cards can be created as the current user. With these grants, `mdavis` can read and run templates but cannot create templates through the backend.

## Execution Audit

`preview` and `run` write best-effort audit cards into `Cst_QueryExecutionLog`.

Template `create` and `update` write best-effort version snapshots into `Cst_QueryTemplateVersion`, and Designer shows the latest versions for the selected template.

Stored fields:

```text
TemplateCode
StartedAt
FinishedAt
Username
ExecutionStatus
RowsCount
ErrorMessage
```

Template parameters and CMDBuild cookie/token values are not stored in audit cards.

## CMDBuild Upload Constraints

CMDBuild 4.1 validates uploaded JS with strict markers:

- the main class must look like `CMDBuildUI.view.custompages.<Name>.<Class>`;
- `alias` must be written without whitespace before the string, for example `alias:'widget.cmdb-dynamic-pages'`;
- the page must include `mixins:['CMDBuildUI.mixins.CustomPage']`.

## Documentation

- [Architecture and implementation plan](docs/architecture-plan.md)
- [Roadmap and current task state](docs/roadmap.md)
