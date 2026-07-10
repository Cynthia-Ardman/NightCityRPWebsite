---
name: Deploy-time expression index trap
description: Expression indexes whose normalized DDL contains a space-containing literal break the publish migration differ with invalid SQL.
---

# Deploy-time expression index trap

The rule: schema indexes must avoid expressions that Postgres normalizes into
space-containing literals (e.g. `coalesce(col, 'epoch'::timestamptz)` — pg
stores it as `'1970-01-01 00:00:00+00'::timestamptz`). The Replit publish
migration step re-parses the live index DDL and mangles such literals into
invalid SQL (`'1970-01-01 00:00:00+00'::timesta timestamptz_ops` — "syntax
error at or near timestamptz_ops"), hard-blocking every production deploy with
"Migrations failed validation".

**Why:** June/July 2026 publish was blocked by `event_npc_signups_active_idx`
(coalesce-sentinel uniqueness over nullable occurrence_start_at). Simple casts
of space-free literals (`'signed_up'::text`) are fine — only literals
containing spaces break the differ.

**How to apply:** for "unique including NULL as a value" semantics, use TWO
plain partial unique indexes instead of one coalesce expression index: one on
(..., nullable_col) WHERE col IS NOT NULL, one on (...) WHERE col IS NULL —
both sharing the state predicate. `onConflictDoNothing()` without a target
still works across both. Push to dev with `pnpm --filter @workspace/db run
push-force` (plain push prompts for a TTY).
