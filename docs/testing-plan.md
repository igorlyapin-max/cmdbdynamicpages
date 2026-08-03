# Testing Plan

English branch. Russian branch: [testing-plan.ru.md](testing-plan.ru.md).

## Implemented

- `npm run check`: syntax check for custom page, proxy, diagnostics, e2e, and validation scripts.
- `npm run secret:scan`: scans repository text files for high-confidence committed secrets, excluding generated/runtime directories.
- `npm run build:zip`: builds the CMDBuild custom page ZIP with the dependency-free Node builder.
- `npm run ci`: runs `secret:scan`, `npm test`, and `build:zip`. GitHub Actions and GitLab CI additionally install pinned Playwright/Chromium and run `test:ui:required`.
- `npm run test:static`: validates required OpenAPI paths, local component references, and architecture artifact links.
- `npm run test:unit`: covers cache configuration, cache key scope, refresh metadata, snapshot URL params, parameter defaults, IPv4 matching, topology diagram payloads, runtime JSON output-mode filtering, assistant MCP allowlist/defaults, dependency map, logging redaction, diagnostic mode, assistant-disabled config, and runtime config validation.
- `npm run test:api`: API contract smoke for `/health/*`, `/metrics`, protected logging status, same-origin/CSRF rejection, and JSON content-type validation. Readiness is checked through `checks.redis`, `checks.cmdbuild`, `checks.d2`, and `checks.d2Import`.
- `npm run test:ui`: skip-safe Playwright smoke for Designer template list, fixed menu/action bar, contextual Run buttons, compact Runtime shell, runtime table search/sort, grouped-table control disabling, and split-subtable local sorting.
- `npm run test:ui:required`: CI browser gate. Starts an isolated CMDBuild API fixture and backend, requires Chromium and a valid fixture session, then verifies visible Designer shell scenarios. It fails instead of skipping when a browser or fixture is unavailable.
- `npm run test:nginx`: validates the project-only nginx config and `cmdbdynamicpages` routes through `localhost:8088`.
- `npm run e2e`: checks logging diagnostics, draft preview without runtime cache, runtime cache hit, POST `forceRefresh`, GET runtime not forcing refresh, technical schema bootstrap, and write-mode `expectedSpecHash` conflict handling.

With a valid non-readonly CMDBuild admin session, normal `npm run e2e` calls `POST /schema/bootstrap`. It creates only missing technical CMDBuild classes and attributes, so it is state-changing. `CMDBDYNAMIC_EXPECT_READONLY=1` is for a limited CMDBuild account: bootstrap is not called and the e2e verifies that template creation is denied. It is not an admin check-only mode.

## Remaining

- Run live e2e with a fresh CMDBuild session or explicit `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD` when validating against a restarted environment.
- For the authenticated `npm run test:api` branch, set `CMDBUILD_COOKIE_HEADER` or `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD` (optionally `CMDBUILD_LOGIN_ORIGIN`, `CMDBUILD_ROLE`, and `CMDBUILD_SCOPE`). Without them public and rejection scenarios run, while the valid-session content-type scenario is explicitly skipped.
- Add browser smoke for rendered topology SVG diagrams and Assistant section controls after the customer confirms target diagram layouts and LiteLLM stand access for UI automation.
