---
name: Venue manage entrypoint & stock cost default
description: How owners/employees reach venue management, and the purchase-price cost-default rule.
---

# Venue manage entrypoint
The public directory store/clinic detail page (DirectoryStoreDetail) originally
showed the MANAGE button only to `isStaff` (admin||fixer). Owners and employees
have no owner Discord role to key off, and the public payload only returns
`ownerName`/`employeeNames` (strings, no ids), so you cannot tell from it whether
the viewer manages the venue.

**Rule:** derive manage access from `useListMyStores()` — `/stores/mine` already
returns stores the user OWNS or is EMPLOYED at (joins store_employees→characters
by ownerId). `canManage = isStaff || myStores.some(s => s.id === storeId)`.
Server authz is unchanged/authoritative; this only controls button visibility.

**Why:** an employee reported "no manage store button" — nav link works via the
data-derived isStoreEmployee flag, but the storefront page had no entrypoint.

# Stock cost default = purchase price
In `purchaseFromCatalog` (stores.ts), a brand-NEW stock row seeds `cost: unitCost`
(the per-unit price the venue paid) so commission (price − cost) is right without
a manual cost entry. On a RESTOCK merge into an existing row, do NOT touch cost —
`existing.cost || unitCost` is a bug because cost=0 is a valid intentional value
and would get clobbered. Preserve existing cost; the default only applies to new rows.
