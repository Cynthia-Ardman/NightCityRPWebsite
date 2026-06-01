---
name: Review close/reopen authz must match vote authz
description: close/reopen authz for staged review tickets must mirror the per-type VOTE authz, not the queue-visibility policy
---

# Close/reopen authz mirrors VOTE authz, not queue visibility

The unified `POST /review/:type/:id/close|reopen` endpoints gate on `isReviewer`
(FIXER || CS_APPROVER || ADMIN) — the SAME predicate the three vote endpoints use
(`requests.ts` vote, `pending-edits.ts` vote, `sheets.ts` vote all check
`isReviewer`).

**Why:** In the staged model, approval is decided at vote/majority time and the
economic/character effect is DEFERRED to close. Whoever can vote-approve a ticket
can already drive it to `approved`; restricting close to a narrower role does NOT
add a privilege boundary — it only creates an inconsistency. A tempting-but-wrong
fix is to gate close per-type using the QUEUE-VISIBILITY policy from the
unseen-counts endpoints (requests → FIXER/ADMIN via `canMisc`, sheets →
CS_APPROVER/ADMIN via `canSheets`). That is a *visibility* policy, not an *action*
policy: sheet voting is open to any reviewer (a FIXER can vote on a sheet), so
gating sheet-close on CS_APPROVER/ADMIN makes a FIXER who just voted unable to
close it (→ 403, breaks `sheets.pipeline.test.ts` "majority threshold").

**How to apply:** When adding any state-changing action to a review ticket, gate
it on the SAME predicate as that ticket's vote/override endpoint, not on the
unseen/queue visibility helpers. Visibility (who sees the queue) and action (who
can decide/close) are deliberately decoupled here.
