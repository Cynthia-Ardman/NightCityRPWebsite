---
name: Offer approve debit-before-flip refund
description: Money-safety rules for the buyer-approval sale-offer approve path (saleOffers.ts approveOffer)
---

approveOffer charges the buyer (applyWalletDelta, idem `offer:<id>:buyer`) BEFORE the
guarded `pending -> approved` flip inside the completion transaction. That ordering creates
two failure modes that must each refund or money is lost:

1. **Flip fails (0 rows) = offer no longer pending.** Do NOT blanket-return "duplicate".
   Re-read the row: if final status is `approved`, a concurrent approve completed the sale
   and shares the same buyer idempotency key (no double-charge) → return duplicate success.
   Otherwise (`denied`/`expired`) the buyer was charged for a sale that won't happen →
   refund (idem `offer:<id>:buyer-refund`, allowNegative).
2. **Stock-guard miss** rolls the tx back → refund the buyer (same refund key).

**Why:** before the fix, a deny landing between the debit and the flip left the buyer
charged with no refund; and both refund paths ignored the refund result, so a failed
refund still told the user "buyer was refunded".

**How to apply:** any refund via applyWalletDelta must check `.ok`; on failure, log a loud
`OFFER_REFUND_FAILED` (manual reconciliation) and return an error that does NOT claim a
refund happened. Same principle for store-funded purchase: wrap venue debit + stock + ledger
in one db.transaction so a crash can't leave money gone without stock (purchaseFromCatalog).

## Two-system money move = reserve phase + ledger-derived paid-state + endpoint retry
Invariant for any payout that pairs a local DB debit/credit with an external wallet call
(e.g. commission to a venue employee): never credit the external side before reserving the
local side, or a tx/crash mints money. Structure it as two durable phases:
1. **Reserve** (atomic, guarded once via a nullable `*_at` timestamp): move the funding-side
   balance + write the ledger row. The guard makes re-runs a no-op (no double debit).
2. **Pay**: external credit with a stable idempotency key.

**Derive "paid?" from durable ledger state** (a `synced` wallet_transactions row for that
idempotency key), NOT from the reserve timestamp — the two can legitimately diverge in the
crash window between reserve-commit and credit.

**Hold, don't reverse, on credit failure:** leave the reservation in place (money conserved:
funder debited, payee unpaid) so it stays retryable. Make the action endpoint re-entrant: a
repeat call on an already-finalized entity re-runs ONLY the idempotent credit (reserve guard
blocks a second debit; applyWalletDelta reuses the prior `failed` row — only ambiguous
`pending` rows block a retry). This gives deterministic crash recovery with no background
worker. **Why:** reversing on failure loses the "owed" marker; a hard 409 on the finalized
state makes the reserved-but-unpaid window unrecoverable.


## Former index detail (full)
buyer debit precedes the guarded pending→approved flip; if flip fails, refund unless final status is 'approved', and never claim "refunded" without checking applyWalletDelta.ok.
