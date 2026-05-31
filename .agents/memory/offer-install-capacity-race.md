---
name: Offer install capacity race
description: CWP cap enforcement on buyer-approval install offers must be locked + re-derived inside the completion tx, and the operator CWP value must not undercut the stock note.
---

Buyer-approval cyberware install offers (saleOffers.approveOffer) enforce the PC
15-CWP cap. A pre-transaction capacity check is NOT sufficient: two concurrent
approvals against the same near-cap PC can both read the same `used` and both
commit, blowing past 15.

**Rule:** inside the completion `db.transaction`, after flipping the offer to
approved, `SELECT ... FROM characters WHERE id=buyer FOR UPDATE` to serialize
concurrent approvals, then recompute used CWP from inventory_items inside the tx
and re-check the cap. Throw to roll back on overflow — the pre-tx buyer debit is
compensated by the existing refund-on-completionError path.

**Why:** the cap is a mutable read-only gate (like mission completedAt); a
top-level check-then-act read is racy. Same family as completion-lock payout race.

**How to apply:** any new offer action that consumes a capped resource must take
the row lock + re-derive inside the tx, not just at the top.

Also: `resolveInstallCwp` must NOT let an operator-supplied `cwp` go *below* a
"CWP n" tag already on the stock notes (use `max(noteCwp, opCwp)` when catalog is
non-authoritative), or a crafted low override dodges the cap.

**Installed = chrome + CWP note:** "installed cyberware" is `category='cyberware'`
AND a parseable "CWP n" install tag. Ripperdoc sell/give land the item in
inventory uninstalled (category cyberware, NO note), so they must NOT appear in
the capacity installed-list nor be removable. Both the GET cyberware status
endpoint and createRemoveOffer enforce this. Untagged chrome contributes 0 CWP
either way, so cap math is unaffected; the note is purely the installed marker.
