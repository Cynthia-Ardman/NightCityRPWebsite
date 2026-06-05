// One-off, phased dev -> LIVE PROD migration tool.
//
// Phases (pass as argv[2]):
//   analyze    (default) read-only divergence report for content/config/history
//   history    insert legacy bot history tables (prod must be empty per table)
//   content    insert-only (ON CONFLICT DO NOTHING) the authored content tables
//   config     insert MISSING bot_config keys only (never overwrites live flags)
//   sequences  reset id sequences on prod to MAX(id) for every touched table
//   guards     apply lib/db/sql/immutable_history.sql to prod + verify triggers
//
// dev  = DATABASE_URL ; prod = LIVE_PROD_DATABASE_URL (Neon, ssl).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDS_SQL = path.resolve(__dirname, "../../lib/db/sql/immutable_history.sql");

const dev = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const prod = new Pool({
  connectionString: process.env.LIVE_PROD_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

// FK-safe order: parents before children.
const CONTENT = [
  "character_tag_options",
  "catalog_districts",
  "catalog_cyberware",
  "catalog_rent",
  "missions",
  "characters",
  "character_status",
  "inventory_items",
  "housing",
  "guidebook_pages",
];
const HISTORY = [
  "bot_attendance_log",
  "bot_balance_history",
  "bot_business_open_log",
  "bot_actor_attendance",
  "bot_rent_payment_events",
];

type Col = { name: string; dataType: string; udt: string };

function stable(v: any): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

async function cols(client: pg.Pool, table: string): Promise<Col[]> {
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => ({ name: r.column_name, dataType: r.data_type, udt: r.udt_name }));
}

async function pk(client: pg.Pool, table: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [`public.${table}`],
  );
  return rows.map((r) => r.attname);
}

function keyOf(row: any, pkCols: string[]): string {
  return pkCols.map((c) => String(row[c])).join("\u0001");
}

async function analyze() {
  console.log("=== CONTENT divergence (dev vs prod, by PK) ===");
  for (const t of CONTENT) {
    const pkCols = await pk(prod, t);
    const d = (await dev.query(`SELECT * FROM "${t}"`)).rows;
    const p = (await prod.query(`SELECT * FROM "${t}"`)).rows;
    const pMap = new Map(p.map((r) => [keyOf(r, pkCols), r]));
    const dMap = new Map(d.map((r) => [keyOf(r, pkCols), r]));
    let onlyDev = 0,
      onlyProd = 0,
      differing = 0;
    const diffCols = new Map<string, number>();
    for (const [k, dr] of dMap) {
      const pr = pMap.get(k);
      if (!pr) {
        onlyDev++;
        continue;
      }
      let rowDiff = false;
      for (const c of Object.keys(dr)) {
        if (stable(dr[c]) !== stable(pr[c])) {
          diffCols.set(c, (diffCols.get(c) ?? 0) + 1);
          rowDiff = true;
        }
      }
      if (rowDiff) differing++;
    }
    for (const k of pMap.keys()) if (!dMap.has(k)) onlyProd++;
    const diffSummary = [...diffCols.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}×${n}`)
      .join(", ");
    console.log(
      `${t.padEnd(22)} pk=${pkCols.join("+")} dev=${d.length} prod=${p.length} | onlyDev=${onlyDev} onlyProd=${onlyProd} differing=${differing}` +
        (diffSummary ? `\n      cols: ${diffSummary}` : ""),
    );
  }

  console.log("\n=== bot_config (dev-only keys + value differences) ===");
  const cfgPk = await pk(prod, "bot_config");
  const dc = (await dev.query(`SELECT * FROM bot_config`)).rows;
  const pc = (await prod.query(`SELECT * FROM bot_config`)).rows;
  const pcMap = new Map(pc.map((r) => [keyOf(r, cfgPk), r]));
  const valCol = Object.keys(dc[0] ?? {}).find((c) => c !== cfgPk[0]) ?? "value";
  for (const r of dc) {
    const k = keyOf(r, cfgPk);
    const pr = pcMap.get(k);
    if (!pr) console.log(`  + MISSING in prod: ${cfgPk.map((c) => r[c]).join("/")} = ${stable(r[valCol])}`);
    else if (stable(r[valCol]) !== stable(pr[valCol]))
      console.log(`  ~ DIFFERS: ${cfgPk.map((c) => r[c]).join("/")} dev=${stable(r[valCol])} prod=${stable(pr[valCol])} (left as-is)`);
  }

  console.log("\n=== HISTORY tables (prod should be 0) ===");
  for (const t of HISTORY) {
    const dN = (await dev.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
    const pN = (await prod.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
    console.log(`  ${t.padEnd(26)} dev=${dN} prod=${pN}${pN > 0 ? "  !! NOT EMPTY — will SKIP" : ""}`);
  }
}

function ph(i: number, col: Col): string {
  const cast =
    col.dataType === "jsonb" || col.dataType === "json" ? "::jsonb" : "";
  return `$${i}${cast}`;
}
function val(col: Col, v: any): any {
  if (v === null || v === undefined) return null;
  if (col.dataType === "jsonb" || col.dataType === "json") return JSON.stringify(v);
  return v;
}

async function insertRows(table: string, doNothing: boolean) {
  const c = await cols(prod, table);
  const d = (await dev.query(`SELECT * FROM "${table}"`)).rows;
  if (d.length === 0) {
    console.log(`  ${table}: 0 dev rows, nothing to do`);
    return 0;
  }
  const colList = c.map((x) => `"${x.name}"`).join(",");
  const client = await prod.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    const CHUNK = 400;
    for (let i = 0; i < d.length; i += CHUNK) {
      const slice = d.slice(i, i + CHUNK);
      const params: any[] = [];
      const tuples = slice.map((row) => {
        const ph2 = c.map((col) => {
          params.push(val(col, row[col.name]));
          return ph(params.length, col);
        });
        return `(${ph2.join(",")})`;
      });
      const sql = `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(",")} ${
        doNothing ? "ON CONFLICT DO NOTHING" : ""
      }`;
      const res = await client.query(sql, params);
      inserted += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log(`  ${table}: inserted ${inserted} / ${d.length} dev rows`);
  return inserted;
}

async function upsertTable(table: string, coalesceCols: Set<string>) {
  const c = await cols(prod, table);
  const pkCols = await pk(prod, table);
  const d = (await dev.query(`SELECT * FROM "${table}"`)).rows;
  if (d.length === 0) {
    console.log(`  ${table}: 0 dev rows, nothing to do`);
    return;
  }
  const colNames = new Set(c.map((x) => x.name));
  for (const cc of coalesceCols)
    if (!colNames.has(cc)) throw new Error(`coalesce col ${cc} missing on ${table}`);
  const colList = c.map((x) => `"${x.name}"`).join(",");
  const setClause = c
    .filter((x) => !pkCols.includes(x.name))
    .map((x) =>
      coalesceCols.has(x.name)
        ? `"${x.name}"=COALESCE("${table}"."${x.name}",EXCLUDED."${x.name}")`
        : `"${x.name}"=EXCLUDED."${x.name}"`,
    )
    .join(",");
  const conflict = pkCols.map((p) => `"${p}"`).join(",");
  const client = await prod.connect();
  let affected = 0;
  try {
    await client.query("BEGIN");
    const CHUNK = 300;
    for (let i = 0; i < d.length; i += CHUNK) {
      const slice = d.slice(i, i + CHUNK);
      const params: any[] = [];
      const tuples = slice.map((row) => {
        const ph2 = c.map((col) => {
          params.push(val(col, row[col.name]));
          return ph(params.length, col);
        });
        return `(${ph2.join(",")})`;
      });
      const sql = `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(
        ",",
      )} ON CONFLICT (${conflict}) DO UPDATE SET ${setClause}`;
      const res = await client.query(sql, params);
      affected += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log(`  ${table}: upserted ${affected} rows (coalesce: ${[...coalesceCols].join(",") || "none"})`);
}

async function resetSequences(tables: string[]) {
  for (const t of tables) {
    const hasId = (
      await prod.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`,
        [t],
      )
    ).rowCount;
    if (!hasId) {
      console.log(`  ${t}: no id column (skip)`);
      continue;
    }
    const seqRes = await prod.query(`SELECT pg_get_serial_sequence($1,'id') AS seq`, [`public.${t}`]);
    const seq = seqRes.rows[0]?.seq;
    if (!seq) {
      console.log(`  ${t}: no id sequence (skip)`);
      continue;
    }
    const maxRes = await prod.query(`SELECT COALESCE(MAX(id),0)::bigint AS m FROM "${t}"`);
    const m = Number(maxRes.rows[0].m);
    if (m > 0) {
      await prod.query(`SELECT setval($1, $2, true)`, [seq, m]);
      console.log(`  ${t}: ${seq} -> ${m}`);
    } else {
      console.log(`  ${t}: empty, sequence left as-is`);
    }
  }
}

async function applyGuards() {
  const sql = fs.readFileSync(GUARDS_SQL, "utf8");
  const client = await prod.connect();
  try {
    await client.query(sql);
    const trg = await client.query(`
      SELECT c.relname tbl, count(*)::int n FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND t.tgname LIKE 'trg_ncrp_block%' AND NOT t.tgisinternal
       GROUP BY c.relname ORDER BY c.relname`);
    console.log("Guard triggers now on prod:");
    for (const r of trg.rows) console.log(`  - ${r.tbl}: ${r.n} trigger(s)`);
  } finally {
    client.release();
  }
}

async function main() {
  const phase = process.argv[2] ?? "analyze";
  console.log(`>>> phase: ${phase}\n`);
  if (phase === "analyze") await analyze();
  else if (phase === "history") {
    for (const t of HISTORY) {
      const pN = (await prod.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
      if (pN > 0) {
        console.log(`  ${t}: prod NOT empty (${pN}) — SKIP`);
        continue;
      }
      await insertRows(t, true);
    }
  } else if (phase === "content") {
    for (const t of CONTENT) {
      if (t === "characters") await upsertTable(t, new Set(["owner_id"]));
      else await insertRows(t, true);
    }
  } else if (phase === "config") {
    await insertRows("bot_config", true);
  } else if (phase === "sequences") {
    await resetSequences([...CONTENT, ...HISTORY]);
  } else if (phase === "guards") {
    await applyGuards();
  } else {
    console.error(`unknown phase: ${phase}`);
    process.exit(1);
  }
  await dev.end();
  await prod.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
