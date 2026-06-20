---
name: Mission thread lifecycle updates
description: How follow-up posts into a mission's Discord discussion thread are wired and gated.
---

Missions start a per-mission Discord discussion thread off the fixer job-proposal
brief. The brief-build + thread-create logic lives in missionsService
(ensureMissionThread(m, channelId) → {created, threadId}; announceMissionThread is
the fire-and-forget wrapper the create path calls) so it is SHARED with the thread
backfill — do not re-inline it in routes/missions.ts. Idempotency contract:
ensureMissionThread no-ops if discordThreadId set, reuses an existing
discordMessageId, persists msgId BEFORE the thread call, sets discordThreadId only
when startThreadFromMessage returns non-null, and returns created=true ONLY when a
thread was newly linked this call. The whole subsystem is DEPLOYMENT-gated
(externalWritesAllowed inside postToChannel/startThreadFromMessage), NOT missions
Test/Live gated — the backfill job (runMissionThreadBackfill, admin job
"mission_thread_backfill" + scripts/backfill-mission-threads.ts) matches this: no
ctx.live gate, no liveSystemByJob entry, pure no-op in dev. Backfill targets
workflowState='posted' AND status NOT IN HISTORY_STATUSES AND discordThreadId IS
NULL, and seeds a one-shot current-state snapshot (roster+pending+NPC, parse:[])
only when created=true. Follow-up lifecycle posts go into that thread via
postMissionThreadUpdate(missionId, text):
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
