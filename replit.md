# Night City RP Portal

Web portal for the Night City RP Cyberpunk Discord community — replaces the legacy NightCityBot bot. Discord OAuth login with role sync, character management (PCs and NPCs), inventory, wallet (UnbelievaBoat as source of truth), shop/clinic management, public directories, Cyberpunk Red character sheets with CS-Approver review flow, dice roller, and an admin panel.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/ncrp-portal run dev` — run the React portal
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate React Query hooks + Zod schemas from `lib/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run generate` — generate a versioned migration from schema changes (see "Database migrations")
- `pnpm --filter @workspace/db run migrate` — apply pending migrations to the dev DB
- Required secrets: `DATABASE_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`
- Optional: `DISCORD_BOT_TOKEN` (role sync, channel posts), `UNBELIEVABOAT_TOKEN` (wallet sync), `CS_APPROVAL_CHANNEL_ID` (sheet review pings)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, `express-session` + `connect-pg-simple`, Discord OAuth2 + bot REST
- Frontend: React 19 + Vite, Tailwind v4, shadcn/ui, wouter, TanStack Query, Orval-generated hooks
- DB: PostgreSQL + Drizzle ORM
- Codegen: Orval (OpenAPI → React Query hooks + Zod)
- Cron: `node-cron` (cyberware humanity drift, monthly rent, role sync)

## Where things live

- DB schema (source of truth): `lib/db/src/schema/`
- API contract (source of truth): `lib/api-spec/openapi.yaml` — **regenerate hooks after edits**
- Generated client: `lib/api-client-react/src/generated/`
- Backend routes: `artifacts/api-server/src/routes/`
- Discord/UB clients: `artifacts/api-server/src/lib/`
- Cron jobs: `artifacts/api-server/src/lib/jobs.ts`
- Portal pages: `artifacts/ncrp-portal/src/pages/`
- Layout/HUD: `artifacts/ncrp-portal/src/components/layout/AppLayout.tsx`

## Database migrations

Schema changes ship as generated, checked-in migration files (`lib/db/migrations/`) — do NOT use `drizzle-kit push` against dev or prod anymore (the push scripts remain only for the api-server test harness's throwaway databases). End-to-end flow for a schema change:

1. Edit the schema in `lib/db/src/schema/`.
2. `pnpm --filter @workspace/db run generate` — writes a new SQL file + journal entry under `lib/db/migrations/`. Review the SQL (mind the deploy trap: no expression indexes with space-containing literals; partial-index predicate changes need an explicit DROP/CREATE in the migration since diffs don't alter predicates in place).
3. `pnpm --filter @workspace/db run migrate` — applies it to the dev DB.
4. Commit the migration files together with the schema change.
5. On production deploy, the api-server applies pending migrations at boot (before serving; `REPLIT_DEPLOYMENT=1` gate, advisory-locked for concurrent instances; `artifacts/api-server/src/lib/runMigrations.ts`). A failed migration aborts startup.

Post-merge setup runs `migrate` then re-asserts the append-only history guards (`db:guards`). Baseline: the initial `0000_baseline` migration was marked already-applied on dev + live prod via `pnpm --filter @workspace/scripts run db:baseline-migrations <ENV_VAR_NAME>` (also the tool to baseline any future pre-existing database).

## Architecture decisions

- **OpenAPI-first**: any API change starts in `openapi.yaml`, then `codegen` regenerates typed hooks consumed by the portal.
- **UnbelievaBoat = source of truth** for character wallets; we cache to `wallet_txns` and return `source: "unbelievaboat"` when the upstream is reachable, `"local"` otherwise.
- **Role-gated routes**: middleware checks Discord guild role membership (Admin, Fixer, CS Approver, Ripperdoc, Store Owner). Role IDs come from env-configurable mapping.
- **Sheets workflow**: cap 11 cyberware slots / 6 humanity points at creation; submission posts an embed to `CS_APPROVAL_CHANNEL_ID` via the bot for human review.
- **No emojis anywhere in UI** (per product spec). Visual identity is type-driven Cyberpunk neon (Chakra Petch + Space Mono).

## CI

- `.github/workflows/ci.yml` runs on every PR (and pushes to main). Three jobs: typecheck (`pnpm run typecheck:libs` + portal `typecheck`), codegen drift (`pnpm --filter @workspace/api-spec run codegen` must leave no git diff in `openapi.yaml` / generated clients), and the api-server vitest suite against a Postgres 16 service container (harness creates its own throwaway databases from `DATABASE_URL`; workers self-cap at 4).
- Merge is blocked via GitHub branch protection on `main`, which requires all three CI checks ("Typecheck (libs + portal)", "Codegen drift (OpenAPI clients)", "API server tests"). If a job is renamed in ci.yml, update the required check names in the repo's branch-protection settings too.

## Product

- Discord login → role-based feature gating.
- Personal: dashboard, characters (PC + NPC) with inventory, wallet, status (LOA / attending / open-shop).
- Sheets: submit Cyberpunk Red sheet for CS-Approver review; approver can approve / reject / request changes.
- Directories: public read-only lists of stores and ripperdoc clinics (no stock exposed publicly).
- Management: store owners and ripperdocs edit their own venues, staff, and stock.
- Fixer Hub: fixers create + manage personal NPC roster, view all NPCs.
- Catalogs: guns, cyberware, housing rentals.
- Dice roller with history.
- Admin panel: user list, role sync, manual job runs, wallet adjustments.

## User preferences

- No emojis in UI copy or component output.

## Deployment / Custom domain

- Target domain: `nightcityroleplay.com`.
- Deployment target: **Reserved VM** (`deploymentTarget = "vm"` in `.replit`; always-on; the API server hosts the cron jobs in `lib/jobs.ts`).
- Why not Autoscale (verified 2026-08-18 against live `job_runs`): steady player traffic kept crons firing every hour for 14 straight days, **but** autoscale ran 2 instances concurrently during a scale-out window (2026-08-17 23:55–00:40 UTC) and every cron fired twice per tick. Idempotency guards absorbed it, yet duplicate cron runners are exactly the double-billing failure mode this project has hit before — Reserved VM guarantees a single always-on cron runner. (Brief old/new instance overlap during a redeploy is still possible; crons must keep their idempotency guards.)
- Production secrets that must be set on the deployment (in addition to the dev set): `SESSION_SECRET`, `DISCORD_BOT_TOKEN`, `UNBELIEVABOAT_TOKEN`, `CS_APPROVAL_CHANNEL_ID`, and `PUBLIC_BASE_URL=https://nightcityroleplay.com`.
- After publishing:
  1. Open the Deployments tab → **Custom domains** → add `nightcityroleplay.com`.
  2. Add the A and TXT records Replit shows at the domain registrar; wait for "Verified".
  3. In the Discord developer portal → OAuth2 → add `https://nightcityroleplay.com/api/auth/discord/callback` to the redirect allowlist (keep the dev `.replit.dev` callback too so local login keeps working).
- `getRedirectUri()` in `artifacts/api-server/src/lib/discord.ts` prefers `PUBLIC_BASE_URL` when set, so the callback always matches the live domain regardless of which Replit hostname is first in `REPLIT_DOMAINS`.

## Gotchas

- After editing `openapi.yaml`, you **must** run `pnpm --filter @workspace/api-spec run codegen` or the portal will reference removed/renamed types.
- After editing `lib/db/src/schema/`, run `pnpm exec tsc -b` inside `lib/db` so dependent packages see the new types.
- Tailwind v4: any `@import url(...)` for fonts in `index.css` must come **before** `@import "tailwindcss"`; postcss otherwise rejects it.
- Wallet writes (`/wallet/transfer`, admin adjustments) always go through UnbelievaBoat; only fall back to local on upstream failure.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
- See the `deployment` skill before publishing or wiring up the custom domain.
