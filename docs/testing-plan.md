# Testing Plan

English branch. Russian branch: [testing-plan.ru.md](testing-plan.ru.md).

## Implemented

- `npm run check`: syntax check for custom page, proxy, diagnostics, e2e, and validation scripts.
- `npm run test:static`: validates required OpenAPI paths, local component references, and architecture artifact links.
- `npm run test:unit`: covers cache configuration, cache key scope, refresh metadata, snapshot URL params, parameter defaults, IPv4 matching, dependency map, and logging redaction.
- `npm run test:api`: skip-safe API contract smoke for `/health/*`, protected logging status, and CSRF/session rejection against a running proxy.
- `npm run test:ui`: skip-safe Playwright smoke for Designer template list, fixed menu/action bar, contextual Run buttons, and compact Runtime shell.
- `npm run test:nginx`: validates nginx config and checks same-origin wiki/dynamicpages routes through `localhost:8088`.
- `npm run e2e`: extended to check logging diagnostics, draft preview without runtime cache, runtime cache hit, POST `forceRefresh`, and GET runtime not forcing refresh.

## Remaining

- Add deeper Playwright Runtime table tests for client-side search/sort and disabled search/sort when row grouping is active.
- Add browser-level iframe rendering assertion through a real wiki page when a stable test page is available in the local wiki.
- Run live e2e with a fresh CMDBuild session or explicit `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD` when validating against a restarted environment.
