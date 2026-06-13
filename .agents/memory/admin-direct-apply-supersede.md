---
name: Direct-apply write paths must supersede in-flight pending edits
description: Any character write path that applies a full diff directly (bypassing review) must cancel in-flight pending edits, or a later approve+close clobbers it. The old admin fast-path that triggered this rule has been removed.
---

# Direct-apply write paths must supersede in-flight pending edits

**Current state:** `createPendingEdit` no longer has an admin/staff instant-apply
fast-path. EVERY non-cosmetic character edit now goes through the pending-edits
review queue regardless of role. Only cosmetic-only diffs (portrait, background,
archetype, sheetData preamble) auto-apply, and those fields do not overlap with
the non-cosmetic fields carried in a queued `proposed_diff`, so the cosmetic
auto-apply path does NOT need to supersede in-flight edits.

**Durable rule (still applies to any FUTURE bypass path):** if you ever add a
write path that applies a full character diff directly to the live row while
review-queued edits can exist for the same character, it MUST also mark any
in-flight pending edit (`pending` + `changes_requested`) as `cancelled` in the
same transaction as the apply.

**Why:** `closeEdit` re-applies a row's `proposed_diff` when its status is
`approved`. An older queued edit can still be voted approved and closed AFTER a
newer direct change was applied — re-applying its stale diff over the newer edit
on overlapping fields. Cancel (NOT approve) the queued row so `closeEdit` only
archives it and never re-runs the stale diff.

**How to apply:** PATCH /characters uses `loadOwnedOrStaffChar` so staff can edit
any character — they just go through review like everyone else now. The
supersede-on-cancel pattern is the guard to reach for the moment any new
instant-apply write path is reintroduced.
