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
