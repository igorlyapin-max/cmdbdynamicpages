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
  - доступ backend к `CMDBUILD_ORIGIN`;
  - доступ backend к Redis;
  - optional доступ backend к LiteLLM endpoint, если включен Designer assistant;
  - входящий доступ к `PROXY_PORT`, по умолчанию `8093`;
  - optional same-origin nginx front `8088`, если используется bundled nginx.
- Redis должен быть production-grade и password-protected, если static snapshot или runtime cache входят в service contract.
- Kafka для этого сервиса не требуется.
- Секреты должны приходить из PAM, platform injection, Docker secrets, mounted secret file или другого approved secret source.
- Логи должны уходить через Docker logging driver, Filebeat, Fluent Bit, Logstash, syslog или другой collector. Приложение всегда пишет structured logs в `stdout`.

## Подготовка env

```bash
cp .env.example .env
```

Заменить placeholders:

- `CMDBDYNAMIC_IMAGE` - approved registry image, например `registry.example.local/gkm/cmdbdynamicpages:v0.1.0-static-baseline`;
- `CMDBUILD_ORIGIN` - URL CMDBuild upstream, доступный с backend host;
- `CMDBDYNAMIC_REDIS_URL` - Redis endpoint без plaintext password в URL, если пароль передается файлом;
- `CMDBDYNAMIC_REDIS_PASSWORD_FILE_HOST` - host path к secret file от PAM/platform;
- `CMDBDYNAMICPAGES_CSRF_SECRET` - stable external secret из approved secret source;
- `CMDP_ASSISTANT_ENABLED` - deprecated/no-op compatibility variable; фактическое включение Designer draft assistant хранится в `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.enabled`;
- `LITELLM_BASE_URL`, `LITELLM_MODEL`, `LITELLM_API_KEY_FILE_HOST` - optional LiteLLM assistant endpoint/model/API-key secret file;
- `CMDP_LITELLM_ALLOWED_BASE_URLS` - server-side allowlist для LiteLLM-compatible endpoints; RuntimeConfig baseUrl не должен выводить API key за этот список;
- `Cst_QueryToolConfig.RuntimeConfigJson.assistant.mcp` - runtime-настройки read-only MCP tools для Designer Assistant; secrets здесь не хранить;
- `CMDP_LOG_TARGET` - `stdout` или `stdout,syslog`, если контур использует syslog sink;
- `CMDP_EXTERNAL_LOG_SINK` - имя внешней доставки логов (`docker logging driver`, collector/sidecar, ELK/OpenSearch/syslog route), если `CMDP_LOG_TARGET` остается `stdout`;
- `CMDP_SYSLOG_*` - только если включен syslog.

`replace-me`, `registry.example.local`, `cmdbuild.example.local`, `redis.example.local`, `litellm.example.local` и `syslog.example.local` не являются рабочими значениями. Real `.env` файлы не коммитить.

## Проверка compose template

```bash
docker compose --env-file .env.example -f docker-compose.runtime.yml config
docker compose -f docker-compose.nginx.yml config
```

Перед production start проверить уже реальный `.env`:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml config
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

- `/health/live` возвращает `200`, если Node process отвечает;
- `/health/ready` возвращает `200`, только если Redis и CMDBuild upstream доступны;
- `/health/redis` возвращает `200` при доступном Redis;
- `/metrics` возвращает Prometheus text без cookies, tokens, user names, runtime rows и raw CMDBuild payload;
- Docker healthcheck использует `/health/live`.

## Diagnostic и logging baseline

Production default:

```text
CMDP_DIAGNOSTIC_MODE=off
CMDP_LOG_TARGET=stdout
CMDP_LOG_FORMAT=json
```

Для диагностики можно временно включить:

```text
CMDP_DIAGNOSTIC_MODE=Basic
CMDP_DIAGNOSTIC_MODE=Verbose
```

`Verbose` включать только на время incident. Cookie, authorization headers, CSRF token, Redis password, raw runtime rows и raw CMDBuild payload не должны попадать в логи. Если нужен внешний sink, использовать `CMDP_LOG_TARGET=stdout,syslog` и настроить `CMDP_SYSLOG_*` либо собрать stdout платформенным collector-ом.

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
- публиковать image в approved registry для branch/tag release;
- прикладывать `dist/cmdbdynamicpages-custompage.zip` как release artifact.

Если image push не выполнен, release нельзя считать готовым для GKM container handoff.
