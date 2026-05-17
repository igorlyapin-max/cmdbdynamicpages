# Карта секретов

| ID | Поток/компонент | Секрет | Где хранится | Где используется | Ротация | Примечание |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | IF-004 Browser/Backend/CMDBuild | `CMDBuild-Authorization` cookie | Выдается CMDBuild, хранится в браузере как `HttpOnly` cookie | Backend извлекает на server side и пересылает в CMDBuild REST header | По политике CMDBuild sessions | Не логировать, не отдавать в JSON |
| SEC-002 | Backend state-changing API | `CMDBDYNAMICPAGES_CSRF_SECRET` | Secret/env уровня деплоя | Генерация `X-CMDBDynamicPages-CSRF` | При деплое или по ИБ-процедуре; смена инвалидирует текущие CSRF токены | Не хранить в git |
| SEC-003 | IF-005 Backend/Redis | Redis password | `CMDBDYNAMIC_REDIS_PASSWORD_FILE` предпочтительно; допускается env/URL для dev | Redis AUTH перед `PING/GET/SET/DEL` | По ИБ-процедуре, минимум при компрометации/смене контура | Production Redis обязан требовать пароль |
| SEC-004 | IF-004 Backend/CMDBuild | CMDBuild technical data permissions | CMDBuild role/grants | Доступ к `Cst_QueryTool*` классам | Через CMDBuild admin process | Не отдельный секрет, но доступ влияет на права редактора |

## Правила хранения

- Секреты не коммитятся в git.
- Для Redis production использовать file-mounted secret:

```text
CMDBDYNAMIC_REDIS_URL=redis://redis-host:6379/0
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
```

- `CMDBDYNAMIC_REDIS_PASSWORD` и `redis://:password@host:6379/0` допустимы для локальной диагностики, но не рекомендуются как production storage.
- Health/status responses маскируют Redis password в URL.

## Смена Redis password

1. Создать новый password в secret store.
2. Обновить Redis configuration/ACL.
3. Обновить mounted secret или deployment env backend.
4. Перезапустить backend.
5. Проверить `GET /health/redis` и `GET /health/ready`.
6. Удалить старый secret.
