# Audit Remediation 2026-05-31

Источник: `/home/lsk/projects/audit/cmdbcustompages-audit-2026-05-31.md`.

## Закрыто в P0/P1

| Audit ID | Решение |
| --- | --- |
| R-002 | CMDBuild REST retry/backoff добавлен для safe transient calls. |
| R-003 | Execution throttling добавлен для template execution. |
| R-004 | Graceful shutdown добавлен для SIGTERM/SIGINT. |
| R-005 | Добавлен backend `Dockerfile` с non-root user и healthcheck. |
| R-006 | Добавлены минимальные GitHub Actions и GitLab CI на `npm test`. |
| R-007 | Добавлен `CMDBDYNAMIC_REDIS_REQUIRED=true`, отключающий memory fallback. |
| R-008 | Добавлен `/metrics` с Prometheus text exposition. |
| R-012 | Добавлен keep-alive agent для CMDBuild REST/proxy calls. |
| R-013 | Добавлен optional `specHash` / `expectedSpecHash` guard для template update. |
| R-014 | Добавлены security headers, совместимые с iframe сценариями. |
| R-015 | Добавлен bounded regex guard для DSL regex paths. |
| R-016 | Добавлен `CHANGELOG.md`. |

## P2 без изменения архитектуры

| Пункт | Действие |
| --- | --- |
| Public contract drift | Синхронизировать `aa/openapi.yaml` с `/metrics`, `specHash`, `expectedSpecHash`, `409 template_version_conflict`. |
| Документация разбросана | Добавить `PROJECT_DOCUMENTATION.md` как карту документации без дублирования. |
| Нет ADR | Добавить короткие ADR для zero-deps, raw RESP Redis и текущей границы monolithic backend. |
| Нет runbook/SLO baseline | Зафиксировать минимальные production checks, SLI candidates и alert inputs в deployment/testing/health/metrics docs. |
| Недостаток test coverage | Добавить skip-safe API smoke для `/metrics`. |
| Security perimeter hardening | Добавить nginx `limit_req`, strict allowlist для CMDBuild proxy fallback и `Content-Type: application/json` для JSON mutation endpoints. |

## Отложено как архитектурное

Эти пункты не входят в P2, потому что меняют архитектуру, стек или runtime ownership:

- декомпозиция `scripts/dev-proxy-server.mjs` на модули;
- TypeScript/JSDoc typecheck migration;
- eslint/prettier stack;
- OpenTelemetry distributed tracing;
- Swagger UI endpoint с новыми статическими assets/dependencies;
- K8s/Helm/GitOps manifests;
- distributed lock для schema bootstrap;
- persistent audit log / DLQ;
- advanced production-specific rate limiting policies beyond bundled nginx config;
- migration с raw RESP на node-redis/ioredis.

## Acceptance

- `npm test` проходит.
- `npm run test:api` проверяет `/metrics`, если proxy доступен.
- `node scripts/validate-openapi.mjs` принимает обновленный `aa/openapi.yaml`.
- Документы не содержат секретов, raw env values или live cookies.
