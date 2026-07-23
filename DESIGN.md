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
      "diagramMappingPrompt": "..."
    },
    "d2": { "source": "...", "sourceHash": "..." }
  }
  ```
- Assistant renders prompts, generation state, warnings, and explicit proposal actions only; it must not render deterministic selection, matching, class, attribute, or D2 mapping controls.
- D2 source and Assistant prompts remain in Assistant. Pending D2 semantic and mapping drafts are rendered and edited only in Diagram.
- Assistant output is always shown as a reviewable proposal. It must not update the editor draft, Diagram settings, save state, or publication state until the author invokes an explicit deterministic apply action.
- Object-flow LLM requests expose only the sanitized flow stages needed for the selected operation and accept one typed `selection` or `block`; complete runtime Spec generation is outside this contract.
- Diagram source controls list every object-flow selection and every intermediate match stage; the final flow result is not the only eligible source.
- Exact non-negated equality matches are pushed into the right `selectCards` as a mandatory source-driven `valueColumn` filter before its result limit is applied; correlated right cards are deduplicated by class/card id, and the explicit `matchRows` stage is retained for deterministic validation and downstream mapping.
- `Применить цепочку`, D2 Apply и D2 Update выполняют только локальную детерминированную компиляцию/валидацию и возвращают новый draft `spec`. Они не создают версию CMDBuild, не меняют сохранённый `specHash`, не инвалидируют runtime cache или static snapshot.
- Единственная операция записи — глобальный `Сохранить`: обычный template `POST`/`PUT` сохраняет текущий `spec`, включая `spec.authoring`, и создаёт версию шаблона. Runtime cache и static snapshot инвалидируются только при изменении executable-части Spec.
- Хранилище принимает незавершённый authoring и неполный D2 mapping. `Извлечение` выполняет только детерминированные таблицы и не зависит от D2 mapping. Draft D2 preview показывает только independently validated bindings; неподтверждённые роли и связи исключаются, а при отсутствии таких bindings показывается исходный D2 template без CMDBuild data. Runtime и publication используют строгую execution-валидацию и fail closed, пока D2 source/mapping не готовы.
- Поля Diagram являются текущим authoring-состоянием template: глобальный `Сохранить` фиксирует их в `spec` независимо от готовности mapping. Неполный mapping сохраняется с `mappingValidation=needsValidation`; он блокирует только diagram preview, runtime и publication, но не переход между меню и не повторное открытие template.
- Applied D2 mapping хранит подписанный `mappingInputRevision`: canonical D2 `sourceHash`, hashes обоих D2 prompts и контракт только используемых им Object Flow stages/fields. При точном совпадении revision и подписи mapping остаётся usable после reload без Analyze, Interpret, Map, Apply или автоматического LLM-вызова.
- Изменение D2 source, любого D2 prompt или контракта используемого Object Flow stage сохраняет mapping для просмотра и ручной правки, но помечает его `needsReview`. UI не запускает LLM самостоятельно: автор явно повторяет нужный Assistant action или корректирует mapping в `Diagram`; до этого runtime и publication fail closed. Несвязанные поля шаблона и неиспользуемые Object Flow stages не делают mapping stale.
- Каждый item `structureTree` имеет явный способ наполнения: `structural` создаёт статическую рамку, `stage` повторяет placement по одному результату Object Flow, `parentCard` повторяет узел по карточке ближайшего materialized container. Вложенный собственный `stage` обязан явно сопоставить свою карточку с карточкой родительской ветви; одинаковый stage заменяется на `parentCard`.
- Контейнеры могут дублироваться в разрешенном D2 context, но каждый динамический экземпляр выбирает собственный result stage. Источники не объединяются неявно.
- Исторические `source.stageId` mappings не мигрируются: они не фиксируют различие между повторением и наследованием карточки. Для них требуется fresh D2 analysis; legacy не поддержана и не запланирована для D2 materialization contract.
- Legacy `assistantDraft` не является поддерживаемым контрактом. Обычный `Сохранить` может однократно мигрировать старое значение в `spec.authoring`; отдельный endpoint `assistant-draft` удалён.
- Removed generic or mixed assistant flows must not remain as hidden compatibility actions in the UI.

## Authoring States

- Keep `proposal`, `reviewed`, `applying`, `validation error`, and `preview required` visually distinct.
- Disable apply when referenced stages or D2 roles are unresolved or stale.
- Deterministic Apply changes only the local draft. A successful global `Сохранить` remains required for persistence; a successful preview remains required before diagram execution or publication; publication remains a separate explicit action.
- Runtime, cache, and publication views expose no Assistant progress state because those paths never invoke LLM.
- Execution aliases Object Flow являются внутренними ключами Spec/API/cache. Во всех пользовательских поверхностях, включая селекторы, редакторы Diagram, trace и диагностические представления, Assistant-управляемый результат показывается только через сохраненное имя блока или его понятное производное; raw alias не выводится.
