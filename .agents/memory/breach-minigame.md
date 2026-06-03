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
- **Timer authority**: client starts the server timer on play-page MOUNT (not first cell
  click) so startedAt is persisted before any submit; time limit enforced via server startedAt.
- **/result contract**: invalid/losing paths score as failed (still 200); resubmit of a
  completed puzzle is 200 idempotent with rewardPaid=false. No 400/409 on result.
