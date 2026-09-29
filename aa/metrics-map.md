# Карта метрик

Источник: `scripts/dev-proxy-server.mjs`, `metricDefinitions`, `incMetric`, `observeMetricSeconds`, `renderPrometheusMetrics` и места их вызова. Карта отделяет реализованный exporter от не подтвержденной конфигурации сбора. Runtime в рамках обновления AA не меняется.

## Контракт сбора

| Поле | Подтверждено репозиторием | Эксплуатационное согласование |
| --- | --- | --- |
| Поток и направление данных | M0: `cmdbdynamicpages` -> потребитель метрик; запрос инициирует потребитель | Экземпляр collector: Требует согласования |
| Модель | Pull, Prometheus text exposition `0.0.4`; push/remote-write из приложения нет | Система сбора и хранения: Требует согласования |
| Endpoint | `GET /metrics`, без CMDBuild cookie; HTTP backend `PROXY_PORT`, default `8093` | Host, TLS, внешний порт и сетевые ограничения: Требует согласования |
| Локальный reverse proxy | Bundled nginx `8088` не публикует `/metrics`: корневой location возвращает `404` | Публикация endpoint за платформенным front: Требует согласования |
| Ответ | `200`, `Content-Type: text/plain; version=0.0.4; charset=utf-8`; HELP/TYPE и samples | Scrape timeout, размер ответа и правила хранения: Требует согласования |
| Ошибки | `500` при ошибке exporter; `503` при shutdown; сетевой отказ возможен независимо от exporter | Политика повторов, alert и периодичность: Требует согласования |
| Состояние | Counters в памяти процесса, сбрасываются при restart; большинство series появляются после первого события | Учет replicas и restart: Требует согласования |
| Readiness | `cmdp_health_ready` хранит последний результат H2; M0 не запускает H2 | Независимый опрос H2 и контроль свежести: Требует согласования |
| Назначение | Ошибки/время HTTP, CMDBuild REST, Redis, кэш, D2, throttling и последний readiness | Dashboard, SLO, alert thresholds: Требует согласования |
| Конфигурация collector | В поставляемых Dockerfile, runtime/nginx/syslog Compose нет scrape job или collector | Контур, владелец и cadence: Требует согласования |

## Реализованный каталог

`_count` и `_sum` ниже являются отдельными counters, **не histogram**: bucket series не реализованы. HTTP-метрики охватывают только пути из `shouldStructuredLogRequest`, не весь произвольный трафик proxy. Значения labels и ограничения описаны после таблицы.

<!-- aa-table: metrics -->
| Поток | Система | Метрика | Тип | Единица | Labels | Назначение и семантика | Статус | Alert или dashboard | Контур | Владелец | Периодичность |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0 | cmdbdynamicpages | `cmdp_http_requests_total` | counter | запрос | route, method, status | Завершенные учитываемые HTTP-запросы, status class | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_http_requests_aborted_total` | counter | запрос | route, method | Соединение закрыто до finish ответа | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_http_request_duration_seconds_count` | counter | наблюдение | route, method | Количество измерений времени завершенных HTTP-запросов | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_http_request_duration_seconds_sum` | counter | секунда | route, method | Сумма времени завершенных HTTP-запросов | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_cmdbuild_rest_requests_total` | counter | ответ | method, status | Полученные ответы cmdbuildRequestOnce, включая повторные попытки; сетевой отказ не увеличивает этот counter | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_cmdbuild_rest_errors_total` | counter | ошибка | method, status | Неуспешный HTTP-ответ или network error CMDBuild REST | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_cmdbuild_rest_retries_total` | counter | повтор | method, reason | Повторы CMDBuild REST: 4xx, 5xx или network | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_redis_errors_total` | counter | ошибка | reason | Redis отключен, временно недоступен или команда завершилась ошибкой | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_runtime_cache_hits_total` | counter | чтение | backend | Runtime cache hit Redis/memory; не счетчик static snapshot hit | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_runtime_cache_misses_total` | counter | чтение | backend | Runtime cache miss Redis/memory | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_runtime_cache_build_seconds_count` | counter | наблюдение | scopeMode | Успешно построенные кэшируемые runtime результаты | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_runtime_cache_build_seconds_sum` | counter | секунда | scopeMode | Сумма времени успешного построения кэшируемых результатов | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_runtime_cache_invalidations_total` | counter | вызов | backend, status | Вызовы инвалидации runtime cache, не число удаленных ключей | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_static_snapshot_invalidations_total` | untyped | вызов | backend, status | Вызовы инвалидации static snapshot; incMetric есть, определения в metricDefinitions нет | Реализовано как untyped; исправление типа не выполнено | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_d2_render_errors_total` | counter | ошибка | reason | Ошибки процесса renderer, подготовки Markdown frame и проверки SVG; не все ранние отказы валидации | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_d2_render_seconds_count` | counter | наблюдение | layout | Измеренные запуски renderer, успешные и неуспешные; не health --version | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_d2_render_seconds_sum` | counter | секунда | layout | Сумма времени процесса renderer, без последующей обработки SVG | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_d2_import_total` | counter | анализ | status | Анализ D2 после auth/body/throttle gates: ready, incomplete или error.code; не все importer операции | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_d2_import_seconds_count` | counter | наблюдение | Нет | Завершившиеся успехом или исключением анализы D2 после начальных gates | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_d2_import_seconds_sum` | counter | секунда | Нет | Полное время анализа D2, включая каталог и preview, а не только importer process | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_template_run_errors_total` | counter | ошибка | action, reason | Ошибки draft-preview, preview, run, publish в соответствующих catch blocks | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_execution_throttled_total` | counter | отказ | action | Отказы acquireExecutionSlot по глобальному или scope limit | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |
| M0 | cmdbdynamicpages | `cmdp_health_ready` | gauge | 0 или 1 | Нет | Начальное 0; последний результат readinessPayload, без timestamp свежести | Реализовано | Требует согласования | Требует согласования | Требует согласования | Требует согласования |

## Labels и границы учета

- `route`: `health`, `metrics`, `backend`, `dynamic-ui`, `cmdbuild-proxy`. Последняя группа охватывает выбранные UI/launcher пути из `shouldLogProxyRequest`, не все REST proxy routes.
- `method`: HTTP method из запроса или внутренних options. Общей allowlist/нормализации к конечному enum в metric registry нет; ограничение до используемых методов с категорией `other` является планируемым требованием.
- `status` для HTTP/CMDBuild: `1xx`..`5xx`; `network` для ошибок без ответа. Для invalidation: `ok`, `partial`. `backend`: `redis`, `memory`; при частичном отказе Redis значение может оставаться `memory` и не означает полностью успешный fallback.
- `reason` для CMDBuild retry: `4xx`, `5xx`, `network`; для Redis: `disabled`, `temporarily_unavailable`, `command_failed`; для template: `redis_required`, `permission_denied`, `execution_limit`, `execution_error`.
- `reason` renderer: `timeout`, `spawn_error`, `binary_not_found`, `process_error`, `stdin_error`, `output_limit`, `exit_code`, `unknown`, `markdown_frame_import`, `invalid_svg`.
- `layout`: нормализуется по deployment allowlist `CMDP_D2_LAYOUT_ALLOWLIST`, default `dagre,elk`; `scopeMode` у измеряемой cache build: `permissionOnly`, `visibilityHash`, `privateUser` (disabled не проходит этот путь).
- `action` throttling задается call sites: `d2-import-analyze`, `d2-import-restore`, `d2-import-apply`, `d2-import-refresh`, `assistant-object-flow-semantic-plan`, `assistant-object-flow-plan`, `d2-map-selections`, `d2-interpret`, `draft-preview`, `preview`, `run`, `publish`; helper имеет default `execution`.
- `status` D2 import берет `ready`, `incomplete` либо `error.code`/`failed`. Единой проверяемой allowlist для error.code нет. Нельзя заявлять строгую ограниченность всех labels до отдельного runtime исправления.
- В labels не передаются username, token, requestId, templateCode, текст исключения или runtime rows. Добавление таких labels недопустимо. HTTP scrape сам учитывается по завершении ответа; его increment виден следующему scrape.
- CMDBuild health probe использует отдельный HTTP path, не `cmdbuildRequestOnce`, поэтому не входит в `cmdp_cmdbuild_rest_*`.

## Планируемые пробелы, не реализованные этим изменением

| Область | Планируемое требование | Текущее ограничение | Поток | Владелец и срок |
| --- | --- | --- | --- | --- |
| Длительности | Histogram с ограниченными buckets для входящего HTTP, runtime build, D2 | Есть только count/sum; percentile по ним не вычисляется | M0 | Требует согласования |
| Внешние HTTP API | Counters результатов и histogram длительности CMDBuild/LiteLLM с ограниченными labels | Для CMDBuild есть counters, но нет duration metric; для LiteLLM отдельного exporter-каталога нет | M0 | Требует согласования |
| Идентичность сборки | Build identity gauge с deployment-controlled version/revision/provenance | Build metadata доступны в H0/headers, но отдельной build metric нет | M0; H0; IF4 | Требует согласования |
| Свежесть readiness | Контроль времени последнего H2 либо согласованный отдельный probe | M0 читает сохраненное значение; отсутствие H2 не видно по gauge | M0; H2 | Требует согласования |
| Metadata и labels | Объявить counter для static snapshot invalidation, нормализовать method/import status | Текущий untyped и отсутствие центральной allowlist сохранены | M0 | Требует согласования |
| Эксплуатация | Scrape job, доступ, retention, dashboards, alerts и proof сбора | Наличие exporter не подтверждает работающий мониторинг | M0 | Требует согласования |

Технические имена будущих метрик, buckets, пороги, контуры, владельцы и cadence: Требует согласования. План не является обещанием runtime-реализации в текущей поставке AA.
