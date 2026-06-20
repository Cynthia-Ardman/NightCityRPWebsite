---
name: Mission thread lifecycle updates
description: How follow-up posts into a mission's Discord discussion thread are wired and gated.
---

Missions start a per-mission Discord discussion thread off the fixer job-proposal
brief (announceMissionThread in routes/missions.ts; thread id stored in
missions.discordThreadId only when startThreadFromMessage succeeds). Follow-up
lifecycle posts go into that thread via postMissionThreadUpdate(missionId, text):
loads discordThreadId, no-ops if absent, posts with postToChannel using
allowed_mentions {parse:[]} (suppress all pings), fully try/catch wrapped.

**Rule:** any member-scoped thread post (needs a name/character label = extra DB
reads) must go through postMissionMemberThreadUpdate, NOT an awaited label lookup
in the request handler. The wrapper runs detached (void IIFE + try/catch) so a
post-mutation label-lookup failure can never 500 the action that already committed.

**Announce-once guards:**
- apply/npc signup announce only when result.isEdit is false. ApplyResult.isEdit
  is set by the service: applyToMission returns isActiveEdit (existing pending/
  accepted app = edit), signUpAsNpc returns inserted.length===0. Keep isEdit
  semantics = "edit of an active signup"; re-apply after withdraw/reject is a NEW
  signup and SHOULD announce (do not switch to an xmax insert-vs-update check —
  that would silence re-applies).
- accept announces only on a real pending→accepted transition: snapshot the
  application status BEFORE reviewApplication (idempotent) and post only when prior
  status !== 'accepted'. Snapshot also carries userId/characterId so no
  post-mutation read is needed.

PATCH /missions/:id builds a single combined thread message (status open↔pending =
close/reopen, cancelled, reschedule, plus a collapsed "Updated: <fields>" line);
posts nothing when no diff. complete/uncomplete post a single line each.
