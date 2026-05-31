# ADR 0001: Zero Runtime Dependencies

## Status

Accepted.

## Context

`cmdbdynamicpages` is deployed as a small CMDBuild companion backend and custom page launcher. The current runtime relies only on Node.js built-in modules.

## Decision

Keep zero runtime dependencies for the current architecture. New operational features should prefer built-in Node.js APIs unless a dependency removes significant risk that cannot be handled locally.

## Consequences

- Container build and security review stay small.
- Dependency CVE exposure is low.
- Some integrations, such as Redis and Prometheus text output, are implemented directly and must remain covered by focused tests.
- Adding TypeScript, OpenTelemetry, Swagger UI, or a Redis client requires a separate architecture decision.
