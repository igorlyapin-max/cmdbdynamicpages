# Архитектурные артефакты cmdbdynamicpages

Комплект соответствует GKM AA и skill `architecture-artifacts`. Источник истины — Markdown, Mermaid и OpenAPI, сверенные с кодом. XLSX — версионируемое представление тех же карт для поставки.

## Граница решения

Проект владеет backend/UI `cmdbdynamicpages`, launcher custom page, D2 importer/renderer и опциональным проектным reverse proxy. CMDBuild, Redis, LiteLLM и платформа мониторинга/логирования — внешние зависимости. Их внутреннее устройство, общий nginx стенда и сервисы соседних проектов не входят в поставку.

## Индекс

| Артефакт | Источник | Поставка |
| --- | --- | --- |
| Бизнес-процессы | [business-processes.md](business-processes.md) | Mermaid |
| Информационная модель | [information-model.md](information-model.md) | [Обзорная схема SVG](cmdbdynamicpages-environment-architecture.svg) |
| Развертывание | [deployment.md](deployment.md) | Mermaid |
| Собственный API | [openapi.yaml](openapi.yaml) | OpenAPI |
| Потребляемый CMDBuild REST | [cmdbuild-consumed.openapi.yaml](openapi/cmdbuild-consumed.openapi.yaml) | OpenAPI |
| Потребляемый LiteLLM API | [litellm-consumed.openapi.yaml](openapi/litellm-consumed.openapi.yaml) | OpenAPI |
| HealthCheck | [healthcheck-map.md](healthcheck-map.md) | [healthcheck-map.xlsx](xlsx/healthcheck-map.xlsx) |
| Метрики | [metrics-map.md](metrics-map.md) | [metrics-map.xlsx](xlsx/metrics-map.xlsx) |
| Секреты | [secrets-map.md](secrets-map.md) | [secrets-rotation-map.xlsx](xlsx/secrets-rotation-map.xlsx) |
| Регистрация событий | [event-logging-map.md](event-logging-map.md) | [event-logging-map.xlsx](xlsx/event-logging-map.xlsx) |
| Маршруты логирования | [logging-flow.md](logging-flow.md) | Mermaid |
| AsyncAPI: неприменимо | [asyncapi-applicability.md](asyncapi-applicability.md) | Брокерного обмена нет |
| Kafka: неприменимо | [kafka-access-map.md](kafka-access-map.md) | XLSX не создаётся |
| Файловый обмен: неприменимо | [file-access-map.md](file-access-map.md) | XLSX не создаётся |

## Идентификаторы и достоверность

Реестр в [information-model.md](information-model.md) определяет идентификаторы один раз: `OAPI0` — HTTP API, `H0` — health, `M0` — метрики, `L0` — логирование, `IF0` — прочие потоки. Нумерация внутри типа начинается с нуля, без разделителей и ведущих нулей; пробелы между выделенными диапазонами допустимы. Префикс AAPI применяется только при появлении брокерного обмена.

Все карты и `x-flow-id` OpenAPI ссылаются на этот реестр. Сетевые каналы содержат протокол и порт; локальные адреса отделены от параметров эксплуатационных контуров. Неизвестные значения отмечены `Требует согласования`.

Не включать токены, cookie, пароли, приватные ключи, реальные сертификаты заказчика и бизнес-данные. Имена переменных и пути монтирования секретов допустимы без значений.

## Обновление и проверка

1. Обновить реестр, API и карты по фактическим операциям кода. Mermaid и обзорный SVG должны отражать те же границы и направления данных.
2. Установить инструменты: `python3 -m pip install -r scripts/requirements-aa.txt` (рекомендуется virtualenv).
3. Подготовить временные данные: `python3 scripts/aa_workbooks.py export --output-dir /tmp/cmdbdynamicpages-aa-data`. Данные извлекаются из помеченных таблиц карт; вручную JSON не заполнять.
4. Выпустить XLSX: `python3 scripts/aa_workbooks.py generate`. Команда вызывает global `aa_xlsx.py create` и `validate`. Каталог шаблонов — `AA_XLSX_TEMPLATE_DIR`, по умолчанию `$HOME/projects/files/aa`; helper — `AA_XLSX_HELPER`, по умолчанию `$HOME/.codex/skills/architecture-artifacts/scripts/aa_xlsx.py`. Шаблоны и временные JSON не коммитить.
5. Выполнить `npm run test:static`, `npm run secret:scan` и `git diff --check`. Коммитить исходники и четыре книги вместе.

CI использует только repo-owned валидаторы и `scripts/requirements-aa.txt`: skills и каталог шаблонов не требуются. Проверяются комплектность, ссылки, потоки, OpenAPI и содержимое XLSX. Сверка соответствия реальной архитектуре и согласование эксплуатационных параметров остаются обязательными.
