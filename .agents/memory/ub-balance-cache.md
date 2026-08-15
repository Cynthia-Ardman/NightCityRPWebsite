---
name: UnbelievaBoat balance cache
description: How getBalance/patchBalance cache works — single-flight, generation guard, opt-in stale fallback — and why strict callers must NOT get source:"local".
---

# UnbelievaBoat balance cache (lib/unbelievaboat.ts)

`getBalance` has a 30s in-memory cache with three load-bearing properties:

- **Single-flight**: concurrent cache misses for the same user share ONE upstream
  fetch (an `inflight` Map of promises), so a slow/hung UB API (10s timeout)
  can't fan out into N parallel stalls on one page load.
- **Generation guard**: a per-user monotonic counter. A live fetch snapshots the
  generation when it starts and only writes the cache if it's unchanged on
  resolve. `patchBalance` bumps the generation on EVERY write outcome — success
  (then caches the authoritative post-write value), non-OK response, AND thrown
  error (both bump + delete cache). This closes the stale-overwrite race where an
  older in-flight read repopulates the cache with a pre-write balance.
- **Opt-in stale fallback**: `getBalance(id, { allowStale: true })` returns the
  last-synced DB value `users.lastSyncedUbBalance` as `{cash:total,bank:0,total,
  source:"local"}` ONLY when the live fetch fails. Default (no opts) stays strict
  `null`-on-failure. Failures are never cached (API retried next call).

**Why opt-in (not downstream source filtering):** money-movement + sync callers
must have live data. economy reconcile/sync, characters transfer fund-checks,
the authoritative `/characters/:id/wallet` GET, and admin economy drift all rely
on `if (!ub) ...`. If they consumed a `source:"local"` fallback, economy reconcile
would fold a phantom delta / mark a synced state during a UB outage (feedback
loop into lastSyncedUbBalance). Keeping the fallback opt-in means strict callers
literally cannot receive `source:"local"`. Only pure-display reads opt in:
dashboard `/me/wallet` (surfaces `source: ub.source`) and the summary total.

**How to apply:** any NEW caller that gates spending/transfers/sync must call
`getBalance(id)` (strict) — never pass `allowStale`. Only add `allowStale:true`
for read-only display where a degraded estimate is acceptable, and propagate
`ub.source` so the UI can flag it.

**Testing note:** vitest.config.ts forces `UNBELIEVABOAT_TOKEN:""` so the real
module is inert; every suite mocks `../lib/unbelievaboat`. There is intentionally
no unit test that drives the real cache — adding one needs resetModules + env
injection + fetch stub, which fights the harness convention.

## Bulk reads: leaderboard endpoint
Per-user GET /guilds/:g/users/:id at ~4/s trips UB rate limits (economy_reconcile used to fail ~330/483 users per run, silently skipping them). Bulk read via `listGuildBalances()` — GET /guilds/:g/users?limit=100&page=N returns `{users:[{user_id,cash,bank,total}],total_pages}`; ~5 calls covers the guild. Contract gotchas encoded in the reconcile: any failed page → return null (partial map misreads absent users as "no UB row"); leaderboard membership of zero/negative accounts is NOT documented, so map-absent users with a non-null lastSyncedUbBalance get a per-user re-check; economy_reconcile is in NO_OVERLAP_JOBS so runs can't stack.
