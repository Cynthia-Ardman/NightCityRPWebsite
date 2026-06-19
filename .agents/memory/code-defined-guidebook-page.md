---
name: Code-defined guidebook reference page
description: How to add a bespoke, code-rendered guidebook page that isn't a DB row.
---

Guidebook pages are normally DB rows (Discord-imported / admin-edited), reached
via `/guidebook/:id` (which does `Number(id)`). To add a bespoke, fully
code-defined reference page instead:

- Register a static route (e.g. `/guidebook/weapons`) in `App.tsx` BEFORE
  `/guidebook/:id` — otherwise wouter's Switch captures it as a numeric detail
  route and `Number("weapons")` → NaN.
- It will NOT appear in `DirectoryGuidebook`'s listing (that iterates API
  `data.sections` of DB pages). Surface it with a static card — e.g. a static
  "Reference" section rendered alongside the dynamic sections, gated so an active
  search that clearly doesn't match can hide it.

**Why:** the natural assumption is to seed a DB `guidebook_pages` row, but a page
that needs real React/components (swatches, computed layout) can't live in the
markdown body; the special-case-by-slug pattern in `GuidebookPageDetail` only
toggles small widgets (faq/npc-acting), not a whole bespoke page.
