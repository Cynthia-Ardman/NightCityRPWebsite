import pg from "pg";
const { Pool } = pg;

const devPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const prodPool = new Pool({
  connectionString: process.env.LIVE_PROD_DATABASE_URL,
  max: 4,
  ssl: { rejectUnauthorized: false },
});

async function q(pool: pg.Pool, sql: string): Promise<any[]> {
  const c = await pool.connect();
  try {
    await c.query("SET statement_timeout = '30s'");
    const r = await c.query(sql);
    return r.rows;
  } finally {
    c.release();
  }
}

async function main() {
  const tblSql =
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name";
  const [devTbls, prodTbls] = await Promise.all([q(devPool, tblSql), q(prodPool, tblSql)]);
  const devSet = new Set(devTbls.map((r) => r.table_name));
  const prodSet = new Set(prodTbls.map((r) => r.table_name));
  const onlyDev = [...devSet].filter((t) => !prodSet.has(t));
  const onlyProd = [...prodSet].filter((t) => !devSet.has(t));
  const common = [...devSet].filter((t) => prodSet.has(t));

  console.log("=== TABLE COUNTS ===");
  console.log(`dev tables: ${devSet.size} | prod tables: ${prodSet.size} | common: ${common.length}`);
  console.log("TABLES ONLY IN DEV:", onlyDev.length ? onlyDev.join(", ") : "(none)");
  console.log("TABLES ONLY IN PROD:", onlyProd.length ? onlyProd.join(", ") : "(none)");

  const colSql =
    "SELECT table_name, column_name, data_type, is_nullable, COALESCE(column_default,'') AS column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position";
  const [devCols, prodCols] = await Promise.all([q(devPool, colSql), q(prodPool, colSql)]);
  const key = (c: any) => `${c.table_name}.${c.column_name}`;
  const devColMap = new Map(devCols.map((c) => [key(c), c]));
  const prodColMap = new Map(prodCols.map((c) => [key(c), c]));

  const colOnlyDev: string[] = [];
  const colOnlyProd: string[] = [];
  const colChanged: string[] = [];
  for (const [k, c] of devColMap) {
    if (!common.includes(c.table_name)) continue;
    const p = prodColMap.get(k);
    if (!p) {
      colOnlyDev.push(k);
      continue;
    }
    if (c.data_type !== p.data_type || c.is_nullable !== p.is_nullable || c.column_default !== p.column_default) {
      colChanged.push(
        `${k}: dev(${c.data_type},null=${c.is_nullable},def=${c.column_default}) vs prod(${p.data_type},null=${p.is_nullable},def=${p.column_default})`,
      );
    }
  }
  for (const [k, p] of prodColMap) {
    if (!common.includes(p.table_name)) continue;
    if (!devColMap.has(k)) colOnlyProd.push(k);
  }
  console.log("\n=== COLUMN DIFFS (common tables) ===");
  console.log("COLUMNS ONLY IN DEV:", colOnlyDev.length ? colOnlyDev.join(", ") : "(none)");
  console.log("COLUMNS ONLY IN PROD:", colOnlyProd.length ? colOnlyProd.join(", ") : "(none)");
  console.log("COLUMNS CHANGED:", colChanged.length ? "\n  - " + colChanged.join("\n  - ") : "(none)");

  const allTables = [...new Set([...devSet, ...prodSet])].sort();
  function countQuery(tables: string[]) {
    return tables.map((t) => `SELECT '${t}' AS t, count(*)::int AS c FROM "${t}"`).join(" UNION ALL ");
  }
  const [devCounts, prodCounts] = await Promise.all([
    q(devPool, countQuery([...devSet])),
    q(prodPool, countQuery([...prodSet])),
  ]);
  const devCountMap = new Map(devCounts.map((r) => [r.t, r.c]));
  const prodCountMap = new Map(prodCounts.map((r) => [r.t, r.c]));

  console.log("\n=== ROW COUNTS (table | dev | prod | delta dev-prod) ===");
  const rows = allTables.map((t) => {
    const d = devCountMap.get(t);
    const p = prodCountMap.get(t);
    return { t, dev: d === undefined ? "-" : d, prod: p === undefined ? "-" : p, delta: (d ?? 0) - (p ?? 0) };
  });
  for (const r of rows) {
    const flag = r.dev === "-" || r.prod === "-" ? "  (table missing one side)" : r.delta === 0 ? "" : r.delta > 0 ? `  DEV +${r.delta}` : `  PROD +${-r.delta}`;
    console.log(`${r.t.padEnd(34)} ${String(r.dev).padStart(8)} ${String(r.prod).padStart(8)}${flag}`);
  }

  await devPool.end();
  await prodPool.end();
  console.log("\n(done)");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
