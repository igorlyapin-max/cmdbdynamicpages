# Информационная модель

## Схема потоков

```mermaid
flowchart LR
  Browser[Browser / iframe]
  Nginx[Nginx same-origin front<br/>localhost:8088]
  Wiki[Wiki<br/>localhost:3000]
  Backend[cmdbdynamicpages Backend/UI<br/>127.0.0.1:8093]
  CMDB[CMDBuild UI/REST<br/>127.0.0.1:8090]
  Redis[Redis<br/>127.0.0.1:6379]
  Monitor[Monitoring / LB]

  Browser -->|IF-001 HTTPS/HTTP UI 8088| Nginx
  Nginx -->|IF-002 HTTP wiki 3000| Wiki
  Nginx -->|IF-003 HTTP dynamicpages 8093| Backend
  Backend -->|IF-004 HTTP CMDBuild REST 8090| CMDB
  Backend -->|IF-005 Redis RESP AUTH/GET/SET/PING 6379| Redis
  Browser -->|IF-006 HTTP direct dev 8093| Backend
  Browser -->|IF-007 HTTP CMDBuild launcher 8093->8090| CMDB
  Monitor -->|IF-008 HTTP health 8093/8088| Backend
```

## Реестр информационных потоков

| ID | Источник | Получатель | Канал и порт | Данные | Примечание |
| --- | --- | --- | --- | --- | --- |
| IF-001 | Browser | Nginx | HTTP `localhost:8088` | Wiki pages, iframe URLs, `/cmdbuild/*`, `/health/*` | Единый browser-facing origin для iframe |
| IF-002 | Nginx | Wiki | HTTP `localhost:3000` | Wiki HTML/content | Не управляется cmdbdynamicpages |
| IF-003 | Nginx | cmdbdynamicpages Backend | HTTP `127.0.0.1:8093` | Designer UI, Runtime UI, custom API, health | Reverse proxy path `/cmdbuild/*` и `/health/*` |
| IF-004 | cmdbdynamicpages Backend | CMDBuild REST | HTTP `127.0.0.1:8090` | Session, classes, domains, cards, relations, technical cards | Header `CMDBuild-Authorization`; cookie/token не логируются |
| IF-005 | cmdbdynamicpages Backend | Redis | RESP `127.0.0.1:6379` | Runtime cache, static snapshots, PING | Production Redis требует password/AUTH |
| IF-006 | Browser | cmdbdynamicpages Backend | HTTP `127.0.0.1:8093` | Direct dev Designer/Runtime/API | Локальный прямой доступ без nginx |
| IF-007 | Browser | CMDBuild UI через proxy chain | HTTP `127.0.0.1:8093` -> `8090` | CMDBuild UI assets, custom page launcher | Нужен для входа и получения session cookie |
| IF-008 | Monitoring/LB | cmdbdynamicpages Backend | HTTP `8093` или `8088` | `/health/live`, `/health/ready`, `/health/redis` JSON | Readiness возвращает `503` при Redis/CMDBuild проблемах |

## Данные CMDBuild

Технические классы:

| Класс | Назначение |
| --- | --- |
| `Cst_QueryToolConfig` | Runtime/system settings |
| `Cst_QueryTemplate` | Шаблоны DSL |
| `Cst_QueryTemplateVersion` | Версии шаблонов |
| `Cst_QueryExecutionLog` | Best-effort audit preview/direct POST run |

Business data читаются из существующих CMDBuild классов через DSL (`selectCards`, `expandRelations`, matching). Состав полей ограничивается used-field dependency map: backend запрашивает только атрибуты, реально используемые фильтрами, сопоставлением, итоговыми данными или визуализацией.

## Данные Redis

| Namespace | Данные | TTL |
| --- | --- | --- |
| Runtime result cache | Результат выполнения шаблона + cache metadata | `spec.cache.ttlSeconds`, default 8h |
| Static snapshot | Опубликованный результат шаблона | Без TTL |
| In-flight coordination | Защита от одновременной сборки одного результата | В памяти backend |

Redis credentials не передаются в ответы API. В health/status возвращается замаскированный URL.

## Синхронные API

HTTP API проекта описан в [openapi.yaml](openapi.yaml). CMDBuild REST используется как внешний API и в этот OpenAPI не включается, кроме указания потоков IF-004.
