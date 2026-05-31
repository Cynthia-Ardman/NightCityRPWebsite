---
name: Open-shop access & income for venue owners
description: Why shop owners without a business lease can still open shop and how they get paid
---

# Open-shop visibility & income parity

The open-shop "collect" flow originally gated on **business leases** only, so
store/ripperdoc owners who own a *venue* but hold no business lease saw no
button and earned nothing.

**Decision (kept the existing daily-open → monthly-payout model, NOT a flat
weekly amount):**
- `canOpen = leases > 0 || venues > 0`. Venue owners (stores/ripperdocs matched
  by `ownerCharacterId`) can open shop; `open-shop` 403s only when there is
  NEITHER a lease NOR a venue. `listingId` is nullable for venue-only opens.
- Monthly income has a dedicated **"2b" pass** in `jobs.ts` (after the lease
  loop) paying venue-only owners a Tier-0 flat `SHOP_T0_PAYOUTS[opens]` scaled
  by capped monthly opens.

**Why:** keeps one consistent economy (opens still drive payout) while widening
who participates.

**How to apply / pitfalls:**
- The 2b pass MUST exclude `businessLeaseCharIds` — a character with both a
  lease and a venue is already paid by the lease loop; double-paying is the main
  risk.
- Reuse the lease path's idempotency: preloaded `alreadyBilled` month guard
  (kind `shop_income`), in-run `markBilled/unmarkBilled`, and reserve-before-UB
  rollback. Inherits `monthly_rent` live-mode gating (`isSystemLive("housing")`).
