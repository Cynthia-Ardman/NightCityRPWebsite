---
name: Economy dry-run mirrors live guards
description: applyWalletDelta test-mode dry runs enforce the same overdraw/overflow guards as live; deposit/withdraw requires a client idempotency key.
---

- `applyWalletDelta` in TEST mode (dry_run) now applies the SAME overdraw (`insufficient_funds`) and int4 ceiling (`exceeds_max`) guards as live. **Why:** dry runs must predict the live outcome — callers mark things "paid" off `ok:true`, so a permissive dry run made test mode lie (NCPD fine marked paid with insufficient funds).
- **How to apply:** tests exercising debit paths in test mode must fund the user first; tests asserting refusal can rely on 402/409 in test mode too.
- `duplicate` commit outcome maps to `ok: true, status: "duplicate"` — retry-based healing (mission payouts, fines) treats it as success.
- Venue deposit/withdraw 400s without a client `idempotencyKey` (the `Date.now()` fallback was removed); tests must send `crypto.randomUUID()`.
