---
title: "Design System"
description: "Project visual identity and design system"
version: "1.1.18"
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

## Assistant / Diagram Ownership

- `Assistant` is the authoring surface for D2 import, semantic interpretation, object-flow selection/match proposals, and selection-to-role proposals.
- `Diagram` is the deterministic configuration surface for accepted `result.diagrams[]` settings and mappings.
- Каноническое сохраняемое authoring-состояние находится только в `spec.authoring`:
  ```json
  {
    "version": 1,
    "assistant": {
      "objectFlowIntent": "...",
      "diagramInterpretPrompt": "...",
      "diagramMappingPrompt": "...",
      "systemPromptOverrides": {
        "objectFlow": "..."
      }
    },
    "d2": { "source": "...", "sourceHash": "..." }
  }
  ```
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
- Изменение D2 source или контракта используемого Object Flow stage сохраняет mapping для просмотра и ручной правки, но помечает его `needsReview`. Изменение D2 prompts влияет только на следующее предложение Assistant и не инвалидирует применённый mapping. UI не запускает LLM самостоятельно; до явного review/runtime and publication fail closed только для изменённого source или контракта stage. Несвязанные поля шаблона и неиспользуемые Object Flow stages не делают mapping stale.
- Каждый item `structureTree` имеет явный способ наполнения: `structural` создаёт статическую рамку, `stage` повторяет placement по одному результату Object Flow, `parentCard` повторяет узел по карточке ближайшего materialized container. Вложенный собственный `stage` хранит parent-child условия отдельно в `hierarchyConditions`; одинаковый stage заменяется на `parentCard`.
- Контейнеры могут дублироваться в разрешенном D2 context, но каждый динамический экземпляр выбирает собственный result stage. Источники не объединяются неявно.
- Поле сопоставления принадлежит конкретному `structureTree` placement: `stage` использует собственную карточку результата, `parentCard` — карточку ближайшего materialized parent. Динамический контейнер участвует в endpoint-сопоставлении только когда его карточка не представлена непосредственным дочерним узлом `parentCard`; в противном случае контейнер остаётся рамкой, а endpoint — дочерний узел. Копирование ветки создаёт независимое правило. Каждая D2-связь хранится один раз на `d2ClassKey` как алгоритм и задаёт только результат связи, поля source/target и методы сравнения. Runtime сопоставляет каждую сторону со всеми materialized placement-правилами, которые поддерживают соответствующий метод. Примеры стрелок D2 задают оформление, но не ограничивают бизнес-пары объектов.
- Направление связи определяется полями результата: `source` → `target`. Редактор предоставляет только признак «Без направления»; он выводит `--`. Шаблонная стрелка D2 задает стиль, но не переопределяет направление данных.
- «Связи иерархии» редактируют только parent-child сопоставление именованных materialized результатов Object Flow. Данные для label и structured data настраиваются в инспекторе выбранного контейнера или узла. Domain, reference и path настраиваются в «Группе объектов» или «Сопоставлении с объектами» и не редактируются повторно в Diagram. Статический контейнер не имеет источника данных; старые traversal mappings требуют ручного пересмотра, legacy не поддержана и не запланирована.
- «Сопоставление с объектами» и «Редактор диаграмм» используют один permission-filtered catalog field picker. До поискового запроса picker не строит graph class/reference/domain; после ввода показывает только readable прямые атрибуты и подтвержденные paths в границах Runtime depth. Операции связей не имеют собственных limit или output-column controls: `executionLimits.maxRelationsPerCardDefault` и `maxRelationsPerCardMax` применяются ко всем relation reads, включая paths.
- Runtime materializes все readable прямые атрибуты карточек Object Flow. Compiler добавляет только явно использованные deep fields как техническую проекцию для rules, labels, hierarchy и D2 edges. Видимые колонки таблицы принадлежат только «Итоговым данным»; «Извлечение» показывает материализованные данные источника.
- Исторические `source.stageId` mappings не мигрируются: они не фиксируют различие между повторением и наследованием карточки. Для них требуется fresh D2 analysis; legacy не поддержана и не запланирована для D2 materialization contract.
- Legacy `assistantDraft` не является поддерживаемым контрактом. Обычный `Сохранить` может однократно мигрировать старое значение в `spec.authoring`; отдельный endpoint `assistant-draft` удалён.
- Removed generic or mixed assistant flows must not remain as hidden compatibility actions in the UI.

## Authoring States

- Keep `proposal`, `reviewed`, `applying`, `validation error`, and `preview required` visually distinct.
- Disable Assistant Apply when its proposal references unresolved or stale stages/roles. The manual Diagram editor has no second Apply control.
- Assistant Apply changes only the local draft. Manual editor changes persist through global `Сохранить`; its intermediate preview uses unsaved editor values and shows only independently valid bindings. Runtime and publication remain strict and separate explicit actions.
- Runtime, cache, and publication views expose no Assistant progress state because those paths never invoke LLM.
- Execution aliases Object Flow являются внутренними ключами Spec/API/cache. Во всех пользовательских поверхностях, включая селекторы, редакторы Diagram, trace и диагностические представления, Assistant-управляемый результат показывается только через сохраненное имя блока или его понятное производное; raw alias не выводится.
