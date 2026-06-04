// One-off data fix: convert the imported Discord event "Actors Needed:
// Slaughter of steel labs" (events.id=13) into a posted mission.
//
// The event was imported as a generic calendar event but is really a mission
// (NPC actors needed). This creates a mission seeded from the event row, moves
// the linked Discord scheduled-event id onto the mission (so the reconcile cron
// skips it instead of re-importing a duplicate event), re-hosts the banner at
// full resolution, then deletes the original event row.
//
// Safe to re-run: if event 13 is already gone it no-ops.
//
// Runs IN the api-server package so object storage works in-process (no auth).
//
// Usage (from repo root):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/convert-event-13-to-mission.ts
//
// DRY_RUN=1 prints what it would do without writing.

export {};

import { eq } from "drizzle-orm";
import { db, pool, events, missions, eventNpcSignups } from "@workspace/db";
import { guildEventImageUrl, rehostEventImage } from "../lib/eventsService";

const EVENT_ID = 13;
const DRY_RUN = process.env.DRY_RUN === "1";

function highResUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  const m = imageUrl.match(/\/guild-events\/(\d+)\/([^./?]+)/);
  if (!m) return imageUrl; // already hosted / unknown shape — reuse as-is
  return guildEventImageUrl(m[1]!, m[2]!);
}

async function main() {
  const [ev] = await db.select().from(events).where(eq(events.id, EVENT_ID));
  if (!ev) {
    console.log(`Event #${EVENT_ID} not found — nothing to convert (already done?).`);
    await pool.end();
    return;
  }

  console.log(`Converting event #${ev.id} "${ev.title}" → mission`);
  console.log(`  location=${ev.location} discordEventId=${ev.discordEventId}`);
  console.log(`  start=${ev.startAt?.toISOString()} end=${ev.endAt?.toISOString()}`);

  const durationMinutes =
    ev.startAt && ev.endAt
      ? Math.max(30, Math.round((ev.endAt.getTime() - ev.startAt.getTime()) / 60000))
      : 120;

  // Re-host the banner at full resolution; fall back to the high-res CDN URL.
  let imageUrl: string | null = null;
  const hi = highResUrl(ev.imageUrl);
  if (hi) imageUrl = (await rehostEventImage(hi)) ?? hi;

  const PLAYER_PAY = 5000; // ¥5,000 per attendee (from the event description)
  const SLOTS = 5; // 5 attendees listed in the event description

  if (DRY_RUN) {
    console.log("  [dry] would insert mission:", {
      title: ev.title,
      location: ev.location,
      playerPay: PLAYER_PAY,
      slots: SLOTS,
      maxPlayers: SLOTS,
      durationMinutes,
      startAt: ev.startAt?.toISOString(),
      discordEventId: ev.discordEventId,
      imageUrl,
      workflowState: "posted",
      status: "open",
    });
    console.log(`  [dry] would delete event #${ev.id}`);
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    // Detach the Discord link from the event FIRST so the partial unique index
    // on missions.discordEventId can't collide while both rows briefly exist.
    if (ev.discordEventId) {
      await tx.update(events).set({ discordEventId: null }).where(eq(events.id, ev.id));
    }

    const [mission] = await tx
      .insert(missions)
      .values({
        title: ev.title,
        tier: 1,
        playerPay: PLAYER_PAY,
        location: ev.location,
        description: ev.description,
        imageUrl,
        status: "open",
        workflowState: "posted",
        startAt: ev.startAt,
        durationMinutes,
        slots: SLOTS,
        maxPlayers: SLOTS,
        discordEventId: ev.discordEventId,
      })
      .returning({ id: missions.id });

    // Remove any NPC sign-ups bound to the event, then delete the event row.
    await tx.delete(eventNpcSignups).where(eq(eventNpcSignups.eventId, ev.id));
    await tx.delete(events).where(eq(events.id, ev.id));

    console.log(`  [ ok ] created mission #${mission!.id}, deleted event #${ev.id}`);
  });

  await pool.end();
}

main().catch((err) => {
  console.error("convert-event-13-to-mission failed:", err);
  process.exit(1);
});
