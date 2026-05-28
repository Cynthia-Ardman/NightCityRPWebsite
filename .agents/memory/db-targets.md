---
name: NCRP database targets
description: Three distinct databases — DATABASE_URL, PROD_DATABASE_URL, and the live deployed prod DB — easy to confuse.
---

In this project there are **three** Postgres databases, not two:

1. `DATABASE_URL` — development portal DB. Modern schema (`users`, `characters`, `housing`, etc). Drizzle is generated against this.
2. `PROD_DATABASE_URL` — the **legacy NightCityBot Python DB**. Read-only source for the one-time `scripts/src/import-prod.ts` migration. Completely different schema: `wholesaler_shops`, `balance_history`, `cyberware_status`, no `users` table at all. **NEVER point Drizzle code at this URL.**
3. The **live deployed prod DB** (the one nightcityroleplay.com actually uses) — managed by Replit Deployments. No connection string exposed as a secret. Reachable read-only via `executeSql({environment:"production"})`. Schema changes go through the Publish flow, not migration scripts.

**Why:** the user originally set up `PROD_DATABASE_URL` for one-time data migration FROM the old bot. The name implies "prod target" but it is "legacy source". Confusing it costs an hour.

**How to apply:**
- For any *write* against the live deployed DB, ask the user to add a separate secret (e.g. `LIVE_PROD_DATABASE_URL`) by copying it from the Deployments → Database tab.
- For any *read* against the live deployed DB, use `executeSql({environment:"production"})`.
- For schema changes against the live deployed DB, instruct the user to Publish — don't write migration scripts.
