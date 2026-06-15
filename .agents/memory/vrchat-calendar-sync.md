---
name: VRChat group-calendar sync
description: How the NCRP VRChat group-calendar mirror is gated, what it covers, the silent-backfill rule, and the prod-enable gotcha.
---

# VRChat group-calendar sync (events → VRChat)

The full mirror machinery lives in `artifacts/api-server/src/lib/eventsService.ts`
(`reconcileVrchatCalendar`, `syncEventVrchatCalendar`, `syncAndApplyVrchat`) and
runs inside the `discord_event_sync` cron job. It mirrors **upcoming session +
social** events only — missions are excluded by design (separate table), past
events are never backfilled, and writes are capped per cycle for the VRChat rate
limit.

## Triple gate (all must be true)
- `vrchat_calendar_sync_enabled` bot_config flag (defaults OFF; toggled via
  Admin → VRChat calendar sync, `PUT /admin/vrchat-calendar-sync`).
- Deployment write-gate: `REPLIT_DEPLOYMENT=1` or `ALLOW_EXTERNAL_WRITES=1`
  (so dev/scripts never touch the real VRChat API).
- `vrchatCredsConfigured()` + a valid VRChat service-account session (VRChat
  forces email-OTP login on datacenter IPs, so the session can need a manual
  re-login).

## Silent-backfill rule
`syncEventVrchatCalendar(event, { notifyOnCreate })` controls VRChat's
`sendCreationNotification`. **Reconcile/backfill passes `notifyOnCreate:false`**
(bulk backfill must not ping the whole group once per event); the **inline path**
(createEvent/updateEvent → syncAndApplyVrchat) keeps the default `true` so a
genuinely new event still notifies.
**Why:** enabling sync backfills all existing upcoming events at once; notifying
each would spam every group member.
**Tradeoff:** a new event whose inline create fails and is later recovered by
reconcile will be silent — acceptable per product. True notify-fidelity would
need a persisted notification-intent flag.

## Prod-enable gotcha (schema drift)
The `events.vrchat_*` columns (vrchat_calendar_id / vrchat_synced_hash /
vrchat_synced_at / vrchat_sync_error) can exist in dev but be **missing in prod**
— prod schema is applied via the Publish flow (dev→prod diff), so columns added
to the dev schema don't reach prod until the next Publish. Enabling the flag
before those columns exist crashes reconcile. Order: Publish first, confirm
columns, then flip the flag.
