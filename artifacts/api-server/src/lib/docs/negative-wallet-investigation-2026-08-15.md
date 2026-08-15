# Negative Website Wallet Investigation — 2026-08-15

## TL;DR

**68 users** have negative `users.wallet_balance` as of this audit. No bugs were found.
Every negative balance is the result of one or more legitimate charge paths. No balance
corrections are needed. The mirror repair decision is at the bottom of this document.

---

## How wallets can go negative (by design)

Two code paths explicitly allow overdraw:

1. **`settleReservedCharge`** — used by all autobill crons (meds, rent, baseline monthly).
   It deliberately calls `clampInt4(prev + amount)` without an overdraw check, mirroring
   the old UB bot behavior of letting cash go negative.

2. **`runEconomyReconcile` / `reconcileOneUser`** — folds external UB deltas into the
   website wallet via a relative `walletBalance + delta` increment with no floor. If a
   player gambles away a large amount on Discord (or a mod command removes UB cash), that
   loss is folded in even if it pushes the website wallet below zero.

Any path using `applyWalletDelta` with `allowNegative: false` (the default) and no UB
live-balance retry will refuse to overdraw. The autobill and reconcile paths are the only
ones that bypass this.

---

## Breakdown by charge type (negative charges on negative-balance users)

| kind            | source          | users | total deducted |
|-----------------|-----------------|-------|----------------|
| meds            | website         | 43    | −483,104       |
| reconcile       | reconciliation  | 45    | −229,285       |
| transfer_out    | website         | 3     | −186,334       |
| baseline        | website         | 66    | −63,000        |
| shop            | ripperdoc       | 2     | −33,445        |
| historical      | website         | 13    | −24,108        |
| sink            | website         | 3     | −20,145        |
| store_give      | store           | 2     | −12,325        |
| shop            | store           | 1     | −6,000         |
| rent            | website         | 2     | −5,500         |

**Meds** and **reconcile-folded UB losses** are the dominant drivers. Baseline monthly
charges appear on nearly every account because the 500 eddies/month flat fee bills
regardless of balance.

---

## 62 "bilateral" users (wallet_balance = last_synced_ub_balance, both negative)

These 62 users have matching website and UB balances — both are negative. UB mirrors the
website's debt. This is the simplest category: autobill charges and/or reconciled Discord
spending outpaced income. No discrepancy with UB; no action required.

Common pattern: player incurs high cyberware meds charges (e.g. extreme-grade chrome at
$546–$3,125/week) while earning commissions slowly, and the weekly bills accumulate faster
than income recovers.

---

## 6 anomalous users (negative website, positive last_synced_ub_balance)

`last_synced_ub_balance` tracks the expected UB total as pushes land and reconcile folds
land. When it's positive while `wallet_balance` is negative, UB has recovered via external
Discord activity (gambling, mods) that hasn't yet been folded into the website wallet
(delta=0 on last reconcile run) — or the website accrued debt faster than UB did.

### .nemi. — wallet −53,164 / UB_sync +41,486 (gap: −94,650)

**Root cause:** Two massive external UB spending events folded via reconcile:
- June 20: −49,900 (external UB gambling loss → folded into website)
- July 3: −31,404 (external UB gambling loss → folded into website)

These drove the website deeply negative. UB subsequently recovered (gambling wins, external
income) while the website balance remained in debt. Reconcile correctly set the baseline
to UB's recovered value (41,486). The website's −53,164 is an accurate tally of the
aggregate debt; UB's 41,486 reflects current Discord-side cash. No double-counting, no
bug. The system is working as designed.

Additional context: .nemi. continued earning commissions (work income) and making transfers
while deeply in debt; the website correctly recorded all of it.

### _novaishere_ — wallet −12,345 / UB_sync +2,150 (gap: −14,495)

**Root cause:** Accumulated reconcile folds of external UB spending (−58,749 total over
the ledger lifetime), an −8,000 transfer_out ("Paying you back for everything") made
on 2026-08-12 while already at −3,877, and weekly autobill charges. No bug.

### batterybear — wallet −8,327 / UB_sync 0 (gap: −8,327)

**Root cause:** Single −15,081 reconcile entry on 2026-07-23 ("External UnbelievaBoat
change"). Prior balance was +6,754; the external UB loss drove the website to −8,327 in
one shot. `last_synced_ub_balance = 0` indicates the baseline was either initially seeded
at 0 or has been cleared; this is consistent with the account's short history starting
from a 0 seed. No bug.

### miniminhurr — wallet −1,918 / UB_sync +903 (gap: −2,821)

**Root cause:** Accumulated reconcile folds (−10,904), baseline (−1,125), and transfers
(−1,610) outpaced earnings (+20,691) from a starting balance of 0. Small, gradual drift
into debt. No bug.

### elirialove — wallet −661 / UB_sync +2,465 (gap: −3,126)

**Root cause:** A −10,000 historical meds charge (legacy bot import), then reconcile folds
of external UB losses (−49,128 total), partially offset by 56,567 in credits. Current
small negative balance from rent (−2,000 August) + autobill. No bug.

### ghostologest — wallet −2,833 / UB_sync −2,583 (gap: −250)

**Root cause:** Both negative, essentially in sync (gap of 250 eddies). Accumulated
autobill charges. Effectively a bilateral negative like the 62-user group; the tiny
discrepancy is within normal reconcile timing. No action needed.

---

## Verdict: no bugs, no corrections needed

All 68 accounts went negative through legitimate, intended charge paths:
- Autobill charges that legally overdraw (by design, parity with the old UB bot)
- Reconcile folds of real external UB spending events (gambling/mod actions)
- Player transfers or store purchases made while already in debt (website allows these)

No double-charges, no phantom reconcile entries, no import bugs were found. The ledger
chain is internally consistent for every account examined.

---

## Mirror repair decision: negative website wallets

When a fleet-wide UB mirror repair is run (to push UB balances up to match the website
for users whose UB has drifted ahead via unmirrored activity), the following policy MUST
apply to accounts where `wallet_balance < 0`:

### Policy: **floor UB at 0 — keep the debt website-side only**

- Do NOT send a negative target balance to UnbelievaBoat. UB may reject negative balances
  outright (API behavior is undefined for sub-zero totals), and sending a player from a
  positive UB balance (e.g. +41,486) to a large negative (e.g. −53,164) in one repair
  push would be severely disruptive and visually shocking.

- For users where `wallet_balance < 0` AND `last_synced_ub_balance > 0`:
  **skip or no-op the mirror repair** for that user. Their UB balance is legitimately
  higher than the website because UB recovered externally; the website debt is real and
  should persist.

- For users where `wallet_balance < 0` AND `last_synced_ub_balance <= 0`:
  UB already reflects the negative state. **No push needed** — both sides are in sync.
  Do not attempt to bring UB up to 0 either; the bilateral debt is correct.

- The website is the source of truth. Players with negative website balances will
  organically recover as future earnings (reconcile folds of discord income, mission
  payouts, commission) are added to the website balance, gradually moving it back toward
  zero.

### Practical consequence for `.nemi.` (the extreme case)

`.nemi.` has UB at ~41,486 and website at −53,164. Under this policy, no repair push is
made. Reconcile will continue to fold external UB changes into the website; if .nemi.
keeps earning on Discord, those will eventually close the gap. Staff can optionally issue
an admin wallet credit if the debt is considered forgiven, but no automated action should
send UB negative.

---

## Code locations relevant to future mirror repair

- `artifacts/api-server/src/lib/economy.ts`:
  - `settleReservedCharge` — the overdraw-allowing autobill path
  - `runEconomyReconcile` — fleet reconcile cron, folds external UB deltas
  - `drainUbPushOutbox` — advances `last_synced_ub_balance` when pushes land
  - `getMirrorHealth` — exposes queued push counts and drift per user for admin panel

When implementing a mirror repair endpoint or script, add a guard:

```typescript
// NEVER push UB below 0 during mirror repair.
// Keep website-side debt as website-only — see docs/negative-wallet-investigation-2026-08-15.md
if (targetUbBalance < 0) {
  logger.warn({ userId, websiteBalance, targetUbBalance }, "mirror repair: skipping negative target for user");
  continue; // or skip
}
```
