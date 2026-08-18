---
name: Fire-and-forget effects need vi.waitFor in tests
description: How to assert detached (void-ed) side effects in api-server tests without flaking under full-suite load
---

Many api-server write paths detach side effects (`void announceRequest(...)`, the outbox drain kicked by `applyWalletDelta`, the UB snapshot persist in `getBalance`). Tests that assert those effects synchronously — or after a fixed `setTimeout` sleep — pass per-file but flake under full-suite CPU/IO load.

**Why:** the route responds before the detached promise runs; under load the gap stretches far past any fixed sleep. The ub_push_outbox rows also transiently sit at `inflight` while the drain has them claimed, so a status assertion like "pending|suppressed" can catch the middle state.

**How to apply:** poll with `await vi.waitFor(async () => { ...expect... }, { timeout: 10_000, interval: 50-100 })` on the condition instead of asserting immediately or sleeping. For outbox status asserts, wait for rows to *settle* (out of `inflight`), then assert nothing reached `pushed` (test env suppresses external pushes). Negative asserts ("never announced") are fine immediately only when the code path provably never fires the effect.
