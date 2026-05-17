# Карта HealthCheck

## Endpoint'ы

| ID | Информационный поток | Endpoint | Порт | Условие OK | HTTP при ошибке | Проверяемые зависимости |
| --- | --- | --- | --- | --- | --- | --- |
| HC-001 | IF-008 | `GET /health/live` | `8093` или `8088` | Node.js process отвечает HTTP | Нет ответа/5xx | Только процесс |
| HC-002 | IF-008, IF-005 | `GET /health/redis` | `8093` или `8088`; Redis `6379` | Redis `PING` вернул `PONG` | `503` | Redis, AUTH/password |
| HC-003 | IF-008, IF-005, IF-004 | `GET /health/ready` | `8093` или `8088`; Redis `6379`; CMDBuild `8090` | Process OK, Redis OK, CMDBuild reachable | `503` | Redis, CMDBuild upstream |
| HC-004 | IF-008 | `GET /cmdbuild/custom-api/cache/status` | `8093` или `8088` | Diagnostic response returned | Обычно `200` | Redis visibility + memory counters |

## Важное различие

`HC-004` не является readiness. Он предназначен для диагностики и может вернуть `200`, даже если backend работает через memory fallback. Для production readiness использовать `HC-003`.

## Настройки

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `CMDBDYNAMIC_HEALTH_TIMEOUT_MS` | `2000` | Таймаут проверки CMDBuild upstream |
| `CMDBDYNAMIC_HEALTH_REDIS_REQUIRED` | `true` | Если `true`, readiness падает при недоступном Redis |
| `CMDBDYNAMIC_REDIS_ENABLED` | `true` | Если Redis отключен, `/health/redis` вернет `503` |

## Пример ready ответа

```json
{
  "service": "cmdbdynamicpages",
  "status": "ready",
  "ready": true,
  "checks": {
    "process": { "ok": true, "status": "ok" },
    "redis": {
      "required": true,
      "ok": true,
      "status": "ok",
      "available": true,
      "url": "redis://:***@127.0.0.1:6379/0"
    },
    "cmdbuild": {
      "required": true,
      "ok": true,
      "status": "ok",
      "url": "http://127.0.0.1:8090/cmdbuild/services/rest/v3/sessions/current"
    }
  }
}
```
