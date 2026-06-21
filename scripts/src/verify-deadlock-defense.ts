// READ-ONLY verification for Task #267 (Convert Deadlock Defense to a gun store).
// Inspects the LIVE prod DB (LIVE_PROD_DATABASE_URL) for the character, owner,
// the existing off-map business lease (housing id 44), and any existing store.
import pg from "pg";

const CHARACTER_ID = 139;
const OWNER_DISCORD_ID = "262434049862270976";
const HOUSING_ID = 44;
const STORE_NAME = "Deadlock Defense";

async function main() {
  const url = process.env.LIVE_PROD_DATABASE_URL;
  if (!url) {
    console.error("LIVE_PROD_DATABASE_URL not set");
    process.exit(1);
  }
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const char = await c.query(
      `SELECT id, name, kind, owner_id, claimed, approved, life_status FROM characters WHERE id = $1`,
      [CHARACTER_ID],
    );
    console.log("CHARACTER 139:", JSON.stringify(char.rows, null, 2));

    const owner = await c.query(
      `SELECT id, discord_id, username FROM users WHERE id = $1 OR discord_id = $1`,
      [OWNER_DISCORD_ID],
    );
    console.log("OWNER user:", JSON.stringify(owner.rows, null, 2));

    const lease = await c.query(
      `SELECT id, character_id, listing_id, address, district, tier, monthly_rent, kind FROM housing WHERE id = $1`,
      [HOUSING_ID],
    );
    console.log("HOUSING 44:", JSON.stringify(lease.rows, null, 2));

    const storesByName = await c.query(
      `SELECT id, owner_id, owner_character_id, name, kind, location, housing_id, balance, created_at FROM stores WHERE name ILIKE $1`,
      [STORE_NAME],
    );
    console.log("STORES named Deadlock Defense:", JSON.stringify(storesByName.rows, null, 2));

    const storesByChar = await c.query(
      `SELECT id, owner_id, owner_character_id, name, kind FROM stores WHERE owner_character_id = $1`,
      [CHARACTER_ID],
    );
    console.log("STORES owned by character 139:", JSON.stringify(storesByChar.rows, null, 2));

    const ripByChar = await c.query(
      `SELECT id, owner_id, owner_character_id, name FROM ripperdocs WHERE owner_character_id = $1`,
      [CHARACTER_ID],
    );
    console.log("RIPPERDOCS owned by character 139:", JSON.stringify(ripByChar.rows, null, 2));

    const cols = await c.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='stores' ORDER BY ordinal_position`,
    );
    console.log("STORES columns:", JSON.stringify(cols.rows, null, 2));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
