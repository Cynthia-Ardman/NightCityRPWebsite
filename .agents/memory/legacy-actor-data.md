---
name: Legacy actor data is lobby-only
description: Why the per-mission ACTORS tab is empty and cannot be backfilled from legacy data
---

The mission ACTORS tab reads `mission_actor_payments` (populated going forward via the
"Pay Actors" tool). It looks empty because:

- Legacy `mission_event` (PROD_DATABASE_URL source) has NO actor field — only
  `attendee_ids` (players, imported as `missions.slots` + mission_assignments).
- Legacy `actor_attendance` / imported `bot_actor_attendance` is ~16 rows, ALL
  `mission_name` = "Open Chaos Lobby" (14) or "test" (2), with `mission_id` NULL.
  It is generic standby-lobby attendance, NOT tied to any specific mission.
- `missions` has no legacy-mission-id column, so even if the data were per-mission
  there's no join key.

**Why:** the old Discord bot barely used per-mission actor tracking, so per-mission
actor history genuinely does not exist. getActorHistory() surfaces it as an aggregate
"who acted" view on the reports page, NOT per mission (deliberate).

**How to apply:** don't try to populate per-mission actors from legacy data — there's
nothing to map. The ACTORS tab fills only from new "Pay Actors" payments. Note the
bot_* imports (incl. bot_actor_attendance) can be present on dev but absent on live
prod — verify per-DB before claiming the reports actor-history section is populated.
