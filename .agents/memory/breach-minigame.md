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
- **Reward settlement is decoupled from completion (eventually-exactly-once)**: completedAt
  is flipped BEFORE payout, so payout must be retryable, not fire-and-forget. `rewardPaidAt`
  is stamped ONLY when every required reward part has settled — eddies (idempotent on
  wallet key `breach-reward-<id>`) AND item mint (guarded by `rewardItemId`, claimed under
  a `breachPuzzles` row `FOR UPDATE`). A partial payout persists the settled part's id and
  leaves rewardPaidAt NULL; the idempotent already-completed reply paths call `settleIfNeeded`
  to retry the missing part on a later submit. **Why:** previously rewardPaidAt was stamped
  unconditionally even when the eddies UB call failed → reward silently lost with no retry;
  and a crash between the completedAt flip and payout left a success permanently unpaid.
  Never stamp rewardPaidAt unless `eddiesSettled && itemSettled`.
- **Timer authority is the grid-reveal point**: the server starts the clock (sets startedAt)
  inside `getPuzzle` the first time the assigned player fetches the puzzle — that single
  endpoint is the ONLY place the full grid+daemon sequences are revealed to a player. List
  endpoints (`/breach/mine`, per-character) redact grid+daemon-sequences for non-completed
  rows (keep daemon COUNT for "x/y" displays); staff see full. submitResult treats a null
  startedAt as expired. **Why:** if any list leaked the grid before the clock started, a
  player could solve offline untimed then start+submit instantly — defeating the timer.
  Don't add grid/daemon contents to any player-facing endpoint other than getPuzzle.
- **/result contract**: invalid/losing paths score as failed (still 200); resubmit of a
  completed puzzle is 200 idempotent. No 400/409 on result. rewardPaid is usually false on
  resubmit, but CAN be true when a resubmit settles a previously-unsettled success (see the
  reward-settlement invariant) — never assume resubmit always returns rewardPaid=false.
