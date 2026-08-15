---
name: UB mirror drift repair
description: Diagnosing and fixing website-wallet vs UnbelievaBoat drift; portal "negative cash" is a drift symptom, not theft.
---

Portal cash = `users.walletBalance − UB bank`. When UB total > website wallet, cash displays NEGATIVE and players report money "stolen with no logs". Nothing moved — first verify the website ledger chain (previous_balance → new_balance is continuous; seed row + sum(amount) must equal walletBalance).

**Root cause pattern:** pre-cutover charges recorded with NULL previous/new balance (monthly baseline, weekly meds — the informational-backfill rows) were never mirrored to UB, so UB stayed high. Drift = `last_synced_ub_balance − wallet_balance` persists silently because the reconcile cron only folds *changes in UB vs baseline*, never the standing gap.

**Repair recipe (per user):**
1. PATCH UB by −drift (bank preferred; UB PATCH body values are deltas, raw curl with `$UNBELIEVABOAT_TOKEN` bypasses the code's deployment write-gate).
2. THEN advance `last_synced_ub_balance` to the website total, guarded on the old value — order matters: advancing the baseline first makes the reconcile cron fold +drift INTO the wallet (gives money away).
3. Insert a 0-amount `reconcile`/`reconciliation` wallet_transactions row for forensics.

**Why:** Aug 2026 — 144 of 480 synced prod users drifted (−36k…+94k); AlienCowboy's "6k deficit" was exactly this. Some users also have NEGATIVE website wallets (allowNegative debits) — don't blindly push UB negative.
