---
name: Edit-dialog cyberware flush on main SAVE
description: Staff cyberware edits in EditCharacterDialog are a separate immediate-apply system; the main SAVE must flush them or they are silently lost.
---

The character edit dialog contains TWO independent persistence systems: the review-queued character fields (main SAVE → PATCH /characters/:id → pending edit) and the staff-only cyberware grid (SAVE CYBERWARE → inventory endpoints, applies immediately, never in the review diff).

**Why:** A staff user edited a cyberware description in the CYBERWARE tab and clicked only the main SAVE — the typed change was silently discarded (nothing in the review ticket, nothing in inventory_items). Verified against live data: the old text was still on the item.

**How to apply:** The main `save()` computes `cyberDirty` (staff + row JSON diff vs snapshot) and awaits `saveCyberware()` BEFORE the review PATCH; if the flush fails it aborts the submit so the dialog stays open and rows aren't lost. A dirty dot on the tab trigger signals unsaved chrome. Any future side-panel editor with its own save button inside this dialog needs the same flush-or-warn treatment — a lone secondary save button next to a primary form submit is a data-loss trap.

Note for explaining to users: staff cyberware edits will never appear in a pending-edit review ticket — that is by design; only character-row fields (sheetData etc.) are reviewable.
