import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Managed Postgres (Neon) periodically terminates idle backend connections
// ("terminating connection due to administrator command", e.g. on compute
// restarts/scaling). node-postgres emits that as an 'error' event on the pool
// for the affected IDLE client; with no listener attached, Node treats it as
// an unhandled 'error' event and hard-crashes the whole server (took prod down
// 2026-07-18). The client is already broken at that point — logging is all
// that's needed; the pool discards the dead client and new queries get fresh
// connections. Errors on clients with an active query still propagate to that
// query's caller as normal — this handler only covers idle clients.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[pg pool] idle client error (connection dropped by server):", err.message);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./walletCategory";
