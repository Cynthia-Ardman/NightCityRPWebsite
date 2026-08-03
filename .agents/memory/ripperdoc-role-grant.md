---
name: RipperDoc role grant & backfill
description: How the "RipperDoc" Discord/website role is granted on sheet approval and backfilled for existing ripper docs
---

The "RipperDoc" Discord role (id `1356028868103897156`) is granted to a player when
a character they submitted is **approved AND finalized** (sheet close), gated on a
`ripperDoc: true` flag the submitter ticks on the character sheet.

**Decision (USER):** grant ONLY on staff approval/finalize, never instantly on submit.

**How it threads through:**
- `discord.ts` exposes `RIPPERDOC_ROLE_ID` + `RIPPERDOC_ROLE_MARKER="ripperdoc"`, id-pinned in
  `applyRoleIdGrants` (same pattern as Trial Fixer / Verified 18+). `ROLE_NAMES.RIPPERDOC`
  already existed, so `hasRole(roles,"RIPPERDOC")` and the website flag work for free.
- The website side is reconciled BOTH directions by the hourly `role_sync` cron (which calls
  `applyRoleIdGrants`): granted while the Discord role is held, dropped when it's gone. Don't
  add a one-way set-true-on-grant only.
- The sheet `data` blob is free-form (`CharacterSheetInput` `additionalProperties:true`), so the
  `ripperDoc` flag needs NO OpenAPI change — it flows create → materialize → `characters.sheetData`.
  `sheetWantsRipperdoc(data)` reads `data.ripperDoc === true`; grant fires fire-and-forget in
  `closeSheet`'s applied branch, mirroring the approved-character role grant.

**Backfill** (`POST /admin/maintenance/ripperdoc-backfill`, adminOnly, supports `dryRun`):
- USER decision: target = BOTH groups, deduped — characters whose archetype/occupation says
  ripperdoc (regex `ripper ?-?doc`, NOT bare `ripper` which matches "stripper") OR sheet
  `ripperDoc` flag, PLUS ripperdoc clinic owners (`ripperdocs.owner_id` + via `owner_character_id`)
  and employees (`ripperdoc_employees.character_id` → `characters.owner_id`).
- `users.id` IS the Discord snowflake; grant straight on `owner_id`. Only attempt grants on
  real snowflakes (`/^\d{17,20}$/`); legacy/non-snowflake ids are reported as `skipped`.
- Idempotent / re-runnable. On a successful Discord grant it also `array_append`s the
  "ripperdoc" website role immediately.

**Durable at-least-once grants (2026-08-02, USER decision):** approval-time role grants
(RipperDoc + Approved Character in closeSheet, RipperDoc in pending-edit close + archive PATCH)
go through `grantRoleDurable()` (`lib/roleGrants.ts`), NOT bare `addGuildMemberRole`. It persists
a `pending_role_grants` row first (partial unique on user+role WHERE pending), attempts
immediately (read-before-write: if the member already holds the role, finalize without a Discord
write — heals crash windows and never re-grants after a manual removal), and the hourly role_sync
retries pending rows until success, posting ONE alert to CS_APPROVAL_CHANNEL_ID after 3 real
failed attempts (atomic alerted_at claim). Once `granted`, no action ever again — staff removing
the role later is respected. Off-deployment: rows wait without burning attempts or alerting.
Any NEW approval-time role grant should use `grantRoleDurable`.

**Gotcha:** Discord writes are gated by `externalWritesAllowed()` (REPLIT_DEPLOYMENT=1 or
ALLOW_EXTERNAL_WRITES=1) — in dev/test the grant no-ops (returns `ok:false`). The backfill must
be run from the PUBLISHED app to actually grant Discord roles; the UI surfaces this warning.

**Edit-surface grants (three independent paths now):** turning on `sheetData.ripperDoc` from an
EDIT (not just initial sheet approval) must also grant the role, and the wiring lives in THREE
places — miss one and that surface silently won't grant:
1. `closeSheet` applied branch (initial approval) — original path above.
2. `pending-edits.ts closeEdit` approved branch — detect `diff.sheetData.ripperDoc===true`, capture
   `{ownerId,name}` inside the tx, fire `addGuildMemberRole(RIPPERDOC_ROLE_ID)` AFTER commit.
3. `directory.ts PATCH /directory/archive/:id` (admin archive editor) — grant when
   `edit.sheetData?.ripperDoc===true` after the activity insert.
Same fire-and-forget pattern everywhere. NOTE: archive PATCH `sheetData` must SPREAD-MERGE
(`{...cur.sheetData, ...edit.sheetData}`), not whole-replace, or it wipes unrelated sheet keys
(see sheetdata-merge-passthrough). The Ripper Doc checkbox is on ALL edit dialogs
(EditCharacterDialog Identity tab + ArchiveEditDialog Identity tab); ArchiveEditDialog was also
restructured into tabs matching creation.
