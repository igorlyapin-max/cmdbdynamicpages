# Карта метрик

В текущей реализации отдельный Prometheus `/metrics` endpoint не реализован. Минимальная operational visibility обеспечивается health/readiness JSON endpoint'ами и container health status.

## Текущие контролируемые показатели

| ID | Поток | Источник | Поле/метрика | Назначение |
| --- | --- | --- | --- | --- |
| MET-001 | IF-008 | `/health/live` | `uptimeSec`, `pid`, `status` | Контроль живого процесса |
| MET-002 | IF-008, IF-005 | `/health/redis` | `redis.ok`, `redis.available`, `redis.lastCheckedAt` | Контроль доступности Redis |
| MET-003 | IF-008, IF-004 | `/health/ready` | `checks.cmdbuild.ok`, `checks.cmdbuild.latencyMs`, `checks.cmdbuild.statusCode` | Контроль доступности CMDBuild upstream |
| MET-004 | IF-008, IF-005 | `/cmdbuild/custom-api/cache/status` | `memory.runtimeEntries`, `memory.staticSnapshotEntries`, `memory.inFlightRuntimeBuilds` | Диагностика in-memory fallback |
| MET-005 | IF-003/IF-004 | Runtime response cache metadata | `cache.status`, `expiresAt`, `refreshAllowedAt` | Пользовательский countdown cache/refresh |

## Рекомендуемое развитие

Добавить `/metrics` с Prometheus exposition format:

- `cmdp_runtime_cache_hits_total`
- `cmdp_runtime_cache_misses_total`
- `cmdp_runtime_cache_build_seconds`
- `cmdp_cmdbuild_rest_requests_total`
- `cmdp_cmdbuild_rest_errors_total`
- `cmdp_redis_errors_total`
- `cmdp_template_run_errors_total`
- `cmdp_health_ready`

До появления `/metrics` production мониторинг должен использовать `/health/ready` для readiness и централизованные логи для ошибок выполнения.
