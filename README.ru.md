# cmdbdynamicpages

Русская ветка документации. Английская ветка остается в [README.md](README.md), архитектурные артефакты лежат в [aa/](aa/README.md).

Проект решает две задачи:

- Designer UI для подготовки шаблонов динамических страниц и хранения их JSON-описаний в технических классах CMDBuild;
- Runtime UI для запуска шаблона по URL и вывода результата таблицами в рамках прав текущего пользователя CMDBuild либо как опубликованный статический снимок.

Пошаговая инструкция развертывания: [docs/deployment-guide.ru.md](docs/deployment-guide.ru.md).

## Текущая архитектура

CMDBuild custom page оставлен тонким launcher-компонентом. Он не содержит сложный UI, а перенаправляет браузер на backend-owned маршруты проекта:

```text
/cmdbuild/dynamicpages/ui/designer
/cmdbuild/dynamicpages/ui/designer/<section>
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

Все маршруты находятся под `/cmdbuild`, поэтому браузер автоматически отправляет `HttpOnly` cookie CMDBuild. JavaScript не читает и не пересылает `CMDBuild-Authorization`; backend получает cookie на same-origin маршруте и сам вызывает CMDBuild REST с серверным заголовком `CMDBuild-Authorization`.

Срок жизни пользовательской сессии задает CMDBuild/Tomcat, а не `cmdbdynamicpages`. На текущем стенде server-side idle timeout составляет 30 минут неактивности. Ориентировочный блок настройки находится в Tomcat `web.xml`:

```xml
<session-config>
    <session-timeout>30</session-timeout>
</session-config>
```

Значение указывается в минутах. Это не TTL runtime-кэша шаблона: cookie может оставаться в браузере, но backend все равно проверяет `/sessions/current`, и после истечения CMDBuild-сессии пользователь должен авторизоваться заново.

Компоненты разработки:

```text
CMDBuild UI/REST          http://127.0.0.1:8090
cmdbdynamicpages proxy    http://127.0.0.1:8093
wiki                      http://localhost:3000
nginx same-origin front   http://localhost:8088
Redis                     redis://127.0.0.1:6379/0
```

Порты при пересборке не меняем.

## Custom Page

Файл custom page:

```text
src/CmdbDynamicPages.js
```

Прямой вход через CMDBuild launcher:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpMode=designer#custompages/CmdbDynamicPages
```

Если `cmdpTemplate` не задан, launcher открывает Designer. Если `cmdpTemplate` задан, launcher открывает Runtime:

```text
http://127.0.0.1:8093/cmdbuild/ui/?cmdpTemplate=testtemplate&city=city49#custompages/CmdbDynamicPages
```

Предпочтительные прямые URL:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/testtemplate?city=city49
```

## Запуск разработки

Backend/proxy:

```bash
npm run proxy:dev
```

Redis:

```bash
docker compose -f docker-compose.nginx.yml up -d redis
```

Nginx для same-origin iframe:

```bash
npm run nginx:dev
```

Проверки:

```bash
npm test
npm run test:static
npm run test:unit
npm run test:api
npm run test:ui
npm run test:nginx
npm run check
npm run diag
npm run e2e
npm run e2e:write
npm run e2e:limited
npm run nginx:test
```

`npm test` выполняет syntax check, статическую проверку OpenAPI/ссылок `aa/` и unit-тесты. `test:unit` покрывает ключи runtime cache, cooldown refresh, defaults параметров, IPv4-сравнения, dependency map и маскирование логов. `test:api` является smoke-контрактом для уже запущенного proxy на `8093`; если proxy недоступен, тесты помечаются как skipped. `test:ui` запускает skip-safe Playwright smoke, только если Playwright установлен и есть валидная CMDBuild cookie. `test:nginx` проверяет nginx config и same-origin wiki/iframe маршруты через `localhost:8088`.

## Redis и секреты

Для production Redis должен быть защищен паролем. Пароль не хранится в git и не должен попадать в compose-файлы репозитория. Предпочтительная настройка:

```text
CMDBDYNAMIC_REDIS_URL=redis://127.0.0.1:6379/0
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
```

Поддерживаются также:

```text
CMDBDYNAMIC_REDIS_PASSWORD=<secret>
CMDBDYNAMIC_REDIS_URL=redis://:password@redis-host:6379/0
```

`CMDBDYNAMIC_REDIS_PASSWORD_FILE` имеет приоритет как production-вариант. `CMDBDYNAMIC_REDIS_PASSWORD` и пароль внутри URL удобны для локальных проверок, но не являются предпочтительным способом хранения секрета. Health/status ответы маскируют Redis credentials и не возвращают пароль.

Redis используется для:

- runtime result cache;
- опубликованных static snapshot страниц;
- координации fallback-состояния backend cache.

Если Redis недоступен в dev, backend может использовать memory fallback. В production readiness считает Redis обязательным, если `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED` не установлен в `false`.

## Health и readiness

Endpoint'ы без авторизации:

```text
GET /health/live
GET /health/ready
GET /health/redis
GET /cmdbuild/custom-api/health/live
GET /cmdbuild/custom-api/health/ready
GET /cmdbuild/custom-api/health/redis
```

Смысл:

- `/health/live` возвращает `200`, если Node-процесс отвечает на HTTP.
- `/health/redis` делает строгий Redis `PING`; при недоступности Redis возвращает `503`.
- `/health/ready` проверяет процесс, Redis и CMDBuild upstream; при проблеме возвращает `503`.
- `/cmdbuild/custom-api/cache/status` остается диагностикой и может возвращать `200` даже при fallback на memory.
- `/cmdbuild/custom-api/logging/status` показывает текущий log level, target и правила маскирования без секретов.

Настройки:

```text
CMDBDYNAMIC_HEALTH_TIMEOUT_MS=2000
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
```

## Логирование

Backend пишет структурированные операционные логи. Для Docker-установок основной режим - `stdout`: дальше поток забирает Docker logging driver, Filebeat, Fluent Bit или Logstash и передает в ELK. Прямой output в Elasticsearch из приложения не используется.

```text
CMDP_LOG_LEVEL=info
CMDP_LOG_FORMAT=json
CMDP_LOG_TARGET=stdout
CMDP_LOG_REDACT_HEADERS=cookie,authorization,cmdbuild-authorization,x-csrf-token,x-cmdbdynamicpages-csrf,set-cookie
CMDP_LOG_REDACT_QUERY=password,passwd,pwd,token,secret,authorization,auth,csrf,x-cmdbdynamicpages-csrf
```

Syslog включается отдельно для VM/bare-metal или SIEM:

```text
CMDP_LOG_TARGET=syslog
CMDP_SYSLOG_HOST=127.0.0.1
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp
CMDP_SYSLOG_FACILITY=local0
```

Если нужны оба канала, можно указать `CMDP_LOG_TARGET=stdout,syslog`. В логи попадают завершение HTTP-запросов, CSRF/same-origin отказы, изменение доступности Redis, ошибки CMDBuild upstream, runtime cache hit/miss/refresh, static snapshot publish/hit/miss и create/update/delete шаблонов. Cookie, authorization headers, CSRF token и secret-like query параметры маскируются. Runtime-строки результата и payload карточек CMDBuild в операционные логи не пишутся.

## Designer

Основной URL:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer
```

Разделы Designer являются отдельными route, а не якорями одной страницы:

```text
/cmdbuild/dynamicpages/ui/designer/templates
/cmdbuild/dynamicpages/ui/designer/template
/cmdbuild/dynamicpages/ui/designer/params
/cmdbuild/dynamicpages/ui/designer/object-group
/cmdbuild/dynamicpages/ui/designer/matching
/cmdbuild/dynamicpages/ui/designer/final-view
/cmdbuild/dynamicpages/ui/designer/visualization
/cmdbuild/dynamicpages/ui/designer/cache
/cmdbuild/dynamicpages/ui/designer/general-settings
/cmdbuild/dynamicpages/ui/designer/settings
/cmdbuild/dynamicpages/ui/designer/run
```

Новая сессия Designer открывается со списка шаблонов. Первый шаблон автоматически не выбирается.

Вверху каждого route есть закрепленная контекстная кнопочная строка. Кнопки уровня страницы, например применить, сохранить, прогнать, опубликовать, открыть диагностику или сохранить настройки, остаются сверху и не уезжают вниз длинной формы.

Designer умеет:

- создавать шаблон по коду и описанию;
- копировать новый шаблон из существующего;
- редактировать входные переменные;
- строить одну или несколько `ВыборкаX`;
- сопоставлять выборки между собой;
- задавать итоговые данные;
- настраивать визуализацию;
- задавать cache-политику конкретного шаблона;
- прогонять шаблон в редакторе и в отдельной runtime-странице.

## Шаблоны

Шаблон хранится в CMDBuild классе `Cst_QueryTemplate`.

Основные поля:

```text
Code              код шаблона для runtime URL
Description       описание
SpecJson          исполняемый DSL
ParamsSchemaJson  дополнительная схема параметров
ResultSchemaJson  дополнительная схема результата
```

Входные переменные задаются в `spec.params`:

```json
{
  "params": {
    "city": {
      "type": "string",
      "required": true,
      "example": "city49",
      "description": "Код города"
    }
  }
}
```

Необязательная входная переменная обязана иметь default/defaultValue. Если пользователь не передал значение, Runtime использует default.

## Runtime

Runtime URL:

```text
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

Runtime вызывает read-only endpoint:

```text
GET /cmdbuild/custom-api/templates/<templateCode>/run?param=value
```

Для dynamic шаблонов выполнение идет под правами текущего пользователя CMDBuild. Для static snapshot шаблонов Runtime читает опубликованный результат из Redis; права зрителя на исходные CMDBuild-объекты не проверяются, поэтому Designer требует явного подтверждения режима публикации.

## Кэширование

Настройки кэша живут в шаблоне:

```json
{
  "cache": {
    "enabled": true,
    "scopeMode": "permissionOnly",
    "probeMode": "usedFieldsOnly",
    "shareMode": "endpoint",
    "ttlSeconds": 28800,
    "allowManualRefresh": true
  }
}
```

Designer показывает TTL в часах. Значение по умолчанию для новых шаблонов: 8 часов (`28800` секунд).

Режимы:

- `permissionOnly` - быстрый режим по умолчанию; общий endpoint cache после lightweight probe по реально используемым классам/атрибутам.
- `visibilityHash` - добавляет hash видимых card id для учета row-level scope.
- `privateUser` - изоляция кэша по пользователю/сессии.
- `disabled` - кэш runtime результата выключен.

Системный cooldown ручного refresh хранится в `Cst_QueryToolConfig.RuntimeConfigJson.runtimeCache.refreshCooldownSec`. В Runtime cache UI компактный: в header таблицы название остается слева, а поиск и иконка `⟳` прижаты справа на том же уровне; подробности кэша показываются в tooltip по hover/focus.

Preview в Designer отделен от кэша сохраненного runtime результата: `Визуализировать в редакторе` вызывает `/draft/preview` по текущему черновику и не читает final runtime cache. В разделе `Прогон` также есть `Обновить кэш и показать`: это `POST run` сохраненного шаблона с `forceRefresh=true`, он перестраивает runtime cache без пользовательского cooldown и требует CSRF, поэтому iframe/read-only `GET run` не может обходить таймер.

## Техническая схема CMDBuild

Технический root по умолчанию:

```text
Cst_QueryTool
```

Технические классы:

```text
Cst_QueryToolConfig
Cst_QueryTemplate
Cst_QueryTemplateVersion
Cst_QueryExecutionLog
```

Root относится только к техническим классам проекта. Он не ограничивает business-data запросы: шаблоны выполняются в рамках прав текущего пользователя CMDBuild.

## Ограничения безопасности

- Нет generic REST proxy к CMDBuild.
- State-changing API требует same-origin `Origin`/`Referer` и `X-CMDBDynamicPages-CSRF`.
- Runtime iframe использует read-only `GET run`, поэтому CSRF token ему не нужен.
- Cookie и CMDBuild token не логируются.
- Redis password хранится только как deployment secret.
- Static snapshot режим требует явного предупреждения, потому что публикует результат из-под автора снимка.

## Документация

- [English README](README.md)
- [Архитектурный план](docs/architecture-plan.ru.md)
- [Roadmap](docs/roadmap.ru.md)
- [Архитектурные артефакты](aa/README.md)
