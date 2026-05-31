---
name: Financial decision authz against current owner
description: Approve/spend endpoints must authorize against the resource's CURRENT owner, not a snapshotted requester id stored at creation time.
---

# Authorize spend/approve endpoints against the resource's current owner

When a request row stores who it was routed to (e.g. `custom_requests.requestedById = venue.ownerId` at creation), a later approval that **spends money** must NOT authorize on that stored id alone.

**Rule:** Inside the decision transaction, re-load the underlying resource (the venue) by its id from `details`, and gate on the resource's *current* `ownerId` (or admin). If the resource is missing, 404; if the caller is no longer the owner, 403.

**Why:** Ownership can be reassigned by staff between request creation and approval. If you trust the stored `requestedById`, the *old* owner can still approve and drain the *new* owner's balance — a broken-auth financial bug.

**How to apply:** Any `stock_cost` / cost-approval / spend-on-approval path (e.g. `POST /requests/:id/stock-decision`). Load `stores`/`ripperdocs` by `details.venueId` under the same `FOR UPDATE` tx, then check `venue.ownerId === req.user.id || isAdmin`. Covered by regression tests in `requests.venue.test.ts` (old-owner blocked, new-owner approves, venue-deleted 404).
