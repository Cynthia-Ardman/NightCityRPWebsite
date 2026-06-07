---
name: Rules-gate role grant reconciliation
description: Why the first-login rules acceptance grant must be backfilled by the role_sync cron, not trusted on the accept call alone.
---

The first-login rules splash flips `users.rulesAccepted` AND grants a Discord
role on `POST /auth/accept-rules`. The role grant is **best-effort**: it is gated
by `externalWritesAllowed()` (no-op off the live deploy) and can transiently fail
(Discord down). Persistence still succeeds, so a member can permanently clear the
UI gate without ever receiving the role.

**Rule:** any "accept once → also grant a Discord role" flow must have the
`role_sync` cron reconcile it — for every user with the accepted flag set whose
fetched roleIds lack the role, call `addGuildMemberRole` (best-effort, guarded on
`roleIds !== null` so a failed fetch never thrashes).

**Why:** guarantees eventual grant without blocking the accept UX on Discord
availability. Do NOT make the accept endpoint hard-fail (e.g. 502) on grant
failure — that locks the member out whenever Discord hiccups.

**How to apply:** the gate itself is frontend-only (App.tsx AppRoutes, after the
verified18 + loginRestricted gates); it is a soft onboarding acknowledgement, NOT
an authorization boundary, so it is deliberately not mirrored as server-side 403s
like the legal age-gate / admin lockdown.
