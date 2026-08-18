---
name: player_sell offers
description: Players selling inventory items TO a venue via the sale_offers machinery — authz and money-flow rules.
---

`player_sell` reverses the usual offer direction: the venue BUYS from a player.
Reuses `sale_offers` (no migration): `installItemId` = seller's inventory row,
`sellerCharacterId` = selling char, `buyerUserId` = venue owner AT CREATION,
`createdById` = selling player.

Rules that must hold on every future change:
- **Approve gates on the venue's CURRENT owner**, never the `buyerUserId`
  snapshot (venue can change hands while pending). `canDecide` is async for
  this reason; the seller (`createdById`) may withdraw/deny only.
  Admins can deny but never approve (they'd spend someone else's venue money).
- **Approve tx re-validates under lock**: inventory row FOR UPDATE (still owned
  by `sellerCharacterId`, qty, not installed = no "CWP n" note tag) AND the
  selling character's `ownerId` still equals `createdById` (char transfers
  must not pay the former owner).
- Money: guarded venue debit (gte) + venue ledger inside the tx; seller wallet
  credit AFTER the tx via `applyWalletDelta` keyed `offer:<id>:player-sell-credit`;
  re-approve of an approved offer retries an unpaid credit (idempotent).
- Portal: venue P&L must treat `player_sell` (like `stock_add`) as an EXPENSE
  and swap buyer/seller labels; `offerNeedsMyDecision` includes it (owner Inbox).

**Why:** review round found former-owner-approve and char-transfer payout holes;
both are real money-extraction paths.
