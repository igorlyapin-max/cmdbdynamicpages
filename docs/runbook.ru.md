# Runbook cmdbdynamicpages

## Назначение

Runbook нужен для production checks, rollback, diagnostics и разбора типовых incidents. Не помещайте live cookies, Redis passwords, CMDBuild tokens и raw secret values в tickets, logs, docs или test fixtures.

## Проверки развертывания

Перед deploy:

```bash
npm run ci
```

Проверка runtime package:

```bash
npm run build:zip
unzip -t dist/cmdbdynamicpages-custompage.zip
```

Обязательная production configuration:

```text
NODE_ENV=production
CMDP_PUBLIC_ORIGIN=https://custom.example.local
CMDP_NGINX_PUBLIC_HOST=custom.example.local
CMDP_NGINX_PUBLIC_PROTO=https
CMDBDYNAMIC_REDIS_URL=rediss://redis.example.local:6380/0
CMDBDYNAMIC_REDIS_TLS_CA_FILE=
CMDBDYNAMICPAGES_CSRF_SECRET=<external stable secret>
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDP_LOG_TARGET=stdout,syslog
CMDP_SYSLOG_HOST=<approved syslog collector>
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp
CMDP_DIAGNOSTIC_MODE=off
```

Проверки после deploy:

```text
GET /health/live
GET /health/redis
GET /health/ready
GET /metrics
GET /cmdbuild/custom-api/logging/status
```

Ожидаемый результат: `/health/live` отвечает `200`; `/health/ready` отвечает `200` только когда Redis и CMDBuild upstream доступны; `/metrics` возвращает Prometheus text без cookies, tokens, user names, runtime rows и raw CMDBuild payload.

## Public Origin За Reverse Proxy

`CMDP_PUBLIC_ORIGIN` - единственный browser-facing origin для CMDBuild UI, custom page и `/cmdbuild/custom-api/*`. Он должен быть задан в production как bare `http(s)` origin, например `https://custom.example.local`, без path, query, fragment или credentials.

`CMDBUILD_ORIGIN` - только внутренний upstream URL, доступный backend, например `https://vr2.internal.example`. Он может отличаться от `CMDP_PUBLIC_ORIGIN`, но не должен появляться в URL браузера, `Origin`, `Referer`, redirect `Location` или cookie domain.

Для production Redis использовать `rediss://`. `CMDBDYNAMIC_REDIS_TLS_CA_FILE` optional и задает путь к CA PEM, уже смонтированному в backend container, если system trust не покрывает private Redis PKI. Plaintext `redis://` остается поддержанным для local и существующих deployment, но в production runtime сообщает `redis_plaintext_transport`.

Задать `CMDP_NGINX_PUBLIC_HOST` как `host[:port]` из `CMDP_PUBLIC_ORIGIN`, а `CMDP_NGINX_PUBLIC_PROTO` как его protocol. Bundled nginx передает только эти configured values, а не client-supplied `Host`, `X-Forwarded-Host` или `X-Forwarded-Proto`. Пользовательский ingress публикует только public hostname; прямой доступ пользователей к backend, bundled nginx и internal CMDBuild upstream закрывается firewall/ingress правилами. Browser JavaScript использует относительные `/cmdbuild/...` URLs и не обращается к `PROXY_PORT` или `CMDBUILD_ORIGIN` напрямую.

После deploy проверить через public hostname:

```text
GET https://custom.example.local/cmdbuild/ui/config.js
GET https://custom.example.local/cmdbuild/custom-api/logging/status
```

`config.js`, redirects и CMDBuild session cookie должны оставаться на `custom.example.local`; `vr2.internal.example` не должен быть виден в browser traffic.

## Rollback

Порядок rollback:

1. Вернуть предыдущий backend image или process bundle.
2. Вернуть предыдущий CMDBuild custom page ZIP, если менялся launcher.
3. Не очищать Redis, если incident не связан напрямую с corrupt static snapshots или cache entries.
4. Повторить `/health/live`, `/health/ready` и один известный runtime URL.

Обычные runtime releases не требуют destructive CMDBuild schema rollback. Schema bootstrap non-destructive и не должен удалять или переносить существующие CMDBuild classes.

## Diagnostics

Для безопасной диагностики используйте `CMDP_DIAGNOSTIC_MODE=Basic`. `Verbose` включайте только временно, когда нужны sanitized request/upstream details.

Полезные endpoints:

```text
GET /health/ready
GET /health/redis
GET /metrics
GET /cmdbuild/custom-api/cache/status
GET /cmdbuild/custom-api/logging/status
GET /cmdbuild/custom-api/auth/permission-scope
```

Интерпретация:

- Redis unavailable: `/health/redis` возвращает `503`, `/health/ready` возвращает `503` при required Redis, logs содержат `redis.unavailable`.
- CMDBuild unavailable: `/health/ready` возвращает `503` с `checks.cmdbuild.ok=false`, logs содержат `cmdbuild.request_error` или `cmdbuild.request_failed`.
- Template execution errors: смотреть `cmdp_template_run_errors_total`, `template.execution_failed`, `runtime.cache_result`.
- Cache behavior: сравнить `/cmdbuild/custom-api/cache/status`, runtime response `cache.status` и `cmdp_runtime_cache_*`.
- Same-origin rejection: сопоставить `x-request-id` браузерного ответа с `security.same_origin_rejected`. В событии смотреть `expectedOrigin`, `headerSource` и `reason`; cookie и CSRF token в логи не пишутся. При external TLS expected origin должен быть `https://...`, а не internal CMDBuild URL.

## SLI и alert inputs

Кандидаты SLI:

- readiness success rate из `/health/ready`;
- CMDBuild upstream latency/error rate из readiness и `cmdp_cmdbuild_rest_*`;
- Redis availability из `/health/redis` и `cmdp_redis_errors_total`;
- HTTP error rate из `cmdp_http_requests_total`;
- runtime cache hit/miss/build duration из `cmdp_runtime_cache_*`;
- template execution error rate из `cmdp_template_run_errors_total`;
- execution throttling из `cmdp_execution_throttled_total`.

Предлагаемые alerts:

- `/health/ready` остается non-ready два scrape intervals подряд.
- Redis required mode включен и `/health/redis` возвращает `503`.
- CMDBuild upstream readiness падает или latency резко растет.
- Template execution errors растут выше обычного baseline.
- Execution throttling держится продолжительное время.

## Типовые incidents

### Production startup падает с `app.config_invalid`

Проверить `NODE_ENV=production`, `CMDBDYNAMICPAGES_CSRF_SECRET` и `CMDP_PUBLIC_ORIGIN`. Production требует stable external CSRF secret и explicit public browser origin; internal `CMDBUILD_ORIGIN` его не заменяет.

### Runtime iframe показывает login или пустой результат

Проверить same-origin access через nginx/ingress, CMDBuild session cookie, template read grants и business-data read permissions. Dynamic runtime pages требуют current CMDBuild session cookie. Static snapshots требуют Redis snapshot.

### Static snapshot отсутствует

Если runtime показывает `Страница отсутствует для загрузки`, переопубликовать static snapshot из editor/admin session. Проверить Redis persistence и `CMDBDYNAMIC_REDIS_REQUIRED=true` для production.

### Cache не обновляется

Проверить template cache settings, `RuntimeConfigJson.runtimeCache.refreshCooldownSec`, runtime response `cache.refreshAllowedAt`, а также тип запроса: read-only `GET run` или CSRF-protected `POST run` с `forceRefresh=true`.

### Designer не сохраняет templates

Проверить CMDBuild CRUD grants на technical classes, same-origin headers, `X-CMDBDynamicPages-CSRF` и `Content-Type: application/json`.

Если ответ содержит `State-changing custom API calls require a same-origin Origin or Referer header.`, проверить в browser Network, что `Origin` и `Referer` имеют `CMDP_PUBLIC_ORIGIN`, а не internal upstream hostname. Если same-origin проверка проходит, следующей ожидаемой проверкой будет валидный `X-CMDBDynamicPages-CSRF`.
