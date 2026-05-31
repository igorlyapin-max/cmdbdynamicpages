# Инструкция развертывания

Русская ветка. English branch: [deployment-guide.md](deployment-guide.md).

## 1. Предварительные условия

- CMDBuild доступен, локально по умолчанию `http://127.0.0.1:8090/cmdbuild`.
- `cmdbdynamicpages` backend/proxy запускается на `http://127.0.0.1:8093`.
- Redis доступен на `redis://127.0.0.1:6379/0`; в production пароль обязателен.
- Для iframe/wiki используется same-origin nginx front `http://localhost:8088`.
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
CMDBUILD_ORIGIN=http://127.0.0.1:8090
CMDBDYNAMIC_REDIS_URL=redis://127.0.0.1:6379/0
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true
CMDBDYNAMICPAGES_CSRF_SECRET=<stable external secret>
CMDP_LOG_TARGET=stdout
CMDP_LOG_FORMAT=json
```

В репозитории есть backend `Dockerfile` для container deployment. Образ запускается от пользователя `node`, слушает `8093` и использует `/health/live` как container healthcheck.

Если платформа передает Redis secret только строкой, поддерживаются варианты:

```text
CMDBDYNAMIC_REDIS_PASSWORD=<secret>
CMDBDYNAMIC_REDIS_URL=redis://:password@redis-host:6379/0
```

Любой из этих вариантов должен приходить из deployment secret/env уровня контура, а не из git. Приоритет у `CMDBDYNAMIC_REDIS_PASSWORD_FILE`, затем `CMDBDYNAMIC_REDIS_PASSWORD`, затем пароль внутри `CMDBDYNAMIC_REDIS_URL`.

## 3. Redis

Для dev:

```bash
docker compose -f docker-compose.nginx.yml up -d redis
```

Production Redis должен быть защищен паролем. Предпочтительно передавать пароль через `CMDBDYNAMIC_REDIS_PASSWORD_FILE`; если используется строковая передача секрета, задавать `CMDBDYNAMIC_REDIS_PASSWORD` или password в `CMDBDYNAMIC_REDIS_URL` только через secret/env платформы. Не хранить секрет в git или compose-файле репозитория.

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

Интеграция `cmdbaa` через `POST /cmdbuild/custom-api/templates/<templateCode>/baa-verify` использует те же runtime-права CMDBuild. В настройках endpoint указывайте абсолютный URL на reverse proxy `cmdbdynamicpages`, например `http://127.0.0.1:8093/cmdbuild/custom-api/templates/netverify/baa-verify`; относительный path в `cmdbaa` резолвится от его `CMDBUILD_ORIGIN`. Browser-вызовы используют CMDBuild session cookie и `X-CMDBDynamicPages-CSRF`; server-to-server вызов `cmdbaa` может передавать текущий `CMDBuild-Authorization` header.

## 7. Nginx same-origin front

Локальный запуск:

```bash
npm run nginx:dev
```

Ключевые маршруты:

```text
http://localhost:8088/cmdbuild/ -> http://127.0.0.1:8093/cmdbuild/
http://localhost:8088/health/  -> http://127.0.0.1:8093/health/
http://localhost:8088/         -> http://127.0.0.1:3000/
```

Так wiki и runtime iframe оказываются на одном origin `localhost:8088`.

## 8. Проверки после развертывания

```bash
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

`/health/ready` в production должен видеть Redis и CMDBuild upstream. `/metrics` отдает агрегированные Prometheus counters/gauges и не должен использоваться как readiness gate.

## 9. Production notes

- Не включать generic REST proxy.
- Не логировать `cookie`, `authorization`, `CMDBuild-Authorization`, CSRF tokens и Redis password.
- State-changing API должны проходить same-origin + CSRF.
- Задавать `CMDBDYNAMICPAGES_CSRF_SECRET` из стабильного внешнего secret; random fallback предназначен только для local/dev.
- Включать `CMDBDYNAMIC_REDIS_REQUIRED=true` для production scale-out или когда static snapshots входят в service contract.
- Redis RDB snapshot нужен для static snapshot страниц.
- Если static snapshot отсутствует в Redis, runtime отдаст сообщение `Страница отсутствует для загрузки`; администратор должен заново опубликовать снимок.
