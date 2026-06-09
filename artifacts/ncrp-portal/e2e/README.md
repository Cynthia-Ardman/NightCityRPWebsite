# Browser end-to-end tests (Playwright)

These tests drive the **running portal** with a real Chromium browser, signing in
as each role via a dev-only login backdoor (no Discord OAuth), and assert on
**visible outcomes** (rendered text, balances, gated UI) rather than HTTP status.

## One command

```bash
pnpm --filter @workspace/ncrp-portal run test:e2e
```

(or `pnpm test:e2e` from inside `artifacts/ncrp-portal`)

The full suite takes ~2–3 minutes. To run a single spec:

```bash
pnpm --filter @workspace/ncrp-portal run test:e2e e2e/missions.spec.ts
```

## Prerequisites (already configured in this workspace)

1. **Chromium** — installed as a Nix system dependency. The config resolves it at
   runtime via `which chromium` (override with `PLAYWRIGHT_CHROMIUM_PATH`).
   Playwright's own downloaded browsers are *not* used (they lack shared libs in
   the Nix environment).
2. **`ENABLE_TEST_AUTH=true`** on the **api-server**, set in the *development*
   environment scope only — never in production. This enables
   `POST /api/auth/test-login`, which mints a session for a given user id without
   Discord OAuth. The endpoint is additionally hard-gated to non-production.
3. The dev workflows must be running (the portal at `/` and the api at `/api` on
   `$REPLIT_DEV_DOMAIN`). The suite targets that live Test environment.

## How it works

- `e2e/global-setup.ts` runs once before the suite. It:
  1. Seeds one deterministic user per role (`e2e-player`, `e2e-fixer`,
     `e2e-archivist`, `e2e-admin`, `e2e-csapprover`, plus `e2e-fresh` /
     `e2e-unverified` gate fixtures) directly in the dev database, with
     `verified18` / `rulesAccepted` set so they clear the onboarding gates.
  2. Seeds a player-owned character and a small wallet ledger for the
     data-backed journeys.
  3. Signs in as each role via `/api/auth/test-login` and saves the session
     cookies to `e2e/.auth/<role>.json` (a Playwright `storageState`).
- Each spec selects the role it needs with
  `test.use({ storageState: stateFile("admin") })`.
- All test data is namespaced with an `e2e-` prefix and the seed is idempotent,
  so reruns never disturb real imported data.

## Coverage

| Spec | Journey |
| --- | --- |
| `smoke.spec.ts` | App shell loads in a real browser |
| `auth-gates.spec.ts` | Logged-out landing, age-verification wall, rules splash → dashboard |
| `access.spec.ts` | Role-based route guards (player blocked from staff routes; admin/fixer reach their hubs) |
| `characters.spec.ts` | Character list → detail; new-sheet form |
| `wallet.spec.ts` | Ledger lists seeded transactions |
| `catalog.spec.ts` | Guns / cyberware / property catalogs render |
| `missions.spec.ts` | Mission board tabs; staff-only create gating |
| `breach.spec.ts` | Breach practice hub |
| `reviews.spec.ts` | Pending character-sheet review queue (approver roles) |
