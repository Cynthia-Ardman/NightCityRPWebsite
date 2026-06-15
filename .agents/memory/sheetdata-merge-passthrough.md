---
name: sheetData edits must merge + passthrough
description: Why character sheetData edits whole-replace and how to avoid wiping sheet-created top-level story fields
---

# sheetData edits must MERGE (client) + PASSTHROUGH (validator)

Character edit PATCH (`pending-edits.ts` EditableSchema → applyDiff) **whole-replaces**
`characters.sheetData` with whatever the client sends. Sheet-created characters store
discrete keys at the TOP LEVEL of sheetData (physicalDescription, appearance,
psychProfile, hooks, skills, gear, guns, identity), NOT just `{preamble, sections}`.

**Two failure modes that silently wipe data:**
1. Client sends a partial blob (e.g. only `{preamble, sections}`) → applyDiff replaces
   the whole column → every other top-level key is lost. FIX: the edit form must spread
   the existing `character.sheetData` first, then override only the fields it edits.
2. The Zod validator (EditableSchema's inner `sheetData` object) is strict → it STRIPS
   any key it doesn't declare → even a correctly-merged blob loses gear/guns/identity.
   FIX: the inner object needs `.passthrough()` plus optional declarations for the
   known story fields.

**Why:** the real validation path is `EditableSchema.safeParse` in pending-edits.ts.
`characters.ts` CharacterUpdateSchema is DEAD CODE (never executed) — don't be fooled
into thinking editing it changes behavior.

**How to apply:** any new top-level sheetData key (read by CharacterDetail/NewSheet)
must (a) be spread-preserved by every edit form's save(), and (b) survive
EditableSchema via `.passthrough()`. The OpenAPI `SheetData` component carries
`additionalProperties: true` + the optional story props to keep generated clients in sync.

## Top-level story keys also break TWO other surfaces (same root: discrete vs sections)
1. **Cosmetic-edit classification** (`pending-edits.ts isCosmeticOnlyDiff`): a sheetData
   edit must be considered cosmetic ONLY when the lone changed key is `preamble`. The old
   code compared only `sections`, so a discrete story-field edit (physicalDescription/
   appearance/psychProfile/hooks/skills) left `sections` untouched → misclassified as
   cosmetic → AUTO-APPLIED with NO review request (the live row + Edit dialog showed the
   value but no pending edit existed). FIX: diff every sheetData key except `preamble`.
2. **Profile rendering** (`CharacterDetail.tsx ProfileDossier`): it used to early-return to
   `<SheetSections>` whenever `sections` existed, hiding every discrete top-level field on
   legacy chars that have BOTH. Render SheetSections (gate on a NON-EMPTY section value,
   mirroring SheetSections' own filter) AND the discrete `DossierTextCard`s (they self-hide
   on empty); guard the discrete BACKGROUND card behind `!hasSections` so the bio isn't
   shown twice. Note `hooks` was editable-but-never-rendered — keep dossier cards in sync
   with EditableSchema's story fields.

**Why:** discrete story fields and the free-form `sections` map are independent stores; any
code that special-cases one (classification, diffing, rendering) silently drops the other.
