---
name: Rent importer stale catalog listings
description: import-rent-leases reconciles leases but never deletes catalog_rent rows, so a naming-scheme change leaves orphan duplicate listings.
---

The rent importer reconciles `housing` (leases) but only **upserts** `catalog_rent`
— it never deletes listing rows. So when the listing-naming logic changes, a re-run
creates the new-named listing and leaves the old-named one behind as an orphan with
zero leases.

**Why it matters:** orphan listings appear on the Property Catalog as extra
*available* units, so the page looks wrong even though every lease is correct.

**How to apply:** after a re-import, compare the `catalog_rent` row count against
the spreadsheet (or a freshly-imported clean DB); a higher count means orphans.
Prune by name diff, deleting only rows that no `housing` row references. The
legacy `Apt`-suffixed Tier-3 rows are the known offenders.
