---
name: Sheet-importer reconciliation
description: When a spreadsheet is the source of truth for a relational table, the importer must reconcile removals (vacancies, tenant changes), not just upsert.
---

When importing a spreadsheet that is the **source of truth** for an ownership / occupancy table (e.g. housing leases, role assignments, store ownership), a pure upsert is not enough. The importer must also actively reconcile:

1. **Vacancy** — if a source row is now marked "Vacant" / blank, delete all existing rows for that source key. Otherwise old leases linger forever after a tenant moves out.
2. **Tenant change** — before inserting/updating a row keyed by `(sourceKey, ownerKey)`, delete any existing rows for that `sourceKey` whose `ownerKey` differs from the new one. The natural unique key for upsert is `sourceKey` (e.g. listingId) — not the composite — because the *source* row is what's authoritative.

**Why:** the first import of `import-rent-leases.ts` upserted by `(listingId, characterId)` only. A rerun after a tenant changed in the sheet silently kept the *old* lease and created a *second* lease for the same unit, double-billing on the next rent cron.

**How to apply:** any new "import from sheet → into ownership table" script needs a `// reconciliation` block running before the upsert. Forward-fill cells (tier, building, business name) only across rows that genuinely inherit them — never forward-fill row-local fields like operating cost.

**Matching rules for owner→character (or owner→entity):** prefer exact normalized-name match; fall back to single-active-record only when unambiguous. Never substring-match on short names ("Adam", "Mist") — it false-links siblings and reused names. Report skipped rows distinctly as "no user" vs "no character" so admins know whether to claim or to assign.
