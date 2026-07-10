# Возможное расширение: MCP/LangGraph assistant для подготовки шаблонов

Статус: proposal / backlog. Документ фиксирует отдельное направление развития, а не текущий runtime contract и не утвержденный roadmap.

Дата фиксации: 2026-07-09.

## Summary

Текущий проект должен продолжать выполнять таблицы и будущие диаграммы детерминированно: по сохраненному `SpecJson`, под текущей CMDBuild-сессией пользователя, с текущей моделью cache/static snapshot.

Переходить на MCP/LangGraph для обычного runtime формирования таблиц неразумно. Табличный runtime сейчас ценен именно тем, что он воспроизводимый, тестируемый, кэшируемый и не зависит от LLM. MCP/LangGraph лучше рассматривать как отдельный assistant-слой для Designer/editor:

- разобрать пользовательский intent;
- через read-only MCP endpoint изучить доступную модель CMDBuild;
- предложить draft DSL/template spec;
- прогнать deterministic validation/preview;
- сохранить результат только после подтверждения редактора.

Обычный просмотр страницы не должен вызывать LLM, MCP-agent или LangGraph workflow.

## Целевая граница

```text
Editor intent
  -> Template Assistant API
  -> optional LangGraph workflow
  -> MCP read-only CMDBuild tools
  -> draft template spec
  -> deterministic validation/preview
  -> human approval
  -> save to Cst_QueryTemplate.SpecJson
  -> runtime GET run executes saved spec without LLM/MCP assistant
```

Runtime остается прежним:

```text
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
  -> load saved template
  -> execute deterministic DSL under current user session
  -> apply limits/cache/static snapshot rules
  -> render static web page
```

## Пример целевого сценария

Пользовательский запрос в Designer:

```text
Возьми входной параметр "информационная система", найди ее в CMDBuild,
по связям найди все серверы, по серверам найди IP и VLAN,
выведи результат в таблицу.
```

Assistant не должен выполнять production runtime-запрос как финальный результат. Он должен подготовить draft template:

```json
{
  "params": [
    {
      "name": "informationSystem",
      "type": "text",
      "required": true
    }
  ],
  "steps": [
    {
      "name": "system",
      "type": "selectCards",
      "className": "InformationSystem",
      "where": {
        "codeOrName": "{{params.informationSystem}}"
      },
      "limit": 1
    },
    {
      "name": "servers",
      "type": "expandRelations",
      "from": "system",
      "domain": "InformationSystem_Server",
      "targetClass": "Server",
      "maxDepth": 1
    },
    {
      "name": "ipAddresses",
      "type": "expandRelations",
      "from": "servers",
      "domain": "Server_IPAddress",
      "targetClass": "IPAddress"
    },
    {
      "name": "vlans",
      "type": "expandRelations",
      "from": "ipAddresses",
      "domain": "IPAddress_VLAN",
      "targetClass": "VLAN"
    }
  ],
  "result": {
    "tables": [
      {
        "name": "serverNetwork",
        "title": "Servers / IP / VLAN",
        "columns": [
          { "key": "serverCode", "title": "Server" },
          { "key": "ipAddress", "title": "IP" },
          { "key": "vlanName", "title": "VLAN" }
        ],
        "source": "composeRows(server, ipAddresses, vlans)"
      }
    ]
  }
}
```

Имена классов, доменов и полей выше являются иллюстрацией. Реальный draft должен строиться только после inspection доступной модели CMDBuild.

## Почему не заменять текущий table runtime

Текущий runtime для таблиц должен остаться основным механизмом:

- результат воспроизводим для одинаковых `templateCode`, `SpecJson`, параметров, прав и лимитов;
- cache key можно считать детерминированно;
- ошибки можно валидировать schema/API/unit тестами;
- права CMDBuild применяются на каждом REST-запросе backend-а;
- static snapshot остается обычным опубликованным artifact;
- page rendering не зависит от доступности LLM/MCP/LangGraph.

LLM-agent в runtime ухудшит эти свойства:

- появится недетерминированный план запроса;
- возрастут latency и операционная стоимость;
- появится prompt-injection поверхность через CMDBuild data/model labels;
- сложнее доказывать, что cache соответствует правам текущего пользователя;
- сложнее гарантировать одинаковый результат при повторной публикации snapshot.

## MCP endpoint для CMDBuild

MCP endpoint нужен не как generic CMDBuild proxy, а как узкий read-only contract для assistant-а.

Минимальный набор tools/resources:

- `get_visible_model_catalog` - список доступных классов, доменов и атрибутов с учетом текущего пользователя;
- `inspect_class` - метаданные класса, ключевые поля, searchable/display attributes;
- `inspect_domains` - связи класса, direction, cardinality, target classes;
- `sample_cards_limited` - малая выборка карточек только для disambiguation, с лимитами и masking policy;
- `validate_template_spec` - deterministic проверка draft spec без сохранения;
- `preview_template_spec` - deterministic preview на ограниченном наборе данных без записи в runtime cache;
- `explain_template_spec` - человекочитаемое объяснение, какие классы/связи будет читать шаблон.

Запрещенные свойства v1:

- generic REST passthrough в CMDBuild;
- write tools для карточек, доменов, классов или grants;
- передача `CMDBuild-Authorization`, cookie, bearer token или raw session secret в LLM;
- неограниченные samples;
- silent fallback на service account, если текущему пользователю не хватает прав.

## LangGraph boundary

LangGraph уместен только для editor workflow, где есть состояние, уточнения, retry и human-in-the-loop:

```text
parse intent
  -> inspect model
  -> resolve ambiguous class/domain names
  -> draft DSL
  -> validate
  -> preview
  -> ask editor to approve or refine
```

LangGraph не должен участвовать в:

- `GET /run`;
- static snapshot serving;
- cache hit path;
- health/readiness;
- permission enforcement в runtime;
- генерации результата для конечного viewer-а.

## Сохранение результата

В v1 не создавать новые CMDBuild technical classes.

Сохранять approved результат в существующем шаблоне:

```text
Cst_QueryTemplate.SpecJson
```

Опционально можно добавить metadata внутри `SpecJson`:

```json
{
  "meta": {
    "authoring": {
      "source": "assistant",
      "assistantVersion": "mcp-langgraph-template-assistant/v0",
      "approvedBy": "{{currentUser}}",
      "approvedAt": "2026-07-09T00:00:00Z"
    },
    "determinism": {
      "specHash": "...",
      "dependencyMapHash": "...",
      "cacheScope": "visibilityHash"
    }
  }
}
```

Metadata не должна быть обязательной для старых шаблонов. Table-only templates должны выполняться без миграции.

## Права, cache и static snapshot

Базовое правило: assistant может видеть только то, что backend может прочитать в контексте текущего пользователя или явно спроектированного server-side editor context.

Для runtime:

- выполняется только сохраненный `SpecJson`;
- CMDBuild REST вызывается backend-ом под текущей пользовательской сессией;
- cache key включает `templateCode`, `specHash`, runtime params, execution limits, dependency map и cache scope;
- при row-level-sensitive данных использовать `visibilityHash` или `privateUser`, а не `permissionOnly`;
- static snapshot хранит опубликованный artifact и не должен повторно вызывать assistant.

Для assistant preview:

- preview не пишет в runtime cache;
- preview имеет отдельные лимиты `maxRestCalls`, `maxRows`, `maxDepth`, `maxSamples`;
- permission denied возвращается как ошибка draft/preview, а не как частичный результат;
- operational logs не содержат raw rows, cookies, tokens, headers или prompt payloads с чувствительными данными.

## Реализация по фазам

### Phase 0: Contract-only spike

- Зафиксировать JSON schema для template draft, validation result и preview result.
- Проверить, что текущий deterministic DSL покрывает сценарий "ИС -> серверы -> IP -> VLAN".
- Добавить test fixtures с mocked CMDBuild model catalog.
- Не подключать реальный LLM.

### Phase 1: MCP read-only adapter

- Реализовать MCP tools поверх существующего backend CMDBuild client.
- Ограничить tools только model/catalog/sample/validate/preview операциями.
- Добавить audit-safe structured logs.
- Добавить unit/API tests на grants, лимиты и запрет write/passthrough.

### Phase 2: Assistant workflow

- Добавить отдельный Template Assistant API для Designer.
- Подключить LangGraph только внутри authoring workflow, если простого sequential planner-а недостаточно.
- Сохранять только approved `SpecJson`.
- Показывать editor-у объяснение classes/domains/fields до сохранения.

### Phase 3: Designer integration

- Добавить UI action "Сгенерировать из описания" рядом с ручным редактированием шаблона.
- Показать draft diff, validation warnings, preview result и список зависимостей.
- Не скрывать ручной режим редактирования.

### Phase 4: Hardening

- Добавить permission-denied regression tests.
- Проверить cache/static snapshot contract.
- Добавить prompt-injection test corpus на labels/descriptions из CMDBuild metadata.
- Добавить browser smoke для Designer preview и runtime page.

## Acceptance criteria для будущей реализации

- Existing table-only templates работают без изменений.
- Runtime `GET run` не импортирует и не вызывает assistant/LangGraph code path.
- Assistant может создать draft spec по mocked CMDBuild model catalog.
- Draft нельзя сохранить без deterministic validation.
- Preview не пишет runtime cache.
- MCP tools не дают generic CMDBuild proxy.
- Секреты CMDBuild не попадают в prompts/logs/MCP output.
- Permission denied не возвращает partial table.
- `npm test`, `npm run test:api`, `npm run test:nginx` проходят.
- Browser smoke подтверждает, что approved template открывается через same-origin front `8088`.

## Open questions

- Достаточно ли текущего DSL для relation traversal, или нужен явный `traverseDomains` step.
- Нужен ли отдельный dependency map artifact, или его можно вычислять из `SpecJson`.
- Какой cache scope должен быть default для assistant-generated templates.
- Нужна ли отдельная роль CMDBuild для использования assistant-а в Designer.
- Какие поля CMDBuild metadata можно безопасно отправлять в LLM без masking.
- Нужна ли offline/local LLM модель для стендов без внешнего network access.

## Related docs

- `docs/diagram-extension-plan.ru.md` - отдельный plan по диаграммам как runtime view.
- `docs/architecture-plan.ru.md` - архитектурный backlog проекта.
- `docs/testing-plan.ru.md` - тестовая стратегия.

## External references

Перед реализацией сверить актуальные версии:

- MCP introduction: <https://modelcontextprotocol.io/docs/getting-started/intro>
- MCP specification 2025-06-18: <https://modelcontextprotocol.io/specification/2025-06-18>
- LangGraph overview: <https://docs.langchain.com/oss/python/langgraph/overview>
