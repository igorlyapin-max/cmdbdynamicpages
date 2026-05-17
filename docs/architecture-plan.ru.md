# Архитектурный план cmdbdynamicpages

Русская ветка архитектурной документации. Английская версия: [architecture-plan.md](architecture-plan.md).

## Цель

`cmdbdynamicpages` предоставляет механизм динамических страниц CMDBuild:

- редактор шаблонов, в котором пользователь подготавливает сложную выборку и визуализацию;
- runtime, который запускает шаблон по URL и показывает итоговые таблицы;
- хранение шаблонов и настроек в технических классах CMDBuild;
- выполнение CMDBuild REST запросов под авторизацией текущего пользователя либо выдачу опубликованного static snapshot из Redis.

## Runtime-архитектура

Custom page внутри CMDBuild используется только как launcher. Он не содержит сложный UI и не обрабатывает бизнес-логику.

Поток:

```text
Browser -> CMDBuild UI custom page -> /cmdbuild/dynamicpages/ui/designer
Browser -> /cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
Runtime UI -> GET /cmdbuild/custom-api/templates/<templateCode>/run
Backend -> CMDBuild REST /cmdbuild/services/rest/v3/*
Backend -> Redis
```

Порты локального контура:

```text
CMDBuild            127.0.0.1:8090
cmdbdynamicpages    127.0.0.1:8093
Wiki                localhost:3000
Nginx same-origin   localhost:8088
Redis               127.0.0.1:6379
```

## Reverse Proxy

Backend-owned UI:

```text
/cmdbuild/dynamicpages/ui/designer
/cmdbuild/dynamicpages/ui/designer/<section>
/cmdbuild/dynamicpages/ui/run/<templateCode>
```

Backend API:

```text
/cmdbuild/custom-api/*
```

Обычные `/cmdbuild/*` запросы проксируются в CMDBuild на `8090`. Маршруты dynamicpages обслуживаются проектным backend на `8093`.

Для wiki iframe используется nginx same-origin front на `8088`:

```text
http://localhost:8088/                 -> wiki localhost:3000
http://localhost:8088/cmdbuild/*       -> dynamicpages/CMDBuild chain on 8093
http://localhost:8088/health/*         -> dynamicpages health on 8093
```

## Безопасность сессии CMDBuild

Браузер не читает `CMDBuild-Authorization`, потому что cookie `HttpOnly`. Backend получает cookie автоматически на same-origin маршрутах под `/cmdbuild`, извлекает значение на сервере и вызывает CMDBuild REST с заголовком `CMDBuild-Authorization`.

Ограничения:

- cookie/token не логируются;
- generic REST proxy отсутствует;
- state-changing backend вызовы требуют same-origin `Origin`/`Referer` и `X-CMDBDynamicPages-CSRF`;
- runtime iframe использует read-only `GET run`, чтобы не требовать CSRF;
- static snapshot явно предупреждает редактора, что результат будет отдаваться без проверки прав зрителя на исходные объекты.

## Redis и кэш runtime

Redis используется как production storage для:

- runtime result cache;
- static snapshot страниц;
- координации in-flight runtime build.

Шаблон управляет cache behavior через `spec.cache`:

```json
{
  "enabled": true,
  "scopeMode": "permissionOnly",
  "probeMode": "usedFieldsOnly",
  "shareMode": "endpoint",
  "ttlSeconds": 28800,
  "allowManualRefresh": true
}
```

TTL шаблона хранится в секундах, но Designer показывает его в часах. Дефолт новых шаблонов: 8 часов.

Режимы:

- `permissionOnly` - общий endpoint cache после проверки доступа к реально используемым классам/атрибутам;
- `visibilityHash` - добавляет hash видимых card id;
- `privateUser` - кэш изолирован по пользователю/сессии;
- `disabled` - runtime result cache отключен.

Системный cooldown ручного refresh хранится в `RuntimeConfigJson.runtimeCache.refreshCooldownSec`.

## Redis password

Production Redis должен требовать пароль. Backend поддерживает три способа передачи секрета:

```text
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDBDYNAMIC_REDIS_PASSWORD=<secret>
CMDBDYNAMIC_REDIS_URL=redis://:password@redis-host:6379/0
```

Предпочтительно использовать `CMDBDYNAMIC_REDIS_PASSWORD_FILE`. Секреты не хранятся в git. Health/status ответы возвращают Redis URL только в замаскированном виде.

## Production health checks

Endpoint'ы:

```text
/health/live
/health/ready
/health/redis
/cmdbuild/custom-api/health/live
/cmdbuild/custom-api/health/ready
/cmdbuild/custom-api/health/redis
```

Смысл:

- `/health/live` - процесс отвечает на HTTP;
- `/health/redis` - строгий Redis `PING`, `503` при недоступности;
- `/health/ready` - process + Redis + CMDBuild upstream, `503` при неготовности.

Настройки:

```text
CMDBDYNAMIC_HEALTH_TIMEOUT_MS=2000
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
```

`/cmdbuild/custom-api/cache/status` не является readiness: это диагностика Redis/memory fallback и она может возвращать `200` при fallback.

## Технический root

Root по умолчанию:

```text
Cst_QueryTool
```

Классы:

```text
Cst_QueryToolConfig
Cst_QueryTemplate
Cst_QueryTemplateVersion
Cst_QueryExecutionLog
```

Root ограничивает только технические классы проекта. Бизнес-данные выбираются из обычных CMDBuild классов в рамках прав текущего пользователя.

## Хранение настроек

`Cst_QueryToolConfig.RuntimeConfigJson` хранит:

- executor limits;
- system manual refresh cooldown;
- runtime defaults.

Raw JSON в UI не показывается: Designer редактирует настройки через описанные поля.

`Cst_QueryTemplate.SpecJson` хранит DSL шаблона, включая:

- входные переменные;
- выборки `ВыборкаX`;
- сопоставление объектов;
- итоговые данные;
- визуализацию;
- cache policy;
- publication mode.

## Права редактора

Редактор определяется правами CMDBuild на технический класс `Cst_QueryTemplate`. Отдельная ACL внутри проекта не ведется.

Обычный runtime пользователь должен иметь:

- чтение custom page;
- чтение `Cst_QueryTool`, `Cst_QueryToolConfig`, `Cst_QueryTemplate`, `Cst_QueryTemplateVersion`;
- права на бизнес-объекты, которые он должен видеть;
- при `POST run`/preview может потребоваться запись в `Cst_QueryExecutionLog`, но iframe runtime использует `GET run` и не пишет audit card.

## Designer UI

Designer расположен по адресу:

```text
/cmdbuild/dynamicpages/ui/designer
```

Основные разделы:

- список шаблонов;
- создание/копирование шаблона;
- входные переменные;
- группа объектов;
- сопоставление с объектами;
- итоговые данные;
- визуализация;
- кэширование;
- публикация;
- настройки;
- прогон.

Новая сессия открывает список шаблонов без авто-выбора первого шаблона.

## DSL

Исполняемый DSL является declarative JSON, а не JavaScript/SQL/CQL. Backend поддерживает операции:

- `findClassesByAttributeType`;
- `extractVariables`;
- `selectCards`;
- `expandRelations`;
- `composeRows`;
- `filterRows`;
- `intersectRows`;
- `joinRows`;
- `matchRows`;
- model/domain operations.

Executor ограничивает число строк, классов, доменов, REST-вызовов и глубину раскрытия связей.

## Backend API

Основные endpoint'ы:

```text
GET  /cmdbuild/custom-api/session
GET  /cmdbuild/custom-api/model/catalog
GET  /cmdbuild/custom-api/model/classes
GET  /cmdbuild/custom-api/model/classes/:className
GET  /cmdbuild/custom-api/model/classes/:className/attributes
GET  /cmdbuild/custom-api/model/domains
GET  /cmdbuild/custom-api/model/domains/:domainName
GET  /cmdbuild/custom-api/auth/capabilities
GET  /cmdbuild/custom-api/auth/permission-scope
GET  /cmdbuild/custom-api/csrf
GET  /cmdbuild/custom-api/schema
POST /cmdbuild/custom-api/schema/bootstrap
GET  /cmdbuild/custom-api/config
PUT  /cmdbuild/custom-api/config
GET  /cmdbuild/custom-api/templates
POST /cmdbuild/custom-api/templates
GET  /cmdbuild/custom-api/templates/:code
PUT  /cmdbuild/custom-api/templates/:code
DELETE /cmdbuild/custom-api/templates/:code
POST /cmdbuild/custom-api/templates/:code/validate
POST /cmdbuild/custom-api/templates/:code/preview
GET  /cmdbuild/custom-api/templates/:code/run
POST /cmdbuild/custom-api/templates/:code/run
POST /cmdbuild/custom-api/templates/:code/publish
POST /cmdbuild/custom-api/draft/validate
POST /cmdbuild/custom-api/draft/preview
```

## Runtime flow

Пользователь открывает:

```text
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

Runtime UI вызывает:

```text
GET /cmdbuild/custom-api/templates/<templateCode>/run?param=value
```

Backend:

1. Загружает шаблон из `Cst_QueryTemplate`.
2. Проверяет параметры.
3. Проверяет cache policy.
4. Делает permission/visibility probe при необходимости.
5. Возвращает cache hit либо выполняет DSL через CMDBuild REST.
6. Форматирует таблицы для Runtime UI.

## Архитектурные артефакты

Формализованные артефакты ведутся в [../aa](../aa/README.md) относительно этого файла:

- бизнес-процессы;
- информационная модель;
- deployment;
- OpenAPI;
- healthcheck map;
- secrets map;
- event logging map;
- metrics map;
- async/Kafka applicability notes.
