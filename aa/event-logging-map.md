# Карта регистрации событий

| ID | Поток | Событие | Где регистрируется | Состав данных | ИБ-замечание |
| --- | --- | --- | --- | --- | --- |
| LOG-001 | IF-007 | Загрузка custom page launcher | `/cmdbuild/custom-api/client-log` memory log | timestamp, stage, href | Cookie/token не пишутся |
| LOG-002 | IF-007 | Redirect launcher -> Designer/Runtime | `/cmdbuild/custom-api/client-log` memory log | timestamp, target URL, href | URL параметры могут быть бизнес-параметрами; не писать secrets |
| LOG-003 | IF-003 | Proxy request CMDBuild UI | `/cmdbuild/custom-api/proxy-log` memory log | method, path, referer, userAgent | Headers/cookies не пишутся |
| LOG-004 | IF-004 | Preview шаблона | `Cst_QueryExecutionLog` | TemplateCode, StartedAt, FinishedAt, Username, ExecutionStatus, RowsCount, ErrorMessage | Параметры запуска и CMDBuild token не пишутся |
| LOG-005 | IF-004 | Direct `POST run` | `Cst_QueryExecutionLog` | TemplateCode, StartedAt, FinishedAt, Username, ExecutionStatus, RowsCount, ErrorMessage | Iframe `GET run` audit card не пишет |
| LOG-006 | IF-004 | Save/update шаблона | `Cst_QueryTemplateVersion` | TemplateCode, Version, SpecJson, ChangedBy, ChangedAt, ChangeComment | SpecJson может содержать бизнес-логику, но не должен содержать secrets |
| LOG-007 | IF-005 | Redis недоступен | backend stderr/container logs + `/health/redis` response | error message, timestamp | Redis password маскируется |
| LOG-008 | IF-004 | CMDBuild upstream недоступен | backend stderr/container logs + `/health/ready` response | status/error, latency | CMDBuild token отсутствует в health |
| LOG-009 | IF-003 | CSRF rejection | API response + backend logs при наличии runtime логирования окружения | HTTP 403, route | CSRF token не логировать |

## Обязательные события ИБ

- Отказ CSRF/same-origin проверки для state-changing API.
- Недоступность Redis при `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true`.
- Недоступность CMDBuild upstream.
- Ошибка доступа к техническим классам CMDBuild.
- Публикация static snapshot, потому что результат может быть доступен без проверки прав зрителя на исходные объекты.

## Ограничения текущей реализации

Memory diagnostic logs ограничены по размеру и не заменяют централизованный аудит. Для production события backend stdout/stderr и access logs reverse proxy должны собираться штатной системой логирования контура.
