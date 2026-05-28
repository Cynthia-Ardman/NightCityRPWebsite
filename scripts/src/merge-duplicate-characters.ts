/**
 * Post-import cleanup: merge thread-imported (fresh) rows into pre-existing
 * legacy rows when the fresh row's normalized name CONTAINS (or equals)
 * the legacy row's normalized name. This handles cases like:
 *   legacy "Corpse" + fresh "The Corpse Hound" → keep legacy id, copy data
 *   legacy "Diesel" + fresh "Malcolm 'Diesel' Reyes" → same
 *
 * Strategy:
 *   - For each owner_id, build the set of legacy rows (imported_from_thread_id IS NULL)
 *     and fresh rows (imported_from_thread_id IS NOT NULL).
 *   - Normalize names: lowercase, strip non-alphanumerics, keep tokens.
 *   - For each legacy row, find the UNIQUE fresh row whose normalized name
 *     contains every token of the legacy name (or vice versa).
 *   - On unique match: UPDATE legacy with fresh's content fields, DELETE fresh.
 *   - On ambiguous match (>1 candidate): skip and report.
 *   - On no match: skip silently.
 *
 *   DATABASE_URL="$LIVE_PROD_DATABASE_URL" \
 *     pnpm --filter @workspace/scripts exec tsx src/merge-duplicate-characters.ts [--dry-run]
 *
 * WARNING: This script DELETEs the fresh row, which cascades through every
 * table whose FK references characters.id (inventory_items, wallet_transactions,
 * housing, character_status, mission_log, trauma_team_calls, store_employees,
 * ripperdoc_employees). Safe only when the fresh rows are brand-new from import
 * and have no user activity yet. If re-running later, FIRST re-link those
 * child rows to the legacy id, or temporarily null the fresh row's
 * imported_from_thread_id and UPDATE the legacy row first.
 */
import { db, characters } from "@workspace/db";
import { eq, isNotNull, isNull, sql } from "drizzle-orm";

const DRY = process.argv.includes("--dry-run");

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(s: string): string[] {
  return norm(s).split(" ").filter((t) => t.length >= 3);
}

const all = await db
  .select({
    id: characters.id,
    name: characters.name,
    ownerId: characters.ownerId,
    threadId: characters.importedFromThreadId,
    portraitUrl: characters.portraitUrl,
    portraitUrls: characters.portraitUrls,
    statsImageUrls: characters.statsImageUrls,
    sheetData: characters.sheetData,
    background: characters.background,
    archetype: characters.archetype,
    legacyDiscordUsername: characters.legacyDiscordUsername,
    importedFromChannelName: characters.importedFromChannelName,
    discordChannelId: characters.discordChannelId,
    archived: characters.archived,
  })
  .from(characters)
  .where(isNotNull(characters.ownerId));

const byOwner = new Map<string, typeof all>();
for (const r of all) {
  const k = r.ownerId!;
  if (!byOwner.has(k)) byOwner.set(k, [] as typeof all);
  byOwner.get(k)!.push(r);
}

let merged = 0;
let ambiguous = 0;
let unmatched = 0;
const ambiguousReport: string[] = [];

for (const [ownerId, rows] of byOwner) {
  const legacy = rows.filter((r) => !r.threadId);
  const fresh = rows.filter((r) => r.threadId);
  if (legacy.length === 0 || fresh.length === 0) continue;

  // Track which fresh rows have been claimed by a merge so we don't double-merge.
  const claimedFresh = new Set<number>();

  for (const lg of legacy) {
    const lgTokens = tokens(lg.name);
    if (lgTokens.length === 0) continue;
    const candidates = fresh.filter((fr) => {
      if (claimedFresh.has(fr.id)) return false;
      const frTokens = tokens(fr.name);
      // Match if every token of legacy is present as a substring of any
      // token of fresh, OR legacy name (normalized) is a substring of fresh
      // (normalized). The latter catches "doc marcus" ↔ "marcus felix alarin md"? No.
      // Use token-subset: every legacy token must appear as a substring of some fresh token.
      return lgTokens.every((lt) => frTokens.some((ft) => ft.includes(lt) || lt.includes(ft)));
    });

    if (candidates.length === 0) {
      unmatched++;
      continue;
    }
    if (candidates.length > 1) {
      ambiguous++;
      ambiguousReport.push(
        `owner=${ownerId} legacy=#${lg.id} "${lg.name}" matches: ${candidates.map((c) => `#${c.id} "${c.name}"`).join(", ")}`,
      );
      continue;
    }

    const fr = candidates[0];
    claimedFresh.add(fr.id);

    if (DRY) {
      console.log(`  [dry] merge #${fr.id} "${fr.name}" -> #${lg.id} "${lg.name}"`);
      merged++;
      continue;
    }

    // Delete fresh FIRST so the unique index on importedFromThreadId is free
    // for the legacy row to claim it. Wrapped in a transaction so a failure
    // mid-merge doesn't lose the fresh row's data.
    await db.transaction(async (tx) => {
      await tx.delete(characters).where(eq(characters.id, fr.id));
      await tx
        .update(characters)
        .set({
          portraitUrl: lg.portraitUrl ?? fr.portraitUrl,
          portraitUrls:
            lg.portraitUrls && lg.portraitUrls.length > 0
              ? lg.portraitUrls
              : (fr.portraitUrls ?? []),
          statsImageUrls:
            lg.statsImageUrls && lg.statsImageUrls.length > 0
              ? lg.statsImageUrls
              : (fr.statsImageUrls ?? []),
          sheetData: lg.sheetData ?? fr.sheetData,
          background:
            lg.background && lg.background.length > (fr.background?.length ?? 0)
              ? lg.background
              : fr.background,
          archetype: lg.archetype ?? fr.archetype,
          legacyDiscordUsername: lg.legacyDiscordUsername ?? fr.legacyDiscordUsername,
          importedFromThreadId: fr.threadId,
          importedFromChannelName: fr.importedFromChannelName,
          discordChannelId: fr.discordChannelId,
          archived: lg.archived || fr.archived,
        })
        .where(eq(characters.id, lg.id));
    });

    console.log(`  merged #${fr.id} "${fr.name}" -> #${lg.id} "${lg.name}"`);
    merged++;
  }
}

console.log(`\nDone. merged=${merged} ambiguous=${ambiguous} unmatched=${unmatched}`);
if (ambiguousReport.length) {
  console.log("\nAmbiguous cases (needs human resolution):");
  for (const a of ambiguousReport) console.log("  " + a);
}
process.exit(0);
