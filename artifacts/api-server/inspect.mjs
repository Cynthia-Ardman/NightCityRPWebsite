import pg from "pg";
const url = process.env.PROD_DATABASE_URL;
const devUrl = process.env.DATABASE_URL;
console.log("PROD host:", url?.match(/@([^/]+)/)?.[1]);
console.log("DEV  host:", devUrl?.match(/@([^/]+)/)?.[1]);
console.log("same url?", url === devUrl);
const pool = new pg.Pool({ connectionString: url });
try {
  const t = await pool.query("SELECT count(*)::int as n FROM information_schema.tables WHERE table_schema='public'");
  console.log("prod public tables:", t.rows[0].n);
  try {
    const c = await pool.query("SELECT count(*)::int as total, count(*) FILTER (WHERE kind='npc')::int as npcs FROM characters");
    console.log("prod characters total:", c.rows[0].total, "npcs:", c.rows[0].npcs);
  } catch (e) { console.log("characters table err:", e.message); }
} catch (e) { console.log("ERR:", e.message); }
await pool.end();
