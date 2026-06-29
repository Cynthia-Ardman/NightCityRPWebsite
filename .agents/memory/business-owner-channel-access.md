---
name: Business-owner Discord channel access
description: How owners of stores/ripperdocs are granted/revoked access to the business-owners Discord channel.
---

Owners of a `stores` or `ripperdocs` row (the `ownerId` column = a Discord snowflake) get a
per-member VIEW permission OVERWRITE on a fixed Discord channel; they lose it only when they own
NO business. Employees (`*_employees` tables) never get access.

**Design:** the bot manages per-member channel overwrites directly (PUT/DELETE
`/channels/{id}/permissions/{userId}`), NOT a role — driven by a single
`reconcileBusinessChannelAccess()` (lib/businessChannelAccess.ts) that diffs DESIRED (distinct
valid-snowflake owners of stores ∪ ripperdocs) against a MANAGED set persisted in `bot_config`
key `business_channel_access_granted`.

**Why a bot_config managed set instead of reading the channel's live overwrites:** reconcile must
only ever touch overwrites WE created, so it can never clobber an admin's manual member overwrite.
The set mutates ONLY after a successful Discord write, so off-deployment runs (externalWritesAllowed
false → writes no-op) leave it untouched and retry once live. Known gap: manual removal of a
bot-managed overwrite WITHOUT an ownership change won't self-heal (desired==managed).

**How to apply:** any new ownership-loss/gain path must trigger a reconcile. Current hooks:
request approve (closeRequest, appliedRef store:/ripperdoc:), PATCH ownerId transfer, DELETE
store/ripperdoc, + hourly catch-all piggybacked on the role_sync job. Reconcile is serialized
in-process via a promise chain (bot_config is read-modify-write; overlapping fire-and-forget calls
would otherwise race/double-call). Owner ids that aren't 17-20 digit snowflakes (legacy/stub rows)
are skipped.
