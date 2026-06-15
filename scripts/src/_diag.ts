import { Pool } from "pg";

const url = process.env.LIVE_PROD_DATABASE_URL;
if (!url) {
  console.error("LIVE_PROD_DATABASE_URL not set");
  process.exit(1);
}
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  // ---- 1. Washi_56 fixer issue ----
  console.log("===== WASHI_56 USER ROW =====");
  const u = await pool.query(
    `select id, discord_id, username, global_name, roles, roles_synced_at, last_seen_at, login_count
     from users
     where lower(username) like '%washi%' or lower(global_name) like '%washi%' or lower(username) like '%56%' or lower(global_name) like '%56%'`,
  );
  console.log("users matching washi/56:", JSON.stringify(u.rows, null, 2));
  const utot = await pool.query(`select count(*) as n from users`);
  console.log("total users rows:", utot.rows[0].n);
  const fixers = await pool.query(
    `select id, username, global_name, roles from users
     where 'fixer' = any(select lower(r) from unnest(roles) r)
        or 'coordinator' = any(select lower(r) from unnest(roles) r)
        or 'trial-fixer' = any(select lower(r) from unnest(roles) r)
     order by username`,
  );
  console.log("\n===== current fixer/coordinator/trial-fixer users =====");
  console.table(fixers.rows.map((r) => ({ username: r.username, global_name: r.global_name, roles: (r.roles || []).join(",") })));

  // ---- 2. Meds history global monthly distribution ----
  console.log("\n===== bot_rent_payment_events kind=cyberware_meds : monthly count =====");
  const ev = await pool.query(
    `select to_char(ts, 'YYYY-MM') as ym, count(*) as n, count(distinct user_id) as users
     from bot_rent_payment_events
     where kind = 'cyberware_meds'
     group by 1 order by 1`,
  );
  console.table(ev.rows);

  console.log("\n===== bot_balance_history reason ILIKE 'Cyberware meds%' : monthly count =====");
  const bh = await pool.query(
    `select to_char(ts, 'YYYY-MM') as ym, count(*) as n, count(distinct user_id) as users
     from bot_balance_history
     where reason ilike 'Cyberware meds%'
     group by 1 order by 1`,
  );
  console.table(bh.rows);

  // ---- 3. Dashboard pending counts ----
  console.log("\n===== character_sheets status counts =====");
  const cs = await pool.query(
    `select status, count(*) as n from character_sheets group by 1 order by 2 desc`,
  );
  console.table(cs.rows);

  console.log("\n===== pending character_sheets detail =====");
  const csp = await pool.query(
    `select id, name, owner_id, character_id, created_at, updated_at
     from character_sheets where status = 'pending' order by created_at`,
  );
  console.table(csp.rows);

  console.log("\n===== custom_requests status x type (active) =====");
  const cr = await pool.query(
    `select type, status, count(*) as n
     from custom_requests
     where status in ('pending','changes_requested')
     group by 1,2 order by 1,2`,
  );
  console.table(cr.rows);

  console.log("\n===== active custom_requests detail (non-excluded types) =====");
  const crd = await pool.query(
    `select id, type, status, requested_by_id, character_id, created_at
     from custom_requests
     where status in ('pending','changes_requested')
       and type not in ('stock_cost','employee_invite','mission_participation')
     order by created_at`,
  );
  console.table(crd.rows);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERR", e);
    process.exit(1);
  });
