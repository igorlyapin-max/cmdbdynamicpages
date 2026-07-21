# План тестирования

Русская ветка. Английская ветка: [testing-plan.md](testing-plan.md).

## Реализовано

- `npm run check`: syntax check custom page, proxy, diagnostics, e2e и validation scripts.
- `npm run secret:scan`: сканирует repository text files на high-confidence committed secrets, исключая generated/runtime directories.
- `npm run build:zip`: собирает CMDBuild custom page ZIP dependency-free Node builder'ом.
- `npm run ci`: запускает `secret:scan`, `npm test` и `build:zip`.
- `npm run test:static`: проверяет обязательные OpenAPI paths, локальные component references и ссылки архитектурных артефактов.
- `npm run test:unit`: покрывает настройки кэша, scope ключей кэша, refresh metadata, параметры static snapshot URL, defaults параметров, IPv4-сопоставление, topology diagram payloads, runtime JSON output-mode filtering, assistant MCP allowlist/defaults, dependency map, маскирование логов, diagnostic mode, assistant-disabled config и runtime config validation.
- `npm run test:api`: skip-safe API smoke для `/health/*`, `/metrics`, защищенного logging status и отказа state-changing вызовов без CSRF/session на запущенном proxy.
- `npm run test:ui`: skip-safe Playwright smoke для списка шаблонов Designer, fixed menu/action bar, контекстных кнопок Run, компактной Runtime shell, runtime table search/sort, отключения grouped-table controls и split-subtable local sorting.
- `npm run test:nginx`: проверяет project-only nginx config и маршруты `cmdbdynamicpages` через `localhost:8088`.
- `npm run e2e`: проверяет logging diagnostics, draft preview без runtime cache, runtime cache hit, POST `forceRefresh`, что GET runtime не делает forced refresh, и write-mode `expectedSpecHash` conflict handling.

## Осталось

- Для live e2e нужен свежий CMDBuild session cookie или явные `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD`.
- Добавить browser smoke для rendered topology SVG diagrams и Assistant section controls после подтверждения целевых видов диаграмм заказчиком и доступа к LiteLLM стенду для UI automation.
