# CMDB Dynamic Pages: container deployment handoff

Статус: admin-facing deployment guide для image-only release delivery.

## Что поставляется

- Backend image `cmdbdynamicpages`, tag должен совпадать с release tag формата `vXX.YY.ZZ.NN`.
- Verified release image содержит root `VERSION`, Git revision, `RUNTIME_SOURCE_MANIFEST.json` и OCI labels. Manifest детерминированно покрывает `src/**`, `scripts/**`, `cmd/cmdp-d2-import/**`, `go.mod`, `go.sum`, `package.json` и `VERSION`; его `runtimeManifestSha256` записан в `BUILD_INFO.json` и label `io.gkm.cmdbdynamicpages.runtime-source-manifest-sha256`.
- `/health/live` возвращает ту же build identity, manifest digest и SHA-256 фактически исполняемого Designer.
- Image-only compose template: `docker-compose.runtime.yml`.
- Safe env template: `.env.example`.
- Custom page zip artifact: `dist/cmdbdynamicpages-custompage.zip`, собирается в CI/release через `npm run build:zip`.

Runtime host не должен выполнять `npm install`, `npm run build` или локальную сборку приложения. Администратор запускает уже опубликованный image из approved registry.

## Предварительные условия контура

- Доступ к approved private registry и registry login для service account.
- Если registry использует внутренний CA, установить CA/cert в trust store Docker host до pull image. Это отдельное требование от CA bundle внутри backend container.
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

- `CMDBDYNAMIC_IMAGE` - approved registry image, например `registry.example.local/gkm/cmdbdynamicpages:vXX.YY.ZZ.NN`;
- `PROXY_HOST` - bind address backend; production default `127.0.0.1`, а внешний TLS reverse proxy публикует только `CMDP_PUBLIC_ORIGIN`;
- `CMDP_PUBLIC_ORIGIN` - canonical public `http(s)` origin для browser, CMDBuild UI, custom page и custom API; не содержит path, query, fragment или credentials;
- `CMDP_NGINX_PUBLIC_HOST` - canonical `host[:port]` из `CMDP_PUBLIC_ORIGIN`, который bundled nginx передает как `Host` и `X-Forwarded-Host`;
- `CMDP_NGINX_PUBLIC_PROTO` - `http` или `https` из `CMDP_PUBLIC_ORIGIN`, который bundled nginx передает как `X-Forwarded-Proto`;
- `CMDBUILD_ORIGIN` - URL CMDBuild upstream, доступный с backend host;
- `CMDBDYNAMIC_REDIS_URL` - production Redis endpoint без plaintext password в URL, предпочтительно `rediss://redis.example.local:6380/0`;
- `CMDP_TLS_CA_FILE_HOST` и `CMDP_TLS_CA_FILE` - optional private-CA PEM bundle для CMDBuild, Redis и LiteLLM. Первый указывает существующий readable host file, второй - его фиксированный путь внутри container `/run/certs/cmdbdynamicpages-ca.pem`. Задать оба значения или оставить оба пустыми, если system trust достаточен;
- `CMDBDYNAMIC_REDIS_PASSWORD_FILE_HOST` - host path к secret file от PAM/platform;
- `CMDBDYNAMICPAGES_CSRF_SECRET` - stable external secret из approved secret source;
- `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT` - timeout для `proxy_read_timeout` и `proxy_send_timeout` только в nginx location `/cmdbuild/custom-api/`; default `70s`. Он должен быть больше максимальной одной LiteLLM-попытки (`60000 ms`) и transport grace. D2 mapping повторяется отдельным checkpointed HTTP-запросом и не требует увеличения этого timeout;
- `CMDP_EXECUTION_MAX_SELECTION_SCAN_ROWS_ABSOLUTE` - абсолютный server-side cap количества карточек, которые один детерминированный selection может просканировать; default `50000`. Он ограничивает настроечные значения Designer и не увеличивает число строк в опубликованной таблице. Поднимать только после оценки нагрузки CMDBuild; при достижении cap UI сообщает, что результат может быть неполным;
- `CMDP_DRAFT_PREVIEW_TIMEOUT_MS` - общий deadline draft preview в Designer; default `60000` ms, допустимый диапазон `1000-300000` ms. Он включает CSRF/browser request и весь server-side deterministic execution. При поздней ошибке diagram-only preview возвращает безопасный partial preview успешно завершившихся этапов и trace, но не считается успешным preview;
- `CMDP_ASSISTANT_ENABLED` - deprecated/no-op compatibility variable; фактическое включение Designer draft assistant хранится в `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.enabled`;
- `LITELLM_BASE_URL`, `LITELLM_MODEL`, `LITELLM_API_KEY_FILE_HOST` - optional LiteLLM assistant endpoint/model/API-key secret file. Leave `LITELLM_API_KEY_FILE_HOST` empty when Assistant is unused: compose mounts `/dev/null`. When Assistant is enabled, the host path must already be a readable regular file; do not create a directory at the secret path;
- `CMDP_LITELLM_ALLOWED_BASE_URLS` - server-side allowlist для LiteLLM-compatible endpoints; RuntimeConfig baseUrl не должен выводить API key за этот список;
- `CMDP_ASSISTANT_LLM_MAX_REQUEST_BYTES_ABSOLUTE` и `CMDP_ASSISTANT_LLM_MAX_RESPONSE_BYTES_ABSOLUTE` - deployment ceilings для LiteLLM request/response, defaults `2097152` и `4194304` bytes. Настройки `Cst_QueryToolConfig.RuntimeConfigJson.assistant.llm.maxRequestBytes` (default `524288`) и `assistant.llm.maxResponseBytes` (default `1048576`) могут быть ниже, но server-side clamp не позволяет превысить absolute caps;
- `Cst_QueryToolConfig.RuntimeConfigJson.assistant.mcp` - runtime-настройки read-only MCP tools для Designer Assistant; secrets здесь не хранить;
- `CMDP_D2_RENDER_ENABLED`, `CMDP_D2_BINARY`, `CMDP_D2_TIMEOUT_MS`, `CMDP_D2_MAX_INPUT_BYTES`, `CMDP_D2_MAX_OUTPUT_BYTES`, `CMDP_D2_MAX_DIAGRAMS`, `CMDP_D2_CONCURRENCY`, `CMDP_D2_LAYOUT`, `CMDP_D2_LAYOUT_ALLOWLIST` - обязательный по умолчанию server-side D2 SVG render. В штатном image binary уже лежит в `/usr/local/bin/d2`; при `CMDP_D2_RENDER_ENABLED=true` `/health/ready` требует рабочий binary;
- `CMDP_D2_IMPORT_BINARY`, `CMDP_D2_IMPORT_TIMEOUT_MS`, `CMDP_D2_IMPORT_MAX_INPUT_BYTES`, `CMDP_D2_IMPORT_MAX_OUTPUT_BYTES`, `CMDP_D2_IMPORT_MAX_ELEMENTS`, `CMDP_D2_IMPORT_PROPOSAL_TTL_MS`, `CMDP_D2_IMPORT_ASSISTANT_MAX_SPEC_BYTES`, `CMDP_D2_IMPORT_ASSISTANT_CHECKPOINT_MAX_BYTES`, `CMDP_TEMPLATE_REQUEST_MAX_BYTES` - bounded import self-contained `.d2` в Designer. Штатный image содержит `/usr/local/bin/cmdp-d2-import`; readiness проверяет parser helper отдельно. Proposal подписан, привязан к CMDBuild session/template version и по умолчанию действует 30 минут. Перед LiteLLM raw D2 source/structural IR и composite template удаляются, размер sanitized spec ограничен. `CMDP_D2_IMPORT_ASSISTANT_CHECKPOINT_MAX_BYTES` ограничивает и authoring checkpoint, и server-side resumable mapping checkpoint; превышение очищает mapping checkpoint и возвращает `413 assistant_diagram_mapping_checkpoint_too_large`. После reload checkpoints переаттестуются без LLM и не содержат runtime payload. Общий body limit Preview/Create/Update должен вмещать разрешённые source и normalized IR. Raw D2 source и CMDBuild payload не должны попадать в operational logs;
- `CMDP_LOG_TARGET` - production contract `stdout,syslog`: structured logs остаются в stdout/stderr и дублируются в syslog;
- `CMDP_SYSLOG_HOST`, `CMDP_SYSLOG_PORT`, `CMDP_SYSLOG_PROTOCOL`, `CMDP_SYSLOG_FACILITY` - обязательные параметры approved syslog collector.

`replace-me`, `registry.example.local`, `cmdbuild.example.local`, `redis.example.local`, `litellm.example.local` и `syslog.example.local` не являются рабочими значениями. Real `.env` файлы не коммитить.

`redis://` для local и уже существующих deployment остается поддержанным. В production backend запускается, но пишет runtime warning `redis_plaintext_transport`; для нового production deployment использовать `rediss://`. Если CMDBuild, Redis или LiteLLM использует private PKI, передать единый PEM bundle через read-only mount:

```text
CMDP_TLS_CA_FILE_HOST=/etc/cmdbdynamicpages/customer-ca-bundle.pem
CMDP_TLS_CA_FILE=/run/certs/cmdbdynamicpages-ca.pem
```

Host file должен быть обычным файлом, читаемым Docker daemon и пользователем `node` в container, например mode `0444`. Compose передает его как `NODE_EXTRA_CA_CERTS` для HTTPS CMDBuild/LiteLLM и тем же bundle проверяет Redis TLS. При ротации заменить host file, проверить fingerprint, затем recreate backend container; restart старого container не перечитывает mount contract.

Проверить private PKI до запуска, не используя `--insecure`:

```bash
CMDP_TLS_SMOKE_URL=https://cmdbuild.internal.example/cmdbuild/ \
CMDP_TLS_CA_FILE_HOST=/etc/cmdbdynamicpages/customer-ca-bundle.pem \
bash scripts/tls-ca-smoke.sh
```

В LiteLLM могут передаваться authoring literals, введённые в Assistant prompts, filters, D2 Notes, templates и mapping rules. Runtime rows, resolved parameter values, CMDBuild cards и raw D2 source автоматически не отправляются; они попадут в запрос только если пользователь явно включит их в authoring text.

Перед запуском с включенным Assistant проверить secret mount без вывода ключа:

```bash
test -f "$LITELLM_API_KEY_FILE_HOST" && test -r "$LITELLM_API_KEY_FILE_HOST"
docker compose -f docker-compose.runtime.yml exec cmdbdynamicpages sh -c 'test -f /run/secrets/cmdbdynamicpages_litellm_api_key && test -r /run/secrets/cmdbdynamicpages_litellm_api_key'
test -z "$CMDP_TLS_CA_FILE" || { test "$CMDP_TLS_CA_FILE" = /run/certs/cmdbdynamicpages-ca.pem && test -f "$CMDP_TLS_CA_FILE_HOST" && test -r "$CMDP_TLS_CA_FILE_HOST"; }
```

`CMDP_PUBLIC_ORIGIN` и `CMDBUILD_ORIGIN` имеют разные роли. Например, browser работает с `https://custom.example.local`, а backend обращается к internal CMDBuild `https://vr2.internal.example`. Для этого public origin задать `CMDP_NGINX_PUBLIC_HOST=custom.example.local` и `CMDP_NGINX_PUBLIC_PROTO=https`; delivery validation требует совпадения с host/port и protocol `CMDP_PUBLIC_ORIGIN`. Internal upstream не должен быть доступен пользователям, попадать в browser URLs, redirect `Location`, `Origin`, `Referer` или CMDBuild cookie domain. Bundled nginx намеренно не передает в backend client-supplied `Host`, `X-Forwarded-Host` или `X-Forwarded-Proto`.

Для опубликованных static snapshots raw `.d2` source не отдается публичному endpoint по умолчанию. Если заказчик разрешает скачивание `.d2`, включайте `publish.publicD2Source=true` в шаблоне осознанно: source может содержать structured diagram metadata и бизнес-данные, уже зафиксированные в snapshot.

## Проверка compose template

```bash
docker compose --env-file .env.example -f docker-compose.runtime.yml config
docker compose -f docker-compose.nginx.yml config
```

Bundled nginx использует штатную template processing entrypoint image `nginx:1.27-alpine`: конфигурация монтируется в `/etc/nginx/templates/default.conf.template`, а Compose передает `CMDP_NGINX_PUBLIC_HOST=localhost:8088`, `CMDP_NGINX_PUBLIC_PROTO=http` и `CMDP_NGINX_CUSTOM_API_READ_TIMEOUT=70s` по умолчанию. Эти local defaults совпадают с `CMDP_PUBLIC_ORIGIN=http://localhost:8088`. Не монтировать этот файл напрямую в `/etc/nginx/conf.d/default.conf`, иначе template variable не будет подставлена.

Перед production start проверить уже реальный `.env`:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml config
docker compose --env-file .env -f docker-compose.nginx.yml config
```

Compose template не содержит `build:` и использует только prebuilt `image:`.

`docker compose build --no-cache` с этим template не собирает backend. `--no-cache` управляет только повторным использованием слоёв во время реального `docker build` и не обновляет существующий container.

### Ручная Docker-only сборка

Production deployment использует опубликованный CI image. Если заказчику требуется собрать исходники самостоятельно без Node.js на host, default Docker target формирует рабочий образ с provenance `unverified-local`:

```bash
docker build -t cmdbdynamicpages:manual .
docker run --rm --entrypoint node cmdbdynamicpages:manual scripts/build-identity.mjs verify-runtime --root /app --expect-provenance unverified-local
```

Manual target сам формирует `RUNTIME_SOURCE_MANIFEST.json`, вычисляет его digest и записывает фактические version/digest в `BUILD_INFO.json`. Git revision и dirty state внутри такого образа неизвестны; manual image не получает canonical version/revision/manifest OCI labels и не считается verified release.

Чтобы использовать этот tag с image-only Compose, задайте в deployment `.env`:

```dotenv
CMDBDYNAMIC_IMAGE=cmdbdynamicpages:manual
```

После запуска проверьте `/health/live`: `provenance` должен быть `unverified-local`, а `runtimeManifestSha256` — непустым lowercase SHA-256. Не присваивайте `BUILD_PROVENANCE=verified` вручную.

### Каноническая source-сборка

Канонический helper вычисляет manifest по полному runtime source contract, передает его digest в отдельный canonical Docker target и после сборки сравнивает весь embedded manifest с checkout.

Cross-platform build из checkout с Git metadata:

```bash
npm run container:build -- --tag cmdbdynamicpages:local --no-cache
npm run container:verify -- --image cmdbdynamicpages:local
```

Обычная local-сборка получает provenance `unverified-local` и фактический dirty state. Только canonical helper mode `--require-clean` и CI формируют `verified` image. Strict mode до build отклоняет dirty checkout, а verification после build требует одновременно clean checkout, provenance `verified` и image `dirty=false`:

```bash
npm run container:build -- --tag cmdbdynamicpages:verified-local --require-clean
npm run container:verify -- --image cmdbdynamicpages:verified-local --require-clean
```

Прямой `docker build .` является только manual `unverified-local` path. Customer release принимается из approved registry по image digest и собирается только canonical helper/CI. `--no-cache` не меняет provenance. Node, Go и GitLab Docker base images также закреплены immutable SHA-256 digest; их обновление выполняется отдельным проверяемым изменением CI/Dockerfile.

### Подготовленные GKM base images

Для закрытого registry, внутреннего CA или package mirror подготовьте два Alpine base image. Это отдельная операция заказчика, выполняемая до сборки приложения. Скрипт использует только `docker build`; на хосте не требуются `npm`, Node или Go.

```bash
scripts/build-gkm-base-images.sh \
  --node-tag registry.gkm.local/gkm/node:20-alpine-ca \
  --go-tag registry.gkm.local/gkm/golang:1.25.11-alpine-ca \
  --ca-dir /secure/customer-ca \
  --apk-repositories /secure/apk-repositories
docker push registry.gkm.local/gkm/node:20-alpine-ca
docker push registry.gkm.local/gkm/golang:1.25.11-alpine-ca
```

`--ca-dir` необязателен, но при его указании должен содержать хотя бы один PEM-encoded `.crt` или `.pem`; один файл содержит ровно один certificate, а цепочка передаётся отдельными файлами. `--apk-repositories` необязателен и должен содержать Alpine repositories. Перед pull/push private registry Docker daemon хоста должен доверять CA registry: trust внутри base image не заменяет этот prerequisite.

После этого соберите сервис из checkout. Рекомендуемая явная команда:

```bash
docker build \
  --target gkm-runtime \
  --build-arg GKM_NODE_BASE_IMAGE=registry.gkm.local/gkm/node:20-alpine-ca \
  --build-arg GKM_GO_BASE_IMAGE=registry.gkm.local/gkm/golang:1.25.11-alpine-ca \
  --tag registry.gkm.local/gkm/cmdbdynamicpages:local \
  .
```

Эквивалентный удобный shell wrapper вызывает ту же команду Docker:

```bash
scripts/build-gkm-runtime.sh \
  --node-base-image registry.gkm.local/gkm/node:20-alpine-ca \
  --go-base-image registry.gkm.local/gkm/golang:1.25.11-alpine-ca \
  --tag registry.gkm.local/gkm/cmdbdynamicpages:local
```

Проверьте embedded identity без Node/npm на хосте:

```bash
docker run --rm --entrypoint cat registry.gkm.local/gkm/cmdbdynamicpages:local \
  /app/BUILD_INFO.json
```

В JSON должны быть `"provenance":"unverified-local"`, `"revision":"unknown"` и непустой `runtimeManifestSha256`. `gkm-runtime` не принимает release provenance arguments. Для проверяемого CI/release image используется отдельный target `gkm-runtime-canonical` через `scripts/container-image.mjs`; это не процедура ручной сборки заказчика.

Prepared base images обязаны сохранять поддерживаемые OS family, package manager, CPU architecture, Node/Go ABI и пользователя `node`; они содержат CA trust store и конфигурацию package repository/mirror. Product Dockerfile не копирует customer CA, registry credentials или repository configuration, но после `FROM` устанавливает собственные утилиты, необходимые для загрузки D2 (`curl`, `tar`). Для этого проекта команды используют `apk`; миграция на другое семейство ОС требует отдельного изменения Dockerfile.

Build-time trust, registry daemon trust и runtime trust различны. Runtime mount `CMDP_TLS_CA_FILE` остаётся отдельным контрактом: entrypoint передаёт его в `NODE_EXTRA_CA_CERTS`. Если mount не задан, inherited `NODE_EXTRA_CA_CERTS` prepared Node base image не перезаписывается.

## Запуск и остановка

```bash
docker login <approved-registry>
docker compose --env-file .env -f docker-compose.runtime.yml pull
docker compose --env-file .env -f docker-compose.runtime.yml up -d --force-recreate
docker compose --env-file .env -f docker-compose.runtime.yml ps
```

Остановка:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml down
```

Rollback:

1. Вернуть `CMDBDYNAMIC_IMAGE` в `.env` на предыдущий approved tag.
2. Выполнить `docker compose --env-file .env -f docker-compose.runtime.yml pull`.
3. Выполнить `docker compose --env-file .env -f docker-compose.runtime.yml up -d --force-recreate`.
4. Повторить health/metrics checks.

## Health, metrics и логи

```bash
curl -fsS http://127.0.0.1:8093/health/live
curl -fsS http://127.0.0.1:8093/health/ready
curl -fsS http://127.0.0.1:8093/health/redis
curl -fsS http://127.0.0.1:8093/metrics
docker logs --tail=100 cmdbdynamicpages-backend
```

После deploy сравнить выбранный image и реально запущенный container:

```bash
docker compose --env-file .env -f docker-compose.runtime.yml config --images
docker inspect cmdbdynamicpages-backend --format 'configured={{.Config.Image}} running={{.Image}} started={{.State.StartedAt}}'
npm run container:verify -- --image "$(docker compose --env-file .env -f docker-compose.runtime.yml config --images | head -n 1)" --container cmdbdynamicpages-backend
```

`container:verify` сравнивает не отдельный entrypoint, а полный canonical `RUNTIME_SOURCE_MANIFEST.json`, его digest в `BUILD_INFO.json`, OCI label и, при `--container`, файлы реально запущенного container. Поле `build.runtimeManifestSha256` в `/health/live` должно совпадать с image metadata; поля `build.version`, `build.revision`, `build.provenance` и `build.editorSha256` также должны совпадать с меню «О программе» и соответствующими HTTP headers `X-CMDP-*`. Если checkout, image и container имеют разные manifest/Designer SHA-256, проблема находится до reverse proxy. Если они совпадают, а public UI отличается, проверить routing внешнего proxy и открыть новую вкладку: Designer отвечает с `Cache-Control: no-store`, но уже открытая SPA продолжает исполнять ранее загруженный JavaScript.

Ожидания:

- `/health/live` - liveness: возвращает `200`, если Node process отвечает; не доказывает готовность зависимостей;
- `/health/ready` - readiness: возвращает `200`, только если Redis, CMDBuild upstream и обязательный D2 renderer доступны;
- `/health/redis` возвращает `200` при доступном Redis;
- `/metrics` возвращает Prometheus text без cookies, tokens, user names, runtime rows и raw CMDBuild payload;
- Backend Docker healthcheck использует только `/health/live`; rollout и traffic routing должны использовать `/health/ready`. Bundled nginx healthcheck выполняет `nginx -t` и проверяет master process по `/var/run/nginx.pid`; он не делает HTTP-запрос через backend.

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
