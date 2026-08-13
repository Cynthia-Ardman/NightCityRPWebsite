---
name: Wallet authorization — website is source of truth, live-UB self-heal on refusal
description: Debits authorize against users.walletBalance (authoritative); on insufficient, one live-UB re-check + guarded reconcile self-heal covers a lagging mirror. UB is a mirror pushed via outbox.
---

Rule: the WEBSITE wallet (`users.walletBalance`) is the money source of truth. `applyWalletDelta` authorizes debits against it under a `FOR UPDATE` user lock (plus an int4 `MAX_WALLET_BALANCE` overflow guard on credits). UB is a downstream mirror updated asynchronously via the `ub_push_outbox` (see [ub-push-outbox.md](ub-push-outbox.md)) — a UB outage must NEVER fail or roll back a charge.

Self-heal escape hatch: when a debit is refused as insufficient by the website number, the caller does ONE live-UB cash read (strict, never `allowStale`; bank never counts). If live cash covers it, first fold the drift into the mirror via the guarded per-user reconcile (writes a reconcile ledger row), then retry the debit against the healed website balance. If UB is unreachable, fail closed as insufficient.

**Why:** players can still earn through the legacy bot between reconciles, leaving the website below live UB cash; refusing on the website number alone shows a false "insufficient". But bypassing without healing drives the mirror negative forever.

**How to apply:** route ALL wallet movement through `applyWalletDelta` (`gate:"none"` to skip the economy kill-switch, e.g. mission pay). Never call `patchBalance` directly for player wallets; bank moves are the sole intentional UB-direct exception.
