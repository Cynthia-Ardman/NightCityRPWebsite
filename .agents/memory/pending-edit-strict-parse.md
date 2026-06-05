---
name: Pending-edit strict-parse sidecar fields
description: createPendingEdit body validation must strip non-field metadata before the strict zod parse
---

# Pending-edit strict-parse must exclude sidecar metadata

`createPendingEdit` (artifacts/api-server/src/routes/pending-edits.ts) validates the
PATCH body against `EditableSchema`, which is `.partial().strict()`. The PATCH body
also carries `updateNote` (a free-text review note, sent by EditCharacterDialog only
when non-empty). `updateNote` is NOT a character field.

**Rule:** destructure metadata out of the body and parse only the `rest`
(`const { updateNote, ...rest } = body; EditableSchema.safeParse(rest)`). Never run
the strict parse over the raw body.

**Why:** `.strict()` rejects any unknown key, so parsing the full body 400s ("invalid")
the moment a player adds a note — silently breaking BOTH the review path and the
cosmetic auto-apply path. It went unnoticed because notes are optional (empty note →
frontend sends `undefined` → key omitted → parse passes).

**How to apply:** any future sidecar/metadata field added to the character PATCH body
(reason, source, idempotency token, etc.) must be stripped before the strict parse the
same way, or it will 400 every request that includes it.
