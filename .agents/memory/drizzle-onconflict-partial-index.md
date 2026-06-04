---
name: Drizzle onConflictDoNothing partial-index predicate
description: onConflictDoNothing uses `where` (not `targetWhere`) for a partial unique index; wrong key drops the predicate and 500s with 42P10.
---

For an upsert/idempotent insert targeting a **partial** unique index (one with a
`WHERE` clause, e.g. `UNIQUE (discord_event_id) WHERE discord_event_id IS NOT NULL`),
the `ON CONFLICT` must repeat that index predicate or Postgres can't match it and
throws `42P10 "there is no unique or exclusion constraint matching the ON CONFLICT
specification"`.

In drizzle the option name differs by method:
- `onConflictDoNothing({ target, where })` — `where` IS the index predicate.
- `onConflictDoUpdate({ target, targetWhere, set, setWhere })` — `targetWhere` is the
  index predicate; `setWhere` is the DO UPDATE filter.

**Trap:** passing `targetWhere` to `onConflictDoNothing` type-checks but is **silently
ignored** — drizzle emits a bare `ON CONFLICT (col) DO NOTHING` with no predicate, which
fails against a partial index.

**Why:** the equivalent hand-written psql `ON CONFLICT (col) WHERE col IS NOT NULL DO
NOTHING` works fine, so the bug masquerades as "works in psql, 500s via the app" and is
easy to misdiagnose as a data/encoding issue.

**How to apply:** any `onConflictDoNothing` against a partial unique index must use
`where:`. To get the real cause behind drizzle's "Failed query: ..." wrapper, read
`err.cause.code` / `err.cause.message` (the wrapper message omits the underlying PG error).
