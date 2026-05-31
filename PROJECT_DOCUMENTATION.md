# Project Documentation

This file is the short map for the project documentation set. It avoids copying the full content from the individual documents.

## Start Here

- [README](README.md): local development, current architecture, UI/runtime behavior, operational knobs.
- [Deployment guide](docs/deployment-guide.md): production environment, Redis, CMDBuild permissions, post-deployment checks.
- [Testing plan](docs/testing-plan.md): available checks and remaining test gaps.
- [Roadmap](docs/roadmap.md): current implementation status and planned test follow-ups.
- [Changelog](CHANGELOG.md): release-facing change summary.

## Architecture Artifacts

- [Architecture plan](docs/architecture-plan.md): detailed backend, UI, cache, auth, and deployment design.
- [Architecture artifacts index](aa/README.md): OpenAPI, information model, health, metrics, logging, secrets, deployment, and process maps.
- [OpenAPI contract](aa/openapi.yaml): custom API and runtime contract.
- [Metrics map](aa/metrics-map.md): Prometheus metric names and scrape contract.
- [Healthcheck map](aa/healthcheck-map.md): liveness, readiness, Redis health, and diagnostic endpoints.
- [Secrets map](aa/secrets-map.md): secret storage and rotation expectations.

## Audit And Decisions

- [Audit remediation 2026-05-31](docs/audit-remediation-2026-05-31.md): mapping from audit findings to implemented, planned, and deferred work.
- [ADR 0001: Zero runtime dependencies](docs/adr/0001-zero-runtime-dependencies.md)
- [ADR 0002: Raw RESP Redis client](docs/adr/0002-raw-resp-redis.md)
- [ADR 0003: Current monolithic backend boundary](docs/adr/0003-current-monolithic-backend-boundary.md)

## Russian Branches

Russian mirrors are maintained for the main long-form docs:

- [README.ru](README.ru.md)
- [Architecture plan RU](docs/architecture-plan.ru.md)
- [Deployment guide RU](docs/deployment-guide.ru.md)
- [Testing plan RU](docs/testing-plan.ru.md)
- [Roadmap RU](docs/roadmap.ru.md)
