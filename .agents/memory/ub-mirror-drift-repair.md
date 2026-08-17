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

**Drift causes are mixed:** NULL-balance legacy charges are only part of it; most drift is old website spends whose direct UB patches silently failed pre-cutover. Verify a ledger with `seed.new_balance + sum(amount after seed) = walletBalance` — if it chains exactly, the website figure is the truth regardless of drift decomposition.

**Bulk repair (runUbBalanceRepair) is accuracy-safe** because drift = wallet − lastSynced BASELINE, not live UB — unreconciled recent Discord activity (work/gambling) is preserved and folded by the next reconcile. It skips negative wallets and users with unfinished outbox pushes, and baseline-guards against reconcile races.

**Player comms trap:** the repair drops UB balances with only an audit reason — players see "money vanished from the bot" and file theft reports (happened with the first manual repair). Announce before a live run. Distinct look-alike reports that are NOT drift: real UB gamble losses folded by reconcile (dispute is with UB logs), and meds billing on characters that should be LOA (billing policy, not sync).

**Manual-settle re-fold trap (Aug 2026):** a manual "forfeit/settle" that debits UB (or website) WITHOUT advancing `last_synced_ub_balance` gets re-folded by the next reconcile tick — the player is charged twice. Any manual money move outside applyWalletDelta must either advance the baseline in the same operation or be done as a website-side credit/debit only (letting the outbox mirror it). Repair for a double-debit: credit the WEBSITE wallet (audited), no direct UB push.

**Amnesty aftermath (Aug 2026):** players who saw the amnesty UB credit sometimes "returned" it by paying the legacy bot (external UB debit the ledger never sees) → website > UB drift reappears. If the player disclaims the money, settle by debiting the WEBSITE wallet to match UB (reconcile row + baseline advance), not by re-crediting UB.
