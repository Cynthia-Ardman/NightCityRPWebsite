---
name: Reopen vote handling
description: Reopen CLEARS votes for ALL three review types (requests, edits, sheets); resubmit/edit-while-pending always clear too.
---

# Reopen clears votes across every review queue

REOPEN clears the prior round's votes for ALL three review types. Each has
finalize-on-read (`finalize*` + `*InPlace` on queue AND detail reads), which
re-tallies any carried-over votes on the next reviewer read — so preserving votes
on reopen makes reopen a visible no-op (the next read snaps it straight back to
its prior decision). That's why every queue must clear:

- **requests (`reopenRequest`)** — CLEARS votes (`clearReviewVotes`, subjectType
  `request`, in the reopen txn). Preserving made reopen a no-op:
  `finalizeDecidedRequestsInPlace` re-decided instantly.
- **pending-edits (`reopenEdit`)** — CLEARS votes. Edit votes live in
  `pendingEditApprovals` (editId-keyed), NOT `reviewVotes` — so it does
  `tx.delete(pendingEditApprovals).where(eq(editId, id))`, NOT `clearReviewVotes`
  (whose `ReviewSubjectType` is only `sheet|request|lore`; `"edit"` is a tsc error).
  Frontend REOPEN button in PendingEditDetail.tsx gated `isReviewer &&
  status∈{approved,rejected}` via `useReopenReviewTicket({subjectType:"edit"})`.
- **sheets (`reopenSheet`)** — CLEARS votes (`clearReviewVotes`, subjectType
  `sheet`, in the reopen txn), same as requests. It previously PRESERVED them,
  but that was the exact bug: finalize-on-read (`finalizeDecidedSheet` on
  `/sheets/:id` + `/sheets/pending`) re-tallied the carried-over approvals on the
  next reviewer read and snapped the sheet straight back to approved, so reopen
  appeared to do nothing.

**Why:** finalize-on-read re-decides a reopened ticket from any carried-over
approvals on the next read, so preserving votes makes reopen a visible no-op.
Clearing makes reopen a genuinely fresh round for every queue.

NOTE: `castReviewVote` is TOGGLE, not a plain upsert (see
[Vote toggle](vote-toggle.md)) — re-casting the same value CLEARS it.

**How to apply:** all three queues clear on reopen — requests + sheets via
`clearReviewVotes` (review_votes); edits via
`tx.delete(pendingEditApprovals).where(eq(editId, id))` (edit votes live in
`pendingEditApprovals`, editId-keyed; `clearReviewVotes`'s `ReviewSubjectType`
is only `sheet|request|lore`, `"edit"` is a tsc error). Separately, paths where
the submitter *changed the content* — resubmit and edit-while-pending PATCH —
ALWAYS clear votes too (fresh round from zero), regardless of queue.
