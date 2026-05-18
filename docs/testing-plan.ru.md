# План тестирования

Русская ветка. Английская ветка: [testing-plan.md](testing-plan.md).

## Реализовано

- `npm run check`: syntax check custom page, proxy, diagnostics, e2e и validation scripts.
- `npm run test:static`: проверяет обязательные OpenAPI paths, локальные component references и ссылки архитектурных артефактов.
- `npm run test:unit`: покрывает настройки кэша, scope ключей кэша, refresh metadata, параметры static snapshot URL, defaults параметров, IPv4-сопоставление, dependency map и маскирование логов.
- `npm run test:api`: skip-safe API smoke для `/health/*`, защищенного logging status и отказа state-changing вызовов без CSRF/session на запущенном proxy.
- `npm run test:ui`: skip-safe Playwright smoke для списка шаблонов Designer, fixed menu/action bar, контекстных кнопок Run и компактной Runtime shell.
- `npm run test:nginx`: проверяет nginx config и same-origin wiki/dynamicpages маршруты через `localhost:8088`.
- `npm run e2e`: расширен проверками logging diagnostics, draft preview без runtime cache, runtime cache hit, POST `forceRefresh` и тем, что GET runtime не делает forced refresh.

## Осталось

- Добавить более глубокие Playwright Runtime table tests для client-side search/sort и отключения search/sort при row grouping.
- Добавить browser-level проверку iframe внутри реальной wiki page, когда в локальной wiki появится стабильная тестовая страница.
- Для live e2e нужен свежий CMDBuild session cookie или явные `CMDBUILD_USERNAME`/`CMDBUILD_PASSWORD`.
