---
name: Pending character edits — snapshot the before-state at submit
description: Any review-queue / approval flow must persist the original values of the changed fields at submission time, not read-through them at view time.
---

When you build a review/approval queue on top of a mutable row (character,
sheet, store, ...), persist the prior value of every field referenced in
proposedDiff at submit time (e.g. `before_snapshot jsonb`). Do NOT show
the reviewer a "BEFORE" column computed from the live row.

**Why:** Between submission and decision, other paths (admin scripts,
auto-billing jobs, other approved edits) can mutate the same row. A
read-through BEFORE column then drifts, and a reviewer can approve an
"approve all" that actually overwrites changes they never saw.

**How to apply:** In the queue table, store `before_snapshot jsonb` next
to `proposed_diff jsonb`. Populate it in the createPending helper from
the current row at the moment of insert, keyed only on the fields
present in the diff. Render the diff view straight from those two
columns; never re-read the live source row for "before".
