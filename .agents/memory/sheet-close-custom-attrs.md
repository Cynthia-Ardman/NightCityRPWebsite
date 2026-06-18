---
name: Sheet close custom-attr parity
description: Closing an approved NEW character sheet with custom (non-catalog) cyberware/guns requires the closer to supply mechanical attributes, like the standalone custom-request close flow.
---

# Sheet close requires custom-item attributes

Closing/applying an approved NEW character sheet materializes its inventory from
the sheet `data`. Cyberware/guns whose name matches the catalog (lower(trim) key)
auto-resolve their attributes from the catalog; items NOT in the catalog are
CUSTOM and the closer MUST supply attributes (cyberware: CWP+slot; gun:
category/weaponType/fireMode/powerLevel + optional manufacturer) or close 400s.

**Why:** parity with the standalone custom cyberware/gun *request* close flow — a
custom item with no mechanical detail produces an unusable inventory row.
Hard-require, never silently default.

**How to apply:**
- Resolution lives in ONE server resolver that returns `{error}` on a missing
  custom param; close surfaces that as 400 with no partial materialization. It
  runs only on the fresh-insert path — a linked/resubmitted sheet skips seeding,
  so no params are needed there.
- Params are keyed by `index` = position in the FULL `data.cyberware`/`data.guns`
  array, NOT a compacted custom-only index; the dialog must preserve original
  indices when it filters to custom rows, or mixed catalog+custom sheets misalign.
- Catalog values WIN over the player's typed sheet values for catalog items.
- Note formats must match the request flow: gun = `Manufacturer · Category · Type
  · Fire · Power` (nulls dropped); cyberware ends with `slot: <x>` LAST (the
  character-detail slot regex swallows trailing text).
- All sheet closes route through one dedicated dialog via a dispatcher in
  CloseTicketDialog (subjectType==="sheet"); the generic note-only dialog can't
  collect attributes, so any path using it would 400 on custom sheets.
- Bulk "apply all" sends no params and therefore 400s on custom-item sheets by
  design (counted as failed); the per-row dialog is the attribute-collecting path.
