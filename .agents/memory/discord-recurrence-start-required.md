---
name: Discord recurrence_rule requires start
description: Guild scheduled-event recurrence_rule bodies must include a `start` timestamp or Discord 400s; null clears fine.
---

Discord's guild scheduled-event API REQUIRES `recurrence_rule.start` (ISO
timestamp anchoring the series, same as scheduled_start_time). Omitting it
returns 400 BASE_TYPE_REQUIRED on both create and modify — unit tests of the
body shape missed this; only a live push surfaced it.

Verified live (Aug 2026): create-with-weekly, interval change via modify, and
`recurrence_rule: null` on modify all work once `start` is included; Discord
echoes back exactly {frequency, interval, byWeekday:null, count:null,
until:null}, so recurrenceEqual sees no drift and the reconcile cron does not
churn.

**How to apply:** buildEventBody (discord.ts) sets `rule.start =
input.startAt.toISOString()`. Any new recurrence write path must keep start in
lockstep with the pushed scheduled_start_time. One-off live re-verification:
`ALLOW_EXTERNAL_WRITES=1 npx tsx src/scripts/verify-recurrence-live.ts`
(creates + deletes a temp guild event).
