---
name: Mission approval surface
description: Where mission proposals get approved in the portal and who can reach it
---

Mission proposals (workflowState==='proposal') are approved from the **Misc Requests / Pending Requests** queue, NOT from the Missions "All Missions" board. The Missions board only drives draft→submit and approved→post; a proposal there just shows "Awaiting approval in Pending Requests".

**Why:** fixers submit missions for review like any other request, so approval belongs with the rest of the review queue, not mixed into the staff missions board.

**How to apply:**
- The proposal approval section lives in MiscRequestsTab; it fetches `useListOwnedMissions` (returns all states for managers/approvers, 403s for a pure cs_approver — gate the query on isFixer||isAdmin||isArchivist).
- Approve button (useApproveMission) is gated on isArchivist||isAdmin.
- The Misc tab itself must be reachable by archivists — gate tab trigger/content/default on `canSeeMisc = canMisc || isArchivist`, not the old `canMisc = isAdmin||isFixer`, or archivists lose their only approval surface.
- Creation form: "Save as draft" (create only) vs "Submit for approval" (create then submit). The create-then-submit path must retain the created mission id on submit-failure so a retry resubmits the same row instead of creating a duplicate draft. Submit requires jobType (enforce client-side too).
