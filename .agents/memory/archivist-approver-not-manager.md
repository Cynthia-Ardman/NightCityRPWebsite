---
name: Archivist approver ≠ manager
description: ARCHIVIST role can approve missions but is NOT a manager; visibility/UI gating must keep these capabilities separate.
---

In the missions workflow, ARCHIVIST is an **approver**, not a **manager**.

- `isManager` (admin OR fixer) gates fixer tools: create, edit (PATCH), pay players/actors, review/accept applications, submit, and post.
- `canApprove` / `isArchivist` (admin OR archivist) gates ONLY the approve transition.

**Why:** archivists review proposals but should not run missions or move money. Granting them `isManager` would expose pay/edit endpoints they must not call.

**How to apply:**
- Visibility must be broadened separately from management: archivists need to *see* non-posted missions (detail returns null/404 otherwise) and need the owned board to *find* proposals — but `canManage` stays `isManager`-only. So `getMissionDetail` and `listOwnedMissionSummaries` explicitly include `isArchivist`, while `canManage` does not.
- Any workflow-action UI (WorkflowPanel in MissionDetail, WorkflowActions in the owned board) MUST gate **submit/post on `canManage`** and **approve on `canApprove`** independently. Gating a button only on workflow state (not capability) shows archivists submit/post buttons that 403 server-side. This was a code-review catch.
- Frontend `canSeeOwnedBoard = isStaff || canApprove`, but the Create button / test-mode banner stay `isStaff`-only (approvers don't create).
