---
name: Mission roster stale-edit clobber
description: Mission edit PATCH whole-replaces the roster; stale form snapshots wiped accepted players (The Night Watch incident) and how the fix works.
---

Mission PATCH's `assignments` field is a whole-replace (`applyAssignments`): unpaid roster rows not in the sent set are DELETED. The fixer edit form used to always resend its snapshot, so accepting applications while an edit form sat open got wiped on save (Night Watch: 6 accepted → 1 roster row).

**Why:** classic lost-update — the applications panel and the edit form both mutate the roster; the form's snapshot is stale the moment an accept lands.

**How to apply:**
- Edit form omits `assignments` from the PATCH payload when the roster list is unchanged from the form's initial snapshot (order-insensitive `rosterSig`). Any new roster-mutating surface must do the same or use targeted add/remove endpoints.
- `applyAssignments` flips dropped users' `accepted` applications → `withdrawn` in a transaction (mirrors remove-from-roster), so "accepted but off-roster" can never linger silently.
- Repair path for ghosts: application views expose `onRoster`; MissionDetail shows RESTORE TO ROSTER for `accepted && !onRoster` (accept is idempotent — re-running recreates the assignment).
- Residual known tradeoff: an intentional roster edit concurrent with accepts still whole-replaces (visible now via withdrawn flip).
