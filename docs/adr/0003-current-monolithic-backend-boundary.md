# ADR 0003: Current Monolithic Backend Boundary

## Status

Accepted as a short-term boundary.

## Context

`scripts/dev-proxy-server.mjs` currently owns routing, CMDBuild proxying, auth checks, template CRUD, DSL execution, Redis cache, health, metrics, and backend-served UI.

## Decision

Do not decompose the backend as part of audit hardening P0/P1/P2. Keep changes narrowly scoped and behavior-preserving until a separate refactor plan defines module boundaries, migration order, and regression gates.

## Consequences

- Audit hardening can land with low integration risk.
- The large file remains a maintainability risk and should be treated as a future architecture task.
- Any later decomposition must preserve current URLs, CSRF/session behavior, cache keys, runtime output shapes, and existing test commands.
