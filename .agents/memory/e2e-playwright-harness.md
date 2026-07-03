---
name: e2e Playwright harness (ncrp-portal)
description: How the browser e2e suite is wired — Nix chromium, the test-login backdoor, per-role storageState seeding, and run constraints.
---

# Browser e2e suite (artifacts/ncrp-portal/e2e)

Real-browser Playwright suite that runs against the **live Test environment**
(the running dev workflows on `$REPLIT_DEV_DOMAIN`, portal `/` + api `/api`,
same origin). Command: `pnpm --filter @workspace/ncrp-portal run test:e2e`.

## Chromium
- Playwright's own downloaded browsers do NOT launch in the Nix env (missing
  shared libs). Use the **Nix system `chromium`** resolved at runtime via
  `which chromium` as `launchOptions.executablePath`, with args
  `--no-sandbox --disable-dev-shm-usage`. Override with `PLAYWRIGHT_CHROMIUM_PATH`.
- Install: `chromium` as a Nix system dependency; `@playwright/test` with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.

## Auth without Discord OAuth
- `POST /api/auth/test-login {userId}` mints a session for an existing user.
  Triple-gated: `NODE_ENV!=='production'` AND `ENABLE_TEST_AUTH==='true'` AND the
  userId must start with `e2e-` (else 403) so it can only impersonate harness
  fixtures, never real members.
- `ENABLE_TEST_AUTH=true` is set in the **development** env scope only (never
  prod). The api-server dev workflow is build+start with NO watcher — restart it
  after any route/env change or the change won't take effect.

## Seeding + storageState
- `e2e/global-setup.ts` runs once: seeds users (raw `pg`, not the Drizzle pkg, to
  avoid TS-transpile-of-dep issues) then test-logins each role and saves
  `e2e/.auth/<role>.json`. Specs pick a role via `test.use({ storageState })`.
- All seed data is `e2e-` prefixed and idempotent; gate fixtures `e2e-fresh`
  (rulesAccepted=false) / `e2e-unverified` (verified18=false) are reset every run.
- **Wallet balance is NOT seedable**: `/me/wallet` reads the balance from
  UnbelievaBoat by discordId, so a seeded user shows "—". Assert seeded
  `wallet_transactions` rows (memo/amount, DB-backed) instead of the balance card.

## Run constraints
- Keep `workers: 1`. Parallel workers spawn multiple chromiums that contend
  badly in this constrained env (~40s/test vs ~8s serial). Full suite ~2–3 min.


## Former index detail (full)
Nix `which chromium` executablePath; test-login backdoor gated by NODE_ENV+ENABLE_TEST_AUTH+`e2e-` prefix; per-role storageState seeded via raw pg; balance not seedable (assert wallet_transactions); keep workers=1.
