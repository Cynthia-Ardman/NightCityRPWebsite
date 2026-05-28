import pg from "pg";
const dev = new pg.Client({ connectionString: process.env.DATABASE_URL });
const prod = new pg.Client({ connectionString: process.env.LIVE_PROD_DATABASE_URL });
await dev.connect(); await prod.connect();

async function cols(c: pg.Client) {
  return (await c.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' ORDER BY table_name, ordinal_position`,
  )).rows;
}
const dCols = await cols(dev);
const pCols = await cols(prod);
const key = (r: any) => `${r.table_name}.${r.column_name}`;
const pSet = new Set(pCols.map(key));
const dSet = new Set(dCols.map(key));
console.log("=== SCHEMA DRIFT ===");
console.log("Columns in DEV but not in PROD:");
for (const r of dCols) if (!pSet.has(key(r))) console.log(`  + ${r.table_name}.${r.column_name} (${r.data_type})`);
console.log("Columns in PROD but not in DEV:");
for (const r of pCols) if (!dSet.has(key(r))) console.log(`  - ${r.table_name}.${r.column_name} (${r.data_type})`);

console.log("\n=== bot_config diff ===");
const dCfg = await dev.query(`SELECT key, value::text FROM bot_config ORDER BY key`);
const pCfg = await prod.query(`SELECT key, value::text FROM bot_config ORDER BY key`);
const pKeys = new Set(pCfg.rows.map((r) => r.key));
const dKeys = new Set(dCfg.rows.map((r) => r.key));
console.log("Only in DEV:");
for (const r of dCfg.rows) if (!pKeys.has(r.key)) console.log(`  ${r.key} = ${r.value}`);
console.log("Only in PROD:");
for (const r of pCfg.rows) if (!dKeys.has(r.key)) console.log(`  ${r.key} = ${r.value}`);
console.log("Different values:");
const pMap = new Map(pCfg.rows.map((r) => [r.key, r.value]));
for (const r of dCfg.rows) {
  const pv = pMap.get(r.key);
  if (pv !== undefined && pv !== r.value) console.log(`  ${r.key}:\n    dev:  ${r.value}\n    prod: ${pv}`);
}

await dev.end(); await prod.end();
