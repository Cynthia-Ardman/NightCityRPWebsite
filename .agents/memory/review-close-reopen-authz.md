---
name: Unified review close/reopen per-type authz
description: The unified /review/:type/:id/close|reopen endpoints must gate per queue-type, not with a flat isReviewer check.
---

# Unified review close/reopen per-type authorization

The unified `POST /review/:type/:id/close` and `/reopen` endpoints dispatch to the
per-queue handlers (closeRequest/closeEdit/closeSheet, etc). They MUST authorize
per `type`, not with a flat `isReviewer(user)`:

- `request` → FIXER || ADMIN
- `sheet`   → CS_APPROVER || ADMIN
- `edit`    → any reviewer (isReviewer)

This mirrors the visibility policy already used by the unseen endpoints
(canMisc/canSheets/canEdits).

**Why:** Under the staged lifecycle, a request's economic effect (lease /
inventory / venue materialization) is DEFERRED and only committed at close. A flat
`isReviewer` gate lets a CS_APPROVER (a reviewer for sheets/edits, but NOT a fixer)
close a request and trigger its deferred materialization — a privilege escalation
on a dangerous state transition.

**How to apply:** Any new unified review state-transition endpoint that fans out to
multiple queue types must gate on the per-type policy before dispatch. The exported
close*/reopen* handlers trust the caller contract, so the route is the single
chokepoint — keep the authz there (and add a denial test per type, e.g. CS_APPROVER
cannot close/reopen a request and the effect must not materialize).
