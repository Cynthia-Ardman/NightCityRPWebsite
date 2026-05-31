---
name: Stock-add offer approval + single-unit lease race
description: Owner-only approval rule for venue-debiting offers, and the locking rule for single-occupancy housing leases.
---

# Stock-add offer approval must be owner-only

A `stock_add` SaleOffer is admin-CREATED but DEBITS the target venue's account on approval. The generic `canDecide()` allows buyer OR admin, which would let the admin who created the offer self-approve and charge another player's venue without consent.

**Rule:** `approveStockAddOffer` must additionally require `offer.buyerUserId === actor.id` (buyer = venue owner). Admins may create and deny, never self-approve a venue charge.
**Why:** the whole point of the offer/approval pattern is owner consent before money moves; the shared `canDecide` admin allowance is a silent bypass for any offer type that spends someone else's balance.
**How to apply:** any future offer type that debits a third party must add an owner-only guard inside its approve handler, not rely on `canDecide`.

# Single-unit lease occupancy is race-prone

`POST /housing/lease` is now player-facing (self-lease residential). A check-then-insert (`SELECT existing lease ... then INSERT`) lets two concurrent requests both pass and double-lease one listing.

**Rule:** do the occupancy re-check and insert inside `db.transaction`, locking the listing row first with `tx.select(...).from(catalogRent).where(id).for("update")`.
**Why:** there is no DB unique constraint on `housing.listingId`; the lock serializes concurrent leases on the same listing.
**How to apply:** any path that enforces single-occupancy by row-count check must hold the listing lock across check+insert (or add a partial unique index if leases are deleted on vacate).
