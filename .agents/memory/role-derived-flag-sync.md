---
name: Role-derived access flags need two-way recompute
description: Discord-role-derived gate flags (e.g. users.verified18) must be recomputed both directions in the recurring sync, not just set-true on login.
---

A persisted boolean that gates access and is *derived* from a Discord role (e.g.
`users.verified18` from the Verified-18 role) must be recomputed in BOTH
directions (true AND false) by the authoritative recurring sync — the
`role_sync` cron in `lib/jobs.ts`. Login, the admin per-user roles endpoint, and
a one-off backfill all set it, but if the recurring job only ever sets it true,
removing the role in Discord never revokes portal access (stale-true authz
drift).

**Why:** the 18+ gate (`requireVerified`) reads the persisted column, not live
Discord roles, so the column is the source of truth and must track role removal.

**How to apply:** in the recurring role sync, fetch raw role ids
(`fetchGuildMemberRoleIdsViaBot`, returns null on failure) and set
`verified18 = roleIds === null ? existing : roleIds.includes(ROLE_ID)`. Only
touch the flag when the fetch succeeds (non-null) so a transient Discord outage
never clears the gate for everyone. Same null-guard pattern in the admin roles
endpoint and login callback.
