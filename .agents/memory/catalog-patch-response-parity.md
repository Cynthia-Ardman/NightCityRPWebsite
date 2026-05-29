---
name: Catalog PATCH response parity
description: Staff edit endpoints must echo computed fields that the matching GET adds, or the OpenAPI/client contract drifts.
---

When a list/GET endpoint augments raw DB rows with a computed field (e.g. `GET /catalog/rent` adds `occupied` by checking active leases in `housing`), any staff PATCH that returns the same response schema must re-derive and include that field.

**Why:** PATCH /catalog/rent/:id originally returned the raw `catalog_rent` row via `res.json(updated)`, but the response is typed `CatalogRent` which requires `occupied`. Generated TS clients then see a shape that the server doesn't actually send.

**How to apply:** After a catalog update, run the same occupancy/derived lookup the GET does (scoped to the single id) and spread it onto the returned row before `res.json`. Same rule applies to any future computed columns shared between GET and PATCH.
