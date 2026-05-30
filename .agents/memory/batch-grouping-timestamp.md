---
name: Batch grouping by timestamp
description: Why grouping multi-row "batch" inserts on createdAt fragments them, and what to group on instead.
---

When a single logical "batch" is written as N separate INSERT statements (not one
multi-row insert, not one transaction), do NOT group those rows back into one batch
by a column default like `created_at`/`now()`.

**Why:** Each autocommit statement is its own transaction, so Postgres `now()` (and
any `defaultNow()` column) evaluates per-statement and the timestamps differ by
microseconds-to-milliseconds. Grouping on that splits one batch into N single-row
"events". This bit the standalone actor-payout history (`getStandaloneActorPayouts`)
where each actor row is inserted in its own statement.

**How to apply:** Compute one `const now = new Date()` in JS before the loop and write
the SAME value into a stable column on every row (e.g. `attendanceCreditedAt`), then
group on that JS-stamped column — never on the per-statement `createdAt` default. A
dedicated batch UUID is even more robust but needs a schema change; reuse an existing
stable per-batch timestamp when one already exists.
