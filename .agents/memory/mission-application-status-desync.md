---
name: Mission application status desync
description: Why "My Applications" status must be derived from roster membership, not trusted from mission_applications.status
---

A player's mission application status (`mission_applications.status`) is NOT the
single source of truth for whether they're on a mission. There are two ways to
land on a roster:

1. Fixer "accepts" the application (`reviewApplication`) — this flips the
   application row to `accepted`.
2. Fixer adds the character via the **roster editor** (PATCH `/missions/:id`
   `assignments`) — this creates a `mission_assignments` row + a pending
   `mission_participation` custom_request, but **never touches the application
   row**. The player approving participation, and even being paid, also never
   flips it. So the application sits on `pending` forever.

**Rule:** Treat roster membership (`mission_assignments`) as authoritative for
"accepted". `listMyApplications` derives `accepted` at read time when a matching
assignment exists for `(missionId, characterId)` — only upgrading `pending`,
never rejected/withdrawn. This self-heals legacy rows with no migration.

**Why:** matches the codebase's "roster/participation status is DERIVED" pattern
(see roster-participation-status.md); the application table simply wasn't kept in
lockstep across all accept paths.

**How to apply:** any new "is this player on the mission" surface must consult
assignments, not the raw application status. The canonical write in
`participation-decision` accept (flip pending application → accepted) must be
gated on a live assignment still existing, or a stale request (assignment
removed before the player responds) would falsely canonicalize accepted.
`mission_applications` is unique on `(missionId, characterId)`, NOT
`(missionId, userId)`.
