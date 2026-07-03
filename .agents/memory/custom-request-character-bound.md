---
name: custom_requests is character-bound
description: Why non-character proposal types (new mission / new cyberware catalog) can't drop into the existing custom_requests review flow without a migration.
---

# custom_requests is character-bound

`custom_requests.characterId` is **NOT NULL**, and the entire create → vote → close →
staged-effects → materialize pipeline (and reviewer authz, MyRequests, PendingRequests)
assumes every request hangs off a real character.

**Why it matters:** A request to "approve a brand-new mission" or "approve a new
cyberware catalog entry" has *no owning character*. Wiring those into the existing
multi-vote `custom_requests` flow therefore requires (a) making `characterId` nullable
(schema migration on a hot table) AND (b) auditing every character-bound branch of the
heavily-tested review pipeline for null safety. This is a large, risky change — not a
drop-in new enum value.

**How to apply:** If asked to route non-character proposals through "Misc Requests",
treat it as its own scoped task with migration + pipeline refactor + tests. Do NOT ship
a half-migration. Alternative: missions already have their own
submit→approve→post proposal flow (submitMissionProposal/approveMission/postMission) —
prefer extending that over forcing missions into custom_requests.

Contrast: `mission_participation` DID fit as a new enum value because it *does* have an
owning character (the assigned PC), so it reuses the owner-decided path like
`employee_invite`.


## Former index detail (full)
characterId is NOT NULL; non-character proposals (new mission/cyberware catalog) need a migration, don't drop into the vote flow; participation fits because it has an owning PC.
