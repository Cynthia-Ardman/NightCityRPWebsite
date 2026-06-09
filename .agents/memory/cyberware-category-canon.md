---
name: Cyberware category canonicalization
description: Inventory "cyberware" category predicates must trim+lowercase, or whitespace/case variants bypass slot-cap enforcement and the violator report.
---

The inventory cyberware slot-cap (1 item per capped body slot per player character) keys off `inventory_items.category === "cyberware"`. Any predicate that gates enforcement, reporting, or storage on this value must compare `lower(trim(category))`, never raw `lower(category)` or `category.toLowerCase()`.

**Why:** category is free-text. A payload like `"Cyberware "` (trailing space / mixed case) silently skipped the POST /characters/:id/inventory cap gate AND was invisible to GET /fixer/cyberware-violations, under-reporting violators. Fix: canonicalize once server-side (store the canonical `"cyberware"`), and use `lower(trim(...))` in every SQL predicate.

**How to apply:** when adding any new code path that reads/filters inventory by the cyberware category (enforcement, reports, autobill, derivations), canonicalize the same way. Slot itself is uncapped for Miscellaneous + Custom/one-off + unresolved slot; NPCs (characters.kind==='npc') are exempt. Slot resolution = `slot:` note tag first, else catalog_cyberware name match (see api-server/src/lib/cyberwareSlots.ts).
