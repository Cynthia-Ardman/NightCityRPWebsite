// One-off: inventory item 8744 (Anastasia "Persona" Aran — Subdermal Plating)
// was installed via a ripperdoc offer created with CWP 0 (item not in catalog,
// no auto-fill). Community-wide the item is CWP 2. Fix the note in place.
//
// Run:
//   DATABASE_URL="$LIVE_PROD_DATABASE_URL" ALLOW_EXTERNAL_WRITES=1 \
//     pnpm --filter @workspace/api-server exec tsx src/scripts/fix-subdermal-plating-cwp.ts
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  if (process.env.ALLOW_EXTERNAL_WRITES !== "1") throw new Error("ALLOW_EXTERNAL_WRITES=1 required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query(
      `UPDATE inventory_items
         SET notes = replace(notes, 'CWP 0 ·', 'CWP 2 ·')
       WHERE id = 8744
         AND name = 'Subdermal Plating'
         AND notes LIKE 'CWP 0 ·%'
       RETURNING id, name, notes`,
    );
    console.log(`Updated ${res.rowCount} row(s):`, res.rows);
  } finally {
    await client.end();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
