---
name: Sheet close custom-attr parity
description: Closing an approved NEW character sheet with custom (non-catalog) cyberware/guns requires the closer to supply mechanical attributes, mirroring the standalone custom-request close flow.
---

# Sheet close requires custom-item attributes

When a NEW character sheet is closed/applied, its inventory is materialized from
`data.cyberware` / `data.guns` / `data.gear`. Cyberware and guns whose name is in
the catalog (lower(trim(name)) match) auto-resolve their mechanical attributes
from the catalog. Items NOT in the catalog are CUSTOM and the closer MUST supply
attributes (cyberware: CWP+slot; gun: category/weaponType/fireMode/powerLevel +
optional manufacturer) or the close returns 400.

**Why:** parity with the standalone custom cyberware/gun *request* close flow
(requests.ts) — a custom item with no mechanical detail produces an unusable
inventory row. Hard-require, don't silently default.

**How to apply:**
- Server: `buildSheetInventoryRows()` (sheets.ts) is the single resolver; it
  returns `{error}` when a custom item lacks params. It runs ONLY on the
  fresh-insert materialization path (a linked/resubmitted sheet skips seeding, so
  no params needed there). `closeSheet` loads both catalog maps BEFORE the txn and
  surfaces the build error as HTTP 400.
- Params travel on the close body: `ReviewCloseInput.sheetCyberware[]` /
  `sheetGuns[]`, each keyed by `index` = the position in the FULL
  `data.cyberware`/`data.guns` array (not a compacted custom-only index). The
  frontend `SheetCloseDialog` preserves original indices when it filters to custom
  rows, so mixed catalog+custom sheets map correctly.
- Note formats must match requests.ts: gun = `Manufacturer · Category · Type ·
  Fire · Power` (nulls dropped); cyberware = `CWP <n> · <userNotes> · slot: <x>`
  with `slot:` LAST (CharacterDetail's slot regex swallows trailing text).
- `applyAll` (bulk apply in ReadyToApplyPanel) sends NO params, so it 400s on any
  sheet with custom items — by design, counted as a failed apply; the per-row
  SheetCloseDialog is the path that collects attributes.
- Catalog CWP+slot WIN over the player's typed sheet values for catalog items.
