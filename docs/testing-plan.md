# Testing Plan

English branch. Russian branch: [testing-plan.ru.md](testing-plan.ru.md).

## Implemented

- `npm run check`: syntax check for custom page, proxy, diagnostics, e2e, and validation scripts.
- `npm run secret:scan`: scans repository text files for high-confidence committed secrets, excluding generated/runtime directories.
- `npm run build:zip`: builds the CMDBuild custom page ZIP with the dependency-free Node builder.
- `npm run ci`: runs `secret:scan`, `npm test`, and `build:zip`.
- `npm run test:static`: validates required OpenAPI paths, local component references, and architecture artifact links.
- `npm run test:unit`: covers cache configuration, cache key scope, refresh metadata, snapshot URL params, parameter defaults, IPv4 matching, topology diagram payloads, runtime JSON output-mode filtering, assistant MCP allowlist/defaults, dependency map, logging redaction, diagnostic mode, assistant-disabled config, and runtime config validation.
- `npm run test:api`: skip-safe API contract smoke for `/health/*`, `/metrics`, protected logging status, and CSRF/session rejection against a running proxy.
- `npm run test:ui`: skip-safe Playwright smoke for Designer template list, fixed menu/action bar, contextual Run buttons, compact Runtime shell, runtime table search/sort, grouped-table control disabling, and split-subtable local sorting.
- `npm run test:nginx`: validates the project-only nginx config and `cmdbdynamicpages` routes through `localhost:8088`.
- `npm run e2e`: checks logging diagnostics, draft preview without runtime cache, runtime cache hit, POST `forceRefresh`, GET runtime not forcing refresh, and write-mode `expectedSpecHash` conflict handling.

## Remaining

- Run live e2e with a fresh CMDBuild session or explicit `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD` when validating against a restarted environment.
- Add browser smoke for rendered topology SVG diagrams and Assistant section controls after the customer confirms target diagram layouts and LiteLLM stand access for UI automation.
