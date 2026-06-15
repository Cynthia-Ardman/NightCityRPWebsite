---
name: Dashboard NPC session banner
description: The "needs NPCs" dashboard banner must target the next session, not skip ahead
---

The dashboard "MAIN SESSION NEEDS NPCS" banner (`NpcSessionBanner` in
`ncrp-portal/src/pages/Home.tsx`) must always target the **soonest** upcoming
session that needs NPCs, then HIDE if the viewer already signed up for that
soonest one.

**Why:** the old loop filtered `mySignup != null` *inside* the candidate scan,
so once you signed up for the next session it advanced to a *later* session (e.g.
showed Session 69 when 68 was the actual next session and you'd already signed up
for it). The banner is about the next session only — never a future one.

**How to apply:** pick `best` by earliest occurrence WITHOUT excluding signed-up
events, then `return null` when `best.mySignup != null`. A single session can
have duplicate rows (Discord + website copies sharing a start time); tie-break by
upgrading `best.mySignup` when either copy has a signup, so a signup on either
counts. Read `needsNpcs` from the server view (it's already derived via
`eventNeedsNpcs`), not the raw column.
