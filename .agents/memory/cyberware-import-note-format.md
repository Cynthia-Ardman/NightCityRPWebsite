---
name: Cyberware import note format & display parsing
description: Why imported cyberware notes need catalog-slot disambiguation and sentinel stripping on every display surface.
---

The bulk importer (scripts/src/import-cyberware-inventory.ts) historically wrote
inventory_items.notes as `CWP <n> · <slot> · <desc> [cyberware-import:v1]` — a
BARE slot segment with no `slot:` prefix — plus the import sentinel. The portal
editor's canonical form is `CWP <n> · <desc> · slot: <x>` (slot LAST).

**Rule:** `parseCyberNotes(notes, knownSlots?)` must (1) strip the
`[cyberware-import:*]` sentinel before splitting, and (2) when given the
cyberware catalog's slot names, treat a bare segment matching a known slot as the
slot (guarded by `!slot` so canonical `slot:` wins). Without the catalog it
cannot tell a bare slot from a free-text description — position is unreliable
(some rows have no description, some have the sentinel glued to the slot).

**Why:** otherwise the sentinel AND the bare slot leak into the displayed NOTES
field and the SLOT dropdown stays empty.

**How to apply:**
- Pass `(useListCyberware()??[]).map(c=>c.slot)` to `parseCyberNotes` at every
  call site (StaffCyberwareCard, EditCharacterDialog, CharacterDetail CyberwareTab).
- Any surface rendering RAW `it.notes` (e.g. the generic Inventory tab list and
  its edit dialog) must run `stripImportSentinel(notes)` so the tag never shows.
- The importer now emits canonical `slot: <x>` going forward; only legacy rows
  carry the bare form.
- Hydration effects that re-parse rows from server inventory must guard with a
  dirty check (compare cyberRows vs cyberOriginal) before resetting, or a late
  catalog load / background refetch clobbers the staffer's unsaved edits. The
  catalog is intentionally a dep so a not-yet-edited grid re-parses once slots load.
- Fix is display-layer only (no data migration): the live prod DB isn't reachable
  from dev, and reconcileCyberware self-heals to canonical on the next staff save.
