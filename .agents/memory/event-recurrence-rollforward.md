---
name: Event recurrence roll-forward
description: Why a recurring event's current-week occurrence can vanish from the calendar, and the open-ended-only backfill rule in expandOccurrences.
---

Discord rolls a recurring scheduled event's `scheduled_start_time` forward to the
*next* occurrence once the current one starts. The events reconcile copies that
forward value into `events.start_at`, so the stored base is the NEXT occurrence,
not the series origin.

The calendar expands recurrence client-side (`expandOccurrences` in
`artifacts/ncrp-portal/src/lib/eventRecurrence.ts`). It originally emitted only
occurrences at/after `baseStart`, so an earlier-but-still-visible occurrence (this
week's, which already began earlier today) silently disappeared after the
roll-forward.

**Rule:** for OPEN-ENDED series only (no `count` and no `until`), walk backward
from `baseStart` to cover `rangeStart` and emit pre-baseStart occurrences that
fall inside the visible window. BOUNDED series (explicit count/until) must keep
strict forward-only semantics — there `baseStart` is the authoritative series
origin, so emitting earlier would invent occurrences and break the count budget.

**Why:** Discord's open-ended weekly socials are the common case; their base keeps
advancing, so display correctness depends on backfilling the window. Bounded
series never get rolled forward the same way.

**How to apply:** keep backward generation gated on `openEnded` and clamp backward
steps to MAX_ITER so the iteration ceiling stays hard. Returned dates must remain
chronologically sorted (iterate ascending week then ascending day-offset).
