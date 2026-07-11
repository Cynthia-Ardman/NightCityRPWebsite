---
name: Character-sheet self-declaration flags (ripperDoc, fbc)
description: How to add a boolean self-declaration flag to a character sheet and have it persist end-to-end
---

# Character-sheet self-declaration flags

Boolean "this character is X" flags (e.g. `ripperDoc`, `fbc` = Full Body
Conversion) live in the sheet's free-form `sheetData` JSON, NOT as characters
columns.

## Why they persist for free
- Sheet `data` is stored as a free-form blob (the strict `CharacterSheetData`
  OpenAPI schema does NOT list these flags, yet they persist).
- On approval, `characterFieldsFromSheet` (sheets.ts) copies the ENTIRE blob into
  `characters.sheetData` (`sheetData: data as never`), so the flag survives
  submit → approve → materialize.
- The character edit path (`CharacterUpdateSchema` in characters.ts) uses
  `.passthrough()` on `sheetData`; edit dialogs spread-merge existing sheetData
  before writing, so a story edit never wipes the flag.

## To add a new flag, wire these surfaces (all frontend unless it has effects)
1. `NewSheet.tsx` (creation form): a `useState` from `init.<flag>`, a checkbox,
   include the flag in `buildPayload()`, AND add it to the `payloadSig`
   dependency array or autosave won't fire on toggle.
2. `EditCharacterDialog.tsx` (player/staff edit): state from
   `sheetData.<flag>`, a `setX(...)` line in the reset-on-open effect, and the
   flag in the `sheetData` payload object.
3. `ArchiveEditDialog.tsx` (staff archive edit): the local `sheet` cast type,
   state, the flag in the `sheetData` payload, and a checkbox.
4. (Optional but consistent) document it under `SheetData` and
   `CharacterUpdateInput.sheetData` in openapi.yaml, then run
   `pnpm --filter @workspace/api-spec run codegen`. Safe because SheetData has
   `additionalProperties: true`; the generated client does not strip unknown keys
   anyway, so this step is documentation/typing only.

## Side effects are opt-in
`ripperDoc` grants a Discord role on sheet CLOSE (see ripperdoc-role-grant.md).
`fbc` is deliberately a pure self-declaration with NO backend logic — no
validation, no role, no combat-cyberware enforcement (by product decision). Don't
add enforcement to a self-declaration flag unless explicitly asked.

## Known flags & read-side consumers
`ripperDoc`, `fbc`, `ncpd`. Not every flag is write-only: `ncpd` has NO role
grant (self-declared like fbc) but IS read server-side — the `/ncpd/officers`
roster query filters PCs on `sql\`(characters.sheetData ->> 'ncpd') = 'true'\``
OR-ed with a legacy `archetype ILIKE '%ncpd%'` fallback (kept so pre-checkbox
NCPD chars still surface). sheetData is JSONB; `->>` yields text, compare to
`'true'`. If you add a flag that filters a list, remember to update that query.
