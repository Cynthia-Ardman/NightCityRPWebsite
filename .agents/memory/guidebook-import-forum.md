---
name: Guidebook importer & forum channels
description: How the Guidebook importer pulls Discord source channels, and the forum-channel gotcha.
---

The Guidebook importer (artifacts/api-server/src/lib/guidebookImport.ts) pulls a
fixed list of Discord channels (GUIDEBOOK_SOURCES) and upserts one guidebookPages
row per channel. Idempotent: created/updated/unchanged/conflict/error per source;
on-site edits (editedSinceImport) are NOT clobbered — they stash to pendingImport.

**Forum channels (Discord type 15) hold NO top-level messages** — content lives in
threads (one forum post per topic). A naive `/channels/{id}/messages` fetch returns
[], so such a source imports as "No content found". buildPage() must branch on
channel type: enumerate threads (active via guild active-threads filtered by
parent_id + archived public, paginated by archive_timestamp), order oldest-first by
BigInt snowflake id, and render each thread as a `## <thread name>` section.

**Why:** the configured "detailed-systems-explanation" source is a forum with ~6
system threads (Housing/Cyberware/Business/Trauma Team/Attendance/Text RP).

**How to apply:** archived-thread pagination `before` is an ISO timestamp (has `+`),
MUST be encodeURIComponent'd or `+`→space breaks paging. Treat thread-list fetch
failures as hard throws (per-source error), never silent partials, or an incomplete
thread set overwrites good page body.

Run it: `GUIDEBOOK_IMPORT_TARGET=dev pnpm --filter @workspace/api-server exec tsx
src/scripts/import-guidebook.ts` (or admin POST /guidebook/import/run). Image
rehosting mints a fresh object-storage URL each run, so non-forum link pages can
report UPDATED every run (images array differs) — harmless.
