import { eq, sql, isNull, and } from "drizzle-orm";
import { db, pool, missionLog, users, characters } from "@workspace/db";

/**
 * Re-link mission_log rows whose characterId is null by parsing the
 * [legacy-mission:<missionId>:<attendeeDiscordId>] tag the prod importer
 * stamped into the summary. For each such row we look up the user by
 * discordId and attach their (preferred: approved, non-archived) character.
 *
 * Idempotent: rows whose characterId is already set are ignored, and rows
 * where we still can't resolve a character are skipped (and reported).
 */

const TAG_RE = /\[legacy-mission:([^:]+):([^\]]+)\]/;

async function findCharForDiscordId(discordId: string): Promise<number | null> {
  const u = await db.select({ id: users.id }).from(users).where(eq(users.discordId, discordId)).limit(1);
  if (!u.length) return null;
  const owned = await db
    .select({ id: characters.id, approved: characters.approved, archived: characters.archived })
    .from(characters)
    .where(eq(characters.ownerId, u[0].id));
  if (!owned.length) return null;
  const active = owned.filter((c) => !c.archived);
  const approved = active.filter((c) => c.approved);
  const pool = approved.length ? approved : active.length ? active : owned;
  // Only auto-link when unambiguous (single candidate). For multi-character
  // owners we refuse to guess and report it so an admin can fix manually.
  if (pool.length === 1) return pool[0].id;
  return null;
}

async function main() {
  const rows = await db
    .select({ id: missionLog.id, summary: missionLog.summary })
    .from(missionLog)
    .where(isNull(missionLog.characterId));
  console.log(`mission_log rows with null characterId: ${rows.length}`);

  let linked = 0;
  let noTag = 0;
  let noUser = 0;
  let ambiguous = 0;
  const sampleAmbiguous: string[] = [];

  for (const r of rows) {
    const m = r.summary?.match(TAG_RE);
    if (!m) {
      noTag++;
      continue;
    }
    const discordId = m[2];
    const charId = await findCharForDiscordId(discordId);
    if (charId == null) {
      // distinguish "no user" from "ambiguous / no char"
      const u = await db.select({ id: users.id }).from(users).where(eq(users.discordId, discordId)).limit(1);
      if (!u.length) {
        noUser++;
      } else {
        ambiguous++;
        if (sampleAmbiguous.length < 10) sampleAmbiguous.push(`row ${r.id} discord:${discordId}`);
      }
      continue;
    }
    await db.update(missionLog).set({ characterId: charId }).where(eq(missionLog.id, r.id));
    linked++;
  }

  console.log(`\nLinked:        ${linked}`);
  console.log(`No tag:        ${noTag}`);
  console.log(`Unknown user:  ${noUser}`);
  console.log(`Ambiguous:     ${ambiguous}`);
  if (sampleAmbiguous.length) {
    console.log("Sample ambiguous (multiple chars under one Discord ID):");
    for (const s of sampleAmbiguous) console.log("  " + s);
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
