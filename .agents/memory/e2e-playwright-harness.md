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

## Vite dev error overlay blocks clicks
- The suite runs against the Vite DEV server, so any benign runtime error (e.g.
  the expected `/me/wallet` 502 for unseeded UB balances) pops
  `<vite-error-overlay>` which intercepts ALL pointer events and makes clicks
  time out. Removing it via MutationObserver doesn't stick (it re-spawns);
  inject a CSS kill via `page.addInitScript`:
  `vite-error-overlay{display:none!important;pointer-events:none!important;}`.

## e2e accounts keep losing verified18 (age-verification gate)
- The hourly role_sync recomputes Discord-role-derived flags BOTH directions, and
  `e2e-*` fixtures aren't in the guild, so their `verified18` drifts back to
  false and character pages render the AGE VERIFICATION gate (plus 403 resource
  noise) mid-test-session.
- This is fixture state, not protected data: re-flip it in the dev DB
  (`UPDATE users SET verified18 = true WHERE username LIKE 'e2e-%'`) before
  browser checks that need character detail pages. Expect it to drift again.

## Journey-spec gotchas (journeys.spec.ts)
- Multi-role serial journeys: `browser.newContext({storageState: stateFile(role)})`
  per step inside `test.describe.serial`; look up ids by seeded names via
  `withPool` from `./seed`.
- Sheet submit requires pronouns/occupation/psych/physical/background/age/skills
  (see api-server sheet-validation REQUIRED_SHEET_FIELDS) + portrait & stats
  uploads; a failed submit silently leaves a draft row.
- Mission `button-approve` lives on the FIXER tab and approve AUTO-POSTS
  (approveMission delegates to postMission — no separate post step).
- Mission completion only stamps completedAt/completedBy; `missions.status`
  stays "open" (it's the signup toggle). Player pay settles only via the
  autopay cron — assert mission_assignments payment fields, not money.
- Long runs: never background playwright (bash suspension trap); run foreground
  in chunks with `timeout 110 npx playwright test <files>` per bash call.
