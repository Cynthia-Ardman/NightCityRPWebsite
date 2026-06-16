---
name: Mission post-to-board chokepoint & atomic claim
description: postMission is the single transition point for approved→posted→open; its external side effects must fire behind an atomic conditional-update claim.
---

# Mission post-to-board chokepoint

`postMission()` (missionsService.ts) is the ONE place an approved mission becomes
`workflowState='posted'` + `status='open'`. `approveMission()` delegates to it
(approval publishes in one step), and the manual `/missions/:id/post` route also
calls it. So any side effect that should fire "when a mission opens for sign-ups"
(Discord scheduled-event sync, the sign-up announcement post to the sign-up
channel) belongs in `postMission`, not scattered across approve/post routes.

**Rule:** gate those side effects behind an *atomic* conditional update —
`UPDATE ... SET workflowState='posted' WHERE id=? AND workflowState='approved'
RETURNING id` — and only proceed when exactly one row is claimed. A plain
read-then-update (select workflowState==='approved', then unconditional update)
lets two concurrent approve/post requests both pass the read and each fire the
Discord event + announcement → duplicate posts.

**Why:** missions naturally fire once per approval cycle because the guard
requires `workflowState==='approved'`, but that's only true under serialization;
concurrent requests race the check-then-act window.

**How to apply:** new mission "on open" side effects go in `postMission` after
the claim, live-gated (`ctx.live`) and wrapped in try/catch so a Discord miss
never blocks the transition (mirrors the NPC announcement pattern). The sign-up
channel id is `missions_signup_channel_id` in bot_config (MISSION_CONFIG_KEYS /
MISSION_DEFAULTS in missionsConfig.ts), defaulting to the production channel.
