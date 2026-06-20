import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
async function main() {
  // withdrawn (or rejected) applications that still have a surviving assignment row (same mission+user)
  const r1 = await db.execute(sql`
    SELECT a.id app_id, a.mission_id, a.user_id, a.character_id, a.status app_status,
           asg.id asg_id, asg.character_id asg_char, asg.payment_status
    FROM mission_applications a
    JOIN mission_assignments asg
      ON asg.mission_id = a.mission_id AND asg.user_id = a.user_id
    WHERE a.status IN ('withdrawn','rejected')
    ORDER BY a.mission_id, a.user_id
  `);
  console.log("withdrawn/rejected apps WITH surviving assignment:", r1.rows.length);
  console.log(JSON.stringify(r1.rows.slice(0, 25), null, 2));

  // status distribution
  const r2 = await db.execute(sql`SELECT status, count(*) FROM mission_applications GROUP BY status ORDER BY 2 DESC`);
  console.log("application status counts:", JSON.stringify(r2.rows));
  process.exit(0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
