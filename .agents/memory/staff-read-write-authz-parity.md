---
name: Staff read/write authz parity for character sub-resources
description: When surfacing staff (fixer+admin) direct-management UI on a character sub-resource, the GET read path must allow the same staff scope as the write paths.
---

When you add a staff-only management control on a character-detail tab (cyberware,
property, inventory, etc.), the resource's **read** endpoint must allow the same
fixer+admin scope as its **write** endpoints — otherwise staff see empty/404 data
and the management UI looks broken even though writes would succeed.

**Why:** `GET /characters/:id/housing` was gated "own or admin" (`!isAdmin`) while
`POST /housing/lease` already allowed `isFixerOrAdmin`. Surfacing a StaffLeaseCard
to fixers showed them empty property state. Inventory routes avoided this because
they all funnel through `loadOwnedOrStaffChar` (covers staff).

**How to apply:** Prefer a shared owner-or-staff loader (like `loadOwnedOrStaffChar`)
for every character sub-resource read, or at minimum use `isFixerOrAdmin` (not bare
`isAdmin`) on the GET when the matching write path uses it.
