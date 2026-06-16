---
name: Draft mission hard-delete
description: Only drafts are hard-deletable; everything else is cancelled
---
**Rule:** missions can be hard-deleted ONLY while workflowState='draft'. Anything further in the lifecycle must be cancelled (status='cancelled'), never row-deleted.

**Why:** posted/approved/completed missions carry history, payouts, and a Discord event that must survive; deleting the row would strand/erase them. Authz: owning trial fixer OR any manager (mirror submitMissionProposal's owner gate).

**How to apply:** lock the row FOR UPDATE and re-check the draft gate inside the same transaction (a concurrent submit can advance draft→proposal between read and delete). Mission-child FKs (assignments, applications, npc signups, payments) are onDelete cascade, so the row delete cleans them up. Route is owner-gated via canAuthorMissions; returns 204.
