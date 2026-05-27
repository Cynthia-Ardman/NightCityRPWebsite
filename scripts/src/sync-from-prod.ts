import pg from "pg";

/**
 * Copies live data from the production database into the development database
 * so devs can work with realistic data without writing fixtures by hand.
 *
 * Requires two env vars:
 *   - DATABASE_URL      → the dev DB (the destination)
 *   - PROD_DATABASE_URL → the prod DB (the source, read-only is fine)
 *
 * Run with:  pnpm --filter @workspace/scripts run sync-from-prod
 *
 * Tables intentionally skipped:
 *   - catalog_rent        prod has none; the rent spreadsheet is the source.
 *                         Run `pnpm --filter @workspace/scripts run
 *                         seed-catalogs` after this to fill it.
 *   - user_sessions       auth cookies; copying them just bloats dev.
 *   - inventory_items     prod tracks ownership by user (owner_id); dev tracks
 *                         it by character (character_id NOT NULL). Needs a
 *                         user→character mapping pass before we can copy.
 *   - wallet_transactions same: prod uses user_id, dev requires character_id.
 *   - tables empty in prod (housing, ripperdocs, character_sheets, etc.)
 *
 * When copying, columns that exist in prod but not dev (e.g. inventory's
 * owner_id) are dropped automatically — we intersect column sets per table.
 */

const { Pool } = pg;

// Order matters — parents before children so FKs validate during insert.
// TRUNCATE ... CASCADE on the first call wipes every dependent table in one
// shot, which is fine for dev.
const TABLES: readonly string[] = [
  "users",
  "characters",
  "stores",
  "store_stock",
  "mission_log",
  "bot_config",
  "catalog_guns",
  "catalog_cyberware",
];

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to use unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

type ColInfo = { name: string; type: string };

async function fetchColumns(
  client: pg.Pool | pg.PoolClient,
  table: string,
): Promise<ColInfo[]> {
  const r = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((row: { column_name: string; data_type: string }) => ({
    name: row.column_name,
    type: row.data_type,
  }));
}

function coerce(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (type === "ARRAY") return Array.isArray(value) ? value : [value];
  if (type === "jsonb" || type === "json") {
    // Always stringify — pg sends strings/numbers/booleans as their JS type
    // otherwise, and Postgres rejects them as "invalid input syntax for type
    // json" because it expects the wire value to be a JSON-encoded string.
    return JSON.stringify(value);
  }
  return value;
}

async function syncTable(
  prod: pg.Pool,
  dev: pg.PoolClient,
  table: string,
): Promise<number> {
  const t = quoteIdent(table);
  const devCols = await fetchColumns(dev as unknown as pg.Pool, table);
  const devColNames = new Set(devCols.map((c) => c.name));
  const prodCols = (await fetchColumns(prod, table)).filter((c) =>
    devColNames.has(c.name),
  );
  if (prodCols.length === 0) {
    console.log(`  ${table}: no overlapping columns, skipping`);
    return 0;
  }
  const selectList = prodCols.map((c) => quoteIdent(c.name)).join(", ");
  const { rows } = await prod.query(`SELECT ${selectList} FROM ${t}`);
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows in prod, skipping insert`);
    return 0;
  }
  const colList = prodCols.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = prodCols.map((_, i) => `$${i + 1}`).join(", ");
  const insertSql = `INSERT INTO ${t} (${colList}) VALUES (${placeholders})`;
  for (const r of rows) {
    await dev.query(
      insertSql,
      prodCols.map((c) => coerce(r[c.name], c.type)),
    );
  }
  const idCol = prodCols.find((c) => c.name === "id");
  if (idCol && idCol.type === "integer") {
    await dev.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         COALESCE((SELECT MAX(id) FROM ${t}), 1),
         (SELECT MAX(id) IS NOT NULL FROM ${t})
       )`,
      [table],
    );
  }
  console.log(`  ${table}: ${rows.length} rows copied`);
  return rows.length;
}

async function main() {
  const devUrl = process.env.DATABASE_URL;
  const prodUrl = process.env.PROD_DATABASE_URL;
  if (!devUrl) throw new Error("DATABASE_URL is not set");
  if (!prodUrl) {
    throw new Error(
      "PROD_DATABASE_URL is not set. Grab the prod connection string from " +
        "the Deployments dashboard and add it as a workspace secret.",
    );
  }
  if (prodUrl === devUrl) {
    throw new Error(
      "PROD_DATABASE_URL must be different from DATABASE_URL — refusing to " +
        "truncate and reimport the same database into itself.",
    );
  }

  const prod = new Pool({ connectionString: prodUrl, max: 2 });
  const dev = new Pool({ connectionString: devUrl, max: 2 });
  const devClient = await dev.connect();
  try {
    await devClient.query("BEGIN");
    const truncateList = TABLES.map(quoteIdent).join(", ");
    await devClient.query(
      `TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`,
    );
    let total = 0;
    for (const table of TABLES) {
      total += await syncTable(prod, devClient, table);
    }
    await devClient.query("COMMIT");
    console.log(`Sync complete — ${total} rows copied across ${TABLES.length} tables.`);
  } catch (err) {
    await devClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    devClient.release();
    await Promise.all([prod.end(), dev.end()]);
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exitCode = 1;
});
