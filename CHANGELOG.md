# Changelog

## 2026-06-03

### Added

- Added `CMDP_DIAGNOSTIC_MODE=off|Basic|Verbose` with safe structured diagnostic events and sanitized verbose diagnostics.
- Added production startup validation for `CMDBDYNAMICPAGES_CSRF_SECRET`.
- Added dependency-free `secret:scan`, `ci`, and ZIP build gates.
- Added skip-safe Runtime table UI checks, optional browser-level wiki iframe smoke, write-mode `expectedSpecHash` conflict coverage, and production runbooks.

### Changed

- Kept `stdout` enabled for structured logs even when syslog is configured.
- Updated GitHub Actions and GitLab CI to run the unified `npm run ci` gate.

## 2026-05-31

### Added

- Added Docker runtime packaging for the custom pages backend.
- Added unauthenticated production health endpoints at `/health/live`, `/health/ready`, and `/health/redis`.
- Added Prometheus text metrics at `/metrics` for aggregate HTTP, CMDBuild REST, Redis, runtime cache, template error, throttle, and readiness signals.
- Added opt-in strict Redis mode with `CMDBDYNAMIC_REDIS_REQUIRED=true`.
- Added bounded regex validation for template extraction and matching.
- Added optional optimistic update guard for templates through `specHash` and `expectedSpecHash`.
- Added OpenAPI contract coverage for `/metrics`, `specHash`, `expectedSpecHash`, and `409 template_version_conflict`.
- Added project documentation map, audit remediation notes, and ADRs for current architectural decisions.

### Changed

- Hardened HTTP responses with security headers, request IDs, body limits, throttling, graceful shutdown, and CMDBuild REST retry/backoff behavior.
- Documented metrics, Redis strict mode, regex limits, template version conflict behavior, and production deployment guardrails.
