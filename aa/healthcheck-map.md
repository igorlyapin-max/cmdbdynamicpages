# Карта HealthCheck

Источник контракта: `scripts/dev-proxy-server.mjs`, функции `handleHealth`, `readinessPayload`, `redisHealthCheck`, `checkCmdbuildUpstream`, `d2RendererHealth`, `d2ImporterHealth`. Это описание исходников, не подтверждение доступности конкретного контура.

## Основные проверки

HTTP endpoints доступны без CMDBuild cookie. Backend по умолчанию слушает `127.0.0.1:8093`; локальный nginx принимает `/health/` на `localhost:8088`. Для каждого endpoint также реализован alias `/cmdbuild/custom-api/health/<kind>`. Адрес, порт и доступность через front в целевом контуре: Требует согласования.

<!-- aa-table: healthchecks -->
| Система | Поток | Ресурс | Тип ресурса | Статус | Получатель | Протокол и порт | Условие успеха | Неуспех | Данные ответа | Периодичность | Контур | Владелец |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cmdbdynamicpages | H0 | `GET /health/live` | API | HTTP 200: live; при недоступном процессе ответа нет | Container self-check; внешний потребитель: Требует согласования | HTTP `8093`; локальный front HTTP `8088` | `200`, `live=true`, процесс отвечает | Нет ответа; зависимости не проверяются | service, build, timestamp, startedAt, uptimeSec, pid, status, live | Image/runtime Compose: 30 s, timeout 3 s, retries 3, start_period 10 s; внешняя: Требует согласования | Требует согласования | Требует согласования |
| cmdbdynamicpages | H1 | `GET /health/redis` | API | HTTP 200: ok; HTTP 503: not_ready | Требует согласования | HTTP `8093`; локальный front HTTP `8088`; IF0 к Redis RESP/RESP over TLS, порт из URL, default `6379` | `200`, Redis включен и `PING` вернул `PONG` | `503`, Redis отключен или недоступен | Общие поля health и redis: ok, status, enabled, available, backend, required, маскированный url, transportSecurity, keyPrefix; lastCheckedAt/error при наличии | Требует согласования | Требует согласования | Требует согласования |
| cmdbdynamicpages | H2 | `GET /health/ready` | API | HTTP 200: ready; HTTP 503: not_ready | Требует согласования | HTTP `8093`; локальный front HTTP `8088`; Redis default `6379`, CMDBuild локально HTTP `8090`, иначе порт из `CMDBUILD_ORIGIN`; IF1/IF2 без сетевых портов | `200`, `ready=true`: CMDBuild доступен, обязательные Redis, renderer и importer исправны | `503`, `ready=false`; при исключении может быть общий error вместо checks | Общие поля health; checks.process, checks.redis, checks.cmdbuild, checks.d2, checks.d2Import | Требует согласования; результаты D2/importer кэшируются на 15 s | Требует согласования | Требует согласования |

Система в таблице является отправителем health-данных; HTTP-запрос инициирует получатель. Статусы описывают контракт, не результат live-проверки контура.

## Точная семантика readiness

- `process.ok=true` означает, что обработчик выполняется. Это не отдельная проверка ресурсов процесса.
- `checkCmdbuildUpstream` делает неаутентифицированный `GET /cmdbuild/services/rest/v3/sessions/current`. Любой HTTP status от `200` до `499`, включая `401` и `403`, считается доступностью upstream. Это не доказательство входа пользователя, grants, исправности запросов к карточкам или бизнес-сценария.
- Redis проверяется с `force:true`, без ожидания backoff после предыдущего отказа. Он обязателен, когда `CMDBDYNAMIC_REDIS_REQUIRED=true` или `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED` не равен `false`.
- `checks.redis.required` приходит из `redisStatus` и отражает `CMDBDYNAMIC_REDIS_REQUIRED`: оно может отличаться от условия readiness по `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED`. Решение принимать по итоговому `ready`, не по одному полю `required`.
- IF2: при `CMDP_D2_RENDER_ENABLED=true` renderer обязателен. Проверка запускает `CMDP_D2_BINARY --version`, ограничивает время до `min(CMDP_D2_TIMEOUT_MS, 1500)` ms и вывод до 4096 bytes. При отключении: `required=false`, `ok=true`, `status=disabled`. Версия сама по себе не доказывает рендер конкретной диаграммы.
- IF1: importer обязателен всегда, независимо от renderer и Assistant. Проверка передает `health: Health` через stdin в `CMDP_D2_IMPORT_BINARY`; нужен успешный процесс, JSON с `version >= 4` и пустым `source.errors`. Ограничения: `min(CMDP_D2_IMPORT_TIMEOUT_MS, 1500)` ms и 64 KiB stdout. При недоступном importer readiness не проходит.
- LiteLLM, наличие Assistant API key и внешняя доставка логов не входят в readiness. Их проверяют отдельно.
- Во время shutdown все пути, кроме корневого `/health/live`, получают `503`; это относится также к health aliases и `/metrics`.

## Конфигурация и смежные проверки

| Настройка | Default исходников | Значение |
| --- | --- | --- |
| `CMDBDYNAMIC_HEALTH_TIMEOUT_MS` | `2000`, минимум `500` ms | Таймаут CMDBuild health probe, не общий deadline readiness |
| `CMDBDYNAMIC_REDIS_ENABLED` | `true` | Отключение дает `503` для H1 |
| `CMDBDYNAMIC_REDIS_REQUIRED` | `false`; runtime Compose `true` | Запрещает memory fallback и делает Redis обязательным для H2 |
| `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED` | `true` | Требует Redis в H2 даже при разрешенном memory fallback |
| `CMDBDYNAMIC_REDIS_TIMEOUT_MS` | `500`, минимум `100` ms | Таймаут Redis-команды |
| `CMDP_D2_RENDER_ENABLED` | `true` | Участие renderer в readiness |
| `CMDP_D2_BINARY` | `/usr/local/bin/d2` | Исполняемый renderer в image |
| `CMDP_D2_IMPORT_BINARY` | `/usr/local/bin/cmdp-d2-import` | Исполняемый importer в image |

`GET /cmdbuild/custom-api/cache/status` возвращает `200` с состоянием Redis и memory counters даже при fallback. Это диагностический API, не H2. `GET /cmdbuild/custom-api/logging/status` также не readiness; обработчик требует наличие CMDBuild cookie.

M0 `GET /metrics` возвращает накопленные метрики и **не вызывает** readiness. `cmdp_health_ready` равен `0` при инициализации и обновляется только при выполнении `readinessPayload`. Без опроса H2 значение может устареть; успешный scrape не доказывает готовность.

Dockerfile и runtime Compose используют H0, не H2. Healthcheck bundled nginx проверяет `nginx -t` и наличие master process, не backend. Локальный Redis Compose использует `redis-cli ping`. Проверки маршрутизации и H2 обязательны как отдельные приемочные действия; их расписание, пороги и ответственные: Требует согласования.
