---
name: Lore write paths
description: Every code path that writes a lore_entries row — change all of them in lockstep when adding a field.
---

A new field on `lore_entries` (e.g. `imageUrl`) must be threaded through ALL of
these write paths, not just the obvious direct create/update. Missing one
silently drops the field on that path.

**The full set of lore write paths (artifacts/api-server/src/routes/lore.ts):**
1. Direct admin create — `POST /directory/lore`
2. Direct admin update — `PATCH /directory/lore/:id`
3. Fixer proposal apply — `applyProposal` (BOTH create and edit branches)
4. Import-draft pipeline — `lore_import_drafts` has its OWN mirror columns; the
   field must be added to the draft schema, `draftUpdateSchema` + PATCH set
   logic, `shapeDraft`, `createFromDraft` insert, AND the merge-on-approve
   branch (`draft.field ?? existing.field`).

**Why:** the import-draft path is a separate staging table, easy to forget; an
architect review caught it being dropped on import even though entries supported
the field.

**How to apply:** when adding any lore_entries field, also add the mirror column
to lore_import_drafts and update all 4 path groups + OpenAPI (LoreEntry/Input/
Update/Summary AND LoreImportDraft/Update) + codegen/dist + the LoreEditor and
LoreImportReview UIs. The proposal beforeSnapshot is generic (iterates diff
keys) so it needs no change.
