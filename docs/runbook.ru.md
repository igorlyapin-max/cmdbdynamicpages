# Runbook cmdbdynamicpages

## Назначение

Runbook нужен для production checks, rollback, diagnostics и разбора типовых incidents. Не помещайте live cookies, Redis passwords, CMDBuild tokens и raw secret values в tickets, logs, docs или test fixtures.

## Проверки развертывания

Перед deploy:

```bash
npm run ci
```

Проверка runtime package:

```bash
npm run build:zip
unzip -t dist/cmdbdynamicpages-custompage.zip
```

Обязательная production configuration:

```text
NODE_ENV=production
CMDP_PUBLIC_ORIGIN=https://custom.example.local
CMDP_NGINX_PUBLIC_HOST=custom.example.local
CMDP_NGINX_PUBLIC_PROTO=https
CMDBDYNAMIC_REDIS_URL=rediss://redis.example.local:6380/0
CMDP_TLS_CA_FILE=
CMDP_TLS_CA_FILE_HOST=
CMDBDYNAMICPAGES_CSRF_SECRET=<external stable secret>
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDP_LOG_TARGET=stdout
CMDP_DIAGNOSTIC_MODE=off
```

Проверки после deploy:

```text
GET /health/live
GET /health/redis
GET /health/ready
GET /metrics
GET /cmdbuild/custom-api/logging/status
```

Ожидаемый результат: `/health/live` отвечает `200`; `/health/ready` отвечает `200` только когда Redis и CMDBuild upstream доступны; `/metrics` возвращает Prometheus text без cookies, tokens, user names, runtime rows и raw CMDBuild payload.

`docker compose ... logs` подтверждает только local stdout. Проверить platform-managed маршрут нужно запросом к collector, который вернет `0` только после нахождения отправленного probe ID:

```bash
bash scripts/verify-platform-log-route.sh https://custom.example.local/health/live -- \
  sh -c 'platform-log-query --contains "$CMDP_LOG_PROBE_ID"'
```

Для прямого syslog задать `CMDP_SYSLOG_HOST` и запускать с `-f docker-compose.syslog.yml`; этот overlay устанавливает `CMDP_LOG_TARGET=stdout,syslog` и требует endpoint syslog.

## Public Origin За Reverse Proxy

`CMDP_PUBLIC_ORIGIN` - единственный browser-facing origin для CMDBuild UI, custom page и `/cmdbuild/custom-api/*`. Он должен быть задан в production как bare `http(s)` origin, например `https://custom.example.local`, без path, query, fragment или credentials.

`CMDBUILD_ORIGIN` - только внутренний upstream URL, доступный backend, например `https://vr2.internal.example`. Он может отличаться от `CMDP_PUBLIC_ORIGIN`, но не должен появляться в URL браузера, `Origin`, `Referer`, redirect `Location` или cookie domain.

Для production Redis использовать `rediss://`. При private PKI CMDBuild, Redis или LiteLLM задать вместе `CMDP_TLS_CA_FILE_HOST` и `CMDP_TLS_CA_FILE=/run/certs/cmdbdynamicpages-ca.pem`: compose смонтирует один PEM bundle read-only, а Node использует его для HTTPS trust. Plaintext `redis://` остается поддержанным для local и существующих deployment, но в production runtime сообщает `redis_plaintext_transport`.

Задать `CMDP_NGINX_PUBLIC_HOST` как `host[:port]` из `CMDP_PUBLIC_ORIGIN`, а `CMDP_NGINX_PUBLIC_PROTO` как его protocol. Bundled nginx передает только эти configured values, а не client-supplied `Host`, `X-Forwarded-Host` или `X-Forwarded-Proto`. Пользовательский ingress публикует только public hostname; прямой доступ пользователей к backend, bundled nginx и internal CMDBuild upstream закрывается firewall/ingress правилами. Browser JavaScript использует относительные `/cmdbuild/...` URLs и не обращается к `PROXY_PORT` или `CMDBUILD_ORIGIN` напрямую.

После deploy проверить через public hostname:

```text
GET https://custom.example.local/cmdbuild/ui/config.js
GET https://custom.example.local/cmdbuild/custom-api/logging/status
```

`config.js`, redirects и CMDBuild session cookie должны оставаться на `custom.example.local`; `vr2.internal.example` не должен быть виден в browser traffic.

## Rollback

Порядок rollback:

1. Вернуть предыдущий backend image или process bundle.
2. Вернуть предыдущий CMDBuild custom page ZIP, если менялся launcher.
3. Не очищать Redis, если incident не связан напрямую с corrupt static snapshots или cache entries.
4. Повторить `/health/live`, `/health/ready` и один известный runtime URL.

Обычные runtime releases не требуют destructive CMDBuild schema rollback. Schema bootstrap non-destructive и не должен удалять или переносить существующие CMDBuild classes.

## Diagnostics

Для безопасной диагностики используйте `CMDP_DIAGNOSTIC_MODE=Basic`. `Verbose` включайте только временно, когда нужны sanitized request/upstream details.

### Assistant Capture

Assistant capture независим от `CMDP_DIAGNOSTIC_MODE`: default `Off`, `Basic` для
metadata, `Verbose` также для bounded redacted request/response тел. Capture в Redis
действует **для всех пользователей выбранного технического root**. Даже после
redaction traces/exports считать чувствительными; не публиковать raw exports.

В Designer откройте **Настройки выполнения → Диагностика Assistant**. Выберите
«Подробная» и нажмите «Применить режим», подтвердите захват. После воспроизведения
раскройте «Запросы и ответы Assistant» под результатом либо найдите запись по Request ID
в настройках. Тела загружаются только при раскрытии этапа; доступны копирование и JSON export.
Каждый HTTP-этап имеет собственную трассировку: возобновляемая операция может отдельно
сохранить MCP-контекст и LLM-генерацию. Уже прочитанный фрагмент оборванного ответа
сохраняется с признаком неполноты; запись диагностики не меняет исходную ошибку.

Запись асинхронна: `diagnostics.assistantTrace.storageStatus` имеет значение `pending`, `stored`,
`discarded` (отказ lifecycle/quota) или `unavailable` (отказ storage/control).
Ссылка не подтверждает сохранение. При раскрытии UI повторяет чтение известной
`pending` ссылки максимум 5 секунд; произвольные отсутствующие traces не опрашиваются.

1. Использовать admin-сессию с `admin_classes_modify` и чтением конфигурации root.
2. Прочитать `GET /cmdbuild/custom-api/assistant/diagnostics/status?root=<Root>`.
   Включить `POST .../diagnostics/capture?root=<Root>` с JSON
   `{"mode":"Verbose","durationSec":900,"confirmed":true}` через обычный same-origin CSRF flow.
   Для metadata-only использовать `Basic`; `DELETE .../diagnostics/capture` выключает capture.
3. Воспроизвести одну целевую Assistant-операцию. Прочитать `GET .../diagnostics/traces`
   с `root` и опционально `requestId`, `templateCode`, `limit`. Trace:
   `GET .../diagnostics/traces/<id>` (metadata без тел); span: `GET .../diagnostics/traces/<id>/spans/<spanId>`;
   JSON export: `GET .../diagnostics/traces/<id>/export`. Передавать `root` во всех запросах.
4. Сопоставить effective `max_tokens`, `finish_reason`, detailed token usage и provider
   response. Verbose сохраняет текст invalid JSON после redaction; ошибка parsing
   не означает отсутствие текста. Сначала проверить markers truncation/omission.
5. Остановить capture. `DELETE .../diagnostics/traces?root=<Root>` удаляет retained
   traces и через storage epoch инвалидирует pending/in-flight записи.
   Все mutations требуют CSRF. Остановка не очищает traces, разрешает завершиться
   уже принятым Redis traces, но запрещает новый admission. Очистка не останавливает capture.

Все endpoints admin-only, ответы `Cache-Control: no-store`. Redaction выполняется
до записи Redis. Тела не идут в stdout/stderr или внешние log sinks; операционные
metadata идут в основной structured logging pipeline. Отказ Redis не должен менять
результат Assistant; in-memory storage fallback не предусмотрен.
Capture control опрашивается из Redis в фоне каждую 1 секунду; memory cache содержит
только control metadata, не fallback хранения payload. Отсутствующий/недоступный
control или control старше 2 секунд отключает tracing с warning без ожидания Redis
на пути Assistant. Begin/update атомарны; update использует `XX`, исходный expiry
и проверку epoch. Истёкшие, вытесненные и очищенные traces не восстанавливаются.
Redaction покрывает credentials и в malformed JSON; старую историю нельзя считать безопасной.

Сохранённая policy `assistant.diagnostics`: `captureDurationSec=900` (max `3600`),
`retentionSec=86400` (max `604800`), `maxBodyBytes=8388608`, `maxTraceBytes=33554432`,
`maxStoredBytes=268435456`. Byte quotas ограничивают тело, trace и общий объём retained
traces root. Старые traces могут вытесняться; oversized детали могут опускаться.
Capture истекает автоматически. Restart backend и сохранение policy не включают
capture и не продлевают deadline или retention существующих traces. RuntimeConfig не хранит активный режим.
Deployment ceilings перечислены в [admin guide](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md#budget-генерации-и-временный-capture).
Capture byte quotas не увеличивают LLM request/response byte limits.

`assistant.llm.maxTokens` default `16384`; каждый Assistant LiteLLM request передаёт
effective значение как `max_tokens`, ограниченное deployment ceiling
`CMDP_ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE=131072`. После изменения env пересоздать backend.

`GET`/`PUT /cmdbuild/custom-api/config` сохраняют запрошенные RAW значения
`assistant.llm.maxTokens` и числовой policy `assistant.diagnostics`; выполнение
использует effective caps. Ответ содержит `diagnostics.limits` (`requested`,
`effectiveLimit`, `clampedBy`), `warnings` и `effectiveAssistantDiagnostics`.
Некорректные числа, включая числовые строки, ноль, отрицательные, дробные и unsafe
integers, возвращают HTTP `422`, код `runtime_config_invalid`, до записи CMDBuild.
Исправьте запрос; не подменяйте сохранённый RAW effective ceiling ради скрытия warning.

#### Формат ответа и потеря задачи моделью

В Runtime settings параметр `assistant.llm.responseFormat` принимает `json_object`
(по умолчанию: передаётся `response_format: {"type":"json_object"}`) или `prompt`
(явная инструкция JSON без этого параметра). Режим `prompt` выбирает оператор,
если провайдер не поддерживает JSON-режим. Автоматического переключения нет.
Оба режима сохраняют детерминированную проверку предложения до применения.

- `assistant_invalid_json`: провайдер ответил, но вернул текст или неправильный JSON.
  Ручной повтор использует действующий MCP checkpoint; сам запрос не повторяется.
- `assistant_empty_response`: провайдер не вернул содержимое ответа.
- `assistant_output_truncated`: `finish_reason=length`; предложение не применяется.
- `assistant_response_format_unsupported`: явный отказ провайдера поддерживать
  формат; исправьте настройку или конфигурацию провайдера, не увеличивайте таймаут.

При HTTP 200 от LiteLLM и HTTP 502 от BFF сопоставьте статусы и `finish_reason`
в технической трассе. Если вместо задачи получен обзор каталога, проверьте в
LiteLLM и backend модели сохранность всех `system`-сообщений, последней задачи,
фактическое контекстное окно, chat template и политику усечения входа. Сравните
короткую задачу с полным запросом через один и тот же маршрут. Около 16K в
`prompt_tokens` само по себе не доказывает усечение. Трасса BFF доказывает только
то, что он отправил LiteLLM, а не окончательный вход модели. Не публикуйте
неотредактированные трассы; Verbose включайте только на время диагностики.

#### Security Rollout

Пользователь одобрил удаление **всей существующей диагностической истории** всех
roots, но только внутри diagnostics namespace этого проекта. Остановить все старые
backend writers, выполнить проверенный offline purge CLI от ответственного за
rollout, проверить отсутствие старых diagnostic keys, затем запустить новый backend.
До завершения purge backend не запускать. Новый публичный purge endpoint не
планируется; root-scoped clear API не заменяет rollout purge. Не использовать
`FLUSHDB`/`FLUSHALL` и не удалять посторонние project keys.
Порты front/backend остаются `8088`/`8093`; templates, prompts и business data не
меняются. Legacy для диагностической истории не поддержана. Точные offline команды:
[Security Purge](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md#assistant-diagnostics-security-purge).
Helper импортируется без запуска HTTP, сохраняет epoch keys и удаляет старую/новую
историю всех roots, включая orphan keys и active capture control. До запуска повторить
purge при остановленных writers и получить `deletedKeys: 0`.
Root выполнит это при финальном rollout; в рамках docs-задачи purge не выполнялся.
При `finish_reason=length` не поднимать лимиты автоматически: проверить model/provider
context/output limits, timeout, response byte budget и стоимость до решения оператора.

### Локальный nginx restart-loop

Порты стенда являются контрактом: не менять `8088`, `8093`, `8090` или `6379` для обхода ошибки. Сначала проверить вычисленную конфигурацию и environment контейнера:

```bash
docker compose -f docker-compose.nginx.yml config --quiet
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' cmdbdynamicpages-nginx
```

Шаблон `/etc/nginx/templates/default.conf.template` требует `CMDP_NGINX_PUBLIC_HOST`, `CMDP_NGINX_PUBLIC_PROTO` и `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT`. Если в логах есть `unknown "cmdp_nginx_public_host" variable`, nginx был создан не через штатный Compose или без полного environment. Восстанавливать только Nginx командой `npm run nginx:dev`; она пересоздаёт этот контейнер с тем же `network_mode: host` и портом `8088`, не затрагивая backend, Redis или CMDBuild. Затем проверить `GET http://localhost:8088/health/live`, `GET http://localhost:8088/health/ready` и `GET http://localhost:8088/cmdbuild/ui/`.

Полезные endpoints:

```text
GET /health/ready
GET /health/redis
GET /metrics
GET /cmdbuild/custom-api/cache/status
GET /cmdbuild/custom-api/logging/status
GET /cmdbuild/custom-api/auth/permission-scope
```

Интерпретация:

- Redis unavailable: `/health/redis` возвращает `503`, `/health/ready` возвращает `503` при required Redis, logs содержат `redis.unavailable`.
- CMDBuild unavailable: `/health/ready` возвращает `503` с `checks.cmdbuild.ok=false`, logs содержат `cmdbuild.request_error` или `cmdbuild.request_failed`.
- Template execution errors: смотреть `cmdp_template_run_errors_total`, `template.execution_failed`, `runtime.cache_result`.
- Cache behavior: сравнить `/cmdbuild/custom-api/cache/status`, runtime response `cache.status` и `cmdp_runtime_cache_*`.
- Same-origin rejection: сопоставить `x-request-id` браузерного ответа с `security.same_origin_rejected`. В событии смотреть `expectedOrigin`, `headerSource` и `reason`; cookie и CSRF token в логи не пишутся. При external TLS expected origin должен быть `https://...`, а не internal CMDBuild URL.

## SLI и alert inputs

Кандидаты SLI:

- readiness success rate из `/health/ready`;
- CMDBuild upstream latency/error rate из readiness и `cmdp_cmdbuild_rest_*`;
- Redis availability из `/health/redis` и `cmdp_redis_errors_total`;
- HTTP error rate из `cmdp_http_requests_total`;
- runtime cache hit/miss/build duration из `cmdp_runtime_cache_*`;
- template execution error rate из `cmdp_template_run_errors_total`;
- execution throttling из `cmdp_execution_throttled_total`.

Предлагаемые alerts:

- `/health/ready` остается non-ready два scrape intervals подряд.
- Redis required mode включен и `/health/redis` возвращает `503`.
- CMDBuild upstream readiness падает или latency резко растет.
- Template execution errors растут выше обычного baseline.
- Execution throttling держится продолжительное время.

## Типовые incidents

### Production startup падает с `app.config_invalid`

Проверить `NODE_ENV=production`, `CMDBDYNAMICPAGES_CSRF_SECRET` и `CMDP_PUBLIC_ORIGIN`. Production требует stable external CSRF secret и explicit public browser origin; internal `CMDBUILD_ORIGIN` его не заменяет.

### Runtime iframe показывает login или пустой результат

Проверить same-origin через nginx/ingress и `?root=<technicalRoot>` в ссылке. Добавить `json=true` в ссылку просмотра: выбор данных тот же, что для HTML и D2. Совпавший опубликованный снимок выдаётся без вызова CMDBuild даже при отсутствующей или истёкшей cookie. Только при отсутствии снимка включается защищённый путь: `401 cmdbuild_session_invalid` означает, что нужно войти заново; `403 technical_schema_access_denied` — проверить права чтения технической схемы выбранного root; `403 data_access_denied` — проверить права чтения бизнес-данных. После защищённого `403` снимок повторно не ищется. Для поиска события в структурированных логах использовать заголовок ответа `X-Request-ID`.

### Static snapshot отсутствует или недоступен

**«Перечитать снимок»** только загружает сохранённый результат и доступно без входа. Вошедший читатель, которому доступен запуск сохранённого шаблона, может пересчитать отчёт под своей сессией CMDBuild без права редактировать шаблон. В настройках публикации **«Личный результат»** (по умолчанию) показывает свежие данные только в открытой вкладке. **«Общий снимок»** требует явного разрешения в шаблоне и подтверждения при запуске; он заменяет публичный снимок. Права на карточки у инициатора могут изменить состав результата для всех. Не включайте общий режим, если результат под правами любого допущенного читателя нельзя открыть публично.

В обоих режимах используются параметры из открытого снимка, в том числе при `ignore`. При конфликте перечитайте снимок перед повтором. Отказ в доступе и неполный расчёт не должны менять публичный снимок. Сопоставляйте события `snapshot.refresh_*` по `X-Request-ID`. Если исход запроса неясен из-за ошибки транспорта или хранилища, сначала перечитайте снимок и только затем решайте, повторять ли общую запись.

Проверить публичный `GET /cmdbuild/custom-api/public-snapshots/<code>/run` с теми же `root`, кодом и параметрами, что в ссылке просмотра. Для `exact` дизайнер передаёт `snapshotParams`: URL-кодированный JSON-массив типизированных пар, например `[["enabled",false],["site",42]]`. Копируйте ссылку из дизайнера, не преобразуя значения в строки. При отсутствии снимка API возвращает `snapshotFound=false`.

Ключи версии 3 используют технический класс шаблона и Code; доступ проверяется по поколению отзыва. Старые снимки не мигрируют: нужные отчёты переопубликуйте явно. Используйте один пишущий экземпляр BFF на контур и Redis с гарантией сохранения подтверждённых записей (AOF с `appendfsync always` или эквивалент), без чтения с отстающей реплики. При восстановлении старой резервной копии Redis задайте новый `CMDBDYNAMIC_REDIS_KEY_PREFIX` до открытия публичных маршрутов. При откате не открывайте публичные маршруты, пока старые ключи не удалены из пространства имён.

`503 snapshot_revocation_unavailable` означает, что BFF не начал запись в CMDB. Если подтверждение `MSET` потерялось, маркеры могли сохраниться в Redis. `409 snapshot_revocation_pending` на Publish означает, что маркер блокирует публикацию. `snapshotRevocationPending: true` в ответе на изменение означает, что отзыв не подтверждён или не завершён; `200` при этом подтверждает запись в CMDB, а `502` может скрывать уже применённую запись. Не повторяйте запись с неизвестным результатом.

1. Найдите `snapshot.revocation_attempted` по `X-Request-ID` исходного изменения и `snapshotRevocationOperationId`. Если известен только `409` от Publish, ищите исходное изменение по затронутым root и коду. До `MSET` журнал записывает `requestId`, `operationId` и все `stateKeys`. `snapshot.revocation_started` появляется после подтверждения записи маркеров. По тем же ID найдите `snapshot.revocation_unavailable`, `snapshot.revocation_pending` или `snapshot.revocation_finished`. При `previous_revocation_pending` ищите предыдущие операции по `blockingOperationIds`. Отсутствие итогового события само по себе не доказывает, что запись не отправлялась.
2. Приостановите записи и публикации для всех затронутых кодов, дождитесь завершения незаконченных записей в CMDB. Под сессией редактора или администратора проверьте фактическую карточку и версию, при переименовании оба кода, при удалении отсутствие карточки. Если исход записи установить нельзя, не меняйте маркеры.
3. На настроенном Redis primary в нужной базе выполните `WATCH` для всех ключей из журнала, затем `GET` на том же соединении. Продолжайте, только если каждый ключ содержит ровно `pending:<operationId>`. Через `MULTI`/`EXEC` атомарно замените все значения на `ready:<operationId>`. При расхождении, отмене или потере подтверждения `EXEC` остановитесь и сверьте состояние и более новые операции. Не восстанавливайте прежнее поколение вручную и не копируйте кэшированные payload.
4. После сверки возобновите запись. При необходимости явно переопубликуйте только проверенную сохранённую версию и проверьте её через публичный API снимка.

При `409 template_version_conflict` сохранённая версия больше не совпадает с
базовой версией редактора. Черновик остаётся в редакторе; сохранение и публикация
не повторяются автоматически. Сопоставьте правки с актуальной версией перед
новым сохранением. Для диагностики используйте идентификатор запроса, этап
записи и оба хеша из технического блока. При конфликте публикации старый снимок
не записывается.

Если ссылка просмотра или публичный API снимков возвращает HTTP `503` с `reason=snapshot_storage_unavailable`, проверить `/health/redis` и структурированные логи по `X-Request-ID`. Ошибка поиска не означает отсутствие снимка и не запускает защищённый путь. Если снимок найден, но `d2=true` возвращает `403`, проверить, был ли он опубликован с `publish.publicD2Source=true`.

### Большая таблица

В «Итоговых данных» включите постраничный просмотр для нужной таблицы. **По выбранному объекту → Фильтровать по колонке** строит список из уникальных непустых значений однозначного поля источника, даже если оно не отображается в отчёте. Для прямой выборки карточек Designer читает атрибуты класса, доступные текущему пользователю. Для сопоставления или выборки с явно заданным набором полей доступны только поля самого результата. Откройте «Расширенные настройки», если нужны отдельный источник, другая подпись, сопоставление с другим полем или передача ключа в существующий параметр динамической выборки. Колонки с ключами группировки сохраняют значения, остальные поддерживают уникальные значения, счётчик и связанные поля. Исходные записи открываются отдельно и постранично.

В опубликованном снимке первые 10 вариантов видны сразу при открытии фильтра. Поиск идёт по всему индексу снимка, выдаёт по 10 вариантов и не обращается к CMDBuild. Строки отчёта загружаются после выбора.

В браузер отправляется по 50 записей, максимум 100 за запрос. Размер определяет настройка **Строк на странице**; для снимка применяется значение на момент последней публикации или общего пересчёта. Отдельный общий бюджет исходных строк на постраничную таблицу задаёт `CMDP_LARGE_TABLE_MAX_ROWS` (по умолчанию `10000`). Если число строк равно бюджету, набор считается полным только при подтверждённом конце. Лимиты CMDBuild, связей и времени действуют независимо. Перед повышением бюджета см. [лимиты строк отчёта](deployment-guide.ru.md#лимиты-строк-отчёта).

Публикация и оба режима пересчёта возвращают HTTP `422` с `reason=code=table_result_incomplete`, если расчёт неполный или превышен лимит, включая REST-бюджет. Это относится к обычным, смешанным и постраничным результатам. Ошибки индекса сохраняют код `large_table_*_limit` или `table_view_too_large`. Ответ `snapshot_refresh_incomplete` без диагностики лимитов означает, что шаблон или снимок-кандидат не готов: проверьте валидацию и настройки публикации, не повышая лимит.

В `diagnostics.limits` найдите итоговую таблицу (`table`), фазу (`phase`) и, если указаны, шаг Object Flow, имя лимита, источник настройки, ключ и фактический лимит. Фазы: `selector` (варианты выбора), `rows` (расчёт отчёта или строк постраничной таблицы), `index` (индекс таблицы), `commit` (ожидание блокировки, финальная проверка, проверка дедлайна в Redis или создание личного представления). По этим данным сузьте отчёт, проверьте настройку или пагинацию upstream. Список содержит не более 16 плоских записей; положительный `diagnostics.omittedCount` показывает, сколько записей не вошло. Чувствительные метки маскируются в API и структурированных логах. Сопоставляйте их по `X-Request-ID`.

Сопоставляйте счётчики только в указанной единице (`unit`). Например, при чтении 10 000 карточек и общем числе 10 001 по метаданным `maxSelectionScanRows` показывает `observed=10000` и `total=10001`: это не подтверждает 10 001-ю строку результата. Если при лимите 1 вернулась одна связь, а метаданные подтверждают две, возвращается `limit_exceeded`, `observed=1`, `total=2`. Без подтверждённого конца той же полной страницы возвращается `completeness_unconfirmed`, а неизвестный `total` опускается. `maxRestCalls` считает вызовы чтения движка, без сетевых повторов одного чтения и без вызова, отклонённого до отправки.

Истечение дедлайна имеет приоритет над превышением лимита, если запись не отправлялась или Redis подтвердил отказ по дедлайну. В этом случае возвращается HTTP `504`: `draft_preview_timeout` для публикации и `snapshot_refresh_timeout` для пересчёта. Перед изменением индекса или снимка Redis проверяет собственное время, поколение и, если применимо, ревизию. Запись `executionTimeoutMs` / `deadline_exceeded` сохраняется даже при переполнении списка. Для таймаута на фазе `commit` поле `table` равно `""`, поля шага отсутствуют. При `422` и `504` публичный снимок не заменяется, личное представление не создаётся. Проверьте прежнюю ревизию и её данные через публичный API.

HTTP `503` с `reason=code=snapshot_commit_outcome_unknown` означает, что публикация или общий пересчёт отправили запись в Redis, но не получили однозначного ответа. Backend не повторяет запись и не включает общую паузу Redis из-за потери подтверждения. Нажмите **«Проверить текущий снимок»**: интерфейс перечитает публичный снимок с исходными root, шаблоном и параметрами. Сравните ревизию и данные. При ошибке чтения повтор останется заблокирован; подтверждённое чтение разрешает новое ручное действие без автоматической записи. Новая ревизия не доказывает, кто её записал. При работе через API выполните такое же чтение и сравните `cache.snapshotRevision` перед новым запросом записи. Если чтение тоже не удаётся, проверьте `/health/redis` и сопоставьте логи по `X-Request-ID`.

Перед публикацией Designer вызывает `GET /templates/{code}/publish`. Он отправляет полученный `publishBaseline` только если шаблон и черновик не изменились. Клиенты API также обязаны получить baseline для тех же root, шаблона и параметров. Backend атомарно сверяет поколение и предыдущее состояние ключа, в том числе при первой публикации. При `409 snapshot_publish_conflict` перечитайте текущее состояние и решите, нужна ли новая публикация; не повторяйте старый запрос. Ошибка чтения CMDBuild до записи (`502 snapshot_refresh_data_unavailable`) и явный отказ Redis запустить команду `EVAL` по ACL (`503 snapshot_storage_unavailable`) означают, что запись не выполнялась. Ошибка уже запущенного скрипта `EVAL` может оставить исход неопределённым.

Если в Redis используется ограничительный ACL, учётной записи backend нужна команда `TIME` в дополнение к уже разрешённым командам снимков. Она используется перед отправкой записи и внутри атомарного `EVAL` для проверки дедлайна.

Публичный поиск, строки и детали доступны только для итоговой таблицы отчёта. В личном и общем режиме пересчёт не выдаёт результат по устаревшей ревизии снимка. При `409` перечитайте снимок или снова откройте таблицу. События `report.table_prepared` и `report.table_page_failed` сопоставляются по `X-Request-ID`.

Публикация и пересчёт используют один бюджет REST-чтений на обычный результат, варианты фильтра и постраничные строки. Ошибка чтения Runtime settings возвращает `502 report_runtime_config_unavailable` до расчёта. Перед повтором проверьте класс настроек и ответ CMDBuild по `X-Request-ID`.

### Cache не обновляется

Проверить template cache settings, `RuntimeConfigJson.runtimeCache.refreshCooldownSec`, runtime response `cache.refreshAllowedAt`, а также тип запроса: read-only `GET run` или CSRF-protected `POST run` с `forceRefresh=true`.

Успешный `cache.status=bypass` с `cache.reason=access_probe_unconfirmed` означает, что проверка не подтвердила возможность использовать кэш. Результат прочитан под текущей сессией с теми же лимитами, без чтения и записи кэша результатов. Принудительное обновление не отменяет это решение.

Динамические отчёты с чтением связей используют `cache.scopeMode=privateUser`, даже если для шаблона включён общий кэш. Повторное чтение возможно только для того же пользователя и контекста доступа и не продлевает срок записи. Изменение прав на связи в CMDBuild может стать заметно только по истечении срока или после принудительного обновления. При повторном расчёте явный отказ CMDBuild в чтении данных завершает запрос ошибкой без выдачи прежнего результата.

Явный отказ также отзывает приватную запись: расчёт, начатый до отзыва, не может её восстановить. При настроенном `visibilityHash` первая страница карточек не считается доказательством общей видимости. Если проверка не покрывает весь набор, доступный расчёту, используется приватный кэш.

### Designer не сохраняет templates

Проверить CMDBuild CRUD grants на technical classes, same-origin headers, `X-CMDBDynamicPages-CSRF` и `Content-Type: application/json`.

Если ответ содержит `State-changing custom API calls require a same-origin Origin or Referer header.`, проверить в browser Network, что `Origin` и `Referer` имеют `CMDP_PUBLIC_ORIGIN`, а не internal upstream hostname. Если same-origin проверка проходит, следующей ожидаемой проверкой будет валидный `X-CMDBDynamicPages-CSRF`.
