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
- Assistant renders prompts, generation state, warnings, and explicit proposal actions only; it must not render deterministic selection, matching, class, attribute, or D2 mapping controls.
- D2 source and Assistant prompts remain in Assistant. Pending D2 semantic and mapping drafts are rendered and edited only in Diagram; applying a proposal never changes the current Designer section.
- Assistant output is always shown as a reviewable proposal. It must not update the editor draft, Diagram settings, save state, or publication state until the author invokes an explicit deterministic apply action.
- Object-flow LLM requests expose only the sanitized flow stages needed for the selected operation and accept one typed `selection` or `block`; complete runtime Spec generation is outside this contract.
- Diagram source controls list every object-flow selection and every intermediate match stage; the final flow result is not the only eligible source.
- Exact non-negated equality matches are pushed into the right `selectCards` as a mandatory source-driven `valueColumn` filter before its result limit is applied; correlated right cards are deduplicated by class/card id, and the explicit `matchRows` stage is retained for deterministic validation and downstream mapping.
- A pending D2 proposal never mutates the deterministic diagram settings. In Diagram it takes priority over any saved mapping, including an outdated mapping; Apply explicitly replaces the saved mapping and common Diagram settings become editable afterwards.
- Assistant prompt autosave may preserve a current applied D2 identity only when its source exactly matches the saved applied source. A changed source clears identity and reviewed overrides, then requires fresh analysis; legacy mapping migration is not supported or planned.
- Removed generic or mixed assistant flows must not remain as hidden compatibility actions in the UI.

## Authoring States

- Keep `proposal`, `reviewed`, `applying`, `validation error`, and `preview required` visually distinct.
- Disable apply when referenced stages or D2 roles are unresolved or stale.
- After deterministic apply, persist the catalog-valid mapping immediately. A successful preview remains required before diagram execution or publication; publication remains a separate explicit action.
- Runtime, cache, and publication views expose no Assistant progress state because those paths never invoke LLM.
