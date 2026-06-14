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
