// One-off operational script: re-host low-resolution Discord-imported event
// banners to object storage at full resolution.
//
// Older imports stored the raw `cdn.discordapp.com/guild-events/<id>/<hash>.png`
// URL with no `?size`, which Discord serves at a small default size. This walks
// every event whose imageUrl is still a raw guild-events CDN URL, re-fetches it
// at 2048px, re-hosts it to object storage, and rewrites imageUrl to the hosted
// path. Idempotent: rows already pointing at object storage are skipped.
//
// Runs IN the api-server package so object storage works in-process (no auth).
//
// Usage (from repo root):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-event-images.ts
//
// DRY_RUN=1 prints what it would do without writing.

export {};

import { eq, like } from "drizzle-orm";
import { db, pool, events } from "@workspace/db";
import { guildEventImageUrl, rehostEventImage } from "../lib/eventsService";

const DRY_RUN = process.env.DRY_RUN === "1";

// Parse `.../guild-events/<discordEventId>/<imageHash>.png[?...]` → the 2048px
// CDN URL. Returns null for any URL that isn't a raw guild-events banner.
function highResUrl(imageUrl: string): string | null {
  const m = imageUrl.match(/\/guild-events\/(\d+)\/([^./?]+)/);
  if (!m) return null;
  return guildEventImageUrl(m[1]!, m[2]!);
}

async function main() {
  const rows = await db
    .select({ id: events.id, title: events.title, imageUrl: events.imageUrl })
    .from(events)
    .where(like(events.imageUrl, "https://cdn.discordapp.com/guild-events/%"));

  console.log(`Found ${rows.length} event(s) with a raw guild-events banner.`);
  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.imageUrl) continue;
    const src = highResUrl(row.imageUrl);
    if (!src) {
      console.log(`  [skip] #${row.id} ${row.title} — unrecognized URL`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [dry ] #${row.id} ${row.title} → would rehost ${src}`);
      continue;
    }
    const hosted = await rehostEventImage(src);
    if (!hosted) {
      failed++;
      console.log(`  [FAIL] #${row.id} ${row.title} — rehost failed`);
      continue;
    }
    await db.update(events).set({ imageUrl: hosted }).where(eq(events.id, row.id));
    updated++;
    console.log(`  [ ok ] #${row.id} ${row.title} → ${hosted}`);
  }

  console.log(`\nDone. updated=${updated} failed=${failed} dryRun=${DRY_RUN}`);
  await pool.end();
}

main().catch((err) => {
  console.error("backfill-event-images failed:", err);
  process.exit(1);
});
