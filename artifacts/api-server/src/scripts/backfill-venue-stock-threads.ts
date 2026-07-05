// One-off / repeatable backfill: ensure every currently-OPEN venue_stock
// ("Venue Goods") custom request has a Discord cs-approver thread.
//
// Venue-stock requests are created via routes/stores.ts, a path that
// historically never announced to the cs-approver channel, so these tickets
// showed "No Discord thread linked to this ticket yet." Newly-created ones now
// announce inline; this script backfills the pre-existing open ones.
//
// "Open" = type='venue_stock' AND status='pending' AND no discordThreadId yet.
//
// Idempotency: a row that a prior run posted but failed to thread will have a
// discordMessageId (no threadId). Rather than re-posting (which would duplicate
// the cs-approver message), this run threads directly off the stored message.
// Rows with neither get the full announceRequest (post + thread). Because it only
// ever targets rows still missing a threadId, re-running never duplicates work.
//
// Discord writes are deployment-gated (discord.ts externalWritesAllowed): this is
// a pure no-op scan in the dev workspace unless ALLOW_EXTERNAL_WRITES=1.
//
// Usage (from repo root) — target the LIVE prod DB and force real writes:
//   DATABASE_URL="$LIVE_PROD_DATABASE_URL" ALLOW_EXTERNAL_WRITES=1 \
//     pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-venue-stock-threads.ts

export {};

import { pool, db, customRequests, characters, users } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { announceRequest } from "../routes/requests";
import { startThreadFromMessage } from "../lib/discord";

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

async function main() {
  const allowed = process.env.REPLIT_DEPLOYMENT === "1" || process.env.ALLOW_EXTERNAL_WRITES === "1";
  if (!allowed) {
    console.log(
      "Note: Discord writes are suppressed (not a deployment). This run will scan but make no posts. " +
        "Set ALLOW_EXTERNAL_WRITES=1 to force real writes against the configured Discord token.",
    );
  }
  if (!CS_CHANNEL_ID) {
    console.error("CS_APPROVAL_CHANNEL_ID is not set — announceRequest would no-op. Aborting.");
    await pool.end();
    process.exit(1);
  }

  const rows = await db
    .select({
      id: customRequests.id,
      title: customRequests.title,
      characterName: characters.name,
      requestedByName: users.username,
      discordMessageId: customRequests.discordMessageId,
    })
    .from(customRequests)
    .leftJoin(characters, eq(characters.id, customRequests.characterId))
    .leftJoin(users, eq(users.id, customRequests.requestedById))
    .where(
      and(
        eq(customRequests.type, "venue_stock"),
        eq(customRequests.status, "pending"),
        isNull(customRequests.discordThreadId),
      ),
    );

  console.log(`Found ${rows.length} open venue_stock request(s) missing a Discord thread.`);

  let created = 0;
  let failed = 0;
  for (const r of rows) {
    const title = r.title ?? `Request ${r.id}`;
    try {
      if (r.discordMessageId) {
        // A prior run posted the message but failed to thread — thread off it
        // instead of re-posting, to avoid a duplicate cs-approver message.
        const threadId = await startThreadFromMessage(CS_CHANNEL_ID, r.discordMessageId, `Request: ${title}`);
        if (threadId) {
          await db.update(customRequests).set({ discordThreadId: threadId }).where(eq(customRequests.id, r.id));
        }
      } else {
        await announceRequest(
          r.id,
          "venue_stock",
          title,
          r.characterName ?? "(unknown)",
          r.requestedByName ?? "(unknown)",
        );
      }
      const [after] = await db
        .select({ threadId: customRequests.discordThreadId })
        .from(customRequests)
        .where(eq(customRequests.id, r.id))
        .limit(1);
      if (after?.threadId) {
        created++;
        console.log(`  #${r.id} "${title}" → thread ${after.threadId}`);
      } else {
        failed++;
        console.log(`  #${r.id} "${title}" → no thread linked (write suppressed or Discord miss)`);
      }
    } catch (err) {
      failed++;
      console.error(`  #${r.id} "${title}" announce failed:`, err);
    }
  }

  console.log(`Done. Linked ${created} thread(s); ${failed} still unlinked.`);
  await pool.end();
}

main().catch((err) => {
  console.error("backfill-venue-stock-threads failed:", err);
  process.exit(1);
});
