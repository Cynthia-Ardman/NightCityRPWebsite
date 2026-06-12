---
name: Cyberware review-enforcement surfaces
description: Where the "players' cyberware changes must go through review, not apply immediately" rule has to be enforced.
---

Non-staff (not admin/fixer) must NOT be able to mutate cyberware directly — every change goes through the request/review flow. This rule spans MULTIPLE surfaces and gating only one is a silent bypass.

**Why:** A review found that hiding the immediate cyberware editor in `EditCharacterDialog` (gated on `isStaff`) still left players able to edit/recategorize/delete cyberware via the Inventory tab rows + `EditItemDialog`, because the backend only blocked the `equipped` toggle.

**How to apply:** When enforcing the cyberware-review rule, cover all of these:
- `POST /characters/:id/inventory` — adding inventory is already staff-only.
- `PATCH /characters/:cid/inventory/:itemId` — block non-staff when the item IS cyberware OR `category` is being set TO cyberware (covers equipped, name, notes, qty, recategorize). Use `lower(trim(category)) === "cyberware"`.
- `DELETE /characters/:cid/inventory/:itemId` — block non-staff deletes of cyberware items.
- `EditCharacterDialog` cyberware editor — staff-only; show players a pointer to the Cyberware tab request flow.
- UI inventory rows (`CharacterDetail` InventoryTab) — hide edit/MOVE/delete buttons for cyberware items unless `isStaff`.

Staff (admin/fixer) keep direct control everywhere for corrections. The equip toggle is already replaced with a "via ripperdoc" hint for cyberware rows.
