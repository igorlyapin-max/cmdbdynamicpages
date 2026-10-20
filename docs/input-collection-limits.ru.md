# Лимиты структурных входных коллекций

Контракт относится к входу owned authoring API: template POST/PUT,
draft validate/preview, Object Flow plan/semantic-plan/apply и Diagram Import
analyze/apply/restore/refresh/interpret/map-selections. Публичные endpoints,
аутентификация и consumed CMDBuild/LiteLLM contracts не изменяются.

## Конфигурация

| Параметр | Default | Абсолютный максимум | Назначение |
| --- | ---: | ---: | --- |
| `CMDP_INPUT_MAX_COLLECTION_ITEMS` | 5000 | 50000 | Одна структурная коллекция без отдельного предметного лимита |
| `CMDP_INPUT_MAX_TOTAL_ITEMS` | 50000 | 500000 | Сумма длин проверяемых структурных коллекций одного входа |
| `CMDP_D2_IMPORT_MAX_ELEMENTS` | 5000 | 50000 | Существующий предметный лимит D2 roles, relationRules, endpointProfiles и structureTree items |

Настройка должна быть положительным целым числом. Значение выше абсолютного
максимума ограничивается максимумом; некорректное значение заменяется default.
Конфигурация читается при запуске backend. `limits.effective` показывает
действующие значения, `limits.meta` - запрошенные значения и причину ограничения.
Поля metadata: `requested`, `effective`, `absolute`, `clampedBy`; последнее равно
`default`, `absolute` либо `null`. GET config предоставляет
`inputCollectionLimits`; новый путь записи runtime config не вводится.

Отдельные неизменяемые caps: `intent.blocks` - 32 бизнес-блока,
`intent.blocks[].uses` - 31 зависимость. Это предметные ограничения,
а не default общего лимита. Суммарный бюджет учитывает и эти коллекции.
Каноническое поле зависимостей - `uses`; `dependsOn` не поддерживается.
`AssistantEditorDelta.spec.params` - объект, а не массив.

## Граница проверки

Guard проверяет поддерживаемые поля authoring-структуры, а не любой массив
в JSON. В область входят определения steps, Object Flow selections/operations,
rules/filters, columns, таблиц и диаграмм, visualModels, D2 roles/relationRules,
structureTree, клиентские stages, relation-rule path и структурные поля
mapping/checkpoint, в том числе вложенные в
полный `spec`, `currentSpec` и сохранённый `spec.authoring`.

Непрозрачные full-spec объекты в OpenAPI отмечены
`x-input-collection-policy: full-spec`: это обещание проверки известных
структурных путей, не рекурсивный лимит на произвольные бизнес-объекты.
Схема не изобретает внутренние поля для `additionalProperties: true`.

Не ограничиваются этим guard: строки результата (`rows/staticRows`), output
catalog/Help, данные CMDBuild/LiteLLM, произвольные `params/defaults`, literal
values/операнды фильтров, prompts и response-only массивы. Например, массив
в literal `right.value` не становится структурной коллекцией из-за имён
`steps` или `roles` внутри него. Диагностика `proposal.unresolved`, даже если
возвращается во входе подписанного предложения, помечена `output-data`.

Проверка выполняется над исходными коллекциями до нормализации, deduplication,
upstream-вызовов и сохранения. Guard никогда не обрезает вход. Повторяющиеся
элементы учитываются по исходному количеству; вложенная коллекция добавляет
свою длину в суммарный счётчик. Лимиты размера JSON/D2 в байтах, времени,
выполнения и model context действуют отдельно и не заменяются этими caps.
Same-origin/CSRF и права доступа сохраняются; ранний 413 не отменяет их.

Для Assistant дополнительно проверяется объединение сохранённого шаблона и
`editorDelta`: по отдельности допустимые части не могут обойти суммарный бюджет.
Для этой проверки требуется прочитать сохранённую основу; проверка объединённого
состояния выполняется до его клонирования, компиляции и записи. Сам новый вход
запроса проверяется до обращения к CMDBuild.

## OpenAPI

`maxItems: 50000` у структурных request-массивов описывает абсолютный предел,
а не эффективный default 5000. Иначе OpenAPI ошибочно запрещал бы вход,
который оператор разрешил конфигурацией. Description у массива называет
соответствующий параметр/default; верхнеуровневый
`x-input-collection-limits` фиксирует defaults, абсолютные и предметные caps.
Эффективный лимит может быть ниже schema cap.

Массивы `ObjectFlowProposal` и D2-схем, достижимые и из request, и из response,
имеют ограничения принимаемого входа. Только ответные `catalog`, `rows`,
warnings и другие response-only массивы не получают входной `maxItems`.
Ранний 413 описан reusable response `InputCollectionLimit`; существующие
413 byte/context limits сохранены как альтернативные схемы ответа.

## Ошибка HTTP 413

```json
{
  "success": false,
  "code": "input_collection_limit",
  "message": "Authoring input exceeds a structural collection limit. Reduce the collection or ask the operator to adjust its configured limit.",
  "requestId": "example-request-id",
  "errors": [{"path": "$.spec.steps[0].filters", "actualCount": 5001, "limit": 5000}],
  "limits": {
    "effective": {"maxCollectionItems": 5000, "maxTotalItems": 50000, "d2MaxElements": 5000},
    "meta": {
      "maxCollectionItems": {"requested": 5000, "effective": 5000, "absolute": 50000, "clampedBy": null},
      "maxTotalItems": {"requested": 50000, "effective": 50000, "absolute": 500000, "clampedBy": null},
      "d2MaxElements": {"requested": 5000, "effective": 5000, "absolute": 50000, "clampedBy": null}
    }
  }
}
```

`requestId` optional. `errors[].path` состоит из известных полей схемы и
индексов, не из произвольных ключей payload. `actualCount` - длина нарушившей
коллекции либо накопленный суммарный счётчик; `limit` - нарушенный эффективный
лимит. Сообщение фиксированное: значения входа, cookies, tokens и prompts
в ошибку не включаются. Событие `security.input_collection_limit` использует
основной structured logging pipeline, без отдельного raw-payload логирования.

## Offline-проверка

```bash
python3 -B scripts/aa_contracts.py
python3 -B -m unittest discover -s tests/aa -p 'test_input_contracts.py'
```

Валидатор разбирает YAML, начинает обход только с operation request bodies,
следует локальным `$ref` и composition-схемам, проверяет структурные массивы,
opaque full-spec policy и 413. Defaults/caps сверяются с литералами
`INPUT_COLLECTION_DEFAULT_LIMITS` / `INPUT_COLLECTION_ABSOLUTE_LIMITS` и
предметными caps общего `scripts/input-collection-limits.mjs`, без импорта
backend, чтения env, запуска runtime или вызовов LLM. Consumed specifications
не получают owned-input требования. `security: []` остаётся допустимой явной
границей публичного доступа. Legacy для прежнего `dependsOn` не поддержана
и не запланирована.

## Проверка На Стенде

20.10.2026 проверены 723 unit-теста, 124 API-теста (один намеренный skip
удалённого контракта), 36 AA-тестов и 4 обязательных browser-теста.
Отдельная API-матрица доказывает отказ на 12 authoring-путях без новых upstream
вызовов, соблюдение CSRF, допустимость ровно 5000 фильтров и исключение literals.

Через обычный UI на изолированной копии `aspm20261020_testtemplate4` проверены:
отказ 413 без изменения сохранённого шаблона и без потери редактируемой подписи,
последующее успешное сохранение, reload, видимые DNS/AD в извлечении и диаграмма
с 16 предметными стрелками плюс тремя статическими стрелками легенды. Проверка
использовала ранее подтверждённый mapping копии testtemplate4, не повторную
генерацию Assistant. Строгий preview сохранённой копии также выполнен без LLM.
Исходные шаблоны и бизнес-данные не изменялись.

Backend пересобран и пересоздан; workspace/image/running hashes и readiness
проверены. Повторное сканирование ASPM в окружении заказчика не выполнялось;
изменение статусов записей его отчёта не заявляется.
