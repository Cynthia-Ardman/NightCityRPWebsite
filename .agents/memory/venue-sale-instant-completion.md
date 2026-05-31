---
name: Venue sale instant completion
description: How store/ripperdoc sell/install/give/remove charge the buyer instantly via create-drives-completion, and the cleanup traps.
---

Venue sales (store + ripperdoc: sell/install/give/remove) charge the buyer and move the
item IMMEDIATELY on the operator's action — there is no buyer pending-approval step.

**Shape:** `completeSaleOffer(offer, actor)` in `saleOffers.ts` holds the whole completion
body (econ-mode gate → debit → guarded tx → commission → final return). `createOffer` and
`createRemoveOffer` insert a pending offer + audit row, then call `completeSaleOffer`, then
delete the row iff it is still pending afterward. `approveOffer` keeps only its preamble and
delegates to `completeSaleOffer`; it is retained ONLY for the stock_add (admin→venue) approval
path and legacy pending offers. MyOffers UI shows approve/deny ONLY for pending `stock_add`
offers; every other type is read-only history.

**Why delete-if-pending:** a non-success completion (economy disabled/test, can't afford,
wallet error) leaves status=pending; without cleanup these linger as dangling pending sale
offers that no longer have any approve UI.

**Trap 1 — needsReconcile:** if the buyer is debited but completion AND refund both fail,
`completeSaleOffer` returns `body.needsReconcile: true`. Callers MUST skip the delete in that
case so the offer row survives as the manual-reconciliation handle. Deleting it unconditionally
loses the only offer-linked recovery handle for a buyer-debited incident.

**Trap 2 — TEST-mode dryRun leaves pending:** in TEST/dry-run economy mode `approveOffer`/
`completeSaleOffer` return a 200 dryRun and leave the offer pending (this was the root cause of
custom/non-catalog items "silently failing" — they sat pending forever). The instant flow's
cleanup deletes that pending row, so a dry-run sale returns 200 with nothing moved. UI does not
yet surface `dryRun`, so an operator testing in TEST mode sees success but no movement.

**Test harness gotcha:** stores.test.ts live-mode debit syncs to the wallet provider, so
`mockPatch` (patchBalance) needs a default `mockResolvedValue` in beforeEach or the debit 502s.
