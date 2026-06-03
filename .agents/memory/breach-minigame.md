---
name: Breach Protocol minigame
description: Where breach puzzle logic/state lives and the exactly-once reward + timer invariants.
---

# Breach Protocol minigame

Cyberpunk-style hacking minigame. Staff generate timed puzzles, DM a play link;
players solve live; rewards paid on success.

## Layout
- Pure logic: `lib/breach/src/{game,puzzleGenerator}.ts` (scoreSelection is authoritative).
- Table `breachPuzzles` (lib/db schema). Service `artifacts/api-server/src/lib/breach.ts`, router `routes/breach.ts`.
- Frontend `artifacts/ncrp-portal/src/pages/breach/{BreachPlay,BreachHub,MyBreaches,breachUtils}.tsx`; CharacterDetail Breach tab; routes in App.tsx, nav in AppLayout.

## Invariants (don't regress)
- **Reward exactly once**: submitResult does an atomic conditional UPDATE guarded on
  `completedAt IS NULL`. Only the winning row proceeds to score+payReward; losers return
  the idempotent recorded outcome. This (not payReward's own rewardPaidAt guard) is what
  stops concurrent submits double-minting inventory items, since item insert is not idempotent.
  **Why:** check-then-act on completedAt let two concurrent POSTs both pay.
- **Timer authority is the grid-reveal point**: the server starts the clock (sets startedAt)
  inside `getPuzzle` the first time the assigned player fetches the puzzle — that single
  endpoint is the ONLY place the full grid+daemon sequences are revealed to a player. List
  endpoints (`/breach/mine`, per-character) redact grid+daemon-sequences for non-completed
  rows (keep daemon COUNT for "x/y" displays); staff see full. submitResult treats a null
  startedAt as expired. **Why:** if any list leaked the grid before the clock started, a
  player could solve offline untimed then start+submit instantly — defeating the timer.
  Don't add grid/daemon contents to any player-facing endpoint other than getPuzzle.
- **/result contract**: invalid/losing paths score as failed (still 200); resubmit of a
  completed puzzle is 200 idempotent with rewardPaid=false. No 400/409 on result.
