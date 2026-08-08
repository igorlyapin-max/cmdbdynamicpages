---
title: "Design System"
description: "Project visual identity and design system"
version: "1.1.19"
---

# DESIGN.md

## Overview

Project visual identity and design system.

## Colors

- Primary: #111827
- Accent: #7C3AED
- Success: #059669
- Warning: #D97706
- Danger: #DC2626

## Typography

- Inter, system-ui

## Rules

- Use tokens before inventing new values.
- Keep components compact and status-aware.

## UI Interaction Contract

- Each localized surface uses one natural language for labels, actions, placeholders, help, status, validation, loading, empty, and error text. Verbatim exceptions are limited to the shared technical-token allowlist: `CMDBuild`, `D2`, `JSON`, `API`, `REST`, `URL`, `HTTP`, `MCP`, `LLM`, `LiteLLM`, `Redis`, `Spec`, `${...}`, common domain abbreviations such as `IP`, `ACL`, `VLAN`, and `SQL`, and user-authored or data identifiers such as class and attribute names, aliases, paths, and template names. Do not introduce other mixed-language prose.
- Context help uses a fixed-size `?` icon button in a reserved slot beside its owning label or header. Help opens in a viewport-contained overlay and never expands inline; it is available on hover/focus and click/tap, has an accessible name and associated tooltip semantics, closes with `Escape`, and does not steal or lose the user's focus.
- Disclosure headers keep the same title, indicator, and action geometry when collapsed or expanded. Content opens below the header; the indicator uses a fixed slot, and the semantic header control exposes `aria-expanded` and `aria-controls`.
- A known finite multi-select uses a compact dropdown with checkboxes. Its bounded trigger summarizes selected labels or their count, the option list opens as an overlay, and selection never creates a growing chip row or resizes adjacent controls.
- Catalog pickers are query-first: before a non-empty query they do not enumerate or preload catalog options. Search, loading, empty, and error results stay inside the picker overlay, and an existing selection remains visible while the query changes.
- Expression-enabled inputs offer autocomplete only while the caret is inside `${...}`. The global diagram title exposes only template parameters; a source-bound label exposes template parameters plus readable fields of that bound source, never fields from unrelated sources. Suggestions update when the binding changes and support keyboard selection without replacing text outside the active expression.
- Help, dropdowns, catalog results, autocomplete, async state, and selection changes must not shift surrounding layout. Reserve stable trigger and header dimensions, render overlays outside document flow, truncate or summarize variable text, and allow only intentional disclosure content to expand below its unchanged header.
- Desktop keeps controls compact, overlays anchored to their trigger, and every workflow operable by pointer and keyboard. Mobile preserves the same capabilities in one column, keeps overlays within the viewport, avoids horizontal overflow and hover-only behavior, and uses touch targets of at least `44px`.
- Use native or equivalent semantic buttons, checkboxes, and combobox/listbox patterns with programmatic labels, visible `focus-visible` state, logical focus order, keyboard navigation, `Escape` dismissal, focus return, screen-reader status announcements, sufficient contrast, and no state communicated by color alone.

## Build Identity Contract

- Root `VERSION` is the displayed release version. A container build embeds that exact file; build arguments may validate it but never replace it.
- Every container embeds `BUILD_INFO.json` and matching OCI labels with version, Git revision, source dirty state, and provenance. Canonical CI/release builds use `verified`; an ordinary local build is explicitly `unverified-local`.
- Build and deployment verification compare the SHA-256 of the served editor source with the current checkout or canonical build input. `--no-cache` alone is not evidence that a running container contains current code.
- `/health/live`, response headers, startup diagnostics, and `About` expose one consistent public build identity. They never expose secrets or raw environment values.
- Replacing a container image requires recreation of the container. A process restart against the old image id is not a deployment.

## Assistant / Diagram Ownership

- `Assistant` is the authoring surface for D2 import, semantic interpretation, object-flow selection/match proposals, and selection-to-role proposals.
- `Diagram` is the deterministic configuration surface for accepted `result.diagrams[]` settings and mappings.
- Каноническое сохраняемое authoring-состояние находится только в `spec.authoring`:
  ```json
  {
    "version": 1,
    "assistant": {
      "objectFlowIntent": {
        "context": "...",
        "blocks": [
          {
            "name": "Результат 1",
            "description": "...",
            "resultKind": "cards",
            "uses": []
          }
        ]
      },
      "promptContractVersion": 4,
      "diagramIntentPrompt": "...",
      "systemPromptOverrides": {
        "objectFlow": "..."
      }
    },
    "d2": { "source": "...", "sourceHash": "..." }
  }
  ```
- Assistant prompt contract v4 exposes one user-authored `diagramIntentPrompt`. Internal stages remain separate (`semantics -> binding intent -> placement -> connections -> critique`) and receive the same intent under stage-specific system policies. Legacy diagram prompt fields are read-only migration inputs; normalization joins unique non-empty values and every subsequent Save writes only v4 fields.
- Assistant authoring requests use `templateRef` plus a bounded editor delta. The saved template is the server-side base; full `currentSpec` is not sent by the browser on each LLM stage. Diagram output is excluded from D2 mapping input identity so applying a mapping cannot invalidate its own analysis.
- D2 Role Notes and Placement Notes may contain one machine-readable line `materialization: structural|stage|parentCard`. Placement Notes override Role Notes. The deterministic structural model validates the hint against the visual kind and narrows `allowedMaterialization`; Assistant may choose a source but may not override the declared materialization mode. This directive is generic D2 authoring metadata, not a CMDBuild class or customer-specific convention.
- Diagram Assistant exchanges independently versioned, hash-addressed contracts:
  - `BusinessBlockManifest` exposes each named user block, its one terminal result, helper results, primary class, output kind, row grain, and materialized fields. Newly applied Assistant flows persist `assistantStageRole=terminal|helper`: every user block owns exactly one unshared terminal result, and a helper cannot be published as that block. Legacy flows are recovered only when the dependency graph has one sink inside the block; labels never decide terminal ownership.
  - `DataSemanticModel` contains named deterministic Object Flow stages, dependencies, lineage, materialized card sources, classes, and fields.
  - `D2StructuralModel` contains exact reusable roles, exact placement ids and parents, D2 connection classes, and Notes scoped by their source location.
  - `D2SemanticModel` contains only node/container meaning and label intent for exact role ids.
  - `D2BindingIntent` binds each dynamic placement and connection class to one named business block without selecting a technical stage or field.
  - `D2BindingModel` contains accepted placement-to-stage materialization and hierarchy conditions. The connection stage receives this model as immutable input.
  - `SemanticObligationMatrix` records the terminal-result, filter, membership, row-grain, endpoint-mode, and endpoint-field requirements that must remain true in the generated mapping.
  - `D2MappingCritique` reports semantic concerns only through exact obligation ids and cannot approve an obligation that deterministic validation marked unsatisfied.
  - `CoverageModel` reports required, mapped, and unresolved roles, containers, and connection classes. It is evidence, not a source for implicit autofill.
- Assistant stages are ordered `semantics -> binding intent -> placement -> connections -> semantic critic`. Binding intent sees named business blocks but no technical stages. Placement receives only stages allowed by the accepted intent; connections receive only candidates from the selected business block and use terminal results unless Notes explicitly allow a helper. The final result is accepted only when every deterministic semantic obligation is satisfied. At most two targeted correction passes are allowed across the whole mapping workflow. Runtime execution never invokes LLM.
- D2 Notes are natural-language authoring input by default. Binding intent translates explicit branch filters, parent membership, row grain, endpoint fields and operators into a typed obligation contract, and deterministic validation checks that later placement/connection stages satisfy it. Advanced machine-readable lines (`binding-result`, `stage-policy`, `row-grain`, `membership`, repeated `required-condition`/`required-membership`, `endpoint-mode`, repeated `endpoint-field`/`endpoint-operator`, `source-field`/`source-operator`, `target-field`/`target-operator`, and `exemplars`) remain authoritative when present. Fixed materialization, exact business-block ownership, typed conditions, membership rules, and endpoint profiles are compiled by the deterministic adapter; LLM may enrich ambiguous natural-language intent but cannot replace or omit those constraints. `endpoint-field` is resolved from the exact card source selected for each concrete placement; backend then creates one deterministic endpoint profile per placement and field.
- `CoverageModel.status=complete` requires the same executable endpoint-profile and operator checks as D2 Apply. A mapped connection class without compatible source and target profiles remains `partial`; Assistant cannot report success that deterministic Apply would immediately reject.
- D2 `Notes` are interpreted by location: Notes on a class define reusable role semantics, Notes on a concrete element define only that placement, and Notes on a connection class or exemplar define only the connection algorithm. Notes guide selection among supplied identifiers but never create CMDBuild identifiers, relations, stages, or fields.
- Assistant renders prompts, generation state, warnings, and explicit proposal actions only; it must not render deterministic selection, matching, class, attribute, or D2 mapping controls.
- D2 source and Assistant prompts remain in Assistant. Pending D2 semantic and mapping proposals remain in Assistant and never replace the deterministic Diagram editor state.
- Global Assistant system prompts remain the inherited default. A non-empty `assistant.systemPromptOverrides` value belongs to one template, overrides only that prompt for its Assistant calls, and is persisted by the normal template Save action.
- Assistant output is always shown as a reviewable proposal. It must not update the editor draft, Diagram settings, save state, preview input, or publication state until the author invokes an explicit deterministic apply action.
- Object-flow LLM requests expose only the sanitized flow stages needed for the selected operation and accept one typed `selection` or `block`; complete runtime Spec generation is outside this contract.
- Diagram source controls list every object-flow selection and every intermediate match stage; the final flow result is not the only eligible source.
- Exact non-negated equality matches are pushed into the right `selectCards` as a mandatory source-driven `valueColumn` filter before its result limit is applied; correlated right cards are deduplicated by class/card id, and the explicit `matchRows` stage is retained for deterministic validation and downstream mapping.
- `Применить цепочку` и D2 Apply в «Ассистенте диаграмм» выполняют только локальную детерминированную компиляцию/валидацию и возвращают новый draft `spec`. Ручной «Редактор диаграмм» не применяет mapping: он меняет authoring-состояние, которое сохраняет только глобальный `Сохранить`.
- Единственная операция записи — глобальный `Сохранить`: обычный template `POST`/`PUT` сохраняет текущий `spec`, включая `spec.authoring`, и создаёт версию шаблона. Runtime cache и static snapshot инвалидируются только при изменении executable-части Spec.
- Хранилище принимает незавершённый authoring и неполный D2 mapping. `Извлечение` выполняет только детерминированные таблицы и не зависит от D2 mapping. Draft D2 preview показывает только independently validated bindings; неподтверждённые роли и связи исключаются, а при отсутствии таких bindings показывается исходный D2 template без CMDBuild data. Runtime и publication используют строгую execution-валидацию и fail closed, пока D2 source/mapping не готовы.
- Поля Diagram являются текущим authoring-состоянием template: глобальный `Сохранить` фиксирует их в `spec` независимо от готовности mapping. Неполный mapping сохраняется с `mappingValidation=needsValidation`; он блокирует runtime и publication, но не переход между меню, повторное открытие template или промежуточный diagram preview.
- Applied D2 mapping хранит подписанный `mappingInputRevision`: canonical D2 `sourceHash` и контракт только используемых им Object Flow stages/fields. При точном совпадении revision и подписи mapping остаётся usable после reload без Analyze, Interpret, Map, Apply или автоматического LLM-вызова.
- Если read-path детерминированно переаттестовал полностью исполнимый mapping, но обновленная подпись еще не записана в CMDBuild, UI показывает отдельное состояние «требуется сохранить». Обычный глобальный `Сохранить` фиксирует восстановленную валидацию; повторный Analyze, Assistant или Apply не требуется. Runtime и publication до этого сохранения остаются fail closed, а table-only режим не зависит от D2 recovery.
- Изменение D2 source или контракта используемого Object Flow stage сохраняет mapping для просмотра и ручной правки, но помечает его `needsReview`. Изменение D2 prompts влияет только на следующее предложение Assistant и не инвалидирует применённый mapping. UI не запускает LLM самостоятельно; до явного review/runtime and publication fail closed только для изменённого source или контракта stage. Несвязанные поля шаблона и неиспользуемые Object Flow stages не делают mapping stale.
- Каждый item `structureTree` имеет явный способ наполнения: `structural` создаёт статическую рамку, `stage` повторяет placement по одному результату Object Flow, `parentCard` повторяет узел по карточке ближайшего materialized container. Вложенный собственный `stage` хранит parent-child условия отдельно в `hierarchyConditions`; одинаковый stage заменяется на `parentCard`.
- Контейнеры могут дублироваться в разрешенном D2 context, но каждый динамический экземпляр выбирает собственный result stage. Источники не объединяются неявно.
- Поле сопоставления принадлежит конкретному `structureTree` placement: `stage` использует собственную карточку результата, `parentCard` — карточку ближайшего materialized parent. Динамический контейнер участвует в endpoint-сопоставлении только когда его карточка не представлена непосредственным дочерним узлом `parentCard`; в противном случае контейнер остаётся рамкой, а endpoint — дочерний узел. Копирование ветки создаёт независимое правило. Каждая D2-связь хранится один раз на `d2ClassKey` как алгоритм и задаёт только результат связи, поля source/target и методы сравнения. Runtime сопоставляет каждую сторону со всеми materialized placement-правилами, которые поддерживают соответствующий метод. Примеры стрелок D2 задают оформление, но не ограничивают бизнес-пары объектов.
- Направление связи определяется полями результата: `source` → `target`. Редактор предоставляет только признак «Без направления»; он выводит `--`. Шаблонная стрелка D2 задает стиль, но не переопределяет направление данных.
- «Связи иерархии» редактируют только parent-child сопоставление именованных materialized результатов Object Flow. Данные для label и structured data настраиваются в инспекторе выбранного контейнера или узла. Domain, reference и path настраиваются в «Группе объектов» или «Сопоставлении с объектами» и не редактируются повторно в Diagram. Статический контейнер не имеет источника данных; старые traversal mappings требуют ручного пересмотра, legacy не поддержана и не запланирована.
- «Сопоставление с объектами» и «Редактор диаграмм» используют query-first catalog picker из общего UI contract. Picker является permission-filtered: до поискового запроса он не строит graph class/reference/domain, а после ввода показывает только readable прямые атрибуты и подтвержденные paths в границах Runtime depth. Операции связей не имеют собственных limit или output-column controls: `executionLimits.maxRelationsPerCardDefault` и `maxRelationsPerCardMax` применяются ко всем relation reads, включая paths.
- Runtime materializes все readable прямые атрибуты карточек Object Flow. Compiler добавляет только явно использованные deep fields как техническую проекцию для rules, labels, hierarchy и D2 edges. Видимые колонки таблицы принадлежат только «Итоговым данным»; «Извлечение» показывает материализованные данные источника.
- Подписи materialized результатов Object Flow являются самостоятельным детерминированным presentation contract и не зависят от доступности LLM. Только явные `assistantManaged` outputs или сохранённый `assistantOutputManifest` задают Assistant provenance; один `objectFlowIntent` не делает поток Assistant-managed. При неполном legacy provenance read-path сохраняет однозначные пользовательские подписи, создаёт нейтральные подписи для остальных результатов и оставляет «Извлечение» доступным; обычный `Сохранить` фиксирует восстановленный contract без повторного запуска Assistant.
- `objectMatching.operations` является каноническим порядком Object Flow. `blocks` и `setOperations` остаются только синхронизированными представлениями редактора; aliases вычисляются из валидного dependency graph и обязаны соответствовать executable `steps`. Невалидный authoring сохраняется без удаления стадий, но не создаёт phantom-результаты в «Извлечении».
- Имя materialized результата и заголовок опубликованной таблицы независимы: `outputs[].label` используется Designer и Diagram, а `result.presentation.tables[].title` управляет публикацией. Object Flow recovery не переносит semantic label обратно в table presentation.
- Исторические `source.stageId` mappings не мигрируются: они не фиксируют различие между повторением и наследованием карточки. Для них требуется fresh D2 analysis; legacy не поддержана и не запланирована для D2 materialization contract.
- Legacy `assistantDraft` не является поддерживаемым контрактом. Обычный `Сохранить` может однократно мигрировать старое значение в `spec.authoring`; отдельный endpoint `assistant-draft` удалён.
- Removed generic or mixed assistant flows must not remain as hidden compatibility actions in the UI.

## Authoring States

- Keep `proposal`, `reviewed`, `applying`, `validation error`, and `preview required` visually distinct.
- Disable Assistant Apply when its proposal references unresolved or stale stages/roles. The manual Diagram editor has no second Apply control.
- Assistant Apply changes only the local draft. Manual editor changes persist through global `Сохранить`; its intermediate preview uses unsaved editor values and shows only independently valid bindings. Runtime and publication remain strict and separate explicit actions.
- Runtime, cache, and publication views expose no Assistant progress state because those paths never invoke LLM.
- Execution aliases Object Flow являются внутренними ключами Spec/API/cache. Во всех пользовательских поверхностях, включая селекторы, редакторы Diagram, trace и диагностические представления, Assistant-управляемый результат показывается только через сохраненное имя блока или его понятное производное; raw alias не выводится.
