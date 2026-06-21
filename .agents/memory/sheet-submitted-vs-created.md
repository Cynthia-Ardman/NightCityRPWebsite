---
name: Sheet submission date vs draft date
description: character_sheets.createdAt is draft-creation, not submission; how the portal derives the real submission moment.
---

# Sheet submission date vs draft creation date

`character_sheets.createdAt` is when the DRAFT row was first created, NOT when the
player submitted for review. A sheet can sit as a draft for days, so showing
`createdAt` as "Submitted" is wrong.

The canonical submission time is `character_sheets.submittedAt` (nullable),
stamped at the `draft|changes_requested -> pending` transition in
`POST /sheets/:id/submit` (covers first submit AND resubmit). Do NOT stamp it in
`reopenSheet` — reopen is a staff re-review of an already-decided sheet and must
preserve the player's original submission time.

**Effective submission time** for display = `submittedAt ?? snowflakeToDate(discordMessageId) ?? createdAt`.
Computed server-side via `effectiveSubmittedAt()` in
`artifacts/api-server/src/routes/sheets.ts` and returned on `GET /sheets/pending`
and `GET /sheets/:id`.

**Why the snowflake fallback:** rows created before the `submittedAt` column
existed have no explicit value, but their Discord announce post
(`discordMessageId`) was created at submission time. A Discord snowflake embeds
its creation ms: `Number(BigInt(id) >> 22n) + 1420070400000`. This auto-corrects
historical prod rows with NO data backfill (announce posts only exist in prod;
dev relies on `submittedAt` going forward).

**How to apply:** any new surface showing a sheet's "submitted" date must use the
effective value, not raw `createdAt`. The owner list `GET /sheets` returns raw
rows, so `submittedAt` is genuinely null there for never-submitted drafts — guard
with `submittedAt ?? createdAt` on the client.

**Durable backfill (dev rows have no announce post):** the snowflake fallback only
fixes rows WITH a `discordMessageId`. Dev-submitted sheets never get one (Discord
writes are deployment-gated), so the queue still showed `createdAt` for them. The
recoverable real submit time for no-message-id rows is the `activity_events` row
`kind='sheet_submitted'` (message `"<user> submitted sheet for <name>"`), matched
on `actor_id == owner_id` AND exact trailing name, latest event at/after
`createdAt`. `activity_events` has NO sheet-id FK, so multiple same-name no-msgid
sheets for one owner are unresolvable — skip + warn, never auto-attribute. Backfill
script: `scripts/src/backfill-sheet-submitted-at.ts` (snowflake first per-row, then
activity-event; idempotent on `submittedAt IS NULL`; `IMPORT_TARGET=live`). NOTE:
`audit_log` has no sheet-submit action (`edit_submitted` is pending-EDITS only),
and `character_sheets` has no `updated_at` — `activity_events` is the only submit log.
