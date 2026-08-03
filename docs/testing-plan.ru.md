# План тестирования

Русская ветка. Английская ветка: [testing-plan.md](testing-plan.md).

## Реализовано

- `npm run check`: syntax check custom page, proxy, diagnostics, e2e и validation scripts.
- `npm run secret:scan`: сканирует repository text files на high-confidence committed secrets, исключая generated/runtime directories.
- `npm run build:zip`: собирает CMDBuild custom page ZIP dependency-free Node builder'ом.
- `npm run ci`: запускает `secret:scan`, `npm test` и `build:zip`. GitHub Actions и GitLab CI дополнительно устанавливают pinned Playwright/Chromium и выполняют `test:ui:required`.
- `npm run test:static`: проверяет обязательные OpenAPI paths, локальные component references и ссылки архитектурных артефактов.
- `npm run test:unit`: покрывает настройки кэша, scope ключей кэша, refresh metadata, параметры static snapshot URL, defaults параметров, IPv4-сопоставление, topology diagram payloads, runtime JSON output-mode filtering, assistant MCP allowlist/defaults, dependency map, маскирование логов, diagnostic mode, assistant-disabled config и runtime config validation.
- `npm run test:api`: API contract smoke для `/health/*`, `/metrics`, защищенного logging status, same-origin/CSRF отказов и JSON content-type проверки. Readiness проверяется по `checks.redis`, `checks.cmdbuild`, `checks.d2`, `checks.d2Import`.
- `npm run test:ui`: skip-safe Playwright smoke для списка шаблонов Designer, fixed menu/action bar, контекстных кнопок Run, компактной Runtime shell, runtime table search/sort, отключения grouped-table controls и split-subtable local sorting.
- `npm run test:ui:required`: обязательный CI browser gate. Он поднимает изолированный CMDBuild API fixture и backend, требует Chromium и валидную fixture session, затем проверяет видимые сценарии Designer. При отсутствии browser или fixture команда завершается ошибкой, а не skip.
- `npm run test:nginx`: проверяет project-only nginx config и маршруты `cmdbdynamicpages` через `localhost:8088`.
- `npm run e2e`: проверяет logging diagnostics, draft preview без runtime cache, runtime cache hit, POST `forceRefresh`, что GET runtime не делает forced refresh, technical schema bootstrap и write-mode `expectedSpecHash` conflict handling.

При валидной non-readonly CMDBuild admin session обычный `npm run e2e` вызывает `POST /schema/bootstrap`. Он создает только отсутствующие technical CMDBuild classes и attributes, поэтому изменяет состояние. `CMDBDYNAMIC_EXPECT_READONLY=1` предназначен для ограниченной CMDBuild-учетной записи: bootstrap не вызывается, а e2e проверяет запрет создания шаблона. Это не admin check-only режим.

## Осталось

- Для live e2e нужен свежий CMDBuild session cookie или явные `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD`.
- Для authenticated ветки `npm run test:api` задайте `CMDBUILD_COOKIE_HEADER` либо `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD` (опционально `CMDBUILD_LOGIN_ORIGIN`, `CMDBUILD_ROLE`, `CMDBUILD_SCOPE`). Без этих значений публичные и reject-сценарии выполняются, а проверка content-type после валидной session явно пропускается.
- Добавить browser smoke для rendered topology SVG diagrams и Assistant section controls после подтверждения целевых видов диаграмм заказчиком и доступа к LiteLLM стенду для UI automation.
