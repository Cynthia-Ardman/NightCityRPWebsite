---
name: Pending-row dedup via partial unique index
description: How to make "at most one pending row per key" idempotent across concurrent runs.
---

For queues where re-running an importer/generator must not create duplicate *pending* rows (but a key may legitimately reappear after the prior row is resolved), an in-memory "already-seen keys" Set is NOT enough — two concurrent runs both read empty and both insert.

**Rule:** add a PARTIAL unique index on the dedup key filtered to the live status, e.g.
`uniqueIndex(...).on(t.groupKey).where(sql\`status = 'pending'\`)`, and insert with
`.onConflictDoNothing({ target: t.groupKey, where: eq(t.status, "pending") })`.
A losing racer's insert returns `[]` (count it as a duplicate); excluded statuses (approved/discarded) let the key be re-imported later.

**Why:** the indexed-but-not-unique column + check-then-insert is a classic TOCTOU race the architect flags as a data-integrity failure.

**How to apply:** any "review queue" table populated by an admin-triggered scan (e.g. lore import drafts in `artifacts/api-server/src/lib/loreImport.ts`).

**No-migration variant:** when the task forbids a DB migration (so you can't add the partial unique index), serialize the check-then-insert with a transaction-scoped Postgres advisory lock keyed on the dedup identity instead: `await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtext(${keyString}))\`)` at the top of the tx, then the existing read-check + insert. Concurrent racers block on the lock and the second one sees the first's row. Used for employee_invite dedup (kind+venueId+characterId) in `artifacts/api-server/src/routes/stores.ts`.
