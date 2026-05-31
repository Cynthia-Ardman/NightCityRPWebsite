---
name: Rent importer stale catalog listings
description: Re-running import-rent-leases reconciles LEASES but never deletes old catalog_rent rows, so a naming-scheme change leaves orphan duplicate listings.
---

`scripts/src/import-rent-leases.ts` upserts `catalog_rent` and reconciles
`housing` (leases) — it deletes vacated/tenant-changed leases. It does NOT delete
`catalog_rent` rows. So when the listing-naming logic changes (e.g. the "Apt"
room value is now stripped, turning "Back Roof Apartment #Apt" into
"Back Roof Apartment"), a re-run CREATES the new-named listing and leaves the
old-named one behind as an orphan with 0 leases.

**Why it matters:** orphan listings show up on the Property Catalog as extra
*available* units — the page looks "wrong" even though leases are correct. Symptom
to watch: a DB ends up with MORE `catalog_rent` rows than the spreadsheet defines
(e.g. prod 48 vs sheet 45) while a freshly-imported DB matches exactly.

**How to apply:** after a re-import, compare `catalog_rent` count to the sheet /
to a clean dev DB. Prune orphans by name diff, deleting only rows with no housing
referencing them: `delete ... where id in (...) and not exists (select 1 from
housing h where h.listing_id = catalog_rent.id)`. The "Apt"-suffixed Tier-3 rows
("Apartment #Apt", "Back Roof Apartment #Apt", "Block 05 Apartment #Apt") are the
known legacy-naming offenders.
