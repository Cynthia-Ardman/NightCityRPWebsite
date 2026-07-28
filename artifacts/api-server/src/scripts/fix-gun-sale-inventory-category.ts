import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("neon.tech")) throw new Error("Refusing: DATABASE_URL is not the expected neon host");
  if (process.env.ALLOW_EXTERNAL_WRITES !== "1") throw new Error("Refusing: set ALLOW_EXTERNAL_WRITES=1");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", (e) => console.error("pool error", e));
  try {
    const res = await pool.query(
      `UPDATE inventory_items
         SET category = 'gun',
             notes = COALESCE(NULLIF(notes, ''), 'Category: Power · Power: M')
       WHERE id IN (8889, 8890)
         AND character_id = 616
         AND category = 'Power'
      RETURNING id, name, category, notes`
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
