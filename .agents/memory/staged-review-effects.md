---
name: Staged review effects deferred to close
description: How the NCRP review ticket lifecycle stages approval and defers side effects to close-time.
---

# Staged review effects deferred to close

The review ticket lifecycle is STAGED. Approval/denial is a decision; a reviewer's
"Close ticket" commits effects and archives.

- Lifecycle: pending/changes_requested (Active) → approved/rejected/cancelled
  (Resolved) → closed (Archive).
- Reopen: approved|rejected → pending (votes deleted, decision metadata cleared).
  Closed/cancelled cannot reopen.
- Close: approved|rejected|cancelled → closed; applies the deferred effect ONLY if
  the ticket was approved. Idempotent (status==="closed" no-ops under FOR UPDATE).

Effects DEFERRED to close-time for three queues: custom requests, character edits,
character sheets. vote/override only set status=approved and persist the mechanical
params (custom_requests.decisionParams jsonb), WITHOUT materializing.

- requests.ts: closeRequest reads decisionParams (legacy fallback details.approval)
  then materializes lease/inventory/venue under a row lock.
- pending-edits.ts: closeEdit applies the diff atomically.
- sheets.ts: closeSheet materializes the character on approved.

**Out of scope (keep immediate behavior):** lore, and owner/player-decided flows
stock_cost and employee_invite — these still apply at decision time.

**Why:** lets reviewers stage a verdict and let a fixer do a final review + commit,
and prevents double-applying already-applied legacy rows (backfill terminal
approved/rejected/cancelled rows → closed before deploying, dev + prod).

**How to apply:** any new request type added to a staged queue must defer its effect
to the close handler and stash its params in decisionParams, not materialize in
vote/override. Schema: closedAt/closedBy on all three tables; decisionParams on
custom_requests.
