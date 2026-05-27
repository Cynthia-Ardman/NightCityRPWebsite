# Night City RP Portal

Web portal for the Night City RP Cyberpunk Discord community — replaces the legacy NightCityBot bot. Discord OAuth login with role sync, character management (PCs and NPCs), inventory, wallet (UnbelievaBoat as source of truth), shop/clinic management, public directories, Cyberpunk Red character sheets with CS-Approver review flow, dice roller, and an admin panel.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/ncrp-portal run dev` — run the React portal
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate React Query hooks + Zod schemas from `lib/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
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

## Architecture decisions

- **OpenAPI-first**: any API change starts in `openapi.yaml`, then `codegen` regenerates typed hooks consumed by the portal.
- **UnbelievaBoat = source of truth** for character wallets; we cache to `wallet_txns` and return `source: "unbelievaboat"` when the upstream is reachable, `"local"` otherwise.
- **Role-gated routes**: middleware checks Discord guild role membership (Admin, Fixer, CS Approver, Ripperdoc, Store Owner). Role IDs come from env-configurable mapping.
- **Sheets workflow**: cap 11 cyberware slots / 6 humanity points at creation; submission posts an embed to `CS_APPROVAL_CHANNEL_ID` via the bot for human review.
- **No emojis anywhere in UI** (per product spec). Visual identity is type-driven Cyberpunk neon (Chakra Petch + Space Mono).

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
- Deployment target: **Reserved VM** (always-on; the API server hosts the cron jobs in `lib/jobs.ts` — Autoscale would put them to sleep between requests).
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
