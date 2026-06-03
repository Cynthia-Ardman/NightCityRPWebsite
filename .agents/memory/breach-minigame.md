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
- **Shared board + local scoring parity**: the interactive matrix/buffer/daemons/timer/result
  overlay live in a reusable `BreachBoard.tsx` consumed by BOTH assigned play (BreachPlay) and
  the unrecorded `BreachPractice` page. The board computes its own outcome client-side and must
  mirror the server's contiguous-subsequence daemon rule (scoreSelection); if you change scoring
  in `lib/breach/src/game.ts`, update the board's `containsContiguous`/success criterion too or
  practice + live live-feedback drift from the authoritative result.
- **Mission link vs free-text context are intentionally redundant**: a breach can hard-link a
  real mission (`breachPuzzles.missionId`, FK set-null on delete) OR carry only a free-text
  `contextLabel`. When a mission is linked, createPuzzle SNAPSHOTS the mission title into
  contextLabel (if no explicit label) so the breach log + DM still read well after a rename or
  mission deletion; `shape()` separately resolves the LIVE `missionTitle` for display. Don't
  "dedupe" these — contextLabel is the durable snapshot, missionTitle is the live join.
  The mission detail page's attached-breaches panel reuses the staff-only list endpoint
  (`GET /breach/puzzles?missionId=`, FIXER/ADMIN-gated) and only renders in the manager tab —
  keep that endpoint staff-gated; it's the authz boundary for the panel.
- **Practice stats sync is opt-in, personal-only, and NEVER touches the economy/authoritative flow**:
  the practice page stays "not recorded". Optional account sync lives in its own `breachPracticeStats`
  table (PK `(userId, difficulty)`), service fns + routes under `/breach/practice/*` in breach.ts /
  routes/breach.ts. A per-browser localStorage flag (`ncrp-breach-practice-sync-v1`) drives the opt-in
  (`usePracticeStats.ts`); only shown when logged in. **Merge (first-sync) is one-shot**: it SUMS
  attempts/solves and keeps the smaller fastestClear, then the client CLEARS its local snapshot so a
  later re-enable can't double-count the same history. **Never add rewards or tie practice into the
  economy/authoritative flow** — that breaks the "not recorded" contract.
- **Practice leaderboard ranks INDIVIDUAL runs, not per-player bests — two-table design**: there are TWO
  practice tables. `breachPracticeStats` (PK `(userId,difficulty)`) is the AGGREGATE for the personal stats
  card (attempts/solves/fastestClearMs). `breachPracticeClears` (serial id, userId, difficulty, clearMs
  notNull, createdAt) holds ONE ROW PER WINNING RUN and is what the LEADERBOARD reads. `getPracticeLeaderboard`
  (`GET /breach/practice/leaderboard`, requireAuth) innerJoins `breachPracticeClears`→users, orders
  `asc(clearMs), asc(createdAt), asc(id)`, buckets top-10/difficulty with NO per-user dedup — so one player
  can hold multiple/all slots. `LeaderboardEntry = {id,userId,username,clearMs,achievedAt}` (id is the run id =
  stable React key since userId repeats; self-highlight by userId). `recordPracticeAttempt` writes BOTH (a
  clear row only when win+clearMs!=null). **Reset and merge MUST touch BOTH tables**: `clearPracticeStats`
  deletes stats AND clears (else a reset leaves the player on the board); `mergePracticeStats` seeds ONE clear
  row per difficulty from the local best, guarded by an exists-check on (userId,difficulty,clearMs) so a replay
  doesn't duplicate slots. Backfill from legacy bests: `scripts/src/backfill-practice-clears.ts` (idempotent via
  NOT EXISTS on user+difficulty+clear_ms; supports IMPORT_TARGET=live) — run once on prod after deploy. Only
  ACCOUNT-SYNCED players have clear rows; still no rewards/economy. **Why:** users asked one fast player to be
  able to occupy several top spots, which a per-player-best aggregate can't express.
- **Difficulty is split: practice/leaderboard ⊂ staff**: `lib/breach/src/game.ts` exports the FULL
  `Difficulty`/`DIFFICULTIES` (incl. `impossible`) for STAFF puzzle assignment (BreachHub, createPuzzle,
  difficultyBadge), and a narrower `PracticeDifficulty`/`PRACTICE_DIFFICULTIES` = easy|medium|hard|very_hard|nightmare
  (everything EXCEPT impossible) for the practice page + practice leaderboard. The practice service keys (`PracticeStatsView`/`PracticeLeaderboardView`),
  the `isPracticeDifficulty` guard, and the openapi practice schemas all use the narrow set. Legacy
  `breachPracticeStats` rows with `difficulty='impossible'` are silently filtered (guard skips them) — never
  indexed into response objects. **Why:** impossible was removed from practice only; widening either set must
  stay one-directional (staff ⊇ practice) or practice will accept a difficulty the leaderboard can't bucket.
- **Live-submit status is on the RESPONSE, not the query**: after a successful /result submit,
  derive the overlay's expired/success/solvedCount from the returned `BreachResult.puzzle`
  (fresh status), NOT the pre-submit getPuzzle query — that cached row is still `sent`/`startedAt`
  and reports a timeout as a generic failure. **Why:** caused a regression where timed-out runs
  showed "BREACH FAILED" instead of "TIME UP" until a refetch landed.
