---
name: Reopen vote handling is per-queue
description: Reopen CLEARS votes for requests + edits but PRESERVES them for sheets; resubmit/edit-while-pending always clear.
---

# Reopen vote handling differs per review queue

REOPEN is NOT uniform across the three review types. Each has finalize-on-read
(`finalize*` + `*InPlace` on queue AND detail reads), which re-tallies any
carried-over votes on the next reviewer read. So whether to clear votes on reopen
depends on whether preserving them would make reopen a visible no-op:

- **requests (`reopenRequest`)** — CLEARS votes (`clearReviewVotes`, subjectType
  `request`, in the reopen txn). Preserving made reopen a no-op:
  `finalizeDecidedRequestsInPlace` re-decided instantly.
- **pending-edits (`reopenEdit`)** — CLEARS votes. Edit votes live in
  `pendingEditApprovals` (editId-keyed), NOT `reviewVotes` — so it does
  `tx.delete(pendingEditApprovals).where(eq(editId, id))`, NOT `clearReviewVotes`
  (whose `ReviewSubjectType` is only `sheet|request|lore`; `"edit"` is a tsc error).
  Frontend REOPEN button in PendingEditDetail.tsx gated `isReviewer &&
  status∈{approved,rejected}` via `useReopenReviewTicket({subjectType:"edit"})`.
- **sheets (`reopenSheet`)** — PRESERVES votes (leave it). Only the "decided"
  markers are wiped; finalize-on-read re-evaluates the preserved votes and
  re-finalizes if still passing.

**Why:** for requests + edits, preserving carried-over approvals snapped a
reopened ticket straight back to its prior decision on the next read — reopen
looked like it did nothing. Clearing makes reopen a genuinely fresh round.

NOTE: `castReviewVote` is TOGGLE, not a plain upsert (see
[Vote toggle](vote-toggle.md)) — re-casting the same value CLEARS it.

**How to apply:** requests + edits clear on reopen (different vote tables);
sheets preserve. Separately, paths where the submitter *changed the content* —
resubmit and edit-while-pending PATCH — ALWAYS clear votes (fresh round from
zero), regardless of queue.
