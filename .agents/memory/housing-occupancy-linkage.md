---
name: Housing occupancy linkage
description: How the Property Catalog decides a listing is occupied, and the legacy-lease NULL listing_id trap.
---

A Property Catalog listing is shown OCCUPIED **only** when a `housing` row points
at it via `housing.listing_id` — occupancy is keyed on the foreign key, never on
`housing.address`. `address` is display text captured at lease time and is not kept
in sync with `catalog_rent`.

**The trap:** leases created outside the rent importer can carry the listing's
*name* in `housing.address` while leaving `listing_id` NULL. Such leases are real
but invisible to the catalog, so every unit looks available.

**Why:** keying on `listing_id` (not name) is what makes occupancy reliable, but
nothing backfills `listing_id` for externally-created leases.

**How to apply:** when "everything shows available" but leases exist, backfill the
missing `listing_id` by matching the address to the listing name (additive — only
where it is NULL). Prefer re-running the source-of-truth importer when a fresh
spreadsheet exists. Remember prod = the live Neon DB, not the legacy bot DB.


## Former index detail (full)
catalog OCCUPIED via housing.listing_id; legacy leases store name in housing.address w/ NULL listing_id (backfill by name); import-rent-leases never deletes catalog_rent rows so renames orphan listings, prune by count diff ([stale](rent-importer-stale-listings.md)).
