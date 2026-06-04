// One-off / repeatable backfill: ensure Main Session events exist on the
// calendar ~3 months out.
//
// Main Sessions run every Sunday but are stored as DISCRETE events (one row per
// week, each with its own Discord scheduled-event), NOT a recurrence rule. So
// the calendar only shows as far out as rows exist. This finds the latest
// session, then clones it forward one week + one session-number at a time
// ("Session 69" → "Session 70" → ...) until coverage reaches the horizon.
//
// Uses createEvent(), so each new row goes through the normal Discord sync path
// (gated on the live flag) exactly like a staff-created event.
//
// Idempotent: only fills Sundays AFTER the latest existing session, and skips
// any week that already has a session row.
//
// Usage (from repo root):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-main-sessions.ts
//
// DRY_RUN=1 prints what it would create without writing.
// HORIZON_DAYS=120 overrides the default 90-day (≈3 month) horizon.

export {};

import { eq } from "drizzle-orm";
import { db, pool, events } from "@workspace/db";
import { createEvent } from "../lib/eventsService";

const DRY_RUN = process.env.DRY_RUN === "1";
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS ?? "90");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Pull the trailing integer out of a session title, e.g.
// "NCRP Main Event: Session 69" → { prefix: "NCRP Main Event: Session ", num: 69 }.
function parseSessionTitle(title: string): { prefix: string; num: number } | null {
  const m = title.match(/^(.*?)(\d+)\s*$/);
  if (!m) return null;
  return { prefix: m[1], num: Number(m[2]) };
}

function dayKeyUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

async function main() {
  const sessions = (await db.select().from(events).where(eq(events.eventType, "session")))
    .filter((e) => e.status !== "cancelled" && e.startAt)
    .sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());

  if (sessions.length === 0) {
    console.log("No existing Main Session events found — nothing to seed from. Aborting.");
    await pool.end();
    return;
  }

  const last = sessions[sessions.length - 1]!;
  const parsed = parseSessionTitle(last.title);
  if (!parsed) {
    console.log(`Could not parse a session number out of latest title "${last.title}". Aborting.`);
    await pool.end();
    return;
  }
  if (!last.endAt) {
    console.log(`Latest session #${last.id} has no end time. Aborting.`);
    await pool.end();
    return;
  }

  const durationMs = last.endAt.getTime() - last.startAt!.getTime();
  const existingDays = new Set(sessions.map((e) => dayKeyUTC(e.startAt!)));

  const horizon = new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `Latest: #${last.id} "${last.title}" @ ${last.startAt!.toISOString()} ` +
      `(num=${parsed.num}, duration=${Math.round(durationMs / 3_600_000)}h)`,
  );
  console.log(`Horizon: ${horizon.toISOString()} (${HORIZON_DAYS} days out)${DRY_RUN ? " [DRY RUN]" : ""}`);

  // Idempotency guard: if the latest session already reaches/exceeds the
  // horizon, coverage is complete — creating another week would overshoot the
  // target. Re-running is then a no-op.
  if (last.startAt!.getTime() >= horizon.getTime()) {
    console.log("Coverage already extends to the horizon — nothing to create.");
    await pool.end();
    return;
  }

  let num = parsed.num;
  let start = new Date(last.startAt!.getTime());
  let created = 0;

  // Clone forward until a session lands on/after the horizon (inclusive), so
  // coverage always extends to at least HORIZON_DAYS out.
  while (true) {
    start = new Date(start.getTime() + WEEK_MS);
    num += 1;
    const reachedHorizon = start.getTime() >= horizon.getTime();

    if (existingDays.has(dayKeyUTC(start))) {
      console.log(`  skip: a session already exists on ${start.toISOString()}`);
      if (reachedHorizon) break;
      continue;
    }

    const end = new Date(start.getTime() + durationMs);
    const title = `${parsed.prefix}${num}`;

    if (DRY_RUN) {
      console.log(`  [dry] would create "${title}" @ ${start.toISOString()} → ${end.toISOString()}`);
    } else {
      const ev = await createEvent(
        {
          title,
          eventType: "session",
          location: last.location,
          description: last.description,
          imageUrl: last.imageUrl,
          startAt: start,
          endAt: end,
          needsNpcs: last.needsNpcs,
          npcBlurb: last.npcBlurb,
        },
        last.createdById ?? "system",
      );
      console.log(`  [ ok ] created #${ev.id} "${title}" @ ${start.toISOString()}`);
    }
    created += 1;
    existingDays.add(dayKeyUTC(start));

    if (reachedHorizon) break;
  }

  console.log(`Done. ${DRY_RUN ? "Would create" : "Created"} ${created} session(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error("backfill-main-sessions failed:", err);
  process.exit(1);
});
