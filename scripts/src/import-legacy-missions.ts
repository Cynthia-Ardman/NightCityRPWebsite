import pg from "pg";

/**
 * One-time(ish), idempotent importer that brings the legacy NightCityBot
 * missions (the `mission_event` table in PROD_DATABASE_URL) into the portal's
 * first-class `missions` table so they show up on the Missions/LN page.
 *
 * These are PAST missions, so they are imported as:
 *   - workflow_state = 'posted'      (visible to everyone)
 *   - status         = 'cancelled' | 'completed_paid' | 'completed'
 *   - auto_pay_processed_at = now()  (NEUTRALISES the auto-pay cron so it never
 *                                     tries to pay real eddies for history)
 *   - npc_announced_at      = now()  (belt-and-braces; past missions are
 *                                     excluded from the announce sweep anyway)
 *
 * Idempotent: a mission is matched by (lower(title), start_at) and skipped if it
 * already exists, so re-running never duplicates.
 *
 * Obvious test placeholders ("Test"/"test"/"Example") are skipped.
 *
 * Target selection:
 *   - default                  → DATABASE_URL            (dev)
 *   - IMPORT_TARGET=live       → LIVE_PROD_DATABASE_URL  (the Neon DB n.com uses)
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/import-legacy-missions.ts
 *   IMPORT_TARGET=live pnpm --filter @workspace/scripts exec tsx src/import-legacy-missions.ts
 */

const SOURCE = process.env.PROD_DATABASE_URL;
if (!SOURCE) {
  console.error("PROD_DATABASE_URL (legacy bot source) is not set");
  process.exit(1);
}

const targetIsLive = process.env.IMPORT_TARGET === "live";
const TARGET = targetIsLive
  ? process.env.LIVE_PROD_DATABASE_URL
  : process.env.DATABASE_URL;
if (!TARGET) {
  console.error(
    targetIsLive
      ? "IMPORT_TARGET=live but LIVE_PROD_DATABASE_URL is not set"
      : "DATABASE_URL (dev target) is not set",
  );
  process.exit(1);
}

const SKIP_NAMES = new Set(["test", "example"]);

type LegacyMission = {
  mission_id: string;
  mission_name: string;
  mission_description: string | null;
  pay_per_player: unknown;
  start_ts: unknown;
  paid: boolean | null;
  canceled: boolean | null;
  creator_id: string | null;
  attendee_ids: unknown;
};

function toInt(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toStartDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    // epoch seconds vs ms
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms);
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function attendeeCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") {
    const s = v.trim().replace(/^\{|\}$/g, "");
    if (!s) return 0;
    return s.split(",").filter(Boolean).length;
  }
  return 0;
}

function statusFor(m: LegacyMission): string {
  if (m.canceled) return "cancelled";
  if (m.paid) return "completed_paid";
  return "completed";
}

async function main() {
  const source = new pg.Client({ connectionString: SOURCE });
  const target = new pg.Client({ connectionString: TARGET });
  await source.connect();
  await target.connect();
  console.log(
    `Source (legacy): ${new URL(SOURCE!).host}\n` +
      `Target ${targetIsLive ? "(LIVE)" : "(dev)"}: ${new URL(TARGET!).host}\n`,
  );

  const { rows } = await source.query<LegacyMission>(
    `SELECT mission_id, mission_name, mission_description, pay_per_player,
            start_ts, paid, canceled, creator_id, attendee_ids
       FROM mission_event
      ORDER BY start_ts NULLS LAST`,
  );

  let inserted = 0;
  let skippedExisting = 0;
  let skippedTest = 0;

  for (const m of rows) {
    const title = (m.mission_name ?? "").trim();
    if (!title || SKIP_NAMES.has(title.toLowerCase())) {
      skippedTest++;
      continue;
    }
    const startAt = toStartDate(m.start_ts);

    // Idempotency: match on (lower(title), start_at) — NULL-safe.
    const dupe = await target.query(
      `SELECT id FROM missions
        WHERE lower(title) = lower($1)
          AND start_at IS NOT DISTINCT FROM $2
        LIMIT 1`,
      [title, startAt],
    );
    if (dupe.rowCount && dupe.rowCount > 0) {
      skippedExisting++;
      continue;
    }

    // Fixer: only set when the creator exists as a portal user (FK constraint).
    let fixerId: string | null = null;
    if (m.creator_id) {
      const u = await target.query(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [m.creator_id]);
      if (u.rowCount && u.rowCount > 0) fixerId = m.creator_id;
    }

    const status = statusFor(m);
    const playerPay = toInt(m.pay_per_player);
    const slots = attendeeCount(m.attendee_ids);
    const createdAt = startAt ?? new Date();

    await target.query(
      `INSERT INTO missions
         (title, tier, player_pay, description, status, workflow_state,
          fixer_id, start_at, duration_minutes, slots, max_players,
          auto_pay_processed_at, npc_announced_at, created_at, updated_at)
       VALUES
         ($1, 1, $2, $3, $4, 'posted',
          $5, $6, 120, $7, 0,
          now(), now(), $8, now())`,
      [title, playerPay, m.mission_description ?? null, status, fixerId, startAt, slots, createdAt],
    );
    inserted++;
    console.log(`  + ${title}  [${status}]  start=${startAt ? startAt.toISOString() : "none"}  fixer=${fixerId ?? "none"}`);
  }

  console.log(
    `\nDone. inserted=${inserted}  skipped(existing)=${skippedExisting}  skipped(test)=${skippedTest}  total source=${rows.length}`,
  );

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exitCode = 1;
});
