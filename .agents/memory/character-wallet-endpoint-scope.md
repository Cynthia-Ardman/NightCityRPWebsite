---
name: Character wallet endpoint scope
description: /characters/:id/wallet/transactions returns account-level rows too; per-character history UI must filter by characterId
---

`GET /characters/:id/wallet/transactions` returns `OR(characterId = id, userId = currentOwner)` — i.e. it deliberately includes **account-level** rows (characterId NULL) belonging to the owner, not just rows attributed to this character. Legacy bot ledger rows are imported at the account level (userId set, characterId NULL); multi-character players' rows stay account-level forever because there's no way to attribute them to one PC.

**Why:** any UI that wants a *per-character* slice (e.g. RENT HISTORY / CYBERWARE PAYMENTS sections on the character page) must additionally filter `t.characterId === characterId`. Filtering by `category` alone leaks the owner's account-level rows onto every one of their characters' tabs.

**How to apply:** when building character-scoped views off this endpoint, always combine the category/kind filter with `t.characterId === characterId`. The full (account-inclusive) result is intended for the character page's general wallet view, not for attributed-history sections.

Related: `wallet_transactions.category` is a coarse display bucket (rent/cyberware/mission/business/membership/fee/purchase/transfer/other) derived from kind+memo via `classifyWalletCategory` in lib/db/src/walletCategory.ts. It is independent of the load-bearing `kind`; APIs fallback-derive it when null so responses never have null category.


## Former index detail (full)
/characters/:id/wallet/transactions also returns account-level (characterId NULL) owner rows (filter t.characterId===id in UI); category (rent/cyberware/…) derived from kind+memo via classifyWalletCategory, fallback-derived when null.
