# Карта метрик

Prometheus `/metrics` endpoint реализован как unauthenticated root endpoint. Он отдает только агрегированные технические счетчики и gauges, без cookies, токенов, имен пользователей, runtime rows или raw CMDBuild payload.

## Текущие контролируемые показатели

| ID | Поток | Источник | Поле/метрика | Назначение |
| --- | --- | --- | --- | --- |
| MET-001 | IF-008 | `/health/live` | `uptimeSec`, `pid`, `status` | Контроль живого процесса |
| MET-002 | IF-008, IF-005 | `/health/redis` | `redis.ok`, `redis.available`, `redis.lastCheckedAt` | Контроль доступности Redis |
| MET-003 | IF-008, IF-004 | `/health/ready` | `checks.cmdbuild.ok`, `checks.cmdbuild.latencyMs`, `checks.cmdbuild.statusCode` | Контроль доступности CMDBuild upstream |
| MET-004 | IF-008, IF-005 | `/cmdbuild/custom-api/cache/status` | `memory.runtimeEntries`, `memory.staticSnapshotEntries`, `memory.inFlightRuntimeBuilds` | Диагностика in-memory fallback |
| MET-005 | IF-003/IF-004 | Runtime response cache metadata | `cache.status`, `expiresAt`, `refreshAllowedAt` | Пользовательский countdown cache/refresh |
| MET-006 | IF-008 | `/metrics` | Prometheus exposition format | Scrapeable metrics для request, CMDBuild REST, Redis, runtime cache и readiness |

## Prometheus metrics

`GET /metrics` публикует:

- `cmdp_http_requests_total`
- `cmdp_http_request_duration_seconds_count`
- `cmdp_http_request_duration_seconds_sum`
- `cmdp_runtime_cache_hits_total`
- `cmdp_runtime_cache_misses_total`
- `cmdp_runtime_cache_build_seconds_count`
- `cmdp_runtime_cache_build_seconds_sum`
- `cmdp_cmdbuild_rest_requests_total`
- `cmdp_cmdbuild_rest_errors_total`
- `cmdp_cmdbuild_rest_retries_total`
- `cmdp_redis_errors_total`
- `cmdp_template_run_errors_total`
- `cmdp_execution_throttled_total`
- `cmdp_health_ready`

`cmdp_health_ready` обновляется при scrape через тот же readiness path, что и `/health/ready`.
