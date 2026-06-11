---
name: Settled wallet movement (mission payouts in the ledger)
description: Why money paths that hit UnbelievaBoat directly must record a settled ledger row, and how recordSettledWalletMovement avoids double-counting with reconcile.
---

# Settled wallet movement

Some money paths call UnbelievaBoat (`patchBalance`) **directly** and deliberately
do NOT route through `applyWalletDelta` — most notably **mission payouts**
(`missionsService.ts` `payMissionPlayers`). They are gated on **mission live mode**
(`ctx.live`), not the **economy kill-switch** that gates `applyWalletDelta`.

**Why not just use applyWalletDelta:** it is gated on the economy mode (disabled/
test/enabled). The economy kill-switch is often OFF while missions run live.
Routing mission pay through it would (a) make payouts silently stop when economy is
disabled and (b) fire a SECOND UB leg → double-pay. So mission pay keeps its direct
`patchBalance` call.

**Consequence if you do nothing:** no `wallet_transactions` row is written, so the
player's per-character Ledger shows nothing; the eddies only ever surface later as a
generic `source:"reconcile"` row when the economy reconcile cron runs. To the user
this looks like "the payout never happened / no record."

**Fix pattern — `recordSettledWalletMovement` (economy.ts):** after the UB call
already succeeded, record the movement into the website ledger + balance WITHOUT a
second UB call:
- lock the user row `FOR UPDATE` (atomic read-modify-write of `walletBalance`),
- insert a `syncStatus:"synced"` `wallet_transactions` row,
- advance `walletBalance`,
- advance `lastSyncedUbBalance` to the **post-call UB total** so the reconcile cron
  computes a zero delta and does NOT double-count this same payout.

**Critical seeding edge case:** when the wallet was never seeded
(`lastSyncedUbBalance IS NULL`), leave the baseline null — only advance
`walletBalance`. The first reconcile's seed branch then sets the full UB total
(which already includes this payout), so nothing is lost or doubled. If you set the
baseline here on an unseeded wallet you permanently strand the pre-existing UB
balance.

**Idempotency:** pass an `idempotencyKey` (e.g. `mission_payout:<assignmentId>`).
Pre-check returns the existing row id; the insert also uses
`onConflictDoNothing({ target: idempotencyKey })` so a concurrent
pre-check→insert race is a true no-op (the FOR UPDATE lock makes the two writers
serialize, and the loser must NOT advance the balance again).

**How to apply:** call it best-effort (try/catch) AFTER the authoritative state
change (assignment marked paid). A failure must never unwind a payout that already
moved real money — reconcile folds the UB delta as a fallback. Do NOT clamp to
MAX_WALLET_BALANCE here: the money already moved in UB, so clamping would desync
website balance from UB.

**Admin discoverability:** mission payout audit rows have `category:"mission"`. The
Admin Audit Log (`AdminDashboard.tsx` `AUDIT_SUBTABS`) needs a `mission` sub-tab to
surface them; `classifyWalletCategory(kind="mission")` → `"mission"` category for
the Ledger.

**Not handled:** actor/NPC mission payouts (`payMissionActors`,
`payMissionActorsForEvent`) still call `patchBalance` directly and remain
ledger-invisible — same pattern would apply if that gap is reported.

**Backfilling pre-fix payouts (one-off, prod):** to retroactively show already-paid
payouts that pre-date the fix, do NOT reuse `recordSettledWalletMovement` (it moves
`walletBalance`, which would show a WRONG too-low number for unseeded users and
can't be reconstructed historically). Instead insert **purely informational**
history rows: `source/kind:"mission"`, `category:"mission"`,
`syncStatus:"synced"`, `idempotencyKey:"mission_payout:<assignmentId>"` (same key as
the live path → can't double-write), `createdAt = paid_at`, and leave
`previousBalance`/`newBalance` **and** `walletBalance`/`lastSyncedUbBalance`
untouched. Safe because the authoritative balance is the `users.walletBalance`
column, NOT a SUM of `wallet_transactions` (`getBalance` reads the column). Reconcile
later seeds each unseeded user to their full UB total as one snapshot row — the same
eddies then appear once as the labeled mission entry and once folded into that
seed snapshot; balances stay correct. Write via a `--apply`-gated tsx script against
`LIVE_PROD_DATABASE_URL` (executeSql prod is read-only); `INSERT...SELECT ...
ON CONFLICT (idempotency_key) DO NOTHING`. Done once for all 5 paid missions
(23 player rows).
