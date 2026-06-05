// READ-ONLY diagnostic: compare verified18 state between dev and live prod.
import pg from "pg";

const dev = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const prod = new pg.Pool({
  connectionString: process.env.LIVE_PROD_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

async function report(name: string, p: pg.Pool) {
  const tot = (await p.query(`SELECT count(*)::int n FROM users`)).rows[0].n;
  const v = (await p.query(`SELECT count(*)::int n FROM users WHERE verified18 IS TRUE`)).rows[0].n;
  const nullRoles = (await p.query(`SELECT count(*)::int n FROM users WHERE roles IS NULL OR array_length(roles,1) IS NULL`)).rows[0].n;
  const synced = (await p.query(`SELECT count(*)::int n FROM users WHERE roles_synced_at IS NOT NULL`)).rows[0].n;
  console.log(`\n=== ${name} ===`);
  console.log(`  users=${tot}  verified18=true:${v}  roles-empty:${nullRoles}  roles_synced_at set:${synced}`);
  const recent = (
    await p.query(
      `SELECT id, username, verified18, login_count,
              array_length(roles,1) AS nroles,
              roles_synced_at,
              (SELECT count(*) FROM unnest(roles) r WHERE lower(r) LIKE '%18%' OR lower(r) LIKE '%verif%')::int AS verifish
         FROM users
        ORDER BY roles_synced_at DESC NULLS LAST
        LIMIT 8`,
    )
  ).rows;
  console.log(`  most-recently role-synced:`);
  for (const r of recent)
    console.log(
      `    ${String(r.username).padEnd(22)} v18=${String(r.verified18).padEnd(5)} nroles=${r.nroles ?? 0} verif-ish-role=${r.verifish} logins=${r.login_count} synced=${r.roles_synced_at?.toISOString?.() ?? r.roles_synced_at}`,
    );
}

async function main() {
  await report("DEV", dev);
  await report("LIVE PROD", prod);
  await dev.end();
  await prod.end();
  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
