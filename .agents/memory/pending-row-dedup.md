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
