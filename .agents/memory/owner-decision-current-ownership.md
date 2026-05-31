---
name: Owner-gated decision endpoints vs ownership snapshot
description: Owner-action request endpoints should authorize against CURRENT characters.ownerId, not the requestedById captured at creation.
---

# Owner-gated decision endpoints must check CURRENT ownership

Endpoints where the *character owner* acts on a pending request (e.g.
`/requests/:id/stock-decision`, `/requests/:id/employee-decision`) should
authorize against the **current** `characters.ownerId` at decision time, not
only the `requestedById` snapshot stored when the request was created.

**Why:** character ownership is not immutable while a request is pending — it
can change via Discord-login auto-claim (`auto-claim-legacy-username`) or admin
reassignment. Gating purely on the creation-time `requestedById` lets a former
owner accept/deny after the character has moved to someone else (stale rights),
and can block the new rightful owner. stock-cost decision already revalidates
against the current owner; employee-decision currently gates on
`requestedById` only and has this gap (flagged in review as non-blocking).

**How to apply:** inside the FOR UPDATE + pending-status re-check transaction,
re-load the character and compare `characters.ownerId` to the actor (or allow
admin). Mirror the stock-cost pattern so all owner-action endpoints behave
consistently.
