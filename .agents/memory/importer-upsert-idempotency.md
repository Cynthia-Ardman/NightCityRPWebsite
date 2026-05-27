---
name: Importer upsert idempotency
description: Rerun-safety rules for Discord-sheet character imports
---

Rule: in any `onConflictDoUpdate` for character imports keyed by
`importedFromThreadId`, never overwrite ownership-bearing columns with the
freshly-resolved value. Use `coalesce(existing, excluded)` for `ownerId`
and OR-combine `claimed`. Image arrays should only be filled when empty.

**Why:** Between the first import and a rerun an admin may have manually
assigned the character to a different account (e.g. the player came back
under a new Discord ID). A naive `set: { ownerId: values.ownerId }`
silently clears that assignment if the importer can no longer resolve the
user. Same applies to populated image galleries the user may have curated.

**How to apply:** Conflict-set clauses for re-runnable importers:
- `ownerId: sql\`coalesce(${table.ownerId}, excluded.owner_id)\``
- `claimed: sql\`(${table.ownerId} is not null) or excluded.claimed\``
- image arrays guarded by `array_length(...) is null or = 0`.
