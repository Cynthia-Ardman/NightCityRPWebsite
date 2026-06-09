# Implementation Plan - Night City RP Portal Integration & Optimization

This plan addresses three performance and scalability issues identified in the transition to the remote IDE session on Host B (`thalamus`).

---

## User Review Required

> [!IMPORTANT]
> **Database Column Addition**: This plan introduces a new column `cyberware_points` to the `characters` table. We will apply this schema change using `pnpm run push` (which executes `drizzle-kit push`). No data migration script is strictly required, as we will run a one-time backfill script or trigger updates to populate this column for existing characters.

---

## Open Questions

None. The issues and targeted fixes are well-defined.

---

## Proposed Changes

### Database Layer

#### [MODIFY] [index.ts](file:///home/minnbicchi/NightCityRPWebsite/lib/db/src/schema/index.ts)
- Add `cyberwarePoints: integer("cyberware_points").notNull().default(0)` to the `characters` table definition.

---

### Core API Server & Libraries

#### [MODIFY] [cyberware.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/lib/cyberware.ts)
- Import `characters` and `eq` from `@workspace/db` and `"drizzle-orm"`.
- Implement a helper `updateCharacterCwp(characterId: number, tx: any = db): Promise<number>` that sums CWP for a character's inventory and updates the `cyberwarePoints` column.

#### [MODIFY] [unbelievaboat.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/lib/unbelievaboat.ts)
- Add an in-memory cache map `balanceCache` with a 60-second TTL (Time to Live).
- Import `db` and `users` from `@workspace/db` and `eq` from `"drizzle-orm"`.
- Modify `getBalance` to check the cache first. On cache miss, fetch from the UnbelievaBoat API.
- If the fetch fails (or times out), query the database-cached balance `users.walletBalance` and return it with `source: "local"`.
- If the fetch succeeds, update `balanceCache`.
- Update `patchBalance` to update or invalidate the cache entry on modification.

---

### Route Handlers

#### [MODIFY] [offers.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/routes/offers.ts)
- Re-architect `offers/mine` and `/stores/:id/offers` / `/ripperdocs/:id/offers` list routes to perform a single query joining `saleOffers` with `stores`, `ripperdocs`, and `characters` (buyers). This reduces $1 + 2N$ queries to exactly $1$.
- Keep the single get `/offers/:id` route using the joined query or direct shape for single-item lookups.

#### [MODIFY] [dashboard.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/routes/dashboard.ts)
- Ensure the `/dashboard/summary` endpoint utilizes the optimized `getBalance` function, preventing synchronous blocking if the UnbelievaBoat external API is unresponsive.

#### [MODIFY] [directory.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/routes/directory.ts)
- Optimize the staff `/directory/archive` and `/directory/archive/:id` routes. Read `cyberwarePoints` directly from the `characters` column instead of calling `sumCwpByCharacter` and parsing regexes for up to 2000 character rows.

#### [MODIFY] [characters.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/routes/characters.ts)
- In the inventory routes (`POST /characters/:id/inventory`, `PATCH /characters/:cid/inventory/:itemId`, `DELETE /characters/:cid/inventory/:itemId`, `POST /characters/:cid/inventory/:itemId/transfer`), call `updateCharacterCwp` on modification to keep `cyberwarePoints` in sync.

#### [MODIFY] [sheets.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/routes/sheets.ts)
- In the sheet materialization flow (`materializeCharacterFromSheet`), invoke `updateCharacterCwp` after seeding the character's initial inventory.

#### [MODIFY] [saleOffers.ts](file:///home/minnbicchi/NightCityRPWebsite/artifacts/api-server/src/lib/saleOffers.ts)
- In `completeSaleOffer`, call `updateCharacterCwp` when cyberware is installed or removed from a character's active inventory.

---

### Scripting & One-Time Backfill

#### [NEW] [backfill-cwp.ts](file:///home/minnbicchi/NightCityRPWebsite/scripts/backfill-cwp.ts)
- A simple script to compute CWP for all existing characters in the DB and backfill their `cyberwarePoints` column.

---

## Verification Plan

### Automated Tests
- We will run existing test suites to verify no regressions:
  ```bash
  pnpm run typecheck
  pnpm --filter "artifacts/api-server" test
  ```
- Run the new backfill script:
  ```bash
  npx tsx scripts/backfill-cwp.ts
  ```

### Manual Verification
- Verify that directory listing performs in under 50ms instead of blocking for multiple seconds.
- Verify that the dashboard load is near-instant, falling back to local DB balance or serving from cache.
