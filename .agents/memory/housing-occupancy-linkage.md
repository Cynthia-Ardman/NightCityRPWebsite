---
name: Housing occupancy linkage
description: How the Property Catalog decides a listing is occupied, and the legacy-lease NULL listing_id trap.
---

The Property Catalog page (`CatalogRent.tsx` via GET `/catalog/rent`) marks a
listing OCCUPIED (and shows the occupant to staff / "Not available" to players)
ONLY when a `housing` row references it via `housing.listing_id = catalog_rent.id`.

**The trap:** leases that originated outside the rent importer (e.g. the live
site's own lease flow, or an early import) store the listing's name in
`housing.address` but leave `housing.listing_id` NULL. Those leases are real but
invisible to the catalog — every listing shows as available.

**Why:** occupancy is keyed on `listing_id`, not on `address`. `address` is just
display text written at lease time; nothing keeps it in sync with `catalog_rent`.

**How to apply:** when "everyone shows as available" but leases exist, backfill
`housing.listing_id` by matching `lower(housing.address) = lower(catalog_rent.name)`
(names are unique within a district in this dataset). It's additive — only fill
where `listing_id IS NULL`. `housing.kind` (residential/business) is usually
already correct on these rows. No redeploy needed; the live api-server reads the
data live. Remember prod = `LIVE_PROD_DATABASE_URL` (Neon), not `PROD_DATABASE_URL`.
