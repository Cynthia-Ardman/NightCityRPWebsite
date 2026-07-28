import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("neon.tech")) throw new Error("Refusing: DATABASE_URL is not the expected neon host");
  if (process.env.ALLOW_EXTERNAL_WRITES !== "1") throw new Error("Refusing: set ALLOW_EXTERNAL_WRITES=1");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", (e) => console.error("pool error", e));
  try {
    const res = await pool.query(
      `UPDATE store_stock ss
         SET power_level = g.power_level,
             cyberware_req = COALESCE(ss.cyberware_req, NULLIF(g.cyberware_req, ''))
        FROM catalog_guns g
       WHERE lower(g.name) = lower(ss.name)
         AND ss.power_level IS NULL
         AND g.power_level IS NOT NULL
      RETURNING ss.id, ss.name, ss.power_level, ss.cyberware_req`
    );
    console.log("updated rows:", res.rowCount);
    for (const r of res.rows) console.log(r);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
