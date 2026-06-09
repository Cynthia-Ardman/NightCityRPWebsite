---
name: Admin direct-apply supersedes pending edits
description: When an admin edit bypasses the character-edit review queue and applies directly, it must cancel in-flight pending edits or a later approve+close clobbers it.
---

# Admin direct-apply must supersede in-flight pending edits

`createPendingEdit` has an ADMIN fast-path that applies the full diff immediately
(no review queue) and a separate review path for everyone else. When the admin
path applies directly, it MUST also mark any in-flight pending edit for the same
character as `cancelled` (statuses `pending` + `changes_requested`), inside the
same transaction as the `applyDiff`.

**Why:** `closeEdit` re-applies a row's `proposed_diff` when its status is
`approved`. An older queued edit for the same character can still be voted
approved and closed AFTER the admin already applied a newer change — re-applying
its now-stale diff over the admin's edit on overlapping fields. Marking the
queued row `cancelled` (NOT `approved`) means `closeEdit` only archives it and
never re-applies the stale diff.

**How to apply:** Any new bypass/instant-apply write path on characters (or a
similar review-queued resource) that writes directly to the live row must also
resolve/supersede competing in-flight queued edits in the same transaction.
Cancel, don't approve — approve would re-run the diff on close.
