// One-off: additively add the UB cash/bank snapshot columns to the LIVE prod
// DB (Neon). Prod schema changes must be applied explicitly (no publish-time
// diff for this project). Idempotent: ADD COLUMN IF NOT EXISTS only.
import pg from "pg";

const DST = process.env.LIVE_PROD_DATABASE_URL;
if (!DST) {
  console.error("Missing LIVE_PROD_DATABASE_URL");
  process.exit(1);
}
const host = new URL(DST).hostname;
if (!host.includes("neon.tech")) {
  console.error(`Refusing: LIVE_PROD_DATABASE_URL host looks wrong: ${host}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DST, max: 1 });
pool.on("error", (e) => console.error("pool idle error", e.message));

pool
  .query(
    `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS last_synced_ub_cash integer,
       ADD COLUMN IF NOT EXISTS last_synced_ub_bank integer;`
  )
  .then(async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users' AND column_name LIKE 'last_synced_ub%' ORDER BY 1`
    );
    console.log("prod users columns:", rows.map((r) => r.column_name).join(", "));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
