import pg from "pg";

const dev = new pg.Client({ connectionString: process.env.DATABASE_URL });
const prod = new pg.Client({ connectionString: process.env.LIVE_PROD_DATABASE_URL });
await dev.connect();
await prod.connect();

const tables = (
  await dev.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  )
).rows.map((r) => r.tablename);

console.log("Row counts (dev vs prod) — table: dev | prod | diff");
console.log("─".repeat(70));
for (const t of tables) {
  try {
    const d = (await dev.query(`SELECT count(*)::int AS c FROM "${t}"`)).rows[0].c;
    let p: number | string;
    try {
      p = (await prod.query(`SELECT count(*)::int AS c FROM "${t}"`)).rows[0].c;
    } catch {
      p = "(missing in prod)";
    }
    const diff = typeof p === "number" ? d - p : "—";
    const marker = typeof diff === "number" && diff !== 0 ? "  ⚠" : "";
    console.log(`  ${t.padEnd(30)} ${String(d).padStart(6)} | ${String(p).padStart(15)} | ${String(diff).padStart(6)}${marker}`);
  } catch (e: any) {
    console.log(`  ${t}: error ${e.message}`);
  }
}

await dev.end();
await prod.end();
