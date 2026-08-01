---
name: Wallet debit authorization uses live UB cash + self-heal
description: Overdraw checks must not refuse on the website mirror alone; re-check live UB cash, then self-heal the mirror via the guarded per-user reconcile before applying.
---

Rule: when a wallet debit would be refused because the website mirror (`users.walletBalance`) is too low, re-check against LIVE UnbelievaBoat CASH (strict read — never `allowStale`; bank never counts, debits target cash only). If live cash covers it, do NOT just bypass the check — first fold the external drift into the mirror via the guarded per-user reconcile (writes a reconcile ledger row), then recompute the debit from the healed mirror. Only refuse if the live read fails or live cash is insufficient.

**Why:** the mirror drifts below live UB cash when players earn through the bot between reconciles; the UI shows live UB, so a player with visibly sufficient cash gets a false "Insufficient personal wallet balance". Bypassing without healing is worse: finalize sets `lastSyncedUbBalance` to the post-patch total, silently swallowing the drift and driving the mirror negative forever (ledger previous/newBalance become lies).

**How to apply:** debit paths routed through the central wallet-delta entry point inherit this; a path that bypasses it must do the same live-cash check + reconcile-first heal. If UB is unreachable, fail closed on the mirror (the UB write would fail anyway).
