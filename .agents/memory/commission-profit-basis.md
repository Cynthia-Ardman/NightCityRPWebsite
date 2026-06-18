---
name: Commission from profit, not gross
description: Employee commission is a % of (sale total − snapshotted cost basis), via a single helper, with cost-basis frozen at offer creation.
---

Employee commission on store/ripperdoc stock sales comes out of PROFIT, not the full sale price: `commission = floor(max(0, totalPrice − (costBasis ?? 0)) * pct / 100)`.

- The shop recovers its acquisition cost first; commission is a percent of what's left. Profit floored at 0 → no negative/clawback commission when an item sells at or below cost.
- `storeStock.cost` / `ripperdocStock.cost` are per-unit (int, notNull default 0). `saleOffers.costBasis` (int, nullable) is the TOTAL cost snapshot = `max(0, item.cost) * qty`, frozen at `createOffer` time so later stock-cost edits never retro-change a pending offer's commission.
- **Why snapshot:** owners can edit `cost` after an offer is pending; without the snapshot, approving later would compute commission off the new cost.
- One helper `computeCommissionAmount(offer)` is the single source of truth — used by BOTH the test-mode dry-run preview and live `settleCommission`. Any new commission surface must call it, never re-derive off `totalPrice`.
- Service-fee offer types (`remove`, `install_owned`, `stock_add`) intentionally leave `costBasis` null → commission applies to the full fee (no inventory-cost concept). This null = full-fee behavior is by design, not a bug.
