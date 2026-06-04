---
name: Discord scheduled-event ↔ calendar bidirectional sync
description: How the events↔Discord poll-based reconcile decides direction and stays idempotent (no gateway exists).
---

# Discord event sync (poll-based, no gateway)

There is NO Discord gateway/websocket listener in this codebase. All Discord
sync is REST. Bidirectional events↔Discord sync is a poll cron
(`discord_event_sync`, every 10 min) that calls `reconcileDiscordEvents()` in
eventsService.ts.

## Direction is decided by a stored content-hash, not a timestamp
Discord's API exposes no "modified at" on scheduled events. So each event row
stores `discordSyncedHash` (sha256 of title/description/effective-location/
start-sec/end-sec) of the last reconciled state. Each cycle compares BOTH sides'
current hash to the stored one: the side that differs is the side that changed.
- only Discord changed → pull into the row
- website changed (or BOTH) → push the website edit up
**Why both-changed → website-wins (not true most-recent):** website edits push
synchronously and re-stamp the hash, so genuine both-changed races are rare; we
honour the operator's last on-site action. Do NOT call this "most recent wins"
literally — it's website-authoritative on true conflict.

## Hash normalisation MUST match buildEventBody (discord.ts)
Null/empty location collapses to `"Night City"` (the default we push) so a
website-null and a Discord-"Night City" hash identically and don't churn forever.
Image is intentionally excluded (Discord gives an image hash, not our URL).

## Idempotency guards (added after architect review)
- Partial unique index `events_discord_event_id_unq` on `discord_event_id WHERE NOT NULL`; import uses `onConflictDoNothing` so concurrent cron/manual runs or a race with the synchronous create path can't double-insert. The ON CONFLICT predicate MUST use `where:` (NOT `targetWhere:`, silently ignored → 42P10) — see drizzle-onconflict-partial-index.md.
- Pull UPDATE is guarded `WHERE discord_synced_hash = <synced>` (non-null in the pull branch) so a concurrent website edit isn't clobbered.
- True mirror: a Discord delete → cancel the row; a website-cancelled row whose Discord event still exists gets a delete-RETRY in reconcile (covers transient/Test-mode push failures), then nulls discordEventId.

## "Gone from Discord" is NOT always a delete — ended events must be retained
Discord auto-removes a scheduled event from the guild once it ENDS. So in the `!d`
(gone-from-Discord) branch, blindly cancelling loses all history (listEvents hides
`status='cancelled'`). Disambiguate by end time:
- **non-recurring AND `endAt ?? startAt` <= now** → it finished, not deleted → set
  `status='completed'` + unlink `discordEventId=null` (so later cycles skip it via the
  `if (!row.discordEventId) continue` guard — idempotent). `completed` rows stay visible
  (listEvents only excludes `cancelled`); they're past-dated so never show as upcoming.
- **end still in the future** → genuine early delete → cancel-mirror (original behaviour).
- **recurring rows are EXCLUDED from the completed path**: Discord keeps recurring events
  in the list rolling-forward, so a disappeared recurring row = whole series deleted →
  cancel. A retained recurring row would expand phantom future occurrences on the calendar.
`completed` is a third value in EventView.status enum (openapi.yaml: [scheduled, cancelled,
completed]); ReconcileResult/jobs log carry a `completed` counter.

## Gating — split by destination (NOT whole-job)
`reconcileDiscordEvents(live: boolean)`. It is intentionally NOT in `liveSystemByJob`
(that would no-op the entire job in Test mode and block importing the existing schedule).
- **Website-side writes ALWAYS run** (Test and Live): import unmatched Discord events,
  pull Discord-only edits, mirror a Discord delete → cancel the row. These touch only our
  DB and are non-destructive to Discord.
- **Discord-side mutations gate on `live`**: push a website edit up, delete a Discord event
  for an on-site cancel. In Test they increment `result.deferred` and are left for the next
  Live run. jobs.ts computes `live = await isSystemLive("missions")` (ANDs master) and passes it.
Mission-owned discord ids (missions.discordEventId) are excluded from import/reconcile.
