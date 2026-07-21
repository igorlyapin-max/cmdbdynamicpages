# Historical Integration Guide: MediaWiki and CMDB Dynamic Pages

**Context:** This document defines the supported MediaWiki boundary for CMDBuild dynamic pages. It is not a runtime, proxy, or port ownership contract for `cmdbcustompages`; deploy external services independently.

**Status:** The supported authenticated flow is a browser CMDBuild session on same-origin project routes. This guide intentionally does not define a MediaWiki credential-forwarding protocol.

## Supported Browser Session

`CMDP_PUBLIC_ORIGIN` is the single public browser origin for the CMDBuild UI and project routes below `/cmdbuild/*`. The internal `CMDBUILD_ORIGIN` is backend-only and must not appear in browser URLs, redirects, or cookie domains.

The supported sequence is:

1. The user signs in to CMDBuild through `CMDP_PUBLIC_ORIGIN`.
2. The browser sends the existing HttpOnly `CMDBuild-Authorization` session cookie on matching same-origin `/cmdbuild/*` requests.
3. `cmdbdynamicpages` validates that existing session and uses it only for its server-side CMDBuild REST requests.
4. The browser opens `/cmdbuild/dynamicpages/ui/designer` or `/cmdbuild/dynamicpages/ui/run/<templateCode>`.

JavaScript and MediaWiki PHP do not read, create, copy, or relay the CMDBuild session cookie. `cmdbdynamicpages` does not accept MediaWiki identity headers, group claims, or MediaWiki-created user credentials.

## MediaWiki Role

MediaWiki may render a regular browser link to a supported public route under `CMDP_PUBLIC_ORIGIN`. The user then reaches CMDBuild and CMDB Dynamic Pages directly in the browser, where the established CMDBuild session applies.

MediaWiki must not issue server-side backend requests as a user. Do not add user or group identity headers, forward cookies, or pass authorization credentials from a MediaWiki request to `cmdbdynamicpages`.

The external TLS reverse proxy must preserve the public `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto=https` values for the CMDBuild UI and `cmdbdynamicpages` routes. A MediaWiki-specific proxy path is not a substitute for the supported browser session path.

## Unsupported Flows

The repository does not provide a protocol for MediaWiki to impersonate a CMDBuild user, exchange a MediaWiki session for a CMDBuild session, or forward user credentials to the backend. A cross-system identity design requires a separately implemented and reviewed contract; it must not be inferred from this guide.

Server-rendered HTML fetches, MediaWiki API relays, and custom token pass-through are therefore outside the supported `cmdbcustompages` integration surface.

## Operator Check

1. Configure one `CMDP_PUBLIC_ORIGIN` for the CMDBuild UI and the project-owned `/cmdbuild/*` routes.
2. Sign in to CMDBuild through that public origin.
3. Open a Designer or Runtime route in the browser and confirm the existing CMDBuild session is accepted.
4. If the session is absent or invalid, direct the user to CMDBuild sign-in. Do not add a MediaWiki server-side relay.
