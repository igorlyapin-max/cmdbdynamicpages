# Карта регистрации событий

| ID | Поток | Событие | Где регистрируется | Состав данных | ИБ-замечание |
| --- | --- | --- | --- | --- | --- |
| LOG-001 | IF-007 | Загрузка custom page launcher | `/cmdbuild/custom-api/client-log` memory log | timestamp, stage, href | Cookie/token не пишутся |
| LOG-002 | IF-007 | Redirect launcher -> Designer/Runtime | `/cmdbuild/custom-api/client-log` memory log | timestamp, target URL, href | URL параметры могут быть бизнес-параметрами; не писать secrets |
| LOG-003 | IF-003 | Proxy request CMDBuild UI | `/cmdbuild/custom-api/proxy-log` memory log | method, path, referer, userAgent | Headers/cookies не пишутся |
| LOG-004 | IF-004 | Preview шаблона | structured logger `template.executed` / `template.execution_failed` | requestId, action, templateCode, username, rowsCount, status/error | Параметры запуска и CMDBuild token не пишутся |
| LOG-005 | IF-004 | Direct `POST run` / iframe `GET run` | structured logger `template.executed` / `runtime.cache_result` / `template.execution_failed` | requestId, action, templateCode, username, rowsCount, cache status, status/error | Runtime rows и cookie/token не пишутся |
| LOG-006 | IF-004 | Save/update шаблона | `Cst_QueryTemplateVersion` | TemplateCode, Version, SpecJson, ChangedBy, ChangedAt, ChangeComment | SpecJson может содержать бизнес-логику, но не должен содержать secrets |
| LOG-007 | IF-005 | Redis недоступен | backend stderr/container logs + `/health/redis` response | error message, timestamp | Redis password маскируется |
| LOG-008 | IF-004 | CMDBuild upstream недоступен | backend stderr/container logs + `/health/ready` response | status/error, latency | CMDBuild token отсутствует в health |
| LOG-009 | IF-003 | CSRF rejection | API response + backend logs при наличии runtime логирования окружения | HTTP 403, route | CSRF token не логировать |
| LOG-010 | IF-003/IF-004 | HTTP request завершен | structured logger `stdout`/syslog | requestId, method, masked path, statusCode, durationMs, route, sessionHash | Cookie и authorization headers не пишутся; query secrets маскируются |
| LOG-011 | IF-004/IF-005 | Runtime cache hit/miss/refresh | structured logger `runtime.cache_result` | templateCode, username, cache status, backend, scope, rowsCount | Результирующие строки таблиц не пишутся |
| LOG-012 | IF-004/IF-005 | Static snapshot publish/hit/miss | structured logger `snapshot.*` | templateCode, username, backend, key/hash, rowsCount, paramsMode | Исходные CMDBuild-объекты и runtime rows не пишутся |
| LOG-013 | IF-004 | Create/update/delete шаблона | structured logger `template.*` + `Cst_QueryTemplateVersion` | templateCode, username, cmdbuildStatus, versionLogged | `SpecJson` хранится в version class, но не пишется в операционный лог |
| LOG-014 | IF-009 | Передача логов в ELK/SIEM | stdout/syslog -> collector | JSON event или RFC5424-like syslog message | Прямого подключения приложения к Elasticsearch нет |
| LOG-015 | IF-010 | Designer assistant draft | structured logger `assistant.template_draft.*` | requestId, username/session hash, model, status/error | Prompt context, LiteLLM API key, cookie/token и CSRF token не пишутся |

## Обязательные события ИБ

- Отказ CSRF/same-origin проверки для state-changing API.
- Недоступность Redis при `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true`.
- Недоступность CMDBuild upstream.
- Ошибка доступа к техническим классам CMDBuild.
- Публикация static snapshot, потому что результат может быть доступен без проверки прав зрителя на исходные объекты.

## Ограничения текущей реализации

Memory diagnostic logs ограничены по размеру и не заменяют централизованный аудит. Для production structured logs backend пишутся в `stdout` или syslog и должны собираться штатной системой логирования контура. ELK подключается через Docker/Filebeat/Fluent Bit/Logstash collector; прямого output в Elasticsearch из приложения нет.
