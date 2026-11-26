# Инструкция развертывания

Русская ветка. English branch: [deployment-guide.md](deployment-guide.md).

## 1. Предварительные условия

- CMDBuild доступен, локально по умолчанию `http://127.0.0.1:8090/cmdbuild`.
- `cmdbdynamicpages` backend/proxy запускается на `http://127.0.0.1:8093`.
- Redis доступен на `redis://127.0.0.1:6379/0`; в production пароль обязателен.
- Project-only nginx front доступен по `http://localhost:8088` и обслуживает только `/cmdbuild/*` и `/health/*`.
- Для первого создания схемы нужен CMDBuild role с `admin_classes_modify` и доступом к metadata/classes API.
- Доступ к Designer равен доступу к технической схеме проекта: пользователь с правом редактировать технические классы может создавать и менять шаблоны runtime endpoints.

## 2. Backend/proxy

Локальный запуск:

```bash
npm run proxy:dev
```

Порт не менять: проект и инструкции ожидают `8093`.

Production env минимум:

```text
PROXY_HOST=127.0.0.1
PROXY_PORT=8093
CMDP_PUBLIC_ORIGIN=https://cmdb.example.local
CMDP_NGINX_PUBLIC_HOST=cmdb.example.local
CMDP_NGINX_PUBLIC_PROTO=https
CMDBUILD_ORIGIN=http://127.0.0.1:8090
CMDBDYNAMIC_REDIS_URL=rediss://redis.example.local:6380/0
CMDP_TLS_CA_FILE=
CMDP_TLS_CA_FILE_HOST=
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
CMDBDYNAMICPAGES_CSRF_SECRET=<stable external secret>
CMDP_LOG_TARGET=stdout
CMDP_LOG_FORMAT=json
CMDP_DIAGNOSTIC_MODE=off
```

В репозитории есть backend `Dockerfile` для container deployment. Образ запускается от пользователя `node`, слушает `8093` и использует `/health/live` только как liveness container healthcheck. Structured logs всегда поступают в stdout/stderr; дальнейшую доставку выполняет platform collector, agent или sidecar. `docker compose ... logs` подтверждает только local output; внешний маршрут проверяется `scripts/verify-platform-log-route.sh` и platform-owned запросом к collector. Базовый Compose не задаёт Docker logging driver или topology syslog.

Для прямой доставки приложением в syslog задать `CMDP_SYSLOG_HOST` и запустить явный overlay:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml -f docker-compose.syslog.yml up -d
```

Overlay устанавливает `CMDP_LOG_TARGET=stdout,syslog` и требует `CMDP_SYSLOG_HOST`; порт, protocol и facility настраиваются через `CMDP_SYSLOG_PORT`, `CMDP_SYSLOG_PROTOCOL` и `CMDP_SYSLOG_FACILITY`.
Production startup fail-closed, если не задан `CMDBDYNAMICPAGES_CSRF_SECRET` или `CMDP_PUBLIC_ORIGIN`. `CMDP_PUBLIC_ORIGIN` - публичный browser origin; `CMDBUILD_ORIGIN` - внутренний backend upstream и они могут различаться. `CMDP_NGINX_PUBLIC_HOST` и `CMDP_NGINX_PUBLIC_PROTO` должны совпадать с host[:port] и protocol `CMDP_PUBLIC_ORIGIN`; bundled nginx использует эти configured values, а не forwarding headers из запроса. `CMDP_DIAGNOSTIC_MODE=Verbose` включать только временно для incident diagnostics.
Admin-facing container handoff описан отдельно: [CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md).

Если платформа передает Redis secret только строкой, поддерживаются варианты:

```text
CMDBDYNAMIC_REDIS_PASSWORD=<secret>
CMDBDYNAMIC_REDIS_URL=redis://:password@redis-host:6379/0
```

Любой из этих вариантов должен приходить из deployment secret/env уровня контура, а не из git. Приоритет у `CMDBDYNAMIC_REDIS_PASSWORD_FILE`, затем `CMDBDYNAMIC_REDIS_PASSWORD`, затем пароль внутри `CMDBDYNAMIC_REDIS_URL`.

### Лимиты строк отчёта

| Переменная окружения | Значение по умолчанию и рекомендация | Что ограничивает |
| --- | ---: | --- |
| `CMDP_EXECUTION_MAX_ROWS_ABSOLUTE` | `2000` | Верхняя граница для настройки Designer **Строк в обычном отчёте** (`executionLimits.maxRowsMax`). Обычная публикация использует эту настройку, а не лимит по умолчанию для обычного запуска или предпросмотра. |
| `CMDP_LARGE_TABLE_MAX_ROWS` | `10000` | Общий бюджет исходных строк на постраничную таблицу, а не размер выдачи в браузер (по умолчанию 50, максимум 100 за запрос). |

Оба значения задаются положительными безопасными целыми числами (`1`–`9007199254740991`). `CMDP_LARGE_TABLE_MAX_ROWS` должен быть строго больше `CMDP_EXECUTION_MAX_ROWS_ABSOLUTE`. Значения по умолчанию применяются только при отсутствии переменных. Пустое значение или другая ошибка конфигурации не даёт backend запуститься. После изменения окружения перезапустите backend. В Compose пересоздайте контейнер `cmdbdynamicpages` с обновлённым `.env` и теми же overlays, что при развёртывании: `docker compose restart` не применяет изменения переменных окружения.

В основных настройках выполнения показаны строки в обычном отчёте, строки на странице, REST-запросы, читаемые карточки и текущий бюджет времени. Первые четыре можно изменить. Бюджет времени публикации и предпросмотра в Designer задаётся через `CMDP_DRAFT_PREVIEW_TIMEOUT_MS` и показан для справки. Технические ограничения вынесены отдельно и продолжают действовать; ранее сохранённые значения не сбрасываются. **Строк на странице** (`executionLimits.reportPageSize`, по умолчанию `50`, диапазон `1–100`) ограничивает размер страницы, а не результат отчёта.

Оставляйте рекомендуемые значения, пока замеры нагрузки не обоснуют повышение. Если отчёту нужно больше строк, чем допускает **Строк в обычном отчёте**, выберите **Итоговые данные → Большая таблица → Просмотр строк → Все строки, постранично**. Если бюджет большой таблицы уже исчерпан, сузьте выборку или разделите отчёт. В новых шагах «Группы объектов» оставляйте поле **Лимит** пустым, если выборке не нужно своё ограничение. Уже заданные лимиты шагов не переписываются и не удаляются. Если лимит делает результат неполным, публикация и пересчёт сообщают об этом вместо тихого усечения. Перед повышением лимитов проверьте [диагностику в runbook](runbook.ru.md#большая-таблица).

Потолок строк не повышает максимум прочитанных карточек, визуальные пределы D2 или бюджет сопоставления. При `maxMatchRuleChecks` сузьте обе входные выборки: за одно выполнение допускается до 5 000 000 проверок правил, независимо от числа найденных совпадений.

## 3. Redis

Для dev:

```bash
docker compose -f docker-compose.nginx.yml up -d redis
```

Production Redis должен быть защищен паролем и использовать `rediss://`. `CMDP_TLS_CA_FILE_HOST` и `CMDP_TLS_CA_FILE=/run/certs/cmdbdynamicpages-ca.pem` задают один read-only private-CA PEM bundle для Redis, CMDBuild и LiteLLM; задавать оба только когда system trust не покрывает internal PKI. Предпочтительно передавать пароль через `CMDBDYNAMIC_REDIS_PASSWORD_FILE`; если используется строковая передача секрета, задавать `CMDBDYNAMIC_REDIS_PASSWORD` или password в `CMDBDYNAMIC_REDIS_URL` только через secret/env платформы. Plaintext `redis://` остается поддержанным для local и существующих deployment, но в production backend пишет runtime warning `redis_plaintext_transport`. Не хранить secrets или CA material в git или compose-файле репозитория.

LiteLLM Assistant опционален. Оставляйте `LITELLM_API_KEY_FILE_HOST` пустым, если Assistant не используется: compose смонтирует `/dev/null`. При включенном Assistant путь обязан существовать до `docker compose up` и быть читаемым обычным файлом, иначе Docker может создать каталог вместо secret file. Проверка без вывода ключа:

```bash
test -f "$LITELLM_API_KEY_FILE_HOST" && test -r "$LITELLM_API_KEY_FILE_HOST"
docker compose -f docker-compose.runtime.yml exec cmdbdynamicpages sh -c 'test -f /run/secrets/cmdbdynamicpages_litellm_api_key && test -r /run/secrets/cmdbdynamicpages_litellm_api_key'
```

## 4. Регистрация custom page

Собрать zip:

```bash
npm run build:zip
```

Загрузить `dist/cmdbdynamicpages-custompage.zip` в CMDBuild custom pages с параметрами:

```text
name: CmdbDynamicPages
description: CMDB Dynamic Pages
alias: widget.cmdb-dynamic-pages
componentId: view.custompages.CmdbDynamicPages.CmdbDynamicPages
active: true
```

Проверочный launcher URL:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages
```

Прямой Designer URL:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer
```

## 5. Создание технической схемы

1. Войти в CMDBuild через proxy `8093` под административной ролью с `admin_classes_modify`.
2. Открыть Designer.
3. Перейти в меню `Управление схемой и настройками` -> `Схема`.
4. Указать:
   - технический root, например `Cst_QueryTool`;
   - описание root;
   - родительский суперкласс, под которым будет создан root.
5. Нажать `Проверить схему`.
6. Убедиться, что нет конфликтов.
7. Поставить подтверждение non-destructive bootstrap.
8. Нажать `Создать недостающее`.

Bootstrap создает только недостающие классы и атрибуты. Он не удаляет, не переносит и не меняет типы существующих объектов CMDBuild.

Администратор bootstrap должен иметь права CMDBuild на изменение модели классов: создание классов под выбранным parent superclass, создание атрибутов, чтение metadata classes/attributes и проверку существующей схемы. После bootstrap эту роль не нужно выдавать обычным редакторам шаблонов.

### Assistant Token Budget And Capture Policy

Per-root budget: `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.maxTokens`
(default `16384`). Каждый Assistant LiteLLM request передаёт effective значение как
`max_tokens`, ограниченное deployment env `CMDP_ASSISTANT_LLM_MAX_TOKENS_ABSOLUTE`
(default `131072`), поставляемым в runtime Compose. Изменение env требует пересоздания
backend. Provider context/output limits, byte budgets и timeout действуют независимо.
Старый `CMDP_ASSISTANT_MAX_TOKENS` не поддержан.

`assistant.diagnostics` хранит только policy: `captureDurationSec=900` (max `3600`),
`retentionSec=86400` (max `604800`), `maxBodyBytes=8388608`, `maxTraceBytes=33554432`,
`maxStoredBytes=268435456`. Фактический capture `Off|Basic|Verbose` default `Off`,
временно включается admin API в Redis per root для всех его пользователей.
Сохранение policy и restart не включают и не продлевают capture. Защитить Redis и
exports; redaction до записи, тела не идут в stdout. Это не замена обязательного
operational log sink. См. [Assistant capture](runbook.ru.md#assistant-capture).

## 6. Права CMDBuild

Редакторам шаблонов нужны права чтения/создания/изменения на технические классы:

```text
<Root>QueryTemplate
<Root>QueryTemplateVersion
<Root>QueryToolConfig
```

Это и есть основной контроль доступа к Designer: если пользователь может открыть Designer и писать в `QueryTemplate`/`QueryToolConfig`, он может изменить поведение runtime endpoints. Поэтому доступ редакторов должен выдаваться тем же процессом, которым управляются права на технические классы CMDBuild.

Runtime-пользователям нужны:

```text
read на <Root>QueryTemplate
read на <Root>QueryTemplateVersion
read на custom page CmdbDynamicPages
```

Бизнес-данные читаются только в правах текущего пользователя CMDBuild.

Опциональный LiteLLM assistant не участвует в runtime rendering. Включайте его только для генерации черновиков в Designer через `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.enabled`, `LITELLM_BASE_URL`, `CMDP_LITELLM_ALLOWED_BASE_URLS`, `LITELLM_MODEL` и `LITELLM_API_KEY_FILE` или `LITELLM_API_KEY`. API key не хранится в git и должен подаваться через механизм секретов контура. RuntimeConfig baseUrl вне server-side allowlist отклоняется до использования API key. `CMDP_ASSISTANT_ENABLED` deprecated и больше не блокирует assistant calls. Настройки Assistant MCP хранятся в `Cst_QueryToolConfig.RuntimeConfigJson.assistant.mcp`; `assistant.mcp.timeoutMs` (1000-60000 ms) ограничивает весь этап сбора MCP-контекста и одну LiteLLM-попытку. При достижении deadline backend возвращает частичный контекст с явным предупреждением и не запускает новые MCP-чтения. Для D2 interpretation допускаются до двух попыток. D2 mapping выполняется возобновляемыми этапами `roles` и `topology`: один HTTP-запрос делает ровно один LiteLLM-вызов, а browser автоматически один раз повторяет recoverable этап с тем же session-bound TTL checkpoint. После успешного `roles` подтверждённые данные переиспользуются для `topology`, поэтому повтор сопоставления связей не запрашивает объекты заново. Browser timeout покрывает одну LiteLLM-попытку и transport grace и остаётся меньше default nginx custom API timeout. Отмена browser request прекращает активный LiteLLM-вызов и освобождает execution slot. `CMDP_ASSISTANT_TIMEOUT_MS` не поддерживается. `/cmdbuild/custom-api/mcp` read-only, работает в правах текущего пользователя и должен оставаться недоступным без обычной CMDBuild cookie-сессии.

Несмотря на имя MCP, `assistant.mcp.timeoutMs` ограничивает и LiteLLM request, а не только MCP. Локальный deadline/abort и upstream HTTP `504` имеют разные причины: определяйте этап сбоя и владельца timeout по безопасной диагностике, не только по HTTP status. Recoverable retry D2 mapping использует тот же действующий checkpoint и завершённый результат `roles`; истёкший/невалидный checkpoint требует нового mapping. Retry не должен автоматически увеличивать timeout или лимиты каталога.

При ошибке Designer раскройте «Техническая диагностика» под сообщением: HTTP status и Request ID видны в заголовке даже у свернутого блока. Кнопка копирования передаёт безопасный отчёт с этапом, длительностью, относительным API-путём без query, клиентским и серверным Request ID, форматом ответа, доступными лимитами и подтверждённым checkpoint. Ответ `502` с HTML не определяет виновный upstream: сопоставляйте Request ID с журналами reverse proxy и backend. Отсутствие ответа, клиентский timeout и отмена обозначаются отдельно; deadline охватывает также чтение тела ответа. Фрагмент ответа ограничен 4 KiB, весь отчёт — 16 KiB; данные аутентификации, тела запросов, промты и Spec не включаются. Отчёт не сохраняется и не переносится на другой шаблон или операцию. Если браузер запрещает clipboard, выделите текст отчёта вручную.

«Применить цепочку» меняет черновик и не запускает выборку. Если открыть «Извлечение» до завершения Apply, дождитесь его окончания: запрос по старому черновику не отправляется. Чтобы проверить карточки до сохранения, выберите именованный результат и нажмите «Извлечь по шаблону». Интерфейс различает незапущенную выборку, ноль строк, отсутствие источника, ограниченный результат и ошибку. Для реального нуля проверьте класс, фильтры и видимость карточек под той же ролью CMDBuild.

При захвате `Basic` администратору доступны безопасные метаданные операций. Для Apply `Verbose` добавляет счётчики, но в обоих режимах трасса не содержит Spec, промтов, фильтров, параметров и сырых ошибок. Для «Извлечения» `Verbose` сохраняет структуру выполнения и лимиты без карточек и значений параметров. Обычные предпросмотры и выполнение опубликованных отчётов не захватываются. Если до обновления использовался `Verbose` для Apply, администратор может остановить захват и нажать «Очистить» в настройках диагностики Assistant: это удалит **все** сохранённые трассы выбранного корня, не меняя шаблоны. Уже скачанные файлы это действие не удаляет.

Распознавание класса использует техническое metadata `name`, а не `Code` карточки; точное исходное `description` или переведённое `_description_translation` имеет приоритет над частичным описанием. Отсутствие в bounded catalog не означает отсутствия в CMDBuild: явный технический identifier требует адресной проверки metadata в тех же правах, allowlist и оставшихся бюджетах. Неполный контекст или отказ доступа нужно сообщать явно, не подменяя класс молча. См. [метаданные Assistant](cmdbuild-assistant-metadata-guide.ru.md).

Раздел [Настройка LiteLLM и провайдера](CONTAINER_DEPLOYMENT_ADMIN_GUIDE.md#llm-connection-setup) описывает настройку с vLLM, OpenAI, OpenAI-compatible API или Ollama, различия между API-ключами, включение ассистента в Runtime-настройках и устранение неполадок.

Задайте `CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE=2097152` и `CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE=4194304` как deployment ceilings. Настройки `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.maxRequestBytes` (default `524288`) и `assistant.llm.maxResponseBytes` (default `1048576`) могут задавать меньшие лимиты, но server-side clamp не позволяет превысить absolute caps. В LiteLLM могут передаваться authoring literals из Assistant prompts, filters, D2 Notes, templates и mapping rules. Runtime rows, resolved parameter values, CMDBuild cards и raw D2 source автоматически не отправляются; они включаются только если пользователь явно помещает их в authoring text.

## 7. Nginx same-origin front

Локальный запуск:

```bash
npm run nginx:dev
```

Ключевые маршруты:

```text
http://localhost:8088/cmdbuild/ -> http://127.0.0.1:8093/cmdbuild/
http://localhost:8088/health/  -> http://127.0.0.1:8093/health/
http://localhost:8088/         -> 404
```

Этот nginx обслуживает только маршруты `cmdbdynamicpages`. Внешние порталы разворачиваются и проксируются отдельно.

В production с external TLS reverse proxy browser всегда открывает CMDBuild UI, custom page и `/cmdbuild/custom-api/*` через один `CMDP_PUBLIC_ORIGIN`, например `https://custom.example.local`. Задать `CMDP_NGINX_PUBLIC_HOST=custom.example.local` и `CMDP_NGINX_PUBLIC_PROTO=https`; bundled nginx передает только эти configured values и не доверяет client-supplied `Host` или forwarding headers. Internal `CMDBUILD_ORIGIN`, например `https://vr2.internal.example`, не публикуется пользователям. Проверить, что `/cmdbuild/ui/config.js`, redirects и CMDBuild session cookie используют public hostname, а не internal upstream.

Если контур разворачивается совместно с WikiAI, используйте дополнительные
договоренности из [wikiai-integration.ru.md](wikiai-integration.ru.md):
WikiAI индексирует только anonymous `staticSnapshot`, а `dynamicUser` runtime
остается live-контекстом текущего пользователя и не пишется в общий индекс.

## 8. Проверки после развертывания

```bash
npm run ci
npm run container:check
npm test
npm run test:api
npm run test:nginx
```

С валидной CMDBuild cookie:

```bash
npm run e2e
```

Health endpoints:

```text
http://127.0.0.1:8093/health/live
http://127.0.0.1:8093/health/ready
http://127.0.0.1:8093/health/redis
http://127.0.0.1:8093/metrics
```

`/health/live` - только liveness: он подтверждает, что Node process отвечает на HTTP, и используется Docker healthcheck. `/health/ready` - readiness: в production он должен видеть Redis и CMDBuild upstream до rollout или traffic routing. `/metrics` отдает агрегированные Prometheus counters/gauges и не должен использоваться как readiness gate.

## 9. Production notes

### Приёмка переноса шаблонов

- Backend и встроенный редактор должны обслуживаться одной обновлённой сборкой. Используются существующие same-origin JSON/CSRF pipeline и CMDBuild session; отдельные сервис, порт, LLM key и миграция БД не нужны.
- Export/prepare используют общий с Save лимит тела `TEMPLATE_REQUEST_MAX_BYTES`, настраиваемый через `CMDP_TEMPLATE_REQUEST_MAX_BYTES`, и существующие structural collection limits. Согласуйте лимит reverse proxy; превышение возвращает HTTP 413.
- Структурные бюджеты HTTP: `CMDP_INPUT_MAX_COLLECTION_ITEMS` (default 5000, absolute 50000) и `CMDP_INPUT_MAX_TOTAL_ITEMS` (default 50000, absolute 500000). Это не глобальные caps pure transfer module. Проверки каталога используют `executionLimits` назначения: по умолчанию `maxClassesDefault=100`, `maxDomainsDefault=100`, `maxRestCallsDefault=250`, `maxTraversalDepthMax=5`. Проверьте фактические `checks.summary.limits` и проблемы достижения бюджета: backend не расширяет поиск автоматически и не вызывает LLM.
- Окружения должны иметь одинаковую модель CMDBuild и права на шаблоны: чтение источника для экспорта, создание для нового, чтение/изменение назначения для замены. Различия модели показываются как проблемы проверки, автоматической миграции схемы нет.
- Проверьте экспорт несохранённых описания, схем, правок Diagram, D2 source и запросов Assistant. Скачивание не должно создавать/обновлять шаблон или версию.
- Отдельно проверьте Diagram → список → экспорт, приоритет всех четырёх источников defaults и замену затенённого ID: неподтверждённая активная зависимость не должна получить `executionReady:true`. Для DSL без visual models проверьте конечное поле вложенного reference/domain path. Изменение prompt во время запроса Assistant не должно оставлять кнопку подготовки заблокированной после завершения запроса.
- Импортируйте файл в режимах new/replace, проверьте проблемы и явные ID/URL overrides, подтвердите обязательные ссылки, сначала отмените применение, затем подтвердите staging. До обычного Save CMDBuild не меняется. Новый сохранённый шаблон неактивен; замена сохраняет identity/активность/историю назначения и отклоняет устаревший baseline hash.
- Пакет `needsAttention` с неполным/неподписанным сопоставлением остаётся доступен для редактирования и сохранения незавершённым. Готовность выполнения не должна подразумеваться; перенос не вызывает LLM и не публикует.
- Браузерная регрессия: `node tests/ui/template-transfer.test.mjs` (Playwright и системный Chrome либо `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). API в тесте замокирован; для поставленного контура отдельно выполните описанный выше сценарий с реальной авторизацией. Порядок действий и API: [README](../README.ru.md#экспорт--импорт), [OpenAPI](../aa/openapi.yaml).

- Не включать generic REST proxy.
- Не логировать `cookie`, `authorization`, `CMDBuild-Authorization`, CSRF tokens и Redis password.
- Держать `CMDP_DIAGNOSTIC_MODE=off` по умолчанию; `Basic` или временный `Verbose` включать только через deployment configuration.
- State-changing API должны проходить same-origin + CSRF и передавать `Content-Type: application/json`, если тело запроса JSON.
- Оставлять `CMDP_PROXY_ALLOWLIST_STRICT=true`, если только контролируемое развертывание явно не требует проксировать дополнительные CMDBuild paths.
- Применять reverse-proxy rate limiting, эквивалентный bundled nginx `limit_req` rules для `/cmdbuild/custom-api/`, `/cmdbuild/dynamicpages/` и общего `/cmdbuild/` traffic.
- Задавать `CMDBDYNAMICPAGES_CSRF_SECRET` из стабильного внешнего secret; random fallback предназначен только для local/dev.
- Включать `CMDBDYNAMIC_REDIS_REQUIRED=true` для production scale-out или когда static snapshots входят в service contract.
- Redis RDB snapshot нужен для static snapshot страниц.
- Если static snapshot отсутствует в Redis, runtime отдаст сообщение `Страница отсутствует для загрузки`; администратор должен заново опубликовать снимок.
