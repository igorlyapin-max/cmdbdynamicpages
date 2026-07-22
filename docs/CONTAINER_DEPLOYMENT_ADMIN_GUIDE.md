# CMDB Dynamic Pages: container deployment handoff

Статус: admin-facing deployment guide для `v0.1.0-static-baseline`.

## Что поставляется

- Backend image `cmdbdynamicpages`, tag должен совпадать с release tag, например `v0.1.0-static-baseline`.
- Image-only compose template: `docker-compose.runtime.yml`.
- Safe env template: `.env.example`.
- Custom page zip artifact: `dist/cmdbdynamicpages-custompage.zip`, собирается в CI/release через `npm run build:zip`.

Runtime host не должен выполнять `npm install`, `npm run build` или локальную сборку приложения. Администратор запускает уже опубликованный image из approved registry.

## Предварительные условия контура

- Доступ к approved private registry и registry login для service account.
- Если registry использует внутренний CA, установить CA/cert в trust store Docker host до pull image.
- DNS/proxy/firewall должны разрешать:
  - pull image из private registry;
  - browser access только к public `CMDP_PUBLIC_ORIGIN` через TLS reverse proxy;
  - доступ backend к `CMDBUILD_ORIGIN`;
  - доступ backend к Redis;
  - optional доступ backend к LiteLLM endpoint, если включен Designer assistant;
  - доступ backend к approved syslog collector.
- Backend по умолчанию слушает только `127.0.0.1:8093`. Не открывать `PROXY_PORT` во внешнем firewall и не использовать его как public URL: browser входит через `CMDP_PUBLIC_ORIGIN`.
- Redis должен быть production-grade и password-protected, если static snapshot или runtime cache входят в service contract.
- Kafka для этого сервиса не требуется.
- Секреты должны приходить из PAM, platform injection, Docker secrets, mounted secret file или другого approved secret source.
- Production logging использует `CMDP_LOG_TARGET=stdout,syslog`: приложение пишет structured logs в `stdout`/`stderr` и отправляет их в approved syslog collector. Docker logging driver не является заменой этого delivery contract.

## Подготовка env

```bash
cp .env.example .env
```

Заменить placeholders:

- `CMDBDYNAMIC_IMAGE` - approved registry image, например `registry.example.local/gkm/cmdbdynamicpages:v0.1.0-static-baseline`;
- `PROXY_HOST` - bind address backend; production default `127.0.0.1`, а внешний TLS reverse proxy публикует только `CMDP_PUBLIC_ORIGIN`;
- `CMDP_PUBLIC_ORIGIN` - canonical public `http(s)` origin для browser, CMDBuild UI, custom page и custom API; не содержит path, query, fragment или credentials;
- `CMDBUILD_ORIGIN` - URL CMDBuild upstream, доступный с backend host;
- `CMDBDYNAMIC_REDIS_URL` - Redis endpoint без plaintext password в URL, если пароль передается файлом;
- `CMDBDYNAMIC_REDIS_PASSWORD_FILE_HOST` - host path к secret file от PAM/platform;
- `CMDBDYNAMICPAGES_CSRF_SECRET` - stable external secret из approved secret source;
- `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT` - timeout для `proxy_read_timeout` и `proxy_send_timeout` только в nginx location `/cmdbuild/custom-api/`; default `70s`. Использовать nginx duration, например `90s`, если подтверждено, что upstream operation требует больше времени;
- `CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE` - абсолютный server-side cap количества карточек, которые один детерминированный selection может просканировать; default `50000`. Он ограничивает настроечные значения Designer и не увеличивает число строк в опубликованной таблице. Поднимать только после оценки нагрузки CMDBuild; при достижении cap UI сообщает, что результат может быть неполным;
- `CMDP_DRAFT_PREVIEW_TIMEOUT_MS` - общий deadline draft preview в Designer; default `60000` ms, допустимый диапазон `1000-300000` ms. Он включает CSRF/browser request и весь server-side deterministic execution. При поздней ошибке diagram-only preview возвращает безопасный partial preview успешно завершившихся этапов и trace, но не считается успешным preview;
- `CMDP_ASSISTANT_ENABLED` - deprecated/no-op compatibility variable; фактическое включение Designer draft assistant хранится в `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.enabled`;
- `LITELLM_BASE_URL`, `LITELLM_MODEL`, `LITELLM_API_KEY_FILE_HOST` - optional LiteLLM assistant endpoint/model/API-key secret file. Leave `LITELLM_API_KEY_FILE_HOST` empty when Assistant is unused: compose mounts `/dev/null`. When Assistant is enabled, the host path must already be a readable regular file; do not create a directory at the secret path;
- `CMDP_LITELLM_ALLOWED_BASE_URLS` - server-side allowlist для LiteLLM-compatible endpoints; RuntimeConfig baseUrl не должен выводить API key за этот список;
- `Cst_QueryToolConfig.RuntimeConfigJson.assistant.mcp` - runtime-настройки read-only MCP tools для Designer Assistant; secrets здесь не хранить;
- `CMDP_D2_RENDER_ENABLED`, `CMDP_D2_BINARY`, `CMDP_D2_TIMEOUT_MS`, `CMDP_D2_MAX_INPUT_BYTES`, `CMDP_D2_MAX_OUTPUT_BYTES`, `CMDP_D2_MAX_DIAGRAMS`, `CMDP_D2_CONCURRENCY`, `CMDP_D2_LAYOUT`, `CMDP_D2_LAYOUT_ALLOWLIST` - обязательный по умолчанию server-side D2 SVG render. В штатном image binary уже лежит в `/usr/local/bin/d2`; при `CMDP_D2_RENDER_ENABLED=true` `/health/ready` требует рабочий binary;
- `CMDP_D2_IMPORT_BINARY`, `CMDP_D2_IMPORT_TIMEOUT_MS`, `CMDP_D2_IMPORT_MAX_INPUT_BYTES`, `CMDP_D2_IMPORT_MAX_OUTPUT_BYTES`, `CMDP_D2_IMPORT_MAX_ELEMENTS`, `CMDP_D2_IMPORT_PROPOSAL_TTL_MS`, `CMDP_D2_IMPORT_ASSISTANT_MAX_SPEC_BYTES`, `CMDP_TEMPLATE_REQUEST_MAX_BYTES` - bounded import self-contained `.d2` в Designer. Штатный image содержит `/usr/local/bin/cmdp-d2-import`; readiness проверяет parser helper отдельно. Proposal подписан, привязан к CMDBuild session/template version и по умолчанию действует 30 минут. Перед LiteLLM raw D2 source/structural IR и composite template удаляются, размер sanitized spec ограничен. Общий body limit Preview/Create/Update должен вмещать разрешённые source и normalized IR. Raw D2 source и CMDBuild payload не должны попадать в operational logs;
- `CMDP_LOG_TARGET` - production contract `stdout,syslog`: structured logs остаются в stdout/stderr и дублируются в syslog;
- `CMDP_SYSLOG_HOST`, `CMDP_SYSLOG_PORT`, `CMDP_SYSLOG_PROTOCOL`, `CMDP_SYSLOG_FACILITY` - обязательные параметры approved syslog collector.

`replace-me`, `registry.example.local`, `cmdbuild.example.local`, `redis.example.local`, `litellm.example.local` и `syslog.example.local` не являются рабочими значениями. Real `.env` файлы не коммитить.

Перед запуском с включенным Assistant проверить secret mount без вывода ключа:

```bash
test -f "$LITELLM_API_KEY_FILE_HOST" && test -r "$LITELLM_API_KEY_FILE_HOST"
docker compose -f docker-compose.runtime.yml exec cmdbdynamicpages sh -c 'test -f /run/secrets/cmdbdynamicpages_litellm_api_key && test -r /run/secrets/cmdbdynamicpages_litellm_api_key'
```

`CMDP_PUBLIC_ORIGIN` и `CMDBUILD_ORIGIN` имеют разные роли. Например, browser работает с `https://custom.example.local`, а backend обращается к internal CMDBuild `https://vr2.internal.example`. Internal upstream не должен быть доступен пользователям, попадать в browser URLs, redirect `Location`, `Origin`, `Referer` или CMDBuild cookie domain. Внешний TLS reverse proxy обязан передать public `Host`, `X-Forwarded-Host` и `X-Forwarded-Proto=https`.

Для опубликованных static snapshots raw `.d2` source не отдается публичному endpoint по умолчанию. Если заказчик разрешает скачивание `.d2`, включайте `publish.publicD2Source=true` в шаблоне осознанно: source может содержать structured diagram metadata и бизнес-данные, уже зафиксированные в snapshot.

## Проверка compose template

```bash
docker compose --env-file .env.example -f docker-compose.runtime.yml config
docker compose -f docker-compose.nginx.yml config
```

Bundled nginx использует штатную template processing entrypoint image `nginx:1.27-alpine`: конфигурация монтируется в `/etc/nginx/templates/default.conf.template`, а Compose передает `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT` со значением `70s` по умолчанию. Не монтировать этот файл напрямую в `/etc/nginx/conf.d/default.conf`, иначе template variable не будет подставлена.

Перед production start проверить уже реальный `.env`:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml config
docker compose --env-file .env -f docker-compose.nginx.yml config
```

Compose template не содержит `build:` и использует только prebuilt `image:`.

## Запуск и остановка

```bash
docker login <approved-registry>
docker compose --env-file .env -f docker-compose.runtime.yml pull
docker compose --env-file .env -f docker-compose.runtime.yml up -d
docker compose --env-file .env -f docker-compose.runtime.yml ps
```

Остановка:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml down
```

Rollback:

1. Вернуть `CMDBDYNAMIC_IMAGE` в `.env` на предыдущий approved tag.
2. Выполнить `docker compose --env-file .env -f docker-compose.runtime.yml pull`.
3. Выполнить `docker compose --env-file .env -f docker-compose.runtime.yml up -d`.
4. Повторить health/metrics checks.

## Health, metrics и логи

```bash
curl -fsS http://127.0.0.1:8093/health/live
curl -fsS http://127.0.0.1:8093/health/ready
curl -fsS http://127.0.0.1:8093/health/redis
curl -fsS http://127.0.0.1:8093/metrics
docker logs --tail=100 cmdbdynamicpages-backend
```

Ожидания:

- `/health/live` - liveness: возвращает `200`, если Node process отвечает; не доказывает готовность зависимостей;
- `/health/ready` - readiness: возвращает `200`, только если Redis, CMDBuild upstream и обязательный D2 renderer доступны;
- `/health/redis` возвращает `200` при доступном Redis;
- `/metrics` возвращает Prometheus text без cookies, tokens, user names, runtime rows и raw CMDBuild payload;
- Docker healthcheck использует только `/health/live`; rollout и traffic routing должны использовать `/health/ready`.

## Diagnostic и logging baseline

Production default:

```text
CMDP_DIAGNOSTIC_MODE=off
CMDP_LOG_TARGET=stdout,syslog
CMDP_LOG_FORMAT=json
CMDP_SYSLOG_HOST=syslog.example.local
CMDP_SYSLOG_PORT=514
CMDP_SYSLOG_PROTOCOL=udp
CMDP_SYSLOG_FACILITY=local0
```

Для диагностики можно временно включить:

```text
CMDP_DIAGNOSTIC_MODE=Basic
CMDP_DIAGNOSTIC_MODE=Verbose
```

`Verbose` включать только на время incident. Cookie, authorization headers, CSRF token, Redis password, raw runtime rows и raw CMDBuild payload не должны попадать в логи. `CMDP_SYSLOG_HOST`, `CMDP_SYSLOG_PORT`, `CMDP_SYSLOG_PROTOCOL` и `CMDP_SYSLOG_FACILITY` должны указывать на approved syslog collector; `stdout`/stderr остаются обязательным локальным output.

## CMDBuild schema и custom page

Сервис не требует SQL migration. CMDBuild technical schema создается через Designer bootstrap и является non-destructive: создаются только недостающие классы/атрибуты.

Для custom page release artifact:

```bash
npm run build:zip
unzip -t dist/cmdbdynamicpages-custompage.zip
```

Затем загрузить zip в CMDBuild custom pages:

```text
name: CmdbDynamicPages
componentId: view.custompages.CmdbDynamicPages.CmdbDynamicPages
active: true
```

Проверить launcher и runtime через same-origin front или backend proxy, согласно deployment guide.

## CI/CD требования

CI для release должен:

- запускать `npm run ci`;
- строить Docker image;
- проверять `docker compose --env-file .env.example -f docker-compose.runtime.yml config`;
- проверять `docker compose -f docker-compose.nginx.yml config`;
- запускать `bash scripts/nginx-test.sh` для проверки рендеринга nginx template;
- публиковать image в approved registry для branch/tag release;
- прикладывать `dist/cmdbdynamicpages-custompage.zip` как release artifact.

Если image push не выполнен, release нельзя считать готовым для GKM container handoff.
