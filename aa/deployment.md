# Схема развертывания

Окружение разработки не требуется по `../aa.txt`, но локальные порты указаны как справочные, потому что текущая проверка выполняется локально. Для production схема ниже фиксирует те же logical nodes и сетевую связность.

## Тест ИТ / локальный стенд

```mermaid
flowchart TB
  subgraph Host["Developer/Test host"]
    Browser[Browser]
    Nginx[Nginx container<br/>listen 8088]
    Backend[Node.js cmdbdynamicpages<br/>listen 127.0.0.1:8093]
    Redis[Redis container<br/>listen 127.0.0.1:6379<br/>RDB snapshot]
    CMDBuild[CMDBuild app<br/>listen 127.0.0.1:8090]
    Logs[Docker stdout / optional syslog<br/>514 UDP/TCP]
    CMDBDB[CMDBuild DB]
  end

  Browser -->|HTTP 8088| Nginx
  Nginx -->|HTTP 8093| Backend
  Browser -->|HTTP direct dev 8093| Backend
  Backend -->|HTTP REST 8090| CMDBuild
  Backend -->|RESP AUTH 6379| Redis
  Backend -->|JSON stdout / syslog 514| Logs
  CMDBuild --> CMDBDB
```

## Бизнес Тест / Продуктив

```mermaid
flowchart TB
  User[User browser / iframe]
  LB[Ingress / Load balancer<br/>443]
  Web[Wiki / portal<br/>443]
  App[cmdbdynamicpages Node.js<br/>8080 или platform port]
  Redis[Managed Redis<br/>6379/TLS или platform port<br/>AUTH required]
  CMDB[CMDBuild REST<br/>443 или 8090]
  CMDBDB[(CMDBuild DB)]
  Mon[Monitoring / LB health probe]
  LogCollector[Log collector<br/>Filebeat/Fluent Bit/Logstash<br/>5044/24224/platform port]
  Syslog[Syslog / SIEM<br/>514 UDP/TCP]
  ELK[Elasticsearch / ELK<br/>9200/platform port]
  Secret[Secret store<br/>Redis password, CSRF secret]

  User -->|HTTPS 443| LB
  LB -->|HTTPS 443| Web
  LB -->|HTTP/HTTPS app port| App
  App -->|HTTPS/HTTP CMDBuild REST 443/8090| CMDB
  App -->|Redis RESP 6379, AUTH| Redis
  App -->|read secrets at startup| Secret
  App -->|JSON stdout via platform logging| LogCollector
  App -->|optional syslog 514 UDP/TCP| Syslog
  Syslog -->|optional forward| LogCollector
  LogCollector -->|index/bulk 9200| ELK
  CMDB --> CMDBDB
  Mon -->|GET /health/live,/ready 443/app port| App
```

Production deployment requirements:

- Redis password must be delivered as deployment secret, preferably file-mounted secret.
- `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED=true`.
- Health endpoints must be exposed to LB/monitoring but do not require CMDBuild user cookies.
- CMDBuild session cookies must remain `HttpOnly`.
- Same-origin route for iframe should be provided by ingress/reverse proxy.

## Контуры

| Контур | Статус схемы | Отличия |
| --- | --- | --- |
| Тест ИТ | Описан | Локальные порты `8093`, `8090`, `6379`, `8088` |
| Бизнес Тест | Логически совпадает с production | Адреса/сертификаты задаются платформой |
| Продуктив | Описан | Redis password обязателен; health/readiness используются LB/monitoring |
