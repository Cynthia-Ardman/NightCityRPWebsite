---
name: Bar shift wage split
description: How per-sale shift wage splits settle, snapshot, and suppress commission; traps for future changes.
---

Bars (stores with staff-set `shiftsEnabled` + owner-set `shiftWagePct`) let the owner/employees clock in for 4-hour shifts (`store_shifts`; one active shift per USER via partial unique on user_id WHERE clock_out_at IS NULL). While anyone is on shift and pct > 0, each venue-credited sale splits pct% of the sale TOTAL (not profit) evenly (floored, remainder stays in venue) and **replaces** the seller's profit commission for that sale.

**Rules that must survive future edits (`settleShiftWages` in saleOffers.ts):**
- Two durable phases mirroring settleCommission: reserve (lock active shifts FOR UPDATE, guarded stamp of `shiftWagesSettledAt` + amount, venue debit + ledger row + per-shift earned totals, all one tx) then per-worker credits keyed `offer:<id>:shift:<shiftId>`.
- **Membership snapshot, never timestamps:** the reserve writes `shiftWageShiftIds` on the offer; recovery re-pays exactly that set. Reconstructing "active at settledAt" races concurrent clock-ins → divides by a different count on retry.
- `shiftRegime: true` (commission suppressed) even when the floored per-worker share is 0, and when a concurrent call holds the reservation.
- Active-shift predicate is `clockOutAt IS NULL AND scheduledEndAt > now()` — lazy expiry/sweep is bookkeeping only; an unswept expired row can never earn.
- Clock-in owner fallback must verify `ownerCharacterId` is still owned by the CURRENT owner (staff reassign ownerId without relinking the character).
- Staff-only `shiftsEnabled` (PATCH 403s non-staff); pct is owner-or-staff, clamped 0-100. Test-mode sales dryRun before any of this runs.

**Why:** prevents double-pay/underpay on approve retries and cross-owner shift attribution (architect-flagged races, Aug 2026).

**Post-publish TODO:** dev DB has no bars; enabling the four prod bars (The Afterlife, The Warthog, N1rvana, Pinche Pollo) needs name-match SQL against prod AFTER the schema columns deploy.
