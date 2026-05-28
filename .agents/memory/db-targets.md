---
name: NCRP database targets
description: Three Postgres DBs are reachable from this workspace — which is which, and which one the live site actually uses.
---

This workspace can reach THREE distinct Postgres databases. Mixing them up has cost real time. Always confirm the host before any write.

- `DATABASE_URL` → **dev DB** (Replit-managed helium*). NOT connected to anything live. Local workflows (api-server, ncrp-portal:web) read this.
- `LIVE_PROD_DATABASE_URL` → **live prod DB** (Neon `ep-*.neon.tech`). This is what nightcityroleplay.com actually reads/writes. All "real" data lives here.
- `PROD_DATABASE_URL` → **legacy** NightCityBot uuid-keyed DB. Different schema (uuid PKs, not the portal's serial ints). NOT used by the live site. Treat as read-only historical source for backfills only.

**Why:** earlier in the project all "import to prod" work landed in `DATABASE_URL` (dev) by accident because the env name `PROD_DATABASE_URL` made it sound like the live target. It is not.

**How to apply:**
- Any write that's supposed to hit the live site MUST use `LIVE_PROD_DATABASE_URL`.
- `scripts/sync-from-prod.ts` reads from `LIVE_PROD_DATABASE_URL` and overwrites dev — run it to make dev mirror prod for testing.
- `scripts/src/import-cyberware-inventory.ts` has an `assertTargetDbAllowed()` guard: refuses to run against a non-helium host unless `IMPORT_TARGET=prod` is also set. Apply the same guard pattern to any future destructive importer.
- Replit's standard "publish-time schema diff dev→prod" does NOT apply to this project — the live DB is on Neon, not Replit-managed. Schema/data changes for prod must be applied explicitly via a script pointed at `LIVE_PROD_DATABASE_URL`.
