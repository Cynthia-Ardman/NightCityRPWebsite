---
name: Character death write paths
description: Every place lifeStatus can flip to "dead" and the rule for wiring death side effects
---

# Character death write paths

A PC's `lifeStatus` can become `dead` via THREE write paths, plus a self-heal:

1. Admin manual character create (`POST /admin/characters` with `lifeStatus: "dead"`).
2. Staff archive PATCH in directory routes (archive edit dialog).
3. Pending-edit close (`closeEdit`) applying an approved character edit.
4. Hourly `role_sync` cron — the backfill/self-heal pass.

**Rule:** any side effect keyed on death (e.g. the Dead Character Discord role grant) must be wired at ALL THREE write paths AND recomputed in `role_sync`, mirroring the RULES_ROLE_ID backfill pattern.

**Why:** wiring only one path leaves silent gaps; the cron backfill catches missed/legacy rows and manual DB edits.

**How to apply:**
- In `closeEdit`, capture the grant intent INSIDE the transaction (from post-apply state, including `kind === 'pc'`), fire the Discord call after commit (fire-and-forget, grant-only).
- In `role_sync`, precompute the distinct dead-PC ownerId set once, grant only when the member's roleIds read was definite (`!== null`) and the role is missing. Ownership matches on `users.id`; the Discord write uses `discordId`.
- Canonical lifeStatus values: `active | dead | missing | loa | retired` — "active" is the default, there is no "alive".
