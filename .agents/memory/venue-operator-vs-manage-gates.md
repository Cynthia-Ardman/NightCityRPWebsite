---
name: Venue operator vs manage authz gates
description: Which venue (store/ripperdoc) actions are operator-level (incl. employees) vs owner/staff-only, and how the frontend infers employee status
---

# Venue operator vs manage gates

Store/ripperdoc venues have TWO distinct backend authz tiers. Conflating them in
the frontend is a recurring bug source (an employee-buys-stock bug came from
gating a buy button on the manage tier).

## The two tiers
- **Operator** (`isVenueOperator` in routes/stores.ts, `isOperator` in
  lib/saleOffers.ts) = owner **OR** admin/fixer **OR** EMPLOYEE (a character the
  user owns is in store_employees/ripperdoc_employees). Governs the money-making
  day-to-day: **BUY STOCK from catalog** (`POST /stores|ripperdocs/:id/purchase`)
  and **SELL** (`/sell`, `/install`, etc.). Employees are deliberately allowed —
  "Owner/employee always pay the catalog price."
- **Manage** (`loadManageableStore`/`loadManageableRipperdoc`) = owner **OR**
  staff only (NO employees). Governs profile edit (`PATCH /:id`), employee
  hiring, wallet deposit/withdraw/grant, delete, and **manual stock add/edit**
  (`POST/PATCH/DELETE /:id/stock`). Gun stores tighten manual stock further to
  **staff-only** (`kind==="guns" && !isStaff` → 403), even for the owner.

**Why:** employees run the shop (buy/sell) but shouldn't reconfigure the
business or hand-edit regulated gun catalog rows.

## Frontend rules (MyStoreDetail.tsx)
- `canBuyStock = isOwner || isStaff || isEmployee` gates the BUY STOCK button —
  NOT `canEditStock` (that's the manage/gun-edit tier). Gating buy on
  canEditStock hid the button from employees AND gun-store owners.
- `canEditStock = (isOwner||isStaff) && (!isGunStore || isStaff)` still gates the
  editable stock rows / manual edits.
- SELL already works for employees via the read-only stock branch's sell button.
- **Inferring employee client-side:** `GET /:id` 403s everyone but
  owner/staff/employee AND strips employee ownerId from the payload, so there is
  no explicit `viewerIsEmployee` flag. Safe inference: a viewer who loaded the
  manage page and is `!isOwner && !isStaff` is necessarily an employee. If the
  read-gate policy ever widens, this inference breaks — prefer adding an explicit
  `viewerIsEmployee` field then.
- MyClinicDetail.tsx does NOT restrict its BUY STOCK button (all operators see
  it), so the store page was the outlier that needed this fix.
