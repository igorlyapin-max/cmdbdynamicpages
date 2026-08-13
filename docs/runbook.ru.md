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
CMDP_TLS_CA_FILE=
CMDP_TLS_CA_FILE_HOST=
CMDBDYNAMICPAGES_CSRF_SECRET=<external stable secret>
CMDBDYNAMIC_REDIS_REQUIRED=true
CMDBDYNAMIC_REDIS_PASSWORD_FILE=/run/secrets/cmdbdynamicpages_redis_password
CMDP_LOG_TARGET=stdout
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

`docker compose ... logs` подтверждает только local stdout. Проверить platform-managed маршрут нужно запросом к collector, который вернет `0` только после нахождения отправленного probe ID:

```bash
bash scripts/verify-platform-log-route.sh https://custom.example.local/health/live -- \
  sh -c 'platform-log-query --contains "$CMDP_LOG_PROBE_ID"'
```

Для прямого syslog задать `CMDP_SYSLOG_HOST` и запускать с `-f docker-compose.syslog.yml`; этот overlay устанавливает `CMDP_LOG_TARGET=stdout,syslog` и требует endpoint syslog.

## Public Origin За Reverse Proxy

`CMDP_PUBLIC_ORIGIN` - единственный browser-facing origin для CMDBuild UI, custom page и `/cmdbuild/custom-api/*`. Он должен быть задан в production как bare `http(s)` origin, например `https://custom.example.local`, без path, query, fragment или credentials.

`CMDBUILD_ORIGIN` - только внутренний upstream URL, доступный backend, например `https://vr2.internal.example`. Он может отличаться от `CMDP_PUBLIC_ORIGIN`, но не должен появляться в URL браузера, `Origin`, `Referer`, redirect `Location` или cookie domain.

Для production Redis использовать `rediss://`. При private PKI CMDBuild, Redis или LiteLLM задать вместе `CMDP_TLS_CA_FILE_HOST` и `CMDP_TLS_CA_FILE=/run/certs/cmdbdynamicpages-ca.pem`: compose смонтирует один PEM bundle read-only, а Node использует его для HTTPS trust. Plaintext `redis://` остается поддержанным для local и существующих deployment, но в production runtime сообщает `redis_plaintext_transport`.

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

### Локальный nginx restart-loop

Порты стенда являются контрактом: не менять `8088`, `8093`, `8090` или `6379` для обхода ошибки. Сначала проверить вычисленную конфигурацию и environment контейнера:

```bash
docker compose -f docker-compose.nginx.yml config --quiet
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' cmdbdynamicpages-nginx
```

Шаблон `/etc/nginx/templates/default.conf.template` требует `CMDP_NGINX_PUBLIC_HOST`, `CMDP_NGINX_PUBLIC_PROTO` и `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT`. Если в логах есть `unknown "cmdp_nginx_public_host" variable`, nginx был создан не через штатный Compose или без полного environment. Восстанавливать только Nginx командой `npm run nginx:dev`; она пересоздаёт этот контейнер с тем же `network_mode: host` и портом `8088`, не затрагивая backend, Redis или CMDBuild. Затем проверить `GET http://localhost:8088/health/live`, `GET http://localhost:8088/health/ready` и `GET http://localhost:8088/cmdbuild/ui/`.

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
