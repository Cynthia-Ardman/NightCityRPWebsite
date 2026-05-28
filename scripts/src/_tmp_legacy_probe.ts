import pg from "pg";

const url = process.env.PROD_DATABASE_URL;
if (!url) throw new Error("PROD_DATABASE_URL not set");

async function main() {
  const pool = new pg.Pool({ connectionString: url });
  try {
    for (const t of ["actor_attendance", "mission_log", "mission_event"]) {
      const cols = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position;`, [t]);
      console.log(`\n${t} COLUMNS: ${cols.rows.map(r => r.column_name).join(", ")}`);
    }

    // Try to find vinnybot, ghosted_stoner, pizzakev, lorddepresso in any username field
    const probe = await pool.query(`
      SELECT DISTINCT user_id, username FROM actor_attendance
      WHERE lower(username) IN ('vinnybot<3','ghosted_stoner','pizzakev','lorddepressotm')
      LIMIT 20;
    `);
    console.log("\nactor_attendance matches:");
    for (const r of probe.rows) console.log(JSON.stringify(r));

    const probe2 = await pool.query(`
      SELECT DISTINCT user_id, username FROM mission_log
      WHERE lower(username) IN ('vinnybot<3','ghosted_stoner','pizzakev','lorddepressotm')
      LIMIT 20;
    `);
    console.log("\nmission_log matches:");
    for (const r of probe2.rows) console.log(JSON.stringify(r));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
