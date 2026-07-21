# Roadmap cmdbdynamicpages

Русская ветка roadmap. Английская версия: [roadmap.md](roadmap.md).

Легенда:

- `[x]` выполнено
- `[ ]` не выполнено

## Текущий статус

Выполнено:

- `CmdbDynamicPages` зарегистрирован как CMDBuild custom page.
- CMDBuild открывается через same-origin dev proxy.
- Backend маршруты `/cmdbuild/custom-api/*` получают `HttpOnly` cookie CMDBuild.
- Backend вызывает CMDBuild REST от имени текущего пользователя через серверный заголовок `CMDBuild-Authorization`.
- Custom page превращен в тонкий launcher.
- Designer и Runtime обслуживаются backend-owned маршрутами `/cmdbuild/dynamicpages/ui/*`.
- Техническая схема создана под root `Cst_QueryTool`.
- Шаблоны и настройки хранятся в CMDBuild технических классах.
- Template CRUD, versioning, validate/preview/run реализованы.
- Runtime iframe использует read-only `GET run` без CSRF.
- State-changing backend API требует same-origin headers и `X-CMDBDynamicPages-CSRF`.
- DSL v1 поддерживает выборки, фильтры, regexp extraction, relation expansion, сопоставление, итоговые данные и визуализацию.
- Designer поддерживает русский/английский язык.
- Designer открывает список шаблонов без авто-выбора первого шаблона.
- Designer умеет создавать шаблон, копировать из существующего, редактировать входные переменные, `ВыборкаX`, сопоставление, итоговые данные, визуализацию, кэширование и прогон.
- Designer содержит раздел `Схема` для первого запуска: root, описание, родительский суперкласс, preview и non-destructive bootstrap.
- Каталог CMDBuild кэшируется на клиенте; светофор каталога показывает freshness и запускает sync.
- Runtime table sorting и text filtering выполняются на клиенте без повторного обращения к серверу.
- Row grouping отключает сортировку/фильтры, потому что merged cells требуют стабильного порядка строк.
- Runtime result cache работает через Redis с memory fallback для dev.
- Cache behavior задается на уровне шаблона: `permissionOnly`, `visibilityHash`, `privateUser`, `disabled`.
- TTL кэша шаблона редактируется в часах, default для новых шаблонов 8 часов.
- System refresh cooldown хранится в `Cst_QueryToolConfig.RuntimeConfigJson.runtimeCache.refreshCooldownSec`.
- Static snapshot publication сохраняет результат в Redis и отдает его без проверки прав зрителя на исходные объекты.
- BAA verification exchange удален из runtime/API surface; legacy BAA поля очищаются или отклоняются validation.
- Static topology diagrams поддержаны через `result.diagrams` и рендерятся как SVG в runtime HTML плюс `diagrams[]` в runtime JSON.
- Optional Designer `Assistant draft` использует настроенный LiteLLM-compatible endpoint и валидирует generated DSL перед применением.
- Production health/readiness endpoint'ы реализованы: live, ready, redis.
- Redis password поддерживается через secret file/env/URL и маскируется в health/status ответах.
- Docker runtime packaging, минимальные GitHub Actions/GitLab CI, retry/backoff, execution throttling, graceful shutdown, keep-alive CMDBuild agents, security headers, nginx rate limiting, strict CMDBuild proxy allowlist, JSON mutation `Content-Type` checks, Prometheus `/metrics`, Redis strict mode, regex guard и template `specHash` conflict guard реализованы как audit hardening.
- `PROJECT_DOCUMENTATION.md`, audit remediation notes и начальные ADR фиксируют текущую карту документации и отложенные архитектурные решения.
- `docs/runbook.ru.md` фиксирует deploy checks, rollback, diagnostics, incidents, SLI candidates и alert inputs.
- Nginx same-origin маршрут `/health/` проксируется в dynamicpages backend.
- Документация ведется на английском и русском.
- Архитектурные артефакты ведутся в `aa/`.

Не выполнено в текущем плане:

- Нет оставшихся core implementation задач.
- Примеры шаблонов ведутся отдельно от roadmap.
- Глубокие Playwright Runtime table проверки реализованы как skip-safe tests и зависят от доступных live template fixtures для полного покрытия.
- Browser smoke для согласованных заказчиком topology diagrams будет добавлен после стабилизации целевых layout.

## 1. Проверка ролей и групп CMDBuild

- [x] Найдены REST endpoints для roles/users/groups.
- [x] Проверены admin и обычный пользователь `mdavis` / `Helpdesk`.
- [x] Принято решение использовать CRUD-права CMDBuild на `Cst_QueryTemplate` как право редактора.
- [x] Permission-scope probe оставлен как диагностика, а не как доказательство равного row-level visibility.

## 2. Технический root/bootstrap

- [x] Спроектирован root `Cst_QueryTool`.
- [x] Проверено создание классов через CMDBuild REST.
- [x] Реализованы:
  - `GET /cmdbuild/custom-api/schema`
  - `POST /cmdbuild/custom-api/schema/bootstrap`
- [x] Root используется только для технических классов, не для ограничения бизнес-запросов.

## 3. CMDBuild-классы хранения

- [x] `Cst_QueryToolConfig`
- [x] `Cst_QueryTemplate`
- [x] `Cst_QueryTemplateVersion`
- [x] Runtime config хранится в `Cst_QueryToolConfig.RuntimeConfigJson`.
- [x] Шаблоны хранятся в CMDBuild, не в локальных файлах.

## 4. Backend API

- [x] Session/model/auth endpoints.
- [x] Technical schema endpoints.
- [x] Config endpoints.
- [x] Template CRUD.
- [x] Version endpoints.
- [x] Draft validate/preview.
- [x] Template validate/preview/run/publish.
- [x] Public static snapshot run.
- [x] Diagnostic logs.
- [x] Cache status.
- [x] Production health/readiness endpoints.

## 5. DSL v1

- [x] JSON validation.
- [x] Executor.
- [x] `findClassesByAttributeType`.
- [x] `extractVariables`.
- [x] `selectCards`.
- [x] `expandRelations`.
- [x] `composeRows`.
- [x] joins/intersections/matching.
- [x] Ограничения по строкам, классам, доменам, REST calls и traversal depth.
- [x] Used-field dependency map, чтобы не читать лишние атрибуты.

## 6. Designer UI

- [x] Standalone backend UI.
- [x] Двухуровневое левое меню.
- [x] Отдельные route для разделов.
- [x] Список шаблонов.
- [x] Создание/копирование шаблона.
- [x] Входные переменные.
- [x] Группа объектов / `ВыборкаX`.
- [x] Сопоставление с объектами.
- [x] Итоговые данные.
- [x] Визуализация.
- [x] Кэширование.
- [x] Публикация.
- [x] Настройки.
- [x] Прогон.
- [x] Русский/английский UI.
- [x] Каталог CMDBuild с freshness indicator.

## 7. Runtime UI

- [x] `/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value`.
- [x] Custom page launcher compatibility.
- [x] Read-only `GET run`.
- [x] Только финальная таблица на отдельной странице.
- [x] URL для iframe/link.
- [x] Client-side sorting/filtering.
- [x] Runtime cache bar с countdown.

## 8. Hardening

- [x] Same-origin + CSRF для state-changing API.
- [x] Нет generic REST proxy.
- [x] Cookie/token не логируются.
- [x] Execution limits.
- [x] Request timeout к CMDBuild.
- [x] Audit log для preview/direct POST run.
- [x] Read-only iframe runtime.
- [x] Redis password as secret.
- [x] Health/readiness.

## 9. End-to-end проверки

- [x] `npm run check`
- [x] `npm test`
- [x] `npm run test:static`
- [x] `npm run test:unit`
- [x] `npm run test:api`
- [x] `npm run test:ui`
- [x] `npm run test:nginx`
- [x] `npm run diag`
- [x] `npm run e2e`
- [x] `npm run e2e:write`
- [x] `npm run e2e:limited`
- [x] `npm run nginx:test`
- [x] manual health checks:
  - `/health/live`
  - `/health/redis`
  - `/health/ready`

## Точки входа

```text
Designer:
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/designer

Runtime:
http://127.0.0.1:8093/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value

Health:
http://127.0.0.1:8093/health/ready
http://localhost:8088/health/ready
```
