---
name: Open-shop access & instant income
description: Who can open shop and how shop owners get paid (instant per-session payout)
---

# Open-shop visibility & instant income

The open-shop "collect" flow originally gated on **business leases** only, so
store/ripperdoc owners who own a *venue* but hold no business lease saw no
button and earned nothing. Access was widened; income was later reworked.

## Access
- `canOpen = leases > 0 || venues > 0`. Venue owners (stores/ripperdocs matched
  by `ownerCharacterId`) can open shop; `open-shop` 403s only when there is
  NEITHER a lease NOR a venue. `listingId` is nullable for venue-only opens.

## Income model — INSTANT, not monthly
Shop income is paid **instantly** the moment an owner opens shop during a live
session (`POST /characters/:id/open-shop`), like the weekly attendance bonus.
Amount is the flat `SHOP_OPEN_PAYOUT` constant in `characters.ts` (currently
150, hardcoded like attendance's `WEEKLY_ATTEND_PAYOUT` — change in code to tune).

**Why:** the old monthly model (a "2a" business pass + a "2b" venue-only pass in
`jobs.ts`) was silently broken — the monthly_rent cron fires on the 1st at
04:00 UTC and counted opens in the CURRENT month, so it saw ~0 opens and paid
nobody, ever (shop_opens had rows but shop_income had zero all-time). User chose
instant-per-open over fixing the monthly off-by-one. Both monthly passes are now
REMOVED (replaced with REMOVED-note comments); only the rent DEBIT remains in the
lease pass.

**How to apply / pitfalls:**
- **Anti-farm guard is mandatory** with instant pay: pay at most once per
  session. The endpoint rejects (409) if any shop_opens row for the char exists
  within the last **8 hours** (the session window is 7h Sun 2–9pm Pacific and
  sessions are a week apart, so an 8h lookback is TZ-math-free and can't bleed
  into a neighbouring session). This also closes the UTC-midnight straddle that
  the `(characterId, openedOn)` per-UTC-day unique index alone would let through.
- **Reserve-before-credit** (mirrors attendance): insert the shop_opens row
  FIRST (the durable "opened this session" marker), then credit UB; on a clean
  UB failure DELETE the shop_opens row so the owner can retry. Two rapid clicks
  collide on the per-day unique index (23505 → 409) so only one reaches payout.
- Record the money via `recordSettledWalletMovement` (kind `shop_income`,
  `source:"website"`, `idempotencyKey: shop-open:<rowId>`, `ubTotalAfter: ub.total`)
  so the website wallet balance advances and reconcile never double-counts.
- `loadOwnedChar` is strictly owner-only (`ownerId === userId`), so `req.user`
  IS the payee — no `getOwner` lookup needed here.
- Instant pay does NOT gate on `isSystemLive("housing")` (attendance doesn't
  either); `patchBalance` already no-ops in dev via the deployment-write gate.
- Prod-history caveat: instant pay is forward-only — June/July opens that
  predate this change were never paid and are not back-paid.

## Income model update — TIERED instant payout (replaces flat 150)
The flat `SHOP_OPEN_PAYOUT` is gone. Each open pays the guidebook's marginal
step for its ordinal within the current UTC calendar month (counted under the
same advisory lock as the session guard): tier-0/micro + venue-only owners use
cumulative table [0,150,250,350,500]; tier-1+ leases pay
`floor(rent * cumulative [0,.25,.4,.6,.8])`. Opens beyond 4/month record but
pay 0 (no ledger row, no rollback path). **Tier classification must come from
`catalog_rent.tier` (via listingId) → `housing.tier` → address regex LAST**:
prod catalog tiers are labeled "Business Tier 1..3" / "T0" and addresses say
nothing about tier, so the old `isShopTierZero(address)` heuristic misclassifies
real leases. Player-facing origin: a Tier-3 owner (rent 4000) reported the flat
150 "did not double" — flat pay contradicted the published tier schedule.
