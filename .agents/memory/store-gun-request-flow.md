---
name: Store-initiated custom gun requests
description: How type='gun' custom requests fork on details.storeId — store stock materialization, auto sale offer, and the widened access surfaces.
---

Gun custom requests have TWO materialize paths, forked on `details.storeId`:
- No storeId (legacy player path): gun lands in the request character's `inventory_items`.
- storeId present (store-initiated via POST /stores/:id/gun-requests): gun lands in that store's `store_stock` (appliedRef `store_stock:<id>`); if `details.buyerCharacterId` + `details.salePrice` are set, a PENDING `sale_offers` row is inserted in the same tx (buyer approves & pays via the normal offer pipeline — never auto-complete).

**Why:** gun-store catalogs are regulated (owners can't manually edit stock), so the fixer-approved request queue is the only operator path to new weapons; store attribution keeps the buyer charged only after their explicit Inbox approval.

**How to apply:** anything touching this flow must keep ALL widened surfaces in sync:
- Request `characterId` = buyer when named (buyer visibility on My Submissions) else owner char.
- `GET /requests/mine` includes gun+storeId rows whose characterId the viewer owns.
- review.ts resolveSubject returns `extraUserIds` (buyer owner + store owner + employee owners) for thread access.
- `closeRequest` merges `details.specs` UNDER closer-supplied params as defaults.
- Buyer bell+DM notification fires post-commit only (notifyBuyer payload from materializeRequest).
