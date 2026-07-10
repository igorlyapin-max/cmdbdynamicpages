# Возможное расширение: диаграммы и graph-runtime

Статус: baseline implemented / дальнейшее расширение. Документ фиксирует выбранную модель развития диаграмм внутри текущего runtime contract.

Дата фиксации: 2026-07-09.

## Summary

Текущий `cmdbdynamicpages` уже содержит нужную основу для диаграмм:

- CMDBuild custom page остается тонким launcher;
- backend-owned UI обслуживается под `/cmdbuild/dynamicpages/ui/*`;
- шаблоны хранятся в технических классах CMDBuild;
- выполнение идет под текущей CMDBuild-сессией пользователя;
- runtime result cache и static snapshot уже реализованы через Redis;
- таблицы строятся детерминированным DSL executor.

Поэтому диаграммы лучше развивать как новый тип runtime-представления внутри текущего проекта, а не как отдельный продукт. LLM/MCP/LangGraph стоит рассматривать как optional editor assistant для генерации и проверки конфигурации, но не как часть обычного runtime-rendering пути.

## Целевая модель

Для пользователя результат остается статической web-страницей с теми же свойствами, что и текущие runtime pages:

```text
/cmdbuild/dynamicpages/ui/run/<templateCode>?param=value
```

Страница может содержать таблицы, диаграммы или оба типа представления. Runtime не вызывает LLM. Он исполняет сохраненный шаблон и сохраненный graph spec детерминированно.

Предлагаемое расширение шаблона:

```json
{
  "result": {
    "tables": [],
    "diagrams": [
      {
        "name": "systemTopology",
        "title": "ACL / Servers / Containers / VLAN",
        "source": {
          "nodes": "GraphNodes",
          "edges": "GraphEdges"
        },
        "nodeMappings": [
          {
            "from": "GraphNodes",
            "fields": {
              "id": "Id",
              "label": "Label",
              "group": "Vlan",
              "parent": "Parent",
              "nodeType": "Kind",
              "href": "Href"
            }
          }
        ],
        "edgeMappings": [
          {
            "type": "object",
            "from": "AclRows",
            "fields": {
              "source": "Source",
              "target": "Target",
              "label": "Port",
              "edgeType": "Action",
              "edgeDirection": "Direction"
            }
          }
        ],
        "groupMappings": [
          {
            "from": "Vlans",
            "fields": { "id": "Vlan", "label": "Name" }
          }
        ],
        "hierarchyMappings": [
          {
            "from": "Contains",
            "fields": { "parent": "Parent", "child": "Child", "label": "Relation" }
          }
        ],
        "layout": {
          "type": "hierarchical"
        },
        "limits": {
          "maxNodes": 300,
          "maxEdges": 800,
          "maxDepth": 4
        }
      }
    ]
  }
}
```

`result.diagrams[]` должен ссылаться на результаты уже существующих DSL steps: `selectCards`, `expandRelations`, `traverseDomains`, `matchRows`, `enrichRows`, `composeRows`. Новые business-сущности в CMDBuild для nodes/edges не нужны на первом этапе.

Для v1 mapping покрывает три обязательных семейства:

- `groupMappings`: группировки по VLAN, location, ИС, lookup/status или другому признаку;
- `hierarchyMappings`: containment/иерархия вроде server -> docker -> service;
- `edgeMappings`: CMDBuild domains, reference attributes и relation-object классы вроде ACL/firewall/route/dependency.

## Реализация

Минимальный v1:

- добавить schema validation для `result.diagrams[]`;
- добавить deterministic graph builder, который из DSL context строит `{ nodes, edges, groups, warnings }`;
- добавить renderer статической HTML/SVG диаграммы;
- добавить runtime JSON output, где рядом с `tables` возвращаются `diagrams`;
- расширить Designer разделом `Диаграмма` / `Graph view`;
- сохранить cache/static snapshot модель без отдельного graph storage.

Текущий baseline содержит schema validation, deterministic graph builder, runtime HTML/JSON, отдельный Designer пункт `Diagram editor`, server-side D2 SVG render через binary и скачивание generated `.d2` source. Если D2 renderer недоступен, runtime page обязана показать явное предупреждение и fallback-диаграмму, а не молча подменять визуализацию. Runtime JSON не должен отдавать raw `.d2`, embedded structured metadata или raw SVG content; source экспортируется отдельным `d2=true` endpoint. Для public static snapshot raw `.d2` source доступен только при явном `publish.publicD2Source=true`.

Graph builder должен:

- строить nodes/edges только из данных, уже полученных под текущим пользователем CMDBuild;
- применять лимиты `maxNodes`, `maxEdges`, `maxDepth`, `maxRestCalls`;
- возвращать truncation warnings, а не пытаться дорисовывать неполный граф молча;
- использовать тот же safe-link механизм, что и табличные ячейки;
- не писать runtime rows, CMDBuild payload, cookie, auth headers или secrets в operational logs.

Cache key должен включать:

- template code;
- spec hash;
- graph spec hash;
- runtime params;
- execution limits;
- dependency map hash;
- cache scope mode (`permissionOnly`, `visibilityHash`, `privateUser`, `disabled`);
- static snapshot params hash, если используется публикация.

## LLM / MCP / LangGraph

LLM не должен быть runtime dependency для просмотра страницы.

Рекомендуемая граница:

```text
Designer/editor intent
  -> Graph Assistant
  -> MCP read-only tools over CMDBuild model
  -> optional LangGraph orchestration
  -> draft graph spec
  -> deterministic validation/preview
  -> editor approval
  -> save template spec in CMDBuild
```

Пример пользовательского intent:

```text
Выбери данные по ACL, серверам, контейнерам и VLAN для этой информационной системы и сделай граф по шаблону.
```

MCP endpoint должен быть узким и read-only:

- `get_visible_model_catalog`;
- `inspect_class`;
- `inspect_domains`;
- `sample_cards_limited`;
- `validate_graph_spec`;
- `preview_graph_spec`.

MCP/LangGraph слой не получает CMDBuild cookie/token. Все CMDBuild reads выполняет backend под текущей сессией пользователя или через явно утвержденный server-side context, если такая модель будет отдельно спроектирована.

LangGraph уместен только для editor workflow, где нужны stateful steps, retry, human-in-the-loop и проверка draft spec. Обычный `GET run` должен оставаться синхронным, воспроизводимым и кэшируемым.

## Права и безопасность

Базовое правило не меняется: business data читаются только в правах текущего пользователя CMDBuild.

Для dynamic runtime:

- backend получает `CMDBuild-Authorization` cookie server-side;
- CMDBuild REST вызывается с текущей сессией;
- permission denied возвращает отказ без частичного результата;
- `permissionOnly` cache остается быстрым, но требует осознанного выбора администратора;
- для row-level-sensitive графов использовать `visibilityHash` или `privateUser`.

Для static snapshot:

- publication выполняется редактором под его CMDBuild-сессией;
- Redis хранит готовый graph artifact без TTL;
- viewer получает опубликованную статическую страницу без проверки прав на исходные CMDBuild-объекты;
- если snapshot отсутствует, runtime показывает текущую ошибку отсутствующего снимка.

## Test result

На момент фиксации этот документ не сопровождается runtime-реализацией. Обязательные проверки для будущей реализации:

- unit: validation `result.diagrams[]`;
- unit: graph builder из sample DSL rows;
- unit: лимиты nodes/edges/depth/REST calls;
- unit: cache key меняется при изменении graph spec;
- unit: unsafe links/labels отклоняются или превращаются в plain text;
- API: `GET run` возвращает `tables` и `diagrams`;
- API: `POST preview` строит draft graph без runtime cache;
- API: `POST publish` сохраняет graph static snapshot;
- security: permission denied не возвращает partial graph;
- runtime: `/health/ready`, `/metrics`, `npm test`, `npm run test:api`, `npm run test:nginx`;
- browser smoke: graph page открывается через same-origin front `8088`.

## Migration notes

В v1 не создавать новые CMDBuild technical classes. Хранить graph config внутри существующего `Cst_QueryTemplate.SpecJson`.

Новые классы или отдельный ontology layer рассматривать только если появится повторяемая потребность хранить reusable graph templates независимо от обычных query templates.

Совместимость:

- существующие table-only templates должны выполняться без изменений;
- `result.tables[]` остается валидным;
- `result.diagrams[]` является optional;
- старые static snapshots не мигрируются автоматически.

## Known limitations

- Автоматическая генерация graph spec через LLM потребует отдельного review/approval flow.
- Большие CMDBuild-модели могут быстро превышать лимиты узлов и связей; нужна стратегия collapsed groups.
- `permissionOnly` cache может быть недостаточен для графов с row-level visibility differences.
- Browser rendering больших SVG/HTML графов может потребовать lazy rendering или canvas/WebGL в следующих версиях.
- Перед реализацией нужно отдельно выбрать renderer и формат layout, чтобы не связать backend с тяжелой frontend-библиотекой без необходимости.

## External references

Перед реализацией сверить актуальные версии:

- MCP introduction: <https://modelcontextprotocol.io/docs/getting-started/intro>
- MCP specification 2025-06-18: <https://modelcontextprotocol.io/specification/2025-06-18>
- LangGraph overview: <https://docs.langchain.com/oss/python/langgraph/overview>
