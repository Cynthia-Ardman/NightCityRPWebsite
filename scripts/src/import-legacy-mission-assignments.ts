import pg from "pg";

/**
 * Backfills mission PLAYERS for the legacy missions imported by
 * import-legacy-missions.ts. Without this, every imported mission shows
 * "0 / N players" because the `missions` rows exist but `mission_assignments`
 * is empty.
 *
 * Source: legacy `mission_event.attendee_ids` (Discord ids) from
 * PROD_DATABASE_URL. The per-mission character for each attendee is taken from
 * the already-imported `mission_log` rows (tagged
 * `[legacy-mission:<mission_id>:<attendee_id>]` in their summary) so the
 * character shown on the mission matches that character's history page. Falls
 * back to the attendee's active character if no tagged log row is found.
 *
 * Safety: every imported mission already has auto_pay_processed_at set, so the
 * auto-pay cron never touches these rows regardless of payment_status. Players
 * are written with the historical payment state and attendance credit (no
 * attendance credit for the cancelled mission). Nothing here triggers a payout.
 *
 * Performance: all reads are done in a handful of bulk queries (NOT per
 * attendee) and the inserts are a single multi-row statement, because the DBs
 * are remote/high-latency.
 *
 * Idempotent: ON CONFLICT (mission_id, user_id) DO NOTHING.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/import-legacy-mission-assignments.ts
 *   IMPORT_TARGET=live pnpm --filter @workspace/scripts exec tsx src/import-legacy-mission-assignments.ts
 */

const SOURCE = process.env.PROD_DATABASE_URL;
if (!SOURCE) {
  console.error("PROD_DATABASE_URL (legacy bot source) is not set");
  process.exit(1);
}
const targetIsLive = process.env.IMPORT_TARGET === "live";
const TARGET = targetIsLive ? process.env.LIVE_PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!TARGET) {
  console.error(targetIsLive ? "IMPORT_TARGET=live but LIVE_PROD_DATABASE_URL is not set" : "DATABASE_URL is not set");
  process.exit(1);
}

const SKIP_NAMES = new Set(["test", "example"]);
const TIMEOUTS = { connectionTimeoutMillis: 15000, statement_timeout: 20000, query_timeout: 20000 };

type LegacyMission = {
  mission_id: string;
  mission_name: string;
  pay_per_player: unknown;
  start_ts: Date | null;
  paid: boolean | null;
  canceled: boolean | null;
  attendee_ids: string[] | null;
};

const toInt = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const mkey = (title: string, start: Date | null) => `${title.toLowerCase()}::${start ? start.toISOString() : "null"}`;

async function main() {
  const src = new pg.Client({ connectionString: SOURCE, ...TIMEOUTS });
  const tgt = new pg.Client({ connectionString: TARGET, ...TIMEOUTS });
  await src.connect();
  await tgt.connect();
  console.log(`Target ${targetIsLive ? "(LIVE)" : "(dev)"}: ${new URL(TARGET!).host}`);

  // --- 1. Source: legacy missions + attendees (1 query) ---
  const { rows: legacy } = await src.query<LegacyMission>(
    `SELECT mission_id, mission_name, pay_per_player, start_ts, paid, canceled, attendee_ids
       FROM mission_event ORDER BY start_ts`,
  );
  const realMissions = legacy.filter((m) => m.mission_name && !SKIP_NAMES.has(m.mission_name.trim().toLowerCase()));
  const allAttendees = [...new Set(realMissions.flatMap((m) => m.attendee_ids ?? []))];

  // --- 2. Target bulk reads (4 queries) ---
  const missionRows = await tgt.query<{ id: number; title: string; start_at: Date | null }>(
    `SELECT id, title, start_at FROM missions`,
  );
  const missionByKey = new Map<string, number>();
  for (const r of missionRows.rows) missionByKey.set(mkey(r.title, r.start_at), r.id);

  const userRows = await tgt.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1)`, [allAttendees]);
  const userSet = new Set(userRows.rows.map((r) => r.id));

  const charRows = await tgt.query<{ id: number; owner_id: string }>(
    `SELECT DISTINCT ON (owner_id) id, owner_id FROM characters
      WHERE owner_id = ANY($1) ORDER BY owner_id, (life_status='active') DESC, created_at ASC`,
    [allAttendees],
  );
  const charByOwner = new Map<string, number>();
  for (const r of charRows.rows) charByOwner.set(r.owner_id, r.id);

  const logRows = await tgt.query<{ character_id: number | null; summary: string | null }>(
    `SELECT character_id, summary FROM mission_log WHERE summary LIKE '[legacy-mission:%'`,
  );
  const charByMissionAttendee = new Map<string, number | null>();
  const tagRe = /^\[legacy-mission:([^:]+):([^\]]+)\]/;
  for (const r of logRows.rows) {
    const mt = r.summary ? tagRe.exec(r.summary) : null;
    if (mt) charByMissionAttendee.set(`${mt[1]}::${mt[2]}`, r.character_id);
  }

  // --- 3. Build rows in memory ---
  const values: unknown[] = [];
  const tuples: string[] = [];
  let noUser = 0;
  let noMission = 0;
  const perMission: Record<string, number> = {};
  for (const m of realMissions) {
    const missionId = missionByKey.get(mkey(m.mission_name.trim(), m.start_ts));
    if (!missionId) { noMission++; console.log(`! mission not found: ${m.mission_name}`); continue; }
    const cancelled = !!m.canceled;
    const paid = !!m.paid;
    const payAmount = toInt(m.pay_per_player);
    for (const attendeeId of m.attendee_ids ?? []) {
      if (!userSet.has(attendeeId)) { noUser++; continue; }
      const characterId = charByMissionAttendee.get(`${m.mission_id}::${attendeeId}`) ?? charByOwner.get(attendeeId) ?? null;
      const attendanceCreditedAt = cancelled ? null : m.start_ts;
      const paymentStatus = !cancelled && paid ? "paid" : "unpaid";
      const assignmentPayAmount = paymentStatus === "paid" ? payAmount : null;
      const paidAt = paymentStatus === "paid" ? m.start_ts : null;
      const createdAt = m.start_ts ?? new Date();
      const i = values.length;
      tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8})`);
      values.push(missionId, attendeeId, characterId, attendanceCreditedAt, paymentStatus, assignmentPayAmount, paidAt, createdAt);
      perMission[m.mission_name.trim()] = (perMission[m.mission_name.trim()] ?? 0) + 1;
    }
  }

  // --- 4. Single bulk insert ---
  let inserted = 0;
  if (tuples.length > 0) {
    const res = await tgt.query(
      `INSERT INTO mission_assignments
         (mission_id, user_id, character_id, attendance_credited_at, payment_status, pay_amount, paid_at, created_at)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (mission_id, user_id) DO NOTHING`,
      values,
    );
    inserted = res.rowCount ?? 0;
  }

  for (const [name, n] of Object.entries(perMission)) console.log(`  ${name}: ${n} players prepared`);
  console.log(`\nDone. candidate rows=${tuples.length}  inserted(new)=${inserted}  skipped(no user)=${noUser}  missions not found=${noMission}`);
  await src.end();
  await tgt.end();
}
main()
  .then(() => process.exit(0))
  .catch((err) => { console.error("Import failed:", err); process.exit(1); });
